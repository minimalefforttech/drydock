/**
 * Cross-project task-review editor panel host.
 *
 * One editor-area WebviewPanel per task, same trust boundary as the control
 * panel: parsePanelRequest gates every inbound message, the CSP is the strict
 * control-panel CSP (no mermaid here, so no `unsafe-inline` deviation), and the
 * webview only sees display-safe projections. The panel is a navigator + comment
 * dock; review happens in native diff editors opened Beside via the shared
 * baseline-diff flow.
 *
 * The panel serves the aggregated task-review state (taskReview.state), submits
 * the reviewer's comments back to the owning sessions as revision turns
 * (taskReview.submit, resuming a dead session with an auto workspace context),
 * and — because it spans sessions — requires an explicit sessionId on the
 * per-session review passthroughs (review.state/addComment). A linked session
 * starting or completing a turn (or a session deletion) fires the panel-scoped
 * taskReview.updated push so an open panel refetches; content never rides it.
 */

import { randomBytes } from "node:crypto";
import path from "node:path";
import * as vscode from "vscode";
import {
  parsePanelRequest,
  WEBVIEW_PROTOCOL_VERSION,
  type HostToWebviewMessage,
  type PanelPushPayload,
  type PanelRequest,
  type PanelResponsePayload,
  type TaskReviewState
} from "@drydock/contracts";
import type { Logger } from "@drydock/core";
import type { Backend } from "../compositionRoot.js";
import type { TaskReviewAppService } from "../services/taskReviewAppService.js";
import type { WorkspaceReviewAppService } from "../services/workspaceReviewAppService.js";
import { openBaselineDiff } from "./baselineDiff.js";
import type { TaskReviewCommentFile, TaskReviewCommentsController } from "./taskReviewCommentsController.js";

export class TaskReviewPanelProvider {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly sequences = new Map<string, number>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly backend: Backend,
    private readonly logger: Logger,
    // Optional so the provider stays constructible without the Comments-API
    // surface; extension.ts always passes it when the backend is available.
    private readonly comments?: TaskReviewCommentsController
  ) {
    if (backend.available) {
      // A linked session's turn boundary (or its deletion) may change any of the
      // task-review projections, so fan the event out to every open panel whose
      // task links that session as the summaries-free taskReview.updated push.
      backend.bus.subscribe((event) => {
        if (event.kind !== "turn-started" && event.kind !== "turn-completed" && event.kind !== "session-deleted") {
          return;
        }
        if (this.panels.size === 0) {
          return;
        }
        this.fanOutSessionUpdate(event.sessionId);
      });
    }
  }

  /**
   * Pushes taskReview.updated to every open panel whose task links this session.
   * Shared by the bus subscription (turn/deletion events) and the gutter
   * controller's onCommentsChanged callback (a store write from the diff editor).
   */
  private fanOutSessionUpdate(sessionId: string): void {
    if (!this.backend.available || this.panels.size === 0) {
      return;
    }
    void this.backend.taskReview.taskIdsForSession(sessionId)
      .then((taskIds) => {
        for (const taskId of taskIds) {
          this.push(taskId, { type: "taskReview.updated", taskId });
        }
      })
      .catch((error: unknown) => {
        this.logger.warn("task review update fan-out failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  /**
   * Controller → panels: a gutter-side comment create/resolve wrote to the
   * store, so open panels for the session refetch. Reuses the same fan-out the
   * bus subscription uses.
   */
  notifySessionCommentsChanged(sessionId: string): void {
    this.fanOutSessionUpdate(sessionId);
  }

  /**
   * Builds the gutter-registration list from a computed state: one entry per
   * baseline-backed file (clone files are excluded — no on-disk path is theirs).
   * The baseline root is resolved once per unique baselineId within the call;
   * files whose baseline root resolves null are skipped with a warning.
   */
  private async buildCommentFiles(
    workspaceReview: WorkspaceReviewAppService,
    state: TaskReviewState
  ): Promise<TaskReviewCommentFile[]> {
    const rootCache = new Map<string, string | null>();
    const entries: TaskReviewCommentFile[] = [];
    for (const project of state.projects) {
      for (const file of project.files) {
        if (file.baselineId === undefined) {
          continue; // Clone file: informational only, never gutter-commentable.
        }
        let root = rootCache.get(file.baselineId);
        if (root === undefined) {
          root = await workspaceReview.baselineRootPath(file.baselineId);
          rootCache.set(file.baselineId, root);
        }
        if (root === null) {
          this.logger.warn("task review comment registration skipped a file with no baseline root", {
            baselineId: file.baselineId,
            path: file.path
          });
          continue;
        }
        entries.push({
          sessionId: file.sessionId,
          repo: file.repo,
          relativePath: file.path,
          absolutePath: path.join(root, file.path)
        });
      }
    }
    return entries;
  }

  /** Fire-and-forget gutter refresh after a webview-side store mutation. */
  private refreshComments(): void {
    void this.comments?.refresh().catch((error: unknown) => {
      this.logger.warn("task review gutter refresh failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  async open(taskId: string, taskTitle: string, startGuide = false): Promise<void> {
    const existing = this.panels.get(taskId);
    if (existing !== undefined) {
      existing.reveal(vscode.ViewColumn.Active);
      if (startGuide) this.push(taskId, { type: "help.startTour" });
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "drydock.taskReview",
      `Drydock: Task Review: ${taskTitle}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")]
      }
    );
    this.panels.set(taskId, panel);
    this.sequences.set(taskId, 0);
    panel.webview.html = this.renderHtml(panel.webview, taskId, startGuide);
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      void this.onMessage(taskId, raw);
    });
    panel.onDidDispose(() => {
      this.panels.delete(taskId);
      this.sequences.delete(taskId);
      // Drop this task's gutter registrations and tear down its now-orphaned
      // threads (files still registered by another open panel survive).
      this.comments?.clearTask(taskId);
    });
  }

  private requireBackend(): Extract<Backend, { available: true }> {
    if (!this.backend.available) {
      throw new Error(this.backend.reason);
    }
    return this.backend;
  }

  /** Absolute fsPath roots of the window's open file-scheme folders (for auto resume). */
  private openFolderRoots(): string[] {
    return (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === "file")
      .map((folder) => folder.uri.fsPath);
  }

  private async onMessage(taskId: string, raw: unknown): Promise<void> {
    const request = parsePanelRequest(raw);
    if (!request) {
      this.logger.warn("task review panel dropped a malformed webview message");
      return;
    }
    try {
      await this.handleRequest(taskId, request);
    } catch (error) {
      this.respondError(taskId, request.requestId, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleRequest(taskId: string, request: PanelRequest): Promise<void> {
    const payload = request.payload;
    if (payload.type === "taskBoard.open") {
      if (payload.startGuide !== true) this.requireBackend();
      await vscode.commands.executeCommand("drydock.taskBoard.open", { startGuide: payload.startGuide === true });
      this.respond(taskId, request.requestId, { type: "taskBoard.open", accepted: true });
      return;
    }
    if (payload.type === "agents.open") {
      if (payload.startGuide !== true) this.requireBackend();
      await vscode.commands.executeCommand("drydock.agents.open", { startGuide: payload.startGuide === true });
      this.respond(taskId, request.requestId, { type: "agents.open", accepted: true });
      return;
    }
    if (payload.type === "planner.open") {
      if (payload.startGuide !== true) this.requireBackend();
      await vscode.commands.executeCommand("drydock.planner.open", payload.planId, { startGuide: payload.startGuide === true });
      this.respond(taskId, request.requestId, { type: "planner.open", accepted: true });
      return;
    }
    const backend = this.requireBackend();
    const taskReview: TaskReviewAppService = backend.taskReview;
    const workspaceReview: WorkspaceReviewAppService = backend.workspaceReview;
    switch (payload.type) {
      case "taskReview.state": {
        const state = await taskReview.computeState(payload.taskId);
        this.respond(taskId, request.requestId, { type: "taskReview.state", state });
        // Register this task's baseline-backed files for gutter commenting. The
        // state response must not block on it, so it is fire-and-forget.
        if (this.comments !== undefined) {
          const controller = this.comments;
          void this.buildCommentFiles(workspaceReview, state)
            .then((entries) => controller.setTaskFiles(payload.taskId, entries))
            .catch((error: unknown) => {
              this.logger.warn("task review comment registration failed", {
                taskId: payload.taskId,
                error: error instanceof Error ? error.message : String(error)
              });
            });
        }
        return;
      }
      case "taskReview.submit": {
        const { dispatched, sessions, sentSessions, errors } = await taskReview.submitReview(payload.taskId, {
          resolveResumeWorkspace: async (mode) => {
            // Auto-resolve the window's open folders for a resume; a mode with no
            // matching folders open is unresumable here (undefined).
            try {
              return await workspaceReview.resolveWorkspaceSelection({ auto: true, mode }, this.openFolderRoots());
            } catch {
              return undefined;
            }
          },
          onDispatchFailed: (failure) => {
            // sendChatTurn resolves at terminal, after the submit response has
            // already returned. Recovery has reopened the still-delegated
            // threads; refresh both review surfaces and tell the user that a
            // retry is available instead of silently stranding the comments.
            this.refreshComments();
            this.push(taskId, { type: "taskReview.updated", taskId });
            const recovery = failure.reopenedCount === failure.commentCount
              ? `${String(failure.reopenedCount)} comment${failure.reopenedCount === 1 ? " was" : "s were"} reopened for retry.`
              : `${String(failure.reopenedCount)} of ${String(failure.commentCount)} comments could be reopened; inspect the review before retrying.`;
            void vscode.window.showWarningMessage(
              `Review revision for "${failure.sessionTitle}" ${failure.reason}. ${recovery}`
            );
          }
        });
        this.respond(taskId, request.requestId, {
          type: "taskReview.submit",
          dispatched,
          sessions,
          ...(sentSessions.length === 0 ? {} : { sentSessions }),
          ...(errors.length === 0 ? {} : { errors })
        });
        // Submit flips delegated comments off `open`; gutter threads follow.
        this.refreshComments();
        return;
      }
      case "review.state": {
        // This panel spans sessions: there is no default session, so the comment
        // read must name one.
        if (payload.sessionId === undefined) {
          this.respondError(taskId, request.requestId, "A sessionId is required to read comments in the task review panel.");
          return;
        }
        const state = await workspaceReview.reviewState(payload.sessionId);
        this.respond(taskId, request.requestId, { type: "review.state", reviewSessionId: state.reviewSessionId, comments: state.comments });
        return;
      }
      case "review.addComment": {
        if (payload.sessionId === undefined) {
          this.respondError(taskId, request.requestId, "A sessionId is required to add a comment in the task review panel.");
          return;
        }
        const comment = await workspaceReview.addComment({ ...payload, sessionId: payload.sessionId });
        this.respond(taskId, request.requestId, { type: "review.addComment", comment });
        // A webview-side comment add must surface in the gutter too.
        this.refreshComments();
        return;
      }
      case "review.setCommentStatus": {
        const comment = await workspaceReview.setCommentStatus(payload.commentId, payload.status);
        this.respond(taskId, request.requestId, { type: "review.setCommentStatus", comment });
        // A webview-side status change (e.g. resolve) must track in the gutter too.
        this.refreshComments();
        return;
      }
      case "diff.openFile": {
        // Baseline-backed files open the native diff Beside the navigator.
        await openBaselineDiff(workspaceReview, payload.baselineId, payload.path, vscode.ViewColumn.Beside);
        this.respond(taskId, request.requestId, { type: "diff.openFile", accepted: true });
        return;
      }
      default:
        this.respondError(taskId, request.requestId, `Request ${payload.type} is not supported by the task review panel.`);
    }
  }

  private respond(taskId: string, requestId: string, payload: PanelResponsePayload): void {
    this.post(taskId, { protocolVersion: WEBVIEW_PROTOCOL_VERSION, kind: "response", requestId, ok: true, payload });
  }

  private respondError(taskId: string, requestId: string, message: string): void {
    this.post(taskId, { protocolVersion: WEBVIEW_PROTOCOL_VERSION, kind: "response", requestId, ok: false, error: { message } });
  }

  private push(taskId: string, payload: PanelPushPayload): void {
    if (!this.panels.has(taskId)) return;
    const sequence = (this.sequences.get(taskId) ?? 0) + 1;
    this.sequences.set(taskId, sequence);
    this.post(taskId, { protocolVersion: WEBVIEW_PROTOCOL_VERSION, kind: "push", sequence, payload });
  }

  private post(taskId: string, message: HostToWebviewMessage): void {
    void this.panels.get(taskId)?.webview.postMessage(message);
  }

  private renderHtml(webview: vscode.Webview, taskId: string, startGuide: boolean): string {
    const nonce = randomBytes(16).toString("hex");
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "taskReview.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "taskReview.css"));
    // Strict CSP, matching the control panel exactly: no remote content, scripts
    // only with this nonce, styles only from the extension. Model/comment text is
    // rendered via textContent in the webview script, never as HTML.
    const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, "");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri.toString()}">
  <title>Drydock: Task Review</title>
</head>
<body data-start-guide="${startGuide ? "true" : "false"}">
  <div id="app" data-task-id="${safeTaskId}"></div>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}
