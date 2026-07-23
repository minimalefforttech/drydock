/**
 * Host-driven provider sign-in (the guided connect flow).
 *
 * Auth handshakes are interactive user setup, not agent work, so they run on
 * the HOST where a browser and a localhost OAuth callback both work natively -
 * exactly like `sbx secret set -g openai --oauth` already does. Only
 * prompt-bearing agent execution stays inside sandboxes.
 *
 * Instead of dropping the user into a bare terminal, Drydock spawns the login
 * process itself with piped stdio, scrapes the sign-in URL from its output,
 * opens the browser, relays an optional paste-back code from the webview into
 * the process's stdin, and verifies completion by re-probing auth status.
 *
 * Secret hygiene: captured tokens and submitted API keys live in process
 * memory only on their way into the Docker Sandbox secret ledger (OS
 * keychain) or VS Code SecretStorage. They are never logged, never persisted
 * by Drydock, and never echoed back to the webview; progress `detail` strings
 * are scrubbed against token shapes before they leave this module.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { providerDescriptor, type ProviderAuthStatus } from "@drydock/contracts";
import type { Logger } from "@drydock/core";
import type { ProviderSecretRefStore } from "./isolatedRunService.js";

export interface ProviderAuthProgress {
  readonly providerId: string;
  readonly phase: "launched" | "browser-opened" | "awaiting-code" | "verifying" | "connected" | "failed";
  readonly detail?: string;
}

export interface ProviderConnectDeps {
  readonly logger: Logger;
  readonly sbxPath?: string;
  readonly hostClaudePath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly providerSecrets?: ProviderSecretRefStore;
  /** Interactive/network policy gate; throws in managed mode. */
  readonly assertInteractiveSetupAllowed: (action: string) => void;
  /** Opens a URL in the user's browser. */
  readonly openExternal: (url: string) => Promise<void> | void;
  /** Forced auth re-probe; returns the provider's status afterwards. */
  readonly refreshAuthStatus: (providerId: string) => Promise<ProviderAuthStatus>;
  readonly onProgress: (progress: ProviderAuthProgress) => void;
  /** Overridable for tests. */
  readonly spawnProcess?: typeof spawn;
  readonly flowTimeoutMs?: number;
  readonly browserOpenDelayMs?: number;
}

interface ActiveFlow {
  readonly child: ChildProcessWithoutNullStreams;
  readonly timers: (NodeJS.Timeout | undefined)[];
  buffer: string;
  urlSeen?: string;
  awaitingCode: boolean;
  settled: boolean;
}

const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/;
const CODE_PROMPT_PATTERN = /(paste|enter)[^\n]{0,60}code|authorization code|code[^\n]{0,30}(here|below)/i;
const CLAUDE_TOKEN_PATTERN = /sk-ant-[A-Za-z0-9_-]{20,}/;
/** Shapes that must never leave this module inside a progress detail. */
const SECRET_SHAPES = [/sk-[A-Za-z0-9_-]{10,}/g, /Bearer\s+\S+/gi];
const BUFFER_CAP = 64 * 1024;
const DEFAULT_FLOW_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_BROWSER_OPEN_DELAY_MS = 4_000;
const SECRET_SET_TIMEOUT_MS = 30_000;

function scrubDetail(detail: string): string {
  let scrubbed = detail;
  for (const shape of SECRET_SHAPES) {
    scrubbed = scrubbed.replace(shape, "[redacted]");
  }
  return scrubbed.slice(0, 500);
}

export class ProviderConnectService {
  private readonly flows = new Map<string, ActiveFlow>();

  constructor(private readonly deps: ProviderConnectDeps) {}

  /**
   * Starts sign-in for a provider. Returns "guided" when this service owns
   * the flow (progress arrives via onProgress), or "terminal" when the caller
   * should fall back to a visible terminal (Claude without a host CLI).
   * API-key providers never come through here; the connect card collects a
   * key via submitApiKey instead.
   */
  begin(providerId: string): { readonly mode: "guided" | "terminal"; readonly display: string } {
    this.deps.assertInteractiveSetupAllowed("Provider sign-in");
    const descriptor = providerDescriptor(providerId);
    if (descriptor === undefined) {
      throw new Error(`Unknown provider ${providerId}.`);
    }
    this.cancel(providerId);
    if (descriptor.connect.oauth === "sbx-service-oauth" && descriptor.connect.sbxService !== undefined) {
      if (this.deps.sbxPath === undefined) throw new Error("Docker Sandbox `sbx` is not available in this window.");
      const args = ["secret", "set", "-g", descriptor.connect.sbxService, "--oauth"];
      this.launchGuided(providerId, this.deps.sbxPath, args, { expectToken: false });
      return { mode: "guided", display: `sbx ${args.join(" ")}` };
    }
    if (descriptor.connect.oauth === "claude-host-token") {
      if (this.deps.hostClaudePath !== undefined && this.deps.sbxPath !== undefined) {
        this.launchGuided(providerId, this.deps.hostClaudePath, ["setup-token"], { expectToken: true });
        return { mode: "guided", display: "claude setup-token (host) → sbx secret set -g anthropic" };
      }
      return { mode: "terminal", display: "sbx run claude (then /login inside Claude)" };
    }
    if (descriptor.connect.oauth === "sandbox-terminal") {
      return { mode: "terminal", display: "sbx run claude (then /login inside Claude)" };
    }
    throw new Error(`${descriptor.displayName} signs in with an API key; enter one on the connect card instead.`);
  }

  /** Relays a paste-back OAuth code from the webview into the flow's stdin. */
  submitCode(providerId: string, code: string): boolean {
    const flow = this.flows.get(providerId);
    if (flow === undefined || flow.settled) return false;
    flow.child.stdin.write(`${code.trim()}\n`);
    return true;
  }

  /**
   * Stores an API key: providers with a Docker Sandbox service pipe it into
   * `sbx secret set -g <service>` (OS keychain, proxy-injected); the rest go
   * to VS Code SecretStorage for runtime-scoped injection.
   */
  async submitApiKey(providerId: string, apiKey: string): Promise<ProviderAuthStatus> {
    this.deps.assertInteractiveSetupAllowed("Provider API key setup");
    const descriptor = providerDescriptor(providerId);
    const spec = descriptor?.connect.apiKey;
    if (descriptor === undefined || spec === undefined) {
      throw new Error(`Provider ${providerId} does not accept an API key.`);
    }
    const trimmed = apiKey.trim();
    if (trimmed.length === 0) throw new Error("The API key was empty.");
    if (spec.sbxService !== undefined) {
      await this.runSbxSecretSet(spec.sbxService, trimmed);
    } else {
      if (this.deps.providerSecrets === undefined) {
        throw new Error("Secret storage is unavailable in this window.");
      }
      await this.deps.providerSecrets.set(providerId, trimmed);
    }
    return this.deps.refreshAuthStatus(providerId);
  }

  cancel(providerId: string): boolean {
    const flow = this.flows.get(providerId);
    if (flow === undefined) return false;
    this.settle(providerId, flow);
    try {
      flow.child.kill();
    } catch {
      // Already exited.
    }
    return true;
  }

  dispose(): void {
    for (const providerId of [...this.flows.keys()]) {
      this.cancel(providerId);
    }
  }

  private launchGuided(providerId: string, command: string, args: readonly string[], options: { readonly expectToken: boolean }): void {
    const spawnProcess = this.deps.spawnProcess ?? spawn;
    const child = spawnProcess(command, [...args], {
      env: this.deps.environment ?? process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const flow: ActiveFlow = { child, timers: [], buffer: "", awaitingCode: false, settled: false };
    this.flows.set(providerId, flow);
    this.progress(providerId, "launched", `${command.split(/[\\/]/).pop() ?? command} ${args.join(" ")}`);
    flow.timers.push(setTimeout(() => {
      if (!flow.settled) {
        this.progress(providerId, "failed", "Sign-in timed out. Try again, or use the terminal fallback.");
        this.cancel(providerId);
      }
    }, this.deps.flowTimeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS));

    const onChunk = (chunk: Buffer): void => {
      if (flow.settled) return;
      flow.buffer = (flow.buffer + chunk.toString("utf8")).slice(-BUFFER_CAP);
      if (flow.urlSeen === undefined) {
        const url = URL_PATTERN.exec(flow.buffer)?.[0];
        if (url !== undefined) {
          flow.urlSeen = url;
          // The CLI usually opens the browser itself; the delayed nudge covers
          // environments where that silently fails. The URL itself is
          // display-safe and rendered as a link in the connect card.
          this.progress(providerId, "browser-opened", url);
          flow.timers.push(setTimeout(() => {
            if (!flow.settled) void this.deps.openExternal(url);
          }, this.deps.browserOpenDelayMs ?? DEFAULT_BROWSER_OPEN_DELAY_MS));
        }
      }
      if (!flow.awaitingCode && CODE_PROMPT_PATTERN.test(flow.buffer)) {
        flow.awaitingCode = true;
        this.progress(providerId, "awaiting-code", "Paste the code from your browser into the field below.");
      }
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.on("error", (error) => {
      if (flow.settled) return;
      this.settle(providerId, flow);
      this.progress(providerId, "failed", scrubDetail(error.message));
    });
    child.on("close", (exitCode) => {
      if (flow.settled) return;
      this.settle(providerId, flow);
      void this.completeGuided(providerId, flow, exitCode, options.expectToken);
    });
  }

  private async completeGuided(providerId: string, flow: ActiveFlow, exitCode: number | null, expectToken: boolean): Promise<void> {
    if (exitCode !== 0) {
      const tail = scrubDetail(flow.buffer.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-3).join(" · "));
      this.progress(providerId, "failed", tail.length > 0 ? tail : `The sign-in process exited with code ${String(exitCode)}.`);
      return;
    }
    try {
      this.progress(providerId, "verifying");
      if (expectToken) {
        const token = CLAUDE_TOKEN_PATTERN.exec(flow.buffer)?.[0];
        // The captured buffer holds the token; drop it before anything else runs.
        flow.buffer = "";
        if (token === undefined) {
          this.progress(providerId, "failed", "The sign-in finished but no token was produced. Use the terminal fallback.");
          return;
        }
        const service = providerDescriptor(providerId)?.connect.sbxService;
        if (service === undefined) throw new Error(`Provider ${providerId} has no sandbox secret service.`);
        await this.runSbxSecretSet(service, token);
      }
      const status = await this.deps.refreshAuthStatus(providerId);
      if (status === "authenticated") {
        this.progress(providerId, "connected");
      } else {
        this.progress(providerId, "failed", "The sign-in finished but the credential did not register. Click Recheck, or try again.");
      }
    } catch (error) {
      this.progress(providerId, "failed", scrubDetail(error instanceof Error ? error.message : String(error)));
    }
  }

  /** Pipes a secret value into `sbx secret set -g <service>` over stdin. */
  private runSbxSecretSet(service: string, value: string): Promise<void> {
    const sbxPath = this.deps.sbxPath;
    if (sbxPath === undefined) {
      return Promise.reject(new Error("Docker Sandbox `sbx` is not available in this window."));
    }
    const spawnProcess = this.deps.spawnProcess ?? spawn;
    return new Promise((resolve, reject) => {
      const child = spawnProcess(sbxPath, ["secret", "set", "-g", service], {
        env: this.deps.environment ?? process.env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("sbx secret set timed out."));
      }, SECRET_SET_TIMEOUT_MS);
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-2_000);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        if (exitCode === 0) resolve();
        else reject(new Error(`sbx secret set -g ${service} failed: ${scrubDetail(stderr) || `exit ${String(exitCode)}`}`));
      });
      child.stdin.write(value);
      child.stdin.end();
    });
  }

  private progress(providerId: string, phase: ProviderAuthProgress["phase"], detail?: string): void {
    this.deps.logger.info("provider connect progress", { providerId, phase });
    this.deps.onProgress({ providerId, phase, ...(detail === undefined ? {} : { detail: scrubDetail(detail) }) });
  }

  private settle(providerId: string, flow: ActiveFlow): void {
    flow.settled = true;
    for (const timer of flow.timers) {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (this.flows.get(providerId) === flow) {
      this.flows.delete(providerId);
    }
  }
}
