/**
 * Planner editor panel host (ADR 0012).
 *
 * A SINGLE editor-area WebviewPanel for the selected plan's files, outline,
 * artifact viewer, and plan-wide notes queue. Plan creation, selection,
 * aspects, and planning chat remain in the Drydock Plan tab in the VS Code
 * sidebar. Same trust boundary as every panel - parsePanelRequest gates every
 * inbound message and the webview only sees display-safe projections from
 * PlannerAppService.
 *
 * Pushes: the coarse `planner.changed` (debounced; the webview refetches
 * planner.state), `planner.sessionReady` (terminal result of a detached
 * session boot - boots outlive the webview request timeout), plus turn and
 * session state for the compact status shown in the panel header.
 *
 * CSP: mirrors the plan-docs panel, including its one deviation - mermaid's
 * render path injects <style> nodes with no nonce API, so style-src carries
 * 'unsafe-inline' here (owner-approved 2026-07-10 with the ADR 0012 build
 * sign-off; input-side mitigations are identical: securityLevel strict,
 * htmlLabels off, directive stripping, sanitized SVG adoption). Every other
 * webview keeps the strict CSP.
 */

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import {
  parsePanelRequest,
  WEBVIEW_PROTOCOL_VERSION,
  type HostToWebviewMessage,
  type PanelPushPayload,
  type PanelRequest,
  type PanelResponsePayload,
  type ChatSessionSummary
} from "@drydock/contracts";
import type { Logger, ProductBusEvent } from "@drydock/core";
import type { Backend, BackendReady } from "../compositionRoot.js";
import { extractSubtaskCandidates } from "../services/planMaterialize.js";
import { toChatSessionSummary } from "./controlPanelProvider.js";

export class PlannerPanelProvider {
  /** Single instance: at most one planner panel per window. */
  private panel: vscode.WebviewPanel | undefined;
  private sequence = 0;
  /** Sessions belonging to plans this panel has served; chat pushes forward only for these. */
  private readonly watchedSessions = new Set<string>();
  /**
   * A plan another surface asked us to show before the webview booted. The
   * webview always fetches planner.plans on boot; the pending navigation
   * flushes as a planner.showPlan push right after that response, so it can
   * never race a not-yet-listening document.
   */
  private pendingShowPlanId: string | null = null;
  /** A cross-panel guide handoff queued until planner.plans proves the webview is listening. */
  private pendingStartGuide = false;
  /** Last plan selection sent to the Drydock Plan tab. */
  private sidebarPlanId: string | null = null;
  /** planner.changed debounce: collection bursts collapse into one push per plan. */
  private readonly pendingChangedPlanIds = new Set<string>();
  private changedDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly backend: Backend,
    private readonly logger: Logger,
    private readonly showPlanInSidebar: (planId: string | undefined, reveal: boolean) => void
  ) {
    if (backend.available) {
      backend.bus.subscribe((event) => {
        this.onBusEvent(event);
      });
    }
  }

  private onBusEvent(event: ProductBusEvent): void {
    if (this.panel === undefined) {
      return;
    }
    switch (event.kind) {
      case "planner-changed":
        this.scheduleChanged(event.planId);
        return;
      case "planner-session-started":
        // Watch the session as soon as it exists so turn/session status reaches
        // the panel header, then report that detached boot has completed.
        this.watchedSessions.add(event.sessionId);
        this.push({ type: "planner.sessionReady", planId: event.planId, sessionId: event.sessionId, ok: true });
        return;
      case "turn-started":
        if (!this.watchedSessions.has(event.sessionId)) return;
        this.push({ type: "chat.turnStarted", sessionId: event.sessionId, runId: event.runId });
        return;
      case "turn-completed":
        if (!this.watchedSessions.has(event.sessionId)) return;
        this.push({ type: "chat.turnCompleted", sessionId: event.sessionId, runId: event.runId, status: event.status });
        return;
      case "session-updated":
        if (!this.watchedSessions.has(event.session.sessionId)) return;
        this.push({ type: "session.updated", session: this.decorateSession(event.session.sessionId, event.session) });
        return;
      default:
        return;
    }
  }

  private scheduleChanged(planId: string): void {
    this.pendingChangedPlanIds.add(planId);
    if (this.changedDebounceTimer !== undefined) return;
    this.changedDebounceTimer = setTimeout(() => {
      this.changedDebounceTimer = undefined;
      const planIds = [...this.pendingChangedPlanIds];
      this.pendingChangedPlanIds.clear();
      for (const id of planIds) {
        this.push({ type: "planner.changed", planId: id });
      }
    }, 200);
  }

  async open(planId?: string, startGuide = false): Promise<void> {
    this.showPlanInSidebar(planId, true);
    if (planId !== undefined) this.sidebarPlanId = planId;
    if (this.panel !== undefined) {
      this.panel.reveal(vscode.ViewColumn.Active);
      if (planId !== undefined) {
        this.push({ type: "planner.showPlan", planId });
      }
      if (startGuide) this.push({ type: "help.startTour" });
      return;
    }
    if (planId !== undefined) {
      this.pendingShowPlanId = planId;
    }
    this.pendingStartGuide = startGuide;
    const panel = vscode.window.createWebviewPanel(
      "drydock.planner",
      "Drydock: Planner",
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
      this.watchedSessions.clear();
      this.pendingChangedPlanIds.clear();
      this.pendingShowPlanId = null;
      this.pendingStartGuide = false;
      this.sidebarPlanId = null;
      if (this.changedDebounceTimer !== undefined) {
        clearTimeout(this.changedDebounceTimer);
        this.changedDebounceTimer = undefined;
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
      this.logger.warn("planner panel dropped a malformed webview message");
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
    if (payload.type === "taskBoard.open") {
      if (payload.startGuide !== true) this.requireBackend();
      await vscode.commands.executeCommand("drydock.taskBoard.open", { startGuide: payload.startGuide === true });
      this.respond(request.requestId, { type: "taskBoard.open", accepted: true });
      return;
    }
    if (payload.type === "agents.open") {
      if (payload.startGuide !== true) this.requireBackend();
      await vscode.commands.executeCommand("drydock.agents.open", { startGuide: payload.startGuide === true });
      this.respond(request.requestId, { type: "agents.open", accepted: true });
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
      case "planner.plans": {
        const plans = await backend.planner.listPlans();
        this.respond(request.requestId, { type: "planner.plans", plans });
        if (this.pendingShowPlanId !== null) {
          // The webview is provably alive (it just asked); deliver the
          // navigation another surface queued before the panel existed.
          this.push({ type: "planner.showPlan", planId: this.pendingShowPlanId });
          this.pendingShowPlanId = null;
        }
        if (this.pendingStartGuide) {
          this.pendingStartGuide = false;
          this.push({ type: "help.startTour" });
        }
        return;
      }
      case "planner.state": {
        const state = await backend.planner.getPlanState(payload.planId);
        if (this.sidebarPlanId !== payload.planId) {
          this.sidebarPlanId = payload.planId;
          this.showPlanInSidebar(payload.planId, false);
        }
        const session = await this.sessionSummaryFor(backend, state.plan.sessionId);
        if (state.plan.sessionId !== null) {
          this.watchedSessions.add(state.plan.sessionId);
        }
        this.respond(request.requestId, { type: "planner.state", state, session });
        return;
      }
      case "planner.create": {
        const plan = await backend.planner.createPlan({
          brief: payload.brief,
          aspectIds: payload.aspectIds,
          contextRoots: payload.contextRoots,
          ...(payload.notes === undefined ? {} : { notes: payload.notes }),
          ...(payload.title === undefined ? {} : { title: payload.title }),
          ...(payload.taskId === undefined ? {} : { taskId: payload.taskId })
        });
        const summary = (await backend.planner.listPlans()).find((candidate) => candidate.planId === plan.planId);
        if (summary === undefined) {
          throw new Error("The plan was created but could not be read back.");
        }
        this.respond(request.requestId, { type: "planner.create", plan: summary });
        // Boot detached: a sandbox boot outlives the webview request timeout.
        this.bootDetached(backend, plan.planId, payload.model === undefined ? undefined : payload.model);
        return;
      }
      case "planner.updateIntake": {
        await backend.planner.updateIntake(payload.planId, {
          ...(payload.title === undefined ? {} : { title: payload.title }),
          ...(payload.brief === undefined ? {} : { brief: payload.brief }),
          ...(payload.aspectIds === undefined ? {} : { aspectIds: payload.aspectIds }),
          ...(payload.contextRoots === undefined ? {} : { contextRoots: payload.contextRoots }),
          ...(payload.notes === undefined ? {} : { notes: payload.notes }),
          // "" clears the link back to an orphan plan.
          ...(payload.taskId === undefined ? {} : { taskId: payload.taskId === "" ? null : payload.taskId })
        });
        const summary = (await backend.planner.listPlans()).find((candidate) => candidate.planId === payload.planId);
        if (summary === undefined) {
          throw new Error("The plan no longer exists.");
        }
        this.respond(request.requestId, { type: "planner.updateIntake", plan: summary });
        return;
      }
      case "planner.archive": {
        await backend.planner.archivePlan(payload.planId, payload.archived);
        const summary = (await backend.planner.listPlans()).find((candidate) => candidate.planId === payload.planId);
        if (summary === undefined) {
          throw new Error("The plan no longer exists.");
        }
        this.respond(request.requestId, { type: "planner.archive", plan: summary });
        return;
      }
      case "planner.startSession": {
        this.respond(request.requestId, { type: "planner.startSession", accepted: true });
        this.bootDetached(backend, payload.planId, payload.model === undefined ? undefined : payload.model);
        return;
      }
      case "planner.sendTurn": {
        // Ack immediately; the turn's own events stream via the forwarded bus
        // pushes. Failures surface through the sessionReady-style error push.
        this.respond(request.requestId, { type: "planner.sendTurn", accepted: true });
        void backend.planner.sendPlanTurn(payload.planId, payload.prompt).catch((error: unknown) => {
          this.pushTurnFailure(backend, payload.planId, error);
        });
        return;
      }
      case "planner.annotation.add": {
        const annotation = await backend.planner.addAnnotation(payload.planId, payload.artifactId, payload.anchor, payload.body);
        this.respond(request.requestId, { type: "planner.annotation.add", annotation });
        return;
      }
      case "planner.annotation.setStatus": {
        const annotation = await backend.planner.setAnnotationStatus(payload.annotationId, payload.status);
        this.respond(request.requestId, { type: "planner.annotation.setStatus", annotation });
        return;
      }
      case "planner.annotation.remove": {
        await backend.planner.removeAnnotation(payload.annotationId);
        this.respond(request.requestId, { type: "planner.annotation.remove", removed: true });
        return;
      }
      case "planner.artifact.rename": {
        const artifact = await backend.planner.renameArtifact(payload.artifactId, payload.title);
        this.respond(request.requestId, { type: "planner.artifact.rename", artifact });
        return;
      }
      case "planner.sendInstructions": {
        const result = await backend.planner.sendInstructions(payload.planId);
        this.respond(request.requestId, { type: "planner.sendInstructions", accepted: true, sentCount: result.sentCount });
        return;
      }
      case "planner.subtaskCandidates": {
        // Plan → board (ADR 0012): checkbox items across the plan's document
        // artifacts, proposed verbatim - the dialog shows exactly what the
        // plan lists as work, nothing inferred.
        const state = await backend.planner.getPlanState(payload.planId);
        const candidates = extractSubtaskCandidates(state.artifacts);
        this.respond(request.requestId, {
          type: "planner.subtaskCandidates",
          candidates,
          ...(state.plan.taskId === null ? {} : { taskId: state.plan.taskId }),
          ...(state.plan.taskTitle === undefined ? {} : { taskTitle: state.plan.taskTitle })
        });
        return;
      }
      case "planner.materializeSubtasks": {
        // Creates, never starts (0007 discipline): each accepted title lands
        // as a backlog subtask on the plan's owning task with a plan-sourced
        // prompt, so it is startable later without retyping context.
        const state = await backend.planner.getPlanState(payload.planId);
        const taskId = state.plan.taskId;
        if (taskId === null) {
          this.respondError(request.requestId, "This plan has no owning task - assign one from the Drydock Plan tab first.");
          return;
        }
        let createdCount = 0;
        for (const title of payload.titles) {
          await backend.subtasks.createSubtask(taskId, {
            title,
            prompt: `From the plan "${state.plan.title}": ${title}\n\nFollow the plan's artifacts for context and constraints.`
          });
          createdCount += 1;
        }
        this.respond(request.requestId, { type: "planner.materializeSubtasks", createdCount, taskId });
        return;
      }
      case "planner.regenerate": {
        this.respond(request.requestId, { type: "planner.regenerate", accepted: true });
        void backend.planner.regenerate(payload.planId, payload.aspectId).catch((error: unknown) => {
          this.pushTurnFailure(backend, payload.planId, error);
        });
        return;
      }
      case "planner.openArtifact": {
        const hostPath = await backend.planner.artifactHostPath(payload.artifactId);
        if (hostPath === null) {
          throw new Error("The artifact has no workspace file right now - start the plan's session first.");
        }
        await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(hostPath));
        this.respond(request.requestId, { type: "planner.openArtifact", accepted: true });
        return;
      }
      case "planner.setPrototypeScripts": {
        const artifact = await backend.planner.setPrototypeScripts(payload.artifactId, payload.enabled);
        this.respond(request.requestId, { type: "planner.setPrototypeScripts", artifact });
        return;
      }
      case "planner.aspects.list": {
        const aspects = (await backend.planner.listAspects(true)).map((aspect) => ({ ...aspect }));
        this.respond(request.requestId, { type: "planner.aspects.list", aspects });
        return;
      }
      case "planner.aspects.save": {
        const aspects = await backend.planner.saveAspect(payload.aspect);
        this.respond(request.requestId, { type: "planner.aspects.save", aspects });
        return;
      }
      case "planner.aspects.archive": {
        const aspects = await backend.planner.archiveAspect(payload.aspectId, payload.archived);
        this.respond(request.requestId, { type: "planner.aspects.archive", aspects });
        return;
      }
      case "task.list": {
        // The intake's task picker (plans belong to tasks, ADR 0006 doctrine).
        const tasks = await backend.tasks.listTaskSummaries();
        this.respond(request.requestId, { type: "task.list", tasks });
        return;
      }
      default:
        this.respondError(request.requestId, `Request ${payload.type} is not supported by the planner panel.`);
    }
  }

  /**
   * Detached session boot shared by create and startSession: watch the
   * session as soon as it exists, then report the terminal result as the
   * planner.sessionReady push.
   */
  private bootDetached(backend: BackendReady, planId: string, model?: { providerId: string; model?: string }): void {
    // Success is announced via the bus planner-session-started event (every
    // provider translates it to the planner.sessionReady push); only the
    // failure path is local to the surface that initiated the boot.
    void backend.planner.startPlanSession(planId, model)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error("planner session boot failed", { planId, error: message });
        this.push({ type: "planner.sessionReady", planId, sessionId: "", ok: false, error: message });
      });
  }

  /** A failed detached turn surfaces as a sessionReady-shaped error push. */
  private pushTurnFailure(backend: BackendReady, planId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error("planner turn failed", { planId, error: message });
    void backend.planner.getPlan(planId).then((plan) => {
      this.push({ type: "planner.sessionReady", planId, sessionId: plan?.sessionId ?? "", ok: false, error: message });
    }).catch(() => {
      this.push({ type: "planner.sessionReady", planId, sessionId: "", ok: false, error: message });
    });
  }

  private async sessionSummaryFor(backend: BackendReady, sessionId: string | null): Promise<ChatSessionSummary | null> {
    if (sessionId === null) {
      return null;
    }
    const record = await backend.planner.getSessionRecord(sessionId);
    if (record === null) {
      return null;
    }
    return this.decorateSession(sessionId, record);
  }

  private decorateSession(sessionId: string, record: Parameters<typeof toChatSessionSummary>[0]): ChatSessionSummary {
    const backend = this.requireBackend();
    return { ...toChatSessionSummary(record), live: backend.appService.isChatSessionLive(sessionId) };
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
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "planner.js"));
    const mermaidUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "planDocsMermaid.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "planner.css"));
    // CSP deviation, THIS PANEL ONLY (owner-approved 2026-07-10, ADR 0012):
    // mermaid injects <style> nodes with no nonce API, so style-src needs
    // 'unsafe-inline' - identical to the plan-docs precedent, with identical
    // input-side mitigations in the webview. Scripts stay nonce-gated; the
    // mermaid bundle URI + nonce travel as data attributes for lazy injection.
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; frame-src data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri.toString()}">
  <title>Drydock: Planner</title>
</head>
<body data-start-guide="${startGuide ? "true" : "false"}">
  <div id="app" data-nonce="${nonce}" data-mermaid-src="${mermaidUri.toString()}"></div>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}
