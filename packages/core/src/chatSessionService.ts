/**
 * Durable chat session orchestration.
 *
 * This service owns Stage 2 session state: one isolated runtime per chat
 * session, one active turn at a time, durable event append with replay
 * sequence publication, cancellation, cleanup, and restart reconciliation.
 */

import type {
  AgentAdapter,
  AgentConnection,
  AgentContextMessage,
  AgentDoneEvent,
  AgentErrorEvent,
  AgentEvent,
  AgentModelCatalog,
  AgentRole,
  AgentTransport,
  ChatModelSelection,
  ChatSessionRecord,
  ChatSessionStatus,
  ChatSessionStore,
  CloneDirtyHandling,
  EventStore,
  MountPolicy,
  RuntimeHandle,
  RuntimeId,
  RuntimeInventoryRecord,
  RuntimeInventoryStore,
  RuntimeTemplate,
  SessionId,
  SessionMode,
  StoredEvent,
  TurnResult,
  TurnTerminalStatus
} from "@drydock/contracts";
import type { Clock } from "./clock.js";
import type { IdGenerator } from "./ids.js";
import type { Logger } from "./logger.js";
import type { ProductEventBus } from "./eventBus.js";
import { assertChildMountsWithinParent } from "./mountPolicy.js";
import { withSandboxProvider, type SandboxProvider } from "./isolatedRunTemplate.js";
import { stripHostBriefing } from "./accessRequestProtocol.js";
import { RuntimeCleanupService } from "./runtimeCleanupService.js";
import { RuntimeLifecycleService } from "./runtimeLifecycleService.js";

/** Role sessions run under their spawned role; everything else stays "worker". */
function sessionRole(record: ChatSessionRecord): AgentRole {
  return record.spawnedRole ?? "worker";
}

/** Maps a provider id to a sandbox agent kind (only Claude and Codex ship today). */
function toSandboxProvider(providerId: string): SandboxProvider {
  return providerId === "claude" ? "claude" : "codex";
}

export interface StartChatSessionRequest {
  readonly template: RuntimeTemplate;
  readonly workspacePath: string;
  readonly workspaceOwnerToken?: string;
  readonly title: string;
  readonly model: ChatModelSelection;
  readonly transport: AgentTransport;
  /** Session mode recorded on the row: drives briefing + clone sync UI. */
  readonly mode?: SessionMode;
  /** Original project mount roots, persisted so a later resume re-mounts them. */
  readonly workspaceRoots?: readonly string[];
  readonly readOnlyRoots?: readonly string[];
  /** Clone sessions only: persisted so resume recreates the same snapshot policy. */
  readonly cloneDirtyHandling?: CloneDirtyHandling;
  /**
   * Role-session spawn lineage. When set, the caller has already derived the
   * child template from the parent's mounts and this service enforces the
   * subset rule again on every later expansion. `spawnedRole` becomes the
   * runtime/connection agentRole (and the role chip in the UI).
   */
  readonly parentSessionId?: SessionId;
  readonly spawnedRole?: AgentRole;
  readonly disposeWorkspace?: () => Promise<void>;
}

/**
 * Resume request: same boot inputs as a start, but targeting an existing
 * (ended/failed) session row by id. The runtime, generation, and agent are all
 * fresh; the durable transcript is replayed into the new backend.
 */
export interface ResumeChatSessionRequest {
  readonly sessionId: SessionId;
  readonly template: RuntimeTemplate;
  readonly workspacePath: string;
  readonly workspaceOwnerToken?: string;
  readonly model: ChatModelSelection;
  readonly transport: AgentTransport;
  /**
   * Session mode. Persisted rows already carry the mode from start, so
   * resume normally omits it; when supplied it stamps a legacy row that predates
   * the column so the resumed session is still recognizable as clone/plan.
   */
  readonly mode?: SessionMode;
  /**
   * Force-revive a session that is still `active` (a takeover / reclaim), not
   * just ended/failed. The caller must have already claimed ownership so it is
   * not running elsewhere; this only relaxes the status guard. The prior
   * generation's container (if any) is left for reconciliation to reap.
   */
  readonly force?: boolean;
  readonly disposeWorkspace?: () => Promise<void>;
}

export interface ChatTurnOptions {
  readonly model?: ChatModelSelection;
}

/**
 * Event stores that can drop a session's rows. Kept local because the frozen
 * EventStore port does not declare deletion; the Sqlite store implements it and
 * deleteSession narrows to this shape at the call site.
 */
export interface EventDeletingStore {
  deleteSessionEvents(sessionId: SessionId): Promise<number>;
}

/** Default cadence at which live sessions re-prove liveness (heartbeat). */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
/**
 * Default age past which a stored heartbeat is considered stale. Must comfortably
 * exceed the interval so a single missed tick does not mark a live session dead.
 */
export const DEFAULT_HEARTBEAT_STALE_MS = 60_000;

/**
 * Transports whose in-container CLI state survives a host restart and can be
 * re-bound cheaply without a new container (adoption). exec-json transports
 * only shell out per turn; the app-server transport holds a live process
 * connection that cannot be reattached, so it is deliberately excluded.
 */
const ADOPTABLE_TRANSPORTS: ReadonlySet<AgentTransport> = new Set(["claude-exec-json", "codex-exec-json"]);

export interface ChatSessionServiceOptions {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly lifecycle: RuntimeLifecycleService;
  readonly cleanup: RuntimeCleanupService;
  /** Provider id → adapter; sessions bind to one adapter for their lifetime. */
  readonly agentAdapters: ReadonlyMap<string, AgentAdapter>;
  readonly eventStore: EventStore;
  readonly sessionStore: ChatSessionStore;
  /**
   * Read access to the durable runtime ledger (adoption): reconcile rebuilds
   * a RuntimeHandle from a stored inventory record to reattach to a surviving
   * container. Only getRuntime is used.
   */
  readonly inventory: Pick<RuntimeInventoryStore, "getRuntime">;
  readonly bus: ProductEventBus;
  /**
   * This extension host's identity. Stamped onto every session this
   * instance owns so a foreign fresh heartbeat can be told apart from our own.
   */
  readonly hostInstanceId: string;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatStaleMs?: number;
}

interface ActiveTurn {
  runId?: TurnResult["runId"];
  cancelRequested: boolean;
}

interface LiveSession {
  session: ChatSessionRecord;
  adapter: AgentAdapter;
  transport: AgentTransport;
  template: RuntimeTemplate;
  workspacePath: string;
  workspaceOwnerToken?: string;
  runtime: RuntimeHandle;
  connection: AgentConnection;
  model: ChatModelSelection;
  disposeWorkspace?: () => Promise<void>;
  activeTurn?: ActiveTurn;
}

/** Coordinates persistent isolated chat sessions and their turn streams. */
export class ChatSessionService {
  private readonly liveSessions = new Map<SessionId, LiveSession>();
  /** Sessions with a sidecar prompt in flight (one at a time per session). */
  private readonly sidecarBusy = new Set<SessionId>();
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatStaleMs: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: ChatSessionServiceOptions) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatStaleMs = options.heartbeatStaleMs ?? DEFAULT_HEARTBEAT_STALE_MS;
  }

  async startSession(request: StartChatSessionRequest): Promise<ChatSessionRecord> {
    const adapter = this.requiredAdapter(request.model.providerId);
    const sessionId = this.options.ids.sessionId();
    const chatId = this.options.ids.chatId();
    const createdAt = this.options.clock.isoNow();
    const runtimeId = this.options.ids.runtimeId();
    const starting: ChatSessionRecord = {
      sessionId,
      chatId,
      title: request.title,
      status: "starting",
      providerId: request.model.providerId,
      ...(request.model.model === undefined ? {} : { model: request.model.model }),
      transport: request.transport,
      ...(request.mode === undefined ? {} : { mode: request.mode }),
      ...(request.workspaceRoots === undefined ? {} : { workspaceRoots: request.workspaceRoots }),
      ...(request.readOnlyRoots === undefined ? {} : { readOnlyRoots: request.readOnlyRoots }),
      ...(request.cloneDirtyHandling === undefined ? {} : { cloneDirtyHandling: request.cloneDirtyHandling }),
      ...(request.parentSessionId === undefined ? {} : { parentSessionId: request.parentSessionId }),
      ...(request.spawnedRole === undefined ? {} : { spawnedRole: request.spawnedRole }),
      runtimeId,
      createdAt,
      updatedAt: createdAt
    };

    await this.options.sessionStore.insertSession(starting);
    this.options.bus.publish({ kind: "session-updated", session: starting });

    // A fresh session has no durable events, so no context is replayed.
    return this.bootLiveSession(starting, adapter, {
      template: request.template,
      workspacePath: request.workspacePath,
      runtimeId,
      transport: request.transport,
      model: request.model,
      ...(request.workspaceOwnerToken === undefined ? {} : { workspaceOwnerToken: request.workspaceOwnerToken }),
      ...(request.disposeWorkspace === undefined ? {} : { disposeWorkspace: request.disposeWorkspace }),
      restoreContext: false
    });
  }

  /**
   * Resumes an ended/failed session on a fresh runtime under current mount
   * rules, replaying the durable transcript. The session row stays; a new
   * runtime generation boots and the same context is restored (warn-only on
   * failure, matching restartSession). Rejects a live session or one that is
   * neither ended nor failed — resume is for revival, not for hijacking a
   * running backend.
   */
  async resumeSession(request: ResumeChatSessionRequest): Promise<ChatSessionRecord> {
    if (this.liveSessions.has(request.sessionId)) {
      throw new Error(`Session ${request.sessionId} is still live; it cannot be resumed.`);
    }
    const stored = await this.requiredStoredSession(request.sessionId);
    // A session running in another window is off-limits to resume here even if
    // this window's row still reads ended/failed (races on shared state). A
    // reclaim clears this by claiming ownership first, so this still passes.
    this.assertNotRunningElsewhere(stored);
    // A plain resume is revival, not a takeover of a running backend. A reclaim
    // (force) deliberately revives an `active` session in THIS window instead.
    if (!request.force && stored.status !== "ended" && stored.status !== "failed") {
      throw new Error(`Session ${request.sessionId} is ${stored.status}; only ended or failed sessions can be resumed.`);
    }
    // A resume boots a FRESH runtime generation, so the session's PREVIOUS
    // container (from a dead prior instance or an earlier generation) would leak
    // as a stray "running" sandbox. Reap it best-effort before booting the new
    // one — otherwise repeated resume/reclaim/reload piles up dead containers.
    if (stored.runtimeId !== undefined) {
      try {
        await this.options.cleanup.cleanupRuntime(stored.runtimeId, "graceful");
      } catch (error) {
        this.options.logger.warn("resume: previous runtime cleanup failed", {
          sessionId: request.sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    const adapter = this.requiredAdapter(request.model.providerId);
    const runtimeId = this.options.ids.runtimeId();
    const updated = await this.updateSession(stored, { status: "starting" });
    // Mode is immutable and normally already persisted; a request mode only fills
    // in a legacy row that predates the column (ChatSessionUpdate carries no mode,
    // so this stays on the in-memory projection the caller seeds its map from).
    const starting = updated.mode === undefined && request.mode !== undefined
      ? { ...updated, mode: request.mode }
      : updated;

    return this.bootLiveSession(starting, adapter, {
      template: request.template,
      workspacePath: request.workspacePath,
      runtimeId,
      transport: request.transport,
      model: request.model,
      ...(request.workspaceOwnerToken === undefined ? {} : { workspaceOwnerToken: request.workspaceOwnerToken }),
      ...(request.disposeWorkspace === undefined ? {} : { disposeWorkspace: request.disposeWorkspace }),
      restoreContext: true
    });
  }

  /**
   * The shared boot sequence for startSession and resumeSession: start a fresh
   * runtime generation and adapter connection, optionally replay durable
   * context, register the LiveSession, and flip the row to active. A boot
   * failure past runtime creation is torn down and the row is marked failed,
   * mirroring the original startSession semantics. New runtime/agent ids come
   * from the generator on every call so a resume never reuses a dead generation.
   */
  private async bootLiveSession(
    starting: ChatSessionRecord,
    adapter: AgentAdapter,
    boot: {
      readonly template: RuntimeTemplate;
      readonly workspacePath: string;
      readonly runtimeId: RuntimeId;
      readonly transport: AgentTransport;
      readonly model: ChatModelSelection;
      readonly workspaceOwnerToken?: string;
      readonly disposeWorkspace?: () => Promise<void>;
      readonly restoreContext: boolean;
    }
  ): Promise<ChatSessionRecord> {
    const sessionId = starting.sessionId;
    const agentId = this.options.ids.agentId();
    const generationId = this.options.ids.runtimeGenerationId();

    let runtime: RuntimeHandle | undefined;
    try {
      runtime = await this.options.lifecycle.startRuntime({
        sessionId,
        chatId: starting.chatId,
        agentId,
        agentRole: sessionRole(starting),
        template: boot.template,
        workspacePath: boot.workspacePath,
        generationId,
        runtimeId: boot.runtimeId,
        ...(boot.workspaceOwnerToken === undefined ? {} : { workspaceOwnerToken: boot.workspaceOwnerToken })
      });
      const connection = await adapter.startProtocol({
        sessionId,
        agentId,
        agentRole: sessionRole(starting),
        runtime,
        transport: boot.transport
      });
      if (boot.restoreContext) {
        try {
          await adapter.restoreContext(connection, await this.contextMessages(sessionId));
        } catch (error) {
          this.options.logger.warn("chat context restore failed during resume", {
            sessionId,
            providerId: boot.model.providerId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      // Stamp ownership on activation so another window sees this session as
      // "running here" via a fresh foreign heartbeat and leaves it untouched.
      const active = await this.updateSession(starting, {
        status: "active",
        runtimeId: boot.runtimeId,
        hostInstanceId: this.options.hostInstanceId,
        heartbeatAt: this.options.clock.isoNow()
      });
      this.liveSessions.set(sessionId, {
        session: active,
        adapter,
        transport: boot.transport,
        template: boot.template,
        workspacePath: boot.workspacePath,
        ...(boot.workspaceOwnerToken === undefined ? {} : { workspaceOwnerToken: boot.workspaceOwnerToken }),
        runtime,
        connection,
        model: boot.model,
        ...(boot.disposeWorkspace === undefined ? {} : { disposeWorkspace: boot.disposeWorkspace })
      });
      this.options.bus.publish({ kind: "inventory-changed" });
      return active;
    } catch (error) {
      const failed = await this.updateSession(starting, { status: "failed", endedAt: this.options.clock.isoNow() });
      this.options.logger.error("chat session boot failed", {
        sessionId,
        runtimeId: boot.runtimeId,
        error: error instanceof Error ? error.message : String(error)
      });
      this.options.bus.publish({ kind: "session-updated", session: failed });
      if (runtime !== undefined) {
        await this.options.cleanup.cleanupRuntime(runtime.runtimeId, "force-remove");
      }
      await this.disposeWorkspaceQuietly(boot.disposeWorkspace);
      this.options.bus.publish({ kind: "inventory-changed" });
      throw error;
    }
  }

  async sendTurn(sessionId: SessionId, prompt: string, options?: ChatTurnOptions): Promise<TurnResult> {
    await this.guardRunningElsewhere(sessionId);
    const live = this.requiredLiveSession(sessionId);
    if (live.activeTurn !== undefined) {
      throw new Error(`Session ${sessionId} already has an active turn.`);
    }
    const turnModel = options?.model ?? live.model;
    if (turnModel.providerId !== live.model.providerId) {
      throw new Error(`Session ${sessionId} is backed by ${live.model.providerId}; restart the backend before sending to ${turnModel.providerId}.`);
    }

    const activeTurn: ActiveTurn = { cancelRequested: false };
    live.activeTurn = activeTurn;
    let runId: TurnResult["runId"] | undefined;
    let eventCount = 0;
    let terminalStatus: TurnTerminalStatus = "completed";
    let sawDone = false;

    try {
      await this.appendUserMessage(live, prompt, turnModel);
      runId = await live.adapter.sendPrompt(live.connection, {
        text: prompt,
        cwd: live.runtime.runtimeCwd ?? live.runtime.workspacePath,
        metadata: modelMetadata(turnModel)
      });
      activeTurn.runId = runId;
      this.options.bus.publish({ kind: "turn-started", sessionId, runId });
      if (activeTurn.cancelRequested) {
        await live.adapter.cancel(live.connection, runId);
      }

      for await (const event of live.adapter.streamEvents(live.connection, runId)) {
        eventCount += 1;
        const sequence = await this.appendAndPublish(event);
        if (event.type === "agent.done") {
          sawDone = true;
          terminalStatus = event.status;
        } else if (event.type === "agent.error" && terminalStatus === "completed") {
          terminalStatus = "failed";
        }
        this.options.logger.info("chat event stored", { sessionId, runId, sequence, eventType: event.type });
      }

      if (!sawDone) {
        const status = activeTurn.cancelRequested ? "cancelled" : terminalStatus;
        eventCount += 1;
        await this.appendAndPublish(this.doneEvent(live, runId, status, { synthetic: true, reason: "stream-ended-without-terminal-event" }));
        terminalStatus = status;
      }
    } catch (error) {
      if (runId === undefined) {
        runId = this.options.ids.runId();
      }
      terminalStatus = activeTurn.cancelRequested ? "cancelled" : "failed";
      eventCount += 1;
      await this.appendAndPublish(this.errorEvent(live, runId, error, terminalStatus === "cancelled" ? "TURN_CANCELLED" : "TURN_FAILED"));
      eventCount += 1;
      await this.appendAndPublish(this.doneEvent(live, runId, terminalStatus, { synthetic: true }));
    } finally {
      delete live.activeTurn;
    }

    live.model = turnModel;
    const updated = await this.updateSession(live.session, {
      status: "active",
      ...(live.session.title === "New chat" ? { title: titleFromPrompt(prompt) } : {}),
      providerId: turnModel.providerId,
      model: turnModel.model ?? null
    });
    live.session = updated;
    this.options.bus.publish({ kind: "turn-completed", sessionId, runId, status: terminalStatus });
    return { runId, status: terminalStatus, eventCount };
  }

  async cancelTurn(sessionId: SessionId): Promise<void> {
    const live = this.requiredLiveSession(sessionId);
    if (live.activeTurn === undefined) {
      return;
    }
    live.activeTurn.cancelRequested = true;
    if (live.activeTurn.runId !== undefined) {
      await live.adapter.cancel(live.connection, live.activeTurn.runId);
    }
  }

  /**
   * Soft nudge for a turn that has gone quiet ("Give it a poke?"): asks the
   * adapter to interrupt the current turn WITHOUT cancelling it, so a standoff
   * can resolve gracefully while the session stays live. Returns false when
   * there is nothing to poke (no live turn, or the adapter has no poke path).
   */
  async pokeTurn(sessionId: SessionId): Promise<boolean> {
    const live = this.liveSessions.get(sessionId);
    if (live?.activeTurn?.runId === undefined || live.adapter.poke === undefined) {
      return false;
    }
    await live.adapter.poke(live.connection, live.activeTurn.runId);
    return true;
  }

  /**
   * Runs a one-off prompt through a SIDECAR connection on the session's live
   * runtime: a fresh adapter connection under synthetic ids, sharing the
   * already-running container but not the session's conversation thread. No
   * event is appended and nothing is published, so the durable transcript and
   * the visible chat are untouched by construction. Used for out-of-band asks
   * (the AI chat summary) whose result must not become part of the chat.
   * Returns the agent's final text.
   */
  async runSidecarPrompt(sessionId: SessionId, prompt: string): Promise<string> {
    await this.guardRunningElsewhere(sessionId);
    const live = this.requiredLiveSession(sessionId);
    if (this.sidecarBusy.has(sessionId)) {
      throw new Error(`Session ${sessionId} already has a sidecar prompt in flight.`);
    }
    this.sidecarBusy.add(sessionId);
    try {
      // Synthetic ids: adapter connection state is keyed by generation+agent,
      // and no session row exists under this id, so the sidecar can neither
      // clobber the live connection nor leak rows into any transcript.
      const connection = await live.adapter.startProtocol({
        sessionId: this.options.ids.sessionId(),
        agentId: this.options.ids.agentId(),
        agentRole: sessionRole(live.session),
        runtime: live.runtime,
        transport: live.transport
      });
      try {
        const runId = await live.adapter.sendPrompt(connection, {
          text: prompt,
          cwd: live.runtime.runtimeCwd ?? live.runtime.workspacePath,
          metadata: modelMetadata(live.model)
        });
        let finalText = "";
        let failure: string | undefined;
        for await (const event of live.adapter.streamEvents(connection, runId)) {
          if (event.type === "agent.text" && event.final && event.text.length > 0) {
            finalText = event.text;
          } else if (event.type === "agent.error") {
            failure = failure ?? event.message;
          } else if (event.type === "agent.done" && event.status !== "completed") {
            failure = failure ?? `The sidecar turn was ${event.status}.`;
          }
        }
        if (failure !== undefined) {
          throw new Error(failure);
        }
        if (finalText.length === 0) {
          throw new Error("The agent returned no text for the sidecar prompt.");
        }
        return finalText;
      } finally {
        try {
          await live.adapter.stop(connection, "sidecar prompt finished");
        } catch (error) {
          this.options.logger.warn("sidecar connection stop failed", {
            sessionId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    } finally {
      this.sidecarBusy.delete(sessionId);
    }
  }

  listModels(sessionId: SessionId): Promise<AgentModelCatalog> {
    const live = this.requiredLiveSession(sessionId);
    return live.adapter.listModels(live.connection);
  }

  /**
   * Restarts the session backend, optionally switching provider/model. A
   * provider switch is a restart: the requested provider's adapter boots a new
   * runtime + connection on the given transport and the same context is
   * replayed. `transport` must match the requested provider (the caller owns
   * the provider→transport mapping); it defaults to the live transport, which
   * only stays valid on a same-provider restart. A failure past the point the
   * old runtime is torn down leaves the session failed, mirroring startSession.
   */
  async restartSession(sessionId: SessionId, model: ChatModelSelection, reason: string, transport?: AgentTransport): Promise<ChatSessionRecord> {
    await this.guardRunningElsewhere(sessionId);
    const live = this.requiredLiveSession(sessionId);
    if (live.activeTurn !== undefined) {
      throw new Error(`Session ${sessionId} already has an active turn.`);
    }
    const adapter = this.requiredAdapter(model.providerId);
    const nextTransport = transport ?? live.transport;
    // A provider switch must run in the NEW provider's sandbox (its own agent
    // image + egress); reusing the old template booted e.g. Codex inside the
    // Claude image, where `codex app-server` never answers initialize.
    const nextTemplate = model.providerId === live.model.providerId
      ? live.template
      : withSandboxProvider(live.template, toSandboxProvider(model.providerId));

    try {
      await live.adapter.stop(live.connection, reason);
    } catch (error) {
      this.options.logger.warn("chat adapter stop failed during restart", {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    await this.options.cleanup.cleanupRuntime(live.runtime.runtimeId, "graceful");

    const runtimeId = this.options.ids.runtimeId();
    const generationId = this.options.ids.runtimeGenerationId();
    const agentId = this.options.ids.agentId();
    try {
      const runtime = await this.options.lifecycle.startRuntime({
        sessionId: live.session.sessionId,
        chatId: live.session.chatId,
        agentId,
        agentRole: sessionRole(live.session),
        template: nextTemplate,
        workspacePath: live.workspacePath,
        generationId,
        runtimeId,
        ...(live.workspaceOwnerToken === undefined ? {} : { workspaceOwnerToken: live.workspaceOwnerToken })
      });
      const connection = await adapter.startProtocol({
        sessionId: live.session.sessionId,
        agentId,
        agentRole: sessionRole(live.session),
        runtime,
        transport: nextTransport
      });

      try {
        await adapter.restoreContext(connection, await this.contextMessages(sessionId));
      } catch (error) {
        this.options.logger.warn("chat context restore failed during restart", {
          sessionId,
          providerId: model.providerId,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      live.runtime = runtime;
      live.connection = connection;
      live.adapter = adapter;
      live.transport = nextTransport;
      live.template = nextTemplate;
      live.model = model;
      // A restart re-boots the backend under this host, so it re-stamps
      // ownership + heartbeat exactly like a fresh activation.
      const updated = await this.updateSession(live.session, {
        status: "active",
        runtimeId,
        providerId: model.providerId,
        model: model.model ?? null,
        hostInstanceId: this.options.hostInstanceId,
        heartbeatAt: this.options.clock.isoNow()
      });
      live.session = updated;
      this.options.bus.publish({ kind: "inventory-changed" });
      return updated;
    } catch (error) {
      // The old generation is already torn down; a failed boot must not leave a
      // live session pointing at a dead runtime. Mark it failed and drop it from
      // the live map (the workspace is not disposed — a later new chat owns its
      // own workspace, and this one is cleaned up by startup reconciliation).
      this.liveSessions.delete(sessionId);
      await this.updateSession(live.session, { status: "failed", endedAt: this.options.clock.isoNow() });
      this.options.logger.error("chat session restart failed", {
        sessionId,
        providerId: model.providerId,
        error: error instanceof Error ? error.message : String(error)
      });
      this.options.bus.publish({ kind: "inventory-changed" });
      throw error;
    }
  }

  /**
   * Widens the session's mounts after an approved access request. Only this
   * session's runtime generation restarts; the expanded template persists on
   * the live session so later restarts keep the approved mount. Edits inside
   * existing mounts live on the host and survive; conversation context is
   * restored by the restart flow.
   */
  async expandSessionMounts(sessionId: SessionId, addedMounts: readonly MountPolicy[], reason: string): Promise<ChatSessionRecord> {
    const live = this.requiredLiveSession(sessionId);
    // Threat-model rule: a role child can never out-grow its parent.
    // Approving a new mount on the child requires the PARENT to already hold
    // it — grant to the parent first, then to the child. A parent that is not
    // live in this host cannot vouch, so the expansion is refused outright.
    const parentSessionId = live.session.parentSessionId;
    if (parentSessionId !== undefined) {
      const parent = this.liveSessions.get(parentSessionId);
      if (parent === undefined) {
        throw new Error(
          "This role session's parent is not live in this window, so its access cannot be widened. Grant the path to the parent session first."
        );
      }
      assertChildMountsWithinParent(addedMounts, parent.template.mounts);
    }
    live.template = { ...live.template, mounts: [...live.template.mounts, ...addedMounts] };
    return this.restartSession(sessionId, live.model, reason);
  }

  /**
   * Read-only snapshot for spawning a role child: the parent's
   * current mounts/template, model, and transport. Null when the session is
   * not live in this host.
   */
  liveSpawnSnapshot(sessionId: SessionId): { template: RuntimeTemplate; model: ChatModelSelection; transport: AgentTransport } | null {
    const live = this.liveSessions.get(sessionId);
    if (live === undefined) return null;
    return { template: live.template, model: live.model, transport: live.transport };
  }

  async endSession(sessionId: SessionId, reason: string): Promise<ChatSessionRecord> {
    const live = this.liveSessions.get(sessionId);
    if (live !== undefined) {
      if (live.activeTurn !== undefined) {
        await this.cancelTurn(sessionId);
      }
      try {
        await live.adapter.stop(live.connection, reason);
      } catch (error) {
        this.options.logger.warn("chat adapter stop failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      const cleanup = await this.options.cleanup.cleanupRuntime(live.runtime.runtimeId, "graceful");
      const status: ChatSessionStatus = cleanup.status === "removed" ? "ended" : "failed";
      // Releasing ownership (null) lets a later window resume without hitting a
      // foreign-heartbeat guard against a session that is no longer running.
      const ended = await this.updateSession(live.session, {
        status,
        endedAt: this.options.clock.isoNow(),
        hostInstanceId: null,
        heartbeatAt: null
      });
      this.liveSessions.delete(sessionId);
      await this.disposeWorkspaceQuietly(live.disposeWorkspace);
      this.options.bus.publish({ kind: "inventory-changed" });
      return ended;
    }

    const stored = await this.options.sessionStore.getSession(sessionId);
    if (stored === null) {
      throw new Error(`Session ${sessionId} was not found.`);
    }
    // Guard: a session running in another live window is read-only here.
    this.assertNotRunningElsewhere(stored);
    if (stored.status === "ended" || stored.status === "failed") {
      return stored;
    }
    let nextStatus: ChatSessionStatus = "ended";
    if (stored.runtimeId !== undefined) {
      const cleanup = await this.options.cleanup.cleanupRuntime(stored.runtimeId, "graceful");
      if (cleanup.status !== "removed") {
        nextStatus = "failed";
      }
    }
    this.options.bus.publish({ kind: "inventory-changed" });
    return this.updateSession(stored, {
      status: nextStatus,
      endedAt: this.options.clock.isoNow(),
      hostInstanceId: null,
      heartbeatAt: null
    });
  }

  async renameSession(sessionId: SessionId, title: string): Promise<ChatSessionRecord> {
    const record = await this.requiredStoredSession(sessionId);
    const updated = await this.updateSession(record, { title });
    this.syncLiveRecord(updated);
    return updated;
  }

  /**
   * Force-claims a not-live session's ownership for THIS host instance with a
   * fresh heartbeat — the backend half of "Take over here". It clears the
   * running-elsewhere lock (isFreshForeignHeartbeat now sees our own id) so this
   * window can revive/drive the session. A session already live here is returned
   * unchanged. The caller (reclaim) then resumes it on a fresh runtime; the
   * previous owner's container, if any, is left for reconciliation to reap.
   */
  async claimOwnership(sessionId: SessionId): Promise<ChatSessionRecord> {
    const live = this.liveSessions.get(sessionId);
    if (live !== undefined) {
      return live.session;
    }
    const record = await this.requiredStoredSession(sessionId);
    return this.updateSession(record, {
      hostInstanceId: this.options.hostInstanceId,
      heartbeatAt: this.options.clock.isoNow()
    });
  }

  /** An empty string clears the stored description (persisted as NULL). */
  async setSessionDescription(sessionId: SessionId, description: string): Promise<ChatSessionRecord> {
    const record = await this.requiredStoredSession(sessionId);
    const updated = await this.updateSession(record, { description: description.length === 0 ? null : description });
    this.syncLiveRecord(updated);
    return updated;
  }

  /**
   * Ends a live session first (runtime cleanup included), then removes its
   * durable events and the session row, then announces the deletion. Event
   * rows are deleted before the session row so a crash mid-delete never leaves
   * orphaned events pointing at a missing session.
   */
  async deleteSession(sessionId: SessionId): Promise<void> {
    const stored = await this.options.sessionStore.getSession(sessionId);
    if (stored === null) {
      throw new Error(`Session ${sessionId} was not found.`);
    }
    // Guard runs before any destructive step: a session live in another window
    // must not have its runtime, events, or row deleted from here.
    if (!this.liveSessions.has(sessionId)) {
      this.assertNotRunningElsewhere(stored);
    }
    if (this.liveSessions.has(sessionId)) {
      await this.endSession(sessionId, "session-delete");
    }
    await this.deletableEventStore().deleteSessionEvents(sessionId);
    await this.options.sessionStore.deleteSession(sessionId);
    this.options.bus.publish({ kind: "session-deleted", sessionId });
  }

  listSessions(limit?: number): Promise<ChatSessionRecord[]> {
    return this.options.sessionStore.listSessions(limit);
  }

  /** The durable session record, or null when the id is unknown. */
  getSession(sessionId: SessionId): Promise<ChatSessionRecord | null> {
    return this.options.sessionStore.getSession(sessionId);
  }

  getTimeline(sessionId: SessionId, fromSequence?: number): Promise<StoredEvent[]> {
    return this.options.eventStore.listEvents(sessionId, fromSequence);
  }

  isSessionLive(sessionId: SessionId): boolean {
    const session = this.liveSessions.get(sessionId);
    return session !== undefined && session.session.status === "active";
  }

  hasActiveTurn(sessionId: SessionId): boolean {
    return this.liveSessions.get(sessionId)?.activeTurn !== undefined;
  }

  /**
   * The live session's mounts, projected for the session briefing. Empty when
   * the session is not live in this host. hostDisplayPath is the template
   * mount's host path verbatim — it stays host-side; only the app layer's
   * briefing text ever consumes it.
   */
  getSessionMounts(sessionId: SessionId): readonly { runtimePath: string; mode: "read-only" | "read-write"; hostDisplayPath?: string }[] {
    const live = this.liveSessions.get(sessionId);
    if (live === undefined) {
      return [];
    }
    return live.template.mounts.map((mount) => ({
      runtimePath: mount.runtimePath,
      mode: mount.mode,
      hostDisplayPath: mount.hostPath
    }));
  }

  /**
   * The live session's host workspace path (the temp dir mounted into the VM),
   * or null when the session is not live in this host. Plan-doc collection reads
   * `<workspacePath>/plan` from it after a plan-mode turn.
   */
  getSessionWorkspacePath(sessionId: SessionId): string | null {
    return this.liveSessions.get(sessionId)?.workspacePath ?? null;
  }

  /**
   * Starts the periodic liveness heartbeat and returns a disposer that stops it.
   * The service has no dispose() of its own, so the composition root owns the
   * returned disposer (it fires on backend disposal / window teardown). Each
   * tick re-stamps heartbeatAt for every session live in this process; a store
   * failure for one session is swallowed+warned so the others still refresh.
   */
  startHeartbeats(): () => void {
    if (this.heartbeatTimer !== undefined) {
      return () => this.stopHeartbeats();
    }
    this.heartbeatTimer = setInterval(() => {
      void this.beatOnce();
    }, this.heartbeatIntervalMs);
    // Do not keep the host process alive solely for the heartbeat timer.
    this.heartbeatTimer.unref?.();
    return () => this.stopHeartbeats();
  }

  private stopHeartbeats(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  /**
   * One heartbeat pass, extracted for direct invocation in tests. Writes a fresh
   * heartbeatAt (ownership already stamped at boot) for every live session,
   * isolating per-session store failures so one bad write cannot stall the rest.
   */
  async beatOnce(): Promise<void> {
    const now = this.options.clock.isoNow();
    for (const [sessionId, live] of this.liveSessions) {
      try {
        const updated = await this.updateSession(live.session, { heartbeatAt: now });
        live.session = updated;
      } catch (error) {
        this.options.logger.warn("chat session heartbeat failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  /**
   * Startup reconciliation across a shared state root. For every stored
   * session that reads starting/active but is not live in THIS process:
   *  - fresh foreign heartbeat → running in another window; leave it untouched;
   *  - stale/absent heartbeat + container gone → end it (the old behaviour);
   *  - stale/absent heartbeat + container alive + adoptable transport → adopt
   *    it (reattach to the surviving container with no new container, no context
   *    restore — exec transports keep in-container CLI state);
   *  - stale/absent heartbeat + container alive + non-adoptable transport
   *    (codex-app-server, whose live process cannot be reattached) → end it.
   * `externalRuntimeNames` is the adapter's current external-name set, fetched
   * once by the caller. Returns counts for the startup log line.
   */
  async reconcileSessions(externalRuntimeNames: ReadonlySet<string>): Promise<ReconcileCounts> {
    const sessions = await this.options.sessionStore.listSessions();
    const counts: MutableReconcileCounts = { ended: 0, adopted: 0, elsewhere: 0 };
    for (const session of sessions) {
      if (session.status !== "starting" && session.status !== "active") {
        continue;
      }
      if (this.liveSessions.has(session.sessionId)) {
        // Already recovered/owned in this process; nothing to reconcile.
        continue;
      }
      if (this.isFreshForeignHeartbeat(session)) {
        counts.elsewhere += 1;
        continue;
      }
      try {
        const adopted = await this.tryAdoptOrEnd(session, externalRuntimeNames);
        if (adopted) {
          counts.adopted += 1;
        } else {
          counts.ended += 1;
        }
      } catch (error) {
        this.options.logger.warn("chat session reconciliation failed", {
          sessionId: session.sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
        counts.ended += 1;
      }
    }
    return counts;
  }

  /**
   * Reconciles one stale (or unowned) stored session: adopts it if its container
   * still runs and its transport is adoptable, otherwise ends it. Returns true
   * when the session was adopted (now live here), false when it was ended.
   */
  private async tryAdoptOrEnd(session: ChatSessionRecord, externalRuntimeNames: ReadonlySet<string>): Promise<boolean> {
    const record = session.runtimeId === undefined
      ? null
      : await this.options.inventory.getRuntime(session.runtimeId);
    const containerAlive = record !== null && externalRuntimeNames.has(record.externalName);
    if (!containerAlive || record === null) {
      await this.endSession(session.sessionId, "startup-reconcile");
      return false;
    }
    // Container is alive. Non-adoptable transports (codex-app-server) hold a live
    // process we cannot reattach to, so the honest move is to end + clean up.
    const transport = session.transport as AgentTransport;
    if (!ADOPTABLE_TRANSPORTS.has(transport)) {
      await this.endSession(session.sessionId, "startup-reconcile-nonadoptable");
      return false;
    }
    const adapter = this.options.agentAdapters.get(session.providerId);
    if (adapter === undefined) {
      this.options.logger.warn("cannot adopt session: no adapter for provider", {
        sessionId: session.sessionId,
        providerId: session.providerId
      });
      await this.endSession(session.sessionId, "startup-reconcile-no-adapter");
      return false;
    }
    await this.adoptSession(session, record, adapter, transport);
    return true;
  }

  /**
   * Reattaches to a surviving container (adoption). Rebuilds a RuntimeHandle
   * from the persisted inventory record, starts the protocol against the
   * EXISTING container (exec transports do not create one), registers a
   * LiveSession, and stamps ownership + a fresh heartbeat. No context is
   * restored: exec transports keep their in-container CLI state (claude's own
   * --resume state survives), so the conversation is intact.
   *
   * Adoption limitations, documented honestly: the inventory record does not
   * persist the original RuntimeTemplate, so a MINIMAL template is reconstructed
   * (id from templateId, adapter kind, empty mounts). That is sufficient for
   * turns — sendTurn/exec only need the handle's externalName + cwd — but a
   * later restartSession or expandSessionMounts on an adopted session boots a
   * fresh runtime from this minimal template and thus loses the original mounts
   * (it falls back to a fresh resume of the transcript). getSessionMounts also
   * projects empty for an adopted session until it is restarted.
   */
  private async adoptSession(
    session: ChatSessionRecord,
    record: RuntimeInventoryRecord,
    adapter: AgentAdapter,
    transport: AgentTransport
  ): Promise<void> {
    const runtime = handleFromInventoryRecord(record);
    const agentId = this.options.ids.agentId();
    const connection = await adapter.startProtocol({
      sessionId: session.sessionId,
      agentId,
      agentRole: record.agentRole ?? sessionRole(session),
      runtime,
      transport
    });
    const template = minimalTemplateFromRecord(record);
    const workspacePath = runtime.workspacePath;
    // Stamp ownership + heartbeat and flip to active (a "starting" row that was
    // never activated is now adopted live). No restoreContext — see doc comment.
    const active = await this.updateSession(session, {
      status: "active",
      hostInstanceId: this.options.hostInstanceId,
      heartbeatAt: this.options.clock.isoNow()
    });
    this.liveSessions.set(session.sessionId, {
      session: active,
      adapter,
      transport,
      template,
      workspacePath,
      ...(record.workspaceOwnerToken === undefined ? {} : { workspaceOwnerToken: record.workspaceOwnerToken }),
      runtime,
      connection,
      model: modelFromRecord(session)
    });
    this.options.logger.info("chat session adopted", {
      sessionId: session.sessionId,
      externalName: record.externalName,
      transport
    });
    this.options.bus.publish({ kind: "inventory-changed" });
  }

  private async updateSession(
    current: ChatSessionRecord,
    update: {
      readonly status?: ChatSessionStatus;
      readonly title?: string;
      readonly description?: string | null;
      readonly runtimeId?: ChatSessionRecord["runtimeId"];
      readonly providerId?: string;
      readonly model?: string | null;
      readonly hostInstanceId?: string | null;
      readonly heartbeatAt?: string | null;
      readonly endedAt?: string;
    }
  ): Promise<ChatSessionRecord> {
    const updatedAt = this.options.clock.isoNow();
    await this.options.sessionStore.updateSession(current.sessionId, {
      updatedAt,
      ...(update.status === undefined ? {} : { status: update.status }),
      ...(update.title === undefined ? {} : { title: update.title }),
      ...(update.description === undefined ? {} : { description: update.description }),
      ...(update.runtimeId === undefined ? {} : { runtimeId: update.runtimeId }),
      ...(update.providerId === undefined ? {} : { providerId: update.providerId }),
      ...(update.model === undefined ? {} : { model: update.model }),
      ...(update.hostInstanceId === undefined ? {} : { hostInstanceId: update.hostInstanceId }),
      ...(update.heartbeatAt === undefined ? {} : { heartbeatAt: update.heartbeatAt }),
      ...(update.endedAt === undefined ? {} : { endedAt: update.endedAt })
    });
    const base = update.description === null ? withoutDescription(current) : current;
    const withoutModelBase = update.model === null ? withoutModel(base) : base;
    // null clears ownership from the projection too; a string stamps it.
    const withoutOwnershipBase = clearOwnershipIfNull(withoutModelBase, update);
    const next: ChatSessionRecord = {
      ...withoutOwnershipBase,
      ...(update.title === undefined ? {} : { title: update.title }),
      ...(update.description === undefined || update.description === null ? {} : { description: update.description }),
      ...(update.status === undefined ? {} : { status: update.status }),
      ...(update.providerId === undefined ? {} : { providerId: update.providerId }),
      ...(update.model === undefined || update.model === null ? {} : { model: update.model }),
      ...(update.runtimeId === undefined ? {} : { runtimeId: update.runtimeId }),
      ...(update.hostInstanceId === undefined || update.hostInstanceId === null ? {} : { hostInstanceId: update.hostInstanceId }),
      ...(update.heartbeatAt === undefined || update.heartbeatAt === null ? {} : { heartbeatAt: update.heartbeatAt }),
      updatedAt,
      ...(update.endedAt === undefined ? {} : { endedAt: update.endedAt })
    };
    this.options.bus.publish({ kind: "session-updated", session: next });
    return next;
  }

  private async requiredStoredSession(sessionId: SessionId): Promise<ChatSessionRecord> {
    const stored = await this.options.sessionStore.getSession(sessionId);
    if (stored === null) {
      throw new Error(`Session ${sessionId} was not found.`);
    }
    return stored;
  }

  /**
   * True when the stored record carries a fresh heartbeat owned by a DIFFERENT
   * host instance — i.e. the session is live in another VS Code window. A record
   * this host owns is never "foreign" even if its heartbeat is fresh. Invariant:
   * callers must have already confirmed the session is not live in this process.
   */
  private isFreshForeignHeartbeat(record: ChatSessionRecord): boolean {
    if (record.hostInstanceId === undefined || record.hostInstanceId === this.options.hostInstanceId) {
      return false;
    }
    if (record.heartbeatAt === undefined) {
      return false;
    }
    const age = new Date(this.options.clock.isoNow()).getTime() - new Date(record.heartbeatAt).getTime();
    return age < this.heartbeatStaleMs;
  }

  /**
   * Refuses a destructive/mutating operation on a session another live window
   * owns. Explicit takeover goes through claimOwnership/reclaim first, which
   * stamps this host as owner before resuming on a fresh runtime.
   */
  private assertNotRunningElsewhere(record: ChatSessionRecord): void {
    if (this.isFreshForeignHeartbeat(record)) {
      throw new Error(`Session ${record.sessionId} is running in another VS Code window.`);
    }
  }

  /**
   * For operations that fall through to requiredLiveSession (sendTurn,
   * restartSession): if the session is not live here, surface the specific
   * "running in another window" error before the generic not-active one. A
   * session live here is ours, so no store read is needed.
   */
  private async guardRunningElsewhere(sessionId: SessionId): Promise<void> {
    if (this.liveSessions.has(sessionId)) {
      return;
    }
    const stored = await this.options.sessionStore.getSession(sessionId);
    if (stored !== null) {
      this.assertNotRunningElsewhere(stored);
    }
  }

  /** Keeps a live session's cached record in step with metadata-only edits. */
  private syncLiveRecord(record: ChatSessionRecord): void {
    const live = this.liveSessions.get(record.sessionId);
    if (live !== undefined) {
      live.session = record;
    }
  }

  private deletableEventStore(): EventDeletingStore {
    const store = this.options.eventStore as Partial<EventDeletingStore>;
    if (typeof store.deleteSessionEvents !== "function") {
      throw new Error("The configured event store cannot delete session events.");
    }
    return store as EventDeletingStore;
  }

  private requiredAdapter(providerId: string): AgentAdapter {
    const adapter = this.options.agentAdapters.get(providerId);
    if (adapter === undefined) {
      throw new Error(`No agent adapter is registered for provider ${providerId}.`);
    }
    return adapter;
  }

  private requiredLiveSession(sessionId: SessionId): LiveSession {
    const live = this.liveSessions.get(sessionId);
    if (live === undefined || live.session.status !== "active") {
      throw new Error(`Session ${sessionId} is not active in this extension host.`);
    }
    return live;
  }

  private async appendUserMessage(live: LiveSession, text: string, model: ChatModelSelection): Promise<void> {
    const createdAt = this.options.clock.isoNow();
    const sequence = await this.options.eventStore.appendStoredEvent({
      id: this.options.ids.eventId(),
      sessionId: live.session.sessionId,
      eventType: "user.message",
      createdAt,
      payload: {
        text,
        providerId: model.providerId,
        ...(model.model === undefined ? {} : { model: model.model })
      }
    });
    this.options.bus.publish({
      kind: "transcript-line",
      sessionId: live.session.sessionId,
      sequence,
      line: { eventType: "user.message", createdAt, summary: text }
    });
  }

  private async contextMessages(sessionId: SessionId): Promise<AgentContextMessage[]> {
    const events = await this.options.eventStore.listEvents(sessionId);
    const messages: AgentContextMessage[] = [];
    for (const event of events) {
      if (event.eventType === "user.message") {
        const raw = event.payload["text"];
        if (typeof raw === "string" && raw.length > 0) {
          // Strip the host briefing so restored context is just the dialogue —
          // replaying mount/protocol boilerplate crowds out real history.
          const text = stripHostBriefing(raw);
          if (text.length > 0) {
            messages.push({ role: "user", text, createdAt: event.createdAt });
          }
        }
        continue;
      }
      // Only final agent.text becomes assistant context. agent.reasoning is
      // DISPLAY-ONLY (see AgentReasoningEvent in contracts/events.ts) — it is
      // the agent's own scratch thinking, not user/assistant dialogue, and is
      // naturally excluded here since it never matches "agent.text". It still
      // flows through appendAndPublish like any other agent event (stored +
      // pushed to the webview) — that part is correct; only replay-as-context
      // must skip it.
      if (event.eventType !== "agent.text") {
        continue;
      }
      const payload = event.payload as { readonly text?: unknown; readonly final?: unknown };
      if (payload.final === true && typeof payload.text === "string" && payload.text.length > 0) {
        messages.push({ role: "assistant", text: payload.text, createdAt: event.createdAt });
      }
    }
    return messages;
  }

  private async appendAndPublish(event: AgentEvent): Promise<number> {
    const sequence = await this.options.eventStore.appendAgentEvent(event);
    this.options.bus.publish({ kind: "agent-event", sessionId: event.sessionId, runId: event.runId, sequence, event });
    return sequence;
  }

  private errorEvent(live: LiveSession, runId: TurnResult["runId"], error: unknown, code: string): AgentErrorEvent {
    return {
      id: this.options.ids.eventId(),
      type: "agent.error",
      sessionId: live.session.sessionId,
      runId,
      agentId: live.connection.agentId,
      agentRole: live.connection.agentRole,
      runtimeId: live.runtime.runtimeId,
      createdAt: this.options.clock.isoNow(),
      code,
      message: error instanceof Error ? error.message : String(error),
      retryable: code !== "TURN_CANCELLED",
      raw: { synthetic: true }
    };
  }

  private doneEvent(live: LiveSession, runId: TurnResult["runId"], status: TurnTerminalStatus, raw: AgentDoneEvent["raw"]): AgentDoneEvent {
    return {
      id: this.options.ids.eventId(),
      type: "agent.done",
      sessionId: live.session.sessionId,
      runId,
      agentId: live.connection.agentId,
      agentRole: live.connection.agentRole,
      runtimeId: live.runtime.runtimeId,
      createdAt: this.options.clock.isoNow(),
      status,
      ...(raw === undefined ? {} : { raw })
    };
  }

  private async disposeWorkspaceQuietly(disposeWorkspace: (() => Promise<void>) | undefined): Promise<void> {
    if (disposeWorkspace === undefined) {
      return;
    }
    try {
      await disposeWorkspace();
    } catch (error) {
      this.options.logger.warn("chat workspace cleanup failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

export interface ReconcileCounts {
  readonly ended: number;
  readonly adopted: number;
  readonly elsewhere: number;
}

interface MutableReconcileCounts {
  ended: number;
  adopted: number;
  elsewhere: number;
}

/**
 * Rebuilds a running RuntimeHandle from a persisted inventory record for
 * adoption. Faithful for exec transports: exec (dockerSandboxRuntimeAdapter)
 * addresses the container purely by externalName, and sendPrompt's cwd comes
 * from runtimeCwd ?? workspacePath — both persisted (workspacePath in metadata,
 * runtimeCwd derived below). mounts is empty because the inventory record only
 * stores a mount COUNT, not the policies; that is acceptable because exec/turns
 * never read handle.mounts (only createRuntime does, and adoption never creates
 * a container). Mirrors handleFromRecord in runtimeLifecycleService.
 */
function handleFromInventoryRecord(record: RuntimeInventoryRecord): RuntimeHandle {
  const workspacePath = typeof record.metadata["workspacePath"] === "string" ? record.metadata["workspacePath"] : "";
  const runtimeCwd = typeof record.metadata["runtimeCwd"] === "string"
    ? record.metadata["runtimeCwd"]
    : toContainerCwd(workspacePath);
  return {
    runtimeId: record.runtimeId,
    runtimeGenerationId: record.runtimeGenerationId,
    sessionId: record.sessionId,
    adapter: record.adapter,
    externalName: record.externalName,
    workspacePath,
    ...(runtimeCwd === undefined ? {} : { runtimeCwd }),
    mounts: [],
    status: "running"
  };
}

/**
 * Best-effort in-container cwd for an adopted handle when the record never
 * persisted runtimeCwd. Mirrors dockerSandboxRuntimeAdapter's Windows→POSIX
 * drive rewrite; a non-Windows path passes through. Only used as a cwd hint for
 * exec — a wrong value degrades to the container default, never a host escape.
 */
function toContainerCwd(hostPath: string): string | undefined {
  if (hostPath.length === 0) {
    return undefined;
  }
  const normalized = hostPath.replace(/\\/g, "/");
  const drive = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (drive) {
    return `/${(drive[1] ?? "").toLowerCase()}/${drive[2] ?? ""}`;
  }
  return normalized;
}

/**
 * The minimal RuntimeTemplate stored on an adopted LiveSession. The original
 * template is not persisted in inventory, so this reconstruction carries only
 * what LiveSession structurally requires; empty mounts mean a later restart of
 * an adopted session loses the original mounts (documented in adoptSession).
 */
function minimalTemplateFromRecord(record: RuntimeInventoryRecord): RuntimeTemplate {
  return {
    id: record.templateId,
    type: record.adapter as RuntimeTemplate["type"],
    network: "disabled",
    mounts: [],
    environment: {},
    adapterProviderIds: [],
    advancedOptions: {}
  };
}

/** The session row's persisted provider/model, projected as a ChatModelSelection. */
function modelFromRecord(session: ChatSessionRecord): ChatModelSelection {
  return {
    providerId: session.providerId,
    ...(session.model === undefined ? {} : { model: session.model })
  };
}

function modelMetadata(model: ChatModelSelection): { readonly providerId: string; readonly model?: string } {
  return {
    providerId: model.providerId,
    ...(model.model === undefined ? {} : { model: model.model })
  };
}

function titleFromPrompt(prompt: string): string {
  return prompt.length > 64 ? `${prompt.slice(0, 64)}…` : prompt;
}

function withoutModel(session: ChatSessionRecord): ChatSessionRecord {
  return {
    sessionId: session.sessionId,
    chatId: session.chatId,
    title: session.title,
    ...(session.description === undefined ? {} : { description: session.description }),
    status: session.status,
    providerId: session.providerId,
    transport: session.transport,
    ...(session.mode === undefined ? {} : { mode: session.mode }),
    ...(session.runtimeId === undefined ? {} : { runtimeId: session.runtimeId }),
    ...(session.hostInstanceId === undefined ? {} : { hostInstanceId: session.hostInstanceId }),
    ...(session.heartbeatAt === undefined ? {} : { heartbeatAt: session.heartbeatAt }),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.endedAt === undefined ? {} : { endedAt: session.endedAt })
  };
}

function withoutDescription(session: ChatSessionRecord): ChatSessionRecord {
  const { description: _description, ...rest } = session;
  return rest;
}

/**
 * Drops hostInstanceId/heartbeatAt from the projected record when the update
 * clears them (null). Each field is cleared independently so a heartbeat-only
 * refresh never strips ownership and vice versa.
 */
function clearOwnershipIfNull(
  session: ChatSessionRecord,
  update: { readonly hostInstanceId?: string | null; readonly heartbeatAt?: string | null }
): ChatSessionRecord {
  let next = session;
  if (update.hostInstanceId === null) {
    const { hostInstanceId: _hostInstanceId, ...rest } = next;
    next = rest;
  }
  if (update.heartbeatAt === null) {
    const { heartbeatAt: _heartbeatAt, ...rest } = next;
    next = rest;
  }
  return next;
}
