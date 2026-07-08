/**
 * Cleanup must not quarantine a sandbox that is already gone: a remove that
 * fails only because the sandbox no longer exists is a successful removal.
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
import { RuntimeCleanupService } from "./runtimeCleanupService.js";

test("cleanup treats an already-gone sandbox as removed, not quarantined", async () => {
  const inventory = new SingleRuntimeStore(runtimeRecord("runtime-gone", "drydock-gone-worker", "quarantined"));
  const service = new RuntimeCleanupService({
    clock: new FixedClock(),
    inventory,
    runtimeAdapter: new CannedAdapter(commandResult(1, "sandbox 'drydock-gone-worker' not found")),
    logger: new NullLogger()
  });

  const result = await service.cleanupRuntime(asId<"RuntimeId">("runtime-gone"), "force-remove");

  assert.equal(result.status, "removed");
  assert.equal((await inventory.getRuntime(asId<"RuntimeId">("runtime-gone")))?.status, "removed");
});

test("cleanup still quarantines on a genuine remove failure", async () => {
  const inventory = new SingleRuntimeStore(runtimeRecord("runtime-stuck", "drydock-stuck-worker", "running"));
  const service = new RuntimeCleanupService({
    clock: new FixedClock(),
    inventory,
    runtimeAdapter: new CannedAdapter(commandResult(1, "permission denied while removing container")),
    logger: new NullLogger()
  });

  const result = await service.cleanupRuntime(asId<"RuntimeId">("runtime-stuck"), "force-remove");

  assert.equal(result.status, "failed");
  assert.equal((await inventory.getRuntime(asId<"RuntimeId">("runtime-stuck")))?.status, "quarantined");
});

class CannedAdapter implements RuntimeAdapter {
  readonly adapter = "docker-sandbox" as const;
  constructor(private readonly removeResult: CommandResult) {}
  createRuntime(_request: StartRuntimeRequest, _externalName: string): Promise<RuntimeHandle> { throw new Error("not used"); }
  stopRuntime(_handle: RuntimeHandle, _reason: string): Promise<CommandResult> { return Promise.resolve(commandResult(0, "")); }
  removeRuntime(_handle: RuntimeHandle, _force: boolean): Promise<CommandResult> { return Promise.resolve(this.removeResult); }
  listExternalRuntimeNames(_namePrefix: string): Promise<string[]> { return Promise.resolve([]); }
}

class SingleRuntimeStore implements RuntimeInventoryStore {
  private record: RuntimeInventoryRecord;
  constructor(record: RuntimeInventoryRecord) { this.record = record; }
  insertRuntime(record: RuntimeInventoryRecord): Promise<void> { this.record = record; return Promise.resolve(); }
  updateRuntimeStatus(_runtimeId: RuntimeInventoryRecord["runtimeId"], status: RuntimeStatus, timestamp: string): Promise<void> {
    this.record = { ...this.record, status, lastSeenAt: timestamp };
    return Promise.resolve();
  }
  updateRuntimeMetadata(_runtimeId: RuntimeInventoryRecord["runtimeId"], patch: JsonObject, timestamp: string): Promise<void> {
    this.record = { ...this.record, metadata: { ...this.record.metadata, ...patch }, lastSeenAt: timestamp };
    return Promise.resolve();
  }
  updateCleanupAttempt(_runtimeId: RuntimeInventoryRecord["runtimeId"], _timestamp: string, _failed: boolean): Promise<void> { return Promise.resolve(); }
  getRuntime(runtimeId: RuntimeInventoryRecord["runtimeId"]): Promise<RuntimeInventoryRecord | null> {
    return Promise.resolve(runtimeId === this.record.runtimeId ? this.record : null);
  }
  listRuntimes(): Promise<RuntimeInventoryRecord[]> { return Promise.resolve([this.record]); }
}

class FixedClock implements Clock {
  now(): Date { return new Date("2026-07-02T00:00:00.000Z"); }
  isoNow(): string { return this.now().toISOString(); }
}

class NullLogger implements Logger {
  info(_message: string, _metadata?: JsonObject): void {}
  warn(_message: string, _metadata?: JsonObject): void {}
  error(_message: string, _metadata?: JsonObject): void {}
}

function commandResult(exitCode: number, stderr: string): CommandResult {
  return { command: "sbx", args: [], cwd: ".", exitCode, signal: null, stdout: "", stderr, durationMs: 1, timedOut: false };
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
