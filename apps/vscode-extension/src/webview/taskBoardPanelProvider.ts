/**
 * Task Board editor panel host (task board and subtasks).
 *
 * A SINGLE editor-area WebviewPanel over the global board: all columns, all
 * tasks, all subtasks. Same trust boundary as the control panel —
 * parsePanelRequest gates every inbound message, the CSP is the strict
 * task-review CSP (no `unsafe-inline` anywhere), and the webview only sees
 * display-safe projections assembled by the shared boardShared helpers (one
 * code path with the control panel's Work tab).
 *
 * Pushes are the one coarse `board.changed` (the webview refetches
 * board.state; content never rides the push): fired on the product bus's
 * `turn-completed` (a finished run may have moved cards / changed blocked
 * states) and `board-changed` (a board/subtask mutation from any surface,
 * including the orchestrator). subtask.start/task.start route to
 * backend.orchestrator; its typed StartSubtaskError messages surface verbatim
 * through the error-response path.
 */

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import {
  cardDetailLevel,
  parsePanelRequest,
  WEBVIEW_PROTOCOL_VERSION,
  type HostToWebviewMessage,
  type PanelPushPayload,
  type PanelRequest,
  type PanelResponsePayload
} from "@drydock/contracts";
import type { Logger } from "@drydock/core";
import type { Backend, BackendReady } from "../compositionRoot.js";
import { buildBoardState, reconcileColumns, requireTaskSummary } from "./boardShared.js";
import { promptAndSaveSubtaskSeedMode } from "./subtaskSeedPrompt.js";
import { promptAndSaveTaskClonePolicy } from "./taskClonePolicyPrompt.js";

export class TaskBoardPanelProvider {
  /** Single instance: at most one board panel per window. */
  private panel: vscode.WebviewPanel | undefined;
  private sequence = 0;
  /** A cross-panel handoff waits for the boot board.state request before starting the tour. */
  private pendingStartGuide = false;
  /** Collapses bus-event bursts (a turn boundary plus its cascade) into one push. */
  private pushDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly backend: Backend,
    private readonly logger: Logger
  ) {
    if (backend.available) {
      // The subscription lives for the extension lifetime; push() is a no-op
      // while the panel is closed. turn-completed: a finished run can change
      // blocked/done projections. board-changed: any board/subtask mutation
      // (subtask service, orchestrator cascade) — both collapse into the one
      // coarse board.changed push and the webview refetches board.state.
      backend.bus.subscribe((event) => {
        if (event.kind !== "turn-completed" && event.kind !== "board-changed") {
          return;
        }
        this.schedulePush();
      });
    }
  }

  /** Debounced board.changed: cascades fire many bus events back-to-back. */
  private schedulePush(): void {
    if (this.panel === undefined) return;
    if (this.pushDebounceTimer !== undefined) return;
    this.pushDebounceTimer = setTimeout(() => {
      this.pushDebounceTimer = undefined;
      this.push({ type: "board.changed" });
    }, 200);
  }

  async open(startGuide = false): Promise<void> {
    if (this.panel !== undefined) {
      this.panel.reveal(vscode.ViewColumn.Active);
      if (startGuide) this.push({ type: "help.startTour" });
      return;
    }
    this.pendingStartGuide = startGuide;
    const panel = vscode.window.createWebviewPanel(
      "drydock.taskBoard",
      "Task Board",
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
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      void this.onMessage(raw);
    });
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.pendingStartGuide = false;
      if (this.pushDebounceTimer !== undefined) {
        clearTimeout(this.pushDebounceTimer);
        this.pushDebounceTimer = undefined;
      }
    });
  }

  private requireBackend(): BackendReady {
    if (!this.backend.available) {
      throw new Error(this.backend.reason);
    }
    return this.backend;
  }

  private async onMessage(raw: unknown): Promise<void> {
    const request = parsePanelRequest(raw);
    if (!request) {
      this.logger.warn("task board panel dropped a malformed webview message");
      return;
    }
    try {
      await this.handleRequest(request);
    } catch (error) {
      this.respondError(request.requestId, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleRequest(request: PanelRequest): Promise<void> {
    const backend = this.requireBackend();
    const payload = request.payload;
    switch (payload.type) {
      case "board.state": {
        const board = await buildBoardState(backend, this.logger);
        this.respond(request.requestId, { type: "board.state", board });
        if (this.pendingStartGuide) {
          this.pendingStartGuide = false;
          this.push({ type: "help.startTour" });
        }
        return;
      }
      case "board.moveCard": {
        if (payload.cardKind === "task") {
          await backend.tasks.updateTask(payload.id, { columnId: payload.columnId });
        } else {
          await backend.subtasks.moveCard({ subtaskId: payload.id }, payload.columnId);
        }
        const board = await buildBoardState(backend, this.logger);
        this.respond(request.requestId, { type: "board.moveCard", board });
        return;
      }
      case "board.columns.update": {
        await reconcileColumns(backend.board, payload.columns, payload.deletedColumnIds);
        const board = await buildBoardState(backend, this.logger);
        this.respond(request.requestId, { type: "board.columns.update", board });
        return;
      }
      case "task.create": {
        // Same create message the Work tab uses; the board webview refetches
        // board.state after the response, so the summary is decorated fresh.
        const record = await backend.tasks.createTask(payload.title, payload.description);
        const summary = await requireTaskSummary(backend, record.taskId);
        this.respond(request.requestId, { type: "task.create", task: summary });
        return;
      }
      case "subtask.create": {
        await backend.subtasks.createSubtask(payload.taskId, {
          title: payload.title,
          ...(payload.description === undefined ? {} : { description: payload.description }),
          ...(payload.prompt === undefined ? {} : { prompt: payload.prompt }),
          ...(payload.autoStart === undefined ? {} : { autoStart: payload.autoStart })
        });
        const summary = await requireTaskSummary(backend, payload.taskId);
        this.respond(request.requestId, { type: "subtask.create", task: summary });
        return;
      }
      case "subtask.update": {
        const existing = await backend.subtasks.getSubtask(payload.subtaskId);
        if (existing === null) {
          throw new Error(`Subtask ${payload.subtaskId} was not found.`);
        }
        const hasFieldUpdate = payload.title !== undefined || payload.description !== undefined
          || payload.prompt !== undefined || payload.autoStart !== undefined || payload.colorOverride !== undefined
          || payload.seedMode !== undefined || payload.verified !== undefined;
        if (hasFieldUpdate) {
          await backend.subtasks.updateSubtask(payload.subtaskId, {
            ...(payload.title === undefined ? {} : { title: payload.title }),
            ...(payload.description === undefined ? {} : { description: payload.description }),
            ...(payload.prompt === undefined ? {} : { prompt: payload.prompt }),
            ...(payload.autoStart === undefined ? {} : { autoStart: payload.autoStart }),
            ...(payload.colorOverride === undefined ? {} : { colorOverride: payload.colorOverride }),
            ...(payload.seedMode === undefined ? {} : { seedMode: payload.seedMode }),
            ...(payload.verified === undefined ? {} : { verified: payload.verified })
          });
        }
        if (payload.columnId !== undefined) {
          await backend.subtasks.moveCard({ subtaskId: payload.subtaskId }, payload.columnId);
        }
        const summary = await requireTaskSummary(backend, existing.taskId);
        this.respond(request.requestId, { type: "subtask.update", task: summary });
        return;
      }
      case "subtask.delete": {
        const existing = await backend.subtasks.getSubtask(payload.subtaskId);
        if (existing === null) {
          throw new Error(`Subtask ${payload.subtaskId} was not found.`);
        }
        await backend.subtasks.deleteSubtask(payload.subtaskId);
        const summary = await requireTaskSummary(backend, existing.taskId);
        this.respond(request.requestId, { type: "subtask.delete", task: summary });
        return;
      }
      case "subtask.dependency.add": {
        await backend.subtasks.addDependency(payload.fromSubtaskId, payload.toSubtaskId);
        const summary = await requireTaskSummary(backend, payload.taskId);
        this.respond(request.requestId, { type: "subtask.dependency.add", task: summary });
        return;
      }
      case "subtask.dependency.remove": {
        await backend.subtasks.removeDependency(payload.fromSubtaskId, payload.toSubtaskId);
        const summary = await requireTaskSummary(backend, payload.taskId);
        this.respond(request.requestId, { type: "subtask.dependency.remove", task: summary });
        return;
      }
      case "workspace.state": {
        // Read-only pass-through so the board can resolve workspace-set names
        // for task-card chips (same message the control panel serves).
        const state = await backend.workspaceReview.getPolicyState();
        this.respond(request.requestId, { type: "workspace.state", state });
        return;
      }
      case "subtask.start": {
        // force is the manual-only override for a BLOCKED subtask; typed
        // StartSubtaskError messages surface verbatim via the error-response path.
        const subtask = await backend.subtasks.getSubtask(payload.subtaskId);
        if (subtask === null) {
          throw new Error(`Subtask ${payload.subtaskId} was not found.`);
        }
        if (!(await promptAndSaveTaskClonePolicy(backend, subtask.taskId))) {
          this.respond(request.requestId, { type: "subtask.start", accepted: false });
          return;
        }
        // Seed choice (ADR 0014): prompts only when upstreams exist and no
        // seedMode is stored yet; the pick persists on the subtask.
        if (!(await promptAndSaveSubtaskSeedMode(backend, payload.subtaskId))) {
          this.respond(request.requestId, { type: "subtask.start", accepted: false });
          return;
        }
        await backend.orchestrator.startSubtask(payload.subtaskId, { force: payload.force === true });
        this.respond(request.requestId, { type: "subtask.start", accepted: true });
        return;
      }
      case "task.start": {
        if (!(await promptAndSaveTaskClonePolicy(backend, payload.taskId))) {
          this.respond(request.requestId, { type: "task.start", accepted: false });
          return;
        }
        await backend.orchestrator.startTask(payload.taskId);
        this.respond(request.requestId, { type: "task.start", accepted: true });
        return;
      }
      case "recipes.list": {
        const recipes = await backend.recipes.listRecipes();
        this.respond(request.requestId, { type: "recipes.list", recipes });
        return;
      }
      case "task.faq.list": {
        const faqs = await backend.tasks.listFaqs(payload.taskId);
        this.respond(request.requestId, { type: "task.faq.list", faqs });
        return;
      }
      case "task.faq.add": {
        await backend.tasks.addFaq(payload.taskId, payload.pattern, payload.answer);
        this.respond(request.requestId, { type: "task.faq.add", faqs: await backend.tasks.listFaqs(payload.taskId) });
        return;
      }
      case "task.faq.remove": {
        await backend.tasks.removeFaq(payload.taskId, payload.faqId);
        this.respond(request.requestId, { type: "task.faq.remove", faqs: await backend.tasks.listFaqs(payload.taskId) });
        return;
      }
      case "task.update": {
        // The board panel accepts the FAQ toggle only (title/description edits
        // stay on the sidebar); anything else falls through to the service's
        // own validation.
        await backend.tasks.updateTask(payload.taskId, {
          ...(payload.title === undefined ? {} : { title: payload.title }),
          ...(payload.description === undefined ? {} : { description: payload.description }),
          ...(payload.state === undefined ? {} : { state: payload.state }),
          ...(payload.autoAnswerFaq === undefined ? {} : { autoAnswerFaq: payload.autoAnswerFaq })
        });
        const summary = await requireTaskSummary(backend, payload.taskId);
        this.respond(request.requestId, { type: "task.update", task: summary });
        return;
      }
      case "task.createFromRecipe": {
        // Materializes task + subtasks + DAG with per-role defaults; never starts.
        const created = await backend.recipes.materializeTask(payload.recipeId, payload.title);
        const summary = await requireTaskSummary(backend, created.taskId);
        this.respond(request.requestId, { type: "task.createFromRecipe", task: summary });
        return;
      }
      default:
        this.respondError(request.requestId, `Request ${payload.type} is not supported by the task board panel.`);
    }
  }

  private respond(requestId: string, payload: PanelResponsePayload): void {
    this.post({ protocolVersion: WEBVIEW_PROTOCOL_VERSION, kind: "response", requestId, ok: true, payload });
  }

  private respondError(requestId: string, message: string): void {
    this.post({ protocolVersion: WEBVIEW_PROTOCOL_VERSION, kind: "response", requestId, ok: false, error: { message } });
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
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "taskBoard.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "taskBoard.css"));
    // The density default (ADR 0013) rides in as a body data attribute —
    // sanitized to the closed enum, so no free-form setting text reaches HTML.
    const cardDetail = cardDetailLevel(vscode.workspace.getConfiguration("drydock").get("ui.cardDetail"));
    // Strict CSP, matching the task-review panel exactly: no remote content,
    // scripts only with this nonce, styles only from the extension, no
    // 'unsafe-inline' anywhere. All dynamic text renders via textContent in
    // the webview script, never as HTML.
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri.toString()}">
  <title>Task Board</title>
</head>
<body data-card-detail="${cardDetail}">
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}
