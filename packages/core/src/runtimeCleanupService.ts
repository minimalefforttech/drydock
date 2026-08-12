/**
 * Runtime cleanup service.
 *
 * Cleanup attempts are written before external commands run so failed removal
 * remains visible after process restarts.
 */

import type { CleanupMode, CleanupResult, CommandResult, RuntimeId, RuntimeInventoryStore } from "@drydock/contracts";
import type { Clock } from "./clock.js";
import type { Logger } from "./logger.js";
import { RuntimeAdapterRegistry, type RuntimeAdapterSelection } from "./runtimeAdapter.js";

export type RuntimeCleanupServiceOptions = {
  readonly clock: Clock;
  readonly inventory: RuntimeInventoryStore;
  readonly logger: Logger;
} & RuntimeAdapterSelection;

export class RuntimeCleanupService {
  private readonly adapters: RuntimeAdapterRegistry;

  constructor(private readonly options: RuntimeCleanupServiceOptions) {
    this.adapters = new RuntimeAdapterRegistry(options);
  }

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

    // A record whose adapter kind is not registered in THIS process (a hyperv
    // row on a host that no longer discovers Hyper-V, say) must not be reported
    // as cleaned. Quarantine it with the reason so the row stays visible and a
    // later process with that adapter can finish the job.
    const runtimeAdapter = this.adapters.find(record.adapter);
    if (runtimeAdapter === undefined) {
      await this.options.inventory.updateCleanupAttempt(runtimeId, this.options.clock.isoNow(), true);
      await this.options.inventory.updateRuntimeStatus(runtimeId, "quarantined", this.options.clock.isoNow());
      const diagnostic = `No runtime adapter is registered for kind "${record.adapter}"; ${record.externalName} was quarantined instead of removed. Registered kinds: ${this.adapters.kinds.join(", ")}.`;
      this.options.logger.warn("runtime cleanup skipped: adapter kind unavailable", {
        runtimeId,
        externalName: record.externalName,
        adapter: record.adapter
      });
      return { runtimeId, status: "quarantined", mode, diagnostics: [diagnostic] };
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
      const stop = await runtimeAdapter.stopRuntime(handle, "cleanup");
      diagnostics.push(`stop exit: ${String(stop.exitCode)}`);
      await this.options.inventory.updateRuntimeStatus(runtimeId, "stopped", this.options.clock.isoNow());
      await this.options.inventory.updateRuntimeStatus(runtimeId, "removing", this.options.clock.isoNow());
      const remove = await runtimeAdapter.removeRuntime(handle, true);
      diagnostics.push(`remove exit: ${String(remove.exitCode)}`);
      // A remove that fails because the sandbox is ALREADY GONE is a success, not
      // a quarantine - otherwise every cleanup of a sandbox that `sbx reset` (or a
      // prior removal) already deleted leaves a permanently quarantined row.
      if (remove.exitCode !== 0 && !isAlreadyGone(remove)) {
        throw new Error(remove.stderr || remove.error || remove.stdout || "remove failed");
      }
      await this.options.inventory.updateRuntimeStatus(runtimeId, "removed", this.options.clock.isoNow());
      this.options.logger.info("runtime removed", { runtimeId, externalName: record.externalName, alreadyGone: remove.exitCode !== 0 });
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

/**
 * True when a remove failed only because the runtime no longer exists. The
 * Hyper-V phrases (ADR 0022) matter for the same reason the sbx ones do: a
 * validation VM that a human already deleted must reap the row, not leave it
 * quarantined forever.
 *
 * The docker-sandbox phrases stay broad and read the combined output. The
 * Hyper-V phrases are tightened to Hyper-V's specific absent-VM wording (no bare
 * `no virtual machine`, no unanchored `.*`) and read stderr/error ONLY: Hyper-V
 * lists VM names on stdout, and a real stop/remove failure that merely mentions
 * "virtual machine" must never reap the row of a VM the product still owns.
 */
function isAlreadyGone(result: CommandResult): boolean {
  const combined = `${result.stderr} ${result.error ?? ""} ${result.stdout}`.toLowerCase();
  if (/not found|no such|does not exist|unknown sandbox|no container/.test(combined)) {
    return true;
  }
  const hypervDetail = `${result.stderr} ${result.error ?? ""}`.toLowerCase();
  return /unable to find (a )?virtual machine|no virtual machine (was )?found (with|matching)/.test(hypervDetail);
}
