/**
 * Unit tests for SubtaskOrchestrator: manual start (BLOCKED/force/typed
 * errors), completion-driven cascade (autoStart fan-out, backlog exclusion,
 * promptless dependents, diamond dependencies), failure (no cascade), manual
 * card-entered-done, unknown sessions, and the re-entrancy guard.
 *
 * In-memory fakes throughout (no sqlite, no vscode), mirroring
 * subtaskService.test.ts / boardService.test.ts.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { asId } from "@drydock/contracts";
import type {
  BoardColumnRecord,
  ColumnCategory,
  SubtaskDependencyRecord,
  SubtaskRecord,
  WorkTaskLinkRecord
} from "@drydock/contracts";
import { MemoryLogger, ProductEventBus } from "@drydock/core";
import {
  SubtaskOrchestrator,
  StartSubtaskError,
  type OrchestratorBoardPort,
  type OrchestratorLinkPort,
  type OrchestratorSubtaskPort,
  type StartSubtaskRun
} from "./subtaskOrchestrator.js";

const NOW = "2026-07-06T00:00:00.000Z";

const DEFAULT_COLUMNS: readonly BoardColumnRecord[] = [
  { columnId: asId<"ColumnId">("col-backlog"), name: "Backlog", category: "backlog", sortOrder: 0 },
  { columnId: asId<"ColumnId">("col-todo"), name: "ToDo", category: "pending", sortOrder: 1 },
  { columnId: asId<"ColumnId">("col-blocked"), name: "Blocked", category: "pending", sortOrder: 2 },
  { columnId: asId<"ColumnId">("col-in-progress"), name: "In Progress", category: "in-progress", sortOrder: 3 },
  { columnId: asId<"ColumnId">("col-review"), name: "Review", category: "done", sortOrder: 4 },
  { columnId: asId<"ColumnId">("col-finished"), name: "Finished", category: "done", sortOrder: 5 }
];

class FakeBoard implements OrchestratorBoardPort {
  private readonly columns = new Map<string, BoardColumnRecord>(DEFAULT_COLUMNS.map((c) => [c.columnId as string, c]));

  listColumns(): Promise<BoardColumnRecord[]> {
    return Promise.resolve([...this.columns.values()].sort((a, b) => a.sortOrder - b.sortOrder));
  }

  async firstColumnOf(category: ColumnCategory): Promise<BoardColumnRecord> {
    const found = (await this.listColumns()).find((c) => c.category === category);
    if (found === undefined) throw new Error(`no column in category ${category}`);
    return found;
  }
}

class FakeSubtasks implements OrchestratorSubtaskPort {
  readonly subtasks = new Map<string, SubtaskRecord>();
  readonly dependencies: SubtaskDependencyRecord[] = [];
  readonly movedTo: { subtaskId: string; columnId: string }[] = [];
  updateGate: Promise<void> | undefined;

  /**
   * Bus is wired in after construction (harness() ties the knot) so this fake
   * can replicate SubtaskService.moveCard's real behaviour: publishing
   * "card-entered-done" whenever a subtask transitions into a done-category
   * column. Without this, the orchestrator's own completion-driven moveCard
   * would never trigger a cascade in tests, unlike production.
   */
  bus: ProductEventBus | undefined;

  add(record: SubtaskRecord): void {
    this.subtasks.set(record.subtaskId, record);
  }

  addDependency(fromSubtaskId: string, toSubtaskId: string, taskId: string): void {
    this.dependencies.push({
      taskId: asId<"TaskId">(taskId),
      fromSubtaskId: asId<"SubtaskId">(fromSubtaskId),
      toSubtaskId: asId<"SubtaskId">(toSubtaskId),
      createdAt: NOW
    });
  }

  getSubtask(subtaskId: string): Promise<SubtaskRecord | null> {
    return Promise.resolve(this.subtasks.get(subtaskId) ?? null);
  }

  listForTask(taskId: string): Promise<SubtaskRecord[]> {
    return Promise.resolve([...this.subtasks.values()].filter((s) => s.taskId === taskId));
  }

  listDependenciesForTask(taskId: string): Promise<SubtaskDependencyRecord[]> {
    return Promise.resolve(this.dependencies.filter((edge) => edge.taskId === taskId));
  }

  async updateSubtask(subtaskId: string, input: { readonly verified: false }): Promise<SubtaskRecord> {
    await this.updateGate;
    const existing = this.subtasks.get(subtaskId);
    if (existing === undefined) throw new Error(`subtask ${subtaskId} not found`);
    const next = { ...existing };
    if (!input.verified) delete (next as { verifiedAt?: string }).verifiedAt;
    this.subtasks.set(subtaskId, next);
    return next;
  }

  moveCard(card: { readonly subtaskId: string }, columnId: string): Promise<SubtaskRecord> {
    this.movedTo.push({ subtaskId: card.subtaskId, columnId });
    const existing = this.subtasks.get(card.subtaskId);
    if (existing === undefined) throw new Error(`subtask ${card.subtaskId} not found`);
    const columns = new Map(DEFAULT_COLUMNS.map((c) => [c.columnId as string, c]));
    const destination = columns.get(columnId);
    const doneAt = destination?.category === "done" ? NOW : undefined;
    const next: SubtaskRecord = { ...existing, columnId: asId<"ColumnId">(columnId), ...(doneAt === undefined ? {} : { doneAt }) };
    if (doneAt === undefined) delete (next as { doneAt?: string }).doneAt;
    this.subtasks.set(card.subtaskId, next);
    // Mirrors SubtaskService.moveCard: fire card-entered-done on every
    // transition into a done-category column (manual or orchestrator-driven).
    if (destination?.category === "done") {
      this.bus?.publish({ kind: "card-entered-done", taskId: next.taskId, subtaskId: next.subtaskId });
    }
    return Promise.resolve(next);
  }

  update(subtaskId: string, patch: Partial<SubtaskRecord>): void {
    const existing = this.subtasks.get(subtaskId);
    if (existing === undefined) return;
    this.subtasks.set(subtaskId, { ...existing, ...patch });
  }
}

class FakeLinks implements OrchestratorLinkPort {
  readonly links: WorkTaskLinkRecord[] = [];

  link(taskId: string, target: { readonly sessionId: string; readonly subtaskId?: string }): Promise<void> {
    this.links.push({
      taskId: asId<"TaskId">(taskId),
      sessionId: asId<"SessionId">(target.sessionId),
      ...(target.subtaskId === undefined ? {} : { subtaskId: asId<"SubtaskId">(target.subtaskId) }),
      createdAt: NOW
    });
    return Promise.resolve();
  }

  listLinks(): Promise<WorkTaskLinkRecord[]> {
    return Promise.resolve([...this.links]);
  }
}

function subtask(input: {
  subtaskId: string;
  taskId: string;
  columnId?: string;
  prompt?: string;
  autoStart?: boolean;
  verifyMode?: "hitl";
  verifiedAt?: string;
}): SubtaskRecord {
  return {
    subtaskId: asId<"SubtaskId">(input.subtaskId),
    taskId: asId<"TaskId">(input.taskId),
    title: input.subtaskId,
    origin: "manual",
    autoStart: input.autoStart ?? false,
    columnId: asId<"ColumnId">(input.columnId ?? "col-todo"),
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
    ...(input.verifyMode === undefined ? {} : { verifyMode: input.verifyMode }),
    ...(input.verifiedAt === undefined ? {} : { verifiedAt: input.verifiedAt })
  };
}

interface Harness {
  orchestrator: SubtaskOrchestrator;
  subtasks: FakeSubtasks;
  board: FakeBoard;
  links: FakeLinks;
  bus: ProductEventBus;
  logger: MemoryLogger;
  startRun: StartSubtaskRun;
  startCalls: Parameters<StartSubtaskRun>[0][];
  sessionCounter: { n: number };
}

function harness(startRunImpl?: StartSubtaskRun, extra?: {
  maxConcurrentRuns?: () => number;
  onCardEnteredDone?: (input: { readonly taskId: string; readonly subtaskId: string }) => Promise<void>;
}): Harness {
  const subtasks = new FakeSubtasks();
  const board = new FakeBoard();
  const links = new FakeLinks();
  const bus = new ProductEventBus();
  subtasks.bus = bus;
  const logger = new MemoryLogger();
  const startCalls: Parameters<StartSubtaskRun>[0][] = [];
  const sessionCounter = { n: 0 };
  const startRun: StartSubtaskRun = async (input) => {
    startCalls.push(input);
    if (startRunImpl !== undefined) {
      return startRunImpl(input);
    }
    sessionCounter.n += 1;
    return { sessionId: `session-${sessionCounter.n}`, dispatchFirstTurn: () => undefined };
  };
  const orchestrator = new SubtaskOrchestrator({
    subtasks,
    board,
    links,
    bus,
    startRun,
    logger,
    ...(extra?.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: extra.maxConcurrentRuns }),
    ...(extra?.onCardEnteredDone === undefined ? {} : { onCardEnteredDone: extra.onCardEnteredDone })
  });
  return { orchestrator, subtasks, board, links, bus, logger, startRun, startCalls, sessionCounter };
}

/** Completes the most recently started run (by call order) with the given status. */
async function completeRun(h: Harness, sessionId: string, status: "completed" | "failed" | "cancelled"): Promise<void> {
  h.bus.publish({ kind: "turn-completed", sessionId: asId<"SessionId">(sessionId), runId: asId<"RunId">(`run-${sessionId}`), status });
  // turn-completed handling is async (fire-and-forget inside the bus
  // subscriber); flush microtasks so the resulting moveCard/cascade lands.
  await flush();
}

/**
 * Drains pending microtasks/macrotasks so a fire-and-forget bus handler chain
 * (turn-completed -> moveCard -> card-entered-done -> evaluateDependents ->
 * Promise.allSettled -> startSubtask -> startRun) fully settles before
 * assertions run. A handful of setImmediate hops covers every await in that
 * chain with margin to spare.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("default autoStart=false: completion does not cascade to a dependent", async () => {
  const h = harness();
  h.subtasks.add(subtask({ subtaskId: "a", taskId: "task-1", prompt: "do a" }));
  h.subtasks.add(subtask({ subtaskId: "b", taskId: "task-1", prompt: "do b", autoStart: false }));
  h.subtasks.addDependency("a", "b", "task-1");

  await h.orchestrator.startSubtask("a");
  assert.equal(h.startCalls.length, 1);
  await completeRun(h, "session-1", "completed");

  assert.equal(h.startCalls.length, 1, "dependent b must not auto-start when its autoStart flag is off");
  assert.equal((await h.subtasks.getSubtask("a"))?.columnId, "col-review");
});

test("an immediately completing first turn is observed after orchestration state commits", async () => {
  let h: Harness;
  h = harness(async () => ({
    sessionId: "session-immediate",
    dispatchFirstTurn: () => {
      h.bus.publish({
        kind: "turn-completed",
        sessionId: asId<"SessionId">("session-immediate"),
        runId: asId<"RunId">("run-immediate"),
        status: "completed"
      });
    }
  }));
  h.subtasks.add(subtask({ subtaskId: "a", taskId: "task-1", prompt: "do a" }));

  await h.orchestrator.startSubtask("a");
  await flush();

  assert.deepEqual(h.links.links.map((link) => link.sessionId), ["session-immediate"]);
  assert.deepEqual(h.subtasks.movedTo, [
    { subtaskId: "a", columnId: "col-in-progress" },
    { subtaskId: "a", columnId: "col-review" }
  ]);
  assert.equal((await h.subtasks.getSubtask("a"))?.columnId, "col-review");
  assert.equal(h.orchestrator.isRunning("a"), false);
});

test("autoStart=true fans out to several dependents at once", async () => {
  const h = harness();
  h.subtasks.add(subtask({ subtaskId: "a", taskId: "task-1", prompt: "do a" }));
  h.subtasks.add(subtask({ subtaskId: "b", taskId: "task-1", prompt: "do b", autoStart: true }));
  h.subtasks.add(subtask({ subtaskId: "c", taskId: "task-1", prompt: "do c", autoStart: true }));
  h.subtasks.addDependency("a", "b", "task-1");
  h.subtasks.addDependency("a", "c", "task-1");

  await h.orchestrator.startSubtask("a");
  await completeRun(h, "session-1", "completed");

  assert.equal(h.startCalls.length, 3, "both b and c should have started alongside a");
  const startedIds = h.startCalls.map((c) => c.subtaskId).sort();
  assert.deepEqual(startedIds, ["a", "b", "c"]);
  assert.equal((await h.subtasks.getSubtask("b"))?.columnId, "col-in-progress");
  assert.equal((await h.subtasks.getSubtask("c"))?.columnId, "col-in-progress");
});

test("a dependent sitting in a backlog-category column is excluded from cascade", async () => {
  const h = harness();
  h.subtasks.add(subtask({ subtaskId: "a", taskId: "task-1", prompt: "do a" }));
  h.subtasks.add(subtask({ subtaskId: "b", taskId: "task-1", prompt: "do b", autoStart: true, columnId: "col-backlog" }));
  h.subtasks.addDependency("a", "b", "task-1");

  await h.orchestrator.startSubtask("a");
  await completeRun(h, "session-1", "completed");

  assert.equal(h.startCalls.length, 1, "backlog dependent must not auto-start");
  assert.equal((await h.subtasks.getSubtask("b"))?.columnId, "col-backlog");
});

test("a dependent without a prompt is skipped silently (no error, no start)", async () => {
  const h = harness();
  h.subtasks.add(subtask({ subtaskId: "a", taskId: "task-1", prompt: "do a" }));
  h.subtasks.add(subtask({ subtaskId: "b", taskId: "task-1", autoStart: true })); // no prompt
  h.subtasks.addDependency("a", "b", "task-1");

  await h.orchestrator.startSubtask("a");
  await completeRun(h, "session-1", "completed");

  assert.equal(h.startCalls.length, 1);
  assert.equal(h.logger.entries.some((e) => e.level === "warn"), false, "a promptless dependent is silently skipped, not logged as an error");
});

test("manual start is refused BLOCKED while an upstream is unfinished, and allowed with force", async () => {
  const h = harness();
  h.subtasks.add(subtask({ subtaskId: "a", taskId: "task-1", prompt: "do a" }));
  h.subtasks.add(subtask({ subtaskId: "b", taskId: "task-1", prompt: "do b" }));
  h.subtasks.addDependency("a", "b", "task-1");

  await assert.rejects(
    () => h.orchestrator.startSubtask("b"),
    (error: unknown) => error instanceof StartSubtaskError && error.code === "BLOCKED"
  );
  assert.equal(h.startCalls.length, 0);

  await h.orchestrator.startSubtask("b", { force: true });
  assert.equal(h.startCalls.length, 1, "force=true bypasses the BLOCKED refusal");
});

test("startSubtask never starts dependencies (manual start is single-subtask only)", async () => {
  const h = harness();
  h.subtasks.add(subtask({ subtaskId: "a", taskId: "task-1", prompt: "do a" }));
  h.subtasks.add(subtask({ subtaskId: "b", taskId: "task-1", prompt: "do b", autoStart: true }));
  h.subtasks.addDependency("a", "b", "task-1");

  // Starting b directly with force must not also start a.
  await h.orchestrator.startSubtask("b", { force: true });
  assert.equal(h.startCalls.length, 1);
  assert.equal(h.startCalls[0]?.subtaskId, "b");
});

test("typed errors: NOT_FOUND, NO_PROMPT, ALREADY_RUNNING, ALREADY_DONE", async () => {
  const h = harness();
  await assert.rejects(
    () => h.orchestrator.startSubtask("missing"),
    (error: unknown) => error instanceof StartSubtaskError && error.code === "NOT_FOUND"
  );

  h.subtasks.add(subtask({ subtaskId: "no-prompt", taskId: "task-1" }));
  await assert.rejects(
    () => h.orchestrator.startSubtask("no-prompt"),
    (error: unknown) => error instanceof StartSubtaskError && error.code === "NO_PROMPT"
  );

  h.subtasks.add(subtask({ subtaskId: "done-one", taskId: "task-1", prompt: "p", columnId: "col-review" }));
  await assert.rejects(
    () => h.orchestrator.startSubtask("done-one"),
    (error: unknown) => error instanceof StartSubtaskError && error.code === "ALREADY_DONE"
  );

  // ALREADY_RUNNING: never resolve startRun so the subtask stays "running".
  const stuck = harness(() => new Promise(() => { /* never resolves */ }));
  stuck.subtasks.add(subtask({ subtaskId: "slow", taskId: "task-1", prompt: "p" }));
  void stuck.orchestrator.startSubtask("slow");
  await flush();
  await assert.rejects(
    () => stuck.orchestrator.startSubtask("slow"),
    (error: unknown) => error instanceof StartSubtaskError && error.code === "ALREADY_RUNNING"
  );
});

test("concurrent starts atomically claim one subtask and launch it only once", async () => {
  const h = harness();
  h.subtasks.add(subtask({ subtaskId: "same", taskId: "task-1", prompt: "do it once" }));

  const results = await Promise.allSettled([
    h.orchestrator.startSubtask("same"),
    h.orchestrator.startSubtask("same")
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejection = results.find((result) => result.status === "rejected");
  assert.ok(rejection?.status === "rejected");
  assert.ok(rejection.reason instanceof StartSubtaskError);
  assert.equal(rejection.reason.code, "ALREADY_RUNNING");
  assert.equal(h.startCalls.length, 1, "the check/await race must never launch a duplicate session");
  assert.equal(h.links.links.length, 1, "only the winning launch is linked");
});

test("an admitted start reserves its fleet slot across verification re-arming", async () => {
  let releaseUpdate!: () => void;
  const updateGate = new Promise<void>((resolve) => { releaseUpdate = resolve; });
  const h = harness(undefined, { maxConcurrentRuns: () => 1 });
  h.subtasks.updateGate = updateGate;
  h.subtasks.add(subtask({
    subtaskId: "rework",
    taskId: "task-1",
    prompt: "rework",
    verifyMode: "hitl",
    verifiedAt: NOW
  }));
  h.subtasks.add(subtask({ subtaskId: "next", taskId: "task-1", prompt: "next" }));

  const reworkStart = h.orchestrator.startSubtask("rework");
  await flush();
  assert.equal(h.orchestrator.isRunning("rework"), true, "a pre-launch reservation is active state");
  assert.equal(h.startCalls.length, 0, "the run waits for verification to be re-armed");

  const nextStart = h.orchestrator.startSubtask("next", { origin: "auto" });
  await nextStart;
  assert.equal(h.orchestrator.isQueued("next"), true, "the reserved slot counts against the fleet budget");
  assert.equal(h.startCalls.length, 0, "a second launch cannot oversubscribe the reserved slot");

  releaseUpdate();
  await reworkStart;
  assert.equal((await h.subtasks.getSubtask("rework"))?.verifiedAt, undefined);
  assert.deepEqual(h.startCalls.map((call) => call.subtaskId), ["rework"]);

  await completeRun(h, "session-1", "completed");
  assert.deepEqual(h.startCalls.map((call) => call.subtaskId), ["rework", "next"], "the queued start drains in FIFO order");
});

test("a failed run leaves the card in place with no cascade; lastFailure is recorded", async () => {
  const h = harness();
  h.subtasks.add(subtask({ subtaskId: "a", taskId: "task-1", prompt: "do a" }));
  h.subtasks.add(subtask({ subtaskId: "b", taskId: "task-1", prompt: "do b", autoStart: true }));
  h.subtasks.addDependency("a", "b", "task-1");

  await h.orchestrator.startSubtask("a");
  assert.equal(h.orchestrator.isRunning("a"), true);
  await completeRun(h, "session-1", "failed");

  assert.equal(h.startCalls.length, 1, "no cascade on failure");
  assert.equal((await h.subtasks.getSubtask("a"))?.columnId, "col-in-progress", "card stays put on failure");
  assert.equal(h.orchestrator.isRunning("a"), false);
  assert.notEqual(h.orchestrator.lastFailure("a"), undefined);

  // Cancelled behaves the same as failed.
  const h2 = harness();
  h2.subtasks.add(subtask({ subtaskId: "a", taskId: "task-1", prompt: "do a" }));
  await h2.orchestrator.startSubtask("a");
  await completeRun(h2, "session-1", "cancelled");
  assert.equal((await h2.subtasks.getSubtask("a"))?.columnId, "col-in-progress");
  assert.notEqual(h2.orchestrator.lastFailure("a"), undefined);
});

test("manually dragging a subtask into a done column triggers dependent evaluation", async () => {
  const h = harness();
  h.subtasks.add(subtask({ subtaskId: "a", taskId: "task-1", prompt: "do a" }));
  h.subtasks.add(subtask({ subtaskId: "b", taskId: "task-1", prompt: "do b", autoStart: true }));
  h.subtasks.addDependency("a", "b", "task-1");

  // Simulate a manual drag exactly like SubtaskService.moveCard: the card
  // moves into the done column FIRST, then card-entered-done fires (the fake
  // moveCard publishes it, matching the real service's ordering — the
  // orchestrator reads the moved state when it evaluates dependents).
  await h.subtasks.moveCard({ subtaskId: "a" }, "col-review");
  await flush();

  assert.equal(h.startCalls.length, 1);
  assert.equal(h.startCalls[0]?.subtaskId, "b");
});

test("card-entered-done awaits changeset capture before starting dependents", async () => {
  let releaseCapture!: () => void;
  const captureGate = new Promise<void>((resolve) => { releaseCapture = resolve; });
  const hookCalls: Array<{ readonly taskId: string; readonly subtaskId: string }> = [];
  const h = harness(undefined, {
    onCardEnteredDone: async (input) => {
      hookCalls.push(input);
      await captureGate;
    }
  });
  h.subtasks.add(subtask({ subtaskId: "a", taskId: "task-1", prompt: "do a" }));
  h.subtasks.add(subtask({ subtaskId: "b", taskId: "task-1", prompt: "do b", autoStart: true }));
  h.subtasks.addDependency("a", "b", "task-1");

  await h.subtasks.moveCard({ subtaskId: "a" }, "col-review");
  await flush();

  assert.deepEqual(hookCalls, [{ taskId: "task-1", subtaskId: "a" }]);
  assert.equal(h.startCalls.length, 0, "dependent must wait until upstream capture commits");

  releaseCapture();
  await flush();

  assert.deepEqual(h.startCalls.map((call) => call.subtaskId), ["b"]);
});

test("changeset capture failure blocks completion-driven dependent auto-start and logs the safe outcome", async () => {
  const h = harness(undefined, {
    onCardEnteredDone: () => Promise.reject(new Error("capture store unavailable"))
  });
  h.subtasks.add(subtask({ subtaskId: "a", taskId: "task-1", prompt: "do a" }));
  h.subtasks.add(subtask({ subtaskId: "b", taskId: "task-1", prompt: "do b", autoStart: true }));
  h.subtasks.addDependency("a", "b", "task-1");

  await h.orchestrator.startSubtask("a");
  await completeRun(h, "session-1", "completed");

  assert.deepEqual(h.startCalls.map((call) => call.subtaskId), ["a"], "capture failure must stop the cascade");
  assert.equal((await h.subtasks.getSubtask("a"))?.columnId, "col-review", "completed upstream remains visible for recovery");
  assert.equal((await h.subtasks.getSubtask("b"))?.columnId, "col-todo", "dependent remains safely pending");
  const warning = h.logger.entries.find((entry) => entry.message === "card-entered-done hook failed; dependent auto-start skipped");
  assert.deepEqual(warning, {
    level: "warn",
    message: "card-entered-done hook failed; dependent auto-start skipped",
    data: { taskId: "task-1", subtaskId: "a", error: "capture store unavailable" }
  });
});

test("a failed upstream capture blocks a shared dependent when another upstream finishes", async () => {
  const h = harness(undefined, {
    onCardEnteredDone: ({ subtaskId }) => subtaskId === "a"
      ? Promise.reject(new Error("a capture failed"))
      : Promise.resolve()
  });
  h.subtasks.add(subtask({ subtaskId: "a", taskId: "task-1", prompt: "a" }));
  h.subtasks.add(subtask({ subtaskId: "c", taskId: "task-1", prompt: "c" }));
  h.subtasks.add(subtask({ subtaskId: "d", taskId: "task-1", prompt: "d", autoStart: true }));
  h.subtasks.addDependency("a", "d", "task-1");
  h.subtasks.addDependency("c", "d", "task-1");

  await h.subtasks.moveCard({ subtaskId: "a" }, "col-review");
  await flush();
  await h.subtasks.moveCard({ subtaskId: "c" }, "col-review");
  await flush();

  assert.equal((await h.subtasks.getSubtask("d"))?.columnId, "col-todo");
  assert.equal(h.startCalls.length, 0, "another upstream's successful capture must not bypass the failed gate");
});

test("diamond dependency (A->B, A->C, B&C->D): D starts only once both B and C are done", async () => {
  const h = harness();
  h.subtasks.add(subtask({ subtaskId: "a", taskId: "task-1", prompt: "a" }));
  h.subtasks.add(subtask({ subtaskId: "b", taskId: "task-1", prompt: "b", autoStart: true }));
  h.subtasks.add(subtask({ subtaskId: "c", taskId: "task-1", prompt: "c", autoStart: true }));
  h.subtasks.add(subtask({ subtaskId: "d", taskId: "task-1", prompt: "d", autoStart: true }));
  h.subtasks.addDependency("a", "b", "task-1");
  h.subtasks.addDependency("a", "c", "task-1");
  h.subtasks.addDependency("b", "d", "task-1");
  h.subtasks.addDependency("c", "d", "task-1");

  await h.orchestrator.startSubtask("a");
  await completeRun(h, "session-1", "completed"); // finishes a, fans out to b and c

  assert.equal(h.startCalls.map((c) => c.subtaskId).sort().join(","), "a,b,c", "d must not start until both b and c are done");

  // Finish b only: c is still not done, so d must not start yet.
  await completeRun(h, "session-2", "completed");
  assert.equal(h.startCalls.some((c) => c.subtaskId === "d"), false, "d waits for BOTH upstreams");

  // Finish c: now both upstreams of d are done, so d starts.
  await completeRun(h, "session-3", "completed");
  assert.equal(h.startCalls.some((c) => c.subtaskId === "d"), true, "d starts once both b and c are done");
});

test("an unknown sessionId on turn-completed is ignored", async () => {
  const h = harness();
  h.subtasks.add(subtask({ subtaskId: "a", taskId: "task-1", prompt: "a" }));

  await completeRun(h, "session-does-not-exist", "completed");

  assert.equal((await h.subtasks.getSubtask("a"))?.columnId, "col-todo", "unrelated subtask must be untouched");
  assert.equal(h.startCalls.length, 0);
});

test("re-entrancy guard: cascade evaluation for the same subtask does not double-start a dependent", async () => {
  const h = harness();
  h.subtasks.add(subtask({ subtaskId: "a", taskId: "task-1", prompt: "a" }));
  h.subtasks.add(subtask({ subtaskId: "b", taskId: "task-1", prompt: "b", autoStart: true }));
  h.subtasks.addDependency("a", "b", "task-1");

  // Upstream a is done (state precedes the event, as in the real service)...
  h.subtasks.update("a", { columnId: asId<"ColumnId">("col-review"), doneAt: NOW });
  // ...then evaluateDependents("a") fires twice concurrently (as a
  // synchronous bus delivering duplicate card-entered-done events would) —
  // b must only be started once.
  await Promise.all([h.orchestrator.evaluateDependents("a"), h.orchestrator.evaluateDependents("a")]);
  await flush();

  const bStarts = h.startCalls.filter((c) => c.subtaskId === "b");
  assert.equal(bStarts.length, 1, "b must not be started twice by overlapping evaluations");
});

test("startTask starts every ready subtask and reports started/skipped counts", async () => {
  const h = harness();
  h.subtasks.add(subtask({ subtaskId: "ready-1", taskId: "task-1", prompt: "p1" }));
  h.subtasks.add(subtask({ subtaskId: "ready-2", taskId: "task-1", prompt: "p2" }));
  h.subtasks.add(subtask({ subtaskId: "no-prompt", taskId: "task-1" }));
  h.subtasks.add(subtask({ subtaskId: "backlog-item", taskId: "task-1", prompt: "p3", columnId: "col-backlog" }));
  h.subtasks.add(subtask({ subtaskId: "blocked-item", taskId: "task-1", prompt: "p4" }));
  h.subtasks.add(subtask({ subtaskId: "blocker", taskId: "task-1", prompt: "p5" }));
  h.subtasks.addDependency("blocker", "blocked-item", "task-1");

  const result = await h.orchestrator.startTask("task-1");

  assert.equal(result.started, 3, "ready-1, ready-2, blocker are ready; blocked-item, no-prompt, backlog-item are not");
  assert.equal(result.queued, 0);
  assert.equal(result.skipped, 3);
  const startedIds = h.startCalls.map((c) => c.subtaskId).sort();
  assert.deepEqual(startedIds, ["blocker", "ready-1", "ready-2"]);
});

test("startTask reports budget-held work as queued rather than started", async () => {
  const h = harness(undefined, { maxConcurrentRuns: () => 1 });
  h.subtasks.add(subtask({ subtaskId: "ready-1", taskId: "task-1", prompt: "p1" }));
  h.subtasks.add(subtask({ subtaskId: "ready-2", taskId: "task-1", prompt: "p2" }));

  const result = await h.orchestrator.startTask("task-1");

  assert.deepEqual(result, { started: 1, queued: 1, skipped: 0 });
  assert.equal(h.startCalls.length, 1);
});

test("startSubtask records the session->subtask link and moves the card to the first in-progress column", async () => {
  const h = harness();
  h.subtasks.add(subtask({ subtaskId: "a", taskId: "task-1", prompt: "do a" }));

  const updated = await h.orchestrator.startSubtask("a");
  assert.equal(updated.columnId, "col-in-progress");
  assert.equal(h.links.links.length, 1);
  assert.equal(h.links.links[0]?.subtaskId, "a");
  assert.equal(h.links.links[0]?.sessionId, "session-1");
});

// --- Policy rails (ADR 0015) --------------------------------------------------

test("run-slot budget queues excess starts and drains on completion", async () => {
  const h = harness(undefined, { maxConcurrentRuns: () => 1 });
  h.subtasks.add(subtask({ subtaskId: "sub-a", taskId: "task-1", columnId: "col-todo", prompt: "a" }));
  h.subtasks.add(subtask({ subtaskId: "sub-b", taskId: "task-1", columnId: "col-todo", prompt: "b" }));

  await h.orchestrator.startSubtask("sub-a");
  await h.orchestrator.startSubtask("sub-b", { origin: "auto" });

  // Only A actually launched; B waits in the visible queue.
  assert.deepEqual(h.startCalls.map((call) => call.subtaskId), ["sub-a"]);
  assert.equal(h.orchestrator.isQueued("sub-b"), true);
  assert.equal(h.orchestrator.isRunning("sub-b"), false);

  await completeRun(h, "session-1", "completed");
  assert.deepEqual(h.startCalls.map((call) => call.subtaskId), ["sub-a", "sub-b"]);
  assert.equal(h.orchestrator.isQueued("sub-b"), false);
  assert.equal(h.orchestrator.isRunning("sub-b"), true);
});

test("manual starts jump the queue ahead of queued auto starts", async () => {
  const h = harness(undefined, { maxConcurrentRuns: () => 1 });
  h.subtasks.add(subtask({ subtaskId: "sub-a", taskId: "task-1", columnId: "col-todo", prompt: "a" }));
  h.subtasks.add(subtask({ subtaskId: "sub-b", taskId: "task-1", columnId: "col-todo", prompt: "b" }));
  h.subtasks.add(subtask({ subtaskId: "sub-hotfix", taskId: "task-1", columnId: "col-todo", prompt: "hotfix" }));

  await h.orchestrator.startSubtask("sub-a");
  await h.orchestrator.startSubtask("sub-b", { origin: "auto" });
  await h.orchestrator.startSubtask("sub-hotfix"); // manual → front of the queue

  await completeRun(h, "session-1", "completed");
  // The hotfix launched first; B is still queued behind it.
  assert.deepEqual(h.startCalls.map((call) => call.subtaskId), ["sub-a", "sub-hotfix"]);
  assert.equal(h.orchestrator.isQueued("sub-b"), true);

  await completeRun(h, "session-2", "completed");
  assert.deepEqual(h.startCalls.map((call) => call.subtaskId), ["sub-a", "sub-hotfix", "sub-b"]);
});

test("auto runs retry once on failure, then park; manual ↻ clears the park", async () => {
  const h = harness();
  h.subtasks.add(subtask({ subtaskId: "sub-auto", taskId: "task-1", columnId: "col-todo", prompt: "go" }));

  await h.orchestrator.startSubtask("sub-auto", { origin: "auto" });
  assert.equal(h.startCalls.length, 1);

  // First failure: retried automatically (same subtask, origin auto).
  await completeRun(h, "session-1", "failed");
  assert.equal(h.startCalls.length, 2);
  assert.equal(h.orchestrator.isParked("sub-auto"), false);

  // Second failure: parked — automation gives up, no third start.
  await completeRun(h, "session-2", "failed");
  assert.equal(h.startCalls.length, 2);
  assert.equal(h.orchestrator.isParked("sub-auto"), true);

  // A manual start (the ↻) clears the park and runs again.
  await h.orchestrator.startSubtask("sub-auto");
  assert.equal(h.startCalls.length, 3);
  assert.equal(h.orchestrator.isParked("sub-auto"), false);
});

test("manual failures and cancellations never auto-retry", async () => {
  const h = harness();
  h.subtasks.add(subtask({ subtaskId: "sub-m", taskId: "task-1", columnId: "col-todo", prompt: "m" }));
  h.subtasks.add(subtask({ subtaskId: "sub-c", taskId: "task-1", columnId: "col-todo", prompt: "c" }));

  await h.orchestrator.startSubtask("sub-m"); // manual
  await completeRun(h, "session-1", "failed");
  assert.equal(h.startCalls.length, 2 - 1); // no retry fired

  await h.orchestrator.startSubtask("sub-c", { origin: "auto" });
  await completeRun(h, "session-2", "cancelled"); // user gesture
  assert.equal(h.startCalls.filter((call) => call.subtaskId === "sub-c").length, 1);
  assert.equal(h.orchestrator.isParked("sub-c"), false);
});

test("parked dependents are excluded from the cascade", async () => {
  const h = harness();
  h.subtasks.add(subtask({ subtaskId: "sub-up", taskId: "task-1", columnId: "col-todo", prompt: "up" }));
  h.subtasks.add(subtask({ subtaskId: "sub-down", taskId: "task-1", columnId: "col-todo", prompt: "down", autoStart: true }));
  h.subtasks.addDependency("sub-up", "sub-down", "task-1");

  // Upstream completes -> the cascade auto-starts sub-down (session-2)...
  await h.orchestrator.startSubtask("sub-up"); // session-1
  await completeRun(h, "session-1", "completed");
  assert.equal(h.startCalls.filter((call) => call.subtaskId === "sub-down").length, 1);

  // ...which fails, retries once (session-3), fails again, and parks.
  await completeRun(h, "session-2", "failed");
  await completeRun(h, "session-3", "failed");
  assert.equal(h.startCalls.filter((call) => call.subtaskId === "sub-down").length, 2);
  assert.equal(h.orchestrator.isParked("sub-down"), true);

  // Re-firing the cascade (manual re-entry into another done column) skips
  // the parked dependent: automation already gave up on it.
  await h.subtasks.moveCard({ subtaskId: "sub-up" }, "col-finished");
  await flush();
  assert.equal(h.startCalls.filter((call) => call.subtaskId === "sub-down").length, 2);
  assert.equal(h.orchestrator.isParked("sub-down"), true);
});

// --- Continuity (ADR 0015) ----------------------------------------------------

class FakeHoldStore {
  rows = new Map<string, { subtaskId: string; kind: "queued" | "parked"; origin: "manual" | "auto"; force: boolean; heldAt: string }>();

  async upsertHold(record: { subtaskId: string; kind: "queued" | "parked"; origin: "manual" | "auto"; force: boolean; heldAt: string }): Promise<void> {
    this.rows.set(record.subtaskId, record);
  }

  async deleteHold(subtaskId: string): Promise<number> {
    return this.rows.delete(subtaskId) ? 1 : 0;
  }

  async listHolds(): Promise<{ subtaskId: string; kind: "queued" | "parked"; origin: "manual" | "auto"; force: boolean; heldAt: string }[]> {
    return [...this.rows.values()].sort((a, b) => a.heldAt.localeCompare(b.heldAt));
  }
}

function holdsHarness(
  holds: FakeHoldStore,
  maxConcurrentRuns?: () => number,
  isSessionLive?: (sessionId: string) => boolean
): Harness {
  const subtasks = new FakeSubtasks();
  const board = new FakeBoard();
  const links = new FakeLinks();
  const bus = new ProductEventBus();
  subtasks.bus = bus;
  const logger = new MemoryLogger();
  const startCalls: Parameters<StartSubtaskRun>[0][] = [];
  const sessionCounter = { n: 0 };
  const startRun: StartSubtaskRun = async (input) => {
    startCalls.push(input);
    sessionCounter.n += 1;
    return { sessionId: `session-${sessionCounter.n}`, dispatchFirstTurn: () => undefined };
  };
  const orchestrator = new SubtaskOrchestrator({
    subtasks,
    board,
    links,
    bus,
    startRun,
    logger,
    holds: holds as never,
    ...(maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns }),
    ...(isSessionLive === undefined ? {} : { isSessionLive })
  });
  return { orchestrator, subtasks, board, links, bus, logger, startRun, startCalls, sessionCounter };
}

test("holds mirror queue/park transitions durably", async () => {
  const holds = new FakeHoldStore();
  const h = holdsHarness(holds, () => 1);
  h.subtasks.add(subtask({ subtaskId: "sub-a", taskId: "task-1", columnId: "col-todo", prompt: "a" }));
  h.subtasks.add(subtask({ subtaskId: "sub-b", taskId: "task-1", columnId: "col-todo", prompt: "b" }));

  await h.orchestrator.startSubtask("sub-a");
  await h.orchestrator.startSubtask("sub-b", { origin: "auto" });
  await flush();
  assert.equal(holds.rows.get("sub-b")?.kind, "queued");

  // Draining clears the queued hold.
  await completeRun(h, "session-1", "completed");
  await flush();
  assert.equal(holds.rows.has("sub-b"), false);

  // Two failures park sub-b durably; a manual ↻ clears the hold.
  await completeRun(h, "session-2", "failed");
  await completeRun(h, "session-3", "failed");
  await flush();
  assert.equal(holds.rows.get("sub-b")?.kind, "parked");
  await h.orchestrator.startSubtask("sub-b");
  await flush();
  assert.equal(holds.rows.has("sub-b"), false);
});

test("restore reloads holds after a reload: parked stays, queued drains under the budget", async () => {
  const holds = new FakeHoldStore();
  await holds.upsertHold({ subtaskId: "sub-q", kind: "queued", origin: "auto", force: false, heldAt: "2026-07-12T00:00:01.000Z" });
  await holds.upsertHold({ subtaskId: "sub-p", kind: "parked", origin: "auto", force: false, heldAt: "2026-07-12T00:00:02.000Z" });

  // A fresh process (new orchestrator, same store) — like a window reload.
  const h = holdsHarness(holds);
  h.subtasks.add(subtask({ subtaskId: "sub-q", taskId: "task-1", columnId: "col-todo", prompt: "q" }));
  h.subtasks.add(subtask({ subtaskId: "sub-p", taskId: "task-1", columnId: "col-todo", prompt: "p" }));

  await h.orchestrator.restore();
  await flush();

  // The queued start launched; the parked one stayed parked, hold intact.
  assert.deepEqual(h.startCalls.map((call) => call.subtaskId), ["sub-q"]);
  assert.equal(h.orchestrator.isParked("sub-p"), true);
  assert.equal(holds.rows.get("sub-p")?.kind, "parked");
  assert.equal(holds.rows.has("sub-q"), false);
});

test("restore preserves FIFO within manual priority before automatic holds", async () => {
  const holds = new FakeHoldStore();
  await holds.upsertHold({ subtaskId: "sub-m1", kind: "queued", origin: "manual", force: false, heldAt: "2026-07-12T00:00:01.000Z" });
  await holds.upsertHold({ subtaskId: "sub-a1", kind: "queued", origin: "auto", force: false, heldAt: "2026-07-12T00:00:02.000Z" });
  await holds.upsertHold({ subtaskId: "sub-m2", kind: "queued", origin: "manual", force: false, heldAt: "2026-07-12T00:00:03.000Z" });

  const h = holdsHarness(holds, () => 1);
  h.subtasks.add(subtask({ subtaskId: "sub-m1", taskId: "task-1", columnId: "col-todo", prompt: "m1" }));
  h.subtasks.add(subtask({ subtaskId: "sub-m2", taskId: "task-1", columnId: "col-todo", prompt: "m2" }));
  h.subtasks.add(subtask({ subtaskId: "sub-a1", taskId: "task-1", columnId: "col-todo", prompt: "a1" }));

  await h.orchestrator.restore();
  assert.deepEqual(h.startCalls.map((call) => call.subtaskId), ["sub-m1"]);
  await completeRun(h, "session-1", "completed");
  assert.deepEqual(h.startCalls.map((call) => call.subtaskId), ["sub-m1", "sub-m2"]);
  await completeRun(h, "session-2", "completed");
  assert.deepEqual(h.startCalls.map((call) => call.subtaskId), ["sub-m1", "sub-m2", "sub-a1"]);
});

test("restored live sessions consume the fleet budget before queued holds drain", async () => {
  const holds = new FakeHoldStore();
  await holds.upsertHold({ subtaskId: "sub-q", kind: "queued", origin: "auto", force: false, heldAt: "2026-07-12T00:00:01.000Z" });
  const h = holdsHarness(holds, () => 1, (candidate) => candidate === "session-live");
  h.subtasks.add(subtask({ subtaskId: "sub-live", taskId: "task-1", columnId: "col-in-progress", prompt: "live" }));
  h.subtasks.add(subtask({ subtaskId: "sub-q", taskId: "task-1", columnId: "col-todo", prompt: "queued" }));
  await h.links.link("task-1", { sessionId: "session-live", subtaskId: "sub-live" });

  await h.orchestrator.restore();
  assert.equal(h.startCalls.length, 0, "the adopted live run owns the only fleet slot");

  await completeRun(h, "session-live", "completed");
  assert.deepEqual(h.startCalls.map((call) => call.subtaskId), ["sub-q"]);
});
