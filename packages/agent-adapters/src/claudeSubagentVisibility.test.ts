/**
 * Claude lineage tests. FIXTURE IS SYNTHETIC: built from the documented
 * stream-json format (Task tool_use + parent_tool_use_id sidechains +
 * tool_result user lines) because the standalone CLI is unauthenticated on
 * this host — replace with a live capture when available
 * (docs/design/subagent-workflows.md).
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { asId } from "@drydock/contracts";
import type { Clock, IdGenerator } from "@drydock/core";
import { ClaudeEventNormalizer, type ClaudeNormalizerContext } from "./claudeEventNormalizer.js";

test("task spawns, sidechain attribution, nested tasks, and task results as node_done", () => {
  const normalizer = new ClaudeEventNormalizer(new FixedIds(), new FixedClock());
  const stdout = [
    // Root spawns two subagents in one message.
    JSON.stringify({ type: "assistant", session_id: "claude-session-1", message: { content: [
      { type: "tool_use", id: "task-scribe", name: "Task", input: { description: "scribe", subagent_type: "general-purpose", prompt: "Write a haiku about rain to haiku.txt." } },
      { type: "tool_use", id: "task-lister", name: "Task", input: { description: "lister", prompt: "List the working directory." } }
    ] } }),
    // Sidechain: scribe works (text + a Bash call it later gets a result for).
    JSON.stringify({ type: "assistant", parent_tool_use_id: "task-scribe", message: { content: [
      { type: "text", text: "Writing haiku." },
      { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "echo haiku > haiku.txt" } }
    ] } }),
    JSON.stringify({ type: "user", parent_tool_use_id: "task-scribe", message: { content: [
      { type: "tool_result", tool_use_id: "bash-1", content: "ok" }
    ] } }),
    // Nested: scribe spawns its own subagent; the grandchild emits a line.
    JSON.stringify({ type: "assistant", parent_tool_use_id: "task-scribe", message: { content: [
      { type: "tool_use", id: "task-counter", name: "Task", input: { description: "counter", prompt: "Count words." } }
    ] } }),
    JSON.stringify({ type: "assistant", parent_tool_use_id: "task-counter", message: { content: [
      { type: "text", text: "12 words." }
    ] } }),
    JSON.stringify({ type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "task-counter", content: "12 words." }
    ] } }),
    // Scribe's Task result returns to root (success), lister's fails.
    JSON.stringify({ type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "task-scribe", content: [{ type: "text", text: "haiku written" }] }
    ] } }),
    JSON.stringify({ type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "task-lister", is_error: true, content: "lister blew up" }
    ] } }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "DONE", session_id: "claude-session-1", usage: { output_tokens: 42 } })
  ].join("\n");

  const parsed = normalizer.parseJsonLines(stdout, context());
  const types = parsed.events.map((event) => `${event.type}${event.agentPath === undefined ? "" : `@${event.agentPath.join("/")}`}`);
  assert.deepEqual(types, [
    "agent.spawn",                       // scribe (root emits)
    "agent.spawn",                       // lister
    "agent.text@task-scribe",
    "agent.command@task-scribe",         // started
    "agent.command@task-scribe",         // completed via tool_result
    "agent.spawn@task-scribe",           // nested counter
    "agent.text@task-scribe/task-counter",
    "agent.node_done@task-scribe",       // counter done (parent path = scribe)
    "agent.node_done",                   // scribe done (root path omitted)
    "agent.node_done",                   // lister failed
    "agent.done"
  ]);

  const scribeSpawn = parsed.events[0];
  assert.ok(scribeSpawn?.type === "agent.spawn");
  assert.equal(scribeSpawn.nodeId, "task-scribe");
  assert.equal(scribeSpawn.label, "scribe");
  assert.equal(scribeSpawn.subagentType, "general-purpose");
  assert.equal(scribeSpawn.promptPreview, "Write a haiku about rain to haiku.txt.");

  const bashDone = parsed.events[4];
  assert.ok(bashDone?.type === "agent.command");
  assert.equal(bashDone.status, "completed");
  assert.equal(bashDone.output, "ok");

  const counterDone = parsed.events[7];
  assert.ok(counterDone?.type === "agent.node_done");
  assert.equal(counterDone.nodeId, "task-counter");
  assert.equal(counterDone.status, "completed");

  const listerDone = parsed.events[9];
  assert.ok(listerDone?.type === "agent.node_done");
  assert.equal(listerDone.nodeId, "task-lister");
  assert.equal(listerDone.status, "failed");
  assert.equal(listerDone.resultPreview, "lister blew up");
  // The stored raw is the truncated display-safe form, never the full dump.
  assert.equal(listerDone.raw?.["truncated"], true);
});

test("oversized tool results are capped in both preview and stored raw", () => {
  const normalizer = new ClaudeEventNormalizer(new FixedIds(), new FixedClock());
  const huge = "x".repeat(5000);
  const stdout = [
    JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", id: "grep-1", name: "Grep", input: { pattern: "x" } }
    ] } }),
    JSON.stringify({ type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "grep-1", content: huge }
    ] } })
  ].join("\n");

  const parsed = normalizer.parseJsonLines(stdout, context());
  const completed = parsed.events[1];
  assert.ok(completed?.type === "agent.tool_call");
  assert.equal(completed.status, "completed");
  assert.equal(completed.toolUseId, "grep-1");
  assert.ok((completed.output ?? "").length <= 1025); // cap + ellipsis
  const rawContent = JSON.stringify(completed.raw);
  assert.ok(rawContent.length < 2500, `raw not truncated: ${String(rawContent.length)} chars`);
});

test("unknown parent ids still attribute under root instead of dropping", () => {
  const normalizer = new ClaudeEventNormalizer(new FixedIds(), new FixedClock());
  const parsed = normalizer.parseJsonLines(
    JSON.stringify({ type: "assistant", parent_tool_use_id: "mystery", message: { content: [{ type: "text", text: "hi" }] } }),
    context()
  );
  assert.deepEqual(parsed.events[0]?.agentPath, ["mystery"]);
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
  now(): Date { return new Date("2026-07-05T00:00:00.000Z"); }
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
}
