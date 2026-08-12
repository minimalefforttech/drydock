/**
 * Repo MCP packs (UX overhaul P6): `.drydock/mcp.json` in any open workspace
 * folder contributes READ-ONLY server rows to the Configure panel's MCP
 * section - the recipe/aspect overlay pattern (`recipeOverlay.ts`), applied to
 * the MCP registry.
 *
 * The file uses the same Claude project-scope shape the settings import already
 * accepts, so a repo can check in one file that both Claude Code and Drydock
 * understand:
 *
 *   { "mcpServers": { "docs": { "command": "npx", "args": ["-y", "docs-mcp"],
 *                               "env": { "DOCS_ROOT": "./docs" } } } }
 *
 * These rows are never stored, never editable in the panel, and never merge
 * into the SQLite registry: ids are prefixed `overlay:` so they can neither
 * collide with nor mutate a stored row, and the panel renders them with a
 * `project` provenance chip plus "edit the file ↗". Malformed files and
 * entries are skipped with structured diagnostics - an overlay must never
 * break the panel.
 *
 * SECURITY: an MCP server definition is a command line the sandbox will run,
 * so this file is repository-controlled executable content. It is gated on
 * workspace trust exactly like recipes and planner aspects, and env VALUES are
 * kept host-side (only key names ever leave for display).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { MCP_COMMAND_MAX, MCP_MAX_ARGS, MCP_MAX_ENV_VARS, MCP_SERVER_NAME_MAX } from "@drydock/contracts";
import type { Logger } from "@drydock/core";

const OVERLAY_RELATIVE_PATH = [".drydock", "mcp.json"];
/** Ids carry the prefix so a stored registry row can never be shadowed. */
export const MCP_OVERLAY_ID_PREFIX = "overlay:";

/** One read-only server contributed by an open folder's `.drydock/mcp.json`. */
export interface McpProjectServer {
  /** `overlay:<slug>` - stable per name, never a registry id. */
  readonly serverId: string;
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Key names only; values stay host-side like every other MCP surface. */
  readonly envKeys: readonly string[];
  /** Host path of the file this row came from, for "edit the file ↗". */
  readonly filePath: string;
}

/**
 * Builds the reader the Configure panel calls. `roots` is re-read on every
 * call, so opening or closing a folder takes effect without a reload.
 */
export function createMcpProjectOverlayReader(
  roots: () => readonly string[],
  logger: Pick<Logger, "warn">,
  isWorkspaceTrusted: () => boolean,
  resolveFile: (root: string, filePath: string) => string | undefined = (_root, filePath) => filePath
): () => Promise<readonly McpProjectServer[]> {
  return async () => {
    // A server definition is a command the sandbox executes. Match VS Code's
    // executable-content boundary: an untrusted workspace contributes nothing.
    if (!isWorkspaceTrusted()) return [];
    const merged: McpProjectServer[] = [];
    const seen = new Set<string>();
    for (const root of roots()) {
      const filePath = resolveFile(root, path.join(root, ...OVERLAY_RELATIVE_PATH));
      if (filePath === undefined) continue;
      for (const server of await readOverlayFile(filePath, logger)) {
        if (!seen.has(server.serverId)) {
          seen.add(server.serverId);
          merged.push(server);
        } else {
          logger.warn("duplicate mcp overlay server ignored", { filePath, name: server.name });
        }
      }
    }
    return merged;
  };
}

async function readOverlayFile(filePath: string, logger: Pick<Logger, "warn">): Promise<McpProjectServer[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn("mcp overlay could not be read", {
        filePath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logger.warn("mcp overlay JSON could not be parsed", {
      filePath,
      error: error instanceof Error ? error.message : String(error)
    });
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    logger.warn("mcp overlay root must be an object with mcpServers", { filePath });
    return [];
  }
  const mcpServers = (parsed as Record<string, unknown>)["mcpServers"];
  if (typeof mcpServers !== "object" || mcpServers === null || Array.isArray(mcpServers)) {
    logger.warn("mcp overlay root must be an object with mcpServers", { filePath });
    return [];
  }
  const servers: McpProjectServer[] = [];
  for (const [name, value] of Object.entries(mcpServers)) {
    const issues = validateEntry(name, value);
    if (issues.length > 0) {
      logger.warn("invalid mcp overlay entry skipped", { filePath, name, issues });
      continue;
    }
    const entry = value as Record<string, unknown>;
    const rawArgs = Array.isArray(entry["args"]) ? entry["args"] : [];
    const rawEnv = entry["env"];
    const envKeys = typeof rawEnv === "object" && rawEnv !== null && !Array.isArray(rawEnv)
      ? Object.keys(rawEnv).slice(0, MCP_MAX_ENV_VARS)
      : [];
    servers.push({
      serverId: `${MCP_OVERLAY_ID_PREFIX}${slug(name)}`,
      name,
      command: entry["command"] as string,
      args: (rawArgs as string[]).slice(0, MCP_MAX_ARGS),
      envKeys,
      filePath
    });
  }
  return servers;
}

/** Rejects an entry as a whole rather than partially normalizing it. */
function validateEntry(name: string, value: unknown): string[] {
  const issues: string[] = [];
  if (name.trim().length === 0 || name.length > MCP_SERVER_NAME_MAX) {
    issues.push(`name must be 1-${String(MCP_SERVER_NAME_MAX)} characters`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issues.push("entry must be an object");
    return issues;
  }
  const entry = value as Record<string, unknown>;
  const command = entry["command"];
  if (typeof command !== "string" || command.trim().length === 0 || command.length > MCP_COMMAND_MAX) {
    issues.push(`command must be a non-empty string of at most ${String(MCP_COMMAND_MAX)} characters`);
  }
  const args = entry["args"];
  if (args !== undefined && (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))) {
    issues.push("args must contain only strings");
  }
  const env = entry["env"];
  if (env !== undefined) {
    if (typeof env !== "object" || env === null || Array.isArray(env)) {
      issues.push("env must be an object");
    } else if (Object.values(env).some((entryValue) => typeof entryValue !== "string")) {
      issues.push("env values must be strings");
    }
  }
  return issues;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "server";
}
