/**
 * SQLite-backed stage handoff store (plan D4): one bounded note per
 * producing subtask, upserted on completion (latest wins), read by the run
 * bridge when a dependent stage starts. Notes are small by contract - the
 * cap is enforced at parse/synthesis time, not here.
 */

import type { SubtaskHandoffRecord, SubtaskHandoffStore, SubtaskId, TaskId } from "@drydock/contracts";
import type { SqliteConnection } from "./sqliteConnection.js";

export class SqliteSubtaskHandoffStore implements SubtaskHandoffStore {
  constructor(private readonly connection: SqliteConnection) {}

  async upsertHandoff(record: SubtaskHandoffRecord): Promise<void> {
    this.connection.database.prepare(`
      INSERT INTO subtask_handoffs (subtask_id, task_id, note, source, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(subtask_id) DO UPDATE SET
        task_id = excluded.task_id,
        note = excluded.note,
        source = excluded.source,
        created_at = excluded.created_at
    `).run(record.subtaskId, record.taskId, record.note, record.source, record.createdAt);
  }

  async getHandoff(subtaskId: SubtaskId): Promise<SubtaskHandoffRecord | null> {
    const row = this.connection.database.prepare(`
      SELECT *
      FROM subtask_handoffs
      WHERE subtask_id = ?
    `).get(subtaskId) as HandoffRow | undefined;
    return row === undefined ? null : mapHandoff(row);
  }

  async listForSubtasks(subtaskIds: readonly SubtaskId[]): Promise<SubtaskHandoffRecord[]> {
    if (subtaskIds.length === 0) return [];
    const placeholders = subtaskIds.map(() => "?").join(", ");
    const rows = this.connection.database.prepare(`
      SELECT *
      FROM subtask_handoffs
      WHERE subtask_id IN (${placeholders})
    `).all(...subtaskIds) as unknown as HandoffRow[];
    // Preserve the caller's id order (upstream edge order matters to briefings).
    const byId = new Map(rows.map((row) => [row.subtask_id, row]));
    const ordered: SubtaskHandoffRecord[] = [];
    for (const id of subtaskIds) {
      const row = byId.get(id as string);
      if (row !== undefined) ordered.push(mapHandoff(row));
    }
    return ordered;
  }

  async deleteForSubtask(subtaskId: SubtaskId): Promise<number> {
    const result = this.connection.database.prepare(`
      DELETE FROM subtask_handoffs
      WHERE subtask_id = ?
    `).run(subtaskId);
    return Number(result.changes);
  }
}

interface HandoffRow {
  readonly subtask_id: string;
  readonly task_id: string;
  readonly note: string;
  readonly source: string;
  readonly created_at: string;
}

function mapHandoff(row: HandoffRow): SubtaskHandoffRecord {
  return {
    subtaskId: row.subtask_id as SubtaskId,
    taskId: row.task_id as TaskId,
    note: row.note,
    source: row.source === "agent" ? "agent" : "summary",
    createdAt: row.created_at
  };
}
