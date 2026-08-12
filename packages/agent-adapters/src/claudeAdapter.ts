/**
 * Claude agent adapter.
 *
 * Runs Claude Code non-interactively inside an already-created isolated
 * runtime (`claude -p --output-format stream-json`), with the prompt on stdin
 * so it never appears in host argv. The stream-json lines are parsed LIVE via
 * the executor's per-line hook, so events reach the UI while the turn runs and
 * the turn's outcome never depends on a buffered (and truncatable) stdout
 * capture. Multi-turn continuity uses the provider session id with `--resume`;
 * the id is captured from the first line that carries it, so even a cancelled
 * or failed turn keeps the conversation resumable. Host operations stay inert;
 * prompts only ever execute through the runtime executor.
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
  AgentModelSummary,
  AgentPrompt,
  AuthValidationResult,
  CommandResult,
  JsonObject,
  ProviderId,
  RunId,
  RuntimeHandle,
  StartAgentProtocolRequest
} from "@drydock/contracts";
import { asId } from "@drydock/contracts";
import type { Clock, IdGenerator, Logger, RawStreamSink } from "@drydock/core";
import { ClaudeEventNormalizer } from "./claudeEventNormalizer.js";

/** Runtime exec port with cancellation and live stdout lines; DockerSandboxRuntimeAdapter satisfies it. */
export interface CancellableRuntimeExecutor {
  exec(
    handle: RuntimeHandle,
    args: readonly string[],
    timeoutMs: number,
    input?: string,
    signal?: AbortSignal,
    onStdoutLine?: (line: string) => void
  ): Promise<CommandResult>;
}

/**
 * Wiring for a ridden provider (DeepSeek, Kimi, ...): the same Claude Code
 * CLI, pointed at an Anthropic-compatible endpoint. The auth token is read
 * inside the sandbox from `tokenFile` (written runtime-scoped by the host over
 * the exec side-channel); it never appears in argv.
 */
export interface ClaudeWireConfig {
  readonly baseUrl: string;
  readonly tokenFile: string;
  /** Background/fast-model slot override so the rider endpoint never sees Anthropic model ids. */
  readonly smallFastModel?: string;
}

export interface ClaudeAdapterOptions {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly runtimeExecutor: CancellableRuntimeExecutor;
  /** Hard cap on a single turn's wall clock (default 60 min). */
  readonly turnTimeoutMs?: number;
  /**
   * Stall watchdog: end the turn as a recoverable failure after this much
   * stdout silence (default 10 min - past Claude Code's own tool timeouts,
   * so a healthy long tool run does not trip it). 0 disables it.
   */
  readonly inactivityTimeoutMs?: number;
  /** Optional debug tee of the raw exec stream for the chat tab's raw view. */
  readonly rawSink?: RawStreamSink;
  /** Rider identity; defaults to the native "claude" provider. */
  readonly providerId?: string;
  /** Present only for ridden providers; absent means native Anthropic auth via the sandbox proxy. */
  readonly wire?: ClaudeWireConfig;
  /**
   * Live catalog source for ridden providers (host-side registry discovery).
   * Native Claude discovers models inside the session runtime instead.
   */
  readonly catalogSource?: () => Promise<AgentModelCatalog>;
}

interface ClaudeConnectionState {
  claudeSessionId?: string;
  pendingContext?: readonly AgentContextMessage[];
}

interface ActiveRun {
  readonly stream: AgentEventQueue;
  readonly controller: AbortController;
  readonly connectionId: string;
  /** Resolves with the exec result or the thrown launch error once settled; assigned right after launch. */
  settled: Promise<{ readonly result?: CommandResult; readonly error?: unknown }>;
  quietTimedOut: boolean;
  sawTerminal: boolean;
  droppedLines: number;
}

const DEFAULT_TURN_TIMEOUT_MS = 3_600_000;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 600_000;
const MODEL_LIST_TIMEOUT_MS = 30_000;

export class ClaudeAdapter implements AgentAdapter {
  readonly providerId: ProviderId;
  private readonly normalizer: ClaudeEventNormalizer;
  private readonly turnTimeoutMs: number;
  private readonly inactivityTimeoutMs: number;
  private readonly connections = new Map<string, ClaudeConnectionState>();
  private readonly runs = new Map<string, ActiveRun>();

  constructor(private readonly options: ClaudeAdapterOptions) {
    this.providerId = asId<"ProviderId">(options.providerId ?? "claude");
    this.normalizer = new ClaudeEventNormalizer(options.ids, options.clock);
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
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
      diagnostics: [
        this.options.wire === undefined
          ? "Runtime auth is delegated to the Docker Sandbox `anthropic` service secret."
          : `Runtime auth is a runtime-scoped token injected from vscode-secret:${String(this.providerId)}.`
      ]
    };
  }

  async startProtocol(request: StartAgentProtocolRequest): Promise<AgentConnection> {
    if (request.transport !== "claude-exec-json") {
      throw new Error(`Unsupported Claude transport: ${request.transport}`);
    }
    const connection: AgentConnection = {
      providerId: this.providerId,
      // Generation + agent: a sidecar connection on the SAME runtime (e.g. an
      // out-of-band summary prompt) must never share state with - or clobber -
      // the session's own connection.
      connectionId: `claude-exec-${String(request.runtime.runtimeGenerationId)}-${String(request.agentId)}`,
      sessionId: request.sessionId,
      agentId: request.agentId,
      agentRole: request.agentRole,
      runtime: request.runtime,
      transport: request.transport
    };
    this.connections.set(connection.connectionId, {});
    return connection;
  }

  /**
   * Live model discovery. Native Claude asks api.anthropic.com/v1/models from
   * INSIDE the session runtime (the sandbox proxy injects the credential; the
   * host never sees it). Riders return their host-side registry discovery.
   * Failures return an "unavailable" catalog carrying the reason - never an
   * invented list.
   */
  async listModels(connection: AgentConnection): Promise<AgentModelCatalog> {
    if (this.options.catalogSource !== undefined) {
      return this.options.catalogSource();
    }
    if (this.options.wire !== undefined) {
      return this.unavailableCatalog("This provider has no live model discovery wired; type a model id from its docs.");
    }
    const result = await this.options.runtimeExecutor.exec(
      connection.runtime,
      ["node", "-e", ANTHROPIC_MODELS_SCRIPT],
      MODEL_LIST_TIMEOUT_MS
    );
    return this.parseModelProbe(result);
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
   * run id and cancel mid-execution; streamEvents consumes the live event
   * queue the exec's stdout lines feed.
   */
  async sendPrompt(connection: AgentConnection, prompt: AgentPrompt): Promise<RunId> {
    const state = this.requiredState(connection);
    const runId = this.options.ids.runId();
    const requested = typeof prompt.metadata?.["model"] === "string" ? prompt.metadata["model"] : undefined;
    const model = requested !== undefined && requested.length > 0 ? requested : undefined;
    // Ridden endpoints reject Claude's own default model ids, and there is no
    // compiled-in default to fall back to - the turn must pick a model.
    if (model === undefined && this.options.wire !== undefined) {
      throw new Error(
        `${String(this.providerId)} needs an explicit model for this turn. Pick one from the model menu (Refresh models if the list is empty), or type a model id.`
      );
    }
    const claudeArgs = [
      "claude",
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      ...(model === undefined ? [] : ["--model", model]),
      ...(state.claudeSessionId === undefined ? [] : ["--resume", state.claudeSessionId])
    ];
    const args = this.options.wire === undefined ? claudeArgs : wrapWithWire(claudeArgs, this.options.wire);
    const controller = new AbortController();
    const input = this.promptWithContext(state, prompt.text);
    const stream = new AgentEventQueue();
    const context = {
      sessionId: connection.sessionId,
      runId,
      agentRole: connection.agentRole,
      runtimeId: connection.runtime.runtimeId
    };

    // Debug tee: reset the session's raw buffer at launch and append each
    // stream-json line as it arrives, so the raw view is live for Claude too.
    this.options.rawSink?.beginTurn(connection.sessionId);

    const run: ActiveRun = {
      stream,
      controller,
      connectionId: connection.connectionId,
      settled: Promise.resolve({}),
      quietTimedOut: false,
      sawTerminal: false,
      droppedLines: 0
    };

    let quietTimer: NodeJS.Timeout | undefined;
    const armQuietTimer = (): void => {
      if (this.inactivityTimeoutMs <= 0) return;
      if (quietTimer !== undefined) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        run.quietTimedOut = true;
        this.options.logger.warn("claude exec went quiet; aborting turn", {
          runId,
          quietMs: this.inactivityTimeoutMs
        });
        controller.abort();
      }, this.inactivityTimeoutMs);
    };

    const onLine = (line: string): void => {
      armQuietTimer();
      this.options.rawSink?.write(connection.sessionId, `${line}\n`);
      const parsed = this.normalizer.parseLine(line, context);
      if (parsed.dropped === true) {
        run.droppedLines += 1;
        return;
      }
      if (parsed.claudeSessionId !== undefined) {
        state.claudeSessionId = parsed.claudeSessionId;
      }
      for (const event of parsed.events) {
        if (event.type === "agent.error" || event.type === "agent.done") {
          run.sawTerminal = true;
        }
        stream.push(event);
      }
    };

    this.options.logger.info("claude exec prompt starting", { runId, runtimeId: connection.runtime.runtimeId });
    armQuietTimer();
    run.settled = this.options.runtimeExecutor
      .exec(connection.runtime, args, this.turnTimeoutMs, input, controller.signal, onLine)
      .then((result) => ({ result }), (error: unknown) => ({ error }))
      .then((outcome) => {
        if (quietTimer !== undefined) clearTimeout(quietTimer);
        stream.end();
        return outcome;
      });
    this.runs.set(runId, run);
    return runId;
  }

  async *streamEvents(connection: AgentConnection, runId: RunId): AsyncIterable<AgentEvent> {
    const run = this.runs.get(runId);
    this.runs.delete(runId);
    if (!run) {
      yield this.errorEvent(connection, runId, "RUN_NOT_FOUND", `No live Claude exec stream was found for ${runId}.`, false);
      return;
    }

    for await (const event of run.stream) {
      yield event;
    }

    const outcome = await run.settled;
    if (run.droppedLines > 0) {
      this.options.logger.warn("claude stream contained unparseable lines", {
        runId,
        droppedLines: run.droppedLines
      });
    }
    if (outcome.error !== undefined) {
      yield this.errorEvent(
        connection,
        runId,
        run.controller.signal.aborted ? "TURN_CANCELLED" : "CLAUDE_EXEC_FAILED",
        outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
        !run.controller.signal.aborted
      );
      return;
    }
    const result = outcome.result;
    if (result === undefined) {
      return;
    }
    if (result.stderr.length > 0) {
      this.options.rawSink?.write(connection.sessionId, `\n[stderr]\n${result.stderr}\n`);
    }

    // Honest terminal accounting: when Claude produced its own terminal event
    // (a stream-json `result` line), that event already carries the real
    // message and nothing is stacked on top. Every other ending - launch
    // failure, timeout, quiet-watchdog abort, cancellation, and (new) a clean
    // exit that never emitted a result line - yields an explicit error.
    if (run.sawTerminal) {
      return;
    }
    if (run.quietTimedOut) {
      yield this.errorEvent(
        connection,
        runId,
        "CLAUDE_TURN_STALLED",
        `Claude produced no output for ${String(Math.round(this.inactivityTimeoutMs / 60_000))} minutes, so the turn was stopped. The conversation is still resumable - send the message again to continue.`,
        true,
        { exitCode: result.exitCode, timedOut: result.timedOut }
      );
      return;
    }
    if (run.controller.signal.aborted) {
      yield this.errorEvent(connection, runId, "TURN_CANCELLED", result.error ?? "The turn was cancelled.", false, {
        exitCode: result.exitCode,
        timedOut: result.timedOut
      });
      return;
    }
    if (result.timedOut) {
      yield this.errorEvent(
        connection,
        runId,
        "CLAUDE_TURN_TIMEOUT",
        `The turn exceeded the ${String(Math.round(this.turnTimeoutMs / 60_000))}-minute limit and was stopped. Work already done inside the sandbox is kept; send a follow-up to continue.`,
        true,
        { exitCode: result.exitCode, timedOut: true }
      );
      return;
    }
    const detail = result.exitCode !== 0
      ? (result.stderr || result.error || `claude exited ${String(result.exitCode)} without a result line`)
      : `claude exited cleanly but never emitted a terminal result line (${String(run.droppedLines)} unparseable stream line(s)); the reply may be incomplete. Send the message again to retry.`;
    yield this.errorEvent(connection, runId, "CLAUDE_EXEC_FAILED", detail, true, {
      exitCode: result.exitCode,
      timedOut: result.timedOut
    });
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

  private parseModelProbe(result: CommandResult): AgentModelCatalog {
    if (result.exitCode !== 0) {
      return this.unavailableCatalog(
        `Model discovery inside the runtime failed (exit ${String(result.exitCode)}): ${oneLine(result.stderr || result.error || result.stdout) || "no output"}`
      );
    }
    let probe: JsonObject;
    try {
      const parsed = JSON.parse(result.stdout.trim()) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("probe output was not an object");
      }
      probe = parsed as JsonObject;
    } catch {
      return this.unavailableCatalog(`Model discovery returned unparseable output: ${oneLine(result.stdout)}`);
    }
    if (probe["ok"] !== true) {
      return this.unavailableCatalog(
        `api.anthropic.com/v1/models rejected the request: ${typeof probe["error"] === "string" ? probe["error"] : "unknown error"}`
      );
    }
    const rawModels = Array.isArray(probe["models"]) ? probe["models"] : [];
    const models: AgentModelSummary[] = [];
    for (const entry of rawModels) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as JsonObject;
      const id = typeof record["id"] === "string" ? record["id"] : null;
      if (id === null || id.length === 0) continue;
      models.push({
        id,
        displayName: typeof record["display_name"] === "string" && record["display_name"].length > 0 ? record["display_name"] : id,
        isDefault: false,
        hidden: false
      });
    }
    if (models.length === 0) {
      return this.unavailableCatalog("api.anthropic.com/v1/models answered without any models.");
    }
    return {
      providerId: String(this.providerId),
      displayName: "Claude / Anthropic",
      models,
      refreshedAt: this.options.clock.isoNow(),
      source: "provider",
      diagnostics: ["Live model list from api.anthropic.com/v1/models, fetched inside the session runtime (proxy-injected credential)."]
    };
  }

  private unavailableCatalog(reason: string): AgentModelCatalog {
    return {
      providerId: String(this.providerId),
      displayName: this.options.wire === undefined ? "Claude / Anthropic" : String(this.providerId),
      models: [],
      refreshedAt: this.options.clock.isoNow(),
      source: "unavailable",
      diagnostics: [reason]
    };
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

/**
 * Unbounded single-consumer queue bridging the exec's line callback to the
 * streamEvents async iterator. push() after end() is dropped (late lines from
 * a killed process); iteration completes once end() is called and the buffer
 * drains.
 */
class AgentEventQueue implements AsyncIterable<AgentEvent> {
  private readonly buffered: AgentEvent[] = [];
  private waiter: ((result: IteratorResult<AgentEvent>) => void) | null = null;
  private ended = false;

  push(event: AgentEvent): void {
    if (this.ended) return;
    if (this.waiter !== null) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: event, done: false });
      return;
    }
    this.buffered.push(event);
  }

  end(): void {
    this.ended = true;
    if (this.waiter !== null && this.buffered.length === 0) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: (): Promise<IteratorResult<AgentEvent>> => {
        const queued = this.buffered.shift();
        if (queued !== undefined) {
          return Promise.resolve({ value: queued, done: false });
        }
        if (this.ended) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      }
    };
  }
}

/** POSIX single-quote escaping for argv embedded in an `sh -c` command string. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Rewrites the claude argv to run behind an Anthropic-compatible rider
 * endpoint. The token is read from the runtime-scoped token file INSIDE the
 * sandbox (command substitution), so it never appears in host argv or logs;
 * base URLs and model ids are not secrets and may. Telemetry is disabled so
 * the rider's scoped egress does not generate blocked statsig/sentry noise.
 */
function wrapWithWire(claudeArgs: readonly string[], wire: ClaudeWireConfig): readonly string[] {
  const pairs = [
    `ANTHROPIC_BASE_URL=${wire.baseUrl}`,
    ...(wire.smallFastModel === undefined
      ? []
      : [
          `ANTHROPIC_SMALL_FAST_MODEL=${wire.smallFastModel}`,
          `ANTHROPIC_DEFAULT_HAIKU_MODEL=${wire.smallFastModel}`
        ]),
    "DISABLE_TELEMETRY=1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"
  ];
  const command = [
    `ANTHROPIC_AUTH_TOKEN="$(cat ${shQuote(wire.tokenFile)} 2>/dev/null)"`,
    "exec", "env",
    ...pairs.map(shQuote),
    ...claudeArgs.map(shQuote)
  ].join(" ");
  return ["sh", "-c", command];
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 400);
}

/**
 * Inert in-runtime probe of api.anthropic.com/v1/models. Runs under the
 * sandbox's node with the sandbox proxy on-path: the proxy injects the real
 * Anthropic credential at the HTTPS layer, so the script only ever sends the
 * `proxy-managed` sentinel. Tries the bearer and x-api-key header forms (and
 * a bare request) because subscription tokens and API keys ride different
 * headers; the first accepted form wins. Prints a single JSON object:
 * `{ok:true, models:[...]}` or `{ok:false, error}`.
 */
const ANTHROPIC_MODELS_SCRIPT = `
(async () => {
  const attempts = [
    { authorization: "Bearer proxy-managed" },
    { "x-api-key": "proxy-managed" },
    {}
  ];
  const errors = [];
  for (const auth of attempts) {
    try {
      const models = [];
      let afterId = undefined;
      for (let page = 0; page < 20; page += 1) {
        const url = new URL("https://api.anthropic.com/v1/models");
        url.searchParams.set("limit", "100");
        if (afterId) url.searchParams.set("after_id", afterId);
        const res = await fetch(url, { headers: { "anthropic-version": "2023-06-01", ...auth } });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(res.status + " " + ((body && body.error && body.error.message) || res.statusText));
        }
        const data = Array.isArray(body && body.data) ? body.data : [];
        for (const entry of data) {
          if (entry && typeof entry.id === "string") {
            models.push({ id: entry.id, display_name: typeof entry.display_name === "string" ? entry.display_name : entry.id });
          }
        }
        if (!(body && body.has_more) || data.length === 0) break;
        afterId = body.last_id;
      }
      if (models.length > 0) {
        process.stdout.write(JSON.stringify({ ok: true, models }));
        return;
      }
      errors.push("empty model list");
    } catch (error) {
      errors.push(String(error && error.message ? error.message : error));
    }
  }
  process.stdout.write(JSON.stringify({ ok: false, error: errors.join(" | ") }));
})();
`.trim();
