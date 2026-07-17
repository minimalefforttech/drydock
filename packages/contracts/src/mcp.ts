/**
 * MCP registry contracts (docs/design/mcp-and-memory.md).
 *
 * Servers are DEFINED once in the registry (System tab); everywhere else is
 * toggles. The effective set for a session cascades registry defaults →
 * workspace override → task override → session override (most specific wins;
 * `sensitive` servers are OFF unless a task/session explicitly opts in), and
 * is rendered to /workspace/.mcp.json over the runtime exec side-channel
 * (ADR 0018) — never new mounts, never restarts. Servers execute INSIDE the
 * sandbox under the existing egress policy; the registry never grants
 * network or mounts, and env values never render in the webview.
 */

import type { Brand } from "./ids.js";

export type McpServerId = Brand<string, "McpServerId">;

export interface McpServerRecord {
  readonly serverId: McpServerId;
  /** Display name; also the key in the rendered .mcp.json. Unique. */
  readonly name: string;
  /** stdio launch inside the sandbox. */
  readonly command: string;
  readonly args: readonly string[];
  /** Stored host-side, injected only into the session's own config file. */
  readonly env: Readonly<Record<string, string>>;
  readonly enabledByDefault: boolean;
  /** Requires an explicit task/session opt-in; a default or workspace "on" is not enough. */
  readonly sensitive: boolean;
  readonly notes?: string;
  /** "settings" rows are imported from drydock.mcp.configPath, editable only via that file. */
  readonly source: "registry" | "settings";
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Where an MCP override binds. Workspace overrides key on a workspace-set id. */
export type McpOverrideScope = "workspace-set" | "task" | "session";

export interface McpOverride {
  readonly scope: McpOverrideScope;
  /** workspaceSetId / taskId / sessionId. */
  readonly refId: string;
  readonly serverId: McpServerId;
  /** No stored row = inherit. */
  readonly state: "on" | "off";
}

export const MCP_SERVER_NAME_MAX = 64;
export const MCP_COMMAND_MAX = 512;
export const MCP_MAX_ARGS = 32;
export const MCP_MAX_ENV_VARS = 32;

export interface McpServerStore {
  upsertServer(record: McpServerRecord): Promise<void>;
  getServer(serverId: McpServerId): Promise<McpServerRecord | null>;
  /** Name order, stable. */
  listServers(): Promise<McpServerRecord[]>;
  deleteServer(serverId: McpServerId): Promise<void>;
  /** "on"/"off" upserts; "inherit" deletes the row. */
  setOverride(override: McpOverride): Promise<void>;
  clearOverride(scope: McpOverrideScope, refId: string, serverId: McpServerId): Promise<void>;
  listOverrides(scope?: McpOverrideScope, refId?: string): Promise<McpOverride[]>;
}
