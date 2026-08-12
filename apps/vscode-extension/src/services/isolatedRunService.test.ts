/**
 * Unit tests for provider auth-status parsing.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { asId, type AgentModelCatalog, type ChatSessionRecord } from "@drydock/contracts";
import { ProductEventBus, type BootStage, type ProductBusEvent } from "@drydock/core";
import type { EffectiveSecurityPolicy } from "./securityPolicy.js";
import {
  IsolatedRunService,
  mergeAgentModelCatalog,
  parseSbxSecretServices,
  resolveResumeWorkspaceContext,
  type ChatWorkspaceContext,
  type IsolatedRunServiceOptions
} from "./isolatedRunService.js";

function catalog(source: AgentModelCatalog["source"], ids: readonly string[], diagnostics: readonly string[] = []): AgentModelCatalog {
  return {
    providerId: "codex",
    displayName: "Codex",
    models: ids.map((id) => ({ id, displayName: id, isDefault: id === ids[0], hidden: false })),
    refreshedAt: "2026-07-20T00:00:00.000Z",
    source,
    diagnostics
  };
}

test("a live provider result is the truth: it replaces the entry wholesale", () => {
  const discovered = mergeAgentModelCatalog(catalog("cache", ["gpt-5.5"]), catalog("provider", ["gpt-5.6-sol", "gpt-5.6-luna"]));
  assert.deepEqual(discovered.models.map((model) => model.id), ["gpt-5.6-sol", "gpt-5.6-luna"]);

  // A model removed upstream really disappears - no unions of history.
  const narrowed = mergeAgentModelCatalog(discovered, catalog("provider", ["gpt-5.6-sol"]));
  assert.deepEqual(narrowed.models.map((model) => model.id), ["gpt-5.6-sol"]);
});

test("an unavailable result never erases a usable list; its reason is attached", () => {
  const existing = catalog("cache", ["gpt-5.5"]);
  const merged = mergeAgentModelCatalog(existing, catalog("unavailable", [], ["discovery failed: 401"]));
  assert.deepEqual(merged.models.map((model) => model.id), ["gpt-5.5"]);
  assert.equal(merged.source, "cache");
  assert.ok(merged.diagnostics.includes("discovery failed: 401"));
});

test("cache only fills absence and never overwrites a live entry", () => {
  const live = catalog("provider", ["gpt-5.6-sol"]);
  const merged = mergeAgentModelCatalog(live, catalog("cache", ["gpt-5.5"]));
  assert.deepEqual(merged.models.map((model) => model.id), ["gpt-5.6-sol"]);
  assert.equal(mergeAgentModelCatalog(undefined, catalog("cache", ["gpt-5.5"])).models[0]?.id, "gpt-5.5");
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
  let riderDiscoveries = 0;
  const options = {
    securityPolicy: policy({ managed: false, networked: true }),
    sbxPath: "sbx",
    clock: { now: () => new Date("2026-08-01T00:00:00.000Z"), isoNow: () => "2026-08-01T00:00:00.000Z" },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    environment: {},
    chatService: { liveSessionIds: () => [] },
    discoverProviderModels: async () => {
      riderDiscoveries += 1;
      return catalog("unavailable", []);
    },
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

  // First call: TTL due, probe + discovery run (no services configured yet).
  await service.refreshHostProviderCatalogs();
  assert.equal(secretLsRuns, 1);
  const discoveriesAfterFirst = riderDiscoveries;
  assert.ok(discoveriesAfterFirst > 0, "TTL-due refresh runs rider discovery");
  assert.equal(service.providerAuthStatus("codex"), "needs-login");

  // Within the TTL a plain refresh does NOT re-probe or re-discover...
  await service.refreshHostProviderCatalogs();
  assert.equal(secretLsRuns, 1);
  assert.equal(riderDiscoveries, discoveriesAfterFirst);

  // ...an auth-only recheck re-probes without touching discovery...
  await service.refreshHostProviderCatalogs({ forceAuthProbe: true });
  assert.equal(secretLsRuns, 2);
  assert.equal(riderDiscoveries, discoveriesAfterFirst);
  assert.equal(service.providerAuthStatus("codex"), "authenticated");

  // ...and a full force (the user's Refresh models) re-runs discovery too.
  await service.refreshHostProviderCatalogs({ force: true });
  assert.equal(secretLsRuns, 3);
  assert.ok(riderDiscoveries > discoveriesAfterFirst, "force re-runs rider discovery");
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
  // No compiled-in models: an undiscovered provider is an honest empty entry.
  const kimi = byId.get("kimi");
  assert.equal(kimi?.authKind, "api-key");
  assert.equal(kimi?.source, "unavailable");
  assert.equal(kimi?.models.length, 0);
  assert.match(kimi?.diagnostics.join(" ") ?? "", /No models discovered yet/);
});

test("cached catalogs load for pre-connect selection and live discovery replaces them", async () => {
  let saved: readonly AgentModelCatalog[] | undefined;
  const options = {
    securityPolicy: policy({ managed: false, networked: true }),
    sbxPath: "sbx",
    clock: { now: () => new Date("2026-08-01T00:00:00.000Z"), isoNow: () => "2026-08-01T00:00:00.000Z" },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    environment: {},
    chatService: { liveSessionIds: () => [] },
    catalogCache: {
      load: () => [{ ...catalog("provider", ["gpt-5.5"]), refreshedAt: "2026-07-01T00:00:00.000Z" }],
      save: (catalogs: readonly AgentModelCatalog[]) => { saved = catalogs; }
    },
    discoverProviderModels: async () => catalog("unavailable", []),
    commandRunner: {
      run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false })
    }
  } as unknown as IsolatedRunServiceOptions;
  const service = new IsolatedRunService(options);

  // The cached entry is selectable immediately, labeled as cache.
  const boot = service.listChatProviderCatalogs().find((entry) => entry.providerId === "codex");
  assert.equal(boot?.source, "cache");
  assert.deepEqual(boot?.models.map((model) => model.id), ["gpt-5.5"]);

  // A failed refresh keeps the cached models and attaches the reason.
  await service.refreshHostProviderCatalogs({ force: true });
  const afterFail = service.listChatProviderCatalogs().find((entry) => entry.providerId === "codex");
  assert.deepEqual(afterFail?.models.map((model) => model.id), ["gpt-5.5"]);
  assert.equal(afterFail?.source, "cache");
  assert.ok(afterFail?.diagnostics.some((line) => /No host Codex CLI/.test(line)));
  assert.equal(saved, undefined, "failed discovery must not overwrite the cache");
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

// --- boot timeline (UX overhaul P4) -----------------------------------------

/**
 * Drives a real startChatSession over fakes for everything the boot touches,
 * so the assertion is about the SEAMS the stages sit on - disposable workspace,
 * mounts vs clone seeding, backend start - not about a helper in isolation.
 * Returns the stages published, in order, plus the started session's id.
 */
async function bootStagesFor(
  workspace: ChatWorkspaceContext | undefined,
  extraOptions: Partial<IsolatedRunServiceOptions> = {}
): Promise<{ stages: BootStage[]; sessionId: string; startedWith: string | undefined }> {
  const base = await mkdtemp(path.join(os.tmpdir(), "drydock-boot-"));
  try {
    const bus = new ProductEventBus();
    const stages: BootStage[] = [];
    let sessionId = "";
    let startedWith: string | undefined;
    bus.subscribe((event: ProductBusEvent) => {
      if (event.kind !== "boot-progress") return;
      // Every stage must name the SAME session the caller ends up holding.
      assert.equal(event.sessionId, sessionId);
      stages.push(event.stage);
    });
    let counter = 0;
    const service = new IsolatedRunService({
      ids: {
        sessionId: () => {
          sessionId = "session-fake";
          return asId<"SessionId">(sessionId);
        },
        mountId: () => {
          counter += 1;
          return asId<"MountId">(`mount-${String(counter)}`);
        }
      },
      clock: { isoNow: () => "2026-08-02T00:00:00.000Z" },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      workspaceStore: {
        createWorkspace: async (prefix: string) => {
          const root = await mkdtemp(path.join(base, `${prefix}-`));
          return { root, workspacePath: root, ownerToken: "owner" };
        },
        cleanupWorkspace: async () => undefined
      },
      chatService: {
        bus,
        startSession: async (request: { readonly sessionId?: string }): Promise<ChatSessionRecord> => {
          startedWith = request.sessionId;
          return {
            sessionId: asId<"SessionId">(request.sessionId ?? "session-late"),
            chatId: asId<"ChatId">("chat-fake"),
            title: "Boot",
            status: "active",
            providerId: "codex",
            transport: "codex-app-server",
            createdAt: "2026-08-02T00:00:00.000Z",
            updatedAt: "2026-08-02T00:00:00.000Z"
          };
        },
        listModels: async () => {
          throw new Error("no models in this test");
        }
      },
      ...extraOptions
    } as unknown as IsolatedRunServiceOptions);

    const started = await service.startChatSession({ providerId: "codex" }, "Boot", workspace);
    return { stages, sessionId: started.session.sessionId, startedWith };
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test("a chat boot reports create → mount → start against the pre-allocated session id", async () => {
  const { stages, sessionId, startedWith } = await bootStagesFor(undefined);

  assert.deepEqual(stages, ["create", "mount", "start"]);
  // The id is minted BEFORE the workspace exists and handed to the chat
  // service, so the timeline and the response cannot name two sessions.
  assert.equal(startedWith, sessionId);
});

test("clone mode reports the clone stage in place of mount", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "drydock-boot-repo-"));
  try {
    const { stages } = await bootStagesFor(
      { mode: "clone", roots: [repo], dirtyHandling: "fresh" },
      {
        cloneSync: {
          detectGit: async () => ({ available: true }),
          preflightRepo: async () => ({ isGitRepo: true, localRepoPath: repo }),
          initClone: async () => ({ clonePath: path.join(repo, "clone"), branch: "main" })
        }
      } as unknown as Partial<IsolatedRunServiceOptions>
    );

    assert.deepEqual(stages, ["create", "clone", "start"]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

function serviceWithPolicy(securityPolicy: EffectiveSecurityPolicy): IsolatedRunService {
  return new IsolatedRunService({
    securityPolicy,
    sbxPath: "sbx",
    clock: { now: () => new Date("2026-08-01T00:00:00.000Z"), isoNow: () => "2026-08-01T00:00:00.000Z" },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    chatService: { liveSessionIds: () => [] }
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
