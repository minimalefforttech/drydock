/**
 * Subtask run bridge (task board orchestration).
 *
 * Builds the `StartSubtaskRun` callback the SubtaskOrchestrator is
 * constructed with, out of the SAME backend services the control panel's
 * "chat.start" flow delegates to: `IsolatedRunService.startChat` boots the
 * isolated clone session (title derived from the prompt), and the first turn
 * is dispatched fire-and-forget — completion arrives via the product bus
 * `turn-completed` event, which the orchestrator subscribes to. No `vscode` imports belong
 * here; ports are narrow and structural so tests can stub them without
 * booting docker (the taskReviewAppService pattern).
 *
 * Workspace inheritance: every automated subtask uses the parent task's
 * durable clone policy. The task service revalidates its sole linked set and
 * selected project subset before each run; missing/ambiguous policy fails
 * loudly instead of silently starting without the intended code.
 *
 * Concurrency: `IsolatedRunService.startChat` -> `startChatSession` never
 * touches the single-flight `runInFlight` slot — that guard only covers
 * `startPromptRun` and `runAppServerProbe` (see acquireRunSlot call sites in
 * isolatedRunService.ts). Chat sessions are per-session concurrent
 * (ChatSessionService keeps a liveSessions map; only turns within ONE session
 * serialize), so parallel dependent dispatch needs no FIFO queue here.
 */

import type { ChatModelSelection, ChatSessionRecord, TaskClonePolicy } from "@drydock/contracts";
import type { Logger } from "@drydock/core";
import type { StartSubtaskRun } from "@drydock/work-management";
import type { ChatWorkspaceContext } from "./isolatedRunService.js";

/** Chat-session facts the bridge needs; IsolatedRunService satisfies this structurally. */
export interface SubtaskRunSessionPort {
  startChat(prompt: string, model?: ChatModelSelection, workspace?: ChatWorkspaceContext, title?: string): Promise<{ session: ChatSessionRecord }>;
  sendChatTurn(sessionId: string, prompt: string): Promise<unknown>;
}

/** Task-clone workspace resolution; WorkspaceReviewAppService satisfies this. */
export interface SubtaskRunWorkspacePort {
  resolveTaskCloneWorkspace(policy: TaskClonePolicy): Promise<ChatWorkspaceContext>;
}

/** Durable task policy; TaskService satisfies this. */
export interface SubtaskRunTaskPort {
  requireClonePolicy(taskId: string): Promise<TaskClonePolicy>;
}

export interface SubtaskRunBridgeOptions {
  readonly logger: Logger;
  readonly sessions: SubtaskRunSessionPort;
  readonly workspaces: SubtaskRunWorkspacePort;
  readonly tasks: SubtaskRunTaskPort;
}

/**
 * The returned callback mirrors the control panel's chat.start sequence:
 * resolve clone workspace -> startChat -> detached first turn. The
 * turn is deliberately NOT awaited — the orchestrator treats startRun as
 * "session is up and the prompt is on its way"; the terminal status flows
 * back through the bus.
 */
export function createSubtaskRunBridge(options: SubtaskRunBridgeOptions): StartSubtaskRun {
  return async ({ taskId, subtaskId, prompt, title }) => {
    const workspace = await resolveTaskWorkspace(options, taskId);
    // The subtask's title names the chat (survives the first-turn auto-rename).
    const started = await options.sessions.startChat(prompt, undefined, workspace, title);
    const sessionId = started.session.sessionId as string;
    // Fire-and-forget, mirroring runTurnDetached: completion (completed /
    // failed / cancelled) reaches the orchestrator via the bus.
    void options.sessions.sendChatTurn(sessionId, prompt).catch((error: unknown) => {
      options.logger.error("subtask first turn failed to run", {
        sessionId,
        subtaskId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    return { sessionId };
  };
}

/**
 * Resolve the parent task's durable, revalidated policy to a non-empty clone
 * workspace. Missing or ambiguous configuration is an actionable hard error.
 */
async function resolveTaskWorkspace(options: SubtaskRunBridgeOptions, taskId: string): Promise<ChatWorkspaceContext> {
  const policy = await options.tasks.requireClonePolicy(taskId);
  const workspace = await options.workspaces.resolveTaskCloneWorkspace(policy);
  if (workspace.mode !== "clone" || workspace.roots.length === 0) {
    throw new Error(`Task ${taskId}'s clone policy did not resolve to a non-empty clone workspace.`);
  }
  return workspace;
}
