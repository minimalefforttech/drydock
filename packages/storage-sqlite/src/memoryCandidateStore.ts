/**
 * SQLite-backed durable memory-candidate store.
 *
 * Agents propose durable insights via a memory-candidate fenced block; each
 * parsed note lands here as a pending candidate, inert until a human approves
 * it. Persistence mechanics live here; capture/resolve policy stays in
 * MemoryService.
 */

import type {
  MemoryCandidateId,
  MemoryCandidateRecord,
  MemoryCandidateStatus,
  MemoryCandidateStore,
  SessionId
} from "@drydock/contracts";
import type { SqliteConnection } from "./sqliteConnection.js";

export class SqliteMemoryCandidateStore implements MemoryCandidateStore {
  constructor(private readonly connection: SqliteConnection) {}

  async insertCandidate(record: MemoryCandidateRecord): Promise<void> {
    this.connection.database.prepare(`
      INSERT INTO memory_candidates (
        memory_candidate_id,
        session_id,
        content,
        status,
        created_at,
        resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      record.memoryCandidateId,
      record.sessionId,
      record.content,
      record.status,
      record.createdAt,
      record.resolvedAt ?? null
    );
  }

  async getCandidate(memoryCandidateId: MemoryCandidateId): Promise<MemoryCandidateRecord | null> {
    const row = this.connection.database.prepare(`
      SELECT *
      FROM memory_candidates
      WHERE memory_candidate_id = ?
    `).get(memoryCandidateId) as MemoryCandidateRow | undefined;
    return row ? mapCandidate(row) : null;
  }

  async listCandidates(status?: MemoryCandidateStatus): Promise<MemoryCandidateRecord[]> {
    // Newest-first by created_at; same-timestamp writes fall back to insertion
    // order (rowid) so the listing stays deterministic.
    const rows = status === undefined
      ? this.connection.database.prepare(`
          SELECT *
          FROM memory_candidates
          ORDER BY created_at DESC, rowid DESC
        `).all() as unknown as MemoryCandidateRow[]
      : this.connection.database.prepare(`
          SELECT *
          FROM memory_candidates
          WHERE status = ?
          ORDER BY created_at DESC, rowid DESC
        `).all(status) as unknown as MemoryCandidateRow[];
    return rows.map(mapCandidate);
  }

  async updateCandidateStatus(memoryCandidateId: MemoryCandidateId, status: MemoryCandidateStatus, resolvedAt: string): Promise<void> {
    this.connection.database.prepare(`
      UPDATE memory_candidates
      SET status = ?, resolved_at = ?
      WHERE memory_candidate_id = ?
    `).run(status, resolvedAt, memoryCandidateId);
  }
}

interface MemoryCandidateRow {
  readonly memory_candidate_id: string;
  readonly session_id: string;
  readonly content: string;
  readonly status: MemoryCandidateStatus;
  readonly created_at: string;
  readonly resolved_at: string | null;
}

function mapCandidate(row: MemoryCandidateRow): MemoryCandidateRecord {
  return {
    memoryCandidateId: row.memory_candidate_id as MemoryCandidateId,
    sessionId: row.session_id as SessionId,
    content: row.content,
    status: row.status,
    createdAt: row.created_at,
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at })
  };
}
