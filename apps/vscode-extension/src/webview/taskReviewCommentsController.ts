/**
 * Task Review ↔ VS Code Comments API bridge.
 *
 * This file is the ONLY Comments-API surface in the extension. One
 * CommentController ("drydock.taskReview") backs every open Task Review
 * panel; gutter threads in the diff editor are two-way synced to the review
 * store through WorkspaceReviewAppService (never through panel messages —
 * comment traffic flows host-side here directly).
 *
 * Registry design. A per-task map of normalized absolute file paths → the
 * {sessionId, repo, relativePath} needed to anchor a comment is kept for every
 * baseline-backed file of every OPEN panel (clone files are never registered —
 * no on-disk path is theirs to comment on). A path may be registered by two
 * tasks, so registrations are stored per task and merged into one lookup; a
 * path stays commentable while any task still registers it. With no panels
 * open the merged lookup is empty, so:
 *
 * Right-side-only rule. The commentingRangeProvider offers a commenting range
 * ONLY for a `file`-scheme document whose normalized fsPath is in the merged
 * registry. The `drydock-baseline` (left) side of a diff is never `file`
 * scheme, so it never becomes commentable, and with the registry empty the
 * controller offers commenting NOWHERE — zero global editor noise.
 *
 * Line numbers. Stored comment ranges are 1-based inclusive; vscode.Range lines
 * are 0-based. The conversion is centralized in taskReviewCommentShared.ts
 * (unit-tested there) and only used through storedLinesToRange /
 * rangeToStoredLines here.
 */

import * as vscode from "vscode";
import type { Logger } from "@drydock/core";
import { normalizePathKey } from "@drydock/core";
import type { WorkspaceReviewAppService } from "../services/workspaceReviewAppService.js";
import {
  anchorMatchesFile,
  commentAnchor,
  GUTTER_VISIBLE_STATUSES,
  rangeToStoredLines,
  storedLinesToRange
} from "./taskReviewCommentShared.js";

/** A commentable baseline-backed file: enough to anchor a comment to its session. */
export interface TaskReviewCommentFile {
  readonly sessionId: string;
  readonly repo: string;
  readonly relativePath: string;
  readonly absolutePath: string;
}

/** Registry value: everything a lookup by path needs to talk to the store. */
interface RegistryEntry {
  readonly sessionId: string;
  readonly repo: string;
  readonly relativePath: string;
  readonly absolutePath: string;
}

export interface TaskReviewCommentsControllerOptions {
  readonly workspaceReview: WorkspaceReviewAppService;
  readonly logger: Logger;
  /** Fired after a store write so open panels for the session refetch state. */
  readonly onCommentsChanged: (sessionId: string) => void;
}

export class TaskReviewCommentsController {
  private readonly controller: vscode.CommentController;
  /** taskId → (normalized path key → entry). One set per open panel. */
  private readonly perTask = new Map<string, Map<string, RegistryEntry>>();
  /** Merged path-key → entry across all tasks; rebuilt on every mutation. */
  private readonly merged = new Map<string, RegistryEntry>();
  /** Flat list of live materialized threads, so refresh/dispose can tear down. */
  private threads: vscode.CommentThread[] = [];

  constructor(private readonly options: TaskReviewCommentsControllerOptions) {
    this.controller = vscode.comments.createCommentController("drydock.taskReview", "Task Review");
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => this.commentingRangesFor(document)
    };
  }

  // MARK: Registration

  /**
   * Replaces one task's registrations with the given baseline-backed files and
   * re-materializes threads. A path registered by another task stays commentable.
   */
  async setTaskFiles(taskId: string, files: readonly TaskReviewCommentFile[]): Promise<void> {
    const byPath = new Map<string, RegistryEntry>();
    for (const file of files) {
      byPath.set(normalizePathKey(file.absolutePath), {
        sessionId: file.sessionId,
        repo: file.repo,
        relativePath: file.relativePath,
        absolutePath: file.absolutePath
      });
    }
    this.perTask.set(taskId, byPath);
    this.rebuildMerged();
    await this.refresh();
  }

  /**
   * Drops a task's registrations (panel closed). Threads whose file is no longer
   * registered by any task are disposed; the rest are refreshed.
   */
  clearTask(taskId: string): void {
    if (!this.perTask.delete(taskId)) {
      return;
    }
    this.rebuildMerged();
    void this.refresh().catch((error: unknown) => {
      this.options.logger.warn("task review comment refresh after clearTask failed", {
        taskId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  // MARK: Materialization

  /**
   * Re-materializes ALL gutter threads from the store. Thread counts are small,
   * so dispose-and-recreate is fine: every live thread is torn down, then for
   * each registered session every gutter-visible comment that anchor-matches a
   * registered file of that session is recreated on that file's disk uri at its
   * stored range.
   */
  async refresh(): Promise<void> {
    this.disposeThreads();
    if (this.merged.size === 0) {
      return;
    }
    // One reviewState read per unique session across the merged registry.
    const sessionIds = new Set<string>();
    for (const entry of this.merged.values()) {
      sessionIds.add(entry.sessionId);
    }
    for (const sessionId of sessionIds) {
      let comments;
      try {
        comments = (await this.options.workspaceReview.reviewState(sessionId)).comments;
      } catch (error) {
        this.options.logger.warn("task review comment materialization skipped a session", {
          sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
        continue;
      }
      for (const comment of comments) {
        if (!GUTTER_VISIBLE_STATUSES.includes(comment.status)) {
          continue;
        }
        const target = this.entryForComment(sessionId, comment.filePath);
        if (target === undefined) {
          continue;
        }
        this.materializeThread(target, comment);
      }
    }
  }

  /**
   * Finds the registered file (of this session) whose anchor the comment's
   * filePath matches — qualified `<repo>:<path>` or legacy plain path.
   */
  private entryForComment(sessionId: string, filePath: string): RegistryEntry | undefined {
    for (const entry of this.merged.values()) {
      if (entry.sessionId === sessionId && anchorMatchesFile(filePath, entry.repo, entry.relativePath)) {
        return entry;
      }
    }
    return undefined;
  }

  /** Builds one read-only gutter thread for a stored comment. */
  private materializeThread(
    entry: RegistryEntry,
    comment: { commentId: string; startLine: number; endLine: number; body: string; author: string; status: string }
  ): void {
    const { startLine0, endLine0 } = storedLinesToRange(comment.startLine, comment.endLine);
    const range = new vscode.Range(startLine0, 0, endLine0, 0);
    const thread = this.controller.createCommentThread(vscode.Uri.file(entry.absolutePath), range, [
      this.buildComment(comment)
    ]);
    thread.label = comment.status;
    thread.contextValue = "drydock.taskReview";
    thread.canReply = false;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    this.threads.push(thread);
  }

  private buildComment(comment: { commentId: string; body: string; author: string }): vscode.Comment {
    return {
      body: comment.body,
      mode: vscode.CommentMode.Preview,
      author: { name: comment.author },
      // Stash the commentId so resolveThread can find it back off the thread.
      contextValue: comment.commentId
    };
  }

  // MARK: Gutter creation / resolve flows

  /**
   * Gutter "+" reply → a new stored comment. VS Code has already created an
   * empty placeholder thread on the reply; we look its file up in the registry,
   * write the comment to the owning session, drop the placeholder, and refresh
   * so the materialized (read-only) thread takes its place.
   */
  async addFromReply(reply: vscode.CommentReply): Promise<void> {
    const entry = this.merged.get(normalizePathKey(reply.thread.uri.fsPath));
    if (entry === undefined) {
      void vscode.window.showErrorMessage("This file is not part of an open task review.");
      reply.thread.dispose();
      return;
    }
    const range = reply.thread.range ?? new vscode.Range(0, 0, 0, 0);
    const { startLine, endLine } = rangeToStoredLines(range.start.line, range.end.line);
    try {
      await this.options.workspaceReview.addComment({
        sessionId: entry.sessionId,
        filePath: commentAnchor(entry.repo, entry.relativePath),
        startLine,
        endLine,
        body: reply.text
      });
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      reply.thread.dispose();
      return;
    }
    reply.thread.dispose();
    await this.refresh();
    this.options.onCommentsChanged(entry.sessionId);
  }

  /**
   * Gutter resolve action → flip the stored comment to `resolved` (which drops
   * it from the gutter, since resolved is terminal). The commentId is read back
   * from the first comment's contextValue stash; the owning session comes from
   * the registry entry for the thread's file. The store refuses invalid
   * transitions — surface the error, do not swallow it.
   */
  async resolveThread(thread: vscode.CommentThread): Promise<void> {
    const commentId = thread.comments[0]?.contextValue;
    if (commentId === undefined || commentId === "") {
      void vscode.window.showErrorMessage("This review comment cannot be resolved (missing identity).");
      return;
    }
    const entry = this.merged.get(normalizePathKey(thread.uri.fsPath));
    if (entry === undefined) {
      void vscode.window.showErrorMessage("This file is not part of an open task review.");
      return;
    }
    try {
      await this.options.workspaceReview.setCommentStatus(commentId, "resolved");
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      return;
    }
    await this.refresh();
    this.options.onCommentsChanged(entry.sessionId);
  }

  // MARK: Provider + lifecycle

  /**
   * Full-document commenting range for a registered right-side file, otherwise
   * none. Only `file`-scheme docs qualify, which excludes the read-only
   * `drydock-baseline` left pane by construction.
   */
  private commentingRangesFor(document: vscode.TextDocument): vscode.Range[] {
    if (document.uri.scheme !== "file") {
      return [];
    }
    if (!this.merged.has(normalizePathKey(document.uri.fsPath))) {
      return [];
    }
    return [new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0)];
  }

  /** Rebuilds the merged lookup from the per-task sets (last writer wins on a shared path). */
  private rebuildMerged(): void {
    this.merged.clear();
    for (const byPath of this.perTask.values()) {
      for (const [key, entry] of byPath) {
        this.merged.set(key, entry);
      }
    }
  }

  private disposeThreads(): void {
    for (const thread of this.threads) {
      thread.dispose();
    }
    this.threads = [];
  }

  dispose(): void {
    this.disposeThreads();
    this.controller.dispose();
  }
}
