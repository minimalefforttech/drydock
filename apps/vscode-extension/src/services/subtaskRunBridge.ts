/**
 * Subtask run bridge (task board orchestration).
 *
 * Builds the `StartSubtaskRun` callback the SubtaskOrchestrator is
 * constructed with, out of the SAME backend services the control panel's
 * "chat.start" flow delegates to: `IsolatedRunService.startChat` boots the
 * isolated clone session (title derived from the prompt), then returns a
 * fire-and-forget first-turn dispatcher. The orchestrator calls it only after
 * its session map, durable link, and card state are committed; completion
 * arrives via the product bus `turn-completed` event. No `vscode` imports
 * belong here; ports are narrow and structural so tests can stub them without
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

/** Unlanded upstream changesets (ADR 0014); ChangesetService satisfies this. */
export interface SubtaskRunChangesetPort {
  seedPatchesFor(upstreamSubtaskIds: readonly string[]): Promise<readonly { readonly repoName: string; readonly label: string; readonly patch: string }[]>;
}

export interface SubtaskRunBridgeOptions {
  readonly logger: Logger;
  readonly sessions: SubtaskRunSessionPort;
  readonly workspaces: SubtaskRunWorkspacePort;
  readonly tasks: SubtaskRunTaskPort;
  /** Optional: absent keeps every start seeding local HEAD (classic behavior). */
  readonly changesets?: SubtaskRunChangesetPort;
}

/**
 * The returned callback prepares the control panel's chat.start sequence:
 * resolve clone workspace -> startChat -> return a detached first-turn
 * dispatcher. The orchestrator invokes that dispatcher only after committing
 * the session's orchestration state; terminal status flows back through the
 * bus and is deliberately not awaited by the start request.
 */
export function createSubtaskRunBridge(options: SubtaskRunBridgeOptions): StartSubtaskRun {
  return async ({ taskId, subtaskId, prompt, title, seedMode, dependsOn, model }) => {
    let workspace = await resolveTaskWorkspace(options, taskId);
    // Stored `upstream` seed choice (ADR 0014): resolve the upstream subtasks'
    // unlanded changesets and ride them into clone init. No unlanded output is
    // NOT an error — the upstreams simply produced nothing to carry — but a
    // resolution failure (missing blob) aborts the start honestly.
    if (seedMode === "upstream" && dependsOn.length > 0 && options.changesets !== undefined) {
      const seeds = await options.changesets.seedPatchesFor(dependsOn);
      if (seeds.length > 0) {
        workspace = { ...workspace, seedPatches: seeds };
      } else {
        options.logger.info("upstream seed chosen but no unlanded changesets exist; cloning local HEAD only", { subtaskId });
      }
    }
    // The subtask's title names the chat (survives the first-turn auto-rename).
    // A per-role model profile (ADR 0002) rides through; absent = provider default.
    const started = await options.sessions.startChat(prompt, model, workspace, title);
    const sessionId = started.session.sessionId as string;
    const logDispatchFailure = (error: unknown): void => {
      options.logger.error("subtask first turn failed to run", {
        sessionId,
        subtaskId,
        error: error instanceof Error ? error.message : String(error)
      });
    };
    return {
      sessionId,
      // Fire-and-forget, mirroring runTurnDetached: completion (completed /
      // failed / cancelled) reaches the orchestrator via the bus. Protect the
      // no-throw dispatcher contract even if a structural test double throws
      // before returning its promise.
      dispatchFirstTurn: () => {
        try {
          void options.sessions.sendChatTurn(sessionId, prompt).catch(logDispatchFailure);
        } catch (error) {
          logDispatchFailure(error);
        }
      }
    };
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
