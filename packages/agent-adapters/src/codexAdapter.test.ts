/**
 * Unit tests for the Codex adapter's exec-json transport: restored context is
 * delivered as a plain-text preamble on the next prompt only, mirroring the
 * Claude adapter's restore strategy.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { asId } from "@drydock/contracts";
import type { AgentEvent, CommandResult, RuntimeHandle } from "@drydock/contracts";
import type { Clock, IdGenerator } from "@drydock/core";
import { CodexAdapter } from "./codexAdapter.js";

test("restored context is delivered as a preamble on the next exec prompt only", async () => {
  const executor = new FakeExecutor([execResult(""), execResult("")]);
  const adapter = makeAdapter(executor);
  const connection = await adapter.startProtocol(protocolRequest());
  await adapter.restoreContext(connection, [
    { role: "user", text: "earlier question", createdAt: "2026-07-03T00:00:00.000Z" },
    { role: "assistant", text: "earlier answer", createdAt: "2026-07-03T00:00:01.000Z" }
  ]);

  const firstRun = await adapter.sendPrompt(connection, { text: "follow-up" });
  await collect(adapter.streamEvents(connection, firstRun));
  assert.match(executor.calls[0]?.input ?? "", /earlier question/);
  assert.match(executor.calls[0]?.input ?? "", /earlier answer/);
  assert.match(executor.calls[0]?.input ?? "", /Current request:\nfollow-up/);

  // The buffered context is consumed once; the next prompt is verbatim.
  const secondRun = await adapter.sendPrompt(connection, { text: "clean" });
  await collect(adapter.streamEvents(connection, secondRun));
  assert.equal(executor.calls[1]?.input, "clean");
});

test("without restored context the exec prompt is sent verbatim", async () => {
  const executor = new FakeExecutor([execResult("")]);
  const adapter = makeAdapter(executor);
  const connection = await adapter.startProtocol(protocolRequest());

  const runId = await adapter.sendPrompt(connection, { text: "plain" });
  await collect(adapter.streamEvents(connection, runId));
  assert.equal(executor.calls[0]?.input, "plain");
});

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function makeAdapter(executor: FakeExecutor): CodexAdapter {
  return new CodexAdapter({
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
    transport: "codex-exec-json" as const
  };
}

function runtimeHandle(): RuntimeHandle {
  return {
    runtimeId: asId<"RuntimeId">("runtime-fixed"),
    runtimeGenerationId: asId<"RuntimeGenerationId">("generation-fixed"),
    sessionId: asId<"SessionId">("session-fixed"),
    adapter: "docker-sandbox",
    externalName: "drydock-codex-test",
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
}

class FakeExecutor {
  readonly calls: ExecCall[] = [];

  constructor(private readonly results: CommandResult[]) {}

  async exec(_handle: RuntimeHandle, args: readonly string[], _timeoutMs: number, input?: string): Promise<CommandResult> {
    this.calls.push({ args, ...(input === undefined ? {} : { input }) });
    const result = this.results.shift();
    if (result === undefined) {
      throw new Error("FakeExecutor ran out of canned results.");
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
  columnId() { return asId<"ColumnId">("col-fixed"); }
  subtaskId() { return asId<"SubtaskId">("subtask-fixed"); }
}
