/**
 * SQLite runtime inventory repository.
 *
 * Inventory is written before runtime creation and updated through cleanup so
 * interrupted sessions remain auditable.
 */

import type {
  AgentId,
  AgentRole,
  ChatId,
  JsonObject,
  RuntimeGenerationId,
  RuntimeId,
  RuntimeInventoryRecord,
  RuntimeInventoryStore,
  RuntimeStatus,
  SessionId
} from "@drydock/contracts";
import type { SqliteConnection } from "./sqliteConnection.js";

export class SqliteRuntimeInventoryStore implements RuntimeInventoryStore {
  constructor(private readonly connection: SqliteConnection) {}

  async insertRuntime(record: RuntimeInventoryRecord): Promise<void> {
    this.connection.database.prepare(`
      INSERT INTO runtime_instances (
        runtime_id,
        runtime_generation_id,
        session_id,
        chat_id,
        agent_id,
        agent_role,
        template_id,
        adapter,
        external_name,
        external_id,
        workspace_owner_token,
        status,
        started_at,
        stopped_at,
        removed_at,
        last_seen_at,
        last_cleanup_attempt_at,
        cleanup_failure_count,
        metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.runtimeId,
      record.runtimeGenerationId,
      record.sessionId,
      record.chatId,
      record.agentId ?? null,
      record.agentRole ?? null,
      record.templateId,
      record.adapter,
      record.externalName,
      record.externalId ?? null,
      record.workspaceOwnerToken ?? null,
      record.status,
      record.startedAt,
      record.stoppedAt ?? null,
      record.removedAt ?? null,
      record.lastSeenAt ?? null,
      record.lastCleanupAttemptAt ?? null,
      record.cleanupFailureCount,
      JSON.stringify(record.metadata)
    );
  }

  async updateRuntimeStatus(runtimeId: RuntimeId, status: RuntimeStatus, timestamp: string): Promise<void> {
    const stoppedAt = status === "stopped" ? timestamp : null;
    const removedAt = status === "removed" ? timestamp : null;
    this.connection.database.prepare(`
      UPDATE runtime_instances
      SET status = ?,
          stopped_at = COALESCE(?, stopped_at),
          removed_at = COALESCE(?, removed_at),
          last_seen_at = ?
      WHERE runtime_id = ?
    `).run(status, stoppedAt, removedAt, timestamp, runtimeId);
  }

  async updateRuntimeMetadata(runtimeId: RuntimeId, patch: JsonObject, timestamp: string): Promise<void> {
    // Read-merge-write is safe on the single synchronous connection. The merge
    // is shallow: top-level patch keys overwrite, every other stored key
    // survives. Missing runtimes are a silent no-op.
    const row = this.connection.database.prepare(`
      SELECT metadata_json
      FROM runtime_instances
      WHERE runtime_id = ?
    `).get(runtimeId) as { metadata_json: string } | undefined;
    if (row === undefined) {
      return;
    }
    const merged: JsonObject = { ...(JSON.parse(row.metadata_json) as JsonObject), ...patch };
    this.connection.database.prepare(`
      UPDATE runtime_instances
      SET metadata_json = ?,
          last_seen_at = ?
      WHERE runtime_id = ?
    `).run(JSON.stringify(merged), timestamp, runtimeId);
  }

  async updateCleanupAttempt(runtimeId: RuntimeId, timestamp: string, failed: boolean): Promise<void> {
    this.connection.database.exec("BEGIN IMMEDIATE;");
    try {
      this.connection.database.prepare(`
        INSERT INTO runtime_cleanup_attempts (runtime_id, attempted_at, failed)
        VALUES (?, ?, ?)
      `).run(runtimeId, timestamp, failed ? 1 : 0);
      this.connection.database.prepare(`
        UPDATE runtime_instances
        SET last_cleanup_attempt_at = ?,
            cleanup_failure_count = cleanup_failure_count + ?
        WHERE runtime_id = ?
      `).run(timestamp, failed ? 1 : 0, runtimeId);
      this.connection.database.exec("COMMIT;");
    } catch (error) {
      this.connection.database.exec("ROLLBACK;");
      throw error;
    }
  }

  async getRuntime(runtimeId: RuntimeId): Promise<RuntimeInventoryRecord | null> {
    const row = this.connection.database.prepare(`
      SELECT *
      FROM runtime_instances
      WHERE runtime_id = ?
    `).get(runtimeId) as RuntimeRow | undefined;
    return row ? mapRuntime(row) : null;
  }

  async listRuntimes(): Promise<RuntimeInventoryRecord[]> {
    const rows = this.connection.database.prepare(`
      SELECT *
      FROM runtime_instances
      ORDER BY started_at DESC
    `).all() as unknown as RuntimeRow[];
    return rows.map(mapRuntime);
  }

  /**
   * Deletes terminal inventory rows past their retention window: `removed`
   * rows keyed on removed_at (when they were torn down), `lost` rows keyed on
   * last_seen_at (when reconciliation last observed them). started_at is the
   * fallback when the primary timestamp is NULL so a row can never linger for
   * want of a stamp. Returns the number of rows deleted.
   */
  async purgeRuntimes(input: { now: string; removedOlderThanMs: number; lostOlderThanMs: number }): Promise<number> {
    const removedCutoff = new Date(new Date(input.now).getTime() - input.removedOlderThanMs).toISOString();
    const lostCutoff = new Date(new Date(input.now).getTime() - input.lostOlderThanMs).toISOString();
    const result = this.connection.database.prepare(`
      DELETE FROM runtime_instances
      WHERE (status = 'removed' AND COALESCE(removed_at, started_at) < ?)
         OR (status = 'lost' AND COALESCE(last_seen_at, started_at) < ?)
    `).run(removedCutoff, lostCutoff);
    return Number(result.changes);
  }
}

interface RuntimeRow {
  readonly runtime_id: string;
  readonly runtime_generation_id: string;
  readonly session_id: string;
  readonly chat_id: string;
  readonly agent_id: string | null;
  readonly agent_role: AgentRole | null;
  readonly template_id: string;
  readonly adapter: RuntimeInventoryRecord["adapter"];
  readonly external_name: string;
  readonly external_id: string | null;
  readonly workspace_owner_token: string | null;
  readonly status: RuntimeStatus;
  readonly started_at: string;
  readonly stopped_at: string | null;
  readonly removed_at: string | null;
  readonly last_seen_at: string | null;
  readonly last_cleanup_attempt_at: string | null;
  readonly cleanup_failure_count: number;
  readonly metadata_json: string;
}

function mapRuntime(row: RuntimeRow): RuntimeInventoryRecord {
  return {
    runtimeId: row.runtime_id as RuntimeId,
    runtimeGenerationId: row.runtime_generation_id as RuntimeGenerationId,
    sessionId: row.session_id as SessionId,
    chatId: row.chat_id as ChatId,
    ...(row.agent_id === null ? {} : { agentId: row.agent_id as AgentId }),
    ...(row.agent_role === null ? {} : { agentRole: row.agent_role }),
    templateId: row.template_id,
    adapter: row.adapter,
    externalName: row.external_name,
    ...(row.external_id === null ? {} : { externalId: row.external_id }),
    ...(row.workspace_owner_token === null ? {} : { workspaceOwnerToken: row.workspace_owner_token }),
    status: row.status,
    startedAt: row.started_at,
    ...(row.stopped_at === null ? {} : { stoppedAt: row.stopped_at }),
    ...(row.removed_at === null ? {} : { removedAt: row.removed_at }),
    ...(row.last_seen_at === null ? {} : { lastSeenAt: row.last_seen_at }),
    ...(row.last_cleanup_attempt_at === null ? {} : { lastCleanupAttemptAt: row.last_cleanup_attempt_at }),
    cleanupFailureCount: row.cleanup_failure_count,
    metadata: JSON.parse(row.metadata_json) as JsonObject
  };
}
