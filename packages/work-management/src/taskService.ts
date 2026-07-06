/**
 * Work-task service (chat-panel redesign, Phase 2).
 *
 * Internal work tasks carry a state machine and links to the workspace sets
 * and chat sessions where their work happens. Persistence lives in the store;
 * lifecycle and policy (state validation, link idempotency, summary joins)
 * live here.
 */

import {
  WORK_TASK_STATES,
  asId
} from "@drydock/contracts";
import type {
  SessionId,
  TaskId,
  WorkSessionRecord,
  WorkSessionStore,
  WorkTaskLinkRecord,
  WorkTaskRecord,
  WorkTaskState,
  WorkTaskStore,
  WorkTaskSummary,
  WorkspaceSetId
} from "@drydock/contracts";
import type { Clock, IdGenerator } from "@drydock/core";

export interface TaskServiceOptions {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly store: WorkTaskStore;
  /** Presence enables work-session touch tracking and lastWorkedAt. */
  readonly workSessions?: WorkSessionStore;
}

/** One link target; exactly one field is set per call. */
export type TaskLinkTarget = { readonly workspaceSetId: string } | { readonly sessionId: string };

export interface TaskUpdateInput {
  readonly title?: string;
  /** "" clears the description to null; a string overwrites it. */
  readonly description?: string;
  readonly state?: WorkTaskState;
}

export class TaskService {
  constructor(private readonly options: TaskServiceOptions) {}

  async createTask(title: string, description?: string): Promise<WorkTaskRecord> {
    if (title.trim() === "") {
      throw new Error("Task title must not be empty.");
    }
    const now = this.options.clock.isoNow();
    const record: WorkTaskRecord = {
      taskId: this.options.ids.taskId(),
      title: title.trim(),
      ...(description === undefined ? {} : { description }),
      state: "todo",
      createdAt: now,
      updatedAt: now
    };
    await this.options.store.insertTask(record);
    return record;
  }

  async updateTask(taskId: string, input: TaskUpdateInput): Promise<WorkTaskRecord> {
    if (input.title === undefined && input.description === undefined && input.state === undefined) {
      throw new Error("Task update must change at least one field.");
    }
    if (input.title !== undefined && input.title.trim() === "") {
      throw new Error("Task title must not be empty.");
    }
    if (input.state !== undefined && !WORK_TASK_STATES.includes(input.state)) {
      throw new Error(`Unknown task state ${input.state}.`);
    }
    const id = asId<"TaskId">(taskId);
    const existing = await this.options.store.getTask(id);
    if (existing === null) {
      throw new Error(`Task ${taskId} was not found.`);
    }
    await this.options.store.updateTask(id, {
      updatedAt: this.options.clock.isoNow(),
      ...(input.title === undefined ? {} : { title: input.title.trim() }),
      // "" clears the description; the store maps null to a NULL column.
      ...(input.description === undefined ? {} : { description: input.description === "" ? null : input.description }),
      ...(input.state === undefined ? {} : { state: input.state })
    });
    const updated = await this.options.store.getTask(id);
    if (updated === null) {
      throw new Error(`Task ${taskId} vanished during update.`);
    }
    return updated;
  }

  async deleteTask(taskId: string): Promise<void> {
    const id = asId<"TaskId">(taskId);
    await this.options.store.deleteTask(id);
    // Work sessions live in a separate store with no FK cascade; drop them here
    // so a deleted task leaves no orphaned touch history.
    if (this.options.workSessions !== undefined) {
      await this.options.workSessions.deleteForTask(id);
    }
  }

  /**
   * Touches the work session for every task linked to this chat session:
   * created on the first activity, then bumped on each subsequent turn.
   * startedAt is preserved from any existing row; lastActivityAt advances to
   * `at` and turnCount increments. workspaceSetId is set only when the task
   * links to EXACTLY one workspace set (an unambiguous "where"); otherwise it
   * stays undefined. A no-op when no work-session store is configured.
   */
  async recordSessionActivity(sessionId: string, at: string): Promise<void> {
    const workSessions = this.options.workSessions;
    if (workSessions === undefined) {
      return;
    }
    const session = asId<"SessionId">(sessionId);
    const links = await this.options.store.listLinks();
    const tasksForSession = new Set<TaskId>();
    const setsByTask = new Map<TaskId, Set<WorkspaceSetId>>();
    for (const link of links) {
      if (link.sessionId === session) {
        tasksForSession.add(link.taskId);
      }
      if (link.workspaceSetId !== undefined) {
        const existing = setsByTask.get(link.taskId);
        if (existing === undefined) {
          setsByTask.set(link.taskId, new Set([link.workspaceSetId]));
        } else {
          existing.add(link.workspaceSetId);
        }
      }
    }
    for (const taskId of tasksForSession) {
      const existing = await workSessions.getWorkSession(taskId, session);
      const sets = setsByTask.get(taskId);
      const soleSet = sets !== undefined && sets.size === 1 ? [...sets][0] : undefined;
      const record: WorkSessionRecord = {
        taskId,
        sessionId: session,
        ...(soleSet === undefined ? {} : { workspaceSetId: soleSet }),
        startedAt: existing?.startedAt ?? at,
        lastActivityAt: at,
        turnCount: (existing?.turnCount ?? 0) + 1
      };
      await workSessions.upsertWorkSession(record);
    }
  }

  /** Idempotent: a duplicate link is a no-op via the store's INSERT OR IGNORE. */
  async link(taskId: string, target: TaskLinkTarget): Promise<void> {
    const record: WorkTaskLinkRecord = {
      taskId: asId<"TaskId">(taskId),
      ...resolveTarget(target),
      createdAt: this.options.clock.isoNow()
    };
    await this.options.store.insertLink(record);
  }

  async unlink(taskId: string, target: TaskLinkTarget): Promise<void> {
    await this.options.store.deleteLink(asId<"TaskId">(taskId), resolveTarget(target));
  }

  getTask(taskId: string): Promise<WorkTaskRecord | null> {
    return this.options.store.getTask(asId<"TaskId">(taskId));
  }

  listTasks(): Promise<WorkTaskRecord[]> {
    return this.options.store.listTasks();
  }

  /**
   * Newest-first summaries; links grouped in memory from one listLinks() call.
   * lastWorkedAt is the max lastActivityAt across the task's work sessions,
   * derived from ONE listWorkSessions() call and grouped in memory; absent when
   * the task has never been worked (or no work-session store is configured).
   */
  async listTaskSummaries(): Promise<WorkTaskSummary[]> {
    const tasks = await this.options.store.listTasks();
    const links = await this.options.store.listLinks();
    const workspaceSetsByTask = new Map<string, string[]>();
    const sessionsByTask = new Map<string, string[]>();
    for (const link of links) {
      if (link.workspaceSetId !== undefined) {
        pushInto(workspaceSetsByTask, link.taskId, link.workspaceSetId);
      }
      if (link.sessionId !== undefined) {
        pushInto(sessionsByTask, link.taskId, link.sessionId);
      }
    }
    const lastWorkedByTask = new Map<string, string>();
    if (this.options.workSessions !== undefined) {
      for (const workSession of await this.options.workSessions.listWorkSessions()) {
        const current = lastWorkedByTask.get(workSession.taskId);
        if (current === undefined || current < workSession.lastActivityAt) {
          lastWorkedByTask.set(workSession.taskId, workSession.lastActivityAt);
        }
      }
    }
    return tasks.map((task) => {
      const lastWorkedAt = lastWorkedByTask.get(task.taskId);
      return {
        taskId: task.taskId,
        title: task.title,
        ...(task.description === undefined ? {} : { description: task.description }),
        state: task.state,
        linkedWorkspaceSetIds: workspaceSetsByTask.get(task.taskId) ?? [],
        linkedSessionIds: sessionsByTask.get(task.taskId) ?? [],
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        ...(lastWorkedAt === undefined ? {} : { lastWorkedAt })
      };
    });
  }
}

function resolveTarget(target: TaskLinkTarget): { workspaceSetId?: WorkspaceSetId; sessionId?: SessionId } {
  return "workspaceSetId" in target
    ? { workspaceSetId: asId<"WorkspaceSetId">(target.workspaceSetId) }
    : { sessionId: asId<"SessionId">(target.sessionId) };
}

function pushInto(map: Map<string, string[]>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, [value]);
  } else {
    existing.push(value);
  }
}
