/**
 * Cross-project task-review application facade.
 *
 * A VIEW over existing state, not new storage: it aggregates a task's changed
 * files across every linked session (baseline diffs for implementation sessions,
 * clone sync state for clone sessions), joins the sessions' open code-review
 * comments by the `<repo>:<path>` anchor convention, and - on submit - turns
 * each session's open comments back into a host-authored revision turn through
 * the shared `composeReviewCommentTurn` composer. Nothing here widens agent
 * reach: it only reads projections and sends text to sessions the task already
 * links.
 *
 * The service depends on NARROW structural ports (below) rather than the
 * concrete runtimes, so the unit tests stub them without booting docker or the
 * chat service; the real IsolatedRunService / WorkspaceReviewAppService /
 * TaskService satisfy them structurally at composition. No `vscode` imports
 * belong here.
 */

import type {
  ChatModelSelection,
  ChatSessionRecord,
  CloneRepoState,
  DiffFileSummary,
  ReviewCommentId,
  ReviewCommentSummary,
  SessionMode,
  TaskReviewFile,
  TaskReviewProject,
  TaskReviewSessionRef,
  TaskReviewState,
  TurnResult,
  WorkTaskRecord,
  WorkTaskSummary
} from "@drydock/contracts";
import {
  composeReviewCommentTurn,
  type CodeReviewService,
  type Logger
} from "@drydock/core";
import { asId } from "@drydock/contracts";
import type { ChatWorkspaceContext } from "./isolatedRunService.js";

/** Session facts the task review needs; IsolatedRunService satisfies this structurally. */
export interface TaskReviewSessionPort {
  listChatSessions(): Promise<ChatSessionRecord[]>;
  cloneState(sessionId: string): Promise<CloneRepoState[]>;
  isCloneSession(sessionId: string): boolean;
  isChatSessionLive(sessionId: string): boolean;
  hasActiveChatTurn(sessionId: string): boolean;
  isHeartbeatFresh(heartbeatAt: string | undefined): boolean;
  readonly hostInstanceId: string;
  /** Resolves only when the dispatched turn reaches a terminal state. */
  sendChatTurn(sessionId: string, prompt: string): Promise<TurnResult>;
  resumeChatSession(sessionId: string, model?: ChatModelSelection, workspace?: ChatWorkspaceContext): Promise<unknown>;
  getSessionMode(sessionId: string): SessionMode;
}

/** Diff + review-thread facts; WorkspaceReviewAppService satisfies this. */
export interface TaskReviewDiffPort {
  diffStatus(sessionId?: string): Promise<DiffFileSummary[]>;
  reviewState(sessionId?: string): Promise<{ reviewSessionId: string; comments: ReviewCommentSummary[] }>;
}

/** Task facts; TaskService satisfies this. */
export interface TaskReviewTaskPort {
  getTask(taskId: string): Promise<WorkTaskRecord | null>;
  listTaskSummaries(): Promise<WorkTaskSummary[]>;
}

export interface TaskReviewAppServiceOptions {
  readonly logger: Logger;
  readonly tasks: TaskReviewTaskPort;
  readonly sessions: TaskReviewSessionPort;
  readonly diffs: TaskReviewDiffPort;
  readonly review: CodeReviewService;
}

export interface TaskReviewSubmitResult {
  readonly dispatched: number;
  readonly sessions: number;
  /** The sessions revision turns were dispatched to, in dispatch order. */
  readonly sentSessions: readonly TaskReviewSessionRef[];
  readonly errors: readonly string[];
}

export interface TaskReviewSubmitHooks {
  /** vscode-side auto workspace resolution for resuming a dead session; undefined result = cannot resume. */
  readonly resolveResumeWorkspace?: (mode: SessionMode) => Promise<ChatWorkspaceContext | undefined>;
  /** Detached terminal failure notification; comments have been reopened before this runs. */
  readonly onDispatchFailed?: (failure: TaskReviewDispatchFailure) => void | Promise<void>;
}

export interface TaskReviewDispatchFailure {
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly reason: string;
  readonly commentCount: number;
  readonly reopenedCount: number;
}

export class TaskReviewAppService {
  constructor(private readonly options: TaskReviewAppServiceOptions) {}

  /**
   * Aggregates the task's cross-project review projection: changed files grouped
   * by repo across every linked session, with per-file open-comment counts. A
   * missing session record for a linked id is a stale link - warned and skipped,
   * never fatal. Clone sessions not live in this window (or whose clone state
   * cannot be read) contribute a degraded-fetch note instead of silently
   * dropping their files.
   */
  async computeState(taskId: string): Promise<TaskReviewState> {
    const task = await this.options.tasks.getTask(taskId);
    if (task === null) {
      throw new Error(`Task ${taskId} was not found.`);
    }
    const summary = (await this.options.tasks.listTaskSummaries()).find((candidate) => candidate.taskId === taskId);
    const linkedSessionIds = summary?.linkedSessionIds ?? [];

    const records = new Map<string, ChatSessionRecord>();
    for (const record of await this.options.sessions.listChatSessions()) {
      records.set(record.sessionId, record);
    }

    const files: TaskReviewFile[] = [];
    const notes: string[] = [];
    const sessionRefs: TaskReviewSessionRef[] = [];
    let openCommentCount = 0;
    let revisionInFlight = 0;

    for (const sessionId of linkedSessionIds) {
      const record = records.get(sessionId);
      if (record === undefined) {
        // A stale link (session deleted out from under the task); skip silently.
        this.options.logger.warn("task review skipped an unknown linked session", { taskId, sessionId });
        continue;
      }
      // Every resolvable linked session rides along - even one with no changed
      // files - so the panel's comment dock can read its threads.
      sessionRefs.push({ sessionId, sessionTitle: record.title });

      if (this.options.sessions.hasActiveChatTurn(sessionId)) {
        revisionInFlight += 1;
      }

      // This session's open code comments (non-plan anchors), joined per-file below.
      const openComments = (await this.options.diffs.reviewState(sessionId).then((state) => state.comments))
        .filter((comment) => comment.status === "open" && !comment.filePath.startsWith("plan:"));
      openCommentCount += openComments.length;

      const mode = record.mode ?? this.options.sessions.getSessionMode(sessionId);
      if (mode === "plan") {
        // Plan sessions contribute plan docs, not code files.
        continue;
      }

      if (mode === "clone") {
        files.push(...await this.cloneFiles(sessionId, record, openComments, notes));
        continue;
      }

      // Implementation (baseline-backed) session.
      for (const change of await this.options.diffs.diffStatus(sessionId)) {
        files.push({
          sessionId,
          sessionTitle: record.title,
          baselineId: change.baselineId,
          repo: change.rootName,
          path: change.path,
          changeKind: change.changeKind,
          ...(change.addedLines === undefined ? {} : { addedLines: change.addedLines }),
          ...(change.removedLines === undefined ? {} : { removedLines: change.removedLines }),
          commentCount: countFileComments(openComments, change.rootName, change.path)
        });
      }
    }

    const projects = groupByRepo(files);
    return {
      taskId,
      title: task.title,
      sessions: sessionRefs,
      projects,
      openCommentCount,
      ...(revisionInFlight > 0 ? { revisionInFlight } : {}),
      ...(notes.length === 0 ? {} : { notes })
    };
  }

  /**
   * Sends each linked session's open code comments back as a revision turn. Per
   * docs/design/task-review.md "Submit semantics": a session with no open code
   * comments is skipped silently (its comments stay `open`); a session that is
   * mid-turn, running elsewhere, or unresumable here is skipped with an error
   * line (comments stay `open`); only a confirmed-sendable session has its
   * comments composed (which flips them to `delegated`) and dispatched detached.
   * A refused, failed, or cancelled detached turn reopens only those included
   * comments that are still delegated, leaving later user/agent state alone.
   */
  async submitReview(taskId: string, hooks?: TaskReviewSubmitHooks): Promise<TaskReviewSubmitResult> {
    const summary = (await this.options.tasks.listTaskSummaries()).find((candidate) => candidate.taskId === taskId);
    const linkedSessionIds = summary?.linkedSessionIds ?? [];

    const records = new Map<string, ChatSessionRecord>();
    for (const record of await this.options.sessions.listChatSessions()) {
      records.set(record.sessionId, record);
    }

    let dispatched = 0;
    let sessions = 0;
    const sentSessions: TaskReviewSessionRef[] = [];
    const errors: string[] = [];

    for (const sessionId of linkedSessionIds) {
      const record = records.get(sessionId);
      if (record === undefined) {
        // Stale link; nothing to submit.
        continue;
      }
      const title = record.title;

      // 1. Count open code comments FIRST. Composing flips comments to delegated,
      // so a session that turns out unsendable must not have its comments touched.
      const openComments = (await this.options.diffs.reviewState(sessionId).then((state) => state.comments))
        .filter((comment) => comment.status === "open" && !comment.filePath.startsWith("plan:"));
      if (openComments.length === 0) {
        // Nothing to send from this session.
        continue;
      }

      // 2. Live session: must be idle. A mid-turn session is left alone.
      if (this.options.sessions.isChatSessionLive(sessionId)) {
        if (this.options.sessions.hasActiveChatTurn(sessionId)) {
          errors.push(`Session "${title}" is mid-turn - submit again when it finishes.`);
          continue;
        }
      } else {
        // 3. Not live: a session running in another window must not be touched.
        if (this.isRunningElsewhere(record)) {
          errors.push(`Session "${title}" is running in another VS Code window.`);
          continue;
        }
        const workspace = hooks?.resolveResumeWorkspace === undefined
          ? undefined
          : await hooks.resolveResumeWorkspace(record.mode ?? this.options.sessions.getSessionMode(sessionId));
        if (workspace === undefined) {
          errors.push(`Session "${title}" is not live and could not be resumed here.`);
          continue;
        }
        try {
          await this.options.sessions.resumeChatSession(sessionId, undefined, workspace);
        } catch (error) {
          errors.push(`Session "${title}" could not be resumed: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
      }

      // 4. Session is confirmed sendable: compose (flips comments to delegated)
      // and dispatch the revision turn detached. sendChatTurn resolves only at
      // terminal, so awaiting it here would serialize multi-session revisions
      // and leave the webview request open for the whole agent turn. The
      // detached recovery path reopens the exact included comments on failure.
      const composed = await composeReviewCommentTurn({
        review: this.options.review,
        sessionId: asId<"SessionId">(sessionId),
        anchorFilter: (filePath) => !filePath.startsWith("plan:"),
        header: "[host] Reviewer comments on your code changes - address each comment and revise the files:",
        renderLine: (comment) => `- ${comment.filePath}:${comment.startLine === comment.endLine ? String(comment.startLine) : `${String(comment.startLine)}-${String(comment.endLine)}`} - ${comment.body}`
      });
      if (composed === null) {
        continue;
      }
      this.dispatchReviewTurn(taskId, sessionId, title, composed, hooks?.onDispatchFailed);
      dispatched += composed.count;
      sessions += 1;
      // Named refs let the panel say WHICH chats now run revisions (and, next
      // phase, carry the session's role) instead of a bare count.
      sentSessions.push({ sessionId, sessionTitle: title });
    }

    return { dispatched, sessions, sentSessions, errors };
  }

  /**
   * Runs one already-composed revision turn without blocking sibling dispatches.
   * A terminal completion keeps the comments delegated. Refusal/rejection and
   * explicit failed/cancelled results roll back only comments that have not
   * since moved out of delegated, so a later resolve/block is never overwritten.
   */
  private dispatchReviewTurn(
    taskId: string,
    sessionId: string,
    sessionTitle: string,
    composed: { readonly prompt: string; readonly count: number; readonly commentIds: readonly ReviewCommentId[] },
    onDispatchFailed?: (failure: TaskReviewDispatchFailure) => void | Promise<void>
  ): void {
    void this.runDetachedReviewTurn(taskId, sessionId, sessionTitle, composed, onDispatchFailed);
  }

  private async runDetachedReviewTurn(
    taskId: string,
    sessionId: string,
    sessionTitle: string,
    composed: { readonly prompt: string; readonly count: number; readonly commentIds: readonly ReviewCommentId[] },
    onDispatchFailed?: (failure: TaskReviewDispatchFailure) => void | Promise<void>
  ): Promise<void> {
    let reason: string;
    try {
      const result = await this.options.sessions.sendChatTurn(sessionId, composed.prompt);
      if (result.status === "completed") {
        return;
      }
      reason = result.status === "cancelled"
        ? "was cancelled before it completed"
        : "failed before it completed";
    } catch (error) {
      reason = `was refused: ${error instanceof Error ? error.message : String(error)}`;
    }

    let reopenedCount = 0;
    const recoveryErrors: string[] = [];
    try {
      const recovery = await this.reopenDelegatedComments(sessionId, composed.commentIds);
      reopenedCount = recovery.reopenedCount;
      recoveryErrors.push(...recovery.errors);
    } catch (error) {
      recoveryErrors.push(error instanceof Error ? error.message : String(error));
    }

    this.options.logger.error("task review revision turn did not complete", {
      taskId,
      sessionId,
      reason,
      commentCount: composed.count,
      reopenedCount,
      ...(recoveryErrors.length === 0 ? {} : { recoveryErrors })
    });

    if (onDispatchFailed !== undefined) {
      try {
        await onDispatchFailed({
          sessionId,
          sessionTitle,
          reason,
          commentCount: composed.count,
          reopenedCount
        });
      } catch (error) {
        this.options.logger.warn("task review dispatch-failure notification failed", {
          taskId,
          sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  /** Reopens the dispatch's exact threads, but only while they remain delegated. */
  private async reopenDelegatedComments(
    sessionId: string,
    commentIds: readonly ReviewCommentId[]
  ): Promise<{ readonly reopenedCount: number; readonly errors: readonly string[] }> {
    const scope = await this.options.review.ensureReviewSession("current-session", asId<"SessionId">(sessionId));
    const included = new Set<ReviewCommentId>(commentIds);
    const delegated = (await this.options.review.listComments(scope.reviewSessionId))
      .filter((comment) => included.has(comment.commentId) && comment.status === "delegated");
    let reopenedCount = 0;
    const errors: string[] = [];
    for (const comment of delegated) {
      try {
        await this.options.review.setCommentStatus(comment.commentId, "open");
        reopenedCount += 1;
      } catch (error) {
        errors.push(`${comment.commentId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { reopenedCount, errors };
  }

  /**
   * Open (non-plan) review-comment counts per task, joined over each task's
   * linked sessions with ONE reviewState read per unique session. Powers the
   * Work-tab Review button's "(N open comments)" - comment counts are cheap
   * store reads; changed-FILE counts are deliberately NOT computed here
   * (diffStatus walks and hashes trees). Tasks with a zero count are omitted.
   */
  async openCommentCountsByTask(): Promise<ReadonlyMap<string, number>> {
    const summaries = await this.options.tasks.listTaskSummaries();
    const perSession = new Map<string, number>();
    const counts = new Map<string, number>();
    for (const task of summaries) {
      let total = 0;
      for (const sessionId of task.linkedSessionIds) {
        let count = perSession.get(sessionId);
        if (count === undefined) {
          try {
            const state = await this.options.diffs.reviewState(sessionId);
            count = state.comments
              .filter((comment) => comment.status === "open" && !comment.filePath.startsWith("plan:"))
              .length;
          } catch (error) {
            this.options.logger.warn("task review comment count skipped a session", {
              sessionId,
              error: error instanceof Error ? error.message : String(error)
            });
            count = 0;
          }
          perSession.set(sessionId, count);
        }
        total += count;
      }
      if (total > 0) {
        counts.set(task.taskId, total);
      }
    }
    return counts;
  }

  /** Task ids whose links include this session - the panel provider's push routing. */
  async taskIdsForSession(sessionId: string): Promise<string[]> {
    return (await this.options.tasks.listTaskSummaries())
      .filter((task) => task.linkedSessionIds.includes(sessionId))
      .map((task) => task.taskId);
  }

  /**
   * A clone session's agent-changed files, one TaskReviewFile per repo/file with
   * the `clone` marker (no baseline diff). A session that is not a live clone in
   * this window - or whose clone state cannot be read - contributes a note
   * instead, since `sessionClones` is process state.
   */
  private async cloneFiles(
    sessionId: string,
    record: ChatSessionRecord,
    openComments: readonly ReviewCommentSummary[],
    notes: string[]
  ): Promise<TaskReviewFile[]> {
    if (!this.options.sessions.isCloneSession(sessionId)) {
      notes.push(`Clone session "${record.title}" is not live in this window - its changes are not listed.`);
      this.options.logger.warn("task review clone session not live", { sessionId });
      return [];
    }
    let repos: CloneRepoState[];
    try {
      repos = await this.options.sessions.cloneState(sessionId);
    } catch (error) {
      notes.push(`Clone session "${record.title}" is not live in this window - its changes are not listed.`);
      this.options.logger.warn("task review clone state read failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
    const files: TaskReviewFile[] = [];
    for (const repo of repos) {
      for (const file of repo.files) {
        files.push({
          sessionId,
          sessionTitle: record.title,
          repo: repo.name,
          path: file.path,
          changeKind: file.changeKind,
          ...(file.addedLines === undefined ? {} : { addedLines: file.addedLines }),
          ...(file.removedLines === undefined ? {} : { removedLines: file.removedLines }),
          commentCount: countFileComments(openComments, repo.name, file.path),
          clone: true,
          ...(file.conflicted === true ? { conflicted: true } : {})
        });
      }
    }
    return files;
  }

  /**
   * True when a stored-active session's fresh heartbeat belongs to another host
   * instance - it is running in a sibling window and must not be resumed here.
   * Mirrors the control panel's running-elsewhere rule.
   */
  private isRunningElsewhere(record: ChatSessionRecord): boolean {
    const storedActive = record.status === "active" || record.status === "starting";
    return storedActive
      && this.options.sessions.isHeartbeatFresh(record.heartbeatAt)
      && record.hostInstanceId !== undefined
      && record.hostInstanceId !== this.options.sessions.hostInstanceId;
  }
}

/**
 * Open code comments anchored to a file count either the qualified `<repo>:<path>`
 * form (task-review convention) or the legacy plain `<path>` form (Changes →
 * Comments). A plain-path comment in a multi-root session badges same-named files
 * in each root - the noted cosmetic limit.
 */
function countFileComments(comments: readonly ReviewCommentSummary[], repo: string, filePath: string): number {
  const qualified = `${repo}:${filePath}`;
  return comments.filter((comment) => comment.filePath === qualified || comment.filePath === filePath).length;
}

/** Groups files into projects by repo; projects sorted by name, files by path then title. */
function groupByRepo(files: readonly TaskReviewFile[]): TaskReviewProject[] {
  const byRepo = new Map<string, TaskReviewFile[]>();
  for (const file of files) {
    const existing = byRepo.get(file.repo);
    if (existing === undefined) {
      byRepo.set(file.repo, [file]);
    } else {
      existing.push(file);
    }
  }
  const projects: TaskReviewProject[] = [];
  for (const [name, repoFiles] of byRepo) {
    repoFiles.sort((a, b) => a.path.localeCompare(b.path) || a.sessionTitle.localeCompare(b.sessionTitle));
    projects.push({ name, files: repoFiles });
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));
  return projects;
}
