/**
 * Unit tests for SQLite subtask persistence: CRUD, dependency add/remove,
 * cascade of dependency edges on subtask delete, and the work_tasks.column_id
 * backfill from legacy state performed during migration.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { asId } from "@drydock/contracts";
import type { SubtaskRecord, WorkTaskRecord } from "@drydock/contracts";
import { applyMigrations } from "./migrations.js";
import { SqliteConnection } from "./sqliteConnection.js";
import { SqliteSubtaskStore } from "./subtaskStore.js";
import { SqliteWorkTaskStore } from "./workTaskStore.js";

test("subtasks insert, update (incl. clearing prompt/description), and list per task", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "subtasks.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const taskStore = new SqliteWorkTaskStore(connection);
    const store = new SqliteSubtaskStore(connection);

    await taskStore.insertTask(task("task-1"));

    await store.insertSubtask(subtask("sub-1", "task-1", 0, { description: "notes", prompt: "do it" }));
    await store.insertSubtask(subtask("sub-2", "task-1", 1));

    await store.updateSubtask(asId<"SubtaskId">("sub-1"), {
      updatedAt: "2026-07-03T00:00:02.000Z",
      description: null,
      prompt: null,
      sortOrder: 5
    });
    connection.close();

    const reopened = new SqliteConnection(dbPath);
    applyMigrations(reopened);
    const reopenedStore = new SqliteSubtaskStore(reopened);
    const listed = await reopenedStore.listForTask(asId<"TaskId">("task-1"));
    const first = await reopenedStore.getSubtask(asId<"SubtaskId">("sub-1"));
    reopened.close();

    // sub-2 (sortOrder 1) now sorts ahead of sub-1 (bumped to sortOrder 5).
    assert.deepEqual(listed.map((entry) => entry.subtaskId), ["sub-2", "sub-1"]);
    assert.equal(first?.description, undefined);
    assert.equal(first?.prompt, undefined);
    assert.equal(first?.sortOrder, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("autoStart defaults to false, round-trips true, and toggles via update", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "subtask-autostart.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const taskStore = new SqliteWorkTaskStore(connection);
    const store = new SqliteSubtaskStore(connection);

    await taskStore.insertTask(task("task-1"));
    await store.insertSubtask(subtask("sub-default", "task-1", 0));
    await store.insertSubtask(subtask("sub-cascade", "task-1", 1, { autoStart: true }));
    connection.close();

    // The flag survives a reopen in both states.
    const reopened = new SqliteConnection(dbPath);
    applyMigrations(reopened);
    const reopenedStore = new SqliteSubtaskStore(reopened);
    assert.equal((await reopenedStore.getSubtask(asId<"SubtaskId">("sub-default")))?.autoStart, false);
    assert.equal((await reopenedStore.getSubtask(asId<"SubtaskId">("sub-cascade")))?.autoStart, true);

    // Update toggles it in both directions without touching other fields.
    await reopenedStore.updateSubtask(asId<"SubtaskId">("sub-default"), {
      updatedAt: "2026-07-03T00:00:02.000Z",
      autoStart: true
    });
    await reopenedStore.updateSubtask(asId<"SubtaskId">("sub-cascade"), {
      updatedAt: "2026-07-03T00:00:02.000Z",
      autoStart: false
    });
    assert.equal((await reopenedStore.getSubtask(asId<"SubtaskId">("sub-default")))?.autoStart, true);
    assert.equal((await reopenedStore.getSubtask(asId<"SubtaskId">("sub-cascade")))?.autoStart, false);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listAll returns subtasks across tasks", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "subtasks-all.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const taskStore = new SqliteWorkTaskStore(connection);
    const store = new SqliteSubtaskStore(connection);

    await taskStore.insertTask(task("task-1"));
    await taskStore.insertTask(task("task-2"));
    await store.insertSubtask(subtask("sub-1", "task-1", 0));
    await store.insertSubtask(subtask("sub-2", "task-2", 0));

    const all = await store.listAll();
    connection.close();

    assert.deepEqual(all.map((entry) => entry.subtaskId).sort(), ["sub-1", "sub-2"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dependency add/remove and cascade delete of edges when a subtask is deleted", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "subtask-deps.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const taskStore = new SqliteWorkTaskStore(connection);
    const store = new SqliteSubtaskStore(connection);

    await taskStore.insertTask(task("task-1"));
    await store.insertSubtask(subtask("sub-1", "task-1", 0));
    await store.insertSubtask(subtask("sub-2", "task-1", 1));
    await store.insertSubtask(subtask("sub-3", "task-1", 2));

    await store.insertDependency({
      taskId: asId<"TaskId">("task-1"),
      fromSubtaskId: asId<"SubtaskId">("sub-1"),
      toSubtaskId: asId<"SubtaskId">("sub-2"),
      createdAt: "2026-07-03T00:00:01.000Z"
    });
    await store.insertDependency({
      taskId: asId<"TaskId">("task-1"),
      fromSubtaskId: asId<"SubtaskId">("sub-2"),
      toSubtaskId: asId<"SubtaskId">("sub-3"),
      createdAt: "2026-07-03T00:00:02.000Z"
    });

    assert.equal((await store.listDependenciesForTask(asId<"TaskId">("task-1"))).length, 2);

    connection.database.prepare(`
      INSERT INTO subtask_holds (subtask_id, kind, origin, force, held_at)
      VALUES (?, 'queued', 'manual', 0, ?)
    `).run("sub-3", "2026-07-03T00:00:03.000Z");
    connection.database.prepare(`
      INSERT INTO task_changesets (
        changeset_id, task_id, subtask_id, session_id, repo_name,
        patch_sha256, patch_bytes, file_count, captured_at, landed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run("changeset-1", "task-1", "sub-3", "session-1", "repo", "a".repeat(64), 1, 1, "2026-07-03T00:00:03.000Z");
    await taskStore.insertLink({
      taskId: asId<"TaskId">("task-1"),
      sessionId: asId<"SessionId">("session-1"),
      subtaskId: asId<"SubtaskId">("sub-3"),
      createdAt: "2026-07-03T00:00:03.000Z"
    });

    await store.removeDependency(asId<"SubtaskId">("sub-1"), asId<"SubtaskId">("sub-2"));
    assert.equal((await store.listDependenciesForTask(asId<"TaskId">("task-1"))).length, 1);

    // Deleting sub-3 (an endpoint of the remaining edge) cascades the edge away.
    await store.deleteSubtask(asId<"SubtaskId">("sub-3"));
    assert.equal((await store.listDependenciesForTask(asId<"TaskId">("task-1"))).length, 0);
    assert.equal(await store.getSubtask(asId<"SubtaskId">("sub-3")), null);
    const holdCount = connection.database.prepare("SELECT COUNT(*) AS count FROM subtask_holds").get() as { readonly count: number };
    const changesetCount = connection.database.prepare("SELECT COUNT(*) AS count FROM task_changesets").get() as { readonly count: number };
    assert.equal(holdCount.count, 0);
    assert.equal(changesetCount.count, 0);
    assert.equal((await taskStore.listSessionIdsBySubtask(asId<"SubtaskId">("sub-3"))).length, 0);
    connection.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleting a task cascades its subtasks and their dependency edges", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "subtask-task-cascade.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const taskStore = new SqliteWorkTaskStore(connection);
    const store = new SqliteSubtaskStore(connection);

    await taskStore.insertTask(task("task-1"));
    await store.insertSubtask(subtask("sub-1", "task-1", 0));
    await store.insertSubtask(subtask("sub-2", "task-1", 1));
    await store.insertDependency({
      taskId: asId<"TaskId">("task-1"),
      fromSubtaskId: asId<"SubtaskId">("sub-1"),
      toSubtaskId: asId<"SubtaskId">("sub-2"),
      createdAt: "2026-07-03T00:00:01.000Z"
    });

    // Mirrors the "links first, then the task row" cascade pattern: the
    // service layer deletes subtasks (which cascades their edges) before
    // deleting the task row itself.
    for (const entry of await store.listForTask(asId<"TaskId">("task-1"))) {
      await store.deleteSubtask(entry.subtaskId);
    }
    await taskStore.deleteTask(asId<"TaskId">("task-1"));
    connection.close();

    const reopened = new SqliteConnection(dbPath);
    applyMigrations(reopened);
    const reopenedStore = new SqliteSubtaskStore(reopened);
    assert.equal((await reopenedStore.listForTask(asId<"TaskId">("task-1"))).length, 0);
    assert.equal((await reopenedStore.listDependenciesForTask(asId<"TaskId">("task-1"))).length, 0);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reassignSubtasksColumn moves every subtask on a column to another", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "subtask-reassign.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const taskStore = new SqliteWorkTaskStore(connection);
    const store = new SqliteSubtaskStore(connection);

    await taskStore.insertTask(task("task-1"));
    await store.insertSubtask(subtask("sub-1", "task-1", 0, { columnId: "col-blocked" }));
    await store.insertSubtask(subtask("sub-2", "task-1", 1, { columnId: "col-todo" }));

    await store.reassignSubtasksColumn(asId<"ColumnId">("col-blocked"), asId<"ColumnId">("col-todo"));
    const listed = await store.listForTask(asId<"TaskId">("task-1"));
    connection.close();

    assert.ok(listed.every((entry) => entry.columnId === "col-todo"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("colorOverride round-trips through insert, update, clear, and a reopen", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "subtask-color-override.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const taskStore = new SqliteWorkTaskStore(connection);
    const store = new SqliteSubtaskStore(connection);

    await taskStore.insertTask(task("task-1"));
    // Absent by default (undefined, not 0) — falls back to the parent task's stripe hue.
    await store.insertSubtask(subtask("sub-default", "task-1", 0));
    // Set at creation time.
    await store.insertSubtask(subtask("sub-colored", "task-1", 1, { colorOverride: 3 }));

    assert.equal((await store.getSubtask(asId<"SubtaskId">("sub-default")))?.colorOverride, undefined);
    assert.equal((await store.getSubtask(asId<"SubtaskId">("sub-colored")))?.colorOverride, 3);

    // Update sets an override on the previously-unset subtask.
    await store.updateSubtask(asId<"SubtaskId">("sub-default"), {
      updatedAt: "2026-07-03T00:00:02.000Z",
      colorOverride: 5
    });
    assert.equal((await store.getSubtask(asId<"SubtaskId">("sub-default")))?.colorOverride, 5);

    // null clears it back to "use the parent task's stripe hue" (undefined, not 0).
    await store.updateSubtask(asId<"SubtaskId">("sub-colored"), {
      updatedAt: "2026-07-03T00:00:03.000Z",
      colorOverride: null
    });
    connection.close();

    const reopened = new SqliteConnection(dbPath);
    applyMigrations(reopened);
    const reopenedStore = new SqliteSubtaskStore(reopened);
    const stillColored = await reopenedStore.getSubtask(asId<"SubtaskId">("sub-default"));
    const cleared = await reopenedStore.getSubtask(asId<"SubtaskId">("sub-colored"));
    reopened.close();

    assert.equal(stillColored?.colorOverride, 5);
    assert.equal(cleared?.colorOverride, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migration backfills work_tasks.column_id from legacy state for pre-existing rows", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "backfill.sqlite");
  try {
    // Simulate a pre-column-model DB: apply migrations, then hand-write a row
    // the way the old schema would (state set, column_id left NULL) to prove
    // the backfill (not just insertTask's own column_id) does the mapping.
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    connection.database.exec(`
      INSERT INTO work_tasks (task_id, title, description, state, column_id, created_at, updated_at, done_at)
      VALUES
        ('legacy-todo', 'Todo task', NULL, 'todo', NULL, '2026-07-03T00:00:00.000Z', '2026-07-03T00:00:00.000Z', NULL),
        ('legacy-in-progress', 'In progress task', NULL, 'in-progress', NULL, '2026-07-03T00:00:00.000Z', '2026-07-03T00:00:00.000Z', NULL),
        ('legacy-blocked', 'Blocked task', NULL, 'blocked', NULL, '2026-07-03T00:00:00.000Z', '2026-07-03T00:00:00.000Z', NULL),
        ('legacy-review', 'Review task', NULL, 'review', NULL, '2026-07-03T00:00:00.000Z', '2026-07-03T00:00:00.000Z', NULL),
        ('legacy-done', 'Done task', NULL, 'done', NULL, '2026-07-03T00:00:00.000Z', '2026-07-03T00:00:00.000Z', NULL)
    `);
    connection.close();

    // Re-applying migrations against the now-populated DB performs the backfill.
    const reopened = new SqliteConnection(dbPath);
    applyMigrations(reopened);
    const taskStore = new SqliteWorkTaskStore(reopened);
    const todo = await taskStore.getTask(asId<"TaskId">("legacy-todo"));
    const inProgress = await taskStore.getTask(asId<"TaskId">("legacy-in-progress"));
    const blocked = await taskStore.getTask(asId<"TaskId">("legacy-blocked"));
    const review = await taskStore.getTask(asId<"TaskId">("legacy-review"));
    const done = await taskStore.getTask(asId<"TaskId">("legacy-done"));
    reopened.close();

    assert.equal(todo?.columnId, "col-todo");
    assert.equal(inProgress?.columnId, "col-in-progress");
    assert.equal(blocked?.columnId, "col-blocked");
    assert.equal(review?.columnId, "col-review");
    assert.equal(done?.columnId, "col-finished");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function task(taskId: string): WorkTaskRecord {
  return {
    taskId: asId<"TaskId">(taskId),
    title: "Task",
    state: "todo",
    columnId: asId<"ColumnId">("col-todo"),
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z"
  };
}

function subtask(
  subtaskId: string,
  taskId: string,
  sortOrder: number,
  options?: {
    readonly description?: string;
    readonly prompt?: string;
    readonly columnId?: string;
    readonly autoStart?: boolean;
    readonly colorOverride?: number;
  }
): SubtaskRecord {
  return {
    subtaskId: asId<"SubtaskId">(subtaskId),
    taskId: asId<"TaskId">(taskId),
    title: "Subtask",
    ...(options?.description === undefined ? {} : { description: options.description }),
    ...(options?.prompt === undefined ? {} : { prompt: options.prompt }),
    origin: "manual",
    autoStart: options?.autoStart ?? false,
    columnId: asId<"ColumnId">(options?.columnId ?? "col-todo"),
    sortOrder,
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
    ...(options?.colorOverride === undefined ? {} : { colorOverride: options.colorOverride })
  };
}
