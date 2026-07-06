/**
 * Normalized event contracts.
 *
 * Adapter-specific streams are converted to these events before storage or UI
 * sees them.
 */

import type { AgentId, AgentRole, EventId, RunId, RuntimeId, SessionId } from "./ids.js";
import type { JsonObject, JsonValue } from "./json.js";

export interface AgentEventBase {
  readonly id: EventId;
  readonly type: string;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly agentId?: AgentId;
  readonly agentRole: AgentRole;
  readonly runtimeId?: RuntimeId;
  readonly createdAt: string;
  /**
   * Lineage of the EMITTING agent inside the session. Absent/empty =
   * the session's root agent; ["n1","n2"] = sub-subagent n2 under subagent
   * n1. Node ids are transport-scoped (codex: child thread id; claude: the
   * spawning Task tool_use id) — opaque here, unique within the session.
   */
  readonly agentPath?: readonly string[];
  readonly raw?: JsonObject;
}

export interface AgentTextEvent extends AgentEventBase {
  readonly type: "agent.text";
  readonly text: string;
  readonly final: boolean;
}

export interface AgentToolCallEvent extends AgentEventBase {
  readonly type: "agent.tool_call";
  readonly toolName: string;
  readonly status: "started" | "completed" | "failed";
  /**
   * Transport-scoped call id pairing a completion with its start (claude
   * tool_use.id; codex item id). Lets one logical call arrive as two events.
   */
  readonly toolUseId?: string;
  readonly input?: JsonValue;
  readonly output?: string;
}

export interface AgentCommandEvent extends AgentEventBase {
  readonly type: "agent.command";
  readonly command: readonly string[];
  readonly status: "started" | "completed" | "failed";
  readonly exitCode?: number;
  readonly output?: string;
}

export interface AgentFileEditEvent extends AgentEventBase {
  readonly type: "agent.file_edit";
  readonly path: string;
  readonly changeKind: "add" | "update" | "delete" | "rename" | "metadata";
}

export interface AgentPlanEvent extends AgentEventBase {
  readonly type: "agent.plan";
  readonly text: string;
  readonly items?: readonly string[];
}

export interface AgentErrorEvent extends AgentEventBase {
  readonly type: "agent.error";
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface AgentDoneEvent extends AgentEventBase {
  readonly type: "agent.done";
  readonly status: "completed" | "failed" | "cancelled";
  readonly usage?: JsonObject;
}

/**
 * A recognized delegation: the emitting agent (base.agentPath) spawned a
 * child agent. The child's own events carry agentPath = [...parent, nodeId].
 * Previews are normalizer-capped (prompt ≤ 500 chars) — never full payloads.
 */
export interface AgentSpawnEvent extends AgentEventBase {
  readonly type: "agent.spawn";
  readonly nodeId: string;
  readonly label: string;
  readonly subagentType?: string;
  readonly model?: string;
  readonly promptPreview?: string;
}

/**
 * A spawned agent reached a terminal state. Convention (mirrors agent.spawn):
 * base.agentPath is the PARENT's path; `nodeId` names the finished child.
 * `usage` is attached where the transport reports per-child cost (codex
 * per-thread token usage); `resultPreview` is normalizer-capped (≤ 1 KB).
 */
export interface AgentNodeDoneEvent extends AgentEventBase {
  readonly type: "agent.node_done";
  readonly nodeId: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly resultPreview?: string;
  readonly usage?: JsonObject;
}

export type AgentEvent =
  | AgentTextEvent
  | AgentToolCallEvent
  | AgentCommandEvent
  | AgentFileEditEvent
  | AgentPlanEvent
  | AgentErrorEvent
  | AgentDoneEvent
  | AgentSpawnEvent
  | AgentNodeDoneEvent;

export interface StoredEvent {
  readonly id: EventId;
  readonly sessionId: SessionId;
  readonly runId?: RunId;
  readonly eventType: string;
  readonly createdAt: string;
  readonly payload: JsonObject;
  /** Monotonic store-assigned replay position; absent on events not yet persisted. */
  readonly sequence?: number;
}

/** One display-ready transcript row projected from a normalized event. */
export interface TranscriptLine {
  readonly eventType: string;
  readonly createdAt: string;
  readonly summary: string;
  /** Runtime-side path, present only for agent.file_edit lines. */
  readonly filePath?: string;
  readonly fileChangeKind?: string;
  /** Lineage of the emitting agent; absent/empty = root agent. */
  readonly agentPath?: readonly string[];
  /** Spawned/finished node id, present on agent.spawn / agent.node_done lines. */
  readonly nodeId?: string;
  /** Child label, present on agent.spawn lines. */
  readonly label?: string;
  /**
   * Node lifecycle carried structurally: "running" on spawn, the terminal
   * status on node_done, and the ROOT agent's terminal status on agent.done.
   */
  readonly nodeStatus?: "running" | "completed" | "failed" | "cancelled";
  /** Call status on agent.tool_call / agent.command lines (drives counts + spinners). */
  readonly toolStatus?: "started" | "completed" | "failed";
  /** Capped payload preview (tool output, spawn prompt, node result) behind a disclosure. */
  readonly detail?: string;
  /** Token usage on agent.done / agent.node_done lines, where the transport reports it. */
  readonly usage?: JsonObject;
}

const TRANSCRIPT_SUMMARY_MAX = 400;

/**
 * Shared presentation projection for every UI surface (output channel,
 * webview transcript). Exhaustive over the event union so new event types
 * fail compilation instead of rendering blank.
 */
export function summarizeAgentEvent(event: AgentEvent): TranscriptLine {
  switch (event.type) {
    case "agent.text":
      return transcriptLine(event, event.text);
    case "agent.tool_call":
      return {
        ...transcriptLine(event, `${event.toolName} ${event.status}${event.output === undefined ? "" : `: ${event.output}`}`),
        toolStatus: event.status,
        ...(event.output === undefined ? {} : { detail: event.output })
      };
    case "agent.command":
      return {
        ...transcriptLine(
          event,
          `${event.command.join(" ")} [${event.status}${event.exitCode === undefined ? "" : ` exit ${String(event.exitCode)}`}]`
        ),
        toolStatus: event.status,
        ...(event.output === undefined ? {} : { detail: event.output })
      };
    case "agent.file_edit":
      return {
        ...transcriptLine(event, `${event.changeKind} ${event.path}`),
        filePath: event.path,
        fileChangeKind: event.changeKind
      };
    case "agent.plan":
      return transcriptLine(event, event.items && event.items.length > 0 ? `${event.text} (${String(event.items.length)} steps)` : event.text);
    case "agent.error":
      return transcriptLine(event, `${event.code}: ${event.message}`);
    case "agent.done":
      return {
        ...transcriptLine(event, `done: ${event.status}`),
        nodeStatus: event.status,
        ...(event.usage === undefined ? {} : { usage: event.usage })
      };
    case "agent.spawn":
      return {
        ...transcriptLine(event, `spawned ${event.label}${event.subagentType === undefined ? "" : ` (${event.subagentType})`}`),
        nodeId: event.nodeId,
        label: event.label,
        nodeStatus: "running",
        ...(event.promptPreview === undefined ? {} : { detail: event.promptPreview })
      };
    case "agent.node_done":
      return {
        ...transcriptLine(event, `subagent ${event.status}${event.resultPreview === undefined ? "" : `: ${event.resultPreview}`}`),
        nodeId: event.nodeId,
        nodeStatus: event.status,
        ...(event.resultPreview === undefined ? {} : { detail: event.resultPreview }),
        ...(event.usage === undefined ? {} : { usage: event.usage })
      };
    default:
      return assertNever(event);
  }
}

export function summarizeStoredEvent(event: StoredEvent): TranscriptLine {
  if (event.eventType === "user.message") {
    const text = event.payload["text"];
    return {
      eventType: "user.message",
      createdAt: event.createdAt,
      summary: clipSummary(typeof text === "string" ? text : "")
    };
  }
  return summarizeAgentEvent(event.payload as unknown as AgentEvent);
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}

function transcriptLine(event: AgentEvent, summary: string): TranscriptLine {
  return {
    eventType: event.type,
    createdAt: event.createdAt,
    summary: clipSummary(summary),
    ...(event.agentPath === undefined || event.agentPath.length === 0 ? {} : { agentPath: event.agentPath })
  };
}

function clipSummary(summary: string): string {
  return summary.length > TRANSCRIPT_SUMMARY_MAX
    ? `${summary.slice(0, TRANSCRIPT_SUMMARY_MAX)}…`
    : summary;
}
