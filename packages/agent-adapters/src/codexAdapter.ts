/**
 * Codex agent adapter.
 *
 * Host operations are limited to inert detection/auth checks. Prompt-bearing
 * operations require a runtime connection supplied by the orchestrator.
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
  CommandRunner,
  ProviderId,
  RunId,
  StartAgentProtocolRequest
} from "@drydock/contracts";
import { asId } from "@drydock/contracts";
import type { Clock, IdGenerator, Logger } from "@drydock/core";
import {
  CodexAppServerTransport,
  type CodexAppServerSession,
  type CodexAppServerTransportOptions
} from "./codexAppServerTransport.js";
import { CodexExecJsonTransport, type RuntimeExecutor } from "./codexExecJsonTransport.js";

export interface CodexAdapterOptions {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly runtimeExecutor: RuntimeExecutor;
  readonly commandRunner?: CommandRunner;
  readonly hostCodexPath?: string;
  readonly appServer?: Omit<CodexAppServerTransportOptions, "ids" | "clock" | "logger">;
}

export class CodexAdapter implements AgentAdapter {
  readonly providerId: ProviderId = asId<"ProviderId">("codex");
  private readonly execTransport: CodexExecJsonTransport;
  private readonly appServerTransport: CodexAppServerTransport | undefined;
  private readonly appServerSessions = new Map<string, CodexAppServerSession>();

  constructor(private readonly options: CodexAdapterOptions) {
    this.execTransport = new CodexExecJsonTransport({
      ids: options.ids,
      clock: options.clock,
      logger: options.logger,
      runtimeExecutor: options.runtimeExecutor
    });
    this.appServerTransport = options.appServer === undefined
      ? undefined
      : new CodexAppServerTransport({
        ...options.appServer,
        ids: options.ids,
        clock: options.clock,
        logger: options.logger
      });
  }

  async detect(): Promise<AdapterDetectionResult> {
    if (!this.options.commandRunner || !this.options.hostCodexPath) {
      return {
        available: true,
        diagnostics: ["Host Codex detection was not configured; runtime-only adapter remains available."]
      };
    }
    const result = await this.options.commandRunner.run(this.options.hostCodexPath, ["--version"], {
      cwd: process.cwd(),
      timeoutMs: 10_000
    });
    return {
      available: result.exitCode === 0,
      ...(result.stdout.trim() ? { version: result.stdout.trim() } : {}),
      diagnostics: [result.stderr || result.error || result.stdout || "codex version checked"]
    };
  }

  async validateAuth(context: AdapterAuthContext): Promise<AuthValidationResult> {
    if (context.target === "host-inert") {
      return {
        status: "unknown",
        secretRefs: [],
        diagnostics: ["Host auth validation is inert; sandbox login is validated by runtime smoke."]
      };
    }
    return {
      status: "unknown",
      secretRefs: [],
      diagnostics: ["Runtime auth is delegated to Docker Sandbox managed Codex secrets."]
    };
  }

  async startProtocol(request: StartAgentProtocolRequest): Promise<AgentConnection> {
    if (request.transport === "codex-exec-json") {
      return {
        providerId: this.providerId,
        // Generation + agent, so a sidecar connection on the same runtime
        // never collides with the session's own connection state.
        connectionId: `codex-exec-${String(request.runtime.runtimeGenerationId)}-${String(request.agentId)}`,
        sessionId: request.sessionId,
        agentId: request.agentId,
        agentRole: request.agentRole,
        runtime: request.runtime,
        transport: request.transport
      };
    }

    if (request.transport === "codex-app-server") {
      if (this.appServerTransport === undefined) {
        throw new Error("Codex app-server transport is not configured.");
      }
      const connection: AgentConnection = {
        providerId: this.providerId,
        connectionId: `codex-app-${String(request.runtime.runtimeGenerationId)}-${String(request.agentId)}`,
        sessionId: request.sessionId,
        agentId: request.agentId,
        agentRole: request.agentRole,
        runtime: request.runtime,
        transport: request.transport
      };
      const session = await this.appServerTransport.connect(connection);
      this.appServerSessions.set(connection.connectionId, session);
      return connection;
    }

    throw new Error(`Unsupported Codex transport: ${request.transport}`);
  }

  async sendPrompt(connection: AgentConnection, prompt: AgentPrompt): Promise<RunId> {
    if (connection.transport === "codex-app-server") {
      const runId = this.options.ids.runId();
      const appServer = this.requiredAppServerSession(connection);
      await appServer.transport.sendPrompt(appServer.session, prompt, runId);
      return runId;
    }
    return this.execTransport.sendPrompt(connection, prompt);
  }

  async listModels(connection: AgentConnection): Promise<AgentModelCatalog> {
    if (connection.transport === "codex-app-server") {
      const appServer = this.requiredAppServerSession(connection);
      return appServer.transport.listModels(appServer.session);
    }
    return fallbackCatalog();
  }

  async restoreContext(connection: AgentConnection, messages: readonly AgentContextMessage[]): Promise<void> {
    if (connection.transport === "codex-app-server") {
      const appServer = this.requiredAppServerSession(connection);
      await appServer.transport.restoreContext(appServer.session, messages);
      return;
    }
    await this.execTransport.restoreContext(connection, messages);
  }

  streamEvents(connection: AgentConnection, runId: RunId): AsyncIterable<AgentEvent> {
    if (connection.transport === "codex-app-server") {
      const appServer = this.requiredAppServerSession(connection);
      return appServer.transport.streamEvents(appServer.session, runId);
    }
    return this.execTransport.streamEvents(connection, runId);
  }

  async cancel(connection: AgentConnection, runId: RunId): Promise<void> {
    if (connection.transport === "codex-app-server") {
      const appServer = this.requiredAppServerSession(connection);
      appServer.transport.cancel(appServer.session, runId);
      return;
    }
    this.options.logger.warn("Codex exec cancellation is not supported by the buffered transport", {});
  }

  async poke(connection: AgentConnection, runId: RunId): Promise<void> {
    // Soft nudge for a quiet turn; only the streaming app-server transport can
    // interrupt a live turn. The buffered exec transport has no live turn to poke.
    if (connection.transport === "codex-app-server") {
      const appServer = this.requiredAppServerSession(connection);
      appServer.transport.poke(appServer.session, runId);
    }
  }

  async stop(connection: AgentConnection, reason: string): Promise<void> {
    if (connection.transport === "codex-app-server") {
      const appServer = this.requiredAppServerSession(connection);
      await appServer.transport.close(appServer.session);
      this.appServerSessions.delete(connection.connectionId);
    }
    this.execTransport.discardContext(connection.connectionId);
    this.options.logger.info("Codex adapter stopped", { reason });
  }

  async summarizeCapabilities(): Promise<AgentCapabilities> {
    return {
      providerId: this.providerId,
      supportsExecJson: true,
      supportsAppServer: this.appServerTransport !== undefined,
      supportsCancel: this.appServerTransport !== undefined,
      eventFamilies: ["text", "command", "file", "error", "done"]
    };
  }

  private requiredAppServerSession(connection: AgentConnection): {
    readonly transport: CodexAppServerTransport;
    readonly session: CodexAppServerSession;
  } {
    if (this.appServerTransport === undefined) {
      throw new Error("Codex app-server transport is not configured.");
    }
    const session = this.appServerSessions.get(connection.connectionId);
    if (session === undefined) {
      throw new Error(`No Codex app-server session exists for ${connection.connectionId}.`);
    }
    return { transport: this.appServerTransport, session };
  }
}

function fallbackCatalog(): AgentModelCatalog {
  return {
    providerId: "codex",
    displayName: "Codex / OpenAI",
    models: [
      { id: "gpt-5", displayName: "GPT-5", isDefault: true, hidden: false }
    ],
    refreshedAt: new Date().toISOString(),
    source: "fallback",
    diagnostics: ["Codex app-server model/list is available only on the app-server transport."]
  };
}
