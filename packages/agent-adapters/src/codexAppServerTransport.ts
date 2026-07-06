/**
 * Codex app-server transport probe.
 *
 * The isolated-run workflow uses exec JSON for the real one-turn run; this
 * transport validates the richer app-server session path inside a sandbox and
 * records a clear blocker when the installed protocol shape changes.
 */

import type {
  AgentConnection,
  AgentContextMessage,
  AgentEvent,
  AgentModelCatalog,
  AgentModelSummary,
  AgentPrompt,
  AppServerProbeResult,
  JsonObject,
  JsonValue,
  RunId,
  RuntimeHandle
} from "@drydock/contracts";
import { productError } from "@drydock/contracts";
import type { Clock, IdGenerator, Logger } from "@drydock/core";
import { errorMessage } from "@drydock/core";
import { CodexAppServerEventNormalizer } from "./codexAppServerEventNormalizer.js";
import { CodexThreadLineage } from "./codexThreadLineage.js";
import { LineJsonRpcClient } from "./jsonRpcClient.js";

export interface CodexAppServerTransportOptions {
  readonly command: string;
  readonly argsForRuntime: (runtime: RuntimeHandle) => readonly string[];
  readonly cwd: string;
  readonly ids?: IdGenerator;
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly timeoutMs?: number;
}

export interface CodexAppServerSession {
  readonly connection: AgentConnection;
  readonly client: LineJsonRpcClient;
  readonly threadId: string;
  readonly cwd: string;
  readonly normalizer: CodexAppServerEventNormalizer;
  /** Thread→agentPath lineage for collab-agent children. */
  readonly lineage: CodexThreadLineage;
  readonly providerTurnIds: Map<string, string>;
  readonly turnControllers: Map<string, AbortController>;
  readonly cancelledRuns: Set<string>;
}

export class CodexAppServerTransport {
  private readonly timeoutMs: number;

  constructor(private readonly options: CodexAppServerTransportOptions) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async connect(connection: AgentConnection): Promise<CodexAppServerSession> {
    const { ids, clock } = this.requireStreamingDependencies();
    const client = this.createClient(connection.runtime);
    await client.start();
    try {
      await this.initialize(client);
      const cwd = connection.runtime.runtimeCwd ?? connection.runtime.workspacePath;
      const threadStart = await client.request("thread/start", {
        cwd,
        ephemeral: true,
        sandbox: "read-only",
        approvalPolicy: "never"
      }, 45_000);
      const threadId = extractThreadId(threadStart);
      if (!threadId) {
        throw new Error("Codex app-server did not return a thread id.");
      }
      return {
        connection,
        client,
        threadId,
        cwd,
        normalizer: new CodexAppServerEventNormalizer(ids, clock),
        lineage: new CodexThreadLineage(threadId),
        providerTurnIds: new Map(),
        turnControllers: new Map(),
        cancelledRuns: new Set()
      };
    } catch (error) {
      await client.stop();
      throw error;
    }
  }

  async sendPrompt(session: CodexAppServerSession, prompt: AgentPrompt, runId: RunId): Promise<void> {
    const turnStart = await session.client.request("turn/start", {
      threadId: session.threadId,
      cwd: prompt.cwd ?? session.cwd,
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "readOnly",
        networkAccess: false
      },
      input: [{ type: "text", text: prompt.text }],
      ...modelOverride(prompt)
    }, this.timeoutMs);
    const providerTurnId = extractTurnId(turnStart);
    if (providerTurnId !== null) {
      session.providerTurnIds.set(runId, providerTurnId);
    }
  }

  listModels(session: CodexAppServerSession): Promise<AgentModelCatalog> {
    return requestCodexModelCatalog(session.client, () => this.options.clock?.isoNow() ?? new Date().toISOString());
  }

  async restoreContext(session: CodexAppServerSession, messages: readonly AgentContextMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    await session.client.request("thread/inject_items", {
      threadId: session.threadId,
      items: messages.map(contextMessageToResponseItem)
    }, 45_000);
  }

  async *streamEvents(session: CodexAppServerSession, runId: RunId): AsyncIterable<AgentEvent> {
    const controller = new AbortController();
    session.turnControllers.set(runId, controller);
    if (session.cancelledRuns.has(runId)) {
      controller.abort();
    }
    try {
      while (true) {
        const notification = await session.client.nextNotification(controller.signal);
        if (notification.method === "turn/started") {
          // Only the ROOT thread's turn id may drive turn/interrupt — collab
          // child threads start their own turns on this same connection
          // (verified against live app-server captures) and must not hijack the cancel target.
          const params = notification.params;
          const notifiedThreadId = params && typeof params === "object" && !Array.isArray(params) && typeof params["threadId"] === "string"
            ? params["threadId"]
            : undefined;
          if (session.lineage.isRoot(notifiedThreadId)) {
            const providerTurnId = extractTurnId(notification.params ?? null);
            if (providerTurnId !== null) {
              session.providerTurnIds.set(runId, providerTurnId);
            }
          }
        }
        const events = session.normalizer.normalize(notification, {
          sessionId: session.connection.sessionId,
          runId,
          agentRole: session.connection.agentRole,
          runtimeId: session.connection.runtime.runtimeId,
          lineage: session.lineage
        });
        for (const event of events) {
          yield event;
          if (event.type === "agent.done") {
            return;
          }
        }
      }
    } finally {
      session.turnControllers.delete(runId);
      session.providerTurnIds.delete(runId);
      session.cancelledRuns.delete(runId);
    }
  }

  cancel(session: CodexAppServerSession, runId: RunId): void {
    const providerTurnId = session.providerTurnIds.get(runId);
    session.cancelledRuns.add(runId);
    session.client.notify("turn/interrupt", {
      threadId: session.threadId,
      ...(providerTurnId === undefined ? {} : { turnId: providerTurnId })
    });
    session.turnControllers.get(runId)?.abort();
  }

  async close(session: CodexAppServerSession): Promise<void> {
    for (const controller of session.turnControllers.values()) {
      controller.abort();
    }
    await session.client.stop();
  }

  async probe(runtime: RuntimeHandle, prompt?: string): Promise<AppServerProbeResult> {
    const client = this.createClient(runtime);
    try {
      await client.start();
      const initialize = await this.initialize(client);
      const cwd = runtime.runtimeCwd ?? runtime.workspacePath;
      const threadStart = await client.request("thread/start", {
        cwd,
        ephemeral: true,
        sandbox: "read-only",
        approvalPolicy: "never"
      }, 45_000);
      const threadId = extractThreadId(threadStart);
      if (!threadId) {
        return blocked("Codex app-server did not return a thread id.", { initialize, threadStart }, client.diagnostics());
      }

      if (!prompt) {
        return {
          status: "pass",
          threadId,
          diagnostics: [`thread id: ${threadId}`, `notifications observed: ${String(client.notifications.length)}`]
        };
      }

      const turnStart = await client.request("turn/start", {
        threadId,
        cwd,
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          networkAccess: false
        },
        input: [{ type: "text", text: prompt }]
      }, this.timeoutMs);
      const turnId = extractTurnId(turnStart);
      return {
        status: "pass",
        threadId,
        ...(turnId === null ? {} : { turnId }),
        diagnostics: [
          `thread id: ${threadId}`,
          `turn id: ${turnId ?? "(not returned)"}`,
          `notifications observed: ${String(client.notifications.length)}`
        ]
      };
    } catch (error) {
      return blocked(errorMessage(error), {}, client.diagnostics());
    } finally {
      await client.stop();
    }
  }

  private createClient(runtime: RuntimeHandle): LineJsonRpcClient {
    return new LineJsonRpcClient(
      this.options.command,
      [...this.options.argsForRuntime(runtime), "codex", "app-server", "--listen", "stdio://"],
      this.options.cwd
    );
  }

  private initialize(client: LineJsonRpcClient): Promise<JsonValue> {
    return initializeCodexAppServer(client);
  }

  private requireStreamingDependencies(): { readonly ids: IdGenerator; readonly clock: Clock } {
    if (this.options.ids === undefined || this.options.clock === undefined) {
      throw new Error("Codex app-server streaming requires ids and clock dependencies.");
    }
    return { ids: this.options.ids, clock: this.options.clock };
  }
}

/** Shared app-server handshake: initialize request plus initialized notify. */
export async function initializeCodexAppServer(client: LineJsonRpcClient): Promise<JsonValue> {
  const initialize = await client.request("initialize", {
    clientInfo: {
      name: "drydock_stage2",
      title: "Drydock",
      version: "0.0.0-stage2"
    },
    capabilities: {
      experimentalApi: true
    }
  }, 15_000);
  client.notify("initialized", {});
  return initialize;
}

/** Pages through model/list on an initialized app-server client. */
export async function requestCodexModelCatalog(client: LineJsonRpcClient, isoNow: () => string): Promise<AgentModelCatalog> {
  const models: AgentModelSummary[] = [];
  const diagnostics: string[] = [];
  let cursor: string | null | undefined;
  do {
    const page = await client.request("model/list", {
      ...(cursor === undefined ? {} : { cursor }),
      includeHidden: false,
      limit: 200
    }, 30_000);
    const parsed = parseModelList(page);
    models.push(...parsed.models);
    cursor = parsed.nextCursor;
    diagnostics.push(`model/list returned ${String(parsed.models.length)} model(s)`);
  } while (typeof cursor === "string" && cursor.length > 0);

  return {
    providerId: "codex",
    displayName: "Codex / OpenAI",
    models,
    refreshedAt: isoNow(),
    source: "provider",
    diagnostics
  };
}

function blocked(message: string, data: JsonObject, diagnostics: readonly string[]): AppServerProbeResult {
  return {
    status: "blocked",
    diagnostics,
    error: productError({
      code: "PROTOCOL_UNAVAILABLE",
      service: "CodexAppServerTransport",
      operation: "probe",
      message,
      retryable: true,
      userAction: "Regenerate Codex app-server schema and update the transport method mapping.",
      providerId: "codex",
      diagnostics: data
    })
  };
}

function extractThreadId(value: JsonValue): string | null {
  const object = objectValue(value);
  const thread = objectValue(object?.["thread"]);
  const id = stringValue(thread?.["id"]) ?? stringValue(object?.["threadId"]) ?? stringValue(object?.["thread_id"]);
  return id;
}

function extractTurnId(value: JsonValue): string | null {
  const object = objectValue(value);
  const turn = objectValue(object?.["turn"]);
  const id = stringValue(turn?.["id"]) ?? stringValue(object?.["turnId"]) ?? stringValue(object?.["turn_id"]);
  return id;
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function stringValue(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function booleanValue(value: JsonValue | undefined): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function parseModelList(value: JsonValue): { readonly models: readonly AgentModelSummary[]; readonly nextCursor?: string | null } {
  const object = objectValue(value);
  const data = object?.["data"];
  const models = Array.isArray(data) ? data.map(parseModel).filter((model): model is AgentModelSummary => model !== null) : [];
  const nextCursor = stringValue(object?.["nextCursor"]);
  return {
    models,
    ...(nextCursor === null ? {} : { nextCursor })
  };
}

function parseModel(value: JsonValue): AgentModelSummary | null {
  const object = objectValue(value);
  if (object === undefined) {
    return null;
  }
  const id = stringValue(object["model"]) ?? stringValue(object["id"]);
  if (id === null || id.length === 0) {
    return null;
  }
  const displayName = stringValue(object["displayName"]) ?? id;
  const description = stringValue(object["description"]);
  return {
    id,
    displayName,
    ...(description === null ? {} : { description }),
    isDefault: booleanValue(object["isDefault"]) ?? false,
    hidden: booleanValue(object["hidden"]) ?? false
  };
}

function contextMessageToResponseItem(message: AgentContextMessage): JsonObject {
  if (message.role === "assistant") {
    return {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: message.text }]
    };
  }
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: message.text }]
  };
}

function modelOverride(prompt: AgentPrompt): { readonly model?: string } {
  const model = prompt.metadata?.["model"];
  return typeof model === "string" && model.length > 0 ? { model } : {};
}
