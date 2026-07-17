/**
 * Assembly tests for the Agents panel overview (ADR 0013): task grouping,
 * role-child grafting, orphan collection, column chip join, and pending
 * passthrough - pinned against plain fakes of the narrow ports.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { asId, type ChatSessionRecord, type ChatSessionSummary, type WorkTaskSummary } from "@drydock/contracts";
import { buildAgentsOverview, buildLandingItems, type AgentsOverviewColumn, type AgentsOverviewPorts } from "./agentsOverviewAppService.js";

function sessionRecord(sessionId: string, extra?: Partial<ChatSessionRecord>): ChatSessionRecord {
  return {
    sessionId: asId<"SessionId">(sessionId),
    chatId: asId<"ChatId">(`chat-${sessionId}`),
    title: `Session ${sessionId}`,
    status: "active",
    providerId: "codex",
    transport: "codex-app-server",
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    ...extra
  };
}

function taskSummary(taskId: string, linkedSessionIds: readonly string[], columnId = "col-in-progress"): WorkTaskSummary {
  return {
    taskId,
    title: `Task ${taskId}`,
    state: "in-progress",
    columnId,
    linkedWorkspaceSetIds: [],
    linkedSessionIds,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    subtasks: []
  };
}

function makePorts(input: {
  readonly sessions: readonly ChatSessionRecord[];
  readonly tasks: readonly WorkTaskSummary[];
  readonly columns?: readonly AgentsOverviewColumn[];
}): AgentsOverviewPorts {
  return {
    listSessions: () => Promise.resolve(input.sessions),
    listTaskSummaries: () => Promise.resolve(input.tasks),
    listColumns: () => Promise.resolve(input.columns ?? [{ columnId: "col-in-progress", name: "Doing", category: "in-progress" }]),
    listPendingQuestions: () => Promise.resolve([{
      questionId: "q-1",
      sessionId: "s-1",
      question: "Mock the ledger?",
      options: [],
      status: "pending" as const,
      createdAt: "2026-07-11T00:00:00.000Z"
    }]),
    listPendingAccessRequests: () => Promise.resolve([]),
    decorateSession: (record): ChatSessionSummary => ({
      sessionId: record.sessionId,
      title: record.title,
      status: record.status,
      providerId: record.providerId,
      transport: record.transport,
      ...(record.parentSessionId === undefined ? {} : { parentSessionId: record.parentSessionId }),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    }),
    now: () => "2026-07-11T01:00:00.000Z",
    agentIdleThresholdMs: () => 300_000
  };
}

test("sessions group under their linked task; the first task in list order wins duplicates", async () => {
  const sessions = [sessionRecord("s-1"), sessionRecord("s-2"), sessionRecord("s-3")];
  const tasks = [taskSummary("t-1", ["s-1", "s-2"]), taskSummary("t-2", ["s-2", "s-3"])];
  const overview = await buildAgentsOverview(makePorts({ sessions, tasks }));
  assert.equal(overview.groups.length, 2);
  assert.deepEqual(overview.groups[0]?.sessions.map((s) => s.sessionId), ["s-1", "s-2"]);
  assert.deepEqual(overview.groups[1]?.sessions.map((s) => s.sessionId), ["s-3"]);
  assert.equal(overview.orphanSessions.length, 0);
  // Column chip joined from the task's columnId.
  assert.equal(overview.groups[0]?.columnName, "Doing");
  assert.equal(overview.groups[0]?.columnCategory, "in-progress");
});

test("unlinked role children graft under their nearest linked ancestor, depth-N", async () => {
  const sessions = [
    sessionRecord("s-parent"),
    sessionRecord("s-child", { parentSessionId: asId<"SessionId">("s-parent"), spawnedRole: "reviewer" }),
    sessionRecord("s-grandchild", { parentSessionId: asId<"SessionId">("s-child") })
  ];
  const tasks = [taskSummary("t-1", ["s-parent"])];
  const overview = await buildAgentsOverview(makePorts({ sessions, tasks }));
  assert.equal(overview.groups.length, 1);
  assert.deepEqual(overview.groups[0]?.sessions.map((s) => s.sessionId), ["s-parent", "s-child", "s-grandchild"]);
  assert.equal(overview.orphanSessions.length, 0);
});

test("sessions with no linked task (or ancestry) land in the orphan drawer; taskless tasks are dropped", async () => {
  const sessions = [
    sessionRecord("s-linked"),
    sessionRecord("s-orphan"),
    // A parent cycle must not hang the walk; both cycle members stay orphans.
    sessionRecord("s-a", { parentSessionId: asId<"SessionId">("s-b") }),
    sessionRecord("s-b", { parentSessionId: asId<"SessionId">("s-a") })
  ];
  const tasks = [taskSummary("t-1", ["s-linked"]), taskSummary("t-empty", [])];
  const overview = await buildAgentsOverview(makePorts({ sessions, tasks }));
  assert.deepEqual(overview.groups.map((group) => group.task.taskId), ["t-1"]);
  assert.deepEqual(overview.orphanSessions.map((s) => s.sessionId), ["s-orphan", "s-a", "s-b"]);
});

test("a stale link to a deleted session is ignored; a missing column renders chipless", async () => {
  const sessions = [sessionRecord("s-1")];
  const tasks = [taskSummary("t-1", ["s-1", "s-deleted-long-ago"], "col-gone")];
  const overview = await buildAgentsOverview(makePorts({ sessions, tasks }));
  assert.equal(overview.groups.length, 1);
  assert.deepEqual(overview.groups[0]?.sessions.map((s) => s.sessionId), ["s-1"]);
  assert.equal(overview.groups[0]?.columnName, undefined);
  assert.equal(overview.groups[0]?.columnCategory, undefined);
});

test("pending sets and the idle threshold pass through untouched", async () => {
  const overview = await buildAgentsOverview(makePorts({ sessions: [], tasks: [] }));
  assert.equal(overview.questions.length, 1);
  assert.equal(overview.questions[0]?.questionId, "q-1");
  assert.deepEqual(overview.accessRequests, []);
  assert.equal(overview.agentIdleThresholdMs, 300_000);
  assert.equal(overview.generatedAt, "2026-07-11T01:00:00.000Z");
});

// --- Landing items (ADR 0014) -------------------------------------------------

test("buildLandingItems groups per subtask, computes overlap, and orders disjoint-first", () => {
  const tasks: WorkTaskSummary[] = [
    {
      ...taskSummary("task-1", []),
      subtasks: [
        { subtaskId: "sub-a", taskId: "task-1", title: "Exporter", autoStart: false, origin: "manual", columnId: "col-review", sortOrder: 0, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z", isBlocked: false, dependsOn: [], isRunning: false, linkedSessionIds: [] },
        { subtaskId: "sub-b", taskId: "task-1", title: "Allowlist", autoStart: false, origin: "manual", columnId: "col-review", sortOrder: 1, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z", isBlocked: false, dependsOn: [], isRunning: false, linkedSessionIds: [] }
      ]
    }
  ];
  const row = (changesetId: string, subtaskId: string, repoName: string, paths?: readonly string[]) => ({
    changesetId,
    taskId: asId<"TaskId">("task-1"),
    subtaskId: asId<"SubtaskId">(subtaskId),
    sessionId: asId<"SessionId">(`session-${subtaskId}`),
    repoName,
    patchSha256: "0".repeat(64),
    patchBytes: 10,
    fileCount: paths?.length ?? 1,
    ...(paths === undefined ? {} : { paths }),
    capturedAt: `2026-07-12T00:0${changesetId.length % 10}:00.000Z`
  });

  // sub-a touches api:src/x.py in one repo and something disjoint in another;
  // sub-b touches the SAME api path → they overlap each other.
  const items = buildLandingItems(
    [
      row("cs1", "sub-a", "api", ["src/x.py"]),
      row("cs2", "sub-a", "tools", ["bin/run.sh"]),
      row("cs3", "sub-b", "api", ["src/x.py", "src/y.py"]),
      row("cs4", "sub-c", "api", ["docs/readme.md"])
    ],
    tasks
  );

  assert.deepEqual(items.map((item) => item.subtaskId), ["sub-c", "sub-a", "sub-b"]);
  const subA = items.find((item) => item.subtaskId === "sub-a");
  assert.deepEqual(subA?.overlapsWith, ["sub-b"]);
  assert.equal(subA?.subtaskTitle, "Exporter");
  assert.equal(subA?.taskTitle, "Task task-1");
  assert.deepEqual(subA?.repos.map((repo) => repo.repoName), ["api", "tools"]);
  // Unknown subtask id still lands (title falls back to the id).
  assert.equal(items.find((item) => item.subtaskId === "sub-c")?.subtaskTitle, "sub-c");
});

test("buildLandingItems flags overlap-unknown when a row has no stored paths", () => {
  const base = {
    taskId: asId<"TaskId">("task-1"),
    patchSha256: "0".repeat(64),
    patchBytes: 10,
    fileCount: 1,
    capturedAt: "2026-07-12T00:00:00.000Z"
  };
  const items = buildLandingItems(
    [
      { ...base, changesetId: "cs1", subtaskId: asId<"SubtaskId">("sub-legacy"), sessionId: asId<"SessionId">("session-1"), repoName: "api" },
      { ...base, changesetId: "cs2", subtaskId: asId<"SubtaskId">("sub-new"), sessionId: asId<"SessionId">("session-2"), repoName: "api", paths: ["src/x.py"] }
    ],
    []
  );
  const legacy = items.find((item) => item.subtaskId === "sub-legacy");
  const fresh = items.find((item) => item.subtaskId === "sub-new");
  assert.equal(legacy?.overlapUnknown, true);
  assert.deepEqual(legacy?.overlapsWith, []);
  // The pair's overlap is unknown from the fresh side too - flagged, never
  // assumed disjoint - so BOTH carry the unknown risk class and keep their
  // capture order (unknown sorts after known-disjoint, before overlapping).
  assert.equal(fresh?.overlapUnknown, true);
  assert.deepEqual(items.map((item) => item.subtaskId), ["sub-legacy", "sub-new"]);
});
