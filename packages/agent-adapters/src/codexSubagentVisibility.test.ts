/**
 * Subagent visibility tests for both codex transports. Fixture shapes
 * are trimmed from the 2026-07-05 live probe captures
 * (docs/design/probes/2026-07-05-codex-subagents/), including the real
 * failed-child case (lister's sandboxed pwsh died).
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { asId } from "@drydock/contracts";
import type { Clock, IdGenerator } from "@drydock/core";
import { CodexAppServerEventNormalizer } from "./codexAppServerEventNormalizer.js";
import { CodexEventNormalizer } from "./codexEventNormalizer.js";
import { CodexThreadLineage } from "./codexThreadLineage.js";

const ROOT = "thread-root";
const SCRIBE = "thread-scribe";
const LISTER = "thread-lister";

function appServerContext(lineage: CodexThreadLineage) {
  return {
    sessionId: asId<"SessionId">("session-fixed"),
    runId: asId<"RunId">("run-fixed"),
    agentRole: "worker" as const,
    runtimeId: asId<"RuntimeId">("runtime-fixed"),
    lineage
  };
}

function notification(method: string, params: Record<string, unknown>) {
  return { method, params } as never;
}

test("app-server: spawn edges attribute child threads and only the root turn ends the run", () => {
  const normalizer = new CodexAppServerEventNormalizer(new FixedIds(), new FixedClock());
  const lineage = new CodexThreadLineage(ROOT);
  const context = appServerContext(lineage);

  const spawn = normalizer.normalize(notification("item/completed", {
    threadId: ROOT,
    turnId: "turn-1",
    item: {
      type: "collabAgentToolCall",
      id: "collab-1",
      tool: "spawnAgent",
      status: "completed",
      senderThreadId: ROOT,
      receiverThreadIds: [SCRIBE],
      prompt: "You are named scribe. Write a haiku about rain to haiku.txt.",
      model: "gpt-5.5",
      agentsStates: { [SCRIBE]: { status: "pendingInit", message: null } }
    }
  }), context);
  assert.deepEqual(spawn.map((event) => event.type), ["agent.spawn"]);
  const spawnEvent = spawn[0];
  assert.ok(spawnEvent?.type === "agent.spawn");
  assert.equal(spawnEvent.nodeId, SCRIBE);
  assert.equal(spawnEvent.model, "gpt-5.5");
  assert.ok(spawnEvent.label.startsWith("You are named scribe."));
  assert.equal(spawnEvent.agentPath, undefined); // root emitted it

  // Child activity is attributed, not misfiled under root.
  const childEdit = normalizer.normalize(notification("item/completed", {
    threadId: SCRIBE,
    turnId: "turn-2",
    item: { type: "fileChange", id: "fc-1", status: "completed", changes: [{ path: "haiku.txt", kind: "add" }] }
  }), context);
  assert.equal(childEdit[0]?.type, "agent.file_edit");
  assert.deepEqual(childEdit[0]?.agentPath, [SCRIBE]);

  // Per-thread usage is held and stamped onto the child's terminal event.
  normalizer.normalize(notification("thread/tokenUsage/updated", {
    threadId: SCRIBE,
    tokenUsage: { total: { totalTokens: 28192 }, last: { totalTokens: 177 } }
  }), context);

  // THE FIX: a child's turn/completed is its node_done, not the run's end.
  const childDone = normalizer.normalize(notification("turn/completed", { threadId: SCRIBE, turn: { id: "turn-2" } }), context);
  assert.deepEqual(childDone.map((event) => event.type), ["agent.node_done"]);
  const nodeDone = childDone[0];
  assert.ok(nodeDone?.type === "agent.node_done");
  assert.equal(nodeDone.nodeId, SCRIBE);
  assert.equal(nodeDone.status, "completed");
  assert.deepEqual(nodeDone.usage, { totalTokens: 28192 });
  assert.deepEqual(nodeDone.agentPath, undefined); // parent (root) path

  // A later wait's agentsStates message merges via a second node_done.
  const waitDone = normalizer.normalize(notification("item/completed", {
    threadId: ROOT,
    item: {
      type: "collabAgentToolCall",
      id: "collab-2",
      tool: "wait",
      status: "completed",
      senderThreadId: ROOT,
      receiverThreadIds: [SCRIBE],
      agentsStates: { [SCRIBE]: { status: "completed", message: "nested spawning unsupported" } }
    }
  }), context);
  assert.deepEqual(waitDone.map((event) => event.type), ["agent.node_done"]);
  assert.equal(waitDone[0]?.type === "agent.node_done" ? waitDone[0].resultPreview : "", "nested spawning unsupported");

  // Only the ROOT turn/completed produces agent.done.
  const rootDone = normalizer.normalize(notification("turn/completed", {
    threadId: ROOT,
    usage: { totalTokens: 74219 }
  }), context);
  assert.deepEqual(rootDone.map((event) => event.type), ["agent.done"]);
});

test("app-server: wait-first ordering (probe order) emits one terminal per child with message and usage", () => {
  const normalizer = new CodexAppServerEventNormalizer(new FixedIds(), new FixedClock());
  const lineage = new CodexThreadLineage(ROOT);
  const context = appServerContext(lineage);

  normalizer.normalize(notification("item/completed", {
    threadId: ROOT,
    item: {
      type: "collabAgentToolCall", id: "c1", tool: "spawnAgent", status: "completed",
      senderThreadId: ROOT, receiverThreadIds: [LISTER], prompt: "You are named lister.",
      agentsStates: {}
    }
  }), context);
  normalizer.normalize(notification("thread/tokenUsage/updated", {
    threadId: LISTER, tokenUsage: { total: { totalTokens: 28112 } }
  }), context);

  // Probe order: the wait completion (with the failure message) arrives
  // BEFORE the child's own turn/completed.
  const waitEvents = normalizer.normalize(notification("item/completed", {
    threadId: ROOT,
    item: {
      type: "collabAgentToolCall", id: "c2", tool: "wait", status: "completed",
      senderThreadId: ROOT, receiverThreadIds: [LISTER],
      agentsStates: { [LISTER]: { status: "errored", message: "sandbox process failed" } }
    }
  }), context);
  assert.deepEqual(waitEvents.map((event) => event.type), ["agent.node_done"]);
  const done = waitEvents[0];
  assert.ok(done?.type === "agent.node_done");
  assert.equal(done.status, "failed");
  assert.equal(done.resultPreview, "sandbox process failed");
  assert.deepEqual(done.usage, { totalTokens: 28112 });

  // The child's own turn/completed afterwards is a deduped no-op.
  assert.deepEqual(normalizer.normalize(notification("turn/completed", { threadId: LISTER }), context), []);

  // close_agent repeating the same terminal state stays silent too? It
  // carries the same message - a repeat emit is allowed only when a message
  // is present, and the reducer merges it idempotently. Assert the shape.
  const closeEvents = normalizer.normalize(notification("item/completed", {
    threadId: ROOT,
    item: {
      type: "collabAgentToolCall", id: "c3", tool: "closeAgent", status: "completed",
      senderThreadId: ROOT, receiverThreadIds: [LISTER],
      agentsStates: { [LISTER]: { status: "errored", message: "sandbox process failed" } }
    }
  }), context);
  for (const event of closeEvents) {
    assert.equal(event.type, "agent.node_done");
  }
});

test("app-server: webSearch items map to attributed tool calls", () => {
  const normalizer = new CodexAppServerEventNormalizer(new FixedIds(), new FixedClock());
  const lineage = new CodexThreadLineage(ROOT);
  const context = appServerContext(lineage);

  const events = normalizer.normalize(notification("item/completed", {
    threadId: ROOT,
    item: { type: "webSearch", id: "ws-1", query: "https://example.com/", action: { type: "other" } }
  }), context);
  assert.deepEqual(events.map((event) => event.type), ["agent.tool_call"]);
  const call = events[0];
  assert.ok(call?.type === "agent.tool_call");
  assert.equal(call.toolName, "web_search");
  assert.equal(call.status, "completed");
  assert.equal(call.output, "https://example.com/");
  assert.equal(call.toolUseId, "ws-1");
});

test("app-server: activity on an unspawned thread lands under root instead of vanishing", () => {
  const normalizer = new CodexAppServerEventNormalizer(new FixedIds(), new FixedClock());
  const lineage = new CodexThreadLineage(ROOT);
  const context = appServerContext(lineage);

  const events = normalizer.normalize(notification("item/completed", {
    threadId: "thread-mystery",
    item: { type: "agentMessage", id: "m1", text: "hello" }
  }), context);
  assert.equal(events[0]?.type, "agent.text");
  assert.deepEqual(events[0]?.agentPath, ["thread-mystery"]);
});

test("exec --json: collab lifecycle maps to spawn/node_done and web_search to a tool call (probe lines)", () => {
  const normalizer = new CodexEventNormalizer(new FixedIds(), new FixedClock());
  // Trimmed verbatim shapes from codex-exec-stream.jsonl (2026-07-05 probe).
  const stdout = [
    JSON.stringify({ type: "thread.started", thread_id: ROOT }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: {
      type: "collab_tool_call", id: "c1", tool: "spawn_agent", status: "completed",
      sender_thread_id: ROOT, receiver_thread_ids: [SCRIBE],
      prompt: "You are named scribe. Create haiku.txt.",
      agents_states: { [SCRIBE]: { status: "pending_init", message: null } }
    } }),
    JSON.stringify({ type: "item.started", item: { type: "web_search", id: "ws-1", query: "", action: { type: "other" } } }),
    JSON.stringify({ type: "item.completed", item: { type: "web_search", id: "ws-1", query: "https://example.com/", action: { type: "other" } } }),
    JSON.stringify({ type: "item.completed", item: {
      type: "collab_tool_call", id: "c2", tool: "wait", status: "completed",
      sender_thread_id: ROOT, receiver_thread_ids: [SCRIBE],
      agents_states: { [SCRIBE]: { status: "completed", message: "nested spawning unsupported" } }
    } }),
    JSON.stringify({ type: "item.completed", item: {
      type: "collab_tool_call", id: "c3", tool: "close_agent", status: "completed",
      sender_thread_id: ROOT, receiver_thread_ids: [SCRIBE],
      agents_states: { [SCRIBE]: { status: "completed", message: "nested spawning unsupported" } }
    } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", id: "m1", text: "DONE" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 92807, output_tokens: 538 } })
  ].join("\n");

  const events = normalizer.parseJsonLines(stdout, {
    sessionId: asId<"SessionId">("session-fixed"),
    runId: asId<"RunId">("run-fixed"),
    agentRole: "worker",
    runtimeId: asId<"RuntimeId">("runtime-fixed")
  });

  assert.deepEqual(events.map((event) => event.type), [
    "agent.spawn",
    "agent.tool_call", // web_search started
    "agent.tool_call", // web_search completed
    "agent.node_done", // from wait; close_agent repeat is deduped
    "agent.text",
    "agent.done"
  ]);
  const spawn = events[0];
  assert.ok(spawn?.type === "agent.spawn");
  assert.equal(spawn.nodeId, SCRIBE);
  assert.equal(spawn.promptPreview, "You are named scribe. Create haiku.txt.");
  const nodeDone = events[3];
  assert.ok(nodeDone?.type === "agent.node_done");
  assert.equal(nodeDone.status, "completed");
  assert.equal(nodeDone.resultPreview, "nested spawning unsupported");
});

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
  planId() { return asId<"PlanId">("plan-test"); }
  planArtifactId() { return asId<"PlanArtifactId">("plart-test"); }
  planAnnotationId() { return asId<"PlanAnnotationId">("plnote-test"); }
}
