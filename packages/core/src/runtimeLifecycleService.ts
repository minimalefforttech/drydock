/**
 * Runtime lifecycle service.
 *
 * Records inventory before external creation and keeps runtime status changes
 * durable as host-side control commands run.
 */

import type {
  RuntimeHandle,
  RuntimeInventoryRecord,
  RuntimeInventoryStore,
  RuntimeStatus,
  StartRuntimeRequest
} from "@drydock/contracts";
import type { Clock } from "./clock.js";
import type { Logger } from "./logger.js";
import { RuntimeAdapterRegistry, type RuntimeAdapterSelection } from "./runtimeAdapter.js";
import { buildRuntimeName } from "./runtimeNames.js";

export type RuntimeLifecycleServiceOptions = {
  readonly clock: Clock;
  readonly inventory: RuntimeInventoryStore;
  readonly logger: Logger;
  /** Final authorization immediately before the external runtime is created. */
  readonly authorizeStart?: (request: StartRuntimeRequest) => void | Promise<void>;
  readonly runtimeNamePrefix?: string;
} & RuntimeAdapterSelection;

export class RuntimeLifecycleService {
  private readonly prefix: string;
  private readonly adapters: RuntimeAdapterRegistry;

  constructor(private readonly options: RuntimeLifecycleServiceOptions) {
    this.prefix = options.runtimeNamePrefix ?? "drydock";
    this.adapters = new RuntimeAdapterRegistry(options);
  }

  async startRuntime(request: StartRuntimeRequest): Promise<RuntimeHandle> {
    // Resolve the adapter BEFORE anything durable is written: a template kind
    // nobody can service must fail loudly, not leave a `starting` row that no
    // adapter can ever clean up.
    const runtimeAdapter = this.adapters.require(request.template.type, `template ${request.template.id}`);
    const startedAt = this.options.clock.isoNow();
    const externalName = buildRuntimeName(this.prefix, request.sessionId, request.generationId, request.agentRole);
    const record = makeStartingRecord(request, externalName, runtimeAdapter.adapter, startedAt);
    await this.options.inventory.insertRuntime(record);
    this.options.logger.info("runtime starting", { runtimeId: request.runtimeId, externalName });

    let handle: RuntimeHandle | undefined;
    try {
      await this.options.authorizeStart?.(request);
      handle = await runtimeAdapter.createRuntime(request, externalName);
      const durableHandleFacts = {
        // Durable fallback for removeRuntime after a restart: the adapter's
        // in-process policy map does not survive one, so the inventory
        // record's metadata becomes the only place this string still exists.
        ...(handle.networkAllowResources === undefined ? {} : { networkAllowResources: handle.networkAllowResources }),
        // The adopted-handle rebuilders prefer a RECORDED cwd and only derive
        // one (docker drive rewrite) when this key is absent; hyperv's
        // guestJobRoot is not derivable from workspacePath at all, so the
        // adapter's answer is persisted rather than re-guessed on adoption.
        ...(handle.runtimeCwd === undefined ? {} : { runtimeCwd: handle.runtimeCwd })
      };
      if (Object.keys(durableHandleFacts).length > 0) {
        await this.options.inventory.updateRuntimeMetadata(
          request.runtimeId,
          durableHandleFacts,
          this.options.clock.isoNow()
        );
      }
      await this.options.inventory.updateRuntimeStatus(request.runtimeId, "running", this.options.clock.isoNow());
      this.options.logger.info("runtime running", { runtimeId: request.runtimeId, externalName });
      return handle;
    } catch (error) {
      let finalStatus: RuntimeStatus = "lost";
      if (handle !== undefined) {
        try {
          const removal = await runtimeAdapter.removeRuntime(handle, true);
          if (removal.exitCode === 0) {
            finalStatus = "removed";
          } else {
            this.options.logger.warn("runtime cleanup failed after start error", {
              runtimeId: request.runtimeId,
              externalName,
              exitCode: removal.exitCode
            });
          }
        } catch (cleanupError) {
          this.options.logger.warn("runtime cleanup failed after start error", {
            runtimeId: request.runtimeId,
            externalName,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          });
        }
      }
      try {
        await this.options.inventory.updateRuntimeStatus(request.runtimeId, finalStatus, this.options.clock.isoNow());
      } catch (statusError) {
        this.options.logger.warn("runtime status update failed after start error", {
          runtimeId: request.runtimeId,
          externalName,
          error: statusError instanceof Error ? statusError.message : String(statusError)
        });
      }
      this.options.logger.error("runtime create failed", {
        runtimeId: request.runtimeId,
        externalName,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  async stopRuntime(runtimeId: RuntimeInventoryRecord["runtimeId"], reason: string): Promise<void> {
    const record = await this.requiredRecord(runtimeId);
    // The RECORD names the adapter kind, so a stop resolves the same adapter
    // that started it even when several kinds are registered.
    const runtimeAdapter = this.adapters.require(record.adapter, `runtime ${record.runtimeId}`);
    const handle = handleFromRecord(record);
    await this.setStatus(runtimeId, "stopping");
    const result = await runtimeAdapter.stopRuntime(handle, reason);
    if (result.exitCode !== 0) {
      throw new Error(`Runtime stop failed for ${record.externalName}: ${result.stderr || result.error || result.stdout}`);
    }
    await this.setStatus(runtimeId, "stopped");
  }

  private async requiredRecord(runtimeId: RuntimeInventoryRecord["runtimeId"]): Promise<RuntimeInventoryRecord> {
    const record = await this.options.inventory.getRuntime(runtimeId);
    if (!record) {
      throw new Error(`Runtime ${runtimeId} is not in inventory.`);
    }
    return record;
  }

  private async setStatus(runtimeId: RuntimeInventoryRecord["runtimeId"], status: RuntimeStatus): Promise<void> {
    await this.options.inventory.updateRuntimeStatus(runtimeId, status, this.options.clock.isoNow());
  }
}

function makeStartingRecord(
  request: StartRuntimeRequest,
  externalName: string,
  adapter: RuntimeInventoryRecord["adapter"],
  startedAt: string
): RuntimeInventoryRecord {
  const securityPolicy = request.template.advancedOptions["securityPolicy"];
  const base = {
    runtimeId: request.runtimeId,
    runtimeGenerationId: request.generationId,
    sessionId: request.sessionId,
    chatId: request.chatId,
    agentRole: request.agentRole,
    templateId: request.template.id,
    adapter,
    externalName,
    status: "starting" as const,
    startedAt,
    cleanupFailureCount: 0,
    metadata: {
      workspacePath: request.workspacePath,
      mounts: request.template.mounts.length,
      ...(isJsonObject(securityPolicy) ? { securityPolicy } : {})
    }
  };
  return {
    ...base,
    ...(request.agentId === undefined ? {} : { agentId: request.agentId }),
    ...(request.workspaceOwnerToken === undefined ? {} : { workspaceOwnerToken: request.workspaceOwnerToken })
  };
}

function isJsonObject(value: unknown): value is import("@drydock/contracts").JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function handleFromRecord(record: RuntimeInventoryRecord): RuntimeHandle {
  return {
    runtimeId: record.runtimeId,
    runtimeGenerationId: record.runtimeGenerationId,
    sessionId: record.sessionId,
    adapter: record.adapter,
    externalName: record.externalName,
    workspacePath: typeof record.metadata["workspacePath"] === "string" ? record.metadata["workspacePath"] : "",
    ...(typeof record.metadata["runtimeCwd"] === "string" ? { runtimeCwd: record.metadata["runtimeCwd"] } : {}),
    mounts: [],
    status: "running"
  };
}
