/**
 * MCP registry service (docs/design/mcp-and-memory.md).
 *
 * Servers are DEFINED once (System tab, or imported read-only from the
 * drydock.mcp.configPath settings file); everywhere else is tri-state
 * toggles. The effective set for a session cascades registry defaults →
 * workspace-set overrides (sets whose roots intersect the session's mounted
 * roots) → task overrides (tasks linked to the session) → session override —
 * most specific wins, and `sensitive` servers stay OFF unless a task or
 * session explicitly turns them on. The winner set renders to the Claude
 * .mcp.json shape and rides the exec side-channel (ADR 0018); toggles apply
 * next turn, never a restart.
 */

import { randomUUID } from "node:crypto";
import {
  asId,
  MCP_COMMAND_MAX,
  MCP_MAX_ARGS,
  MCP_MAX_ENV_VARS,
  MCP_SERVER_NAME_MAX
} from "@drydock/contracts";
import type {
  McpOverride,
  McpOverrideScope,
  McpServerRecord,
  McpServerStore
} from "@drydock/contracts";
import type { Clock } from "@drydock/core";

export interface McpRegistryServiceOptions {
  readonly clock: Clock;
  readonly store: McpServerStore;
  /** Read-only rows imported from drydock.mcp.configPath at activation. */
  readonly importedServers?: readonly McpServerRecord[];
}

export interface McpServerInput {
  /** Absent = create. */
  readonly serverId?: string;
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  /** Absent on update = keep the stored values (env is write-only from the UI). */
  readonly env?: Readonly<Record<string, string>>;
  readonly enabledByDefault: boolean;
  readonly sensitive: boolean;
  readonly notes?: string;
}

/** One workspace set the resolver can match session roots against. */
export interface McpWorkspaceSetRef {
  readonly workspaceSetId: string;
  readonly roots: readonly string[];
}

export interface McpEffectiveQuery {
  readonly sessionId: string;
  readonly sessionRoots: readonly string[];
  readonly taskIds: readonly string[];
  readonly workspaceSets: readonly McpWorkspaceSetRef[];
}

/** One server plus how the cascade resolved it, for display and rendering. */
export interface McpEffectiveServer {
  readonly server: McpServerRecord;
  readonly enabled: boolean;
  /** Which scope decided the state ("default" when nothing overrode it). */
  readonly decidedBy: "default" | McpOverrideScope | "sensitive-gate";
}

function normalizeRoot(root: string): string {
  return root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export class McpRegistryService {
  constructor(private readonly options: McpRegistryServiceOptions) {}

  /** Registry rows plus settings-imported rows, name-sorted for display. */
  async listServers(): Promise<McpServerRecord[]> {
    const stored = await this.options.store.listServers();
    const imported = this.options.importedServers ?? [];
    return [...stored, ...imported].sort((a, b) => a.name.localeCompare(b.name));
  }

  async saveServer(input: McpServerInput): Promise<McpServerRecord> {
    const name = input.name.trim();
    if (name.length === 0 || name.length > MCP_SERVER_NAME_MAX) {
      throw new Error(`Server name must be 1-${MCP_SERVER_NAME_MAX} characters.`);
    }
    const command = input.command.trim();
    if (command.length === 0 || command.length > MCP_COMMAND_MAX) {
      throw new Error("Server command is required.");
    }
    const args = (input.args ?? []).slice(0, MCP_MAX_ARGS).map((arg) => String(arg));
    if (input.serverId !== undefined && this.isImported(input.serverId)) {
      throw new Error("This server comes from drydock.mcp.configPath — edit that file instead.");
    }
    const existing = input.serverId === undefined
      ? null
      : await this.options.store.getServer(asId<"McpServerId">(input.serverId));
    if (input.serverId !== undefined && existing === null) {
      throw new Error(`MCP server ${input.serverId} was not found.`);
    }
    const duplicate = (await this.listServers()).find(
      (server) => server.name.toLowerCase() === name.toLowerCase() && server.serverId !== input.serverId
    );
    if (duplicate !== undefined) {
      throw new Error(`An MCP server named "${name}" already exists.`);
    }
    const env = input.env === undefined
      ? (existing?.env ?? {})
      : Object.fromEntries(Object.entries(input.env).slice(0, MCP_MAX_ENV_VARS));
    const now = this.options.clock.isoNow();
    const record: McpServerRecord = {
      serverId: existing?.serverId ?? asId<"McpServerId">(`mcp-${randomUUID().replace(/-/g, "").slice(0, 8)}`),
      name,
      command,
      args,
      env,
      enabledByDefault: input.enabledByDefault,
      sensitive: input.sensitive,
      ...(input.notes === undefined || input.notes.trim().length === 0 ? {} : { notes: input.notes.trim() }),
      source: "registry",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    try {
      await this.options.store.upsertServer(record);
    } catch (error) {
      // The check above is TOCTOU (T3.6): two concurrent saves can both pass it
      // before either writes. migrations.ts's UNIQUE(name COLLATE NOCASE) index
      // is the real guard; this turns ITS raw constraint failure into the same
      // sentence a same-process caller already gets above, instead of a bare
      // SQLite error reaching the panel.
      if (isNameConflict(error)) {
        throw new Error(`An MCP server named "${name}" already exists.`);
      }
      throw error;
    }
    return record;
  }

  async deleteServer(serverId: string): Promise<void> {
    if (this.isImported(serverId)) {
      throw new Error("This server comes from drydock.mcp.configPath — remove it from that file instead.");
    }
    await this.options.store.deleteServer(asId<"McpServerId">(serverId));
  }

  /** Tri-state: "on"/"off" stores a row; "inherit" clears it. */
  async setOverride(scope: McpOverrideScope, refId: string, serverId: string, state: "on" | "off" | "inherit"): Promise<void> {
    const id = asId<"McpServerId">(serverId);
    if (state === "inherit") {
      await this.options.store.clearOverride(scope, refId, id);
      return;
    }
    await this.options.store.setOverride({ scope, refId, serverId: id, state });
  }

  listOverrides(scope?: McpOverrideScope, refId?: string): Promise<McpOverride[]> {
    return this.options.store.listOverrides(scope, refId);
  }

  /**
   * The cascade. Workspace-set overrides apply when the set's roots intersect
   * the session's mounted roots; task overrides when the task is linked to
   * the session; session overrides always. Later (more specific) wins.
   * Sensitive servers additionally require the deciding "on" to come from a
   * task or session override — a default or workspace "on" reads as off.
   */
  async effectiveForSession(query: McpEffectiveQuery): Promise<McpEffectiveServer[]> {
    const servers = await this.listServers();
    if (servers.length === 0) return [];
    const overrides = await this.options.store.listOverrides();
    const sessionRootSet = new Set(query.sessionRoots.map(normalizeRoot));
    const matchingSetIds = new Set(
      query.workspaceSets
        .filter((set) => set.roots.some((root) => sessionRootSet.has(normalizeRoot(root))))
        .map((set) => set.workspaceSetId)
    );
    const taskIds = new Set(query.taskIds);
    const results: McpEffectiveServer[] = [];
    for (const server of servers) {
      let enabled = server.enabledByDefault;
      let decidedBy: McpEffectiveServer["decidedBy"] = "default";
      for (const override of overrides) {
        if (override.serverId !== server.serverId || override.scope !== "workspace-set") continue;
        if (!matchingSetIds.has(override.refId)) continue;
        enabled = override.state === "on";
        decidedBy = "workspace-set";
      }
      for (const override of overrides) {
        if (override.serverId !== server.serverId || override.scope !== "task") continue;
        if (!taskIds.has(override.refId)) continue;
        enabled = override.state === "on";
        decidedBy = "task";
      }
      for (const override of overrides) {
        if (override.serverId !== server.serverId || override.scope !== "session") continue;
        if (override.refId !== query.sessionId) continue;
        enabled = override.state === "on";
        decidedBy = "session";
      }
      if (server.sensitive && enabled && decidedBy !== "task" && decidedBy !== "session") {
        enabled = false;
        decidedBy = "sensitive-gate";
      }
      results.push({ server, enabled, decidedBy });
    }
    return results;
  }

  /** Claude project-scope .mcp.json for the enabled set; null when empty. */
  renderConfigJson(servers: readonly McpEffectiveServer[]): string | null {
    const enabled = servers.filter((entry) => entry.enabled);
    if (enabled.length === 0) return null;
    const mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
    for (const entry of enabled) {
      mcpServers[entry.server.name] = {
        command: entry.server.command,
        args: [...entry.server.args],
        ...(Object.keys(entry.server.env).length === 0 ? {} : { env: { ...entry.server.env } })
      };
    }
    return JSON.stringify({ mcpServers }, null, 2);
  }

  private isImported(serverId: string): boolean {
    return (this.options.importedServers ?? []).some((server) => server.serverId === serverId);
  }
}

/**
 * True for the `mcp_servers` name-uniqueness violation (T3.6). The project's
 * SQLite driver (node:sqlite) reports every constraint failure under the same
 * generic `ERR_SQLITE_ERROR` code, so the constrained column - present in
 * `error.message` - is the only specific signal available to tell this apart
 * from some other failure `upsertServer` could throw.
 */
function isNameConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes("mcp_servers.name");
}

/**
 * Parses a validated .mcp.json string (drydock.mcp.configPath) into imported
 * read-only registry rows tagged `source: "settings"`. Malformed entries are
 * dropped — the file was already validated at activation, this is belt and
 * suspenders.
 */
export function importServersFromConfigJson(configJson: string, importedAt: string): McpServerRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const mcpServers = (parsed as Record<string, unknown>)["mcpServers"];
  if (typeof mcpServers !== "object" || mcpServers === null) return [];
  const records: McpServerRecord[] = [];
  for (const [name, value] of Object.entries(mcpServers)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    const command = typeof entry["command"] === "string" ? entry["command"] : "";
    if (command.length === 0 || name.length === 0 || name.length > MCP_SERVER_NAME_MAX) continue;
    const args = Array.isArray(entry["args"])
      ? entry["args"].filter((arg): arg is string => typeof arg === "string")
      : [];
    const rawEnv = entry["env"];
    const env: Record<string, string> = {};
    if (typeof rawEnv === "object" && rawEnv !== null && !Array.isArray(rawEnv)) {
      for (const [key, envValue] of Object.entries(rawEnv)) {
        if (typeof envValue === "string") env[key] = envValue;
      }
    }
    records.push({
      serverId: asId<"McpServerId">(`mcp-settings-${name.toLowerCase().replace(/[^a-z0-9]/g, "-")}`),
      name,
      command,
      args,
      env,
      enabledByDefault: true,
      sensitive: false,
      source: "settings",
      createdAt: importedAt,
      updatedAt: importedAt
    });
  }
  return records;
}
