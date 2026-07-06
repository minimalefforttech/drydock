/**
 * Control panel webview host.
 *
 * This is the trust boundary between the webview (untrusted renderer) and the
 * backend services: every inbound message passes through parsePanelRequest,
 * every outbound message is a typed envelope, and the webview only ever
 * receives display-safe projections — never runtime handles, secrets, or
 * process APIs. The panel renders a degraded state instead of disappearing
 * when the isolated runtime tooling is missing.
 */

import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import {
  asId,
  parsePanelRequest,
  summarizeAgentEvent,
  WEBVIEW_PROTOCOL_VERSION,
  type AccessRequestSummary,
  type AgentQuestionRecord,
  type AgentQuestionSummary,
  type BackendAvailability,
  type ChatModelSelection,
  type ChatSessionRecord,
  type ChatSessionSummary,
  type ChatWorkspaceSelection,
  type HostToWebviewMessage,
  type MemoryCandidateRecord,
  type MemoryCandidateSummary,
  type PanelInitState,
  type PanelPushPayload,
  type PanelRequest,
  type PanelResponsePayload,
  type SessionAttentionReason,
  type WorkspaceActivateResult,
  type WorkTaskRecord,
  type WorkTaskSummary
} from "@drydock/contracts";
import { normalizePathKey, type AgentQuestionService, type Logger, type ProductBusEvent } from "@drydock/core";
import type { MemoryService, TaskService } from "@drydock/work-management";
import type { Backend } from "../compositionRoot.js";
import {
  toRuntimeSummary,
  type ChatWorkspaceContext,
  type IsolatedRunService
} from "../services/isolatedRunService.js";
import type { PlanDocsAppService } from "../services/planDocsAppService.js";
import type { WorkHistoryFilter, WorkInsightsAppService } from "../services/workInsightsAppService.js";
import { toAccessRequestSummary, type WorkspaceReviewAppService } from "../services/workspaceReviewAppService.js";
import { openBaselineDiff } from "./baselineDiff.js";
import { composePlanDocsSend, toPlanDocDetail, toPlanDocSummary } from "./planDocsShared.js";

export function toChatSessionSummary(record: ChatSessionRecord, runningElsewhere = false): ChatSessionSummary {
  return {
    sessionId: record.sessionId,
    title: record.title,
    ...(record.description === undefined ? {} : { description: record.description }),
    status: record.status,
    providerId: record.providerId,
    ...(record.model === undefined ? {} : { model: record.model }),
    ...(runningElsewhere ? { runningElsewhere: true } : {}),
    ...(record.mode === undefined ? {} : { mode: record.mode }),
    transport: record.transport,
    ...(record.parentSessionId === undefined ? {} : { parentSessionId: record.parentSessionId }),
    ...(record.spawnedRole === undefined ? {} : { spawnedRole: record.spawnedRole }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

/** Display-safe projection of an agent question (records carry no host paths). */
function toAgentQuestionSummary(record: AgentQuestionRecord): AgentQuestionSummary {
  return {
    questionId: record.questionId,
    sessionId: record.sessionId,
    question: record.question,
    options: record.options,
    status: record.status,
    ...(record.answer === undefined ? {} : { answer: record.answer }),
    createdAt: record.createdAt
  };
}

/**
 * Summary for a freshly-created task: a record with no links yet. Records
 * straight from createTask carry no links, so the empty arrays are exact
 * rather than a lossy default.
 */
function toFreshWorkTaskSummary(record: WorkTaskRecord): WorkTaskSummary {
  return {
    taskId: record.taskId,
    title: record.title,
    ...(record.description === undefined ? {} : { description: record.description }),
    state: record.state,
    linkedWorkspaceSetIds: [],
    linkedSessionIds: [],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

/** Display-safe projection of a memory candidate; resolvedAt is host-only. */
function toMemoryCandidateSummary(record: MemoryCandidateRecord): MemoryCandidateSummary {
  return {
    memoryCandidateId: record.memoryCandidateId,
    sessionId: record.sessionId,
    content: record.content,
    status: record.status,
    createdAt: record.createdAt
  };
}

/**
 * The single link target from a task.link/unlink payload. Contracts guarantee
 * exactly one of workspaceSetId/sessionId is present, so workspaceSetId is
 * preferred and sessionId is the else branch.
 */
function taskLinkTarget(payload: { readonly workspaceSetId?: string; readonly sessionId?: string }):
  | { readonly workspaceSetId: string }
  | { readonly sessionId: string } {
  return payload.workspaceSetId !== undefined
    ? { workspaceSetId: payload.workspaceSetId }
    : { sessionId: payload.sessionId as string };
}

export class ControlPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "drydock.controlPanel";

  private view: vscode.WebviewView | undefined;
  private sequence = 0;
  /**
   * Per-session "waiting on you" reasons. Drives the activity-bar badge, the
   * `session.attention` push, and the hidden-panel toast. A session with an
   * empty set is dropped entirely so the badge counts only sessions that still
   * need the user.
   */
  private readonly attention = new Map<string, Set<SessionAttentionReason>>();
  /** Seeded once so a reloaded webview re-derives startup pending-request attention. */
  private attentionSeeded = false;
  /**
   * Live subagent counters per session (⑂ chip), folded from the bus
   * agent-events this host streams — sessions running in another window
   * stream nothing here, so their chip stays empty (read-only posture).
   */
  private readonly agentActivity = new Map<string, { running: Set<string>; failed: number }>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly backend: Backend,
    private readonly logger: Logger
  ) {
    if (backend.available) {
      // The subscription lives for the extension lifetime; push() is a no-op
      // while the view is hidden/disposed.
      backend.bus.subscribe((event) => this.onBusEvent(event));
    }
  }

  private onBusEvent(event: ProductBusEvent): void {
    switch (event.kind) {
      case "agent-event":
        this.foldAgentActivity(event.sessionId, event.event);
        this.push({
          type: "chat.event",
          sessionId: event.sessionId,
          line: {
            ...summarizeAgentEvent(event.event),
            sequence: event.sequence,
            ...(event.event.type === "agent.text" ? { final: event.event.final } : {})
          }
        });
        return;
      case "transcript-line":
        this.push({
          type: "chat.event",
          sessionId: event.sessionId,
          line: { ...event.line, sequence: event.sequence }
        });
        return;
      case "turn-started":
        // Fresh turn, fresh subagent counters (last turn's failures stop tinting the chip).
        if (this.agentActivity.delete(event.sessionId)) {
          this.pushAgentActivity(event.sessionId);
        }
        this.push({ type: "chat.turnStarted", sessionId: event.sessionId, runId: event.runId });
        return;
      case "turn-completed":
        this.push({ type: "chat.turnCompleted", sessionId: event.sessionId, runId: event.runId, status: event.status });
        // A completed turn flags the session for attention; a failed/cancelled
        // turn flags it as failed. Both surface as a badge and a hidden-panel toast.
        void this.flagAttention(
          event.sessionId,
          event.status === "completed" ? "turn-completed" : "turn-failed",
          event.status === "completed" ? "finished a turn" : "failed a turn"
        );
        return;
      case "session-updated":
        this.push({ type: "session.updated", session: this.decorateSessionSummary(event.session) });
        return;
      case "session-deleted":
        this.push({ type: "session.deleted", sessionId: event.sessionId });
        // A deleted session can no longer wait on the user; drop its attention.
        this.dropAttention(event.sessionId);
        return;
      case "plan-docs-updated":
        // Forward as the summaries-only push (no content over the boundary
        // beyond an explicit planDocs.state request).
        this.push({ type: "planDocs.updated", sessionId: event.sessionId, docs: event.docs.map(toPlanDocSummary) });
        return;
      case "access-requested":
        // Detected agent access requests arrive here; forward the display-safe
        // summary as its own push and flag the session for attention (badge +
        // hidden-panel toast). The badge derives from attention reasons now, so
        // no separate pending-request query is needed here.
        this.push({ type: "policy.accessRequested", accessRequest: toAccessRequestSummary(event.request) });
        void this.flagAttention(event.request.sessionId, "access-request", "needs access approval");
        return;
      case "question-asked":
        // A pending agent question is a standing "waiting on you" item: stack
        // card in the panel, badge + toast via the attention path.
        this.push({ type: "question.asked", question: toAgentQuestionSummary(event.question) });
        void this.flagAttention(event.question.sessionId, "question", "asked a question");
        return;
      case "memory-candidate-added":
        // A proposed memory is not urgent: forward the display-safe summary as
        // its own push, but do NOT flag the session for attention.
        this.push({ type: "memory.candidateAdded", candidate: toMemoryCandidateSummary(event.candidate) });
        return;
      case "inventory-changed":
        if (this.backend.available) {
          void this.pushInventory(this.backend.appService);
        }
        return;
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")]
    };
    view.webview.html = this.renderHtml(view.webview);
    view.webview.onDidReceiveMessage((raw: unknown) => {
      void this.onMessage(raw);
    });
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }

  private async onMessage(raw: unknown): Promise<void> {
    const request = parsePanelRequest(raw);
    if (!request) {
      this.logger.warn("control panel dropped a malformed webview message");
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
    switch (payload.type) {
      case "panel.init": {
        const runtimes = this.backend.available
          ? (await this.backend.appService.listPanelRuntimes()).map(toRuntimeSummary)
          : [];
        const state: PanelInitState = {
          availability: this.availability(),
          runtimes,
          providerCatalogs: this.backend.available ? this.backend.appService.listChatProviderCatalogs() : [],
          stateRootDisplayPath: this.backend.stateRootPath,
          openFolderNames: this.openFolderNames()
        };
        this.respond(request.requestId, { type: "panel.init", state });
        if (this.backend.available) {
          // Host API ping is inert capability discovery; push the refreshed
          // catalogs when it lands rather than blocking init on the network.
          void this.backend.appService.refreshHostProviderCatalogs().then((providerCatalogs) => {
            this.push({ type: "provider.models", providerCatalogs });
          }).catch(() => { /* logged by the service */ });
        }
        return;
      }
      case "isolatedRun.listRuntimes": {
        const appService = this.requireBackend();
        const runtimes = (await appService.listPanelRuntimes(payload.includeRemoved ?? false)).map(toRuntimeSummary);
        this.respond(request.requestId, { type: "isolatedRun.listRuntimes", runtimes });
        return;
      }
      case "isolatedRun.stopRuntime": {
        const appService = this.requireBackend();
        const result = await appService.stopRuntime(payload.runtimeId, "force-remove");
        this.respond(request.requestId, {
          type: "isolatedRun.stopRuntime",
          runtimeId: payload.runtimeId,
          status: result.status,
          diagnostics: result.diagnostics
        });
        await this.pushInventory(appService);
        return;
      }
      case "isolatedRun.probeAppServer": {
        const appService = this.requireBackend();
        if (appService.isRunInFlight()) {
          throw new Error("A run is already in progress.");
        }
        this.respond(request.requestId, { type: "isolatedRun.probeAppServer", accepted: true });
        void this.executeProbe(appService);
        return;
      }
      case "chat.start": {
        const appService = this.requireBackend();
        const workspace = await this.resolveWorkspace(payload.workspace);
        const started = await appService.startChat(payload.prompt, payload.model, workspace);
        await this.baselineWorkspaceSession(started.session.sessionId, workspace);
        this.push({ type: "run.started", isolation: started.isolation });
        this.push({ type: "provider.models", providerCatalogs: started.providerCatalogs });
        this.respond(request.requestId, { type: "chat.start", session: this.decorateSessionSummary(started.session) });
        this.runTurnDetached(appService, started.session.sessionId, payload.prompt, payload.model);
        return;
      }
      case "chat.startSession": {
        const appService = this.requireBackend();
        const workspace = await this.resolveWorkspace(payload.workspace);
        const started = await appService.startChatSession(payload.model, undefined, workspace);
        await this.baselineWorkspaceSession(started.session.sessionId, workspace);
        this.push({ type: "run.started", isolation: started.isolation });
        this.push({ type: "provider.models", providerCatalogs: started.providerCatalogs });
        this.respond(request.requestId, {
          type: "chat.startSession",
          session: this.decorateSessionSummary(started.session),
          providerCatalogs: started.providerCatalogs
        });
        return;
      }
      case "chat.sendTurn": {
        const appService = this.requireBackend();
        if (!appService.isChatSessionLive(payload.sessionId)) {
          throw new Error("This session is no longer live. Start a new chat.");
        }
        if (appService.hasActiveChatTurn(payload.sessionId)) {
          throw new Error("A turn is already in progress for this session.");
        }
        this.respond(request.requestId, { type: "chat.sendTurn", accepted: true });
        this.runTurnDetached(appService, payload.sessionId, payload.prompt, payload.model);
        return;
      }
      case "chat.restartBackend": {
        const appService = this.requireBackend();
        if (!appService.isChatSessionLive(payload.sessionId)) {
          throw new Error("This session is no longer live. Start a new chat.");
        }
        if (appService.hasActiveChatTurn(payload.sessionId)) {
          throw new Error("A turn is already in progress for this session.");
        }
        const restarted = await appService.restartChatBackend(payload.sessionId, payload.model);
        this.push({ type: "provider.models", providerCatalogs: restarted.providerCatalogs });
        this.respond(request.requestId, {
          type: "chat.restartBackend",
          session: this.decorateSessionSummary(restarted.session),
          providerCatalogs: restarted.providerCatalogs
        });
        await this.pushInventory(appService);
        return;
      }
      case "chat.resumeSession": {
        const appService = this.requireBackend();
        if (appService.isChatSessionLive(payload.sessionId)) {
          throw new Error("This session is already live.");
        }
        const workspace = await this.resolveWorkspace(payload.workspace);
        const resumed = await appService.resumeChatSession(payload.sessionId, payload.model, workspace);
        await this.baselineWorkspaceSession(resumed.session.sessionId, workspace);
        this.push({ type: "run.started", isolation: resumed.isolation });
        this.push({ type: "provider.models", providerCatalogs: resumed.providerCatalogs });
        this.respond(request.requestId, {
          type: "chat.resumeSession",
          session: this.decorateSessionSummary(resumed.session),
          providerCatalogs: resumed.providerCatalogs
        });
        await this.pushInventory(appService);
        return;
      }
      case "chat.cancelTurn": {
        const appService = this.requireBackend();
        await appService.cancelChatTurn(payload.sessionId);
        this.respond(request.requestId, { type: "chat.cancelTurn", accepted: true });
        return;
      }
      case "chat.endSession": {
        const appService = this.requireBackend();
        const session = await appService.endChatSession(payload.sessionId, "panel-end");
        this.respond(request.requestId, { type: "chat.endSession", session: this.decorateSessionSummary(session) });
        // An ended session no longer waits on the user; drop its attention.
        this.dropAttention(payload.sessionId);
        await this.pushInventory(appService);
        return;
      }
      case "chat.spawnRole": {
        const appService = this.requireBackend();
        const spawned = await appService.spawnRoleChatSession(payload.sessionId, payload.role);
        // The child works the same tasks as its parent: inherit the links so
        // Task Review and the Work board see its changes under the same tasks.
        try {
          const tasks = this.requireTasks();
          const summaries = await tasks.listTaskSummaries();
          for (const task of summaries) {
            if (task.linkedSessionIds.includes(payload.sessionId)) {
              await tasks.link(task.taskId, { sessionId: spawned.session.sessionId });
            }
          }
        } catch {
          // Task system unavailable (no state store): the spawn itself stands.
        }
        this.push({ type: "run.started", isolation: spawned.isolation });
        this.respond(request.requestId, { type: "chat.spawnRole", session: this.decorateSessionSummary(spawned.session) });
        await this.pushInventory(appService);
        return;
      }
      case "session.list": {
        const appService = this.requireBackend();
        const sessions = await appService.listChatSessions();
        this.respond(request.requestId, { type: "session.list", sessions: sessions.map((session) => this.decorateSessionSummary(session)) });
        return;
      }
      case "session.rename": {
        const appService = this.requireBackend();
        const session = await appService.renameChatSession(payload.sessionId, payload.title);
        this.respond(request.requestId, { type: "session.rename", session: this.decorateSessionSummary(session) });
        return;
      }
      case "session.setDescription": {
        const appService = this.requireBackend();
        // "" clears the note; the service persists that as NULL.
        const session = await appService.setChatSessionDescription(payload.sessionId, payload.description);
        this.respond(request.requestId, { type: "session.setDescription", session: this.decorateSessionSummary(session) });
        return;
      }
      case "session.delete": {
        const appService = this.requireBackend();
        // deleteChatSession publishes `session-deleted` on the bus, which this
        // provider forwards as the `session.deleted` push (see onBusEvent), so
        // the handler does not push it again. Deleting a live session tears
        // down its runtime, hence the inventory refresh.
        await appService.deleteChatSession(payload.sessionId);
        this.respond(request.requestId, { type: "session.delete", sessionId: payload.sessionId });
        // deleteChatSession publishes session-deleted (which drops attention via
        // onBusEvent); this is belt-and-suspenders for the panel's own bookkeeping.
        this.dropAttention(payload.sessionId);
        await this.pushInventory(appService);
        return;
      }
      case "provider.list": {
        const appService = this.requireBackend();
        const providerCatalogs = await appService.refreshHostProviderCatalogs();
        this.respond(request.requestId, { type: "provider.list", providerCatalogs });
        return;
      }
      case "provider.login": {
        const appService = this.requireBackend();
        const login = appService.loginCommand(payload.providerId);
        // The OAuth flow is interactive and user-driven; it runs in a visible
        // terminal so no secret ever passes through the extension.
        const terminal = vscode.window.createTerminal({
          name: `${payload.providerId} login`,
          shellPath: login.command,
          shellArgs: [...login.args]
        });
        terminal.show();
        this.respond(request.requestId, { type: "provider.login", providerId: payload.providerId, launched: login.display });
        return;
      }
      case "session.timeline": {
        const appService = this.requireBackend();
        const lines = await appService.getChatTimeline(
          payload.sessionId,
          payload.fromSequence
        );
        this.respond(request.requestId, { type: "session.timeline", sessionId: payload.sessionId, lines });
        // Selecting a session is the "seen" signal: clear its turn-attention.
        // access-request attention persists until the request is resolved.
        this.clearAttention(payload.sessionId, ["turn-completed", "turn-failed"]);
        return;
      }
      case "task.list": {
        const tasks = await this.requireTasks().listTaskSummaries();
        this.respond(request.requestId, { type: "task.list", tasks: await this.joinOpenCommentCounts(tasks) });
        return;
      }
      case "task.create": {
        const tasks = this.requireTasks();
        const record = await tasks.createTask(payload.title, payload.description);
        // A fresh record has no links, so the empty-array summary is exact.
        this.respond(request.requestId, { type: "task.create", task: toFreshWorkTaskSummary(record) });
        return;
      }
      case "task.update": {
        const tasks = this.requireTasks();
        // description passes through verbatim: "" clears it (TaskService maps
        // "" → NULL); an absent field leaves it untouched.
        await tasks.updateTask(payload.taskId, {
          ...(payload.title === undefined ? {} : { title: payload.title }),
          ...(payload.description === undefined ? {} : { description: payload.description }),
          ...(payload.state === undefined ? {} : { state: payload.state })
        });
        const summary = await this.requireTaskSummary(tasks, payload.taskId);
        this.respond(request.requestId, { type: "task.update", task: summary });
        this.push({ type: "task.updated", task: summary });
        return;
      }
      case "task.delete": {
        const tasks = this.requireTasks();
        await tasks.deleteTask(payload.taskId);
        this.respond(request.requestId, { type: "task.delete", taskId: payload.taskId });
        this.push({ type: "task.deleted", taskId: payload.taskId });
        return;
      }
      case "task.link": {
        const tasks = this.requireTasks();
        // Contracts guarantee exactly one target field is set.
        await tasks.link(payload.taskId, taskLinkTarget(payload));
        const summary = await this.requireTaskSummary(tasks, payload.taskId);
        this.respond(request.requestId, { type: "task.link", task: summary });
        this.push({ type: "task.updated", task: summary });
        return;
      }
      case "task.unlink": {
        const tasks = this.requireTasks();
        await tasks.unlink(payload.taskId, taskLinkTarget(payload));
        const summary = await this.requireTaskSummary(tasks, payload.taskId);
        this.respond(request.requestId, { type: "task.unlink", task: summary });
        this.push({ type: "task.updated", task: summary });
        return;
      }
      case "question.list": {
        const questions = await this.requireQuestions().listQuestions("pending");
        this.respond(request.requestId, { type: "question.list", questions: questions.map(toAgentQuestionSummary) });
        return;
      }
      case "question.answer": {
        const service = this.requireQuestions();
        const record = await service.answer(asId<"AgentQuestionId">(payload.questionId), payload.answer);
        // The answer returns to the agent as a host-authored follow-up turn —
        // possible only when the session is live in this window and idle.
        // Otherwise the answer is recorded and the card says so; it still
        // reaches the agent verbatim if the user pastes/asks later.
        const appService = this.requireBackend();
        const dispatched = appService.isChatSessionLive(record.sessionId)
          && !appService.hasActiveChatTurn(record.sessionId);
        if (dispatched) {
          this.runTurnDetached(
            appService,
            record.sessionId,
            `[host] The developer answered your question.\nQ: ${record.question}\nA: ${record.answer ?? ""}\nContinue with this answer.`
          );
        }
        await this.settleQuestionAttention(record.sessionId);
        this.push({ type: "question.resolved", question: toAgentQuestionSummary(record) });
        this.respond(request.requestId, { type: "question.answer", question: toAgentQuestionSummary(record), dispatched });
        return;
      }
      case "question.dismiss": {
        const record = await this.requireQuestions().dismiss(asId<"AgentQuestionId">(payload.questionId));
        await this.settleQuestionAttention(record.sessionId);
        this.push({ type: "question.resolved", question: toAgentQuestionSummary(record) });
        this.respond(request.requestId, { type: "question.dismiss", question: toAgentQuestionSummary(record) });
        return;
      }
      case "workspace.openInNewWindow": {
        const roots = await this.requireWorkspaceReview().resolveWorkspaceSetRoots(payload.workspaceSetId);
        const root = roots[0];
        if (root === undefined) {
          throw new Error("This workspace set has no folders to open.");
        }
        // Respond before opening: launching a new window can steal focus and
        // tear down this webview mid-call, which would drop a late response.
        this.respond(request.requestId, { type: "workspace.openInNewWindow", accepted: true });
        void vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(root), { forceNewWindow: true });
        return;
      }
      case "workspace.activate": {
        await this.handleWorkspaceActivate(request.requestId, payload);
        return;
      }
      case "work.history": {
        // Contracts guarantee exactly one scope; workspaceSetId wins the union.
        const filter: WorkHistoryFilter = payload.workspaceSetId !== undefined
          ? { workspaceSetId: payload.workspaceSetId }
          : { projectId: payload.projectId as string };
        const entries = await this.requireWorkInsights().history(filter);
        this.respond(request.requestId, { type: "work.history", entries });
        return;
      }
      case "memory.list": {
        const candidates = (await this.requireMemory().listCandidates()).map(toMemoryCandidateSummary);
        this.respond(request.requestId, { type: "memory.list", candidates });
        return;
      }
      case "memory.resolve": {
        const record = await this.requireMemory().resolve(payload.memoryCandidateId, payload.approve);
        this.respond(request.requestId, { type: "memory.resolve", candidate: toMemoryCandidateSummary(record) });
        return;
      }
      case "workspace.state": {
        const state = await this.requireWorkspaceReview().getPolicyState();
        this.respond(request.requestId, { type: "workspace.state", state });
        // Seed access-request attention once (first workspace.state after a
        // reload) so a reloaded webview still shows the badge for requests that
        // were pending before this panel session existed.
        this.seedPendingAttention(state.accessRequests);
        return;
      }
      case "workspace.registerOpenFolders": {
        const folders = this.openFolderRoots();
        if (folders.length === 0) {
          throw new Error("No local folders are open in this window.");
        }
        const projects = await this.requireWorkspaceReview().registerProjects(folders);
        this.respond(request.requestId, { type: "workspace.registerOpenFolders", projects });
        return;
      }
      case "workspace.createSet": {
        const workspaceSet = await this.requireWorkspaceReview().createWorkspaceSetFromCatalog(payload.name);
        this.respond(request.requestId, { type: "workspace.createSet", workspaceSet });
        return;
      }
      case "policy.requestAccess": {
        const workspaceReview = this.requireWorkspaceReview();
        const accessRequest = await workspaceReview.requestAccess(payload);
        this.respond(request.requestId, { type: "policy.requestAccess", accessRequest });
        // A new pending request flags the session for attention (badge + toast).
        void this.flagAttention(accessRequest.sessionId, "access-request", "needs access approval");
        return;
      }
      case "policy.resolveAccess": {
        const workspaceReview = this.requireWorkspaceReview();
        const accessRequest = await workspaceReview.resolveAccess(payload.accessRequestId, payload.approve, payload.editedHostPath);
        this.respond(request.requestId, { type: "policy.resolveAccess", accessRequest });
        // The access-request attention persists until the session has no PENDING
        // requests left; then it clears. Turn attention is untouched here.
        await this.clearAccessAttentionIfResolved(workspaceReview, accessRequest.sessionId);
        // Approval restarts the session with the new mount and denial leaves it
        // as-is; either way, nudge a live idle session to continue the task with
        // the outcome. The runtime path mirrors prepareApproval's deterministic
        // `/approved/<id>` mount point.
        this.autoContinueAfterAccess(payload.approve, accessRequest);
        return;
      }
      case "diff.snapshotWorkspace": {
        const baselineIds = await this.requireWorkspaceReview().snapshotWorkspace(payload.workspaceSetId);
        this.respond(request.requestId, { type: "diff.snapshotWorkspace", baselineIds });
        return;
      }
      case "diff.status": {
        const changes = await this.requireWorkspaceReview().diffStatus(payload.sessionId);
        this.respond(request.requestId, { type: "diff.status", changes });
        return;
      }
      case "diff.acceptFile": {
        const changes = await this.requireWorkspaceReview().acceptFile(payload.baselineId, payload.path);
        this.respond(request.requestId, { type: "diff.acceptFile", changes });
        return;
      }
      case "diff.revertFile": {
        const changes = await this.requireWorkspaceReview().revertFile(payload.baselineId, payload.path);
        this.respond(request.requestId, { type: "diff.revertFile", changes });
        return;
      }
      case "diff.openFile": {
        await openBaselineDiff(this.requireWorkspaceReview(), payload.baselineId, payload.path);
        this.respond(request.requestId, { type: "diff.openFile", accepted: true });
        return;
      }
      case "review.state": {
        const state = await this.requireWorkspaceReview().reviewState(payload.sessionId);
        this.respond(request.requestId, { type: "review.state", reviewSessionId: state.reviewSessionId, comments: state.comments });
        return;
      }
      case "review.addComment": {
        const comment = await this.requireWorkspaceReview().addComment(payload);
        this.respond(request.requestId, { type: "review.addComment", comment });
        return;
      }
      case "review.setCommentStatus": {
        const comment = await this.requireWorkspaceReview().setCommentStatus(payload.commentId, payload.status);
        this.respond(request.requestId, { type: "review.setCommentStatus", comment });
        return;
      }
      case "planDocs.state": {
        this.requireBackend();
        const docs = await this.requirePlanDocs().listDocs(payload.sessionId);
        this.respond(request.requestId, { type: "planDocs.state", sessionId: payload.sessionId, docs: docs.map(toPlanDocDetail) });
        return;
      }
      case "planDocs.open": {
        // Editor-panel open is a host action; route through the command.
        this.requireBackend();
        await vscode.commands.executeCommand("drydock.planDocs.open", payload.sessionId);
        this.respond(request.requestId, { type: "planDocs.open", accepted: true });
        return;
      }
      case "taskReview.open": {
        // Editor-panel open is a host action; route through the command.
        this.requireBackend();
        await vscode.commands.executeCommand("drydock.taskReview.open", payload.taskId);
        this.respond(request.requestId, { type: "taskReview.open", accepted: true });
        return;
      }
      case "planDocs.sendComments": {
        const appService = this.requireBackend();
        if (!this.backend.available) {
          throw new Error(this.backend.reason);
        }
        // Nothing open → accepted no-op; otherwise the guarded send returns a
        // prompt to run detached.
        const send = await composePlanDocsSend(this.backend, appService, payload.sessionId);
        this.respond(request.requestId, { type: "planDocs.sendComments", accepted: true, sentCount: send.sentCount });
        if (send.prompt !== undefined) {
          this.runTurnDetached(appService, payload.sessionId, send.prompt);
        }
        return;
      }
      case "clone.state": {
        const appService = this.requireCloneSession(payload.sessionId);
        const repos = await appService.cloneState(payload.sessionId);
        this.respond(request.requestId, { type: "clone.state", sessionId: payload.sessionId, repos });
        return;
      }
      case "clone.pull": {
        const appService = this.requireCloneSession(payload.sessionId);
        // Contracts enforce the repo+path XOR rule; a full pull names neither.
        const result = await appService.clonePull(payload.sessionId, payload.repo, payload.path);
        this.respond(request.requestId, { type: "clone.pull", result });
        return;
      }
      case "clone.push": {
        const appService = this.requireCloneSession(payload.sessionId);
        const result = await appService.clonePush(payload.sessionId);
        this.respond(request.requestId, { type: "clone.push", result });
        return;
      }
      case "clone.discard": {
        const appService = this.requireCloneSession(payload.sessionId);
        await appService.cloneDiscard(payload.sessionId, payload.repo, payload.path);
        // No push contract exists; the webview refetches clone.state after the op.
        // Return the fresh repo state so the caller can render without a round-trip.
        const repos = await appService.cloneState(payload.sessionId);
        this.respond(request.requestId, { type: "clone.discard", repos });
        return;
      }
    }
  }

  /**
   * Backend + clone-mode guard for the clone.* handlers: the session must be a
   * clone session in this window. A non-clone (or lost) session is refused with a
   * clear error rather than silently returning empty state.
   */
  private requireCloneSession(sessionId: string): IsolatedRunService {
    const appService = this.requireBackend();
    if (appService.getSessionMode(sessionId) !== "clone") {
      throw new Error("This session is not a clone-mode session.");
    }
    return appService;
  }

  /**
   * Projects a session record to its display-safe summary, decorated with
   * `runningElsewhere`. A session runs "elsewhere" when it is stored
   * active/starting, is NOT live in this host's process, carries a FRESH
   * heartbeat, and is owned by a DIFFERENT host instance. All four conditions
   * must hold: not-live rules out our own live sessions cheaply; the foreign
   * owner + fresh heartbeat is the same signal core reconcile uses to leave the
   * session untouched. When the backend is unavailable the flag is simply false.
   */
  private requireQuestions(): AgentQuestionService {
    if (!this.backend.available) {
      throw new Error(`Backend unavailable: ${this.backend.reason}`);
    }
    return this.backend.questions;
  }

  /** Clears the "question" attention reason once a session has no pending questions left. */
  private async settleQuestionAttention(sessionId: string): Promise<void> {
    const pending = await this.requireQuestions().listQuestions("pending", asId<"SessionId">(sessionId));
    if (pending.length === 0) {
      this.clearAttention(sessionId, ["question"]);
    }
  }

  /** Folds spawn/terminal events into the ⑂ chip counters and pushes on change. */
  private foldAgentActivity(sessionId: string, event: { type: string; nodeId?: string; status?: string }): void {
    if (event.type === "agent.spawn" && event.nodeId !== undefined) {
      const entry = this.agentActivity.get(sessionId) ?? { running: new Set<string>(), failed: 0 };
      entry.running.add(event.nodeId);
      this.agentActivity.set(sessionId, entry);
      this.pushAgentActivity(sessionId);
      return;
    }
    if (event.type === "agent.node_done" && event.nodeId !== undefined) {
      const entry = this.agentActivity.get(sessionId);
      if (entry === undefined) return;
      const wasRunning = entry.running.delete(event.nodeId);
      if (event.status === "failed") entry.failed += 1;
      if (wasRunning || event.status === "failed") this.pushAgentActivity(sessionId);
      return;
    }
    if (event.type === "agent.done") {
      // Stream over: stragglers are no longer "running" (the reducer reports
      // them "unknown"); keep the failed tint until the next turn starts.
      const entry = this.agentActivity.get(sessionId);
      if (entry !== undefined && entry.running.size > 0) {
        entry.running.clear();
        this.pushAgentActivity(sessionId);
      }
    }
  }

  private pushAgentActivity(sessionId: string): void {
    const entry = this.agentActivity.get(sessionId);
    this.push({
      type: "session.agentActivity",
      sessionId,
      running: entry?.running.size ?? 0,
      failed: entry?.failed ?? 0
    });
  }

  private decorateSessionSummary(record: ChatSessionRecord): ChatSessionSummary {
    // Backfill the fast-path mode map from the durable record so a clone session
    // stays recognizable after a reload (its sessionClones map is still lost, so
    // clone.* ops surface the precise "resume the session" error, not a mode one).
    if (this.backend.available) {
      this.backend.appService.noteSessionModeFromRecord(record.sessionId, record.mode);
    }
    const summary = toChatSessionSummary(record, this.isRunningElsewhere(record));
    const activity = this.agentActivity.get(record.sessionId);
    return activity === undefined || (activity.running.size === 0 && activity.failed === 0)
      ? summary
      : { ...summary, agentActivity: { running: activity.running.size, failed: activity.failed } };
  }

  private isRunningElsewhere(record: ChatSessionRecord): boolean {
    if (!this.backend.available) {
      return false;
    }
    const appService = this.backend.appService;
    const storedActive = record.status === "active" || record.status === "starting";
    return storedActive
      && !appService.isChatSessionLive(record.sessionId)
      && appService.isHeartbeatFresh(record.heartbeatAt)
      && record.hostInstanceId !== undefined
      && record.hostInstanceId !== appService.hostInstanceId;
  }

  private async resolveWorkspace(selection: ChatWorkspaceSelection | undefined): Promise<ChatWorkspaceContext | undefined> {
    if (selection === undefined) {
      return undefined;
    }
    // The `auto` selection mounts the window's open file-scheme folders; the
    // service throws when none are open.
    return this.requireWorkspaceReview().resolveWorkspaceSelection(selection, this.openFolderRoots());
  }

  /**
   * Joins each task's open review-comment count (cheap review-store reads via
   * TaskReviewAppService — no tree walks) into the summaries so the Work-tab
   * Review button can read "(N open comments)". Best-effort: a failed join
   * returns the summaries unchanged. task.updated pushes do NOT carry the
   * count; it refreshes on the next task.list.
   */
  private async joinOpenCommentCounts(tasks: readonly WorkTaskSummary[]): Promise<readonly WorkTaskSummary[]> {
    if (!this.backend.available) {
      return tasks;
    }
    try {
      const counts = await this.backend.taskReview.openCommentCountsByTask();
      if (counts.size === 0) {
        return tasks;
      }
      return tasks.map((task) => {
        const openReviewCommentCount = counts.get(task.taskId);
        return openReviewCommentCount === undefined ? task : { ...task, openReviewCommentCount };
      });
    } catch (error) {
      this.logger.warn("task review comment-count join failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      return tasks;
    }
  }

  /** Absolute fsPath roots of the window's open file-scheme folders. */
  private openFolderRoots(): string[] {
    return (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === "file")
      .map((folder) => folder.uri.fsPath);
  }

  /** Display names of the window's open file-scheme folders (for panel.init). */
  private openFolderNames(): string[] {
    return (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === "file")
      .map((folder) => folder.name);
  }

  /** Implementation-mode sessions get per-root diff baselines at start. */
  private async baselineWorkspaceSession(sessionId: string, workspace: ChatWorkspaceContext | undefined): Promise<void> {
    if (workspace === undefined || workspace.mode !== "implementation") {
      return;
    }
    try {
      await this.requireWorkspaceReview().createSessionBaselines(sessionId, workspace.roots);
    } catch (error) {
      this.logger.warn("session diff baseline creation failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  // MARK: Workspace activation

  /**
   * Activates a task's (or set's) folders against the current window: diff, then
   * prompt Replace / Append / Open in new window (Cancel is the modal's built-in
   * dismiss). "no-change" when nothing would be added or removed. Replace/Append
   * mutate the window's folders in place; "Open in new window" writes a temp
   * `.code-workspace`. Because updateWorkspaceFolders / openFolder can reload the
   * window and tear down this webview mid-call, the response is sent BEFORE the
   * mutating command, mirroring the openInNewWindow handler's ordering.
   */
  private async handleWorkspaceActivate(
    requestId: string,
    payload: { readonly taskId?: string; readonly workspaceSetId?: string }
  ): Promise<void> {
    const target = await this.resolveActivationTarget(payload);
    const current = this.openFolderRoots();
    const currentKeys = new Set(current.map((root) => normalizePathKey(root)));
    const targetKeys = new Set(target.roots.map((root) => normalizePathKey(root)));
    const toAdd = target.roots.filter((root) => !currentKeys.has(normalizePathKey(root)));
    const toRemove = current.filter((root) => !targetKeys.has(normalizePathKey(root)));

    if (toAdd.length === 0 && toRemove.length === 0) {
      this.respond(requestId, { type: "workspace.activate", result: { outcome: "no-change", added: 0, removed: 0 } });
      void vscode.window.showInformationMessage(`"${target.name}" is already active.`);
      return;
    }

    // A named multi-root .code-workspace add/removes folders in place; only the
    // untitled (no workspaceFile) case reloads across the 1↔many boundary.
    const hasWorkspaceFile = vscode.workspace.workspaceFile !== undefined;
    const replaceReloads = !hasWorkspaceFile && this.crossesRootBoundary(current.length, target.roots.length);
    const appendedCount = current.length + toAdd.length;
    const appendReloads = !hasWorkspaceFile && this.crossesRootBoundary(current.length, appendedCount);

    const detail = this.buildActivateDetail(target, toAdd, toRemove, replaceReloads || appendReloads);
    const title = `Activate "${target.name}": +${String(toAdd.length)} folder(s), −${String(toRemove.length)} folder(s)`;
    const choice = await vscode.window.showInformationMessage(
      title,
      { modal: true, detail },
      "Replace",
      "Append",
      "Open in new window"
    );

    if (choice === undefined) {
      this.respond(requestId, { type: "workspace.activate", result: { outcome: "cancelled", added: 0, removed: 0 } });
      return;
    }

    if (choice === "Replace") {
      const result: WorkspaceActivateResult = {
        outcome: "replaced",
        added: toAdd.length,
        removed: toRemove.length,
        ...(replaceReloads ? { windowReload: true } : {})
      };
      // Respond before mutating: replacing the folder set can reload the window
      // and tear down this webview mid-response.
      this.respond(requestId, { type: "workspace.activate", result });
      vscode.workspace.updateWorkspaceFolders(
        0,
        current.length,
        ...target.roots.map((root) => ({ uri: vscode.Uri.file(root) }))
      );
      return;
    }

    if (choice === "Append") {
      const result: WorkspaceActivateResult = {
        outcome: "appended",
        added: toAdd.length,
        removed: 0,
        ...(appendReloads ? { windowReload: true } : {})
      };
      this.respond(requestId, { type: "workspace.activate", result });
      vscode.workspace.updateWorkspaceFolders(
        current.length,
        0,
        ...toAdd.map((root) => ({ uri: vscode.Uri.file(root) }))
      );
      return;
    }

    // "Open in new window": write a temp .code-workspace listing the target
    // folders and open it forceNewWindow. This window's chats keep running.
    const wsFile = await this.writeWorkspaceFile(target.name, target.roots);
    this.respond(requestId, { type: "workspace.activate", result: { outcome: "new-window", added: toAdd.length, removed: 0 } });
    void vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(wsFile), { forceNewWindow: true });
  }

  /**
   * Resolves the activation source to a display name + ordered target roots.
   * taskId → its linked workspace sets (exactly one → use it; zero → error;
   * multiple → the FIRST by link order, noted in the modal detail). workspaceSetId
   * → the set's mount roots directly.
   */
  private async resolveActivationTarget(
    payload: { readonly taskId?: string; readonly workspaceSetId?: string }
  ): Promise<{ readonly name: string; readonly roots: readonly string[]; readonly ambiguityNote?: string }> {
    const workspaceReview = this.requireWorkspaceReview();
    if (payload.taskId !== undefined) {
      const tasks = this.requireTasks();
      const summary = await this.requireTaskSummary(tasks, payload.taskId);
      const setIds = summary.linkedWorkspaceSetIds;
      if (setIds.length === 0) {
        throw new Error("This task has no linked workspace set to activate.");
      }
      const setId = setIds[0] as string;
      const roots = await workspaceReview.resolveWorkspaceSetRoots(setId);
      const setName = await this.workspaceSetName(setId);
      return {
        name: summary.title,
        roots,
        ...(setIds.length > 1 ? { ambiguityNote: `This task links ${String(setIds.length)} sets; activating the first ("${setName}").` } : {})
      };
    }
    const setId = payload.workspaceSetId as string;
    const roots = await workspaceReview.resolveWorkspaceSetRoots(setId);
    return { name: await this.workspaceSetName(setId), roots };
  }

  /** Best-effort workspace-set display name; falls back to the id prefix. */
  private async workspaceSetName(workspaceSetId: string): Promise<string> {
    try {
      const state = await this.requireWorkspaceReview().getPolicyState();
      return state.workspaceSets.find((set) => set.workspaceSetId === workspaceSetId)?.name
        ?? `${workspaceSetId.slice(0, 8)}…`;
    } catch {
      return `${workspaceSetId.slice(0, 8)}…`;
    }
  }

  /**
   * VS Code reloads an untitled (no workspaceFile) window when its folder count
   * crosses the single-folder ↔ multi-root boundary — i.e. 1→many, many→1, or
   * a 1→1 replacement of the sole root. Both counts on the same side of the
   * boundary (0/1 stays single-ish; ≥2 stays multi-root) are in-place.
   */
  private crossesRootBoundary(before: number, after: number): boolean {
    const wasSingle = before <= 1;
    const willBeSingle = after <= 1;
    // A 1→1 replace still reloads (the single root itself changes); 0→1 and 1→0
    // do not cross into multi-root and are handled in place by VS Code.
    if (wasSingle && willBeSingle) {
      return before === 1 && after === 1;
    }
    return wasSingle !== willBeSingle;
  }

  /** Modal detail: added/removed folder names (cap 6 each) plus an optional reload warning. */
  private buildActivateDetail(
    target: { readonly ambiguityNote?: string },
    toAdd: readonly string[],
    toRemove: readonly string[],
    reloads: boolean
  ): string {
    const lines: string[] = [];
    if (target.ambiguityNote !== undefined) {
      lines.push(target.ambiguityNote);
    }
    if (toAdd.length > 0) {
      lines.push(`Add: ${this.folderNameList(toAdd)}`);
    }
    if (toRemove.length > 0) {
      lines.push(`Remove: ${this.folderNameList(toRemove)}`);
    }
    if (reloads) {
      lines.push("⚠ This changes the window's workspace shape: VS Code will reload this window and live chats in THIS window will end (they may be adopted back on reload if their containers survive).");
    }
    return lines.join("\n");
  }

  /** Comma-joined basenames, capped at 6 with a "+K more" tail. */
  private folderNameList(roots: readonly string[]): string {
    const CAP = 6;
    const names = roots.map((root) => path.basename(root));
    if (names.length <= CAP) {
      return names.join(", ");
    }
    return `${names.slice(0, CAP).join(", ")}, +${String(names.length - CAP)} more`;
  }

  /**
   * Writes a `.code-workspace` file under `<stateRoot>/workspaces/` listing the
   * target folders, returning its path. The name is sanitized to a filesystem-safe
   * slug so an arbitrary task/set title can't escape the directory.
   */
  private async writeWorkspaceFile(name: string, roots: readonly string[]): Promise<string> {
    const dir = path.join(this.backend.stateRootPath, "workspaces");
    await mkdir(dir, { recursive: true });
    const safe = name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "workspace";
    const wsFile = path.join(dir, `${safe}.code-workspace`);
    const contents = JSON.stringify({ folders: roots.map((root) => ({ path: root })) }, null, 2);
    await writeFile(wsFile, contents, "utf8");
    return wsFile;
  }

  /** Turn results surface via bus pushes; failures here are protocol-level. */
  private runTurnDetached(appService: IsolatedRunService, sessionId: string, prompt: string, model?: ChatModelSelection): void {
    void appService.sendChatTurn(sessionId, prompt, model).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("chat turn failed to run", { sessionId, error: message });
      this.push({ type: "run.failed", message });
    });
  }

  /**
   * Auto-sends a continuation turn that tells the agent the access-request
   * outcome, but only when the session is live and idle — a busy or dead
   * session is left alone (the outcome is still visible in the panel). The
   * mount point is `/approved/<id>`, matching AccessRequestService.prepareApproval.
   */
  private autoContinueAfterAccess(approve: boolean, accessRequest: AccessRequestSummary): void {
    if (!this.backend.available) {
      return;
    }
    const appService = this.backend.appService;
    if (!appService.isChatSessionLive(accessRequest.sessionId) || appService.hasActiveChatTurn(accessRequest.sessionId)) {
      return;
    }
    const message = approve
      ? `[host] Access request approved: "${accessRequest.displayPath}" is mounted at "/approved/${accessRequest.accessRequestId}" (${accessRequest.mode}). Continue the task.`
      : `[host] Access request for "${accessRequest.displayPath}" was denied. Continue without it.`;
    this.runTurnDetached(appService, accessRequest.sessionId, message);
  }

  private async executeProbe(appService: IsolatedRunService): Promise<void> {
    try {
      const outcome = await appService.runAppServerProbe();
      this.push({
        type: "probe.completed",
        status: outcome.probe.status,
        diagnostics: [...outcome.probe.diagnostics, ...outcome.cleanupDiagnostics]
      });
    } catch (error) {
      this.push({ type: "run.failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      await this.pushInventory(appService);
    }
  }

  // MARK: Attention routing (Phase 3)

  /**
   * Adds an attention reason to a session and surfaces it: pushes the session's
   * current reasons, refreshes the badge, and — only on the transition from
   * no-attention to attention for that session — shows a hidden-panel toast.
   * The toast fires once per attention episode so consecutive flags on an
   * already-waiting session don't spam the user.
   */
  private async flagAttention(sessionId: string, reason: SessionAttentionReason, verb: string): Promise<void> {
    const existing = this.attention.get(sessionId);
    const wasWaiting = existing !== undefined && existing.size > 0;
    const reasons = existing ?? new Set<SessionAttentionReason>();
    const alreadyHadReason = reasons.has(reason);
    reasons.add(reason);
    this.attention.set(sessionId, reasons);
    if (!wasWaiting || !alreadyHadReason) {
      this.pushAttention(sessionId);
    }
    this.refreshAttentionBadge();
    // Toast only when the panel is hidden and this is a fresh attention episode.
    if (!wasWaiting && !this.view?.visible) {
      await this.showAttentionToast(sessionId, verb);
    }
  }

  /**
   * Removes specific reasons from a session (selection clears turn-attention).
   * When the set empties, the session is dropped. Pushes + rebadges only if the
   * set actually changed.
   */
  private clearAttention(sessionId: string, reasons: readonly SessionAttentionReason[]): void {
    const existing = this.attention.get(sessionId);
    if (existing === undefined) {
      return;
    }
    let changed = false;
    for (const reason of reasons) {
      if (existing.delete(reason)) {
        changed = true;
      }
    }
    if (!changed) {
      return;
    }
    if (existing.size === 0) {
      this.attention.delete(sessionId);
    }
    this.pushAttention(sessionId);
    this.refreshAttentionBadge();
  }

  /** Drops a session's attention entirely (deleted/ended) and re-announces empty. */
  private dropAttention(sessionId: string): void {
    if (!this.attention.delete(sessionId)) {
      return;
    }
    this.pushAttention(sessionId);
    this.refreshAttentionBadge();
  }

  /**
   * Clears a session's access-request attention once no PENDING requests remain
   * for it. Turn-attention is untouched. Queries current policy state.
   */
  private async clearAccessAttentionIfResolved(workspaceReview: WorkspaceReviewAppService, sessionId: string): Promise<void> {
    try {
      const state = await workspaceReview.getPolicyState();
      const stillPending = state.accessRequests.some(
        (accessRequest) => accessRequest.sessionId === sessionId && accessRequest.status === "pending"
      );
      if (!stillPending) {
        this.clearAttention(sessionId, ["access-request"]);
      }
    } catch (error) {
      this.logger.warn("access attention clear failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Seeds access-request attention for sessions with pending requests, once per
   * panel session. This lets a reloaded webview re-derive the badge for
   * requests that were already pending before this panel existed. Turn-attention
   * is ephemeral and intentionally not seeded.
   */
  private seedPendingAttention(accessRequests: readonly AccessRequestSummary[]): void {
    if (this.attentionSeeded) {
      return;
    }
    this.attentionSeeded = true;
    let changed = false;
    for (const accessRequest of accessRequests) {
      if (accessRequest.status !== "pending") {
        continue;
      }
      const reasons = this.attention.get(accessRequest.sessionId) ?? new Set<SessionAttentionReason>();
      if (!reasons.has("access-request")) {
        reasons.add("access-request");
        this.attention.set(accessRequest.sessionId, reasons);
        this.pushAttention(accessRequest.sessionId);
        changed = true;
      }
    }
    if (changed) {
      this.refreshAttentionBadge();
    }
  }

  /** Pushes a session's current attention reasons (empty when it was dropped). */
  private pushAttention(sessionId: string): void {
    const reasons = [...(this.attention.get(sessionId) ?? [])];
    this.push({ type: "session.attention", sessionId, reasons });
  }

  /**
   * The activity-bar badge = the number of sessions with ≥1 attention reason;
   * it clears (undefined) at zero so a settled queue leaves no stale "0".
   */
  private refreshAttentionBadge(): void {
    if (this.view === undefined) {
      return;
    }
    const waiting = this.attention.size;
    this.view.badge = waiting === 0
      ? undefined
      : { value: waiting, tooltip: `${waiting} session(s) waiting on you` };
  }

  /**
   * A hidden-panel toast for a freshly-flagged session. "Open" focuses the
   * control panel. The title comes from the session lookup, falling back to the
   * id prefix when the record can't be read.
   */
  private async showAttentionToast(sessionId: string, verb: string): Promise<void> {
    const title = await this.sessionTitle(sessionId);
    const choice = await vscode.window.showInformationMessage(`"${title}" ${verb}`, "Open");
    if (choice === "Open") {
      void vscode.commands.executeCommand("drydock.controlPanel.focus");
    }
  }

  /** Best-effort session title for a toast; falls back to the id prefix. */
  private async sessionTitle(sessionId: string): Promise<string> {
    const fallback = sessionId.slice(0, 8);
    if (!this.backend.available) {
      return fallback;
    }
    try {
      const sessions = await this.backend.appService.listChatSessions();
      return sessions.find((session) => session.sessionId === sessionId)?.title ?? fallback;
    } catch {
      return fallback;
    }
  }

  private async pushInventory(appService: IsolatedRunService): Promise<void> {
    try {
      // The redesign pushes only non-removed runtimes so torn-down generations
      // stop accumulating in the panel.
      const runtimes = (await appService.listPanelRuntimes()).map(toRuntimeSummary);
      this.push({ type: "runtime.inventory", runtimes });
    } catch (error) {
      this.logger.warn("control panel inventory refresh failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private requireBackend(): IsolatedRunService {
    if (!this.backend.available) {
      throw new Error(this.backend.reason);
    }
    return this.backend.appService;
  }

  private requireWorkspaceReview(): WorkspaceReviewAppService {
    if (!this.backend.available) {
      throw new Error(this.backend.reason);
    }
    return this.backend.workspaceReview;
  }

  private requireTasks(): TaskService {
    if (!this.backend.available) {
      throw new Error(this.backend.reason);
    }
    return this.backend.tasks;
  }

  private requireMemory(): MemoryService {
    if (!this.backend.available) {
      throw new Error(this.backend.reason);
    }
    return this.backend.memory;
  }

  private requireWorkInsights(): WorkInsightsAppService {
    if (!this.backend.available) {
      throw new Error(this.backend.reason);
    }
    return this.backend.workInsights;
  }

  private requirePlanDocs(): PlanDocsAppService {
    if (!this.backend.available) {
      throw new Error(this.backend.reason);
    }
    return this.backend.planDocs;
  }

  /** Refreshed summary (with current links) for one task after a mutation. */
  private async requireTaskSummary(tasks: TaskService, taskId: string): Promise<WorkTaskSummary> {
    const summary = (await tasks.listTaskSummaries()).find((candidate) => candidate.taskId === taskId);
    if (summary === undefined) {
      throw new Error(`Task ${taskId} was not found.`);
    }
    return summary;
  }

  private availability(): BackendAvailability {
    return this.backend.available
      ? { available: true, sbxDisplayPath: this.backend.sbxDisplayPath }
      : { available: false, reason: this.backend.reason };
  }

  private respond(requestId: string, payload: PanelResponsePayload): void {
    this.post({ protocolVersion: WEBVIEW_PROTOCOL_VERSION, kind: "response", requestId, ok: true, payload });
  }

  private respondError(requestId: string, message: string): void {
    this.post({ protocolVersion: WEBVIEW_PROTOCOL_VERSION, kind: "response", requestId, ok: false, error: { message } });
  }

  private push(payload: PanelPushPayload): void {
    this.sequence += 1;
    this.post({ protocolVersion: WEBVIEW_PROTOCOL_VERSION, kind: "push", sequence: this.sequence, payload });
  }

  private post(message: HostToWebviewMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("hex");
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "main.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "main.css"));
    // Strict CSP: no remote content, scripts only with this nonce, styles only
    // from the extension. Model output is rendered via textContent in the
    // webview script, never as HTML.
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri.toString()}">
  <title>Drydock</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}
