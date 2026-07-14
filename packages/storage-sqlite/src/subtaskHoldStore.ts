/**
 * SQLite-backed orchestrator hold store (ADR 0015): queued/parked starts
 * that must survive a window reload. One row per subtask — an upsert
 * replaces the prior hold (a park supersedes a queue entry).
 */

import type { SubtaskHoldRecord, SubtaskHoldStore, SubtaskId } from "@drydock/contracts";
import type { SqliteConnection } from "./sqliteConnection.js";

export class SqliteSubtaskHoldStore implements SubtaskHoldStore {
  constructor(private readonly connection: SqliteConnection) {}

  async upsertHold(record: SubtaskHoldRecord): Promise<void> {
    this.connection.database.prepare(`
      INSERT INTO subtask_holds (subtask_id, kind, origin, force, held_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(subtask_id) DO UPDATE SET
        kind = excluded.kind,
        origin = excluded.origin,
        force = excluded.force,
        held_at = excluded.held_at
    `).run(record.subtaskId, record.kind, record.origin, record.force ? 1 : 0, record.heldAt);
  }

  async deleteHold(subtaskId: SubtaskId): Promise<number> {
    const result = this.connection.database.prepare(`
      DELETE FROM subtask_holds
      WHERE subtask_id = ?
    `).run(subtaskId);
    return Number(result.changes);
  }

  async listHolds(): Promise<SubtaskHoldRecord[]> {
    const rows = this.connection.database.prepare(`
      SELECT *
      FROM subtask_holds
      ORDER BY held_at ASC, rowid ASC
    `).all() as unknown as HoldRow[];
    return rows
      .filter((row) => row.kind === "queued" || row.kind === "parked")
      .map((row) => ({
        subtaskId: row.subtask_id as SubtaskId,
        kind: row.kind as "queued" | "parked",
        origin: row.origin === "manual" ? "manual" : "auto",
        force: row.force !== 0,
        heldAt: row.held_at
      }));
  }
}

interface HoldRow {
  readonly subtask_id: string;
  readonly kind: string;
  readonly origin: string;
  readonly force: number;
  readonly held_at: string;
}
