/**
 * Unit tests for SQLite work-session persistence: upsert (replace on the
 * (task, session) key), newest-activity-first listing with filters, and the
 * per-task / per-session delete counts.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { asId } from "@drydock/contracts";
import type { WorkSessionRecord } from "@drydock/contracts";
import { applyMigrations } from "./migrations.js";
import { SqliteConnection } from "./sqliteConnection.js";
import { SqliteWorkSessionStore } from "./workSessionStore.js";

test("work sessions upsert on (task, session) and list newest-activity-first", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "work-sessions.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const store = new SqliteWorkSessionStore(connection);

    await store.upsertWorkSession(session("task-1", "session-a", "2026-07-03T00:00:00.000Z", 1, "set-1"));
    await store.upsertWorkSession(session("task-1", "session-b", "2026-07-03T00:00:02.000Z", 1));
    // Replace session-a with a later activity and a higher turn count.
    await store.upsertWorkSession(session("task-1", "session-a", "2026-07-03T00:00:03.000Z", 2, "set-1"));
    connection.close();

    const reopened = new SqliteConnection(dbPath);
    applyMigrations(reopened);
    const reopenedStore = new SqliteWorkSessionStore(reopened);
    const all = await reopenedStore.listWorkSessions();
    const one = await reopenedStore.getWorkSession(asId<"TaskId">("task-1"), asId<"SessionId">("session-a"));
    const bySet = await reopenedStore.listWorkSessions({ workspaceSetId: asId<"WorkspaceSetId">("set-1") });
    reopened.close();

    // Newest activity first; the replaced session-a leads, and no duplicate row survives.
    assert.deepEqual(all.map((record) => record.sessionId), ["session-a", "session-b"]);
    assert.equal(one?.turnCount, 2);
    assert.equal(one?.workspaceSetId, "set-1");
    assert.deepEqual(bySet.map((record) => record.sessionId), ["session-a"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("work sessions filter by task and delete by task or session with counts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "work-session-deletes.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const store = new SqliteWorkSessionStore(connection);

    await store.upsertWorkSession(session("task-1", "session-a", "2026-07-03T00:00:00.000Z", 1));
    await store.upsertWorkSession(session("task-2", "session-a", "2026-07-03T00:00:01.000Z", 1));
    await store.upsertWorkSession(session("task-2", "session-b", "2026-07-03T00:00:02.000Z", 1));

    assert.equal((await store.listWorkSessions({ taskId: asId<"TaskId">("task-2") })).length, 2);

    // Deleting session-a spans both tasks; the count reflects both rows.
    assert.equal(await store.deleteForSession(asId<"SessionId">("session-a")), 2);
    assert.equal(await store.deleteForTask(asId<"TaskId">("task-2")), 1);
    assert.equal((await store.listWorkSessions()).length, 0);
    connection.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function session(
  taskId: string,
  sessionId: string,
  lastActivityAt: string,
  turnCount: number,
  workspaceSetId?: string
): WorkSessionRecord {
  return {
    taskId: asId<"TaskId">(taskId),
    sessionId: asId<"SessionId">(sessionId),
    ...(workspaceSetId === undefined ? {} : { workspaceSetId: asId<"WorkspaceSetId">(workspaceSetId) }),
    startedAt: "2026-07-03T00:00:00.000Z",
    lastActivityAt,
    turnCount
  };
}
