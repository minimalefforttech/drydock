/**
 * Unit tests for SQLite work-task persistence: insert/update (incl. description
 * clear), list ordering, delete cascading links, and link uniqueness.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { asId } from "@drydock/contracts";
import type { WorkTaskRecord } from "@drydock/contracts";
import { applyMigrations } from "./migrations.js";
import { SqliteConnection } from "./sqliteConnection.js";
import { SqliteWorkTaskStore } from "./workTaskStore.js";

test("work tasks insert, update, clear description, and list newest-first", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "work-tasks.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const store = new SqliteWorkTaskStore(connection);

    await store.insertTask(task("task-1", "First", "2026-07-03T00:00:00.000Z", "notes"));
    await store.insertTask(task("task-2", "Second", "2026-07-03T00:00:01.000Z"));

    // Update task-1 later so it sorts ahead; clear its description with null.
    await store.updateTask(asId<"TaskId">("task-1"), {
      updatedAt: "2026-07-03T00:00:02.000Z",
      state: "in-progress",
      description: null
    });
    connection.close();

    const reopened = new SqliteConnection(dbPath);
    applyMigrations(reopened);
    const reopenedStore = new SqliteWorkTaskStore(reopened);
    const tasks = await reopenedStore.listTasks();
    const first = await reopenedStore.getTask(asId<"TaskId">("task-1"));
    reopened.close();

    assert.deepEqual(tasks.map((candidate) => candidate.taskId), ["task-1", "task-2"]);
    assert.equal(first?.state, "in-progress");
    assert.equal(first?.description, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleting a task cascades its links and links dedupe on insert", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "work-task-links.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const store = new SqliteWorkTaskStore(connection);

    await store.insertTask(task("task-1", "Linked", "2026-07-03T00:00:00.000Z"));
    await store.insertLink({
      taskId: asId<"TaskId">("task-1"),
      workspaceSetId: asId<"WorkspaceSetId">("set-1"),
      createdAt: "2026-07-03T00:00:01.000Z"
    });
    // Duplicate (task, workspaceSet, null session) is ignored by the UNIQUE constraint.
    await store.insertLink({
      taskId: asId<"TaskId">("task-1"),
      workspaceSetId: asId<"WorkspaceSetId">("set-1"),
      createdAt: "2026-07-03T00:00:02.000Z"
    });
    await store.insertLink({
      taskId: asId<"TaskId">("task-1"),
      sessionId: asId<"SessionId">("session-1"),
      createdAt: "2026-07-03T00:00:03.000Z"
    });

    assert.equal((await store.listLinks(asId<"TaskId">("task-1"))).length, 2);

    // Unlink by whichever target is present.
    await store.deleteLink(asId<"TaskId">("task-1"), { sessionId: asId<"SessionId">("session-1") });
    assert.equal((await store.listLinks(asId<"TaskId">("task-1"))).length, 1);

    // Deleting the task removes remaining links too.
    await store.deleteTask(asId<"TaskId">("task-1"));
    connection.close();

    // The cascade persists: no task and no orphaned links survive a reopen.
    const reopened = new SqliteConnection(dbPath);
    applyMigrations(reopened);
    const reopenedStore = new SqliteWorkTaskStore(reopened);
    assert.equal((await reopenedStore.listLinks()).length, 0);
    assert.equal(await reopenedStore.getTask(asId<"TaskId">("task-1")), null);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function task(taskId: string, title: string, updatedAt: string, description?: string): WorkTaskRecord {
  return {
    taskId: asId<"TaskId">(taskId),
    title,
    ...(description === undefined ? {} : { description }),
    state: "todo",
    columnId: asId<"ColumnId">("col-todo"),
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt
  };
}
