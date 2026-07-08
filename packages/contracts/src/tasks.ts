/**
 * Internal work-task contracts (chat panel redesign, Phase 2).
 *
 * The internal provider slice of docs/design/work-management.md: durable
 * tasks with a state machine and links to workspace sets and chat sessions.
 * External providers (Jira/Asana/GitHub) sync through this same shape later;
 * day plans and work sessions stay future scope. Stores own persistence; the
 * TaskService in @drydock/work-management owns lifecycle and policy.
 */

import type { ColumnId, SessionId, SubtaskId, TaskId, WorkspaceSetId } from "./ids.js";

export const WORK_TASK_STATES = ["todo", "in-progress", "blocked", "review", "done"] as const;
export type WorkTaskState = (typeof WORK_TASK_STATES)[number];

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
  readonly updatedAt: string;
}

export const COLUMN_CATEGORIES = ["backlog", "pending", "in-progress", "done"] as const;
export type ColumnCategory = (typeof COLUMN_CATEGORIES)[number];

export interface BoardColumnRecord {
  readonly columnId: ColumnId;
  /** "Review" — cosmetic, user-editable. */
  readonly name: string;
  /** Drives every behaviour rule; column names never do. */
  readonly category: ColumnCategory;
  readonly sortOrder: number;
}

export interface SubtaskRecord {
  readonly subtaskId: SubtaskId;
  /** Owning task — dependencies never leave it. */
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
