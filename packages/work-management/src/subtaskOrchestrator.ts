/**
 * Subtask auto-start orchestrator (task board and subtasks, Orchestration
 * phase). Normative semantics live in
 * docs/design/task-board-and-subtasks.md#orchestration:
 *
 * - Manual start (`startSubtask`) NEVER starts dependencies; it is refused
 *   while any upstream is unfinished unless `force` is passed (force is
 *   manual-only — automation never passes it).
 * - A successful start spawns a chat session (via the injected `startRun`
 *   callback), links it to the subtask, and moves the card to the first
 *   `in-progress` column.
 * - Completion is event-driven off the product bus `turn-completed`: a
 *   `completed` run moves the card to the first `done` column (the service
 *   stamps `doneAt` and fires `card-entered-done`), which in turn evaluates
 *   dependents; `failed`/`cancelled` runs leave the card in place with no
 *   cascade.
 * - Dependent evaluation auto-starts a downstream subtask iff: its
 *   `autoStart` flag is set, every upstream is in a done-category column, it
 *   has a prompt, it is not in a backlog-category column, and it is not
 *   already running or done. Eligible dependents are dispatched together
 *   (`Promise.allSettled`); a bad dependent is logged and swallowed so one
 *   failure never blocks its siblings.
 * - `isRunning`/`lastFailure` are in-memory only: a host restart losing them
 *   is an accepted, documented limitation (a restarted host has no live
 *   sessions to reconcile against anyway).
 */

import { asId } from "@drydock/contracts";
import type {
  BoardColumnRecord,
  ColumnCategory,
  SubtaskDependencyRecord,
  SubtaskId,
  SubtaskRecord,
  SubtaskStore,
  TaskId,
  WorkTaskLinkRecord
} from "@drydock/contracts";
import type { Logger, ProductBusEvent, ProductEventBus } from "@drydock/core";

/** Subtask facts the orchestrator needs; SubtaskService satisfies this structurally. */
export interface OrchestratorSubtaskPort {
  getSubtask(subtaskId: string): Promise<SubtaskRecord | null>;
  listForTask(taskId: string): Promise<SubtaskRecord[]>;
  listDependenciesForTask(taskId: string): Promise<SubtaskDependencyRecord[]>;
  moveCard(card: { readonly subtaskId: string }, columnId: string): Promise<SubtaskRecord | unknown>;
}

/** Column facts the orchestrator needs; BoardService satisfies this structurally. */
export interface OrchestratorBoardPort {
  firstColumnOf(category: ColumnCategory): Promise<BoardColumnRecord>;
  listColumns(): Promise<BoardColumnRecord[]>;
}

/**
 * Session<->subtask link facts. TaskService.link already accepts an optional
 * subtaskId alongside a sessionId target (see TaskLinkTarget); listLinks()
 * with no taskId returns every link, which is enough to resolve a bare
 * sessionId back to its subtask without a new store accessor.
 */
export interface OrchestratorLinkPort {
  link(taskId: string, target: { readonly sessionId: string; readonly subtaskId?: string }): Promise<void>;
  listLinks(): Promise<WorkTaskLinkRecord[]>;
}

/** App-layer callback that actually starts a chat session and sends the subtask's prompt as the first turn. */
export type StartSubtaskRun = (input: { readonly taskId: string; readonly subtaskId: string; readonly prompt: string; readonly title: string }) => Promise<{ readonly sessionId: string }>;

export interface SubtaskOrchestratorOptions {
  readonly subtasks: OrchestratorSubtaskPort;
  readonly board: OrchestratorBoardPort;
  readonly links: OrchestratorLinkPort;
  readonly bus: ProductEventBus;
  readonly startRun: StartSubtaskRun;
  readonly logger: Logger;
}

export type StartSubtaskErrorCode = "NOT_FOUND" | "NO_PROMPT" | "ALREADY_RUNNING" | "ALREADY_DONE" | "BLOCKED";

export class StartSubtaskError extends Error {
  constructor(readonly code: StartSubtaskErrorCode, message: string) {
    super(message);
    this.name = "StartSubtaskError";
  }
}

export interface StartSubtaskOptions {
  /** Force start bypasses the BLOCKED refusal. Manual-only: automation never passes this. */
  readonly force?: boolean;
}

export interface StartTaskResult {
  readonly started: number;
  readonly skipped: number;
}

/**
 * Coordinates dependency-driven auto-start. Holds two in-memory sets: which
 * subtasks are currently running (survives across calls in this process only)
 * and which dependent evaluations are currently in flight (re-entrancy guard —
 * the bus is synchronous, so a moveCard performed inside a "turn-completed" or
 * "card-entered-done" handler can re-fire events before the outer call
 * returns; the guard makes that safe instead of double-starting a dependent).
 */
export class SubtaskOrchestrator {
  private readonly running = new Set<SubtaskId>();
  private readonly failures = new Map<SubtaskId, { readonly at: string; readonly runId?: string }>();
  private readonly sessionToSubtask = new Map<string, SubtaskId>();
  private readonly evaluating = new Set<SubtaskId>();
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly options: SubtaskOrchestratorOptions) {
    this.unsubscribe = this.options.bus.subscribe((event) => this.onBusEvent(event));
  }

  /** Stops listening to the bus. Safe to call more than once. */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  isRunning(subtaskId: string): boolean {
    return this.running.has(asId<"SubtaskId">(subtaskId));
  }

  lastFailure(subtaskId: string): { readonly at: string; readonly runId?: string } | undefined {
    return this.failures.get(asId<"SubtaskId">(subtaskId));
  }

  /**
   * Manual (or cascade-driven, with force=false) start of one subtask.
   * Refuses BLOCKED (any upstream not done) unless `force` is set; force is a
   * manual-only override — evaluateDependents never passes it.
   */
  async startSubtask(subtaskId: string, options: StartSubtaskOptions = {}): Promise<SubtaskRecord> {
    const id = asId<"SubtaskId">(subtaskId);
    const subtask = await this.options.subtasks.getSubtask(id);
    if (subtask === null) {
      throw new StartSubtaskError("NOT_FOUND", `Subtask ${subtaskId} was not found.`);
    }
    if (subtask.prompt === undefined || subtask.prompt.length === 0) {
      throw new StartSubtaskError("NO_PROMPT", `Subtask ${subtaskId} has no prompt to start.`);
    }
    if (this.running.has(id)) {
      throw new StartSubtaskError("ALREADY_RUNNING", `Subtask ${subtaskId} is already running.`);
    }
    const columns = await this.options.board.listColumns();
    const columnsById = new Map(columns.map((column) => [column.columnId, column]));
    if (columnsById.get(subtask.columnId)?.category === "done") {
      throw new StartSubtaskError("ALREADY_DONE", `Subtask ${subtaskId} is already done.`);
    }
    if (!options.force) {
      const blocked = await this.isBlocked(subtask, columnsById);
      if (blocked) {
        throw new StartSubtaskError("BLOCKED", `Subtask ${subtaskId} has unfinished upstream dependencies.`);
      }
    }

    this.running.add(id);
    try {
      const { sessionId } = await this.options.startRun({ taskId: subtask.taskId, subtaskId: id, prompt: subtask.prompt, title: subtask.title });
      this.sessionToSubtask.set(sessionId, id);
      await this.options.links.link(subtask.taskId, { sessionId, subtaskId: id });
      const inProgress = await this.options.board.firstColumnOf("in-progress");
      await this.options.subtasks.moveCard({ subtaskId: id }, inProgress.columnId);
      this.options.bus.publish({ kind: "board-changed" });
      const updated = await this.options.subtasks.getSubtask(id);
      return updated ?? subtask;
    } catch (error) {
      this.running.delete(id);
      throw error;
    }
  }

  /**
   * Starts every "ready" subtask of a task: has a prompt, not blocked, not in
   * a backlog column, not already running, not already done. Per-subtask
   * failures are isolated (Promise.allSettled) and counted as skipped; this
   * never forces a blocked subtask.
   */
  async startTask(taskId: string): Promise<StartTaskResult> {
    const id = asId<"TaskId">(taskId);
    const subtasks = await this.options.subtasks.listForTask(id);
    const columns = await this.options.board.listColumns();
    const columnsById = new Map(columns.map((column) => [column.columnId, column]));

    const ready: SubtaskRecord[] = [];
    let skipped = 0;
    for (const subtask of subtasks) {
      const eligible = await this.isReadyToStart(subtask, columnsById);
      if (eligible) {
        ready.push(subtask);
      } else {
        skipped += 1;
      }
    }

    const results = await Promise.allSettled(ready.map((subtask) => this.startSubtask(subtask.subtaskId, { force: false })));
    let started = 0;
    for (const result of results) {
      if (result.status === "fulfilled") {
        started += 1;
      } else {
        skipped += 1;
        this.options.logger.warn("subtask auto-start failed during startTask", {
          taskId,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason)
        });
      }
    }
    return { started, skipped };
  }

  /**
   * Applies the normative auto-start predicate to every direct dependent of
   * `subtaskId` and starts the eligible ones together. Guarded by `evaluating`
   * against re-entrancy: the bus is synchronous, so startSubtask's own
   * moveCard-into-done-column (on a later completion) or a nested
   * card-entered-done can re-enter this method for the same subtask while the
   * first pass is still unwinding. Per-dependent start failures are logged and
   * swallowed so one bad dependent never blocks its siblings.
   */
  async evaluateDependents(subtaskId: string): Promise<void> {
    const id = asId<"SubtaskId">(subtaskId);
    if (this.evaluating.has(id)) {
      return;
    }
    this.evaluating.add(id);
    try {
      const subtask = await this.options.subtasks.getSubtask(id);
      if (subtask === null) {
        return;
      }
      const dependencies = await this.options.subtasks.listDependenciesForTask(subtask.taskId);
      const dependentIds = [...new Set(dependencies.filter((edge) => edge.fromSubtaskId === id).map((edge) => edge.toSubtaskId))];
      if (dependentIds.length === 0) {
        return;
      }
      const columns = await this.options.board.listColumns();
      const columnsById = new Map(columns.map((column) => [column.columnId, column]));
      const siblings = await this.options.subtasks.listForTask(subtask.taskId);
      const siblingsById = new Map(siblings.map((entry) => [entry.subtaskId, entry]));

      const eligible: SubtaskRecord[] = [];
      for (const dependentId of dependentIds) {
        const dependent = siblingsById.get(dependentId);
        if (dependent === undefined) {
          continue;
        }
        if (await this.isEligibleForCascade(dependent, dependencies, siblingsById, columnsById)) {
          eligible.push(dependent);
        }
      }

      const results = await Promise.allSettled(eligible.map((dependent) => this.startSubtask(dependent.subtaskId, { force: false })));
      for (const [index, result] of results.entries()) {
        if (result.status === "rejected") {
          const failedSubtaskId = eligible[index]?.subtaskId;
          this.options.logger.warn("dependent auto-start failed", {
            ...(failedSubtaskId === undefined ? {} : { subtaskId: failedSubtaskId }),
            error: result.reason instanceof Error ? result.reason.message : String(result.reason)
          });
        }
      }
    } finally {
      this.evaluating.delete(id);
    }
  }

  private onBusEvent(event: ProductBusEvent): void {
    if (event.kind === "turn-completed") {
      void this.onTurnCompleted(event.sessionId, event.status).catch((error: unknown) => {
        this.options.logger.warn("subtask orchestrator turn-completed handling failed", {
          sessionId: event.sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
      return;
    }
    if (event.kind === "card-entered-done") {
      void this.evaluateDependents(event.subtaskId).catch((error: unknown) => {
        this.options.logger.warn("subtask orchestrator dependent evaluation failed", {
          subtaskId: event.subtaskId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
  }

  private async onTurnCompleted(sessionId: string, status: "completed" | "failed" | "cancelled"): Promise<void> {
    const subtaskId = await this.resolveSubtaskForSession(sessionId);
    if (subtaskId === undefined) {
      // Unknown session (not a subtask-linked run, e.g. a plain chat) — ignore.
      return;
    }
    this.running.delete(subtaskId);
    if (status !== "completed") {
      this.failures.set(subtaskId, { at: new Date().toISOString() });
      this.options.bus.publish({ kind: "board-changed" });
      return;
    }
    const doneColumn = await this.options.board.firstColumnOf("done");
    // moveCard stamps doneAt and (since the destination is a done-category
    // column) fires "card-entered-done" itself, which drives the cascade —
    // this handler does not call evaluateDependents directly.
    await this.options.subtasks.moveCard({ subtaskId }, doneColumn.columnId);
    this.options.bus.publish({ kind: "board-changed" });
  }

  /** Resolves a sessionId to its linked subtaskId, preferring the in-memory map populated at start time; falls back to a link scan (covers a fresh process that adopted an already-linked session). */
  private async resolveSubtaskForSession(sessionId: string): Promise<SubtaskId | undefined> {
    const cached = this.sessionToSubtask.get(sessionId);
    if (cached !== undefined) {
      return cached;
    }
    const links = await this.options.links.listLinks();
    const match = links.find((link) => link.sessionId === sessionId && link.subtaskId !== undefined);
    if (match?.subtaskId === undefined) {
      return undefined;
    }
    this.sessionToSubtask.set(sessionId, match.subtaskId);
    return match.subtaskId;
  }

  private async isBlocked(subtask: SubtaskRecord, columnsById: ReadonlyMap<string, BoardColumnRecord>): Promise<boolean> {
    const dependencies = await this.options.subtasks.listDependenciesForTask(subtask.taskId);
    const siblings = await this.options.subtasks.listForTask(subtask.taskId);
    const siblingsById = new Map(siblings.map((entry) => [entry.subtaskId, entry]));
    const upstreamIds = dependencies.filter((edge) => edge.toSubtaskId === subtask.subtaskId).map((edge) => edge.fromSubtaskId);
    return upstreamIds.some((upstreamId) => {
      const upstream = siblingsById.get(upstreamId);
      if (upstream === undefined) {
        return false;
      }
      return columnsById.get(upstream.columnId)?.category !== "done";
    });
  }

  private async isReadyToStart(subtask: SubtaskRecord, columnsById: ReadonlyMap<string, BoardColumnRecord>): Promise<boolean> {
    if (subtask.prompt === undefined || subtask.prompt.length === 0) {
      return false;
    }
    const category = columnsById.get(subtask.columnId)?.category;
    if (category === "backlog" || category === "done") {
      return false;
    }
    if (this.running.has(subtask.subtaskId)) {
      return false;
    }
    return !(await this.isBlocked(subtask, columnsById));
  }

  /**
   * The normative dependent auto-start predicate: autoStart flag set, every
   * upstream done, has a prompt, not in a backlog column, not already
   * running or done.
   */
  private async isEligibleForCascade(
    dependent: SubtaskRecord,
    dependencies: readonly SubtaskDependencyRecord[],
    siblingsById: ReadonlyMap<SubtaskId, SubtaskRecord>,
    columnsById: ReadonlyMap<string, BoardColumnRecord>
  ): Promise<boolean> {
    if (!dependent.autoStart) {
      return false;
    }
    if (dependent.prompt === undefined || dependent.prompt.length === 0) {
      return false;
    }
    const category = columnsById.get(dependent.columnId)?.category;
    if (category === "backlog" || category === "done") {
      return false;
    }
    if (this.running.has(dependent.subtaskId)) {
      return false;
    }
    const upstreamIds = dependencies.filter((edge) => edge.toSubtaskId === dependent.subtaskId).map((edge) => edge.fromSubtaskId);
    const allUpstreamDone = upstreamIds.every((upstreamId) => {
      const upstream = siblingsById.get(upstreamId);
      return upstream !== undefined && columnsById.get(upstream.columnId)?.category === "done";
    });
    return allUpstreamDone;
  }
}
