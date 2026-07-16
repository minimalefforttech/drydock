/**
 * Code Review editor panel host (in-panel PR-style review —
 * docs/design/code-review-panel.md).
 *
 * One editor-area WebviewPanel per task, same trust boundary as every other
 * panel: parsePanelRequest gates every inbound message, the CSP is the strict
 * control-panel CSP (data: images allowed for host-generated diff thumbnails),
 * and the webview only sees display-safe projections. Diff content (hunk rows,
 * image data URIs, byte sizes) flows host → webview only and is rendered via
 * textContent there.
 *
 * Reuses the v1 task-review submit loop verbatim (taskReview.submit) so notes
 * added here ride the same guarded revision-turn path.
 */

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import {
  parsePanelRequest,
  WEBVIEW_PROTOCOL_VERSION,
  type HostToWebviewMessage,
  type PanelPushPayload,
  type PanelRequest,
  type PanelResponsePayload
} from "@drydock/contracts";
import type { Logger } from "@drydock/core";
import type { Backend } from "../compositionRoot.js";
import { CodeReviewAppService } from "../services/codeReviewAppService.js";
import { openBaselineDiff } from "./baselineDiff.js";

export class CodeReviewPanelProvider {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly sequences = new Map<string, number>();
  private service: CodeReviewAppService | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly backend: Backend,
    private readonly logger: Logger
  ) {
    if (backend.available) {
      backend.bus.subscribe((event) => {
        if (event.kind !== "turn-started" && event.kind !== "turn-completed" && event.kind !== "session-deleted") {
          return;
        }
        if (this.panels.size === 0) return;
        void backend.taskReview.taskIdsForSession(event.sessionId)
          .then((taskIds) => {
            for (const reviewTaskId of taskIds) {
              this.push(reviewTaskId, { type: "codeReview.updated", taskId: reviewTaskId });
            }
          })
          .catch((error: unknown) => {
            this.logger.warn("code review update fan-out failed", {
              sessionId: event.sessionId,
              error: error instanceof Error ? error.message : String(error)
            });
          });
      });
    }
  }

  private requireBackend(): Extract<Backend, { available: true }> {
    if (!this.backend.available) throw new Error(this.backend.reason);
    return this.backend;
  }

  private requireService(): CodeReviewAppService {
    const backend = this.requireBackend();
    this.service ??= new CodeReviewAppService({
      logger: this.logger,
      taskReview: backend.taskReview,
      diffs: backend.workspaceReview
    });
    return this.service;
  }

  /** Absolute fsPath roots of the window's open file-scheme folders. */
  private openFolderRoots(): string[] {
    return (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === "file")
      .map((folder) => folder.uri.fsPath);
  }

  async open(taskId: string, taskTitle: string): Promise<void> {
    const existing = this.panels.get(taskId);
    if (existing !== undefined) {
      existing.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "drydock.codeReview",
      `Drydock: Code Review: ${taskTitle}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")]
      }
    );
    this.panels.set(taskId, panel);
    this.sequences.set(taskId, 0);
    panel.webview.html = this.renderHtml(panel.webview, taskId);
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      void this.onMessage(taskId, raw);
    });
    panel.onDidDispose(() => {
      this.panels.delete(taskId);
      this.sequences.delete(taskId);
    });
    await Promise.resolve();
  }

  private async onMessage(taskId: string, raw: unknown): Promise<void> {
    const request = parsePanelRequest(raw);
    if (!request) {
      this.logger.warn("code review panel dropped a malformed webview message");
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
    const backend = this.requireBackend();
    switch (payload.type) {
      case "codeReview.state": {
        const state = await this.requireService().computeState(payload.taskId, payload.scope, this.openFolderRoots());
        this.respond(taskId, request.requestId, { type: "codeReview.state", state });
        return;
      }
      case "codeReview.fileDiff": {
        const diff = await this.requireService().fileDiff({
          scope: payload.scope,
          repo: payload.repo,
          path: payload.path,
          ...(payload.baselineId === undefined ? {} : { baselineId: payload.baselineId }),
          ...(payload.ignoreWhitespace === undefined ? {} : { ignoreWhitespace: payload.ignoreWhitespace }),
          openFolderRoots: this.openFolderRoots()
        });
        this.respond(taskId, request.requestId, { type: "codeReview.fileDiff", repo: payload.repo, path: payload.path, diff });
        return;
      }
      case "codeReview.addNote": {
        const comments = await this.requireService().addNote(payload.taskId, payload.body, payload.anchors);
        this.respond(taskId, request.requestId, { type: "codeReview.addNote", comments });
        return;
      }
      case "review.state": {
        if (payload.sessionId === undefined) {
          this.respondError(taskId, request.requestId, "A sessionId is required to read comments in the code review panel.");
          return;
        }
        const state = await backend.workspaceReview.reviewState(payload.sessionId);
        this.respond(taskId, request.requestId, { type: "review.state", reviewSessionId: state.reviewSessionId, comments: state.comments });
        return;
      }
      case "review.setCommentStatus": {
        const comment = await backend.workspaceReview.setCommentStatus(payload.commentId, payload.status);
        this.respond(taskId, request.requestId, { type: "review.setCommentStatus", comment });
        return;
      }
      case "taskReview.submit": {
        const { dispatched, sessions, sentSessions, errors } = await backend.taskReview.submitReview(payload.taskId, {
          resolveResumeWorkspace: async (mode) => {
            try {
              return await backend.workspaceReview.resolveWorkspaceSelection({ auto: true, mode }, this.openFolderRoots());
            } catch {
              return undefined;
            }
          }
        });
        this.respond(taskId, request.requestId, {
          type: "taskReview.submit",
          dispatched,
          sessions,
          ...(sentSessions.length === 0 ? {} : { sentSessions }),
          ...(errors.length === 0 ? {} : { errors })
        });
        return;
      }
      case "diff.openFile": {
        await openBaselineDiff(backend.workspaceReview, payload.baselineId, payload.path, vscode.ViewColumn.Beside);
        this.respond(taskId, request.requestId, { type: "diff.openFile", accepted: true });
        return;
      }
      default:
        this.respondError(taskId, request.requestId, `Request ${payload.type} is not supported by the code review panel.`);
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

  private renderHtml(webview: vscode.Webview, taskId: string): string {
    const nonce = randomBytes(16).toString("hex");
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "codeReview.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "codeReview.css"));
    const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, "");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri.toString()}">
  <title>Drydock: Code Review</title>
</head>
<body>
  <div id="app" data-task-id="${safeTaskId}"></div>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}
