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

test("a detached Hyper-V VM reads as already gone, not as a cleanup failure", async () => {
  const inventory = new SingleRuntimeStore(runtimeRecord("runtime-vm", "drydock-validate-a", "running", "hyperv"));
  const service = new RuntimeCleanupService({
    clock: new FixedClock(),
    inventory,
    runtimeAdapters: [new CannedAdapter(commandResult(1, "Hyper-V was unable to find a virtual machine with the requested name."), "hyperv")],
    logger: new NullLogger()
  });

  const result = await service.cleanupRuntime(asId<"RuntimeId">("runtime-vm"), "force-remove");

  assert.equal(result.status, "removed");
  assert.equal((await inventory.getRuntime(asId<"RuntimeId">("runtime-vm")))?.status, "removed");
});

test("a still-running Hyper-V VM whose failure merely mentions a virtual machine is quarantined, not reaped", async () => {
  const inventory = new SingleRuntimeStore(runtimeRecord("runtime-vm", "drydock-validate-a", "running", "hyperv"));
  const service = new RuntimeCleanupService({
    clock: new FixedClock(),
    inventory,
    // "no virtual machine" appears but NOT Hyper-V's absent-VM wording ("... found
    // with/matching" / "unable to find a virtual machine"). The OLD broad matcher
    // would have reaped the row; this VM is still Running and must be quarantined.
    runtimeAdapters: [new CannedAdapter(commandResult(1, "Cannot stop 'drydock-validate-a'; access is denied (no virtual machine management permission)."), "hyperv")],
    logger: new NullLogger()
  });

  const result = await service.cleanupRuntime(asId<"RuntimeId">("runtime-vm"), "force-remove");

  assert.equal(result.status, "failed");
  assert.equal((await inventory.getRuntime(asId<"RuntimeId">("runtime-vm")))?.status, "quarantined");
});

test("cleanup picks the adapter named by the RECORD when several kinds are registered", async () => {
  const inventory = new SingleRuntimeStore(runtimeRecord("runtime-vm", "drydock-validate-a", "running", "hyperv"));
  const sandbox = new CannedAdapter(commandResult(1, "permission denied while removing container"));
  const hyperv = new CannedAdapter(commandResult(0, ""), "hyperv");
  const service = new RuntimeCleanupService({
    clock: new FixedClock(),
    inventory,
    runtimeAdapters: [sandbox, hyperv],
    logger: new NullLogger()
  });

  const result = await service.cleanupRuntime(asId<"RuntimeId">("runtime-vm"), "force-remove");

  assert.equal(result.status, "removed");
  assert.equal(sandbox.removeCalls, 0);
  assert.equal(hyperv.removeCalls, 1);
});

test("cleanup rebuilds the network-allow resources from persisted metadata and passes them to removeRuntime", async () => {
  // Simulates a runtime created before a restart: the adapter's in-process
  // policy map is gone, but the resources string survived in metadata
  // (written by RuntimeLifecycleService at create time). Cleanup must recover
  // it from the record so the fallback in dockerSandboxRuntimeAdapter's
  // removeRuntime actually receives something to revoke.
  const record = {
    ...runtimeRecord("runtime-net", "drydock-net-worker", "running"),
    metadata: { networkAllowResources: "api.example.invalid" }
  };
  const inventory = new SingleRuntimeStore(record);
  const adapter = new CannedAdapter(commandResult(0, ""));
  const service = new RuntimeCleanupService({
    clock: new FixedClock(),
    inventory,
    runtimeAdapter: adapter,
    logger: new NullLogger()
  });

  const result = await service.cleanupRuntime(asId<"RuntimeId">("runtime-net"), "force-remove");

  assert.equal(result.status, "removed");
  assert.equal(adapter.removeCalls, 1);
  assert.equal(adapter.lastRemoveHandle?.networkAllowResources, "api.example.invalid");
});

test("cleanup leaves the handle's network-allow resources unset when metadata never recorded any", async () => {
  const inventory = new SingleRuntimeStore(runtimeRecord("runtime-none", "drydock-none-worker", "running"));
  const adapter = new CannedAdapter(commandResult(0, ""));
  const service = new RuntimeCleanupService({
    clock: new FixedClock(),
    inventory,
    runtimeAdapter: adapter,
    logger: new NullLogger()
  });

  await service.cleanupRuntime(asId<"RuntimeId">("runtime-none"), "force-remove");

  assert.equal(adapter.lastRemoveHandle?.networkAllowResources, undefined);
});

test("a record whose adapter kind is unavailable quarantines with a diagnostic that names it", async () => {
  const inventory = new SingleRuntimeStore(runtimeRecord("runtime-vm", "drydock-validate-a", "running", "hyperv"));
  const service = new RuntimeCleanupService({
    clock: new FixedClock(),
    inventory,
    runtimeAdapter: new CannedAdapter(commandResult(0, "")),
    logger: new NullLogger()
  });

  const result = await service.cleanupRuntime(asId<"RuntimeId">("runtime-vm"), "force-remove");

  assert.equal(result.status, "quarantined");
  assert.equal((await inventory.getRuntime(asId<"RuntimeId">("runtime-vm")))?.status, "quarantined");
  assert.match(String(result.diagnostics[0]), /No runtime adapter is registered for kind "hyperv"/);
  assert.match(String(result.diagnostics[0]), /Registered kinds: docker-sandbox/);
});

class CannedAdapter implements RuntimeAdapter {
  readonly adapter: RuntimeInventoryRecord["adapter"];
  removeCalls = 0;
  lastRemoveHandle: RuntimeHandle | undefined;
  constructor(private readonly removeResult: CommandResult, adapter: RuntimeInventoryRecord["adapter"] = "docker-sandbox") {
    this.adapter = adapter;
  }
  createRuntime(_request: StartRuntimeRequest, _externalName: string): Promise<RuntimeHandle> { throw new Error("not used"); }
  stopRuntime(_handle: RuntimeHandle, _reason: string): Promise<CommandResult> { return Promise.resolve(commandResult(0, "")); }
  removeRuntime(handle: RuntimeHandle, _force: boolean): Promise<CommandResult> {
    this.removeCalls += 1;
    this.lastRemoveHandle = handle;
    return Promise.resolve(this.removeResult);
  }
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

function runtimeRecord(
  runtimeId: string,
  externalName: string,
  status: RuntimeStatus,
  adapter: RuntimeInventoryRecord["adapter"] = "docker-sandbox"
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
