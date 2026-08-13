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
  const connection = new SqliteConnection(dbPath);
  try {
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
    connection.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("T3.5: deleteProject prunes a workspace set left with zero members", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "stage3-prune.sqlite");
  const connection = new SqliteConnection(dbPath);
  try {
    applyMigrations(connection);
    const projects = new SqliteProjectCatalogStore(connection);
    const sets = new SqliteWorkspaceSetStore(connection);

    await projects.insertProject(project("project-a", "C:\\repos\\a"), "c:/repos/a");
    await projects.insertProject(project("project-b", "C:\\repos\\b"), "c:/repos/b");
    await projects.insertProject(project("project-c", "C:\\repos\\c"), "c:/repos/c");
    await sets.insertWorkspaceSet(workspaceSet("set-1", ["project-a", "project-b"]));
    // An unrelated set must survive set-1's pruning untouched.
    await sets.insertWorkspaceSet(workspaceSet("set-2", ["project-c"]));

    // Removing one of two members only trims the membership; the set survives
    // (validateSet's "at least one project" rule is not yet violated).
    await projects.deleteProject(asId<"ProjectId">("project-b"));
    const afterFirst = await sets.getWorkspaceSet(asId<"WorkspaceSetId">("set-1"));
    assert.deepEqual(afterFirst?.projectIds, ["project-a"]);

    // Removing the LAST member prunes the set entirely instead of leaving it
    // to silently resolve to zero mounts.
    await projects.deleteProject(asId<"ProjectId">("project-a"));
    assert.equal(await sets.getWorkspaceSet(asId<"WorkspaceSetId">("set-1")), null);

    // The unrelated set (and its still-valid project) are untouched.
    const survivor = await sets.getWorkspaceSet(asId<"WorkspaceSetId">("set-2"));
    assert.deepEqual(survivor?.projectIds, ["project-c"]);
    assert.equal((await projects.listProjects()).length, 1);
  } finally {
    connection.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("T3.8: insertWorkspaceSet rolls back entirely when a member references a missing project", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "stage3-txn-insert.sqlite");
  const connection = new SqliteConnection(dbPath);
  try {
    applyMigrations(connection);
    const projects = new SqliteProjectCatalogStore(connection);
    const sets = new SqliteWorkspaceSetStore(connection);
    await projects.insertProject(project("project-a", "C:\\repos\\a"), "c:/repos/a");

    // The second member's project_id does not exist in project_records, so
    // the FK on workspace_set_projects throws partway through the membership
    // insert loop - the whole transaction (the workspace_sets row AND the
    // first, otherwise-valid membership row) must roll back rather than
    // leave a partially-created set behind.
    await assert.rejects(
      () => sets.insertWorkspaceSet(workspaceSet("set-bad", ["project-a", "project-missing"])),
      /FOREIGN KEY/
    );

    assert.equal(await sets.getWorkspaceSet(asId<"WorkspaceSetId">("set-bad")), null);
    const leaked = connection.database.prepare(
      "SELECT project_id FROM workspace_set_projects WHERE workspace_set_id = ?"
    ).all("set-bad") as unknown as { readonly project_id: string }[];
    assert.equal(leaked.length, 0);
  } finally {
    connection.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("T3.8: updateWorkspaceSet rolls back to the prior membership when a new member references a missing project", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "stage3-txn-update.sqlite");
  const connection = new SqliteConnection(dbPath);
  try {
    applyMigrations(connection);
    const projects = new SqliteProjectCatalogStore(connection);
    const sets = new SqliteWorkspaceSetStore(connection);
    await projects.insertProject(project("project-a", "C:\\repos\\a"), "c:/repos/a");
    await sets.insertWorkspaceSet(workspaceSet("set-1", ["project-a"]));

    await assert.rejects(
      () => sets.updateWorkspaceSet({ ...workspaceSet("set-1", ["project-missing"]), name: "Renamed" }),
      /FOREIGN KEY/
    );

    // Neither the rename nor the membership swap took effect - the OLD
    // membership (deleted, then meant to be replaced, in the same
    // transaction as the failed insert) is exactly what survives.
    const after = await sets.getWorkspaceSet(asId<"WorkspaceSetId">("set-1"));
    assert.equal(after?.name, "Test set");
    assert.deepEqual(after?.projectIds, ["project-a"]);
  } finally {
    connection.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("diff baselines and review threads persist with per-file replacement", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "stage4.sqlite");
  const connection = new SqliteConnection(dbPath);
  try {
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

    // A second baseline for the same session deletes cleanly (record + rows)
    // without touching its sibling - the turn-frame replacement path.
    await diffs.insertBaseline({ ...baseline("baseline-2"), scope: "turn" }, [
      { path: "a.txt", sha256: "d".repeat(64), size: 3, mtimeMs: 444, capturedAtMs: 3000, blobStored: true }
    ]);
    await diffs.deleteBaseline(asId<"BaselineId">("baseline-2"));
    assert.equal(await diffs.getBaseline(asId<"BaselineId">("baseline-2")), null);
    assert.equal((await diffs.listFileSnapshots(asId<"BaselineId">("baseline-2"))).length, 0);

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
    connection.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("T3.8: insertBaseline rolls back entirely when two snapshots collide on path", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "stage4-txn-insert.sqlite");
  const connection = new SqliteConnection(dbPath);
  try {
    applyMigrations(connection);
    const diffs = new SqliteDiffBaselineStore(connection);

    // Two snapshots for the same path violate the (baseline_id, path)
    // primary key partway through the insert loop - the baseline row itself
    // (inserted first, in the same transaction) must roll back too, instead
    // of leaving a baseline with a partial file list.
    await assert.rejects(
      () => diffs.insertBaseline(baseline("baseline-bad"), [
        { path: "a.txt", sha256: "a".repeat(64), size: 1, mtimeMs: 1, capturedAtMs: 1, blobStored: true },
        { path: "a.txt", sha256: "b".repeat(64), size: 2, mtimeMs: 2, capturedAtMs: 2, blobStored: true }
      ]),
      /UNIQUE constraint|PRIMARY KEY/i
    );

    assert.equal(await diffs.getBaseline(asId<"BaselineId">("baseline-bad")), null);
    assert.equal((await diffs.listFileSnapshots(asId<"BaselineId">("baseline-bad"))).length, 0);
  } finally {
    connection.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("T3.8: deleteBaseline rolls back when the second delete throws mid-sequence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "stage4-txn-delete.sqlite");
  const connection = new SqliteConnection(dbPath);
  try {
    applyMigrations(connection);
    const diffs = new SqliteDiffBaselineStore(connection);
    await diffs.insertBaseline(baseline("baseline-x"), [
      { path: "a.txt", sha256: "a".repeat(64), size: 1, mtimeMs: 1, capturedAtMs: 1, blobStored: true }
    ]);

    // deleteBaseline has no natural constraint to violate (DELETE cannot
    // trip a FK/PK), so the crash this transaction guards against is forced
    // directly: the SECOND prepared statement's run() is made to throw,
    // simulating a mid-sequence failure, and restored immediately after.
    const rawDb = connection.database as unknown as {
      prepare: (sql: string) => { run: (...args: unknown[]) => unknown };
    };
    const realPrepare = rawDb.prepare.bind(rawDb);
    let calls = 0;
    rawDb.prepare = (sql: string) => {
      calls += 1;
      const statement = realPrepare(sql);
      if (calls === 2) {
        statement.run = () => {
          throw new Error("forced failure");
        };
      }
      return statement;
    };
    try {
      await assert.rejects(() => diffs.deleteBaseline(asId<"BaselineId">("baseline-x")), /forced failure/);
    } finally {
      rawDb.prepare = realPrepare;
    }

    // Rolled back: the first delete (the file row) did not survive on its own.
    assert.equal((await diffs.listFileSnapshots(asId<"BaselineId">("baseline-x"))).length, 1);
    assert.notEqual(await diffs.getBaseline(asId<"BaselineId">("baseline-x")), null);
  } finally {
    connection.close();
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
