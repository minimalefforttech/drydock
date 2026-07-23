/**
 * Unit tests for provider auth-status parsing.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { asId, type AgentModelCatalog } from "@drydock/contracts";
import type { EffectiveSecurityPolicy } from "./securityPolicy.js";
import {
  IsolatedRunService,
  mergeAgentModelCatalog,
  parseSbxSecretServices,
  resolveResumeWorkspaceContext,
  type IsolatedRunServiceOptions
} from "./isolatedRunService.js";

function catalog(source: AgentModelCatalog["source"], ids: readonly string[]): AgentModelCatalog {
  return {
    providerId: "codex",
    displayName: "Codex",
    models: ids.map((id) => ({ id, displayName: id, isDefault: id === ids[0], hidden: false })),
    refreshedAt: "2026-07-20T00:00:00.000Z",
    source,
    diagnostics: []
  };
}

test("provider discovery replaces fallback and later catalogs merge without losing models", () => {
  const discovered = mergeAgentModelCatalog(catalog("fallback", ["gpt-5.5"]), catalog("provider", ["gpt-5.6-sol"]));
  assert.deepEqual(discovered.models.map((model) => model.id), ["gpt-5.6-sol"]);

  const merged = mergeAgentModelCatalog(discovered, catalog("provider", ["gpt-5.5"]));
  assert.deepEqual(merged.models.map((model) => model.id), ["gpt-5.6-sol", "gpt-5.5"]);
});

test("sbx secret ls parsing extracts configured service names", () => {
  const stdout = [
    "SCOPE      TYPE      NAME     SECRET",
    "(global)   service   openai   (oauth configured)",
    "(global)   service   Anthropic   (api key configured)",
    "(global)   registry  ghcr.io  (password configured)",
    "my-sandbox service   github   (token configured)"
  ].join("\n");

  const services = parseSbxSecretServices(stdout);

  assert.equal(services.has("openai"), true);
  assert.equal(services.has("anthropic"), true);
  assert.equal(services.has("github"), true);
  assert.equal(services.has("ghcr.io"), false);
});

test("empty or headers-only output yields no services", () => {
  assert.equal(parseSbxSecretServices("SCOPE TYPE NAME SECRET").size, 0);
  assert.equal(parseSbxSecretServices("").size, 0);
});

test("provider login uses the network gate and managed mode requires pre-provisioned access", () => {
  const networkBlocked = serviceWithPolicy(policy({ managed: false, networked: false }));
  assert.throws(() => networkBlocked.loginCommand("codex"), /Networked AI is disabled/);

  const managed = serviceWithPolicy(policy({ managed: true, networked: true }));
  assert.throws(() => managed.loginCommand("codex"), /pre-provision access/);

  const unmanaged = serviceWithPolicy(policy({ managed: false, networked: true }));
  assert.deepEqual(unmanaged.loginCommand("codex"), {
    command: "sbx",
    args: ["secret", "set", "-g", "openai", "--oauth"],
    display: "sbx secret set -g openai --oauth"
  });
});

test("api-key providers have no spawnable login and say so", () => {
  const unmanaged = serviceWithPolicy(policy({ managed: false, networked: true }));
  assert.throws(() => unmanaged.loginCommand("openrouter"), /signs in with an API key/);
  assert.throws(() => unmanaged.loginCommand("deepseek"), /signs in with an API key/);
});

test("explicit recheck always re-probes auth; only the catalog fetch is TTL-gated", async () => {
  let secretLsRuns = 0;
  const options = {
    securityPolicy: policy({ managed: false, networked: true }),
    sbxPath: "sbx",
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    environment: {},
    commandRunner: {
      run: async (_command: string, args: readonly string[]) => {
        if (args[0] === "secret") secretLsRuns += 1;
        return {
          exitCode: 0,
          stdout: secretLsRuns > 1 ? "(global)   service   openai   (oauth configured)" : "",
          stderr: "",
          timedOut: false
        };
      }
    }
  } as unknown as IsolatedRunServiceOptions;
  const service = new IsolatedRunService(options);

  // First call: TTL due, probe runs (no services configured yet).
  await service.refreshHostProviderCatalogs();
  assert.equal(secretLsRuns, 1);
  assert.equal(service.providerAuthStatus("codex"), "needs-login");

  // Within the TTL a plain refresh does NOT re-probe...
  await service.refreshHostProviderCatalogs();
  assert.equal(secretLsRuns, 1);

  // ...but a forced recheck does, and picks up the fresh credential at once.
  await service.refreshHostProviderCatalogs({ forceAuthProbe: true });
  assert.equal(secretLsRuns, 2);
  assert.equal(service.providerAuthStatus("codex"), "authenticated");
});

test("catalogs carry connect metadata: authKind and key URL", async () => {
  const service = serviceWithPolicy(policy({ managed: false, networked: true }));
  const catalogs = service.listChatProviderCatalogs();
  const byId = new Map(catalogs.map((entry) => [entry.providerId, entry]));

  assert.equal(byId.get("codex")?.authKind, "oauth");
  assert.equal(byId.get("claude")?.authKind, "oauth");
  const openrouter = byId.get("openrouter");
  assert.equal(openrouter?.authKind, "api-key");
  assert.match(openrouter?.keyUrl ?? "", /openrouter\.ai/);
  assert.match(openrouter?.loginHint ?? "", /API key/);
  const kimi = byId.get("kimi");
  assert.equal(kimi?.authKind, "api-key");
  assert.equal(kimi?.models.some((model) => model.id === "kimi-k2.7-code"), true);
});

test("vscode-secret providers read auth status from the secret-ref store", async () => {
  const present = new Set(["deepseek"]);
  const options = {
    securityPolicy: policy({ managed: false, networked: true }),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    providerSecrets: {
      has: async (providerId: string) => present.has(providerId),
      get: async () => undefined,
      set: async () => undefined,
      delete: async () => undefined
    }
  } as unknown as IsolatedRunServiceOptions;
  const service = new IsolatedRunService(options);

  await service.refreshProviderAuthStatuses();

  assert.equal(service.providerAuthStatus("deepseek"), "authenticated");
  assert.equal(service.providerAuthStatus("kimi"), "needs-login");
  // No sbx available in this construction: service-backed providers stay unknown.
  assert.equal(service.providerAuthStatus("codex"), "unknown");
});

test("runtime terminals remain available only outside managed mode", () => {
  const managed = serviceWithPolicy(policy({ managed: true, networked: true }));
  assert.throws(() => managed.assertRuntimeTerminalAllowed(), /disabled in managed mode/);

  const unmanaged = serviceWithPolicy(policy({ managed: false, networked: true }));
  assert.doesNotThrow(() => unmanaged.assertRuntimeTerminalAllowed());
});

test("resume preserves clone roots and fresh handling, rejecting a mode downgrade", () => {
  const stored = {
    sessionId: asId<"SessionId">("session-clone"),
    chatId: asId<"ChatId">("chat-clone"),
    title: "Clone run",
    status: "ended" as const,
    providerId: "codex",
    transport: "codex-app-server",
    mode: "clone" as const,
    workspaceRoots: ["C:\\repo-a", "C:\\repo-b"],
    cloneDirtyHandling: "fresh" as const,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:01:00.000Z"
  };

  assert.deepEqual(resolveResumeWorkspaceContext(stored), {
    mode: "clone",
    roots: ["C:\\repo-a", "C:\\repo-b"],
    dirtyHandling: "fresh"
  });
  assert.throws(
    () => resolveResumeWorkspaceContext(stored, { mode: "implementation", roots: ["C:\\live"] }),
    /cannot be resumed as implementation/
  );
});

function serviceWithPolicy(securityPolicy: EffectiveSecurityPolicy): IsolatedRunService {
  return new IsolatedRunService({
    securityPolicy,
    sbxPath: "sbx"
  } as unknown as IsolatedRunServiceOptions);
}

function policy(input: { readonly managed: boolean; readonly networked: boolean }): EffectiveSecurityPolicy {
  return {
    managed: input.managed,
    assertPolicyCurrent: () => undefined,
    assertNetworkedAiAllowed: () => {
      if (!input.networked) throw new Error("Networked AI is disabled for this test workstation.");
    }
  } as unknown as EffectiveSecurityPolicy;
}
