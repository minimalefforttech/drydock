/**
 * Runtime adapter port.
 *
 * Implementations may call host-side runtime control commands such as `sbx`,
 * but never execute agent-requested commands directly on the host.
 */

import type {
  CommandResult,
  RuntimeAdapterKind,
  RuntimeHandle,
  RuntimeInventoryRecord,
  StartRuntimeRequest
} from "@drydock/contracts";

export interface RuntimeAdapter {
  readonly adapter: RuntimeInventoryRecord["adapter"];
  createRuntime(request: StartRuntimeRequest, externalName: string): Promise<RuntimeHandle>;
  stopRuntime(handle: RuntimeHandle, reason: string): Promise<CommandResult>;
  removeRuntime(handle: RuntimeHandle, force: boolean): Promise<CommandResult>;
  /** Returns externally visible runtime names owned by the given product prefix. */
  listExternalRuntimeNames(namePrefix: string): Promise<string[]>;
}

/**
 * How a service is given its adapters (ADR 0022 M3). `runtimeAdapter` is the
 * original single-adapter shape and keeps working unchanged; `runtimeAdapters`
 * adds the kinds a second runtime class needs (`hyperv` beside
 * `docker-sandbox`). Passing both is allowed - the first registration for a kind
 * wins, and duplicates are ignored rather than silently overriding.
 *
 * The union makes "at least one adapter" a COMPILE-TIME requirement: a service
 * with no adapter at all could only fail at activation, which in an extension
 * host means a dead command surface rather than a red test.
 */
export type RuntimeAdapterSelection =
  | { readonly runtimeAdapter: RuntimeAdapter; readonly runtimeAdapters?: readonly RuntimeAdapter[] }
  | { readonly runtimeAdapter?: RuntimeAdapter; readonly runtimeAdapters: readonly RuntimeAdapter[] };

/**
 * Adapter lookup by kind. Records name their adapter kind durably, so cleanup
 * and reconciliation resolve the adapter FROM THE RECORD rather than assuming
 * the one adapter the process happens to hold.
 */
export class RuntimeAdapterRegistry {
  private readonly byKind = new Map<RuntimeAdapterKind, RuntimeAdapter>();

  constructor(selection: RuntimeAdapterSelection) {
    for (const adapter of [...(selection.runtimeAdapters ?? []), ...(selection.runtimeAdapter === undefined ? [] : [selection.runtimeAdapter])]) {
      if (this.byKind.has(adapter.adapter)) continue;
      this.byKind.set(adapter.adapter, adapter);
    }
    if (this.byKind.size === 0) {
      // Belt and braces: the option types already require one, but an empty
      // `runtimeAdapters: []` satisfies the type and must not compose.
      throw new Error("At least one runtime adapter is required (runtimeAdapter or runtimeAdapters).");
    }
  }

  /** Registration order, so callers that fan out stay deterministic. */
  get all(): readonly RuntimeAdapter[] {
    return [...this.byKind.values()];
  }

  get kinds(): readonly RuntimeAdapterKind[] {
    return [...this.byKind.keys()];
  }

  find(kind: RuntimeAdapterKind): RuntimeAdapter | undefined {
    return this.byKind.get(kind);
  }

  /**
   * The adapter for `kind`, or a failure that names what was asked for and what
   * is actually registered - "no adapter" with neither is unactionable.
   */
  require(kind: RuntimeAdapterKind, context: string): RuntimeAdapter {
    const adapter = this.byKind.get(kind);
    if (adapter === undefined) {
      throw new Error(
        `No runtime adapter is registered for kind "${kind}" (${context}). Registered kinds: ${this.kinds.join(", ")}.`
      );
    }
    return adapter;
  }
}
