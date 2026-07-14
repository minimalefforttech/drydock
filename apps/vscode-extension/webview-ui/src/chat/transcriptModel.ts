/**
 * Shared chat transcript model (ADR 0012, P3 extraction).
 *
 * The line→message reducer both sidebar chat surfaces fold transcript lines
 * through: the Edit tab (via views/chatTab.ts) and the Plan tab. One code
 * path means a routing rule fixed once is fixed everywhere. The folder owns
 * the live-turn bookkeeping (streaming assistant row, running-command
 * coalescing, subagent group tree) and mutates a caller-owned store — the
 * caller supplies accessors so it can keep swapping its arrays on session
 * switches, plus hooks for everything surface-specific (diagnostics feed,
 * changed-files tracking, system notices, reasoning stream, render/persist).
 *
 * SECURITY: pure model, no DOM. Rendering lives in ./messageRow.ts.
 */

import type { JsonObject, SequencedTranscriptLine } from "@drydock/contracts";

export interface ChatMessage {
  readonly id: string;
  /**
   * "system" is a client-side notice; "command" is a shell command the agent
   * ran inside the container (surfaced inline, not just in the debug feed).
   */
  readonly role: "user" | "assistant" | "group" | "system" | "command";
  readonly createdAt: string;
  readonly text: string;
  readonly streaming?: boolean;
  /** role "group": the subagent group block this row renders. */
  readonly nodeId?: string;
  /** role "system": severity styling — "error" reds it, otherwise neutral. */
  readonly tone?: "error" | "info";
  /** role "system": show a Retry button that re-sends the last prompt. */
  readonly retry?: boolean;
  /** role "system": show a "Sign in to Docker Sandbox" button (auth failures). */
  readonly signIn?: boolean;
  /** role "system": show an "Authenticate <provider>" button (provider not signed in). */
  readonly authenticate?: boolean;
  /** role "system": provider id the Authenticate button should sign in. */
  readonly authProviderId?: string;
  /** role "command": lifecycle of the shell command. */
  readonly commandStatus?: "started" | "completed" | "failed";
  /** role "command": process exit code once it terminates. */
  readonly commandExit?: number;
  /** role "command": captured stdout/stderr (behind a disclosure). */
  readonly commandOutput?: string;
}

export interface DiagnosticEntry {
  readonly createdAt: string;
  readonly eventType: string;
  readonly summary: string;
  /**
   * Structured lineage fields, mirroring TranscriptLine so the Agents
   * lens can feed entries straight into the contracts tree reducer.
   */
  readonly agentPath?: readonly string[];
  readonly nodeId?: string;
  readonly label?: string;
  readonly subagentType?: string;
  readonly model?: string;
  readonly nodeStatus?: "running" | "completed" | "failed" | "cancelled";
  readonly toolStatus?: "started" | "completed" | "failed";
  readonly commandName?: string;
  readonly detail?: string;
  readonly usage?: JsonObject;
}

/** One rendered line inside a subagent group's feed. */
export interface AgentGroupEntry {
  readonly createdAt: string;
  readonly eventType: string;
  readonly summary: string;
  readonly detail?: string;
  /** agent.text entries render as structural markdown, not activity rows. */
  readonly prose?: boolean;
}

/** Feed entries kept per group; older activity stays in Diagnostics. */
export const AGENT_GROUP_ENTRY_CAP = 200;

/**
 * One subagent's collapsible transcript group. Derived entirely from
 * lineage-attributed transcript lines; nested children reference groups by id.
 */
export interface AgentGroup {
  readonly nodeId: string;
  parentNodeId?: string;
  label: string;
  subagentType?: string;
  model?: string;
  status: "running" | "completed" | "failed" | "cancelled" | "unknown";
  promptPreview?: string;
  resultPreview?: string;
  usage?: unknown;
  toolCalls: number;
  commands: number;
  fileEdits: number;
  errors: number;
  lastActivity?: string;
  lastActivityAt?: string;
  lastCommand?: string;
  createdAt: string;
  endedAt?: string;
  entries: AgentGroupEntry[];
  children: string[];
}

export function nextMessageId(prefix: string): string {
  return `${prefix}-${String(Date.now())}-${String(Math.random()).slice(2)}`;
}

/** A folder input line: a durable transcript line or a synthetic diagnostic. */
export type TranscriptInputLine = SequencedTranscriptLine | DiagnosticEntry;

/**
 * The caller-owned message/group store. Supplied as accessors so a surface
 * that reassigns its arrays on session switch stays coherent — the folder
 * always reads through the getters.
 */
export interface TranscriptStore {
  readonly messages: ChatMessage[];
  readonly groups: Record<string, AgentGroup>;
}

export interface TranscriptFolderHooks {
  /** Every line also lands in the surface's flat debug feed. */
  onDiagnostic(entry: DiagnosticEntry, shouldPersist: boolean): void;
  /** agent.file_edit (root or child): the surface tracks its working set. */
  onFileEdit(filePath: string, changeKind: string): void;
  /** agent.error surfaces as a visible notice; the surface builds/pushes it. */
  onSystemMessage(text: string, tone: "error" | "info", retry: boolean): void;
  /** Streamed agent.reasoning text; the surface owns the live disclosure. */
  onReasoning(text: string): void;
  onRender(): void;
  onPersist(): void;
  /** The turn produced visible assistant text (empty-turn detection). */
  onAssistantTextSeen?(): void;
}

/** Carries the structured lineage fields into the flat Diagnostics feed. */
export function diagnosticFromLine(line: TranscriptInputLine, prefix?: string): DiagnosticEntry {
  return {
    createdAt: line.createdAt,
    eventType: line.eventType,
    summary: prefix === undefined ? line.summary : `[${prefix}] ${line.summary}`,
    ...("agentPath" in line && Array.isArray(line.agentPath) && line.agentPath.length > 0 ? { agentPath: line.agentPath } : {}),
    ...("nodeId" in line && typeof line.nodeId === "string" ? { nodeId: line.nodeId } : {}),
    ...("label" in line && typeof line.label === "string" ? { label: line.label } : {}),
    ...("subagentType" in line && typeof line.subagentType === "string" ? { subagentType: line.subagentType } : {}),
    ...("model" in line && typeof line.model === "string" ? { model: line.model } : {}),
    ...("nodeStatus" in line && typeof line.nodeStatus === "string" ? { nodeStatus: line.nodeStatus } : {}),
    ...("toolStatus" in line && typeof line.toolStatus === "string" ? { toolStatus: line.toolStatus } : {}),
    ...("commandName" in line && typeof line.commandName === "string" ? { commandName: line.commandName } : {}),
    ...("detail" in line && typeof line.detail === "string" ? { detail: line.detail } : {}),
    ...("usage" in line && line.usage !== undefined ? { usage: line.usage } : {})
  };
}

export class TranscriptFolder {
  private activeAssistantId: string | null = null;
  /** Coalesces a command's started→terminal events into one row (by command text). */
  private readonly runningCommands = new Map<string, string>();
  private assistantTextThisTurn = false;

  constructor(
    private readonly store: TranscriptStore,
    private readonly hooks: TranscriptFolderHooks
  ) {}

  /** True when apply() saw final-capable assistant text since the last reset. */
  get sawAssistantTextThisTurn(): boolean {
    return this.assistantTextThisTurn;
  }

  /** New turn: empty-turn detection restarts. */
  resetTurn(): void {
    this.assistantTextThisTurn = false;
  }

  /** Session switch / replay restart: drop every live-turn coalescing handle. */
  clearLiveState(): void {
    this.activeAssistantId = null;
    this.runningCommands.clear();
    this.assistantTextThisTurn = false;
  }

  /** Ends any streaming assistant row without touching command coalescing. */
  clearActiveAssistant(): void {
    this.activeAssistantId = null;
  }

  /**
   * Routes one transcript line. Spawns open a collapsible group at this point
   * in the flow; node_done closes one; everything else carrying a non-root
   * agentPath belongs INSIDE its group, never interleaved into the main log.
   */
  apply(line: TranscriptInputLine, shouldPersist = true): void {
    const agentPath = "agentPath" in line && Array.isArray(line.agentPath) ? line.agentPath : undefined;
    const nodeId = "nodeId" in line && typeof line.nodeId === "string" ? line.nodeId : undefined;

    if (line.eventType === "agent.spawn" && nodeId !== undefined) {
      this.openAgentGroup(line, nodeId, agentPath ?? [], shouldPersist);
      return;
    }
    if (line.eventType === "agent.node_done" && nodeId !== undefined) {
      this.closeAgentGroup(line, nodeId, shouldPersist);
      return;
    }
    if (agentPath !== undefined && agentPath.length > 0) {
      this.routeChildLine(line, agentPath, shouldPersist);
      return;
    }

    if (line.eventType === "user.message") {
      this.appendUserLine(line.summary, line.createdAt, shouldPersist);
      return;
    }
    if (line.eventType === "agent.text") {
      this.appendAssistantText(line.summary, "final" in line && line.final === true, line.createdAt, shouldPersist);
      return;
    }
    if (line.eventType === "agent.reasoning") {
      this.hooks.onReasoning(line.summary);
      return;
    }
    if (line.eventType === "agent.error") {
      // Surface the failure in the chat, not just the Diagnostics feed. The
      // detail (when present) carries the real reason; fall back to the summary.
      const detail = "detail" in line && typeof line.detail === "string" && line.detail.length > 0 ? line.detail : line.summary;
      this.hooks.onSystemMessage(`The agent hit an error: ${detail}`, "error", true);
      this.hooks.onDiagnostic(diagnosticFromLine(line), shouldPersist);
      return;
    }
    if (line.eventType === "agent.command") {
      // The shell commands the agent runs in the container are the "docker shell"
      // activity — render them inline (a dev needs to watch them), not just in
      // the hidden Diagnostics feed. Still diagnose for the flat debug truth.
      this.appendCommand(line, shouldPersist);
      this.hooks.onDiagnostic(diagnosticFromLine(line), shouldPersist);
      return;
    }
    if (line.eventType === "agent.file_edit") {
      const filePath = "filePath" in line && typeof line.filePath === "string"
        ? line.filePath
        : line.summary.split(" ").slice(1).join(" ");
      const changeKind = "fileChangeKind" in line && typeof line.fileChangeKind === "string"
        ? line.fileChangeKind
        : line.summary.split(" ")[0] ?? "update";
      if (filePath) {
        this.hooks.onFileEdit(filePath, changeKind);
      }
    }
    this.hooks.onDiagnostic(diagnosticFromLine(line), shouldPersist);
    if (line.eventType === "agent.done") {
      this.activeAssistantId = null;
    }
  }

  appendUserLine(prompt: string, createdAt = new Date().toISOString(), shouldPersist = true): void {
    this.store.messages.push({ id: nextMessageId("user"), role: "user", createdAt, text: prompt });
    this.activeAssistantId = null;
    this.hooks.onRender();
    if (shouldPersist) this.hooks.onPersist();
  }

  appendAssistantText(text: string, final: boolean, createdAt: string, shouldPersist = true): void {
    this.assistantTextThisTurn = true;
    this.hooks.onAssistantTextSeen?.();
    const messages = this.store.messages;
    const currentIndex = this.activeAssistantId === null
      ? -1
      : messages.findIndex((message) => message.id === this.activeAssistantId);
    if (currentIndex === -1) {
      const id = nextMessageId("assistant");
      this.activeAssistantId = final ? null : id;
      messages.push({ id, role: "assistant", createdAt, text, ...(final ? {} : { streaming: true }) });
    } else {
      const current = messages[currentIndex];
      if (current === undefined) return;
      const nextText = final ? text : `${current.text}${text}`;
      messages[currentIndex] = final
        ? { id: current.id, role: current.role, createdAt: current.createdAt, text: nextText }
        : { ...current, text: nextText, streaming: true };
      if (final) this.activeAssistantId = null;
    }
    this.hooks.onRender();
    if (shouldPersist) this.hooks.onPersist();
  }

  /** A surface-authored notice (built by the surface — auth detection etc. lives there). */
  appendSystemMessage(message: Omit<ChatMessage, "id" | "role" | "createdAt"> & { readonly text: string }): void {
    this.store.messages.push({
      id: nextMessageId("system"),
      role: "system",
      createdAt: new Date().toISOString(),
      ...message
    });
    this.activeAssistantId = null;
    this.hooks.onRender();
    this.hooks.onPersist();
  }

  /**
   * Renders a shell command the agent ran, coalescing its started→terminal
   * events into one row that gains an exit code + captured output. The summary
   * is `<cmd> [<status>[ exit N]]`; we split the command text from the suffix
   * so the row reads like a terminal line.
   */
  appendCommand(line: TranscriptInputLine, shouldPersist = true): void {
    const summary = line.summary;
    const status = "toolStatus" in line && (line.toolStatus === "started" || line.toolStatus === "completed" || line.toolStatus === "failed")
      ? line.toolStatus
      : "started";
    const commandText = summary.replace(/\s*\[[^\]]*\]\s*$/, "").trim() || summary;
    const exitMatch = /exit (-?\d+)/.exec(summary);
    const commandExit = exitMatch ? Number(exitMatch[1]) : undefined;
    const output = "detail" in line && typeof line.detail === "string" && line.detail.length > 0 ? line.detail : undefined;

    const messages = this.store.messages;
    const existingId = this.runningCommands.get(commandText);
    const existingIndex = existingId === undefined ? -1 : messages.findIndex((message) => message.id === existingId);
    const id = existingIndex >= 0 ? (messages[existingIndex] as ChatMessage).id : nextMessageId("command");
    const message: ChatMessage = {
      id,
      role: "command",
      createdAt: line.createdAt,
      text: commandText,
      commandStatus: status,
      ...(commandExit === undefined ? {} : { commandExit }),
      ...(output === undefined ? {} : { commandOutput: output })
    };
    if (existingIndex >= 0) {
      messages[existingIndex] = message;
    } else {
      messages.push(message);
    }
    if (status === "started") {
      this.runningCommands.set(commandText, id);
    } else {
      this.runningCommands.delete(commandText);
    }
    this.hooks.onRender();
    if (shouldPersist) this.hooks.onPersist();
  }

  // ---------------------------------------------------------------------------
  // Subagent groups: lineage-attributed lines collect into collapsible blocks
  // anchored where the spawn happened.
  // ---------------------------------------------------------------------------

  /** Group lookup that synthesizes missing nodes (and ancestors) instead of dropping. */
  private ensureAgentGroup(nodeId: string, parentPath: readonly string[], createdAt: string): AgentGroup {
    const existing = this.store.groups[nodeId];
    if (existing !== undefined) return existing;
    let parentNodeId: string | undefined;
    if (parentPath.length > 0) {
      const parentId = parentPath[parentPath.length - 1] as string;
      this.ensureAgentGroup(parentId, parentPath.slice(0, -1), createdAt);
      parentNodeId = parentId;
    }
    const group: AgentGroup = {
      nodeId,
      ...(parentNodeId === undefined ? {} : { parentNodeId }),
      label: `agent ${nodeId.slice(-8)}`,
      status: "running",
      toolCalls: 0,
      commands: 0,
      fileEdits: 0,
      errors: 0,
      createdAt,
      entries: [],
      children: []
    };
    this.store.groups[nodeId] = group;
    if (parentNodeId === undefined) {
      this.store.messages.push({ id: nextMessageId("group"), role: "group", createdAt, text: "", nodeId });
    } else {
      const parent = this.store.groups[parentNodeId];
      if (parent !== undefined && !parent.children.includes(nodeId)) parent.children.push(nodeId);
    }
    return group;
  }

  private openAgentGroup(line: TranscriptInputLine, nodeId: string, parentPath: readonly string[], shouldPersist: boolean): void {
    const group = this.ensureAgentGroup(nodeId, parentPath, line.createdAt);
    if ("label" in line && typeof line.label === "string") group.label = line.label;
    if ("subagentType" in line && typeof line.subagentType === "string") group.subagentType = line.subagentType;
    if ("model" in line && typeof line.model === "string") group.model = line.model;
    if ("detail" in line && typeof line.detail === "string") group.promptPreview = line.detail;
    group.lastActivity = line.summary;
    group.lastActivityAt = line.createdAt;
    this.hooks.onDiagnostic(diagnosticFromLine(line), shouldPersist);
    this.hooks.onRender();
    if (shouldPersist) this.hooks.onPersist();
  }

  private closeAgentGroup(line: TranscriptInputLine, nodeId: string, shouldPersist: boolean): void {
    const group = this.ensureAgentGroup(nodeId, [], line.createdAt);
    const status = "nodeStatus" in line ? line.nodeStatus : undefined;
    if (group.status === "running" && (status === "completed" || status === "failed" || status === "cancelled")) {
      group.status = status;
      group.endedAt = line.createdAt;
    }
    if ("detail" in line && typeof line.detail === "string") group.resultPreview = line.detail;
    if ("usage" in line && line.usage !== undefined) group.usage = line.usage;
    group.lastActivity = line.summary;
    group.lastActivityAt = line.createdAt;
    this.hooks.onDiagnostic(diagnosticFromLine(line, group.label), shouldPersist);
    this.hooks.onRender();
    if (shouldPersist) this.hooks.onPersist();
  }

  private routeChildLine(line: TranscriptInputLine, agentPath: readonly string[], shouldPersist: boolean): void {
    const nodeId = agentPath[agentPath.length - 1] as string;
    const group = this.ensureAgentGroup(nodeId, agentPath.slice(0, -1), line.createdAt);
    const toolStatus = "toolStatus" in line ? line.toolStatus : undefined;
    if (line.eventType === "agent.tool_call" && toolStatus === "started") group.toolCalls += 1;
    if (line.eventType === "agent.command" && toolStatus === "started") group.commands += 1;
    if ((line.eventType === "agent.tool_call" || line.eventType === "agent.command")
      && "commandName" in line
      && typeof line.commandName === "string") {
      group.lastCommand = line.commandName;
    }
    if (line.eventType === "agent.error") group.errors += 1;
    if (line.eventType === "agent.file_edit") {
      group.fileEdits += 1;
      // Child edits land in the SAME runtime/workspace: the working set owns them too.
      const filePath = "filePath" in line && typeof line.filePath === "string" ? line.filePath : undefined;
      const changeKind = "fileChangeKind" in line && typeof line.fileChangeKind === "string" ? line.fileChangeKind : "update";
      if (filePath !== undefined) {
        this.hooks.onFileEdit(filePath, changeKind);
      }
    }
    group.lastActivity = line.summary;
    group.lastActivityAt = line.createdAt;
    group.entries.push({
      createdAt: line.createdAt,
      eventType: line.eventType,
      summary: line.summary,
      ...("detail" in line && typeof line.detail === "string" ? { detail: line.detail } : {}),
      ...(line.eventType === "agent.text" ? { prose: true } : {})
    });
    if (group.entries.length > AGENT_GROUP_ENTRY_CAP) group.entries.shift();
    this.hooks.onDiagnostic(diagnosticFromLine(line, group.label), shouldPersist);
    this.hooks.onRender();
    if (shouldPersist) this.hooks.onPersist();
  }
}
