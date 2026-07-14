/**
 * Unit tests for WorkspaceReviewAppService.
 *
 * Access approval: the mount must apply before the request is marked approved;
 * a failed restart leaves it pending and retryable.
 *
 * Diff views: the session/turn/full-session frames run against a REAL
 * SessionDiffService over sqlite + content-addressed blobs in a temp dir, so
 * baseline pairing, turn capture, accept fan-out, and accepted-marking
 * exercise the true stack end to end.
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { asId, type AccessRequestRecord, type ChatSessionRecord, type MountPolicy, type SessionId } from "@drydock/contracts";
import { MemoryLogger, RandomIdGenerator, SessionDiffService, SystemClock } from "@drydock/core";
import { ContentAddressedBlobStore } from "@drydock/artifacts";
import { applyMigrations, SqliteConnection, SqliteDiffBaselineStore } from "@drydock/storage-sqlite";
import {
  WorkspaceReviewAppService,
  type WorkspaceReviewAppServiceOptions
} from "./workspaceReviewAppService.js";
import { EffectiveSecurityPolicy } from "./securityPolicy.js";

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
  sessionMode: "implementation" | "clone";
}

function harness(): { readonly service: WorkspaceReviewAppService; readonly state: HarnessState } {
  const state: HarnessState = { expandCalls: [], events: [], expandError: null, sessionMode: "implementation" };
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
    getSession: () => Promise.resolve({ mode: state.sessionMode } as ChatSessionRecord),
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

test("a clone session cannot be widened into a live host mount", async () => {
  const { service, state } = harness();
  state.sessionMode = "clone";

  await assert.rejects(service.resolveAccess("ar-1", true), /Clone sessions cannot add live host mounts/);

  assert.equal(state.expandCalls.length, 0);
  assert.deepEqual(state.events, ["prepare:ar-1"]);
});

test("effective policy filters auto roots and silently tightens the mode to clone", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "drydock-review-policy-"));
  try {
    const allowed = path.join(root, "allowed");
    const blocked = path.join(root, "blocked");
    await Promise.all([mkdir(allowed, { recursive: true }), mkdir(blocked, { recursive: true })]);
    const securityPolicy = new EffectiveSecurityPolicy({
      managed: true,
      policyId: "test",
      allowedProjectRoots: [allowed],
      deniedPaths: [],
      cloneOnly: true,
      allowNetworkedAiOnThisMachine: true,
      cloneOmission: { sensitive: false, paths: [] }
    });
    const service = new WorkspaceReviewAppService({
      logger: new MemoryLogger(),
      securityPolicy
    } as unknown as WorkspaceReviewAppServiceOptions);

    const workspace = await service.resolveWorkspaceSelection(
      { auto: true, mode: "implementation" },
      [allowed, blocked]
    );

    assert.equal(workspace.mode, "clone");
    assert.deepEqual(workspace.roots, [allowed]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// MARK: Diff views (session / turn / full-session)

const SESSION = "session-diff-1";

interface DiffHarness {
  readonly service: WorkspaceReviewAppService;
  readonly diff: SessionDiffService;
  readonly root: string;
  file(name: string): string;
  cleanup(): Promise<void>;
}

async function diffHarness(): Promise<DiffHarness> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-review-diff-"));
  const root = path.join(dir, "repo");
  await mkdir(root, { recursive: true });
  const connection = new SqliteConnection(path.join(dir, "state.sqlite"));
  applyMigrations(connection);
  const diff = new SessionDiffService({
    ids: new RandomIdGenerator(),
    clock: new SystemClock(),
    logger: new MemoryLogger(),
    store: new SqliteDiffBaselineStore(connection),
    blobs: new ContentAddressedBlobStore(path.join(dir, "blobs"))
  });
  const service = new WorkspaceReviewAppService({ diff } as unknown as WorkspaceReviewAppServiceOptions);
  return {
    service,
    diff,
    root,
    file: (name: string) => path.join(root, name),
    cleanup: async () => {
      connection.close();
      await rm(dir, { recursive: true, force: true });
    }
  };
}

test("session baselining creates a working + session-start pair and is resume-idempotent", async () => {
  const h = await diffHarness();
  try {
    await writeFile(h.file("a.txt"), "one\n");
    await h.service.createSessionBaselines(SESSION, [h.root]);

    const baselines = await h.diff.listBaselines(asId<"SessionId">(SESSION));
    assert.deepEqual(baselines.map((b) => b.scope).sort(), ["current-session", "session-start"]);

    // Session continuity: an edit before a resume must survive the re-baseline call.
    await writeFile(h.file("a.txt"), "two\n");
    await h.service.createSessionBaselines(SESSION, [h.root]);
    assert.equal((await h.diff.listBaselines(asId<"SessionId">(SESSION))).length, 2);
    const session = await h.service.diffStatus(SESSION);
    assert.equal(session.length, 1);
    assert.equal(session[0]?.changeKind, "modify");
  } finally {
    await h.cleanup();
  }
});

test("turn view frames changes since the last send; views fall back before the first send", async () => {
  const h = await diffHarness();
  try {
    await writeFile(h.file("a.txt"), "one\n");
    await h.service.createSessionBaselines(SESSION, [h.root]);

    // Pre-first-send edit: every view degrades to the working frame.
    await writeFile(h.file("a.txt"), "two\n");
    assert.equal((await h.service.diffStatus(SESSION, "turn")).length, 1);
    assert.equal((await h.service.diffStatus(SESSION, "full-session")).length, 1);

    // Send: the turn frame captures "two"; the turn view empties, session keeps the change.
    await h.service.beginTurnBaselines(SESSION);
    assert.equal((await h.service.diffStatus(SESSION, "turn")).length, 0);
    assert.equal((await h.service.diffStatus(SESSION, "session")).length, 1);

    // An edit during the turn shows in both frames, with turn-relative stats.
    await writeFile(h.file("a.txt"), "two\nthree\n");
    const turn = await h.service.diffStatus(SESSION, "turn");
    assert.equal(turn.length, 1);
    assert.equal(turn[0]?.addedLines, 1);
    assert.equal(turn[0]?.removedLines, 0);
    const session = await h.service.diffStatus(SESSION, "session");
    assert.equal(session[0]?.addedLines, 2);
    assert.equal(session[0]?.removedLines, 1);
  } finally {
    await h.cleanup();
  }
});

test("each send replaces the turn frame; a clean send keeps the existing one", async () => {
  const h = await diffHarness();
  try {
    await writeFile(h.file("a.txt"), "one\n");
    await h.service.createSessionBaselines(SESSION, [h.root]);

    // Clean first send: nothing changed, so no turn baseline is written at all.
    await h.service.beginTurnBaselines(SESSION);
    const afterClean = await h.diff.listBaselines(asId<"SessionId">(SESSION));
    assert.equal(afterClean.filter((b) => b.scope === "turn").length, 0);

    await writeFile(h.file("a.txt"), "two\n");
    await h.service.beginTurnBaselines(SESSION);
    const firstTurn = (await h.diff.listBaselines(asId<"SessionId">(SESSION))).filter((b) => b.scope === "turn");
    assert.equal(firstTurn.length, 1);

    await writeFile(h.file("a.txt"), "three\n");
    await h.service.beginTurnBaselines(SESSION);
    const secondTurn = (await h.diff.listBaselines(asId<"SessionId">(SESSION))).filter((b) => b.scope === "turn");
    assert.equal(secondTurn.length, 1);
    assert.notEqual(secondTurn[0]?.baselineId, firstTurn[0]?.baselineId);
  } finally {
    await h.cleanup();
  }
});

test("accept advances the working and turn frames but never session-start", async () => {
  const h = await diffHarness();
  try {
    await writeFile(h.file("a.txt"), "one\n");
    await h.service.createSessionBaselines(SESSION, [h.root]);
    await writeFile(h.file("a.txt"), "two\n");
    await h.service.beginTurnBaselines(SESSION);
    await writeFile(h.file("a.txt"), "three\n");

    // Accept from the turn view's row: both live frames clear, history stays.
    const turnRows = await h.service.diffStatus(SESSION, "turn");
    assert.equal(turnRows.length, 1);
    const afterAccept = await h.service.acceptFile(turnRows[0]?.baselineId ?? "", "a.txt", "turn");
    assert.equal(afterAccept.length, 0);
    assert.equal((await h.service.diffStatus(SESSION, "session")).length, 0);

    const full = await h.service.diffStatus(SESSION, "full-session");
    assert.equal(full.length, 1);
    assert.equal(full[0]?.accepted, true);

    // A fresh edit reopens the file everywhere and clears the accepted mark.
    await writeFile(h.file("a.txt"), "four\n");
    assert.equal((await h.service.diffStatus(SESSION, "session")).length, 1);
    assert.equal((await h.service.diffStatus(SESSION, "turn")).length, 1);
    const fullAgain = await h.service.diffStatus(SESSION, "full-session");
    assert.equal(fullAgain[0]?.accepted, undefined);
  } finally {
    await h.cleanup();
  }
});

test("accepting via a full-session row leaves the session-start snapshot untouched", async () => {
  const h = await diffHarness();
  try {
    await writeFile(h.file("a.txt"), "one\n");
    await h.service.createSessionBaselines(SESSION, [h.root]);
    await writeFile(h.file("a.txt"), "two\n");

    const full = await h.service.diffStatus(SESSION, "full-session");
    const refreshed = await h.service.acceptFile(full[0]?.baselineId ?? "", "a.txt", "full-session");

    // The response reflects the caller's view: the row stays, now as history.
    assert.equal(refreshed.length, 1);
    assert.equal(refreshed[0]?.accepted, true);
    assert.equal((await h.service.diffStatus(SESSION, "session")).length, 0);
  } finally {
    await h.cleanup();
  }
});

test("an accepted delete reads as history in the full-session view", async () => {
  const h = await diffHarness();
  try {
    await writeFile(h.file("gone.txt"), "bye\n");
    await h.service.createSessionBaselines(SESSION, [h.root]);
    await rm(h.file("gone.txt"));

    const session = await h.service.diffStatus(SESSION, "session");
    assert.equal(session[0]?.changeKind, "delete");
    await h.service.acceptFile(session[0]?.baselineId ?? "", "gone.txt", "session");

    assert.equal((await h.service.diffStatus(SESSION, "session")).length, 0);
    const full = await h.service.diffStatus(SESSION, "full-session");
    assert.equal(full[0]?.changeKind, "delete");
    assert.equal(full[0]?.accepted, true);
  } finally {
    await h.cleanup();
  }
});

test("revert restores the row's own frame: a turn row rolls back to the send state", async () => {
  const h = await diffHarness();
  try {
    await writeFile(h.file("a.txt"), "one\n");
    await h.service.createSessionBaselines(SESSION, [h.root]);
    await writeFile(h.file("a.txt"), "two\n");
    await h.service.beginTurnBaselines(SESSION);
    await writeFile(h.file("a.txt"), "three\n");

    const turnRows = await h.service.diffStatus(SESSION, "turn");
    const refreshed = await h.service.revertFile(turnRows[0]?.baselineId ?? "", "a.txt", "turn");

    assert.equal(refreshed.length, 0);
    assert.equal(await readFile(h.file("a.txt"), "utf8"), "two\n");
    // The pre-send change is still pending in the session frame.
    assert.equal((await h.service.diffStatus(SESSION, "session")).length, 1);
  } finally {
    await h.cleanup();
  }
});
