/**
 * Shared MCP toggle UI (docs/design/mcp-and-memory.md).
 *
 * Servers are DEFINED in Configure; every other surface (workspace rows,
 * task menus, the chat FileMap) renders the same tri-state popover built
 * here: one row per registered server with inherit / on / off, plus a note
 * naming where the current state comes from. Toggles apply NEXT TURN — the
 * popover says so, honestly.
 *
 * SECURITY: dynamic strings render via textContent only; env values never
 * reach the webview at all (summaries carry key names only).
 */

import type { McpOverrideScope, McpOverrideSummary, McpServerSummary } from "@drydock/contracts";
import { badge, el } from "./components.js";
import { request } from "./messaging.js";
import type { AppState } from "./state.js";

/** Where a toggle popover binds: one scope + ref, plus the inherited context. */
export interface McpScopeContext {
  readonly scope: McpOverrideScope;
  readonly refId: string;
  /** Workspace sets whose overrides feed the inherited state (task/session scopes). */
  readonly workspaceSetIds?: readonly string[];
  /** Tasks whose overrides feed the inherited state (session scope). */
  readonly taskIds?: readonly string[];
}

export interface McpResolvedState {
  readonly server: McpServerSummary;
  readonly enabled: boolean;
  /** Which layer decided it, for the "inherited from …" note. */
  readonly decidedBy: "default" | McpOverrideScope | "sensitive-gate";
  /** This scope's own override, if any ("inherit" when absent). */
  readonly ownState: "on" | "off" | "inherit";
}

function overrideFor(
  overrides: readonly McpOverrideSummary[],
  scope: McpOverrideScope,
  refIds: readonly string[] | undefined,
  serverId: string
): "on" | "off" | undefined {
  if (refIds === undefined) return undefined;
  let found: "on" | "off" | undefined;
  for (const override of overrides) {
    if (override.scope === scope && override.serverId === serverId && refIds.includes(override.refId)) {
      found = override.state;
    }
  }
  return found;
}

/**
 * Mirror of the host cascade (default → workspace-set → task → session with
 * the sensitive gate) so popovers can show effective state without a
 * round-trip per row. The host remains the authority when rendering configs.
 */
export function resolveMcpState(state: AppState, context: McpScopeContext): McpResolvedState[] {
  const scopeChain: { scope: McpOverrideScope; refIds: readonly string[] }[] = [];
  if (context.scope === "workspace-set") {
    scopeChain.push({ scope: "workspace-set", refIds: [context.refId] });
  } else if (context.scope === "task") {
    scopeChain.push({ scope: "workspace-set", refIds: context.workspaceSetIds ?? [] });
    scopeChain.push({ scope: "task", refIds: [context.refId] });
  } else {
    scopeChain.push({ scope: "workspace-set", refIds: context.workspaceSetIds ?? [] });
    scopeChain.push({ scope: "task", refIds: context.taskIds ?? [] });
    scopeChain.push({ scope: "session", refIds: [context.refId] });
  }
  return state.mcpServers.map((server) => {
    let enabled = server.enabledByDefault;
    let decidedBy: McpResolvedState["decidedBy"] = "default";
    for (const layer of scopeChain) {
      const override = overrideFor(state.mcpOverrides, layer.scope, layer.refIds, server.serverId);
      if (override !== undefined) {
        enabled = override === "on";
        decidedBy = layer.scope;
      }
    }
    if (server.sensitive && enabled && decidedBy !== "task" && decidedBy !== "session") {
      enabled = false;
      decidedBy = "sensitive-gate";
    }
    const own = overrideFor(state.mcpOverrides, context.scope, [context.refId], server.serverId);
    return { server, enabled, decidedBy, ownState: own ?? "inherit" };
  });
}

/** Human note for where a state came from. */
function decidedByLabel(resolved: McpResolvedState, ownScope: McpOverrideScope): string {
  if (resolved.decidedBy === "sensitive-gate") return "sensitive — needs a task/chat opt-in";
  if (resolved.decidedBy === ownScope) return "set here";
  if (resolved.decidedBy === "default") return "registry default";
  const names: Record<string, string> = { "workspace-set": "workspace", task: "task", session: "chat" };
  return `inherited from ${names[resolved.decidedBy] ?? resolved.decidedBy}`;
}

/** Count of effectively-on servers, for "MCP (n)" chips. */
export function enabledMcpCount(state: AppState, context: McpScopeContext): number {
  return resolveMcpState(state, context).filter((entry) => entry.enabled).length;
}

/** Loads registry + overrides into state; safe to call often (cheap host read). */
export async function loadMcpState(state: AppState): Promise<boolean> {
  const response = await request({ type: "mcp.list" });
  if (response.ok && response.payload.type === "mcp.list") {
    state.mcpServers = [...response.payload.servers];
    state.mcpOverrides = [...response.payload.overrides];
    return true;
  }
  return false;
}

/**
 * Fills a popover body with tri-state rows for every registered server.
 * `onChanged` fires after the host confirms an override write, so callers can
 * re-render their chips/counters.
 */
export function buildMcpTogglePanel(
  content: HTMLElement,
  state: AppState,
  context: McpScopeContext,
  onChanged: () => void
): void {
  const title = el("div", "mcp-panel-title");
  const scopeNames: Record<McpOverrideScope, string> = { "workspace-set": "workspace", task: "task", session: "chat" };
  title.textContent = `MCP servers — this ${scopeNames[context.scope]}`;
  content.append(title);
  if (state.mcpServers.length === 0) {
    const empty = el("div", "muted");
    empty.textContent = "No MCP servers registered. Add them in System → MCP Servers.";
    content.append(empty);
    return;
  }
  const list = el("div", "mcp-toggle-list");
  for (const resolved of resolveMcpState(state, context)) {
    list.append(mcpToggleRow(resolved, state, context, onChanged));
  }
  content.append(list);
  const note = el("div", "muted mcp-panel-note");
  note.textContent = "Changes apply on the next turn of affected chats.";
  content.append(note);
}

function mcpToggleRow(
  resolved: McpResolvedState,
  state: AppState,
  context: McpScopeContext,
  onChanged: () => void
): HTMLElement {
  const row = el("div", "mcp-toggle-row");
  const head = el("div", "mcp-toggle-head");
  const name = el("span", "mcp-toggle-name");
  name.textContent = resolved.server.name;
  head.append(name);
  if (resolved.server.sensitive) head.append(badge("sensitive", "warn"));
  if (resolved.server.source === "settings") head.append(badge("from settings", ""));
  const stateLabel = el("span", `mcp-toggle-state ${resolved.enabled ? "on" : "off"}`);
  stateLabel.textContent = resolved.enabled ? "on" : "off";
  head.append(stateLabel);
  row.append(head);

  const controls = el("div", "mcp-tristate");
  const states: ("inherit" | "on" | "off")[] = ["inherit", "on", "off"];
  for (const value of states) {
    const option = document.createElement("button");
    option.className = `mcp-tristate-option${resolved.ownState === value ? " active" : ""}`;
    option.textContent = value;
    option.addEventListener("click", (event) => {
      event.stopPropagation();
      void request({
        type: "mcp.setOverride",
        scope: context.scope,
        refId: context.refId,
        serverId: resolved.server.serverId,
        state: value
      }).then((response) => {
        if (response.ok && response.payload.type === "mcp.setOverride") {
          state.mcpOverrides = [...response.payload.overrides];
          onChanged();
        }
      });
    });
    controls.append(option);
  }
  row.append(controls);

  const source = el("div", "muted mcp-toggle-source");
  source.textContent = decidedByLabel(resolved, context.scope);
  row.append(source);
  return row;
}
