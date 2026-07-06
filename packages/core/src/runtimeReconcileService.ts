/**
 * Runtime inventory reconciliation.
 *
 * Compares durable inventory against externally visible runtime names on
 * activation. It records db-only active runtimes as lost and reports
 * external-only names for diagnostics; destructive cleanup remains explicit.
 */

import type {
  RuntimeId,
  RuntimeInventoryReconcileResult,
  RuntimeInventoryStore,
  RuntimeStatus
} from "@drydock/contracts";
import type { Clock } from "./clock.js";
import type { Logger } from "./logger.js";
import type { RuntimeAdapter } from "./runtimeAdapter.js";

export interface RuntimeReconcileServiceOptions {
  readonly clock: Clock;
  readonly inventory: RuntimeInventoryStore;
  readonly runtimeAdapter: RuntimeAdapter;
  readonly logger: Logger;
  readonly runtimeNamePrefix?: string;
}

const DB_ACTIVE_STATUSES = new Set<RuntimeStatus>(["starting", "running", "stopping"]);

/** Reconciles product-owned runtime inventory against the adapter's external list. */
export class RuntimeReconcileService {
  private readonly prefix: string;

  constructor(private readonly options: RuntimeReconcileServiceOptions) {
    this.prefix = options.runtimeNamePrefix ?? "drydock";
  }

  async reconcile(): Promise<RuntimeInventoryReconcileResult> {
    const reconciledAt = this.options.clock.isoNow();
    const externalNames = await this.options.runtimeAdapter.listExternalRuntimeNames(this.prefix);
    const external = new Set(externalNames);
    const inventory = await this.options.inventory.listRuntimes();
    const knownNames = new Set(inventory.map((runtime) => runtime.externalName));
    const missingExternal: RuntimeId[] = [];

    for (const runtime of inventory) {
      if (external.has(runtime.externalName)) {
        await this.options.inventory.updateRuntimeMetadata(runtime.runtimeId, { lastReconciledAt: reconciledAt }, reconciledAt);
        continue;
      }
      if (DB_ACTIVE_STATUSES.has(runtime.status)) {
        await this.options.inventory.updateRuntimeStatus(runtime.runtimeId, "lost", reconciledAt);
        missingExternal.push(runtime.runtimeId);
        this.options.logger.warn("runtime missing during reconciliation", {
          runtimeId: runtime.runtimeId,
          externalName: runtime.externalName,
          previousStatus: runtime.status
        });
      }
    }

    const externalOnly = externalNames
      .filter((name) => !knownNames.has(name))
      .sort();
    return {
      reconciledAt,
      externalOnly,
      missingExternal
    };
  }
}
