/**
 * SQLite-backed durable memory store.
 *
 * Agents propose durable insights via a memory-candidate fenced block; each
 * parsed note lands here as a pending candidate, inert until a human approves
 * it. User quick-add entries land already approved. Scope (global/workspace/
 * task), tag selectors, and origin are additive columns - legacy NULL rows
 * read back as global agent memory. Persistence mechanics live here;
 * capture/resolve policy stays in MemoryService.
 */

import type {
  MemoryCandidateEdits,
  MemoryCandidateId,
  MemoryCandidateRecord,
  MemoryCandidateStatus,
  MemoryCandidateStore,
  MemoryOrigin,
  MemoryScope,
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
        resolved_at,
        scope,
        scope_task_id,
        scope_roots_json,
        tags_json,
        origin
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.memoryCandidateId,
      record.sessionId,
      record.content,
      record.status,
      record.createdAt,
      record.resolvedAt ?? null,
      record.scope ?? null,
      record.scopeTaskId ?? null,
      record.scopeRoots === undefined ? null : JSON.stringify(record.scopeRoots),
      record.tags === undefined ? null : JSON.stringify(record.tags),
      record.origin ?? null
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

  async updateCandidateContent(memoryCandidateId: MemoryCandidateId, edits: MemoryCandidateEdits): Promise<void> {
    const existing = await this.getCandidate(memoryCandidateId);
    if (existing === null) return;
    this.connection.database.prepare(`
      UPDATE memory_candidates
      SET content = ?, scope = ?, scope_task_id = ?, scope_roots_json = ?, tags_json = ?
      WHERE memory_candidate_id = ?
    `).run(
      edits.content ?? existing.content,
      (edits.scope ?? existing.scope) ?? null,
      (edits.scope !== undefined ? edits.scopeTaskId : (edits.scopeTaskId ?? existing.scopeTaskId)) ?? null,
      serializeOrKeep(edits.scope !== undefined ? edits.scopeRoots : (edits.scopeRoots ?? existing.scopeRoots)),
      serializeOrKeep(edits.tags ?? existing.tags),
      memoryCandidateId
    );
  }

  async deleteCandidate(memoryCandidateId: MemoryCandidateId): Promise<void> {
    this.connection.database.prepare(`
      DELETE FROM memory_candidates
      WHERE memory_candidate_id = ?
    `).run(memoryCandidateId);
  }
}

function serializeOrKeep(values: readonly string[] | undefined): string | null {
  return values === undefined || values.length === 0 ? null : JSON.stringify(values);
}

interface MemoryCandidateRow {
  readonly memory_candidate_id: string;
  readonly session_id: string;
  readonly content: string;
  readonly status: MemoryCandidateStatus;
  readonly created_at: string;
  readonly resolved_at: string | null;
  readonly scope: string | null;
  readonly scope_task_id: string | null;
  readonly scope_roots_json: string | null;
  readonly tags_json: string | null;
  readonly origin: string | null;
}

function parseStringArray(json: string | null): string[] | undefined {
  if (json === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return undefined;
    const values = parsed.filter((value): value is string => typeof value === "string");
    return values.length === 0 ? undefined : values;
  } catch {
    return undefined;
  }
}

function mapCandidate(row: MemoryCandidateRow): MemoryCandidateRecord {
  const scope = row.scope === "global" || row.scope === "workspace" || row.scope === "task"
    ? (row.scope as MemoryScope)
    : undefined;
  const origin = row.origin === "user" || row.origin === "agent" ? (row.origin as MemoryOrigin) : undefined;
  const scopeRoots = parseStringArray(row.scope_roots_json);
  const tags = parseStringArray(row.tags_json);
  return {
    memoryCandidateId: row.memory_candidate_id as MemoryCandidateId,
    sessionId: row.session_id as SessionId,
    content: row.content,
    status: row.status,
    createdAt: row.created_at,
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
    ...(scope === undefined ? {} : { scope }),
    ...(row.scope_task_id === null ? {} : { scopeTaskId: row.scope_task_id }),
    ...(scopeRoots === undefined ? {} : { scopeRoots }),
    ...(tags === undefined ? {} : { tags }),
    ...(origin === undefined ? {} : { origin })
  };
}
