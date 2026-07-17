/**
 * SQLite-backed task-changeset store (chain changesets, ADR 0014).
 *
 * One row per (subtask, repo) - `replaceForSubtask` swaps a subtask's whole
 * capture set atomically, so the table always holds only the LATEST capture
 * per subtask. Patch bytes never live here: rows carry the sha256 of a blob
 * in the content-addressed store (the planner_artifacts pattern).
 */

import type { SessionId, SubtaskId, TaskChangesetRecord, TaskChangesetStore, TaskId } from "@drydock/contracts";
import type { SqliteConnection } from "./sqliteConnection.js";

export class SqliteTaskChangesetStore implements TaskChangesetStore {
  constructor(private readonly connection: SqliteConnection) {}

  async replaceForSubtask(subtaskId: SubtaskId, records: readonly TaskChangesetRecord[]): Promise<void> {
    const db = this.connection.database;
    db.exec("BEGIN");
    try {
      db.prepare(`
        DELETE FROM task_changesets
        WHERE subtask_id = ?
      `).run(subtaskId);
      const insert = db.prepare(`
        INSERT INTO task_changesets (
          changeset_id,
          task_id,
          subtask_id,
          session_id,
          repo_name,
          patch_sha256,
          patch_bytes,
          file_count,
          paths_json,
          captured_at,
          landed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const record of records) {
        insert.run(
          record.changesetId,
          record.taskId,
          record.subtaskId,
          record.sessionId,
          record.repoName,
          record.patchSha256,
          record.patchBytes,
          record.fileCount,
          record.paths === undefined ? null : JSON.stringify(record.paths),
          record.capturedAt,
          record.landedAt ?? null
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  async listForSubtasks(subtaskIds: readonly SubtaskId[]): Promise<TaskChangesetRecord[]> {
    if (subtaskIds.length === 0) return [];
    const placeholders = subtaskIds.map(() => "?").join(", ");
    const rows = this.connection.database.prepare(`
      SELECT *
      FROM task_changesets
      WHERE subtask_id IN (${placeholders})
      ORDER BY captured_at ASC, rowid ASC
    `).all(...subtaskIds) as unknown as ChangesetRow[];
    return rows.map(mapChangeset);
  }

  async listUnlandedSubtaskIds(subtaskIds: readonly SubtaskId[]): Promise<SubtaskId[]> {
    if (subtaskIds.length === 0) return [];
    const placeholders = subtaskIds.map(() => "?").join(", ");
    const rows = this.connection.database.prepare(`
      SELECT DISTINCT subtask_id
      FROM task_changesets
      WHERE landed_at IS NULL AND subtask_id IN (${placeholders})
    `).all(...subtaskIds) as unknown as { readonly subtask_id: string }[];
    return rows.map((row) => row.subtask_id as SubtaskId);
  }

  async listUnlanded(): Promise<TaskChangesetRecord[]> {
    const rows = this.connection.database.prepare(`
      SELECT *
      FROM task_changesets
      WHERE landed_at IS NULL
      ORDER BY captured_at ASC, rowid ASC
    `).all() as unknown as ChangesetRow[];
    return rows.map(mapChangeset);
  }

  async markLandedBySession(sessionId: SessionId, landedAt: string, repoName?: string): Promise<number> {
    const result = repoName === undefined
      ? this.connection.database.prepare(`
          UPDATE task_changesets
          SET landed_at = ?
          WHERE session_id = ? AND landed_at IS NULL
        `).run(landedAt, sessionId)
      : this.connection.database.prepare(`
          UPDATE task_changesets
          SET landed_at = ?
          WHERE session_id = ? AND repo_name = ? AND landed_at IS NULL
        `).run(landedAt, sessionId, repoName);
    return Number(result.changes);
  }

  async deleteForSubtask(subtaskId: SubtaskId): Promise<number> {
    const result = this.connection.database.prepare(`
      DELETE FROM task_changesets
      WHERE subtask_id = ?
    `).run(subtaskId);
    return Number(result.changes);
  }
}

interface ChangesetRow {
  readonly changeset_id: string;
  readonly task_id: string;
  readonly subtask_id: string;
  readonly session_id: string;
  readonly repo_name: string;
  readonly patch_sha256: string;
  readonly patch_bytes: number;
  readonly file_count: number;
  readonly paths_json: string | null;
  readonly captured_at: string;
  readonly landed_at: string | null;
}

function mapChangeset(row: ChangesetRow): TaskChangesetRecord {
  return {
    changesetId: row.changeset_id,
    taskId: row.task_id as TaskId,
    subtaskId: row.subtask_id as SubtaskId,
    sessionId: row.session_id as SessionId,
    repoName: row.repo_name,
    patchSha256: row.patch_sha256,
    patchBytes: row.patch_bytes,
    fileCount: row.file_count,
    ...(parsePaths(row.paths_json) ?? {}),
    capturedAt: row.captured_at,
    ...(row.landed_at === null ? {} : { landedAt: row.landed_at })
  };
}

/** Validated path list from the JSON column; junk degrades to absent (= overlap unknown). */
function parsePaths(json: string | null): { paths: readonly string[] } | null {
  if (json === null) return null;
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return null;
    return { paths: value.filter((entry): entry is string => typeof entry === "string") };
  } catch {
    return null;
  }
}
