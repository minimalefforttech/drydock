/**
 * Unit tests for Stage 3/4 SQLite persistence: workspace policy records and
 * diff/review records surviving a connection reopen.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { asId } from "@drydock/contracts";
import type { AccessRequestRecord, DiffBaselineRecord, ProjectRecord, ReviewCommentRecord, ReviewSessionRecord, WorkspaceSetRecord } from "@drydock/contracts";
import { SqliteDiffBaselineStore, SqliteReviewStore } from "./diffReviewStore.js";
import { applyMigrations } from "./migrations.js";
import { SqliteConnection } from "./sqliteConnection.js";
import { SqliteAccessRequestStore, SqliteProjectCatalogStore, SqliteWorkspaceSetStore } from "./workspacePolicyStore.js";

test("workspace policy records persist across reopen", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "stage3.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const projects = new SqliteProjectCatalogStore(connection);
    const sets = new SqliteWorkspaceSetStore(connection);
    const requests = new SqliteAccessRequestStore(connection);

    await projects.insertProject(project("project-a", "C:\\repos\\a"), "c:/repos/a");
    await projects.insertProject(project("project-b", "C:\\repos\\b"), "c:/repos/b");
    await sets.insertWorkspaceSet(workspaceSet("set-1", ["project-b", "project-a"]));
    await requests.insertRequest(accessRequest("request-1"));
    await requests.updateRequestStatus(asId<"AccessRequestId">("request-1"), "approved", "2026-07-02T00:00:01.000Z", "user");
    connection.close();

    const reopened = new SqliteConnection(dbPath);
    applyMigrations(reopened);
    const byKey = await new SqliteProjectCatalogStore(reopened).getProjectByPathKey("c:/repos/a");
    const set = await new SqliteWorkspaceSetStore(reopened).getWorkspaceSet(asId<"WorkspaceSetId">("set-1"));
    const approved = await new SqliteAccessRequestStore(reopened).listRequests("approved");
    const pending = await new SqliteAccessRequestStore(reopened).listRequests("pending");
    reopened.close();

    assert.equal(byKey?.projectId, "project-a");
    // Membership order is positional, not insertion-alphabetical.
    assert.deepEqual(set?.projectIds, ["project-b", "project-a"]);
    // Members round-trip in the same order with their read-only flag (default false).
    assert.deepEqual(set?.members, [
      { projectId: "project-b", readOnly: false },
      { projectId: "project-a", readOnly: false }
    ]);
    assert.equal(approved.length, 1);
    assert.equal(approved[0]?.resolvedBy, "user");
    assert.equal(pending.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("diff baselines and review threads persist with per-file replacement", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "stage4.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const diffs = new SqliteDiffBaselineStore(connection);
    const reviews = new SqliteReviewStore(connection);

    await diffs.insertBaseline(baseline("baseline-1"), [
      { path: "a.txt", sha256: "a".repeat(64), size: 3, mtimeMs: 111.5, capturedAtMs: 1000, blobStored: true },
      { path: "big.bin", sha256: "b".repeat(64), size: 999, mtimeMs: 222, capturedAtMs: 1000, blobStored: false }
    ]);
    await diffs.replaceFileSnapshot(asId<"BaselineId">("baseline-1"), {
      path: "a.txt",
      sha256: "c".repeat(64),
      size: 5,
      mtimeMs: 333,
      capturedAtMs: 2000,
      blobStored: true
    });
    await diffs.deleteFileSnapshot(asId<"BaselineId">("baseline-1"), "big.bin");

    await reviews.insertReviewSession(reviewSession("review-1"));
    await reviews.insertComment(comment("comment-1", "review-1"));
    await reviews.updateCommentStatus(asId<"ReviewCommentId">("comment-1"), "resolved", "2026-07-02T00:00:09.000Z");
    connection.close();

    const reopened = new SqliteConnection(dbPath);
    applyMigrations(reopened);
    const reopenedDiffs = new SqliteDiffBaselineStore(reopened);
    const snapshots = await reopenedDiffs.listFileSnapshots(asId<"BaselineId">("baseline-1"));
    const sessionBaselines = await reopenedDiffs.listBaselines(asId<"SessionId">("session-test"));
    const workspaceBaselines = await reopenedDiffs.listBaselines();
    const reopenedReviews = new SqliteReviewStore(reopened);
    const open = await reopenedReviews.findOpenReviewSession("current-session", asId<"SessionId">("session-test"));
    const comments = await reopenedReviews.listComments(asId<"ReviewSessionId">("review-1"));
    reopened.close();

    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.sha256, "c".repeat(64));
    assert.equal(snapshots[0]?.capturedAtMs, 2000);
    assert.equal(snapshots[0]?.blobStored, true);
    assert.equal(sessionBaselines.length, 1);
    assert.equal(workspaceBaselines.length, 0);
    assert.equal(open?.reviewSessionId, "review-1");
    assert.equal(comments[0]?.status, "resolved");
    assert.equal(comments[0]?.updatedAt, "2026-07-02T00:00:09.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function project(projectId: string, projectPath: string): ProjectRecord {
  return {
    projectId: asId<"ProjectId">(projectId),
    name: path.basename(projectPath),
    path: projectPath,
    kind: "git",
    createdAt: "2026-07-02T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z"
  };
}

function workspaceSet(workspaceSetId: string, projectIds: readonly string[]): WorkspaceSetRecord {
  const ids = projectIds.map((projectId) => asId<"ProjectId">(projectId));
  return {
    workspaceSetId: asId<"WorkspaceSetId">(workspaceSetId),
    name: "Test set",
    projectIds: ids,
    members: ids.map((projectId) => ({ projectId, readOnly: false })),
    createdAt: "2026-07-02T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z"
  };
}

function accessRequest(accessRequestId: string): AccessRequestRecord {
  return {
    accessRequestId: asId<"AccessRequestId">(accessRequestId),
    sessionId: asId<"SessionId">("session-test"),
    hostPath: "C:\\shared\\lib",
    mode: "read-only",
    reason: "needs shared library",
    status: "pending",
    requestedAt: "2026-07-02T00:00:00.000Z"
  };
}

function baseline(baselineId: string): DiffBaselineRecord {
  return {
    baselineId: asId<"BaselineId">(baselineId),
    scope: "current-session",
    sessionId: asId<"SessionId">("session-test"),
    rootPath: "C:\\repos\\a",
    createdAt: "2026-07-02T00:00:00.000Z"
  };
}

function reviewSession(reviewSessionId: string): ReviewSessionRecord {
  return {
    reviewSessionId: asId<"ReviewSessionId">(reviewSessionId),
    scope: "current-session",
    sessionId: asId<"SessionId">("session-test"),
    status: "open",
    createdAt: "2026-07-02T00:00:00.000Z"
  };
}

function comment(commentId: string, reviewSessionId: string): ReviewCommentRecord {
  return {
    commentId: asId<"ReviewCommentId">(commentId),
    reviewSessionId: asId<"ReviewSessionId">(reviewSessionId),
    filePath: "src/index.ts",
    startLine: 4,
    endLine: 6,
    body: "review this",
    author: "user",
    status: "open",
    createdAt: "2026-07-02T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z"
  };
}
