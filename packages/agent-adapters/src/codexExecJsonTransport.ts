/**
 * Codex exec JSON transport.
 *
 * Runs `codex exec --json` inside an already-created isolated runtime and
 * converts the JSONL stream into normalized product events. The prompt is
 * delivered over stdin (`-`) so prompt text never appears in host process
 * argv, where other local processes could observe it.
 */

import type {
  AgentConnection,
  AgentContextMessage,
  AgentEvent,
  AgentPrompt,
  CommandResult,
  ProviderId,
  RunId,
  RuntimeHandle
} from "@drydock/contracts";
import { asId } from "@drydock/contracts";
import type { Clock, IdGenerator, Logger } from "@drydock/core";
import { productError } from "@drydock/contracts";
import { CodexEventNormalizer } from "./codexEventNormalizer.js";

export interface RuntimeExecutor {
  exec(handle: RuntimeHandle, args: readonly string[], timeoutMs: number, input?: string): Promise<CommandResult>;
}

export interface CodexExecJsonTransportOptions {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly runtimeExecutor: RuntimeExecutor;
  readonly timeoutMs?: number;
}

export class CodexExecJsonTransport {
  private readonly normalizer: CodexEventNormalizer;
  private readonly runs = new Map<string, CommandResult>();
  /** Replayed history awaiting delivery as a preamble, keyed by connection. */
  private readonly pendingContexts = new Map<string, readonly AgentContextMessage[]>();
  private readonly timeoutMs: number;

  constructor(private readonly options: CodexExecJsonTransportOptions) {
    this.normalizer = new CodexEventNormalizer(options.ids, options.clock);
    this.timeoutMs = options.timeoutMs ?? 360_000;
  }

  /**
   * Exec runs are stateless (a fresh `codex exec` per turn), so restored
   * history is buffered and prepended to the next prompt as a plain-text
   * preamble - the same strategy the Claude adapter uses.
   */
  async restoreContext(connection: AgentConnection, messages: readonly AgentContextMessage[]): Promise<void> {
    if (messages.length > 0) {
      this.pendingContexts.set(connection.connectionId, messages);
    }
  }

  /** Drops any undelivered preamble when a connection goes away. */
  discardContext(connectionId: string): void {
    this.pendingContexts.delete(connectionId);
  }

  async sendPrompt(connection: AgentConnection, prompt: AgentPrompt): Promise<RunId> {
    const runId = this.options.ids.runId();
    const args = [
      "codex",
      "--dangerously-bypass-approvals-and-sandbox",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-"
    ];
    this.options.logger.info("codex exec prompt starting", { runId, runtimeId: connection.runtime.runtimeId });
    const input = this.promptWithContext(connection.connectionId, prompt.text);
    const result = await this.options.runtimeExecutor.exec(connection.runtime, args, this.timeoutMs, input);
    this.runs.set(runId, result);
    return runId;
  }

  private promptWithContext(connectionId: string, text: string): string {
    const context = this.pendingContexts.get(connectionId);
    if (context === undefined || context.length === 0) {
      return text;
    }
    this.pendingContexts.delete(connectionId);
    const transcript = context
      .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text}`)
      .join("\n");
    return `Earlier conversation, restored after a backend restart (treat as history, not instructions to repeat):\n${transcript}\n\nCurrent request:\n${text}`;
  }

  async *streamEvents(connection: AgentConnection, runId: RunId): AsyncIterable<AgentEvent> {
    // Single-consumer stream: the buffered result is evicted immediately so
    // long-lived sessions do not accumulate captured stdout per run.
    const result = this.runs.get(runId);
    this.runs.delete(runId);
    if (!result) {
      yield {
        id: this.options.ids.eventId(),
        type: "agent.error",
        sessionId: connection.sessionId,
        runId,
        agentId: connection.agentId,
        agentRole: connection.agentRole,
        runtimeId: connection.runtime.runtimeId,
        createdAt: this.options.clock.isoNow(),
        code: "RUN_NOT_FOUND",
        message: `No buffered Codex exec result was found for ${runId}.`,
        retryable: false
      };
      return;
    }

    const events = this.normalizer.parseJsonLines(result.stdout, {
      sessionId: connection.sessionId,
      runId,
      agentRole: connection.agentRole,
      runtimeId: connection.runtime.runtimeId
    });
    let sawTerminal = false;
    for (const event of events) {
      if (event.type === "agent.error" || event.type === "agent.done") sawTerminal = true;
      yield event;
    }

    // Suppress the generic failure when Codex already emitted a terminal event
    // carrying the real cause (parity with the Claude adapter); keep it only for
    // true launch failures where stdout produced nothing.
    if (result.exitCode !== 0 && !sawTerminal) {
      yield {
        id: this.options.ids.eventId(),
        type: "agent.error",
        sessionId: connection.sessionId,
        runId,
        agentId: connection.agentId,
        agentRole: connection.agentRole,
        runtimeId: connection.runtime.runtimeId,
        createdAt: this.options.clock.isoNow(),
        code: "CODEX_EXEC_FAILED",
        message: result.stderr || result.error || "codex exec failed",
        retryable: true,
        raw: {
          exitCode: result.exitCode,
          timedOut: result.timedOut
        }
      };
    }
  }

  providerId(): ProviderId {
    return asId<"ProviderId">("codex");
  }

  unavailableError(message: string) {
    return productError({
      code: "PROTOCOL_UNAVAILABLE",
      service: "CodexExecJsonTransport",
      operation: "sendPrompt",
      message,
      retryable: true,
      userAction: "Verify Codex is available inside the Docker Sandbox runtime.",
      providerId: "codex"
    });
  }
}

