/**
 * Runtime inventory reconciliation.
 *
 * Compares durable inventory against externally visible runtime names on
 * activation. It records db-only active runtimes as lost and reports
 * external-only names for diagnostics; destructive cleanup remains explicit.
 *
 * With more than one adapter kind registered (ADR 0022), the external name set
 * is the UNION across adapters, and a record is only judged when the adapter for
 * ITS kind listed successfully. An adapter that threw, or that is not registered
 * at all, leaves its rows untouched in `unresolvedAdapters` - absence of
 * evidence is not evidence of absence, and marking a validation VM "lost"
 * because Hyper-V was momentarily unavailable would be a lie the UI repeats.
 */

import type {
  RuntimeAdapterKind,
  RuntimeId,
  RuntimeInventoryReconcileResult,
  RuntimeInventoryStore,
  RuntimeStatus
} from "@drydock/contracts";
import type { Clock } from "./clock.js";
import type { Logger } from "./logger.js";
import { RuntimeAdapterRegistry, type RuntimeAdapterSelection } from "./runtimeAdapter.js";

export type RuntimeReconcileServiceOptions = {
  readonly clock: Clock;
  readonly inventory: RuntimeInventoryStore;
  readonly logger: Logger;
  readonly runtimeNamePrefix?: string;
} & RuntimeAdapterSelection;

const DB_ACTIVE_STATUSES = new Set<RuntimeStatus>(["starting", "running", "stopping"]);

/** Reconciles product-owned runtime inventory against the adapter's external list. */
export class RuntimeReconcileService {
  private readonly prefix: string;
  private readonly adapters: RuntimeAdapterRegistry;

  constructor(private readonly options: RuntimeReconcileServiceOptions) {
    this.prefix = options.runtimeNamePrefix ?? "drydock";
    this.adapters = new RuntimeAdapterRegistry(options);
  }

  async reconcile(): Promise<RuntimeInventoryReconcileResult> {
    const reconciledAt = this.options.clock.isoNow();
    const externalNames: string[] = [];
    const listedKinds = new Set<RuntimeAdapterKind>();
    for (const adapter of this.adapters.all) {
      try {
        externalNames.push(...await adapter.listExternalRuntimeNames(this.prefix));
        listedKinds.add(adapter.adapter);
      } catch (error) {
        // Degrade to "unknown" for this adapter only. Its records stay
        // unjudged below rather than being swept up as lost.
        this.options.logger.warn("runtime listing failed during reconciliation", {
          adapter: adapter.adapter,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    const external = new Set(externalNames);
    const inventory = await this.options.inventory.listRuntimes();
    const knownNames = new Set(inventory.map((runtime) => runtime.externalName));
    const missingExternal: RuntimeId[] = [];
    const unresolvedAdapters: RuntimeId[] = [];

    for (const runtime of inventory) {
      if (!listedKinds.has(runtime.adapter)) {
        unresolvedAdapters.push(runtime.runtimeId);
        continue;
      }
      if (external.has(runtime.externalName)) {
        if (runtime.status === "lost") {
          await this.options.inventory.updateRuntimeStatus(runtime.runtimeId, "quarantined", reconciledAt);
          this.options.logger.warn("lost runtime found during reconciliation", {
            runtimeId: runtime.runtimeId,
            externalName: runtime.externalName
          });
        }
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
      } else if (runtime.status !== "removed") {
        // The sandbox is confirmed gone from the host and the row is not active,
        // so any pending/failed cleanup is moot - reap it to "removed" instead of
        // leaving quarantined/lost rows piling up forever (they survive `sbx reset`
        // because they are product inventory, not sandboxes).
        await this.options.inventory.updateRuntimeStatus(runtime.runtimeId, "removed", reconciledAt);
      }
    }

    const externalOnly = [...new Set(externalNames)]
      .filter((name) => !knownNames.has(name))
      .sort();
    if (unresolvedAdapters.length > 0) {
      this.options.logger.warn("runtimes left unjudged during reconciliation", {
        count: unresolvedAdapters.length,
        registeredKinds: [...this.adapters.kinds]
      });
    }
    return {
      reconciledAt,
      externalOnly,
      missingExternal,
      ...(unresolvedAdapters.length === 0 ? {} : { unresolvedAdapters })
    };
  }
}
