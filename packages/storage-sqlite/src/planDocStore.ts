/**
 * SQLite-backed plan-document store (chat-panel redesign, Phase 2 — plan mode v2).
 *
 * Plan documents are the Markdown/mermaid files an agent writes into its
 * workspace `plan/` directory; the host collects them after each plan-mode turn
 * into text rows keyed by (session_id, name). Revision logic lives in the app
 * service — this store just upserts what it is handed and reads back in name
 * order for a stable review-panel nav.
 */

import type {
  PlanDocFormat,
  PlanDocRecord,
  PlanDocStore,
  SessionId
} from "@drydock/contracts";
import type { SqliteConnection } from "./sqliteConnection.js";

export class SqlitePlanDocStore implements PlanDocStore {
  constructor(private readonly connection: SqliteConnection) {}

  async upsertDoc(record: PlanDocRecord): Promise<void> {
    // INSERT OR REPLACE keys on the (session_id, name) primary key; the caller
    // owns revision numbering, so the row is written verbatim.
    this.connection.database.prepare(`
      INSERT OR REPLACE INTO plan_docs (
        session_id,
        name,
        format,
        content,
        revision,
        collected_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      record.sessionId,
      record.name,
      record.format,
      record.content,
      record.revision,
      record.collectedAt
    );
  }

  async getDoc(sessionId: SessionId, name: string): Promise<PlanDocRecord | null> {
    const row = this.connection.database.prepare(`
      SELECT * FROM plan_docs WHERE session_id = ? AND name = ?
    `).get(sessionId, name) as PlanDocRow | undefined;
    return row ? mapDoc(row) : null;
  }

  async listDocs(sessionId: SessionId): Promise<PlanDocRecord[]> {
    const rows = this.connection.database.prepare(`
      SELECT * FROM plan_docs WHERE session_id = ? ORDER BY name
    `).all(sessionId) as unknown as PlanDocRow[];
    return rows.map(mapDoc);
  }

  async deleteSessionDocs(sessionId: SessionId): Promise<number> {
    const result = this.connection.database.prepare(`
      DELETE FROM plan_docs WHERE session_id = ?
    `).run(sessionId);
    return Number(result.changes);
  }
}

interface PlanDocRow {
  readonly session_id: string;
  readonly name: string;
  readonly format: PlanDocFormat;
  readonly content: string;
  readonly revision: number;
  readonly collected_at: string;
}

function mapDoc(row: PlanDocRow): PlanDocRecord {
  return {
    sessionId: row.session_id as SessionId,
    name: row.name,
    format: row.format,
    content: row.content,
    revision: row.revision,
    collectedAt: row.collected_at
  };
}
