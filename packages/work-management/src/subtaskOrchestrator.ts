/**
 * Subtask auto-start orchestrator (task board and subtasks, Orchestration
 * phase). Normative semantics live in
 * docs/design/task-board-and-subtasks.md#orchestration:
 *
 * - Manual start (`startSubtask`) NEVER starts dependencies; it is refused
 *   while any upstream is unfinished unless `force` is passed (force is
 *   manual-only — automation never passes it).
 * - A successful start prepares a chat session (via the injected `startRun`
 *   callback), links it to the subtask, moves the card to the first
 *   `in-progress` column, and only then dispatches the first turn.
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
  SubtaskHoldStore,
  SubtaskId,
  SubtaskModelSelection,
  SubtaskRecord,
  SubtaskSeedMode,
  WorkTaskLinkRecord
} from "@drydock/contracts";
import type { Logger, ProductBusEvent, ProductEventBus } from "@drydock/core";

/** Subtask facts the orchestrator needs; SubtaskService satisfies this structurally. */
export interface OrchestratorSubtaskPort {
  getSubtask(subtaskId: string): Promise<SubtaskRecord | null>;
  listForTask(taskId: string): Promise<SubtaskRecord[]>;
  listDependenciesForTask(taskId: string): Promise<SubtaskDependencyRecord[]>;
  updateSubtask(subtaskId: string, input: { readonly verified: false }): Promise<SubtaskRecord | unknown>;
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

/**
 * App-layer callback that prepares a chat session and returns a detached
 * first-turn dispatcher. Splitting those phases lets the orchestrator commit
 * its session map, durable link, and in-progress card before a very fast turn
 * can publish `turn-completed`. `seedMode`/`dependsOn` carry the stored
 * clone-seeding choice (ADR 0014): the bridge resolves `upstream` into
 * concrete unlanded changeset patches; the orchestrator never invents a
 * choice the user didn't store.
 */
export type StartSubtaskRun = (input: {
  readonly taskId: string;
  readonly subtaskId: string;
  readonly prompt: string;
  readonly title: string;
  readonly seedMode?: SubtaskSeedMode;
  /** Upstream dependency subtask ids, in edge insertion order. */
  readonly dependsOn: readonly string[];
  /** Per-role model profile (ADR 0002); absent = provider default. */
  readonly model?: SubtaskModelSelection;
}) => Promise<{
  readonly sessionId: string;
  /** Starts the first turn detached. The app bridge owns async failure logging. */
  readonly dispatchFirstTurn: () => void;
}>;

export interface SubtaskOrchestratorOptions {
  readonly subtasks: OrchestratorSubtaskPort;
  readonly board: OrchestratorBoardPort;
  readonly links: OrchestratorLinkPort;
  readonly bus: ProductEventBus;
  readonly startRun: StartSubtaskRun;
  readonly logger: Logger;
  /**
   * Awaited when a subtask card enters a done-category column, BEFORE its
   * dependents are evaluated — the ADR 0014 changeset-capture seam. Running
   * it inside the cascade ordering (not as a racing bus subscriber) means an
   * auto-started dependent with `upstream` seeding reads a store the capture
   * has already written. A rejected hook blocks this cascade attempt: starting
   * a dependent with absent or stale upstream output is never a safe fallback.
   */
  readonly onCardEnteredDone?: (input: { readonly taskId: string; readonly subtaskId: string }) => Promise<void>;
  /**
   * Run-slot budget (ADR 0015), resolved live so a settings change applies
   * to the next start. Returns the maximum concurrent runs; <= 0 means
   * unlimited (no queueing). The host derives the "auto" default from
   * machine spec; the orchestrator never guesses.
   */
  readonly maxConcurrentRuns?: () => number;
  /** Identifies adopted live sessions during restore so they consume fleet slots. */
  readonly isSessionLive?: (sessionId: string) => boolean;
  /**
   * ADR 0015: durable mirror of queued/parked state. Every hold transition
   * writes through (best-effort, logged); `restore()` reloads and drains
   * after a reload so held intent is never silently dropped. Absent = the
   * pre-continuity in-memory behaviour.
   */
  readonly holds?: SubtaskHoldStore;
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
  /**
   * Who initiated (ADR 0015): the cascade and the retry pass "auto";
   * everything else defaults to "manual". Manual starts jump the queue
   * (hotfix priority) and clear a parked/retried state; only auto runs are
   * retried-then-parked on failure.
   */
  readonly origin?: "manual" | "auto";
}

export interface StartTaskResult {
  readonly started: number;
  readonly queued: number;
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
  /** Synchronous per-subtask claims close the check/await race before validation begins. */
  private readonly startClaims = new Set<SubtaskId>();
  /** Admitted starts reserve a fleet slot across pre-launch awaits. */
  private readonly starting = new Set<SubtaskId>();
  private readonly failures = new Map<SubtaskId, { readonly at: string; readonly runId?: string }>();
  private readonly sessionToSubtask = new Map<string, SubtaskId>();
  private readonly evaluating = new Set<SubtaskId>();
  /**
   * Latest done-entry hook result per upstream. Keeping the promise lets a
   * diamond dependency wait for every concurrently finishing upstream's
   * capture, and keeping a failed result prevents another upstream's event
   * from starting the shared dependent with stale output.
   */
  private readonly doneEntryHookOutcomes = new Map<SubtaskId, Promise<boolean>>();
  /** Starts held back by the run-slot budget (ADR 0015); mirrored durably when a hold store is configured. */
  private readonly queue: { readonly subtaskId: SubtaskId; readonly force: boolean; readonly origin: "manual" | "auto" }[] = [];
  /** Auto runs that failed twice — automation gives up until a manual start clears it. */
  private readonly parked = new Set<SubtaskId>();
  /** Auto runs already retried once (cleared by success or a manual start). */
  private readonly retried = new Set<SubtaskId>();
  /** Origin of the in-flight run per subtask, for the failure policy. */
  private readonly originOf = new Map<SubtaskId, "manual" | "auto">();
  /** Serializes queue draining so concurrent completions preserve FIFO order. */
  private drainPromise: Promise<void> | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly options: SubtaskOrchestratorOptions) {
    this.unsubscribe = this.options.bus.subscribe((event) => this.onBusEvent(event));
  }

  /** Stops listening to the bus. Safe to call more than once. */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /**
   * Reloads durable holds (ADR 0015) after a reload: parked subtasks stay
   * parked; queued starts re-enter the queue in held order (manual entries
   * keep the front) and drain immediately under the current budget. Call
   * once after activation/reconcile.
   */
  async restore(): Promise<void> {
    if (this.options.isSessionLive !== undefined) {
      for (const link of await this.options.links.listLinks()) {
        if (link.sessionId === undefined || link.subtaskId === undefined || !this.options.isSessionLive(link.sessionId)) continue;
        this.running.add(link.subtaskId);
        this.sessionToSubtask.set(link.sessionId, link.subtaskId);
        // A restored run's original automation intent is not durable. Treat it
        // as manual so an adopted failure is never retried speculatively.
        this.originOf.set(link.subtaskId, "manual");
      }
    }
    if (this.options.holds === undefined) return;
    const holds = await this.options.holds.listHolds();
    const manual: typeof this.queue = [];
    const automatic: typeof this.queue = [];
    for (const hold of holds) {
      if (hold.kind === "parked") {
        this.parked.add(hold.subtaskId);
        continue;
      }
      if (
        this.queue.some((entry) => entry.subtaskId === hold.subtaskId) ||
        manual.some((entry) => entry.subtaskId === hold.subtaskId) ||
        automatic.some((entry) => entry.subtaskId === hold.subtaskId)
      ) continue;
      const entry = { subtaskId: hold.subtaskId, force: hold.force, origin: hold.origin };
      if (hold.origin === "manual") manual.push(entry);
      else automatic.push(entry);
    }
    // listHolds is oldest-first. Spread-unshift keeps that order while still
    // restoring manual priority ahead of automatic queue entries.
    this.queue.unshift(...manual);
    this.queue.push(...automatic);
    if (holds.length === 0) return;
    this.options.logger.info("orchestrator holds restored", { queued: this.queue.length, parked: this.parked.size });
    this.options.bus.publish({ kind: "board-changed" });
    await this.drainQueue();
  }

  /** Best-effort durable mirror of a hold transition (ADR 0015). */
  private mirrorHold(subtaskId: SubtaskId, kind: "queued" | "parked", origin: "manual" | "auto", force: boolean): void {
    void this.options.holds?.upsertHold({ subtaskId, kind, origin, force, heldAt: new Date().toISOString() }).catch((error: unknown) => {
      this.options.logger.warn("hold mirror failed", { subtaskId, kind, error: error instanceof Error ? error.message : String(error) });
    });
  }

  private clearHold(subtaskId: SubtaskId): void {
    void this.options.holds?.deleteHold(subtaskId).catch((error: unknown) => {
      this.options.logger.warn("hold clear failed", { subtaskId, error: error instanceof Error ? error.message : String(error) });
    });
  }

  isRunning(subtaskId: string): boolean {
    const id = asId<"SubtaskId">(subtaskId);
    return this.running.has(id) || this.starting.has(id);
  }

  lastFailure(subtaskId: string): { readonly at: string; readonly runId?: string } | undefined {
    return this.failures.get(asId<"SubtaskId">(subtaskId));
  }

  /** Held back by the run-slot budget (ADR 0015); starts when a slot frees. */
  isQueued(subtaskId: string): boolean {
    const id = asId<"SubtaskId">(subtaskId);
    return this.queue.some((entry) => entry.subtaskId === id);
  }

  /** Auto run failed twice; automation gave up until a manual start (↻). */
  isParked(subtaskId: string): boolean {
    return this.parked.has(asId<"SubtaskId">(subtaskId));
  }

  /**
   * Manual (or cascade-driven, with force=false) start of one subtask.
   * Refuses BLOCKED (any upstream not done) unless `force` is set; force is a
   * manual-only override — evaluateDependents never passes it.
   */
  async startSubtask(subtaskId: string, options: StartSubtaskOptions = {}): Promise<SubtaskRecord> {
    const id = asId<"SubtaskId">(subtaskId);
    // Claim synchronously, before the first await. A second call for this id
    // can no longer pass the same stale `running` check and launch twice.
    if (this.running.has(id) || this.startClaims.has(id)) {
      throw new StartSubtaskError("ALREADY_RUNNING", `Subtask ${subtaskId} is already running.`);
    }
    this.startClaims.add(id);
    try {
      const subtask = await this.options.subtasks.getSubtask(id);
      if (subtask === null) {
        throw new StartSubtaskError("NOT_FOUND", `Subtask ${subtaskId} was not found.`);
      }
      if (subtask.prompt === undefined || subtask.prompt.length === 0) {
        throw new StartSubtaskError("NO_PROMPT", `Subtask ${subtaskId} has no prompt to start.`);
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

      const origin = options.origin ?? "manual";
      if (origin === "manual") {
        // A human retry (↻) always resets the failure policy.
        if (this.parked.delete(id)) this.clearHold(id);
        this.retried.delete(id);
      }

      // Run-slot budget (ADR 0015): a full fleet holds the start in the
      // visible queue instead of refusing. `starting` is part of the active
      // count: an admitted launch owns its slot across every await below.
      const budget = this.options.maxConcurrentRuns?.() ?? 0;
      if (budget > 0 && this.activeRunCount() >= budget) {
        const existingIndex = this.queue.findIndex((entry) => entry.subtaskId === id);
        const entry = { subtaskId: id, force: options.force === true, origin };
        if (existingIndex >= 0) {
          if (origin === "manual" && existingIndex > 0) {
            this.queue.splice(existingIndex, 1);
            this.queue.unshift(entry);
            this.mirrorHold(id, "queued", origin, entry.force);
            this.options.bus.publish({ kind: "board-changed" });
          }
        } else {
          if (origin === "manual") this.queue.unshift(entry);
          else this.queue.push(entry);
          this.mirrorHold(id, "queued", origin, entry.force);
          this.options.logger.info("run-slot budget full; start queued", { subtaskId, origin, queueDepth: this.queue.length });
          this.options.bus.publish({ kind: "board-changed" });
        }
        return subtask;
      }

      // This synchronous admission is the budget reservation. Do it before
      // dependency lookup or verification re-arming so concurrent starts see
      // the occupied slot rather than oversubscribing the fleet.
      this.starting.add(id);
      let preparedSessionId: string | undefined;
      try {
        // A verification stamp only attests to the previous result. Starting
        // rework re-arms the HITL gate before the new run can produce output.
        if (subtask.verifyMode === "hitl" && subtask.verifiedAt !== undefined) {
          await this.options.subtasks.updateSubtask(id, { verified: false });
        }

        // Upstream ids ride along so the run bridge can honour a stored
        // `upstream` seed choice (ADR 0014) without re-deriving the DAG.
        const dependsOn = (await this.options.subtasks.listDependenciesForTask(subtask.taskId))
          .filter((edge) => edge.toSubtaskId === id)
          .map((edge) => edge.fromSubtaskId as string);
        this.running.add(id);
        this.starting.delete(id);
        this.startClaims.delete(id);
        this.originOf.set(id, origin);
        const prepared = await this.options.startRun({
          taskId: subtask.taskId,
          subtaskId: id,
          prompt: subtask.prompt,
          title: subtask.title,
          ...(subtask.seedMode === undefined ? {} : { seedMode: subtask.seedMode }),
          dependsOn,
          ...(subtask.model === undefined ? {} : { model: subtask.model })
        });
        const { sessionId } = prepared;
        preparedSessionId = sessionId;
        this.sessionToSubtask.set(sessionId, id);
        await this.options.links.link(subtask.taskId, { sessionId, subtaskId: id });
        const inProgress = await this.options.board.firstColumnOf("in-progress");
        await this.options.subtasks.moveCard({ subtaskId: id }, inProgress.columnId);
        this.options.bus.publish({ kind: "board-changed" });
        // The session is now fully discoverable by a synchronous or otherwise
        // immediate turn-completed event. Dispatch remains detached; its
        // terminal status returns through the product bus.
        prepared.dispatchFirstTurn();
        const updated = await this.options.subtasks.getSubtask(id);
        return updated ?? subtask;
      } catch (error) {
        this.running.delete(id);
        this.starting.delete(id);
        this.originOf.delete(id);
        if (preparedSessionId !== undefined) {
          this.sessionToSubtask.delete(preparedSessionId);
        }
        throw error;
      }
    } finally {
      this.startClaims.delete(id);
    }
  }

  /**
   * Starts queued entries while the budget has room, strictly one at a time
   * (each start is awaited so `running` grows before the next budget check —
   * never overshooting the slot count). A queued entry that no longer
   * qualifies (moved to done, deleted, prompt cleared) is skipped with a log
   * line and the drain continues.
   */
  private async drainQueue(): Promise<void> {
    const activeDrain = this.drainPromise;
    if (activeDrain !== undefined) {
      await activeDrain;
      return;
    }
    const drain = this.drainQueuedStarts();
    this.drainPromise = drain;
    try {
      await drain;
    } finally {
      if (this.drainPromise === drain) this.drainPromise = undefined;
    }
  }

  private async drainQueuedStarts(): Promise<void> {
    while (this.queue.length > 0) {
      const budget = this.options.maxConcurrentRuns?.() ?? 0;
      if (budget > 0 && this.activeRunCount() >= budget) return;
      const next = this.queue.shift();
      if (next === undefined) return;
      // The hold clears as the entry leaves the queue; a re-queue (budget
      // refilled meanwhile) re-mirrors, a successful start needs no hold.
      this.clearHold(next.subtaskId);
      try {
        await this.startSubtask(next.subtaskId, { force: next.force, origin: next.origin });
      } catch (error) {
        this.options.logger.warn("queued start no longer applies; skipped", {
          subtaskId: next.subtaskId,
          error: error instanceof Error ? error.message : String(error)
        });
        this.options.bus.publish({ kind: "board-changed" });
      }
    }
  }

  private activeRunCount(): number {
    return this.running.size + this.starting.size;
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
    let queued = 0;
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        const subtask = ready[index];
        if (subtask !== undefined && this.isQueued(subtask.subtaskId)) queued += 1;
        else started += 1;
      } else {
        skipped += 1;
        this.options.logger.warn("subtask auto-start failed during startTask", {
          taskId,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason)
        });
      }
    }
    return { started, queued, skipped };
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

      // Parked dependents stay parked: automation already gave up on them.
      const startable = eligible.filter((dependent) => !this.parked.has(dependent.subtaskId));
      const results = await Promise.allSettled(startable.map((dependent) => this.startSubtask(dependent.subtaskId, { force: false, origin: "auto" })));
      for (const [index, result] of results.entries()) {
        if (result.status === "rejected") {
          const failedSubtaskId = startable[index]?.subtaskId;
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
      const subtaskId = asId<"SubtaskId">(event.subtaskId);
      // Record the gate synchronously, before another done event can evaluate
      // a shared dependent in a concurrently completing diamond.
      const hookOutcome = this.runCardEnteredDoneHook(event.taskId, subtaskId);
      this.doneEntryHookOutcomes.set(subtaskId, hookOutcome);
      void (async () => {
        if (!(await hookOutcome)) return;
        await this.evaluateDependents(subtaskId);
      })().catch((error: unknown) => {
        this.options.logger.warn("subtask orchestrator dependent evaluation failed", {
          subtaskId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
  }

  private async runCardEnteredDoneHook(taskId: string, subtaskId: SubtaskId): Promise<boolean> {
    if (this.options.onCardEnteredDone === undefined) return true;
    try {
      await this.options.onCardEnteredDone({ taskId, subtaskId });
      return true;
    } catch (error) {
      this.options.logger.warn("card-entered-done hook failed; dependent auto-start skipped", {
        taskId,
        subtaskId,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  private async onTurnCompleted(sessionId: string, status: "completed" | "failed" | "cancelled"): Promise<void> {
    const subtaskId = await this.resolveSubtaskForSession(sessionId);
    if (subtaskId === undefined) {
      // Unknown session (not a subtask-linked run, e.g. a plain chat) — ignore.
      return;
    }
    this.running.delete(subtaskId);
    const origin = this.originOf.get(subtaskId) ?? "manual";
    this.originOf.delete(subtaskId);
    if (status !== "completed") {
      this.failures.set(subtaskId, { at: new Date().toISOString() });
      // Retry-then-park (ADR 0015), auto runs only: one automatic retry,
      // then automation gives up and parks — the ↻ (a manual start) resumes.
      // A CANCELLED run is a human gesture, never retried or parked.
      if (status === "failed" && origin === "auto") {
        if (!this.retried.has(subtaskId)) {
          this.retried.add(subtaskId);
          this.options.logger.info("auto run failed; retrying once", { subtaskId });
          void this.startSubtask(subtaskId, { force: false, origin: "auto" }).catch((error: unknown) => {
            this.options.logger.warn("auto retry failed to start", {
              subtaskId,
              error: error instanceof Error ? error.message : String(error)
            });
          });
        } else {
          this.parked.add(subtaskId);
          this.mirrorHold(subtaskId, "parked", origin, false);
          this.options.logger.warn("auto run failed twice; parked (manual ↻ resumes)", { subtaskId });
        }
      }
      this.options.bus.publish({ kind: "board-changed" });
      await this.drainQueue();
      return;
    }
    this.retried.delete(subtaskId);
    if (this.parked.delete(subtaskId)) this.clearHold(subtaskId);
    const doneColumn = await this.options.board.firstColumnOf("done");
    // moveCard stamps doneAt and (since the destination is a done-category
    // column) fires "card-entered-done" itself, which drives the cascade —
    // this handler does not call evaluateDependents directly.
    await this.options.subtasks.moveCard({ subtaskId }, doneColumn.columnId);
    this.options.bus.publish({ kind: "board-changed" });
    await this.drainQueue();
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
    if (
      this.running.has(subtask.subtaskId) ||
      this.starting.has(subtask.subtaskId) ||
      this.startClaims.has(subtask.subtaskId) ||
      this.queue.some((entry) => entry.subtaskId === subtask.subtaskId)
    ) {
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
    if (
      this.running.has(dependent.subtaskId) ||
      this.starting.has(dependent.subtaskId) ||
      this.startClaims.has(dependent.subtaskId) ||
      this.queue.some((entry) => entry.subtaskId === dependent.subtaskId) ||
      this.parked.has(dependent.subtaskId)
    ) {
      return false;
    }
    const upstreamIds = dependencies.filter((edge) => edge.toSubtaskId === dependent.subtaskId).map((edge) => edge.fromSubtaskId);
    for (const upstreamId of upstreamIds) {
      const hookOutcome = this.doneEntryHookOutcomes.get(upstreamId);
      if (hookOutcome !== undefined && !(await hookOutcome)) {
        return false;
      }
    }
    const allUpstreamDone = upstreamIds.every((upstreamId) => {
      const upstream = siblingsById.get(upstreamId);
      return upstream !== undefined && columnsById.get(upstream.columnId)?.category === "done";
    });
    return allUpstreamDone;
  }
}
