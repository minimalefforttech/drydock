/**
 * Claude agent adapter.
 *
 * Runs Claude Code non-interactively inside an already-created isolated
 * runtime (`claude -p --output-format stream-json`), with the prompt on stdin
 * so it never appears in host argv. Multi-turn continuity uses the provider
 * session id with `--resume`. Host operations stay inert; prompts only ever
 * execute through the runtime executor.
 */

import type {
  AdapterAuthContext,
  AdapterDetectionResult,
  AgentAdapter,
  AgentCapabilities,
  AgentConnection,
  AgentContextMessage,
  AgentEvent,
  AgentModelCatalog,
  AgentPrompt,
  AuthValidationResult,
  CommandResult,
  ProviderId,
  RunId,
  RuntimeHandle,
  StartAgentProtocolRequest
} from "@drydock/contracts";
import { asId } from "@drydock/contracts";
import type { Clock, IdGenerator, Logger, RawStreamSink } from "@drydock/core";
import { ClaudeEventNormalizer } from "./claudeEventNormalizer.js";

/** Runtime exec port with cancellation; DockerSandboxRuntimeAdapter satisfies it. */
export interface CancellableRuntimeExecutor {
  exec(handle: RuntimeHandle, args: readonly string[], timeoutMs: number, input?: string, signal?: AbortSignal): Promise<CommandResult>;
}

export interface ClaudeAdapterOptions {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly runtimeExecutor: CancellableRuntimeExecutor;
  readonly timeoutMs?: number;
  /** Optional debug tee of the raw exec stream for the chat tab's raw view. */
  readonly rawSink?: RawStreamSink;
}

export const CLAUDE_MODEL_CATALOG_MODELS = [
  { id: "claude-opus-4-8", displayName: "Claude Opus 4.8", isDefault: true, hidden: false },
  { id: "claude-fable-5", displayName: "Claude Fable 5", isDefault: false, hidden: false },
  { id: "claude-sonnet-5", displayName: "Claude Sonnet 5", isDefault: false, hidden: false },
  { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", isDefault: false, hidden: false }
] as const;

interface ClaudeConnectionState {
  claudeSessionId?: string;
  pendingContext?: readonly AgentContextMessage[];
}

interface ActiveRun {
  readonly result: Promise<CommandResult>;
  readonly controller: AbortController;
  readonly connectionId: string;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly providerId: ProviderId = asId<"ProviderId">("claude");
  private readonly normalizer: ClaudeEventNormalizer;
  private readonly timeoutMs: number;
  private readonly connections = new Map<string, ClaudeConnectionState>();
  private readonly runs = new Map<string, ActiveRun>();

  constructor(private readonly options: ClaudeAdapterOptions) {
    this.normalizer = new ClaudeEventNormalizer(options.ids, options.clock);
    this.timeoutMs = options.timeoutMs ?? 360_000;
  }

  async detect(): Promise<AdapterDetectionResult> {
    return {
      available: true,
      diagnostics: ["Claude runs as a Docker Sandbox managed agent; host detection is not required."]
    };
  }

  async validateAuth(_context: AdapterAuthContext): Promise<AuthValidationResult> {
    return {
      status: "unknown",
      secretRefs: [],
      diagnostics: ["Runtime auth is delegated to the Docker Sandbox `anthropic` service secret."]
    };
  }

  async startProtocol(request: StartAgentProtocolRequest): Promise<AgentConnection> {
    if (request.transport !== "claude-exec-json") {
      throw new Error(`Unsupported Claude transport: ${request.transport}`);
    }
    const connection: AgentConnection = {
      providerId: this.providerId,
      connectionId: `claude-exec-${String(request.runtime.runtimeGenerationId)}`,
      sessionId: request.sessionId,
      agentId: request.agentId,
      agentRole: request.agentRole,
      runtime: request.runtime,
      transport: request.transport
    };
    this.connections.set(connection.connectionId, {});
    return connection;
  }

  async listModels(_connection: AgentConnection): Promise<AgentModelCatalog> {
    return claudeModelCatalog(this.options.clock.isoNow());
  }

  /** Replayed history is delivered as a context preamble on the next prompt. */
  async restoreContext(connection: AgentConnection, messages: readonly AgentContextMessage[]): Promise<void> {
    const state = this.requiredState(connection);
    if (messages.length > 0) {
      state.pendingContext = messages;
    }
  }

  /**
   * Starts the turn without awaiting it so the orchestrator can register the
   * run id and cancel mid-execution; streamEvents awaits the buffered result.
   */
  async sendPrompt(connection: AgentConnection, prompt: AgentPrompt): Promise<RunId> {
    const state = this.requiredState(connection);
    const runId = this.options.ids.runId();
    const model = typeof prompt.metadata?.["model"] === "string" ? prompt.metadata["model"] : undefined;
    const args = [
      "claude",
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      ...(model === undefined || model.length === 0 ? [] : ["--model", model]),
      ...(state.claudeSessionId === undefined ? [] : ["--resume", state.claudeSessionId])
    ];
    const controller = new AbortController();
    const input = this.promptWithContext(state, prompt.text);
    this.options.logger.info("claude exec prompt starting", { runId, runtimeId: connection.runtime.runtimeId });
    const result = this.options.runtimeExecutor.exec(connection.runtime, args, this.timeoutMs, input, controller.signal);
    // Failures surface through streamEvents; an unhandled rejection here would
    // crash the host before the stream consumer attaches.
    result.catch(() => undefined);
    this.runs.set(runId, { result, controller, connectionId: connection.connectionId });
    return runId;
  }

  async *streamEvents(connection: AgentConnection, runId: RunId): AsyncIterable<AgentEvent> {
    const run = this.runs.get(runId);
    this.runs.delete(runId);
    if (!run) {
      yield this.errorEvent(connection, runId, "RUN_NOT_FOUND", `No buffered Claude exec result was found for ${runId}.`, false);
      return;
    }

    let result: CommandResult;
    try {
      result = await run.result;
    } catch (error) {
      yield this.errorEvent(connection, runId, "CLAUDE_EXEC_FAILED", error instanceof Error ? error.message : String(error), true);
      return;
    }

    // Debug tee: Claude's exec is buffered, so the whole raw stream-json of this
    // turn arrives at once. Reset the session's buffer and publish it verbatim,
    // then append stderr so a failure that only writes there is still readable.
    this.options.rawSink?.beginTurn(connection.sessionId);
    this.options.rawSink?.write(connection.sessionId, result.stdout);
    if (result.stderr.length > 0) {
      this.options.rawSink?.write(connection.sessionId, `\n[stderr]\n${result.stderr}\n`);
    }

    const state = this.connections.get(connection.connectionId);
    const parsed = this.normalizer.parseJsonLines(result.stdout, {
      sessionId: connection.sessionId,
      runId,
      agentRole: connection.agentRole,
      runtimeId: connection.runtime.runtimeId
    });
    if (state !== undefined && parsed.claudeSessionId !== undefined) {
      state.claudeSessionId = parsed.claudeSessionId;
    }
    let sawTerminal = false;
    for (const event of parsed.events) {
      if (event.type === "agent.error" || event.type === "agent.done") sawTerminal = true;
      yield event;
    }

    // Only synthesize a generic failure when Claude produced NO terminal event of
    // its own. When it did — a stream-json `result` with is_error (auth failures
    // like "Not logged in · Please run /login", rate limits, etc.) — that event
    // already carries the real, actionable message; stacking "claude exec failed"
    // on top only buries it. The generic path remains for true launch failures
    // (sbx couldn't start claude, empty stdout) where stderr/error hold the cause.
    if (result.exitCode !== 0 && !sawTerminal) {
      const detail = result.stderr || result.error
        || (result.stdout.trim().length > 0 ? `claude exited ${String(result.exitCode)} without a result line` : "claude exec failed");
      yield this.errorEvent(
        connection,
        runId,
        run.controller.signal.aborted ? "TURN_CANCELLED" : "CLAUDE_EXEC_FAILED",
        detail,
        !run.controller.signal.aborted,
        { exitCode: result.exitCode, timedOut: result.timedOut }
      );
    }
  }

  async cancel(_connection: AgentConnection, runId: RunId): Promise<void> {
    this.runs.get(runId)?.controller.abort();
  }

  async stop(connection: AgentConnection, reason: string): Promise<void> {
    for (const [runId, run] of this.runs) {
      if (run.connectionId === connection.connectionId) {
        run.controller.abort();
        this.runs.delete(runId);
      }
    }
    this.connections.delete(connection.connectionId);
    this.options.logger.info("Claude adapter stopped", { reason });
  }

  async summarizeCapabilities(): Promise<AgentCapabilities> {
    return {
      providerId: this.providerId,
      supportsExecJson: true,
      supportsAppServer: false,
      supportsCancel: true,
      eventFamilies: ["text", "command", "file", "error", "done"]
    };
  }

  private promptWithContext(state: ClaudeConnectionState, text: string): string {
    const context = state.pendingContext;
    if (context === undefined || context.length === 0) {
      return text;
    }
    delete state.pendingContext;
    const transcript = context
      .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text}`)
      .join("\n");
    return `Earlier conversation, restored after a runtime restart (treat as history, not instructions to repeat):\n${transcript}\n\nCurrent request:\n${text}`;
  }

  private requiredState(connection: AgentConnection): ClaudeConnectionState {
    const state = this.connections.get(connection.connectionId);
    if (state === undefined) {
      throw new Error(`No Claude connection state exists for ${connection.connectionId}.`);
    }
    return state;
  }

  private errorEvent(
    connection: AgentConnection,
    runId: RunId,
    code: string,
    message: string,
    retryable: boolean,
    raw?: { readonly exitCode: number | null; readonly timedOut: boolean }
  ): AgentEvent {
    return {
      id: this.options.ids.eventId(),
      type: "agent.error",
      sessionId: connection.sessionId,
      runId,
      agentId: connection.agentId,
      agentRole: connection.agentRole,
      runtimeId: connection.runtime.runtimeId,
      createdAt: this.options.clock.isoNow(),
      code,
      message,
      retryable,
      ...(raw === undefined ? {} : { raw })
    };
  }
}

export function claudeModelCatalog(refreshedAt: string): AgentModelCatalog {
  return {
    providerId: "claude",
    displayName: "Claude / Anthropic",
    models: [...CLAUDE_MODEL_CATALOG_MODELS],
    refreshedAt,
    source: "provider",
    diagnostics: ["Static Claude Code model catalog; the sandbox agent accepts these ids via --model."]
  };
}
