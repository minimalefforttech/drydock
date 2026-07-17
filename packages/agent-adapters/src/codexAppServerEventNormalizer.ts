/**
 * Codex app-server notification normalization.
 *
 * The app-server surface emits JSON-RPC notifications. This mapper keeps those
 * provider-specific shapes at the adapter boundary and projects the notification
 * families validated in Stage 0/1 into the product `AgentEvent` model.
 */

import type {
  AgentCommandEvent,
  AgentDoneEvent,
  AgentEvent,
  AgentEventBase,
  AgentFileEditEvent,
  AgentNodeDoneEvent,
  AgentPlanEvent,
  AgentReasoningEvent,
  AgentRole,
  AgentSpawnEvent,
  AgentToolCallEvent,
  JsonObject,
  JsonValue,
  RunId,
  RuntimeId,
  SessionId
} from "@drydock/contracts";
import type { Clock, IdGenerator } from "@drydock/core";
import type { JsonRpcMessage } from "./jsonRpcClient.js";
import {
  capPreview,
  CodexThreadLineage,
  NODE_RESULT_PREVIEW_MAX,
  SPAWN_PROMPT_PREVIEW_MAX,
  spawnLabel,
  terminalStatusFrom
} from "./codexThreadLineage.js";
import { TOOL_OUTPUT_PREVIEW_MAX } from "./previewCaps.js";

export interface AppServerNormalizerContext {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly agentRole: AgentRole;
  readonly runtimeId?: RuntimeId;
  /**
   * Thread lineage for the session. Absent = legacy single-thread
   * behavior: no attribution, every turn/completed ends the run.
   */
  readonly lineage?: CodexThreadLineage;
}

export class CodexAppServerEventNormalizer {
  constructor(private readonly ids: IdGenerator, private readonly clock: Clock) {}

  normalize(message: JsonRpcMessage, context: AppServerNormalizerContext): AgentEvent[] {
    const method = message.method ?? "";
    const params = objectValue(message.params);
    const raw = messageToRaw(message);
    const threadId = textFrom(params, ["threadId", "thread_id"]) ?? undefined;
    // Emitting agent's lineage: [] = root; undefined only when lineage is off.
    const path = context.lineage?.attributionFor(threadId);

    switch (method) {
      case "item/agentMessage/delta": {
        const text = textFrom(params, ["delta", "text", "content"]);
        return text === null ? [] : [this.textEvent(context, text, false, raw, path)];
      }
      // NOTE: the method string "item/reasoning/delta" is inferred from the
      // "item/agentMessage/delta" pattern plus the schema's `reasoning` item
      // type - not yet confirmed against a live app-server stream. If the
      // real method name differs, this case simply never matches and
      // reasoning falls through to `default: return []` as it does today
      // (no regression, just no reasoning captured until confirmed).
      case "item/reasoning/delta": {
        const text = textFrom(params, ["delta", "text", "content"]);
        return text === null ? [] : [this.reasoningEvent(context, text, raw, path)];
      }
      case "item/plan/delta": {
        const text = textFrom(params, ["delta", "text", "content"]);
        return text === null ? [] : [this.planEvent(context, text, raw, path)];
      }
      case "turn/plan/updated": {
        return [this.planEvent(context, textFrom(params, ["plan", "text", "summary"]) ?? compactJson(params), raw, path)];
      }
      case "item/started":
        return this.itemStarted(params, context, raw, path);
      case "item/completed":
        return this.itemCompleted(params, context, raw, threadId, path);
      case "item/fileChange/patchUpdated":
      case "turn/diff/updated":
      case "fs/changed":
        return this.fileEvents(params, context, raw, path);
      case "process/outputDelta": {
        const output = textFrom(params, ["delta", "text", "output"]);
        return output === null ? [] : [this.commandEvent(context, params, "completed", raw, path, output)];
      }
      case "process/exited": {
        const exitCode = numberFrom(params, ["exitCode", "exit_code", "code"]);
        const status: AgentCommandEvent["status"] = exitCode === 0 ? "completed" : "failed";
        return [this.commandEvent(context, params, status, raw, path)];
      }
      case "thread/tokenUsage/updated": {
        // Held per thread and attached to the child's terminal event; a live
        // per-node ticker is deferred (design doc).
        if (context.lineage !== undefined && threadId !== undefined) {
          const usage = objectValue(params?.["tokenUsage"]) ?? objectValue(params?.["usage"]);
          const total = objectValue(usage?.["total"]) ?? usage;
          if (total !== undefined) context.lineage.noteUsage(threadId, total);
        }
        return [];
      }
      case "turn/completed": {
        // Correctness rule: only the ROOT thread's turn ends the run.
        // A child thread completing is that child's terminal event.
        if (context.lineage !== undefined && !context.lineage.isRoot(threadId)) {
          return this.childTerminal(context, threadId as string, "completed", null, raw);
        }
        return [this.doneEvent(context, "completed", objectValue(params?.["usage"]), raw)];
      }
      case "turn/failed":
      case "turn/error":
      case "error": {
        if (context.lineage !== undefined && threadId !== undefined && !context.lineage.isRoot(threadId)) {
          return this.childTerminal(
            context,
            threadId,
            "failed",
            textFrom(params, ["message", "error", "reason"]),
            raw
          );
        }
        return [
          {
            ...this.base("agent.error", context, raw),
            type: "agent.error",
            code: textFrom(params, ["code", "errorCode"]) ?? "CODEX_APP_SERVER_TURN_FAILED",
            message: textFrom(params, ["message", "error", "reason"]) ?? compactJson(params),
            retryable: false
          },
          this.doneEvent(context, "failed", undefined, raw)
        ];
      }
      default:
        return [];
    }
  }

  doneEvent(
    context: AppServerNormalizerContext,
    status: AgentDoneEvent["status"],
    usage: JsonObject | undefined,
    raw: JsonObject
  ): AgentDoneEvent {
    return {
      ...this.base("agent.done", context, raw),
      type: "agent.done",
      status,
      ...(usage === undefined ? {} : { usage })
    };
  }

  private itemStarted(
    params: JsonObject | undefined,
    context: AppServerNormalizerContext,
    raw: JsonObject,
    path: readonly string[] | undefined
  ): AgentEvent[] {
    const item = itemObject(params);
    if (isCollabItem(item)) {
      // Spawn starts carry no receiver ids yet (probe fact) - wait for completion.
      return [];
    }
    if (isWebSearchItem(item)) {
      return [this.webSearchEvent(context, item, "started", raw, path)];
    }
    if (isCommandItem(item)) {
      return [this.commandEvent(context, item, "started", raw, path)];
    }
    return [];
  }

  private itemCompleted(
    params: JsonObject | undefined,
    context: AppServerNormalizerContext,
    raw: JsonObject,
    threadId: string | undefined,
    path: readonly string[] | undefined
  ): AgentEvent[] {
    const item = itemObject(params);
    if (isCollabItem(item)) {
      return this.collabEvents(item as JsonObject, context, raw, threadId);
    }
    if (isSubAgentActivityItem(item)) {
      return this.subAgentActivity(item as JsonObject, context, raw, threadId);
    }
    if (isWebSearchItem(item)) {
      return [this.webSearchEvent(context, item, "completed", raw, path)];
    }
    if (isToolCallItem(item)) {
      return [this.mcpToolEvent(context, item as JsonObject, raw, path)];
    }
    if (isAgentMessageItem(item)) {
      const text = textFrom(item, ["text", "content", "message"]) ?? textFrom(params, ["text", "content", "message"]);
      return text === null ? [] : [this.textEvent(context, text, true, raw, path)];
    }
    // Mirrors isAgentMessageItem above: a reasoning item arriving whole via
    // item/completed (rather than streamed via item/reasoning/delta), so a
    // provider that only reports reasoning at completion still surfaces it.
    if (isReasoningItem(item)) {
      const text = textFrom(item, ["text", "content", "message"]) ?? textFrom(params, ["text", "content", "message"]);
      return text === null ? [] : [this.reasoningEvent(context, text, raw, path, true)];
    }
    if (isCommandItem(item)) {
      // The completed command_execution item carries the full captured output -
      // grab it (capped) so the chat shows what the command actually printed,
      // not just the command + exit code.
      const rawOutput = textFrom(item, ["aggregated_output", "output", "stdout", "formatted_output", "aggregatedOutput"]);
      const output = rawOutput === null ? undefined : capPreview(rawOutput, TOOL_OUTPUT_PREVIEW_MAX);
      return [this.commandEvent(context, item, "completed", raw, path, output)];
    }
    const fileEvents = this.fileEvents(item ?? params, context, raw, path);
    if (fileEvents.length > 0) {
      return fileEvents;
    }
    return [];
  }

  /**
   * collabAgentToolCall items are the spawn edges (probe 2026-07-05):
   * spawnAgent completions name the new child thread in receiverThreadIds;
   * wait/close/sendInput completions carry each child's last status+message
   * in agentsStates - the lifecycle-tier terminal source, deduped per child.
   */
  private collabEvents(
    item: JsonObject,
    context: AppServerNormalizerContext,
    raw: JsonObject,
    threadId: string | undefined
  ): AgentEvent[] {
    const lineage = context.lineage;
    if (lineage === undefined) return [];
    if (textFrom(item, ["status"]) !== "completed") return [];

    const events: AgentEvent[] = [];
    const sender = textFrom(item, ["senderThreadId", "sender_thread_id"]) ?? threadId;
    const senderPath = lineage.pathFor(sender ?? undefined) ?? [];
    const tool = textFrom(item, ["tool"]);

    if (tool === "spawnAgent" || tool === "spawn_agent") {
      const prompt = textFrom(item, ["prompt"]);
      const model = textFrom(item, ["model"]);
      for (const receiver of stringArray(item["receiverThreadIds"] ?? item["receiver_thread_ids"])) {
        lineage.registerChild(receiver, sender ?? undefined);
        events.push({
          ...this.base("agent.spawn", context, raw, senderPath),
          type: "agent.spawn",
          nodeId: receiver,
          label: spawnLabel(prompt, receiver),
          ...(model === null ? {} : { model }),
          ...(prompt === null ? {} : { promptPreview: capPreview(prompt, SPAWN_PROMPT_PREVIEW_MAX) })
        } satisfies AgentSpawnEvent);
      }
    }

    const states = objectValue(item["agentsStates"] ?? item["agents_states"]);
    if (states !== undefined) {
      for (const [childThreadId, stateValue] of Object.entries(states)) {
        const state = objectValue(stateValue);
        if (state === undefined) continue;
        const status = terminalStatusFrom(textFrom(state, ["status"]));
        if (status === null) continue;
        const message = textFrom(state, ["message"]);
        if (!lineage.markTerminal(childThreadId) && message === null) continue;
        lineage.registerChild(childThreadId, sender ?? undefined);
        events.push(this.nodeDoneEvent(context, childThreadId, status, message, raw));
      }
    }
    return events;
  }

  /**
   * subAgentActivity is schema-present but unobserved in the probe (likely
   * the disabled multi_agent_v2 path) - registered defensively so activity
   * from that path lands attributed instead of misfiled under root.
   */
  private subAgentActivity(
    item: JsonObject,
    context: AppServerNormalizerContext,
    raw: JsonObject,
    threadId: string | undefined
  ): AgentEvent[] {
    const lineage = context.lineage;
    const agentThreadId = textFrom(item, ["agentThreadId", "agent_thread_id"]);
    if (lineage === undefined || agentThreadId === null) return [];
    if (textFrom(item, ["kind"]) !== "started") return [];
    if (lineage.pathFor(agentThreadId) !== undefined) return [];
    const parentPath = lineage.pathFor(threadId) ?? [];
    lineage.registerChild(agentThreadId, threadId);
    const pathLabel = textFrom(item, ["agentPath", "agent_path"]);
    const label = pathLabel === null
      ? spawnLabel(null, agentThreadId)
      : pathLabel.split("/").filter((part) => part.length > 0).pop() ?? spawnLabel(null, agentThreadId);
    return [{
      ...this.base("agent.spawn", context, raw, parentPath),
      type: "agent.spawn",
      nodeId: agentThreadId,
      label
    } satisfies AgentSpawnEvent];
  }

  /** Child-thread terminal (its own turn/completed|failed), deduped and usage-stamped. */
  private childTerminal(
    context: AppServerNormalizerContext,
    threadId: string,
    status: AgentNodeDoneEvent["status"],
    message: string | null,
    raw: JsonObject
  ): AgentEvent[] {
    const lineage = context.lineage;
    if (lineage === undefined) return [];
    lineage.attributionFor(threadId);
    if (!lineage.markTerminal(threadId) && message === null) return [];
    return [this.nodeDoneEvent(context, threadId, status, message, raw)];
  }

  private nodeDoneEvent(
    context: AppServerNormalizerContext,
    childThreadId: string,
    status: AgentNodeDoneEvent["status"],
    message: string | null,
    raw: JsonObject
  ): AgentNodeDoneEvent {
    const lineage = context.lineage;
    const childPath = lineage?.pathFor(childThreadId) ?? [childThreadId];
    const parentPath = childPath.slice(0, -1);
    const usage = lineage?.usageFor(childThreadId);
    return {
      ...this.base("agent.node_done", context, raw, parentPath),
      type: "agent.node_done",
      nodeId: childThreadId,
      status,
      ...(message === null ? {} : { resultPreview: capPreview(message, NODE_RESULT_PREVIEW_MAX) }),
      ...(usage === undefined ? {} : { usage })
    };
  }

  private webSearchEvent(
    context: AppServerNormalizerContext,
    item: JsonObject | undefined,
    status: AgentToolCallEvent["status"],
    raw: JsonObject,
    path: readonly string[] | undefined
  ): AgentToolCallEvent {
    const query = textFrom(item, ["query", "url"]);
    const toolUseId = textFrom(item, ["id"]);
    return {
      ...this.base("agent.tool_call", context, raw, path),
      type: "agent.tool_call",
      toolName: "web_search",
      status,
      ...(toolUseId === null ? {} : { toolUseId }),
      ...(query === null ? {} : { input: { query } }),
      // The query doubles as the visible result so the line reads
      // "web_search completed: <url>" (started items carry an empty query).
      ...(status === "completed" && query !== null ? { output: query } : {})
    };
  }

  private mcpToolEvent(
    context: AppServerNormalizerContext,
    item: JsonObject,
    raw: JsonObject,
    path: readonly string[] | undefined
  ): AgentToolCallEvent {
    const server = textFrom(item, ["server", "namespace"]);
    const tool = textFrom(item, ["tool"]) ?? "tool";
    const failed = textFrom(item, ["error"]) !== null || item["success"] === false;
    const toolUseId = textFrom(item, ["id"]);
    return {
      ...this.base("agent.tool_call", context, raw, path),
      type: "agent.tool_call",
      toolName: server === null ? tool : `${server}/${tool}`,
      status: failed ? "failed" : "completed",
      ...(toolUseId === null ? {} : { toolUseId })
    };
  }

  private fileEvents(
    params: JsonObject | undefined,
    context: AppServerNormalizerContext,
    raw: JsonObject,
    path: readonly string[] | undefined
  ): AgentFileEditEvent[] {
    const values = extractFileChangeObjects(params);
    return values.flatMap((change): AgentFileEditEvent[] => {
      const filePath = textFrom(change, ["path", "file", "relativePath", "absolutePath"]);
      if (filePath === null) {
        return [];
      }
      return [{
        ...this.base("agent.file_edit", context, raw, path),
        type: "agent.file_edit",
        path: filePath,
        changeKind: changeKind(change)
      }];
    });
  }

  private textEvent(
    context: AppServerNormalizerContext,
    text: string,
    final: boolean,
    raw: JsonObject,
    path: readonly string[] | undefined
  ): AgentEvent {
    return {
      ...this.base("agent.text", context, raw, path),
      type: "agent.text",
      text,
      final
    };
  }

  private reasoningEvent(
    context: AppServerNormalizerContext,
    text: string,
    raw: JsonObject,
    path: readonly string[] | undefined,
    final?: boolean
  ): AgentReasoningEvent {
    return {
      ...this.base("agent.reasoning", context, raw, path),
      type: "agent.reasoning",
      text,
      ...(final === undefined ? {} : { final })
    };
  }

  private planEvent(
    context: AppServerNormalizerContext,
    text: string,
    raw: JsonObject,
    path: readonly string[] | undefined
  ): AgentPlanEvent {
    return {
      ...this.base("agent.plan", context, raw, path),
      type: "agent.plan",
      text
    };
  }

  private commandEvent(
    context: AppServerNormalizerContext,
    item: JsonObject | undefined,
    status: AgentCommandEvent["status"],
    raw: JsonObject,
    path: readonly string[] | undefined,
    output?: string
  ): AgentCommandEvent {
    const command = textFrom(item, ["command", "cmd", "program", "name"]) ?? "process";
    const exitCode = numberFrom(item, ["exitCode", "exit_code", "code"]);
    return {
      ...this.base("agent.command", context, raw, path),
      type: "agent.command",
      command: [command],
      status,
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(output === undefined ? {} : { output })
    };
  }

  private base(
    type: AgentEventBase["type"],
    context: AppServerNormalizerContext,
    raw: JsonObject,
    path?: readonly string[]
  ): AgentEventBase {
    return {
      id: this.ids.eventId(),
      type,
      sessionId: context.sessionId,
      runId: context.runId,
      agentRole: context.agentRole,
      ...(context.runtimeId === undefined ? {} : { runtimeId: context.runtimeId }),
      createdAt: this.clock.isoNow(),
      ...(path === undefined || path.length === 0 ? {} : { agentPath: path }),
      raw
    };
  }
}

function messageToRaw(message: JsonRpcMessage): JsonObject {
  return {
    ...(message.method === undefined ? {} : { method: message.method }),
    ...(message.params === undefined ? {} : { params: message.params })
  };
}

function itemObject(params: JsonObject | undefined): JsonObject | undefined {
  return objectValue(params?.["item"]) ?? objectValue(params?.["itemInfo"]) ?? params;
}

function isAgentMessageItem(item: JsonObject | undefined): boolean {
  const type = textFrom(item, ["type", "kind"]);
  return type === "agent_message" || type === "agentMessage" || type === "message";
}

function isReasoningItem(item: JsonObject | undefined): boolean {
  const type = textFrom(item, ["type", "kind"]);
  return type === "reasoning";
}

function isCollabItem(item: JsonObject | undefined): boolean {
  const type = textFrom(item, ["type", "kind"]);
  return type === "collabAgentToolCall" || type === "collab_tool_call";
}

function isSubAgentActivityItem(item: JsonObject | undefined): boolean {
  const type = textFrom(item, ["type", "kind"]);
  return type === "subAgentActivity" || type === "sub_agent_activity";
}

function isWebSearchItem(item: JsonObject | undefined): boolean {
  const type = textFrom(item, ["type", "kind"]);
  return type === "webSearch" || type === "web_search";
}

function isToolCallItem(item: JsonObject | undefined): boolean {
  const type = textFrom(item, ["type", "kind"]);
  return type === "mcpToolCall" || type === "dynamicToolCall" || type === "mcp_tool_call" || type === "dynamic_tool_call";
}

function stringArray(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function isCommandItem(item: JsonObject | undefined): boolean {
  const type = textFrom(item, ["type", "kind"]);
  return type === "command_execution" || type === "command" || textFrom(item, ["command", "cmd"]) !== null;
}

function extractFileChangeObjects(value: JsonObject | undefined): JsonObject[] {
  if (value === undefined) {
    return [];
  }
  const direct = objectValue(value["change"]) ?? objectValue(value["fileChange"]) ?? objectValue(value["patch"]);
  const arrays = [value["changes"], value["fileChanges"], value["files"], value["paths"]];
  const objects = arrays.flatMap((candidate): JsonObject[] => {
    if (!Array.isArray(candidate)) {
      return [];
    }
    return candidate.flatMap((entry): JsonObject[] => {
      if (typeof entry === "string") {
        return [{ path: entry }];
      }
      const object = objectValue(entry);
      return object === undefined ? [] : [object];
    });
  });
  if (direct !== undefined) {
    objects.unshift(direct);
  }
  const path = textFrom(value, ["path", "file", "relativePath", "absolutePath"]);
  if (path !== null) {
    objects.unshift(value);
  }
  return objects;
}

function changeKind(value: JsonObject): AgentFileEditEvent["changeKind"] {
  const raw = textFrom(value, ["kind", "changeKind", "type", "status"])?.toLowerCase();
  if (raw === "add" || raw === "added" || raw === "create" || raw === "created") return "add";
  if (raw === "delete" || raw === "deleted" || raw === "remove" || raw === "removed") return "delete";
  if (raw === "rename" || raw === "renamed") return "rename";
  if (raw === "metadata" || raw === "chmod") return "metadata";
  return "update";
}

function textFrom(value: JsonObject | undefined, keys: readonly string[]): string | null {
  if (value === undefined) return null;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
    if (Array.isArray(candidate)) {
      const text = candidate
        .map((entry) => typeof entry === "string" ? entry : objectValue(entry)?.["text"])
        .filter((entry): entry is string => typeof entry === "string")
        .join("");
      if (text.length > 0) {
        return text;
      }
    }
  }
  return null;
}

function numberFrom(value: JsonObject | undefined, keys: readonly string[]): number | undefined {
  if (value === undefined) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number") {
      return candidate;
    }
  }
  return undefined;
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function compactJson(value: JsonValue | undefined): string {
  if (value === undefined) return "unknown";
  return JSON.stringify(value).replace(/\s+/g, " ").slice(0, 400);
}
