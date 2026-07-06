/**
 * Subtask run bridge (task board orchestration).
 *
 * Builds the `StartSubtaskRun` callback the SubtaskOrchestrator is
 * constructed with, out of the SAME backend services the control panel's
 * "chat.start" flow delegates to: `IsolatedRunService.startChat` boots the
 * isolated session (title derived from the prompt), implementation-mode
 * workspaces get per-root diff baselines, and the first turn is dispatched
 * fire-and-forget — completion arrives via the product bus `turn-completed`
 * event, which the orchestrator subscribes to. No `vscode` imports belong
 * here; ports are narrow and structural so tests can stub them without
 * booting docker (the taskReviewAppService pattern).
 *
 * Workspace inheritance: the subtask's parent task links to workspace sets;
 * when it links to EXACTLY ONE the session mounts that set (an unambiguous
 * "where", mirroring TaskService.recordSessionActivity's sole-set rule) in
 * implementation mode. Zero or several sets fall back to a plain disposable
 * workspace — guessing between sets would mount the wrong project silently.
 *
 * Concurrency: `IsolatedRunService.startChat` -> `startChatSession` never
 * touches the single-flight `runInFlight` slot — that guard only covers
 * `startPromptRun` and `runAppServerProbe` (see acquireRunSlot call sites in
 * isolatedRunService.ts). Chat sessions are per-session concurrent
 * (ChatSessionService keeps a liveSessions map; only turns within ONE session
 * serialize), so parallel dependent dispatch needs no FIFO queue here.
 */

import { asId } from "@drydock/contracts";
import type { ChatModelSelection, ChatSessionRecord, TaskId, WorkTaskLinkRecord } from "@drydock/contracts";
import type { Logger } from "@drydock/core";
import type { StartSubtaskRun } from "@drydock/work-management";
import type { ChatWorkspaceContext } from "./isolatedRunService.js";

/** Chat-session facts the bridge needs; IsolatedRunService satisfies this structurally. */
export interface SubtaskRunSessionPort {
  startChat(prompt: string, model?: ChatModelSelection, workspace?: ChatWorkspaceContext): Promise<{ session: ChatSessionRecord }>;
  sendChatTurn(sessionId: string, prompt: string): Promise<unknown>;
}

/** Workspace resolution + baselining; WorkspaceReviewAppService satisfies this. */
export interface SubtaskRunWorkspacePort {
  resolveWorkspaceSelection(
    selection: { readonly workspaceSetId: string; readonly mode: "plan" | "implementation" | "clone" },
    openFolderRoots?: readonly string[]
  ): Promise<ChatWorkspaceContext>;
  createSessionBaselines(sessionId: string, roots: readonly string[]): Promise<void>;
}

/** Task-link facts (which workspace sets the parent task points at); WorkTaskStore satisfies this. */
export interface SubtaskRunLinkPort {
  listLinks(taskId?: TaskId): Promise<WorkTaskLinkRecord[]>;
}

export interface SubtaskRunBridgeOptions {
  readonly logger: Logger;
  readonly sessions: SubtaskRunSessionPort;
  readonly workspaces: SubtaskRunWorkspacePort;
  readonly taskLinks: SubtaskRunLinkPort;
}

/**
 * The returned callback mirrors the control panel's chat.start sequence:
 * resolve workspace -> startChat -> baseline -> detached first turn. The
 * turn is deliberately NOT awaited — the orchestrator treats startRun as
 * "session is up and the prompt is on its way"; the terminal status flows
 * back through the bus.
 */
export function createSubtaskRunBridge(options: SubtaskRunBridgeOptions): StartSubtaskRun {
  return async ({ taskId, subtaskId, prompt }) => {
    const workspace = await resolveTaskWorkspace(options, taskId);
    const started = await options.sessions.startChat(prompt, undefined, workspace);
    const sessionId = started.session.sessionId as string;
    if (workspace !== undefined && workspace.mode === "implementation") {
      // Mirrors baselineWorkspaceSession in the chat.start flow: baselines are
      // best-effort; a failure must not sink the run that already started.
      try {
        await options.workspaces.createSessionBaselines(sessionId, workspace.roots);
      } catch (error) {
        options.logger.warn("subtask session baseline failed", {
          sessionId,
          subtaskId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
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
 * The parent task's workspace context: its sole linked workspace set,
 * resolved to implementation-mode mount roots — or undefined when the task
 * links to zero or several sets (ambiguous, so no project mounts).
 */
async function resolveTaskWorkspace(options: SubtaskRunBridgeOptions, taskId: string): Promise<ChatWorkspaceContext | undefined> {
  const links = await options.taskLinks.listLinks(asId<"TaskId">(taskId));
  const setIds = [...new Set(links.filter((link) => link.workspaceSetId !== undefined).map((link) => link.workspaceSetId as string))];
  const soleSetId = setIds.length === 1 ? setIds[0] : undefined;
  if (soleSetId === undefined) {
    return undefined;
  }
  try {
    return await options.workspaces.resolveWorkspaceSelection({ workspaceSetId: soleSetId, mode: "implementation" });
  } catch (error) {
    // A stale/deleted set must not stop the run; it just loses its mounts.
    options.logger.warn("subtask workspace resolution failed; starting without project mounts", {
      taskId,
      workspaceSetId: soleSetId,
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}
