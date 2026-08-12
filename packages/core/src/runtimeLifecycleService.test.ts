/**
 * Lifecycle tests for multi-adapter selection (ADR 0022 M3).
 *
 * The runtime class a template asks for decides which adapter runs it, and a
 * kind nobody can service must fail BEFORE anything durable is written -
 * otherwise activation is left with a `starting` row no adapter can clean up.
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
import { RuntimeLifecycleService } from "./runtimeLifecycleService.js";

test("startRuntime routes to the adapter matching the template's runtime kind", async () => {
  const inventory = new MemoryRuntimeInventoryStore();
  const sandbox = new RecordingAdapter("docker-sandbox");
  const hyperv = new RecordingAdapter("hyperv");
  const service = new RuntimeLifecycleService({
    clock: new FixedClock(),
    inventory,
    runtimeAdapters: [sandbox, hyperv],
    logger: new NullLogger()
  });

  const handle = await service.startRuntime(startRequest("hyperv"));

  assert.equal(handle.adapter, "hyperv");
  assert.equal(sandbox.created.length, 0);
  assert.equal(hyperv.created.length, 1);
  // The row records the kind that actually ran it, so cleanup resolves the
  // same adapter in a later process.
  const record = await inventory.getRuntime(asId<"RuntimeId">("runtime-1"));
  assert.equal(record?.adapter, "hyperv");
  assert.equal(record?.status, "running");
});

test("an unservable template kind fails before any inventory row is written", async () => {
  const inventory = new MemoryRuntimeInventoryStore();
  const service = new RuntimeLifecycleService({
    clock: new FixedClock(),
    inventory,
    runtimeAdapter: new RecordingAdapter("docker-sandbox"),
    logger: new NullLogger()
  });

  await assert.rejects(
    service.startRuntime(startRequest("hyperv")),
    /No runtime adapter is registered for kind "hyperv" \(template template-1\)\. Registered kinds: docker-sandbox\./
  );
  assert.deepEqual(await inventory.listRuntimes(), []);
});

test("the single-adapter option shape keeps working unchanged", async () => {
  const inventory = new MemoryRuntimeInventoryStore();
  const sandbox = new RecordingAdapter("docker-sandbox");
  const service = new RuntimeLifecycleService({
    clock: new FixedClock(),
    inventory,
    runtimeAdapter: sandbox,
    logger: new NullLogger()
  });

  await service.startRuntime(startRequest("docker-sandbox"));
  await service.stopRuntime(asId<"RuntimeId">("runtime-1"), "user requested");

  assert.equal(sandbox.created.length, 1);
  assert.equal(sandbox.stopped.length, 1);
  assert.equal((await inventory.getRuntime(asId<"RuntimeId">("runtime-1")))?.status, "stopped");
});

test("stopRuntime resolves the adapter from the record, not from insertion order", async () => {
  const inventory = new MemoryRuntimeInventoryStore();
  const sandbox = new RecordingAdapter("docker-sandbox");
  const hyperv = new RecordingAdapter("hyperv");
  const service = new RuntimeLifecycleService({
    clock: new FixedClock(),
    inventory,
    runtimeAdapters: [sandbox, hyperv],
    logger: new NullLogger()
  });

  await service.startRuntime(startRequest("hyperv"));
  await service.stopRuntime(asId<"RuntimeId">("runtime-1"), "job finished");

  assert.equal(sandbox.stopped.length, 0);
  assert.deepEqual(hyperv.stopped, ["job finished"]);
});

function startRequest(type: RuntimeAdapterKind): StartRuntimeRequest {
  return {
    sessionId: asId<"SessionId">("session-1"),
    chatId: asId<"ChatId">("chat-1"),
    agentRole: "worker",
    workspacePath: "C:\\drydock\\workspace",
    generationId: asId<"RuntimeGenerationId">("generation-1"),
    runtimeId: asId<"RuntimeId">("runtime-1"),
    template: {
      id: "template-1",
      type,
      network: "disabled",
      mounts: [],
      environment: {},
      adapterProviderIds: [],
      advancedOptions: {}
    }
  };
}

class RecordingAdapter implements RuntimeAdapter {
  readonly created: string[] = [];
  readonly stopped: string[] = [];

  constructor(readonly adapter: RuntimeAdapterKind) {}

  createRuntime(request: StartRuntimeRequest, externalName: string): Promise<RuntimeHandle> {
    this.created.push(externalName);
    return Promise.resolve({
      runtimeId: request.runtimeId,
      runtimeGenerationId: request.generationId,
      sessionId: request.sessionId,
      adapter: this.adapter,
      externalName,
      workspacePath: request.workspacePath,
      mounts: [],
      status: "running"
    });
  }

  stopRuntime(_handle: RuntimeHandle, reason: string): Promise<CommandResult> {
    this.stopped.push(reason);
    return Promise.resolve(commandResult(0));
  }

  removeRuntime(_handle: RuntimeHandle, _force: boolean): Promise<CommandResult> {
    return Promise.resolve(commandResult(0));
  }

  listExternalRuntimeNames(_namePrefix: string): Promise<string[]> {
    return Promise.resolve([]);
  }
}

class MemoryRuntimeInventoryStore implements RuntimeInventoryStore {
  private readonly records = new Map<string, RuntimeInventoryRecord>();

  insertRuntime(record: RuntimeInventoryRecord): Promise<void> {
    this.records.set(record.runtimeId, record);
    return Promise.resolve();
  }

  updateRuntimeStatus(runtimeId: RuntimeInventoryRecord["runtimeId"], status: RuntimeStatus, timestamp: string): Promise<void> {
    const current = this.records.get(runtimeId);
    if (current !== undefined) this.records.set(runtimeId, { ...current, status, lastSeenAt: timestamp });
    return Promise.resolve();
  }

  updateRuntimeMetadata(runtimeId: RuntimeInventoryRecord["runtimeId"], patch: JsonObject, timestamp: string): Promise<void> {
    const current = this.records.get(runtimeId);
    if (current !== undefined) {
      this.records.set(runtimeId, { ...current, metadata: { ...current.metadata, ...patch }, lastSeenAt: timestamp });
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
  now(): Date { return new Date("2026-08-12T00:00:00.000Z"); }
  isoNow(): string { return this.now().toISOString(); }
}

class NullLogger implements Logger {
  info(_message: string, _metadata?: JsonObject): void {}
  warn(_message: string, _metadata?: JsonObject): void {}
  error(_message: string, _metadata?: JsonObject): void {}
}

function commandResult(exitCode: number): CommandResult {
  return { command: "test", args: [], cwd: ".", exitCode, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
}
