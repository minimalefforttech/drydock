/**
 * Agents editor panel host (ADR 0013) — the fleet view.
 *
 * A SINGLE editor-area WebviewPanel over every session across every task:
 * what each agent is doing now, its delegated subagents, and who is waiting
 * on the user. Same trust boundary as the other panels — parsePanelRequest
 * gates every inbound message, the CSP is the strict task-review CSP (no
 * `unsafe-inline` anywhere), and the webview only sees display-safe
 * projections. Projection only: no new storage, no polling.
 *
 * Data plane (hybrid): the webview fetches `agents.state` once, then folds
 * hot pushes in place (`session.agentActivity`, `chat.turnStarted`/
 * `chat.turnCompleted`, `session.updated`/`deleted`) while structural bus
 * events (`board-changed`, question/access asked+resolved, turn boundaries)
 * collapse into one debounced coarse `agents.changed` refetch — the board's
 * self-healing shape, so a missed push never accumulates drift.
 *
 * Subagent rows are folded from the same bus agent-events through the same
 * contracts projection (`agentActivitySummaryOfTree`) the sidebar ⑂ chips
 * use, so the two surfaces cannot disagree.
 */

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import {
  agentActivitySummaryOfTree,
  cardDetailLevel,
  parsePanelRequest,
  reduceAgentTree,
  treeSourceFromEvent,
  WEBVIEW_PROTOCOL_VERSION,
  type AgentActivitySummary,
  type AgentTreeSource,
  type ChatSessionRecord,
  type ChatSessionSummary,
  type HostToWebviewMessage,
  type PanelPushPayload,
  type PanelRequest,
  type PanelResponsePayload
} from "@drydock/contracts";
import type { Logger, ProductBusEvent } from "@drydock/core";
import type { Backend, BackendReady } from "../compositionRoot.js";
import { buildAgentsOverview } from "../services/agentsOverviewAppService.js";
import { buildBoardState } from "./boardShared.js";
import { isSessionRunningElsewhere, toAgentQuestionSummary, toChatSessionSummary } from "./controlPanelProvider.js";

export class AgentsPanelProvider {
  /** Single instance: at most one fleet panel per window. */
  private panel: vscode.WebviewPanel | undefined;
  private sequence = 0;
  /** A cross-panel handoff waits for agents.state so the tour can target rendered rows. */
  private pendingStartGuide = false;
  /** Collapses structural bus bursts (a cascade of task/question churn) into one refetch push. */
  private changedDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  /** Coalesces noisy agent-event streams into at most one projection per session per frame-sized window. */
  private readonly activityPushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Live subagent sources per session, folded from this host's bus
   * agent-events — the same fold the control panel keeps. Sessions running in
   * another window stream nothing here (read-only posture, ADR 0008).
   */
  private readonly agentActivity = new Map<string, { sources: AgentTreeSource[] }>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly backend: Backend,
    private readonly logger: Logger,
    /** Sidebar navigation seam: ControlPanelProvider.showSession. */
    private readonly navigateToSession: (sessionId: string, nodeId?: string) => void
  ) {
    if (backend.available) {
      // The subscription lives for the extension lifetime. Sources still
      // accumulate while the panel is closed so opening mid-turn is complete,
      // but the expensive tree reduction only runs for a visible panel.
      backend.bus.subscribe((event) => {
        this.onBusEvent(event);
      });
    }
  }

  private onBusEvent(event: ProductBusEvent): void {
    switch (event.kind) {
      case "agent-event": {
        const entry = this.agentActivity.get(event.sessionId) ?? { sources: [] };
        entry.sources.push(treeSourceFromEvent(event.event));
        this.agentActivity.set(event.sessionId, entry);
        this.pushAgentActivity(event.sessionId);
        return;
      }
      case "turn-started":
        // Fresh turn, fresh subagent rows (mirrors the sidebar's reset).
        if (this.agentActivity.delete(event.sessionId)) {
          this.pushAgentActivity(event.sessionId);
        }
        this.push({ type: "chat.turnStarted", sessionId: event.sessionId, runId: event.runId });
        return;
      case "turn-completed":
        this.push({ type: "chat.turnCompleted", sessionId: event.sessionId, runId: event.runId, status: event.status });
        // lastWorkedAt/attention rollups shift at turn boundaries; coarse heal.
        this.scheduleChanged();
        return;
      case "session-updated":
        if (this.backend.available) {
          this.push({ type: "session.updated", session: this.decorateSession(this.backend, event.session) });
        }
        return;
      case "session-deleted":
        this.agentActivity.delete(event.sessionId);
        this.clearActivityPush(event.sessionId);
        this.push({ type: "session.deleted", sessionId: event.sessionId });
        return;
      case "board-changed":
      case "question-asked":
      case "question-resolved":
      case "access-requested":
      case "access-resolved":
        // Task/link mutations and the "waiting on you" sets: the webview
        // refetches agents.state off one debounced push.
        this.scheduleChanged();
        return;
      default:
        return;
    }
  }

  /** Debounced agents.changed: cascades fire many bus events back-to-back. */
  private scheduleChanged(): void {
    if (this.panel === undefined) return;
    if (this.changedDebounceTimer !== undefined) return;
    this.changedDebounceTimer = setTimeout(() => {
      this.changedDebounceTimer = undefined;
      this.push({ type: "agents.changed" });
    }, 200);
  }

  private pushAgentActivity(sessionId: string): void {
    if (this.panel === undefined || this.activityPushTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.activityPushTimers.delete(sessionId);
      if (this.panel === undefined) return;
      this.push({ type: "session.agentActivity", sessionId, activity: this.activitySummary(sessionId) });
    }, 50);
    this.activityPushTimers.set(sessionId, timer);
  }

  private clearActivityPush(sessionId: string): void {
    const timer = this.activityPushTimers.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.activityPushTimers.delete(sessionId);
  }

  private activitySummary(sessionId: string): AgentActivitySummary {
    const entry = this.agentActivity.get(sessionId);
    if (entry === undefined) return { running: 0, failed: 0 };
    return agentActivitySummaryOfTree(reduceAgentTree(entry.sources));
  }

  /**
   * The sidebar's decoration (live + runningElsewhere via the shared
   * predicates) plus this host's folded activity. Unlike the sidebar chip
   * path, completed-only agent sets are still attached — the fleet renders
   * what already ran this turn, not just what is running.
   */
  private decorateSession(backend: BackendReady, record: ChatSessionRecord): ChatSessionSummary {
    const live = backend.appService.isChatSessionLive(record.sessionId);
    const summary = { ...toChatSessionSummary(record, isSessionRunningElsewhere(backend.appService, record)), live };
    const activity = this.activitySummary(record.sessionId);
    return activity.agents === undefined && activity.root === undefined
      ? summary
      : { ...summary, agentActivity: activity };
  }

  async open(startGuide = false): Promise<void> {
    if (this.panel !== undefined) {
      this.panel.reveal(vscode.ViewColumn.Active);
      if (startGuide) this.push({ type: "help.startTour" });
      return;
    }
    this.pendingStartGuide = startGuide;
    const panel = vscode.window.createWebviewPanel(
      "drydock.agents",
      "Drydock: Agents",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")]
      }
    );
    this.panel = panel;
    this.sequence = 0;
    panel.webview.html = this.renderHtml(panel.webview, startGuide);
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      void this.onMessage(raw);
    });
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.pendingStartGuide = false;
      if (this.changedDebounceTimer !== undefined) {
        clearTimeout(this.changedDebounceTimer);
        this.changedDebounceTimer = undefined;
      }
      for (const timer of this.activityPushTimers.values()) clearTimeout(timer);
      this.activityPushTimers.clear();
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
      this.logger.warn("agents panel dropped a malformed webview message");
      return;
    }
    try {
      await this.handleRequest(request);
    } catch (error) {
      this.respondError(request.requestId, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleRequest(request: PanelRequest): Promise<void> {
    const payload = request.payload;
    if (payload.type === "agents.openSession") {
      this.navigateToSession(payload.sessionId, payload.nodeId);
      this.respond(request.requestId, { type: "agents.openSession", accepted: true });
      return;
    }
    if (payload.type === "taskBoard.open") {
      if (payload.startGuide !== true) this.requireBackend();
      await vscode.commands.executeCommand("drydock.taskBoard.open", { startGuide: payload.startGuide === true });
      this.respond(request.requestId, { type: "taskBoard.open", accepted: true });
      return;
    }
    if (payload.type === "planner.open") {
      if (payload.startGuide !== true) this.requireBackend();
      await vscode.commands.executeCommand("drydock.planner.open", payload.planId, { startGuide: payload.startGuide === true });
      this.respond(request.requestId, { type: "planner.open", accepted: true });
      return;
    }
    if (payload.type === "taskReview.open") {
      if (payload.startGuide !== true) this.requireBackend();
      await vscode.commands.executeCommand("drydock.taskReview.open", payload.taskId, { startGuide: payload.startGuide === true });
      this.respond(request.requestId, { type: "taskReview.open", accepted: true });
      return;
    }
    const backend = this.requireBackend();
    switch (payload.type) {
      case "agents.state": {
        // listTaskSummaries() deliberately omits subtasks. Landing needs the
        // shared board projection so task/subtask titles match every other
        // surface instead of falling back to opaque ids.
        const boardState = await buildBoardState(backend, this.logger);
        const state = await buildAgentsOverview({
          listSessions: () => backend.appService.listChatSessions(),
          listTaskSummaries: () => Promise.resolve(boardState.tasks),
          listColumns: () => Promise.resolve(boardState.columns),
          listPendingQuestions: async () =>
            (await backend.questions.listQuestions("pending")).map(toAgentQuestionSummary),
          listPendingAccessRequests: () => backend.workspaceReview.listPendingAccessRequests(),
          decorateSession: (record) => this.decorateSession(backend, record),
          listUnlandedChangesets: () => backend.changesets.listUnlanded(),
          now: () => new Date().toISOString(),
          agentIdleThresholdMs: () => this.agentIdleThresholdMs()
        });
        this.respond(request.requestId, { type: "agents.state", state });
        if (this.pendingStartGuide) {
          this.pendingStartGuide = false;
          this.push({ type: "help.startTour" });
        }
        return;
      }
      case "chat.cancelTurn": {
        // The existing per-session cancel; the webview only offers it on
        // locally-live rows (running-elsewhere rows render no controls).
        await backend.appService.cancelChatTurn(payload.sessionId);
        this.respond(request.requestId, { type: "chat.cancelTurn", accepted: true });
        return;
      }
      case "agents.landSession": {
        // Landing (ADR 0014): the SAME full pull as the Changes tray — clone
        // work into the local working tree, then bookkeeping marks the
        // session's changesets landed. Refusals (mid-turn, clone state lost
        // with the window) surface verbatim via the error-response path.
        const result = await backend.appService.clonePull(payload.sessionId);
        try {
          await backend.changesets.markLandedBySession(payload.sessionId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn("landing bookkeeping failed", {
            sessionId: payload.sessionId,
            error: message
          });
          throw new Error(`Clone work was pulled, but Landing bookkeeping failed: ${message}`);
        }
        this.respond(request.requestId, { type: "agents.landSession", message: result.message });
        return;
      }
      default:
        this.respondError(request.requestId, `Request ${payload.type} is not supported by the agents panel.`);
    }
  }

  private agentIdleThresholdMs(): number {
    const minutes = vscode.workspace.getConfiguration("drydock").get<number>("agentIdleThresholdMinutes", 5);
    const safeMinutes = Number.isFinite(minutes) ? Math.max(1, Math.min(120, minutes)) : 5;
    return safeMinutes * 60_000;
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

  private renderHtml(webview: vscode.Webview, startGuide: boolean): string {
    const nonce = randomBytes(16).toString("hex");
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "agents.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "agents.css"));
    // The density default (ADR 0013) rides in as a body data attribute —
    // sanitized to the closed enum, so no free-form setting text reaches HTML.
    const cardDetail = cardDetailLevel(vscode.workspace.getConfiguration("drydock").get("ui.cardDetail"));
    // Strict CSP, matching the task-board/task-review panels exactly: no remote
    // content, scripts only with this nonce, styles only from the extension,
    // no 'unsafe-inline' anywhere. All dynamic text renders via textContent in
    // the webview script, never as HTML.
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri.toString()}">
  <title>Drydock: Agents</title>
</head>
<body data-card-detail="${cardDetail}" data-start-guide="${startGuide ? "true" : "false"}">
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}
