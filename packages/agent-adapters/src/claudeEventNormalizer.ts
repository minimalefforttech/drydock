/**
 * Claude Code stream-json event normalization.
 *
 * Raw `claude -p --output-format stream-json` lines are mapped immediately
 * into product events so storage and UI never depend on provider-specific
 * stream fragments. The provider session id is surfaced so the transport can
 * resume the same conversation on the next turn.
 *
 * Subagent lineage (see docs/adr/0002-product-owned-orchestration.md): Task tool_use blocks spawn subagents; the sidechain
 * lines those subagents emit carry a top-level `parent_tool_use_id` naming
 * the spawning Task call. A per-run registry maps those ids to `agentPath`s
 * (depth-N: a sidechain Task spawn nests under its own path). `user` lines —
 * previously dropped — are parsed for tool_result blocks: a Task result is
 * the child's `agent.node_done`; other results complete their tracked
 * command/tool call with a capped output preview.
 *
 * NOTE: mapping derived from the documented stream format; the standalone
 * CLI is unauthenticated on this host, so the fixture in the test file is
 * synthetic pending live validation (docs/design/subagent-workflows.md).
 */

import type {
  AgentEvent,
  AgentEventBase,
  AgentNodeDoneEvent,
  AgentRole,
  AgentSpawnEvent,
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
  TOOL_OUTPUT_PREVIEW_MAX
} from "./previewCaps.js";

export interface ClaudeNormalizerContext {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly agentRole: AgentRole;
  readonly runtimeId?: RuntimeId;
}

export interface ClaudeParseResult {
  readonly events: readonly AgentEvent[];
  /** Claude Code conversation id, used for --resume on the next turn. */
  readonly claudeSessionId?: string;
}

const FILE_EDIT_TOOLS: Readonly<Record<string, "add" | "update" | "delete">> = {
  Write: "add",
  Edit: "update",
  MultiEdit: "update",
  NotebookEdit: "update"
};

/** A non-Task tool_use awaiting its tool_result. */
interface TrackedCall {
  readonly kind: "command" | "tool";
  readonly toolName: string;
  readonly command?: string;
  /** Path of the agent that MADE the call (its results belong to it too). */
  readonly path: readonly string[];
}

/** Per-run lineage: spawned Task ids → child paths; open calls → pairing info. */
class ClaudeRunLineage {
  readonly spawnPaths = new Map<string, readonly string[]>();
  readonly openCalls = new Map<string, TrackedCall>();

  registerSpawn(toolUseId: string, parentPath: readonly string[]): readonly string[] {
    const existing = this.spawnPaths.get(toolUseId);
    if (existing !== undefined) return existing;
    const path = [...parentPath, toolUseId];
    this.spawnPaths.set(toolUseId, path);
    return path;
  }

  /** Sidechain attribution; an unknown parent id still lands under root. */
  pathForParentId(parentToolUseId: string): readonly string[] {
    return this.spawnPaths.get(parentToolUseId) ?? this.registerSpawn(parentToolUseId, []);
  }
}

export class ClaudeEventNormalizer {
  private readonly runs = new Map<string, ClaudeRunLineage>();

  constructor(private readonly ids: IdGenerator, private readonly clock: Clock) {}

  parseJsonLines(stdout: string, context: ClaudeNormalizerContext): ClaudeParseResult {
    const events: AgentEvent[] = [];
    let claudeSessionId: string | undefined;
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const raw = JSON.parse(trimmed) as JsonValue;
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          const sessionId = stringValue(raw["session_id"]);
          if (sessionId !== null) {
            claudeSessionId = sessionId;
          }
          events.push(...this.normalize(raw, context));
        }
      } catch {
        // Non-JSON output (progress noise) is ignored, same as the Codex path.
      }
    }
    return {
      events,
      ...(claudeSessionId === undefined ? {} : { claudeSessionId })
    };
  }

  normalize(raw: JsonObject, context: ClaudeNormalizerContext): AgentEvent[] {
    const type = stringValue(raw["type"]);
    const lineage = this.lineageFor(context);
    const parentToolUseId = stringValue(raw["parent_tool_use_id"]);
    // Path of the agent that emitted this line: [] = the root agent,
    // otherwise the sidechain subagent spawned by parent_tool_use_id.
    const path = parentToolUseId === null ? [] : lineage.pathForParentId(parentToolUseId);

    if (type === "assistant") {
      const content = contentBlocks(raw["message"]);
      const events: AgentEvent[] = [];
      for (const block of content) {
        events.push(...this.contentBlockEvents(block, context, raw, lineage, path));
      }
      return events;
    }

    if (type === "user") {
      // Tool results come back as user-role messages. A Task result closes a
      // subagent; other results complete their tracked call.
      const content = contentBlocks(raw["message"]);
      const events: AgentEvent[] = [];
      for (const block of content) {
        if (stringValue(block["type"]) !== "tool_result") continue;
        events.push(...this.toolResultEvents(block, context, raw, lineage));
      }
      return events;
    }

    if (type === "result") {
      this.runs.delete(runKey(context));
      const isError = raw["is_error"] === true;
      if (isError) {
        return [
          {
            ...this.base("agent.error", context, raw, []),
            type: "agent.error",
            code: stringValue(raw["subtype"])?.toUpperCase() ?? "CLAUDE_TURN_FAILED",
            message: stringValue(raw["result"]) ?? JSON.stringify(raw),
            retryable: true
          },
          { ...this.base("agent.done", context, raw, []), type: "agent.done", status: "failed" }
        ];
      }
      const usage = objectValue(raw["usage"]);
      return [{
        ...this.base("agent.done", context, raw, []),
        type: "agent.done",
        status: "completed",
        ...(usage === undefined ? {} : { usage })
      }];
    }

    // system/init and stream deltas carry no transcript payload beyond the
    // session id captured above.
    return [];
  }

  private contentBlockEvents(
    block: JsonObject,
    context: ClaudeNormalizerContext,
    raw: JsonObject,
    lineage: ClaudeRunLineage,
    path: readonly string[]
  ): AgentEvent[] {
    const blockType = stringValue(block["type"]);
    if (blockType === "text") {
      const text = stringValue(block["text"]) ?? "";
      if (text.length === 0) return [];
      return [{ ...this.base("agent.text", context, raw, path), type: "agent.text", text, final: true }];
    }
    if (blockType !== "tool_use") {
      return [];
    }

    const toolName = stringValue(block["name"]) ?? "tool";
    const toolUseId = stringValue(block["id"]);
    const input = objectValue(block["input"]);

    if (toolName === "Task") {
      // A subagent spawn. The child's sidechain lines will reference this id
      // via parent_tool_use_id; its tool_result is the child's node_done.
      const nodeId = toolUseId ?? this.ids.eventId();
      lineage.registerSpawn(nodeId, path);
      const description = stringValue(input?.["description"]);
      const prompt = stringValue(input?.["prompt"]);
      const subagentType = stringValue(input?.["subagent_type"]);
      const label = description ?? (prompt === null ? "subagent" : firstLine(prompt));
      return [{
        ...this.base("agent.spawn", context, raw, path),
        type: "agent.spawn",
        nodeId,
        label,
        ...(subagentType === null ? {} : { subagentType }),
        ...(prompt === null ? {} : { promptPreview: capPreview(prompt, SPAWN_PROMPT_PREVIEW_MAX) })
      } satisfies AgentSpawnEvent];
    }

    if (toolName === "Bash") {
      const command = stringValue(input?.["command"]);
      if (toolUseId !== null) {
        lineage.openCalls.set(toolUseId, { kind: "command", toolName, ...(command === null ? {} : { command }), path });
      }
      return [{
        ...this.base("agent.command", context, raw, path),
        type: "agent.command",
        command: command === null ? [toolName] : [command],
        status: "started"
      }];
    }
    const editKind = FILE_EDIT_TOOLS[toolName];
    const filePath = stringValue(input?.["file_path"]) ?? stringValue(input?.["notebook_path"]);
    if (editKind !== undefined && filePath !== null) {
      // Single-shot: a file edit's result confirms success but adds no
      // display value, so it is not tracked for completion.
      return [{
        ...this.base("agent.file_edit", context, raw, path),
        type: "agent.file_edit",
        path: filePath,
        changeKind: editKind
      }];
    }
    if (toolUseId !== null) {
      lineage.openCalls.set(toolUseId, { kind: "tool", toolName, path });
    }
    return [{
      ...this.base("agent.tool_call", context, raw, path),
      type: "agent.tool_call",
      toolName,
      status: "started",
      ...(toolUseId === null ? {} : { toolUseId }),
      ...(input === undefined ? {} : { input })
    }];
  }

  private toolResultEvents(
    block: JsonObject,
    context: ClaudeNormalizerContext,
    raw: JsonObject,
    lineage: ClaudeRunLineage
  ): AgentEvent[] {
    const toolUseId = stringValue(block["tool_use_id"]);
    if (toolUseId === null) return [];
    const isError = block["is_error"] === true;
    const resultText = toolResultText(block["content"]);

    const spawnPath = lineage.spawnPaths.get(toolUseId);
    if (spawnPath !== undefined) {
      const capped = resultText === null ? null : capPreview(resultText, NODE_RESULT_PREVIEW_MAX);
      return [{
        // node_done convention: agentPath is the PARENT's path.
        ...this.base("agent.node_done", context, truncatedResultRaw(raw, toolUseId, isError, capped), spawnPath.slice(0, -1)),
        type: "agent.node_done",
        nodeId: toolUseId,
        status: isError ? "failed" : "completed",
        ...(capped === null ? {} : { resultPreview: capped })
      } satisfies AgentNodeDoneEvent];
    }

    const open = lineage.openCalls.get(toolUseId);
    if (open === undefined) return [];
    lineage.openCalls.delete(toolUseId);
    const output = resultText === null ? undefined : capPreview(resultText, TOOL_OUTPUT_PREVIEW_MAX);
    const safeRaw = truncatedResultRaw(raw, toolUseId, isError, output ?? null);
    if (open.kind === "command") {
      return [{
        ...this.base("agent.command", context, safeRaw, open.path),
        type: "agent.command",
        command: open.command === undefined ? [open.toolName] : [open.command],
        status: isError ? "failed" : "completed",
        ...(output === undefined ? {} : { output })
      }];
    }
    return [{
      ...this.base("agent.tool_call", context, safeRaw, open.path),
      type: "agent.tool_call",
      toolName: open.toolName,
      status: isError ? "failed" : "completed",
      toolUseId,
      ...(output === undefined ? {} : { output })
    }];
  }

  private lineageFor(context: ClaudeNormalizerContext): ClaudeRunLineage {
    const key = runKey(context);
    const existing = this.runs.get(key);
    if (existing !== undefined) return existing;
    const created = new ClaudeRunLineage();
    this.runs.set(key, created);
    return created;
  }

  private base(
    type: string,
    context: ClaudeNormalizerContext,
    raw: JsonObject,
    path: readonly string[]
  ): AgentEventBase {
    return {
      id: this.ids.eventId(),
      type,
      sessionId: context.sessionId,
      runId: context.runId,
      agentRole: context.agentRole,
      ...(context.runtimeId === undefined ? {} : { runtimeId: context.runtimeId }),
      createdAt: this.clock.isoNow(),
      ...(path.length === 0 ? {} : { agentPath: path }),
      raw
    };
  }
}

function runKey(context: ClaudeNormalizerContext): string {
  return `${context.sessionId}:${context.runId}`;
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0]?.trim() ?? "subagent";
  return line.length > 48 ? `${line.slice(0, 48)}…` : line;
}

/**
 * Documented deviation from raw preservation (design doc, Caps): tool_result
 * payloads can be file-dump sized, so the stored raw carries the capped text
 * instead of the full content.
 */
function truncatedResultRaw(raw: JsonObject, toolUseId: string, isError: boolean, capped: string | null): JsonObject {
  return {
    type: stringValue(raw["type"]) ?? "user",
    ...(stringValue(raw["parent_tool_use_id"]) === null ? {} : { parent_tool_use_id: raw["parent_tool_use_id"] }),
    message: {
      content: [{
        type: "tool_result",
        tool_use_id: toolUseId,
        is_error: isError,
        ...(capped === null ? {} : { content: capped })
      }]
    },
    truncated: true
  };
}

/** tool_result content is a string or an array of text blocks. */
function toolResultText(value: JsonValue | undefined): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (!Array.isArray(value)) return null;
  const text = value
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const object = objectValue(entry);
      return object !== undefined && stringValue(object["type"]) === "text" ? stringValue(object["text"]) ?? "" : "";
    })
    .filter((entry) => entry.length > 0)
    .join("\n");
  return text.length > 0 ? text : null;
}

function contentBlocks(message: JsonValue | undefined): JsonObject[] {
  const object = objectValue(message);
  const content = object?.["content"];
  if (!Array.isArray(content)) return [];
  return content
    .map((block) => objectValue(block))
    .filter((block): block is JsonObject => block !== undefined);
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function stringValue(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}
