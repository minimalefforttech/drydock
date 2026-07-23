/**
 * Provider wiring for ridden providers (OpenRouter, DeepSeek, Kimi, ...).
 *
 * Runs on EVERY session boot (start/resume/restart/reclaim) between runtime
 * creation and protocol start, over the exec side-channel - the only
 * host-initiated data path into a sandbox (ADR 0018). Native codex/claude
 * sessions are untouched.
 *
 * - codex rides get `$HOME/.codex/config.toml` declaring the provider's
 *   OpenAI-compatible endpoint. The key env var holds the `proxy-managed`
 *   sentinel; the Docker Sandbox proxy injects the real key at the HTTPS
 *   layer, so no secret is written here.
 * - claude rides get a runtime-scoped token file (mode 0600, tmpfs) read by
 *   the wrapped CLI inside the sandbox. The value comes from VS Code
 *   SecretStorage (`vscode-secret:<provider>`) at boot time and is never
 *   logged or persisted anywhere else. A missing key fails the boot with an
 *   actionable message instead of a mid-turn 401.
 */

import {
  PROVIDER_TOKEN_FILE,
  providerDescriptor,
  type ChatModelSelection,
  type ProviderDescriptor,
  type RuntimeHandle
} from "@drydock/contracts";
import type { Logger } from "@drydock/core";
import type { ProviderSecretRefStore } from "./isolatedRunService.js";

export interface ProviderWireExecutor {
  exec(
    handle: RuntimeHandle,
    args: readonly string[],
    timeoutMs: number,
    input?: string
  ): Promise<{ readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }>;
}

export interface ProviderWireDeps {
  readonly runtimeExecutor: ProviderWireExecutor;
  readonly providerSecrets?: ProviderSecretRefStore;
  readonly logger: Logger;
}

const WIRE_EXEC_TIMEOUT_MS = 30_000;

/** Codex `config.toml` for an OpenAI-compatible rider. Contains no secrets. */
export function codexRiderConfigToml(descriptor: ProviderDescriptor): string {
  const wire = descriptor.wire;
  if (wire === undefined || wire.kind !== "openai-compat" || wire.envKey === undefined) {
    throw new Error(`${descriptor.providerId} is not an openai-compat rider.`);
  }
  const defaultModel = (descriptor.models.find((model) => model.isDefault) ?? descriptor.models[0])?.id;
  return [
    `# Written by Drydock: routes this sandbox's Codex CLI to ${descriptor.displayName}.`,
    `model_provider = "${descriptor.providerId}"`,
    ...(defaultModel === undefined ? [] : [`model = "${defaultModel}"`]),
    "",
    `[model_providers.${descriptor.providerId}]`,
    `name = "${descriptor.displayName}"`,
    `base_url = "${wire.baseUrl}"`,
    `env_key = "${wire.envKey}"`,
    `wire_api = "chat"`,
    ""
  ].join("\n");
}

/**
 * ChatSessionService `prepareRuntime` hook. Resolve wiring for the booting
 * provider and write it into the fresh runtime generation.
 */
export function createProviderRuntimePreparer(deps: ProviderWireDeps): (runtime: RuntimeHandle, model: ChatModelSelection) => Promise<void> {
  return async (runtime, model) => {
    const descriptor = providerDescriptor(model.providerId);
    if (descriptor?.wire === undefined) {
      return; // Native provider: the sandbox image and proxy already know it.
    }
    if (descriptor.wire.kind === "openai-compat") {
      const toml = codexRiderConfigToml(descriptor);
      const result = await deps.runtimeExecutor.exec(
        runtime,
        ["/bin/sh", "-c", 'mkdir -p "$HOME/.codex" && base64 -d > "$HOME/.codex/config.toml"'],
        WIRE_EXEC_TIMEOUT_MS,
        Buffer.from(toml, "utf8").toString("base64")
      );
      if (result.exitCode !== 0) {
        throw new Error(`Writing the ${descriptor.displayName} Codex config into the sandbox failed: ${result.stderr.slice(0, 200) || `exit ${String(result.exitCode)}`}`);
      }
      deps.logger.info("provider wire config written", { providerId: descriptor.providerId, runtimeId: runtime.runtimeId });
      return;
    }
    // anthropic-compat rider: runtime-scoped token injection.
    const usesSbxService = descriptor.connect.apiKey?.sbxService !== undefined;
    if (usesSbxService) {
      return; // The sandbox proxy injects this provider's key; no token file needed.
    }
    const token = await deps.providerSecrets?.get(descriptor.providerId);
    if (token === undefined || token.length === 0) {
      throw new Error(`${descriptor.displayName} has no API key configured. Connect the provider from the chat panel, then retry.`);
    }
    const result = await deps.runtimeExecutor.exec(
      runtime,
      ["/bin/sh", "-c", `umask 077 && base64 -d > ${PROVIDER_TOKEN_FILE}`],
      WIRE_EXEC_TIMEOUT_MS,
      Buffer.from(token, "utf8").toString("base64")
    );
    if (result.exitCode !== 0) {
      throw new Error(`Injecting the ${descriptor.displayName} token into the sandbox failed: ${result.stderr.slice(0, 200) || `exit ${String(result.exitCode)}`}`);
    }
    deps.logger.info("provider token injected runtime-scoped", { providerId: descriptor.providerId, runtimeId: runtime.runtimeId });
  };
}
