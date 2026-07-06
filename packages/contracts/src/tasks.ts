/**
 * Internal work-task contracts (chat panel redesign, Phase 2).
 *
 * The internal provider slice of docs/design/work-management.md: durable
 * tasks with a state machine and links to workspace sets and chat sessions.
 * External providers (Jira/Asana/GitHub) sync through this same shape later;
 * day plans and work sessions stay future scope. Stores own persistence; the
 * TaskService in @drydock/work-management owns lifecycle and policy.
 */

import type { SessionId, TaskId, WorkspaceSetId } from "./ids.js";

export const WORK_TASK_STATES = ["todo", "in-progress", "blocked", "review", "done"] as const;
export type WorkTaskState = (typeof WORK_TASK_STATES)[number];

export interface WorkTaskRecord {
  readonly taskId: TaskId;
  readonly title: string;
  /** Free-form notes; the one-stop context the engineer leaves for themselves. */
  readonly description?: string;
  readonly state: WorkTaskState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A task points at the places its work happens. Exactly one target per link. */
export interface WorkTaskLinkRecord {
  readonly taskId: TaskId;
  readonly workspaceSetId?: WorkspaceSetId;
  readonly sessionId?: SessionId;
  readonly createdAt: string;
}

export interface WorkTaskUpdate {
  readonly title?: string;
  /** null clears the description. */
  readonly description?: string | null;
  readonly state?: WorkTaskState;
  readonly updatedAt: string;
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
}
