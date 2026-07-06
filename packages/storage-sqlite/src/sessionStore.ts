/**
 * SQLite-backed durable chat session store.
 *
 * Sessions outlive the extension host so the panel can list and reopen
 * transcripts after restarts (Stage 2). Persistence mechanics live here;
 * lifecycle and policy stay in ChatSessionService.
 */

import type {
  AgentRole,
  ChatId,
  ChatSessionRecord,
  ChatSessionStatus,
  ChatSessionStore,
  ChatSessionUpdate,
  RuntimeId,
  SessionId,
  SessionMode
} from "@drydock/contracts";
import type { SqliteConnection } from "./sqliteConnection.js";

const DEFAULT_LIST_LIMIT = 50;

export class SqliteChatSessionStore implements ChatSessionStore {
  constructor(private readonly connection: SqliteConnection) {}

  async insertSession(record: ChatSessionRecord): Promise<void> {
    this.connection.database.prepare(`
      INSERT INTO chat_sessions (
        session_id,
        chat_id,
        title,
        description,
        status,
        provider_id,
        model,
        transport,
        runtime_id,
        host_instance_id,
        heartbeat_at,
        mode,
        parent_session_id,
        spawned_role,
        created_at,
        updated_at,
        ended_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.sessionId,
      record.chatId,
      record.title,
      record.description ?? null,
      record.status,
      record.providerId,
      record.model ?? null,
      record.transport,
      record.runtimeId ?? null,
      record.hostInstanceId ?? null,
      record.heartbeatAt ?? null,
      record.mode ?? null,
      record.parentSessionId ?? null,
      record.spawnedRole ?? null,
      record.createdAt,
      record.updatedAt,
      record.endedAt ?? null
    );
  }

  async updateSession(sessionId: SessionId, update: ChatSessionUpdate): Promise<void> {
    // Only the provided fields are written so partial updates (e.g. a title
    // rename) never clobber status or ended_at written by another code path.
    const assignments: string[] = ["updated_at = ?"];
    const values: (string | null)[] = [update.updatedAt];
    if (update.status !== undefined) {
      assignments.push("status = ?");
      values.push(update.status);
    }
    if (update.title !== undefined) {
      assignments.push("title = ?");
      values.push(update.title);
    }
    if (update.description !== undefined) {
      // null clears the description column to NULL; a string overwrites it.
      assignments.push("description = ?");
      values.push(update.description);
    }
    if (update.providerId !== undefined) {
      assignments.push("provider_id = ?");
      values.push(update.providerId);
    }
    if (update.model !== undefined) {
      assignments.push("model = ?");
      values.push(update.model);
    }
    if (update.runtimeId !== undefined) {
      assignments.push("runtime_id = ?");
      values.push(update.runtimeId);
    }
    if (update.hostInstanceId !== undefined) {
      // null releases ownership (session ended/adopted elsewhere); a string stamps it.
      assignments.push("host_instance_id = ?");
      values.push(update.hostInstanceId);
    }
    if (update.heartbeatAt !== undefined) {
      // null clears the liveness proof; a string is the latest heartbeat stamp.
      assignments.push("heartbeat_at = ?");
      values.push(update.heartbeatAt);
    }
    if (update.endedAt !== undefined) {
      assignments.push("ended_at = ?");
      values.push(update.endedAt);
    }
    this.connection.database.prepare(`
      UPDATE chat_sessions
      SET ${assignments.join(", ")}
      WHERE session_id = ?
    `).run(...values, sessionId);
  }

  async getSession(sessionId: SessionId): Promise<ChatSessionRecord | null> {
    const row = this.connection.database.prepare(`
      SELECT *
      FROM chat_sessions
      WHERE session_id = ?
    `).get(sessionId) as ChatSessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  async listSessions(limit = DEFAULT_LIST_LIMIT): Promise<ChatSessionRecord[]> {
    // Newest-first by updated_at; same-timestamp writes fall back to insertion
    // order (rowid) so the listing stays deterministic.
    const rows = this.connection.database.prepare(`
      SELECT *
      FROM chat_sessions
      ORDER BY updated_at DESC, rowid DESC
      LIMIT ?
    `).all(limit) as unknown as ChatSessionRow[];
    return rows.map(mapSession);
  }

  async deleteSession(sessionId: SessionId): Promise<void> {
    // Only removes the session row; the caller deletes dependent event rows.
    this.connection.database.prepare(`
      DELETE FROM chat_sessions
      WHERE session_id = ?
    `).run(sessionId);
  }
}

interface ChatSessionRow {
  readonly session_id: string;
  readonly chat_id: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: ChatSessionStatus;
  readonly provider_id: string;
  readonly model: string | null;
  readonly transport: string;
  readonly runtime_id: string | null;
  readonly host_instance_id: string | null;
  readonly heartbeat_at: string | null;
  readonly mode: string | null;
  readonly parent_session_id: string | null;
  readonly spawned_role: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly ended_at: string | null;
}

function mapSession(row: ChatSessionRow): ChatSessionRecord {
  return {
    sessionId: row.session_id as SessionId,
    chatId: row.chat_id as ChatId,
    title: row.title,
    ...(row.description === null || row.description === "" ? {} : { description: row.description }),
    status: row.status,
    providerId: row.provider_id,
    ...(row.model === null || row.model === "" ? {} : { model: row.model }),
    transport: row.transport,
    ...(row.runtime_id === null ? {} : { runtimeId: row.runtime_id as RuntimeId }),
    ...(row.host_instance_id === null ? {} : { hostInstanceId: row.host_instance_id }),
    ...(row.heartbeat_at === null ? {} : { heartbeatAt: row.heartbeat_at }),
    ...(row.mode === null ? {} : { mode: row.mode as SessionMode }),
    ...(row.parent_session_id === null ? {} : { parentSessionId: row.parent_session_id as SessionId }),
    ...(row.spawned_role === null ? {} : { spawnedRole: row.spawned_role as AgentRole }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at })
  };
}
