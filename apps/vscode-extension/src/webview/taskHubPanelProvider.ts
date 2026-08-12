/**
 * Task Hub editor panel host (UX overhaul, P3).
 *
 * ONE editor-area WebviewPanel over whichever task the active-task spine points
 * at: attention rail, stat tiles, chats, subtasks, plans, and a collapsed
 * System card. The hub is an overview - every card summarizes and links out to
 * the surface that owns the depth (Board / Agents / Planner / Review), and
 * nothing lives here that the rail and chat surfaces cannot also reach (the
 * solo-mode guarantee).
 *
 * The panel owns NO protocol of its own. It attaches to
 * `ControlPanelProvider.attachWebview`, so `hub.state`, `active.*`,
 * `task.update`, `agents.openSession` and friends are dispatched by the one
 * handler that already serves every other host, and every push (`activeTask`,
 * `session.updated`, `board.changed`, question/access events) broadcasts here
 * unchanged. The only message this class sends itself is the `hub.back` push
 * behind the Alt+Left command - a webview-local one-step history the host
 * cannot know.
 *
 * Retarget choreography: the spine moving renames the tab; the webview slides
 * its own content and raises the transient back-chip off the same `activeTask`
 * push. The panel never re-requests state on the host's behalf.
 */

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import {
  WEBVIEW_PROTOCOL_VERSION,
  asId,
  type HostToWebviewMessage,
  type PanelPushPayload
} from "@drydock/contracts";
import type { Logger } from "@drydock/core";
import type { Backend } from "../compositionRoot.js";
import type { ControlPanelProvider } from "./controlPanelProvider.js";

/** Editor-panel viewType; also the `activeWebviewPanelId` the keybinding gates on. */
export const TASK_HUB_VIEW_TYPE = "drydock.taskHub";

export class TaskHubPanelProvider {
  /** Single instance: at most one hub per window (the spine decides its target). */
  private panel: vscode.WebviewPanel | undefined;
  /** Detaches this webview from the control panel's dispatch on disposal. */
  private attachment: { dispose(): void } | undefined;
  /** Sequence for the pushes this panel sends itself (the control panel owns its own). */
  private sequence = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controlPanel: ControlPanelProvider,
    private readonly backend: Backend,
    private readonly logger: Logger
  ) {
    if (backend.available) {
      // Lives for the extension lifetime; the retitle is a no-op while closed.
      backend.bus.subscribe((event) => {
        if (event.kind !== "active-task-changed") return;
        void this.applyTitle(event.taskId);
      });
    }
  }

  /**
   * Reveals the hub, optionally moving the spine first. Passing a taskId is the
   * navigation ("open THIS task's hub"); the retarget itself then rides the
   * `active-task-changed` push like every other surface's does.
   */
  async open(taskId?: string): Promise<void> {
    if (taskId !== undefined && this.backend.available) {
      this.backend.activeTasks.set(asId<"TaskId">(taskId));
    }
    if (this.panel !== undefined) {
      this.panel.reveal(vscode.ViewColumn.Active);
      await this.applyTitle(this.currentTaskId());
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      TASK_HUB_VIEW_TYPE,
      "⚓ Task Hub",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")]
      }
    );
    this.panel = panel;
    this.sequence = 0;
    panel.webview.html = this.renderHtml(panel.webview);
    // One dispatch, many hosts: requests and pushes are the control panel's.
    this.attachment = this.controlPanel.attachWebview(panel.webview);
    panel.onDidDispose(() => {
      this.attachment?.dispose();
      this.attachment = undefined;
      this.panel = undefined;
    });
    await this.applyTitle(this.currentTaskId());
  }

  /** True once the hub is open in this window (the back command's guard). */
  get isOpen(): boolean {
    return this.panel !== undefined;
  }

  /**
   * Alt+Left: return to the previously active task. The one-step history is the
   * webview's (it saw both spine values), so the host only asks.
   */
  back(): void {
    this.push({ type: "hub.back" });
  }

  dispose(): void {
    this.attachment?.dispose();
    this.attachment = undefined;
    this.panel?.dispose();
    this.panel = undefined;
  }

  private currentTaskId(): string | null {
    return this.backend.available ? this.backend.activeTasks.get() : null;
  }

  /**
   * Tab title follows the spine: `⚓ <task> — Task Hub`. A missing task (none
   * selected, or one deleted out from under us) falls back to the bare title
   * rather than showing a stale name.
   */
  private async applyTitle(taskId: string | null): Promise<void> {
    const panel = this.panel;
    if (panel === undefined) return;
    let title: string | undefined;
    if (taskId !== null && this.backend.available) {
      try {
        title = (await this.backend.tasks.getTask(asId<"TaskId">(taskId)))?.title;
      } catch (error) {
        this.logger.warn("task hub title lookup failed", {
          taskId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    // The panel can be disposed while the lookup is in flight.
    if (this.panel !== panel) return;
    panel.title = title === undefined ? "⚓ Task Hub" : `⚓ ${title} — Task Hub`;
  }

  private push(payload: PanelPushPayload): void {
    if (this.panel === undefined) return;
    this.sequence += 1;
    this.post({ protocolVersion: WEBVIEW_PROTOCOL_VERSION, kind: "push", sequence: this.sequence, payload });
  }

  private post(message: HostToWebviewMessage): void {
    void this.panel?.webview.postMessage(message);
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("hex");
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "taskHub.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "taskHub.css"));
    // Strict CSP, matching the task-board panel exactly: no remote content,
    // scripts only with this nonce, styles only from the extension, no
    // 'unsafe-inline' anywhere. Every dynamic string renders via textContent.
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri.toString()}">
  <title>Drydock: Task Hub</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}
