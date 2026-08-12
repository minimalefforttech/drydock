/**
 * ONE status vocabulary + roll-up for task-shaped rows (UX overhaul, P1).
 *
 * The rail, the hub, and the board all render a single dot per task. Without a
 * shared roll-up the three surfaces would each invent their own precedence and
 * the dot language would fork - so the precedence lives here, in contracts,
 * next to the summaries it reads.
 *
 * Precedence (design doc, approved default): awaiting > failed > running >
 * starting/queued > idle > done/offline. `awaiting` outranks `failed` on
 * purpose: a blocked agent burns wall-clock, a failure waits.
 *
 * Pure projections only - no DOM, no host services.
 */

/** The status language every task-shaped surface speaks. */
export const TASK_ROLLUP_STATUSES = [
  "awaiting",
  "failed",
  "running",
  "starting",
  "queued",
  "idle",
  "done",
  "offline"
] as const;

export type TaskRollupStatus = (typeof TASK_ROLLUP_STATUSES)[number];

/**
 * Lower wins. `starting`/`queued` share a rank (both are "about to work"), as
 * do `done`/`offline` (both are "nothing is happening") - within a rank the
 * first child seen wins, so the roll-up is stable for a stable input order.
 */
const RANK: Readonly<Record<TaskRollupStatus, number>> = {
  awaiting: 0,
  failed: 1,
  running: 2,
  starting: 3,
  queued: 3,
  idle: 4,
  done: 5,
  offline: 5
};

/**
 * Folds child statuses (sessions, subtasks) into the one status a task row
 * shows. An empty input is `offline` - a task with nothing under it has
 * nothing live to report.
 */
export function rollupTaskStatus(statuses: Iterable<TaskRollupStatus>): TaskRollupStatus {
  let best: TaskRollupStatus | undefined;
  for (const status of statuses) {
    if (best === undefined || RANK[status] < RANK[best]) {
      best = status;
    }
  }
  return best ?? "offline";
}

/** The session facts the roll-up reads (a structural subset of ChatSessionSummary). */
export interface SessionStatusInput {
  /** Durable ChatSessionStatus: starting | active | ended | failed. */
  readonly status: string;
  /** Authoritative liveness in THIS host. */
  readonly live?: boolean;
  /** Live in another window (view-only here, but still alive). */
  readonly runningElsewhere?: boolean;
  /** A pending question / access request / failed turn is waiting on the user. */
  readonly needsAttention?: boolean;
  /** A turn is in flight (turnStarted push, or the agent-activity root). */
  readonly turnActive?: boolean;
}

/**
 * One session's contribution to its task's dot. `awaiting` wins over the
 * stored status because a waiting agent is the one thing the user must see;
 * a stored-active session with no live backend reads `offline`, never
 * `running` (ADR 0008 honesty).
 */
export function sessionRollupStatus(session: SessionStatusInput): TaskRollupStatus {
  if (session.needsAttention === true) return "awaiting";
  if (session.status === "failed") return "failed";
  const alive = session.live === true || session.runningElsewhere === true;
  if (session.turnActive === true && alive) return "running";
  if (session.status === "starting") return "starting";
  if (alive) return "idle";
  if (session.status === "ended") return "done";
  return "offline";
}

/** The subtask facts the roll-up reads (a structural subset of SubtaskSummary). */
export interface SubtaskStatusInput {
  readonly isRunning?: boolean;
  readonly isQueued?: boolean;
  readonly isParked?: boolean;
  /** ADR 0007: an armed HITL verify gate is unmet - waiting on a person. */
  readonly verifyUnmet?: boolean;
  readonly doneAt?: string;
}

/**
 * One subtask's contribution to its task's dot. An unmet verify gate is a
 * person-shaped block (`awaiting`); a parked subtask is automation that gave
 * up (`failed`).
 */
export function subtaskRollupStatus(subtask: SubtaskStatusInput): TaskRollupStatus {
  if (subtask.verifyUnmet === true) return "awaiting";
  if (subtask.isParked === true) return "failed";
  if (subtask.isRunning === true) return "running";
  if (subtask.isQueued === true) return "queued";
  if (subtask.doneAt !== undefined) return "done";
  return "idle";
}
