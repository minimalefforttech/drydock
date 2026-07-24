/**
 * Internal work-task contracts (chat panel redesign, Phase 2).
 *
 * The internal provider slice of docs/design/work-management.md: durable
 * tasks with a state machine and links to workspace sets and chat sessions.
 * External providers (Jira/Asana/GitHub) sync through this same shape later;
 * day plans and work sessions stay future scope. Stores own persistence; the
 * TaskService in @drydock/work-management owns lifecycle and policy.
 */

import type { ColumnId, ProjectId, SessionId, SubtaskId, TaskId, WorkspaceSetId } from "./ids.js";

export const WORK_TASK_STATES = ["todo", "in-progress", "blocked", "review", "done"] as const;
export type WorkTaskState = (typeof WORK_TASK_STATES)[number];

/** What snapshot a task's isolated clone starts from when its source repo is dirty. */
export type CloneDirtyHandling = "carry" | "fresh";

/**
 * Queue lane (ADR 0015 extension): background runs draw from a bounded
 * sub-budget of the run slots and queue behind normal-lane work. Unset means
 * `normal`. Lanes never change access - only scheduling order.
 */
export type TaskLane = "normal" | "background";

/**
 * How finished work returns to the developer. `patch` is the classic ADR 0014
 * changeset/pull flow. `branch` lands the clone's commits as a local branch
 * named by the user (ref-only write; no checkout, no push).
 */
export type TaskHandoffMode = "patch" | "branch";

/**
 * `plan-first` prepends a planner stage whose downstream subtasks carry a
 * `plan-approval` gate - implementation waits for an explicit human approval
 * of the plan (ADR 0016 family). Unset means `implement`.
 */
export type TaskApproach = "implement" | "plan-first";

/**
 * Human gates a subtask can carry beyond the HITL verify stamp: the subtask
 * is never auto-start eligible until the gate is satisfied by a person.
 */
export type SubtaskGate = "plan-approval";

/**
 * Durable isolation policy for automated work on a task. One workspace set is
 * selected explicitly; projectIds is a non-empty, ordered subset of that set.
 */
export interface TaskClonePolicy {
  readonly workspaceSetId: WorkspaceSetId;
  readonly projectIds: readonly ProjectId[];
  readonly dirtyHandling: CloneDirtyHandling;
}

export interface WorkTaskRecord {
  readonly taskId: TaskId;
  readonly title: string;
  /** Free-form notes; the one-stop context the engineer leaves for themselves. */
  readonly description?: string;
  /**
   * transitional: replaced by columnId; removed when the board UI lands.
   * The webview still reads/writes this flat state; keep it in sync via the
   * category/default-column mapping in TaskService until that phase.
   */
  readonly state: WorkTaskState;
  readonly columnId: ColumnId;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Stamped when the card enters a `done`-category column; cleared on exit. */
  readonly doneAt?: string;
  /** Saved clone selection reused by manual starts and dependency cascades. */
  readonly clonePolicy?: TaskClonePolicy;
  /** ADR 0007: agent questions matching this task's FAQ auto-answer (also gated by global config). */
  readonly autoAnswerFaq?: boolean;
  /** Queue lane; unset = normal. */
  readonly lane?: TaskLane;
  /** How finished work returns; unset = patch. */
  readonly handoffMode?: TaskHandoffMode;
  /**
   * Branch handoff target - the user's own name, typically the ticket key
   * ("PIPE-123"). No product prefix is ever forced onto it.
   */
  readonly branchName?: string;
  /** The branch actually created at landing when branchName collided ("PIPE-123_1"). */
  readonly landedBranch?: string;
  /** plan-first gates implementation behind human plan approval; unset = implement. */
  readonly approach?: TaskApproach;
}

/** A task points at the places its work happens. Exactly one target per link. */
export interface WorkTaskLinkRecord {
  readonly taskId: TaskId;
  readonly workspaceSetId?: WorkspaceSetId;
  readonly sessionId?: SessionId;
  /** Only valid alongside sessionId: the subtask this session-link belongs to. */
  readonly subtaskId?: SubtaskId;
  readonly createdAt: string;
}

export interface WorkTaskUpdate {
  readonly title?: string;
  /** null clears the description. */
  readonly description?: string | null;
  readonly state?: WorkTaskState;
  readonly columnId?: ColumnId;
  /** null clears doneAt. */
  readonly doneAt?: string | null;
  readonly autoAnswerFaq?: boolean;
  readonly lane?: TaskLane;
  readonly handoffMode?: TaskHandoffMode;
  /** null clears the branch name (reverts the task to patch-only landing). */
  readonly branchName?: string | null;
  /** null clears the landed-branch badge. */
  readonly landedBranch?: string | null;
  readonly approach?: TaskApproach;
  readonly updatedAt: string;
}

/**
 * One task FAQ entry (ADR 0007): when the task's auto-answer toggle (and the
 * global config) is on, an incoming agent question containing `pattern`
 * (case-insensitive) is answered automatically with `answer` - with a
 * transcript receipt, and never for access requests.
 */
export interface TaskFaqRecord {
  readonly faqId: string;
  readonly taskId: TaskId;
  readonly pattern: string;
  readonly answer: string;
  readonly createdAt: string;
}

export interface TaskFaqStore {
  insertFaq(record: TaskFaqRecord): Promise<void>;
  /** Scoped by taskId so a stale webview id can never cross task boundaries. */
  deleteFaq(taskId: TaskId, faqId: string): Promise<number>;
  /** Insertion order. */
  listForTask(taskId: TaskId): Promise<TaskFaqRecord[]>;
  countByTask(): Promise<Map<string, number>>;
}

/**
 * ADR 0015: a durable orchestrator hold. `queued` = a start waiting for a
 * run slot; `parked` = automation gave up after two failures.
 * One row per subtask (a park replaces a queue). Survives window reloads so
 * intent is never silently dropped.
 */
export interface SubtaskHoldRecord {
  readonly subtaskId: SubtaskId;
  readonly kind: "queued" | "parked";
  readonly origin: "manual" | "auto";
  readonly force: boolean;
  /** Queue band the entry restores into; absent (older rows) = normal. */
  readonly lane?: TaskLane;
  readonly heldAt: string;
}

export interface SubtaskHoldStore {
  upsertHold(record: SubtaskHoldRecord): Promise<void>;
  deleteHold(subtaskId: SubtaskId): Promise<number>;
  /** Oldest hold first, so a restored queue keeps its arrival order. */
  listHolds(): Promise<SubtaskHoldRecord[]>;
}

export const COLUMN_CATEGORIES = ["backlog", "pending", "in-progress", "done"] as const;
export type ColumnCategory = (typeof COLUMN_CATEGORIES)[number];

export interface BoardColumnRecord {
  readonly columnId: ColumnId;
  /** "Review" - cosmetic, user-editable. */
  readonly name: string;
  /** Drives every behaviour rule; column names never do. */
  readonly category: ColumnCategory;
  readonly sortOrder: number;
}

/**
 * How a dependent subtask's clone seeds at start (ADR 0014). `local` clones
 * the developer's current local HEAD (classic behavior); `upstream`
 * additionally applies its upstream subtasks' unlanded changesets 3-way.
 * Unset means `local` - the user chooses, automation never invents one.
 */
export type SubtaskSeedMode = "local" | "upstream";

/**
 * Per-subtask model profile (ADR 0002), set by recipes at materialization.
 * Structural twin of webviewMessages.ChatModelSelection - tasks.ts cannot
 * import it without a cycle (webviewMessages imports tasks).
 */
export interface SubtaskModelSelection {
  readonly providerId: string;
  readonly model?: string;
}

export interface SubtaskRecord {
  readonly subtaskId: SubtaskId;
  /** Owning task - dependencies never leave it. */
  readonly taskId: TaskId;
  readonly title: string;
  readonly description?: string;
  /** Present implies startable / auto-startable. */
  readonly prompt?: string;
  readonly origin: "manual" | "review";
  /** opt-in cascade: start when dependencies finish (default false). */
  readonly autoStart: boolean;
  readonly columnId: ColumnId;
  readonly sortOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly doneAt?: string;
  /** 0-7 palette index overriding the parent task's stripe hue; undefined uses the task hue. */
  readonly colorOverride?: number;
  /** Clone seeding choice (ADR 0014); unset = `local`. */
  readonly seedMode?: SubtaskSeedMode;
  /** Per-role model profile (ADR 0002); unset = the provider default. */
  readonly model?: SubtaskModelSelection;
  /** ADR 0007: human-in-the-loop verification gate. `hitl` = a person must mark it verified after Review entry. */
  readonly verifyMode?: "hitl";
  /** Stamped by "Mark verified"; cleared when the gate re-arms. */
  readonly verifiedAt?: string;
  /**
   * 1-based position in the task's stage chain (background-lane plan D4).
   * Present = this subtask is a stage: it advances the task branch on
   * completion and the next stage clones from the branch tip.
   */
  readonly stageIndex?: number;
  /** Human gate blocking auto-start eligibility until satisfied (ADR 0016 family). */
  readonly gate?: SubtaskGate;
  /** Stamped when a person satisfies the gate; cleared if the gate re-arms. */
  readonly gateSatisfiedAt?: string;
  /**
   * Stage branch advance refused to fast-forward (BRANCH_DRIFTED): the chain
   * is parked until a person reconciles the branch and retries the land.
   * Cleared by the next successful advance.
   */
  readonly branchDriftAt?: string;
}

export interface SubtaskUpdate {
  readonly title?: string;
  /** null clears the description. */
  readonly description?: string | null;
  /** null clears the prompt. */
  readonly prompt?: string | null;
  readonly autoStart?: boolean;
  readonly columnId?: ColumnId;
  readonly sortOrder?: number;
  /** null clears doneAt. */
  readonly doneAt?: string | null;
  /** null reverts to the parent task's stripe hue; a number (0-7) sets an override. */
  readonly colorOverride?: number | null;
  readonly seedMode?: SubtaskSeedMode;
  /** null clears the verification stamp (re-arms the gate); a string stamps it. */
  readonly verifiedAt?: string | null;
  /** null removes the subtask from the stage chain. */
  readonly stageIndex?: number | null;
  /** null removes the gate. */
  readonly gate?: SubtaskGate | null;
  /** null re-arms the gate; a string satisfies it. */
  readonly gateSatisfiedAt?: string | null;
  /** null clears the drift park; a string stamps it. */
  readonly branchDriftAt?: string | null;
  readonly updatedAt: string;
}

export interface SubtaskDependencyRecord {
  /** Denormalised guard: both endpoints are in this task. */
  readonly taskId: TaskId;
  /** Upstream (output dot). */
  readonly fromSubtaskId: SubtaskId;
  /** Downstream (input dot). */
  readonly toSubtaskId: SubtaskId;
  readonly createdAt: string;
}

/**
 * One (task, session) work pairing: created the first time a linked session
 * completes a turn, then touched on every subsequent turn. Powers the task's
 * lastWorkedAt and the project touch-history view ("recently worked by…").
 */
export interface WorkSessionRecord {
  readonly taskId: TaskId;
  readonly sessionId: SessionId;
  readonly workspaceSetId?: WorkspaceSetId;
  readonly startedAt: string;
  readonly lastActivityAt: string;
  readonly turnCount: number;
}

export interface WorkSessionStore {
  /** Insert-or-replace keyed on (taskId, sessionId). */
  upsertWorkSession(record: WorkSessionRecord): Promise<void>;
  getWorkSession(taskId: TaskId, sessionId: SessionId): Promise<WorkSessionRecord | null>;
  /** Newest activity first. */
  listWorkSessions(filter?: { taskId?: TaskId; workspaceSetId?: WorkspaceSetId }): Promise<WorkSessionRecord[]>;
  deleteForTask(taskId: TaskId): Promise<number>;
  deleteForSession(sessionId: SessionId): Promise<number>;
}

export interface WorkTaskStore {
  insertTask(record: WorkTaskRecord): Promise<void>;
  updateTask(taskId: TaskId, update: WorkTaskUpdate): Promise<void>;
  getTask(taskId: TaskId): Promise<WorkTaskRecord | null>;
  /** Newest-first by updatedAt. */
  listTasks(): Promise<WorkTaskRecord[]>;
  /** Replaces or clears the task's durable clone policy. */
  setClonePolicy(taskId: TaskId, policy: TaskClonePolicy | undefined): Promise<void>;
  /** Removes the task and all of its links. */
  deleteTask(taskId: TaskId): Promise<void>;
  insertLink(record: WorkTaskLinkRecord): Promise<void>;
  deleteLink(taskId: TaskId, target: { workspaceSetId?: WorkspaceSetId; sessionId?: SessionId }): Promise<void>;
  listLinks(taskId?: TaskId): Promise<WorkTaskLinkRecord[]>;
  /** Session ids linked to a specific subtask (session-target links only), in link order. */
  listSessionIdsBySubtask(subtaskId: SubtaskId): Promise<SessionId[]>;
  /** Bulk-reassigns every task currently on fromColumnId to toColumnId (column deletion). */
  reassignTasksColumn(fromColumnId: ColumnId, toColumnId: ColumnId): Promise<void>;
}

export interface BoardColumnStore {
  /** Ordered by sortOrder ascending. */
  listColumns(): Promise<BoardColumnRecord[]>;
  getColumn(columnId: ColumnId): Promise<BoardColumnRecord | null>;
  insertColumn(record: BoardColumnRecord): Promise<void>;
  /** Only name/category/sortOrder are mutable; columnId is the key. */
  updateColumn(columnId: ColumnId, update: { readonly name?: string; readonly category?: ColumnCategory; readonly sortOrder?: number }): Promise<void>;
  deleteColumn(columnId: ColumnId): Promise<void>;
}

/**
 * One step of a task recipe (ADR 0007): materializes into a subtask. Keys
 * are recipe-local names the DAG edges reference; `{title}` inside the
 * prompt is replaced with the created task's title.
 */
export interface TaskRecipeSubtask {
  readonly key: string;
  readonly title: string;
  readonly prompt?: string;
  readonly autoStart: boolean;
  readonly seedMode?: SubtaskSeedMode;
  readonly dependsOnKeys: readonly string[];
  readonly model?: SubtaskModelSelection;
  /** ADR 0007: recipes can arm the human verification gate per step. */
  readonly verify?: "hitl";
  /** 1-based stage-chain position this step materializes with. */
  readonly stageIndex?: number;
  /** Human gate the materialized subtask carries (plan-first recipes). */
  readonly gate?: SubtaskGate;
}

/**
 * A task template (ADR 0007): one click creates the task, its subtasks,
 * their dependency DAG, and per-role defaults - and never starts anything.
 * `seeded` rows ship with the product; `overlay` rows merge read-only from
 * the workspace's `.drydock/recipes.json` (the planner-aspects pattern).
 */
export interface TaskRecipeRecord {
  readonly recipeId: string;
  readonly name: string;
  readonly description?: string;
  readonly source: "user" | "seeded" | "overlay";
  readonly archived: boolean;
  readonly subtasks: readonly TaskRecipeSubtask[];
  /** Ticket defaults this recipe pre-fills (the form still overrides them). */
  readonly lane?: TaskLane;
  readonly handoffMode?: TaskHandoffMode;
  readonly approach?: TaskApproach;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskRecipeStore {
  /** Non-archived first by name; archived excluded unless includeArchived. */
  listRecipes(includeArchived?: boolean): Promise<TaskRecipeRecord[]>;
  getRecipe(recipeId: string): Promise<TaskRecipeRecord | null>;
  insertRecipe(record: TaskRecipeRecord): Promise<void>;
  setArchived(recipeId: string, archived: boolean, updatedAt: string): Promise<void>;
}

/**
 * A durable outbound patch captured from a subtask's clone when its card
 * enters a done-category column (Review entry, ADR 0014). One row per
 * (subtask, repo); a fresh capture replaces the subtask's previous set.
 * Patch bytes live in the content-addressed blob store, keyed by sha256.
 */
export interface TaskChangesetRecord {
  readonly changesetId: string;
  readonly taskId: TaskId;
  readonly subtaskId: SubtaskId;
  /** Session whose clone produced the patch - landing is keyed off it. */
  readonly sessionId: SessionId;
  /** Clone repo folder name; dependents match seeds to their clones by it. */
  readonly repoName: string;
  readonly patchSha256: string;
  readonly patchBytes: number;
  readonly fileCount: number;
  /** Repo-relative touched paths - the landing overlap pre-check (ADR 0014). Absent on older captures. */
  readonly paths?: readonly string[];
  /**
   * The local commit the clone was cut from (refs/sync/origin). Lets an
   * inspection workspace rebuild the finished tree from durable data alone.
   * Absent on captures made before inspection support landed.
   */
  readonly originCommit?: string;
  /** The refs/sync/base commit the relative patch applies onto. Absent on older captures. */
  readonly baseCommit?: string;
  /**
   * Blob sha of `git diff --binary refs/sync/origin..HEAD`, stored ONLY when
   * the base tree differs from the origin tree (upstream seeds or mid-flight
   * syncs moved it) - i.e. when the relative patch alone cannot rebuild the
   * finished tree from originCommit.
   */
  readonly fullPatchSha256?: string;
  readonly fullPatchBytes?: number;
  readonly capturedAt: string;
  /** Stamped when the user pulls this session's work into the local repo. */
  readonly landedAt?: string;
}

/**
 * A bounded handoff note passed from a finished stage to whatever depends on
 * it (plan D4). One row per producing subtask - a fresh completion replaces
 * it. `agent` notes come from a ```handoff fenced block in the worker's
 * final text; `summary` notes are host-built fallbacks from the capture.
 */
export interface SubtaskHandoffRecord {
  readonly subtaskId: SubtaskId;
  readonly taskId: TaskId;
  readonly note: string;
  readonly source: "agent" | "summary";
  readonly createdAt: string;
}

export interface SubtaskHandoffStore {
  /** Insert-or-replace keyed on subtaskId (latest completion wins). */
  upsertHandoff(record: SubtaskHandoffRecord): Promise<void>;
  getHandoff(subtaskId: SubtaskId): Promise<SubtaskHandoffRecord | null>;
  /** Rows for these subtasks, in the given id order. */
  listForSubtasks(subtaskIds: readonly SubtaskId[]): Promise<SubtaskHandoffRecord[]>;
  deleteForSubtask(subtaskId: SubtaskId): Promise<number>;
}

export interface TaskChangesetStore {
  /** Replaces the subtask's previous capture set (latest capture wins). */
  replaceForSubtask(subtaskId: SubtaskId, records: readonly TaskChangesetRecord[]): Promise<void>;
  /** Every stored row for these subtasks (their latest capture sets). */
  listForSubtasks(subtaskIds: readonly SubtaskId[]): Promise<TaskChangesetRecord[]>;
  /** Subtask ids among the given set that hold at least one unlanded row. */
  listUnlandedSubtaskIds(subtaskIds: readonly SubtaskId[]): Promise<SubtaskId[]>;
  /** Every unlanded row across every subtask - the landing queue view (ADR 0014). */
  listUnlanded(): Promise<TaskChangesetRecord[]>;
  /** Marks rows landed for a session's pull; repoName narrows to one repo. */
  markLandedBySession(sessionId: SessionId, landedAt: string, repoName?: string): Promise<number>;
  deleteForSubtask(subtaskId: SubtaskId): Promise<number>;
}

export interface SubtaskStore {
  insertSubtask(record: SubtaskRecord): Promise<void>;
  updateSubtask(subtaskId: SubtaskId, update: SubtaskUpdate): Promise<void>;
  getSubtask(subtaskId: SubtaskId): Promise<SubtaskRecord | null>;
  /** Ordered by sortOrder ascending for one task. */
  listForTask(taskId: TaskId): Promise<SubtaskRecord[]>;
  /** Every subtask across every task; used for cross-task board views. */
  listAll(): Promise<SubtaskRecord[]>;
  /** Removes the subtask and its dependency edges (both directions). */
  deleteSubtask(subtaskId: SubtaskId): Promise<void>;
  /** Bulk-reassigns every subtask currently on fromColumnId to toColumnId (column deletion). */
  reassignSubtasksColumn(fromColumnId: ColumnId, toColumnId: ColumnId): Promise<void>;
  insertDependency(record: SubtaskDependencyRecord): Promise<void>;
  removeDependency(fromSubtaskId: SubtaskId, toSubtaskId: SubtaskId): Promise<void>;
  /** All edges touching this task, in insertion order. */
  listDependenciesForTask(taskId: TaskId): Promise<SubtaskDependencyRecord[]>;
}
