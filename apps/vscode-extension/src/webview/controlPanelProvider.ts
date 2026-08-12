/**
 * Shared webview dispatch bridge (formerly the Control Panel host).
 *
 * The four-tab Control Panel retired with UX overhaul P7; what it was really
 * carrying - one parsed, audited request dispatch over every backend service,
 * plus one push fan-out - stayed. Hosts register with `attachWebview` and share
 * it: the left rail views, the chat rail, and the Task Hub today, any future
 * surface tomorrow. This class owns no view of its own; it never renders HTML.
 *
 * This is still the trust boundary between webviews (untrusted renderers) and
 * the backend services: every inbound message passes through parsePanelRequest,
 * every outbound message is a typed envelope, responses go only to the host
 * that asked, and webviews only ever receive display-safe projections - never
 * runtime handles, secrets, or process APIs. Requests answer with a degraded
 * state instead of failing hard when the isolated runtime tooling is missing.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import {
  agentActivitySummaryOfTree,
  asId,
  parsePanelRequest,
  reduceAgentTree,
  summarizeAgentEvent,
  treeSourceFromEvent,
  WEBVIEW_PROTOCOL_VERSION,
  type AccessRequestSummary,
  type ActiveEditorRef,
  type AgentActivitySummary,
  type AgentEvent,
  type AgentTreeSource,
  type AgentQuestionRecord,
  type AgentQuestionSummary,
  type BackendAvailability,
  type ChatModelSelection,
  type ChatSessionRecord,
  type ChatSessionSummary,
  type ChatWorkspaceSelection,
  type HostToWebviewMessage,
  type HubState,
  type McpServerRecord,
  type McpServerSummary,
  type PanelInitState,
  type PanelPushPayload,
  type PanelRequest,
  type PanelResponsePayload,
  type PanelSurface,
  type PlanSummary,
  type RuntimeStatsSummary,
  type SessionAttentionReason,
  type WorkspaceActivateResult,
  type WorkTaskRecord,
  type WorkTaskSummary
} from "@drydock/contracts";
import { hostPathIdentityKey, sandboxRuntimePath, type AgentQuestionService, type Logger, type ProductBusEvent } from "@drydock/core";
import type { BoardService, McpRegistryService, MemoryService, SubtaskService, TaskService } from "@drydock/work-management";
import type { Backend, BackendReady } from "../compositionRoot.js";
import type { PlannerAppService } from "../services/plannerAppService.js";
import { buildBoardState, decorateTaskSummary, joinOpenCommentCounts, reconcileColumns } from "./boardShared.js";
import { buildHubState, hubTaskSessionIds, type HubMountInput, type HubRuntimeInput } from "./hubShared.js";
import { buildRecentChats, tasksBlockingWorkspaceSet, workspaceInUseMessage } from "./railShared.js";
import { promptAndSaveSubtaskSeedMode } from "./subtaskSeedPrompt.js";
import { promptAndSaveTaskClonePolicy } from "./taskClonePolicyPrompt.js";
import {
  toRuntimeSummary,
  type ChatWorkspaceContext,
  type IsolatedRunService
} from "../services/isolatedRunService.js";
import { ProviderConnectService } from "../services/providerConnectService.js";
import { productionSummaryOptions, toAccessRequestSummary, type WorkspaceReviewAppService } from "../services/workspaceReviewAppService.js";
import type { ValidationAppService } from "../services/validationAppService.js";
import { openBaselineDiff } from "./baselineDiff.js";
import { memoryUri } from "./memoryContentProvider.js";
import { memoryAnchorPorts, memoryTaskTitles, resolveMemoryEdits, toMemoryCandidateSummary } from "./memoryShared.js";

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
export function toAgentQuestionSummary(record: AgentQuestionRecord): AgentQuestionSummary {
  return {
    questionId: record.questionId,
    sessionId: record.sessionId,
    question: record.question,
    options: record.options,
    status: record.status,
    ...(record.answer === undefined ? {} : { answer: record.answer }),
    createdAt: record.createdAt,
    ...(record.kind === undefined ? {} : { kind: record.kind }),
    ...(record.steps === undefined ? {} : { steps: record.steps }),
    ...(record.images === undefined ? {} : { images: record.images }),
    ...(record.subtaskId === undefined ? {} : { subtaskId: record.subtaskId })
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
    columnId: record.columnId,
    ...(record.doneAt === undefined ? {} : { doneAt: record.doneAt }),
    linkedWorkspaceSetIds: [],
    linkedSessionIds: [],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    subtasks: []
  };
}

/** Display-safe registry row: env values NEVER cross to the webview - key names only. */
function toMcpServerSummary(record: McpServerRecord): McpServerSummary {
  return {
    serverId: record.serverId,
    name: record.name,
    command: record.command,
    args: record.args,
    envKeys: Object.keys(record.env),
    enabledByDefault: record.enabledByDefault,
    sensitive: record.sensitive,
    ...(record.notes === undefined ? {} : { notes: record.notes }),
    source: record.source
  };
}

/**
 * Opens a file reference the agent emitted in a markdown link. Handles a trailing
 * `:line[:col]`, external http(s) URLs (open in browser), and the sandbox
 * drive-mirror path form (`/c/Users/...` → `C:\Users\...`) so links to mounted
 * host folders open in the editor at the right line.
 */
export async function openAgentFileRef(ref: string): Promise<boolean> {
  const trimmed = ref.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    await vscode.env.openExternal(vscode.Uri.parse(trimmed));
    return true;
  }
  // Strip a trailing :line[:col] (anchored at the end so a Windows drive colon is safe).
  const suffix = /:(\d+)(?::(\d+))?$/.exec(trimmed);
  const rawPath = suffix ? trimmed.slice(0, suffix.index) : trimmed;
  const line = suffix ? Number(suffix[1]) : undefined;
  const col = suffix && suffix[2] !== undefined ? Number(suffix[2]) : undefined;
  const hostPath = runtimePathToHostPath(rawPath);
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(hostPath));
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    if (line !== undefined && Number.isFinite(line)) {
      const position = new vscode.Position(Math.max(0, line - 1), Math.max(0, (col ?? 1) - 1));
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }
    return true;
  } catch (error) {
    void vscode.window.showWarningMessage(`Couldn't open ${hostPath}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** Maps a sandbox drive-mirror path (`/c/Users/x`) back to its host path (`C:\Users\x`). */
function runtimePathToHostPath(runtimePath: string): string {
  const mirror = /^\/([a-zA-Z])\/(.*)$/.exec(runtimePath);
  if (mirror) {
    return `${mirror[1]!.toUpperCase()}:\\${mirror[2]!.replace(/\//g, "\\")}`;
  }
  return runtimePath;
}

/**
 * The single link target from a task.link/unlink payload. Contracts guarantee
 * exactly one of workspaceSetId/sessionId is present, so workspaceSetId is
 * preferred and sessionId is the else branch.
 */
function taskLinkTarget(payload: {
  readonly workspaceSetId?: string;
  readonly sessionId?: string;
  readonly subtaskId?: string;
}):
  | { readonly workspaceSetId: string }
  | { readonly sessionId: string; readonly subtaskId?: string } {
  return payload.workspaceSetId !== undefined
    ? { workspaceSetId: payload.workspaceSetId }
    // A session link narrowed by subtaskId belongs to that card rather than the
    // task itself; TaskService.link already stores the narrower target.
    : { sessionId: payload.sessionId as string, ...(payload.subtaskId === undefined ? {} : { subtaskId: payload.subtaskId }) };
}

/**
 * A session runs "elsewhere" when it is stored active/starting, is not live
 * in this host process, carries a fresh heartbeat, and is owned by a
 * different host instance (ADR 0008). Exported so every surface (sidebar,
 * Agents panel) applies the identical read-only posture test.
 */
export function isSessionRunningElsewhere(appService: IsolatedRunService, record: ChatSessionRecord): boolean {
  const storedActive = record.status === "active" || record.status === "starting";
  return storedActive
    && !appService.isChatSessionLive(record.sessionId)
    && appService.isHeartbeatFresh(record.heartbeatAt)
    && record.hostInstanceId !== undefined
    && record.hostInstanceId !== appService.hostInstanceId;
}

/**
 * `panel.openSurface` → the command that already opens that surface. The
 * webview names a surface from a closed enum; only this table turns one into a
 * command string, so a webview can never reach an arbitrary command.
 */
const SURFACE_COMMANDS: Readonly<Record<PanelSurface, string>> = {
  hub: "drydock.taskHub.open",
  board: "drydock.taskBoard.open",
  agents: "drydock.agents.open",
  planner: "drydock.planner.open",
  review: "drydock.taskReview.open",
  configure: "drydock.configure.open"
};

export class ControlPanelProvider {
  /** Previews whose untrusted-content notice has already been shown. */
  private readonly previewNoticeShown = new Set<string>();
  private sequence = 0;
  /**
   * Per-session "waiting on you" reasons. Drives the `session.attention` push
   * and the hidden-host toast. A session with an empty set is dropped entirely
   * so downstream counts only include sessions that still need the user. (The
   * native activity-bar badge is the Tasks rail's, folded from the same bus
   * events in `railViewProvider.ts`.)
   */
  private readonly attention = new Map<string, Set<SessionAttentionReason>>();
  /** Seeded once so a reloaded webview re-derives startup pending-request attention. */
  private attentionSeeded = false;
  /** Seeded independently when a host first requests pending questions. */
  private questionAttentionSeeded = false;
  /**
   * Live subagent summaries per session, folded from the bus agent-events this
   * host streams. Sessions running in another window stream nothing here, so
   * their chip stays empty (read-only posture).
   */
  private readonly agentActivity = new Map<string, { sources: AgentTreeSource[] }>();
  /**
   * A session another surface (the Agents panel) asked us to show before any
   * host booted. Hosts always fetch session.list on boot; the pending
   * navigation flushes as a panel.showSession push right after that response,
   * so it can never race a not-yet-listening document (the planner's
   * pendingShowPlanId pattern).
   */
  private pendingShowSession: { readonly sessionId: string; readonly nodeId?: string } | null = null;
  /**
   * The webviews hosting this protocol (one handler, many hosts): they share
   * the request dispatch and receive every push, but their responses go back to
   * whichever host asked. The value reports whether that host is on screen -
   * only view-backed hosts can answer, so the default is "not visible".
   */
  private readonly attachedWebviews = new Map<vscode.Webview, () => boolean>();
  /** In-flight request -> the host that sent it. */
  private readonly responseTargets = new Map<string, vscode.Webview>();
  /** Guided host-side provider sign-in flows (built lazily; needs vscode.env). */
  private connectService: ProviderConnectService | null = null;
  /** Auto-detection for terminal login flows: poll + close listener per provider. */
  private readonly loginWatchers = new Map<string, () => void>();

  constructor(
    private readonly backend: Backend,
    private readonly logger: Logger
  ) {
    if (backend.available) {
      // The subscription lives for the extension lifetime; push() is a no-op
      // while nothing is attached.
      backend.bus.subscribe((event) => this.onBusEvent(event));
    }
    // Surface the active editor so the composer can offer it as a one-click
    // attachment. push() no-ops while nothing is attached, so this is cheap.
    vscode.window.onDidChangeActiveTextEditor(() => {
      this.push({ type: "editor.active", editor: this.activeEditorRef() ?? null });
    });
    // `auto` workspace choices and their labels must follow this window, not the
    // folder list captured when the webview first booted.
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.push({ type: "workspace.folders", openFolderNames: this.openFolderNames() });
    });
  }

  /**
   * Navigation entry point for other surfaces (the Agents panel): reveal the
   * chat rail and land it on this session (nodeId → Agents lens). With no live
   * host yet, the navigation parks until a fresh one's boot session.list proves
   * it is listening.
   */
  showSession(sessionId: string, nodeId?: string): void {
    const target = { sessionId, ...(nodeId === undefined ? {} : { nodeId }) };
    // Focus is best-effort: the push is what carries the navigation. The chat
    // rail is the only chat host now that the Control Panel has retired.
    void vscode.commands.executeCommand("drydock.chatRail.focus").then(undefined, () => undefined);
    if (this.attachedWebviews.size === 0) {
      this.pendingShowSession = target;
      return;
    }
    this.push({ type: "panel.showSession", ...target });
  }

  /** The active file-scheme editor as a display-safe ref, or undefined. */
  private activeEditorRef(): ActiveEditorRef | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri === undefined || uri.scheme !== "file") return undefined;
    return { path: uri.fsPath, name: path.basename(uri.fsPath) };
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
      case "planner-changed":
        // Coarse planner invalidation: plan surfaces refetch planner.plans.
        this.push({ type: "planner.changed", planId: event.planId });
        return;
      case "planner-session-started":
        // A plan session booted (any surface): plan surfaces pick up its rail.
        this.push({ type: "planner.sessionReady", planId: event.planId, sessionId: event.sessionId, ok: true });
        return;
      case "access-requested":
        // Detected agent access requests arrive here; forward the display-safe
        // summary as its own push and flag the session for attention (badge +
        // hidden-panel toast). The badge derives from attention reasons now, so
        // no separate pending-request query is needed here.
        // The production classifier rides along so the card knows whether
        // approval means a mount or a session-scoped snapshot (ADR 0022 F3).
        this.push({
          type: "policy.accessRequested",
          accessRequest: toAccessRequestSummary(event.request, this.productionClassifier())
        });
        void this.flagAttention(event.request.sessionId, "access-request", "needs access approval");
        return;
      case "preview-available":
        this.push({ type: "preview.available", preview: event.preview });
        return;
      case "question-asked":
        // A pending agent question is a standing "waiting on you" item: stack
        // card in the panel, badge + toast via the attention path.
        this.push({ type: "question.asked", question: toAgentQuestionSummary(event.question) });
        void this.flagAttention(event.question.sessionId, "question", "asked a question");
        return;
      case "question-resolved":
        // Resolutions may originate in any surface (including FAQ automation),
        // so the bus is the single source for removing cards and attention.
        this.push({ type: "question.resolved", question: toAgentQuestionSummary(event.question) });
        void this.settleQuestionAttention(event.question.sessionId);
        return;
      case "memory-candidate-added":
        // A proposed memory is not urgent: forward the display-safe summary as
        // its own push, but do NOT flag the session for attention.
        this.push({ type: "memory.candidateAdded", candidate: toMemoryCandidateSummary(event.candidate) });
        return;
      case "board-changed":
        // Coarse board-mutation signal (subtask service, orchestrator cascade,
        // board panel edits): the Work tab refetches board.state off this push.
        this.push({ type: "board.changed" });
        return;
      case "active-task-changed":
        // The spine moved (any surface): every host retargets off this push.
        this.push({ type: "activeTask", activeTaskId: event.taskId });
        return;
      case "boot-progress":
        // One stage of a session boot (UX overhaul P4). Straight relay: the
        // hub composer's timeline and the rail's reconnect spinner decide what
        // to light; a stage nobody is watching costs a discarded message.
        this.push({ type: "chat.bootProgress", sessionId: event.sessionId, stage: event.stage });
        return;
      case "inventory-changed":
        if (this.backend.available) {
          void this.pushInventory(this.backend.appService);
        }
        return;
      // ADR 0022: validation is three pushes - one job moved, the registry
      // moved, or a runtime was quarantined. The chip re-renders off the first,
      // the rail dot off the second, and the F5 banner off the third.
      case "validation-job-changed":
        this.push({
          type: "validation.jobChanged",
          jobId: String(event.jobId),
          state: event.state,
          ...(event.taskId === undefined ? {} : { taskId: String(event.taskId) }),
          ...(event.sessionId === undefined ? {} : { sessionId: String(event.sessionId) })
        });
        return;
      case "validation-runtime-changed":
        this.push({ type: "validation.changed" });
        return;
      case "validation-quarantine": {
        const validation = this.backend.available ? this.backend.validation : undefined;
        const runtimeId = String(event.runtimeId);
        void (validation?.displayNameFor(runtimeId) ?? Promise.resolve(runtimeId))
          .then((displayName) => {
            this.push({
              type: "validation.quarantine",
              runtimeId,
              displayName,
              probeId: event.probeId,
              detail: event.detail,
              at: event.at
            });
          })
          .catch(() => { /* best effort: the next state read still carries it */ });
        return;
      }
    }
  }

  /**
   * Registers a webview on this protocol. Its messages run through the same
   * parse + dispatch path (its responses come back to it, never to a sibling
   * host) and it receives every push. Disposing detaches it.
   *
   * `isVisible` lets a view-backed host report whether it is on screen, which
   * is what suppresses the redundant attention toast for a surface the user is
   * already looking at. Hosts that cannot answer are treated as hidden.
   */
  attachWebview(webview: vscode.Webview, isVisible: () => boolean = () => false): { dispose(): void } {
    this.attachedWebviews.set(webview, isVisible);
    const subscription = webview.onDidReceiveMessage((raw: unknown) => {
      void this.onMessage(raw, webview);
    });
    return {
      dispose: () => {
        subscription.dispose();
        this.attachedWebviews.delete(webview);
      }
    };
  }

  /** `origin` is the host that sent this message. */
  private async onMessage(raw: unknown, origin?: vscode.Webview): Promise<void> {
    const request = parsePanelRequest(raw);
    if (!request) {
      this.logger.warn("control panel dropped a malformed webview message");
      return;
    }
    if (origin !== undefined) {
      this.responseTargets.set(request.requestId, origin);
    }
    try {
      await this.handleRequest(request);
    } catch (error) {
      this.respondError(request.requestId, error instanceof Error ? error.message : String(error));
    } finally {
      this.responseTargets.delete(request.requestId);
    }
  }

  private async handleRequest(request: PanelRequest): Promise<void> {
    const payload = request.payload;
    switch (payload.type) {
      case "panel.init": {
        const runtimes = this.backend.available
          ? (await this.backend.appService.listPanelRuntimes()).map(toRuntimeSummary)
          : [];
        const activeEditor = this.activeEditorRef();
        const state: PanelInitState = {
          availability: this.availability(),
          runtimes,
          providerCatalogs: this.backend.available ? this.backend.appService.listChatProviderCatalogs() : [],
          stateRootDisplayPath: this.backend.stateRootPath,
          openFolderNames: this.openFolderNames(),
          ...(activeEditor !== undefined ? { activeEditor } : {}),
          agentIdleThresholdMs: this.agentIdleThresholdMs(),
          codeBlockWordWrap: this.codeBlockWordWrap()
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
      case "clipboard.writeText": {
        await vscode.env.clipboard.writeText(payload.text);
        this.respond(request.requestId, { type: "clipboard.writeText", accepted: true });
        return;
      }
      case "isolatedRun.listRuntimes": {
        const appService = this.requireBackend();
        const runtimes = (await appService.listPanelRuntimes(payload.includeRemoved ?? false)).map(toRuntimeSummary);
        this.respond(request.requestId, { type: "isolatedRun.listRuntimes", runtimes });
        return;
      }
      case "runtime.reconcile": {
        const appService = this.requireBackend();
        if (!this.backend.available) {
          throw new Error("Docker Sandbox is not available in this window.");
        }
        // Reconciles inventory against `sbx ls`: reaps orphaned quarantined/lost
        // rows (their sandbox is gone) and purges old removed rows.
        await this.backend.reconcileOnActivate();
        this.respond(request.requestId, { type: "runtime.reconcile", accepted: true });
        await this.pushInventory(appService);
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
      case "chat.start": {
        const appService = this.requireBackend();
        this.push({ type: "chat.startProgress", message: "Resolving the selected workspace…" });
        const workspace = await this.resolveWorkspace(payload.workspace);
        const started = await appService.startChat(
          payload.prompt,
          payload.model,
          workspace,
          undefined,
          (message) => this.push({ type: "chat.startProgress", message })
        );
        if (payload.taskId !== undefined) {
          await this.requireTasks().link(payload.taskId, { sessionId: started.session.sessionId });
        }
        this.push({ type: "chat.startProgress", message: "Capturing the workspace change baseline…" });
        await this.baselineWorkspaceSession(started.session.sessionId, workspace);
        this.push({ type: "run.started", isolation: started.isolation });
        this.push({ type: "provider.models", providerCatalogs: started.providerCatalogs });
        this.respond(request.requestId, { type: "chat.start", session: this.decorateSessionSummary(started.session) });
        this.runTurnDetached(appService, started.session.sessionId, payload.prompt, payload.model);
        return;
      }
      case "chat.startSession": {
        const appService = this.requireBackend();
        this.push({ type: "chat.startProgress", message: "Resolving the selected workspace…" });
        const workspace = await this.resolveWorkspace(payload.workspace);
        const started = await appService.startChatSession(
          payload.model,
          payload.title,
          workspace,
          (message) => this.push({ type: "chat.startProgress", message })
        );
        // Link before replying so a reload while the webview awaits sandbox boot
        // cannot leave the newly durable chat orphaned from its task.
        if (payload.taskId !== undefined) {
          await this.requireTasks().link(payload.taskId, { sessionId: started.session.sessionId });
        }
        this.push({ type: "chat.startProgress", message: "Capturing the workspace change baseline…" });
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
        const approvedRoots = await this.requireWorkspaceReview().approvedAccessRoots(payload.sessionId);
        const resumed = await appService.resumeChatSession(payload.sessionId, payload.model, workspace, false, approvedRoots);
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
      case "chat.reclaim": {
        const appService = this.requireBackend();
        if (appService.isChatSessionLive(payload.sessionId)) {
          // Already ours in this window - nothing to take over.
          throw new Error("This session is already live in this window.");
        }
        const approvedRoots = await this.requireWorkspaceReview().approvedAccessRoots(payload.sessionId);
        // A model carries only for a forced provider switch of an active session;
        // omitted, reclaim keeps the session's own provider.
        const reclaimed = await appService.reclaimChatSession(payload.sessionId, payload.model, approvedRoots);
        await this.baselineWorkspaceSession(reclaimed.session.sessionId, undefined);
        this.push({ type: "run.started", isolation: reclaimed.isolation });
        this.push({ type: "provider.models", providerCatalogs: reclaimed.providerCatalogs });
        this.respond(request.requestId, {
          type: "chat.reclaim",
          session: this.decorateSessionSummary(reclaimed.session),
          providerCatalogs: reclaimed.providerCatalogs
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
      case "ui.confirm": {
        // Native modal confirmation for a destructive/irreversible webview action.
        const choice = await vscode.window.showWarningMessage(
          payload.message,
          { modal: true, ...(payload.detail === undefined ? {} : { detail: payload.detail }) },
          payload.confirmLabel
        );
        this.respond(request.requestId, { type: "ui.confirm", confirmed: choice === payload.confirmLabel });
        return;
      }
      case "chat.poke": {
        const appService = this.requireBackend();
        // Soft nudge for a quiet turn - a graceful turn/interrupt that keeps the
        // session/container alive. `poked` is false when there's nothing to poke.
        const poked = await appService.pokeChatTurn(payload.sessionId);
        this.respond(request.requestId, { type: "chat.poke", poked });
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
        if (this.pendingShowSession !== null) {
          // The webview is provably alive (it just asked); deliver the
          // navigation another surface queued before the view existed.
          this.push({ type: "panel.showSession", ...this.pendingShowSession });
          this.pendingShowSession = null;
        }
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
        // An explicit Recheck / "Refresh models" (force) re-probes auth AND
        // requeries every provider's live model list, bypassing the TTL.
        const providerCatalogs = await appService.refreshHostProviderCatalogs(
          payload.force === true ? { force: true } : undefined
        );
        this.respond(request.requestId, { type: "provider.list", providerCatalogs });
        return;
      }
      case "provider.login": {
        const appService = this.requireBackend();
        // Guided first: Drydock drives the host-side flow itself (URL opens in
        // the browser, paste-back lands in the connect card, status flips
        // automatically). Terminal is the fallback, now with auto-detection.
        const connect = this.requireConnectService(appService);
        const begun = connect.begin(payload.providerId);
        if (begun.mode === "guided") {
          this.respond(request.requestId, { type: "provider.login", providerId: payload.providerId, launched: begun.display, mode: "guided" });
          return;
        }
        // loginCommand re-enforces the interactive/network policy and yields
        // the spawnable terminal pieces; the flow stays user-driven in a
        // visible terminal so no credential passes through the extension.
        const login = appService.loginCommand(payload.providerId);
        const terminal = vscode.window.createTerminal({
          name: `${payload.providerId} login`,
          shellPath: login.command,
          shellArgs: [...login.args]
        });
        terminal.show();
        this.watchTerminalLogin(payload.providerId, terminal);
        this.respond(request.requestId, { type: "provider.login", providerId: payload.providerId, launched: login.display, mode: "terminal" });
        return;
      }
      case "provider.submitCode": {
        const appService = this.requireBackend();
        const accepted = this.requireConnectService(appService).submitCode(payload.providerId, payload.code);
        this.respond(request.requestId, { type: "provider.submitCode", providerId: payload.providerId, accepted });
        return;
      }
      case "provider.submitApiKey": {
        const appService = this.requireBackend();
        const authStatus = await this.requireConnectService(appService).submitApiKey(payload.providerId, payload.apiKey);
        this.push({ type: "provider.models", providerCatalogs: appService.listChatProviderCatalogs() });
        this.respond(request.requestId, {
          type: "provider.submitApiKey",
          providerId: payload.providerId,
          authStatus,
          ...(authStatus === "authenticated" ? {} : { message: "The key was stored but the auth probe has not confirmed it yet. Click Recheck." })
        });
        return;
      }
      case "provider.cancelLogin": {
        const appService = this.requireBackend();
        const cancelled = this.requireConnectService(appService).cancel(payload.providerId);
        this.loginWatchers.get(payload.providerId)?.();
        this.respond(request.requestId, { type: "provider.cancelLogin", providerId: payload.providerId, cancelled });
        return;
      }
      case "runtime.sbxLogin": {
        if (!this.backend.available) {
          throw new Error("Docker Sandbox is not available in this window.");
        }
        const appService = this.requireBackend();
        appService.assertInteractiveSetupAllowed("Docker Sandbox sign-in");
        // Interactive Docker Sandbox sign-in in a visible terminal: `sbx login`
        // drives its own OAuth flow; no secret passes through the extension.
        const sbxPath = this.backend.sbxDisplayPath;
        const terminal = vscode.window.createTerminal({ name: "Docker Sandbox login", shellPath: sbxPath, shellArgs: ["login"] });
        terminal.show();
        this.respond(request.requestId, { type: "runtime.sbxLogin", launched: `${sbxPath} login` });
        return;
      }
      case "runtime.openTerminal": {
        const appService = this.requireBackend();
        if (!this.backend.available) {
          throw new Error("Docker Sandbox is not available in this window.");
        }
        appService.assertRuntimeTerminalAllowed();
        // A real VS Code terminal INTO the chat's container, so the developer can
        // watch/interrupt what the agent is running (e.g. a hung command).
        const runtime = (await appService.listRuntimes())
          .find((record) => record.sessionId === payload.sessionId && record.status === "running");
        if (runtime === undefined) {
          throw new Error("This chat has no running container yet. Send a message to start it, then open the terminal.");
        }
        const terminal = vscode.window.createTerminal({
          name: `Container · ${runtime.externalName}`,
          shellPath: this.backend.sbxDisplayPath,
          shellArgs: ["exec", runtime.externalName, "/bin/bash"]
        });
        terminal.show();
        this.respond(request.requestId, { type: "runtime.openTerminal", accepted: true });
        return;
      }
      case "chat.rawStream": {
        if (!this.backend.available) {
          throw new Error("Docker Sandbox is not available in this window.");
        }
        // Debug view: the current (or last) turn's raw agent stream, captured
        // in-memory only. Null snapshot = no turn has run in this window yet.
        const snapshot = this.backend.rawStreamStore.snapshot(payload.sessionId);
        this.respond(request.requestId, {
          type: "chat.rawStream",
          text: snapshot?.text ?? "",
          lastChunkAt: snapshot?.lastChunkAt ?? null
        });
        return;
      }
      case "chat.runtimeStats": {
        const appService = this.requireBackend();
        const stats = await appService.sampleSessionStats(payload.sessionId);
        this.respond(request.requestId, { type: "chat.runtimeStats", stats });
        return;
      }
      case "chat.openFile": {
        const opened = await openAgentFileRef(payload.path);
        this.respond(request.requestId, { type: "chat.openFile", opened });
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
      case "session.summarize": {
        const appService = this.requireBackend();
        if (payload.mode === "log") {
          // Host-side clipboard write: the log can exceed the webview→host
          // clipboard request bound, and the host API takes any string.
          await vscode.env.clipboard.writeText(await appService.buildChatLogExport(payload.sessionId));
          this.respond(request.requestId, { type: "session.summarize", sessionId: payload.sessionId, mode: "log", accepted: true });
          return;
        }
        // AI mode: a model turn can outlive the webview request timeout, so
        // ack now and deliver the outcome as a push. The clipboard is written
        // here regardless of whether the panel is still listening.
        this.respond(request.requestId, { type: "session.summarize", sessionId: payload.sessionId, mode: "ai", accepted: true });
        void appService
          .generateChatSummary(payload.sessionId)
          .then(async (summary) => {
            await vscode.env.clipboard.writeText(summary);
            this.push({ type: "session.summaryReady", sessionId: payload.sessionId, ok: true });
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn("chat AI summary failed", { sessionId: payload.sessionId, error: message });
            this.push({ type: "session.summaryReady", sessionId: payload.sessionId, ok: false, error: message });
          });
        return;
      }
      case "session.recents": {
        // The rail's Recents list: one row per task, host-deduped so the
        // webview never has to join sessions to tasks itself.
        const appService = this.requireBackend();
        const [sessions, tasks] = await Promise.all([
          appService.listChatSessions(),
          this.requireTasks().listTaskSummaries()
        ]);
        const recents = buildRecentChats(
          await this.decorateTasks(tasks),
          sessions.map((session) => {
            const summary = this.decorateSessionSummary(session);
            return {
              sessionId: summary.sessionId,
              title: summary.title,
              status: summary.status,
              ...(summary.live === undefined ? {} : { live: summary.live }),
              ...(summary.runningElsewhere === undefined ? {} : { runningElsewhere: summary.runningElsewhere }),
              updatedAt: summary.updatedAt
            };
          }),
          {
            ...(payload.limit === undefined ? {} : { limit: payload.limit }),
            attentionSessionIds: await this.attentionSessionIds()
          }
        );
        this.respond(request.requestId, { type: "session.recents", recents });
        return;
      }
      case "task.list": {
        const backend = this.requireBackendReady();
        const tasks = await joinOpenCommentCounts(backend, this.logger, await this.requireTasks().listTaskSummaries());
        const columnsById = new Map((await this.requireBoard().listColumns()).map((column) => [column.columnId, column]));
        const decorated = await Promise.all(tasks.map((task) => decorateTaskSummary(backend, task, columnsById)));
        this.respond(request.requestId, { type: "task.list", tasks: decorated });
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
          ...(payload.state === undefined ? {} : { state: payload.state }),
          ...(payload.autoAnswerFaq === undefined ? {} : { autoAnswerFaq: payload.autoAnswerFaq })
        });
        const summary = await this.requireTaskSummary(tasks, payload.taskId);
        this.respond(request.requestId, { type: "task.update", task: summary });
        this.push({ type: "task.updated", task: summary });
        return;
      }
      case "task.faq.list": {
        const faqs = await this.requireTasks().listFaqs(payload.taskId);
        this.respond(request.requestId, { type: "task.faq.list", faqs });
        return;
      }
      case "task.faq.add": {
        const tasks = this.requireTasks();
        await tasks.addFaq(payload.taskId, payload.pattern, payload.answer);
        this.respond(request.requestId, { type: "task.faq.add", faqs: await tasks.listFaqs(payload.taskId) });
        return;
      }
      case "task.faq.remove": {
        const tasks = this.requireTasks();
        await tasks.removeFaq(payload.taskId, payload.faqId);
        this.respond(request.requestId, { type: "task.faq.remove", faqs: await tasks.listFaqs(payload.taskId) });
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
      case "active.get": {
        this.respond(request.requestId, { type: "active.get", activeTaskId: this.requireBackendReady().activeTasks.get() });
        return;
      }
      case "active.set": {
        // The service publishes active-task-changed, which becomes the push.
        const activeTasks = this.requireBackendReady().activeTasks;
        activeTasks.set(payload.taskId === null ? null : asId<"TaskId">(payload.taskId));
        this.respond(request.requestId, { type: "active.set", activeTaskId: activeTasks.get() });
        return;
      }
      case "question.list": {
        const questions = await this.requireQuestions().listQuestions("pending");
        this.respond(request.requestId, { type: "question.list", questions: questions.map(toAgentQuestionSummary) });
        this.seedPendingQuestionAttention(questions);
        return;
      }
      case "question.answer": {
        const service = this.requireQuestions();
        const record = await service.answer(asId<"AgentQuestionId">(payload.questionId), payload.answer);
        // The answer returns to the agent as a host-authored follow-up turn -
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
        this.respond(request.requestId, { type: "question.answer", question: toAgentQuestionSummary(record), dispatched });
        return;
      }
      case "question.dismiss": {
        const record = await this.requireQuestions().dismiss(asId<"AgentQuestionId">(payload.questionId));
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
      case "memory.list": {
        const titles = await this.taskTitleMap();
        const candidates = (await this.requireMemory().listCandidates()).map((record) => toMemoryCandidateSummary(record, titles));
        // Suggestion chips for quick-add: tags detected in the open folders.
        const detectedTags = await this.requireBackend().tagsForRoots(this.openFolderRoots()).catch(() => [] as string[]);
        this.respond(request.requestId, { type: "memory.list", candidates, detectedTags });
        return;
      }
      case "memory.resolve": {
        const edits = await resolveMemoryEdits(
          memoryAnchorPorts(this.requireBackendReady()),
          payload.memoryCandidateId,
          payload.edits,
          this.openFolderRoots()
        );
        const record = await this.requireMemory().resolve(payload.memoryCandidateId, payload.approve, edits);
        this.respond(request.requestId, { type: "memory.resolve", candidate: toMemoryCandidateSummary(record, await this.taskTitleMap()) });
        return;
      }
      case "memory.add": {
        const record = await this.requireMemory().addUserMemory({
          content: payload.content,
          scope: payload.scope,
          ...(payload.taskId === undefined ? {} : { taskId: payload.taskId }),
          roots: this.openFolderRoots(),
          ...(payload.tags === undefined ? {} : { tags: payload.tags })
        });
        this.respond(request.requestId, { type: "memory.add", candidate: toMemoryCandidateSummary(record, await this.taskTitleMap()) });
        return;
      }
      case "memory.delete": {
        await this.requireMemory().deleteMemory(payload.memoryCandidateId);
        this.respond(request.requestId, { type: "memory.delete", memoryCandidateId: payload.memoryCandidateId });
        return;
      }
      case "mcp.list": {
        const servers = (await this.requireMcp().listServers()).map(toMcpServerSummary);
        const overrides = await this.requireMcp().listOverrides();
        this.respond(request.requestId, { type: "mcp.list", servers, overrides });
        return;
      }
      case "mcp.save": {
        await this.requireMcp().saveServer(payload.server);
        const servers = (await this.requireMcp().listServers()).map(toMcpServerSummary);
        this.respond(request.requestId, { type: "mcp.save", servers });
        void this.requireBackend().refreshMcpConfigForLiveSessions();
        return;
      }
      case "mcp.delete": {
        await this.requireMcp().deleteServer(payload.serverId);
        const servers = (await this.requireMcp().listServers()).map(toMcpServerSummary);
        this.respond(request.requestId, { type: "mcp.delete", servers });
        void this.requireBackend().refreshMcpConfigForLiveSessions();
        return;
      }
      case "mcp.setOverride": {
        await this.requireMcp().setOverride(payload.scope, payload.refId, payload.serverId, payload.state);
        const overrides = await this.requireMcp().listOverrides();
        this.respond(request.requestId, { type: "mcp.setOverride", overrides });
        // A session toggle refreshes just that sandbox; broader scopes sweep live ones.
        if (payload.scope === "session") {
          void this.requireBackend().refreshMcpConfig(payload.refId);
        } else {
          void this.requireBackend().refreshMcpConfigForLiveSessions();
        }
        return;
      }
      case "chat.contextDebug": {
        const markdown = await this.requireBackend().composeContextDebug(payload.sessionId);
        const document = await vscode.workspace.openTextDocument({ language: "markdown", content: markdown });
        await vscode.window.showTextDocument(document, { preview: false });
        this.respond(request.requestId, { type: "chat.contextDebug", accepted: true });
        return;
      }
      case "memory.open": {
        const candidate = await this.requireMemory().getCandidate(payload.memoryCandidateId);
        if (candidate === null) {
          throw new Error(`Memory candidate ${payload.memoryCandidateId} was not found.`);
        }
        const document = await vscode.workspace.openTextDocument(memoryUri(candidate.memoryCandidateId));
        await vscode.window.showTextDocument(document, { preview: true });
        this.respond(request.requestId, { type: "memory.open", accepted: true });
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
        const state = await this.requireWorkspaceReview().createWorkspaceSet(payload.name, payload.members);
        this.respond(request.requestId, { type: "workspace.createSet", state });
        return;
      }
      case "workspace.updateSet": {
        const state = await this.requireWorkspaceReview().updateWorkspaceSet(payload.workspaceSetId, payload.name, payload.members);
        this.respond(request.requestId, { type: "workspace.updateSet", state });
        return;
      }
      case "workspace.deleteSet": {
        const review = this.requireWorkspaceReview();
        const state = await review.getPolicyState();
        const set = state.workspaceSets.find((candidate) => candidate.workspaceSetId === payload.workspaceSetId);
        await this.assertWorkspaceSetsFree(
          [payload.workspaceSetId],
          `Workspace set "${set?.name ?? payload.workspaceSetId}"`
        );
        this.respond(request.requestId, { type: "workspace.deleteSet", state: await review.deleteWorkspaceSet(payload.workspaceSetId) });
        return;
      }
      case "workspace.removeProject": {
        // Removing a root removes it from every set that carries it, so the
        // same live-mount guard applies to all of those sets.
        const review = this.requireWorkspaceReview();
        const state = await review.getPolicyState();
        const project = state.projects.find((candidate) => candidate.projectId === payload.projectId);
        const setIds = state.workspaceSets
          .filter((set) => set.members.some((member) => member.projectId === payload.projectId))
          .map((set) => set.workspaceSetId);
        await this.assertWorkspaceSetsFree(setIds, `Folder "${project?.name ?? payload.projectId}"`);
        this.respond(request.requestId, { type: "workspace.removeProject", state: await review.removeProject(payload.projectId) });
        return;
      }
      case "workspace.updateProjectPath": {
        const state = await this.requireWorkspaceReview().updateProjectPath(payload.projectId, payload.path);
        this.respond(request.requestId, { type: "workspace.updateProjectPath", state });
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
        // Approval already applied the mount before marking the request approved;
        // denial is persisted immediately. Once no pending requests remain, clear
        // attention and nudge the live session with the outcome.
        await this.onAccessResolved(workspaceReview, accessRequest, payload.approve);
        return;
      }
      case "diff.snapshotWorkspace": {
        const baselineIds = await this.requireWorkspaceReview().snapshotWorkspace(payload.workspaceSetId);
        this.respond(request.requestId, { type: "diff.snapshotWorkspace", baselineIds });
        return;
      }
      case "diff.status": {
        const changes = await this.requireWorkspaceReview().diffStatus(payload.sessionId, payload.view);
        this.respond(request.requestId, { type: "diff.status", changes });
        return;
      }
      case "diff.acceptFile": {
        const changes = await this.requireWorkspaceReview().acceptFile(payload.baselineId, payload.path, payload.view);
        this.respond(request.requestId, { type: "diff.acceptFile", changes });
        return;
      }
      case "diff.revertFile": {
        const changes = await this.requireWorkspaceReview().revertFile(payload.baselineId, payload.path, payload.view);
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
      case "taskReview.open": {
        // Editor-panel open is a host action; route through the command.
        if (payload.startGuide !== true) this.requireBackend();
        await vscode.commands.executeCommand("drydock.taskReview.open", payload.taskId, {
          startGuide: payload.startGuide === true
        });
        this.respond(request.requestId, { type: "taskReview.open", accepted: true });
        return;
      }
      case "codeReview.open": {
        // Editor-panel open is a host action; route through the command.
        this.requireBackend();
        await vscode.commands.executeCommand("drydock.codeReview.open", payload.taskId);
        this.respond(request.requestId, { type: "codeReview.open", accepted: true });
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
        // Landing (ADR 0014): a full pull moved this session's captured output
        // into local HEAD, so its changesets stop seeding dependents. Per-file
        // pulls never land (the sync base did not advance). Bookkeeping only -
        // a failure logs and never un-pulls.
        if (payload.path === undefined && this.backend.available) {
          void this.backend.changesets.markLandedBySession(payload.sessionId, payload.repo).catch((error: unknown) => {
            this.logger.warn("changeset landing bookkeeping failed", {
              sessionId: payload.sessionId,
              error: error instanceof Error ? error.message : String(error)
            });
          });
        }
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
      case "chat.uploadAttachment": {
        const uploaded = await this.requireBackend().uploadAttachment(payload.sessionId, payload.name, payload.dataBase64);
        this.respond(request.requestId, { type: "chat.uploadAttachment", ...uploaded });
        return;
      }
      case "preview.list": {
        this.respond(request.requestId, { type: "preview.list", previews: this.requireBackend().listPreviews(payload.sessionId) });
        return;
      }
      case "preview.open": {
        const preview = this.requireBackend().getPreview(payload.previewId);
        if (preview === null) {
          this.respondError(request.requestId, "This preview is no longer running.");
          return;
        }
        // Agent-served content is untrusted: it opens in a browser surface,
        // never a privileged webview, with a one-time notice per preview.
        if (!this.previewNoticeShown.has(preview.previewId)) {
          this.previewNoticeShown.add(preview.previewId);
          void vscode.window.showInformationMessage(
            `Opening "${preview.title}" - this page is served by the agent's sandbox. Treat it as untrusted content.`
          );
        }
        if (payload.external === true) {
          await vscode.env.openExternal(vscode.Uri.parse(preview.url));
        } else {
          await vscode.commands.executeCommand("simpleBrowser.show", preview.url);
        }
        this.respond(request.requestId, { type: "preview.open", accepted: true });
        return;
      }
      case "preview.stop": {
        this.respond(request.requestId, { type: "preview.stop", previews: this.requireBackend().stopPreview(payload.previewId) });
        return;
      }
      case "terminal.attach": {
        this.requireBackend();
        await vscode.commands.executeCommand("drydock.session.attachTerminal", payload.sessionId);
        this.respond(request.requestId, { type: "terminal.attach", accepted: true });
        return;
      }
      case "clone.exportPatch": {
        // Save the clone's captured changeset(s) as .patch files the developer
        // can carry to another machine (applied there via Drydock: Apply Patch,
        // or plain `git apply --3way --binary`). Read-only: capture never
        // advances the sync base, and the file goes only where the save dialog
        // points. One dialog per repo patch.
        const appService = this.requireCloneSession(payload.sessionId);
        const patches = await appService.buildOutboundPatches(payload.sessionId);
        const wanted = (patches ?? []).filter((patch) => payload.repo === undefined || patch.repoName === payload.repo);
        if (wanted.length === 0) {
          this.respond(request.requestId, {
            type: "clone.exportPatch",
            savedPaths: [],
            message: patches === null
              ? "This session's clone state is not available in this window."
              : "Nothing to export - the clone has no captured changes."
          });
          return;
        }
        const savedPaths: string[] = [];
        const stamp = new Date().toISOString().slice(0, 10);
        for (const patch of wanted) {
          const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`${patch.repoName}-${stamp}.patch`),
            filters: { "Patch files": ["patch", "diff"] },
            title: `Export ${patch.repoName} changeset (${String(patch.fileCount)} file${patch.fileCount === 1 ? "" : "s"})`
          });
          if (target === undefined) continue;
          await vscode.workspace.fs.writeFile(target, Buffer.from(patch.patch, "utf8"));
          savedPaths.push(target.fsPath);
        }
        this.respond(request.requestId, {
          type: "clone.exportPatch",
          savedPaths,
          message: savedPaths.length === 0
            ? "Export cancelled."
            : `Exported ${String(savedPaths.length)} patch file${savedPaths.length === 1 ? "" : "s"}: ${savedPaths.join(", ")}`
        });
        return;
      }
      case "board.state": {
        const board = await buildBoardState(this.requireBackendReady(), this.logger);
        this.respond(request.requestId, { type: "board.state", board });
        return;
      }
      case "board.moveCard": {
        const backend = this.requireBackendReady();
        if (payload.cardKind === "task") {
          await this.requireTasks().updateTask(payload.id, { columnId: payload.columnId });
        } else {
          await this.requireSubtasks().moveCard({ subtaskId: payload.id }, payload.columnId);
        }
        const board = await buildBoardState(backend, this.logger);
        this.respond(request.requestId, { type: "board.moveCard", board });
        return;
      }
      case "board.columns.update": {
        const backend = this.requireBackendReady();
        await reconcileColumns(backend.board, payload.columns, payload.deletedColumnIds);
        const board = await buildBoardState(backend, this.logger);
        this.respond(request.requestId, { type: "board.columns.update", board });
        return;
      }
      case "subtask.create": {
        this.requireBackend();
        await this.requireSubtasks().createSubtask(payload.taskId, {
          title: payload.title,
          ...(payload.description === undefined ? {} : { description: payload.description }),
          ...(payload.prompt === undefined ? {} : { prompt: payload.prompt }),
          ...(payload.autoStart === undefined ? {} : { autoStart: payload.autoStart })
        });
        const summary = await this.requireTaskSummary(this.requireTasks(), payload.taskId);
        this.respond(request.requestId, { type: "subtask.create", task: summary });
        this.push({ type: "task.updated", task: summary });
        return;
      }
      case "subtask.update": {
        this.requireBackend();
        const existing = await this.requireSubtasks().getSubtask(payload.subtaskId);
        if (existing === null) {
          throw new Error(`Subtask ${payload.subtaskId} was not found.`);
        }
        const hasFieldUpdate = payload.title !== undefined || payload.description !== undefined
          || payload.prompt !== undefined || payload.autoStart !== undefined || payload.colorOverride !== undefined
          || payload.seedMode !== undefined || payload.verified !== undefined;
        if (hasFieldUpdate) {
          await this.requireSubtasks().updateSubtask(payload.subtaskId, {
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
          await this.requireSubtasks().moveCard({ subtaskId: payload.subtaskId }, payload.columnId);
        }
        const summary = await this.requireTaskSummary(this.requireTasks(), existing.taskId);
        this.respond(request.requestId, { type: "subtask.update", task: summary });
        this.push({ type: "task.updated", task: summary });
        return;
      }
      case "subtask.delete": {
        this.requireBackend();
        const existing = await this.requireSubtasks().getSubtask(payload.subtaskId);
        if (existing === null) {
          throw new Error(`Subtask ${payload.subtaskId} was not found.`);
        }
        await this.requireSubtasks().deleteSubtask(payload.subtaskId);
        const summary = await this.requireTaskSummary(this.requireTasks(), existing.taskId);
        this.respond(request.requestId, { type: "subtask.delete", task: summary });
        this.push({ type: "task.updated", task: summary });
        return;
      }
      case "subtask.dependency.add": {
        this.requireBackend();
        await this.requireSubtasks().addDependency(payload.fromSubtaskId, payload.toSubtaskId);
        const summary = await this.requireTaskSummary(this.requireTasks(), payload.taskId);
        this.respond(request.requestId, { type: "subtask.dependency.add", task: summary });
        this.push({ type: "task.updated", task: summary });
        return;
      }
      case "subtask.dependency.remove": {
        this.requireBackend();
        await this.requireSubtasks().removeDependency(payload.fromSubtaskId, payload.toSubtaskId);
        const summary = await this.requireTaskSummary(this.requireTasks(), payload.taskId);
        this.respond(request.requestId, { type: "subtask.dependency.remove", task: summary });
        this.push({ type: "task.updated", task: summary });
        return;
      }
      case "subtask.start": {
        // force is the manual-only override for a BLOCKED subtask; typed
        // StartSubtaskError messages surface verbatim via the error-response path.
        const backend = this.requireBackendReady();
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
        const backend = this.requireBackendReady();
        if (!(await promptAndSaveTaskClonePolicy(backend, payload.taskId))) {
          this.respond(request.requestId, { type: "task.start", accepted: false });
          return;
        }
        await backend.orchestrator.startTask(payload.taskId);
        this.respond(request.requestId, { type: "task.start", accepted: true });
        return;
      }
      case "recipes.list": {
        const backend = this.requireBackendReady();
        const recipes = await backend.recipes.listRecipes();
        this.respond(request.requestId, { type: "recipes.list", recipes });
        return;
      }
      case "task.createFromRecipe": {
        // Materializes task + subtasks + DAG with per-role defaults; never starts.
        const backend = this.requireBackendReady();
        const created = await backend.recipes.materializeTask(payload.recipeId, payload.title);
        const summary = await this.requireTaskSummary(this.requireTasks(), created.taskId);
        this.respond(request.requestId, { type: "task.createFromRecipe", task: summary });
        this.push({ type: "task.updated", task: summary });
        return;
      }
      case "planner.open": {
        if (payload.startGuide !== true) this.requireBackend();
        try {
          await vscode.commands.executeCommand("drydock.planner.open", payload.planId, {
            startGuide: payload.startGuide === true
          });
          this.respond(request.requestId, { type: "planner.open", accepted: true });
        } catch {
          this.respondError(request.requestId, "Planner panel not available yet.");
        }
        return;
      }
      case "planner.create": {
        // The Planner owns the complete intake. The boot runs detached;
        // Planner opens the resulting files while the conversation remains in
        // the sidebar, and failures surface as the sessionReady error push.
        const planner = this.requirePlanner();
        const plan = await planner.createPlan({
          brief: payload.brief,
          aspectIds: payload.aspectIds,
          contextRoots: payload.contextRoots,
          ...(payload.notes === undefined ? {} : { notes: payload.notes }),
          ...(payload.title === undefined ? {} : { title: payload.title }),
          ...(payload.taskId === undefined ? {} : { taskId: payload.taskId })
        });
        const summary = (await planner.listPlans()).find((candidate) => candidate.planId === plan.planId);
        if (summary === undefined) {
          throw new Error("The plan was created but could not be read back.");
        }
        this.respond(request.requestId, { type: "planner.create", plan: summary });
        void planner.startPlanSession(plan.planId, payload.model === undefined ? undefined : payload.model)
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error("plan tab create boot failed", { planId: plan.planId, error: message });
            this.push({ type: "planner.sessionReady", planId: plan.planId, sessionId: "", ok: false, error: message });
          });
        return;
      }
      case "planner.plans": {
        // The plan switcher + rail source (summaries carry sessionId).
        const plans = await this.requirePlanner().listPlans();
        this.respond(request.requestId, { type: "planner.plans", plans });
        return;
      }
      case "planner.archive": {
        const planner = this.requirePlanner();
        await planner.archivePlan(payload.planId, payload.archived);
        const summary = (await planner.listPlans()).find((candidate) => candidate.planId === payload.planId);
        if (summary === undefined) {
          throw new Error("The plan no longer exists.");
        }
        this.respond(request.requestId, { type: "planner.archive", plan: summary });
        return;
      }
      case "planner.aspects.list": {
        const aspects = (await this.requirePlanner().listAspects(true)).map((aspect) => ({ ...aspect }));
        this.respond(request.requestId, { type: "planner.aspects.list", aspects });
        return;
      }
      case "planner.aspects.save": {
        const aspects = await this.requirePlanner().saveAspect(payload.aspect);
        this.respond(request.requestId, { type: "planner.aspects.save", aspects });
        return;
      }
      case "planner.aspects.archive": {
        const aspects = await this.requirePlanner().archiveAspect(payload.aspectId, payload.archived);
        this.respond(request.requestId, { type: "planner.aspects.archive", aspects });
        return;
      }
      case "planner.startSession": {
        // Ack-then-push: the boot outlives the request timeout. Success lands
        // as planner.sessionReady via the bus; only failure is pushed here.
        const planner = this.requirePlanner();
        this.respond(request.requestId, { type: "planner.startSession", accepted: true });
        void planner.startPlanSession(payload.planId, payload.model === undefined ? undefined : payload.model)
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error("plan tab session boot failed", { planId: payload.planId, error: message });
            this.push({ type: "planner.sessionReady", planId: payload.planId, sessionId: "", ok: false, error: message });
          });
        return;
      }
      case "planner.sendTurn": {
        const planner = this.requirePlanner();
        this.respond(request.requestId, { type: "planner.sendTurn", accepted: true });
        void planner.sendPlanTurn(payload.planId, payload.prompt).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error("plan tab turn failed", { planId: payload.planId, error: message });
          this.push({ type: "planner.sessionReady", planId: payload.planId, sessionId: "", ok: false, error: message });
        });
        return;
      }
      case "agents.open": {
        if (payload.startGuide !== true) this.requireBackend();
        try {
          await vscode.commands.executeCommand("drydock.agents.open", {
            startGuide: payload.startGuide === true
          });
          this.respond(request.requestId, { type: "agents.open", accepted: true });
        } catch {
          // Defensive: the command registers during activation; surface a
          // readable error if the relay ever beats registration.
          this.respondError(request.requestId, "Agents panel not available yet.");
        }
        return;
      }
      case "taskBoard.open": {
        if (payload.startGuide !== true) this.requireBackend();
        try {
          await vscode.commands.executeCommand("drydock.taskBoard.open", {
            startGuide: payload.startGuide === true
          });
          this.respond(request.requestId, { type: "taskBoard.open", accepted: true });
        } catch {
          // Defensive: the command registers during activation; surface a
          // readable error if the relay ever beats registration.
          this.respondError(request.requestId, "Task Board panel not available yet.");
        }
        return;
      }
      case "agents.openSession": {
        // Attached hosts (the rail) navigate chat through the same seam the
        // Agents panel uses: one panel.showSession push, whichever chat
        // surface is listening (the chat rail).
        this.showSession(payload.sessionId, payload.nodeId);
        this.respond(request.requestId, { type: "agents.openSession", accepted: true });
        return;
      }
      case "hub.state": {
        // The Task Hub's ONE composite read (UX overhaul P3). Every field is
        // folded from a service that already owns it - the hub adds no state,
        // it only assembles. The fold itself lives in hubShared so it stays
        // unit-testable without vscode or a backend.
        const state = await this.buildHubState(payload.taskId);
        this.respond(request.requestId, { type: "hub.state", state });
        return;
      }
      // ADR 0022 M7: the developer-facing half of validation. The TD's registry
      // writes live in the Configure panel; everything here is what a chip, a
      // rail dot, or a task header needs, and nothing here can create a runtime.
      case "validation.jobs": {
        const jobs = await this.requireValidation().listJobs({
          ...(payload.taskId === undefined ? {} : { taskId: payload.taskId }),
          ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId })
        });
        this.respond(request.requestId, { type: "validation.jobs", jobs });
        return;
      }
      case "validation.abortJob": {
        await this.requireValidation().abortJob(payload.jobId);
        this.respond(request.requestId, { type: "validation.ack" });
        return;
      }
      case "validation.requeue": {
        const result = await this.requireValidation().requeue(payload.jobId, {
          ...(payload.rerouteTo === undefined ? {} : { rerouteTo: payload.rerouteTo }),
          ...(payload.confirmedDelta === undefined ? {} : { confirmedDelta: payload.confirmedDelta })
        });
        this.respond(request.requestId, { type: "validation.requeue", result });
        return;
      }
      case "validation.setTaskRuntime": {
        await this.requireValidation().setTaskRuntime(
          payload.taskId,
          payload.runtimeId === undefined ? undefined : payload.runtimeId
        );
        this.respond(request.requestId, { type: "validation.ack" });
        return;
      }
      case "validation.railStatus": {
        // The dot follows the CURRENT task (edge case H7), so it reads the
        // spine rather than taking a target from the webview.
        const validation = this.backend.available ? this.backend.validation : undefined;
        if (validation === undefined) {
          this.respond(request.requestId, {
            type: "validation.railStatus",
            dot: "none",
            line: "Validation runtimes need a Windows host with Hyper-V."
          });
          return;
        }
        const activeTaskId = this.backend.available ? this.backend.activeTasks.get() : null;
        const status = await validation.railStatus(activeTaskId ?? undefined);
        this.respond(request.requestId, { type: "validation.railStatus", dot: status.dot, line: status.line });
        return;
      }
      case "validation.run": {
        const result = await this.requireValidation().runForSession(payload.sessionId);
        // The queue answers immediately; the chip follows the job pushes.
        this.respond(request.requestId, { type: "validation.ack" });
        this.logger.info("validation run requested", { sessionId: payload.sessionId, message: result.message });
        return;
      }
      case "panel.openSurface": {
        // The webview names a surface from a closed enum; the host owns the
        // command. Board/Agents are window singletons, Planner takes an
        // optional planId, Review is per-task (falling back to the spine).
        this.requireBackend();
        const surface = payload.surface;
        const command = SURFACE_COMMANDS[surface];
        let args: readonly unknown[];
        if (surface === "planner") {
          args = [payload.planId];
        } else if (surface === "review" || surface === "hub") {
          // Both are task-scoped; an omitted id means "the task the spine is on".
          const taskId = payload.taskId ?? this.requireBackendReady().activeTasks.get();
          if (taskId === null) {
            throw new Error(`${surface === "hub" ? "The Task Hub" : "Task Review"} needs a task; pick one first.`);
          }
          args = [taskId];
        } else {
          args = [{}];
        }
        try {
          await vscode.commands.executeCommand(command, ...args);
          this.respond(request.requestId, { type: "panel.openSurface", accepted: true });
        } catch {
          // Defensive: the commands register during activation; surface a
          // readable error if a relay ever beats registration.
          this.respondError(request.requestId, `That panel is not available yet (${surface}).`);
        }
        return;
      }
    }
  }

  /**
   * Assembles one task's hub overview from the services that own each part.
   * Optional services (planner, questions) degrade to empty rather than
   * failing the whole read - a composition without them still has a hub.
   */
  private async buildHubState(taskId: string): Promise<HubState> {
    const backend = this.requireBackendReady();
    const appService = this.requireBackend();
    const task = await this.requireTaskSummary(this.requireTasks(), taskId);
    const linked = hubTaskSessionIds(task);
    const [records, policy, plans, questions] = await Promise.all([
      appService.listChatSessions(),
      this.requireWorkspaceReview().getPolicyState(),
      backend.planner.listPlans().catch(() => [] as PlanSummary[]),
      this.requireQuestions().listQuestions("pending").then(
        (pending) => pending.map(toAgentQuestionSummary),
        () => [] as AgentQuestionSummary[]
      )
    ]);
    const sessions = records
      .filter((record) => linked.has(record.sessionId))
      .map((record) => this.decorateSessionSummary(record));
    // Mount lines + the header's workspace chip come from the task's linked
    // sets, in link order; a set that no longer exists contributes nothing.
    const setsById = new Map(policy.workspaceSets.map((set) => [set.workspaceSetId, set]));
    const mounts: HubMountInput[] = [];
    let workspaceName: string | undefined;
    for (const setId of task.linkedWorkspaceSetIds) {
      const set = setsById.get(setId);
      if (set === undefined) continue;
      workspaceName ??= set.name;
      for (const member of set.members) {
        mounts.push({ displayPath: member.displayPath, readOnly: member.readOnly });
      }
    }
    // Runtimes this task owns, plus ONE stats sample covering all of them (the
    // sampler takes a whole snapshot per call; per-session calls would repeat it).
    const inventory = (await appService.listPanelRuntimes()).filter((record) => linked.has(String(record.sessionId)));
    const runningIds = inventory.filter((record) => record.status === "running").map((record) => String(record.runtimeId));
    const samples = runningIds.length === 0
      ? []
      : await appService.sampleRuntimeStats(runningIds).catch(() => [] as RuntimeStatsSummary[]);
    const samplesById = new Map(samples.map((sample) => [sample.runtimeId, sample]));
    const runtimes: HubRuntimeInput[] = inventory.map((record) => {
      const workspacePath = record.metadata["workspacePath"];
      const sample = samplesById.get(String(record.runtimeId));
      return {
        runtime: toRuntimeSummary(record),
        sessionId: String(record.sessionId),
        ...(sample === undefined ? {} : { stats: sample }),
        ...(typeof workspacePath === "string" && workspacePath.length > 0
          ? { workspaceDisplayPath: workspacePath }
          : {})
      };
    });
    // ADR 0022 F6: the header's `runs on … ▾` picker appears only when the
    // task's resolved runtime differs from the default, so the label is
    // computed here and simply absent otherwise. A composition without
    // validation contributes an empty picker rather than a broken one.
    const validation = backend.validation;
    const [resolvedRuntime, validationRuntimes] = validation === undefined
      ? [undefined, [] as readonly { readonly runtimeId: string; readonly displayName: string }[]]
      : await Promise.all([
        validation.resolvedRuntimeForTask(taskId).catch(() => undefined),
        validation.pickerRuntimes().catch(() => [] as readonly { readonly runtimeId: string; readonly displayName: string }[])
      ]);
    const validationRuntimeLabel = resolvedRuntime?.differsFromDefault === true
      ? resolvedRuntime.runtime?.displayName
      : undefined;
    return buildHubState({
      task,
      sessions,
      plans,
      questions,
      accessRequests: policy.accessRequests,
      runtimes,
      mounts,
      ...(workspaceName === undefined ? {} : { workspaceName }),
      ...(validationRuntimeLabel === undefined ? {} : { validationRuntimeLabel }),
      validationRuntimes,
      generatedAt: new Date().toISOString()
    });
  }

  /**
   * The same decorated task list `task.list` returns (links + subtasks +
   * column state), without the review-comment join the rail does not read.
   */
  private async decorateTasks(summaries: readonly WorkTaskSummary[]): Promise<WorkTaskSummary[]> {
    const backend = this.requireBackendReady();
    const columnsById = new Map((await this.requireBoard().listColumns()).map((column) => [column.columnId, column]));
    return Promise.all(summaries.map((summary) => decorateTaskSummary(backend, summary, columnsById)));
  }

  /**
   * Sessions waiting on the user: this panel's attention bookkeeping plus any
   * pending question (which survives a panel reload the attention map does not).
   */
  private async attentionSessionIds(): Promise<ReadonlySet<string>> {
    const ids = new Set<string>(this.attention.keys());
    try {
      for (const question of await this.requireQuestions().listQuestions("pending")) {
        ids.add(question.sessionId);
      }
    } catch {
      // No question service in this composition: the attention map still stands.
    }
    return ids;
  }

  /** Sessions with a live backend here, or a fresh heartbeat in another window. */
  private async liveSessionIds(): Promise<ReadonlySet<string>> {
    const appService = this.requireBackend();
    const ids = new Set<string>();
    for (const record of await appService.listChatSessions()) {
      if (appService.isChatSessionLive(record.sessionId) || this.isRunningElsewhere(record)) {
        ids.add(record.sessionId);
      }
    }
    return ids;
  }

  /**
   * Refuses a workspace mutation while a live chat mounts the set: pulling the
   * roots out from under a running agent breaks its resume. The error names
   * the task standing in the way rather than failing anonymously.
   */
  private async assertWorkspaceSetsFree(workspaceSetIds: readonly string[], subject: string): Promise<void> {
    if (workspaceSetIds.length === 0) return;
    const [tasks, live] = await Promise.all([
      this.requireTasks().listTaskSummaries().then((summaries) => this.decorateTasks(summaries)),
      this.liveSessionIds()
    ]);
    const blocking = tasksBlockingWorkspaceSet(workspaceSetIds, tasks, live);
    if (blocking.length > 0) {
      throw new Error(workspaceInUseMessage(subject, blocking));
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

  /** Folds structured agent events into the compact subagent summary push. */
  private foldAgentActivity(sessionId: string, event: AgentEvent): void {
    const entry = this.agentActivity.get(sessionId) ?? { sources: [] };
    entry.sources.push(treeSourceFromEvent(event));
    this.agentActivity.set(sessionId, entry);
    this.pushAgentActivity(sessionId);
  }

  private pushAgentActivity(sessionId: string): void {
    this.push({
      type: "session.agentActivity",
      sessionId,
      activity: this.agentActivitySummary(sessionId)
    });
  }

  private agentActivitySummary(sessionId: string): AgentActivitySummary {
    const entry = this.agentActivity.get(sessionId);
    if (entry === undefined) return { running: 0, failed: 0 };
    // Shared projection (contracts): the Agents panel folds the same events
    // through the same function, so chips and fleet rows cannot disagree.
    return agentActivitySummaryOfTree(reduceAgentTree(entry.sources));
  }

  /**
   * Projects a session record to its display-safe summary, decorated with
   * `runningElsewhere`. A session runs "elsewhere" when it is stored
   * active/starting, is not live in this host process, carries a fresh heartbeat,
   * and is owned by a different host instance.
   */
  private decorateSessionSummary(record: ChatSessionRecord): ChatSessionSummary {
    // Backfill the fast-path mode map from the durable record so a clone session
    // stays recognizable after a reload (its sessionClones map is still lost, so
    // clone.* ops surface the precise "resume the session" error, not a mode one).
    if (this.backend.available) {
      this.backend.appService.noteSessionModeFromRecord(record.sessionId, record.mode);
    }
    const live = this.backend.available && this.backend.appService.isChatSessionLive(record.sessionId);
    const summary = { ...toChatSessionSummary(record, this.isRunningElsewhere(record)), live };
    const activity = this.agentActivitySummary(record.sessionId);
    return activity.running === 0 && activity.failed === 0
      ? summary
      : { ...summary, agentActivity: activity };
  }

  private isRunningElsewhere(record: ChatSessionRecord): boolean {
    if (!this.backend.available) {
      return false;
    }
    return isSessionRunningElsewhere(this.backend.appService, record);
  }

  private async resolveWorkspace(selection: ChatWorkspaceSelection | undefined): Promise<ChatWorkspaceContext | undefined> {
    if (selection === undefined) {
      return undefined;
    }
    // The `auto` selection mounts the window's open file-scheme folders; the
    // service throws when none are open.
    return this.requireWorkspaceReview().resolveWorkspaceSelection(selection, this.openFolderRoots());
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

  private agentIdleThresholdMs(): number {
    const minutes = vscode.workspace.getConfiguration("drydock").get<number>("agentIdleThresholdMinutes", 5);
    const safeMinutes = Number.isFinite(minutes) ? Math.max(1, Math.min(120, minutes)) : 5;
    return safeMinutes * 60_000;
  }

  private codeBlockWordWrap(): boolean {
    return vscode.workspace.getConfiguration("drydock").get<boolean>("codeBlockWordWrap", true);
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
    // A mapped drive and its UNC target are the same folder. Compare canonical
    // filesystem identities, but retain the original spellings for VS Code UI
    // mutations (switching X:\\ to \\\\server\\share can trip VS Code's UNC gate).
    const currentKeys = new Set(current.map(hostPathIdentityKey));
    const targetKeys = new Set(target.roots.map(hostPathIdentityKey));
    const toAdd = target.roots.filter((root) => !currentKeys.has(hostPathIdentityKey(root)));
    const toRemove = current.filter((root) => !targetKeys.has(hostPathIdentityKey(root)));

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
   * crosses the single-folder ↔ multi-root boundary - i.e. 1→many, many→1, or
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
    void (async () => {
      // "This Turn" frame: snapshot the send moment BEFORE the agent can edit.
      // Best-effort like session baselining - a capture failure must not block
      // the turn (the view then falls back to its previous frame). No-op for
      // sessions without diff baselines (clone/plan).
      try {
        await this.requireWorkspaceReview().beginTurnBaselines(sessionId);
      } catch (error) {
        this.logger.warn("turn diff baseline capture failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      await appService.sendChatTurn(sessionId, prompt, model);
    })().catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("chat turn failed to run", { sessionId, error: message });
      // A failure this early has no turn events, so the message would vanish
      // without a trace: record it durably in the session's transcript AND
      // push the session-scoped failure for immediate spinner/composer state.
      await appService.recordChatSendFailure(sessionId, error);
      this.push({ type: "run.failed", sessionId, message });
    });
  }

  /**
   * Called after each access decision. While the session still has pending
   * requests, attention persists. Once the queue drains, attention clears and a
   * single continuation turn tells a live idle agent the outcome.
   */
  private async onAccessResolved(
    workspaceReview: WorkspaceReviewAppService,
    accessRequest: AccessRequestSummary,
    approve: boolean
  ): Promise<void> {
    let stillPending: boolean;
    try {
      const state = await workspaceReview.getPolicyState();
      stillPending = state.accessRequests.some(
        (candidate) => candidate.sessionId === accessRequest.sessionId && candidate.status === "pending"
      );
    } catch (error) {
      this.logger.warn("access resolution follow-up failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }
    if (stillPending) {
      return;
    }
    this.clearAttention(accessRequest.sessionId, ["access-request"]);
    this.autoContinueAfterAccess(approve, accessRequest);
  }

  /**
   * Auto-sends a continuation turn that tells the agent the access-request
   * outcome, but only when the session is live and idle. The approval path has
   * already restarted the backend with the new mount by the time this runs.
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
      ? `[host] Access request approved: "${accessRequest.displayPath}" is mounted at "${sandboxRuntimePath(accessRequest.displayPath)}" (${accessRequest.mode}). Continue the task.`
      : `[host] Access request for "${accessRequest.displayPath}" was denied. Continue without it.`;
    this.runTurnDetached(appService, accessRequest.sessionId, message);
  }

  // MARK: Attention routing (Phase 3)

  /**
   * Adds an attention reason to a session and surfaces it: pushes the session's
   * current reasons, refreshes the badge, and - only on the transition from
   * no-attention to attention for that session - shows a hidden-panel toast.
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
    // Toast only when no host is on screen and this is a fresh attention episode.
    if (!wasWaiting && !this.anyHostVisible()) {
      await this.showAttentionToast(sessionId, verb);
    }
  }

  /** True when at least one attached host reports itself on screen. */
  private anyHostVisible(): boolean {
    for (const isVisible of this.attachedWebviews.values()) {
      if (isVisible()) return true;
    }
    return false;
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
  }

  /** Drops a session's attention entirely (deleted/ended) and re-announces empty. */
  private dropAttention(sessionId: string): void {
    if (!this.attention.delete(sessionId)) {
      return;
    }
    this.pushAttention(sessionId);
  }

  /**
   * Seeds access-request attention for sessions with pending requests, once per
   * host session. This lets a reloaded webview re-derive attention for requests
   * that were already pending before this host existed. Turn-attention is
   * ephemeral and intentionally not seeded.
   */
  private seedPendingAttention(accessRequests: readonly AccessRequestSummary[]): void {
    if (this.attentionSeeded) {
      return;
    }
    this.attentionSeeded = true;
    for (const accessRequest of accessRequests) {
      if (accessRequest.status !== "pending") {
        continue;
      }
      const reasons = this.attention.get(accessRequest.sessionId) ?? new Set<SessionAttentionReason>();
      if (!reasons.has("access-request")) {
        reasons.add("access-request");
        this.attention.set(accessRequest.sessionId, reasons);
        this.pushAttention(accessRequest.sessionId);
      }
    }
  }

  /** Re-derives durable question attention after a host/window reload. */
  private seedPendingQuestionAttention(
    questions: readonly { readonly sessionId: string; readonly status: string }[]
  ): void {
    if (this.questionAttentionSeeded) return;
    this.questionAttentionSeeded = true;
    for (const question of questions) {
      if (question.status !== "pending") continue;
      const reasons = this.attention.get(question.sessionId) ?? new Set<SessionAttentionReason>();
      if (reasons.has("question")) continue;
      reasons.add("question");
      this.attention.set(question.sessionId, reasons);
      this.pushAttention(question.sessionId);
    }
  }

  /** Pushes a session's current attention reasons (empty when it was dropped). */
  private pushAttention(sessionId: string): void {
    const reasons = [...(this.attention.get(sessionId) ?? [])];
    this.push({ type: "session.attention", sessionId, reasons });
  }

  /**
   * A hidden-host toast for a freshly-flagged session. "Open" focuses the chat
   * rail. The title comes from the session lookup, falling back to the id
   * prefix when the record can't be read.
   */
  private async showAttentionToast(sessionId: string, verb: string): Promise<void> {
    const title = await this.sessionTitle(sessionId);
    const choice = await vscode.window.showInformationMessage(`"${title}" ${verb}`, "Open");
    if (choice === "Open") {
      void vscode.commands.executeCommand("drydock.chatRail.focus");
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

  /** Lazily builds the guided sign-in service against the live backend. */
  private requireConnectService(appService: IsolatedRunService): ProviderConnectService {
    if (this.connectService !== null) return this.connectService;
    if (!this.backend.available) throw new Error("Docker Sandbox is not available in this window.");
    const backend: BackendReady = this.backend;
    this.connectService = new ProviderConnectService({
      logger: this.logger,
      sbxPath: backend.sbxDisplayPath,
      ...(backend.hostClaudePath === undefined ? {} : { hostClaudePath: backend.hostClaudePath }),
      environment: backend.runtimeEnvironment,
      ...(backend.providerSecrets === undefined ? {} : { providerSecrets: backend.providerSecrets }),
      assertInteractiveSetupAllowed: (action) => appService.assertInteractiveSetupAllowed(action),
      openExternal: async (url) => {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      },
      refreshAuthStatus: async (providerId) => {
        // A completed guided connect means fresh credentials: requery models
        // too, so the picker fills in the moment the provider turns green.
        const providerCatalogs = await appService.refreshHostProviderCatalogs({ force: true });
        this.push({ type: "provider.models", providerCatalogs });
        return appService.providerAuthStatus(providerId);
      },
      onProgress: (progress) => {
        this.push({
          type: "provider.authProgress",
          providerId: progress.providerId,
          phase: progress.phase,
          ...(progress.detail === undefined ? {} : { detail: progress.detail })
        });
      }
    });
    return this.connectService;
  }

  /**
   * Auto-detection for terminal login flows: while the login terminal is open,
   * the inert auth probe polls every few seconds; closing the terminal forces
   * a final probe. The banner flips green without the user clicking Recheck.
   */
  private watchTerminalLogin(providerId: string, terminal: vscode.Terminal): void {
    this.loginWatchers.get(providerId)?.();
    const appService = this.requireBackend();
    const refresh = async (): Promise<boolean> => {
      // Cheap auth-only probe while polling; on the flip to connected, one
      // full forced discovery fills the model list for the fresh credentials.
      const providerCatalogs = await appService.refreshHostProviderCatalogs({ forceAuthProbe: true });
      this.push({ type: "provider.models", providerCatalogs });
      const connected = appService.providerAuthStatus(providerId) === "authenticated";
      if (connected) {
        this.push({ type: "provider.authProgress", providerId, phase: "connected" });
        const refreshed = await appService.refreshHostProviderCatalogs({ force: true });
        this.push({ type: "provider.models", providerCatalogs: refreshed });
      }
      return connected;
    };
    const interval = setInterval(() => {
      void refresh().then((connected) => {
        if (connected) cleanup();
      }).catch(() => { /* probe warnings are logged by the service */ });
    }, 5_000);
    const closeListener = vscode.window.onDidCloseTerminal((closed) => {
      if (closed !== terminal) return;
      void refresh().catch(() => { /* logged by the service */ });
      cleanup();
    });
    const timeout = setTimeout(() => { cleanup(); }, 15 * 60_000);
    const cleanup = (): void => {
      clearInterval(interval);
      clearTimeout(timeout);
      closeListener.dispose();
      this.loginWatchers.delete(providerId);
    };
    this.loginWatchers.set(providerId, cleanup);
  }

  /** The full available-backend value, for the boardShared helpers (which take Backend, not one service at a time). */
  private requireBackendReady(): BackendReady {
    if (!this.backend.available) {
      throw new Error(this.backend.reason);
    }
    return this.backend;
  }

  /**
   * The production-tier classifier for access-request summaries, or undefined
   * when this host has no validation service - in which case the card says
   * nothing about disposition rather than guessing "mount".
   */
  private productionClassifier(): ReturnType<typeof productionSummaryOptions> {
    const validation = this.backend.available ? this.backend.validation : undefined;
    if (validation === undefined) return undefined;
    return productionSummaryOptions(validation);
  }

  /** The validation service, or the sentence saying why this host has none. */
  private requireValidation(): ValidationAppService {
    const backend = this.requireBackendReady();
    if (backend.validation === undefined) {
      throw new Error("Validation runtimes need a Windows host with Hyper-V and OpenSSH; this machine cannot run them.");
    }
    return backend.validation;
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

  private requireBoard(): BoardService {
    if (!this.backend.available) {
      throw new Error(this.backend.reason);
    }
    return this.backend.board;
  }

  private requireSubtasks(): SubtaskService {
    if (!this.backend.available) {
      throw new Error(this.backend.reason);
    }
    return this.backend.subtasks;
  }

  private requireMemory(): MemoryService {
    if (!this.backend.available) {
      throw new Error(this.backend.reason);
    }
    return this.backend.memory;
  }

  private requireMcp(): McpRegistryService {
    if (!this.backend.available) {
      throw new Error(this.backend.reason);
    }
    return this.backend.mcp;
  }

  /** taskId → title, for memory scope labels. Best-effort: empty map on failure. */
  private taskTitleMap(): Promise<ReadonlyMap<string, string>> {
    return memoryTaskTitles(() => this.requireTasks().listTasks());
  }

  private requirePlanner(): PlannerAppService {
    if (!this.backend.available) {
      throw new Error(this.backend.reason);
    }
    return this.backend.planner;
  }

  /** Refreshed summary (with current links, columnId/doneAt, and subtasks) for one task after a mutation. */
  private async requireTaskSummary(tasks: TaskService, taskId: string): Promise<WorkTaskSummary> {
    const summary = (await tasks.listTaskSummaries()).find((candidate) => candidate.taskId === taskId);
    if (summary === undefined) {
      throw new Error(`Task ${taskId} was not found.`);
    }
    return decorateTaskSummary(this.requireBackendReady(), summary);
  }

  private availability(): BackendAvailability {
    return this.backend.available
      ? { available: true, sbxDisplayPath: this.backend.sbxDisplayPath }
      : { available: false, reason: this.backend.reason };
  }

  private respond(requestId: string, payload: PanelResponsePayload): void {
    this.postResponse(requestId, { protocolVersion: WEBVIEW_PROTOCOL_VERSION, kind: "response", requestId, ok: true, payload });
  }

  private respondError(requestId: string, message: string): void {
    this.postResponse(requestId, { protocolVersion: WEBVIEW_PROTOCOL_VERSION, kind: "response", requestId, ok: false, error: { message } });
  }

  /** A response answers exactly one request, so it goes only to its asker. */
  private postResponse(requestId: string, message: HostToWebviewMessage): void {
    void this.responseTargets.get(requestId)?.postMessage(message);
  }

  private push(payload: PanelPushPayload): void {
    this.sequence += 1;
    this.post({ protocolVersion: WEBVIEW_PROTOCOL_VERSION, kind: "push", sequence: this.sequence, payload });
  }

  /** Pushes broadcast to every attached host. */
  private post(message: HostToWebviewMessage): void {
    for (const webview of this.attachedWebviews.keys()) {
      void webview.postMessage(message);
    }
  }
}
