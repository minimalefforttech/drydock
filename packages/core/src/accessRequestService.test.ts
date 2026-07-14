/**
 * Unit tests for the Stage 3 access request approval flow.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  asId,
  type AccessRequestId,
  type AccessRequestRecord,
  type AccessRequestStatus,
  type AccessRequestStore
} from "@drydock/contracts";
import { AccessRequestService } from "./accessRequestService.js";
import type { Clock } from "./clock.js";
import { RandomIdGenerator } from "./ids.js";

test("approval prepares a mount and only resolves after markApproved", async () => {
  const service = makeService([]);
  const request = await service.createRequest({
    sessionId: asId<"SessionId">("session-test"),
    hostPath: "C:\\shared\\lib",
    mode: "read-only",
    reason: "agent needs the shared library"
  });
  assert.equal(request.status, "pending");

  const prepared = await service.prepareApproval(request.accessRequestId);
  assert.equal(prepared.mount.hostPath, "C:\\shared\\lib");
  assert.equal(prepared.mount.mode, "read-only");
  assert.equal(prepared.mount.source, "shared-read");
  assert.equal(prepared.mount.approvedBy, "user");
  // prepareApproval must not resolve the request: a failed restart keeps it retryable.
  assert.equal((await service.listRequests("pending")).length, 1);

  const approved = await service.markApproved(request.accessRequestId, "user");
  assert.equal(approved.status, "approved");
  assert.equal(approved.resolvedBy, "user");
  await assert.rejects(service.markApproved(request.accessRequestId, "user"), /already approved/);
});

test("Windows drive and UNC paths stay absolute and unchanged on every runner OS", async () => {
  const service = makeService([]);
  const drive = await service.createRequest({
    sessionId: asId<"SessionId">("session-drive"),
    hostPath: "C:\\shared\\lib",
    mode: "read-only",
    reason: "drive path"
  });
  const unc = await service.createRequest({
    sessionId: asId<"SessionId">("session-unc"),
    hostPath: "\\\\server\\share\\lib",
    mode: "read-only",
    reason: "UNC path"
  });

  assert.equal(drive.hostPath, "C:\\shared\\lib");
  assert.equal(unc.hostPath, "\\\\server\\share\\lib");
  assert.equal((await service.prepareApproval(unc.accessRequestId)).mount.hostPath, "\\\\server\\share\\lib");

  await assert.rejects(service.editRequestPath(drive.accessRequestId, "C:relative"), /absolute/);
  await assert.rejects(service.editRequestPath(drive.accessRequestId, "\\current-drive-relative"), /absolute/);
});

test("denied paths and relative paths are refused", async () => {
  const service = makeService(["C:\\secrets"]);
  await assert.rejects(service.createRequest({
    sessionId: asId<"SessionId">("session-test"),
    hostPath: "relative\\path",
    mode: "read-only",
    reason: "test"
  }), /absolute/);

  const request = await service.createRequest({
    sessionId: asId<"SessionId">("session-test"),
    hostPath: "C:\\secrets\\keys",
    mode: "read-write",
    reason: "should not be approvable"
  });
  await assert.rejects(service.prepareApproval(request.accessRequestId), /denied path/);

  const denied = await service.denyRequest(request.accessRequestId, "user");
  assert.equal(denied.status, "denied");
});

test("editRequestPath rewrites a pending request's path and rejects resolved or relative paths", async () => {
  const service = makeService([]);
  const request = await service.createRequest({
    sessionId: asId<"SessionId">("session-test"),
    hostPath: "C:\\shared\\lib",
    mode: "read-only",
    reason: "agent needs the shared library"
  });

  const edited = await service.editRequestPath(request.accessRequestId, "C:\\shared\\other");
  assert.equal(edited.hostPath, "C:\\shared\\other");
  assert.equal(edited.status, "pending");
  assert.equal((await service.listRequests("pending"))[0]?.hostPath, "C:\\shared\\other");

  // A relative path is refused by the same gate createRequest uses.
  await assert.rejects(service.editRequestPath(request.accessRequestId, "relative\\path"), /absolute/);

  // Once resolved, the path can no longer be edited.
  await service.markApproved(request.accessRequestId, "user");
  await assert.rejects(service.editRequestPath(request.accessRequestId, "C:\\shared\\third"), /already approved/);
});

function makeService(deniedPaths: readonly string[]): AccessRequestService {
  return new AccessRequestService({
    ids: new RandomIdGenerator(),
    clock: fixedClock(),
    store: new MemoryAccessRequestStore(),
    deniedPaths
  });
}

function fixedClock(): Clock {
  return {
    now: () => new Date("2026-07-02T00:00:00.000Z"),
    isoNow: () => "2026-07-02T00:00:00.000Z"
  };
}

class MemoryAccessRequestStore implements AccessRequestStore {
  private readonly requests = new Map<AccessRequestId, AccessRequestRecord>();

  insertRequest(record: AccessRequestRecord): Promise<void> {
    this.requests.set(record.accessRequestId, record);
    return Promise.resolve();
  }

  getRequest(accessRequestId: AccessRequestId): Promise<AccessRequestRecord | null> {
    return Promise.resolve(this.requests.get(accessRequestId) ?? null);
  }

  updateRequestStatus(accessRequestId: AccessRequestId, status: AccessRequestStatus, resolvedAt: string, resolvedBy: string): Promise<void> {
    const current = this.requests.get(accessRequestId);
    if (current !== undefined) {
      this.requests.set(accessRequestId, { ...current, status, resolvedAt, resolvedBy });
    }
    return Promise.resolve();
  }

  updateRequestPath(accessRequestId: AccessRequestId, hostPath: string): Promise<void> {
    const current = this.requests.get(accessRequestId);
    if (current !== undefined) {
      this.requests.set(accessRequestId, { ...current, hostPath });
    }
    return Promise.resolve();
  }

  listRequests(status?: AccessRequestStatus): Promise<AccessRequestRecord[]> {
    const all = [...this.requests.values()];
    return Promise.resolve(status === undefined ? all : all.filter((request) => request.status === status));
  }
}
