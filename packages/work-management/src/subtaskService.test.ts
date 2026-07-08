/**
 * Unit tests for SubtaskService: CRUD, dependency validation (same-task,
 * no self-edge, no duplicate, acyclic), moveCard doneAt stamping/clearing,
 * and the computed "blocked" helper.
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
  SubtaskDependencyRecord,
  SubtaskId,
  SubtaskRecord,
  SubtaskStore,
  SubtaskUpdate,
  TaskId,
  WorkTaskLinkRecord,
  WorkTaskRecord,
  WorkTaskStore,
  WorkTaskUpdate
} from "@drydock/contracts";
import { RandomIdGenerator, type Clock } from "@drydock/core";
import { SubtaskService } from "./subtaskService.js";

function harness(): { service: SubtaskService; subtasks: MemorySubtaskStore; tasks: MemoryWorkTaskStore; columns: MemoryBoardColumnStore } {
  const subtasks = new MemorySubtaskStore();
  const tasks = new MemoryWorkTaskStore();
  const columns = new MemoryBoardColumnStore();
  const service = new SubtaskService({ ids: new RandomIdGenerator(), clock: fixedClock(), store: subtasks, tasks, columns });
  return { service, subtasks, tasks, columns };
}

function fixedClock(): Clock {
  return {
    now: () => new Date("2026-07-03T00:00:00.000Z"),
    isoNow: () => "2026-07-03T00:00:00.000Z"
  };
}

test("createSubtask defaults to the first backlog column and rejects a blank title", async () => {
  const { service, tasks } = harness();
  await tasks.insertTask(task("task-1"));

  const created = await service.createSubtask("task-1", { title: "Do the thing" });
  assert.equal(created.columnId, "col-backlog");
  assert.equal(created.origin, "manual");

  await assert.rejects(() => service.createSubtask("task-1", { title: "  " }), /must not be empty/);
  await assert.rejects(() => service.createSubtask("task-missing", { title: "X" }), /was not found/);
});

test("updateSubtask clears description/prompt with empty string", async () => {
  const { service, tasks } = harness();
  await tasks.insertTask(task("task-1"));
  const created = await service.createSubtask("task-1", { title: "T", description: "d", prompt: "p" });

  const updated = await service.updateSubtask(created.subtaskId, { description: "", prompt: "" });
  assert.equal(updated.description, undefined);
  assert.equal(updated.prompt, undefined);

  await assert.rejects(() => service.updateSubtask(created.subtaskId, {}), /at least one field/);
});

test("autoStart defaults to false on create, is settable on create, and toggles via update", async () => {
  const { service, tasks } = harness();
  await tasks.insertTask(task("task-1"));

  const plain = await service.createSubtask("task-1", { title: "Plain" });
  assert.equal(plain.autoStart, false);

  const cascade = await service.createSubtask("task-1", { title: "Cascade", autoStart: true });
  assert.equal(cascade.autoStart, true);

  // autoStart alone is a valid update in both directions.
  const enabled = await service.updateSubtask(plain.subtaskId, { autoStart: true });
  assert.equal(enabled.autoStart, true);
  const disabled = await service.updateSubtask(cascade.subtaskId, { autoStart: false });
  assert.equal(disabled.autoStart, false);
});

test("addDependency rejects self-edges, cross-task edges, duplicates, and cycles", async () => {
  const { service, tasks } = harness();
  await tasks.insertTask(task("task-1"));
  await tasks.insertTask(task("task-2"));
  const a = await service.createSubtask("task-1", { title: "A" });
  const b = await service.createSubtask("task-1", { title: "B" });
  const c = await service.createSubtask("task-1", { title: "C" });
  const other = await service.createSubtask("task-2", { title: "Other task" });

  await assert.rejects(() => service.addDependency(a.subtaskId, a.subtaskId), /SUBTASK_DEPENDENCY_SELF_EDGE/);
  await assert.rejects(() => service.addDependency(a.subtaskId, other.subtaskId), /SUBTASK_DEPENDENCY_CROSS_TASK/);

  await service.addDependency(a.subtaskId, b.subtaskId);
  await assert.rejects(() => service.addDependency(a.subtaskId, b.subtaskId), /SUBTASK_DEPENDENCY_DUPLICATE/);

  await service.addDependency(b.subtaskId, c.subtaskId);
  // c -> a would close the loop a -> b -> c -> a.
  await assert.rejects(() => service.addDependency(c.subtaskId, a.subtaskId), /SUBTASK_DEPENDENCY_CYCLE/);

  const edges = await service.listDependenciesForTask("task-1");
  assert.equal(edges.length, 2);

  await service.removeDependency(a.subtaskId, b.subtaskId);
  assert.equal((await service.listDependenciesForTask("task-1")).length, 1);
});

test("moveCard stamps doneAt entering a done column and clears it on exit, for both tasks and subtasks", async () => {
  const { service, tasks } = harness();
  await tasks.insertTask(task("task-1"));
  const subtask = await service.createSubtask("task-1", { title: "S" });

  const movedSubtask = await service.moveCard({ subtaskId: subtask.subtaskId }, "col-review") as SubtaskRecord;
  assert.equal(movedSubtask.columnId, "col-review");
  assert.equal(movedSubtask.doneAt, "2026-07-03T00:00:00.000Z");

  const movedBack = await service.moveCard({ subtaskId: subtask.subtaskId }, "col-todo") as SubtaskRecord;
  assert.equal(movedBack.doneAt, undefined);

  const movedTask = await service.moveCard({ taskId: "task-1" }, "col-finished") as WorkTaskRecord;
  assert.equal(movedTask.columnId, "col-finished");
  assert.equal(movedTask.doneAt, "2026-07-03T00:00:00.000Z");

  await assert.rejects(() => service.moveCard({ taskId: "task-1" }, "col-nonexistent"), /was not found/);
});

test("isBlocked is true iff an upstream subtask sits outside a done-category column", async () => {
  const { service, subtasks, columns } = harness();
  const upstreamNotDone = subtaskRecord("up-1", "task-1", "col-todo");
  const upstreamDone = subtaskRecord("up-2", "task-1", "col-review");
  const downstream = subtaskRecord("down-1", "task-1", "col-todo");
  await subtasks.insertSubtask(upstreamNotDone);
  await subtasks.insertSubtask(upstreamDone);
  await subtasks.insertSubtask(downstream);

  const dependencies: SubtaskDependencyRecord[] = [
    { taskId: asId<"TaskId">("task-1"), fromSubtaskId: upstreamNotDone.subtaskId, toSubtaskId: downstream.subtaskId, createdAt: "2026-07-03T00:00:00.000Z" }
  ];
  const subtasksById = new Map([upstreamNotDone, upstreamDone, downstream].map((entry) => [entry.subtaskId, entry]));
  const columnsById = new Map((await columns.listColumns()).map((column) => [column.columnId, column]));

  assert.equal(service.isBlocked(downstream.subtaskId, dependencies, subtasksById, columnsById), true);

  // Swap the dependency to point at the already-done upstream: no longer blocked.
  const doneDependencies: SubtaskDependencyRecord[] = [
    { taskId: asId<"TaskId">("task-1"), fromSubtaskId: upstreamDone.subtaskId, toSubtaskId: downstream.subtaskId, createdAt: "2026-07-03T00:00:00.000Z" }
  ];
  assert.equal(service.isBlocked(downstream.subtaskId, doneDependencies, subtasksById, columnsById), false);
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

function subtaskRecord(subtaskId: string, taskId: string, columnId: string): SubtaskRecord {
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
    this.columns.set(columnId, { ...existing, ...update });
    return Promise.resolve();
  }

  deleteColumn(columnId: ColumnId): Promise<void> {
    this.columns.delete(columnId);
    return Promise.resolve();
  }
}

class MemoryWorkTaskStore implements WorkTaskStore {
  private readonly tasks = new Map<TaskId, WorkTaskRecord>();

  insertTask(record: WorkTaskRecord): Promise<void> {
    this.tasks.set(record.taskId, record);
    return Promise.resolve();
  }

  updateTask(taskId: TaskId, update: WorkTaskUpdate): Promise<void> {
    const existing = this.tasks.get(taskId);
    if (existing === undefined) return Promise.resolve();
    const next: WorkTaskRecord = {
      ...existing,
      ...(update.title === undefined ? {} : { title: update.title }),
      ...(update.columnId === undefined ? {} : { columnId: update.columnId }),
      updatedAt: update.updatedAt
    };
    if (update.doneAt !== undefined) {
      if (update.doneAt === null) {
        delete (next as { doneAt?: string }).doneAt;
      } else {
        (next as { doneAt?: string }).doneAt = update.doneAt;
      }
    }
    this.tasks.set(taskId, next);
    return Promise.resolve();
  }

  getTask(taskId: TaskId): Promise<WorkTaskRecord | null> {
    return Promise.resolve(this.tasks.get(taskId) ?? null);
  }

  listTasks(): Promise<WorkTaskRecord[]> {
    return Promise.resolve([...this.tasks.values()]);
  }

  deleteTask(taskId: TaskId): Promise<void> {
    this.tasks.delete(taskId);
    return Promise.resolve();
  }

  insertLink(): Promise<void> {
    return Promise.resolve();
  }

  deleteLink(): Promise<void> {
    return Promise.resolve();
  }

  listLinks(): Promise<WorkTaskLinkRecord[]> {
    return Promise.resolve([]);
  }

  listSessionIdsBySubtask(): Promise<SessionId[]> {
    return Promise.resolve([]);
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
    const next: SubtaskRecord = {
      ...existing,
      ...(update.title === undefined ? {} : { title: update.title }),
      ...(update.autoStart === undefined ? {} : { autoStart: update.autoStart }),
      ...(update.columnId === undefined ? {} : { columnId: update.columnId }),
      ...(update.sortOrder === undefined ? {} : { sortOrder: update.sortOrder }),
      updatedAt: update.updatedAt
    };
    if (update.description !== undefined) {
      if (update.description === null) {
        delete (next as { description?: string }).description;
      } else {
        (next as { description?: string }).description = update.description;
      }
    }
    if (update.prompt !== undefined) {
      if (update.prompt === null) {
        delete (next as { prompt?: string }).prompt;
      } else {
        (next as { prompt?: string }).prompt = update.prompt;
      }
    }
    if (update.doneAt !== undefined) {
      if (update.doneAt === null) {
        delete (next as { doneAt?: string }).doneAt;
      } else {
        (next as { doneAt?: string }).doneAt = update.doneAt;
      }
    }
    this.subtasks.set(subtaskId, next);
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
