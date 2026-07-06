/**
 * SQLite-backed durable work-session store.
 *
 * A work session is one (task, session) pairing: created the first time a
 * linked session completes a turn, then touched on every subsequent turn. The
 * (task_id, session_id) primary key makes upsert an INSERT OR REPLACE.
 * Persistence mechanics live here; the touch/aggregate policy stays in
 * TaskService.
 */

import type {
  SessionId,
  TaskId,
  WorkSessionRecord,
  WorkSessionStore,
  WorkspaceSetId
} from "@drydock/contracts";
import type { SqliteConnection } from "./sqliteConnection.js";

export class SqliteWorkSessionStore implements WorkSessionStore {
  constructor(private readonly connection: SqliteConnection) {}

  async upsertWorkSession(record: WorkSessionRecord): Promise<void> {
    // INSERT OR REPLACE keyed on (task_id, session_id); the caller carries the
    // preserved startedAt and bumped turnCount, so the replace is complete.
    this.connection.database.prepare(`
      INSERT OR REPLACE INTO work_sessions (
        task_id,
        session_id,
        workspace_set_id,
        started_at,
        last_activity_at,
        turn_count
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      record.taskId,
      record.sessionId,
      record.workspaceSetId ?? null,
      record.startedAt,
      record.lastActivityAt,
      record.turnCount
    );
  }

  async getWorkSession(taskId: TaskId, sessionId: SessionId): Promise<WorkSessionRecord | null> {
    const row = this.connection.database.prepare(`
      SELECT *
      FROM work_sessions
      WHERE task_id = ? AND session_id = ?
    `).get(taskId, sessionId) as WorkSessionRow | undefined;
    return row ? mapWorkSession(row) : null;
  }

  async listWorkSessions(filter?: { taskId?: TaskId; workspaceSetId?: WorkspaceSetId }): Promise<WorkSessionRecord[]> {
    const clauses: string[] = [];
    const values: string[] = [];
    if (filter?.taskId !== undefined) {
      clauses.push("task_id = ?");
      values.push(filter.taskId);
    }
    if (filter?.workspaceSetId !== undefined) {
      clauses.push("workspace_set_id = ?");
      values.push(filter.workspaceSetId);
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    // Newest activity first; same-timestamp writes fall back to insertion order
    // (rowid) so the listing stays deterministic.
    const rows = this.connection.database.prepare(`
      SELECT *
      FROM work_sessions
      ${where}
      ORDER BY last_activity_at DESC, rowid DESC
    `).all(...values) as unknown as WorkSessionRow[];
    return rows.map(mapWorkSession);
  }

  async deleteForTask(taskId: TaskId): Promise<number> {
    const result = this.connection.database.prepare(`
      DELETE FROM work_sessions
      WHERE task_id = ?
    `).run(taskId);
    return Number(result.changes);
  }

  async deleteForSession(sessionId: SessionId): Promise<number> {
    const result = this.connection.database.prepare(`
      DELETE FROM work_sessions
      WHERE session_id = ?
    `).run(sessionId);
    return Number(result.changes);
  }
}

interface WorkSessionRow {
  readonly task_id: string;
  readonly session_id: string;
  readonly workspace_set_id: string | null;
  readonly started_at: string;
  readonly last_activity_at: string;
  readonly turn_count: number;
}

function mapWorkSession(row: WorkSessionRow): WorkSessionRecord {
  return {
    taskId: row.task_id as TaskId,
    sessionId: row.session_id as SessionId,
    ...(row.workspace_set_id === null ? {} : { workspaceSetId: row.workspace_set_id as WorkspaceSetId }),
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
    turnCount: row.turn_count
  };
}
