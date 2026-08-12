/**
 * Chat rail webview view host.
 *
 * The home for the chat since the Control Panel retired (ADR 0020): its own
 * activity-bar view, so the conversation lives beside the editor instead of
 * inside a tab strip. The view owns no protocol of its own - it attaches to
 * `ControlPanelProvider.attachWebview`, so requests are dispatched by the one
 * handler that serves every host (responses come back here, pushes broadcast to
 * all) and no host can drift from another. It is also the host that reports its
 * own visibility, which is what suppresses the attention toast for a session
 * the user is already looking at.
 *
 * Placement: the first time this view ever resolves, Drydock makes one
 * best-effort attempt to move it into the Secondary Side Bar. The move command
 * is internal VS Code API, so every step is guarded and the attempt is recorded
 * in `app_state` BEFORE it runs - it happens at most once per state root, never
 * again, and a user's own drag always wins. If the move is unavailable the user
 * gets a single non-modal hint instead.
 */

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { Logger } from "@drydock/core";
import type { Backend } from "../compositionRoot.js";
import type { ControlPanelProvider } from "./controlPanelProvider.js";

/** `app_state` key: the one-time secondary-sidebar placement attempt. */
const PLACEMENT_FLAG_KEY = "chatRail.placementAttempted";

/**
 * Internal move-view commands, newest name first. None of these are public
 * API; whichever the running VS Code registers is used, and none being present
 * is a normal outcome that falls through to the hint.
 */
const MOVE_COMMANDS = [
  "workbench.action.moveViewToSecondarySideBar",
  "workbench.action.moveFocusedViewToSecondarySideBar",
  "workbench.action.moveFocusedViewToSidePanel"
] as const;

const PLACEMENT_HINT =
  "Drydock chat fits best beside your editor — drag the ⚓ chat view to the right sidebar to keep it there.";

export class ChatRailViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "drydock.chatRail";

  private view: vscode.WebviewView | undefined;
  /** Detaches this webview from the control panel's dispatch on disposal. */
  private attachment: { dispose(): void } | undefined;
  /** Guards the placement attempt against a same-session re-resolve (the move re-creates the view). */
  private placementRunning = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controlPanel: ControlPanelProvider,
    private readonly backend: Backend,
    private readonly logger: Logger
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")]
    };
    view.webview.html = this.renderHtml(view.webview);
    // One attachment per live webview: the previous one is dead the moment the
    // view is re-resolved (moved, reloaded), so drop it before attaching.
    this.attachment?.dispose();
    // The rail reports its own visibility: it is the surface that already shows
    // a waiting session, so a visible rail suppresses the redundant toast.
    this.attachment = this.controlPanel.attachWebview(view.webview, () => view.visible);
    view.onDidDispose(() => {
      this.attachment?.dispose();
      this.attachment = undefined;
      if (this.view === view) this.view = undefined;
    });
    void this.attemptFirstPlacement();
  }

  /**
   * Navigation seam for `panel.showSession` routing: reveals the rail. Focus is
   * best-effort - the caller's push is what carries the session.
   */
  reveal(): void {
    void vscode.commands
      .executeCommand(`${ChatRailViewProvider.viewType}.focus`)
      .then(undefined, () => undefined);
  }

  /** True once the rail has resolved at least once in this window. */
  get exists(): boolean {
    return this.view !== undefined;
  }

  dispose(): void {
    this.attachment?.dispose();
    this.attachment = undefined;
    this.view = undefined;
  }

  /**
   * First resolve ever (per state root): try the secondary-sidebar move once,
   * else hint once. Never throws, never retries. The flag is written before the
   * attempt so a move that re-creates the view - or a crash mid-command - can
   * neither loop nor repeat on a later activation.
   */
  private async attemptFirstPlacement(): Promise<void> {
    if (this.placementRunning) return;
    // No backend means no durable flag; attempting without one would repeat the
    // move on every activation, which is worse than skipping it.
    if (!this.backend.available) return;
    this.placementRunning = true;
    try {
      if (this.backend.appState.getAppState(PLACEMENT_FLAG_KEY) !== null) return;
      this.backend.appState.setAppState(PLACEMENT_FLAG_KEY, new Date().toISOString());
      const moved = await this.moveToSecondarySideBar();
      if (!moved) {
        void vscode.window.showInformationMessage(PLACEMENT_HINT);
      }
    } catch (error) {
      // Placement is cosmetic: a failure here must never affect the view.
      this.logger.warn("chat rail placement attempt failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.placementRunning = false;
    }
  }

  /**
   * Focus the rail (the move commands act on the focused view), then run the
   * first move command this VS Code actually registers. Returns false when
   * nothing usable exists or any step fails.
   */
  private async moveToSecondarySideBar(): Promise<boolean> {
    try {
      await vscode.commands.executeCommand(`${ChatRailViewProvider.viewType}.focus`);
    } catch {
      return false;
    }
    let registered: readonly string[];
    try {
      registered = await vscode.commands.getCommands(true);
    } catch {
      return false;
    }
    const available = new Set(registered);
    for (const command of MOVE_COMMANDS) {
      if (!available.has(command)) continue;
      try {
        await vscode.commands.executeCommand(command);
        return true;
      } catch {
        // Try the next variant; a registered command can still refuse.
      }
    }
    return false;
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("hex");
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "chatRail.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "chatRail.css"));
    const mermaidUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "planDocsMermaid.js"));
    // The transcript's mermaid diagrams inject scoped inline SVG styles, so
    // this page allows inline STYLE only. Scripts still require the nonce; model output is textContent-only
    // except adopted, sanitized SVG.
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri.toString()}">
  <title>Drydock Chat</title>
</head>
<body>
  <div id="app" data-nonce="${nonce}" data-mermaid-src="${mermaidUri.toString()}"></div>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}
