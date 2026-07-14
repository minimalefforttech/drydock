/**
 * Unit tests for BoardService: column CRUD, category invariant (every
 * category keeps at least one column), reorder, and nearest-column
 * reassignment of task/subtask cards on delete.
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
  WorkTaskLinkRecord,
  WorkTaskRecord,
  WorkTaskStore,
  WorkTaskUpdate
} from "@drydock/contracts";
import { RandomIdGenerator } from "@drydock/core";
import { BoardService } from "./boardService.js";

function harness(): { board: BoardService; columns: MemoryBoardColumnStore; tasks: MemoryWorkTaskStore; subtasks: MemorySubtaskStore } {
  const columns = new MemoryBoardColumnStore();
  const tasks = new MemoryWorkTaskStore();
  const subtasks = new MemorySubtaskStore();
  const board = new BoardService({ ids: new RandomIdGenerator(), store: columns, tasks, subtasks });
  return { board, columns, tasks, subtasks };
}

test("listColumns returns the seeded defaults ordered by sortOrder", async () => {
  const { board } = harness();
  const columns = await board.listColumns();
  assert.deepEqual(columns.map((column) => column.columnId), [
    "col-backlog",
    "col-todo",
    "col-blocked",
    "col-in-progress",
    "col-review",
    "col-finished"
  ]);
});

test("firstColumnOf returns the lowest-sortOrder column in a category", async () => {
  const { board } = harness();
  const firstPending = await board.firstColumnOf("pending");
  assert.equal(firstPending.columnId, "col-todo");
  const firstDone = await board.firstColumnOf("done");
  assert.equal(firstDone.columnId, "col-review");
});

test("addColumn rejects blank names and unknown categories", async () => {
  const { board } = harness();
  await assert.rejects(() => board.addColumn("  ", "pending"), /must not be empty/);
  await assert.rejects(() => board.addColumn("Weird", "unknown" as never), /Unknown column category/);

  const created = await board.addColumn("Design Review", "pending");
  assert.equal(created.category, "pending");
  assert.equal(created.name, "Design Review");
});

test("renameColumn updates the name only", async () => {
  const { board } = harness();
  const renamed = await board.renameColumn("col-review", "Needs Review");
  assert.equal(renamed.name, "Needs Review");
  assert.equal(renamed.category, "done");
  await assert.rejects(() => board.renameColumn("col-nonexistent", "X"), /was not found/);
});

test("reorder rewrites sortOrder to match the given global order", async () => {
  const { board } = harness();
  const existing = await board.listColumns();
  const reversed = [...existing].reverse().map((column) => column.columnId as string);

  const reordered = await board.reorder(reversed);
  assert.deepEqual(reordered.map((column) => column.columnId), reversed);

  await assert.rejects(() => board.reorder(["col-todo"]), /exactly once/);
});

test("deleteColumn rejects deleting the last column in a category", async () => {
  const { board } = harness();
  // col-backlog is the only backlog-category column.
  await assert.rejects(() => board.deleteColumn("col-backlog"), /last backlog column/);
});

test("deleteColumn moves task and subtask cards to the nearest same-category column", async () => {
  const { board, tasks, subtasks } = harness();
  await tasks.insertTask(task("task-1", "col-blocked"));
  await subtasks.insertSubtask(subtask("sub-1", "task-1", "col-blocked"));

  // col-blocked (sortOrder 2) sits between col-todo (1) and col-in-progress (3)
  // but col-in-progress is a DIFFERENT category, so the nearest same-category
  // (pending) sibling is col-todo.
  await board.deleteColumn("col-blocked");

  const remaining = await board.listColumns();
  assert.ok(!remaining.some((column) => column.columnId === "col-blocked"));

  const movedTask = await tasks.getTask(asId<"TaskId">("task-1"));
  assert.equal(movedTask?.columnId, "col-todo");
  const movedSubtask = await subtasks.getSubtask(asId<"SubtaskId">("sub-1"));
  assert.equal(movedSubtask?.columnId, "col-todo");
});

function task(taskId: string, columnId: string): WorkTaskRecord {
  return {
    taskId: asId<"TaskId">(taskId),
    title: "Task",
    state: "todo",
    columnId: asId<"ColumnId">(columnId),
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z"
  };
}

function subtask(subtaskId: string, taskId: string, columnId: string): SubtaskRecord {
  return {
    subtaskId: asId<"SubtaskId">(subtaskId),
    taskId: asId<"TaskId">(taskId),
    title: "Subtask",
    origin: "manual",
    autoStart: false,
    columnId: asId<"ColumnId">(columnId),
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
    this.tasks.set(taskId, {
      ...existing,
      ...(update.title === undefined ? {} : { title: update.title }),
      ...(update.columnId === undefined ? {} : { columnId: update.columnId }),
      updatedAt: update.updatedAt
    });
    return Promise.resolve();
  }

  getTask(taskId: TaskId): Promise<WorkTaskRecord | null> {
    return Promise.resolve(this.tasks.get(taskId) ?? null);
  }

  listTasks(): Promise<WorkTaskRecord[]> {
    return Promise.resolve([...this.tasks.values()]);
  }

  setClonePolicy(taskId: TaskId, policy: WorkTaskRecord["clonePolicy"]): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task !== undefined) this.tasks.set(taskId, withClonePolicy(task, policy));
    return Promise.resolve();
  }

  deleteTask(taskId: TaskId): Promise<void> {
    this.tasks.delete(taskId);
    return Promise.resolve();
  }

  insertLink(record: WorkTaskLinkRecord): Promise<void> {
    this.links.push(record);
    return Promise.resolve();
  }

  deleteLink(): Promise<void> {
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

function withClonePolicy(record: WorkTaskRecord, policy: WorkTaskRecord["clonePolicy"]): WorkTaskRecord {
  const { clonePolicy: _old, ...withoutPolicy } = record;
  return policy === undefined ? withoutPolicy : { ...withoutPolicy, clonePolicy: policy };
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
      ...(update.columnId === undefined ? {} : { columnId: update.columnId }),
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

  removeDependency(): Promise<void> {
    return Promise.resolve();
  }

  listDependenciesForTask(taskId: TaskId): Promise<SubtaskDependencyRecord[]> {
    return Promise.resolve(this.dependencies.filter((edge) => edge.taskId === taskId));
  }
}
