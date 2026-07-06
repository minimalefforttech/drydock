/**
 * Plan-docs editor panel host (chat-panel redesign, Phase 2 — plan mode v2).
 *
 * One editor-area WebviewPanel per chat session, same trust boundary as the
 * control panel: parsePanelRequest gates every inbound message, the CSP mirrors
 * the control panel exactly, and the webview only sees display-safe
 * projections. This is the thin D2 skeleton — D3 replaces the rendering.
 *
 * The panel serves the collected plan documents (planDocs.state), routes block
 * comments through the same WorkspaceReviewAppService the control panel uses
 * (comments arrive with filePath "plan:<docName>", startLine as the block
 * anchor), and sends the reviewer's comments back as a revision turn
 * (planDocs.sendComments), sharing the compose helper with the control panel.
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
import type { IsolatedRunService } from "../services/isolatedRunService.js";
import type { WorkspaceReviewAppService } from "../services/workspaceReviewAppService.js";
import { composePlanDocsSend, toPlanDocDetail, toPlanDocSummary } from "./planDocsShared.js";

export class PlanDocsPanelProvider {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly sequences = new Map<string, number>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly backend: Backend,
    private readonly logger: Logger
  ) {
    if (backend.available) {
      // Forward collection events to the matching session's open panel as the
      // summaries-only planDocs.updated push.
      backend.bus.subscribe((event) => {
        if (event.kind === "plan-docs-updated") {
          this.push(event.sessionId, {
            type: "planDocs.updated",
            sessionId: event.sessionId,
            docs: event.docs.map(toPlanDocSummary)
          });
        }
      });
    }
  }

  async open(sessionId: string, title: string): Promise<void> {
    const existing = this.panels.get(sessionId);
    if (existing !== undefined) {
      existing.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "drydock.planDocs",
      `Plan documents: ${title}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")]
      }
    );
    this.panels.set(sessionId, panel);
    this.sequences.set(sessionId, 0);
    panel.webview.html = this.renderHtml(panel.webview, sessionId);
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      void this.onMessage(sessionId, raw);
    });
    panel.onDidDispose(() => {
      this.panels.delete(sessionId);
      this.sequences.delete(sessionId);
    });
  }

  private requireBackend(): Extract<Backend, { available: true }> {
    if (!this.backend.available) {
      throw new Error(this.backend.reason);
    }
    return this.backend;
  }

  private async onMessage(sessionId: string, raw: unknown): Promise<void> {
    const request = parsePanelRequest(raw);
    if (!request) {
      this.logger.warn("plan docs panel dropped a malformed webview message");
      return;
    }
    try {
      await this.handleRequest(sessionId, request);
    } catch (error) {
      this.respondError(sessionId, request.requestId, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleRequest(sessionId: string, request: PanelRequest): Promise<void> {
    const backend = this.requireBackend();
    const workspaceReview: WorkspaceReviewAppService = backend.workspaceReview;
    const appService: IsolatedRunService = backend.appService;
    const payload = request.payload;
    switch (payload.type) {
      case "planDocs.state": {
        const docs = await backend.planDocs.listDocs(payload.sessionId);
        this.respond(sessionId, request.requestId, { type: "planDocs.state", sessionId: payload.sessionId, docs: docs.map(toPlanDocDetail) });
        return;
      }
      case "review.state": {
        // Plan-doc comments live in the session's review scope; block comments
        // arrive with filePath "plan:<docName>".
        const state = await workspaceReview.reviewState(payload.sessionId ?? sessionId);
        this.respond(sessionId, request.requestId, { type: "review.state", reviewSessionId: state.reviewSessionId, comments: state.comments });
        return;
      }
      case "review.addComment": {
        const comment = await workspaceReview.addComment({ ...payload, sessionId: payload.sessionId ?? sessionId });
        this.respond(sessionId, request.requestId, { type: "review.addComment", comment });
        return;
      }
      case "review.setCommentStatus": {
        const comment = await workspaceReview.setCommentStatus(payload.commentId, payload.status);
        this.respond(sessionId, request.requestId, { type: "review.setCommentStatus", comment });
        return;
      }
      case "planDocs.sendComments": {
        // Same compose+guard as the control panel (shared helper); nothing open
        // → accepted no-op, otherwise run the composed prompt detached.
        const send = await composePlanDocsSend(backend, appService, payload.sessionId);
        this.respond(sessionId, request.requestId, { type: "planDocs.sendComments", accepted: true, sentCount: send.sentCount });
        if (send.prompt !== undefined) {
          void appService.sendChatTurn(payload.sessionId, send.prompt).catch((error: unknown) => {
            this.logger.error("plan docs comment turn failed to run", {
              sessionId: payload.sessionId,
              error: error instanceof Error ? error.message : String(error)
            });
          });
        }
        return;
      }
      default:
        this.respondError(sessionId, request.requestId, `Request ${payload.type} is not supported by the plan docs panel.`);
    }
  }

  private respond(sessionId: string, requestId: string, payload: PanelResponsePayload): void {
    this.post(sessionId, { protocolVersion: WEBVIEW_PROTOCOL_VERSION, kind: "response", requestId, ok: true, payload });
  }

  private respondError(sessionId: string, requestId: string, message: string): void {
    this.post(sessionId, { protocolVersion: WEBVIEW_PROTOCOL_VERSION, kind: "response", requestId, ok: false, error: { message } });
  }

  private push(sessionId: string, payload: PanelPushPayload): void {
    if (!this.panels.has(sessionId)) return;
    const sequence = (this.sequences.get(sessionId) ?? 0) + 1;
    this.sequences.set(sessionId, sequence);
    this.post(sessionId, { protocolVersion: WEBVIEW_PROTOCOL_VERSION, kind: "push", sequence, payload });
  }

  private post(sessionId: string, message: HostToWebviewMessage): void {
    void this.panels.get(sessionId)?.webview.postMessage(message);
  }

  private renderHtml(webview: vscode.Webview, sessionId: string): string {
    const nonce = randomBytes(16).toString("hex");
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "planDocs.js"));
    const mermaidUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "planDocsMermaid.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "planDocs.css"));
    // CSP deviation, THIS PANEL ONLY (owner-approved 2026-07-04): mermaid's
    // render path injects <style> nodes with no nonce API, so style-src needs
    // 'unsafe-inline' here. Styles are not executable; the input-side
    // mitigations live in the webview (securityLevel strict, htmlLabels off,
    // init-directive stripping, sanitized SVG adoption). Every other webview
    // keeps the strict CSP. The mermaid bundle URI + nonce travel as data
    // attributes so the script is injected lazily, only when a diagram exists.
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri.toString()}">
  <title>Plan documents</title>
</head>
<body>
  <div id="app" data-session-id="${safeSessionId}" data-nonce="${nonce}" data-mermaid-src="${mermaidUri.toString()}"></div>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}
