/**
 * Unit tests for provider runtime wiring: codex rider config, claude rider
 * token injection, and the no-op for native providers.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { PROVIDER_TOKEN_FILE, providerDescriptor, type RuntimeHandle } from "@drydock/contracts";
import { codexRiderConfigToml, createProviderRuntimePreparer } from "./providerWire.js";

interface RecordedExec {
  readonly args: readonly string[];
  readonly input?: string;
}

function makeExecutor(): { calls: RecordedExec[]; exec: (handle: RuntimeHandle, args: readonly string[], timeoutMs: number, input?: string) => Promise<{ exitCode: number; stdout: string; stderr: string }> } {
  const calls: RecordedExec[] = [];
  return {
    calls,
    exec: async (_handle, args, _timeoutMs, input) => {
      calls.push({ args, ...(input === undefined ? {} : { input }) });
      return { exitCode: 0, stdout: "", stderr: "" };
    }
  };
}

const runtime = { runtimeId: "rt-1", externalName: "drydock-x" } as unknown as RuntimeHandle;
const logger = { info: () => undefined, warn: () => undefined, error: () => undefined } as never;

test("openrouter rider gets a codex config.toml with sentinel env key and no secret", async () => {
  const executor = makeExecutor();
  const prepare = createProviderRuntimePreparer({ runtimeExecutor: executor, logger });

  await prepare(runtime, { providerId: "openrouter" });

  assert.equal(executor.calls.length, 1);
  assert.match(executor.calls[0]?.args[2] ?? "", /\.codex" && base64 -d > "\$HOME\/\.codex\/config\.toml"/);
  const toml = Buffer.from(executor.calls[0]?.input ?? "", "base64").toString("utf8");
  assert.match(toml, /model_provider = "openrouter"/);
  assert.match(toml, /base_url = "https:\/\/openrouter\.ai\/api\/v1"/);
  assert.match(toml, /env_key = "OPENROUTER_API_KEY"/);
  assert.match(toml, /wire_api = "chat"/);
  assert.doesNotMatch(toml, /sk-/);
});

test("claude riders inject the stored key as a runtime-scoped token file", async () => {
  const executor = makeExecutor();
  const prepare = createProviderRuntimePreparer({
    runtimeExecutor: executor,
    logger,
    providerSecrets: {
      has: async () => true,
      get: async (providerId) => (providerId === "deepseek" ? "test-key-value" : undefined),
      set: async () => undefined,
      delete: async () => undefined
    }
  });

  await prepare(runtime, { providerId: "deepseek" });

  assert.equal(executor.calls.length, 1);
  assert.match(executor.calls[0]?.args[2] ?? "", new RegExp(`umask 077 && base64 -d > ${PROVIDER_TOKEN_FILE.replace(/[/.]/g, "\\$&")}`));
  assert.equal(Buffer.from(executor.calls[0]?.input ?? "", "base64").toString("utf8"), "test-key-value");
});

test("a claude rider without a stored key fails the boot with an actionable message", async () => {
  const executor = makeExecutor();
  const prepare = createProviderRuntimePreparer({
    runtimeExecutor: executor,
    logger,
    providerSecrets: { has: async () => false, get: async () => undefined, set: async () => undefined, delete: async () => undefined }
  });

  await assert.rejects(prepare(runtime, { providerId: "kimi" }), /no API key configured/);
  assert.equal(executor.calls.length, 0);
});

test("native providers are untouched", async () => {
  const executor = makeExecutor();
  const prepare = createProviderRuntimePreparer({ runtimeExecutor: executor, logger });

  await prepare(runtime, { providerId: "codex" });
  await prepare(runtime, { providerId: "claude" });

  assert.equal(executor.calls.length, 0);
});

test("codexRiderConfigToml rejects non-openai-compat descriptors", () => {
  const deepseek = providerDescriptor("deepseek");
  assert.ok(deepseek);
  assert.throws(() => codexRiderConfigToml(deepseek), /not an openai-compat rider/);
});
