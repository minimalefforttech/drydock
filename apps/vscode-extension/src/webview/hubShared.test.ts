/**
 * Task Hub projection tests (UX overhaul, P3): chat-row assembly across
 * task + subtask links, attention pinning, tile arithmetic, and the
 * reconstructed launch command.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type {
  AccessRequestSummary,
  AgentQuestionSummary,
  ChatSessionSummary,
  PlanSummary,
  RuntimeStatsSummary,
  RuntimeSummary,
  SubtaskSummary,
  WorkTaskSummary
} from "@drydock/contracts";
import { buildHubState, buildLaunchCommand, hubTaskSessionIds, type HubStateInput } from "./hubShared.js";

const NOW = "2026-08-02T12:00:00.000Z";

function task(overrides: Partial<WorkTaskSummary> & { taskId: string; title: string }): WorkTaskSummary {
  return {
    state: "in-progress",
    columnId: "col-in-progress",
    linkedWorkspaceSetIds: [],
    linkedSessionIds: [],
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
    subtasks: [],
    ...overrides
  } as WorkTaskSummary;
}

function subtask(subtaskId: string, taskId: string, linkedSessionIds: readonly string[]): SubtaskSummary {
  return {
    subtaskId,
    taskId,
    title: subtaskId,
    autoStart: false,
    origin: "manual",
    columnId: "col-todo",
    sortOrder: 0,
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
    isBlocked: false,
    dependsOn: [],
    isRunning: false,
    linkedSessionIds
  };
}

function session(
  sessionId: string,
  updatedAt: string,
  overrides: Partial<ChatSessionSummary> = {}
): ChatSessionSummary {
  return {
    sessionId,
    title: `${sessionId} title`,
    status: "active",
    providerId: "claude",
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt,
    ...overrides
  };
}

function question(questionId: string, sessionId: string, createdAt: string): AgentQuestionSummary {
  return { questionId, sessionId, question: `${questionId}?`, options: [], status: "pending", createdAt };
}

function accessRequest(id: string, sessionId: string, requestedAt: string): AccessRequestSummary {
  return {
    accessRequestId: id,
    sessionId,
    displayPath: "C:/repo/.env",
    mode: "read-only",
    reason: "read config",
    status: "pending",
    requestedAt
  };
}

function runtime(runtimeId: string, status: string, startedAt: string): RuntimeSummary {
  return { runtimeId, externalName: `drydock-${runtimeId}`, status, startedAt };
}

function stats(runtimeId: string, overrides: Partial<RuntimeStatsSummary> = {}): RuntimeStatsSummary {
  return {
    runtimeId,
    available: true,
    cpuPercent: null,
    memBytes: null,
    ioReadBytesPerSec: null,
    ioWriteBytesPerSec: null,
    loadAvg1: null,
    threads: null,
    ...overrides
  };
}

function input(overrides: Partial<HubStateInput> & { task: WorkTaskSummary }): HubStateInput {
  return {
    sessions: [],
    plans: [],
    questions: [],
    accessRequests: [],
    runtimes: [],
    mounts: [],
    generatedAt: NOW,
    ...overrides
  };
}

test("hubTaskSessionIds unions task and subtask links exactly once", () => {
  const target = task({
    taskId: "task-a",
    title: "Hub",
    linkedSessionIds: ["s-shared", "s-own"],
    subtasks: [subtask("sub-1", "task-a", ["s-shared", "s-child"])]
  });
  assert.deepEqual([...hubTaskSessionIds(target)].sort(), ["s-child", "s-own", "s-shared"]);
});

test("buildHubState collects task + subtask chats, newest first, with provider labels", () => {
  const target = task({
    taskId: "task-a",
    title: "Hub",
    linkedSessionIds: ["s-own"],
    subtasks: [subtask("sub-1", "task-a", ["s-child"])]
  });
  const state = buildHubState(input({
    task: target,
    sessions: [
      session("s-own", "2026-08-01T10:00:00.000Z", { model: "opus-5" }),
      session("s-child", "2026-08-02T10:00:00.000Z", { providerId: "codex", live: true }),
      // Not this task's chat: never a row.
      session("s-other", "2026-08-02T11:00:00.000Z")
    ]
  }));
  assert.deepEqual(state.chats.map((row) => row.sessionId), ["s-child", "s-own"]);
  assert.equal(state.chats[0]?.providerId, "codex");
  assert.equal(state.chats[0]?.subtaskId, "sub-1");
  assert.equal(state.chats[0]?.live, true);
  assert.equal(state.chats[1]?.model, "opus-5");
  assert.equal(state.chats[1]?.subtaskId, undefined);
  // Every row carries its task attribution, like a Recents row.
  assert.equal(state.chats[0]?.taskTitle, "Hub");
});

test("buildHubState pins chats that need you and skips stale links", () => {
  const target = task({ taskId: "task-a", title: "Hub", linkedSessionIds: ["s-quiet", "s-asking", "s-deleted"] });
  const state = buildHubState(input({
    task: target,
    sessions: [
      session("s-quiet", "2026-08-02T10:00:00.000Z"),
      session("s-asking", "2026-08-01T10:00:00.000Z")
    ],
    questions: [question("q-1", "s-asking", "2026-08-02T09:00:00.000Z")]
  }));
  // The older chat wins the top slot because it is waiting on the user.
  assert.deepEqual(state.chats.map((row) => row.sessionId), ["s-asking", "s-quiet"]);
  assert.equal(state.chats[0]?.needsAttention, true);
  assert.equal(state.chats[1]?.needsAttention, undefined);
});

test("buildHubState builds the attention rail oldest-first, questions before access", () => {
  const target = task({ taskId: "task-a", title: "Hub", linkedSessionIds: ["s-1", "s-2"] });
  const state = buildHubState(input({
    task: target,
    sessions: [session("s-1", NOW), session("s-2", NOW)],
    questions: [
      question("q-new", "s-1", "2026-08-02T11:00:00.000Z"),
      question("q-old", "s-2", "2026-08-02T09:00:00.000Z"),
      // Answered questions and other tasks' questions never reach the rail.
      { ...question("q-done", "s-1", "2026-08-02T08:00:00.000Z"), status: "answered" },
      question("q-foreign", "s-elsewhere", "2026-08-02T08:00:00.000Z")
    ],
    accessRequests: [
      accessRequest("a-1", "s-1", "2026-08-02T10:00:00.000Z"),
      { ...accessRequest("a-approved", "s-2", "2026-08-02T07:00:00.000Z"), status: "approved" }
    ]
  }));
  assert.deepEqual(state.attention.map((item) => [item.kind, item.sessionId]), [
    ["question", "s-2"],
    ["question", "s-1"],
    ["access", "s-1"]
  ]);
  assert.equal(state.attention[0]?.headline, "q-old?");
  assert.match(state.attention[2]?.headline ?? "", /read-only access to C:\/repo\/\.env/);
});

test("buildHubState keeps only this task's plans", () => {
  const plan = (planId: string, taskId: string | null): PlanSummary => ({
    planId,
    title: planId,
    brief: "",
    aspectIds: [],
    contextRoots: [],
    notes: "",
    status: "active",
    sessionId: null,
    taskId,
    artifactCount: 0,
    openAnnotationCount: 0,
    updatedAt: NOW
  });
  const state = buildHubState(input({
    task: task({ taskId: "task-a", title: "Hub" }),
    plans: [plan("plan-mine", "task-a"), plan("plan-other", "task-b"), plan("plan-orphan", null)]
  }));
  assert.deepEqual(state.plans.map((entry) => entry.planId), ["plan-mine"]);
});

test("buildHubState sums live samples and agent tokens, and never fakes a zero", () => {
  const target = task({ taskId: "task-a", title: "Hub", linkedSessionIds: ["s-1", "s-2"] });
  const measured = buildHubState(input({
    task: target,
    sessions: [
      session("s-1", NOW, {
        agentActivity: {
          running: 1,
          failed: 0,
          root: { nodeId: "root", label: "root", status: "running", toolUses: 3, tokens: 1_000 },
          agents: [{ nodeId: "a1", label: "child", status: "running", toolUses: 1, tokens: 250 }]
        }
      }),
      session("s-2", NOW)
    ],
    runtimes: [
      { runtime: runtime("r-1", "running", NOW), sessionId: "s-1", stats: stats("r-1", { cpuPercent: 12.5, memBytes: 100 }) },
      { runtime: runtime("r-2", "running", NOW), sessionId: "s-2", stats: stats("r-2", { cpuPercent: 7.5, memBytes: 50 }) },
      { runtime: runtime("r-3", "stopped", NOW), sessionId: "s-2" }
    ]
  }));
  assert.equal(measured.stats.cpuPercent, 20);
  assert.equal(measured.stats.memBytes, 150);
  assert.equal(measured.stats.tokens, 1_250);
  assert.equal(measured.stats.runtimeCount, 2);

  // An unavailable probe is "we could not measure", not "zero".
  const unmeasured = buildHubState(input({
    task: target,
    sessions: [session("s-1", NOW)],
    runtimes: [{ runtime: runtime("r-1", "running", NOW), sessionId: "s-1", stats: stats("r-1", { available: false }) }]
  }));
  assert.equal(unmeasured.stats.cpuPercent, undefined);
  assert.equal(unmeasured.stats.memBytes, undefined);
  assert.equal(unmeasured.stats.tokens, undefined);
  assert.equal(unmeasured.stats.runtimeCount, 1);
});

test("buildHubState renders mount lines and the newest running runtime's launch command", () => {
  const state = buildHubState(input({
    task: task({ taskId: "task-a", title: "Hub", linkedSessionIds: ["s-1", "s-2"] }),
    sessions: [session("s-1", NOW, { providerId: "claude" }), session("s-2", NOW, { providerId: "codex" })],
    mounts: [
      { displayPath: "C:/repo/app", readOnly: false },
      { displayPath: "C:/repo/lib", readOnly: true }
    ],
    runtimes: [
      { runtime: runtime("r-old", "running", "2026-08-01T09:00:00.000Z"), sessionId: "s-1", workspaceDisplayPath: "C:/repo/app" },
      { runtime: runtime("r-new", "running", "2026-08-02T09:00:00.000Z"), sessionId: "s-2", workspaceDisplayPath: "C:/repo/app" }
    ]
  }));
  assert.deepEqual(state.system.mounts, ["rw C:/repo/app", "ro C:/repo/lib"]);
  assert.equal(state.system.runtimes.length, 2);
  assert.equal(state.system.launchCommand, "sbx create --name drydock-r-new codex C:/repo/app C:/repo/lib:ro");
});

test("buildHubState omits the launch command when nothing is running", () => {
  const state = buildHubState(input({
    task: task({ taskId: "task-a", title: "Hub", linkedSessionIds: ["s-1"] }),
    sessions: [session("s-1", NOW)],
    runtimes: [{ runtime: runtime("r-1", "stopped", NOW), sessionId: "s-1", workspaceDisplayPath: "C:/repo/app" }]
  }));
  assert.equal(state.system.launchCommand, undefined);
  assert.equal(state.stats.runtimeCount, 0);
});

test("buildLaunchCommand names the agent and appends non-workspace mounts", () => {
  assert.equal(
    buildLaunchCommand({
      sandboxName: "drydock-abc",
      providerId: "claude-code",
      workspaceDisplayPath: "C:/repo/app",
      mounts: [
        { displayPath: "C:/repo/app", readOnly: false },
        { displayPath: "C:/shared", readOnly: true },
        { displayPath: "C:/scratch", readOnly: false }
      ]
    }),
    "sbx create --name drydock-abc claude C:/repo/app C:/shared:ro C:/scratch"
  );
  // The legacy codex provider id still launches the codex agent.
  assert.match(
    buildLaunchCommand({ sandboxName: "s", providerId: "codex-openai", workspaceDisplayPath: "/w", mounts: [] }),
    /\bcodex \/w$/
  );
});

test("buildHubState hoists subtasks and carries the workspace chip", () => {
  const target = task({
    taskId: "task-a",
    title: "Hub",
    subtasks: [subtask("sub-1", "task-a", []), subtask("sub-2", "task-a", [])]
  });
  const state = buildHubState(input({ task: target, workspaceName: "Studio" }));
  assert.deepEqual(state.subtasks.map((entry) => entry.subtaskId), ["sub-1", "sub-2"]);
  assert.equal(state.workspaceName, "Studio");
  assert.equal(state.generatedAt, NOW);
  assert.equal(state.task.taskId, "task-a");
});
