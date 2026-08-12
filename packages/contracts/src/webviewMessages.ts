/**
 * Panel v0 webview message contracts.
 *
 * Everything crossing the extension-host/webview boundary is a versioned
 * envelope: requests carry a correlation id, responses answer exactly one
 * request, pushes carry a per-panel-session sequence so a reloaded webview can
 * detect gaps. IDs are plain strings here on purpose - the webview is outside
 * the trusted boundary, so payloads stay display-safe (no runtime handles, no
 * secrets, host paths only as display strings).
 *
 * `parsePanelRequest` is the single validation gate for webview input; the
 * extension host must reject anything it returns null for.
 */

import type { AgentModelCatalog, ProviderAuthStatus } from "./agent.js";
import { usageTokens, type AgentsSessionLine, type SessionAgentTree } from "./agentTree.js";
import type { DiffChangeKind, DiffViewMode, ReviewThreadStatus } from "./diffs.js";
import type { TranscriptLine } from "./events.js";
import type { AgentRole } from "./ids.js";
import type { MemoryCandidateStatus, MemoryOrigin, MemoryScope } from "./memory.js";
import type { McpOverrideScope } from "./mcp.js";
import type { AgentQuestionImage, AgentQuestionStep } from "./questions.js";
import {
  PLAN_ANNOTATION_STATUSES,
  parsePlanAnchor,
  type PlanAnnotationStatus,
  type PlanAnnotationSummary,
  type PlanArtifactSummary,
  type PlanAspectSummary,
  type PlannerStateDetail,
  type PlanSummary
} from "./planner.js";
import { COLUMN_CATEGORIES, WORK_TASK_STATES, type ColumnCategory, type SubtaskModelSelection, type SubtaskSeedMode, type TaskClonePolicy, type TaskFaqRecord, type TaskRecipeRecord, type WorkTaskState } from "./tasks.js";
import type { AccessRequestStatus } from "./workspaces.js";

export const WEBVIEW_PROTOCOL_VERSION = 1;
/** Roles a user may spawn as child sessions. */
export const SPAWNABLE_AGENT_ROLES: readonly AgentRole[] = ["researcher", "planner", "worker", "tester", "reviewer"];
export const MAX_PROMPT_LENGTH = 20_000;
export const MAX_CLIPBOARD_LENGTH = 200_000;
export const MAX_ID_LENGTH = 200;
export const MAX_MODEL_ID_LENGTH = 120;
/**
 * Upper bound for write-only secret material crossing the webview boundary
 * (API keys, OAuth paste-back codes). Values are handed straight to the
 * platform secret store or the provider CLI's stdin and are never echoed back,
 * logged, or persisted by Drydock.
 */
export const MAX_SECRET_INPUT_LENGTH = 4_096;
export const MAX_PATH_LENGTH = 1_024;
export const MAX_COMMENT_LENGTH = 4_000;
export const MAX_NAME_LENGTH = 200;
/** Upper bound on `session.recents { limit }` (the rail's default is 7). */
export const MAX_RECENTS_LIMIT = 50;
/** Rows the rail's Recents list asks for when it names no limit. */
export const DEFAULT_RECENTS_LIMIT = 7;

export interface ChatModelSelection {
  readonly providerId: string;
  readonly model?: string;
  /** Provider-advertised reasoning effort for this turn. */
  readonly reasoningEffort?: string;
}

/** Session start modes supported by the host. Clone mounts no live roots. */
export type ChatSessionModeSelection = "plan" | "implementation" | "clone";

/**
 * Mounting selection for a new chat session: either an explicit workspace
 * set, or `auto` - the host derives the roots from the open VS Code folders
 * plus configured shared paths (the default, ceremony-free path).
 */
export type ChatWorkspaceSelection =
  | { readonly workspaceSetId: string; readonly mode: ChatSessionModeSelection }
  | { readonly auto: true; readonly mode: ChatSessionModeSelection };

// ---------------------------------------------------------------------------
// Webview -> extension host
// ---------------------------------------------------------------------------

/**
 * What `session.summarize` copies: `log` is the trimmed dialogue + files
 * touched, built host-side; `ai` asks the session's agent for a structured
 * summary out-of-band. Both land in the system clipboard, never in the chat.
 */
export type ChatSummarizeMode = "log" | "ai";

export type PanelRequestPayload =
  | { readonly type: "panel.init" }
  | { readonly type: "isolatedRun.listRuntimes"; readonly includeRemoved?: boolean }
  | { readonly type: "runtime.reconcile" }
  | { readonly type: "isolatedRun.stopRuntime"; readonly runtimeId: string }
  | { readonly type: "runtime.sbxLogin" }
  | { readonly type: "runtime.openTerminal"; readonly sessionId: string }
  | { readonly type: "chat.rawStream"; readonly sessionId: string }
  | { readonly type: "chat.runtimeStats"; readonly sessionId: string }
  | { readonly type: "chat.openFile"; readonly path: string }
  | { readonly type: "chat.start"; readonly prompt: string; readonly model?: ChatModelSelection; readonly workspace?: ChatWorkspaceSelection; readonly taskId?: string }
  | { readonly type: "chat.startSession"; readonly model: ChatModelSelection; readonly workspace?: ChatWorkspaceSelection; readonly title?: string; readonly taskId?: string }
  | { readonly type: "chat.sendTurn"; readonly sessionId: string; readonly prompt: string; readonly model?: ChatModelSelection }
  | { readonly type: "chat.restartBackend"; readonly sessionId: string; readonly model: ChatModelSelection }
  | { readonly type: "chat.resumeSession"; readonly sessionId: string; readonly model?: ChatModelSelection; readonly workspace?: ChatWorkspaceSelection }
  | { readonly type: "chat.reclaim"; readonly sessionId: string; readonly model?: ChatModelSelection }
  | { readonly type: "ui.confirm"; readonly message: string; readonly detail?: string; readonly confirmLabel: string }
  | { readonly type: "chat.cancelTurn"; readonly sessionId: string }
  | { readonly type: "chat.poke"; readonly sessionId: string }
  | { readonly type: "chat.endSession"; readonly sessionId: string }
  | { readonly type: "chat.spawnRole"; readonly sessionId: string; readonly role: AgentRole }
  | { readonly type: "question.list" }
  | { readonly type: "question.answer"; readonly questionId: string; readonly answer: string }
  | { readonly type: "question.dismiss"; readonly questionId: string }
  | { readonly type: "clipboard.writeText"; readonly text: string }
  | { readonly type: "provider.list"; readonly force?: boolean }
  | { readonly type: "provider.login"; readonly providerId: string }
  /** Write-only OAuth paste-back code for an in-flight guided login. */
  | { readonly type: "provider.submitCode"; readonly providerId: string; readonly code: string }
  /** Write-only API key; stored via sbx secret ledger or VS Code SecretStorage, never echoed. */
  | { readonly type: "provider.submitApiKey"; readonly providerId: string; readonly apiKey: string }
  | { readonly type: "provider.cancelLogin"; readonly providerId: string }
  | { readonly type: "session.list" }
  | { readonly type: "session.timeline"; readonly sessionId: string; readonly fromSequence?: number }
  | { readonly type: "session.rename"; readonly sessionId: string; readonly title: string }
  | { readonly type: "session.setDescription"; readonly sessionId: string; readonly description: string }
  | { readonly type: "session.delete"; readonly sessionId: string }
  | { readonly type: "session.summarize"; readonly sessionId: string; readonly mode: ChatSummarizeMode }
  /** Rail Recents: one row per task = its newest chat, host-deduped (cap 50). */
  | { readonly type: "session.recents"; readonly limit?: number }
  | { readonly type: "task.list" }
  | { readonly type: "task.create"; readonly title: string; readonly description?: string }
  | { readonly type: "task.update"; readonly taskId: string; readonly title?: string; readonly description?: string; readonly state?: WorkTaskState; readonly autoAnswerFaq?: boolean }
  | { readonly type: "task.delete"; readonly taskId: string }
  /** `subtaskId` (session targets only) links the chat to a card, not the task itself. */
  | { readonly type: "task.link"; readonly taskId: string; readonly workspaceSetId?: string; readonly sessionId?: string; readonly subtaskId?: string }
  | { readonly type: "task.unlink"; readonly taskId: string; readonly workspaceSetId?: string; readonly sessionId?: string }
  /** Active-task spine: the one task every surface follows (null = none). */
  | { readonly type: "active.get" }
  | { readonly type: "active.set"; readonly taskId: string | null }
  | { readonly type: "workspace.openInNewWindow"; readonly workspaceSetId: string }
  | { readonly type: "workspace.activate"; readonly taskId?: string; readonly workspaceSetId?: string }
  | { readonly type: "memory.list" }
  | { readonly type: "memory.resolve"; readonly memoryCandidateId: string; readonly approve: boolean; readonly edits?: MemoryEditsInput }
  | { readonly type: "memory.open"; readonly memoryCandidateId: string }
  | { readonly type: "memory.add"; readonly content: string; readonly scope: MemoryScope; readonly taskId?: string; readonly tags?: readonly string[] }
  | { readonly type: "memory.delete"; readonly memoryCandidateId: string }
  | { readonly type: "mcp.list" }
  | { readonly type: "mcp.save"; readonly server: McpServerDraft }
  | { readonly type: "mcp.delete"; readonly serverId: string }
  | { readonly type: "mcp.setOverride"; readonly scope: McpOverrideScope; readonly refId: string; readonly serverId: string; readonly state: "on" | "off" | "inherit" }
  | { readonly type: "chat.contextDebug"; readonly sessionId: string }
  | { readonly type: "workspace.state" }
  | { readonly type: "workspace.registerOpenFolders" }
  | { readonly type: "workspace.createSet"; readonly name: string; readonly members: readonly WorkspaceSetMemberInput[] }
  | { readonly type: "workspace.updateSet"; readonly workspaceSetId: string; readonly name: string; readonly members: readonly WorkspaceSetMemberInput[] }
  | { readonly type: "workspace.deleteSet"; readonly workspaceSetId: string }
  | { readonly type: "workspace.removeProject"; readonly projectId: string }
  | { readonly type: "workspace.updateProjectPath"; readonly projectId: string; readonly path: string }
  | { readonly type: "policy.requestAccess"; readonly sessionId: string; readonly hostPath: string; readonly mode: "read-only" | "read-write"; readonly reason: string }
  | { readonly type: "policy.resolveAccess"; readonly accessRequestId: string; readonly approve: boolean; readonly editedHostPath?: string }
  | { readonly type: "diff.snapshotWorkspace"; readonly workspaceSetId: string }
  | { readonly type: "diff.status"; readonly sessionId?: string; readonly view?: DiffViewMode }
  | { readonly type: "diff.acceptFile"; readonly baselineId: string; readonly path: string; readonly view?: DiffViewMode }
  | { readonly type: "diff.revertFile"; readonly baselineId: string; readonly path: string; readonly view?: DiffViewMode }
  | { readonly type: "diff.openFile"; readonly baselineId: string; readonly path: string }
  | { readonly type: "review.state"; readonly sessionId?: string }
  | { readonly type: "review.addComment"; readonly sessionId?: string; readonly filePath: string; readonly startLine: number; readonly endLine: number; readonly body: string }
  | { readonly type: "review.setCommentStatus"; readonly commentId: string; readonly status: ReviewThreadStatus }
  | { readonly type: "clone.state"; readonly sessionId: string }
  | { readonly type: "clone.pull"; readonly sessionId: string; readonly repo?: string; readonly path?: string }
  | { readonly type: "clone.push"; readonly sessionId: string }
  | { readonly type: "clone.discard"; readonly sessionId: string; readonly repo: string; readonly path: string }
  | { readonly type: "clone.exportPatch"; readonly sessionId: string; readonly repo?: string }
  | { readonly type: "chat.uploadAttachment"; readonly sessionId: string; readonly name: string; readonly dataBase64: string }
  | { readonly type: "preview.list"; readonly sessionId: string }
  | { readonly type: "preview.open"; readonly previewId: string; readonly external?: boolean }
  | { readonly type: "preview.stop"; readonly previewId: string }
  | { readonly type: "terminal.attach"; readonly sessionId: string }
  | { readonly type: "taskReview.open"; readonly taskId: string; readonly startGuide?: boolean }
  | { readonly type: "taskReview.state"; readonly taskId: string }
  | { readonly type: "taskReview.submit"; readonly taskId: string }
  | { readonly type: "codeReview.open"; readonly taskId: string }
  | { readonly type: "codeReview.state"; readonly taskId: string; readonly scope: CodeReviewScope }
  | { readonly type: "codeReview.fileDiff"; readonly taskId: string; readonly scope: CodeReviewScope; readonly repo: string; readonly path: string; readonly baselineId?: string; readonly ignoreWhitespace?: boolean }
  | { readonly type: "codeReview.addNote"; readonly taskId: string; readonly scope: CodeReviewScope; readonly body: string; readonly anchors: readonly CodeReviewAnchor[] }
  | { readonly type: "board.state" }
  | { readonly type: "board.moveCard"; readonly cardKind: "task" | "subtask"; readonly id: string; readonly columnId: string }
  | { readonly type: "board.columns.update"; readonly columns: readonly BoardColumnUpdateInput[]; readonly deletedColumnIds?: readonly string[] }
  | { readonly type: "subtask.create"; readonly taskId: string; readonly title: string; readonly description?: string; readonly prompt?: string; readonly autoStart?: boolean }
  | { readonly type: "subtask.update"; readonly subtaskId: string; readonly title?: string; readonly description?: string; readonly prompt?: string; readonly autoStart?: boolean; readonly columnId?: string; readonly colorOverride?: number | null; readonly seedMode?: SubtaskSeedMode; readonly verified?: boolean }
  | { readonly type: "subtask.delete"; readonly subtaskId: string }
  | { readonly type: "subtask.dependency.add"; readonly taskId: string; readonly fromSubtaskId: string; readonly toSubtaskId: string }
  | { readonly type: "subtask.dependency.remove"; readonly taskId: string; readonly fromSubtaskId: string; readonly toSubtaskId: string }
  | { readonly type: "subtask.start"; readonly subtaskId: string; readonly force?: boolean }
  | { readonly type: "task.start"; readonly taskId: string }
  /** Task recipes (ADR 0007): list templates; materialize one (creates, never starts). */
  | { readonly type: "recipes.list" }
  | { readonly type: "task.createFromRecipe"; readonly recipeId: string; readonly title: string }
  /** Task FAQ (ADR 0007): the auto-answer knowledge the task carries. */
  | { readonly type: "task.faq.list"; readonly taskId: string }
  | { readonly type: "task.faq.add"; readonly taskId: string; readonly pattern: string; readonly answer: string }
  | { readonly type: "task.faq.remove"; readonly taskId: string; readonly faqId: string }
  /** Task Hub (UX overhaul P3): ONE composite read for a task's whole overview. */
  | { readonly type: "hub.state"; readonly taskId: string }
  /**
   * "Open that surface" relay for webviews with no command access: the host
   * executes the existing `drydock.*.open` command. One request instead of a
   * per-surface message per new panel.
   */
  | { readonly type: "panel.openSurface"; readonly surface: PanelSurface; readonly taskId?: string; readonly planId?: string }
  | { readonly type: "taskBoard.open"; readonly startGuide?: boolean }
  | { readonly type: "agents.open"; readonly startGuide?: boolean }
  | { readonly type: "agents.state" }
  /** Navigate the sidebar to a session (nodeId lands on the Agents lens). */
  | { readonly type: "agents.openSession"; readonly sessionId: string; readonly nodeId?: string }
  /** Landing drawer (ADR 0014): full-pull a session's clone work into the local repo and mark its changesets landed. */
  | { readonly type: "agents.landSession"; readonly sessionId: string }
  | { readonly type: "planner.open"; readonly planId?: string; readonly startGuide?: boolean }
  | { readonly type: "planner.plans" }
  | { readonly type: "planner.state"; readonly planId: string }
  | { readonly type: "planner.create"; readonly brief: string; readonly aspectIds: readonly string[]; readonly contextRoots: readonly string[]; readonly notes?: string; readonly title?: string; readonly taskId?: string; readonly model?: ChatModelSelection }
  /** `taskId: ""` clears the task link (back to an orphan plan). */
  | { readonly type: "planner.updateIntake"; readonly planId: string; readonly title?: string; readonly brief?: string; readonly aspectIds?: readonly string[]; readonly contextRoots?: readonly string[]; readonly notes?: string; readonly taskId?: string }
  | { readonly type: "planner.archive"; readonly planId: string; readonly archived: boolean }
  | { readonly type: "planner.startSession"; readonly planId: string; readonly model?: ChatModelSelection }
  | { readonly type: "planner.sendTurn"; readonly planId: string; readonly prompt: string }
  | { readonly type: "planner.annotation.add"; readonly planId: string; readonly artifactId: string; readonly anchor: string; readonly body: string }
  | { readonly type: "planner.annotation.setStatus"; readonly annotationId: string; readonly status: PlanAnnotationStatus }
  | { readonly type: "planner.annotation.remove"; readonly annotationId: string }
  | { readonly type: "planner.artifact.rename"; readonly artifactId: string; readonly title: string }
  | { readonly type: "planner.sendInstructions"; readonly planId: string }
  /** Plan → board (ADR 0012): checkbox items proposed as subtasks; apply creates, never starts. */
  | { readonly type: "planner.subtaskCandidates"; readonly planId: string }
  | { readonly type: "planner.materializeSubtasks"; readonly planId: string; readonly titles: readonly string[] }
  | { readonly type: "planner.regenerate"; readonly planId: string; readonly aspectId?: string }
  | { readonly type: "planner.openArtifact"; readonly artifactId: string }
  | { readonly type: "planner.setPrototypeScripts"; readonly artifactId: string; readonly enabled: boolean }
  | { readonly type: "planner.aspects.list" }
  | { readonly type: "planner.aspects.save"; readonly aspect: PlannerAspectSaveInput }
  | { readonly type: "planner.aspects.archive"; readonly aspectId: string; readonly archived: boolean }
  /**
   * Configure panel (UX overhaul P6). ONE composite read plus a handful of
   * bounded writes; the panel has no Save button, so every write is its own
   * request and the row reports itself saved when the host answers.
   */
  | { readonly type: "config.state"; readonly scope?: ConfigScope }
  | { readonly type: "config.setSetting"; readonly section: ConfigSettingSection; readonly key: string; readonly value: ConfigSettingValue }
  | { readonly type: "config.mcpToggle"; readonly serverId: string; readonly enabled: boolean }
  | { readonly type: "config.mcpAdd"; readonly name: string; readonly command: string; readonly args: readonly string[] }
  | { readonly type: "config.provider.signIn"; readonly providerId: string }
  | { readonly type: "config.provider.setDefaultModel"; readonly providerId: string; readonly model: string }
  /** "Edit the file ↗": the host opens it only if it is one of the paths it just advertised. */
  | { readonly type: "config.openFile"; readonly path: string };

/**
 * Editor-area surfaces a webview may ask the host to open. A closed enum, not
 * a command name: the webview never names a command, the host maps each entry
 * to the `drydock.*.open` command it already registers.
 */
export const PANEL_SURFACES = ["hub", "board", "agents", "planner", "review"] as const;

export type PanelSurface = (typeof PANEL_SURFACES)[number];

/**
 * A `planner.aspects.save` input: `aspectId` present updates that aspect,
 * absent creates a new one (the host slugs the label into a fresh id).
 */
export interface PlannerAspectSaveInput {
  readonly aspectId?: string;
  readonly label: string;
  readonly instructions: string;
  readonly expectedArtifacts: readonly string[];
}

/**
 * One column entry in a `board.columns.update` request: `columnId` present
 * updates that column, absent creates a new one. The service reconciles the
 * full set (add/rename/reorder) against what is currently stored. A sibling
 * `deletedColumnIds` on the request (not per-entry) names columns to remove -
 * the service moves their cards to the nearest same-category column and
 * rejects deleting the last column of a category.
 */
export interface BoardColumnUpdateInput {
  readonly columnId?: string;
  readonly name: string;
  readonly category: ColumnCategory;
  readonly sortOrder: number;
}

/** One ordered set member as sent from the workspace editor. */
export interface WorkspaceSetMemberInput {
  readonly projectId: string;
  readonly readOnly: boolean;
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

/**
 * Live resource sample for one running sandbox, read from cgroup v2 + /proc
 * inside the container. Rate fields (cpu/io) are null until a second sample
 * exists to diff against; `available` is false when the probe couldn't run.
 */
export interface RuntimeStatsSummary {
  readonly runtimeId: string;
  readonly available: boolean;
  /** CPU busy as a percentage of ONE core (top-style; can exceed 100 on multi-core). */
  readonly cpuPercent: number | null;
  /** Anonymous (workload) memory in bytes. */
  readonly memBytes: number | null;
  readonly ioReadBytesPerSec: number | null;
  readonly ioWriteBytesPerSec: number | null;
  readonly loadAvg1: number | null;
  readonly threads: number | null;
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
  /**
   * Authoritative liveness: the backend is live in THIS host right now. The
   * stored `status` can read "active" long after a reload killed the backend, so
   * the UI keys drivability + the online/offline dot off this, not off status.
   */
  readonly live?: boolean;
  /** Active in another VS Code window (fresh foreign heartbeat): view-only here. */
  readonly runningElsewhere?: boolean;
  /** Session mode recorded at start; clone sessions drive the sync UI. */
  readonly mode?: ChatSessionModeSelection;
  /** Agent transport - drives the webview's subagent capability tier. */
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

/**
 * One Recents row (UX overhaul, P1): a task and the single most recent chat
 * across the task's AND its subtasks' linked sessions. Exactly one row per
 * task - the rail's Recents list is a task list wearing its newest chat, not
 * a session list. Status/liveness reuse the ChatSessionSummary vocabulary so
 * the dot cannot disagree with the Agents panel.
 */
export interface RecentChatSummary {
  readonly sessionId: string;
  readonly title: string;
  readonly taskId: string;
  readonly taskTitle: string;
  /** Durable ChatSessionStatus (starting | active | ended | failed). */
  readonly status: string;
  /** Authoritative liveness in THIS host (ChatSessionSummary.live). */
  readonly live?: boolean;
  /** Live in another VS Code window: view-only here. */
  readonly runningElsewhere?: boolean;
  /** A pending question / access request / failed turn waits on the user. */
  readonly needsAttention?: boolean;
  /** The chosen chat's last activity (its session updatedAt). */
  readonly lastActivityAt: string;
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
  /**
   * The session's root agent this turn (nodeId "root"): status "running"
   * while the turn is live, plus the last activity/command line. Fleet rows
   * key their pulse and activity text off this; the ⑂ chip ignores it (its
   * running/failed counts stay native-children-only).
   */
  readonly root?: AgentActivityItem;
}

/**
 * ONE projection from the reduced agent tree to the compact per-agent rows
 * (the sidebar ⑂ chips and the Agents panel's subagent rows both read this,
 * so the two surfaces cannot disagree). Native nodes only - the root agent
 * is the session row itself.
 */
export function agentActivitySummaryOfTree(tree: SessionAgentTree): AgentActivitySummary {
  const toItem = (node: SessionAgentTree["nodes"][number]): AgentActivityItem => {
    const tokens = usageTokens(node.usage);
    return {
      nodeId: node.nodeId,
      ...(node.parentId === undefined ? {} : { parentNodeId: node.parentId }),
      label: node.label,
      status: node.status,
      ...(node.startedAt === undefined ? {} : { startedAt: node.startedAt }),
      ...(node.endedAt === undefined ? {} : { endedAt: node.endedAt }),
      ...(node.lastActivityAt === undefined ? {} : { lastActivityAt: node.lastActivityAt }),
      ...(node.lastActivity === undefined ? {} : { lastActivity: node.lastActivity }),
      ...(node.lastCommand === undefined ? {} : { lastCommand: node.lastCommand }),
      toolUses: node.counts.toolCalls + node.counts.commands + node.counts.fileEdits,
      ...(tokens === null ? {} : { tokens })
    };
  };
  const agents = tree.nodes.filter((node) => node.kind === "native").map(toItem);
  const rootNode = tree.nodes.find((node) => node.kind === "root");
  const root = rootNode === undefined ? undefined : toItem(rootNode);
  const running = agents.filter((agent) => agent.status === "running").length;
  const failed = agents.filter((agent) => agent.status === "failed").length;
  return {
    running,
    failed,
    ...(agents.length === 0 ? {} : { agents }),
    ...(root === undefined ? {} : { root })
  };
}

/** One task's slice of the fleet: the task, its board column chip, its sessions. */
export interface AgentsTaskGroup {
  readonly task: WorkTaskSummary;
  /** Board column display name/category; absent when the column row is gone. */
  readonly columnName?: string;
  readonly columnCategory?: ColumnCategory;
  /**
   * The task's sessions (link-derived, plus unlinked role children grafted
   * under their linked ancestor). Root sessions first-seen order; the webview
   * nests children via parentSessionId.
   */
  readonly sessions: readonly ChatSessionSummary[];
}

/**
 * One Landing-drawer row (ADR 0014): a subtask with unlanded changesets,
 * ready to pull. `overlapsWith` names sibling landing subtasks touching at
 * least one same path (disjoint-first ordering; pull overlapping ones with
 * care). Rows without stored paths report no overlap data - unknown, not
 * safe.
 */
export interface LandingItem {
  readonly taskId: string;
  readonly taskTitle: string;
  readonly subtaskId: string;
  readonly subtaskTitle: string;
  readonly sessionId: string;
  readonly repos: readonly { readonly repoName: string; readonly fileCount: number }[];
  readonly capturedAt: string;
  readonly overlapsWith: readonly string[];
  /** True when any repo row predates path capture - overlap cannot be checked. */
  readonly overlapUnknown?: boolean;
}

/** Fleet snapshot for the Agents panel (ADR 0013) - projection only. */
export interface AgentsOverviewState {
  readonly generatedAt: string;
  readonly groups: readonly AgentsTaskGroup[];
  /** Sessions linked to no task (and with no linked ancestor): the trailing drawer. */
  readonly orphanSessions: readonly ChatSessionSummary[];
  /** Pending only - the "waiting on you" chips across every group. */
  readonly questions: readonly AgentQuestionSummary[];
  readonly accessRequests: readonly AccessRequestSummary[];
  readonly agentIdleThresholdMs: number;
  /** Landing drawer (ADR 0014): subtasks with unlanded changesets, disjoint-first. */
  readonly landing?: readonly LandingItem[];
  /** Flat-list one-liners, one per session with something to say (UX overhaul P5). */
  readonly sessionLines?: readonly AgentsSessionLine[];
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
   * Every linked session with a stored record, in link order - including
   * sessions with no changed files (their comments still show in the dock).
   */
  readonly sessions: readonly TaskReviewSessionRef[];
  readonly projects: readonly TaskReviewProject[];
  /** All open code comments across linked sessions - what Submit would send. */
  readonly openCommentCount: number;
  /** Linked sessions currently running a turn; absent when none are. */
  readonly revisionInFlight?: number;
  /** Degraded-fetch honesty lines (e.g. a clone session not live in this window). */
  readonly notes?: readonly string[];
}

// ---------------------------------------------------------------------------
// Code Review panel (in-panel PR-style review - docs/design/code-review-panel.md)
// ---------------------------------------------------------------------------

/**
 * What the Code Review panel diffs: `uncommitted` = git working tree vs HEAD
 * across the task's project roots, `task` = every linked session's baseline
 * changes (v1 task-review file set), `session` = the primary session only.
 */
export type CodeReviewScope = "uncommitted" | "task" | "session";

/** One anchored range of a review note; sessionId names the owning session when known. */
export interface CodeReviewAnchor {
  readonly repo: string;
  readonly path: string;
  /** 1-based inclusive line range in the NEW file (old file for pure deletions). */
  readonly startLine: number;
  readonly endLine: number;
  readonly sessionId?: string;
}

/** One changed file in the Code Review panel (stats only - content rides fileDiff). */
export interface CodeReviewFile {
  readonly repo: string;
  readonly path: string;
  readonly changeKind: DiffChangeKind;
  readonly oldPath?: string;
  /** Line stats; absent for image/binary/oversized files. */
  readonly addedLines?: number;
  readonly removedLines?: number;
  readonly contentKind: "text" | "image" | "binary" | "oversized";
  readonly bytesBefore?: number;
  readonly bytesAfter?: number;
  readonly commentCount: number;
  /** Owning session (task/session scopes; absent in the uncommitted scope). */
  readonly sessionId?: string;
  readonly sessionTitle?: string;
  /** Baseline backing the diff (task/session scopes; passed back on fileDiff). */
  readonly baselineId?: string;
  readonly clone?: boolean;
  readonly conflicted?: boolean;
  /** Collapse-by-default hint (large or generated/lock file - host rule). */
  readonly largeDiff?: boolean;
}

/** One project (repo/root) group in the Code Review panel. */
export interface CodeReviewProjectState {
  readonly name: string;
  readonly files: readonly CodeReviewFile[];
}

/** Everything the Code Review panel renders for one task+scope (no diff content). */
export interface CodeReviewPanelState {
  readonly taskId: string;
  readonly title: string;
  readonly scope: CodeReviewScope;
  readonly projects: readonly CodeReviewProjectState[];
  readonly openCommentCount: number;
  /** Comment routing target for scopes without per-file owners (uncommitted). */
  readonly primarySession?: TaskReviewSessionRef;
  readonly revisionInFlight?: number;
  readonly notes?: readonly string[];
}

/** One rendered diff row; text renders via textContent ONLY. */
export interface ReviewDiffRow {
  readonly kind: "context" | "add" | "del";
  readonly oldNo?: number;
  readonly newNo?: number;
  readonly text: string;
}

export interface ReviewDiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly rows: readonly ReviewDiffRow[];
}

/** One file's renderable diff, fetched lazily per card. */
export type ReviewFileDiff =
  | { readonly kind: "text"; readonly hunks: readonly ReviewDiffHunk[]; readonly truncated?: boolean }
  | { readonly kind: "image"; readonly beforeDataUri?: string; readonly afterDataUri?: string; readonly bytesBefore?: number; readonly bytesAfter?: number }
  | { readonly kind: "binary"; readonly bytesBefore?: number; readonly bytesAfter?: number }
  | { readonly kind: "oversized"; readonly reason: string };

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

/** Display-safe projection of one project's membership in a set. */
export interface WorkspaceSetMemberSummary {
  readonly projectId: string;
  readonly name: string;
  readonly displayPath: string;
  readonly readOnly: boolean;
}

/** Display-safe projection of a workspace set. */
export interface WorkspaceSetSummary {
  readonly workspaceSetId: string;
  readonly name: string;
  /** Member display names, kept for existing consumers; see `members`. */
  readonly projectNames: readonly string[];
  readonly members: readonly WorkspaceSetMemberSummary[];
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
/**
 * One agent-announced sandbox preview (ADR 0017): an HTTP server the agent
 * started inside its container, proxied to a host 127.0.0.1 port. Web-only -
 * even Qt/Slate work prototypes as HTML styled by the shipped theme packs.
 */
export interface PreviewSummary {
  readonly previewId: string;
  readonly sessionId: string;
  readonly title: string;
  /** Port the agent bound inside the container. */
  readonly containerPort: number;
  readonly path: string;
  /** Host-side 127.0.0.1 URL the proxy serves. */
  readonly url: string;
  readonly status: "up" | "stopped";
  readonly createdAt: string;
}

export interface AgentQuestionSummary {
  readonly questionId: string;
  readonly sessionId: string;
  readonly question: string;
  /** Agent-suggested answers, first = the agent's recommendation. May be empty. */
  readonly options: readonly string[];
  readonly status: "pending" | "answered" | "dismissed";
  readonly answer?: string;
  readonly createdAt: string;
  /** ADR 0016: plain question (absent) vs a step-by-step manual check. */
  readonly kind?: "manual-check";
  readonly steps?: readonly AgentQuestionStep[];
  readonly images?: readonly AgentQuestionImage[];
  readonly subtaskId?: string;
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
  /** ADR 0015: start held back by the run-slot budget. */
  readonly isQueued?: boolean;
  /** ADR 0015: auto run failed twice; automation gave up until a manual ↻. */
  readonly isParked?: boolean;
  readonly linkedSessionIds: readonly string[];
  /** 0-7 palette index overriding the parent task's stripe hue; absent uses the task hue. */
  readonly colorOverride?: number;
  /** Clone seeding choice (ADR 0014); absent = `local`. Meaningful only with dependsOn. */
  readonly seedMode?: SubtaskSeedMode;
  /** A captured outbound changeset exists that has not been pulled into the local repo. */
  readonly hasUnlandedChangeset?: boolean;
  /** Per-role model profile (ADR 0002); absent = provider default. */
  readonly model?: SubtaskModelSelection;
  /** ADR 0007: an armed HITL verify gate is unmet - in Review, no verified stamp. Waiting-on-you. */
  readonly verifyUnmet?: boolean;
  /** ADR 0007: durable time at which a person recorded the latest verification check. */
  readonly verifiedAt?: string;
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
   * when zero or when the join was unavailable. Joined into task.list only -
   * task.updated pushes may omit it until the next list.
   */
  readonly openReviewCommentCount?: number;
  /** Durable clone policy plus the set size needed for a concise all/subset chip. */
  readonly clonePolicy?: TaskClonePolicy & { readonly workspaceSetProjectCount: number };
  /** ADR 0007: FAQ entry count (absent when zero) and the per-task auto-answer toggle. */
  readonly faqCount?: number;
  readonly autoAnswerFaq?: boolean;
  /** UX overhaul P1: the workspace-mismatch toast is suppressed for this task. */
  readonly dontAskWorkspace?: boolean;
  /** This task's subtasks, ordered by sortOrder. */
  readonly subtasks: readonly SubtaskSummary[];
}

/** Everything the Task Board panel renders: all columns, all tasks (with their subtasks). */
export interface BoardState {
  readonly columns: readonly BoardColumnSummary[];
  readonly tasks: readonly WorkTaskSummary[];
}

// ---------------------------------------------------------------------------
// Task Hub (UX overhaul P3) - overview-first projection over existing services
// ---------------------------------------------------------------------------

/**
 * One row in the hub's Chats card: a Recents row (same status/liveness
 * vocabulary, so the hub's dot cannot disagree with the rail or the fleet)
 * plus the provider/model label and turn liveness the hub shows.
 */
export interface HubChatSummary extends RecentChatSummary {
  readonly providerId: string;
  readonly model?: string;
  /** A turn is in flight right now (ChatSessionSummary.agentActivity root). */
  readonly turnActive?: boolean;
  /** Present when the chat belongs to one of the task's subtasks. */
  readonly subtaskId?: string;
}

/**
 * One "waiting on you" item in the attention rail, deep-linked to the session
 * that raised it. Pending only - resolved items leave the rail entirely.
 */
export interface HubAttentionItem {
  readonly kind: "question" | "access";
  readonly sessionId: string;
  /** One display line: the question asked, or the access an agent wants. */
  readonly headline: string;
}

/**
 * The hub's four quiet tiles. cpu/mem are summed across the task's running
 * sandboxes and are absent when nothing could be sampled (the sampler is
 * Windows-only); tokens is absent when no agent activity has been folded yet.
 */
export interface HubStats {
  /** Summed CPU busy across the task's sandboxes, percent of one core. */
  readonly cpuPercent?: number;
  readonly memBytes?: number;
  readonly tokens?: number;
  readonly runtimeCount: number;
}

/** The collapsed System card: what this task is actually running on. */
export interface HubSystemState {
  readonly runtimes: readonly RuntimeSummary[];
  /** Display-only mount lines ("rw <path>"); never runtime handles. */
  readonly mounts: readonly string[];
  /** Reconstructed `sbx create …` for the newest live runtime, when there is one. */
  readonly launchCommand?: string;
}

/**
 * Everything the Task Hub renders for one task. A projection assembled from
 * the services that already own each part - the hub stores nothing of its own
 * and every row links out to the surface that owns the depth.
 */
export interface HubState {
  readonly task: WorkTaskSummary;
  readonly chats: readonly HubChatSummary[];
  /** `task.subtasks`, hoisted so the Subtasks card reads exactly one field. */
  readonly subtasks: readonly SubtaskSummary[];
  /** Plans linked to this task, newest-updated first. */
  readonly plans: readonly PlanSummary[];
  readonly attention: readonly HubAttentionItem[];
  readonly stats: HubStats;
  readonly system: HubSystemState;
  /** Workspace-set name for the header chip; absent when the task links none. */
  readonly workspaceName?: string;
  readonly generatedAt: string;
}

/** Display-safe projection of a memory (agent-proposed or user quick-add). */
export interface MemoryCandidateSummary {
  readonly memoryCandidateId: string;
  readonly sessionId: string;
  readonly content: string;
  readonly status: MemoryCandidateStatus;
  readonly createdAt: string;
  /** Legacy rows read back as global. */
  readonly scope: MemoryScope;
  /** Human anchor label: task title or workspace folder basenames. */
  readonly scopeLabel?: string;
  readonly tags: readonly string[];
  readonly origin: MemoryOrigin;
}

/** Human edits carried with an approval (trim content, retarget scope/tags). */
export interface MemoryEditsInput {
  readonly content?: string;
  readonly scope?: MemoryScope;
  readonly tags?: readonly string[];
}

/** Registry entry draft from the System-tab manager. env is write-only: absent on update = keep stored values. */
export interface McpServerDraft {
  readonly serverId?: string;
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly enabledByDefault: boolean;
  readonly sensitive: boolean;
  readonly notes?: string;
}

/** Display-safe registry row: env renders as KEY NAMES only, never values. */
export interface McpServerSummary {
  readonly serverId: string;
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly envKeys: readonly string[];
  readonly enabledByDefault: boolean;
  readonly sensitive: boolean;
  readonly notes?: string;
  readonly source: "registry" | "settings";
}

export interface McpOverrideSummary {
  readonly scope: McpOverrideScope;
  readonly refId: string;
  readonly serverId: string;
  readonly state: "on" | "off";
}

/** Everything the workspace policy panel section renders. */
export interface WorkspaceSecuritySummary {
  readonly managed: boolean;
  readonly label: string;
  readonly cloneOnly: boolean;
  readonly allowedRootCount?: number;
  readonly networkedAiAllowed: boolean;
  readonly omissionsEnabled: boolean;
}

export interface WorkspacePolicyState {
  readonly projects: readonly ProjectSummary[];
  readonly workspaceSets: readonly WorkspaceSetSummary[];
  readonly accessRequests: readonly AccessRequestSummary[];
  /** Effective host-enforced policy; absent only for legacy/test compositions. */
  readonly security?: WorkspaceSecuritySummary;
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
  /**
   * Full Session view only: true when the file's current content already
   * matches the working (Session) baseline - i.e. the change was accepted and
   * is shown for history, with no pending accept/discard action.
   */
  readonly accepted?: boolean;
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

/** The window's active text editor, surfaced so the composer can offer it as a
 * one-click attachment. `path` is the host fs path (mapped to a runtime path in
 * the webview); `name` is the basename for display. */
export interface ActiveEditorRef {
  readonly path: string;
  readonly name: string;
}

// ---------------------------------------------------------------------------
// Configure panel (UX overhaul P6)
// ---------------------------------------------------------------------------

/**
 * Where a Configure row's value actually lives - the panel's whole trust
 * story in one word, rendered as a chip beside every row:
 *
 * - `local`    SQLite (Drydock owns it; editable right here)
 * - `settings` a VS Code setting (written through the settings API)
 * - `project`  a `.drydock/` file in an open folder (READ-ONLY here; the row
 *              offers "edit the file ↗" instead of a control)
 */
export type ConfigProvenance = "local" | "settings" | "project";

/** Global = this machine; project = the merged view with the open folders' files. */
export type ConfigScope = "global" | "project";

/** Left-nav sections, in render order. */
export const CONFIG_SECTIONS = [
  "providers",
  "mcp",
  "models",
  "preprompts",
  "recipes",
  "memories",
  "runtime",
  "security"
] as const;

export type ConfigSection = (typeof CONFIG_SECTIONS)[number];

/** Sections allowed to write a setting; a closed enum, never a free-form key namespace. */
export const CONFIG_SETTING_SECTIONS = ["runtime", "security", "memories", "preprompts"] as const;

export type ConfigSettingSection = (typeof CONFIG_SETTING_SECTIONS)[number];

/** One glob→tag row of `drydock.memory.tagRules`, as edited by the panel. */
export interface ConfigTagRuleInput {
  readonly globs: readonly string[];
  readonly tag: string;
}

/**
 * A JSON-safe settings value. Deliberately narrow: the four scalar/collection
 * shapes the surfaced `drydock.*` settings actually use, plus the tag-rule
 * object array. Anything else is rejected at the boundary.
 */
export type ConfigSettingValue =
  | string
  | number
  | boolean
  | readonly string[]
  | Readonly<Record<string, string>>
  | readonly ConfigTagRuleInput[];

/** How a settings row renders (and how its value is validated). */
export type ConfigSettingKind = "boolean" | "number" | "string" | "string-list" | "string-map" | "tag-rules";

/**
 * One surfaced `drydock.*` setting. `key` omits the `drydock.` prefix (the
 * host re-adds it), and `requiresReload` drives the row's reload chip - most
 * machine-scope runtime/security settings only take effect on the next window.
 */
export interface ConfigSettingRow {
  readonly key: string;
  /** Which section renders it, and the only section allowed to write it. */
  readonly section: ConfigSettingSection;
  /** Plain-language one-liner; the row's only bold text. */
  readonly label: string;
  /** The dim second line: what it actually does, honestly. */
  readonly detail: string;
  readonly kind: ConfigSettingKind;
  readonly value: ConfigSettingValue;
  readonly requiresReload: boolean;
  readonly provenance: ConfigProvenance;
  readonly min?: number;
  readonly max?: number;
  /** Present when a managed policy or another setting pins this row read-only. */
  readonly lockedReason?: string;
}

/** One provider card: auth state plus the single default-model choice. */
export interface ConfigProviderRow {
  readonly providerId: string;
  readonly label: string;
  readonly authStatus: ProviderAuthStatus;
  readonly authKind?: "oauth" | "api-key";
  /** Display-safe command the sign-in button will run. */
  readonly loginHint?: string;
  readonly models: readonly ConfigModelOption[];
  /** Stored per-provider default (app_state); absent = the registry default. */
  readonly defaultModel?: string;
  /** Chats in the recent window that ran on this provider; omitted when unknown. */
  readonly usedByRecentChats?: number;
}

export interface ConfigModelOption {
  readonly id: string;
  readonly displayName: string;
}

/** One MCP row: quiet by design - toggle, name, transport, tools, provenance. */
export interface ConfigMcpRow {
  readonly serverId: string;
  readonly name: string;
  readonly provenance: ConfigProvenance;
  readonly enabled: boolean;
  /** stdio today; the field exists so the chip never has to lie later. */
  readonly transport: string;
  /** Tools the server advertises, when the host knows; omitted otherwise. */
  readonly toolCount?: number;
  readonly command: string;
  readonly args: readonly string[];
  readonly sensitive: boolean;
  /** Non-local rows: the file to open with `config.openFile`. */
  readonly filePath?: string;
}

export interface ConfigRecipeRow {
  readonly recipeId: string;
  readonly name: string;
  readonly description?: string;
  readonly stepCount: number;
  readonly provenance: ConfigProvenance;
}

export interface ConfigAspectRow {
  readonly aspectId: string;
  readonly label: string;
  readonly expectedArtifacts: readonly string[];
  readonly provenance: ConfigProvenance;
}

/** A merged tag rule: shipped defaults (`local`, read-only) then settings rows. */
export interface ConfigTagRuleRow {
  readonly globs: readonly string[];
  readonly tag: string;
  readonly provenance: ConfigProvenance;
}

/** A standing-instructions file: the settings one, or a detected repo file. */
export interface ConfigPrepromptRow {
  readonly label: string;
  /** Host path, display-safe; also the `config.openFile` argument. */
  readonly path: string;
  readonly provenance: ConfigProvenance;
  readonly exists: boolean;
  readonly bytes?: number;
}

/**
 * Everything the Configure panel renders, in one read. Project scope returns
 * the MERGED list (project rows included and marked read-only); global scope
 * returns only what this machine owns.
 */
export interface ConfigState {
  readonly scope: ConfigScope;
  /** Basename of the first open folder; absent in an empty window. */
  readonly projectLabel?: string;
  readonly availability: BackendAvailability;
  readonly providers: readonly ConfigProviderRow[];
  readonly mcp: readonly ConfigMcpRow[];
  readonly recipes: readonly ConfigRecipeRow[];
  readonly aspects: readonly ConfigAspectRow[];
  readonly tagRules: readonly ConfigTagRuleRow[];
  readonly preprompts: readonly ConfigPrepromptRow[];
  /** Every surfaced `drydock.*` setting, in render order; filter by `section`. */
  readonly settings: readonly ConfigSettingRow[];
  /**
   * The exact host paths `config.openFile` will accept for this state. The
   * webview never invents a path; the host re-checks against this same list.
   */
  readonly editablePaths: readonly string[];
}

export interface PanelInitState {
  readonly availability: BackendAvailability;
  readonly runtimes: readonly RuntimeSummary[];
  readonly providerCatalogs: readonly AgentModelCatalog[];
  readonly stateRootDisplayPath: string;
  /** Folder names open in this window; the `auto` workspace selection mounts these. */
  readonly openFolderNames: readonly string[];
  /** The active editor at init, if any (a file-scheme document). */
  readonly activeEditor?: ActiveEditorRef;
  /** Idle label threshold for delegated agents. */
  readonly agentIdleThresholdMs: number;
  /** Wrap long lines inside chat transcript code blocks. */
  readonly codeBlockWordWrap: boolean;
}

export type PanelResponsePayload =
  | { readonly type: "panel.init"; readonly state: PanelInitState }
  | { readonly type: "isolatedRun.listRuntimes"; readonly runtimes: readonly RuntimeSummary[] }
  | { readonly type: "runtime.reconcile"; readonly accepted: true }
  | { readonly type: "isolatedRun.stopRuntime"; readonly runtimeId: string; readonly status: string; readonly diagnostics: readonly string[] }
  | { readonly type: "runtime.sbxLogin"; readonly launched: string }
  | { readonly type: "runtime.openTerminal"; readonly accepted: true }
  | { readonly type: "chat.rawStream"; readonly text: string; readonly lastChunkAt: string | null }
  | { readonly type: "chat.runtimeStats"; readonly stats: RuntimeStatsSummary | null }
  | { readonly type: "chat.openFile"; readonly opened: boolean }
  | { readonly type: "chat.start"; readonly session: ChatSessionSummary }
  | { readonly type: "chat.startSession"; readonly session: ChatSessionSummary; readonly providerCatalogs: readonly AgentModelCatalog[] }
  | { readonly type: "chat.sendTurn"; readonly accepted: true }
  | { readonly type: "chat.restartBackend"; readonly session: ChatSessionSummary; readonly providerCatalogs: readonly AgentModelCatalog[] }
  | { readonly type: "chat.resumeSession"; readonly session: ChatSessionSummary; readonly providerCatalogs: readonly AgentModelCatalog[] }
  | { readonly type: "chat.reclaim"; readonly session: ChatSessionSummary; readonly providerCatalogs: readonly AgentModelCatalog[] }
  | { readonly type: "ui.confirm"; readonly confirmed: boolean }
  | { readonly type: "chat.cancelTurn"; readonly accepted: true }
  | { readonly type: "chat.poke"; readonly poked: boolean }
  | { readonly type: "clipboard.writeText"; readonly accepted: true }
  | { readonly type: "chat.endSession"; readonly session: ChatSessionSummary }
  | { readonly type: "chat.spawnRole"; readonly session: ChatSessionSummary }
  | { readonly type: "question.list"; readonly questions: readonly AgentQuestionSummary[] }
  | { readonly type: "question.answer"; readonly question: AgentQuestionSummary; readonly dispatched: boolean }
  | { readonly type: "question.dismiss"; readonly question: AgentQuestionSummary }
  | { readonly type: "provider.list"; readonly providerCatalogs: readonly AgentModelCatalog[] }
  /**
   * `guided` means Drydock drives the sign-in itself (progress arrives as
   * `provider.authProgress` pushes); `terminal` means a visible terminal was
   * opened and completion is auto-detected by polling the auth probe.
   */
  | { readonly type: "provider.login"; readonly providerId: string; readonly launched: string; readonly mode: "guided" | "terminal" }
  | { readonly type: "provider.submitCode"; readonly providerId: string; readonly accepted: boolean }
  | { readonly type: "provider.submitApiKey"; readonly providerId: string; readonly authStatus: string; readonly message?: string }
  | { readonly type: "provider.cancelLogin"; readonly providerId: string; readonly cancelled: boolean }
  | { readonly type: "session.list"; readonly sessions: readonly ChatSessionSummary[] }
  | { readonly type: "session.timeline"; readonly sessionId: string; readonly lines: readonly SequencedTranscriptLine[] }
  | { readonly type: "session.rename"; readonly session: ChatSessionSummary }
  | { readonly type: "session.setDescription"; readonly session: ChatSessionSummary }
  | { readonly type: "session.delete"; readonly sessionId: string }
  /**
   * `log` mode has already written the clipboard when this arrives; `ai`
   * mode has only STARTED the summary - completion lands as a
   * `session.summaryReady` push (a model turn can outlive the request timeout).
   */
  | { readonly type: "session.summarize"; readonly sessionId: string; readonly mode: ChatSummarizeMode; readonly accepted: true }
  | { readonly type: "session.recents"; readonly recents: readonly RecentChatSummary[] }
  | { readonly type: "task.list"; readonly tasks: readonly WorkTaskSummary[] }
  | { readonly type: "task.create"; readonly task: WorkTaskSummary }
  | { readonly type: "task.update"; readonly task: WorkTaskSummary }
  | { readonly type: "task.delete"; readonly taskId: string }
  | { readonly type: "task.link"; readonly task: WorkTaskSummary }
  | { readonly type: "task.unlink"; readonly task: WorkTaskSummary }
  | { readonly type: "active.get"; readonly activeTaskId: string | null }
  | { readonly type: "active.set"; readonly activeTaskId: string | null }
  | { readonly type: "workspace.openInNewWindow"; readonly accepted: true }
  | { readonly type: "workspace.activate"; readonly result: WorkspaceActivateResult }
  | { readonly type: "memory.list"; readonly candidates: readonly MemoryCandidateSummary[]; readonly detectedTags: readonly string[] }
  | { readonly type: "memory.resolve"; readonly candidate: MemoryCandidateSummary }
  | { readonly type: "memory.open"; readonly accepted: true }
  | { readonly type: "memory.add"; readonly candidate: MemoryCandidateSummary }
  | { readonly type: "memory.delete"; readonly memoryCandidateId: string }
  | { readonly type: "mcp.list"; readonly servers: readonly McpServerSummary[]; readonly overrides: readonly McpOverrideSummary[] }
  | { readonly type: "mcp.save"; readonly servers: readonly McpServerSummary[] }
  | { readonly type: "mcp.delete"; readonly servers: readonly McpServerSummary[] }
  | { readonly type: "mcp.setOverride"; readonly overrides: readonly McpOverrideSummary[] }
  | { readonly type: "chat.contextDebug"; readonly accepted: true }
  | { readonly type: "workspace.state"; readonly state: WorkspacePolicyState }
  | { readonly type: "workspace.registerOpenFolders"; readonly projects: readonly ProjectSummary[] }
  | { readonly type: "workspace.createSet"; readonly state: WorkspacePolicyState }
  | { readonly type: "workspace.updateSet"; readonly state: WorkspacePolicyState }
  | { readonly type: "workspace.deleteSet"; readonly state: WorkspacePolicyState }
  | { readonly type: "workspace.removeProject"; readonly state: WorkspacePolicyState }
  | { readonly type: "workspace.updateProjectPath"; readonly state: WorkspacePolicyState }
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
  | { readonly type: "clone.state"; readonly sessionId: string; readonly repos: readonly CloneRepoState[] }
  | { readonly type: "clone.pull"; readonly result: CloneSyncResult }
  | { readonly type: "clone.push"; readonly result: CloneSyncResult }
  | { readonly type: "clone.discard"; readonly repos: readonly CloneRepoState[] }
  | { readonly type: "clone.exportPatch"; readonly savedPaths: readonly string[]; readonly message: string }
  | { readonly type: "chat.uploadAttachment"; readonly runtimePath: string; readonly name: string; readonly bytes: number }
  | { readonly type: "preview.list"; readonly previews: readonly PreviewSummary[] }
  | { readonly type: "preview.open"; readonly accepted: true }
  | { readonly type: "preview.stop"; readonly previews: readonly PreviewSummary[] }
  | { readonly type: "terminal.attach"; readonly accepted: true }
  | { readonly type: "taskReview.open"; readonly accepted: true }
  | { readonly type: "taskReview.state"; readonly state: TaskReviewState }
  | { readonly type: "taskReview.submit"; readonly dispatched: number; readonly sessions: number; readonly sentSessions?: readonly TaskReviewSessionRef[]; readonly errors?: readonly string[] }
  | { readonly type: "codeReview.open"; readonly accepted: true }
  | { readonly type: "codeReview.state"; readonly state: CodeReviewPanelState }
  | { readonly type: "codeReview.fileDiff"; readonly repo: string; readonly path: string; readonly diff: ReviewFileDiff }
  | { readonly type: "codeReview.addNote"; readonly comments: readonly ReviewCommentSummary[] }
  | { readonly type: "board.state"; readonly board: BoardState }
  | { readonly type: "board.moveCard"; readonly board: BoardState }
  | { readonly type: "board.columns.update"; readonly board: BoardState }
  | { readonly type: "subtask.create"; readonly task: WorkTaskSummary }
  | { readonly type: "subtask.update"; readonly task: WorkTaskSummary }
  | { readonly type: "subtask.delete"; readonly task: WorkTaskSummary }
  | { readonly type: "subtask.dependency.add"; readonly task: WorkTaskSummary }
  | { readonly type: "subtask.dependency.remove"; readonly task: WorkTaskSummary }
  | { readonly type: "subtask.start"; readonly accepted: boolean }
  | { readonly type: "task.start"; readonly accepted: boolean }
  | { readonly type: "recipes.list"; readonly recipes: readonly TaskRecipeRecord[] }
  | { readonly type: "task.createFromRecipe"; readonly task: WorkTaskSummary }
  | { readonly type: "task.faq.list"; readonly faqs: readonly TaskFaqRecord[] }
  | { readonly type: "task.faq.add"; readonly faqs: readonly TaskFaqRecord[] }
  | { readonly type: "task.faq.remove"; readonly faqs: readonly TaskFaqRecord[] }
  | { readonly type: "hub.state"; readonly state: HubState }
  | { readonly type: "panel.openSurface"; readonly accepted: true }
  | { readonly type: "taskBoard.open"; readonly accepted: true }
  | { readonly type: "agents.open"; readonly accepted: true }
  | { readonly type: "agents.state"; readonly state: AgentsOverviewState }
  | { readonly type: "agents.openSession"; readonly accepted: true }
  | { readonly type: "agents.landSession"; readonly message: string }
  | { readonly type: "planner.open"; readonly accepted: true }
  | { readonly type: "planner.plans"; readonly plans: readonly PlanSummary[] }
  | { readonly type: "planner.state"; readonly state: PlannerStateDetail; readonly session: ChatSessionSummary | null }
  | { readonly type: "planner.create"; readonly plan: PlanSummary }
  | { readonly type: "planner.updateIntake"; readonly plan: PlanSummary }
  | { readonly type: "planner.archive"; readonly plan: PlanSummary }
  /** Ack only - session boot outlives the request timeout; completion arrives as the planner.sessionReady push. */
  | { readonly type: "planner.startSession"; readonly accepted: true }
  | { readonly type: "planner.sendTurn"; readonly accepted: true }
  | { readonly type: "planner.annotation.add"; readonly annotation: PlanAnnotationSummary }
  | { readonly type: "planner.annotation.setStatus"; readonly annotation: PlanAnnotationSummary }
  | { readonly type: "planner.annotation.remove"; readonly removed: true }
  | { readonly type: "planner.artifact.rename"; readonly artifact: PlanArtifactSummary }
  | { readonly type: "planner.sendInstructions"; readonly accepted: true; readonly sentCount: number }
  | { readonly type: "planner.subtaskCandidates"; readonly candidates: readonly string[]; readonly taskId?: string; readonly taskTitle?: string }
  | { readonly type: "planner.materializeSubtasks"; readonly createdCount: number; readonly taskId: string }
  | { readonly type: "planner.regenerate"; readonly accepted: true }
  | { readonly type: "planner.openArtifact"; readonly accepted: true }
  | { readonly type: "planner.setPrototypeScripts"; readonly artifact: PlanArtifactSummary }
  | { readonly type: "planner.aspects.list"; readonly aspects: readonly PlanAspectSummary[] }
  | { readonly type: "planner.aspects.save"; readonly aspects: readonly PlanAspectSummary[] }
  | { readonly type: "planner.aspects.archive"; readonly aspects: readonly PlanAspectSummary[] }
  | { readonly type: "config.state"; readonly state: ConfigState }
  /** No Save button: the write already happened; the row shows "saved to settings". */
  | { readonly type: "config.setSetting"; readonly ok: true }
  | { readonly type: "config.mcpToggle"; readonly servers: readonly ConfigMcpRow[] }
  | { readonly type: "config.mcpAdd"; readonly servers: readonly ConfigMcpRow[] }
  | { readonly type: "config.provider.signIn"; readonly providerId: string; readonly launched: string; readonly mode: "guided" | "terminal" }
  | { readonly type: "config.provider.setDefaultModel"; readonly providerId: string; readonly model: string }
  | { readonly type: "config.openFile"; readonly opened: boolean };

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
  /** Boot-stage progress for a starting session (UX overhaul P4): the composer timeline + reconnect spinners consume the same events. */
  | { readonly type: "chat.bootProgress"; readonly sessionId: string; readonly stage: "create" | "mount" | "clone" | "start" }
  /** Open file-scheme folders changed in this VS Code window. */
  | { readonly type: "workspace.folders"; readonly openFolderNames: readonly string[] }
  | { readonly type: "runtime.inventory"; readonly runtimes: readonly RuntimeSummary[] }
  | { readonly type: "run.started"; readonly isolation: IsolationSummary }
  /**
   * A send/dispatch failed before (or outside) a live turn, so no transcript
   * event exists for it. `sessionId` is present whenever the failure belongs
   * to a chat session; only pre-session boot failures omit it. The webview
   * must surface the message to the user, not just log it.
   */
  | { readonly type: "run.failed"; readonly sessionId?: string; readonly message: string }
  /** Human-readable phase while a new isolated chat backend is booting. */
  | { readonly type: "chat.startProgress"; readonly message: string }
  | { readonly type: "chat.turnStarted"; readonly sessionId: string; readonly runId: string }
  | { readonly type: "chat.event"; readonly sessionId: string; readonly line: SequencedTranscriptLine }
  | { readonly type: "chat.turnCompleted"; readonly sessionId: string; readonly runId: string; readonly status: string }
  | { readonly type: "provider.models"; readonly providerCatalogs: readonly AgentModelCatalog[] }
  /**
   * Progress of a guided provider sign-in. `detail` is display-safe (a sign-in
   * URL or a short status line); secret material never rides this event.
   */
  | {
      readonly type: "provider.authProgress";
      readonly providerId: string;
      readonly phase: "launched" | "browser-opened" | "awaiting-code" | "verifying" | "connected" | "failed";
      readonly detail?: string;
    }
  | { readonly type: "session.updated"; readonly session: ChatSessionSummary }
  | { readonly type: "session.deleted"; readonly sessionId: string }
  | { readonly type: "session.attention"; readonly sessionId: string; readonly reasons: readonly SessionAttentionReason[] }
  | { readonly type: "session.agentActivity"; readonly sessionId: string; readonly activity: AgentActivitySummary }
  /** AI summary finished: ok means the text is on the clipboard. */
  | { readonly type: "session.summaryReady"; readonly sessionId: string; readonly ok: boolean; readonly error?: string }
  | { readonly type: "question.asked"; readonly question: AgentQuestionSummary }
  | { readonly type: "question.resolved"; readonly question: AgentQuestionSummary }
  | { readonly type: "policy.accessRequested"; readonly accessRequest: AccessRequestSummary }
  | { readonly type: "task.updated"; readonly task: WorkTaskSummary }
  | { readonly type: "task.deleted"; readonly taskId: string }
  /** The active-task spine moved; every surface retargets off this push. */
  | { readonly type: "activeTask"; readonly activeTaskId: string | null }
  /**
   * Task Hub: go back one step to the previously active task (the Alt+Left
   * command; the same return the transient back-chip performs). The webview
   * owns the one-step history, so the push carries no target.
   */
  | { readonly type: "hub.back" }
  | { readonly type: "memory.candidateAdded"; readonly candidate: MemoryCandidateSummary }
  | { readonly type: "taskReview.updated"; readonly taskId: string }
  | { readonly type: "codeReview.updated"; readonly taskId: string }
  | { readonly type: "preview.available"; readonly preview: PreviewSummary }
  | { readonly type: "editor.active"; readonly editor: ActiveEditorRef | null }
  | { readonly type: "board.changed" }
  /** Coarse fleet invalidation: the Agents panel refetches agents.state. */
  | { readonly type: "agents.changed" }
  /**
   * Sidebar navigation: another surface asked the control panel to show this
   * session's chat (the planner.showPlan pattern; nodeId → Agents lens).
   */
  | { readonly type: "panel.showSession"; readonly sessionId: string; readonly nodeId?: string }
  /** Coarse invalidation: the planner webview refetches planner.state. */
  | { readonly type: "planner.changed"; readonly planId: string }
  /** Panel navigation: another surface asked the panel to show this plan. */
  | { readonly type: "planner.showPlan"; readonly planId: string }
  /** Cross-panel onboarding: begin this panel's full guided tour after its initial state is ready. */
  | { readonly type: "help.startTour" }
  /** A `drydock.*` setting changed outside the Configure panel; it refetches config.state. */
  | { readonly type: "config.changed" }
  /** Terminal result of a planner.create / planner.startSession boot. */
  | { readonly type: "planner.sessionReady"; readonly planId: string; readonly sessionId: string; readonly ok: boolean; readonly error?: string };

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
    case "runtime.sbxLogin":
    case "session.list":
    case "task.list":
    case "workspace.state":
    case "workspace.registerOpenFolders":
    case "runtime.reconcile":
    case "active.get":
      return { type: payload["type"] };
    case "active.set": {
      // Null clears the spine; anything else must be a bounded task id.
      const taskId = payload["taskId"];
      if (taskId === null) return { type: "active.set", taskId: null };
      if (!isBoundedString(taskId, MAX_ID_LENGTH)) return null;
      return { type: "active.set", taskId };
    }
    case "session.recents": {
      // The rail asks for a handful of rows; the cap keeps a hostile webview
      // from turning one request into a full-history scan.
      const limit = payload["limit"];
      if (limit === undefined) return { type: "session.recents" };
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_RECENTS_LIMIT) return null;
      return { type: "session.recents", limit };
    }
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
      const autoAnswerFaq = payload["autoAnswerFaq"];
      if (!isBoundedString(taskId, MAX_ID_LENGTH)) return null;
      if (title !== undefined && !isBoundedString(title, MAX_NAME_LENGTH)) return null;
      // Empty string is allowed and clears the description.
      if (description !== undefined && (typeof description !== "string" || description.length > MAX_COMMENT_LENGTH)) return null;
      if (state !== undefined && !isWorkTaskState(state)) return null;
      if (autoAnswerFaq !== undefined && typeof autoAnswerFaq !== "boolean") return null;
      if (title === undefined && description === undefined && state === undefined && autoAnswerFaq === undefined) return null;
      return {
        type: "task.update",
        taskId,
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
        ...(state === undefined ? {} : { state }),
        ...(autoAnswerFaq === undefined ? {} : { autoAnswerFaq })
      };
    }
    case "task.faq.list": {
      const taskId = payload["taskId"];
      if (!isBoundedString(taskId, MAX_ID_LENGTH)) return null;
      return { type: "task.faq.list", taskId };
    }
    case "task.faq.add": {
      const taskId = payload["taskId"];
      const pattern = payload["pattern"];
      const answer = payload["answer"];
      if (!isBoundedString(taskId, MAX_ID_LENGTH)) return null;
      if (!isBoundedString(pattern, MAX_NAME_LENGTH)) return null;
      if (!isBoundedString(answer, MAX_COMMENT_LENGTH)) return null;
      return { type: "task.faq.add", taskId, pattern, answer };
    }
    case "task.faq.remove": {
      const taskId = payload["taskId"];
      const faqId = payload["faqId"];
      if (!isBoundedString(taskId, MAX_ID_LENGTH)) return null;
      if (!isBoundedString(faqId, MAX_ID_LENGTH)) return null;
      return { type: "task.faq.remove", taskId, faqId };
    }
    case "task.delete": {
      const taskId = payload["taskId"];
      if (!isBoundedString(taskId, MAX_ID_LENGTH)) return null;
      return { type: "task.delete", taskId };
    }
    case "taskReview.state":
    case "taskReview.submit": {
      const taskId = payload["taskId"];
      if (!isBoundedString(taskId, MAX_ID_LENGTH)) return null;
      return { type: payload["type"], taskId };
    }
    case "taskReview.open": {
      const taskId = payload["taskId"];
      const startGuide = payload["startGuide"];
      if (!isBoundedString(taskId, MAX_ID_LENGTH)) return null;
      if (startGuide !== undefined && typeof startGuide !== "boolean") return null;
      return { type: "taskReview.open", taskId, ...(startGuide === undefined ? {} : { startGuide }) };
    }
    case "codeReview.open": {
      const taskId = payload["taskId"];
      if (!isBoundedString(taskId, MAX_ID_LENGTH)) return null;
      return { type: "codeReview.open", taskId };
    }
    case "codeReview.state": {
      const taskId = payload["taskId"];
      const scope = payload["scope"];
      if (!isBoundedString(taskId, MAX_ID_LENGTH)) return null;
      if (scope !== "uncommitted" && scope !== "task" && scope !== "session") return null;
      return { type: "codeReview.state", taskId, scope };
    }
    case "codeReview.fileDiff": {
      const taskId = payload["taskId"];
      const scope = payload["scope"];
      const repo = payload["repo"];
      const filePath = payload["path"];
      const baselineId = payload["baselineId"];
      const ignoreWhitespace = payload["ignoreWhitespace"];
      if (!isBoundedString(taskId, MAX_ID_LENGTH)) return null;
      if (scope !== "uncommitted" && scope !== "task" && scope !== "session") return null;
      if (!isBoundedString(repo, MAX_NAME_LENGTH)) return null;
      if (!isBoundedString(filePath, MAX_PATH_LENGTH)) return null;
      if (baselineId !== undefined && !isBoundedString(baselineId, MAX_ID_LENGTH)) return null;
      if (ignoreWhitespace !== undefined && typeof ignoreWhitespace !== "boolean") return null;
      return {
        type: "codeReview.fileDiff",
        taskId,
        scope,
        repo,
        path: filePath,
        ...(baselineId === undefined ? {} : { baselineId }),
        ...(ignoreWhitespace === undefined ? {} : { ignoreWhitespace })
      };
    }
    case "codeReview.addNote": {
      const taskId = payload["taskId"];
      const scope = payload["scope"];
      const body = payload["body"];
      const anchors = payload["anchors"];
      if (!isBoundedString(taskId, MAX_ID_LENGTH)) return null;
      if (scope !== "uncommitted" && scope !== "task" && scope !== "session") return null;
      if (!isBoundedString(body, MAX_COMMENT_LENGTH)) return null;
      if (!Array.isArray(anchors) || anchors.length === 0 || anchors.length > 20) return null;
      const parsedAnchors: CodeReviewAnchor[] = [];
      for (const candidate of anchors) {
        if (typeof candidate !== "object" || candidate === null) return null;
        const anchor = candidate as Record<string, unknown>;
        const repo = anchor["repo"];
        const filePath = anchor["path"];
        const startLine = anchor["startLine"];
        const endLine = anchor["endLine"];
        const sessionId = anchor["sessionId"];
        if (!isBoundedString(repo, MAX_NAME_LENGTH)) return null;
        if (!isBoundedString(filePath, MAX_PATH_LENGTH)) return null;
        if (!isLineNumber(startLine) || !isLineNumber(endLine) || startLine > endLine) return null;
        if (sessionId !== undefined && !isBoundedString(sessionId, MAX_ID_LENGTH)) return null;
        parsedAnchors.push({
          repo,
          path: filePath,
          startLine,
          endLine,
          ...(sessionId === undefined ? {} : { sessionId })
        });
      }
      return { type: "codeReview.addNote", taskId, scope, body, anchors: parsedAnchors };
    }
    case "board.state":
    case "agents.state":
    case "recipes.list":
      return { type: payload["type"] };
    case "hub.state": {
      const taskId = payload["taskId"];
      if (!isBoundedString(taskId, MAX_ID_LENGTH)) return null;
      return { type: "hub.state", taskId };
    }
    case "panel.openSurface": {
      // A closed surface enum plus optional bounded ids: the webview can name
      // where to go, never what command to run.
      const surface = payload["surface"];
      if (!isPanelSurface(surface)) return null;
      const taskId = payload["taskId"];
      const planId = payload["planId"];
      if (taskId !== undefined && !isBoundedString(taskId, MAX_ID_LENGTH)) return null;
      if (planId !== undefined && !isBoundedString(planId, MAX_ID_LENGTH)) return null;
      return {
        type: "panel.openSurface",
        surface,
        ...(taskId === undefined ? {} : { taskId }),
        ...(planId === undefined ? {} : { planId })
      };
    }
    case "taskBoard.open":
    case "agents.open": {
      const startGuide = payload["startGuide"];
      if (startGuide !== undefined && typeof startGuide !== "boolean") return null;
      return { type: payload["type"], ...(startGuide === undefined ? {} : { startGuide }) };
    }
    case "agents.landSession": {
      const sessionId = payload["sessionId"];
      if (!isBoundedString(sessionId, MAX_ID_LENGTH)) return null;
      return { type: "agents.landSession", sessionId };
    }
    case "agents.openSession": {
      const sessionId = payload["sessionId"];
      if (!isBoundedString(sessionId, MAX_ID_LENGTH)) return null;
      const nodeId = payload["nodeId"];
      if (nodeId !== undefined && !isBoundedString(nodeId, MAX_ID_LENGTH)) return null;
      return { type: "agents.openSession", sessionId, ...(nodeId === undefined ? {} : { nodeId }) };
    }
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
      const colorOverride = payload["colorOverride"];
      const seedMode = payload["seedMode"];
      const verified = payload["verified"];
      if (!isBoundedString(subtaskId, MAX_ID_LENGTH)) return null;
      if (title !== undefined && !isBoundedString(title, MAX_NAME_LENGTH)) return null;
      // Empty string is allowed and clears description/prompt.
      if (description !== undefined && (typeof description !== "string" || description.length > MAX_COMMENT_LENGTH)) return null;
      if (prompt !== undefined && (typeof prompt !== "string" || prompt.length > MAX_PROMPT_LENGTH)) return null;
      if (autoStart !== undefined && typeof autoStart !== "boolean") return null;
      if (columnId !== undefined && !isBoundedString(columnId, MAX_ID_LENGTH)) return null;
      if (colorOverride !== undefined && colorOverride !== null && !isStripeIndex(colorOverride)) return null;
      if (seedMode !== undefined && seedMode !== "local" && seedMode !== "upstream") return null;
      if (verified !== undefined && typeof verified !== "boolean") return null;
      if (
        title === undefined && description === undefined && prompt === undefined
        && autoStart === undefined && columnId === undefined && colorOverride === undefined
        && seedMode === undefined && verified === undefined
      ) return null;
      return {
        type: "subtask.update",
        subtaskId,
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
        ...(prompt === undefined ? {} : { prompt }),
        ...(autoStart === undefined ? {} : { autoStart }),
        ...(columnId === undefined ? {} : { columnId }),
        ...(colorOverride === undefined ? {} : { colorOverride }),
        ...(seedMode === undefined ? {} : { seedMode }),
        ...(verified === undefined ? {} : { verified })
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
    case "task.createFromRecipe": {
      const recipeId = payload["recipeId"];
      const title = payload["title"];
      if (!isBoundedString(recipeId, MAX_ID_LENGTH)) return null;
      if (!isBoundedString(title, MAX_NAME_LENGTH)) return null;
      return { type: "task.createFromRecipe", recipeId, title };
    }
    case "task.link":
    case "task.unlink": {
      const taskId = payload["taskId"];
      const workspaceSetId = payload["workspaceSetId"];
      const sessionId = payload["sessionId"];
      const subtaskId = payload["subtaskId"];
      if (!isBoundedString(taskId, MAX_ID_LENGTH)) return null;
      // Exactly one link target per request.
      if ((workspaceSetId === undefined) === (sessionId === undefined)) return null;
      if (workspaceSetId !== undefined && !isBoundedString(workspaceSetId, MAX_ID_LENGTH)) return null;
      if (sessionId !== undefined && !isBoundedString(sessionId, MAX_ID_LENGTH)) return null;
      // A subtask narrows a SESSION link to one card; unlink has no such form.
      if (subtaskId !== undefined
        && (payload["type"] !== "task.link" || sessionId === undefined || !isBoundedString(subtaskId, MAX_ID_LENGTH))) {
        return null;
      }
      return {
        type: payload["type"],
        taskId,
        ...(workspaceSetId === undefined ? {} : { workspaceSetId }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(subtaskId === undefined ? {} : { subtaskId })
      };
    }
    case "workspace.openInNewWindow": {
      const workspaceSetId = payload["workspaceSetId"];
      if (!isBoundedString(workspaceSetId, MAX_ID_LENGTH)) return null;
      return { type: "workspace.openInNewWindow", workspaceSetId };
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
      const edits = parseMemoryEdits(payload["edits"]);
      if (edits === null) return null;
      return { type: "memory.resolve", memoryCandidateId, approve, ...(edits === undefined ? {} : { edits }) };
    }
    case "memory.open": {
      const memoryCandidateId = payload["memoryCandidateId"];
      if (!isBoundedString(memoryCandidateId, MAX_ID_LENGTH)) return null;
      return { type: "memory.open", memoryCandidateId };
    }
    case "memory.add": {
      const content = payload["content"];
      const scope = payload["scope"];
      const taskId = payload["taskId"];
      if (!isBoundedString(content, MAX_MEMORY_CONTENT_LENGTH)) return null;
      if (!isMemoryScope(scope)) return null;
      if (taskId !== undefined && !isBoundedString(taskId, MAX_ID_LENGTH)) return null;
      const tags = parseMemoryTags(payload["tags"]);
      if (tags === null) return null;
      return {
        type: "memory.add",
        content,
        scope,
        ...(taskId === undefined ? {} : { taskId }),
        ...(tags === undefined ? {} : { tags })
      };
    }
    case "memory.delete": {
      const memoryCandidateId = payload["memoryCandidateId"];
      if (!isBoundedString(memoryCandidateId, MAX_ID_LENGTH)) return null;
      return { type: "memory.delete", memoryCandidateId };
    }
    case "config.state": {
      const scope = payload["scope"];
      if (scope === undefined) return { type: "config.state" };
      if (scope !== "global" && scope !== "project") return null;
      return { type: "config.state", scope };
    }
    case "config.setSetting": {
      const section = payload["section"];
      const key = payload["key"];
      if (!isConfigSettingSection(section)) return null;
      // Settings keys are a shape, not free text: the host re-adds the
      // `drydock.` prefix and additionally checks the key against the rows it
      // just advertised, so a hostile webview cannot reach another extension's
      // configuration even if this guard were the only one.
      if (!isBoundedString(key, MAX_NAME_LENGTH) || !CONFIG_SETTING_KEY_RE.test(key)) return null;
      const value = parseConfigSettingValue(payload["value"]);
      if (value === null) return null;
      return { type: "config.setSetting", section, key, value };
    }
    case "config.mcpToggle": {
      const serverId = payload["serverId"];
      const enabled = payload["enabled"];
      if (!isBoundedString(serverId, MAX_ID_LENGTH)) return null;
      if (typeof enabled !== "boolean") return null;
      return { type: "config.mcpToggle", serverId, enabled };
    }
    case "config.mcpAdd": {
      const name = payload["name"];
      const command = payload["command"];
      if (!isBoundedString(name, MAX_NAME_LENGTH)) return null;
      if (!isBoundedString(command, MAX_MCP_COMMAND_LENGTH)) return null;
      const args = payload["args"];
      if (!Array.isArray(args) || args.length > MAX_MCP_ARG_COUNT) return null;
      for (const arg of args) {
        if (typeof arg !== "string" || arg.length === 0 || arg.length > MAX_MCP_COMMAND_LENGTH) return null;
      }
      return { type: "config.mcpAdd", name, command, args: args as string[] };
    }
    case "config.provider.signIn": {
      const providerId = payload["providerId"];
      if (!isBoundedString(providerId, MAX_MODEL_ID_LENGTH)) return null;
      return { type: "config.provider.signIn", providerId };
    }
    case "config.provider.setDefaultModel": {
      const providerId = payload["providerId"];
      const model = payload["model"];
      if (!isBoundedString(providerId, MAX_MODEL_ID_LENGTH)) return null;
      // The empty string clears the stored default (back to the registry pick).
      if (!isBoundedText(model, MAX_MODEL_ID_LENGTH)) return null;
      return { type: "config.provider.setDefaultModel", providerId, model };
    }
    case "config.openFile": {
      const filePath = payload["path"];
      if (!isBoundedString(filePath, MAX_PATH_LENGTH)) return null;
      return { type: "config.openFile", path: filePath };
    }
    case "mcp.list":
      return { type: "mcp.list" };
    case "mcp.save": {
      const server = parseMcpServerDraft(payload["server"]);
      if (server === null) return null;
      return { type: "mcp.save", server };
    }
    case "mcp.delete": {
      const serverId = payload["serverId"];
      if (!isBoundedString(serverId, MAX_ID_LENGTH)) return null;
      return { type: "mcp.delete", serverId };
    }
    case "mcp.setOverride": {
      const scope = payload["scope"];
      const refId = payload["refId"];
      const serverId = payload["serverId"];
      const state = payload["state"];
      if (scope !== "workspace-set" && scope !== "task" && scope !== "session") return null;
      if (!isBoundedString(refId, MAX_ID_LENGTH)) return null;
      if (!isBoundedString(serverId, MAX_ID_LENGTH)) return null;
      if (state !== "on" && state !== "off" && state !== "inherit") return null;
      return { type: "mcp.setOverride", scope, refId, serverId, state };
    }
    case "chat.contextDebug": {
      const sessionId = payload["sessionId"];
      if (!isBoundedString(sessionId, MAX_ID_LENGTH)) return null;
      return { type: "chat.contextDebug", sessionId };
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
      const taskId = payload["taskId"];
      if (taskId !== undefined && !isBoundedString(taskId, MAX_ID_LENGTH)) return null;
      return {
        type: "chat.start",
        prompt,
        ...(parsedModel === undefined ? {} : { model: parsedModel }),
        ...(parsedWorkspace === undefined ? {} : { workspace: parsedWorkspace }),
        ...(taskId === undefined ? {} : { taskId })
      };
    }
    case "chat.startSession": {
      const parsedModel = parseModelSelection(payload["model"]);
      if (parsedModel === null || parsedModel === undefined) return null;
      const parsedWorkspace = parseWorkspaceSelection(payload["workspace"]);
      if (parsedWorkspace === null) return null;
      const title = payload["title"];
      if (title !== undefined && !isBoundedString(title, MAX_NAME_LENGTH)) return null;
      const taskId = payload["taskId"];
      if (taskId !== undefined && !isBoundedString(taskId, MAX_ID_LENGTH)) return null;
      return {
        type: "chat.startSession",
        model: parsedModel,
        ...(parsedWorkspace === undefined ? {} : { workspace: parsedWorkspace }),
        ...(title === undefined ? {} : { title }),
        ...(taskId === undefined ? {} : { taskId })
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
    case "chat.reclaim": {
      const sessionId = payload["sessionId"];
      if (!isBoundedString(sessionId, MAX_ID_LENGTH)) return null;
      const parsedModel = parseModelSelection(payload["model"]);
      if (parsedModel === null) return null;
      return { type: "chat.reclaim", sessionId, ...(parsedModel === undefined ? {} : { model: parsedModel }) };
    }
    case "chat.openFile": {
      const path = payload["path"];
      if (!isBoundedString(path, 2048)) return null;
      return { type: "chat.openFile", path };
    }
    case "ui.confirm": {
      const message = payload["message"];
      const confirmLabel = payload["confirmLabel"];
      if (!isBoundedString(message, MAX_PROMPT_LENGTH)) return null;
      if (!isBoundedString(confirmLabel, MAX_NAME_LENGTH)) return null;
      const detail = payload["detail"];
      if (detail !== undefined && !isBoundedString(detail, MAX_PROMPT_LENGTH)) return null;
      return { type: "ui.confirm", message, confirmLabel, ...(detail === undefined ? {} : { detail }) };
    }
    case "chat.cancelTurn":
    case "chat.poke":
    case "chat.rawStream":
    case "chat.runtimeStats":
    case "chat.endSession":
    case "runtime.openTerminal":
    case "session.delete":
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
    case "clone.exportPatch": {
      const sessionId = payload["sessionId"];
      const repo = payload["repo"];
      if (!isBoundedString(sessionId, MAX_ID_LENGTH)) return null;
      if (repo !== undefined && !isBoundedString(repo, MAX_NAME_LENGTH)) return null;
      return { type: "clone.exportPatch", sessionId, ...(repo === undefined ? {} : { repo }) };
    }
    case "preview.list": {
      const sessionId = payload["sessionId"];
      if (!isBoundedString(sessionId, MAX_ID_LENGTH)) return null;
      return { type: "preview.list", sessionId };
    }
    case "preview.open": {
      const previewId = payload["previewId"];
      const external = payload["external"];
      if (!isBoundedString(previewId, MAX_ID_LENGTH)) return null;
      if (external !== undefined && typeof external !== "boolean") return null;
      return { type: "preview.open", previewId, ...(external === undefined ? {} : { external }) };
    }
    case "preview.stop": {
      const previewId = payload["previewId"];
      if (!isBoundedString(previewId, MAX_ID_LENGTH)) return null;
      return { type: "preview.stop", previewId };
    }
    case "terminal.attach": {
      const sessionId = payload["sessionId"];
      if (!isBoundedString(sessionId, MAX_ID_LENGTH)) return null;
      return { type: "terminal.attach", sessionId };
    }
    case "chat.uploadAttachment": {
      const sessionId = payload["sessionId"];
      const name = payload["name"];
      const dataBase64 = payload["dataBase64"];
      if (!isBoundedString(sessionId, MAX_ID_LENGTH)) return null;
      if (!isBoundedString(name, MAX_NAME_LENGTH)) return null;
      // ~12 MB binary as base64; the host re-validates and sanitizes the name.
      if (typeof dataBase64 !== "string" || dataBase64.length === 0 || dataBase64.length > 16_000_000) return null;
      return { type: "chat.uploadAttachment", sessionId, name, dataBase64 };
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
    case "session.summarize": {
      const sessionId = payload["sessionId"];
      if (!isBoundedString(sessionId, MAX_ID_LENGTH)) return null;
      const mode = payload["mode"];
      if (mode !== "log" && mode !== "ai") return null;
      return { type: "session.summarize", sessionId, mode };
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
      const members = parseMemberInputs(payload["members"]);
      if (members === null) return null;
      return { type: "workspace.createSet", name, members };
    }
    case "workspace.updateSet": {
      const workspaceSetId = payload["workspaceSetId"];
      const name = payload["name"];
      if (!isBoundedString(workspaceSetId, MAX_ID_LENGTH)) return null;
      if (!isBoundedString(name, MAX_NAME_LENGTH)) return null;
      const members = parseMemberInputs(payload["members"]);
      if (members === null) return null;
      return { type: "workspace.updateSet", workspaceSetId, name, members };
    }
    case "workspace.deleteSet": {
      const workspaceSetId = payload["workspaceSetId"];
      if (!isBoundedString(workspaceSetId, MAX_ID_LENGTH)) return null;
      return { type: "workspace.deleteSet", workspaceSetId };
    }
    case "workspace.removeProject": {
      const projectId = payload["projectId"];
      if (!isBoundedString(projectId, MAX_ID_LENGTH)) return null;
      return { type: "workspace.removeProject", projectId };
    }
    case "workspace.updateProjectPath": {
      const projectId = payload["projectId"];
      const projectPath = payload["path"];
      if (!isBoundedString(projectId, MAX_ID_LENGTH)) return null;
      if (!isBoundedString(projectPath, MAX_PATH_LENGTH)) return null;
      return { type: "workspace.updateProjectPath", projectId, path: projectPath };
    }
    case "provider.list": {
      const force = payload["force"];
      if (force !== undefined && typeof force !== "boolean") return null;
      return { type: "provider.list", ...(force === undefined ? {} : { force }) };
    }
    case "provider.login": {
      const providerId = payload["providerId"];
      if (!isBoundedString(providerId, MAX_MODEL_ID_LENGTH)) return null;
      return { type: "provider.login", providerId };
    }
    case "provider.submitCode": {
      const providerId = payload["providerId"];
      const code = payload["code"];
      if (!isBoundedString(providerId, MAX_MODEL_ID_LENGTH)) return null;
      if (!isBoundedString(code, MAX_SECRET_INPUT_LENGTH)) return null;
      return { type: "provider.submitCode", providerId, code };
    }
    case "provider.submitApiKey": {
      const providerId = payload["providerId"];
      const apiKey = payload["apiKey"];
      if (!isBoundedString(providerId, MAX_MODEL_ID_LENGTH)) return null;
      if (!isBoundedString(apiKey, MAX_SECRET_INPUT_LENGTH)) return null;
      return { type: "provider.submitApiKey", providerId, apiKey };
    }
    case "provider.cancelLogin": {
      const providerId = payload["providerId"];
      if (!isBoundedString(providerId, MAX_MODEL_ID_LENGTH)) return null;
      return { type: "provider.cancelLogin", providerId };
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
    case "diff.status": {
      const sessionId = payload["sessionId"];
      const view = payload["view"];
      if (view !== undefined && !isDiffViewMode(view)) return null;
      if (sessionId !== undefined && !isBoundedString(sessionId, MAX_ID_LENGTH)) return null;
      return {
        type: "diff.status",
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(view === undefined ? {} : { view })
      };
    }
    case "review.state": {
      const sessionId = payload["sessionId"];
      if (sessionId === undefined) return { type: payload["type"] };
      if (!isBoundedString(sessionId, MAX_ID_LENGTH)) return null;
      return { type: payload["type"], sessionId };
    }
    case "diff.acceptFile":
    case "diff.revertFile": {
      const baselineId = payload["baselineId"];
      const filePath = payload["path"];
      const view = payload["view"];
      if (!isBoundedString(baselineId, MAX_ID_LENGTH)) return null;
      if (!isBoundedString(filePath, MAX_PATH_LENGTH)) return null;
      if (view !== undefined && !isDiffViewMode(view)) return null;
      return {
        type: payload["type"],
        baselineId,
        path: filePath,
        ...(view === undefined ? {} : { view })
      };
    }
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
    case "planner.plans":
    case "planner.aspects.list":
      return { type: payload["type"] };
    case "planner.open": {
      const planId = payload["planId"];
      const startGuide = payload["startGuide"];
      if (planId !== undefined && !isBoundedString(planId, MAX_ID_LENGTH)) return null;
      if (startGuide !== undefined && typeof startGuide !== "boolean") return null;
      return {
        type: "planner.open",
        ...(planId === undefined ? {} : { planId }),
        ...(startGuide === undefined ? {} : { startGuide })
      };
    }
    case "planner.state":
    case "planner.sendInstructions":
    case "planner.subtaskCandidates": {
      const planId = payload["planId"];
      if (!isBoundedString(planId, MAX_ID_LENGTH)) return null;
      return { type: payload["type"], planId };
    }
    case "planner.materializeSubtasks": {
      const planId = payload["planId"];
      const titles = payload["titles"];
      if (!isBoundedString(planId, MAX_ID_LENGTH)) return null;
      if (!Array.isArray(titles) || titles.length === 0 || titles.length > 40) return null;
      if (!titles.every((title) => isBoundedString(title, MAX_NAME_LENGTH))) return null;
      return { type: "planner.materializeSubtasks", planId, titles };
    }
    case "planner.create": {
      const brief = payload["brief"];
      if (!isBoundedString(brief, MAX_PROMPT_LENGTH)) return null;
      const aspectIds = parseBoundedStringArray(payload["aspectIds"], MAX_NAME_LENGTH, 40);
      if (!Array.isArray(aspectIds)) return null;
      const contextRoots = parseBoundedStringArray(payload["contextRoots"], MAX_PATH_LENGTH, 40);
      if (!Array.isArray(contextRoots)) return null;
      const notes = payload["notes"];
      if (notes !== undefined && !isBoundedText(notes, MAX_PROMPT_LENGTH)) return null;
      const title = payload["title"];
      if (title !== undefined && !isBoundedString(title, MAX_NAME_LENGTH)) return null;
      const taskId = payload["taskId"];
      if (taskId !== undefined && !isBoundedString(taskId, MAX_ID_LENGTH)) return null;
      const model = parseModelSelection(payload["model"]);
      if (model === null) return null;
      return {
        type: "planner.create",
        brief,
        aspectIds,
        contextRoots,
        ...(notes === undefined ? {} : { notes }),
        ...(title === undefined ? {} : { title }),
        ...(taskId === undefined ? {} : { taskId }),
        ...(model === undefined ? {} : { model })
      };
    }
    case "planner.updateIntake": {
      const planId = payload["planId"];
      if (!isBoundedString(planId, MAX_ID_LENGTH)) return null;
      const title = payload["title"];
      if (title !== undefined && !isBoundedString(title, MAX_NAME_LENGTH)) return null;
      const brief = payload["brief"];
      if (brief !== undefined && !isBoundedString(brief, MAX_PROMPT_LENGTH)) return null;
      const aspectIds = parseBoundedStringArray(payload["aspectIds"], MAX_NAME_LENGTH, 40);
      if (aspectIds === null) return null;
      const contextRoots = parseBoundedStringArray(payload["contextRoots"], MAX_PATH_LENGTH, 40);
      if (contextRoots === null) return null;
      const notes = payload["notes"];
      if (notes !== undefined && !isBoundedText(notes, MAX_PROMPT_LENGTH)) return null;
      // An empty taskId clears the link back to an orphan plan.
      const taskId = payload["taskId"];
      if (taskId !== undefined && !isBoundedText(taskId, MAX_ID_LENGTH)) return null;
      return {
        type: "planner.updateIntake",
        planId,
        ...(title === undefined ? {} : { title }),
        ...(brief === undefined ? {} : { brief }),
        ...(aspectIds === undefined ? {} : { aspectIds }),
        ...(contextRoots === undefined ? {} : { contextRoots }),
        ...(notes === undefined ? {} : { notes }),
        ...(taskId === undefined ? {} : { taskId })
      };
    }
    case "planner.archive": {
      const planId = payload["planId"];
      const archived = payload["archived"];
      if (!isBoundedString(planId, MAX_ID_LENGTH)) return null;
      if (typeof archived !== "boolean") return null;
      return { type: "planner.archive", planId, archived };
    }
    case "planner.startSession": {
      const planId = payload["planId"];
      if (!isBoundedString(planId, MAX_ID_LENGTH)) return null;
      const model = parseModelSelection(payload["model"]);
      if (model === null) return null;
      return { type: "planner.startSession", planId, ...(model === undefined ? {} : { model }) };
    }
    case "planner.sendTurn": {
      const planId = payload["planId"];
      const prompt = payload["prompt"];
      if (!isBoundedString(planId, MAX_ID_LENGTH)) return null;
      if (!isBoundedString(prompt, MAX_PROMPT_LENGTH)) return null;
      return { type: "planner.sendTurn", planId, prompt };
    }
    case "planner.annotation.add": {
      const planId = payload["planId"];
      const artifactId = payload["artifactId"];
      const anchor = payload["anchor"];
      const body = payload["body"];
      if (!isBoundedString(planId, MAX_ID_LENGTH)) return null;
      if (!isBoundedString(artifactId, MAX_ID_LENGTH)) return null;
      if (!isBoundedString(anchor, MAX_ID_LENGTH) || parsePlanAnchor(anchor) === null) return null;
      if (!isBoundedString(body, MAX_COMMENT_LENGTH)) return null;
      return { type: "planner.annotation.add", planId, artifactId, anchor, body };
    }
    case "planner.annotation.setStatus": {
      const annotationId = payload["annotationId"];
      const status = payload["status"];
      if (!isBoundedString(annotationId, MAX_ID_LENGTH)) return null;
      if (!isPlanAnnotationStatus(status)) return null;
      return { type: "planner.annotation.setStatus", annotationId, status };
    }
    case "planner.annotation.remove": {
      const annotationId = payload["annotationId"];
      if (!isBoundedString(annotationId, MAX_ID_LENGTH)) return null;
      return { type: "planner.annotation.remove", annotationId };
    }
    case "planner.artifact.rename": {
      const artifactId = payload["artifactId"];
      const title = payload["title"];
      if (!isBoundedString(artifactId, MAX_ID_LENGTH)) return null;
      // An empty title clears the override back to the collected title.
      if (!isBoundedText(title, MAX_NAME_LENGTH)) return null;
      return { type: "planner.artifact.rename", artifactId, title };
    }
    case "planner.regenerate": {
      const planId = payload["planId"];
      if (!isBoundedString(planId, MAX_ID_LENGTH)) return null;
      const aspectId = payload["aspectId"];
      if (aspectId !== undefined && !isBoundedString(aspectId, MAX_NAME_LENGTH)) return null;
      return { type: "planner.regenerate", planId, ...(aspectId === undefined ? {} : { aspectId }) };
    }
    case "planner.openArtifact": {
      const artifactId = payload["artifactId"];
      if (!isBoundedString(artifactId, MAX_ID_LENGTH)) return null;
      return { type: "planner.openArtifact", artifactId };
    }
    case "planner.setPrototypeScripts": {
      const artifactId = payload["artifactId"];
      const enabled = payload["enabled"];
      if (!isBoundedString(artifactId, MAX_ID_LENGTH)) return null;
      if (typeof enabled !== "boolean") return null;
      return { type: "planner.setPrototypeScripts", artifactId, enabled };
    }
    case "planner.aspects.save": {
      const aspect = parsePlannerAspectSaveInput(payload["aspect"]);
      if (aspect === null) return null;
      return { type: "planner.aspects.save", aspect };
    }
    case "planner.aspects.archive": {
      const aspectId = payload["aspectId"];
      const archived = payload["archived"];
      if (!isBoundedString(aspectId, MAX_NAME_LENGTH)) return null;
      if (typeof archived !== "boolean") return null;
      return { type: "planner.aspects.archive", aspectId, archived };
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

function isPanelSurface(value: unknown): value is PanelSurface {
  return typeof value === "string" && (PANEL_SURFACES as readonly string[]).includes(value);
}

function isColumnCategory(value: unknown): value is ColumnCategory {
  return typeof value === "string" && (COLUMN_CATEGORIES as readonly string[]).includes(value);
}

/** Validates a workspace set's member array; null on empty or any malformed entry. */
function parseMemberInputs(value: unknown): WorkspaceSetMemberInput[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const result: WorkspaceSetMemberInput[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry as Record<string, unknown>;
    const projectId = record["projectId"];
    const readOnly = record["readOnly"];
    if (!isBoundedString(projectId, MAX_ID_LENGTH)) return null;
    if (typeof readOnly !== "boolean") return null;
    result.push({ projectId, readOnly });
  }
  return result;
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

/** A dependency-edge/stripe palette index: integer 0-7 (matches --dd-stripe-0..7). */
function isStripeIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 7;
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
  if (model !== undefined && model !== "" && !isBoundedString(model, MAX_MODEL_ID_LENGTH)) return null;
  const reasoningEffort = payload["reasoningEffort"];
  if (reasoningEffort !== undefined && reasoningEffort !== "" && !isBoundedString(reasoningEffort, MAX_MODEL_ID_LENGTH)) return null;
  return {
    providerId,
    ...(model === undefined || model === "" ? {} : { model }),
    ...(reasoningEffort === undefined || reasoningEffort === "" ? {} : { reasoningEffort })
  };
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

const MAX_MEMORY_CONTENT_LENGTH = 2_000;
const MAX_MEMORY_TAG_COUNT = 8;
const MAX_MEMORY_TAG_LENGTH = 32;

function isMemoryScope(value: unknown): value is MemoryScope {
  return value === "global" || value === "workspace" || value === "task";
}

/** undefined = absent (fine), null = malformed (reject the request). */
function parseMemoryTags(value: unknown): readonly string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const tags: string[] = [];
  for (const candidate of value.slice(0, MAX_MEMORY_TAG_COUNT)) {
    if (!isBoundedString(candidate, MAX_MEMORY_TAG_LENGTH)) return null;
    const tag = candidate.trim().toLowerCase();
    if (tag.length > 0 && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

/** undefined = absent (fine), null = malformed (reject the request). */
function parseMemoryEdits(value: unknown): MemoryEditsInput | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const content = record["content"];
  const scope = record["scope"];
  if (content !== undefined && !isBoundedString(content, MAX_MEMORY_CONTENT_LENGTH)) return null;
  if (scope !== undefined && !isMemoryScope(scope)) return null;
  const tags = parseMemoryTags(record["tags"]);
  if (tags === null) return null;
  return {
    ...(content === undefined ? {} : { content }),
    ...(scope === undefined ? {} : { scope }),
    ...(tags === undefined ? {} : { tags })
  };
}

const MAX_MCP_COMMAND_LENGTH = 512;
const MAX_MCP_ARG_COUNT = 32;
const MAX_MCP_ENV_COUNT = 32;
const MAX_MCP_NOTES_LENGTH = 1_000;

function parseMcpServerDraft(value: unknown): McpServerDraft | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const serverId = record["serverId"];
  const name = record["name"];
  const command = record["command"];
  const notes = record["notes"];
  if (serverId !== undefined && !isBoundedString(serverId, MAX_ID_LENGTH)) return null;
  if (!isBoundedString(name, MAX_NAME_LENGTH)) return null;
  if (!isBoundedString(command, MAX_MCP_COMMAND_LENGTH)) return null;
  if (notes !== undefined && !isBoundedText(notes, MAX_MCP_NOTES_LENGTH)) return null;
  const rawArgs = record["args"];
  if (!Array.isArray(rawArgs)) return null;
  const args: string[] = [];
  for (const arg of rawArgs.slice(0, MAX_MCP_ARG_COUNT)) {
    if (typeof arg !== "string" || arg.length > MAX_MCP_COMMAND_LENGTH) return null;
    args.push(arg);
  }
  const rawEnv = record["env"];
  let env: Record<string, string> | undefined;
  if (rawEnv !== undefined) {
    if (typeof rawEnv !== "object" || rawEnv === null || Array.isArray(rawEnv)) return null;
    env = {};
    for (const [key, envValue] of Object.entries(rawEnv).slice(0, MAX_MCP_ENV_COUNT)) {
      if (typeof envValue !== "string" || key.length === 0 || key.length > MAX_NAME_LENGTH) return null;
      env[key] = envValue;
    }
  }
  const enabledByDefault = record["enabledByDefault"];
  const sensitive = record["sensitive"];
  if (typeof enabledByDefault !== "boolean" || typeof sensitive !== "boolean") return null;
  return {
    ...(serverId === undefined ? {} : { serverId }),
    name,
    command,
    args,
    ...(env === undefined ? {} : { env }),
    enabledByDefault,
    sensitive,
    ...(notes === undefined ? {} : { notes })
  };
}

/** Like isBoundedString but admits the empty string (clear/blank semantics). */
function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

// --- Configure panel (P6) ---------------------------------------------------

/** `runtime.pathAdditions`, `security.cloneOnly`, `memory.tagRules`, … */
const CONFIG_SETTING_KEY_RE = /^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)*$/;
const MAX_CONFIG_LIST_ITEMS = 64;
const MAX_CONFIG_MAP_ENTRIES = 64;
const MAX_CONFIG_TAG_RULE_GLOBS = 32;

function isConfigSettingSection(value: unknown): value is ConfigSettingSection {
  return typeof value === "string" && (CONFIG_SETTING_SECTIONS as readonly string[]).includes(value);
}

/**
 * Validates a settings value into the closed set of JSON-safe shapes the
 * surfaced `drydock.*` settings use. Returns null for anything else - no
 * nested objects, no nulls, no numbers that would not survive a round trip.
 */
function parseConfigSettingValue(value: unknown): ConfigSettingValue | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value.length <= MAX_PATH_LENGTH ? value : null;
  if (Array.isArray(value)) {
    if (value.length > MAX_CONFIG_LIST_ITEMS) return null;
    if (value.every((entry) => typeof entry === "string")) {
      const items = value as string[];
      return items.every((entry) => entry.length <= MAX_PATH_LENGTH) ? items : null;
    }
    // The other accepted array is the memory tag-rule table.
    const rules: ConfigTagRuleInput[] = [];
    for (const entry of value) {
      const rule = parseConfigTagRule(entry);
      if (rule === null) return null;
      rules.push(rule);
    }
    return rules;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_CONFIG_MAP_ENTRIES) return null;
    const map: Record<string, string> = {};
    for (const [key, entryValue] of entries) {
      if (key.length === 0 || key.length > MAX_NAME_LENGTH) return null;
      if (typeof entryValue !== "string" || entryValue.length > MAX_PATH_LENGTH) return null;
      map[key] = entryValue;
    }
    return map;
  }
  return null;
}

function parseConfigTagRule(value: unknown): ConfigTagRuleInput | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const tag = record["tag"];
  if (!isBoundedString(tag, MAX_NAME_LENGTH)) return null;
  const globs = record["globs"];
  if (!Array.isArray(globs) || globs.length === 0 || globs.length > MAX_CONFIG_TAG_RULE_GLOBS) return null;
  for (const glob of globs) {
    if (!isBoundedString(glob, MAX_NAME_LENGTH)) return null;
  }
  return { globs: globs as string[], tag };
}

/**
 * Validates an array of bounded strings. `undefined` passes through for
 * optional fields; an empty array is valid; any bad entry rejects the whole
 * array (null).
 */
function parseBoundedStringArray(value: unknown, maxLength: number, maxItems: number): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const result: string[] = [];
  for (const entry of value) {
    if (!isBoundedString(entry, maxLength)) return null;
    result.push(entry);
  }
  return result;
}

function isPlanAnnotationStatus(value: unknown): value is PlanAnnotationStatus {
  return typeof value === "string" && (PLAN_ANNOTATION_STATUSES as readonly string[]).includes(value);
}

/** Aspect ids double as `plan/<aspectId>/` directory names, so they stay slugs. */
const PLAN_ASPECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function parsePlannerAspectSaveInput(value: unknown): PlannerAspectSaveInput | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const aspectId = record["aspectId"];
  if (aspectId !== undefined && (typeof aspectId !== "string" || !PLAN_ASPECT_ID_RE.test(aspectId))) return null;
  const label = record["label"];
  if (!isBoundedString(label, MAX_NAME_LENGTH)) return null;
  const instructions = record["instructions"];
  if (!isBoundedString(instructions, MAX_PROMPT_LENGTH)) return null;
  const expectedArtifacts = parseBoundedStringArray(record["expectedArtifacts"], MAX_NAME_LENGTH, 20);
  if (!Array.isArray(expectedArtifacts)) return null;
  return { ...(aspectId === undefined ? {} : { aspectId }), label, instructions, expectedArtifacts };
}

function isDiffViewMode(value: unknown): value is DiffViewMode {
  return value === "turn" || value === "session" || value === "full-session";
}
