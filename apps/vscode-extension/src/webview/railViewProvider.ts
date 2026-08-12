/**
 * Left-rail view host (UX overhaul, P1).
 *
 * Three thin sidebar views - Tasks, Recents, Workspaces - sharing ONE webview
 * bundle (`rail.js`, switched by `body[data-view]`) and ONE message bridge:
 * each resolved view attaches to `ControlPanelProvider`, so every request runs
 * through the same parsePanelRequest gate and dispatch the control panel
 * already owns, and every push reaches the rail unchanged. No new protocol, no
 * duplicated handlers.
 *
 * The Tasks instance also carries the native badge: failed + awaiting sessions,
 * folded from the same bus events the panel's attention bookkeeping reads.
 */

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { Logger, ProductBusEvent } from "@drydock/core";
import type { Backend } from "../compositionRoot.js";
import type { ControlPanelProvider } from "./controlPanelProvider.js";

export type RailViewKind = "tasks" | "recents" | "workspaces";

export const RAIL_VIEW_TYPES: Readonly<Record<RailViewKind, string>> = {
  tasks: "drydock.tasks",
  recents: "drydock.recents",
  workspaces: "drydock.workspaces"
};

export class RailViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private attached: { dispose(): void } | undefined;
  /**
   * Sessions waiting on the user, folded from the bus (question asked/resolved,
   * access requested/resolved, failed turns). The Tasks view publishes the size
   * as its native badge; the other two views ignore it.
   */
  private readonly waiting = new Map<string, Set<string>>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controlPanel: ControlPanelProvider,
    private readonly kind: RailViewKind,
    backend?: Backend,
    private readonly logger?: Logger
  ) {
    if (kind === "tasks" && backend?.available === true) {
      // The subscription lives for the extension lifetime; the badge write is
      // a no-op while the view has not resolved.
      backend.bus.subscribe((event) => {
        this.onBusEvent(event);
      });
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")]
    };
    view.webview.html = this.renderHtml(view.webview);
    // One dispatch, many hosts: the rail's requests and the sidebar panel's
    // run through the same handler, and pushes broadcast to both.
    this.attached = this.controlPanel.attachWebview(view.webview);
    this.applyBadge();
    view.onDidDispose(() => {
      this.attached?.dispose();
      this.attached = undefined;
      if (this.view === view) this.view = undefined;
    });
  }

  dispose(): void {
    this.attached?.dispose();
    this.attached = undefined;
  }

  private onBusEvent(event: ProductBusEvent): void {
    switch (event.kind) {
      case "question-asked":
        this.flag(event.question.sessionId, "question");
        return;
      case "question-resolved":
        this.clear(event.question.sessionId, "question");
        return;
      case "access-requested":
        this.flag(event.request.sessionId, "access");
        return;
      case "access-resolved":
        this.clear(event.request.sessionId, "access");
        return;
      case "turn-completed":
        // A failed turn waits on the user; a clean one clears that flag only.
        if (event.status === "failed") this.flag(event.sessionId, "failed-turn");
        else this.clear(event.sessionId, "failed-turn");
        return;
      case "turn-started":
        this.clear(event.sessionId, "failed-turn");
        return;
      case "session-deleted":
        if (this.waiting.delete(event.sessionId)) this.applyBadge();
        return;
      default:
        return;
    }
  }

  private flag(sessionId: string, reason: string): void {
    const reasons = this.waiting.get(sessionId) ?? new Set<string>();
    if (reasons.has(reason)) return;
    reasons.add(reason);
    this.waiting.set(sessionId, reasons);
    this.applyBadge();
  }

  private clear(sessionId: string, reason: string): void {
    const reasons = this.waiting.get(sessionId);
    if (reasons === undefined || !reasons.delete(reason)) return;
    if (reasons.size === 0) this.waiting.delete(sessionId);
    this.applyBadge();
  }

  /** Native view badge = sessions that need the user (failed + awaiting). */
  private applyBadge(): void {
    if (this.kind !== "tasks" || this.view === undefined) return;
    const value = this.waiting.size;
    try {
      this.view.badge = value === 0
        ? undefined
        : { value, tooltip: `${String(value)} chat${value === 1 ? "" : "s"} need you` };
    } catch (error) {
      // WebviewView.badge is proposed-adjacent on some builds; a failure here
      // must never take the rail down.
      this.logger?.warn("rail badge update failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("hex");
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "rail.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "rail.css"));
    // Strict CSP, matching the editor panels exactly: no remote content,
    // scripts only with this nonce, styles only from the extension, no
    // 'unsafe-inline' anywhere. `data-view` is a closed enum, never free text.
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri.toString()}">
  <title>Drydock</title>
</head>
<body data-view="${this.kind}">
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}
