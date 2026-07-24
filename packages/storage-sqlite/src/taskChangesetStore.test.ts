/**
 * SQLite task-changeset store tests (ADR 0014): replace-per-subtask
 * semantics, unlanded projection, session/repo-scoped landing, and
 * durability across a reopen.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { asId } from "@drydock/contracts";
import type { TaskChangesetRecord } from "@drydock/contracts";
import { applyMigrations } from "./migrations.js";
import { SqliteConnection } from "./sqliteConnection.js";
import { SqliteTaskChangesetStore } from "./taskChangesetStore.js";

function record(input: {
  changesetId: string;
  subtaskId: string;
  sessionId: string;
  repoName: string;
  landedAt?: string;
  originCommit?: string;
  baseCommit?: string;
  fullPatchSha256?: string;
  fullPatchBytes?: number;
}): TaskChangesetRecord {
  return {
    changesetId: input.changesetId,
    taskId: asId<"TaskId">("task-1"),
    subtaskId: asId<"SubtaskId">(input.subtaskId),
    sessionId: asId<"SessionId">(input.sessionId),
    repoName: input.repoName,
    patchSha256: `sha-${input.changesetId}`,
    patchBytes: 128,
    fileCount: 3,
    capturedAt: "2026-07-12T00:00:00.000Z",
    ...(input.landedAt === undefined ? {} : { landedAt: input.landedAt }),
    ...(input.originCommit === undefined ? {} : { originCommit: input.originCommit }),
    ...(input.baseCommit === undefined ? {} : { baseCommit: input.baseCommit }),
    ...(input.fullPatchSha256 === undefined ? {} : { fullPatchSha256: input.fullPatchSha256 }),
    ...(input.fullPatchBytes === undefined ? {} : { fullPatchBytes: input.fullPatchBytes })
  };
}

test("replaceForSubtask swaps a subtask's set atomically and survives a reopen", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "changesets.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const store = new SqliteTaskChangesetStore(connection);

    await store.replaceForSubtask(asId<"SubtaskId">("sub-1"), [
      record({ changesetId: "cs-1", subtaskId: "sub-1", sessionId: "session-1", repoName: "api" }),
      record({ changesetId: "cs-2", subtaskId: "sub-1", sessionId: "session-1", repoName: "web" })
    ]);
    await store.replaceForSubtask(asId<"SubtaskId">("sub-2"), [
      record({ changesetId: "cs-3", subtaskId: "sub-2", sessionId: "session-2", repoName: "api" })
    ]);

    // Latest wins for sub-1; sub-2 untouched. cs-4 carries the inspection
    // fields (origin/base commits + full patch blob pointer).
    await store.replaceForSubtask(asId<"SubtaskId">("sub-1"), [
      record({
        changesetId: "cs-4",
        subtaskId: "sub-1",
        sessionId: "session-3",
        repoName: "api",
        originCommit: "origin-sha",
        baseCommit: "base-sha",
        fullPatchSha256: "sha-full",
        fullPatchBytes: 512
      })
    ]);
    connection.close();

    const reopened = new SqliteConnection(dbPath);
    applyMigrations(reopened);
    const reopenedStore = new SqliteTaskChangesetStore(reopened);
    const rows = await reopenedStore.listForSubtasks([asId<"SubtaskId">("sub-1"), asId<"SubtaskId">("sub-2")]);
    reopened.close();

    assert.deepEqual(rows.map((row) => row.changesetId).sort(), ["cs-3", "cs-4"]);
    const cs4 = rows.find((row) => row.changesetId === "cs-4");
    assert.equal(cs4?.patchBytes, 128);
    assert.equal(cs4?.originCommit, "origin-sha");
    assert.equal(cs4?.baseCommit, "base-sha");
    assert.equal(cs4?.fullPatchSha256, "sha-full");
    assert.equal(cs4?.fullPatchBytes, 512);
    // cs-3 predates the inspection fields - they stay absent, never invented.
    const cs3 = rows.find((row) => row.changesetId === "cs-3");
    assert.equal(cs3?.originCommit, undefined);
    assert.equal(cs3?.fullPatchSha256, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unlanded projection and session/repo-scoped landing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  try {
    const connection = new SqliteConnection(path.join(dir, "landing.sqlite"));
    applyMigrations(connection);
    const store = new SqliteTaskChangesetStore(connection);

    await store.replaceForSubtask(asId<"SubtaskId">("sub-1"), [
      record({ changesetId: "cs-1", subtaskId: "sub-1", sessionId: "session-1", repoName: "api" }),
      record({ changesetId: "cs-2", subtaskId: "sub-1", sessionId: "session-1", repoName: "web" })
    ]);
    await store.replaceForSubtask(asId<"SubtaskId">("sub-2"), [
      record({ changesetId: "cs-3", subtaskId: "sub-2", sessionId: "session-2", repoName: "api", landedAt: "2026-07-11T00:00:00.000Z" })
    ]);

    // Only sub-1 has unlanded rows; unknown ids are ignored.
    assert.deepEqual(
      await store.listUnlandedSubtaskIds([asId<"SubtaskId">("sub-1"), asId<"SubtaskId">("sub-2"), asId<"SubtaskId">("ghost")]),
      [asId<"SubtaskId">("sub-1")]
    );

    // Repo-scoped landing touches one row; a repeat is a no-op.
    assert.equal(await store.markLandedBySession(asId<"SessionId">("session-1"), "2026-07-12T01:00:00.000Z", "api"), 1);
    assert.equal(await store.markLandedBySession(asId<"SessionId">("session-1"), "2026-07-12T01:00:00.000Z", "api"), 0);
    // Full landing sweeps the remainder.
    assert.equal(await store.markLandedBySession(asId<"SessionId">("session-1"), "2026-07-12T02:00:00.000Z"), 1);
    assert.deepEqual(await store.listUnlandedSubtaskIds([asId<"SubtaskId">("sub-1")]), []);

    // Delete clears the capture set and reports the count.
    assert.equal(await store.deleteForSubtask(asId<"SubtaskId">("sub-1")), 2);
    connection.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
