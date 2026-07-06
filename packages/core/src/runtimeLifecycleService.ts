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
import type { RuntimeAdapter } from "./runtimeAdapter.js";
import { buildRuntimeName } from "./runtimeNames.js";

export interface RuntimeLifecycleServiceOptions {
  readonly clock: Clock;
  readonly inventory: RuntimeInventoryStore;
  readonly runtimeAdapter: RuntimeAdapter;
  readonly logger: Logger;
  readonly runtimeNamePrefix?: string;
}

export class RuntimeLifecycleService {
  private readonly prefix: string;

  constructor(private readonly options: RuntimeLifecycleServiceOptions) {
    this.prefix = options.runtimeNamePrefix ?? "drydock";
  }

  async startRuntime(request: StartRuntimeRequest): Promise<RuntimeHandle> {
    const startedAt = this.options.clock.isoNow();
    const externalName = buildRuntimeName(this.prefix, request.sessionId, request.generationId, request.agentRole);
    const record = makeStartingRecord(request, externalName, this.options.runtimeAdapter.adapter, startedAt);
    await this.options.inventory.insertRuntime(record);
    this.options.logger.info("runtime starting", { runtimeId: request.runtimeId, externalName });

    try {
      const handle = await this.options.runtimeAdapter.createRuntime(request, externalName);
      await this.options.inventory.updateRuntimeStatus(request.runtimeId, "running", this.options.clock.isoNow());
      this.options.logger.info("runtime running", { runtimeId: request.runtimeId, externalName });
      return handle;
    } catch (error) {
      await this.options.inventory.updateRuntimeStatus(request.runtimeId, "lost", this.options.clock.isoNow());
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
    const handle = handleFromRecord(record);
    await this.setStatus(runtimeId, "stopping");
    const result = await this.options.runtimeAdapter.stopRuntime(handle, reason);
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
      mounts: request.template.mounts.length
    }
  };
  return {
    ...base,
    ...(request.agentId === undefined ? {} : { agentId: request.agentId }),
    ...(request.workspaceOwnerToken === undefined ? {} : { workspaceOwnerToken: request.workspaceOwnerToken })
  };
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
