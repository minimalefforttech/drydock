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
  ColumnId,
  SubtaskDependencyRecord,
  SubtaskId,
  SubtaskRecord,
  SubtaskUpdate,
  TaskId,
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
    ...(input.prompt === undefined ? {} : { prompt: input.prompt })
  };
}

interface Harness {
  orchestrator: SubtaskOrchestrator;
  subtasks: FakeSubtasks;
  board: FakeBoard;
  links: FakeLinks;
  bus: ProductEventBus;
  logger: MemoryLogger;
  startRun: (input: { taskId: string; subtaskId: string; prompt: string; title: string }) => Promise<{ sessionId: string }>;
  startCalls: { taskId: string; subtaskId: string; prompt: string; title: string }[];
  sessionCounter: { n: number };
}

function harness(startRunImpl?: StartSubtaskRun): Harness {
  const subtasks = new FakeSubtasks();
  const board = new FakeBoard();
  const links = new FakeLinks();
  const bus = new ProductEventBus();
  subtasks.bus = bus;
  const logger = new MemoryLogger();
  const startCalls: { taskId: string; subtaskId: string; prompt: string; title: string }[] = [];
  const sessionCounter = { n: 0 };
  const startRun: StartSubtaskRun = async (input) => {
    startCalls.push(input);
    if (startRunImpl !== undefined) {
      return startRunImpl(input);
    }
    sessionCounter.n += 1;
    return { sessionId: `session-${sessionCounter.n}` };
  };
  const orchestrator = new SubtaskOrchestrator({ subtasks, board, links, bus, startRun, logger });
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
  assert.equal(result.skipped, 3);
  const startedIds = h.startCalls.map((c) => c.subtaskId).sort();
  assert.deepEqual(startedIds, ["blocker", "ready-1", "ready-2"]);
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
