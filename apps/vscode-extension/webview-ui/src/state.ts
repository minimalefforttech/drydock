/**
 * Webview application state (chat panel redesign, Phase 1).
 *
 * One mutable `AppState` object is the single source of truth for the whole
 * panel; every view reads and mutates it and calls `persist()`. The persisted
 * shape is versioned via `getState`/`setState`; `restore()` migrates the legacy
 * (pre-redesign) persisted shape gracefully — anything that no longer fits is
 * reset rather than crashing.
 *
 * SECURITY: this module holds data only. All dynamic strings that reach the DOM
 * are rendered via textContent by the view modules — never innerHTML — so agent
 * output can never become markup.
 */

import type {
  AccessRequestSummary,
  ActiveEditorRef,
  AgentActivitySummary,
  AgentModelCatalog,
  AgentQuestionSummary,
  BoardColumnSummary,
  ChatSessionSummary,
  ColumnCategory,
  IsolationSummary,
  MemoryCandidateSummary,
  PanelInitState,
  RuntimeSummary,
  WorkspacePolicyState,
  WorkTaskSummary
} from "@drydock/contracts";
import { COLUMN_CATEGORIES } from "@drydock/contracts";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode: VsCodeApi = acquireVsCodeApi();

export type TabId = "work" | "plan" | "chat" | "system";

/** Tasks-tab density: full task cards (default) or the compact recents+tree read. */
export type TasksViewMode = "expanded" | "compact";

/** Compact-tree grouping order: task branches first, or workspace branches first. */
export type CompactGroupOrder = "task" | "workspace";

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

export function fallbackCatalog(): AgentModelCatalog {
  return {
    providerId: CODEX_PROVIDER_ID,
    displayName: "Codex / OpenAI",
    models: [
      { id: "gpt-5.5", displayName: "GPT-5.5", isDefault: true, hidden: false },
      { id: "gpt-5.4", displayName: "GPT-5.4", isDefault: false, hidden: false },
      { id: "gpt-5.4-mini", displayName: "GPT-5.4-Mini", isDefault: false, hidden: false },
      { id: "gpt-5.3-codex-spark", displayName: "GPT-5.3-Codex-Spark", isDefault: false, hidden: false }
    ],
    refreshedAt: new Date().toISOString(),
    source: "fallback",
    diagnostics: ["Static Codex catalog; the backend replaces it via host app-server discovery."]
  };
}

/**
 * Everything the panel keeps between reloads. `activeTab` and `openFolderNames`
 * are new for the redesign; the rest carries the pre-redesign session/chat data.
 */
export interface AppState {
  activeTab: TabId;
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
  /** Non-session (probe/run/runtime) lines shown on the System tab. */
  systemLog: DiagnosticEntry[];
  lastSequence: number;
  runtimes: readonly RuntimeSummary[];
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
  /** The plan whose session the Plan tab's rail follows; null = most recent. */
  planTabPlanId: string | null;
  openFolderNames: readonly string[];
  /** The window's active editor (host-reported), offered as a composer
   * attachment; null when none. Transient — not persisted. */
  activeEditor: ActiveEditorRef | null;
  /** Internal work tasks, newest-first by updatedAt. */
  tasks: WorkTaskSummary[];
  /** Board columns (task board and subtasks); ordered by sortOrder at render time. */
  boardColumns: BoardColumnSummary[];
  /**
   * Per-session waiting-on-user signal (Phase 3 attention routing). Maps a
   * sessionId to its active attention reasons ("turn-completed" | "turn-failed"
   * | "access-request"); a session with no key has nothing waiting. Persisted so
   * the "waiting" markers survive a reload until the host re-pushes or the user
   * clears them by selecting the session. Driven by the host `session.attention`
   * push (see `applySessionAttention`).
   */
  attention: Record<string, readonly string[]>;
  /**
   * Agent-proposed memory candidates. All statuses are kept so
   * the Memory section can render pending cards plus a dim "Memories (N)"
   * sub-list; newest-first is imposed at render time. Persisted so the section
   * survives a reload until `memory.list` re-hydrates it; a legacy blob without
   * it migrates to [].
   */
  memoryCandidates: MemoryCandidateSummary[];
  /** Webview-local task notes keyed by durable taskId. */
  taskNotes: TaskNote[];
  /**
   * Sessions currently running a turn (from chat.turnStarted/turnCompleted
   * pushes). Transient — rebuilt from pushes after a reload — but lets every
   * session row show running-a-turn vs idle-live, not just the selected one.
   */
  turnActiveSessionIds: Set<string>;
  /** Tasks-tab view density (expanded cards vs the compact tree). */
  tasksViewMode: TasksViewMode;
  /** Compact-tree grouping order (task-first vs workspace-first). */
  compactGroupOrder: CompactGroupOrder;
}

function freshState(): AppState {
  return {
    activeTab: "work",
    sessions: [],
    selectedSessionId: null,
    chatMessages: [],
    diagnostics: [],
    agentGroups: {},
    agentActivity: {},
    agentIdleThresholdMs: 5 * 60_000,
    codeBlockWordWrap: true,
    questions: [],
    systemLog: [],
    lastSequence: 0,
    runtimes: [],
    providerCatalogs: [fallbackCatalog()],
    promptDraft: "",
    providerId: CODEX_PROVIDER_ID,
    selectedModel: "",
    thinkingEffort: "medium",
    changedFiles: new Map(),
    lastIsolation: null,
    workspacePolicy: null,
    selectedWorkspaceSetId: "",
    planTabPlanId: null,
    openFolderNames: [],
    activeEditor: null,
    tasks: [],
    boardColumns: [],
    attention: {},
    memoryCandidates: [],
    taskNotes: [],
    turnActiveSessionIds: new Set<string>(),
    tasksViewMode: "expanded",
    compactGroupOrder: "task"
  };
}

function isTabId(value: unknown): value is TabId {
  return value === "work" || value === "plan" || value === "chat" || value === "system";
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

function isColumnCategory(value: unknown): value is ColumnCategory {
  return typeof value === "string" && (COLUMN_CATEGORIES as readonly string[]).includes(value);
}

function isBoardColumnSummary(value: unknown): value is BoardColumnSummary {
  if (typeof value !== "object" || value === null) return false;
  const column = value as Record<string, unknown>;
  return typeof column["columnId"] === "string"
    && typeof column["name"] === "string"
    && isColumnCategory(column["category"])
    && typeof column["sortOrder"] === "number";
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

  if (isTabId(raw["activeTab"])) state.activeTab = raw["activeTab"];
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
  if (Array.isArray(raw["systemLog"])) state.systemLog = [...(raw["systemLog"] as DiagnosticEntry[])];
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
  if (Array.isArray(raw["runtimes"])) state.runtimes = raw["runtimes"] as readonly RuntimeSummary[];
  state.providerCatalogs = Array.isArray(raw["providerCatalogs"]) && raw["providerCatalogs"].length > 0
    ? [...(raw["providerCatalogs"] as AgentModelCatalog[])]
    : [fallbackCatalog()];
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
  if (typeof raw["planTabPlanId"] === "string") state.planTabPlanId = raw["planTabPlanId"];
  // Legacy `plans`/`selectedPlanId` keys (retired Stage-5 plan gating) are
  // ignored: old persisted blobs simply drop them.
  if (Array.isArray(raw["openFolderNames"])) {
    state.openFolderNames = (raw["openFolderNames"] as unknown[]).filter((n): n is string => typeof n === "string");
  }
  // `tasks` is new for Phase 2; a legacy blob without it defaults to [].
  if (Array.isArray(raw["tasks"])) state.tasks = [...(raw["tasks"] as WorkTaskSummary[])];
  // `boardColumns` is newer than some persisted blobs; validate array-of-objects
  // shape defensively, else drop to [] (board.state re-hydrates it regardless).
  if (Array.isArray(raw["boardColumns"]) && raw["boardColumns"].every(isBoardColumnSummary)) {
    state.boardColumns = [...(raw["boardColumns"] as BoardColumnSummary[])];
  }
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
  // `memoryCandidates` is a later addition; a legacy blob without it
  // defaults to []. memory.list re-hydrates it on boot regardless.
  if (Array.isArray(raw["memoryCandidates"])) {
    state.memoryCandidates = [...(raw["memoryCandidates"] as MemoryCandidateSummary[])];
  }
  if (Array.isArray(raw["taskNotes"])) {
    state.taskNotes = raw["taskNotes"].filter(isTaskNote);
  }
  // Tasks-tab view prefs are later additions; legacy blobs keep the defaults.
  if (raw["tasksViewMode"] === "expanded" || raw["tasksViewMode"] === "compact") {
    state.tasksViewMode = raw["tasksViewMode"];
  }
  if (raw["compactGroupOrder"] === "task" || raw["compactGroupOrder"] === "workspace") {
    state.compactGroupOrder = raw["compactGroupOrder"];
  }
  return state;
}

/** Persists the current state. Maps serialize as entry arrays. */
export function persist(state: AppState): void {
  vscode.setState({
    activeTab: state.activeTab,
    sessions: state.sessions,
    selectedSessionId: state.selectedSessionId,
    chatMessages: state.chatMessages,
    diagnostics: state.diagnostics,
    agentGroups: state.agentGroups,
    agentActivity: state.agentActivity,
    agentIdleThresholdMs: state.agentIdleThresholdMs,
    codeBlockWordWrap: state.codeBlockWordWrap,
    questions: state.questions,
    systemLog: state.systemLog,
    lastSequence: state.lastSequence,
    runtimes: state.runtimes,
    providerCatalogs: state.providerCatalogs,
    promptDraft: state.promptDraft,
    providerId: state.providerId,
    selectedModel: state.selectedModel,
    thinkingEffort: state.thinkingEffort,
    changedFiles: [...state.changedFiles.entries()],
    lastIsolation: state.lastIsolation,
    workspacePolicy: state.workspacePolicy,
    selectedWorkspaceSetId: state.selectedWorkspaceSetId,
    planTabPlanId: state.planTabPlanId,
    openFolderNames: state.openFolderNames,
    tasks: state.tasks,
    boardColumns: state.boardColumns,
    attention: state.attention,
    memoryCandidates: state.memoryCandidates,
    taskNotes: state.taskNotes,
    tasksViewMode: state.tasksViewMode,
    compactGroupOrder: state.compactGroupOrder
  });
}

/** Applies the host `panel.init` payload to state (openFolderNames, catalogs). */
export function applyInitState(state: AppState, init: PanelInitState): void {
  state.runtimes = init.runtimes;
  state.providerCatalogs = [...init.providerCatalogs];
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

/** Upserts every task in `tasks` (e.g. a `board.moveCard`/`board.state` response). */
export function upsertTasks(state: AppState, tasks: readonly WorkTaskSummary[]): void {
  for (const task of tasks) upsertTask(state, task);
}

/**
 * Upserts one memory candidate by id (replace-in-place, else prepend). Ordering
 * for display is imposed at render time (newest-first by createdAt), so this
 * only keeps the list de-duplicated.
 */
export function upsertMemoryCandidate(state: AppState, candidate: MemoryCandidateSummary): void {
  const index = state.memoryCandidates.findIndex((c) => c.memoryCandidateId === candidate.memoryCandidateId);
  if (index === -1) {
    state.memoryCandidates.unshift(candidate);
  } else {
    state.memoryCandidates[index] = candidate;
  }
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

/**
 * Highest-priority attention reason for a session (failed > approval > done),
 * or null when nothing is waiting. Drives the single Tasks-row marker chip.
 */
export function topAttentionReason(state: AppState, sessionId: string): string | null {
  const reasons = state.attention[sessionId];
  if (reasons === undefined || reasons.length === 0) return null;
  if (reasons.includes("turn-failed")) return "turn-failed";
  if (reasons.includes("access-request")) return "access-request";
  if (reasons.includes("turn-completed")) return "turn-completed";
  return reasons[0] ?? null;
}

/** Upserts one agent question by id (replace-in-place, else append — asked order). */
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

export function isSessionLiveish(state: AppState, sessionId: string): boolean {
  const session = state.sessions.find((candidate) => candidate.sessionId === sessionId);
  if (session === undefined) return false;
  // Authoritative: the host tells us whether the backend is live HERE. Fall back
  // to the stored status only for summaries that predate the `live` field (which
  // the host now always sets) — a reloaded "active" row is NOT live until revived.
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
