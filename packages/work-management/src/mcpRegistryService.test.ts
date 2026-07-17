/**
 * Unit tests for the MCP registry: the override cascade (defaults →
 * workspace-set → task → session), the sensitive gate, config rendering,
 * and settings-file import.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import type {
  McpOverride,
  McpOverrideScope,
  McpServerId,
  McpServerRecord,
  McpServerStore
} from "@drydock/contracts";
import { importServersFromConfigJson, McpRegistryService } from "./mcpRegistryService.js";

class MemoryMcpStore implements McpServerStore {
  readonly servers = new Map<string, McpServerRecord>();
  readonly overrides: McpOverride[] = [];

  upsertServer(record: McpServerRecord): Promise<void> {
    this.servers.set(record.serverId, record);
    return Promise.resolve();
  }
  getServer(serverId: McpServerId): Promise<McpServerRecord | null> {
    return Promise.resolve(this.servers.get(serverId) ?? null);
  }
  listServers(): Promise<McpServerRecord[]> {
    return Promise.resolve([...this.servers.values()]);
  }
  deleteServer(serverId: McpServerId): Promise<void> {
    this.servers.delete(serverId);
    return Promise.resolve();
  }
  setOverride(override: McpOverride): Promise<void> {
    const index = this.overrides.findIndex((o) => o.scope === override.scope && o.refId === override.refId && o.serverId === override.serverId);
    if (index === -1) this.overrides.push(override); else this.overrides[index] = override;
    return Promise.resolve();
  }
  clearOverride(scope: McpOverrideScope, refId: string, serverId: McpServerId): Promise<void> {
    const index = this.overrides.findIndex((o) => o.scope === scope && o.refId === refId && o.serverId === serverId);
    if (index !== -1) this.overrides.splice(index, 1);
    return Promise.resolve();
  }
  listOverrides(scope?: McpOverrideScope, refId?: string): Promise<McpOverride[]> {
    return Promise.resolve(this.overrides.filter((o) =>
      (scope === undefined || o.scope === scope) && (refId === undefined || o.refId === refId)));
  }
}

const clock = { now: () => new Date("2026-07-17T00:00:00.000Z"), isoNow: () => "2026-07-17T00:00:00.000Z" };

async function serviceWithServers(): Promise<{ service: McpRegistryService; ids: Record<string, string> }> {
  const service = new McpRegistryService({ clock, store: new MemoryMcpStore() });
  const assetDb = await service.saveServer({ name: "asset-db", command: "npx", args: ["-y", "@studio/asset-mcp"], enabledByDefault: true, sensitive: false });
  const shotgrid = await service.saveServer({ name: "shotgrid", command: "uvx", args: [], enabledByDefault: true, sensitive: true });
  const linter = await service.saveServer({ name: "linter", command: "mcp-lint", args: [], enabledByDefault: false, sensitive: false });
  return { service, ids: { assetDb: assetDb.serverId, shotgrid: shotgrid.serverId, linter: linter.serverId } };
}

const QUERY = {
  sessionId: "s-1",
  sessionRoots: ["C:/proj/asset_api"],
  taskIds: ["t-1"],
  workspaceSets: [{ workspaceSetId: "ws-1", roots: ["c:\\proj\\asset_api"] }]
};

test("cascade: defaults, then workspace-set (roots intersect), then task, then session", async () => {
  const { service, ids } = await serviceWithServers();
  // Default: asset-db on, linter off.
  let effective = await service.effectiveForSession(QUERY);
  assert.equal(effective.find((e) => e.server.serverId === ids["assetDb"])?.enabled, true);
  assert.equal(effective.find((e) => e.server.serverId === ids["linter"])?.enabled, false);

  // Workspace-set (case/slash-normalized root match) flips linter on.
  await service.setOverride("workspace-set", "ws-1", ids["linter"]!, "on");
  effective = await service.effectiveForSession(QUERY);
  assert.equal(effective.find((e) => e.server.serverId === ids["linter"])?.enabled, true);
  assert.equal(effective.find((e) => e.server.serverId === ids["linter"])?.decidedBy, "workspace-set");

  // Task off beats workspace on; session on beats task off.
  await service.setOverride("task", "t-1", ids["linter"]!, "off");
  effective = await service.effectiveForSession(QUERY);
  assert.equal(effective.find((e) => e.server.serverId === ids["linter"])?.enabled, false);
  await service.setOverride("session", "s-1", ids["linter"]!, "on");
  effective = await service.effectiveForSession(QUERY);
  assert.equal(effective.find((e) => e.server.serverId === ids["linter"])?.enabled, true);
  assert.equal(effective.find((e) => e.server.serverId === ids["linter"])?.decidedBy, "session");

  // "inherit" clears the session row; task off resurfaces.
  await service.setOverride("session", "s-1", ids["linter"]!, "inherit");
  effective = await service.effectiveForSession(QUERY);
  assert.equal(effective.find((e) => e.server.serverId === ids["linter"])?.enabled, false);

  // A non-matching workspace set never applies.
  const foreign = await service.effectiveForSession({ ...QUERY, sessionRoots: ["D:/other"], taskIds: [], workspaceSets: QUERY.workspaceSets });
  assert.equal(foreign.find((e) => e.server.serverId === ids["linter"])?.enabled, false);
});

test("sensitive servers require a task or session opt-in", async () => {
  const { service, ids } = await serviceWithServers();
  // enabledByDefault true is NOT enough for a sensitive server.
  let effective = await service.effectiveForSession(QUERY);
  const shotgrid = effective.find((e) => e.server.serverId === ids["shotgrid"]);
  assert.equal(shotgrid?.enabled, false);
  assert.equal(shotgrid?.decidedBy, "sensitive-gate");
  // A workspace "on" is not enough either.
  await service.setOverride("workspace-set", "ws-1", ids["shotgrid"]!, "on");
  effective = await service.effectiveForSession(QUERY);
  assert.equal(effective.find((e) => e.server.serverId === ids["shotgrid"])?.enabled, false);
  // A task opt-in is.
  await service.setOverride("task", "t-1", ids["shotgrid"]!, "on");
  effective = await service.effectiveForSession(QUERY);
  assert.equal(effective.find((e) => e.server.serverId === ids["shotgrid"])?.enabled, true);
});

test("renderConfigJson emits the Claude mcpServers shape for enabled servers only", async () => {
  const { service } = await serviceWithServers();
  const effective = await service.effectiveForSession(QUERY);
  const json = service.renderConfigJson(effective);
  assert.ok(json !== null);
  const parsed = JSON.parse(json) as { mcpServers: Record<string, { command: string; args: string[] }> };
  assert.deepEqual(Object.keys(parsed.mcpServers), ["asset-db"]);
  assert.equal(parsed.mcpServers["asset-db"]?.command, "npx");
  // Nothing enabled -> null (caller writes an empty map only on refresh).
  assert.equal(service.renderConfigJson([]), null);
});

test("importServersFromConfigJson maps entries to read-only settings rows", () => {
  const imported = importServersFromConfigJson(
    JSON.stringify({ mcpServers: { docs: { command: "node", args: ["docs.mjs"], env: { TOKEN: "x" } }, bad: {} } }),
    "2026-07-17T00:00:00.000Z"
  );
  assert.equal(imported.length, 1);
  assert.equal(imported[0]?.name, "docs");
  assert.equal(imported[0]?.source, "settings");
  assert.equal(imported[0]?.enabledByDefault, true);
  // Imported rows refuse edits/deletes through the service.
  const service = new McpRegistryService({ clock, store: new MemoryMcpStore(), importedServers: imported });
  void assert.rejects(() => service.deleteServer(imported[0]!.serverId), /configPath/);
});
