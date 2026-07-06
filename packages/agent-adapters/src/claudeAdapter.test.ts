/**
 * Unit tests for the Claude adapter's exec transport: argument shape, resume
 * continuity, context restoration, and cancellation.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { asId } from "@drydock/contracts";
import type { AgentEvent, CommandResult, RuntimeHandle } from "@drydock/contracts";
import type { Clock, IdGenerator } from "@drydock/core";
import { ClaudeAdapter } from "./claudeAdapter.js";

test("turns run claude -p stream-json with resume continuity and model override", async () => {
  const executor = new FakeExecutor([
    execResult([
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-abc" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "first reply" }] } }),
      JSON.stringify({ type: "result", is_error: false, result: "first reply", session_id: "claude-abc" })
    ].join("\n")),
    execResult(JSON.stringify({ type: "result", is_error: false, result: "second", session_id: "claude-abc" }))
  ]);
  const adapter = makeAdapter(executor);
  const connection = await adapter.startProtocol(protocolRequest());

  const firstRun = await adapter.sendPrompt(connection, { text: "hello", metadata: { providerId: "claude", model: "claude-opus-4-8" } });
  const firstEvents = await collect(adapter.streamEvents(connection, firstRun));

  assert.deepEqual(executor.calls[0]?.args.slice(0, 6), ["claude", "-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"]);
  assert.deepEqual(executor.calls[0]?.args.slice(6), ["--model", "claude-opus-4-8"]);
  assert.equal(executor.calls[0]?.input, "hello");
  assert.deepEqual(firstEvents.map((event) => event.type), ["agent.text", "agent.done"]);

  const secondRun = await adapter.sendPrompt(connection, { text: "again" });
  await collect(adapter.streamEvents(connection, secondRun));
  assert.deepEqual(executor.calls[1]?.args.slice(-2), ["--resume", "claude-abc"]);
});

test("restored context is delivered as a preamble on the next prompt only", async () => {
  const executor = new FakeExecutor([execResult(""), execResult("")]);
  const adapter = makeAdapter(executor);
  const connection = await adapter.startProtocol(protocolRequest());
  await adapter.restoreContext(connection, [
    { role: "user", text: "earlier question", createdAt: "2026-07-03T00:00:00.000Z" },
    { role: "assistant", text: "earlier answer", createdAt: "2026-07-03T00:00:01.000Z" }
  ]);

  const runId = await adapter.sendPrompt(connection, { text: "follow-up" });
  await collect(adapter.streamEvents(connection, runId));
  assert.match(executor.calls[0]?.input ?? "", /earlier question/);
  assert.match(executor.calls[0]?.input ?? "", /Current request:\nfollow-up/);

  const nextRun = await adapter.sendPrompt(connection, { text: "clean" });
  await collect(adapter.streamEvents(connection, nextRun));
  assert.equal(executor.calls[1]?.input, "clean");
});

test("cancel aborts the in-flight exec and maps to TURN_CANCELLED", async () => {
  const executor = new FakeExecutor([execResult("", 1, true)]);
  const adapter = makeAdapter(executor);
  const connection = await adapter.startProtocol(protocolRequest());

  const runId = await adapter.sendPrompt(connection, { text: "long task" });
  await adapter.cancel(connection, runId);
  const events = await collect(adapter.streamEvents(connection, runId));

  assert.equal(executor.calls[0]?.signal?.aborted, true);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type === "agent.error" ? events[0].code : "", "TURN_CANCELLED");
});

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function makeAdapter(executor: FakeExecutor): ClaudeAdapter {
  return new ClaudeAdapter({
    ids: new FixedIds(),
    clock: new FixedClock(),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    runtimeExecutor: executor
  });
}

function protocolRequest() {
  return {
    sessionId: asId<"SessionId">("session-fixed"),
    agentId: asId<"AgentId">("agent-fixed"),
    agentRole: "worker" as const,
    runtime: runtimeHandle(),
    transport: "claude-exec-json" as const
  };
}

function runtimeHandle(): RuntimeHandle {
  return {
    runtimeId: asId<"RuntimeId">("runtime-fixed"),
    runtimeGenerationId: asId<"RuntimeGenerationId">("generation-fixed"),
    sessionId: asId<"SessionId">("session-fixed"),
    adapter: "docker-sandbox",
    externalName: "drydock-claude-test",
    workspacePath: "C:\\tmp\\workspace",
    runtimeCwd: "/workspace",
    mounts: [],
    status: "running"
  };
}

function execResult(stdout: string, exitCode = 0, timedOut = false): CommandResult {
  return {
    command: "sbx",
    args: [],
    cwd: "C:\\tmp",
    exitCode,
    signal: null,
    timedOut,
    stdout,
    stderr: "",
    durationMs: 5
  };
}

interface ExecCall {
  readonly args: readonly string[];
  readonly input?: string;
  readonly signal?: AbortSignal;
}

class FakeExecutor {
  readonly calls: ExecCall[] = [];

  constructor(private readonly results: CommandResult[]) {}

  async exec(_handle: RuntimeHandle, args: readonly string[], _timeoutMs: number, input?: string, signal?: AbortSignal): Promise<CommandResult> {
    this.calls.push({ args, ...(input === undefined ? {} : { input }), ...(signal === undefined ? {} : { signal }) });
    const result = this.results.shift();
    if (result === undefined) {
      throw new Error("FakeExecutor ran out of canned results.");
    }
    // Let the caller register the run before the result settles, mirroring the
    // real non-blocking exec.
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (signal?.aborted && result.exitCode === 0) {
      return { ...result, exitCode: 1 };
    }
    return result;
  }
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
  runId() {
    this.next += 1;
    return asId<"RunId">(`run-${String(this.next)}`);
  }
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
