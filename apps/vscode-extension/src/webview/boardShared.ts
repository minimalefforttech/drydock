/**
 * Shared Task Board state assembly, used by both the control panel (Work-tab
 * task cards) and the Task Board editor panel so the two surfaces render
 * identical projections from one code path.
 *
 * `buildBoardState` joins board columns onto every task summary (subtasks,
 * columnId, doneAt) exactly once per render; `decorateTaskSummary` does the
 * same for a single task after a targeted mutation (task.update/link/unlink,
 * subtask.*). `reconcileColumns` applies a `board.columns.update` request
 * (add/rename/reorder, plus the additive `deletedColumnIds`) against the
 * columns currently stored.
 */

import type {
  BoardColumnRecord,
  BoardColumnSummary,
  BoardColumnUpdateInput,
  BoardState,
  ColumnId,
  SubtaskDependencyRecord,
  SubtaskId,
  SubtaskRecord,
  SubtaskSummary,
  WorkTaskSummary
} from "@drydock/contracts";
import type { Logger } from "@drydock/core";
import type { BoardService, SubtaskService } from "@drydock/work-management";
import type { BackendReady } from "../compositionRoot.js";

/** Display-safe projection of a board column. */
export function toBoardColumnSummary(record: BoardColumnRecord): BoardColumnSummary {
  return {
    columnId: record.columnId,
    name: record.name,
    category: record.category,
    sortOrder: record.sortOrder
  };
}

/**
 * Display-safe projection of a subtask, decorated with its computed
 * `isBlocked` (never stored) and the sessions linked to it. `dependencies`,
 * `subtasksById`, and `columnsById` are pre-fetched once per task/board render
 * by the caller so isBlocked's DFS-free lookup stays O(edges) per subtask.
 */
export function toSubtaskSummary(
  record: SubtaskRecord,
  subtaskService: SubtaskService,
  dependencies: readonly SubtaskDependencyRecord[],
  subtasksById: ReadonlyMap<SubtaskId, SubtaskRecord>,
  columnsById: ReadonlyMap<ColumnId, BoardColumnRecord>,
  linkedSessionIds: readonly string[],
  runtime: { readonly isRunning: boolean; readonly lastFailureAt?: string; readonly isQueued?: boolean; readonly isParked?: boolean },
  hasUnlandedChangeset = false
): SubtaskSummary {
  return {
    subtaskId: record.subtaskId,
    taskId: record.taskId,
    title: record.title,
    ...(record.description === undefined ? {} : { description: record.description }),
    ...(record.prompt === undefined ? {} : { prompt: record.prompt }),
    autoStart: record.autoStart,
    origin: record.origin,
    columnId: record.columnId,
    sortOrder: record.sortOrder,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.doneAt === undefined ? {} : { doneAt: record.doneAt }),
    isBlocked: subtaskService.isBlocked(record.subtaskId, dependencies, subtasksById, columnsById),
    dependsOn: dependencies
      .filter((edge) => edge.toSubtaskId === record.subtaskId)
      .map((edge) => edge.fromSubtaskId as string),
    isRunning: runtime.isRunning,
    ...(runtime.lastFailureAt === undefined ? {} : { lastFailureAt: runtime.lastFailureAt }),
    ...(runtime.isQueued === true ? { isQueued: true } : {}),
    ...(runtime.isParked === true ? { isParked: true } : {}),
    linkedSessionIds,
    ...(record.colorOverride === undefined ? {} : { colorOverride: record.colorOverride }),
    ...(record.seedMode === undefined ? {} : { seedMode: record.seedMode }),
    ...(hasUnlandedChangeset ? { hasUnlandedChangeset: true } : {}),
    ...(record.model === undefined ? {} : { model: record.model }),
    // ADR 0007: an armed HITL gate is unmet once the card sits in Review
    // (done category) without a verified stamp - waiting-on-you.
    ...(record.verifyMode === "hitl"
      && columnsById.get(record.columnId)?.category === "done"
      && record.verifiedAt === undefined
      ? { verifyUnmet: true }
      : {}),
    ...(record.verifiedAt === undefined ? {} : { verifiedAt: record.verifiedAt })
  };
}

/**
 * Joins each task's open review-comment count (cheap review-store reads via
 * TaskReviewAppService - no tree walks) into the summaries so callers can
 * read "(N open comments)". Best-effort: a failed join returns the summaries
 * unchanged. task.updated pushes do NOT carry the count; it refreshes on the
 * next full list/board fetch.
 */
export async function joinOpenCommentCounts(
  backend: BackendReady,
  logger: Logger,
  tasks: readonly WorkTaskSummary[]
): Promise<readonly WorkTaskSummary[]> {
  try {
    const counts = await backend.taskReview.openCommentCountsByTask();
    if (counts.size === 0) {
      return tasks;
    }
    return tasks.map((task) => {
      const openReviewCommentCount = counts.get(task.taskId);
      return openReviewCommentCount === undefined ? task : { ...task, openReviewCommentCount };
    });
  } catch (error) {
    logger.warn("task review comment-count join failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    return tasks;
  }
}

/**
 * Joins columnId, doneAt, and subtasks onto a bare task summary from
 * `listTaskSummaries()` (which does not itself carry board-phase fields).
 * `columnsById` may be supplied by a caller that already fetched every
 * column (e.g. buildBoardState, decorating many tasks in one pass); a
 * single-task caller (task.update/link/unlink) omits it and this method
 * fetches columns itself.
 */
export async function decorateTaskSummary(
  backend: BackendReady,
  summary: WorkTaskSummary,
  columnsById?: ReadonlyMap<ColumnId, BoardColumnRecord>
): Promise<WorkTaskSummary> {
  const tasks = backend.tasks;
  const subtaskService = backend.subtasks;
  const resolvedColumnsById = columnsById ?? new Map((await backend.board.listColumns()).map((column) => [column.columnId, column]));
  const record = await tasks.getTask(summary.taskId);
  const subtaskRecords = await subtaskService.listForTask(summary.taskId);
  const dependencies = await subtaskService.listDependenciesForTask(summary.taskId);
  const subtasksById = new Map(subtaskRecords.map((subtask) => [subtask.subtaskId, subtask]));
  // Session links can carry a subtaskId (the orchestrator records one per
  // spawned run); TaskService.listSessionIdsBySubtask resolves each subtask's
  // own linked chats, fetched in parallel across the task's subtasks.
  const linkedSessionIdsBySubtask = await Promise.all(
    subtaskRecords.map((subtask) => backend.tasks.listSessionIdsBySubtask(subtask.subtaskId))
  );
  const linkedSessionIdsById = new Map(subtaskRecords.map((subtask, index) => [subtask.subtaskId, linkedSessionIdsBySubtask[index] ?? []]));
  // ⎘ chip data (ADR 0014): which of this task's subtasks hold a captured
  // changeset not yet pulled into the local repo. One batched query per task.
  const unlandedIds = await backend.changesets.unlandedSubtaskIds(subtaskRecords.map((subtask) => subtask.subtaskId as string));
  const subtasks = subtaskRecords
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((subtask) => {
      const failure = backend.orchestrator.lastFailure(subtask.subtaskId);
      return toSubtaskSummary(
        subtask,
        subtaskService,
        dependencies,
        subtasksById,
        resolvedColumnsById,
        linkedSessionIdsById.get(subtask.subtaskId) ?? [],
        {
          isRunning: backend.orchestrator.isRunning(subtask.subtaskId),
          ...(failure === undefined ? {} : { lastFailureAt: failure.at }),
          ...(backend.orchestrator.isQueued(subtask.subtaskId) ? { isQueued: true } : {}),
          ...(backend.orchestrator.isParked(subtask.subtaskId) ? { isParked: true } : {})
        },
        unlandedIds.has(subtask.subtaskId as string)
      );
    });
  return {
    ...summary,
    columnId: record?.columnId ?? summary.columnId,
    ...(record?.doneAt === undefined ? {} : { doneAt: record.doneAt }),
    subtasks
  };
}

/**
 * Assembles the full board state: every column, every task summary (joined
 * with the open-review-comment count), each decorated with its columnId,
 * doneAt, and subtasks (each subtask carrying its computed isBlocked).
 * `listTaskSummaries()` does not itself embed board fields or subtasks, so
 * this joins them via `decorateTaskSummary`, sharing one columns fetch across
 * every task/subtask's isBlocked lookup.
 */
export async function buildBoardState(backend: BackendReady, logger: Logger): Promise<BoardState> {
  const tasks = backend.tasks;
  const board = backend.board;
  const columns = await board.listColumns();
  const columnsById = new Map(columns.map((column) => [column.columnId, column]));
  const summaries = await joinOpenCommentCounts(backend, logger, await tasks.listTaskSummaries());
  const decorated = await Promise.all(summaries.map((summary) => decorateTaskSummary(backend, summary, columnsById)));
  return { columns: columns.map(toBoardColumnSummary), tasks: decorated };
}

/** Refreshed summary (with current links, columnId/doneAt, and subtasks) for one task after a mutation. */
export async function requireTaskSummary(backend: BackendReady, taskId: string): Promise<WorkTaskSummary> {
  const summary = (await backend.tasks.listTaskSummaries()).find((candidate) => candidate.taskId === taskId);
  if (summary === undefined) {
    throw new Error(`Task ${taskId} was not found.`);
  }
  return decorateTaskSummary(backend, summary);
}

/**
 * Reconciles a `board.columns.update` request against the columns currently
 * stored: entries carrying a columnId are renamed and reordered via
 * BoardService's `renameColumn`/`reorder`; entries with no columnId are
 * created via `addColumn`. BoardService deliberately exposes no
 * category-change operation (its own `reorder` doc comment: "moving a
 * column to a different category is a separate operation the board UI does
 * not expose in this phase") - an entry's `category` is honoured only when
 * creating a new column; a changed category on an EXISTING column is
 * ignored here (rename/reorder only), matching that same-phase boundary.
 *
 * `deletedColumnIds` (additive) is processed FIRST, one at a time via
 * `BoardService.deleteColumn` - which moves that column's cards to the
 * nearest remaining column of the same category and throws a readable error
 * if it would empty a category entirely (surfaced verbatim to the caller,
 * which aborts the whole reconcile so a partial delete never lands silently
 * alongside unapplied renames/reorders). Deleted ids are then excluded from
 * the add/rename/reorder pass below, and from the trailing "remaining
 * columns" append in the reorder step.
 */
export async function reconcileColumns(
  board: BoardService,
  entries: readonly BoardColumnUpdateInput[],
  deletedColumnIds?: readonly string[]
): Promise<void> {
  for (const columnId of deletedColumnIds ?? []) {
    await board.deleteColumn(columnId);
  }
  const deletedIds = new Set(deletedColumnIds ?? []);
  const existing = await board.listColumns();
  const existingIds = new Set(existing.map((column) => column.columnId as string));
  for (const entry of entries) {
    if (entry.columnId === undefined) {
      await board.addColumn(entry.name, entry.category, entry.sortOrder);
      continue;
    }
    if (deletedIds.has(entry.columnId)) {
      continue; // Deleted above this call; skip stale rename/reorder for it.
    }
    if (!existingIds.has(entry.columnId)) {
      throw new Error(`Column ${entry.columnId} was not found.`);
    }
    await board.renameColumn(entry.columnId, entry.name);
  }
  // Reorder to the incoming sortOrder sequence for every column named with an
  // id, preserving each category (reorder() itself never changes category).
  const named = entries.filter(
    (entry): entry is { readonly columnId: string } & BoardColumnUpdateInput =>
      entry.columnId !== undefined && !deletedIds.has(entry.columnId)
  );
  if (named.length > 0) {
    const ordered = [...named].sort((a, b) => a.sortOrder - b.sortOrder).map((entry) => entry.columnId);
    const allIds = (await board.listColumns()).map((column) => column.columnId as string);
    // reorder() requires every existing column exactly once; append any
    // columns not named in this request (e.g. newly-added ones) in their
    // current order so the call satisfies that invariant.
    const remaining = allIds.filter((id) => !ordered.includes(id));
    await board.reorder([...ordered, ...remaining]);
  }
}
