/**
 * SQLite-backed subtask store.
 *
 * Subtasks are child work items of exactly one task; dependencies are
 * directed edges between two subtasks of that same task. Persistence
 * mechanics live here; dependency validation (same-task, acyclic) and card
 * movement policy live in the work-management services.
 */

import type {
  ColumnId,
  SubtaskDependencyRecord,
  SubtaskId,
  SubtaskRecord,
  SubtaskStore,
  SubtaskUpdate,
  TaskId
} from "@drydock/contracts";
import type { SqliteConnection } from "./sqliteConnection.js";

export class SqliteSubtaskStore implements SubtaskStore {
  constructor(private readonly connection: SqliteConnection) {}

  async insertSubtask(record: SubtaskRecord): Promise<void> {
    this.connection.database.prepare(`
      INSERT INTO subtasks (
        subtask_id,
        task_id,
        title,
        description,
        prompt,
        origin,
        auto_start,
        column_id,
        sort_order,
        created_at,
        updated_at,
        done_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.subtaskId,
      record.taskId,
      record.title,
      record.description ?? null,
      record.prompt ?? null,
      record.origin,
      record.autoStart ? 1 : 0,
      record.columnId,
      record.sortOrder,
      record.createdAt,
      record.updatedAt,
      record.doneAt ?? null
    );
  }

  async updateSubtask(subtaskId: SubtaskId, update: SubtaskUpdate): Promise<void> {
    // Only the provided fields are written so partial updates never clobber a
    // column set by another code path.
    const assignments: string[] = ["updated_at = ?"];
    const values: (string | number | null)[] = [update.updatedAt];
    if (update.title !== undefined) {
      assignments.push("title = ?");
      values.push(update.title);
    }
    if (update.description !== undefined) {
      // null clears the description column to NULL; a string overwrites it.
      assignments.push("description = ?");
      values.push(update.description);
    }
    if (update.prompt !== undefined) {
      // null clears the prompt column to NULL; a string overwrites it.
      assignments.push("prompt = ?");
      values.push(update.prompt);
    }
    if (update.autoStart !== undefined) {
      assignments.push("auto_start = ?");
      values.push(update.autoStart ? 1 : 0);
    }
    if (update.columnId !== undefined) {
      assignments.push("column_id = ?");
      values.push(update.columnId);
    }
    if (update.sortOrder !== undefined) {
      assignments.push("sort_order = ?");
      values.push(update.sortOrder);
    }
    if (update.doneAt !== undefined) {
      // null clears doneAt; a string stamps it.
      assignments.push("done_at = ?");
      values.push(update.doneAt);
    }
    this.connection.database.prepare(`
      UPDATE subtasks
      SET ${assignments.join(", ")}
      WHERE subtask_id = ?
    `).run(...values, subtaskId);
  }

  async getSubtask(subtaskId: SubtaskId): Promise<SubtaskRecord | null> {
    const row = this.connection.database.prepare(`
      SELECT *
      FROM subtasks
      WHERE subtask_id = ?
    `).get(subtaskId) as SubtaskRow | undefined;
    return row ? mapSubtask(row) : null;
  }

  async listForTask(taskId: TaskId): Promise<SubtaskRecord[]> {
    const rows = this.connection.database.prepare(`
      SELECT *
      FROM subtasks
      WHERE task_id = ?
      ORDER BY sort_order ASC, rowid ASC
    `).all(taskId) as unknown as SubtaskRow[];
    return rows.map(mapSubtask);
  }

  async listAll(): Promise<SubtaskRecord[]> {
    const rows = this.connection.database.prepare(`
      SELECT *
      FROM subtasks
      ORDER BY task_id ASC, sort_order ASC, rowid ASC
    `).all() as unknown as SubtaskRow[];
    return rows.map(mapSubtask);
  }

  async deleteSubtask(subtaskId: SubtaskId): Promise<void> {
    // Edges first, then the subtask row, so no orphaned edges survive.
    this.connection.database.prepare(`
      DELETE FROM subtask_dependencies
      WHERE from_subtask_id = ? OR to_subtask_id = ?
    `).run(subtaskId, subtaskId);
    this.connection.database.prepare(`
      DELETE FROM subtasks
      WHERE subtask_id = ?
    `).run(subtaskId);
  }

  async reassignSubtasksColumn(fromColumnId: ColumnId, toColumnId: ColumnId): Promise<void> {
    this.connection.database.prepare(`
      UPDATE subtasks
      SET column_id = ?
      WHERE column_id = ?
    `).run(toColumnId, fromColumnId);
  }

  async insertDependency(record: SubtaskDependencyRecord): Promise<void> {
    this.connection.database.prepare(`
      INSERT INTO subtask_dependencies (
        task_id,
        from_subtask_id,
        to_subtask_id,
        created_at
      ) VALUES (?, ?, ?, ?)
    `).run(
      record.taskId,
      record.fromSubtaskId,
      record.toSubtaskId,
      record.createdAt
    );
  }

  async removeDependency(fromSubtaskId: SubtaskId, toSubtaskId: SubtaskId): Promise<void> {
    this.connection.database.prepare(`
      DELETE FROM subtask_dependencies
      WHERE from_subtask_id = ? AND to_subtask_id = ?
    `).run(fromSubtaskId, toSubtaskId);
  }

  async listDependenciesForTask(taskId: TaskId): Promise<SubtaskDependencyRecord[]> {
    const rows = this.connection.database.prepare(`
      SELECT *
      FROM subtask_dependencies
      WHERE task_id = ?
      ORDER BY rowid ASC
    `).all(taskId) as unknown as SubtaskDependencyRow[];
    return rows.map(mapDependency);
  }
}

interface SubtaskRow {
  readonly subtask_id: string;
  readonly task_id: string;
  readonly title: string;
  readonly description: string | null;
  readonly prompt: string | null;
  readonly origin: "manual" | "review";
  readonly auto_start: number;
  readonly column_id: string;
  readonly sort_order: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly done_at: string | null;
}

interface SubtaskDependencyRow {
  readonly task_id: string;
  readonly from_subtask_id: string;
  readonly to_subtask_id: string;
  readonly created_at: string;
}

function mapSubtask(row: SubtaskRow): SubtaskRecord {
  return {
    subtaskId: row.subtask_id as SubtaskId,
    taskId: row.task_id as TaskId,
    title: row.title,
    ...(row.description === null ? {} : { description: row.description }),
    ...(row.prompt === null ? {} : { prompt: row.prompt }),
    origin: row.origin,
    autoStart: row.auto_start !== 0,
    columnId: row.column_id as ColumnId,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.done_at === null ? {} : { doneAt: row.done_at })
  };
}

function mapDependency(row: SubtaskDependencyRow): SubtaskDependencyRecord {
  return {
    taskId: row.task_id as TaskId,
    fromSubtaskId: row.from_subtask_id as SubtaskId,
    toSubtaskId: row.to_subtask_id as SubtaskId,
    createdAt: row.created_at
  };
}
