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
 * touches the single-flight `runInFlight` slot - that guard only covers
 * `startPromptRun` and `runAppServerProbe` (see acquireRunSlot call sites in
 * isolatedRunService.ts). Chat sessions are per-session concurrent
 * (ChatSessionService keeps a liveSessions map; only turns within ONE session
 * serialize), so parallel dependent dispatch needs no FIFO queue here.
 */

import type { ChatModelSelection, ChatSessionRecord, TaskClonePolicy } from "@drydock/contracts";
import { sanitizeHandoffNoteForPrompt, type Logger } from "@drydock/core";
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

/** Ticket facts for stage chains (plan D4); the work-task store satisfies this. */
export interface SubtaskRunTicketPort {
  getTicket(taskId: string): Promise<{
    readonly handoffMode?: "patch" | "branch";
    readonly branchName?: string;
    readonly landedBranch?: string;
  } | null>;
}

/** Stored handoff notes from upstream subtasks (plan D4). */
export interface SubtaskRunHandoffPort {
  listForSubtasks(subtaskIds: readonly string[]): Promise<readonly { readonly subtaskId: string; readonly note: string }[]>;
}

export interface SubtaskRunBridgeOptions {
  readonly logger: Logger;
  readonly sessions: SubtaskRunSessionPort;
  readonly workspaces: SubtaskRunWorkspacePort;
  readonly tasks: SubtaskRunTaskPort;
  /** Optional: absent keeps every start seeding local HEAD (classic behavior). */
  readonly changesets?: SubtaskRunChangesetPort;
  /** Optional: absent disables stage-branch cloning (stages then behave like classic dependents). */
  readonly tickets?: SubtaskRunTicketPort;
  /** Optional: absent disables handoff-note injection. */
  readonly handoffs?: SubtaskRunHandoffPort;
}

/**
 * The returned callback prepares the control panel's chat.start sequence:
 * resolve clone workspace -> startChat -> return a detached first-turn
 * dispatcher. The orchestrator invokes that dispatcher only after committing
 * the session's orchestration state; terminal status flows back through the
 * bus and is deliberately not awaited by the start request.
 */
export function createSubtaskRunBridge(options: SubtaskRunBridgeOptions): StartSubtaskRun {
  return async ({ taskId, subtaskId, prompt, title, seedMode, dependsOn, model, stageIndex }) => {
    let workspace = await resolveTaskWorkspace(options, taskId);

    // Stage chains (plan D4): a stage past the first on a branch-handoff task
    // clones the TASK BRANCH tip instead of local HEAD - the branch is the
    // chain medium, durable by construction. Chain clones are always fresh
    // (the branch tree is exactly the intended state) and never also seed
    // upstream changesets (the branch already carries that content; seeding
    // it again would double-apply).
    let stageBranch: string | undefined;
    if ((stageIndex ?? 0) > 1 && options.tickets !== undefined) {
      const ticket = await options.tickets.getTicket(taskId);
      if (ticket?.handoffMode === "branch") {
        stageBranch = ticket.landedBranch ?? ticket.branchName;
      }
    }
    if (stageBranch !== undefined) {
      workspace = { ...workspace, sourceBranch: stageBranch, dirtyHandling: "fresh" };
      if (seedMode === "upstream") {
        options.logger.info("stage clones the task branch; upstream changeset seeding skipped", { subtaskId, stageBranch });
      }
    } else if (seedMode === "upstream" && dependsOn.length > 0 && options.changesets !== undefined) {
      // Stored `upstream` seed choice (ADR 0014): resolve the upstream subtasks'
      // unlanded changesets and ride them into clone init. No unlanded output is
      // NOT an error - the upstreams simply produced nothing to carry - but a
      // resolution failure (missing blob) aborts the start honestly.
      const seeds = await options.changesets.seedPatchesFor(dependsOn);
      if (seeds.length > 0) {
        workspace = { ...workspace, seedPatches: seeds };
      } else {
        options.logger.info("upstream seed chosen but no unlanded changesets exist; cloning local HEAD only", { subtaskId });
      }
    }

    // Handoff notes (plan D4): whatever the upstreams left for their
    // successors rides into the first turn as labeled context - fresh
    // context plus a small baton, never a transcript replay. Notes are
    // worker-authored and sanitized so they cannot fabricate host-briefing
    // sections or protocol fences the next worker would trust.
    let effectivePrompt = prompt;
    if (dependsOn.length > 0 && options.handoffs !== undefined) {
      const notes = await options.handoffs.listForSubtasks(dependsOn);
      if (notes.length > 0) {
        const sections = notes.map((entry) => `## Handoff from the previous stage\n${sanitizeHandoffNoteForPrompt(entry.note)}`);
        effectivePrompt = `${sections.join("\n\n")}\n\n## This stage\n${prompt}`;
      }
    }

    // The subtask's title names the chat (survives the first-turn auto-rename).
    // A per-role model profile (ADR 0002) rides through; absent = provider default.
    const started = await options.sessions.startChat(effectivePrompt, model, workspace, title);
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
          void options.sessions.sendChatTurn(sessionId, effectivePrompt).catch(logDispatchFailure);
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
