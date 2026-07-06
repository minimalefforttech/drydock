/**
 * Codex event normalization.
 *
 * Raw Codex JSONL is mapped immediately into product events so storage and UI
 * do not depend on provider-specific stream fragments.
 */

import type {
  AgentCommandEvent,
  AgentDoneEvent,
  AgentEvent,
  AgentEventBase,
  AgentFileEditEvent,
  AgentNodeDoneEvent,
  AgentSpawnEvent,
  AgentTextEvent,
  AgentToolCallEvent,
  AgentRole,
  EventId,
  JsonObject,
  JsonValue,
  RunId,
  RuntimeId,
  SessionId
} from "@drydock/contracts";
import type { Clock, IdGenerator } from "@drydock/core";
import {
  capPreview,
  NODE_RESULT_PREVIEW_MAX,
  SPAWN_PROMPT_PREVIEW_MAX,
  spawnLabel,
  terminalStatusFrom
} from "./codexThreadLineage.js";

export interface NormalizerContext {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly agentRole: AgentRole;
  readonly runtimeId?: RuntimeId;
}

export class CodexEventNormalizer {
  constructor(private readonly ids: IdGenerator, private readonly clock: Clock) {}

  normalize(raw: JsonObject, context: NormalizerContext): AgentEvent[] {
    const type = stringValue(raw["type"]);
    const item = objectValue(raw["item"]);

    if (type === "item.completed" && stringValue(item?.["type"]) === "agent_message") {
      const text = stringValue(item?.["text"]) ?? JSON.stringify(item);
      return [this.textEvent(context, text, true, raw)];
    }

    if ((type === "item.started" || type === "item.completed") && stringValue(item?.["type"]) === "command_execution") {
      return [this.commandEvent(context, item, type === "item.started" ? "started" : "completed", raw)];
    }

    // Lifecycle-tier subagent visibility: exec --json surfaces the
    // parent's collab tool calls only — spawn edges + per-child status/result
    // via agents_states, never per-child feeds (probe 2026-07-05).
    if (type === "item.completed" && stringValue(item?.["type"]) === "collab_tool_call") {
      return this.collabEvents(context, item as JsonObject, raw);
    }

    if ((type === "item.started" || type === "item.completed") && stringValue(item?.["type"]) === "web_search") {
      return [this.webSearchEvent(context, item as JsonObject, type === "item.started" ? "started" : "completed", raw)];
    }

    if (stringValue(item?.["type"]) === "file_change") {
      return this.fileEvents(context, item, raw);
    }

    if (type === "turn.completed") {
      const usage = objectValue(raw["usage"]);
      return [this.doneEvent(context, "completed", usage, raw)];
    }

    if (type === "turn.failed" || type === "error") {
      return [
        {
          ...this.base("agent.error", context, raw),
          type: "agent.error",
          code: stringValue(raw["code"]) ?? "CODEX_TURN_FAILED",
          message: stringValue(raw["message"]) ?? JSON.stringify(raw),
          retryable: false
        },
        this.doneEvent(context, "failed", undefined, raw)
      ];
    }

    return [];
  }

  parseJsonLines(stdout: string, context: NormalizerContext): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const raw = JSON.parse(trimmed) as JsonValue;
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          events.push(...this.normalize(raw, context));
        }
      } catch {
        // Raw non-JSON output is retained by command diagnostics, not event replay.
      }
    }
    return ensureTerminalEvent(events, context, this);
  }

  doneEvent(context: NormalizerContext, status: AgentDoneEvent["status"], usage: JsonObject | undefined, raw: JsonObject): AgentDoneEvent {
    return {
      ...this.base("agent.done", context, raw),
      type: "agent.done",
      status,
      ...(usage === undefined ? {} : { usage })
    };
  }

  /**
   * Exec collab items: spawn_agent completions carry receiver_thread_ids;
   * wait/close completions carry agents_states {threadId → {status, message}}.
   * Everything is emitted by the ROOT agent (depth-1 on this transport), so
   * spawn/node_done events carry no agentPath and node parents default to
   * root. Terminal states are deduped per child within one parse pass — the
   * same child appears in wait AND close_agent states (probe fact).
   */
  private readonly terminalChildIds = new Set<string>();

  private collabEvents(context: NormalizerContext, item: JsonObject, raw: JsonObject): AgentEvent[] {
    if (stringValue(item["status"]) !== "completed") return [];
    const events: AgentEvent[] = [];
    const tool = stringValue(item["tool"]);

    if (tool === "spawn_agent" || tool === "spawnAgent") {
      const prompt = stringValue(item["prompt"]);
      const model = stringValue(item["model"]);
      const receivers = item["receiver_thread_ids"] ?? item["receiverThreadIds"];
      for (const receiver of Array.isArray(receivers) ? receivers : []) {
        if (typeof receiver !== "string") continue;
        events.push({
          ...this.base("agent.spawn", context, raw),
          type: "agent.spawn",
          nodeId: receiver,
          label: spawnLabel(prompt, receiver),
          ...(model === null ? {} : { model }),
          ...(prompt === null ? {} : { promptPreview: capPreview(prompt, SPAWN_PROMPT_PREVIEW_MAX) })
        } satisfies AgentSpawnEvent);
      }
    }

    const states = objectValue(item["agents_states"] ?? item["agentsStates"]);
    if (states !== undefined) {
      for (const [childThreadId, stateValue] of Object.entries(states)) {
        const state = objectValue(stateValue);
        if (state === undefined) continue;
        const status = terminalStatusFrom(stringValue(state["status"]));
        if (status === null) continue;
        if (this.terminalChildIds.has(childThreadId)) continue;
        this.terminalChildIds.add(childThreadId);
        const message = stringValue(state["message"]);
        events.push({
          ...this.base("agent.node_done", context, raw),
          type: "agent.node_done",
          nodeId: childThreadId,
          status,
          ...(message === null ? {} : { resultPreview: capPreview(message, NODE_RESULT_PREVIEW_MAX) })
        } satisfies AgentNodeDoneEvent);
      }
    }
    return events;
  }

  private webSearchEvent(
    context: NormalizerContext,
    item: JsonObject,
    status: AgentToolCallEvent["status"],
    raw: JsonObject
  ): AgentToolCallEvent {
    const query = stringValue(item["query"]);
    const toolUseId = stringValue(item["id"]);
    return {
      ...this.base("agent.tool_call", context, raw),
      type: "agent.tool_call",
      toolName: "web_search",
      status,
      ...(toolUseId === null ? {} : { toolUseId }),
      ...(query === null || query.length === 0 ? {} : { input: { query } }),
      ...(status === "completed" && query !== null && query.length > 0 ? { output: query } : {})
    };
  }

  private textEvent(context: NormalizerContext, text: string, final: boolean, raw: JsonObject): AgentTextEvent {
    return {
      ...this.base("agent.text", context, raw),
      type: "agent.text",
      text,
      final
    };
  }

  private commandEvent(
    context: NormalizerContext,
    item: JsonObject | undefined,
    status: AgentCommandEvent["status"],
    raw: JsonObject
  ): AgentCommandEvent {
    const commandText = stringValue(item?.["command"]) ?? stringValue(item?.["cmd"]) ?? "unknown";
    const exitCodeValue = numberValue(item?.["exit_code"]) ?? numberValue(item?.["exitCode"]);
    return {
      ...this.base("agent.command", context, raw),
      type: "agent.command",
      command: [commandText],
      status,
      ...(exitCodeValue === undefined ? {} : { exitCode: exitCodeValue }),
      ...(stringValue(item?.["output"]) === null ? {} : { output: stringValue(item?.["output"]) ?? "" })
    };
  }

  private fileEvents(context: NormalizerContext, item: JsonObject | undefined, raw: JsonObject): AgentFileEditEvent[] {
    const changes = item?.["changes"];
    if (!Array.isArray(changes)) {
      return [];
    }
    return changes.flatMap((change): AgentFileEditEvent[] => {
      if (!change || typeof change !== "object" || Array.isArray(change)) return [];
      const changeObject = change as JsonObject;
      const path = stringValue(changeObject["path"]) ?? stringValue(changeObject["file"]) ?? stringValue(changeObject["relativePath"]);
      const kind = extractChangeKind(changeObject["kind"]);
      if (!path || !kind) return [];
      return [{
        ...this.base("agent.file_edit", context, raw),
        type: "agent.file_edit",
        path,
        changeKind: kind
      }];
    });
  }

  private base(type: AgentEventBase["type"], context: NormalizerContext, raw: JsonObject): AgentEventBase {
    return {
      id: this.ids.eventId() as EventId,
      type,
      sessionId: context.sessionId,
      runId: context.runId,
      agentRole: context.agentRole,
      ...(context.runtimeId === undefined ? {} : { runtimeId: context.runtimeId }),
      createdAt: this.clock.isoNow(),
      raw
    };
  }
}

function ensureTerminalEvent(events: AgentEvent[], context: NormalizerContext, normalizer: CodexEventNormalizer): AgentEvent[] {
  if (events.some((event) => event.type === "agent.done")) {
    return events;
  }
  return [...events, normalizer.doneEvent(context, "completed", undefined, { synthetic: true })];
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function stringValue(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function extractChangeKind(value: JsonValue | undefined): AgentFileEditEvent["changeKind"] | null {
  const raw = typeof value === "string"
    ? value
    : value && typeof value === "object" && !Array.isArray(value) && typeof value["type"] === "string"
      ? value["type"]
      : null;
  if (raw === "add" || raw === "update" || raw === "delete" || raw === "rename" || raw === "metadata") {
    return raw;
  }
  return null;
}

