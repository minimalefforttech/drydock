/**
 * SQLite-backed durable work-task store.
 *
 * Internal work tasks and their links to workspace sets and chat sessions
 * outlive the extension host so the panel can list and reopen them after
 * restarts. Persistence mechanics live here; lifecycle and policy stay in
 * TaskService.
 */

import type {
  ColumnId,
  SessionId,
  SubtaskId,
  TaskClonePolicy,
  TaskId,
  WorkTaskLinkRecord,
  WorkTaskRecord,
  WorkTaskState,
  WorkTaskStore,
  WorkTaskUpdate,
  WorkspaceSetId
} from "@drydock/contracts";
import type { SqliteConnection } from "./sqliteConnection.js";

export class SqliteWorkTaskStore implements WorkTaskStore {
  constructor(private readonly connection: SqliteConnection) {}

  async insertTask(record: WorkTaskRecord): Promise<void> {
    this.connection.database.prepare(`
      INSERT INTO work_tasks (
        task_id,
        title,
        description,
        state,
        column_id,
        created_at,
        updated_at,
        done_at,
        clone_workspace_set_id,
        clone_project_ids_json,
        clone_dirty_handling
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.taskId,
      record.title,
      record.description ?? null,
      record.state,
      record.columnId,
      record.createdAt,
      record.updatedAt,
      record.doneAt ?? null,
      record.clonePolicy?.workspaceSetId ?? null,
      record.clonePolicy === undefined ? null : JSON.stringify(record.clonePolicy.projectIds),
      record.clonePolicy?.dirtyHandling ?? null
    );
  }

  async updateTask(taskId: TaskId, update: WorkTaskUpdate): Promise<void> {
    // Only the provided fields are written so partial updates never clobber a
    // column set by another code path.
    const assignments: string[] = ["updated_at = ?"];
    const values: (string | null)[] = [update.updatedAt];
    if (update.title !== undefined) {
      assignments.push("title = ?");
      values.push(update.title);
    }
    if (update.description !== undefined) {
      // null clears the description column to NULL; a string overwrites it.
      assignments.push("description = ?");
      values.push(update.description);
    }
    if (update.state !== undefined) {
      assignments.push("state = ?");
      values.push(update.state);
    }
    if (update.columnId !== undefined) {
      assignments.push("column_id = ?");
      values.push(update.columnId);
    }
    if (update.doneAt !== undefined) {
      // null clears doneAt; a string stamps it.
      assignments.push("done_at = ?");
      values.push(update.doneAt);
    }
    this.connection.database.prepare(`
      UPDATE work_tasks
      SET ${assignments.join(", ")}
      WHERE task_id = ?
    `).run(...values, taskId);
  }

  async getTask(taskId: TaskId): Promise<WorkTaskRecord | null> {
    const row = this.connection.database.prepare(`
      SELECT *
      FROM work_tasks
      WHERE task_id = ?
    `).get(taskId) as WorkTaskRow | undefined;
    return row ? mapTask(row) : null;
  }

  async listTasks(): Promise<WorkTaskRecord[]> {
    // Newest-first by updated_at; same-timestamp writes fall back to insertion
    // order (rowid) so the listing stays deterministic.
    const rows = this.connection.database.prepare(`
      SELECT *
      FROM work_tasks
      ORDER BY updated_at DESC, rowid DESC
    `).all() as unknown as WorkTaskRow[];
    return rows.map(mapTask);
  }

  async setClonePolicy(taskId: TaskId, policy: TaskClonePolicy | undefined): Promise<void> {
    this.connection.database.prepare(`
      UPDATE work_tasks
      SET clone_workspace_set_id = ?, clone_project_ids_json = ?, clone_dirty_handling = ?
      WHERE task_id = ?
    `).run(
      policy?.workspaceSetId ?? null,
      policy === undefined ? null : JSON.stringify(policy.projectIds),
      policy?.dirtyHandling ?? null,
      taskId
    );
  }

  async deleteTask(taskId: TaskId): Promise<void> {
    // Links first, then the task row, so no orphaned links survive.
    this.connection.database.prepare(`
      DELETE FROM work_task_links
      WHERE task_id = ?
    `).run(taskId);
    this.connection.database.prepare(`
      DELETE FROM work_tasks
      WHERE task_id = ?
    `).run(taskId);
  }

  async insertLink(record: WorkTaskLinkRecord): Promise<void> {
    // INSERT OR IGNORE relies on the COALESCE unique index over (task_id,
    // workspace_set_id, session_id) to make duplicate links a no-op.
    // subtask_id is only meaningful alongside session_id (session-target
    // links); it rides along on the same row rather than a separate index.
    this.connection.database.prepare(`
      INSERT OR IGNORE INTO work_task_links (
        task_id,
        workspace_set_id,
        session_id,
        subtask_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      record.taskId,
      record.workspaceSetId ?? null,
      record.sessionId ?? null,
      record.subtaskId ?? null,
      record.createdAt
    );
  }

  async deleteLink(taskId: TaskId, target: { workspaceSetId?: WorkspaceSetId; sessionId?: SessionId }): Promise<void> {
    // Delete by task_id plus whichever target field is present.
    if (target.workspaceSetId !== undefined) {
      this.connection.database.prepare(`
        DELETE FROM work_task_links
        WHERE task_id = ? AND workspace_set_id = ?
      `).run(taskId, target.workspaceSetId);
      return;
    }
    if (target.sessionId !== undefined) {
      this.connection.database.prepare(`
        DELETE FROM work_task_links
        WHERE task_id = ? AND session_id = ?
      `).run(taskId, target.sessionId);
    }
  }

  async listLinks(taskId?: TaskId): Promise<WorkTaskLinkRecord[]> {
    const rows = taskId === undefined
      ? this.connection.database.prepare(`
          SELECT *
          FROM work_task_links
          ORDER BY rowid ASC
        `).all() as unknown as WorkTaskLinkRow[]
      : this.connection.database.prepare(`
          SELECT *
          FROM work_task_links
          WHERE task_id = ?
          ORDER BY rowid ASC
        `).all(taskId) as unknown as WorkTaskLinkRow[];
    return rows.map(mapLink);
  }

  async listSessionIdsBySubtask(subtaskId: SubtaskId): Promise<SessionId[]> {
    const rows = this.connection.database.prepare(`
      SELECT session_id
      FROM work_task_links
      WHERE subtask_id = ? AND session_id IS NOT NULL
      ORDER BY rowid ASC
    `).all(subtaskId) as unknown as { readonly session_id: string }[];
    return rows.map((row) => row.session_id as SessionId);
  }

  async reassignTasksColumn(fromColumnId: ColumnId, toColumnId: ColumnId): Promise<void> {
    this.connection.database.prepare(`
      UPDATE work_tasks
      SET column_id = ?
      WHERE column_id = ?
    `).run(toColumnId, fromColumnId);
  }
}

interface WorkTaskRow {
  readonly task_id: string;
  readonly title: string;
  readonly description: string | null;
  readonly state: WorkTaskState;
  readonly column_id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly done_at: string | null;
  readonly clone_workspace_set_id: string | null;
  readonly clone_project_ids_json: string | null;
  readonly clone_dirty_handling: string | null;
}

interface WorkTaskLinkRow {
  readonly task_id: string;
  readonly workspace_set_id: string | null;
  readonly session_id: string | null;
  readonly subtask_id: string | null;
  readonly created_at: string;
}

function mapTask(row: WorkTaskRow): WorkTaskRecord {
  const clonePolicy = mapClonePolicy(row);
  return {
    taskId: row.task_id as TaskId,
    title: row.title,
    ...(row.description === null ? {} : { description: row.description }),
    state: row.state,
    columnId: row.column_id as ColumnId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.done_at === null ? {} : { doneAt: row.done_at }),
    ...(clonePolicy === undefined ? {} : { clonePolicy })
  };
}

function mapClonePolicy(row: WorkTaskRow): TaskClonePolicy | undefined {
  if (row.clone_workspace_set_id === null || row.clone_project_ids_json === null) {
    return undefined;
  }
  if (row.clone_dirty_handling !== "carry" && row.clone_dirty_handling !== "fresh") {
    return undefined;
  }
  try {
    const projectIds: unknown = JSON.parse(row.clone_project_ids_json);
    if (!Array.isArray(projectIds) || projectIds.length === 0 || projectIds.some((id) => typeof id !== "string")) {
      return undefined;
    }
    return {
      workspaceSetId: row.clone_workspace_set_id as WorkspaceSetId,
      projectIds: projectIds as TaskClonePolicy["projectIds"],
      dirtyHandling: row.clone_dirty_handling
    };
  } catch {
    // Corrupt/partial legacy data degrades to "no policy" and is replaced by
    // the next manual start rather than crashing every task listing.
    return undefined;
  }
}

function mapLink(row: WorkTaskLinkRow): WorkTaskLinkRecord {
  return {
    taskId: row.task_id as TaskId,
    ...(row.workspace_set_id === null ? {} : { workspaceSetId: row.workspace_set_id as WorkspaceSetId }),
    ...(row.session_id === null ? {} : { sessionId: row.session_id as SessionId }),
    ...(row.subtask_id === null ? {} : { subtaskId: row.subtask_id as SubtaskId }),
    createdAt: row.created_at
  };
}
