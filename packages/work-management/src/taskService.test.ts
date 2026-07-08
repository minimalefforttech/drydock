/**
 * Unit tests for TaskService: create, update (state/columnId), link
 * idempotency, unlink, and summary grouping over in-memory stores.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { asId } from "@drydock/contracts";
import type {
  BoardColumnRecord,
  BoardColumnStore,
  ColumnCategory,
  ColumnId,
  SessionId,
  SubtaskId,
  SubtaskRecord,
  SubtaskStore,
  SubtaskDependencyRecord,
  SubtaskUpdate,
  TaskId,
  WorkSessionRecord,
  WorkSessionStore,
  WorkTaskLinkRecord,
  WorkTaskRecord,
  WorkTaskStore,
  WorkTaskUpdate,
  WorkspaceSetId
} from "@drydock/contracts";
import { RandomIdGenerator, type Clock } from "@drydock/core";
import { TaskService } from "./taskService.js";

test("createTask starts in todo/col-todo and rejects blank titles", async () => {
  const service = new TaskService(options());
  const task = await service.createTask("Wire the panel", "grab the diff first");
  assert.equal(task.state, "todo");
  assert.equal(task.columnId, "col-todo");
  assert.equal(task.title, "Wire the panel");
  assert.equal(task.description, "grab the diff first");
  await assert.rejects(() => service.createTask("   "), /must not be empty/);
});

test("updateTask validates fields, transitions legacy state, and clears description", async () => {
  const service = new TaskService(options());
  const task = await service.createTask("Task", "notes");

  await assert.rejects(() => service.updateTask(task.taskId, {}), /at least one field/);
  await assert.rejects(() => service.updateTask(task.taskId, { state: "shipped" as never }), /Unknown task state/);
  await assert.rejects(() => service.updateTask(task.taskId, { title: "  " }), /must not be empty/);

  const moved = await service.updateTask(task.taskId, { state: "in-progress" });
  assert.equal(moved.state, "in-progress");
  assert.equal(moved.columnId, "col-in-progress");

  const cleared = await service.updateTask(task.taskId, { description: "" });
  assert.equal(cleared.description, undefined);
});

test("updateTask accepts columnId directly and stamps/clears doneAt by category", async () => {
  const columns = new MemoryBoardColumnStore();
  const service = new TaskService(options(undefined, undefined, columns));
  const task = await service.createTask("Task");

  const inReview = await service.updateTask(task.taskId, { columnId: "col-review" });
  assert.equal(inReview.columnId, "col-review");
  assert.equal(inReview.state, "done");
  assert.equal(inReview.doneAt, "2026-07-03T00:00:00.000Z");

  const backToTodo = await service.updateTask(task.taskId, { columnId: "col-todo" });
  assert.equal(backToTodo.doneAt, undefined);

  await assert.rejects(() => service.updateTask(task.taskId, { columnId: "col-nonexistent" }), /was not found/);
});

test("link is idempotent and unlink removes the targeted link", async () => {
  const store = new MemoryWorkTaskStore();
  const service = new TaskService(options(store));
  const task = await service.createTask("Task");

  await service.link(task.taskId, { workspaceSetId: "set-1" });
  await service.link(task.taskId, { workspaceSetId: "set-1" });
  assert.equal((await store.listLinks(task.taskId as TaskId)).length, 1);

  await service.link(task.taskId, { sessionId: "session-1" });
  assert.equal((await store.listLinks(task.taskId as TaskId)).length, 2);

  await service.unlink(task.taskId, { workspaceSetId: "set-1" });
  const remaining = await store.listLinks(task.taskId as TaskId);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.sessionId, "session-1");
});

test("link carries an optional subtaskId alongside a session target", async () => {
  const store = new MemoryWorkTaskStore();
  const service = new TaskService(options(store));
  const task = await service.createTask("Task");

  await service.link(task.taskId, { sessionId: "session-1", subtaskId: "subtask-1" });
  const [link] = await store.listLinks(task.taskId as TaskId);
  assert.equal(link?.subtaskId, "subtask-1");
});

test("listTaskSummaries groups links per task from one pass", async () => {
  const service = new TaskService(options());
  const a = await service.createTask("A");
  const b = await service.createTask("B");
  await service.link(a.taskId, { workspaceSetId: "set-1" });
  await service.link(a.taskId, { sessionId: "session-1" });
  await service.link(a.taskId, { sessionId: "session-2" });
  await service.link(b.taskId, { workspaceSetId: "set-9" });

  const summaries = await service.listTaskSummaries();
  const byId = new Map(summaries.map((summary) => [summary.taskId, summary]));

  assert.deepEqual(byId.get(a.taskId)?.linkedWorkspaceSetIds, ["set-1"]);
  assert.deepEqual([...(byId.get(a.taskId)?.linkedSessionIds ?? [])].sort(), ["session-1", "session-2"]);
  assert.deepEqual(byId.get(b.taskId)?.linkedWorkspaceSetIds, ["set-9"]);
  assert.deepEqual(byId.get(b.taskId)?.linkedSessionIds, []);
});

test("listTaskSummaries derives state from columnId category, not the stored state column", async () => {
  const taskStore = new MemoryWorkTaskStore();
  const columns = new MemoryBoardColumnStore();
  const service = new TaskService(options(taskStore, undefined, columns));
  const task = await service.createTask("A");

  // Simulate a card moved by board.moveCard, which writes columnId directly
  // without touching the legacy state column.
  await taskStore.updateTask(task.taskId as TaskId, { updatedAt: "2026-07-03T01:00:00.000Z", columnId: asId<"ColumnId">("col-review") });

  const summary = (await service.listTaskSummaries()).find((candidate) => candidate.taskId === task.taskId);
  assert.equal(summary?.state, "done");
});

test("recordSessionActivity creates then bumps a work session per linked task", async () => {
  const workSessions = new MemoryWorkSessionStore();
  const store = new MemoryWorkTaskStore();
  const service = new TaskService(options(store, workSessions));
  const a = await service.createTask("A");
  const b = await service.createTask("B");
  // task A links the session and exactly one set → workspaceSetId is inferred.
  await service.link(a.taskId, { sessionId: "session-1" });
  await service.link(a.taskId, { workspaceSetId: "set-1" });
  // task B links the session and two sets → workspaceSetId stays ambiguous.
  await service.link(b.taskId, { sessionId: "session-1" });
  await service.link(b.taskId, { workspaceSetId: "set-9" });
  await service.link(b.taskId, { workspaceSetId: "set-8" });

  await service.recordSessionActivity("session-1", "2026-07-03T01:00:00.000Z");
  await service.recordSessionActivity("session-1", "2026-07-03T02:00:00.000Z");

  const sessionA = await workSessions.getWorkSession(a.taskId as TaskId, asId<"SessionId">("session-1"));
  const sessionB = await workSessions.getWorkSession(b.taskId as TaskId, asId<"SessionId">("session-1"));

  // startedAt is preserved from the first touch; turnCount reaches 2.
  assert.equal(sessionA?.startedAt, "2026-07-03T01:00:00.000Z");
  assert.equal(sessionA?.lastActivityAt, "2026-07-03T02:00:00.000Z");
  assert.equal(sessionA?.turnCount, 2);
  assert.equal(sessionA?.workspaceSetId, "set-1");
  // Two linked sets leave the workspace ambiguous → no workspaceSetId.
  assert.equal(sessionB?.workspaceSetId, undefined);
  assert.equal(sessionB?.turnCount, 2);
});

test("listTaskSummaries derives lastWorkedAt and deleteTask drops work sessions", async () => {
  const workSessions = new MemoryWorkSessionStore();
  const store = new MemoryWorkTaskStore();
  const service = new TaskService(options(store, workSessions));
  const a = await service.createTask("A");
  await service.link(a.taskId, { sessionId: "session-1" });
  await service.link(a.taskId, { sessionId: "session-2" });

  await service.recordSessionActivity("session-1", "2026-07-03T01:00:00.000Z");
  await service.recordSessionActivity("session-2", "2026-07-03T05:00:00.000Z");

  const summary = (await service.listTaskSummaries()).find((candidate) => candidate.taskId === a.taskId);
  // lastWorkedAt is the max across the task's two work sessions.
  assert.equal(summary?.lastWorkedAt, "2026-07-03T05:00:00.000Z");

  await service.deleteTask(a.taskId);
  assert.equal((await workSessions.listWorkSessions()).length, 0);
});

test("deleteTask cascades subtasks when a SubtaskStore is configured", async () => {
  const store = new MemoryWorkTaskStore();
  const subtasks = new MemorySubtaskStore();
  const service = new TaskService(options(store, undefined, undefined, subtasks));
  const a = await service.createTask("A");
  await subtasks.insertSubtask(subtask("sub-1", a.taskId));

  await service.deleteTask(a.taskId);
  assert.equal((await subtasks.listForTask(asId<"TaskId">(a.taskId))).length, 0);
});

function options(
  store: WorkTaskStore = new MemoryWorkTaskStore(),
  workSessions?: WorkSessionStore,
  columns: BoardColumnStore = new MemoryBoardColumnStore(),
  subtasks?: SubtaskStore
): {
  ids: RandomIdGenerator;
  clock: Clock;
  store: WorkTaskStore;
  columns: BoardColumnStore;
  workSessions?: WorkSessionStore;
  subtasks?: SubtaskStore;
} {
  return {
    ids: new RandomIdGenerator(),
    clock: fixedClock(),
    store,
    columns,
    ...(workSessions === undefined ? {} : { workSessions }),
    ...(subtasks === undefined ? {} : { subtasks })
  };
}

function fixedClock(): Clock {
  return {
    now: () => new Date("2026-07-03T00:00:00.000Z"),
    isoNow: () => "2026-07-03T00:00:00.000Z"
  };
}

function subtask(subtaskId: string, taskId: string): SubtaskRecord {
  return {
    subtaskId: asId<"SubtaskId">(subtaskId),
    taskId: asId<"TaskId">(taskId),
    title: "Subtask",
    origin: "manual",
    autoStart: false,
    columnId: asId<"ColumnId">("col-todo"),
    sortOrder: 0,
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z"
  };
}

const DEFAULT_TEST_COLUMNS: readonly BoardColumnRecord[] = [
  { columnId: asId<"ColumnId">("col-backlog"), name: "Backlog", category: "backlog", sortOrder: 0 },
  { columnId: asId<"ColumnId">("col-todo"), name: "ToDo", category: "pending", sortOrder: 1 },
  { columnId: asId<"ColumnId">("col-blocked"), name: "Blocked", category: "pending", sortOrder: 2 },
  { columnId: asId<"ColumnId">("col-in-progress"), name: "In Progress", category: "in-progress", sortOrder: 3 },
  { columnId: asId<"ColumnId">("col-review"), name: "Review", category: "done", sortOrder: 4 },
  { columnId: asId<"ColumnId">("col-finished"), name: "Finished", category: "done", sortOrder: 5 }
];

class MemoryBoardColumnStore implements BoardColumnStore {
  private readonly columns = new Map<string, BoardColumnRecord>(
    DEFAULT_TEST_COLUMNS.map((column) => [column.columnId as string, column])
  );

  listColumns(): Promise<BoardColumnRecord[]> {
    return Promise.resolve([...this.columns.values()].sort((a, b) => a.sortOrder - b.sortOrder));
  }

  getColumn(columnId: ColumnId): Promise<BoardColumnRecord | null> {
    return Promise.resolve(this.columns.get(columnId) ?? null);
  }

  insertColumn(record: BoardColumnRecord): Promise<void> {
    this.columns.set(record.columnId, record);
    return Promise.resolve();
  }

  updateColumn(columnId: ColumnId, update: { name?: string; category?: ColumnCategory; sortOrder?: number }): Promise<void> {
    const existing = this.columns.get(columnId);
    if (existing === undefined) return Promise.resolve();
    this.columns.set(columnId, {
      ...existing,
      ...(update.name === undefined ? {} : { name: update.name }),
      ...(update.category === undefined ? {} : { category: update.category }),
      ...(update.sortOrder === undefined ? {} : { sortOrder: update.sortOrder })
    });
    return Promise.resolve();
  }

  deleteColumn(columnId: ColumnId): Promise<void> {
    this.columns.delete(columnId);
    return Promise.resolve();
  }
}

class MemoryWorkSessionStore implements WorkSessionStore {
  private readonly sessions = new Map<string, WorkSessionRecord>();

  private key(taskId: TaskId, sessionId: SessionId): string {
    return `${taskId} ${sessionId}`;
  }

  upsertWorkSession(record: WorkSessionRecord): Promise<void> {
    this.sessions.set(this.key(record.taskId, record.sessionId), record);
    return Promise.resolve();
  }

  getWorkSession(taskId: TaskId, sessionId: SessionId): Promise<WorkSessionRecord | null> {
    return Promise.resolve(this.sessions.get(this.key(taskId, sessionId)) ?? null);
  }

  listWorkSessions(filter?: { taskId?: TaskId; workspaceSetId?: WorkspaceSetId }): Promise<WorkSessionRecord[]> {
    const all = [...this.sessions.values()]
      .filter((record) => filter?.taskId === undefined || record.taskId === filter.taskId)
      .filter((record) => filter?.workspaceSetId === undefined || record.workspaceSetId === filter.workspaceSetId)
      .sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1));
    return Promise.resolve(all);
  }

  deleteForTask(taskId: TaskId): Promise<number> {
    let count = 0;
    for (const [key, record] of this.sessions) {
      if (record.taskId === taskId) {
        this.sessions.delete(key);
        count += 1;
      }
    }
    return Promise.resolve(count);
  }

  deleteForSession(sessionId: SessionId): Promise<number> {
    let count = 0;
    for (const [key, record] of this.sessions) {
      if (record.sessionId === sessionId) {
        this.sessions.delete(key);
        count += 1;
      }
    }
    return Promise.resolve(count);
  }
}

class MemoryWorkTaskStore implements WorkTaskStore {
  private readonly tasks = new Map<TaskId, WorkTaskRecord>();
  private readonly links: WorkTaskLinkRecord[] = [];

  insertTask(record: WorkTaskRecord): Promise<void> {
    this.tasks.set(record.taskId, record);
    return Promise.resolve();
  }

  updateTask(taskId: TaskId, update: WorkTaskUpdate): Promise<void> {
    const existing = this.tasks.get(taskId);
    if (existing === undefined) return Promise.resolve();
    const next: WorkTaskRecord = {
      taskId: existing.taskId,
      title: update.title ?? existing.title,
      ...resolveDescription(existing, update),
      state: update.state ?? existing.state,
      columnId: update.columnId ?? existing.columnId,
      createdAt: existing.createdAt,
      updatedAt: update.updatedAt,
      ...resolveDoneAt(existing, update)
    };
    this.tasks.set(taskId, next);
    return Promise.resolve();
  }

  getTask(taskId: TaskId): Promise<WorkTaskRecord | null> {
    return Promise.resolve(this.tasks.get(taskId) ?? null);
  }

  listTasks(): Promise<WorkTaskRecord[]> {
    return Promise.resolve(
      [...this.tasks.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    );
  }

  deleteTask(taskId: TaskId): Promise<void> {
    for (let i = this.links.length - 1; i >= 0; i -= 1) {
      if (this.links[i]?.taskId === taskId) this.links.splice(i, 1);
    }
    this.tasks.delete(taskId);
    return Promise.resolve();
  }

  insertLink(record: WorkTaskLinkRecord): Promise<void> {
    const duplicate = this.links.some(
      (link) =>
        link.taskId === record.taskId &&
        link.workspaceSetId === record.workspaceSetId &&
        link.sessionId === record.sessionId
    );
    if (!duplicate) this.links.push(record);
    return Promise.resolve();
  }

  deleteLink(taskId: TaskId, target: { workspaceSetId?: WorkspaceSetId; sessionId?: SessionId }): Promise<void> {
    for (let i = this.links.length - 1; i >= 0; i -= 1) {
      const link = this.links[i];
      if (link === undefined || link.taskId !== taskId) continue;
      const hit =
        (target.workspaceSetId !== undefined && link.workspaceSetId === target.workspaceSetId) ||
        (target.sessionId !== undefined && link.sessionId === target.sessionId);
      if (hit) this.links.splice(i, 1);
    }
    return Promise.resolve();
  }

  listLinks(taskId?: TaskId): Promise<WorkTaskLinkRecord[]> {
    return Promise.resolve(taskId === undefined ? [...this.links] : this.links.filter((link) => link.taskId === taskId));
  }

  listSessionIdsBySubtask(subtaskId: SubtaskId): Promise<SessionId[]> {
    return Promise.resolve(
      this.links.filter((link) => link.subtaskId === subtaskId && link.sessionId !== undefined).map((link) => link.sessionId as SessionId)
    );
  }

  reassignTasksColumn(fromColumnId: ColumnId, toColumnId: ColumnId): Promise<void> {
    for (const [taskId, record] of this.tasks) {
      if (record.columnId === fromColumnId) {
        this.tasks.set(taskId, { ...record, columnId: toColumnId });
      }
    }
    return Promise.resolve();
  }
}

class MemorySubtaskStore implements SubtaskStore {
  private readonly subtasks = new Map<string, SubtaskRecord>();
  private readonly dependencies: SubtaskDependencyRecord[] = [];

  insertSubtask(record: SubtaskRecord): Promise<void> {
    this.subtasks.set(record.subtaskId, record);
    return Promise.resolve();
  }

  updateSubtask(subtaskId: SubtaskId, update: SubtaskUpdate): Promise<void> {
    const existing = this.subtasks.get(subtaskId);
    if (existing === undefined) return Promise.resolve();
    this.subtasks.set(subtaskId, {
      ...existing,
      ...(update.title === undefined ? {} : { title: update.title }),
      ...(update.columnId === undefined ? {} : { columnId: update.columnId }),
      ...(update.sortOrder === undefined ? {} : { sortOrder: update.sortOrder }),
      updatedAt: update.updatedAt
    });
    return Promise.resolve();
  }

  getSubtask(subtaskId: SubtaskId): Promise<SubtaskRecord | null> {
    return Promise.resolve(this.subtasks.get(subtaskId) ?? null);
  }

  listForTask(taskId: TaskId): Promise<SubtaskRecord[]> {
    return Promise.resolve([...this.subtasks.values()].filter((entry) => entry.taskId === taskId));
  }

  listAll(): Promise<SubtaskRecord[]> {
    return Promise.resolve([...this.subtasks.values()]);
  }

  deleteSubtask(subtaskId: SubtaskId): Promise<void> {
    this.subtasks.delete(subtaskId);
    for (let i = this.dependencies.length - 1; i >= 0; i -= 1) {
      const edge = this.dependencies[i];
      if (edge !== undefined && (edge.fromSubtaskId === subtaskId || edge.toSubtaskId === subtaskId)) {
        this.dependencies.splice(i, 1);
      }
    }
    return Promise.resolve();
  }

  reassignSubtasksColumn(fromColumnId: ColumnId, toColumnId: ColumnId): Promise<void> {
    for (const [subtaskId, record] of this.subtasks) {
      if (record.columnId === fromColumnId) {
        this.subtasks.set(subtaskId, { ...record, columnId: toColumnId });
      }
    }
    return Promise.resolve();
  }

  insertDependency(record: SubtaskDependencyRecord): Promise<void> {
    this.dependencies.push(record);
    return Promise.resolve();
  }

  removeDependency(fromSubtaskId: SubtaskId, toSubtaskId: SubtaskId): Promise<void> {
    for (let i = this.dependencies.length - 1; i >= 0; i -= 1) {
      const edge = this.dependencies[i];
      if (edge !== undefined && edge.fromSubtaskId === fromSubtaskId && edge.toSubtaskId === toSubtaskId) {
        this.dependencies.splice(i, 1);
      }
    }
    return Promise.resolve();
  }

  listDependenciesForTask(taskId: TaskId): Promise<SubtaskDependencyRecord[]> {
    return Promise.resolve(this.dependencies.filter((edge) => edge.taskId === taskId));
  }
}

function resolveDescription(existing: WorkTaskRecord, update: WorkTaskUpdate): { description?: string } {
  if (update.description === undefined) {
    return existing.description === undefined ? {} : { description: existing.description };
  }
  // null clears the description; a string overwrites it.
  return update.description === null ? {} : { description: update.description };
}

function resolveDoneAt(existing: WorkTaskRecord, update: WorkTaskUpdate): { doneAt?: string } {
  if (update.doneAt === undefined) {
    return existing.doneAt === undefined ? {} : { doneAt: existing.doneAt };
  }
  // null clears doneAt; a string stamps it.
  return update.doneAt === null ? {} : { doneAt: update.doneAt };
}
