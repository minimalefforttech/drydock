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
  AgentModelCatalog,
  AgentQuestionSummary,
  ChatSessionSummary,
  IsolationSummary,
  JsonObject,
  MemoryCandidateSummary,
  PanelInitState,
  RuntimeSummary,
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

export type TabId = "chat" | "work" | "system";

export interface ChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "group";
  readonly createdAt: string;
  readonly text: string;
  readonly streaming?: boolean;
  /** role "group": the subagent group block this row renders. */
  readonly nodeId?: string;
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
  readonly nodeStatus?: "running" | "completed" | "failed" | "cancelled";
  readonly toolStatus?: "started" | "completed" | "failed";
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
  createdAt: string;
  endedAt?: string;
  entries: AgentGroupEntry[];
  children: string[];
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
  agentActivity: Record<string, { running: number; failed: number }>;
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
  composerMode: "implementation" | "plan" | "clone";
  changedFiles: Map<string, string>;
  lastIsolation: IsolationSummary | null;
  workspacePolicy: WorkspacePolicyState | null;
  selectedWorkspaceSetId: string;
  selectedSessionMode: string;
  openFolderNames: readonly string[];
  /** Internal work tasks, newest-first by updatedAt. */
  tasks: WorkTaskSummary[];
  /**
   * Plan documents collected for the selected session (drives the "Plan
   * documents (N)" pill above the composer); null when the selected session has
   * none. Summaries only — the panel fetches full content itself.
   */
  planDocs: { sessionId: string; docs: readonly { name: string; format: string; revision: number }[] } | null;
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
   * the Memory section can render pending cards plus a dim "Approved (N)"
   * sub-list; newest-first is imposed at render time. Persisted so the section
   * survives a reload until `memory.list` re-hydrates it; a legacy blob without
   * it migrates to [].
   */
  memoryCandidates: MemoryCandidateSummary[];
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
    questions: [],
    systemLog: [],
    lastSequence: 0,
    runtimes: [],
    providerCatalogs: [fallbackCatalog()],
    promptDraft: "",
    providerId: CODEX_PROVIDER_ID,
    selectedModel: "",
    composerMode: "implementation",
    changedFiles: new Map(),
    lastIsolation: null,
    workspacePolicy: null,
    selectedWorkspaceSetId: "",
    selectedSessionMode: "implementation",
    openFolderNames: [],
    tasks: [],
    planDocs: null,
    attention: {},
    memoryCandidates: []
  };
}

function isTabId(value: unknown): value is TabId {
  return value === "chat" || value === "work" || value === "system";
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
    state.agentActivity = { ...(raw["agentActivity"] as Record<string, { running: number; failed: number }>) };
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
  if (raw["composerMode"] === "plan" || raw["composerMode"] === "implementation" || raw["composerMode"] === "clone") {
    state.composerMode = raw["composerMode"];
  }
  if (Array.isArray(raw["changedFiles"])) {
    for (const entry of raw["changedFiles"] as unknown[]) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") {
        state.changedFiles.set(entry[0], entry[1]);
      }
    }
  }
  state.lastIsolation = (raw["lastIsolation"] as IsolationSummary | null | undefined) ?? null;
  state.workspacePolicy = (raw["workspacePolicy"] as WorkspacePolicyState | null | undefined) ?? null;
  if (typeof raw["selectedWorkspaceSetId"] === "string") state.selectedWorkspaceSetId = raw["selectedWorkspaceSetId"];
  if (typeof raw["selectedSessionMode"] === "string") state.selectedSessionMode = raw["selectedSessionMode"];
  // Legacy `plans`/`selectedPlanId` keys (retired Stage-5 plan gating) are
  // ignored: old persisted blobs simply drop them.
  if (Array.isArray(raw["openFolderNames"])) {
    state.openFolderNames = (raw["openFolderNames"] as unknown[]).filter((n): n is string => typeof n === "string");
  }
  // `tasks` is new for Phase 2; a legacy blob without it defaults to [].
  if (Array.isArray(raw["tasks"])) state.tasks = [...(raw["tasks"] as WorkTaskSummary[])];
  // `planDocs` is new for Phase 2; validate its shape or drop to null.
  const planDocs = raw["planDocs"];
  if (typeof planDocs === "object" && planDocs !== null) {
    const pd = planDocs as Record<string, unknown>;
    if (typeof pd["sessionId"] === "string" && Array.isArray(pd["docs"])) {
      state.planDocs = {
        sessionId: pd["sessionId"],
        docs: pd["docs"] as readonly { name: string; format: string; revision: number }[]
      };
    }
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
    questions: state.questions,
    systemLog: state.systemLog,
    lastSequence: state.lastSequence,
    runtimes: state.runtimes,
    providerCatalogs: state.providerCatalogs,
    promptDraft: state.promptDraft,
    providerId: state.providerId,
    selectedModel: state.selectedModel,
    composerMode: state.composerMode,
    changedFiles: [...state.changedFiles.entries()],
    lastIsolation: state.lastIsolation,
    workspacePolicy: state.workspacePolicy,
    selectedWorkspaceSetId: state.selectedWorkspaceSetId,
    selectedSessionMode: state.selectedSessionMode,
    openFolderNames: state.openFolderNames,
    tasks: state.tasks,
    planDocs: state.planDocs,
    attention: state.attention,
    memoryCandidates: state.memoryCandidates
  });
}

/** Applies the host `panel.init` payload to state (openFolderNames, catalogs). */
export function applyInitState(state: AppState, init: PanelInitState): void {
  state.runtimes = init.runtimes;
  state.providerCatalogs = [...init.providerCatalogs];
  state.openFolderNames = [...init.openFolderNames];
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
 * or null when nothing is waiting. Drives the single Work-row marker chip.
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
  return session !== undefined && (session.status === "active" || session.status === "starting");
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
