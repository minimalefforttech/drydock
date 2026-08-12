/**
 * Pure projections behind the left rail's host handlers (UX overhaul, P1).
 *
 * Kept free of vscode and of every backend service so the rules that decide
 * what the rail shows - one Recents row per task, and which live work blocks a
 * workspace delete - are unit-testable in isolation. `controlPanelProvider`
 * feeds these plain summaries in and posts the results out.
 *
 * SECURITY: display-safe summaries in, display-safe summaries out. Nothing
 * here reads the filesystem or a runtime handle.
 */

import {
  DEFAULT_RECENTS_LIMIT,
  type RecentChatSummary,
  type WorkTaskSummary
} from "@drydock/contracts";

/** The session facts a Recents row is built from (a subset of ChatSessionSummary). */
export interface RecentSessionInput {
  readonly sessionId: string;
  readonly title: string;
  readonly status: string;
  readonly live?: boolean;
  readonly runningElsewhere?: boolean;
  /** Last activity; ChatSessionSummary.updatedAt. */
  readonly updatedAt: string;
}

export interface BuildRecentChatsOptions {
  /** Rows to return; defaults to the rail's cap of 7. */
  readonly limit?: number;
  /** Sessions with a pending question / access request / failed turn. */
  readonly attentionSessionIds?: ReadonlySet<string>;
}

/**
 * One row per task: the task's most recent chat across its own AND its
 * subtasks' linked sessions.
 *
 * Selection inside a task: a chat that has not ended outranks an ended one
 * (the rail wants the conversation you can continue), then newest activity
 * wins, then sessionId keeps it deterministic. That ordering is also what
 * promotes the next chat into the row when the newest one ends.
 *
 * Tasks with no resolvable chat are omitted entirely - a Recents row with no
 * chat has nothing to click. Rows are newest-first, capped at `limit`.
 */
export function buildRecentChats(
  tasks: readonly WorkTaskSummary[],
  sessions: readonly RecentSessionInput[],
  options: BuildRecentChatsOptions = {}
): RecentChatSummary[] {
  const limit = options.limit ?? DEFAULT_RECENTS_LIMIT;
  const attention = options.attentionSessionIds ?? new Set<string>();
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  const rows: RecentChatSummary[] = [];

  for (const task of tasks) {
    // A session linked to both the task and one of its subtasks must not
    // produce two candidates - the Set is the dedupe.
    const linked = new Set<string>(task.linkedSessionIds);
    for (const subtask of task.subtasks) {
      for (const sessionId of subtask.linkedSessionIds) linked.add(sessionId);
    }
    let best: RecentSessionInput | undefined;
    for (const sessionId of linked) {
      const candidate = byId.get(sessionId);
      // Unknown ids are stale links (a deleted session): skip, never guess.
      if (candidate === undefined) continue;
      if (best === undefined || compareCandidates(candidate, best) < 0) best = candidate;
    }
    if (best === undefined) continue;
    rows.push({
      sessionId: best.sessionId,
      title: best.title,
      taskId: task.taskId,
      taskTitle: task.title,
      status: best.status,
      ...(best.live === undefined ? {} : { live: best.live }),
      ...(best.runningElsewhere === undefined ? {} : { runningElsewhere: best.runningElsewhere }),
      ...(attention.has(best.sessionId) ? { needsAttention: true } : {}),
      lastActivityAt: best.updatedAt
    });
  }

  rows.sort((a, b) => (a.lastActivityAt === b.lastActivityAt
    ? a.taskId.localeCompare(b.taskId)
    : (a.lastActivityAt < b.lastActivityAt ? 1 : -1)));
  return rows.slice(0, Math.max(0, limit));
}

/** Negative when `a` should be the task's Recents row instead of `b`. */
function compareCandidates(a: RecentSessionInput, b: RecentSessionInput): number {
  const endedA = a.status === "ended" ? 1 : 0;
  const endedB = b.status === "ended" ? 1 : 0;
  if (endedA !== endedB) return endedA - endedB;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.sessionId.localeCompare(b.sessionId);
}

/**
 * Task titles that block deleting a workspace set: the task links the set AND
 * has at least one live chat (its own or a subtask's). Deleting the set under
 * a running agent would strip the mounts its resume depends on, so the host
 * refuses and names the work standing in the way.
 *
 * Titles are de-duplicated and returned in task order; an empty array means
 * the delete is safe.
 */
export function tasksBlockingWorkspaceSet(
  workspaceSetIds: readonly string[],
  tasks: readonly WorkTaskSummary[],
  liveSessionIds: ReadonlySet<string>
): string[] {
  const targets = new Set(workspaceSetIds);
  const blocking: string[] = [];
  for (const task of tasks) {
    if (!task.linkedWorkspaceSetIds.some((setId) => targets.has(setId))) continue;
    const linked = new Set<string>(task.linkedSessionIds);
    for (const subtask of task.subtasks) {
      for (const sessionId of subtask.linkedSessionIds) linked.add(sessionId);
    }
    const inUse = [...linked].some((sessionId) => liveSessionIds.has(sessionId));
    if (inUse && !blocking.includes(task.title)) blocking.push(task.title);
  }
  return blocking;
}

/** The refusal message for an in-use workspace set (or one of its roots). */
export function workspaceInUseMessage(subject: string, taskTitles: readonly string[]): string {
  const names = taskTitles.map((title) => `"${title}"`).join(", ");
  const plural = taskTitles.length === 1 ? "a live chat" : "live chats";
  return `${subject} is in use: ${names} ${taskTitles.length === 1 ? "has" : "have"} ${plural} mounted on it. End or land that work first.`;
}
