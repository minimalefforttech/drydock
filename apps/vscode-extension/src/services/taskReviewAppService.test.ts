/**
 * Unit tests for cross-project task-review aggregation and submit.
 *
 * The three ports (task/session/diff) are stubbed as plain objects so no docker
 * or chat runtime boots; the review side is a REAL CodeReviewService over an
 * in-memory SqliteReviewStore, so the compose→delegate flow and the per-session
 * open-comment joins exercise the true store (mirroring planDocsAppService.test).
 * The diff port's reviewState reads back from that same review service, keeping
 * the aggregation counts and the composer in lockstep.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  asId,
  type ChatModelSelection,
  type ChatSessionRecord,
  type CloneRepoState,
  type DiffFileSummary,
  type ReviewCommentSummary,
  type SessionMode,
  type WorkTaskRecord,
  type WorkTaskSummary
} from "@drydock/contracts";
import { CodeReviewService, MemoryLogger, RandomIdGenerator, SystemClock } from "@drydock/core";
import { applyMigrations, SqliteConnection, SqliteReviewStore } from "@drydock/storage-sqlite";
import type { ChatWorkspaceContext } from "./isolatedRunService.js";
import {
  TaskReviewAppService,
  type TaskReviewDiffPort,
  type TaskReviewSessionPort,
  type TaskReviewTaskPort
} from "./taskReviewAppService.js";

const HOST_INSTANCE_ID = "host-here";

/** A mutable, hand-driven session port; each field defaults to an inert value. */
class SessionPortStub implements TaskReviewSessionPort {
  readonly records: ChatSessionRecord[] = [];
  readonly cloneStates = new Map<string, CloneRepoState[]>();
  readonly cloneStateThrows = new Set<string>();
  readonly cloneSessions = new Set<string>();
  readonly liveSessions = new Set<string>();
  readonly activeTurns = new Set<string>();
  readonly modes = new Map<string, SessionMode>();
  hostInstanceId = HOST_INSTANCE_ID;
  freshHeartbeat = true;
  readonly sentTurns: { sessionId: string; prompt: string }[] = [];
  readonly resumed: { sessionId: string; workspace?: ChatWorkspaceContext }[] = [];
  resumeThrows = false;

  listChatSessions(): Promise<ChatSessionRecord[]> {
    return Promise.resolve(this.records);
  }
  cloneState(sessionId: string): Promise<CloneRepoState[]> {
    if (this.cloneStateThrows.has(sessionId)) {
      return Promise.reject(new Error("clone session not live"));
    }
    return Promise.resolve(this.cloneStates.get(sessionId) ?? []);
  }
  isCloneSession(sessionId: string): boolean {
    return this.cloneSessions.has(sessionId);
  }
  isChatSessionLive(sessionId: string): boolean {
    return this.liveSessions.has(sessionId);
  }
  hasActiveChatTurn(sessionId: string): boolean {
    return this.activeTurns.has(sessionId);
  }
  isHeartbeatFresh(): boolean {
    return this.freshHeartbeat;
  }
  sendChatTurn(sessionId: string, prompt: string): Promise<unknown> {
    this.sentTurns.push({ sessionId, prompt });
    return Promise.resolve(undefined);
  }
  resumeChatSession(sessionId: string, _model?: ChatModelSelection, workspace?: ChatWorkspaceContext): Promise<unknown> {
    this.resumed.push({ sessionId, ...(workspace === undefined ? {} : { workspace }) });
    if (this.resumeThrows) {
      return Promise.reject(new Error("resume boom"));
    }
    return Promise.resolve(undefined);
  }
  getSessionMode(sessionId: string): SessionMode {
    return this.modes.get(sessionId) ?? "implementation";
  }
}

/** A task port backed by a fixed set of records + summaries. */
class TaskPortStub implements TaskReviewTaskPort {
  readonly tasks = new Map<string, WorkTaskRecord>();
  readonly summaries: WorkTaskSummary[] = [];
  getTask(taskId: string): Promise<WorkTaskRecord | null> {
    return Promise.resolve(this.tasks.get(taskId) ?? null);
  }
  listTaskSummaries(): Promise<WorkTaskSummary[]> {
    return Promise.resolve(this.summaries);
  }
}

interface Harness {
  readonly service: TaskReviewAppService;
  readonly review: CodeReviewService;
  readonly sessions: SessionPortStub;
  readonly tasks: TaskPortStub;
  readonly diffStatuses: Map<string, DiffFileSummary[]>;
  close(): void;
  cleanup(): Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-taskreview-"));
  const connection = new SqliteConnection(path.join(dir, "task-review.sqlite"));
  applyMigrations(connection);
  const clock = new SystemClock();
  const ids = new RandomIdGenerator();
  const review = new CodeReviewService({ ids, clock, store: new SqliteReviewStore(connection) });

  const sessions = new SessionPortStub();
  const tasks = new TaskPortStub();
  const diffStatuses = new Map<string, DiffFileSummary[]>();

  // The diff port reads open comments straight from the real review service so
  // the aggregation join and the composer see one truth.
  const diffs: TaskReviewDiffPort = {
    diffStatus: (sessionId?: string) => Promise.resolve(sessionId === undefined ? [] : diffStatuses.get(sessionId) ?? []),
    reviewState: async (sessionId?: string) => {
      const scope = await review.ensureReviewSession("current-session", asId<"SessionId">(sessionId ?? ""));
      const comments = await review.listComments(scope.reviewSessionId);
      return {
        reviewSessionId: scope.reviewSessionId,
        comments: comments.map((c): ReviewCommentSummary => ({
          commentId: c.commentId,
          filePath: c.filePath,
          startLine: c.startLine,
          endLine: c.endLine,
          body: c.body,
          author: c.author,
          status: c.status,
          createdAt: c.createdAt
        }))
      };
    }
  };

  const service = new TaskReviewAppService({ logger: new MemoryLogger(), tasks, sessions, diffs, review });
  return {
    service,
    review,
    sessions,
    tasks,
    diffStatuses,
    close: () => connection.close(),
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

/** Registers a task record + summary linking the given sessions. */
function seedTask(harness: Harness, taskId: string, title: string, linkedSessionIds: string[]): void {
  const now = new Date().toISOString();
  harness.tasks.tasks.set(taskId, { taskId: asId<"TaskId">(taskId), title, state: "todo", columnId: asId<"ColumnId">("col-todo"), createdAt: now, updatedAt: now });
  harness.tasks.summaries.push({
    taskId: asId<"TaskId">(taskId),
    title,
    state: "todo",
    columnId: asId<"ColumnId">("col-todo"),
    linkedWorkspaceSetIds: [],
    linkedSessionIds: linkedSessionIds.map((id) => asId<"SessionId">(id)),
    createdAt: now,
    updatedAt: now,
    subtasks: []
  });
}

/** Registers a session record; mode/status default to a plain live-elsewhere-safe implementation. */
function seedSession(harness: Harness, sessionId: string, title: string, overrides: Partial<ChatSessionRecord> = {}): void {
  const now = new Date().toISOString();
  harness.sessions.records.push({
    sessionId: asId<"SessionId">(sessionId),
    chatId: asId<"ChatId">(`chat-${sessionId}`),
    title,
    status: "ended",
    providerId: "codex",
    transport: "codex-app-server",
    createdAt: now,
    updatedAt: now,
    ...overrides
  });
}

async function addOpenComment(
  review: CodeReviewService,
  sessionId: string,
  filePath: string,
  line: number,
  body: string
): Promise<string> {
  const scope = await review.ensureReviewSession("current-session", asId<"SessionId">(sessionId));
  const comment = await review.addComment({
    reviewSessionId: scope.reviewSessionId,
    filePath,
    startLine: line,
    endLine: line,
    body,
    author: "user"
  });
  return comment.commentId;
}

function implFile(baselineId: string, rootName: string, filePath: string, added?: number, removed?: number): DiffFileSummary {
  return {
    baselineId,
    rootName,
    path: filePath,
    changeKind: "modify",
    ...(added === undefined ? {} : { addedLines: added }),
    ...(removed === undefined ? {} : { removedLines: removed }),
    revertSupported: true
  };
}

test("computeState groups two implementation sessions into repo projects with per-file comment counts", async () => {
  const harness = await makeHarness();
  try {
    seedTask(harness, "task-1", "Cross-repo change", ["session-a", "session-b"]);
    seedSession(harness, "session-a", "Alpha");
    seedSession(harness, "session-b", "Beta");
    // session-a touches repo "zeta" and repo "alpha"; session-b touches "alpha".
    harness.diffStatuses.set("session-a", [
      implFile("base-a1", "zeta", "src/z.ts", 3, 1),
      implFile("base-a2", "alpha", "src/a.ts", 5, 0)
    ]);
    harness.diffStatuses.set("session-b", [implFile("base-b1", "alpha", "src/b.ts", 2, 2)]);

    // Comments: a qualified anchor, a plain-path anchor, a plan: (excluded),
    // and a resolved (non-open, excluded).
    await addOpenComment(harness.review, "session-a", "zeta:src/z.ts", 4, "Qualified anchor.");
    await addOpenComment(harness.review, "session-a", "src/a.ts", 5, "Plain-path anchor.");
    await addOpenComment(harness.review, "session-a", "plan:overview.md", 1, "Plan comment, ignored.");
    const resolvedId = await addOpenComment(harness.review, "session-b", "alpha:src/b.ts", 2, "Will resolve.");
    await harness.review.setCommentStatus(asId<"ReviewCommentId">(resolvedId), "resolved");

    const state = await harness.service.computeState("task-1");
    assert.equal(state.title, "Cross-repo change");
    // Every resolvable linked session rides along, in link order, for the dock.
    assert.deepEqual(state.sessions, [
      { sessionId: "session-a", sessionTitle: "Alpha" },
      { sessionId: "session-b", sessionTitle: "Beta" }
    ]);
    // Projects sorted by name: alpha before zeta.
    assert.deepEqual(state.projects.map((p) => p.name), ["alpha", "zeta"]);
    // openCommentCount = 2 open code comments (plan: and resolved excluded).
    assert.equal(state.openCommentCount, 2);
    assert.equal(state.revisionInFlight, undefined);

    const alpha = state.projects.find((p) => p.name === "alpha");
    // alpha has src/a.ts (session-a) and src/b.ts (session-b), sorted by path.
    assert.deepEqual(alpha?.files.map((f) => f.path), ["src/a.ts", "src/b.ts"]);
    assert.equal(alpha?.files.find((f) => f.path === "src/a.ts")?.commentCount, 1); // plain-path match
    assert.equal(alpha?.files.find((f) => f.path === "src/b.ts")?.commentCount, 0); // resolved not counted
    assert.equal(alpha?.files.find((f) => f.path === "src/a.ts")?.baselineId, "base-a2");

    const zeta = state.projects.find((p) => p.name === "zeta");
    assert.equal(zeta?.files.find((f) => f.path === "src/z.ts")?.commentCount, 1); // qualified match
    assert.equal(zeta?.files[0]?.addedLines, 3);
    assert.equal(zeta?.files[0]?.removedLines, 1);
  } finally {
    harness.close();
    await harness.cleanup();
  }
});

test("computeState lists clone files with conflicted passthrough, notes a dead clone, and flags revision-in-flight", async () => {
  const harness = await makeHarness();
  try {
    seedTask(harness, "task-1", "Clone task", ["session-live", "session-dead"]);
    seedSession(harness, "session-live", "Live clone", { mode: "clone" });
    seedSession(harness, "session-dead", "Dead clone", { mode: "clone" });

    // Live clone reports two files, one conflicted; it is also mid-turn.
    harness.sessions.cloneSessions.add("session-live");
    harness.sessions.activeTurns.add("session-live");
    harness.sessions.cloneStates.set("session-live", [
      {
        name: "widgets",
        branch: "main",
        files: [
          { path: "a.ts", changeKind: "modify", addedLines: 1 },
          { path: "b.ts", changeKind: "add", conflicted: true }
        ]
      }
    ]);
    // Dead clone: not a live clone session in this window → note, no files.
    // (session-dead intentionally left out of cloneSessions.)

    const state = await harness.service.computeState("task-1");
    const widgets = state.projects.find((p) => p.name === "widgets");
    assert.notEqual(widgets, undefined);
    assert.deepEqual(widgets?.files.map((f) => f.path), ["a.ts", "b.ts"]);
    assert.equal(widgets?.files.every((f) => f.clone === true), true);
    assert.equal(widgets?.files.find((f) => f.path === "a.ts")?.baselineId, undefined);
    assert.equal(widgets?.files.find((f) => f.path === "b.ts")?.conflicted, true);
    // a.ts is not conflicted → the field is absent, not false.
    assert.equal(Object.prototype.hasOwnProperty.call(widgets?.files.find((f) => f.path === "a.ts") ?? {}, "conflicted"), false);
    // The dead clone surfaces a note but still appears in the session refs
    // (its comments remain readable even though its files are not listed).
    assert.equal(state.notes?.some((n) => n.includes("Dead clone")), true);
    assert.deepEqual(state.sessions.map((s) => s.sessionId), ["session-live", "session-dead"]);
    // One linked session (session-live) has an active turn.
    assert.equal(state.revisionInFlight, 1);
  } finally {
    harness.close();
    await harness.cleanup();
  }
});

test("submitReview sends a revision turn to a live idle session and skips a comment-free session", async () => {
  const harness = await makeHarness();
  try {
    seedTask(harness, "task-1", "Submit task", ["session-a", "session-b"]);
    seedSession(harness, "session-a", "Alpha", { status: "active" });
    seedSession(harness, "session-b", "Beta", { status: "active" });
    harness.sessions.liveSessions.add("session-a");
    harness.sessions.liveSessions.add("session-b");
    // session-a has two open code comments (one qualified, one range); session-b has none.
    const c1 = await addOpenComment(harness.review, "session-a", "repo:src/x.ts", 12, "Fix the guard.");
    const scope = await harness.review.ensureReviewSession("current-session", asId<"SessionId">("session-a"));
    await harness.review.addComment({
      reviewSessionId: scope.reviewSessionId,
      filePath: "repo:src/y.ts",
      startLine: 3,
      endLine: 7,
      body: "Extract this.",
      author: "user"
    });

    const result = await harness.service.submitReview("task-1");
    assert.equal(result.dispatched, 2);
    assert.equal(result.sessions, 1);
    // The dispatched sessions come back as named refs.
    assert.deepEqual(result.sentSessions, [{ sessionId: "session-a", sessionTitle: "Alpha" }]);
    assert.deepEqual(result.errors, []);

    // Only session-a received a turn; the prompt carries the header and the
    // `repo:path:line — body` / range styles.
    assert.equal(harness.sessions.sentTurns.length, 1);
    const sent = harness.sessions.sentTurns[0];
    assert.equal(sent?.sessionId, "session-a");
    assert.match(sent?.prompt ?? "", /address each comment and revise the files/);
    assert.match(sent?.prompt ?? "", /- repo:src\/x\.ts:12 — Fix the guard\./);
    assert.match(sent?.prompt ?? "", /- repo:src\/y\.ts:3-7 — Extract this\./);

    // session-a's comments are now delegated.
    assert.equal(
      (await harness.review.listComments(scope.reviewSessionId)).find((c) => c.commentId === c1)?.status,
      "delegated"
    );
  } finally {
    harness.close();
    await harness.cleanup();
  }
});

test("submitReview leaves comments open for mid-turn and unresumable sessions, and resumes a dead one", async () => {
  const harness = await makeHarness();
  try {
    seedTask(harness, "task-busy", "Busy", ["session-busy"]);
    seedSession(harness, "session-busy", "Busy", { status: "active" });
    harness.sessions.liveSessions.add("session-busy");
    harness.sessions.activeTurns.add("session-busy");
    const busyComment = await addOpenComment(harness.review, "session-busy", "repo:a.ts", 1, "Later.");

    // Mid-turn: error line, no send, comment stays open.
    const busyResult = await harness.service.submitReview("task-busy");
    assert.equal(busyResult.dispatched, 0);
    assert.equal(busyResult.sessions, 0);
    assert.deepEqual(busyResult.sentSessions, []);
    assert.equal(busyResult.errors.length, 1);
    assert.match(busyResult.errors[0] ?? "", /is mid-turn/);
    assert.equal(harness.sessions.sentTurns.length, 0);
    assert.equal(await statusOf(harness.review, "session-busy", busyComment), "open");

    // Dead session, no resolver hook: error line, comment stays open, no resume.
    seedTask(harness, "task-dead", "Dead", ["session-dead"]);
    seedSession(harness, "session-dead", "Dead", { status: "ended" });
    const deadComment = await addOpenComment(harness.review, "session-dead", "repo:b.ts", 1, "Revise.");
    const noResolver = await harness.service.submitReview("task-dead");
    assert.match(noResolver.errors[0] ?? "", /not live and could not be resumed here/);
    assert.equal(harness.sessions.resumed.length, 0);
    assert.equal(await statusOf(harness.review, "session-dead", deadComment), "open");

    // Dead session WITH a resolver → resume with the resolved workspace, then send.
    const workspace: ChatWorkspaceContext = { mode: "implementation", roots: ["/w/root"] };
    const withResolver = await harness.service.submitReview("task-dead", {
      resolveResumeWorkspace: () => Promise.resolve(workspace)
    });
    assert.equal(withResolver.dispatched, 1);
    assert.equal(withResolver.sessions, 1);
    assert.deepEqual(withResolver.errors, []);
    assert.equal(harness.sessions.resumed.length, 1);
    assert.deepEqual(harness.sessions.resumed[0]?.workspace, workspace);
    assert.equal(harness.sessions.sentTurns.length, 1);
    assert.equal(harness.sessions.sentTurns[0]?.sessionId, "session-dead");
    assert.equal(await statusOf(harness.review, "session-dead", deadComment), "delegated");
  } finally {
    harness.close();
    await harness.cleanup();
  }
});

test("submitReview skips a session running in another window without resuming or sending", async () => {
  const harness = await makeHarness();
  try {
    seedTask(harness, "task-1", "Elsewhere", ["session-elsewhere"]);
    // Active + fresh heartbeat + a FOREIGN host instance id → running elsewhere.
    seedSession(harness, "session-elsewhere", "Elsewhere", {
      status: "active",
      hostInstanceId: "another-window",
      heartbeatAt: new Date().toISOString()
    });
    harness.sessions.freshHeartbeat = true;
    const comment = await addOpenComment(harness.review, "session-elsewhere", "repo:c.ts", 1, "Please revise.");

    let resolverCalled = false;
    const result = await harness.service.submitReview("task-1", {
      resolveResumeWorkspace: () => {
        resolverCalled = true;
        return Promise.resolve({ mode: "implementation", roots: ["/w"] });
      }
    });
    assert.equal(result.dispatched, 0);
    assert.equal(result.sessions, 0);
    assert.match(result.errors[0] ?? "", /running in another VS Code window/);
    assert.equal(resolverCalled, false);
    assert.equal(harness.sessions.resumed.length, 0);
    assert.equal(harness.sessions.sentTurns.length, 0);
    assert.equal(await statusOf(harness.review, "session-elsewhere", comment), "open");
  } finally {
    harness.close();
    await harness.cleanup();
  }
});

test("openCommentCountsByTask joins cheap per-session counts and omits zero-count tasks", async () => {
  const harness = await makeHarness();
  try {
    // task-a links two sessions (2 + 1 open comments); task-b shares session-2
    // (1 comment); task-c links a comment-free session and must be OMITTED.
    seedTask(harness, "task-a", "A", ["session-1", "session-2"]);
    seedTask(harness, "task-b", "B", ["session-2"]);
    seedTask(harness, "task-c", "C", ["session-3"]);
    seedSession(harness, "session-1", "One");
    seedSession(harness, "session-2", "Two");
    seedSession(harness, "session-3", "Three");
    await addOpenComment(harness.review, "session-1", "repo:a.ts", 1, "First.");
    await addOpenComment(harness.review, "session-1", "repo:b.ts", 2, "Second.");
    await addOpenComment(harness.review, "session-2", "repo:c.ts", 3, "Third.");
    // Non-open and plan-doc comments never count.
    const resolved = await addOpenComment(harness.review, "session-2", "repo:d.ts", 4, "Resolved.");
    await harness.review.setCommentStatus(asId<"ReviewCommentId">(resolved), "resolved");
    await addOpenComment(harness.review, "session-3", "plan:overview.md", 1, "Plan note.");

    const counts = await harness.service.openCommentCountsByTask();
    assert.equal(counts.get("task-a"), 3);
    assert.equal(counts.get("task-b"), 1);
    // Zero-count tasks are omitted entirely (the card renders no "(0)").
    assert.equal(counts.has("task-c"), false);
  } finally {
    harness.close();
    await harness.cleanup();
  }
});

/** Current status of one comment in a session's current-session review scope. */
async function statusOf(review: CodeReviewService, sessionId: string, commentId: string): Promise<string | undefined> {
  const scope = await review.ensureReviewSession("current-session", asId<"SessionId">(sessionId));
  return (await review.listComments(scope.reviewSessionId)).find((c) => c.commentId === commentId)?.status;
}
