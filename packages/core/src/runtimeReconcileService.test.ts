/**
 * Unit tests for startup runtime reconciliation.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  asId,
  type CommandResult,
  type JsonObject,
  type RuntimeHandle,
  type RuntimeInventoryRecord,
  type RuntimeInventoryStore,
  type RuntimeStatus,
  type StartRuntimeRequest
} from "@drydock/contracts";
import type { Clock } from "./clock.js";
import type { Logger } from "./logger.js";
import type { RuntimeAdapter } from "./runtimeAdapter.js";
import { RuntimeReconcileService } from "./runtimeReconcileService.js";

test("reconciliation marks db-active missing runtimes lost and reports external-only names", async () => {
  const inventory = new MemoryRuntimeInventoryStore([
    runtimeRecord("runtime-present", "drydock-present-worker", "running"),
    runtimeRecord("runtime-missing", "drydock-missing-worker", "running"),
    runtimeRecord("runtime-removed", "drydock-removed-worker", "removed")
  ]);
  const runtimeAdapter = new ListingRuntimeAdapter(["drydock-present-worker", "drydock-external-worker"]);
  const service = new RuntimeReconcileService({
    clock: new FixedClock(),
    inventory,
    runtimeAdapter,
    logger: new NullLogger()
  });

  const result = await service.reconcile();

  assert.deepEqual(result.missingExternal, [asId<"RuntimeId">("runtime-missing")]);
  assert.deepEqual(result.externalOnly, ["drydock-external-worker"]);
  assert.equal((await inventory.getRuntime(asId<"RuntimeId">("runtime-missing")))?.status, "lost");
  assert.equal((await inventory.getRuntime(asId<"RuntimeId">("runtime-present")))?.metadata["lastReconciledAt"], "2026-07-02T00:00:00.000Z");
});

class ListingRuntimeAdapter implements RuntimeAdapter {
  readonly adapter = "docker-sandbox" as const;

  constructor(private readonly names: readonly string[]) {}

  createRuntime(_request: StartRuntimeRequest, _externalName: string): Promise<RuntimeHandle> {
    throw new Error("not used");
  }

  stopRuntime(_handle: RuntimeHandle, _reason: string): Promise<CommandResult> {
    throw new Error("not used");
  }

  removeRuntime(_handle: RuntimeHandle, _force: boolean): Promise<CommandResult> {
    throw new Error("not used");
  }

  listExternalRuntimeNames(namePrefix: string): Promise<string[]> {
    return Promise.resolve(this.names.filter((name) => name.startsWith(namePrefix)));
  }
}

class MemoryRuntimeInventoryStore implements RuntimeInventoryStore {
  private readonly records = new Map<string, RuntimeInventoryRecord>();

  constructor(records: readonly RuntimeInventoryRecord[]) {
    for (const record of records) {
      this.records.set(record.runtimeId, record);
    }
  }

  insertRuntime(record: RuntimeInventoryRecord): Promise<void> {
    this.records.set(record.runtimeId, record);
    return Promise.resolve();
  }

  updateRuntimeStatus(runtimeId: RuntimeInventoryRecord["runtimeId"], status: RuntimeStatus, timestamp: string): Promise<void> {
    const current = this.records.get(runtimeId);
    if (current !== undefined) {
      this.records.set(runtimeId, { ...current, status, lastSeenAt: timestamp });
    }
    return Promise.resolve();
  }

  updateRuntimeMetadata(runtimeId: RuntimeInventoryRecord["runtimeId"], patch: JsonObject, timestamp: string): Promise<void> {
    const current = this.records.get(runtimeId);
    if (current !== undefined) {
      this.records.set(runtimeId, {
        ...current,
        metadata: { ...current.metadata, ...patch },
        lastSeenAt: timestamp
      });
    }
    return Promise.resolve();
  }

  updateCleanupAttempt(_runtimeId: RuntimeInventoryRecord["runtimeId"], _timestamp: string, _failed: boolean): Promise<void> {
    return Promise.resolve();
  }

  getRuntime(runtimeId: RuntimeInventoryRecord["runtimeId"]): Promise<RuntimeInventoryRecord | null> {
    return Promise.resolve(this.records.get(runtimeId) ?? null);
  }

  listRuntimes(): Promise<RuntimeInventoryRecord[]> {
    return Promise.resolve([...this.records.values()]);
  }
}

class FixedClock implements Clock {
  now(): Date {
    return new Date("2026-07-02T00:00:00.000Z");
  }

  isoNow(): string {
    return this.now().toISOString();
  }
}

class NullLogger implements Logger {
  info(_message: string, _metadata?: JsonObject): void {}
  warn(_message: string, _metadata?: JsonObject): void {}
  error(_message: string, _metadata?: JsonObject): void {}
}

function runtimeRecord(runtimeId: string, externalName: string, status: RuntimeStatus): RuntimeInventoryRecord {
  return {
    runtimeId: asId<"RuntimeId">(runtimeId),
    runtimeGenerationId: asId<"RuntimeGenerationId">(`generation-${runtimeId}`),
    sessionId: asId<"SessionId">(`session-${runtimeId}`),
    chatId: asId<"ChatId">(`chat-${runtimeId}`),
    agentRole: "worker",
    templateId: "template-test",
    adapter: "docker-sandbox",
    externalName,
    status,
    startedAt: "2026-07-02T00:00:00.000Z",
    cleanupFailureCount: 0,
    metadata: {}
  };
}
