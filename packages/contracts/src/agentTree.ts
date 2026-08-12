/**
 * Subagent lineage projection.
 *
 * ONE pure reducer turns a session's ordered event stream into the agent
 * tree the UI renders - consumed by the webview Agents lens (over
 * TranscriptLines it already holds) and by the host (over AgentEvents, for
 * session-summary chip counters). Derivable state only: nothing here is a
 * second source of truth, and sessions without lineage data reduce to a
 * root-only tree.
 */

import type { AgentEvent, TranscriptLine } from "./events.js";
import type { JsonObject } from "./json.js";

/**
 * What a transport can report about delegated agents. "full" = per-child
 * event feeds (codex app-server child threads; claude sidechains);
 * "lifecycle" = spawn/status/result only, no child feed (codex exec-json
 * collab_tool_call items); "none" = no signal - the UI must say so rather
 * than render an all-quiet tree.
 */
export type SubagentReportingTier = "full" | "lifecycle" | "none";

const TRANSPORT_TIERS: Readonly<Record<string, SubagentReportingTier>> = {
  "codex-app-server": "full",
  "claude-exec-json": "full",
  "codex-exec-json": "lifecycle"
};

export function subagentReportingForTransport(transport: string): SubagentReportingTier {
  return TRANSPORT_TIERS[transport] ?? "none";
}

/** Sentinel node id for the session's root agent (never a transport id). */
export const ROOT_AGENT_NODE_ID = "root";

export type AgentTreeNodeStatus = "running" | "completed" | "failed" | "cancelled" | "unknown";

export interface AgentTreeCounts {
  readonly toolCalls: number;
  readonly commands: number;
  readonly fileEdits: number;
  readonly errors: number;
}

export interface AgentTreeNode {
  readonly nodeId: string;
  /** Absent on the root node. */
  readonly parentId?: string;
  /** "native" = in-runtime subagent; role sessions add "role-session". */
  readonly kind: "root" | "native";
  readonly label: string;
  readonly subagentType?: string;
  readonly model?: string;
  readonly status: AgentTreeNodeStatus;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly counts: AgentTreeCounts;
  /** Clipped summary of the node's most recent event. */
  readonly lastActivity?: string;
  readonly lastActivityAt?: string;
  readonly lastCommand?: string;
  readonly promptPreview?: string;
  readonly resultPreview?: string;
  readonly usage?: JsonObject;
}

export interface SessionAgentTree {
  /** Root first, then nodes in first-seen order; parents precede children. */
  readonly nodes: readonly AgentTreeNode[];
}

/**
 * Minimal projection the reducer folds - extractable from BOTH input shapes
 * so the tree logic exists exactly once.
 */
export interface AgentTreeSource {
  readonly eventType: string;
  readonly createdAt: string;
  readonly agentPath?: readonly string[];
  readonly nodeId?: string;
  readonly label?: string;
  readonly subagentType?: string;
  readonly model?: string;
  readonly nodeStatus?: "running" | "completed" | "failed" | "cancelled";
  readonly toolStatus?: "started" | "completed" | "failed";
  readonly commandName?: string;
  readonly promptPreview?: string;
  readonly resultPreview?: string;
  readonly usage?: JsonObject;
  readonly summary?: string;
}

export function treeSourceFromEvent(event: AgentEvent): AgentTreeSource {
  const base: AgentTreeSource = {
    eventType: event.type,
    createdAt: event.createdAt,
    ...(event.agentPath === undefined || event.agentPath.length === 0 ? {} : { agentPath: event.agentPath })
  };
  switch (event.type) {
    case "agent.spawn":
      return {
        ...base,
        nodeId: event.nodeId,
        label: event.label,
        ...(event.subagentType === undefined ? {} : { subagentType: event.subagentType }),
        ...(event.model === undefined ? {} : { model: event.model }),
        ...(event.promptPreview === undefined ? {} : { promptPreview: event.promptPreview }),
        summary: `spawned ${event.label}`
      };
    case "agent.node_done":
      return {
        ...base,
        nodeId: event.nodeId,
        nodeStatus: event.status,
        ...(event.resultPreview === undefined ? {} : { resultPreview: event.resultPreview }),
        ...(event.usage === undefined ? {} : { usage: event.usage })
      };
    case "agent.done":
      return { ...base, nodeStatus: event.status, ...(event.usage === undefined ? {} : { usage: event.usage }) };
    case "agent.tool_call":
      return { ...base, toolStatus: event.status, commandName: event.toolName, summary: event.toolName };
    case "agent.command":
      const commandName = commandNameFromArgv(event.command);
      return {
        ...base,
        toolStatus: event.status,
        ...(commandName === undefined ? {} : { commandName }),
        summary: event.command.join(" ")
      };
    case "agent.file_edit":
      return { ...base, summary: `${event.changeKind} ${event.path}` };
    case "agent.error":
      return { ...base, summary: `${event.code}: ${event.message}` };
    case "agent.text":
      return { ...base, summary: event.text };
    case "agent.plan":
      return { ...base, summary: event.text };
    default:
      return base;
  }
}

export function treeSourceFromLine(line: TranscriptLine): AgentTreeSource {
  return {
    eventType: line.eventType,
    createdAt: line.createdAt,
    ...(line.agentPath === undefined || line.agentPath.length === 0 ? {} : { agentPath: line.agentPath }),
    ...(line.nodeId === undefined ? {} : { nodeId: line.nodeId }),
    ...(line.label === undefined ? {} : { label: line.label }),
    ...(line.subagentType === undefined ? {} : { subagentType: line.subagentType }),
    ...(line.model === undefined ? {} : { model: line.model }),
    ...(line.nodeStatus === undefined || line.nodeStatus === "running" ? {} : { nodeStatus: line.nodeStatus }),
    ...(line.toolStatus === undefined ? {} : { toolStatus: line.toolStatus }),
    ...(line.commandName === undefined ? {} : { commandName: line.commandName }),
    // Line `detail` is the spawn prompt on agent.spawn and the result on
    // agent.node_done - route it back to the field the reducer expects.
    ...(line.eventType === "agent.spawn" && line.detail !== undefined ? { promptPreview: line.detail } : {}),
    ...(line.eventType === "agent.node_done" && line.detail !== undefined ? { resultPreview: line.detail } : {}),
    ...(line.usage === undefined ? {} : { usage: line.usage }),
    summary: line.summary
  };
}

const LAST_ACTIVITY_MAX = 120;

interface MutableNode {
  nodeId: string;
  parentId?: string;
  kind: "root" | "native";
  label: string;
  subagentType?: string;
  model?: string;
  status: AgentTreeNodeStatus;
  startedAt?: string;
  endedAt?: string;
  toolCalls: number;
  commands: number;
  fileEdits: number;
  errors: number;
  lastActivity?: string;
  lastActivityAt?: string;
  lastCommand?: string;
  promptPreview?: string;
  resultPreview?: string;
  usage?: JsonObject;
}

/**
 * Folds ordered sources into the tree. Resilient by construction: activity
 * on a never-spawned path synthesizes placeholder nodes (ancestors included)
 * rather than dropping or misattributing; duplicate spawns merge; a terminal
 * node status never downgrades. When the ROOT is terminal, children still
 * "running" are reported "unknown" - the stream ended without telling us.
 */
export function reduceAgentTree(sources: Iterable<AgentTreeSource>): SessionAgentTree {
  const nodes = new Map<string, MutableNode>();
  const order: string[] = [];

  const upsert = (nodeId: string, parentId: string | undefined, createdAt: string): MutableNode => {
    const existing = nodes.get(nodeId);
    if (existing) return existing;
    const created: MutableNode = {
      nodeId,
      ...(parentId === undefined ? {} : { parentId }),
      kind: nodeId === ROOT_AGENT_NODE_ID ? "root" : "native",
      label: nodeId === ROOT_AGENT_NODE_ID ? "agent" : `agent ${nodeId.slice(-8)}`,
      status: "running",
      startedAt: createdAt,
      toolCalls: 0,
      commands: 0,
      fileEdits: 0,
      errors: 0
    };
    nodes.set(nodeId, created);
    order.push(nodeId);
    return created;
  };

  /** Materializes every ancestor on a path; returns the path's leaf node. */
  const nodeForPath = (path: readonly string[] | undefined, createdAt: string): MutableNode => {
    let parentId = ROOT_AGENT_NODE_ID;
    upsert(ROOT_AGENT_NODE_ID, undefined, createdAt);
    for (const step of path ?? []) {
      upsert(step, parentId, createdAt);
      parentId = step;
    }
    return nodes.get(parentId) as MutableNode;
  };

  for (const source of sources) {
    // User prompts aren't agent activity; folding them would make the root's
    // "last activity" echo the user's own text.
    if (source.eventType === "user.message") continue;
    const emitter = nodeForPath(source.agentPath, source.createdAt);

    if (source.eventType === "agent.spawn" && source.nodeId !== undefined) {
      const child = upsert(source.nodeId, emitter.nodeId, source.createdAt);
      if (source.label !== undefined) child.label = source.label;
      if (source.subagentType !== undefined) child.subagentType = source.subagentType;
      if (source.model !== undefined) child.model = source.model;
      if (source.promptPreview !== undefined) child.promptPreview = source.promptPreview;
      child.lastActivity = source.summary ?? `spawned ${child.label}`;
      child.lastActivityAt = source.createdAt;
      continue;
    }

    if (source.eventType === "agent.node_done" && source.nodeId !== undefined) {
      const child = upsert(source.nodeId, emitter.nodeId, source.createdAt);
      if (child.status === "running" && source.nodeStatus !== undefined) {
        child.status = source.nodeStatus;
        child.endedAt = source.createdAt;
      }
      if (source.resultPreview !== undefined) child.resultPreview = source.resultPreview;
      if (source.usage !== undefined) child.usage = source.usage;
      child.lastActivity = source.resultPreview ?? `subagent ${source.nodeStatus ?? "done"}`;
      child.lastActivityAt = source.createdAt;
      continue;
    }

    if (source.eventType === "agent.done") {
      if (emitter.status === "running" && source.nodeStatus !== undefined) {
        emitter.status = source.nodeStatus;
        emitter.endedAt = source.createdAt;
      }
      if (source.usage !== undefined && emitter.usage === undefined) emitter.usage = source.usage;
      emitter.lastActivityAt = source.createdAt;
      continue;
    }

    // Ordinary activity, attributed to the emitting node.
    if (source.eventType === "agent.tool_call" && source.toolStatus === "started") emitter.toolCalls += 1;
    if (source.eventType === "agent.command" && source.toolStatus === "started") emitter.commands += 1;
    if ((source.eventType === "agent.tool_call" || source.eventType === "agent.command") && source.commandName !== undefined) {
      emitter.lastCommand = source.commandName;
    }
    if (source.eventType === "agent.file_edit") emitter.fileEdits += 1;
    if (source.eventType === "agent.error") emitter.errors += 1;
    if (source.summary !== undefined && source.summary.length > 0) {
      emitter.lastActivity = source.summary.length > LAST_ACTIVITY_MAX
        ? `${source.summary.slice(0, LAST_ACTIVITY_MAX)}…`
        : source.summary;
      emitter.lastActivityAt = source.createdAt;
    }
  }

  const root = nodes.get(ROOT_AGENT_NODE_ID);
  const rootTerminal = root !== undefined && root.status !== "running";

  return {
    nodes: order.map((nodeId) => {
      const node = nodes.get(nodeId) as MutableNode;
      const status: AgentTreeNodeStatus =
        rootTerminal && node.kind !== "root" && node.status === "running" ? "unknown" : node.status;
      return {
        nodeId: node.nodeId,
        ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
        kind: node.kind,
        label: node.label,
        ...(node.subagentType === undefined ? {} : { subagentType: node.subagentType }),
        ...(node.model === undefined ? {} : { model: node.model }),
        status,
        ...(node.startedAt === undefined ? {} : { startedAt: node.startedAt }),
        ...(node.endedAt === undefined ? {} : { endedAt: node.endedAt }),
        counts: {
          toolCalls: node.toolCalls,
          commands: node.commands,
          fileEdits: node.fileEdits,
          errors: node.errors
        },
        ...(node.lastActivity === undefined ? {} : { lastActivity: node.lastActivity }),
        ...(node.lastActivityAt === undefined ? {} : { lastActivityAt: node.lastActivityAt }),
        ...(node.lastCommand === undefined ? {} : { lastCommand: node.lastCommand }),
        ...(node.promptPreview === undefined ? {} : { promptPreview: node.promptPreview }),
        ...(node.resultPreview === undefined ? {} : { resultPreview: node.resultPreview }),
        ...(node.usage === undefined ? {} : { usage: node.usage })
      };
    })
  };
}

/**
 * Total token count from a provider-reported usage object, or null when the
 * shape is unrecognized. Providers report either `{totalTokens}` (codex
 * per-thread totals) or `{total: {totalTokens}}` (turn-final usage) - ONE
 * reader here so every surface prices a node identically.
 */
export function usageTokens(usage: unknown): number | null {
  if (typeof usage !== "object" || usage === null) return null;
  const record = usage as Record<string, unknown>;
  if (typeof record["totalTokens"] === "number") return record["totalTokens"];
  const total = record["total"];
  if (typeof total === "object" && total !== null && typeof (total as Record<string, unknown>)["totalTokens"] === "number") {
    return (total as Record<string, unknown>)["totalTokens"] as number;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fleet row lines (UX overhaul P5)
// ---------------------------------------------------------------------------

/**
 * The Agents panel's flat list carries ONE live line per row. The host derives
 * it for the snapshot (it can see questions, changesets and stored status);
 * the webview re-derives it when an activity push lands mid-turn. Both call
 * the functions below, so a pushed row and a refetched row cannot disagree.
 *
 * `AgentsOverviewState.sessionLines` carries these on the `agents.state`
 * snapshot.
 */
export interface AgentsSessionLine {
  readonly sessionId: string;
  /** ONE live line: pending question → posture → command → output → status. */
  readonly activityLine?: string;
  /** Terminal one-liner for done/failed rows (changed files, else last output). */
  readonly resultLine?: string;
  /** An unlanded changeset waits on this session: the row offers Land changes. */
  readonly landable?: boolean;
}

/**
 * The root-agent facts the line derivations read - a structural subset of
 * `AgentActivityItem`, so callers pass `activity.root` straight through
 * without this module depending on the webview message contracts.
 */
export interface FleetRootActivity {
  readonly status?: string;
  readonly lastCommand?: string;
  readonly lastActivity?: string;
}

/** The session facts `fleetActivityLine` reads (subset of ChatSessionSummary + pendings). */
export interface FleetActivityLineInput {
  /** Durable ChatSessionStatus: starting | active | ended | failed. */
  readonly status: string;
  readonly live?: boolean;
  readonly runningElsewhere?: boolean;
  /** Verbatim text of the oldest pending question on this session. */
  readonly pendingQuestion?: string;
  /** A pending workspace-access request waits on the user. */
  readonly pendingAccess?: boolean;
  /** This session's root-agent fold for the current (or last) turn. */
  readonly root?: FleetRootActivity;
  /** User-authored session note - the last thing tried before a status phrase. */
  readonly description?: string;
}

/** Output/command lines are clipped here so a row never ships a paragraph. */
const FLEET_LINE_MAX = 80;

function clipLine(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > FLEET_LINE_MAX ? `${collapsed.slice(0, FLEET_LINE_MAX)}…` : collapsed;
}

/**
 * The row's one live line. Order is deliberate: a question the user must
 * answer outranks everything; an honest posture (running elsewhere, still
 * booting) outranks a local fold that is not authoritative (ADR 0008); then
 * the current command, the latest output, and finally a stored phrase.
 * Elapsed is NOT baked in - it ticks in the row's right column, where it
 * cannot go stale between pushes.
 */
export function fleetActivityLine(input: FleetActivityLineInput): string | undefined {
  const question = input.pendingQuestion?.replace(/\s+/g, " ").trim();
  if (question !== undefined && question.length > 0) return `? ${question}`;
  if (input.pendingAccess === true) return "? waiting on a workspace access decision";
  if (input.runningElsewhere === true) return "running in another window - view only";
  if (input.status === "starting") return "resuming - recreating the runtime and clones";
  const root = input.root;
  const command = root?.lastCommand?.trim();
  if (command !== undefined && command.length > 0) return `$ ${clipLine(command)}`;
  const activity = root?.lastActivity?.trim();
  if (activity !== undefined && activity.length > 0) return clipLine(activity);
  const description = input.description?.trim();
  if (description !== undefined && description.length > 0) return clipLine(description);
  if (input.status === "failed") return "the last turn failed";
  if (input.status === "ended") return undefined;
  return input.live === true ? "no activity this turn yet" : "not running - open the chat to resume";
}

/** The facts `fleetResultLine` reads for a settled row. */
export interface FleetResultLineInput {
  readonly status: string;
  /** Files an unlanded changeset captured for this session. */
  readonly changedFiles?: number;
  /** Repos those files span (>1 is worth saying). */
  readonly changedRepos?: number;
  /** The root fold's last reported line, when no changeset exists. */
  readonly lastActivity?: string;
}

/**
 * The line a done/failed row collapses to. Changed-file counts win when a
 * changeset waits - that is the thing the user acts on - otherwise the last
 * reported output stands in. Live rows get nothing (their activity line is
 * the truth).
 */
export function fleetResultLine(input: FleetResultLineInput): string | undefined {
  if (input.status !== "ended" && input.status !== "failed") return undefined;
  const files = input.changedFiles;
  if (files !== undefined && files > 0) {
    const repos = input.changedRepos ?? 1;
    const spread = repos > 1 ? ` across ${String(repos)} repos` : "";
    return `${String(files)} file${files === 1 ? "" : "s"} changed${spread} - not landed`;
  }
  const activity = input.lastActivity?.trim();
  if (activity !== undefined && activity.length > 0) return clipLine(activity);
  return input.status === "failed" ? "the last turn failed" : "ended with nothing reported";
}

function commandNameFromArgv(command: readonly string[]): string | undefined {
  const raw = commandFromShell(command) ?? command[0];
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  const unquoted = trimmed.replace(/^["']+|["']+$/g, "");
  return /^([^\s;&|]+)/.exec(unquoted)?.[1];
}

function commandFromShell(command: readonly string[]): string | undefined {
  const executable = command[0]?.toLowerCase();
  if (executable === undefined) return undefined;
  if (executable === "bash" || executable === "sh" || executable === "zsh") {
    const index = command.findIndex((part) => part === "-c" || part === "-lc");
    return index >= 0 ? command[index + 1] : undefined;
  }
  if (executable === "pwsh" || executable === "powershell" || executable === "powershell.exe") {
    const index = command.findIndex((part) => {
      const normalized = part.toLowerCase();
      return normalized === "-command" || normalized === "-c";
    });
    return index >= 0 ? command[index + 1] : undefined;
  }
  if (executable === "cmd" || executable === "cmd.exe") {
    const index = command.findIndex((part) => part.toLowerCase() === "/c");
    return index >= 0 ? command[index + 1] : undefined;
  }
  return undefined;
}
