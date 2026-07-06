/**
 * Panel v0 webview message contracts.
 *
 * Everything crossing the extension-host/webview boundary is a versioned
 * envelope: requests carry a correlation id, responses answer exactly one
 * request, pushes carry a per-panel-session sequence so a reloaded webview can
 * detect gaps. IDs are plain strings here on purpose — the webview is outside
 * the trusted boundary, so payloads stay display-safe (no runtime handles, no
 * secrets, host paths only as display strings).
 *
 * `parsePanelRequest` is the single validation gate for webview input; the
 * extension host must reject anything it returns null for.
 */

import type { AgentModelCatalog } from "./agent.js";
import type { DiffChangeKind, ReviewThreadStatus } from "./diffs.js";
import type { TranscriptLine } from "./events.js";
import type { AgentRole } from "./ids.js";
import type { MemoryCandidateStatus } from "./memory.js";
import type { PlanDocFormat } from "./planDocs.js";
import { COLUMN_CATEGORIES, WORK_TASK_STATES, type ColumnCategory, type WorkTaskState } from "./tasks.js";
import type { AccessRequestStatus } from "./workspaces.js";

export const WEBVIEW_PROTOCOL_VERSION = 1;
/** Roles a user may spawn as child sessions. */
export const SPAWNABLE_AGENT_ROLES: readonly AgentRole[] = ["researcher", "planner", "worker", "tester", "reviewer"];
export const MAX_PROMPT_LENGTH = 20_000;
export const MAX_CLIPBOARD_LENGTH = 200_000;
export const MAX_ID_LENGTH = 200;
export const MAX_MODEL_ID_LENGTH = 120;
export const MAX_PATH_LENGTH = 1_024;
export const MAX_COMMENT_LENGTH = 4_000;
export const MAX_NAME_LENGTH = 200;

export interface ChatModelSelection {
  readonly providerId: string;
  readonly model?: string;
}

/** Session start modes supported by the host. Clone mounts no live roots. */
export type ChatSessionModeSelection = "plan" | "implementation" | "clone";

/**
 * Mounting selection for a new chat session: either an explicit workspace
 * set, or `auto` — the host derives the roots from the open VS Code folders
 * plus configured shared paths (the default, ceremony-free path).
 */
export type ChatWorkspaceSelection =
  | { readonly workspaceSetId: string; readonly mode: ChatSessionModeSelection }
  | { readonly auto: true; readonly mode: ChatSessionModeSelection };

// ---------------------------------------------------------------------------
// Webview -> extension host
// ---------------------------------------------------------------------------

export type PanelRequestPayload =
  | { readonly type: "panel.init" }
  | { readonly type: "isolatedRun.probeAppServer" }
  | { readonly type: "isolatedRun.listRuntimes"; readonly includeRemoved?: boolean }
  | { readonly type: "isolatedRun.stopRuntime"; readonly runtimeId: string }
  | { readonly type: "chat.start"; readonly prompt: string; readonly model?: ChatModelSelection; readonly workspace?: ChatWorkspaceSelection }
  | { readonly type: "chat.startSession"; readonly model: ChatModelSelection; readonly workspace?: ChatWorkspaceSelection }
  | { readonly type: "chat.sendTurn"; readonly sessionId: string; readonly prompt: string; readonly model?: ChatModelSelection }
  | { readonly type: "chat.restartBackend"; readonly sessionId: string; readonly model: ChatModelSelection }
  | { readonly type: "chat.resumeSession"; readonly sessionId: string; readonly model?: ChatModelSelection; readonly workspace?: ChatWorkspaceSelection }
  | { readonly type: "chat.cancelTurn"; readonly sessionId: string }
  | { readonly type: "chat.endSession"; readonly sessionId: string }
  | { readonly type: "chat.spawnRole"; readonly sessionId: string; readonly role: AgentRole }
  | { readonly type: "question.list" }
  | { readonly type: "question.answer"; readonly questionId: string; readonly answer: string }
  | { readonly type: "question.dismiss"; readonly questionId: string }
  | { readonly type: "clipboard.writeText"; readonly text: string }
  | { readonly type: "provider.list" }
  | { readonly type: "provider.login"; readonly providerId: string }
  | { readonly type: "session.list" }
  | { readonly type: "session.timeline"; readonly sessionId: string; readonly fromSequence?: number }
  | { readonly type: "session.rename"; readonly sessionId: string; readonly title: string }
  | { readonly type: "session.setDescription"; readonly sessionId: string; readonly description: string }
  | { readonly type: "session.delete"; readonly sessionId: string }
  | { readonly type: "task.list" }
  | { readonly type: "task.create"; readonly title: string; readonly description?: string }
  | { readonly type: "task.update"; readonly taskId: string; readonly title?: string; readonly description?: string; readonly state?: WorkTaskState }
  | { readonly type: "task.delete"; readonly taskId: string }
  | { readonly type: "task.link"; readonly taskId: string; readonly workspaceSetId?: string; readonly sessionId?: string }
  | { readonly type: "task.unlink"; readonly taskId: string; readonly workspaceSetId?: string; readonly sessionId?: string }
  | { readonly type: "workspace.openInNewWindow"; readonly workspaceSetId: string }
  | { readonly type: "workspace.activate"; readonly taskId?: string; readonly workspaceSetId?: string }
  | { readonly type: "work.history"; readonly workspaceSetId?: string; readonly projectId?: string }
  | { readonly type: "memory.list" }
  | { readonly type: "memory.resolve"; readonly memoryCandidateId: string; readonly approve: boolean }
  | { readonly type: "memory.open"; readonly memoryCandidateId: string }
  | { readonly type: "workspace.state" }
  | { readonly type: "workspace.registerOpenFolders" }
  | { readonly type: "workspace.createSet"; readonly name: string }
  | { readonly type: "policy.requestAccess"; readonly sessionId: string; readonly hostPath: string; readonly mode: "read-only" | "read-write"; readonly reason: string }
  | { readonly type: "policy.resolveAccess"; readonly accessRequestId: string; readonly approve: boolean; readonly editedHostPath?: string }
  | { readonly type: "diff.snapshotWorkspace"; readonly workspaceSetId: string }
  | { readonly type: "diff.status"; readonly sessionId?: string }
  | { readonly type: "diff.acceptFile"; readonly baselineId: string; readonly path: string }
  | { readonly type: "diff.revertFile"; readonly baselineId: string; readonly path: string }
  | { readonly type: "diff.openFile"; readonly baselineId: string; readonly path: string }
  | { readonly type: "review.state"; readonly sessionId?: string }
  | { readonly type: "review.addComment"; readonly sessionId?: string; readonly filePath: string; readonly startLine: number; readonly endLine: number; readonly body: string }
  | { readonly type: "review.setCommentStatus"; readonly commentId: string; readonly status: ReviewThreadStatus }
  | { readonly type: "planDocs.state"; readonly sessionId: string }
  | { readonly type: "planDocs.open"; readonly sessionId: string }
  | { readonly type: "planDocs.sendComments"; readonly sessionId: string }
  | { readonly type: "clone.state"; readonly sessionId: string }
  | { readonly type: "clone.pull"; readonly sessionId: string; readonly repo?: string; readonly path?: string }
  | { readonly type: "clone.push"; readonly sessionId: string }
  | { readonly type: "clone.discard"; readonly sessionId: string; readonly repo: string; readonly path: string }
  | { readonly type: "taskReview.open"; readonly taskId: string }
  | { readonly type: "taskReview.state"; readonly taskId: string }
  | { readonly type: "taskReview.submit"; readonly taskId: string }
  | { readonly type: "board.state" }
  | { readonly type: "board.moveCard"; readonly cardKind: "task" | "subtask"; readonly id: string; readonly columnId: string }
  | { readonly type: "board.columns.update"; readonly columns: readonly BoardColumnUpdateInput[]; readonly deletedColumnIds?: readonly string[] }
  | { readonly type: "subtask.create"; readonly taskId: string; readonly title: string; readonly description?: string; readonly prompt?: string; readonly autoStart?: boolean }
  | { readonly type: "subtask.update"; readonly subtaskId: string; readonly title?: string; readonly description?: string; readonly prompt?: string; readonly autoStart?: boolean; readonly columnId?: string }
  | { readonly type: "subtask.delete"; readonly subtaskId: string }
  | { readonly type: "subtask.dependency.add"; readonly taskId: string; readonly fromSubtaskId: string; readonly toSubtaskId: string }
  | { readonly type: "subtask.dependency.remove"; readonly taskId: string; readonly fromSubtaskId: string; readonly toSubtaskId: string }
  | { readonly type: "subtask.start"; readonly subtaskId: string; readonly force?: boolean }
  | { readonly type: "task.start"; readonly taskId: string }
  | { readonly type: "taskBoard.open" };

/**
 * One column entry in a `board.columns.update` request: `columnId` present
 * updates that column, absent creates a new one. The service reconciles the
 * full set (add/rename/reorder) against what is currently stored. A sibling
 * `deletedColumnIds` on the request (not per-entry) names columns to remove —
 * the service moves their cards to the nearest same-category column and
 * rejects deleting the last column of a category.
 */
export interface BoardColumnUpdateInput {
  readonly columnId?: string;
  readonly name: string;
  readonly category: ColumnCategory;
  readonly sortOrder: number;
}

export interface PanelRequest {
  readonly protocolVersion: typeof WEBVIEW_PROTOCOL_VERSION;
  readonly kind: "request";
  readonly requestId: string;
  readonly payload: PanelRequestPayload;
}

// ---------------------------------------------------------------------------
// Extension host -> webview
// ---------------------------------------------------------------------------

/** Whether the isolated backend can run at all on this machine. */
export interface BackendAvailability {
  readonly available: boolean;
  /** Present when unavailable; a user-actionable explanation. */
  readonly reason?: string;
  /** Display string of the discovered sbx binary. */
  readonly sbxDisplayPath?: string;
}

/** Display-safe projection of the isolation boundary for one run. */
export interface IsolationSummary {
  readonly runtimeKind: "docker-sandbox";
  readonly network: "none" | "provider-scoped";
  /** Comma-separated allowlist when network is provider-scoped. */
  readonly networkAllowlist?: string;
  readonly mounts: readonly {
    readonly runtimePath: string;
    readonly mode: "read-only" | "read-write";
    /** Host path as a display string only. */
    readonly hostDisplayPath?: string;
  }[];
  readonly workspaceDisplayPath: string;
}

/** Display-safe projection of one inventory record. */
export interface RuntimeSummary {
  readonly runtimeId: string;
  readonly externalName: string;
  readonly status: string;
  readonly startedAt: string;
  readonly agentRole?: string;
}

/** Display-safe projection of a durable chat session. */
export interface ChatSessionSummary {
  readonly sessionId: string;
  readonly title: string;
  /** User-authored summary/notes shown on session cards. */
  readonly description?: string;
  readonly status: string;
  readonly providerId: string;
  readonly model?: string;
  /** Active in another VS Code window (fresh foreign heartbeat): view-only here. */
  readonly runningElsewhere?: boolean;
  /** Session mode recorded at start; clone sessions drive the sync UI. */
  readonly mode?: ChatSessionModeSelection;
  /** Agent transport — drives the webview's subagent capability tier. */
  readonly transport?: string;
  /** Live subagent counters for the ⑂ chip (host-derived; local-live sessions only). */
  readonly agentActivity?: AgentActivitySummary;
  /** Spawned-by lineage for product-owned role sessions. */
  readonly parentSessionId?: string;
  /** Role this session plays when spawned as a child. */
  readonly spawnedRole?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One compact live/delegated-agent summary for scan views. */
export interface AgentActivityItem {
  readonly nodeId: string;
  readonly parentNodeId?: string;
  readonly label: string;
  readonly status: "running" | "completed" | "failed" | "cancelled" | "unknown";
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly lastActivityAt?: string;
  readonly lastActivity?: string;
  readonly lastCommand?: string;
  readonly toolUses: number;
  readonly tokens?: number;
}

/** Live subagent summary folded by the host from structured agent events. */
export interface AgentActivitySummary {
  readonly running: number;
  readonly failed: number;
  readonly agents?: readonly AgentActivityItem[];
}

/** One agent-changed file in a clone, relative to the sync base. */
export interface CloneFileChange {
  readonly path: string;
  readonly changeKind: DiffChangeKind;
  readonly addedLines?: number;
  readonly removedLines?: number;
  /** Unresolved conflict markers present (from a prior sync). */
  readonly conflicted?: boolean;
}

/** Per-repo clone sync state for one clone-mode session. */
export interface CloneRepoState {
  readonly name: string;
  readonly branch: string;
  readonly files: readonly CloneFileChange[];
}

/** Result of a pull/push sync operation. */
export interface CloneSyncResult {
  readonly appliedFiles: number;
  readonly conflictedFiles: readonly string[];
  readonly untrackedCopied?: number;
  /** Human-readable outcome line for the diagnostics feed. */
  readonly message: string;
}

/**
 * One changed file in a cross-project task review, owned by the session
 * that produced it. Baseline-backed files carry the baselineId that
 * diff.openFile needs; clone-session files carry `clone` instead and are
 * reviewed through the owning session's sync working set.
 */
export interface TaskReviewFile {
  readonly sessionId: string;
  readonly sessionTitle: string;
  /** Diff baseline backing the native diff editor; absent on clone files. */
  readonly baselineId?: string;
  /** Project (repo/root) display name the file belongs to. */
  readonly repo: string;
  /** Root-relative path with forward slashes. */
  readonly path: string;
  readonly changeKind: DiffChangeKind;
  /** Line-diff stats vs the baseline/sync base; absent for binary/oversized files. */
  readonly addedLines?: number;
  readonly removedLines?: number;
  /** Open review comments anchored to this file (`<repo>:<path>` or plain path). */
  readonly commentCount: number;
  /** Clone-session file with unresolved sync conflict markers. */
  readonly conflicted?: boolean;
  /** From a clone-mode session: no baseline diff; deep-link to its sync UI. */
  readonly clone?: boolean;
}

/** One project (repo/root) group in a task review, files across all sessions. */
export interface TaskReviewProject {
  readonly name: string;
  readonly files: readonly TaskReviewFile[];
}

/** One linked session in a task review (drives the comment dock's per-session reads). */
export interface TaskReviewSessionRef {
  readonly sessionId: string;
  readonly sessionTitle: string;
}

/** Everything the task-review panel renders for one task. */
export interface TaskReviewState {
  readonly taskId: string;
  readonly title: string;
  /**
   * Every linked session with a stored record, in link order — including
   * sessions with no changed files (their comments still show in the dock).
   */
  readonly sessions: readonly TaskReviewSessionRef[];
  readonly projects: readonly TaskReviewProject[];
  /** All open code comments across linked sessions — what Submit would send. */
  readonly openCommentCount: number;
  /** Linked sessions currently running a turn; absent when none are. */
  readonly revisionInFlight?: number;
  /** Degraded-fetch honesty lines (e.g. a clone session not live in this window). */
  readonly notes?: readonly string[];
}

/** Outcome of a task/set activation against the current window's folders. */
export interface WorkspaceActivateResult {
  readonly outcome: "replaced" | "appended" | "new-window" | "cancelled" | "no-change";
  readonly added: number;
  readonly removed: number;
  /** True when the chosen action reloads this window (folder-state transition). */
  readonly windowReload?: boolean;
}

/** Transcript line paired with its durable replay sequence. */
export interface SequencedTranscriptLine extends TranscriptLine {
  readonly sequence: number;
  readonly final?: boolean;
}

/** Display-safe projection of a registered project. */
export interface ProjectSummary {
  readonly projectId: string;
  readonly name: string;
  readonly displayPath: string;
  readonly kind: string;
}

/** Display-safe projection of a workspace set. */
export interface WorkspaceSetSummary {
  readonly workspaceSetId: string;
  readonly name: string;
  readonly projectNames: readonly string[];
}

/** Display-safe projection of an access request. */
export interface AccessRequestSummary {
  readonly accessRequestId: string;
  readonly sessionId: string;
  readonly displayPath: string;
  readonly mode: "read-only" | "read-write";
  readonly reason: string;
  readonly status: AccessRequestStatus;
  readonly requestedAt: string;
  /**
   * Host-computed: the path matches a sensitive pattern (credentials, keys,
   * env files). The approval card escalates to a typed confirmation.
   */
  readonly sensitive?: boolean;
  /** Why it is sensitive: display text naming the matched directory/pattern. */
  readonly sensitiveReason?: string;
}

/** Why a session is waiting on the user (drives badge/toast/row markers). */
export type SessionAttentionReason = "turn-completed" | "turn-failed" | "access-request" | "question";

/** Display-safe projection of one pending/resolved agent question. */
export interface AgentQuestionSummary {
  readonly questionId: string;
  readonly sessionId: string;
  readonly question: string;
  /** Agent-suggested answers, first = the agent's recommendation. May be empty. */
  readonly options: readonly string[];
  readonly status: "pending" | "answered" | "dismissed";
  readonly answer?: string;
  readonly createdAt: string;
}

/** Display-safe projection of a board column (task board and subtasks). */
export interface BoardColumnSummary {
  readonly columnId: string;
  readonly name: string;
  readonly category: ColumnCategory;
  readonly sortOrder: number;
}

/** Display-safe projection of a subtask, including its computed blocked state. */
export interface SubtaskSummary {
  readonly subtaskId: string;
  readonly taskId: string;
  readonly title: string;
  readonly description?: string;
  readonly prompt?: string;
  readonly autoStart: boolean;
  readonly origin: "manual" | "review";
  readonly columnId: string;
  readonly sortOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly doneAt?: string;
  /** Computed: any upstream dependency not currently in a done-category column. */
  readonly isBlocked: boolean;
  /** Upstream dependency subtask ids (each edge points upstream → this subtask). */
  readonly dependsOn: readonly string[];
  /** Computed: a chat spawned for this subtask is in flight (in-memory; resets on host restart). */
  readonly isRunning: boolean;
  /** Timestamp of the most recent failed/cancelled run, if any (in-memory; resets on host restart). */
  readonly lastFailureAt?: string;
  readonly linkedSessionIds: readonly string[];
}

/** Display-safe projection of an internal work task with its links. */
export interface WorkTaskSummary {
  readonly taskId: string;
  readonly title: string;
  readonly description?: string;
  /**
   * transitional: kept alongside columnId until the board UI fully replaces
   * the flat state select. Derived fresh from columnId's category.
   */
  readonly state: WorkTaskState;
  readonly columnId: string;
  readonly linkedWorkspaceSetIds: readonly string[];
  readonly linkedSessionIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Stamped when the card enters a done-category column; cleared on exit. */
  readonly doneAt?: string;
  /** Latest linked-session activity (derived from work sessions); absent when never worked. */
  readonly lastWorkedAt?: string;
  /**
   * Open (non-plan) review comments across the task's linked sessions; absent
   * when zero or when the join was unavailable. Joined into task.list only —
   * task.updated pushes may omit it until the next list.
   */
  readonly openReviewCommentCount?: number;
  /** This task's subtasks, ordered by sortOrder. */
  readonly subtasks: readonly SubtaskSummary[];
}

/** Everything the Task Board panel renders: all columns, all tasks (with their subtasks). */
export interface BoardState {
  readonly columns: readonly BoardColumnSummary[];
  readonly tasks: readonly WorkTaskSummary[];
}

/** One touch-history entry: who worked a workspace, through which chat, when. */
export interface WorkHistoryEntry {
  readonly taskId?: string;
  readonly taskTitle?: string;
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly lastActivityAt: string;
  readonly turnCount: number;
}

/** Display-safe projection of an agent-proposed memory candidate. */
export interface MemoryCandidateSummary {
  readonly memoryCandidateId: string;
  readonly sessionId: string;
  readonly content: string;
  readonly status: MemoryCandidateStatus;
  readonly createdAt: string;
}

/** Everything the workspace policy panel section renders. */
export interface WorkspacePolicyState {
  readonly projects: readonly ProjectSummary[];
  readonly workspaceSets: readonly WorkspaceSetSummary[];
  readonly accessRequests: readonly AccessRequestSummary[];
}

/** Display-safe projection of one changed file in a diff. */
export interface DiffFileSummary {
  readonly baselineId: string;
  /** Display name of the snapshotted root (not a full host path). */
  readonly rootName: string;
  readonly path: string;
  readonly changeKind: DiffChangeKind;
  readonly oldPath?: string;
  /** Line-diff stats vs the baseline; absent for binary/oversized files. */
  readonly addedLines?: number;
  readonly removedLines?: number;
  readonly revertSupported: boolean;
  readonly reason?: string;
}

/** Display-safe projection of a review comment thread. */
export interface ReviewCommentSummary {
  readonly commentId: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly body: string;
  readonly author: string;
  readonly status: ReviewThreadStatus;
  readonly intent?: string;
  readonly blockId?: string;
  readonly createdAt: string;
}

/** Display-safe plan-document listing entry (no content). */
export interface PlanDocSummary {
  readonly name: string;
  readonly format: PlanDocFormat;
  readonly revision: number;
  readonly collectedAt: string;
}

/** Full plan document for the review panel; content renders textContent-only. */
export interface PlanDocDetail extends PlanDocSummary {
  readonly content: string;
}

export interface PanelInitState {
  readonly availability: BackendAvailability;
  readonly runtimes: readonly RuntimeSummary[];
  readonly providerCatalogs: readonly AgentModelCatalog[];
  readonly stateRootDisplayPath: string;
  /** Folder names open in this window; the `auto` workspace selection mounts these. */
  readonly openFolderNames: readonly string[];
  /** Idle label threshold for delegated agents. */
  readonly agentIdleThresholdMs: number;
  /** Wrap long lines inside chat transcript code blocks. */
  readonly codeBlockWordWrap: boolean;
}

export type PanelResponsePayload =
  | { readonly type: "panel.init"; readonly state: PanelInitState }
  | { readonly type: "isolatedRun.probeAppServer"; readonly accepted: true }
  | { readonly type: "isolatedRun.listRuntimes"; readonly runtimes: readonly RuntimeSummary[] }
  | { readonly type: "isolatedRun.stopRuntime"; readonly runtimeId: string; readonly status: string; readonly diagnostics: readonly string[] }
  | { readonly type: "chat.start"; readonly session: ChatSessionSummary }
  | { readonly type: "chat.startSession"; readonly session: ChatSessionSummary; readonly providerCatalogs: readonly AgentModelCatalog[] }
  | { readonly type: "chat.sendTurn"; readonly accepted: true }
  | { readonly type: "chat.restartBackend"; readonly session: ChatSessionSummary; readonly providerCatalogs: readonly AgentModelCatalog[] }
  | { readonly type: "chat.resumeSession"; readonly session: ChatSessionSummary; readonly providerCatalogs: readonly AgentModelCatalog[] }
  | { readonly type: "chat.cancelTurn"; readonly accepted: true }
  | { readonly type: "clipboard.writeText"; readonly accepted: true }
  | { readonly type: "chat.endSession"; readonly session: ChatSessionSummary }
  | { readonly type: "chat.spawnRole"; readonly session: ChatSessionSummary }
  | { readonly type: "question.list"; readonly questions: readonly AgentQuestionSummary[] }
  | { readonly type: "question.answer"; readonly question: AgentQuestionSummary; readonly dispatched: boolean }
  | { readonly type: "question.dismiss"; readonly question: AgentQuestionSummary }
  | { readonly type: "provider.list"; readonly providerCatalogs: readonly AgentModelCatalog[] }
  | { readonly type: "provider.login"; readonly providerId: string; readonly launched: string }
  | { readonly type: "session.list"; readonly sessions: readonly ChatSessionSummary[] }
  | { readonly type: "session.timeline"; readonly sessionId: string; readonly lines: readonly SequencedTranscriptLine[] }
  | { readonly type: "session.rename"; readonly session: ChatSessionSummary }
  | { readonly type: "session.setDescription"; readonly session: ChatSessionSummary }
  | { readonly type: "session.delete"; readonly sessionId: string }
  | { readonly type: "task.list"; readonly tasks: readonly WorkTaskSummary[] }
  | { readonly type: "task.create"; readonly task: WorkTaskSummary }
  | { readonly type: "task.update"; readonly task: WorkTaskSummary }
  | { readonly type: "task.delete"; readonly taskId: string }
  | { readonly type: "task.link"; readonly task: WorkTaskSummary }
  | { readonly type: "task.unlink"; readonly task: WorkTaskSummary }
  | { readonly type: "workspace.openInNewWindow"; readonly accepted: true }
  | { readonly type: "workspace.activate"; readonly result: WorkspaceActivateResult }
  | { readonly type: "work.history"; readonly entries: readonly WorkHistoryEntry[] }
  | { readonly type: "memory.list"; readonly candidates: readonly MemoryCandidateSummary[] }
  | { readonly type: "memory.resolve"; readonly candidate: MemoryCandidateSummary }
  | { readonly type: "memory.open"; readonly accepted: true }
  | { readonly type: "workspace.state"; readonly state: WorkspacePolicyState }
  | { readonly type: "workspace.registerOpenFolders"; readonly projects: readonly ProjectSummary[] }
  | { readonly type: "workspace.createSet"; readonly workspaceSet: WorkspaceSetSummary }
  | { readonly type: "policy.requestAccess"; readonly accessRequest: AccessRequestSummary }
  | { readonly type: "policy.resolveAccess"; readonly accessRequest: AccessRequestSummary }
  | { readonly type: "diff.snapshotWorkspace"; readonly baselineIds: readonly string[] }
  | { readonly type: "diff.status"; readonly changes: readonly DiffFileSummary[] }
  | { readonly type: "diff.acceptFile"; readonly changes: readonly DiffFileSummary[] }
  | { readonly type: "diff.revertFile"; readonly changes: readonly DiffFileSummary[] }
  | { readonly type: "diff.openFile"; readonly accepted: true }
  | { readonly type: "review.state"; readonly reviewSessionId: string | null; readonly comments: readonly ReviewCommentSummary[] }
  | { readonly type: "review.addComment"; readonly comment: ReviewCommentSummary }
  | { readonly type: "review.setCommentStatus"; readonly comment: ReviewCommentSummary }
  | { readonly type: "planDocs.state"; readonly sessionId: string; readonly docs: readonly PlanDocDetail[] }
  | { readonly type: "planDocs.open"; readonly accepted: true }
  | { readonly type: "planDocs.sendComments"; readonly accepted: true; readonly sentCount: number }
  | { readonly type: "clone.state"; readonly sessionId: string; readonly repos: readonly CloneRepoState[] }
  | { readonly type: "clone.pull"; readonly result: CloneSyncResult }
  | { readonly type: "clone.push"; readonly result: CloneSyncResult }
  | { readonly type: "clone.discard"; readonly repos: readonly CloneRepoState[] }
  | { readonly type: "taskReview.open"; readonly accepted: true }
  | { readonly type: "taskReview.state"; readonly state: TaskReviewState }
  | { readonly type: "taskReview.submit"; readonly dispatched: number; readonly sessions: number; readonly sentSessions?: readonly TaskReviewSessionRef[]; readonly errors?: readonly string[] }
  | { readonly type: "board.state"; readonly board: BoardState }
  | { readonly type: "board.moveCard"; readonly board: BoardState }
  | { readonly type: "board.columns.update"; readonly board: BoardState }
  | { readonly type: "subtask.create"; readonly task: WorkTaskSummary }
  | { readonly type: "subtask.update"; readonly task: WorkTaskSummary }
  | { readonly type: "subtask.delete"; readonly task: WorkTaskSummary }
  | { readonly type: "subtask.dependency.add"; readonly task: WorkTaskSummary }
  | { readonly type: "subtask.dependency.remove"; readonly task: WorkTaskSummary }
  | { readonly type: "subtask.start"; readonly accepted: true }
  | { readonly type: "task.start"; readonly accepted: true }
  | { readonly type: "taskBoard.open"; readonly accepted: true };

export interface PanelResponseOk {
  readonly protocolVersion: typeof WEBVIEW_PROTOCOL_VERSION;
  readonly kind: "response";
  readonly requestId: string;
  readonly ok: true;
  readonly payload: PanelResponsePayload;
}

export interface PanelResponseError {
  readonly protocolVersion: typeof WEBVIEW_PROTOCOL_VERSION;
  readonly kind: "response";
  readonly requestId: string;
  readonly ok: false;
  readonly error: { readonly message: string; readonly code?: string };
}

export type PanelResponse = PanelResponseOk | PanelResponseError;

export type PanelPushPayload =
  | { readonly type: "panel.availability"; readonly availability: BackendAvailability }
  | { readonly type: "runtime.inventory"; readonly runtimes: readonly RuntimeSummary[] }
  | { readonly type: "run.started"; readonly isolation: IsolationSummary }
  | { readonly type: "run.failed"; readonly message: string }
  | { readonly type: "probe.completed"; readonly status: string; readonly diagnostics: readonly string[] }
  | { readonly type: "chat.turnStarted"; readonly sessionId: string; readonly runId: string }
  | { readonly type: "chat.event"; readonly sessionId: string; readonly line: SequencedTranscriptLine }
  | { readonly type: "chat.turnCompleted"; readonly sessionId: string; readonly runId: string; readonly status: string }
  | { readonly type: "provider.models"; readonly providerCatalogs: readonly AgentModelCatalog[] }
  | { readonly type: "session.updated"; readonly session: ChatSessionSummary }
  | { readonly type: "session.deleted"; readonly sessionId: string }
  | { readonly type: "session.attention"; readonly sessionId: string; readonly reasons: readonly SessionAttentionReason[] }
  | { readonly type: "session.agentActivity"; readonly sessionId: string; readonly activity: AgentActivitySummary }
  | { readonly type: "question.asked"; readonly question: AgentQuestionSummary }
  | { readonly type: "question.resolved"; readonly question: AgentQuestionSummary }
  | { readonly type: "policy.accessRequested"; readonly accessRequest: AccessRequestSummary }
  | { readonly type: "task.updated"; readonly task: WorkTaskSummary }
  | { readonly type: "task.deleted"; readonly taskId: string }
  | { readonly type: "memory.candidateAdded"; readonly candidate: MemoryCandidateSummary }
  | { readonly type: "planDocs.updated"; readonly sessionId: string; readonly docs: readonly PlanDocSummary[] }
  | { readonly type: "taskReview.updated"; readonly taskId: string }
  | { readonly type: "board.changed" };

export interface PanelPush {
  readonly protocolVersion: typeof WEBVIEW_PROTOCOL_VERSION;
  readonly kind: "push";
  /** Per-panel-session monotonic counter (not the durable event sequence). */
  readonly sequence: number;
  readonly payload: PanelPushPayload;
}

export type WebviewToHostMessage = PanelRequest;
export type HostToWebviewMessage = PanelResponse | PanelPush;

// ---------------------------------------------------------------------------
// Boundary validation
// ---------------------------------------------------------------------------

/**
 * Validates an untrusted webview message into a typed request. Returns null
 * for anything malformed; callers must drop null results.
 */
export function parsePanelRequest(value: unknown): PanelRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const message = value as Record<string, unknown>;
  if (message["protocolVersion"] !== WEBVIEW_PROTOCOL_VERSION) return null;
  if (message["kind"] !== "request") return null;
  const requestId = message["requestId"];
  if (!isBoundedString(requestId, MAX_ID_LENGTH)) return null;
  const payload = parsePayload(message["payload"]);
  if (!payload) return null;
  return { protocolVersion: WEBVIEW_PROTOCOL_VERSION, kind: "request", requestId, payload };
}

function parsePayload(value: unknown): PanelRequestPayload | null {
  if (typeof value !== "object" || value === null) return null;
  const payload = value as Record<string, unknown>;
  switch (payload["type"]) {
    case "panel.init":
    case "isolatedRun.probeAppServer":
    case "provider.list":
    case "session.list":
    case "task.list":
    case "workspace.state":
    case "workspace.registerOpenFolders":
      return { type: payload["type"] };
    case "task.create": {
      const title = payload["title"];
      const description = payload["description"];
      if (!isBoundedString(title, MAX_NAME_LENGTH)) return null;
      if (description !== undefined && !isBoundedString(description, MAX_COMMENT_LENGTH)) return null;
      return { type: "task.create", title, ...(description === undefined ? {} : { description }) };
    }
    case "task.update": {
      const taskId = payload["taskId"];
      const title = payload["title"];
      const description = payload["description"];
      const state = payload["state"];
      if (!isBoundedString(taskId, MAX_ID_LENGTH)) return null;
      if (title !== undefined && !isBoundedString(title, MAX_NAME_LENGTH)) return null;
      // Empty string is allowed and clears the description.
      if (description !== undefined && (typeof description !== "string" || description.length > MAX_COMMENT_LENGTH)) return null;
      if (state !== undefined && !isWorkTaskState(state)) return null;
      if (title === undefined && description === undefined && state === undefined) return null;
      return {
        type: "task.update",
        taskId,
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
        ...(state === undefined ? {} : { state })
      };
    }
    case "task.delete": {
      const taskId = payload["taskId"];
      if (!isBoundedString(taskId, MAX_ID_LENGTH)) return null;
      return { type: "task.delete", taskId };
    }
    case "taskReview.open":
    case "taskReview.state":
    case "taskReview.submit": {
      const taskId = payload["taskId"];
      if (!isBoundedString(taskId, MAX_ID_LENGTH)) return null;
      return { type: payload["type"], taskId };
    }
    case "board.state":
    case "taskBoard.open":
      return { type: payload["type"] };
    case "board.moveCard": {
      const cardKind = payload["cardKind"];
      const id = payload["id"];
      const columnId = payload["columnId"];
      if (cardKind !== "task" && cardKind !== "subtask") return null;
      if (!isBoundedString(id, MAX_ID_LENGTH)) return null;
      if (!isBoundedString(columnId, MAX_ID_LENGTH)) return null;
      return { type: "board.moveCard", cardKind, id, columnId };
    }
    case "board.columns.update": {
      const columns = payload["columns"];
      const parsedColumns = parseBoardColumnUpdates(columns);
      if (parsedColumns === null) return null;
      const deletedColumnIds = payload["deletedColumnIds"];
      const parsedDeletedIds = parseDeletedColumnIds(deletedColumnIds);
      if (parsedDeletedIds === null) return null;
      return {
        type: "board.columns.update",
        columns: parsedColumns,
        ...(parsedDeletedIds === undefined ? {} : { deletedColumnIds: parsedDeletedIds })
      };
    }
    case "subtask.create": {
      const taskId = payload["taskId"];
      const title = payload["title"];
      const description = payload["description"];
      const prompt = payload["prompt"];
      const autoStart = payload["autoStart"];
      if (!isBoundedString(taskId, MAX_ID_LENGTH)) return null;
      if (!isBoundedString(title, MAX_NAME_LENGTH)) return null;
      if (description !== undefined && !isBoundedString(description, MAX_COMMENT_LENGTH)) return null;
      if (prompt !== undefined && !isBoundedString(prompt, MAX_PROMPT_LENGTH)) return null;
      if (autoStart !== undefined && typeof autoStart !== "boolean") return null;
      return {
        type: "subtask.create",
        taskId,
        title,
        ...(description === undefined ? {} : { description }),
        ...(prompt === undefined ? {} : { prompt }),
        ...(autoStart === undefined ? {} : { autoStart })
      };
    }
    case "subtask.update": {
      const subtaskId = payload["subtaskId"];
      const title = payload["title"];
      const description = payload["description"];
      const prompt = payload["prompt"];
      const autoStart = payload["autoStart"];
      const columnId = payload["columnId"];
      if (!isBoundedString(subtaskId, MAX_ID_LENGTH)) return null;
      if (title !== undefined && !isBoundedString(title, MAX_NAME_LENGTH)) return null;
      // Empty string is allowed and clears description/prompt.
      if (description !== undefined && (typeof description !== "string" || description.length > MAX_COMMENT_LENGTH)) return null;
      if (prompt !== undefined && (typeof prompt !== "string" || prompt.length > MAX_PROMPT_LENGTH)) return null;
      if (autoStart !== undefined && typeof autoStart !== "boolean") return null;
      if (columnId !== undefined && !isBoundedString(columnId, MAX_ID_LENGTH)) return null;
      if (
        title === undefined && description === undefined && prompt === undefined
        && autoStart === undefined && columnId === undefined
      ) return null;
      return {
        type: "subtask.update",
        subtaskId,
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
        ...(prompt === undefined ? {} : { prompt }),
        ...(autoStart === undefined ? {} : { autoStart }),
        ...(columnId === undefined ? {} : { columnId })
      };
    }
    case "subtask.delete": {
      const subtaskId = payload["subtaskId"];
      if (!isBoundedString(subtaskId, MAX_ID_LENGTH)) return null;
      return { type: "subtask.delete", subtaskId };
    }
    case "subtask.dependency.add":
    case "subtask.dependency.remove": {
      const taskId = payload["taskId"];
      const fromSubtaskId = payload["fromSubtaskId"];
      const toSubtaskId = payload["toSubtaskId"];
      if (!isBoundedString(taskId, MAX_ID_LENGTH)) return null;
      if (!isBoundedString(fromSubtaskId, MAX_ID_LENGTH)) return null;
      if (!isBoundedString(toSubtaskId, MAX_ID_LENGTH)) return null;
      return { type: payload["type"], taskId, fromSubtaskId, toSubtaskId };
    }
    case "subtask.start": {
      const subtaskId = payload["subtaskId"];
      const force = payload["force"];
      if (!isBoundedString(subtaskId, MAX_ID_LENGTH)) return null;
      if (force !== undefined && typeof force !== "boolean") return null;
      return { type: "subtask.start", subtaskId, ...(force === undefined ? {} : { force }) };
    }
    case "task.start": {
      const taskId = payload["taskId"];
      if (!isBoundedString(taskId, MAX_ID_LENGTH)) return null;
      return { type: "task.start", taskId };
    }
    case "task.link":
    case "task.unlink": {
      const taskId = payload["taskId"];
      const workspaceSetId = payload["workspaceSetId"];
      const sessionId = payload["sessionId"];
      if (!isBoundedString(taskId, MAX_ID_LENGTH)) return null;
      // Exactly one link target per request.
      if ((workspaceSetId === undefined) === (sessionId === undefined)) return null;
      if (workspaceSetId !== undefined && !isBoundedString(workspaceSetId, MAX_ID_LENGTH)) return null;
      if (sessionId !== undefined && !isBoundedString(sessionId, MAX_ID_LENGTH)) return null;
      return {
        type: payload["type"],
        taskId,
        ...(workspaceSetId === undefined ? {} : { workspaceSetId }),
        ...(sessionId === undefined ? {} : { sessionId })
      };
    }
    case "workspace.openInNewWindow": {
      const workspaceSetId = payload["workspaceSetId"];
      if (!isBoundedString(workspaceSetId, MAX_ID_LENGTH)) return null;
      return { type: "workspace.openInNewWindow", workspaceSetId };
    }
    case "work.history": {
      const workspaceSetId = payload["workspaceSetId"];
      const projectId = payload["projectId"];
      // Exactly one scope per query.
      if ((workspaceSetId === undefined) === (projectId === undefined)) return null;
      if (workspaceSetId !== undefined && !isBoundedString(workspaceSetId, MAX_ID_LENGTH)) return null;
      if (projectId !== undefined && !isBoundedString(projectId, MAX_ID_LENGTH)) return null;
      return {
        type: "work.history",
        ...(workspaceSetId === undefined ? {} : { workspaceSetId }),
        ...(projectId === undefined ? {} : { projectId })
      };
    }
    case "workspace.activate": {
      const taskId = payload["taskId"];
      const workspaceSetId = payload["workspaceSetId"];
      // Exactly one activation source.
      if ((taskId === undefined) === (workspaceSetId === undefined)) return null;
      if (taskId !== undefined && !isBoundedString(taskId, MAX_ID_LENGTH)) return null;
      if (workspaceSetId !== undefined && !isBoundedString(workspaceSetId, MAX_ID_LENGTH)) return null;
      return {
        type: "workspace.activate",
        ...(taskId === undefined ? {} : { taskId }),
        ...(workspaceSetId === undefined ? {} : { workspaceSetId })
      };
    }
    case "memory.list":
      return { type: "memory.list" };
    case "memory.resolve": {
      const memoryCandidateId = payload["memoryCandidateId"];
      const approve = payload["approve"];
      if (!isBoundedString(memoryCandidateId, MAX_ID_LENGTH)) return null;
      if (typeof approve !== "boolean") return null;
      return { type: "memory.resolve", memoryCandidateId, approve };
    }
    case "memory.open": {
      const memoryCandidateId = payload["memoryCandidateId"];
      if (!isBoundedString(memoryCandidateId, MAX_ID_LENGTH)) return null;
      return { type: "memory.open", memoryCandidateId };
    }
    case "isolatedRun.listRuntimes": {
      const includeRemoved = payload["includeRemoved"];
      if (includeRemoved === undefined) return { type: "isolatedRun.listRuntimes" };
      if (typeof includeRemoved !== "boolean") return null;
      return { type: "isolatedRun.listRuntimes", includeRemoved };
    }
    case "chat.start": {
      const prompt = payload["prompt"];
      if (!isBoundedString(prompt, MAX_PROMPT_LENGTH)) return null;
      const parsedModel = parseModelSelection(payload["model"]);
      if (parsedModel === null) return null;
      const parsedWorkspace = parseWorkspaceSelection(payload["workspace"]);
      if (parsedWorkspace === null) return null;
      return {
        type: "chat.start",
        prompt,
        ...(parsedModel === undefined ? {} : { model: parsedModel }),
        ...(parsedWorkspace === undefined ? {} : { workspace: parsedWorkspace })
      };
    }
    case "chat.startSession": {
      const parsedModel = parseModelSelection(payload["model"]);
      if (parsedModel === null || parsedModel === undefined) return null;
      const parsedWorkspace = parseWorkspaceSelection(payload["workspace"]);
      if (parsedWorkspace === null) return null;
      return {
        type: "chat.startSession",
        model: parsedModel,
        ...(parsedWorkspace === undefined ? {} : { workspace: parsedWorkspace })
      };
    }
    case "isolatedRun.stopRuntime": {
      const runtimeId = payload["runtimeId"];
      if (!isBoundedString(runtimeId, MAX_ID_LENGTH)) return null;
      return { type: "isolatedRun.stopRuntime", runtimeId };
    }
    case "chat.sendTurn": {
      const sessionId = payload["sessionId"];
      const prompt = payload["prompt"];
      if (!isBoundedString(sessionId, MAX_ID_LENGTH)) return null;
      if (!isBoundedString(prompt, MAX_PROMPT_LENGTH)) return null;
      const parsedModel = parseModelSelection(payload["model"]);
      if (parsedModel === null) return null;
      return { type: "chat.sendTurn", sessionId, prompt, ...(parsedModel === undefined ? {} : { model: parsedModel }) };
    }
    case "chat.restartBackend": {
      const sessionId = payload["sessionId"];
      if (!isBoundedString(sessionId, MAX_ID_LENGTH)) return null;
      const parsedModel = parseModelSelection(payload["model"]);
      if (parsedModel === null || parsedModel === undefined) return null;
      return { type: "chat.restartBackend", sessionId, model: parsedModel };
    }
    case "chat.resumeSession": {
      const sessionId = payload["sessionId"];
      if (!isBoundedString(sessionId, MAX_ID_LENGTH)) return null;
      const parsedModel = parseModelSelection(payload["model"]);
      if (parsedModel === null) return null;
      const parsedWorkspace = parseWorkspaceSelection(payload["workspace"]);
      if (parsedWorkspace === null) return null;
      return {
        type: "chat.resumeSession",
        sessionId,
        ...(parsedModel === undefined ? {} : { model: parsedModel }),
        ...(parsedWorkspace === undefined ? {} : { workspace: parsedWorkspace })
      };
    }
    case "chat.cancelTurn":
    case "chat.endSession":
    case "session.delete":
    case "planDocs.state":
    case "planDocs.open":
    case "planDocs.sendComments":
    case "clone.state":
    case "clone.push": {
      const sessionId = payload["sessionId"];
      if (!isBoundedString(sessionId, MAX_ID_LENGTH)) return null;
      return { type: payload["type"], sessionId };
    }
    case "chat.spawnRole": {
      const sessionId = payload["sessionId"];
      const role = payload["role"];
      if (!isBoundedString(sessionId, MAX_ID_LENGTH)) return null;
      if (typeof role !== "string" || !SPAWNABLE_AGENT_ROLES.includes(role as AgentRole)) return null;
      return { type: "chat.spawnRole", sessionId, role: role as AgentRole };
    }
    case "question.list":
      return { type: "question.list" };
    case "question.answer": {
      const questionId = payload["questionId"];
      const answer = payload["answer"];
      if (!isBoundedString(questionId, MAX_ID_LENGTH)) return null;
      if (!isBoundedString(answer, MAX_COMMENT_LENGTH)) return null;
      return { type: "question.answer", questionId, answer };
    }
    case "question.dismiss": {
      const questionId = payload["questionId"];
      if (!isBoundedString(questionId, MAX_ID_LENGTH)) return null;
      return { type: "question.dismiss", questionId };
    }
    case "clipboard.writeText": {
      const text = payload["text"];
      if (!isBoundedString(text, MAX_CLIPBOARD_LENGTH)) return null;
      return { type: "clipboard.writeText", text };
    }
    case "clone.pull": {
      const sessionId = payload["sessionId"];
      const repo = payload["repo"];
      const filePath = payload["path"];
      if (!isBoundedString(sessionId, MAX_ID_LENGTH)) return null;
      // A per-file pull names both the repo and the path; a full pull names neither.
      if ((repo === undefined) !== (filePath === undefined)) return null;
      if (repo !== undefined && !isBoundedString(repo, MAX_NAME_LENGTH)) return null;
      if (filePath !== undefined && !isBoundedString(filePath, MAX_PATH_LENGTH)) return null;
      return {
        type: "clone.pull",
        sessionId,
        ...(repo === undefined ? {} : { repo }),
        ...(filePath === undefined ? {} : { path: filePath })
      };
    }
    case "clone.discard": {
      const sessionId = payload["sessionId"];
      const repo = payload["repo"];
      const filePath = payload["path"];
      if (!isBoundedString(sessionId, MAX_ID_LENGTH)) return null;
      if (!isBoundedString(repo, MAX_NAME_LENGTH)) return null;
      if (!isBoundedString(filePath, MAX_PATH_LENGTH)) return null;
      return { type: "clone.discard", sessionId, repo, path: filePath };
    }
    case "session.rename": {
      const sessionId = payload["sessionId"];
      const title = payload["title"];
      if (!isBoundedString(sessionId, MAX_ID_LENGTH)) return null;
      if (!isBoundedString(title, MAX_NAME_LENGTH)) return null;
      return { type: "session.rename", sessionId, title };
    }
    case "session.setDescription": {
      const sessionId = payload["sessionId"];
      const description = payload["description"];
      if (!isBoundedString(sessionId, MAX_ID_LENGTH)) return null;
      // Empty string is allowed and clears the description.
      if (typeof description !== "string" || description.length > MAX_COMMENT_LENGTH) return null;
      return { type: "session.setDescription", sessionId, description };
    }
    case "session.timeline": {
      const sessionId = payload["sessionId"];
      if (!isBoundedString(sessionId, MAX_ID_LENGTH)) return null;
      const fromSequence = payload["fromSequence"];
      if (fromSequence === undefined) {
        return { type: "session.timeline", sessionId };
      }
      if (typeof fromSequence !== "number" || !Number.isFinite(fromSequence) || fromSequence < 0) return null;
      return { type: "session.timeline", sessionId, fromSequence };
    }
    case "workspace.createSet": {
      const name = payload["name"];
      if (!isBoundedString(name, MAX_NAME_LENGTH)) return null;
      return { type: "workspace.createSet", name };
    }
    case "provider.login": {
      const providerId = payload["providerId"];
      if (!isBoundedString(providerId, MAX_MODEL_ID_LENGTH)) return null;
      return { type: "provider.login", providerId };
    }
    case "policy.requestAccess": {
      const sessionId = payload["sessionId"];
      const hostPath = payload["hostPath"];
      const reason = payload["reason"];
      const mode = payload["mode"];
      if (!isBoundedString(sessionId, MAX_ID_LENGTH)) return null;
      if (!isBoundedString(hostPath, MAX_PATH_LENGTH)) return null;
      if (!isBoundedString(reason, MAX_COMMENT_LENGTH)) return null;
      if (mode !== "read-only" && mode !== "read-write") return null;
      return { type: "policy.requestAccess", sessionId, hostPath, mode, reason };
    }
    case "policy.resolveAccess": {
      const accessRequestId = payload["accessRequestId"];
      const approve = payload["approve"];
      const editedHostPath = payload["editedHostPath"];
      if (!isBoundedString(accessRequestId, MAX_ID_LENGTH)) return null;
      if (typeof approve !== "boolean") return null;
      if (editedHostPath === undefined) {
        return { type: "policy.resolveAccess", accessRequestId, approve };
      }
      if (!isBoundedString(editedHostPath, MAX_PATH_LENGTH)) return null;
      return { type: "policy.resolveAccess", accessRequestId, approve, editedHostPath };
    }
    case "diff.snapshotWorkspace": {
      const workspaceSetId = payload["workspaceSetId"];
      if (!isBoundedString(workspaceSetId, MAX_ID_LENGTH)) return null;
      return { type: "diff.snapshotWorkspace", workspaceSetId };
    }
    case "diff.status":
    case "review.state": {
      const sessionId = payload["sessionId"];
      if (sessionId === undefined) return { type: payload["type"] };
      if (!isBoundedString(sessionId, MAX_ID_LENGTH)) return null;
      return { type: payload["type"], sessionId };
    }
    case "diff.acceptFile":
    case "diff.revertFile":
    case "diff.openFile": {
      const baselineId = payload["baselineId"];
      const filePath = payload["path"];
      if (!isBoundedString(baselineId, MAX_ID_LENGTH)) return null;
      if (!isBoundedString(filePath, MAX_PATH_LENGTH)) return null;
      return { type: payload["type"], baselineId, path: filePath };
    }
    case "review.addComment": {
      const sessionId = payload["sessionId"];
      const filePath = payload["filePath"];
      const body = payload["body"];
      const startLine = payload["startLine"];
      const endLine = payload["endLine"];
      if (sessionId !== undefined && !isBoundedString(sessionId, MAX_ID_LENGTH)) return null;
      if (!isBoundedString(filePath, MAX_PATH_LENGTH)) return null;
      if (!isBoundedString(body, MAX_COMMENT_LENGTH)) return null;
      if (!isLineNumber(startLine) || !isLineNumber(endLine) || startLine > endLine) return null;
      return {
        type: "review.addComment",
        ...(sessionId === undefined ? {} : { sessionId }),
        filePath,
        startLine,
        endLine,
        body
      };
    }
    case "review.setCommentStatus": {
      const commentId = payload["commentId"];
      const status = payload["status"];
      if (!isBoundedString(commentId, MAX_ID_LENGTH)) return null;
      if (!isReviewThreadStatus(status)) return null;
      return { type: "review.setCommentStatus", commentId, status };
    }
    default:
      return null;
  }
}

const REVIEW_THREAD_STATUSES: readonly ReviewThreadStatus[] = ["open", "acknowledged", "delegated", "resolved", "wont-fix", "blocked"];

function isReviewThreadStatus(value: unknown): value is ReviewThreadStatus {
  return typeof value === "string" && (REVIEW_THREAD_STATUSES as readonly string[]).includes(value);
}

function isWorkTaskState(value: unknown): value is WorkTaskState {
  return typeof value === "string" && (WORK_TASK_STATES as readonly string[]).includes(value);
}

function isColumnCategory(value: unknown): value is ColumnCategory {
  return typeof value === "string" && (COLUMN_CATEGORIES as readonly string[]).includes(value);
}

/** Validates a `board.columns.update` request's column array; null on any malformed entry. */
function parseBoardColumnUpdates(value: unknown): BoardColumnUpdateInput[] | null {
  if (!Array.isArray(value)) return null;
  const result: BoardColumnUpdateInput[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry as Record<string, unknown>;
    const columnId = record["columnId"];
    const name = record["name"];
    const category = record["category"];
    const sortOrder = record["sortOrder"];
    if (columnId !== undefined && !isBoundedString(columnId, MAX_ID_LENGTH)) return null;
    if (!isBoundedString(name, MAX_NAME_LENGTH)) return null;
    if (!isColumnCategory(category)) return null;
    if (typeof sortOrder !== "number" || !Number.isFinite(sortOrder)) return null;
    result.push({ ...(columnId === undefined ? {} : { columnId }), name, category, sortOrder });
  }
  return result;
}

/** Validates a `board.columns.update` request's optional `deletedColumnIds`; null on any malformed entry. */
function parseDeletedColumnIds(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const entry of value) {
    if (!isBoundedString(entry, MAX_ID_LENGTH)) return null;
    result.push(entry);
  }
  return result;
}

function isLineNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1_000_000;
}

function parseWorkspaceSelection(value: unknown): ChatWorkspaceSelection | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) return null;
  const payload = value as Record<string, unknown>;
  const mode = payload["mode"];
  if (mode !== "plan" && mode !== "implementation" && mode !== "clone") return null;
  if (payload["auto"] === true) {
    if (payload["workspaceSetId"] !== undefined) return null;
    return { auto: true, mode };
  }
  const workspaceSetId = payload["workspaceSetId"];
  if (!isBoundedString(workspaceSetId, MAX_ID_LENGTH)) return null;
  return { workspaceSetId, mode };
}

function parseModelSelection(value: unknown): ChatModelSelection | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) return null;
  const payload = value as Record<string, unknown>;
  const providerId = payload["providerId"];
  if (!isBoundedString(providerId, MAX_MODEL_ID_LENGTH)) return null;
  const model = payload["model"];
  if (model === undefined || model === "") {
    return { providerId };
  }
  if (!isBoundedString(model, MAX_MODEL_ID_LENGTH)) return null;
  return { providerId, model };
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}
