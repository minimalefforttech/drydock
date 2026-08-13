/**
 * SQLite-backed MCP registry store (docs/design/mcp-and-memory.md).
 *
 * Server definitions plus tri-state override rows: no row = inherit, so
 * setOverride upserts "on"/"off" and clearOverride deletes. Env values are
 * stored here host-side and injected only into a session's own
 * /workspace/.mcp.json — they never cross into the webview.
 */

import type {
  McpOverride,
  McpOverrideScope,
  McpServerId,
  McpServerRecord,
  McpServerStore
} from "@drydock/contracts";
import type { SqliteConnection } from "./sqliteConnection.js";

export class SqliteMcpServerStore implements McpServerStore {
  constructor(private readonly connection: SqliteConnection) {}

  /**
   * The conflict target here is server_id (an edit keeps its row), not name -
   * but migrations.ts also carries a `UNIQUE(name COLLATE NOCASE)` index
   * (T3.6), so a name collision with a DIFFERENT row (a concurrent create, or
   * a rename onto an existing name) still throws rather than silently
   * producing two rows that fight over the same key when rendered to
   * .mcp.json. The service layer maps that raw constraint error to a
   * readable message.
   */
  async upsertServer(record: McpServerRecord): Promise<void> {
    this.connection.database.prepare(`
      INSERT INTO mcp_servers (
        server_id, name, command, args_json, env_json,
        enabled_by_default, sensitive, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id) DO UPDATE SET
        name = excluded.name,
        command = excluded.command,
        args_json = excluded.args_json,
        env_json = excluded.env_json,
        enabled_by_default = excluded.enabled_by_default,
        sensitive = excluded.sensitive,
        notes = excluded.notes,
        updated_at = excluded.updated_at
    `).run(
      record.serverId,
      record.name,
      record.command,
      JSON.stringify(record.args),
      JSON.stringify(record.env),
      record.enabledByDefault ? 1 : 0,
      record.sensitive ? 1 : 0,
      record.notes ?? null,
      record.createdAt,
      record.updatedAt
    );
  }

  async getServer(serverId: McpServerId): Promise<McpServerRecord | null> {
    const row = this.connection.database.prepare(`
      SELECT * FROM mcp_servers WHERE server_id = ?
    `).get(serverId) as McpServerRow | undefined;
    return row ? mapServer(row) : null;
  }

  async listServers(): Promise<McpServerRecord[]> {
    const rows = this.connection.database.prepare(`
      SELECT * FROM mcp_servers ORDER BY name COLLATE NOCASE, server_id
    `).all() as unknown as McpServerRow[];
    return rows.map(mapServer);
  }

  /** Deletes the server row and its override rows in one transaction (T3.8). */
  async deleteServer(serverId: McpServerId): Promise<void> {
    const db = this.connection.database;
    db.exec("BEGIN");
    try {
      db.prepare(`DELETE FROM mcp_servers WHERE server_id = ?`).run(serverId);
      db.prepare(`DELETE FROM mcp_overrides WHERE server_id = ?`).run(serverId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  async setOverride(override: McpOverride): Promise<void> {
    this.connection.database.prepare(`
      INSERT INTO mcp_overrides (scope, ref_id, server_id, state)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(scope, ref_id, server_id) DO UPDATE SET state = excluded.state
    `).run(override.scope, override.refId, override.serverId, override.state);
  }

  async clearOverride(scope: McpOverrideScope, refId: string, serverId: McpServerId): Promise<void> {
    this.connection.database.prepare(`
      DELETE FROM mcp_overrides WHERE scope = ? AND ref_id = ? AND server_id = ?
    `).run(scope, refId, serverId);
  }

  async listOverrides(scope?: McpOverrideScope, refId?: string): Promise<McpOverride[]> {
    let rows: McpOverrideRow[];
    if (scope === undefined) {
      rows = this.connection.database.prepare(`SELECT * FROM mcp_overrides`).all() as unknown as McpOverrideRow[];
    } else if (refId === undefined) {
      rows = this.connection.database.prepare(`SELECT * FROM mcp_overrides WHERE scope = ?`).all(scope) as unknown as McpOverrideRow[];
    } else {
      rows = this.connection.database.prepare(`SELECT * FROM mcp_overrides WHERE scope = ? AND ref_id = ?`).all(scope, refId) as unknown as McpOverrideRow[];
    }
    return rows
      .filter((row) => row.state === "on" || row.state === "off")
      .map((row) => ({
        scope: row.scope as McpOverrideScope,
        refId: row.ref_id,
        serverId: row.server_id as McpServerId,
        state: row.state as "on" | "off"
      }));
  }
}

interface McpServerRow {
  readonly server_id: string;
  readonly name: string;
  readonly command: string;
  readonly args_json: string;
  readonly env_json: string;
  readonly enabled_by_default: number;
  readonly sensitive: number;
  readonly notes: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface McpOverrideRow {
  readonly scope: string;
  readonly ref_id: string;
  readonly server_id: string;
  readonly state: string;
}

function parseJsonArray(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonRecord(json: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const record: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") record[key] = value;
    }
    return record;
  } catch {
    return {};
  }
}

function mapServer(row: McpServerRow): McpServerRecord {
  return {
    serverId: row.server_id as McpServerId,
    name: row.name,
    command: row.command,
    args: parseJsonArray(row.args_json),
    env: parseJsonRecord(row.env_json),
    enabledByDefault: row.enabled_by_default === 1,
    sensitive: row.sensitive === 1,
    ...(row.notes === null ? {} : { notes: row.notes }),
    source: "registry",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
