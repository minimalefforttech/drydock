/**
 * Unit tests for Claude stream-json normalization.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { asId } from "@drydock/contracts";
import type { Clock, IdGenerator } from "@drydock/core";
import { ClaudeEventNormalizer, type ClaudeNormalizerContext } from "./claudeEventNormalizer.js";

test("normalizes text, commands, file edits, tool calls, and completion", () => {
  const normalizer = new ClaudeEventNormalizer(new FixedIds(), new FixedClock());
  const stdout = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-opus-4-8" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/workspace/notes.txt", content: "hi" } }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch", input: { query: "docs" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "All done." }] } }),
    "not json noise",
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "All done.", session_id: "claude-session-1", usage: { output_tokens: 12 } })
  ].join("\n");

  const parsed = normalizer.parseJsonLines(stdout, context());

  assert.equal(parsed.claudeSessionId, "claude-session-1");
  assert.deepEqual(parsed.events.map((event) => event.type), [
    "agent.command",
    "agent.file_edit",
    "agent.tool_call",
    "agent.text",
    "agent.done"
  ]);
  const [command, fileEdit, toolCall, text, done] = parsed.events;
  assert.deepEqual(command?.type === "agent.command" ? command.command : [], ["npm test"]);
  assert.equal(fileEdit?.type === "agent.file_edit" ? fileEdit.path : "", "/workspace/notes.txt");
  assert.equal(fileEdit?.type === "agent.file_edit" ? fileEdit.changeKind : "", "add");
  assert.equal(toolCall?.type === "agent.tool_call" ? toolCall.toolName : "", "WebSearch");
  assert.equal(text?.type === "agent.text" ? text.text : "", "All done.");
  assert.equal(done?.type === "agent.done" ? done.status : "", "completed");
});

test("captures thinking and redacted_thinking blocks as agent.reasoning events", () => {
  const normalizer = new ClaudeEventNormalizer(new FixedIds(), new FixedClock());
  const stdout = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "Let me consider the approach." }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "redacted_thinking", data: "opaque" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } })
  ].join("\n");

  const parsed = normalizer.parseJsonLines(stdout, context());

  assert.deepEqual(parsed.events.map((event) => event.type), ["agent.reasoning", "agent.reasoning", "agent.text"]);
  const [thinking, redacted] = parsed.events;
  assert.equal(thinking?.type === "agent.reasoning" ? thinking.text : "", "Let me consider the approach.");
  assert.equal(redacted?.type === "agent.reasoning" ? redacted.text : "", "[redacted reasoning]");
});

test("error results produce agent.error plus a failed terminal event", () => {
  const normalizer = new ClaudeEventNormalizer(new FixedIds(), new FixedClock());
  const stdout = JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "credit balance too low",
    session_id: "claude-session-2"
  });

  const parsed = normalizer.parseJsonLines(stdout, context());

  assert.deepEqual(parsed.events.map((event) => event.type), ["agent.error", "agent.done"]);
  const [error, done] = parsed.events;
  assert.equal(error?.type === "agent.error" ? error.code : "", "ERROR_DURING_EXECUTION");
  assert.equal(error?.type === "agent.error" ? error.message : "", "credit balance too low");
  assert.equal(done?.type === "agent.done" ? done.status : "", "failed");
});

function context(): ClaudeNormalizerContext {
  return {
    sessionId: asId<"SessionId">("session-fixed"),
    runId: asId<"RunId">("run-fixed"),
    agentRole: "worker",
    runtimeId: asId<"RuntimeId">("runtime-fixed")
  };
}

class FixedClock implements Clock {
  now(): Date { return new Date("2026-07-03T00:00:00.000Z"); }
  isoNow(): string { return this.now().toISOString(); }
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
  planId() { return asId<"PlanId">("plan-test"); }
  planArtifactId() { return asId<"PlanArtifactId">("plart-test"); }
  planAnnotationId() { return asId<"PlanAnnotationId">("plnote-test"); }
}
