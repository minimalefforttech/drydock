/**
 * Unit tests for Codex app-server notification normalization.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { asId } from "@drydock/contracts";
import type { Clock, IdGenerator } from "@drydock/core";
import { CodexAppServerEventNormalizer } from "./codexAppServerEventNormalizer.js";

test("normalizes app-server text, command, file, plan, and done notifications", () => {
  const normalizer = new CodexAppServerEventNormalizer(new FixedIds(), new FixedClock());
  const context = {
    sessionId: asId<"SessionId">("session-test"),
    runId: asId<"RunId">("run-test"),
    agentRole: "worker" as const,
    runtimeId: asId<"RuntimeId">("runtime-test")
  };
  const events = [
    ...normalizer.normalize({ method: "item/agentMessage/delta", params: { delta: "hi" } }, context),
    ...normalizer.normalize({ method: "item/started", params: { item: { type: "command_execution", command: "ls" } } }, context),
    ...normalizer.normalize({ method: "item/fileChange/patchUpdated", params: { path: "src/app.ts", kind: "update" } }, context),
    ...normalizer.normalize({ method: "turn/plan/updated", params: { plan: "Do the thing" } }, context),
    ...normalizer.normalize({ method: "turn/completed", params: { usage: { inputTokens: 1 } } }, context)
  ];

  assert.deepEqual(events.map((event) => event.type), [
    "agent.text",
    "agent.command",
    "agent.file_edit",
    "agent.plan",
    "agent.done"
  ]);
  assert.equal(events[0]?.type === "agent.text" ? events[0].text : "", "hi");
  assert.equal(events[2]?.type === "agent.file_edit" ? events[2].path : "", "src/app.ts");
  assert.equal(events[4]?.type === "agent.done" ? events[4].status : "", "completed");
});

test("a completed command execution carries its captured output and exit code", () => {
  const normalizer = new CodexAppServerEventNormalizer(new FixedIds(), new FixedClock());
  const context = {
    sessionId: asId<"SessionId">("session-test"),
    runId: asId<"RunId">("run-test"),
    agentRole: "worker" as const,
    runtimeId: asId<"RuntimeId">("runtime-test")
  };
  const events = normalizer.normalize({
    method: "item/completed",
    params: { item: { type: "command_execution", command: "ls", exit_code: 0, aggregated_output: "file-a\nfile-b\n" } }
  }, context);

  assert.deepEqual(events.map((event) => event.type), ["agent.command"]);
  const command = events[0];
  assert.equal(command?.type === "agent.command" ? command.exitCode : -1, 0);
  assert.ok(command?.type === "agent.command" && (command.output ?? "").includes("file-a"));
});

test("normalizes app-server reasoning deltas into agent.reasoning events", () => {
  const normalizer = new CodexAppServerEventNormalizer(new FixedIds(), new FixedClock());
  const context = {
    sessionId: asId<"SessionId">("session-test"),
    runId: asId<"RunId">("run-test"),
    agentRole: "worker" as const,
    runtimeId: asId<"RuntimeId">("runtime-test")
  };
  const events = normalizer.normalize({ method: "item/reasoning/delta", params: { delta: "considering the approach" } }, context);

  assert.deepEqual(events.map((event) => event.type), ["agent.reasoning"]);
  assert.equal(events[0]?.type === "agent.reasoning" ? events[0].text : "", "considering the approach");
});

test("normalizes app-server turn failures into error plus terminal failed", () => {
  const normalizer = new CodexAppServerEventNormalizer(new FixedIds(), new FixedClock());
  const events = normalizer.normalize({
    method: "turn/failed",
    params: { code: "MODEL_ERROR", message: "model stopped" }
  }, {
    sessionId: asId<"SessionId">("session-test"),
    runId: asId<"RunId">("run-test"),
    agentRole: "worker"
  });

  assert.deepEqual(events.map((event) => event.type), ["agent.error", "agent.done"]);
  assert.equal(events[0]?.type === "agent.error" ? events[0].code : "", "MODEL_ERROR");
  assert.equal(events[1]?.type === "agent.done" ? events[1].status : "", "failed");
});

class FixedClock implements Clock {
  now(): Date {
    return new Date("2026-07-02T00:00:00.000Z");
  }

  isoNow(): string {
    return this.now().toISOString();
  }
}

class FixedIds implements IdGenerator {
  private next = 0;

  sessionId() { return asId<"SessionId">("session-fixed"); }
  chatId() { return asId<"ChatId">("chat-fixed"); }
  runtimeId() { return asId<"RuntimeId">("runtime-fixed"); }
  runtimeGenerationId() { return asId<"RuntimeGenerationId">("generation-fixed"); }
  agentId() { return asId<"AgentId">("agent-fixed"); }
  runId() { return asId<"RunId">("run-fixed"); }
  mountId() { return asId<"MountId">("mount-fixed"); }
  eventId() {
    this.next += 1;
    return asId<"EventId">(`event-${String(this.next)}`);
  }
  projectId() { return asId<"ProjectId">("project-fixed"); }
  workspaceSetId() { return asId<"WorkspaceSetId">("workspace-set-fixed"); }
  accessRequestId() { return asId<"AccessRequestId">("access-request-fixed"); }
  agentQuestionId() { return asId<"AgentQuestionId">("question-fixed"); }
  baselineId() { return asId<"BaselineId">("baseline-fixed"); }
  reviewSessionId() { return asId<"ReviewSessionId">("review-fixed"); }
  reviewCommentId() { return asId<"ReviewCommentId">("comment-fixed"); }
  taskId() { return asId<"TaskId">("task-fixed"); }
  memoryCandidateId() { return asId<"MemoryCandidateId">("memory-fixed"); }
  columnId() { return asId<"ColumnId">("col-fixed"); }
  subtaskId() { return asId<"SubtaskId">("subtask-fixed"); }
}
