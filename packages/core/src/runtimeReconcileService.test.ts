/**
 * Unit tests for startup runtime reconciliation.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  asId,
  type CommandResult,
  type JsonObject,
  type RuntimeAdapterKind,
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

test("reconciliation reaps orphaned quarantined/lost/stopped rows to removed", async () => {
  const inventory = new MemoryRuntimeInventoryStore([
    runtimeRecord("runtime-quarantined", "drydock-q-worker", "quarantined"),
    runtimeRecord("runtime-lost", "drydock-lost-worker", "lost"),
    runtimeRecord("runtime-stopped", "drydock-stopped-worker", "stopped"),
    runtimeRecord("runtime-live-q", "drydock-live-q-worker", "quarantined"),
    runtimeRecord("runtime-live-lost", "drydock-live-lost-worker", "lost"),
    runtimeRecord("runtime-removed", "drydock-removed-worker", "removed")
  ]);
  const runtimeAdapter = new ListingRuntimeAdapter(["drydock-live-q-worker", "drydock-live-lost-worker"]);
  const service = new RuntimeReconcileService({
    clock: new FixedClock(),
    inventory,
    runtimeAdapter,
    logger: new NullLogger()
  });

  await service.reconcile();

  // Orphaned non-active rows are reaped so they stop piling up.
  assert.equal((await inventory.getRuntime(asId<"RuntimeId">("runtime-quarantined")))?.status, "removed");
  assert.equal((await inventory.getRuntime(asId<"RuntimeId">("runtime-lost")))?.status, "removed");
  assert.equal((await inventory.getRuntime(asId<"RuntimeId">("runtime-stopped")))?.status, "removed");
  // A quarantined row whose sandbox STILL exists is left untouched.
  assert.equal((await inventory.getRuntime(asId<"RuntimeId">("runtime-live-q")))?.status, "quarantined");
  // A supposedly lost row whose sandbox still exists is quarantined for cleanup.
  assert.equal((await inventory.getRuntime(asId<"RuntimeId">("runtime-live-lost")))?.status, "quarantined");
});

test("reconciliation unions external names across adapters and judges each record by its own kind", async () => {
  const inventory = new MemoryRuntimeInventoryStore([
    runtimeRecord("runtime-sbx", "drydock-present-worker", "running"),
    runtimeRecord("runtime-vm", "drydock-validate-a", "running", "hyperv"),
    runtimeRecord("runtime-vm-gone", "drydock-validate-b", "running", "hyperv")
  ]);
  const service = new RuntimeReconcileService({
    clock: new FixedClock(),
    inventory,
    runtimeAdapters: [
      new ListingRuntimeAdapter(["drydock-present-worker"]),
      new ListingRuntimeAdapter(["drydock-validate-a", "drydock-validate-c"], "hyperv")
    ],
    logger: new NullLogger()
  });

  const result = await service.reconcile();

  // Each record is judged against the union, so a hyperv row is not "lost"
  // merely because it is absent from the sandbox list.
  assert.equal((await inventory.getRuntime(asId<"RuntimeId">("runtime-sbx")))?.status, "running");
  assert.equal((await inventory.getRuntime(asId<"RuntimeId">("runtime-vm")))?.status, "running");
  assert.equal((await inventory.getRuntime(asId<"RuntimeId">("runtime-vm-gone")))?.status, "lost");
  assert.deepEqual(result.missingExternal, [asId<"RuntimeId">("runtime-vm-gone")]);
  assert.deepEqual(result.externalOnly, ["drydock-validate-c"]);
  assert.equal(result.unresolvedAdapters, undefined);
});

test("an adapter whose listing FAILS leaves its records untouched instead of lost", async () => {
  const inventory = new MemoryRuntimeInventoryStore([
    runtimeRecord("runtime-sbx", "drydock-present-worker", "running"),
    runtimeRecord("runtime-vm", "drydock-validate-a", "running", "hyperv")
  ]);
  const service = new RuntimeReconcileService({
    clock: new FixedClock(),
    inventory,
    runtimeAdapters: [
      new ListingRuntimeAdapter(["drydock-present-worker"]),
      new ThrowingListRuntimeAdapter("hyperv")
    ],
    logger: new NullLogger()
  });

  const result = await service.reconcile();

  // "We could not look" is not evidence the VM is gone.
  assert.equal((await inventory.getRuntime(asId<"RuntimeId">("runtime-vm")))?.status, "running");
  assert.deepEqual(result.missingExternal, []);
  assert.deepEqual(result.unresolvedAdapters, [asId<"RuntimeId">("runtime-vm")]);
});

test("records whose adapter kind is not registered at all are reported, never judged", async () => {
  const inventory = new MemoryRuntimeInventoryStore([
    runtimeRecord("runtime-vm", "drydock-validate-a", "running", "hyperv")
  ]);
  const service = new RuntimeReconcileService({
    clock: new FixedClock(),
    inventory,
    runtimeAdapter: new ListingRuntimeAdapter([]),
    logger: new NullLogger()
  });

  const result = await service.reconcile();

  assert.equal((await inventory.getRuntime(asId<"RuntimeId">("runtime-vm")))?.status, "running");
  assert.deepEqual(result.unresolvedAdapters, [asId<"RuntimeId">("runtime-vm")]);
});

class ListingRuntimeAdapter implements RuntimeAdapter {
  readonly adapter: RuntimeAdapterKind;

  constructor(private readonly names: readonly string[], adapter: RuntimeAdapterKind = "docker-sandbox") {
    this.adapter = adapter;
  }

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

/** Stands in for a hypervisor that is momentarily unreachable. */
class ThrowingListRuntimeAdapter implements RuntimeAdapter {
  readonly adapter: RuntimeAdapterKind;

  constructor(adapter: RuntimeAdapterKind) {
    this.adapter = adapter;
  }

  createRuntime(_request: StartRuntimeRequest, _externalName: string): Promise<RuntimeHandle> {
    throw new Error("not used");
  }

  stopRuntime(_handle: RuntimeHandle, _reason: string): Promise<CommandResult> {
    throw new Error("not used");
  }

  removeRuntime(_handle: RuntimeHandle, _force: boolean): Promise<CommandResult> {
    throw new Error("not used");
  }

  listExternalRuntimeNames(_namePrefix: string): Promise<string[]> {
    return Promise.reject(new Error("Get-VM failed: the Hyper-V Virtual Machine Management service is not running."));
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

function runtimeRecord(
  runtimeId: string,
  externalName: string,
  status: RuntimeStatus,
  adapter: RuntimeAdapterKind = "docker-sandbox"
): RuntimeInventoryRecord {
  return {
    runtimeId: asId<"RuntimeId">(runtimeId),
    runtimeGenerationId: asId<"RuntimeGenerationId">(`generation-${runtimeId}`),
    sessionId: asId<"SessionId">(`session-${runtimeId}`),
    chatId: asId<"ChatId">(`chat-${runtimeId}`),
    agentRole: "worker",
    templateId: "template-test",
    adapter,
    externalName,
    status,
    startedAt: "2026-07-02T00:00:00.000Z",
    cleanupFailureCount: 0,
    metadata: {}
  };
}
