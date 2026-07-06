/**
 * Subagent lineage projection.
 *
 * ONE pure reducer turns a session's ordered event stream into the agent
 * tree the UI renders — consumed by the webview Agents lens (over
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
 * collab_tool_call items); "none" = no signal — the UI must say so rather
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
  readonly promptPreview?: string;
  readonly resultPreview?: string;
  readonly usage?: JsonObject;
}

export interface SessionAgentTree {
  /** Root first, then nodes in first-seen order; parents precede children. */
  readonly nodes: readonly AgentTreeNode[];
}

/**
 * Minimal projection the reducer folds — extractable from BOTH input shapes
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
      return { ...base, toolStatus: event.status, summary: event.toolName };
    case "agent.command":
      return { ...base, toolStatus: event.status, summary: event.command.join(" ") };
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
    ...(line.nodeStatus === undefined || line.nodeStatus === "running" ? {} : { nodeStatus: line.nodeStatus }),
    ...(line.toolStatus === undefined ? {} : { toolStatus: line.toolStatus }),
    // Line `detail` is the spawn prompt on agent.spawn and the result on
    // agent.node_done — route it back to the field the reducer expects.
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
  promptPreview?: string;
  resultPreview?: string;
  usage?: JsonObject;
}

/**
 * Folds ordered sources into the tree. Resilient by construction: activity
 * on a never-spawned path synthesizes placeholder nodes (ancestors included)
 * rather than dropping or misattributing; duplicate spawns merge; a terminal
 * node status never downgrades. When the ROOT is terminal, children still
 * "running" are reported "unknown" — the stream ended without telling us.
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
      continue;
    }

    if (source.eventType === "agent.done") {
      if (emitter.status === "running" && source.nodeStatus !== undefined) {
        emitter.status = source.nodeStatus;
        emitter.endedAt = source.createdAt;
      }
      if (source.usage !== undefined && emitter.usage === undefined) emitter.usage = source.usage;
      continue;
    }

    // Ordinary activity, attributed to the emitting node.
    if (source.eventType === "agent.tool_call" && source.toolStatus === "started") emitter.toolCalls += 1;
    if (source.eventType === "agent.command" && source.toolStatus === "started") emitter.commands += 1;
    if (source.eventType === "agent.file_edit") emitter.fileEdits += 1;
    if (source.eventType === "agent.error") emitter.errors += 1;
    if (source.summary !== undefined && source.summary.length > 0) {
      emitter.lastActivity = source.summary.length > LAST_ACTIVITY_MAX
        ? `${source.summary.slice(0, LAST_ACTIVITY_MAX)}…`
        : source.summary;
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
        ...(node.promptPreview === undefined ? {} : { promptPreview: node.promptPreview }),
        ...(node.resultPreview === undefined ? {} : { resultPreview: node.resultPreview }),
        ...(node.usage === undefined ? {} : { usage: node.usage })
      };
    })
  };
}
