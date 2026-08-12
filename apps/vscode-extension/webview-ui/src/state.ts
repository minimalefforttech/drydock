/**
 * Webview application state (chat panel redesign, Phase 1).
 *
 * One mutable `AppState` object is the single source of truth for the whole
 * panel; every view reads and mutates it and calls `persist()`. The persisted
 * shape is versioned via `getState`/`setState`; `restore()` migrates the legacy
 * (pre-redesign) persisted shape gracefully - anything that no longer fits is
 * reset rather than crashing.
 *
 * SECURITY: this module holds data only. All dynamic strings that reach the DOM
 * are rendered via textContent by the view modules - never innerHTML - so agent
 * output can never become markup.
 */

import type {
  AccessRequestSummary,
  ActiveEditorRef,
  AgentActivitySummary,
  AgentModelCatalog,
  AgentQuestionSummary,
  ChatSessionSummary,
  IsolationSummary,
  McpOverrideSummary,
  McpServerSummary,
  PanelInitState,
  PreviewSummary,
  WorkspacePolicyState,
  WorkTaskSummary
} from "@drydock/contracts";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode: VsCodeApi = acquireVsCodeApi();

// The transcript message/group model moved to the shared chat module (ADR
// 0012, P3) so the Planner rail folds lines through the same reducer as the
// Chat tab. Re-exported here so existing imports keep working.
export {
  AGENT_GROUP_ENTRY_CAP,
  type AgentGroup,
  type AgentGroupEntry,
  type ChatMessage,
  type DiagnosticEntry
} from "./chat/transcriptModel.js";
import type { AgentGroup, ChatMessage, DiagnosticEntry } from "./chat/transcriptModel.js";

/** Freeform notes the user adds from the chat panel, scoped to a task and
 * (when the chat is a subtask session) to that subtask. */
export interface TaskNote {
  readonly noteId: string;
  readonly taskId: string;
  /** Present when the note was added from a subtask session; scopes it to that
   * subtask so parent-task and subtask notes stay separate. */
  readonly subtaskId?: string;
  readonly createdAt: string;
  readonly text: string;
}

export const CODEX_PROVIDER_ID = "codex";
export const LEGACY_CODEX_PROVIDER_ID = "codex-openai";

export function normalizeProviderId(providerId: string): string {
  return providerId === LEGACY_CODEX_PROVIDER_ID ? CODEX_PROVIDER_ID : providerId;
}

/**
 * Folds host-sent catalogs into state through one choke point. Every host
 * message carries the same canonical per-provider map, so a per-provider
 * `refreshedAt` comparison is enough to stop a slow, older response from
 * clobbering a fresher one (the historical last-write-wins race). There is no
 * webview-side fallback catalog: until the host answers, the state is empty
 * and the UI says so.
 */
export function applyProviderCatalogs(state: AppState, incoming: readonly AgentModelCatalog[]): void {
  const byId = new Map(state.providerCatalogs.map((catalog) => [normalizeProviderId(catalog.providerId), catalog]));
  for (const catalog of incoming) {
    const key = normalizeProviderId(catalog.providerId);
    const existing = byId.get(key);
    if (existing === undefined || Date.parse(catalog.refreshedAt) >= Date.parse(existing.refreshedAt) || Number.isNaN(Date.parse(existing.refreshedAt))) {
      byId.set(key, catalog);
    }
  }
  state.providerCatalogs = [...byId.values()];
}

/**
 * Everything the panel keeps between reloads. `activeTab` and `openFolderNames`
 * are new for the redesign; the rest carries the pre-redesign session/chat data.
 */
export interface AppState {
  sessions: ChatSessionSummary[];
  selectedSessionId: string | null;
  chatMessages: ChatMessage[];
  diagnostics: DiagnosticEntry[];
  /** Subagent groups for the SELECTED session, keyed by node id. */
  agentGroups: Record<string, AgentGroup>;
  /** Per-session ⑂ chip counters from `session.agentActivity` pushes. */
  agentActivity: Record<string, AgentActivitySummary>;
  /** Host-provided threshold for showing delegated agents as idle. */
  agentIdleThresholdMs: number;
  /** Host/user setting: wrap long lines inside chat transcript code blocks. */
  codeBlockWordWrap: boolean;
  /** Agent questions (all statuses); pending ones stack in the attention UI. */
  questions: AgentQuestionSummary[];
  lastSequence: number;
  providerCatalogs: AgentModelCatalog[];
  promptDraft: string;
  providerId: string;
  selectedModel: string;
  /** Last provider-advertised reasoning effort selected by the user. */
  thinkingEffort: string;
  changedFiles: Map<string, string>;
  lastIsolation: IsolationSummary | null;
  workspacePolicy: WorkspacePolicyState | null;
  selectedWorkspaceSetId: string;
  openFolderNames: readonly string[];
  /** The window's active editor (host-reported), offered as a composer
   * attachment; null when none. Transient - not persisted. */
  activeEditor: ActiveEditorRef | null;
  /** Internal work tasks, newest-first by updatedAt. */
  tasks: WorkTaskSummary[];
  /**
   * Per-session waiting-on-user signal (Phase 3 attention routing). Maps a
   * sessionId to its active attention reasons ("turn-completed" | "turn-failed"
   * | "access-request"); a session with no key has nothing waiting. Persisted so
   * the "waiting" markers survive a reload until the host re-pushes or the user
   * clears them by selecting the session. Driven by the host `session.attention`
   * push (see `applySessionAttention`).
   */
  attention: Record<string, readonly string[]>;
  /** MCP registry rows + tri-state overrides. Transient; mcp.list hydrates. */
  mcpServers: McpServerSummary[];
  mcpOverrides: McpOverrideSummary[];
  /** Webview-local task notes keyed by durable taskId. */
  taskNotes: TaskNote[];
  /**
   * Sessions currently running a turn (from chat.turnStarted/turnCompleted
   * pushes). Transient - rebuilt from pushes after a reload - but lets every
   * session row show running-a-turn vs idle-live, not just the selected one.
   */
  turnActiveSessionIds: Set<string>;
  /** Agent-announced sandbox previews (ADR 0017). Transient - re-pushed/refetched. */
  previews: PreviewSummary[];
  /**
   * The CURRENT task, shared across Tasks/Plan/Edit so they stay in sync:
   * selecting a session adopts its owning task, clicking a task card sets it,
   * the Plan tab's task picker reads and writes it, and new chats link to it.
   * Persisted; null = no explicit choice (surfaces fall back to derivation).
   */
  activeTaskId: string | null;
}

function freshState(): AppState {
  return {
    sessions: [],
    selectedSessionId: null,
    chatMessages: [],
    diagnostics: [],
    agentGroups: {},
    agentActivity: {},
    agentIdleThresholdMs: 5 * 60_000,
    codeBlockWordWrap: true,
    questions: [],
    lastSequence: 0,
    providerCatalogs: [],
    promptDraft: "",
    providerId: CODEX_PROVIDER_ID,
    selectedModel: "",
    thinkingEffort: "medium",
    changedFiles: new Map(),
    lastIsolation: null,
    workspacePolicy: null,
    selectedWorkspaceSetId: "",
    openFolderNames: [],
    activeEditor: null,
    tasks: [],
    attention: {},
    mcpServers: [],
    mcpOverrides: [],
    taskNotes: [],
    turnActiveSessionIds: new Set<string>(),
    previews: [],
    activeTaskId: null
  };
}

function isTaskNote(value: unknown): value is TaskNote {
  if (typeof value !== "object" || value === null) return false;
  const note = value as Record<string, unknown>;
  return typeof note["noteId"] === "string"
    && typeof note["taskId"] === "string"
    && (note["subtaskId"] === undefined || typeof note["subtaskId"] === "string")
    && typeof note["createdAt"] === "string"
    && typeof note["text"] === "string";
}

/**
 * Reads persisted state, tolerating the legacy shape. Unknown/legacy fields are
 * ignored; missing fields fall back to defaults; a malformed blob resets to a
 * clean state instead of throwing. `restart`/`docsState`-era keys are dropped.
 */
export function restore(): AppState {
  const state = freshState();
  const saved = vscode.getState();
  if (typeof saved !== "object" || saved === null) {
    return state;
  }
  const raw = saved as Record<string, unknown>;

  if (Array.isArray(raw["sessions"])) state.sessions = [...(raw["sessions"] as ChatSessionSummary[])];
  if (typeof raw["selectedSessionId"] === "string") state.selectedSessionId = raw["selectedSessionId"];
  if (Array.isArray(raw["chatMessages"])) state.chatMessages = [...(raw["chatMessages"] as ChatMessage[])];
  // Legacy blobs stored the per-session feed under `diagnostics` (and, further
  // back, `transcript`); either seeds the chat diagnostics feed.
  if (Array.isArray(raw["diagnostics"])) {
    state.diagnostics = [...(raw["diagnostics"] as DiagnosticEntry[])];
  } else if (Array.isArray(raw["transcript"])) {
    state.diagnostics = [...(raw["transcript"] as DiagnosticEntry[])];
  }
  // Subagent groups + chip counters; legacy blobs default to empty.
  if (typeof raw["agentGroups"] === "object" && raw["agentGroups"] !== null) {
    state.agentGroups = { ...(raw["agentGroups"] as Record<string, AgentGroup>) };
  }
  if (typeof raw["agentActivity"] === "object" && raw["agentActivity"] !== null) {
    state.agentActivity = { ...(raw["agentActivity"] as Record<string, AgentActivitySummary>) };
  }
  if (typeof raw["agentIdleThresholdMs"] === "number" && Number.isFinite(raw["agentIdleThresholdMs"])) {
    state.agentIdleThresholdMs = raw["agentIdleThresholdMs"];
  }
  if (typeof raw["codeBlockWordWrap"] === "boolean") {
    state.codeBlockWordWrap = raw["codeBlockWordWrap"];
  }
  if (Array.isArray(raw["questions"])) state.questions = [...(raw["questions"] as AgentQuestionSummary[])];
  if (typeof raw["lastSequence"] === "number") state.lastSequence = raw["lastSequence"];
  // providerCatalogs are deliberately NOT restored: a persisted blob from an
  // older extension is exactly the staleness the host-side cache replaces.
  // The host answers panel.init with its durable cache within the first round
  // trip; until then the picker renders its honest loading state.
  if (typeof raw["promptDraft"] === "string") state.promptDraft = raw["promptDraft"];
  if (typeof raw["providerId"] === "string") state.providerId = normalizeProviderId(raw["providerId"]);
  // `selectedModel` (current) or `modelDraft` (older) both name the model.
  if (typeof raw["selectedModel"] === "string") state.selectedModel = raw["selectedModel"];
  else if (typeof raw["modelDraft"] === "string") state.selectedModel = raw["modelDraft"];
  if (typeof raw["thinkingEffort"] === "string" && raw["thinkingEffort"].length > 0 && raw["thinkingEffort"].length <= 120) {
    state.thinkingEffort = raw["thinkingEffort"];
  }
  // Legacy `composerMode` (the retired [Plan | Develop] switch, ADR 0012) is
  // ignored: old persisted blobs simply drop it.
  if (Array.isArray(raw["changedFiles"])) {
    for (const entry of raw["changedFiles"] as unknown[]) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") {
        state.changedFiles.set(entry[0], entry[1]);
      }
    }
  }
  state.lastIsolation = (raw["lastIsolation"] as IsolationSummary | null | undefined) ?? null;
  const restoredWorkspacePolicy = raw["workspacePolicy"] as WorkspacePolicyState | null | undefined;
  if (restoredWorkspacePolicy !== undefined && restoredWorkspacePolicy !== null) {
    // Security decisions are host-authoritative and must be fetched fresh on
    // every webview load; never briefly trust a persisted allocation state.
    const { security: _staleSecurity, ...policyWithoutSecurity } = restoredWorkspacePolicy;
    state.workspacePolicy = policyWithoutSecurity;
  }
  if (typeof raw["selectedWorkspaceSetId"] === "string") state.selectedWorkspaceSetId = raw["selectedWorkspaceSetId"];
  // Legacy `plans`/`selectedPlanId` keys (retired Stage-5 plan gating) are
  // ignored: old persisted blobs simply drop them.
  if (Array.isArray(raw["openFolderNames"])) {
    state.openFolderNames = (raw["openFolderNames"] as unknown[]).filter((n): n is string => typeof n === "string");
  }
  // `tasks` is new for Phase 2; a legacy blob without it defaults to [].
  if (Array.isArray(raw["tasks"])) state.tasks = [...(raw["tasks"] as WorkTaskSummary[])];
  // `attention` is new for Phase 3; keep only string→string[] entries, drop the
  // rest (a legacy blob without it defaults to {}).
  const attention = raw["attention"];
  if (typeof attention === "object" && attention !== null) {
    for (const [sessionId, reasons] of Object.entries(attention as Record<string, unknown>)) {
      if (Array.isArray(reasons) && reasons.every((r): r is string => typeof r === "string")) {
        state.attention[sessionId] = [...reasons];
      }
    }
  }
  if (Array.isArray(raw["taskNotes"])) {
    state.taskNotes = raw["taskNotes"].filter(isTaskNote);
  }
  if (typeof raw["activeTaskId"] === "string") state.activeTaskId = raw["activeTaskId"];
  return state;
}

/** Persists the current state. Maps serialize as entry arrays. */
export function persist(state: AppState): void {
  vscode.setState({
    sessions: state.sessions,
    selectedSessionId: state.selectedSessionId,
    chatMessages: state.chatMessages,
    diagnostics: state.diagnostics,
    agentGroups: state.agentGroups,
    agentActivity: state.agentActivity,
    agentIdleThresholdMs: state.agentIdleThresholdMs,
    codeBlockWordWrap: state.codeBlockWordWrap,
    questions: state.questions,
    lastSequence: state.lastSequence,
    promptDraft: state.promptDraft,
    providerId: state.providerId,
    selectedModel: state.selectedModel,
    thinkingEffort: state.thinkingEffort,
    changedFiles: [...state.changedFiles.entries()],
    lastIsolation: state.lastIsolation,
    workspacePolicy: state.workspacePolicy,
    selectedWorkspaceSetId: state.selectedWorkspaceSetId,
    openFolderNames: state.openFolderNames,
    tasks: state.tasks,
    attention: state.attention,
    taskNotes: state.taskNotes,
    activeTaskId: state.activeTaskId
  });
}

/** Applies the host `panel.init` payload to state (openFolderNames, catalogs). */
export function applyInitState(state: AppState, init: PanelInitState): void {
  applyProviderCatalogs(state, init.providerCatalogs);
  state.openFolderNames = [...init.openFolderNames];
  state.activeEditor = init.activeEditor ?? null;
  state.agentIdleThresholdMs = init.agentIdleThresholdMs;
  state.codeBlockWordWrap = init.codeBlockWordWrap;
}

export function upsertSession(state: AppState, session: ChatSessionSummary): void {
  const index = state.sessions.findIndex((candidate) => candidate.sessionId === session.sessionId);
  if (index === -1) {
    state.sessions.unshift(session);
  } else {
    state.sessions[index] = session;
  }
  state.sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** Upserts one task, keeping the list newest-first by updatedAt. */
export function upsertTask(state: AppState, task: WorkTaskSummary): void {
  const index = state.tasks.findIndex((candidate) => candidate.taskId === task.taskId);
  if (index === -1) {
    state.tasks.unshift(task);
  } else {
    state.tasks[index] = task;
  }
  state.tasks.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/**
 * Applies a host `session.attention` push. Empty reasons clears the session's
 * waiting signal (delete the key); a non-empty list replaces it. Returns whether
 * anything changed, so callers can skip a re-render on a no-op push.
 */
export function applySessionAttention(state: AppState, sessionId: string, reasons: readonly string[]): boolean {
  const previous = state.attention[sessionId];
  if (reasons.length === 0) {
    if (previous === undefined) return false;
    delete state.attention[sessionId];
    return true;
  }
  if (previous !== undefined && previous.length === reasons.length && previous.every((r, i) => r === reasons[i])) {
    return false;
  }
  state.attention[sessionId] = [...reasons];
  return true;
}

/** Upserts one agent question by id (replace-in-place, else append - asked order). */
export function upsertQuestion(state: AppState, question: AgentQuestionSummary): void {
  const index = state.questions.findIndex((candidate) => candidate.questionId === question.questionId);
  if (index === -1) {
    state.questions.push(question);
  } else {
    state.questions[index] = question;
  }
}

export function currentSession(state: AppState): ChatSessionSummary | undefined {
  return state.selectedSessionId === null
    ? undefined
    : state.sessions.find((session) => session.sessionId === state.selectedSessionId);
}

/**
 * The task that owns a session, by the rules every chat surface already uses:
 * a direct `linkedSessionIds` match wins; then a subtask link (a subtask
 * session belongs to its parent task); then the session's `parentSessionId`
 * chain (a spawned child may not be linked itself). Cycle-guarded, since
 * session records are host-provided. Returns undefined for an orphan chat.
 *
 * Pure derivation over state - added for the chat rail's task-attribution line
 * (UX overhaul P2); the Edit tab keeps its own narrower note-scoping rule.
 */
export function owningTaskForSession(state: AppState, sessionId: string | null): WorkTaskSummary | undefined {
  if (sessionId === null) return undefined;
  const direct = state.tasks.find((task) => task.linkedSessionIds.includes(sessionId));
  if (direct !== undefined) return direct;
  for (const task of state.tasks) {
    for (const subtask of task.subtasks) {
      if (subtask.linkedSessionIds.includes(sessionId)) return task;
    }
  }
  const visited = new Set<string>([sessionId]);
  let current = state.sessions.find((session) => session.sessionId === sessionId)?.parentSessionId;
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    const ancestorId = current;
    const viaAncestor = state.tasks.find((task) => task.linkedSessionIds.includes(ancestorId));
    if (viaAncestor !== undefined) return viaAncestor;
    current = state.sessions.find((session) => session.sessionId === ancestorId)?.parentSessionId;
  }
  return undefined;
}

export function isSessionLiveish(state: AppState, sessionId: string): boolean {
  const session = state.sessions.find((candidate) => candidate.sessionId === sessionId);
  if (session === undefined) return false;
  // Authoritative: the host tells us whether the backend is live HERE. Fall back
  // to the stored status only for summaries that predate the `live` field (which
  // the host now always sets) - a reloaded "active" row is NOT live until revived.
  return session.live !== undefined
    ? session.live
    : (session.status === "active" || session.status === "starting");
}

/**
 * Upserts one access request into `state.workspacePolicy.accessRequests`,
 * creating the `workspacePolicy` object (with empty projects/workspaceSets)
 * if it does not exist yet, preserving whatever other fields it already has.
 */
export function upsertAccessRequest(state: AppState, accessRequest: AccessRequestSummary): void {
  const existing = state.workspacePolicy;
  const base = existing ?? { projects: [], workspaceSets: [], accessRequests: [] };
  const index = base.accessRequests.findIndex((candidate) => candidate.accessRequestId === accessRequest.accessRequestId);
  const accessRequests = index === -1
    ? [...base.accessRequests, accessRequest]
    : base.accessRequests.map((candidate) => (candidate.accessRequestId === accessRequest.accessRequestId ? accessRequest : candidate));
  state.workspacePolicy = { ...base, accessRequests };
}
