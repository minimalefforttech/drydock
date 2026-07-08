/**
 * Isolated-run application service facade.
 *
 * Owns the workflow orchestration that used to live inside command callbacks:
 * disposable workspace provisioning, runtime template construction, the
 * app-server probe sequence, and cleanup. Commands and the control panel are
 * both thin delegations into this service, so there is exactly one truth for
 * "run an isolated prompt". No `vscode` imports belong here.
 */

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { claudeModelCatalog, fetchCodexHostModelCatalog } from "@drydock/agent-adapters";
import { TempWorkspaceStore, type TempWorkspace } from "@drydock/artifacts";
import {
  asId,
  MEMORY_BRIEFING_LIMIT,
  summarizeAgentEvent,
  summarizeStoredEvent,
  type AgentModelCatalog,
  type AgentEvent,
  type AgentRole,
  type AgentTransport,
  type AppServerProbeResult,
  type ChatModelSelection,
  type CloneRepoState,
  type CloneSyncResult,
  type CommandResult,
  type CommandRunner,
  type ProviderAuthStatus,
  type ChatSessionRecord,
  type CleanupMode,
  type CleanupResult,
  type IsolationSummary,
  type RuntimeHandle,
  type RuntimeInventoryRecord,
  type RuntimeInventoryStore,
  type RuntimeStatsSummary,
  type RuntimeSummary,
  type RuntimeTemplate,
  type SequencedTranscriptLine,
  type SessionId,
  type SessionMode,
  type TurnResult
} from "@drydock/contracts";
import {
  assertChildMountsWithinParent,
  assertMountAllowed,
  buildSessionBriefing,
  buildIsolatedRunTemplate,
  ChatSessionService,
  CloneSyncService,
  DEFAULT_HEARTBEAT_STALE_MS,
  RuntimeCleanupService,
  RuntimeLifecycleService,
  IsolatedRunWorkflow,
  normalizePathKey,
  type Clock,
  type IdGenerator,
  type Logger
} from "@drydock/core";
import type { MemoryService } from "@drydock/work-management";

export const ISOLATED_RUN_DEFAULT_PROMPT = "Create smoke-result.txt containing exactly DRYDOCK_SMOKE_OK, then say smoke-ok.";

export interface AppServerProber {
  probe(runtime: RuntimeHandle, prompt: string): Promise<AppServerProbeResult>;
}

export interface IsolatedRunServiceOptions {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly workspaceStore: TempWorkspaceStore;
  readonly workflow: IsolatedRunWorkflow;
  readonly lifecycle: RuntimeLifecycleService;
  readonly cleanup: RuntimeCleanupService;
  readonly inventory: RuntimeInventoryStore;
  readonly prober: AppServerProber;
  readonly chatService: ChatSessionService;
  /** Clone mode: host-side git plumbing for the workspace clones + sync. */
  readonly cloneSync: CloneSyncService;
  /**
   * This extension host's identity. The same id the ChatSessionService
   * stamps onto sessions it owns; the panel uses it to tell a session running
   * in THIS window from one running elsewhere.
   */
  readonly hostInstanceId: string;
  /** Approved team memory injected into the first briefing of each session. */
  readonly memoryService?: MemoryService;
  readonly deniedPaths?: readonly string[];
  /** Host sbx binary, used for inert auth-status checks and login commands. */
  readonly sbxPath?: string;
  readonly commandRunner?: CommandRunner;
  /** Host codex binary, used for inert app-server model discovery. */
  readonly hostCodexPath?: string;
}

/** Resolved workspace mounting for a chat session. */
export interface ChatWorkspaceContext {
  /** Absent for the `auto` selection, which has no backing workspace set. */
  readonly workspaceSetId?: string;
  readonly mode: SessionMode;
  /** Ordered absolute project roots (from a set, or the open folders). */
  readonly roots: readonly string[];
  /** Subset of roots the set marks read-only; they mount RO even in implementation. */
  readonly readOnlyRoots?: readonly string[];
}

/**
 * Inventory stores that can purge stale terminal rows. Declared locally
 * because the frozen RuntimeInventoryStore port does not carry purge; the
 * Sqlite store implements it and this facade narrows to it at the call site.
 */
interface RuntimePurgingStore {
  purgeRuntimes(input: { now: string; removedOlderThanMs: number; lostOlderThanMs: number }): Promise<number>;
}

export const CHAT_TITLE_MAX = 64;
export const CODEX_PROVIDER_ID = "codex";
export const CLAUDE_PROVIDER_ID = "claude";
export const LEGACY_CODEX_PROVIDER_ID = "codex-openai";

/** Docker Sandbox service secret backing each provider's runtime auth. */
const PROVIDER_SBX_SERVICES: Readonly<Record<string, string>> = {
  [CODEX_PROVIDER_ID]: "openai",
  [CLAUDE_PROVIDER_ID]: "anthropic"
};

export interface IsolatedRunHooks {
  /** Fired after the disposable workspace and template exist, before the runtime starts. */
  readonly onStarted?: (isolation: IsolationSummary) => void;
}

export interface IsolatedRunOutcome {
  readonly sessionId: SessionId;
  readonly events: readonly AgentEvent[];
  readonly cleanupStatus: "removed" | "kept" | "failed";
  readonly isolation: IsolationSummary;
}

export interface IsolatedProbeOutcome {
  readonly probe: AppServerProbeResult;
  readonly cleanupDiagnostics: readonly string[];
}

interface PreparedWorkspace {
  readonly workspace: TempWorkspace;
  readonly template: RuntimeTemplate;
  readonly isolation: IsolationSummary;
  /** Clones prepared for a clone-mode session (empty otherwise). */
  readonly clones: readonly SessionCloneRepo[];
}

/** One repo cloned into a clone-mode session's workspace, resolved for sync ops. */
export interface SessionCloneRepo {
  /** Display name (the local repo's basename); the sync UI keys per-repo state on it. */
  readonly name: string;
  /** Host path of the clone under `<workspace>/repos/<name>` (the sync working copy). */
  readonly clonePath: string;
  /** The developer's real repo — read-only clone source + working-tree apply target. */
  readonly localRepoPath: string;
  /** Branch the clone tracks (or a commit id when the local repo was detached). */
  readonly branch: string;
}

const HOST_CATALOG_TTL_MS = 5 * 60_000;

export class IsolatedRunService {
  private runInFlight = false;
  private hostCatalogRefreshedAt = 0;
  private readonly providerAuthStatuses = new Map<string, ProviderAuthStatus>();
  /** Sessions whose first prompt has already carried the host briefing. */
  private readonly briefedSessions = new Set<string>();
  /** Session mode, recorded at start, so the briefing states plan vs. implementation. */
  private readonly sessionModes = new Map<string, SessionMode>();
  /**
   * Clone-mode session → its prepared clones. Process-local: a clone
   * session whose window reloaded loses this entry (documented v1 limitation),
   * and the sync passthroughs then return a "resume the session" error.
   */
  private readonly sessionClones = new Map<string, readonly SessionCloneRepo[]>();
  private readonly providerCatalogs = new Map<string, AgentModelCatalog>([
    [CODEX_PROVIDER_ID, fallbackCodexCatalog()],
    [CLAUDE_PROVIDER_ID, claudeModelCatalog(new Date().toISOString())]
  ]);

  constructor(private readonly options: IsolatedRunServiceOptions) {}

  isRunInFlight(): boolean {
    return this.runInFlight;
  }

  async startPromptRun(promptText: string, hooks?: IsolatedRunHooks): Promise<IsolatedRunOutcome> {
    this.acquireRunSlot();
    try {
      const prepared = await this.prepareWorkspace("extension");
      try {
        hooks?.onStarted?.(prepared.isolation);
        const result = await this.options.workflow.runOnePrompt({
          prompt: promptText,
          workspacePath: prepared.workspace.workspacePath,
          template: prepared.template
        });
        return {
          sessionId: result.sessionId,
          events: result.events,
          cleanupStatus: result.cleanupStatus,
          isolation: prepared.isolation
        };
      } finally {
        await this.cleanupWorkspaceQuietly(prepared.workspace);
      }
    } finally {
      this.runInFlight = false;
    }
  }

  async runAppServerProbe(): Promise<IsolatedProbeOutcome> {
    this.acquireRunSlot();
    try {
      const prepared = await this.prepareWorkspace("app-server");
      let runtime: RuntimeHandle | undefined;
      try {
        runtime = await this.options.lifecycle.startRuntime({
          sessionId: this.options.ids.sessionId(),
          chatId: this.options.ids.chatId(),
          agentId: this.options.ids.agentId(),
          agentRole: "worker",
          template: prepared.template,
          workspacePath: prepared.workspace.workspacePath,
          generationId: this.options.ids.runtimeGenerationId(),
          runtimeId: this.options.ids.runtimeId()
        });
        const probe = await this.options.prober.probe(runtime, "Reply exactly app-server-ok.");
        const cleanupDiagnostics = await this.cleanupProbe(runtime, prepared.workspace);
        return { probe, cleanupDiagnostics };
      } catch (error) {
        await this.cleanupProbe(runtime, prepared.workspace);
        throw error;
      }
    } finally {
      this.runInFlight = false;
    }
  }

  listRuntimes(): Promise<RuntimeInventoryRecord[]> {
    return this.options.inventory.listRuntimes();
  }

  async listActiveRuntimes(): Promise<RuntimeInventoryRecord[]> {
    const runtimes = await this.options.inventory.listRuntimes();
    return runtimes.filter((runtime) => runtime.status !== "removed");
  }

  /** Previous CPU/IO counters per runtime, so a sample can diff into rates. */
  private readonly statsSamples = new Map<string, { readonly cpu100ns: number; readonly ioReadBytes: number; readonly ioWriteBytes: number; readonly atMs: number }>();

  /**
   * Live per-sandbox resource sample (CPU%, memory, I/O rate) measured entirely
   * HOST-SIDE — no container exec. Each sbx sandbox is a nerdbox microVM whose
   * `containerd-shim-nerdbox` process (plus any children) carries the sandbox's
   * real CPU and memory. We map externalName -> shim PID from containerd's
   * on-disk task state, then sum each shim's whole process tree from ONE
   * `Win32_Process` snapshot (a single call covers every sandbox). CPU/IO are
   * rates diffed against the previous sample, so the first poll returns nulls
   * for those. Windows-only (the nerdbox shim model); other platforms return
   * empty and the UI omits the usage line.
   */
  async sampleRuntimeStats(runtimeIds?: readonly string[]): Promise<RuntimeStatsSummary[]> {
    const sbxPath = this.options.sbxPath;
    const runner = this.options.commandRunner;
    if (sbxPath === undefined || runner === undefined || process.platform !== "win32") {
      return [];
    }
    const wanted = runtimeIds === undefined ? undefined : new Set(runtimeIds);
    const running = (await this.listRuntimes()).filter(
      (runtime) => runtime.status === "running" && (wanted === undefined || wanted.has(String(runtime.runtimeId)))
    );
    if (running.length === 0) {
      return [];
    }
    const unavailable = (runtime: RuntimeInventoryRecord): RuntimeStatsSummary => ({
      runtimeId: String(runtime.runtimeId),
      available: false,
      cpuPercent: null,
      memBytes: null,
      ioReadBytesPerSec: null,
      ioWriteBytesPerSec: null,
      loadAvg1: null,
      threads: null
    });
    const [shimPids, snapshot] = await Promise.all([readSandboxShimPids(sbxPath), snapshotProcessTree(runner)]);
    if (snapshot === null) {
      return running.map(unavailable);
    }
    const nowMs = this.options.clock.now().getTime();
    const stats = running.map((runtime): RuntimeStatsSummary => {
      const shimPid = shimPids.get(runtime.externalName);
      if (shimPid === undefined || !snapshot.byId.has(shimPid)) {
        return unavailable(runtime);
      }
      const tree = sumProcessTree(snapshot, shimPid);
      const key = String(runtime.runtimeId);
      const prev = this.statsSamples.get(key);
      let cpuPercent: number | null = null;
      let ioReadBytesPerSec: number | null = null;
      let ioWriteBytesPerSec: number | null = null;
      if (prev !== undefined && nowMs > prev.atMs) {
        const dtSec = (nowMs - prev.atMs) / 1000;
        // A counter that regressed means the shim restarted (new sandbox gen);
        // skip that interval rather than report a negative rate.
        if (tree.cpu100ns >= prev.cpu100ns) cpuPercent = (tree.cpu100ns - prev.cpu100ns) / 1e7 / dtSec * 100;
        if (tree.ioReadBytes >= prev.ioReadBytes) ioReadBytesPerSec = (tree.ioReadBytes - prev.ioReadBytes) / dtSec;
        if (tree.ioWriteBytes >= prev.ioWriteBytes) ioWriteBytesPerSec = (tree.ioWriteBytes - prev.ioWriteBytes) / dtSec;
      }
      this.statsSamples.set(key, { cpu100ns: tree.cpu100ns, ioReadBytes: tree.ioReadBytes, ioWriteBytes: tree.ioWriteBytes, atMs: nowMs });
      return {
        runtimeId: key,
        available: true,
        cpuPercent,
        memBytes: tree.memBytes,
        ioReadBytesPerSec,
        ioWriteBytesPerSec,
        loadAvg1: null,
        threads: tree.threads
      };
    });
    const alive = new Set(running.map((runtime) => String(runtime.runtimeId)));
    for (const key of [...this.statsSamples.keys()]) {
      if (!alive.has(key)) this.statsSamples.delete(key);
    }
    return stats;
  }

  /** Live usage for a session's running sandbox (the chat panel's usage bar). */
  async sampleSessionStats(sessionId: string): Promise<RuntimeStatsSummary | null> {
    const runtime = (await this.listRuntimes()).find(
      (record) => String(record.sessionId) === sessionId && record.status === "running"
    );
    if (runtime === undefined) {
      return null;
    }
    const stats = await this.sampleRuntimeStats([String(runtime.runtimeId)]);
    return stats[0] ?? null;
  }

  /**
   * Panel-facing inventory. The redesign hides `removed` runtimes by default so
   * torn-down generations stop accumulating in the System tab; a post-mortem
   * view can opt back in with includeRemoved.
   */
  async listPanelRuntimes(includeRemoved = false): Promise<RuntimeInventoryRecord[]> {
    if (includeRemoved) {
      return this.options.inventory.listRuntimes();
    }
    return this.listActiveRuntimes();
  }

  /**
   * Activation-time inventory purge: deletes long-dead `removed`/`lost` rows so
   * the ledger stays bounded. Returns the number of rows removed.
   */
  async purgeRuntimes(removedOlderThanMs: number, lostOlderThanMs: number): Promise<number> {
    const inventory = this.options.inventory as Partial<RuntimePurgingStore>;
    if (typeof inventory.purgeRuntimes !== "function") {
      return 0;
    }
    return inventory.purgeRuntimes({
      now: this.options.clock.isoNow(),
      removedOlderThanMs,
      lostOlderThanMs
    });
  }

  stopRuntime(runtimeId: string, mode: CleanupMode): Promise<CleanupResult> {
    return this.options.cleanup.cleanupRuntime(asId<"RuntimeId">(runtimeId), mode);
  }

  sweepTempWorkspaces(): Promise<number> {
    return this.options.workspaceStore.sweepOwnedWorkspaces();
  }

  // -------------------------------------------------------------------------
  // Chat sessions (app-server transport)
  // -------------------------------------------------------------------------

  /**
   * Starts a persistent chat session on a fresh disposable workspace. An
   * explicit title (e.g. a subtask name) wins; otherwise it derives from the
   * prompt. A title other than "New chat" also survives the first-turn
   * auto-rename in ChatSessionService.
   */
  async startChat(prompt: string, model?: ChatModelSelection, workspace?: ChatWorkspaceContext, title?: string): Promise<{ session: ChatSessionRecord; isolation: IsolationSummary; providerCatalogs: readonly AgentModelCatalog[] }> {
    return this.startChatSession(model, title ?? titleFromPrompt(prompt), workspace);
  }

  /** Starts the isolated chat backend before the first prompt is sent. */
  async startChatSession(model?: ChatModelSelection, title = "New chat", workspace?: ChatWorkspaceContext): Promise<{ session: ChatSessionRecord; isolation: IsolationSummary; providerCatalogs: readonly AgentModelCatalog[] }> {
    const normalizedModel = this.normalizeModelSelection(model);
    this.assertSupportedModelSelection(normalizedModel);
    const prepared = await this.prepareWorkspace("chat", workspace, normalizedModel.providerId);
    const session = await this.options.chatService.startSession({
      template: prepared.template,
      workspacePath: prepared.workspace.workspacePath,
      workspaceOwnerToken: prepared.workspace.ownerToken,
      title,
      model: normalizedModel,
      transport: transportForProvider(normalizedModel.providerId),
      ...(workspace?.mode === undefined ? {} : { mode: workspace.mode }),
      ...(workspace?.roots === undefined || workspace.roots.length === 0 ? {} : { workspaceRoots: workspace.roots }),
      ...(workspace?.readOnlyRoots === undefined || workspace.readOnlyRoots.length === 0 ? {} : { readOnlyRoots: workspace.readOnlyRoots }),
      disposeWorkspace: () => this.options.workspaceStore.cleanupWorkspace(prepared.workspace)
    });
    await this.refreshModelsForSession(session.sessionId);
    this.sessionModes.set(session.sessionId, workspace?.mode ?? "implementation");
    this.stashSessionClones(session.sessionId, prepared.clones);
    return { session, isolation: prepared.isolation, providerCatalogs: this.listChatProviderCatalogs() };
  }

  /**
   * Role-session spawn: a child session under a LIVE parent, inheriting the
   * parent's mounts with role-derived modes — read roles (researcher/planner/
   * reviewer/memory-extractor) get every mount read-only and plan mode;
   * worker/tester keep the parent's modes. The subset guard runs here at
   * spawn and again inside expandSessionMounts for every later widening, so
   * a child can never out-reach its parent (threat-model rule). The child
   * gets its own disposable workspace and runtime: ending or cancelling it
   * never touches the parent or sibling roles.
   */
  async spawnRoleChatSession(parentSessionId: string, role: AgentRole, title?: string): Promise<{ session: ChatSessionRecord; isolation: IsolationSummary; providerCatalogs: readonly AgentModelCatalog[] }> {
    const parentId = asId<"SessionId">(parentSessionId);
    const snapshot = this.options.chatService.liveSpawnSnapshot(parentId);
    if (snapshot === null) {
      throw new Error("The parent session is not live in this window; role sessions spawn from a live parent chat.");
    }
    const parentRecord = await this.options.chatService.getSession(parentId);
    if (parentRecord?.mode === "clone") {
      // The clone lives inside the parent's private disposable workspace,
      // which a separate child runtime cannot see — spawning would hand the
      // child an empty world while looking like it worked.
      throw new Error("Role sessions cannot spawn from a clone session: the clone lives inside the parent's private workspace.");
    }
    const readOnlyRole = role === "researcher" || role === "planner" || role === "reviewer" || role === "memory-extractor";
    const childMounts = snapshot.template.mounts.map((mount) => ({
      ...mount,
      mountId: this.options.ids.mountId(),
      mode: readOnlyRole ? ("read-only" as const) : mount.mode
    }));
    for (const mount of childMounts) {
      assertMountAllowed(mount.hostPath, this.options.deniedPaths ?? []);
    }
    assertChildMountsWithinParent(childMounts, snapshot.template.mounts);

    const workspace = await this.options.workspaceStore.createWorkspace("role");
    const template: RuntimeTemplate = { ...snapshot.template, mounts: childMounts };
    const mode: SessionMode = readOnlyRole ? "plan" : "implementation";
    const session = await this.options.chatService.startSession({
      template,
      workspacePath: workspace.workspacePath,
      workspaceOwnerToken: workspace.ownerToken,
      title: title ?? `${role} — ${parentRecord?.title ?? "chat"}`,
      model: snapshot.model,
      transport: snapshot.transport,
      mode,
      parentSessionId: parentId,
      spawnedRole: role,
      disposeWorkspace: () => this.options.workspaceStore.cleanupWorkspace(workspace)
    });
    await this.refreshModelsForSession(session.sessionId);
    this.sessionModes.set(session.sessionId, mode);
    return {
      session,
      isolation: isolationSummaryFromTemplate(template, workspace.workspacePath),
      providerCatalogs: this.listChatProviderCatalogs()
    };
  }

  /** Resolves when the turn reaches a terminal status; events flow via the bus. */
  async sendChatTurn(sessionId: string, prompt: string, model?: ChatModelSelection): Promise<TurnResult> {
    const normalizedModel = model === undefined ? undefined : this.normalizeModelSelection(model);
    this.assertSupportedModelSelection(normalizedModel);
    const briefedPrompt = await this.applySessionBriefing(sessionId, prompt);
    return this.options.chatService.sendTurn(asId<"SessionId">(sessionId), briefedPrompt, normalizedModel === undefined ? undefined : { model: normalizedModel });
  }

  /**
   * Prepends the host briefing to a session's first prompt (and the first
   * prompt after a backend restart, when briefedSessions was cleared and mounts
   * may have changed). The briefing is host-authored preamble; the user's text
   * follows it. Once briefed, the session is marked so later turns pay nothing —
   * in particular the approved-memory query runs only on the first briefed turn,
   * never on every turn.
   */
  private async applySessionBriefing(sessionId: string, prompt: string): Promise<string> {
    if (this.briefedSessions.has(sessionId)) {
      return prompt;
    }
    const memories = this.options.memoryService === undefined
      ? []
      : await this.options.memoryService.listApprovedContents(MEMORY_BRIEFING_LIMIT);
    const mode = this.sessionModes.get(sessionId) ?? "implementation";
    const cloneRepos = mode === "clone"
      ? (this.sessionClones.get(sessionId) ?? []).map((repo) => repo.name)
      : [];
    const briefing = buildSessionBriefing({
      mode,
      mounts: this.options.chatService.getSessionMounts(asId<"SessionId">(sessionId)),
      ...(memories.length === 0 ? {} : { memories }),
      ...(cloneRepos.length === 0 ? {} : { cloneRepos })
    });
    this.briefedSessions.add(sessionId);
    return `${briefing}\n\n${prompt}`;
  }

  async restartChatBackend(sessionId: string, model: ChatModelSelection): Promise<{ session: ChatSessionRecord; providerCatalogs: readonly AgentModelCatalog[] }> {
    const normalizedModel = this.normalizeModelSelection(model);
    this.assertSupportedModelSelection(normalizedModel);
    // A provider switch needs the new provider's transport; core defaults to
    // the live transport, which is only valid for same-provider restarts.
    const session = await this.options.chatService.restartSession(
      asId<"SessionId">(sessionId),
      normalizedModel,
      "provider-or-model-change",
      transportForProvider(normalizedModel.providerId)
    );
    // Mounts may have changed across the restart; the next turn re-briefs.
    this.briefedSessions.delete(sessionId);
    await this.refreshModelsForSession(session.sessionId);
    return { session, providerCatalogs: this.listChatProviderCatalogs() };
  }

  /**
   * "Take over here": reclaims a session another window still owns — most often
   * this same window's own pre-reload instance, whose heartbeat has not yet gone
   * stale — and revives it live in THIS window with its transcript replayed.
   * Claims ownership first so the running-elsewhere guard yields, then resumes on
   * a fresh runtime using the session's persisted project roots plus any approved
   * access mounts.
   */
  async reclaimChatSession(
    sessionId: string,
    model?: ChatModelSelection,
    additionalRoots?: { readonly roots: readonly string[]; readonly readOnlyRoots: readonly string[] }
  ): Promise<{ session: ChatSessionRecord; isolation: IsolationSummary; providerCatalogs: readonly AgentModelCatalog[] }> {
    await this.options.chatService.claimOwnership(asId<"SessionId">(sessionId));
    // force: a reclaimed session is usually still `active` (running in the other
    // window / a dead prior instance), which a plain resume refuses.
    return this.resumeChatSession(sessionId, model, undefined, true, additionalRoots);
  }

  /**
   * Revives an ended/failed session on a fresh runtime under current mount
   * rules, replaying its durable transcript. The model defaults to the stored
   * session's provider/model when the caller omits one; a fresh disposable
   * workspace and template are provisioned exactly as startChatSession does, so
   * resume honors the current denied-path defaults. Rejects a still-live
   * session — resume is revival, not a takeover of a running backend.
   */
  async resumeChatSession(
    sessionId: string,
    model?: ChatModelSelection,
    workspace?: ChatWorkspaceContext,
    force = false,
    additionalRoots?: { readonly roots: readonly string[]; readonly readOnlyRoots: readonly string[] }
  ): Promise<{ session: ChatSessionRecord; isolation: IsolationSummary; providerCatalogs: readonly AgentModelCatalog[] }> {
    if (this.isChatSessionLive(sessionId)) {
      throw new Error("This session is already live; it cannot be resumed.");
    }
    const stored = await this.options.chatService.getSession(asId<"SessionId">(sessionId));
    if (stored === null) {
      throw new Error(`Session ${sessionId} was not found.`);
    }
    // Default the model to what the session last ran under; normalize + assert
    // exactly as the start path does.
    const requestedModel = model ?? {
      providerId: stored.providerId,
      ...(stored.model === undefined ? {} : { model: stored.model })
    };
    const normalizedModel = this.normalizeModelSelection(requestedModel);
    this.assertSupportedModelSelection(normalizedModel);
    // Re-mount the SAME project roots the session started with (persisted on the
    // record) so a revived session can still edit the project — not just its
    // disposable workspace. An explicit workspace arg wins; otherwise rebuild the
    // context from the stored roots + mode. Falls back to no roots only when the
    // session never had any (a plain no-folder chat).
    const baseWorkspace: ChatWorkspaceContext | undefined = workspace ?? (
      stored.workspaceRoots !== undefined && stored.workspaceRoots.length > 0
        ? {
            mode: stored.mode ?? "implementation",
            roots: stored.workspaceRoots,
            ...(stored.readOnlyRoots === undefined ? {} : { readOnlyRoots: stored.readOnlyRoots })
          }
        : undefined
    );
    // Merge back the folders granted via approved access requests, so a resume
    // re-mounts what the agent was already allowed (e.g. a project it asked for)
    // instead of losing it and re-requesting every time.
    const effectiveWorkspace = mergeWorkspaceRoots(baseWorkspace, additionalRoots, stored.mode);
    const prepared = await this.prepareWorkspace("chat", effectiveWorkspace, normalizedModel.providerId);
    const session = await this.options.chatService.resumeSession({
      sessionId: asId<"SessionId">(sessionId),
      template: prepared.template,
      workspacePath: prepared.workspace.workspacePath,
      workspaceOwnerToken: prepared.workspace.ownerToken,
      model: normalizedModel,
      transport: transportForProvider(normalizedModel.providerId),
      ...(effectiveWorkspace?.mode === undefined ? {} : { mode: effectiveWorkspace.mode }),
      ...(force ? { force: true } : {}),
      disposeWorkspace: () => this.options.workspaceStore.cleanupWorkspace(prepared.workspace)
    });
    // Resume re-clones on a fresh workspace, so the mode comes from the stored
    // record when the caller omitted a workspace (mode is immutable per session).
    this.sessionModes.set(session.sessionId, effectiveWorkspace?.mode ?? session.mode ?? "implementation");
    this.stashSessionClones(session.sessionId, prepared.clones);
    // Mounts changed with the fresh runtime; the next turn must re-brief.
    this.briefedSessions.delete(session.sessionId);
    await this.refreshModelsForSession(session.sessionId);
    return { session, isolation: prepared.isolation, providerCatalogs: this.listChatProviderCatalogs() };
  }

  cancelChatTurn(sessionId: string): Promise<void> {
    return this.options.chatService.cancelTurn(asId<"SessionId">(sessionId));
  }

  /** Soft nudge for a quiet turn; resolves false when there's nothing to poke. */
  pokeChatTurn(sessionId: string): Promise<boolean> {
    return this.options.chatService.pokeTurn(asId<"SessionId">(sessionId));
  }

  // -------------------------------------------------------------------------
  // Clone-mode sync
  // -------------------------------------------------------------------------

  /**
   * Per-repo agent-change state for a clone-mode session, mapped to contract
   * shapes. Refuses while a turn is running (the agent may be mid-write) and
   * when the process-local clone state was lost with the window.
   */
  async cloneState(sessionId: string): Promise<CloneRepoState[]> {
    const clones = this.requireSessionClones(sessionId);
    this.assertNoActiveTurnForSync(sessionId);
    const repos: CloneRepoState[] = [];
    for (const clone of clones) {
      const files = await this.options.cloneSync.agentChanges(clone.clonePath);
      repos.push({ name: clone.name, branch: clone.branch, files });
    }
    return repos;
  }

  /**
   * Pull the agent's clone work into the developer's editor. A full pull (no
   * repo/path) pulls every clone; a per-file pull names both the repo and the
   * path (the contract's XOR rule) and never advances the sync base. Refuses
   * while a turn runs.
   */
  async clonePull(sessionId: string, repo?: string, filePath?: string): Promise<CloneSyncResult> {
    const clones = this.requireSessionClones(sessionId);
    this.assertNoActiveTurnForSync(sessionId);
    if (repo === undefined) {
      return this.aggregateInbound(clones);
    }
    const target = this.requireCloneRepo(clones, repo);
    return this.options.cloneSync.inboundPatch(
      target.clonePath,
      target.localRepoPath,
      ...(filePath === undefined ? [] : [{ path: filePath }])
    );
  }

  /** Push the developer's local edits into every clone (VM). Refuses while a turn runs. */
  async clonePush(sessionId: string): Promise<CloneSyncResult> {
    const clones = this.requireSessionClones(sessionId);
    this.assertNoActiveTurnForSync(sessionId);
    return this.aggregateOutbound(clones);
  }

  /** Restore one file in a clone to its sync base. Refuses while a turn runs. */
  async cloneDiscard(sessionId: string, repo: string, filePath: string): Promise<void> {
    const clones = this.requireSessionClones(sessionId);
    this.assertNoActiveTurnForSync(sessionId);
    const target = this.requireCloneRepo(clones, repo);
    await this.options.cloneSync.discardFile(target.clonePath, filePath);
  }

  /** Runs a full inbound pull across every clone and merges their results into one. */
  private async aggregateInbound(clones: readonly SessionCloneRepo[]): Promise<CloneSyncResult> {
    const results: CloneSyncResult[] = [];
    for (const clone of clones) {
      results.push(await this.options.cloneSync.inboundPatch(clone.clonePath, clone.localRepoPath));
    }
    return mergeSyncResults("Pulled", results);
  }

  /** Runs an outbound push across every clone and merges their results into one. */
  private async aggregateOutbound(clones: readonly SessionCloneRepo[]): Promise<CloneSyncResult> {
    const results: CloneSyncResult[] = [];
    for (const clone of clones) {
      results.push(await this.options.cloneSync.outboundSync(clone.clonePath, clone.localRepoPath));
    }
    return mergeSyncResults("Pushed", results);
  }

  /** The session's clones, or a clear "state was lost" error after a reload. */
  private requireSessionClones(sessionId: string): readonly SessionCloneRepo[] {
    const clones = this.sessionClones.get(sessionId);
    if (clones === undefined || clones.length === 0) {
      throw new Error("This clone session's state was lost with the window; resume the session to recreate its clones.");
    }
    return clones;
  }

  private requireCloneRepo(clones: readonly SessionCloneRepo[], repo: string): SessionCloneRepo {
    const target = clones.find((clone) => clone.name === repo);
    if (target === undefined) {
      throw new Error(`Clone repo "${repo}" is not part of this session.`);
    }
    return target;
  }

  /** Sync ops are refused mid-turn: the agent may be writing the clone concurrently. */
  private assertNoActiveTurnForSync(sessionId: string): void {
    if (this.hasActiveChatTurn(sessionId)) {
      throw new Error("A turn is in progress; wait for it to finish before syncing the clone.");
    }
  }

  /** True when a session is a live clone session with prepared clones in this process. */
  isCloneSession(sessionId: string): boolean {
    return this.sessionClones.has(sessionId);
  }

  endChatSession(sessionId: string, reason: string): Promise<ChatSessionRecord> {
    this.forgetSessionState(sessionId);
    return this.options.chatService.endSession(asId<"SessionId">(sessionId), reason);
  }

  renameChatSession(sessionId: string, title: string): Promise<ChatSessionRecord> {
    return this.options.chatService.renameSession(asId<"SessionId">(sessionId), title);
  }

  /** An empty description clears the stored note. */
  setChatSessionDescription(sessionId: string, description: string): Promise<ChatSessionRecord> {
    return this.options.chatService.setSessionDescription(asId<"SessionId">(sessionId), description);
  }

  deleteChatSession(sessionId: string): Promise<void> {
    this.forgetSessionState(sessionId);
    return this.options.chatService.deleteSession(asId<"SessionId">(sessionId));
  }

  /** Drops per-session host state (briefing + mode + clones) once a session is gone. */
  private forgetSessionState(sessionId: string): void {
    this.briefedSessions.delete(sessionId);
    this.sessionModes.delete(sessionId);
    this.sessionClones.delete(sessionId);
  }

  listChatSessions(limit?: number): Promise<ChatSessionRecord[]> {
    return this.options.chatService.listSessions(limit);
  }

  listChatProviderCatalogs(): readonly AgentModelCatalog[] {
    return [...this.providerCatalogs.values()].map((catalog) => ({
      ...catalog,
      authStatus: this.providerAuthStatuses.get(catalog.providerId) ?? "unknown",
      loginHint: this.loginHint(catalog.providerId)
    }));
  }

  /** Display command plus spawnable pieces for signing a provider in. */
  loginCommand(providerId: string): { readonly command: string; readonly args: readonly string[]; readonly display: string } {
    if (this.options.sbxPath === undefined) {
      throw new Error(`No login flow is available for provider ${providerId}.`);
    }
    const normalized = this.normalizeModelSelection({ providerId }).providerId;
    // Anthropic can't be configured via `sbx secret set` (Docker Sandbox rejects
    // `sbx secret set -g anthropic --oauth`). Claude must be signed in from INSIDE
    // a Claude sandbox: `sbx run claude`, then `/login`; Docker Sandbox then
    // persists the credential for future Claude sandboxes. OpenAI/Codex uses the
    // standard sbx secret OAuth flow.
    if (normalized === CLAUDE_PROVIDER_ID) {
      const args = ["run", "claude"];
      return { command: this.options.sbxPath, args, display: "sbx run claude (then /login inside Claude)" };
    }
    const service = PROVIDER_SBX_SERVICES[normalized];
    if (service === undefined) {
      throw new Error(`No login flow is available for provider ${providerId}.`);
    }
    const args = ["secret", "set", "-g", service, "--oauth"];
    return { command: this.options.sbxPath, args, display: `sbx ${args.join(" ")}` };
  }

  /**
   * Inert auth-status probe: reads the Docker Sandbox secret ledger (the same
   * store the sandbox proxy uses to authenticate agents) without touching any
   * secret values.
   */
  async refreshProviderAuthStatuses(): Promise<void> {
    if (this.options.sbxPath === undefined || this.options.commandRunner === undefined) {
      return;
    }
    try {
      const result = await this.options.commandRunner.run(this.options.sbxPath, ["secret", "ls"], {
        cwd: process.cwd(),
        timeoutMs: 15_000
      });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || result.error || "sbx secret ls failed");
      }
      const configuredServices = parseSbxSecretServices(result.stdout);
      for (const [providerId, service] of Object.entries(PROVIDER_SBX_SERVICES)) {
        this.providerAuthStatuses.set(providerId, configuredServices.has(service) ? "authenticated" : "needs-login");
      }
    } catch (error) {
      this.options.logger.warn("provider auth status probe failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      for (const providerId of Object.keys(PROVIDER_SBX_SERVICES)) {
        this.providerAuthStatuses.set(providerId, "unknown");
      }
    }
  }

  private loginHint(providerId: string): string {
    // Claude signs in from inside a sandbox; Codex/OpenAI via the secret OAuth flow.
    if (providerId === CLAUDE_PROVIDER_ID) return "sbx run claude (then /login)";
    const service = PROVIDER_SBX_SERVICES[providerId];
    return service === undefined ? "" : `sbx secret set -g ${service} --oauth`;
  }

  /**
   * Refreshes provider catalogs and auth statuses with inert host capability
   * discovery (allowed by the threat model) — no prompt or model output ever
   * flows through these calls. The primary source is the host Codex
   * app-server model/list; the OPENAI_API_KEY ping remains a fallback. A
   * richer catalog fetched from a live sandbox is never overwritten.
   */
  async refreshHostProviderCatalogs(): Promise<readonly AgentModelCatalog[]> {
    const now = Date.now();
    if (now - this.hostCatalogRefreshedAt >= HOST_CATALOG_TTL_MS) {
      this.hostCatalogRefreshedAt = now;
      await this.refreshProviderAuthStatuses();
      const existing = this.providerCatalogs.get(CODEX_PROVIDER_ID);
      if (existing === undefined || existing.source === "fallback") {
        const hostCatalog = await this.fetchCodexCatalogFromHost();
        if (hostCatalog !== null) {
          this.providerCatalogs.set(CODEX_PROVIDER_ID, hostCatalog);
        }
      }
    }
    return this.listChatProviderCatalogs();
  }

  private async fetchCodexCatalogFromHost(): Promise<AgentModelCatalog | null> {
    if (this.options.hostCodexPath !== undefined) {
      try {
        const catalog = await fetchCodexHostModelCatalog({
          codexPath: this.options.hostCodexPath,
          cwd: process.cwd(),
          isoNow: () => this.options.clock.isoNow()
        });
        if (catalog.models.length > 0) {
          return { ...catalog, providerId: CODEX_PROVIDER_ID, displayName: "Codex / OpenAI" };
        }
      } catch (error) {
        this.options.logger.warn("host codex model discovery failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return fetchOpenAiModelCatalogFromHost(this.options.logger);
  }

  isChatSessionLive(sessionId: string): boolean {
    return this.options.chatService.isSessionLive(asId<"SessionId">(sessionId));
  }

  /** This window's host-instance id, stamped onto sessions it owns. */
  get hostInstanceId(): string {
    return this.options.hostInstanceId;
  }

  /**
   * True when `heartbeatAt` is within the staleness window relative to now — i.e.
   * the owning host proved liveness recently enough that the session is still
   * considered running. Absent/blank heartbeats and unparseable timestamps are
   * treated as stale (false). Mirrors the core reconcile freshness rule so the
   * panel's "running elsewhere" decoration agrees with reconciliation.
   */
  isHeartbeatFresh(heartbeatAt: string | undefined): boolean {
    if (heartbeatAt === undefined || heartbeatAt === "") {
      return false;
    }
    const beat = Date.parse(heartbeatAt);
    if (Number.isNaN(beat)) {
      return false;
    }
    return Date.parse(this.options.clock.isoNow()) - beat < DEFAULT_HEARTBEAT_STALE_MS;
  }

  /**
   * The session's composer mode, recorded at start. Plan-doc collection keys off
   * this to run only after plan-mode turns. Unknown sessions default to
   * implementation (they never wrote to `plan/`).
   */
  getSessionMode(sessionId: string): SessionMode {
    return this.sessionModes.get(sessionId) ?? "implementation";
  }

  /**
   * Seeds the fast-path session-mode map from a durable record's mode when the
   * in-memory entry is missing (e.g. after a window reload). The map stays the
   * fast path; this only backfills recognition so a reloaded clone session is
   * still known to be clone mode. Never overwrites an existing entry.
   */
  noteSessionModeFromRecord(sessionId: string, mode: SessionMode | undefined): void {
    if (mode !== undefined && !this.sessionModes.has(sessionId)) {
      this.sessionModes.set(sessionId, mode);
    }
  }

  hasActiveChatTurn(sessionId: string): boolean {
    return this.options.chatService.hasActiveTurn(asId<"SessionId">(sessionId));
  }

  async getChatTimeline(sessionId: string, fromSequence?: number): Promise<SequencedTranscriptLine[]> {
    const events = await this.options.chatService.getTimeline(asId<"SessionId">(sessionId), fromSequence);
    return events.map((stored) => ({
      ...summarizeStoredEvent(stored),
      sequence: stored.sequence ?? 0,
      ...(isFinalTextEvent(stored.payload) ? { final: stored.payload.final } : {})
    }));
  }

  private async refreshModelsForSession(sessionId: SessionId): Promise<void> {
    try {
      const catalog = await this.options.chatService.listModels(sessionId);
      this.providerCatalogs.set(catalog.providerId, {
        ...catalog,
        displayName: catalog.displayName || catalog.providerId
      });
    } catch (error) {
      this.options.logger.warn("chat provider model discovery failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private assertSupportedModelSelection(model: ChatModelSelection | undefined): void {
    if (model === undefined) return;
    if (model.providerId !== CODEX_PROVIDER_ID && model.providerId !== CLAUDE_PROVIDER_ID) {
      throw new Error(`Provider ${model.providerId} is not wired yet. Supported providers: Codex/OpenAI and Claude/Anthropic.`);
    }
  }

  private normalizeModelSelection(model: ChatModelSelection | undefined): ChatModelSelection {
    if (model === undefined) {
      return { providerId: CODEX_PROVIDER_ID };
    }
    const providerId = model.providerId === LEGACY_CODEX_PROVIDER_ID ? CODEX_PROVIDER_ID : model.providerId;
    return {
      providerId,
      ...(model.model === undefined ? {} : { model: model.model })
    };
  }

  private acquireRunSlot(): void {
    if (this.runInFlight) {
      throw new Error("An isolated run is already in progress; wait for it to finish.");
    }
    this.runInFlight = true;
  }

  private async prepareWorkspace(prefix: string, workspaceContext?: ChatWorkspaceContext, providerId?: string): Promise<PreparedWorkspace> {
    const workspace = await this.options.workspaceStore.createWorkspace(prefix);
    await writeFile(path.join(workspace.workspacePath, "README.md"), "# Isolated run disposable workspace\n", "utf8");
    // Clone mode: each root is git-cloned INTO the workspace, and buildMountPolicy
    // yields NO project-root mounts for clone mode — so the only rw mount is the
    // workspace itself, which now contains the clones. That is the design.
    const clones = workspaceContext?.mode === "clone"
      ? await this.prepareClones(workspace.workspacePath, workspaceContext.roots)
      : [];
    const template = buildIsolatedRunTemplate({
      workspacePath: workspace.workspacePath,
      ids: this.options.ids,
      approvedAt: this.options.clock.isoNow(),
      provider: providerId === CLAUDE_PROVIDER_ID ? "claude" : "codex",
      ...(workspaceContext === undefined ? {} : {
        projectRoots: workspaceContext.roots,
        sessionMode: workspaceContext.mode,
        ...(workspaceContext.readOnlyRoots === undefined ? {} : { readOnlyRoots: workspaceContext.readOnlyRoots })
      }),
      ...(this.options.deniedPaths === undefined ? {} : { deniedPaths: this.options.deniedPaths })
    });
    return {
      workspace,
      template,
      isolation: isolationSummaryFromTemplate(template, workspace.workspacePath),
      clones
    };
  }

  /**
   * Clone-mode workspace preparation. Verifies host git is available, and
   * for each root requires it is a git repo (a non-git root aborts with a clear
   * error rather than silently mounting nothing), then clones the developer's
   * current branch + dirty state into `<workspace>/repos/<basename>` as the sync
   * base. Returns the resolved clone list the caller stashes per session id.
   */
  private async prepareClones(workspacePath: string, roots: readonly string[]): Promise<SessionCloneRepo[]> {
    const git = await this.options.cloneSync.detectGit();
    if (!git.available) {
      throw new Error("Clone mode requires git on the host PATH, but `git --version` failed. Install git (or fix PATH) and reload the window.");
    }
    const cloneParentDir = path.join(workspacePath, "repos");
    const clones: SessionCloneRepo[] = [];
    for (const root of roots) {
      if (!(await isGitRepo(root))) {
        throw new Error(`Clone mode requires git repositories; "${root}" is not one.`);
      }
      const name = path.basename(root);
      const result = await this.options.cloneSync.initClone({ localRepoPath: root, cloneParentDir, name });
      clones.push({ name, clonePath: result.clonePath, localRepoPath: root, branch: result.branch });
    }
    return clones;
  }

  /** Records a clone-mode session's prepared clones; a no-op for empty lists. */
  private stashSessionClones(sessionId: string, clones: readonly SessionCloneRepo[]): void {
    if (clones.length > 0) {
      this.sessionClones.set(sessionId, clones);
    }
  }

  private async cleanupProbe(runtime: RuntimeHandle | undefined, workspace: TempWorkspace): Promise<string[]> {
    const diagnostics: string[] = [];
    if (runtime) {
      const cleanup = await this.options.cleanup.cleanupRuntime(runtime.runtimeId, "graceful");
      diagnostics.push(`cleanup ${cleanup.status} (${cleanup.diagnostics.join(", ")})`);
    }
    await this.cleanupWorkspaceQuietly(workspace);
    return diagnostics;
  }

  private async cleanupWorkspaceQuietly(workspace: TempWorkspace): Promise<void> {
    try {
      await this.options.workspaceStore.cleanupWorkspace(workspace);
    } catch (error) {
      this.options.logger.warn("temp workspace cleanup failed", {
        root: workspace.root,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

export function isolationSummaryFromTemplate(template: RuntimeTemplate, workspaceDisplayPath: string): IsolationSummary {
  const allowlist = typeof template.advancedOptions["networkResources"] === "string"
    ? template.advancedOptions["networkResources"]
    : typeof template.advancedOptions["codexNetworkResources"] === "string"
      ? template.advancedOptions["codexNetworkResources"]
      : undefined;
  const network = template.network === "allowed" && allowlist !== undefined ? "provider-scoped" : "none";
  return {
    runtimeKind: "docker-sandbox",
    network,
    ...(network === "provider-scoped" && allowlist !== undefined ? { networkAllowlist: allowlist } : {}),
    mounts: template.mounts.map((mount) => ({
      runtimePath: mount.runtimePath,
      mode: mount.mode,
      hostDisplayPath: mount.hostPath
    })),
    workspaceDisplayPath
  };
}

export function toRuntimeSummary(record: RuntimeInventoryRecord): RuntimeSummary {
  return {
    runtimeId: record.runtimeId,
    externalName: record.externalName,
    status: record.status,
    startedAt: record.startedAt,
    ...(record.agentRole === undefined ? {} : { agentRole: record.agentRole })
  };
}

/** One process's host counters from a Win32_Process snapshot. */
interface ProcInfo {
  readonly ppid: number;
  readonly memBytes: number;
  readonly cpu100ns: number;
  readonly ioReadBytes: number;
  readonly ioWriteBytes: number;
  readonly threads: number;
}

interface ProcessSnapshot {
  readonly byId: Map<number, ProcInfo>;
  readonly childrenByPpid: Map<number, number[]>;
}

/**
 * Maps each running sandbox's externalName to its nerdbox shim host PID by
 * reading containerd's on-disk task state (`config.json`.hostname + `shim.pid`),
 * whose location is derived from the sbx binary path. Best-effort: returns what
 * it can parse, empty on any failure — callers then report the sandbox as
 * unavailable rather than throwing.
 */
async function readSandboxShimPids(sbxPath: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    // <DockerSandboxes>\bin\sbx.exe -> <DockerSandboxes>\sandboxes\state\sandboxd\...
    const root = path.dirname(path.dirname(sbxPath));
    const taskDir = path.join(root, "sandboxes", "state", "sandboxd", "containerd", "state", "io.containerd.runtime.v2.task", "docker");
    const entries = await readdir(taskDir, { withFileTypes: true });
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      try {
        const dir = path.join(taskDir, entry.name);
        const [configRaw, pidRaw] = await Promise.all([
          readFile(path.join(dir, "config.json"), "utf8"),
          readFile(path.join(dir, "shim.pid"), "utf8")
        ]);
        const hostname = (JSON.parse(configRaw) as { hostname?: unknown }).hostname;
        const pid = Number.parseInt(pidRaw.trim(), 10);
        if (typeof hostname === "string" && hostname.length > 0 && Number.isFinite(pid)) {
          map.set(hostname, pid);
        }
      } catch {
        // Skip a task dir we can't read/parse.
      }
    }));
  } catch {
    // No task dir (no running sandboxes, or layout changed): empty map.
  }
  return map;
}

/** Snapshots all host processes (PID/PPID/CPU/mem/IO/threads) via one PowerShell call. */
async function snapshotProcessTree(runner: CommandRunner): Promise<ProcessSnapshot | null> {
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime,ReadTransferCount,WriteTransferCount,ThreadCount | ConvertTo-Json -Compress";
  let result: CommandResult;
  try {
    result = await runner.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      cwd: process.cwd(),
      timeoutMs: 10_000
    });
  } catch {
    return null;
  }
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout); } catch { return null; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const byId = new Map<number, ProcInfo>();
  const childrenByPpid = new Map<number, number[]>();
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const pid = statNumber(record["ProcessId"]);
    if (pid === null) continue;
    const ppid = statNumber(record["ParentProcessId"]) ?? -1;
    byId.set(pid, {
      ppid,
      memBytes: statNumber(record["WorkingSetSize"]) ?? 0,
      cpu100ns: (statNumber(record["KernelModeTime"]) ?? 0) + (statNumber(record["UserModeTime"]) ?? 0),
      ioReadBytes: statNumber(record["ReadTransferCount"]) ?? 0,
      ioWriteBytes: statNumber(record["WriteTransferCount"]) ?? 0,
      threads: statNumber(record["ThreadCount"]) ?? 0
    });
    if (ppid >= 0) {
      const list = childrenByPpid.get(ppid);
      if (list) list.push(pid); else childrenByPpid.set(ppid, [pid]);
    }
  }
  return { byId, childrenByPpid };
}

/** Sums CPU/mem/IO/threads over a process and all its descendants (cycle-guarded). */
function sumProcessTree(snapshot: ProcessSnapshot, rootPid: number): { cpu100ns: number; memBytes: number; ioReadBytes: number; ioWriteBytes: number; threads: number } {
  let cpu100ns = 0, memBytes = 0, ioReadBytes = 0, ioWriteBytes = 0, threads = 0;
  const seen = new Set<number>();
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const info = snapshot.byId.get(pid);
    if (info === undefined) continue;
    cpu100ns += info.cpu100ns;
    memBytes += info.memBytes;
    ioReadBytes += info.ioReadBytes;
    ioWriteBytes += info.ioWriteBytes;
    threads += info.threads;
    for (const child of snapshot.childrenByPpid.get(pid) ?? []) stack.push(child);
  }
  return { cpu100ns, memBytes, ioReadBytes, ioWriteBytes, threads };
}

/** WMI numbers arrive as number or string (large uint64); coerce, else null. */
function statNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
  return null;
}

function titleFromPrompt(prompt: string): string {
  return prompt.length > CHAT_TITLE_MAX ? `${prompt.slice(0, CHAT_TITLE_MAX)}…` : prompt;
}

/** Merges approved-access roots into a base workspace context, deduping by normalized path key. */
function mergeWorkspaceRoots(
  base: ChatWorkspaceContext | undefined,
  additional: { readonly roots: readonly string[]; readonly readOnlyRoots: readonly string[] } | undefined,
  storedMode: SessionMode | undefined
): ChatWorkspaceContext | undefined {
  if (additional === undefined || additional.roots.length === 0) {
    return base;
  }
  const dedupe = (values: readonly string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
      const key = normalizePathKey(value);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
    }
    return out;
  };
  const roots = dedupe([...(base?.roots ?? []), ...additional.roots]);
  const readOnlyRoots = dedupe([...(base?.readOnlyRoots ?? []), ...additional.readOnlyRoots]);
  return {
    mode: base?.mode ?? storedMode ?? "implementation",
    roots,
    ...(readOnlyRoots.length === 0 ? {} : { readOnlyRoots })
  };
}

/** True when `<root>/.git` exists (clone mode's git-repo requirement). */
async function isGitRepo(root: string): Promise<boolean> {
  try {
    await stat(path.join(root, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Folds per-clone sync results into one CloneSyncResult for a multi-repo full
 * pull/push: sums applied + untracked counts, concatenates conflicted files, and
 * joins each clone's message so the diagnostics feed sees them all.
 */
function mergeSyncResults(verb: string, results: readonly CloneSyncResult[]): CloneSyncResult {
  if (results.length === 1 && results[0] !== undefined) {
    return results[0];
  }
  let appliedFiles = 0;
  let untrackedCopied = 0;
  const conflictedFiles: string[] = [];
  const messages: string[] = [];
  for (const result of results) {
    appliedFiles += result.appliedFiles;
    untrackedCopied += result.untrackedCopied ?? 0;
    conflictedFiles.push(...result.conflictedFiles);
    messages.push(result.message);
  }
  return {
    appliedFiles,
    conflictedFiles,
    ...(untrackedCopied > 0 ? { untrackedCopied } : {}),
    message: messages.length > 0 ? messages.join("; ") : `${verb} 0 files`
  };
}

function fallbackCodexCatalog(reason?: string): AgentModelCatalog {
  return {
    providerId: CODEX_PROVIDER_ID,
    displayName: "Codex / OpenAI",
    models: [
      { id: "gpt-5.5", displayName: "GPT-5.5", isDefault: true, hidden: false },
      { id: "gpt-5.4", displayName: "GPT-5.4", isDefault: false, hidden: false },
      { id: "gpt-5.4-mini", displayName: "GPT-5.4-Mini", isDefault: false, hidden: false },
      { id: "gpt-5.3-codex-spark", displayName: "GPT-5.3-Codex-Spark", isDefault: false, hidden: false }
    ],
    refreshedAt: new Date().toISOString(),
    source: "fallback",
    diagnostics: [reason ?? "Static Codex catalog; the host Codex app-server refresh replaces it when available."]
  };
}

function transportForProvider(providerId: string): AgentTransport {
  return providerId === CLAUDE_PROVIDER_ID ? "claude-exec-json" : "codex-app-server";
}

/**
 * Extracts configured service names from `sbx secret ls` output. Rows look
 * like `(global)   service   openai   (oauth configured)`; token matching
 * keeps format drift from silently breaking auth detection.
 */
export function parseSbxSecretServices(stdout: string): ReadonlySet<string> {
  const services = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /\bservice\s+(\S+)/.exec(line);
    if (match?.[1] !== undefined) {
      services.add(match[1].toLowerCase());
    }
  }
  return services;
}

const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const HOST_MODEL_FAMILY = /^(gpt-5|gpt-4\.1|gpt-4o|o3|o4|codex)/;
const HOST_PING_TIMEOUT_MS = 8_000;

/**
 * Inert host-side model listing. Reads OPENAI_API_KEY from the extension-host
 * environment; returns null (caller keeps its current catalog) when the key is
 * absent or the ping fails. Never sends prompts or workspace data.
 */
async function fetchOpenAiModelCatalogFromHost(logger: Logger): Promise<AgentModelCatalog | null> {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, HOST_PING_TIMEOUT_MS);
  try {
    const response = await fetch(OPENAI_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal
    });
    if (!response.ok) {
      logger.warn("host model ping rejected", { status: response.status });
      return null;
    }
    const body = await response.json() as { readonly data?: readonly { readonly id?: string }[] };
    const ids = (body.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === "string" && HOST_MODEL_FAMILY.test(id))
      .sort();
    if (ids.length === 0) return null;
    return {
      providerId: CODEX_PROVIDER_ID,
      displayName: "Codex / OpenAI",
      models: ids.map((id) => ({
        id,
        displayName: id,
        isDefault: id === "gpt-5",
        hidden: false
      })),
      refreshedAt: new Date().toISOString(),
      source: "provider",
      diagnostics: ["Models listed via inert host API ping; prompts never leave the micro-VM path."]
    };
  } catch (error) {
    logger.warn("host model ping failed", { error: error instanceof Error ? error.message : String(error) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function isFinalTextEvent(value: unknown): value is { readonly type: "agent.text"; readonly final: boolean } {
  return typeof value === "object" &&
    value !== null &&
    (value as { readonly type?: unknown }).type === "agent.text" &&
    typeof (value as { readonly final?: unknown }).final === "boolean";
}
