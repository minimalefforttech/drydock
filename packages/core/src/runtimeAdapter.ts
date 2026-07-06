/**
 * Runtime adapter port.
 *
 * Implementations may call host-side runtime control commands such as `sbx`,
 * but never execute agent-requested commands directly on the host.
 */

import type {
  CommandResult,
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
