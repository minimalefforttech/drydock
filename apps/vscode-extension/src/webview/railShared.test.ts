/**
 * Rail projection tests (UX overhaul, P1): Recents dedupe/attribution/
 * promotion and the workspace delete guard.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { SubtaskSummary, WorkTaskSummary } from "@drydock/contracts";
import {
  buildRecentChats,
  tasksBlockingWorkspaceSet,
  workspaceInUseMessage,
  type RecentSessionInput
} from "./railShared.js";

function task(overrides: Partial<WorkTaskSummary> & { taskId: string; title: string }): WorkTaskSummary {
  return {
    description: undefined,
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

function session(sessionId: string, updatedAt: string, overrides: Partial<RecentSessionInput> = {}): RecentSessionInput {
  return { sessionId, title: `${sessionId} title`, status: "active", updatedAt, ...overrides };
}

test("buildRecentChats returns one row per task, newest chat first", () => {
  const tasks = [
    task({ taskId: "task-a", title: "Rail", linkedSessionIds: ["s-old", "s-new"] }),
    task({ taskId: "task-b", title: "Hub", linkedSessionIds: ["s-mid"] })
  ];
  const sessions = [
    session("s-old", "2026-08-01T10:00:00.000Z"),
    session("s-new", "2026-08-02T10:00:00.000Z"),
    session("s-mid", "2026-08-01T18:00:00.000Z")
  ];
  const rows = buildRecentChats(tasks, sessions);
  assert.deepEqual(rows.map((row) => [row.taskId, row.sessionId]), [
    ["task-a", "s-new"],
    ["task-b", "s-mid"]
  ]);
  assert.equal(rows[0]?.taskTitle, "Rail");
  assert.equal(rows[0]?.lastActivityAt, "2026-08-02T10:00:00.000Z");
});

test("buildRecentChats attributes a subtask's chat to its parent task, once", () => {
  const tasks = [
    task({
      taskId: "task-a",
      title: "Rail",
      // The same session is linked at both levels: still exactly one row.
      linkedSessionIds: ["s-shared"],
      subtasks: [subtask("sub-1", "task-a", ["s-shared", "s-child"])]
    })
  ];
  const rows = buildRecentChats(tasks, [
    session("s-shared", "2026-08-01T10:00:00.000Z"),
    session("s-child", "2026-08-02T10:00:00.000Z")
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.sessionId, "s-child");
  assert.equal(rows[0]?.taskTitle, "Rail");
});

test("buildRecentChats excludes tasks with no resolvable chat", () => {
  const tasks = [
    task({ taskId: "task-a", title: "No chats" }),
    // A link pointing at a deleted session is stale, not a row.
    task({ taskId: "task-b", title: "Stale link", linkedSessionIds: ["gone"] }),
    task({ taskId: "task-c", title: "Real", linkedSessionIds: ["s-1"] })
  ];
  const rows = buildRecentChats(tasks, [session("s-1", "2026-08-02T10:00:00.000Z")]);
  assert.deepEqual(rows.map((row) => row.taskId), ["task-c"]);
});

test("buildRecentChats promotes the next chat when the newest one ends", () => {
  const tasks = [task({ taskId: "task-a", title: "Rail", linkedSessionIds: ["s-live", "s-newest"] })];
  const live = session("s-live", "2026-08-01T10:00:00.000Z", { live: true });
  const newest = session("s-newest", "2026-08-02T10:00:00.000Z");
  // While both are open the newest wins...
  assert.equal(buildRecentChats(tasks, [live, newest])[0]?.sessionId, "s-newest");
  // ...and once it ends the still-open chat is promoted into the row.
  const ended = { ...newest, status: "ended" };
  const promoted = buildRecentChats(tasks, [live, ended])[0];
  assert.equal(promoted?.sessionId, "s-live");
  assert.equal(promoted?.live, true);
  // Every chat ended: the row falls back to the newest ended one.
  assert.equal(buildRecentChats(tasks, [{ ...live, status: "ended" }, ended])[0]?.sessionId, "s-newest");
});

test("buildRecentChats caps rows and flags attention", () => {
  const tasks = Array.from({ length: 10 }, (_, index) => task({
    taskId: `task-${String(index)}`,
    title: `Task ${String(index)}`,
    linkedSessionIds: [`s-${String(index)}`]
  }));
  const sessions = tasks.map((_, index) => session(`s-${String(index)}`, `2026-08-0${String(index % 9 + 1)}T10:00:00.000Z`));
  assert.equal(buildRecentChats(tasks, sessions).length, 7);
  assert.equal(buildRecentChats(tasks, sessions, { limit: 3 }).length, 3);
  const flagged = buildRecentChats(tasks, sessions, { attentionSessionIds: new Set(["s-2"]) })
    .find((row) => row.sessionId === "s-2");
  assert.equal(flagged?.needsAttention, true);
});

test("tasksBlockingWorkspaceSet names only tasks with a live chat on the set", () => {
  const tasks = [
    task({ taskId: "task-a", title: "Running work", linkedWorkspaceSetIds: ["set-1"], linkedSessionIds: ["s-live"] }),
    task({ taskId: "task-b", title: "Idle work", linkedWorkspaceSetIds: ["set-1"], linkedSessionIds: ["s-dead"] }),
    task({ taskId: "task-c", title: "Other set", linkedWorkspaceSetIds: ["set-2"], linkedSessionIds: ["s-live"] }),
    task({
      taskId: "task-d",
      title: "Subtask work",
      linkedWorkspaceSetIds: ["set-1"],
      subtasks: [subtask("sub-1", "task-d", ["s-child-live"])]
    })
  ];
  const live = new Set(["s-live", "s-child-live"]);
  assert.deepEqual(tasksBlockingWorkspaceSet(["set-1"], tasks, live), ["Running work", "Subtask work"]);
  assert.deepEqual(tasksBlockingWorkspaceSet(["set-3"], tasks, live), []);
  assert.deepEqual(tasksBlockingWorkspaceSet(["set-1"], tasks, new Set()), []);
});

test("workspaceInUseMessage names the blocking tasks", () => {
  assert.match(workspaceInUseMessage("Workspace set \"Studio\"", ["Rail"]), /"Rail" has a live chat/);
  assert.match(workspaceInUseMessage("Folder \"api\"", ["Rail", "Hub"]), /"Rail", "Hub" have live chats/);
});
