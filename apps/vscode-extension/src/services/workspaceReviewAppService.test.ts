/**
 * Unit tests for access-grant approval in WorkspaceReviewAppService.
 *
 * An approval must apply the mount before the request is marked approved. If the
 * runtime restart fails, the request stays pending and retryable.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { asId, type AccessRequestRecord, type ChatSessionRecord, type MountPolicy, type SessionId } from "@drydock/contracts";
import {
  WorkspaceReviewAppService,
  type WorkspaceReviewAppServiceOptions
} from "./workspaceReviewAppService.js";

function approvedRecord(id: string, hostPath: string): AccessRequestRecord {
  return {
    accessRequestId: asId<"AccessRequestId">(id),
    sessionId: asId<"SessionId">("session-1"),
    hostPath,
    mode: "read-write",
    reason: "needs the folder",
    status: "approved",
    requestedAt: "2026-07-07T00:00:00.000Z",
    resolvedAt: "2026-07-07T00:00:01.000Z",
    resolvedBy: "user"
  };
}

function mount(id: string): MountPolicy {
  return { mountId: asId<"MountId">(`mount-${id}`), hostPath: `C:\\grant\\${id}`, runtimePath: `/c/grant/${id}`, mode: "read-write", source: "shared-write" };
}

interface HarnessState {
  readonly expandCalls: MountPolicy[][];
  readonly events: string[];
  expandError: Error | null;
}

function harness(): { readonly service: WorkspaceReviewAppService; readonly state: HarnessState } {
  const state: HarnessState = { expandCalls: [], events: [], expandError: null };
  const accessRequests = {
    prepareApproval: (id: string) => {
      state.events.push(`prepare:${id}`);
      return Promise.resolve({ request: approvedRecord(id, `C:\\grant\\${id}`), mount: mount(id) });
    },
    markApproved: (id: string) => {
      state.events.push(`mark:${id}`);
      return Promise.resolve(approvedRecord(id, `C:\\grant\\${id}`));
    },
    denyRequest: (id: string) => {
      state.events.push(`deny:${id}`);
      return Promise.resolve({ ...approvedRecord(id, `C:\\grant\\${id}`), status: "denied" as const });
    },
    editRequestPath: (id: string) => Promise.resolve(approvedRecord(id, `C:\\grant\\${id}`))
  };
  const chatService = {
    expandSessionMounts: (_id: SessionId, mounts: readonly MountPolicy[]) => {
      state.events.push("expand:session-1");
      if (state.expandError !== null) {
        return Promise.reject(state.expandError);
      }
      state.expandCalls.push([...mounts]);
      return Promise.resolve({} as ChatSessionRecord);
    }
  };
  const bus = { publish: () => {} };
  const service = new WorkspaceReviewAppService(
    { accessRequests, chatService, bus } as unknown as WorkspaceReviewAppServiceOptions
  );
  return { service, state };
}

test("approval applies the mount before marking the request approved", async () => {
  const { service, state } = harness();

  const summary = await service.resolveAccess("ar-1", true);

  assert.equal(summary.status, "approved");
  assert.equal(state.expandCalls.length, 1);
  assert.equal(state.expandCalls[0]?.length, 1);
  assert.deepEqual(state.events, ["prepare:ar-1", "expand:session-1", "mark:ar-1"]);
});

test("a failed mount apply leaves the request unapproved", async () => {
  const { service, state } = harness();
  state.expandError = new Error("restart failed");

  await assert.rejects(service.resolveAccess("ar-1", true), /restart failed/);

  assert.equal(state.expandCalls.length, 0);
  assert.deepEqual(state.events, ["prepare:ar-1", "expand:session-1"]);
});

test("a denial resolves without applying a mount", async () => {
  const { service, state } = harness();

  const summary = await service.resolveAccess("ar-1", false);

  assert.equal(summary.status, "denied");
  assert.equal(state.expandCalls.length, 0);
  assert.deepEqual(state.events, ["deny:ar-1"]);
});
