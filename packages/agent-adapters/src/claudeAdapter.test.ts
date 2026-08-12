/**
 * Unit tests for the Claude adapter's streaming exec transport: argument
 * shape, live line-fed events, resume continuity, context restoration,
 * cancellation, stall handling, and in-runtime model discovery.
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

test("events survive buffered-stdout truncation because they stream per line", async () => {
  // The buffered CommandResult stdout is truncated to nothing (the historical
  // 120KB-cap failure); the turn must still deliver every event, including the
  // terminal done, purely from the live line stream.
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "claude-big" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "big reply" }] } }),
    JSON.stringify({ type: "result", is_error: false, result: "big reply", session_id: "claude-big" })
  ];
  const executor = new FakeExecutor([
    { result: { ...execResult(""), stdout: "[truncated 999999 chars]\n" }, lines }
  ]);
  const adapter = makeAdapter(executor);
  const connection = await adapter.startProtocol(protocolRequest());

  const runId = await adapter.sendPrompt(connection, { text: "huge turn" });
  const events = await collect(adapter.streamEvents(connection, runId));

  assert.deepEqual(events.map((event) => event.type), ["agent.text", "agent.done"]);

  // Continuity survived too: the next turn resumes the captured session id.
  const nextRun = await adapter.sendPrompt(connection, { text: "follow-up" });
  await collect(adapter.streamEvents(connection, nextRun));
  assert.deepEqual(executor.calls[1]?.args.slice(-2), ["--resume", "claude-big"]);
});

test("a clean exit without a result line is an explicit error, never silence", async () => {
  const executor = new FakeExecutor([
    execResult(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }))
  ]);
  const adapter = makeAdapter(executor);
  const connection = await adapter.startProtocol(protocolRequest());

  const runId = await adapter.sendPrompt(connection, { text: "hello" });
  const events = await collect(adapter.streamEvents(connection, runId));

  assert.deepEqual(events.map((event) => event.type), ["agent.text", "agent.error"]);
  const error = events[1];
  assert.equal(error?.type === "agent.error" ? error.retryable : false, true);
  assert.match(error?.type === "agent.error" ? error.message : "", /never emitted a terminal result line/);
});

test("ridden providers wrap the exec in sh -c with wire env and the token file, never the token itself", async () => {
  const executor = new FakeExecutor([execResult(JSON.stringify({ type: "result", is_error: false, result: "ok", session_id: "s1" }))]);
  const adapter = new ClaudeAdapter({
    ids: new FixedIds(),
    clock: new FixedClock(),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    runtimeExecutor: executor,
    providerId: "deepseek",
    wire: {
      baseUrl: "https://api.deepseek.com/anthropic",
      tokenFile: "/tmp/.drydock-provider-token",
      smallFastModel: "deepseek-chat"
    }
  });
  const connection = await adapter.startProtocol(protocolRequest());
  assert.equal(String(connection.providerId), "deepseek");

  const runId = await adapter.sendPrompt(connection, { text: "hello", metadata: { model: "deepseek-chat" } });
  await collect(adapter.streamEvents(connection, runId));

  const args = executor.calls[0]?.args ?? [];
  assert.deepEqual(args.slice(0, 2), ["sh", "-c"]);
  const command = args[2] ?? "";
  // Token comes from the runtime-scoped file via command substitution.
  assert.match(command, /ANTHROPIC_AUTH_TOKEN="\$\(cat '\/tmp\/\.drydock-provider-token' 2>\/dev\/null\)"/);
  assert.match(command, /ANTHROPIC_BASE_URL=https:\/\/api\.deepseek\.com\/anthropic/);
  assert.match(command, /ANTHROPIC_SMALL_FAST_MODEL=deepseek-chat/);
  assert.match(command, /'--model' 'deepseek-chat'/);
  // The prompt still rides stdin, through the shell into claude.
  assert.equal(executor.calls[0]?.input, "hello");
});

test("a rider turn without an explicit model is rejected with an actionable error", async () => {
  const executor = new FakeExecutor([]);
  const adapter = new ClaudeAdapter({
    ids: new FixedIds(),
    clock: new FixedClock(),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    runtimeExecutor: executor,
    providerId: "deepseek",
    wire: { baseUrl: "https://api.deepseek.com/anthropic", tokenFile: "/tmp/.drydock-provider-token" }
  });
  const connection = await adapter.startProtocol(protocolRequest());
  await assert.rejects(adapter.sendPrompt(connection, { text: "hello" }), /needs an explicit model/);
  assert.equal(executor.calls.length, 0);
});

test("restored context is delivered as a preamble on the next prompt only", async () => {
  const done = JSON.stringify({ type: "result", is_error: false, result: "ok", session_id: "s2" });
  const executor = new FakeExecutor([execResult(done), execResult(done)]);
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

test("a turn with no output past the inactivity window is stopped as CLAUDE_TURN_STALLED", async () => {
  const executor = new HangingExecutor();
  const adapter = new ClaudeAdapter({
    ids: new FixedIds(),
    clock: new FixedClock(),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    runtimeExecutor: executor,
    inactivityTimeoutMs: 20
  });
  const connection = await adapter.startProtocol(protocolRequest());

  const runId = await adapter.sendPrompt(connection, { text: "stalls forever" });
  const events = await collect(adapter.streamEvents(connection, runId));

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type === "agent.error" ? events[0].code : "", "CLAUDE_TURN_STALLED");
  assert.equal(events[0]?.type === "agent.error" ? events[0].retryable : false, true);
});

test("listModels probes api.anthropic.com inside the runtime and maps the reply", async () => {
  const executor = new FakeExecutor([
    execResult(JSON.stringify({
      ok: true,
      models: [
        { id: "claude-fable-5", display_name: "Claude Fable 5" },
        { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }
      ]
    }))
  ]);
  const adapter = makeAdapter(executor);
  const connection = await adapter.startProtocol(protocolRequest());

  const catalog = await adapter.listModels(connection);
  assert.equal(catalog.source, "provider");
  assert.deepEqual(catalog.models.map((model) => model.id), ["claude-fable-5", "claude-sonnet-5"]);
  assert.equal(executor.calls[0]?.args[0], "node");
});

test("listModels failure is an unavailable catalog carrying the reason, not an invented list", async () => {
  const executor = new FakeExecutor([execResult(JSON.stringify({ ok: false, error: "401 invalid bearer token" }))]);
  const adapter = makeAdapter(executor);
  const connection = await adapter.startProtocol(protocolRequest());

  const catalog = await adapter.listModels(connection);
  assert.equal(catalog.source, "unavailable");
  assert.equal(catalog.models.length, 0);
  assert.match(catalog.diagnostics.join(" "), /401 invalid bearer token/);
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

/** A canned exec outcome: the buffered result plus (optionally) what the live line feed emits. */
type CannedExec = CommandResult | { readonly result: CommandResult; readonly lines: readonly string[] };

/**
 * Canned executor that mirrors the real streaming exec: lines are fed through
 * onStdoutLine before the buffered result settles. The buffered stdout may
 * deliberately differ from the line feed (truncation tests) - exactly how the
 * real runner behaves when its capture cap trims stdout.
 */
class FakeExecutor {
  readonly calls: ExecCall[] = [];

  constructor(private readonly results: CannedExec[]) {}

  async exec(
    _handle: RuntimeHandle,
    args: readonly string[],
    _timeoutMs: number,
    input?: string,
    signal?: AbortSignal,
    onStdoutLine?: (line: string) => void
  ): Promise<CommandResult> {
    this.calls.push({ args, ...(input === undefined ? {} : { input }), ...(signal === undefined ? {} : { signal }) });
    const canned = this.results.shift();
    if (canned === undefined) {
      throw new Error("FakeExecutor ran out of canned results.");
    }
    const result = "result" in canned ? canned.result : canned;
    const lines = "result" in canned ? canned.lines : canned.stdout.split("\n");
    // Let the caller register the run before lines flow, mirroring the real
    // non-blocking exec.
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (!signal?.aborted && onStdoutLine !== undefined) {
      for (const line of lines) {
        if (line.length > 0) onStdoutLine(line);
      }
    }
    if (signal?.aborted && result.exitCode === 0) {
      return { ...result, exitCode: 1 };
    }
    return result;
  }
}

/** Never produces output or settles until the abort signal kills it. */
class HangingExecutor {
  async exec(
    _handle: RuntimeHandle,
    _args: readonly string[],
    _timeoutMs: number,
    _input?: string,
    signal?: AbortSignal
  ): Promise<CommandResult> {
    await new Promise<void>((resolve) => {
      if (signal?.aborted) { resolve(); return; }
      signal?.addEventListener("abort", () => { resolve(); }, { once: true });
    });
    return { ...{
      command: "sbx",
      args: [],
      cwd: "C:\\tmp",
      exitCode: null,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      durationMs: 25
    }, error: "Aborted" };
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
  planId() { return asId<"PlanId">("plan-test"); }
  planArtifactId() { return asId<"PlanArtifactId">("plart-test"); }
  planAnnotationId() { return asId<"PlanAnnotationId">("plnote-test"); }
}
