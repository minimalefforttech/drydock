/**
 * One-prompt isolated run workflow.
 *
 * It starts exactly one isolated runtime, runs one Codex prompt through an
 * adapter, stores normalized events, and cleans the runtime unless requested.
 */

import type {
  AgentAdapter,
  AgentEvent,
  EventStore,
  RuntimeHandle,
  RuntimeTemplate,
  SessionId
} from "@drydock/contracts";
import type { IdGenerator } from "./ids.js";
import type { Logger } from "./logger.js";
import { RuntimeCleanupService } from "./runtimeCleanupService.js";
import { RuntimeLifecycleService } from "./runtimeLifecycleService.js";

export interface IsolatedRunRequest {
  readonly prompt: string;
  readonly workspacePath: string;
  readonly template: RuntimeTemplate;
  readonly keepRuntime?: boolean;
}

export interface IsolatedRunResult {
  readonly sessionId: SessionId;
  readonly runtime: RuntimeHandle;
  readonly events: readonly AgentEvent[];
  readonly cleanupStatus: "removed" | "kept" | "failed";
}

export interface IsolatedRunWorkflowOptions {
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly lifecycle: RuntimeLifecycleService;
  readonly cleanup: RuntimeCleanupService;
  readonly agentAdapter: AgentAdapter;
  readonly eventStore: EventStore;
  /** Re-checks current policy immediately before prompt content leaves the host. */
  readonly authorizePrompt?: () => void | Promise<void>;
}

export class IsolatedRunWorkflow {
  constructor(private readonly options: IsolatedRunWorkflowOptions) {}

  async runOnePrompt(request: IsolatedRunRequest): Promise<IsolatedRunResult> {
    const sessionId = this.options.ids.sessionId();
    const chatId = this.options.ids.chatId();
    const agentId = this.options.ids.agentId();
    const runtimeId = this.options.ids.runtimeId();
    const generationId = this.options.ids.runtimeGenerationId();
    const runtime = await this.options.lifecycle.startRuntime({
      sessionId,
      chatId,
      agentId,
      agentRole: "worker",
      template: request.template,
      workspacePath: request.workspacePath,
      generationId,
      runtimeId
    });

    const events: AgentEvent[] = [];
    let cleanupStatus: IsolatedRunResult["cleanupStatus"] = "kept";
    let connection: Awaited<ReturnType<AgentAdapter["startProtocol"]>> | undefined;
    try {
      connection = await this.options.agentAdapter.startProtocol({
        sessionId,
        agentId,
        agentRole: "worker",
        runtime,
        transport: "codex-exec-json"
      });
      await this.options.authorizePrompt?.();
      const runId = await this.options.agentAdapter.sendPrompt(connection, { text: request.prompt, cwd: runtime.workspacePath });
      for await (const event of this.options.agentAdapter.streamEvents(connection, runId)) {
        events.push(event);
        await this.options.eventStore.appendAgentEvent(event);
      }
    } finally {
      if (connection !== undefined) {
        try {
          await this.options.agentAdapter.stop(connection, "isolated run finished");
        } catch (error) {
          this.options.logger.warn("isolated run protocol cleanup failed", {
            sessionId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      if (request.keepRuntime !== true) {
        const cleanup = await this.options.cleanup.cleanupRuntime(runtime.runtimeId, "graceful");
        cleanupStatus = cleanup.status === "removed" ? "removed" : "failed";
        this.options.logger.info("isolated run cleanup complete", { runtimeId: runtime.runtimeId, status: cleanupStatus });
      }
    }
    return { sessionId, runtime, events, cleanupStatus };
  }
}
