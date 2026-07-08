/**
 * Docker Sandbox runtime adapter.
 *
 * Host execution is limited to Docker Sandbox lifecycle, policy, and exec
 * control commands. Agent prompts run inside the created sandbox.
 */

import path from "node:path";
import type {
  CommandResult,
  CommandRunner,
  RuntimeHandle,
  RuntimeInventoryRecord,
  StartRuntimeRequest
} from "@drydock/contracts";
import { sandboxRuntimePath } from "@drydock/core";
import type { RuntimeAdapter } from "@drydock/core";
import type { Logger } from "@drydock/core";

export interface DockerSandboxRuntimeAdapterOptions {
  readonly sbxPath: string;
  readonly commandRunner: CommandRunner;
  readonly cwd: string;
  readonly logger: Logger;
  readonly createTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
}

export class DockerSandboxRuntimeAdapter implements RuntimeAdapter {
  readonly adapter: RuntimeInventoryRecord["adapter"] = "docker-sandbox";
  private readonly createTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly networkPolicies = new Map<string, string>();

  constructor(private readonly options: DockerSandboxRuntimeAdapterOptions) {
    this.createTimeoutMs = options.createTimeoutMs ?? 120_000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
  }

  async createRuntime(request: StartRuntimeRequest, externalName: string): Promise<RuntimeHandle> {
    // The workspace path is sbx's positional arg; every other mount (project
    // roots, shared paths, approved access requests) passes as `path[:ro]`.
    const workspaceKey = path.resolve(request.workspacePath);
    const mountArgs = request.template.mounts
      .filter((mount) => path.resolve(mount.hostPath) !== workspaceKey)
      .map((mount) => mount.mode === "read-only" ? `${mount.hostPath}:ro` : mount.hostPath);
    const agent = typeof request.template.advancedOptions["sandboxAgent"] === "string"
      ? request.template.advancedOptions["sandboxAgent"]
      : "codex";
    const result = await this.options.commandRunner.run(
      this.options.sbxPath,
      ["create", "--name", externalName, agent, request.workspacePath, ...mountArgs],
      { cwd: this.options.cwd, timeoutMs: this.createTimeoutMs }
    );
    if (result.exitCode !== 0) {
      const detail = result.stderr || result.error || result.stdout;
      throw new Error(`sbx create failed: ${detail}${authHint(detail)}`);
    }
    const handle: RuntimeHandle = {
      runtimeId: request.runtimeId,
      runtimeGenerationId: request.generationId,
      sessionId: request.sessionId,
      adapter: this.adapter,
      externalName,
      workspacePath: request.workspacePath,
      runtimeCwd: toDockerSandboxPath(request.workspacePath),
      mounts: request.template.mounts,
      status: "running"
    };
    const resources = networkResources(request.template.advancedOptions);
    if (request.template.network === "allowed" && resources) {
      const allow = await this.allowNetwork(handle, resources);
      if (allow.exitCode !== 0) {
        throw new Error(`sbx network allow failed: ${allow.stderr || allow.error || allow.stdout}`);
      }
      this.networkPolicies.set(handle.externalName, resources);
    }
    return handle;
  }

  async stopRuntime(handle: RuntimeHandle, _reason: string): Promise<CommandResult> {
    return this.options.commandRunner.run(
      this.options.sbxPath,
      ["stop", handle.externalName],
      { cwd: this.options.cwd, timeoutMs: this.commandTimeoutMs }
    );
  }

  async removeRuntime(handle: RuntimeHandle, force: boolean): Promise<CommandResult> {
    const resources = this.networkPolicies.get(handle.externalName);
    if (resources) {
      const removePolicy = await this.removeNetwork(handle, resources);
      if (removePolicy.exitCode !== 0) {
        this.options.logger.warn("sandbox network allow removal failed before runtime removal", {
          runtimeId: handle.runtimeId,
          resources
        });
      }
      this.networkPolicies.delete(handle.externalName);
    }
    const args = force ? ["rm", "--force", handle.externalName] : ["rm", handle.externalName];
    return this.options.commandRunner.run(this.options.sbxPath, args, {
      cwd: this.options.cwd,
      timeoutMs: this.commandTimeoutMs
    });
  }

  async exec(handle: RuntimeHandle, args: readonly string[], timeoutMs: number, input?: string, signal?: AbortSignal): Promise<CommandResult> {
    return this.options.commandRunner.run(
      this.options.sbxPath,
      ["exec", handle.externalName, ...args],
      {
        cwd: this.options.cwd,
        timeoutMs,
        ...(input === undefined ? {} : { input }),
        ...(signal === undefined ? {} : { signal })
      }
    );
  }

  /** Lists product-prefixed sandbox names via `sbx ls` for inventory reconciliation. */
  async listExternalRuntimeNames(namePrefix: string): Promise<string[]> {
    const result = await this.options.commandRunner.run(
      this.options.sbxPath,
      ["ls"],
      { cwd: this.options.cwd, timeoutMs: this.commandTimeoutMs }
    );
    if (result.exitCode !== 0) {
      throw new Error(`sbx ls failed: ${result.stderr || result.error || result.stdout}`);
    }
    // Token-extract rather than parse a table layout so format drift in sbx
    // output cannot silently break reconciliation.
    const pattern = new RegExp(`${escapeRegExp(namePrefix)}-[A-Za-z0-9-]+`, "g");
    const names = new Set<string>();
    for (const match of result.stdout.matchAll(pattern)) {
      names.add(match[0]);
    }
    return [...names];
  }

  async allowNetwork(handle: RuntimeHandle, resources: string): Promise<CommandResult> {
    this.options.logger.info("sandbox network allow requested", { runtimeId: handle.runtimeId, resources });
    return this.options.commandRunner.run(
      this.options.sbxPath,
      ["policy", "allow", "network", "--sandbox", handle.externalName, resources],
      { cwd: this.options.cwd, timeoutMs: this.commandTimeoutMs }
    );
  }

  async removeNetwork(handle: RuntimeHandle, resources: string): Promise<CommandResult> {
    return this.options.commandRunner.run(
      this.options.sbxPath,
      ["policy", "rm", "network", "--sandbox", handle.externalName, "--resource", resources],
      { cwd: this.options.cwd, timeoutMs: this.commandTimeoutMs }
    );
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Appends actionable guidance when sbx fails on authentication. The common cause
 * is NOT that the user is signed out, but that the extension host (a GUI-launched
 * VS Code) can't reach the same Docker/sbx session the user's terminal can —
 * usually the Docker credential helper isn't on the extension's PATH.
 */
function authHint(detail: string): string {
  if (!/not authenticated|no valid user session|secret not found|401|sbx login/i.test(detail)) {
    return "";
  }
  return [
    "",
    "The extension host isn't seeing your Docker Sandbox session. Try, in order:",
    "1. Use the “Sign in to Docker Sandbox” button below (runs sbx login).",
    "2. If that succeeds, reload the window and send again.",
    "3. Otherwise launch VS Code from a terminal where sbx works (code .).",
    "4. Confirm Docker Desktop is running.",
    "Drydock adds Docker Desktop's bin to PATH; a non-standard install may need drydock.runtime.pathAdditions."
  ].join("\n");
}

/** Provider-scoped egress allowlist; the legacy codex-specific key still reads. */
function networkResources(advancedOptions: Record<string, unknown>): string | undefined {
  const generic = advancedOptions["networkResources"];
  if (typeof generic === "string") return generic;
  const legacy = advancedOptions["codexNetworkResources"];
  return typeof legacy === "string" ? legacy : undefined;
}

/**
 * The sandbox mount point for a host path. Delegates to core's
 * `sandboxRuntimePath` so the container path advertised in mount policies (and
 * thus the briefing/UI) is the exact location sbx mounts the folder at.
 */
export function toDockerSandboxPath(hostPath: string): string {
  return sandboxRuntimePath(hostPath);
}
