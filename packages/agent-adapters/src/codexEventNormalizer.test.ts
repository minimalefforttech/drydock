/**
 * Unit tests for Codex JSONL normalization.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { asId } from "@drydock/contracts";
import type { JsonObject } from "@drydock/contracts";
import type { Clock, IdGenerator } from "@drydock/core";
import { CodexEventNormalizer } from "./codexEventNormalizer.js";

test("normalizes Codex message, command, file, and done events", () => {
  const normalizer = new CodexEventNormalizer(new FixedIds(), new FixedClock());
  const stdout = [
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
    JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "ls" } }),
    JSON.stringify({ type: "item.completed", item: { type: "file_change", changes: [{ kind: "add", path: "output.txt" }] } }),
    JSON.stringify({ type: "turn.completed", usage: { inputTokens: 1 } })
  ].join("\n");

  const events = normalizer.parseJsonLines(stdout, {
    sessionId: asId<"SessionId">("session-test"),
    runId: asId<"RunId">("run-test"),
    agentRole: "worker"
  });

  assert.deepEqual(events.map((event) => event.type), [
    "agent.text",
    "agent.command",
    "agent.file_edit",
    "agent.done"
  ]);
  assert.equal(events[0]?.type === "agent.text" ? events[0].text : "", "done");
  assert.equal(events[2]?.type === "agent.file_edit" ? events[2].path : "", "output.txt");
});

class FixedClock implements Clock {
  now(): Date {
    return new Date("2026-07-01T00:00:00.000Z");
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
}

void ({} as JsonObject);

