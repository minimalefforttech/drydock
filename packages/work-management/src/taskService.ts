/**
 * Work-task service (chat-panel redesign, Phase 2; extended for the task board).
 *
 * Internal work tasks carry links to the workspace sets and chat sessions
 * where their work happens, plus a board columnId. Persistence lives in the
 * store; lifecycle and policy (column validation, link idempotency, summary
 * joins) live here. `state` is transitional (see WorkTaskRecord doc comment):
 * it is still accepted/derived for the webview until the board UI lands.
 */

import {
  WORK_TASK_STATES,
  asId
} from "@drydock/contracts";
import type {
  BoardColumnStore,
  ColumnCategory,
  ColumnId,
  SessionId,
  SubtaskId,
  SubtaskStore,
  TaskClonePolicy,
  TaskId,
  WorkSessionRecord,
  WorkSessionStore,
  WorkTaskLinkRecord,
  WorkTaskRecord,
  WorkTaskState,
  WorkTaskStore,
  WorkTaskSummary,
  WorkspaceSetRecord,
  WorkspaceSetStore,
  WorkspaceSetId
} from "@drydock/contracts";
import type { Clock, IdGenerator } from "@drydock/core";

export interface TaskServiceOptions {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly store: WorkTaskStore;
  readonly columns: BoardColumnStore;
  /** Presence enables work-session touch tracking and lastWorkedAt. */
  readonly workSessions?: WorkSessionStore;
  /** Presence enables cascading subtask deletion when a task is deleted. */
  readonly subtasks?: SubtaskStore;
  /** Presence enables validation and display of durable clone policies. */
  readonly workspaceSets?: WorkspaceSetStore;
}

/** One link target; exactly one field is set per call. subtaskId only applies alongside sessionId. */
export type TaskLinkTarget =
  | { readonly workspaceSetId: string }
  | { readonly sessionId: string; readonly subtaskId?: string };

export interface TaskUpdateInput {
  readonly title?: string;
  /** "" clears the description to null; a string overwrites it. */
  readonly description?: string;
  /**
   * transitional: still accepted from the pre-board-UI webview. Mapped to the
   * matching seeded default column (see STATE_TO_DEFAULT_COLUMN_ID); prefer
   * columnId for anything board-aware. Ignored when columnId is also given.
   */
  readonly state?: WorkTaskState;
  readonly columnId?: string;
}

export interface TaskClonePolicyInput {
  readonly workspaceSetId: string;
  readonly projectIds: readonly string[];
  readonly dirtyHandling: "carry" | "fresh";
}

/** Legacy WorkTaskState -> seeded default BoardColumnRecord.columnId (mirrors the migration backfill). */
const STATE_TO_DEFAULT_COLUMN_ID: Readonly<Record<WorkTaskState, string>> = {
  todo: "col-todo",
  "in-progress": "col-in-progress",
  blocked: "col-blocked",
  review: "col-review",
  done: "col-finished"
};

/** ColumnCategory -> legacy WorkTaskState fallback, used to derive `state` for any column (custom or default). */
const CATEGORY_TO_STATE: Readonly<Record<ColumnCategory, WorkTaskState>> = {
  backlog: "todo",
  pending: "todo",
  "in-progress": "in-progress",
  done: "done"
};

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
      columnId: asId<"ColumnId">(STATE_TO_DEFAULT_COLUMN_ID.todo),
      createdAt: now,
      updatedAt: now
    };
    await this.options.store.insertTask(record);
    return record;
  }

  async updateTask(taskId: string, input: TaskUpdateInput): Promise<WorkTaskRecord> {
    if (input.title === undefined && input.description === undefined && input.state === undefined && input.columnId === undefined) {
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
    // columnId wins when both are given; state (transitional) maps to its
    // matching seeded default column.
    const targetColumnId = input.columnId ?? (input.state === undefined ? undefined : STATE_TO_DEFAULT_COLUMN_ID[input.state]);
    let columnUpdate: { readonly columnId?: ColumnId; readonly doneAt?: string | null; readonly state?: WorkTaskState } = {};
    if (targetColumnId !== undefined) {
      const columnId = asId<"ColumnId">(targetColumnId);
      const column = await this.options.columns.getColumn(columnId);
      if (column === null) {
        throw new Error(`Column ${targetColumnId} was not found.`);
      }
      columnUpdate = {
        columnId,
        doneAt: column.category === "done" ? this.options.clock.isoNow() : null,
        state: CATEGORY_TO_STATE[column.category]
      };
    }
    await this.options.store.updateTask(id, {
      updatedAt: this.options.clock.isoNow(),
      ...(input.title === undefined ? {} : { title: input.title.trim() }),
      // "" clears the description; the store maps null to a NULL column.
      ...(input.description === undefined ? {} : { description: input.description === "" ? null : input.description }),
      ...columnUpdate
    });
    const updated = await this.options.store.getTask(id);
    if (updated === null) {
      throw new Error(`Task ${taskId} vanished during update.`);
    }
    return updated;
  }

  async deleteTask(taskId: string): Promise<void> {
    const id = asId<"TaskId">(taskId);
    // Subtasks (and their dependency edges) cascade before the task row itself
    // is removed, mirroring the "links first, then the task row" pattern used
    // for work_task_links.
    if (this.options.subtasks !== undefined) {
      for (const subtask of await this.options.subtasks.listForTask(id)) {
        await this.options.subtasks.deleteSubtask(subtask.subtaskId);
      }
    }
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
    const id = asId<"TaskId">(taskId);
    const record: WorkTaskLinkRecord = {
      taskId: id,
      ...resolveTarget(target),
      createdAt: this.options.clock.isoNow()
    };
    await this.options.store.insertLink(record);
    if ("workspaceSetId" in target) {
      await this.clearPolicyIfWorkspaceSelectionChanged(id);
    }
  }

  async unlink(taskId: string, target: TaskLinkTarget): Promise<void> {
    const id = asId<"TaskId">(taskId);
    await this.options.store.deleteLink(id, resolveTarget(target));
    if ("workspaceSetId" in target) {
      await this.clearPolicyIfWorkspaceSelectionChanged(id);
    }
  }

  /** Saves a validated, non-empty ordered project subset for the task's sole linked set. */
  async saveClonePolicy(taskId: string, input: TaskClonePolicyInput): Promise<TaskClonePolicy> {
    const id = asId<"TaskId">(taskId);
    const task = await this.options.store.getTask(id);
    if (task === null) {
      throw new Error(`Task ${taskId} was not found.`);
    }
    const policy: TaskClonePolicy = {
      workspaceSetId: asId<"WorkspaceSetId">(input.workspaceSetId),
      projectIds: input.projectIds.map((projectId) => asId<"ProjectId">(projectId)),
      dirtyHandling: input.dirtyHandling
    };
    await this.validateClonePolicy(id, policy);
    await this.options.store.setClonePolicy(id, policy);
    return policy;
  }

  /** Reads and revalidates the durable policy immediately before a run uses it. */
  async requireClonePolicy(taskId: string): Promise<TaskClonePolicy> {
    const id = asId<"TaskId">(taskId);
    const task = await this.options.store.getTask(id);
    if (task === null) {
      throw new Error(`Task ${taskId} was not found.`);
    }
    if (task.clonePolicy === undefined) {
      throw new Error(`Task ${taskId} has no clone policy. Start it manually once to select the repositories and dirty-change handling.`);
    }
    await this.validateClonePolicy(id, task.clonePolicy);
    return task.clonePolicy;
  }

  /** Session ids linked to one subtask (session-target links carrying that subtaskId), in link order. */
  listSessionIdsBySubtask(subtaskId: string): Promise<SessionId[]> {
    return this.options.store.listSessionIdsBySubtask(asId<"SubtaskId">(subtaskId));
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
   * `state` (transitional) is derived fresh from each task's columnId + that
   * column's category — not read off the stored column — so a card moved via
   * board.moveCard (which bypasses updateTask) still reports the right legacy
   * state to the pre-board-UI webview. Falls back to "todo" if the column is
   * missing (e.g. deleted out from under a stale reference).
   *
   * `subtasks` is intentionally empty here: the webview host provider joins
   * each task's subtasks (with the computed isBlocked, which needs the
   * SubtaskService's dependency projection) on top of these summaries — this
   * service reports only its own record's board fields (columnId/doneAt).
   */
  async listTaskSummaries(): Promise<WorkTaskSummary[]> {
    const tasks = await this.options.store.listTasks();
    const links = await this.options.store.listLinks();
    const columns = await this.options.columns.listColumns();
    const categoryByColumnId = new Map(columns.map((column) => [column.columnId as string, column.category]));
    const workspaceSetsByTask = new Map<string, string[]>();
    const sessionsByTask = new Map<string, string[]>();
    const linkedSetIdsByTask = new Map<string, Set<string>>();
    for (const link of links) {
      if (link.workspaceSetId !== undefined) {
        pushInto(workspaceSetsByTask, link.taskId, link.workspaceSetId);
        const setIds = linkedSetIdsByTask.get(link.taskId) ?? new Set<string>();
        setIds.add(link.workspaceSetId);
        linkedSetIdsByTask.set(link.taskId, setIds);
      }
      if (link.sessionId !== undefined) {
        pushInto(sessionsByTask, link.taskId, link.sessionId);
      }
    }
    const workspaceSetById = new Map<string, WorkspaceSetRecord>();
    if (this.options.workspaceSets !== undefined) {
      for (const set of await this.options.workspaceSets.listWorkspaceSets()) {
        workspaceSetById.set(set.workspaceSetId, set);
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
      const category = categoryByColumnId.get(task.columnId);
      const state = category === undefined ? "todo" : CATEGORY_TO_STATE[category];
      const clonePolicy = validSummaryClonePolicy(task.clonePolicy, linkedSetIdsByTask.get(task.taskId), workspaceSetById);
      return {
        taskId: task.taskId,
        title: task.title,
        ...(task.description === undefined ? {} : { description: task.description }),
        state,
        columnId: task.columnId,
        linkedWorkspaceSetIds: workspaceSetsByTask.get(task.taskId) ?? [],
        linkedSessionIds: sessionsByTask.get(task.taskId) ?? [],
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        ...(task.doneAt === undefined ? {} : { doneAt: task.doneAt }),
        ...(lastWorkedAt === undefined ? {} : { lastWorkedAt }),
        ...(clonePolicy === undefined ? {} : { clonePolicy }),
        subtasks: []
      };
    });
  }

  private async validateClonePolicy(taskId: TaskId, policy: TaskClonePolicy): Promise<WorkspaceSetRecord> {
    const workspaceSets = this.options.workspaceSets;
    if (workspaceSets === undefined) {
      throw new Error("Task clone policies are unavailable because no workspace-set store is configured.");
    }
    if (policy.dirtyHandling !== "carry" && policy.dirtyHandling !== "fresh") {
      throw new Error(`Unknown clone dirty handling ${String(policy.dirtyHandling)}.`);
    }
    if (policy.projectIds.length === 0) {
      throw new Error("A task clone policy must select at least one project.");
    }
    const selected = new Set<string>();
    for (const projectId of policy.projectIds) {
      if (selected.has(projectId)) {
        throw new Error(`Project ${projectId} is selected more than once in the task clone policy.`);
      }
      selected.add(projectId);
    }
    const links = await this.options.store.listLinks(taskId);
    const linkedSetIds = [...new Set(links.flatMap((link) => link.workspaceSetId === undefined ? [] : [link.workspaceSetId as string]))];
    if (linkedSetIds.length !== 1) {
      throw new Error(`Task ${taskId} must link exactly one workspace set before it can start an isolated clone run; found ${String(linkedSetIds.length)}.`);
    }
    if (linkedSetIds[0] !== policy.workspaceSetId) {
      throw new Error(`Task ${taskId}'s clone policy selects workspace set ${policy.workspaceSetId}, but its linked set is ${linkedSetIds[0]}.`);
    }
    const set = await workspaceSets.getWorkspaceSet(policy.workspaceSetId);
    if (set === null) {
      throw new Error(`Task ${taskId}'s clone policy references missing workspace set ${policy.workspaceSetId}.`);
    }
    const memberIds = new Set(set.projectIds as readonly string[]);
    for (const projectId of policy.projectIds) {
      if (!memberIds.has(projectId)) {
        throw new Error(`Task ${taskId}'s clone policy selects project ${projectId}, which is not in workspace set ${policy.workspaceSetId}.`);
      }
    }
    return set;
  }

  private async clearPolicyIfWorkspaceSelectionChanged(taskId: TaskId): Promise<void> {
    const task = await this.options.store.getTask(taskId);
    if (task?.clonePolicy === undefined) return;
    const links = await this.options.store.listLinks(taskId);
    const setIds = [...new Set(links.flatMap((link) => link.workspaceSetId === undefined ? [] : [link.workspaceSetId as string]))];
    if (setIds.length !== 1 || setIds[0] !== task.clonePolicy.workspaceSetId) {
      await this.options.store.setClonePolicy(taskId, undefined);
    }
  }
}

function validSummaryClonePolicy(
  policy: TaskClonePolicy | undefined,
  linkedSetIds: ReadonlySet<string> | undefined,
  workspaceSetById: ReadonlyMap<string, WorkspaceSetRecord>
): (TaskClonePolicy & { readonly workspaceSetProjectCount: number }) | undefined {
  if (policy === undefined || linkedSetIds?.size !== 1 || !linkedSetIds.has(policy.workspaceSetId) || policy.projectIds.length === 0) {
    return undefined;
  }
  const set = workspaceSetById.get(policy.workspaceSetId);
  if (set === undefined) return undefined;
  const memberIds = new Set(set.projectIds as readonly string[]);
  const selected = new Set<string>();
  for (const projectId of policy.projectIds) {
    if (!memberIds.has(projectId) || selected.has(projectId)) return undefined;
    selected.add(projectId);
  }
  return { ...policy, workspaceSetProjectCount: set.projectIds.length };
}

function resolveTarget(target: TaskLinkTarget): { workspaceSetId?: WorkspaceSetId; sessionId?: SessionId; subtaskId?: SubtaskId } {
  if ("workspaceSetId" in target) {
    return { workspaceSetId: asId<"WorkspaceSetId">(target.workspaceSetId) };
  }
  return {
    sessionId: asId<"SessionId">(target.sessionId),
    ...(target.subtaskId === undefined ? {} : { subtaskId: asId<"SubtaskId">(target.subtaskId) })
  };
}

function pushInto(map: Map<string, string[]>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, [value]);
  } else {
    existing.push(value);
  }
}
