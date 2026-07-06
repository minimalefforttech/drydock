/**
 * Runtime cleanup service.
 *
 * Cleanup attempts are written before external commands run so failed removal
 * remains visible after process restarts.
 */

import type { CleanupMode, CleanupResult, RuntimeId, RuntimeInventoryStore } from "@drydock/contracts";
import type { Clock } from "./clock.js";
import type { Logger } from "./logger.js";
import type { RuntimeAdapter } from "./runtimeAdapter.js";

export interface RuntimeCleanupServiceOptions {
  readonly clock: Clock;
  readonly inventory: RuntimeInventoryStore;
  readonly runtimeAdapter: RuntimeAdapter;
  readonly logger: Logger;
}

export class RuntimeCleanupService {
  constructor(private readonly options: RuntimeCleanupServiceOptions) {}

  async cleanupRuntime(runtimeId: RuntimeId, mode: CleanupMode): Promise<CleanupResult> {
    const record = await this.options.inventory.getRuntime(runtimeId);
    if (!record) {
      return { runtimeId, status: "failed", mode, diagnostics: [`Runtime ${runtimeId} was not found in inventory.`] };
    }
    await this.options.inventory.updateCleanupAttempt(runtimeId, this.options.clock.isoNow(), false);

    if (mode === "quarantine-only") {
      await this.options.inventory.updateRuntimeStatus(runtimeId, "quarantined", this.options.clock.isoNow());
      return { runtimeId, status: "quarantined", mode, diagnostics: ["Quarantined without destructive cleanup."] };
    }

    const handle = {
      runtimeId: record.runtimeId,
      runtimeGenerationId: record.runtimeGenerationId,
      sessionId: record.sessionId,
      adapter: record.adapter,
      externalName: record.externalName,
      workspacePath: typeof record.metadata["workspacePath"] === "string" ? record.metadata["workspacePath"] : "",
      ...(typeof record.metadata["runtimeCwd"] === "string" ? { runtimeCwd: record.metadata["runtimeCwd"] } : {}),
      mounts: [],
      status: "running" as const
    };

    const diagnostics: string[] = [];
    try {
      await this.options.inventory.updateRuntimeStatus(runtimeId, "stopping", this.options.clock.isoNow());
      const stop = await this.options.runtimeAdapter.stopRuntime(handle, "cleanup");
      diagnostics.push(`stop exit: ${String(stop.exitCode)}`);
      await this.options.inventory.updateRuntimeStatus(runtimeId, "stopped", this.options.clock.isoNow());
      await this.options.inventory.updateRuntimeStatus(runtimeId, "removing", this.options.clock.isoNow());
      const remove = await this.options.runtimeAdapter.removeRuntime(handle, true);
      diagnostics.push(`remove exit: ${String(remove.exitCode)}`);
      if (remove.exitCode !== 0) {
        throw new Error(remove.stderr || remove.error || remove.stdout || "remove failed");
      }
      await this.options.inventory.updateRuntimeStatus(runtimeId, "removed", this.options.clock.isoNow());
      this.options.logger.info("runtime removed", { runtimeId, externalName: record.externalName });
      return { runtimeId, status: "removed", mode, diagnostics };
    } catch (error) {
      await this.options.inventory.updateCleanupAttempt(runtimeId, this.options.clock.isoNow(), true);
      await this.options.inventory.updateRuntimeStatus(runtimeId, "quarantined", this.options.clock.isoNow());
      diagnostics.push(error instanceof Error ? error.message : String(error));
      this.options.logger.error("runtime cleanup failed", { runtimeId, externalName: record.externalName });
      return { runtimeId, status: "failed", mode, diagnostics };
    }
  }
}
