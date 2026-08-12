/**
 * Projection + anchor tests for the shared memory helpers (ADR 0019/0020):
 * the display-safe summary both panel hosts ship, and approval-time edit
 * resolution - pinned against plain fakes of the narrow anchor ports.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { asId, type MemoryCandidateRecord } from "@drydock/contracts";
import { memoryTaskTitles, resolveMemoryEdits, toMemoryCandidateSummary, type MemoryAnchorPorts } from "./memoryShared.js";

function record(extra?: Partial<MemoryCandidateRecord>): MemoryCandidateRecord {
  return {
    memoryCandidateId: asId<"MemoryCandidateId">("m-1"),
    sessionId: asId<"SessionId">("s-1"),
    content: "Alembic exports must use the framerange guard.",
    status: "pending",
    createdAt: "2026-08-01T00:00:00.000Z",
    ...extra
  };
}

test("summary labels task scope from the title map, falling back to the id", () => {
  const scoped = record({ scope: "task", scopeTaskId: "t-1" });
  const withTitles = toMemoryCandidateSummary(scoped, new Map([["t-1", "Alembic publish support"]]));
  assert.equal(withTitles.scopeLabel, "Alembic publish support");
  const withoutTitles = toMemoryCandidateSummary(scoped);
  assert.equal(withoutTitles.scopeLabel, "t-1");
});

test("summary labels workspace scope with folder basenames, never paths", () => {
  const summary = toMemoryCandidateSummary(record({
    scope: "workspace",
    scopeRoots: ["C:\\hitl\\asset_api\\", "/home/alex/tools/pipeline"]
  }));
  assert.equal(summary.scopeLabel, "asset_api, pipeline");
});

test("summary defaults legacy rows to global/agent with no tags", () => {
  const summary = toMemoryCandidateSummary(record());
  assert.equal(summary.scope, "global");
  assert.equal(summary.origin, "agent");
  assert.deepEqual(summary.tags, []);
  assert.equal(summary.scopeLabel, undefined);
  // resolvedAt and scopeRoots must not ride along - the summary is display-safe.
  assert.equal("resolvedAt" in summary, false);
  assert.equal("scopeRoots" in summary, false);
});

test("memoryTaskTitles is best-effort: a throwing lookup yields an empty map", async () => {
  const titles = await memoryTaskTitles(() => Promise.resolve([{ taskId: "t-1", title: "One" }]));
  assert.equal(titles.get("t-1"), "One");
  const failed = await memoryTaskTitles(() => { throw new Error("backend unavailable"); });
  assert.equal(failed.size, 0);
});

function ports(overrides?: Partial<MemoryAnchorPorts>): MemoryAnchorPorts {
  return {
    getCandidate: () => Promise.resolve({ sessionId: "s-1" }),
    listTaskSummaries: () => Promise.resolve([
      { taskId: "t-other", linkedSessionIds: ["s-9"] },
      { taskId: "t-owner", linkedSessionIds: ["s-2", "s-1"] }
    ]),
    sessionRoots: () => Promise.resolve(["C:\\hitl\\asset_api"]),
    ...overrides
  };
}

test("resolveMemoryEdits passes undefined through and keeps content/tags verbatim", async () => {
  assert.equal(await resolveMemoryEdits(ports(), "m-1", undefined, []), undefined);
  const resolved = await resolveMemoryEdits(ports(), "m-1", { content: "Trimmed.", tags: ["python"] }, []);
  assert.deepEqual(resolved, { content: "Trimmed.", tags: ["python"] });
});

test("task scope anchors to the task linked to the source session", async () => {
  const resolved = await resolveMemoryEdits(ports(), "m-1", { scope: "task" }, []);
  assert.equal(resolved?.scope, "task");
  assert.equal(resolved?.scopeTaskId, "t-owner");
});

test("task scope with no owning task resolves without an anchor", async () => {
  const resolved = await resolveMemoryEdits(
    ports({ listTaskSummaries: () => Promise.resolve([]) }),
    "m-1",
    { scope: "task" },
    []
  );
  assert.equal(resolved?.scope, "task");
  assert.equal(resolved?.scopeTaskId, undefined);
});

test("workspace scope prefers the source session's roots", async () => {
  const resolved = await resolveMemoryEdits(ports(), "m-1", { scope: "workspace" }, ["D:\\fallback"]);
  assert.deepEqual(resolved?.scopeRoots, ["C:\\hitl\\asset_api"]);
});

test("workspace scope falls back to the open folders for user and unknown sessions", async () => {
  const userAuthored = await resolveMemoryEdits(
    ports({ getCandidate: () => Promise.resolve({ sessionId: "user" }) }),
    "m-1",
    { scope: "workspace" },
    ["D:\\fallback"]
  );
  assert.deepEqual(userAuthored?.scopeRoots, ["D:\\fallback"]);
  const unknownRoots = await resolveMemoryEdits(
    ports({ sessionRoots: () => Promise.resolve(undefined) }),
    "m-1",
    { scope: "workspace" },
    ["D:\\fallback"]
  );
  assert.deepEqual(unknownRoots?.scopeRoots, ["D:\\fallback"]);
});

test("workspace scope with no roots anywhere omits the anchor", async () => {
  const resolved = await resolveMemoryEdits(
    ports({ sessionRoots: () => Promise.resolve([]) }),
    "m-1",
    { scope: "workspace" },
    []
  );
  assert.equal(resolved?.scope, "workspace");
  assert.equal(resolved?.scopeRoots, undefined);
});
