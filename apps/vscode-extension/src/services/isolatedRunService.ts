/**
 * Isolated-run application service facade.
 *
 * Owns the workflow orchestration that used to live inside command callbacks:
 * disposable workspace provisioning, runtime template construction, the
 * app-server probe sequence, and cleanup. Commands and the control panel are
 * both thin delegations into this service, so there is exactly one truth for
 * "run an isolated prompt". No `vscode` imports belong here.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchCodexHostModelCatalog } from "@drydock/agent-adapters";
import { TempWorkspaceStore, type TempWorkspace } from "@drydock/artifacts";
import {
  asId,
  isRegisteredProvider,
  providerDescriptor,
  providerEgressResources,
  providerTransport,
  PROVIDER_REGISTRY,
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
  type ProviderDescriptor,
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
  BootStageReporter,
  buildChatLog,
  buildSessionBriefing,
  stripHostBriefing,
  buildSummaryPrompt,
  buildIsolatedRunTemplate,
  ChatSessionService,
  CloneSyncService,
  DEFAULT_HEARTBEAT_STALE_MS,
  RuntimeCleanupService,
  RuntimeLifecycleService,
  IsolatedRunWorkflow,
  normalizeHostPath,
  normalizePathKey,
  type ClonePathOmission,
  type CloneRepoPreflight,
  type Clock,
  type IdGenerator,
  type Logger
} from "@drydock/core";
import type { McpEffectiveServer, McpEffectiveQuery, MemoryService } from "@drydock/work-management";
import { detectWorkspaceTags, type TagRule } from "@drydock/core";
import { fetchProviderModelsFromHost } from "./modelDiscovery.js";
import { blocksGlobalMemoryBriefing, type EffectiveSecurityPolicy } from "./securityPolicy.js";

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
  /**
   * Bounded exec against a session's own runtime (attachment uploads). The
   * docker runtime adapter satisfies this structurally; optional so tests
   * that never upload need no stub.
   */
  readonly runtimeExecutor?: {
    exec(handle: RuntimeHandle, args: readonly string[], timeoutMs: number, input?: string): Promise<{ readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }>;
  };
  /** Studio-registered prototype themes pushed alongside the built-ins (ADR 0017). */
  readonly userPrototypeThemes?: readonly PrototypeTheme[];
  /** Validated MCP config JSON (drydock.mcp.configPath) written to /workspace/.mcp.json before the first turn. */
  readonly mcpConfigJson?: string;
  /** Studio-level standing instructions (drydock.teamInstructionsPath) appended to the briefing. */
  readonly teamInstructions?: string;
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
  /** Glob→tag rule table (defaults + user rules) driving memory tag selection. */
  readonly tagRules?: readonly TagRule[];
  /** MCP registry: effective-set cascade + .mcp.json rendering (design doc). */
  readonly mcpRegistry?: {
    effectiveForSession(query: McpEffectiveQuery): Promise<McpEffectiveServer[]>;
    renderConfigJson(servers: readonly McpEffectiveServer[]): string | null;
  };
  /** Tasks linked to a session - task-scope memory + MCP task overrides. */
  readonly sessionTaskIds?: (sessionId: string) => Promise<readonly string[]>;
  /** Workspace sets with mount roots - MCP workspace-set override resolution. */
  readonly workspaceSetRefs?: () => Promise<readonly { workspaceSetId: string; roots: readonly string[] }[]>;
  readonly deniedPaths?: readonly string[];
  readonly securityPolicy?: EffectiveSecurityPolicy;
  /** Host sbx binary, used for inert auth-status checks and login commands. */
  readonly sbxPath?: string;
  readonly commandRunner?: CommandRunner;
  /** Private environment inherited by Drydock-owned child processes and host probes. */
  readonly environment?: NodeJS.ProcessEnv;
  /** Host codex binary, used for inert app-server model discovery. */
  readonly hostCodexPath?: string;
  /** Platform secret store backing `vscode-secret:<provider>` auth refs. */
  readonly providerSecrets?: ProviderSecretRefStore;
  /**
   * Persisted copy of the last successful live model discoveries, so the
   * picker is usable before any provider connects. Entries load as
   * source:"cache" and are replaced by live results; nothing model-shaped is
   * compiled into the extension.
   */
  readonly catalogCache?: ProviderCatalogCache;
  /**
   * Rider model discovery, injectable so tests never touch the network.
   * Defaults to the registry-described host fetch (modelDiscovery.ts).
   */
  readonly discoverProviderModels?: (descriptor: ProviderDescriptor) => Promise<AgentModelCatalog>;
}

/** Durable store for discovered provider catalogs (host-side, e.g. globalState). */
export interface ProviderCatalogCache {
  load(): readonly AgentModelCatalog[] | undefined;
  save(catalogs: readonly AgentModelCatalog[]): void;
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
  /** Clone mode only: whether local working changes are copied into each clone. */
  readonly dirtyHandling?: "carry" | "fresh";
  /**
   * Clone mode only (ADR 0014): upstream changeset patches 3-way applied into
   * each matching fresh clone before its sync base freezes. Start-time only -
   * never persisted, so a resume re-clones without them (the same documented
   * limitation as the rest of the process-local clone state).
   */
  readonly seedPatches?: readonly WorkspaceSeedPatch[];
}

/** One upstream changeset patch destined for a named clone repo (ADR 0014). */
export interface WorkspaceSeedPatch {
  /** Matches SessionCloneRepo.name (the clone folder basename, deduped). */
  readonly repoName: string;
  /** Names the source in conflict errors (e.g. "subtask-x/repo"). */
  readonly label: string;
  readonly patch: string;
}

/**
 * Inventory stores that can purge stale terminal rows. Declared locally
 * because the frozen RuntimeInventoryStore port does not carry purge; the
 * Sqlite store implements it and this facade narrows to it at the call site.
 */
interface RuntimePurgingStore {
  purgeRuntimes(input: { now: string; removedOlderThanMs: number; lostOlderThanMs: number }): Promise<number>;
}

import type { PreviewSummary } from "@drydock/contracts";
import { BUILT_IN_PROTOTYPE_THEMES, isValidThemeName, type PrototypeTheme } from "./prototypeThemes.js";

export const CHAT_TITLE_MAX = 64;
export const CODEX_PROVIDER_ID = "codex";
export const CLAUDE_PROVIDER_ID = "claude";
export const LEGACY_CODEX_PROVIDER_ID = "codex-openai";

/**
 * Write/read access to provider API keys held in the platform secret store
 * (VS Code SecretStorage; ref form `vscode-secret:<provider>`). Used only for
 * providers without a Docker Sandbox service secret. Values are read at
 * runtime-injection time and never logged, persisted elsewhere, or displayed.
 */
export interface ProviderSecretRefStore {
  has(providerId: string): Promise<boolean>;
  get(providerId: string): Promise<string | undefined>;
  set(providerId: string, value: string): Promise<void>;
  delete(providerId: string): Promise<void>;
}

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
  /** Requested context after host policy tightened roots/mode. */
  readonly workspaceContext?: ChatWorkspaceContext;
}

/** One repo cloned into a clone-mode session's workspace, resolved for sync ops. */
export interface SessionCloneRepo {
  /** Display name (the local repo's basename); the sync UI keys per-repo state on it. */
  readonly name: string;
  /** Host path of the clone under `<workspace>/repos/<name>` (the sync working copy). */
  readonly clonePath: string;
  /** The developer's real repo - read-only clone source + working-tree apply target. */
  readonly localRepoPath: string;
  /** Branch the clone tracks (or a commit id when the local repo was detached). */
  readonly branch: string;
  readonly omission?: ClonePathOmission;
}

const HOST_CATALOG_TTL_MS = 5 * 60_000;

/**
 * Honest catalog merge. A live "provider" result is the truth and replaces
 * the entry wholesale (removed upstream models really disappear); "cache"
 * only ever fills absence; "unavailable" never erases a usable list - it
 * keeps the existing models and attaches its failure reason so the picker can
 * show "cached from <date>; last refresh failed: <why>".
 */
export function mergeAgentModelCatalog(existing: AgentModelCatalog | undefined, incoming: AgentModelCatalog): AgentModelCatalog {
  if (existing === undefined || existing.providerId !== incoming.providerId) {
    return incoming;
  }
  if (incoming.source === "provider") {
    return incoming;
  }
  if (incoming.source === "cache") {
    return existing;
  }
  // incoming.source === "unavailable"
  if (existing.models.length === 0) {
    return { ...incoming, diagnostics: dedupe([...existing.diagnostics, ...incoming.diagnostics]) };
  }
  return { ...existing, diagnostics: dedupe([...existing.diagnostics, ...incoming.diagnostics]) };
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
/** Detected workspace tags are re-scanned at most this often per root. */
const TAG_CACHE_TTL_MS = 5 * 60_000;

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
  /** Live preview proxies per session (ADR 0017); process-local like clones. */
  private readonly sessionPreviews = new Map<string, { summary: PreviewSummary; server: import("node:http").Server }[]>();
  /** Sessions whose sandbox already received the prototype theme pack. */
  private readonly themedSessions = new Set<string>();
  /** Sessions whose workspace already received the MCP config file. */
  private readonly mcpConfiguredSessions = new Set<string>();
  /** Per-root detected workspace tags (bounded scan, TTL-cached). */
  private readonly tagCache = new Map<string, { tags: string[]; at: number }>();
  /**
   * providerId → last known catalog. Seeded from the durable cache (entries
   * downgraded to source:"cache") and replaced by live discovery results.
   * Providers with no entry render as "unavailable" placeholders; there are
   * no compiled-in model lists.
   */
  private readonly providerCatalogs = new Map<string, AgentModelCatalog>();

  constructor(private readonly options: IsolatedRunServiceOptions) {
    for (const cached of options.catalogCache?.load() ?? []) {
      if (cached.source === "unavailable" || cached.models.length === 0 || !isRegisteredProvider(cached.providerId)) {
        continue;
      }
      this.providerCatalogs.set(cached.providerId, {
        ...cached,
        source: "cache",
        diagnostics: dedupe([...cached.diagnostics, "Cached from the last successful discovery; press Refresh models to requery."])
      });
    }
  }

  /**
   * Folds a discovery result into the catalog map and persists successful
   * live results. The single entry point for every catalog source (host
   * probes, per-session listModels, rider endpoints).
   */
  private absorbCatalog(incoming: AgentModelCatalog): void {
    const merged = mergeAgentModelCatalog(this.providerCatalogs.get(incoming.providerId), incoming);
    this.providerCatalogs.set(incoming.providerId, merged);
    if (incoming.source === "provider" && incoming.models.length > 0) {
      const live = [...this.providerCatalogs.values()].filter((catalog) => catalog.models.length > 0);
      try {
        this.options.catalogCache?.save(live);
      } catch (error) {
        this.options.logger.warn("provider catalog cache save failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  isRunInFlight(): boolean {
    return this.runInFlight;
  }

  async preflightCloneRepo(localRepoPath: string): Promise<CloneRepoPreflight> {
    this.assertWorkspaceRootAllowed(localRepoPath);
    const git = await this.options.cloneSync.detectGit();
    if (!git.available) {
      throw new Error(this.options.securityPolicy?.managed === true
        ? "Clone mode requires an approved Git installation. Ask your administrator to install Git in the standard machine location, then reload the window."
        : "Clone mode requires git on the host PATH, but `git --version` failed. Install git (or fix PATH) and reload the window.");
    }
    return this.options.cloneSync.preflightRepo(localRepoPath);
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
        this.options.securityPolicy?.assertNetworkedAiAllowed();
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
   * HOST-SIDE - no container exec. Each sbx sandbox is a nerdbox microVM whose
   * `containerd-shim-nerdbox` process (plus any children) carries the sandbox's
   * real CPU and memory. We map externalName -> shim PID from containerd's
   * on-disk task state, then sum each shim's whole process tree from ONE
   * `Win32_Process` snapshot (a single call covers every sandbox). CPU/IO are
   * rates diffed against the previous sample, so the first poll returns nulls
   * for those. Windows-only (the nerdbox shim model); other platforms return
   * empty and the UI omits the usage line.
   *
   * The shim reader is DOCKER-SANDBOX SPECIFIC. Other adapter kinds (ADR 0022's
   * `hyperv` validation runtimes) report `available: false` rather than being
   * measured with a model that does not describe them - M4/M7 add their counters
   * through `hyperVControl`. Reporting a VM's usage as a sandbox's would be a
   * confident wrong number, which is worse than an honest blank.
   */
  async sampleRuntimeStats(runtimeIds?: readonly string[]): Promise<RuntimeStatsSummary[]> {
    const sbxPath = this.options.sbxPath;
    const runner = this.options.commandRunner;
    if (sbxPath === undefined || runner === undefined || process.platform !== "win32") {
      return [];
    }
    const wanted = runtimeIds === undefined ? undefined : new Set(runtimeIds);
    const allRunning = (await this.listRuntimes()).filter(
      (runtime) => runtime.status === "running" && (wanted === undefined || wanted.has(String(runtime.runtimeId)))
    );
    if (allRunning.length === 0) {
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
    const running = allRunning.filter((runtime) => runtime.adapter === "docker-sandbox");
    const unmeasured = allRunning.filter((runtime) => runtime.adapter !== "docker-sandbox").map(unavailable);
    if (running.length === 0) {
      return unmeasured;
    }
    const [shimPids, snapshot] = await Promise.all([readSandboxShimPids(sbxPath), snapshotProcessTree(runner)]);
    if (snapshot === null) {
      return [...running.map(unavailable), ...unmeasured];
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
    return [...stats, ...unmeasured];
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
   * torn-down generations stop accumulating in the Runtimes fold; a post-mortem
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

  async sweepTempWorkspaces(): Promise<number> {
    const runtimes = await this.options.inventory.listRuntimes();
    const protectedPaths = runtimes
      .filter((runtime) => runtime.status !== "removed" && runtime.status !== "lost")
      .map((runtime) => runtime.metadata["workspacePath"])
      .filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
    return this.options.workspaceStore.sweepOwnedWorkspaces(undefined, protectedPaths);
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
  async startChat(
    prompt: string,
    model?: ChatModelSelection,
    workspace?: ChatWorkspaceContext,
    title?: string,
    onProgress?: (message: string) => void
  ): Promise<{ session: ChatSessionRecord; isolation: IsolationSummary; providerCatalogs: readonly AgentModelCatalog[] }> {
    return this.startChatSession(model, title ?? titleFromPrompt(prompt), workspace, onProgress);
  }

  /** Starts the isolated chat backend before the first prompt is sent. */
  async startChatSession(
    model?: ChatModelSelection,
    title = "New chat",
    workspace?: ChatWorkspaceContext,
    onProgress?: (message: string) => void
  ): Promise<{ session: ChatSessionRecord; isolation: IsolationSummary; providerCatalogs: readonly AgentModelCatalog[] }> {
    const normalizedModel = this.normalizeModelSelection(model);
    this.assertSupportedModelSelection(normalizedModel);
    // The boot timeline needs ONE identity across stages that precede the
    // durable row (workspace, mounts, clone seeding), so the id is allocated
    // here and handed to the chat service instead of being minted late.
    const sessionId = this.options.ids.sessionId();
    const boot = this.bootStages(sessionId);
    onProgress?.("Preparing the isolated workspace and mounts…");
    const prepared = await this.prepareWorkspace("chat", workspace, normalizedModel.providerId, boot);
    const effectiveWorkspace = prepared.workspaceContext;
    onProgress?.("Starting the sandbox and agent backend…");
    boot.stage("start");
    const session = await this.options.chatService.startSession({
      template: prepared.template,
      workspacePath: prepared.workspace.workspacePath,
      workspaceOwnerToken: prepared.workspace.ownerToken,
      sessionId,
      title,
      model: normalizedModel,
      transport: transportForProvider(normalizedModel.providerId),
      ...(effectiveWorkspace?.mode === undefined ? {} : { mode: effectiveWorkspace.mode }),
      ...(effectiveWorkspace?.roots === undefined || effectiveWorkspace.roots.length === 0 ? {} : { workspaceRoots: effectiveWorkspace.roots }),
      ...(effectiveWorkspace?.readOnlyRoots === undefined || effectiveWorkspace.readOnlyRoots.length === 0 ? {} : { readOnlyRoots: effectiveWorkspace.readOnlyRoots }),
      ...(effectiveWorkspace?.mode === "clone" && effectiveWorkspace.dirtyHandling !== undefined
        ? { cloneDirtyHandling: effectiveWorkspace.dirtyHandling }
        : {}),
      disposeWorkspace: () => this.options.workspaceStore.cleanupWorkspace(prepared.workspace)
    });
    onProgress?.("Loading available models from the agent backend…");
    await this.refreshModelsForSession(session.sessionId, session.providerId);
    this.sessionModes.set(session.sessionId, effectiveWorkspace?.mode ?? "implementation");
    this.stashSessionClones(session.sessionId, prepared.clones);
    return { session, isolation: prepared.isolation, providerCatalogs: this.listChatProviderCatalogs() };
  }

  /**
   * Role-session spawn: a child session under a LIVE parent, inheriting the
   * parent's mounts with role-derived modes - read roles (researcher/planner/
   * reviewer/memory-extractor) get every mount read-only and plan mode;
   * worker/tester keep the parent's modes. The subset guard runs here at
   * spawn and again inside expandSessionMounts for every later widening, so
   * a child can never out-reach its parent (threat-model rule). The child
   * gets its own disposable workspace and runtime: ending or cancelling it
   * never touches the parent or sibling roles.
   */
  async spawnRoleChatSession(parentSessionId: string, role: AgentRole, title?: string): Promise<{ session: ChatSessionRecord; isolation: IsolationSummary; providerCatalogs: readonly AgentModelCatalog[] }> {
    this.options.securityPolicy?.assertNetworkedAiAllowed();
    const parentId = asId<"SessionId">(parentSessionId);
    const snapshot = this.options.chatService.liveSpawnSnapshot(parentId);
    if (snapshot === null) {
      throw new Error("The parent session is not live in this window; role sessions spawn from a live parent chat.");
    }
    const parentRecord = await this.options.chatService.getSession(parentId);
    if (parentRecord?.mode === "clone") {
      // The clone lives inside the parent's private disposable workspace,
      // which a separate child runtime cannot see - spawning would hand the
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
    this.options.securityPolicy?.assertNetworkedAiAllowed();
    const session = await this.options.chatService.startSession({
      template,
      workspacePath: workspace.workspacePath,
      workspaceOwnerToken: workspace.ownerToken,
      title: title ?? `${role} - ${parentRecord?.title ?? "chat"}`,
      model: snapshot.model,
      transport: snapshot.transport,
      mode,
      parentSessionId: parentId,
      spawnedRole: role,
      disposeWorkspace: () => this.options.workspaceStore.cleanupWorkspace(workspace)
    });
    await this.refreshModelsForSession(session.sessionId, session.providerId);
    this.sessionModes.set(session.sessionId, mode);
    return {
      session,
      isolation: isolationSummaryFromTemplate(template, workspace.workspacePath),
      providerCatalogs: this.listChatProviderCatalogs()
    };
  }

  /**
   * Records a send that failed before any turn existed as a durable transcript
   * event, so the failure is visible in the chat instead of vanishing.
   * Best-effort: recording must never mask the original failure.
   */
  async recordChatSendFailure(sessionId: string, error: unknown): Promise<void> {
    try {
      await this.options.chatService.recordSendFailure(asId<"SessionId">(sessionId), error);
    } catch (recordError) {
      this.options.logger.warn("recording a send failure failed", {
        sessionId,
        error: recordError instanceof Error ? recordError.message : String(recordError)
      });
    }
  }

  /** Resolves when the turn reaches a terminal status; events flow via the bus. */
  async sendChatTurn(sessionId: string, prompt: string, model?: ChatModelSelection): Promise<TurnResult> {
    this.options.securityPolicy?.assertNetworkedAiAllowed();
    const normalizedModel = model === undefined ? undefined : this.normalizeModelSelection(model);
    this.assertSupportedModelSelection(normalizedModel);
    const briefedPrompt = await this.applySessionBriefing(sessionId, prompt);
    this.options.securityPolicy?.assertNetworkedAiAllowed();
    return this.options.chatService.sendTurn(asId<"SessionId">(sessionId), briefedPrompt, normalizedModel === undefined ? undefined : { model: normalizedModel });
  }

  /**
   * Prepends the host briefing to a session's first prompt (and the first
   * prompt after a backend restart, when briefedSessions was cleared and mounts
   * may have changed). The briefing is host-authored preamble; the user's text
   * follows it. Once briefed, the session is marked so later turns pay nothing -
   * in particular the approved-memory query runs only on the first briefed turn,
   * never on every turn.
   */
  private async applySessionBriefing(sessionId: string, prompt: string): Promise<string> {
    if (this.briefedSessions.has(sessionId)) {
      return prompt;
    }
    // Scoped memory (design doc): global + this workspace + this task, tag
    // filtered against the mounted roots, grouped most specific first. Under
    // a managed/project-restricting policy only the provenance-free GLOBAL
    // group is dropped - workspace/task memories carry their anchor.
    const memoryGroups = await this.memoryGroupsFor(sessionId);
    const mode = this.sessionModes.get(sessionId) ?? "implementation";
    const cloneRepos = mode === "clone"
      ? (this.sessionClones.get(sessionId) ?? []).map((repo) => repo.name)
      : [];
    // MCP config + instruction-file detection run before the FIRST turn: the
    // agent CLIs are invoked per turn, so a /workspace/.mcp.json written here
    // is loaded by every turn including this one.
    const mcpConfigured = await this.ensureMcpConfig(sessionId);
    const instructionFiles = await this.detectInstructionFiles(sessionId);
    const briefing = buildSessionBriefing({
      mode,
      mounts: this.options.chatService.getSessionMounts(asId<"SessionId">(sessionId)),
      ...(memoryGroups.length === 0 ? {} : { memoryGroups }),
      ...(cloneRepos.length === 0 ? {} : { cloneRepos }),
      ...(instructionFiles.length === 0 ? {} : { instructionFiles }),
      ...(this.options.teamInstructions === undefined ? {} : { teamInstructions: this.options.teamInstructions }),
      ...(mcpConfigured ? { mcpConfigured: true } : {})
    });
    this.briefedSessions.add(sessionId);
    return `${briefing}\n\n${prompt}`;
  }

  /** Session roots + linked tasks + detected tags - the scope query shared by memory and MCP. */
  private async sessionScopeQuery(sessionId: string): Promise<{ sessionRoots: readonly string[]; taskIds: readonly string[]; detectedTags: readonly string[] }> {
    const stored = await this.options.chatService.getSession(asId<"SessionId">(sessionId));
    const sessionRoots = stored?.workspaceRoots ?? [];
    const taskIds = this.options.sessionTaskIds === undefined ? [] : await this.options.sessionTaskIds(sessionId);
    const detectedTags = await this.tagsForRoots(sessionRoots);
    return { sessionRoots, taskIds, detectedTags };
  }

  private async memoryGroupsFor(sessionId: string): Promise<{ label: string; notes: readonly string[] }[]> {
    if (this.options.memoryService === undefined) return [];
    try {
      const query = await this.sessionScopeQuery(sessionId);
      return await this.options.memoryService.briefingGroups({
        ...query,
        blockGlobal: blocksGlobalMemoryBriefing(this.options.securityPolicy)
      });
    } catch (error) {
      this.options.logger.warn("memory briefing selection failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  /**
   * Detected workspace tags per root: one bounded scan (top levels +
   * extension census) cached for TAG_CACHE_TTL_MS, so mount-time detection
   * stays fast and repeated briefings pay nothing.
   */
  async tagsForRoots(roots: readonly string[]): Promise<string[]> {
    const rules = this.options.tagRules ?? [];
    if (rules.length === 0 || roots.length === 0) return [];
    const tags = new Set<string>();
    for (const root of roots) {
      const key = root.replace(/\\/g, "/").toLowerCase();
      const cached = this.tagCache.get(key);
      if (cached !== undefined && Date.now() - cached.at < TAG_CACHE_TTL_MS) {
        for (const tag of cached.tags) tags.add(tag);
        continue;
      }
      try {
        const detected = await detectWorkspaceTags([root], rules);
        this.tagCache.set(key, { tags: detected, at: Date.now() });
        for (const tag of detected) tags.add(tag);
      } catch {
        // Unreadable root: no tags, no cache poison.
      }
    }
    return [...tags].sort();
  }

  async restartChatBackend(sessionId: string, model: ChatModelSelection): Promise<{ session: ChatSessionRecord; providerCatalogs: readonly AgentModelCatalog[] }> {
    this.options.securityPolicy?.assertNetworkedAiAllowed();
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
    await this.refreshModelsForSession(session.sessionId, session.providerId);
    return { session, providerCatalogs: this.listChatProviderCatalogs() };
  }

  /**
   * "Take over here": reclaims a session another window still owns - most often
   * this same window's own pre-reload instance, whose heartbeat has not yet gone
   * stale - and revives it live in THIS window with its transcript replayed.
   * Claims ownership first so the running-elsewhere guard yields, then resumes on
   * a fresh runtime using the session's persisted project roots plus any approved
   * access mounts.
   */
  async reclaimChatSession(
    sessionId: string,
    model?: ChatModelSelection,
    additionalRoots?: { readonly roots: readonly string[]; readonly readOnlyRoots: readonly string[] }
  ): Promise<{ session: ChatSessionRecord; isolation: IsolationSummary; providerCatalogs: readonly AgentModelCatalog[] }> {
    const stored = await this.options.chatService.getSession(asId<"SessionId">(sessionId));
    if (stored === null) throw new Error(`Session ${sessionId} was not found.`);
    this.assertStoredSessionAllowed(stored, additionalRoots);
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
   * session - resume is revival, not a takeover of a running backend.
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
    this.assertStoredSessionAllowed(stored, additionalRoots);
    // Default the model to what the session last ran under; normalize + assert
    // exactly as the start path does.
    const requestedModel = model ?? {
      providerId: stored.providerId,
      ...(stored.model === undefined ? {} : { model: stored.model })
    };
    const normalizedModel = this.normalizeModelSelection(requestedModel);
    this.assertSupportedModelSelection(normalizedModel);
    // Re-mount the SAME project roots and mode the session started with. A
    // caller-supplied workspace is only a legacy fallback when the row has no
    // persisted roots; it must never downgrade a saved plan/clone session into
    // live implementation mounts. Clone snapshot handling is persisted too, so
    // fresh HEAD cannot silently become carry-on-resume.
    const baseWorkspace = resolveResumeWorkspaceContext(stored, workspace);
    // Merge back the folders granted via approved access requests, so a resume
    // re-mounts what the agent was already allowed (e.g. a project it asked for)
    // instead of losing it and re-requesting every time.
    const effectiveWorkspace = mergeWorkspaceRoots(baseWorkspace, additionalRoots, stored.mode);
    // A resume re-runs the same seams, so it reports the same stages: the
    // rail's reconnect spinner reads one vocabulary for both paths.
    const boot = this.bootStages(asId<"SessionId">(sessionId));
    const prepared = await this.prepareWorkspace("chat", effectiveWorkspace, normalizedModel.providerId, boot);
    const policyWorkspace = prepared.workspaceContext;
    boot.stage("start");
    const session = await this.options.chatService.resumeSession({
      sessionId: asId<"SessionId">(sessionId),
      template: prepared.template,
      workspacePath: prepared.workspace.workspacePath,
      workspaceOwnerToken: prepared.workspace.ownerToken,
      model: normalizedModel,
      transport: transportForProvider(normalizedModel.providerId),
      ...(policyWorkspace?.mode === undefined ? {} : { mode: policyWorkspace.mode }),
      ...(force ? { force: true } : {}),
      disposeWorkspace: () => this.options.workspaceStore.cleanupWorkspace(prepared.workspace)
    });
    // Resume re-clones on a fresh workspace, so the mode comes from the stored
    // record when the caller omitted a workspace (mode is immutable per session).
    this.sessionModes.set(session.sessionId, policyWorkspace?.mode ?? session.mode ?? "implementation");
    this.stashSessionClones(session.sessionId, prepared.clones);
    // Mounts changed with the fresh runtime; the next turn must re-brief.
    this.briefedSessions.delete(session.sessionId);
    await this.refreshModelsForSession(session.sessionId, session.providerId);
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
    this.assertCloneHostAccess(clones);
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
    this.assertCloneHostAccess(clones);
    if (repo === undefined) {
      return this.aggregateInbound(clones);
    }
    const target = this.requireCloneRepo(clones, repo);
    return this.options.cloneSync.inboundPatch(
      target.clonePath,
      target.localRepoPath,
      {
        ...(filePath === undefined ? {} : { path: filePath }),
        ...(target.omission === undefined ? {} : { omission: target.omission })
      }
    );
  }

  /**
   * Durable outbound patches for every clone of a session (ADR 0014 capture).
   * Returns null when the process-local clone state is gone (window reload,
   * ended session) - the caller records an honest skip instead of guessing.
   * Refuses mid-turn like every other sync op (the agent may be writing).
   */
  async buildOutboundPatches(sessionId: string): Promise<{ readonly repoName: string; readonly patch: string; readonly fileCount: number; readonly paths: readonly string[] }[] | null> {
    const clones = this.sessionClones.get(sessionId);
    if (clones === undefined || clones.length === 0) return null;
    this.assertNoActiveTurnForSync(sessionId);
    this.assertCloneHostAccess(clones);
    const patches: { repoName: string; patch: string; fileCount: number; paths: readonly string[] }[] = [];
    for (const clone of clones) {
      const result = await this.options.cloneSync.outboundChangesetPatch(clone.clonePath, clone.omission);
      if (result !== null) {
        patches.push({ repoName: clone.name, patch: result.patch, fileCount: result.fileCount, paths: result.paths });
      }
    }
    return patches;
  }

  /** Push the developer's local edits into every clone (VM). Refuses while a turn runs. */
  async clonePush(sessionId: string): Promise<CloneSyncResult> {
    const clones = this.requireSessionClones(sessionId);
    this.assertNoActiveTurnForSync(sessionId);
    this.assertCloneHostAccess(clones);
    return this.aggregateOutbound(clones);
  }

  /** The sandbox CLI path, for host affordances that shell out directly (terminal attach); null when unset. */
  getSbxPath(): string | null {
    return this.options.sbxPath ?? null;
  }

  /**
   * The session's effective MCP servers under the registry cascade (defaults
   * → workspace-set → task → session, sensitive gate applied). Empty when no
   * registry is wired.
   */
  async effectiveMcpServers(sessionId: string): Promise<McpEffectiveServer[]> {
    if (this.options.mcpRegistry === undefined) return [];
    const query = await this.sessionScopeQuery(sessionId);
    const workspaceSets = this.options.workspaceSetRefs === undefined ? [] : await this.options.workspaceSetRefs();
    return this.options.mcpRegistry.effectiveForSession({
      sessionId,
      sessionRoots: query.sessionRoots,
      taskIds: query.taskIds,
      workspaceSets: [...workspaceSets]
    });
  }

  /** The .mcp.json this session should carry right now; null = nothing enabled. */
  private async effectiveMcpJson(sessionId: string): Promise<string | null> {
    if (this.options.mcpRegistry !== undefined) {
      const effective = await this.effectiveMcpServers(sessionId);
      return this.options.mcpRegistry.renderConfigJson(effective);
    }
    // Legacy path: the raw validated drydock.mcp.configPath contents.
    return this.options.mcpConfigJson ?? null;
  }

  /**
   * Writes the session's effective MCP config to /workspace/.mcp.json (once
   * per session) so per-turn CLI invocations load it. Claude transports read
   * the project-scope file; Codex support is a recorded follow-up.
   * Best-effort: failures log and the briefing simply omits the MCP line.
   */
  private async ensureMcpConfig(sessionId: string): Promise<boolean> {
    if (this.mcpConfiguredSessions.has(sessionId)) return true;
    let configJson: string | null;
    try {
      configJson = await this.effectiveMcpJson(sessionId);
    } catch (error) {
      this.options.logger.warn("mcp effective-set resolution failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
    if (configJson === null) return false;
    const written = await this.writeMcpConfig(sessionId, configJson);
    if (written) this.mcpConfiguredSessions.add(sessionId);
    return written;
  }

  /**
   * Rewrites a LIVE session's config after a toggle. Honest semantics: the
   * per-turn CLI picks the file up on the NEXT turn. An empty effective set
   * writes an empty mcpServers map so a disable actually disables.
   */
  async refreshMcpConfig(sessionId: string): Promise<boolean> {
    if (this.options.chatService.liveRuntimeHandle(asId(sessionId)) === null) return false;
    let configJson: string | null;
    try {
      configJson = await this.effectiveMcpJson(sessionId);
    } catch {
      return false;
    }
    const written = await this.writeMcpConfig(sessionId, configJson ?? '{\n  "mcpServers": {}\n}');
    if (written) this.mcpConfiguredSessions.add(sessionId);
    return written;
  }

  /** Rewrites every live session's config; used after registry/override edits. */
  async refreshMcpConfigForLiveSessions(): Promise<void> {
    for (const sessionId of this.options.chatService.liveSessionIds()) {
      await this.refreshMcpConfig(sessionId).catch(() => false);
    }
  }

  private async writeMcpConfig(sessionId: string, configJson: string): Promise<boolean> {
    const executor = this.options.runtimeExecutor;
    const runtime = this.options.chatService.liveRuntimeHandle(asId(sessionId));
    if (executor === undefined || runtime === null) return false;
    try {
      const result = await executor.exec(
        runtime,
        ["/bin/sh", "-c", "base64 -d > /workspace/.mcp.json"],
        30_000,
        Buffer.from(configJson, "utf8").toString("base64")
      );
      if (result.exitCode !== 0) throw new Error(result.stderr.slice(0, 200));
      return true;
    } catch (error) {
      this.options.logger.warn("mcp config write failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  /**
   * Lists repo instruction files (CLAUDE.md / AGENTS.md) present in the
   * session's mounts, by runtime path, so the briefing can point at them.
   * Best-effort: empty on any failure.
   */
  private async detectInstructionFiles(sessionId: string): Promise<string[]> {
    const executor = this.options.runtimeExecutor;
    const runtime = this.options.chatService.liveRuntimeHandle(asId(sessionId));
    if (executor === undefined || runtime === null) return [];
    try {
      const result = await executor.exec(
        runtime,
        ["/bin/sh", "-c", "for f in /workspace/CLAUDE.md /workspace/AGENTS.md /workspace/*/CLAUDE.md /workspace/*/AGENTS.md /workspace/repos/*/CLAUDE.md /workspace/repos/*/AGENTS.md; do [ -f \"$f\" ] && echo \"$f\"; done; exit 0"],
        15_000
      );
      return result.stdout.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("/workspace/")).slice(0, 12);
    } catch {
      return [];
    }
  }

  /**
   * Context debug (design doc): everything the session's briefing/context is
   * composed of, as markdown, each section annotated with WHERE it came from.
   * Renders what the NEXT briefed turn would carry - the same code paths the
   * real briefing uses, so this view cannot drift from reality.
   */
  async composeContextDebug(sessionId: string): Promise<string> {
    const stored = await this.options.chatService.getSession(asId<"SessionId">(sessionId));
    if (stored === null) throw new Error(`Session ${sessionId} was not found.`);
    const live = this.isChatSessionLive(sessionId);
    const mode = this.sessionModes.get(sessionId) ?? stored.mode ?? "implementation";
    const scope = await this.sessionScopeQuery(sessionId);
    const mounts = this.options.chatService.getSessionMounts(asId<"SessionId">(sessionId));
    const lines: string[] = [];
    lines.push(`# Context debug - ${stored.title}`);
    lines.push("");
    lines.push(`> Session \`${sessionId}\` · ${stored.providerId}${stored.model === undefined ? "" : ` / ${stored.model}`} · mode: ${mode} · ${live ? "live" : `not live (${stored.status})`}`);
    lines.push(`> Generated ${this.options.clock.isoNow()}. Shows what the next briefed turn would carry; a session is briefed on its first turn and re-briefed after restarts.`);
    lines.push("");

    lines.push("## Mounts");
    lines.push("_Source: the session's runtime template - workspace roots chosen at start, plus approved access-request grants (ADR 0009)._");
    if (mounts.length === 0) {
      lines.push("- none beyond the disposable workspace");
    } else {
      for (const mount of mounts) {
        lines.push(`- \`${mount.runtimePath}\` (${mount.mode})${mount.hostDisplayPath === undefined ? "" : ` ← host \`${mount.hostDisplayPath}\``}`);
      }
    }
    lines.push("");

    lines.push("## Detected workspace tags");
    lines.push("_Source: glob rule table (built-in defaults + `drydock.memory.tagRules`) matched against the mounted roots at mount time. Tags select which tagged memories load._");
    lines.push(scope.detectedTags.length === 0 ? "- none detected" : scope.detectedTags.map((tag) => `\`${tag}\``).join(" · "));
    lines.push("");

    lines.push("## Team memory");
    lines.push("_Source: the memory store. Grouped by scope, most specific first; tagged memories require a matching detected tag. Agent proposals entered via the approval gate; user entries via quick-add._");
    const memoryGroups = this.options.memoryService === undefined
      ? []
      : await this.options.memoryService.briefingRecords({
          sessionRoots: scope.sessionRoots,
          taskIds: scope.taskIds,
          detectedTags: scope.detectedTags,
          blockGlobal: blocksGlobalMemoryBriefing(this.options.securityPolicy)
        });
    if (memoryGroups.length === 0) {
      lines.push("- none apply to this session");
    }
    for (const group of memoryGroups) {
      lines.push(`### ${group.label}`);
      for (const record of group.records) {
        const origin = record.origin === "user" ? "user quick-add" : `agent proposal (session \`${record.sessionId}\`, approved)`;
        const tags = record.tags === undefined || record.tags.length === 0 ? "" : ` · tags: ${record.tags.join(", ")}`;
        lines.push(`- ${record.content}`);
        lines.push(`  - _from: ${origin} · added ${record.createdAt}${tags}_`);
      }
    }
    lines.push("");

    lines.push("## MCP servers");
    if (this.options.mcpRegistry === undefined) {
      lines.push("_Source: `drydock.mcp.configPath`._");
      lines.push(this.options.mcpConfigJson === undefined ? "- none configured" : "- host config file written to `/workspace/.mcp.json` before the first turn");
    } else {
      lines.push("_Source: MCP registry (Configure → MCP Servers) resolved through the override cascade - defaults → workspace → task → chat. Rendered to `/workspace/.mcp.json` over the exec channel; toggles apply next turn._");
      const effective = await this.effectiveMcpServers(sessionId).catch(() => [] as McpEffectiveServer[]);
      if (effective.length === 0) {
        lines.push("- no servers registered");
      }
      for (const entry of effective) {
        const decided = entry.decidedBy === "default"
          ? "registry default"
          : entry.decidedBy === "sensitive-gate"
            ? "sensitive - needs a task/chat opt-in"
            : `${entry.decidedBy} override`;
        lines.push(`- ${entry.enabled ? "🟢" : "⚪"} **${entry.server.name}** - ${entry.enabled ? "on" : "off"} (${decided})${entry.server.source === "settings" ? " · from settings" : ""}`);
      }
    }
    lines.push("");

    lines.push("## Standing instructions");
    lines.push("_Source: repo instruction files detected inside the live sandbox at first turn, plus `drydock.teamInstructionsPath` appended to every briefing._");
    const instructionFiles = live ? await this.detectInstructionFiles(sessionId) : [];
    if (instructionFiles.length === 0) {
      lines.push(live ? "- no CLAUDE.md / AGENTS.md files detected in the mounts" : "- session not live; file detection runs in-container at first turn");
    } else {
      for (const file of instructionFiles) lines.push(`- \`${file}\``);
    }
    if (this.options.teamInstructions !== undefined && this.options.teamInstructions.trim().length > 0) {
      lines.push("- team instructions (drydock.teamInstructionsPath):");
      lines.push("");
      lines.push("```");
      lines.push(this.options.teamInstructions.trim());
      lines.push("```");
    }
    lines.push("");

    lines.push("## Full briefing preview");
    lines.push("_Source: host-composed preamble prepended to the first prompt (stripped from replayed context). This is the exact text, built by the same code the real briefing uses._");
    const briefing = buildSessionBriefing({
      mode,
      mounts,
      ...(mode === "clone" ? { cloneRepos: (this.sessionClones.get(sessionId) ?? []).map((repo) => repo.name) } : {}),
      ...(await this.memoryGroupsFor(sessionId).then((groups) => (groups.length === 0 ? {} : { memoryGroups: groups }))),
      ...(instructionFiles.length === 0 ? {} : { instructionFiles }),
      ...(this.options.teamInstructions === undefined ? {} : { teamInstructions: this.options.teamInstructions }),
      ...(this.mcpConfiguredSessions.has(sessionId) ? { mcpConfigured: true } : {})
    });
    lines.push("");
    lines.push("````");
    lines.push(briefing);
    lines.push("````");
    lines.push("");
    return lines.join("\n");
  }

  // MARK: Sandbox preview servers (ADR 0017)

  /**
   * Registers an agent-announced in-sandbox HTTP server and starts a host
   * 127.0.0.1 proxy for it. Each proxied request is one bounded exec into the
   * SESSION'S OWN container (node fetch against loopback), so no container
   * restart, no published ports, and no network reach beyond that one
   * container - remote runtimes work over their own exec transport. Web-only
   * previews; websockets/streaming are a recorded fast-follow.
   */
  async registerPreview(sessionId: string, containerPort: number, urlPath: string, title: string): Promise<PreviewSummary> {
    const executor = this.options.runtimeExecutor;
    if (executor === undefined) throw new Error("Preview proxying is not available in this build.");
    if (this.options.chatService.liveRuntimeHandle(asId(sessionId)) === null) {
      throw new Error("Start or resume this chat first - previews proxy into the running sandbox.");
    }
    const existing = (this.sessionPreviews.get(sessionId) ?? []).find((candidate) => candidate.summary.containerPort === containerPort);
    if (existing !== undefined) {
      existing.summary = { ...existing.summary, title, path: urlPath };
      return existing.summary;
    }
    await this.ensurePrototypeThemes(sessionId);
    const { createServer } = await import("node:http");
    const server = createServer((request, response) => {
      void this.proxyPreviewRequest(sessionId, containerPort, request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    const hostPort = typeof address === "object" && address !== null ? address.port : 0;
    const summary: PreviewSummary = {
      previewId: `pv-${sessionId.slice(0, 8)}-${String(containerPort)}`,
      sessionId,
      title,
      containerPort,
      path: urlPath,
      url: `http://127.0.0.1:${String(hostPort)}${urlPath}`,
      status: "up",
      createdAt: this.options.clock.isoNow()
    };
    const list = this.sessionPreviews.get(sessionId) ?? [];
    list.push({ summary, server });
    this.sessionPreviews.set(sessionId, list);
    this.options.logger.info("preview proxy started", { sessionId, containerPort, url: summary.url });
    return summary;
  }

  listPreviews(sessionId: string): PreviewSummary[] {
    return (this.sessionPreviews.get(sessionId) ?? []).map((entry) => entry.summary);
  }

  getPreview(previewId: string): PreviewSummary | null {
    for (const entries of this.sessionPreviews.values()) {
      const found = entries.find((entry) => entry.summary.previewId === previewId);
      if (found !== undefined) return found.summary;
    }
    return null;
  }

  /** Closes the proxy listener and drops the record; returns the session's remaining previews. */
  stopPreview(previewId: string): PreviewSummary[] {
    for (const [sessionId, entries] of this.sessionPreviews.entries()) {
      const index = entries.findIndex((entry) => entry.summary.previewId === previewId);
      if (index === -1) continue;
      entries[index]?.server.close();
      entries.splice(index, 1);
      this.sessionPreviews.set(sessionId, entries);
      return entries.map((entry) => entry.summary);
    }
    return [];
  }

  /** Pushes built-in + studio prototype theme CSS into the sandbox, once per session. */
  private async ensurePrototypeThemes(sessionId: string): Promise<void> {
    if (this.themedSessions.has(sessionId)) return;
    const executor = this.options.runtimeExecutor;
    const runtime = this.options.chatService.liveRuntimeHandle(asId(sessionId));
    if (executor === undefined || runtime === null) return;
    const themes = [...BUILT_IN_PROTOTYPE_THEMES, ...(this.options.userPrototypeThemes ?? [])]
      .filter((theme) => isValidThemeName(theme.name));
    for (const theme of themes) {
      try {
        await executor.exec(
          runtime,
          ["/bin/sh", "-c", `mkdir -p /workspace/.drydock-themes && base64 -d > /workspace/.drydock-themes/${theme.name}.css`],
          30_000,
          Buffer.from(theme.css, "utf8").toString("base64")
        );
      } catch (error) {
        this.options.logger.warn("prototype theme push failed", {
          sessionId,
          theme: theme.name,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    this.themedSessions.add(sessionId);
  }

  /** One proxied HTTP request: gather body → exec node-fetch inside the container → relay status/headers/body. */
  private async proxyPreviewRequest(
    sessionId: string,
    containerPort: number,
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse
  ): Promise<void> {
    try {
      const executor = this.options.runtimeExecutor;
      const runtime = this.options.chatService.liveRuntimeHandle(asId(sessionId));
      if (executor === undefined || runtime === null) {
        response.writeHead(503, { "content-type": "text/plain" });
        response.end("The session is not live - resume it to serve this preview.");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        const lower = key.toLowerCase();
        if (lower === "host" || lower === "connection" || lower === "accept-encoding" || lower === "content-length") continue;
        if (typeof value === "string") headers[lower] = value;
      }
      const payload = JSON.stringify({
        port: containerPort,
        method: request.method ?? "GET",
        path: request.url ?? "/",
        headers,
        bodyB64: chunks.length === 0 ? "" : Buffer.concat(chunks).toString("base64")
      });
      const script = "const c=[];process.stdin.on('data',d=>c.push(d));process.stdin.on('end',async()=>{const q=JSON.parse(Buffer.concat(c).toString('utf8'));try{const r=await fetch('http://127.0.0.1:'+q.port+q.path,{method:q.method,headers:q.headers,...(q.bodyB64?{body:Buffer.from(q.bodyB64,'base64')}:{}),redirect:'manual'});const b=Buffer.from(await r.arrayBuffer());const h={};r.headers.forEach((v,k)=>{h[k]=v});process.stdout.write(JSON.stringify({status:r.status,headers:h})+'\\n'+b.toString('base64'))}catch(e){process.stdout.write(JSON.stringify({status:502,headers:{'content-type':'text/plain'}})+'\\n'+Buffer.from(String(e)).toString('base64'))}})";
      const result = await executor.exec(runtime, ["node", "-e", script], 30_000, payload);
      const newline = result.stdout.indexOf("\n");
      if (result.exitCode !== 0 || newline === -1) {
        response.writeHead(502, { "content-type": "text/plain" });
        response.end(`Preview proxy failed: ${result.stderr.slice(0, 300) || "no response from the sandbox server"}`);
        return;
      }
      const head = JSON.parse(result.stdout.slice(0, newline)) as { status: number; headers: Record<string, string> };
      const body = Buffer.from(result.stdout.slice(newline + 1), "base64");
      const outHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(head.headers)) {
        const lower = key.toLowerCase();
        if (lower === "content-encoding" || lower === "transfer-encoding" || lower === "content-length" || lower === "connection") continue;
        outHeaders[lower] = value;
      }
      outHeaders["content-length"] = String(body.length);
      response.writeHead(head.status, outHeaders);
      response.end(body);
    } catch (error) {
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
      response.end(`Preview proxy error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Writes a user attachment (pasted screenshot, picked image/document) into
   * the LIVE session's container at /workspace/attachments/<name> via a
   * bounded exec - base64 over stdin, so it rides the runtime transport and
   * works identically for remote/networked runtimes. No mounts change and
   * nothing restarts; the agent can read the file immediately. Refuses when
   * the session is not live in this window.
   */
  async uploadAttachment(sessionId: string, name: string, dataBase64: string): Promise<{ runtimePath: string; name: string; bytes: number }> {
    const executor = this.options.runtimeExecutor;
    if (executor === undefined) {
      throw new Error("Attachment uploads are not available in this build.");
    }
    const runtime = this.options.chatService.liveRuntimeHandle(asId(sessionId));
    if (runtime === null) {
      throw new Error("Start or resume this chat first - attachments upload into the running sandbox.");
    }
    const bytes = Buffer.from(dataBase64, "base64");
    if (bytes.length === 0) throw new Error("The attachment was empty.");
    if (bytes.length > 12 * 1024 * 1024) throw new Error("Attachments are capped at 12 MB.");
    // Leaf name only, shell-safe charset, stamped to avoid collisions.
    const base = name.replace(/^.*[\\/]/, "").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 100) || "attachment";
    const safe = `${Date.now().toString(36)}-${base}`;
    const runtimePath = `/workspace/attachments/${safe}`;
    const result = await executor.exec(
      runtime,
      ["/bin/sh", "-c", `mkdir -p /workspace/attachments && base64 -d > ${runtimePath}`],
      60_000,
      dataBase64
    );
    if (result.exitCode !== 0) {
      throw new Error(`Attachment upload failed in the sandbox: ${result.stderr.slice(0, 300) || `exit ${String(result.exitCode)}`}`);
    }
    this.options.logger.info("attachment uploaded", { sessionId, runtimePath, bytes: bytes.length });
    return { runtimePath, name: safe, bytes: bytes.length };
  }

  /**
   * Reads one image the agent produced inside its LIVE sandbox and returns it
   * as a data URI (ADR 0016 question illustrations). The inverse of
   * uploadAttachment: `base64 <path>` over the runtime transport, capped at
   * ~512 KB encoded, absolute in-sandbox image paths only. Null on any
   * failure - callers degrade to a path-only reference, never throw.
   */
  async readSandboxImageDataUri(sessionId: string, imagePath: string): Promise<string | null> {
    const executor = this.options.runtimeExecutor;
    if (executor === undefined) return null;
    const runtime = this.options.chatService.liveRuntimeHandle(asId(sessionId));
    if (runtime === null) return null;
    if (!/^\/[^\s'"`]+\.(png|jpe?g|gif|webp|bmp)$/i.test(imagePath) || imagePath.includes("..")) return null;
    try {
      const result = await executor.exec(runtime, ["base64", imagePath], 30_000);
      if (result.exitCode !== 0) return null;
      const encoded = result.stdout.replace(/\s+/g, "");
      if (encoded.length === 0 || encoded.length > 700_000) return null;
      const ext = imagePath.toLowerCase().split(".").pop() ?? "png";
      const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
      return `data:${mime};base64,${encoded}`;
    } catch {
      return null;
    }
  }

  /** Restore one file in a clone to its sync base. Refuses while a turn runs. */
  async cloneDiscard(sessionId: string, repo: string, filePath: string): Promise<void> {
    const clones = this.requireSessionClones(sessionId);
    this.assertNoActiveTurnForSync(sessionId);
    this.assertCloneHostAccess(clones);
    const target = this.requireCloneRepo(clones, repo);
    await this.options.cloneSync.discardFile(target.clonePath, filePath);
  }

  /** Runs a full inbound pull across every clone and merges their results into one. */
  private async aggregateInbound(clones: readonly SessionCloneRepo[]): Promise<CloneSyncResult> {
    const results: CloneSyncResult[] = [];
    for (const clone of clones) {
      results.push(await this.options.cloneSync.inboundPatch(
        clone.clonePath,
        clone.localRepoPath,
        clone.omission === undefined ? undefined : { omission: clone.omission }
      ));
    }
    return mergeSyncResults("Pulled", results);
  }

  /** Runs an outbound push across every clone and merges their results into one. */
  private async aggregateOutbound(clones: readonly SessionCloneRepo[]): Promise<CloneSyncResult> {
    const results: CloneSyncResult[] = [];
    for (const clone of clones) {
      results.push(await this.options.cloneSync.outboundSync(clone.clonePath, clone.localRepoPath, clone.omission));
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

  private assertCloneHostAccess(clones: readonly SessionCloneRepo[]): void {
    this.options.securityPolicy?.assertPolicyCurrent();
    for (const clone of clones) this.assertWorkspaceRootAllowed(clone.localRepoPath);
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
    // Registry order, one entry per registered provider: a provider that has
    // never been discovered still gets an honest "unavailable" row so the
    // picker can say so (and offer Refresh) instead of omitting it.
    return PROVIDER_REGISTRY.map((descriptor) => {
      const catalog = this.providerCatalogs.get(descriptor.providerId) ?? {
        providerId: descriptor.providerId,
        displayName: descriptor.displayName,
        models: [],
        refreshedAt: this.options.clock.isoNow(),
        source: "unavailable" as const,
        diagnostics: [
          `No models discovered yet. Connect ${descriptor.displayName} or press Refresh models; a model id can also be typed directly.`
        ]
      };
      return {
        ...catalog,
        authStatus: this.providerAuthStatuses.get(descriptor.providerId) ?? "unknown",
        loginHint: this.loginHint(descriptor.providerId),
        authKind: (descriptor.connect.oauth !== undefined ? "oauth" : "api-key") as "oauth" | "api-key",
        ...(descriptor.connect.apiKey === undefined ? {} : { keyUrl: descriptor.connect.apiKey.keyUrl })
      };
    });
  }

  /**
   * Display command plus spawnable pieces for signing a provider in.
   *
   * `sbx-service-oauth` providers run `sbx secret set -g <service> --oauth`
   * (a HOST-side flow: browser and localhost callback both work natively).
   * The Claude terminal fallback stays `sbx run claude` + `/login` because
   * Docker Sandbox rejects `sbx secret set -g anthropic --oauth`; the guided
   * host path (ProviderConnectService, `claude setup-token`) is preferred and
   * only falls back here when no host Claude CLI exists. API-key-only
   * providers have no spawnable login; the connect card collects a key via
   * `provider.submitApiKey` instead.
   */
  loginCommand(providerId: string): { readonly command: string; readonly args: readonly string[]; readonly display: string } {
    this.assertInteractiveSetupAllowed("Provider sign-in");
    if (this.options.sbxPath === undefined) {
      throw new Error(`No login flow is available for provider ${providerId}.`);
    }
    const normalized = this.normalizeModelSelection({ providerId }).providerId;
    const descriptor = providerDescriptor(normalized);
    if (descriptor?.connect.oauth === "sbx-service-oauth" && descriptor.connect.sbxService !== undefined) {
      const args = ["secret", "set", "-g", descriptor.connect.sbxService, "--oauth"];
      return { command: this.options.sbxPath, args, display: `sbx ${args.join(" ")}` };
    }
    if (normalized === CLAUDE_PROVIDER_ID) {
      const args = ["run", "claude"];
      return { command: this.options.sbxPath, args, display: "sbx run claude (then /login inside Claude)" };
    }
    throw new Error(
      descriptor?.connect.apiKey !== undefined
        ? `${descriptor.displayName} signs in with an API key; enter one on the connect card instead.`
        : `No login flow is available for provider ${providerId}.`
    );
  }

  /** Final host guard for OAuth and other interactive network setup. */
  assertInteractiveSetupAllowed(action: string): void {
    this.options.securityPolicy?.assertNetworkedAiAllowed();
    if (this.options.securityPolicy?.managed === true) {
      throw new Error(
        `${action} is disabled in managed mode. Ask your administrator to pre-provision access for this workstation.`
      );
    }
  }

  /** Managed runtimes must be operated through the bounded product controls. */
  assertRuntimeTerminalAllowed(): void {
    this.options.securityPolicy?.assertPolicyCurrent();
    if (this.options.securityPolicy?.managed === true) {
      throw new Error(
        "Runtime terminal access is disabled in managed mode. Use the chat controls, or ask your administrator for an approved troubleshooting workflow."
      );
    }
  }

  /**
   * Inert auth-status probe. Providers backed by a Docker Sandbox service
   * secret read the secret ledger (the same store the sandbox proxy uses to
   * authenticate agents) without touching any secret values; providers backed
   * by VS Code SecretStorage check only whether their reference exists.
   */
  async refreshProviderAuthStatuses(): Promise<void> {
    let configuredServices: ReadonlySet<string> | null = null;
    if (this.options.sbxPath !== undefined && this.options.commandRunner !== undefined) {
      try {
        const result = await this.options.commandRunner.run(this.options.sbxPath, ["secret", "ls"], {
          cwd: process.cwd(),
          timeoutMs: 15_000
        });
        if (result.exitCode !== 0) {
          throw new Error(result.stderr || result.error || "sbx secret ls failed");
        }
        configuredServices = parseSbxSecretServices(result.stdout);
      } catch (error) {
        this.options.logger.warn("provider auth status probe failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    for (const descriptor of PROVIDER_REGISTRY) {
      const service = descriptor.connect.sbxService;
      if (service !== undefined) {
        this.providerAuthStatuses.set(
          descriptor.providerId,
          configuredServices === null ? "unknown" : configuredServices.has(service) ? "authenticated" : "needs-login"
        );
        continue;
      }
      if (this.options.providerSecrets === undefined) {
        this.providerAuthStatuses.set(descriptor.providerId, "unknown");
        continue;
      }
      try {
        const present = await this.options.providerSecrets.has(descriptor.providerId);
        this.providerAuthStatuses.set(descriptor.providerId, present ? "authenticated" : "needs-login");
      } catch {
        this.providerAuthStatuses.set(descriptor.providerId, "unknown");
      }
    }
  }

  /** Current inertly-probed auth status for one provider (login watchers poll this). */
  providerAuthStatus(providerId: string): ProviderAuthStatus {
    return this.providerAuthStatuses.get(this.normalizeModelSelection({ providerId }).providerId) ?? "unknown";
  }

  private loginHint(providerId: string): string {
    if (this.options.securityPolicy?.managed === true) return "";
    const descriptor = providerDescriptor(providerId);
    if (descriptor?.connect.oauth === undefined && descriptor?.connect.apiKey !== undefined) {
      return `API key (create one at ${descriptor.connect.apiKey.keyUrl})`;
    }
    // Claude's terminal fallback signs in from inside a sandbox; Codex/OpenAI
    // run the host-side secret OAuth flow.
    if (providerId === CLAUDE_PROVIDER_ID) return "sbx run claude (then /login)";
    const service = descriptor?.connect.sbxService;
    return service === undefined ? "" : `sbx secret set -g ${service} --oauth`;
  }

  /**
   * Refreshes provider catalogs and auth statuses with inert capability
   * discovery (allowed by the threat model) - no prompt or model output ever
   * flows through these calls. Sources, all live: the host Codex app-server's
   * model/list, each rider's registry-described models endpoint, and - for
   * native Claude, whose credential only exists inside sandboxes - any live
   * Claude session's in-runtime probe. `force` (the user's explicit Refresh)
   * bypasses the TTL; failures land in the catalogs as diagnostics instead of
   * being swallowed.
   */
  async refreshHostProviderCatalogs(options?: { readonly force?: boolean; readonly forceAuthProbe?: boolean }): Promise<readonly AgentModelCatalog[]> {
    this.options.securityPolicy?.assertPolicyCurrent();
    if (this.options.securityPolicy?.allowNetworkedAiOnThisMachine === false) {
      return this.listChatProviderCatalogs();
    }
    const now = Date.now();
    const force = options?.force === true;
    const catalogRefreshDue = force || now - this.hostCatalogRefreshedAt >= HOST_CATALOG_TTL_MS;
    // The auth probe is a cheap, inert LOCAL read (`sbx secret ls` + secret-ref
    // existence); an explicit recheck (and the login poller) always runs it.
    // The network-touching model discovery runs on the TTL or a full `force`.
    if (catalogRefreshDue || options?.forceAuthProbe === true) {
      await this.refreshProviderAuthStatuses();
    }
    if (catalogRefreshDue) {
      this.hostCatalogRefreshedAt = now;
      this.options.securityPolicy?.assertNetworkedAiAllowed();
      const discoverRider = this.options.discoverProviderModels
        ?? ((descriptor: ProviderDescriptor) => fetchProviderModelsFromHost(descriptor, {
          ...(this.options.providerSecrets === undefined ? {} : { providerSecrets: this.options.providerSecrets }),
          logger: this.options.logger,
          isoNow: () => this.options.clock.isoNow()
        }));
      const discoveries: Promise<AgentModelCatalog>[] = [
        this.fetchCodexCatalogFromHost(),
        this.fetchClaudeCatalogViaLiveSession(),
        ...PROVIDER_REGISTRY
          .filter((descriptor) => descriptor.discovery !== undefined)
          .map((descriptor) => discoverRider(descriptor))
      ];
      for (const catalog of await Promise.all(discoveries)) {
        this.absorbCatalog(catalog);
      }
    }
    return this.listChatProviderCatalogs();
  }

  private async fetchCodexCatalogFromHost(): Promise<AgentModelCatalog> {
    if (this.options.hostCodexPath === undefined) {
      return this.unavailableCatalog(
        CODEX_PROVIDER_ID,
        "Codex / OpenAI",
        "No host Codex CLI found (native codex.exe; npm shims are not spawnable). Install it or set CODEX_PATH - or start a Codex chat, which discovers models from inside the sandbox."
      );
    }
    try {
      const catalog = await fetchCodexHostModelCatalog({
        codexPath: this.options.hostCodexPath,
        cwd: process.cwd(),
        ...(this.options.environment === undefined ? {} : { environment: this.options.environment }),
        isoNow: () => this.options.clock.isoNow()
      });
      if (catalog.models.length > 0) {
        return { ...catalog, providerId: CODEX_PROVIDER_ID, displayName: "Codex / OpenAI" };
      }
      return this.unavailableCatalog(CODEX_PROVIDER_ID, "Codex / OpenAI", "The host Codex app-server answered without any models.");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.options.logger.warn("host codex model discovery failed", { error: reason });
      return this.unavailableCatalog(CODEX_PROVIDER_ID, "Codex / OpenAI", `Host Codex model discovery failed: ${reason}`);
    }
  }

  /**
   * Native Claude's credential lives only inside sandboxes, so its catalog can
   * be refreshed exclusively through a live Claude session's runtime. With no
   * live session the cached list (if any) stands, with an honest hint.
   */
  private async fetchClaudeCatalogViaLiveSession(): Promise<AgentModelCatalog> {
    const liveIds = this.options.chatService.liveSessionIds(CLAUDE_PROVIDER_ID);
    const sessionId = liveIds[0];
    if (sessionId === undefined) {
      return this.unavailableCatalog(
        CLAUDE_PROVIDER_ID,
        "Claude / Anthropic",
        "Claude models are discovered from inside a running session (the credential never leaves the sandbox). Start a Claude chat to refresh the list."
      );
    }
    try {
      return await this.options.chatService.listModels(sessionId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return this.unavailableCatalog(CLAUDE_PROVIDER_ID, "Claude / Anthropic", `Claude model discovery via the live session failed: ${reason}`);
    }
  }

  private unavailableCatalog(providerId: string, displayName: string, reason: string): AgentModelCatalog {
    return {
      providerId,
      displayName,
      models: [],
      refreshedAt: this.options.clock.isoNow(),
      source: "unavailable",
      diagnostics: [reason]
    };
  }

  isChatSessionLive(sessionId: string): boolean {
    return this.options.chatService.isSessionLive(asId<"SessionId">(sessionId));
  }

  /** Stored session record passthrough for host affordances (memory scope anchors). */
  getChatSession(sessionId: string): Promise<ChatSessionRecord | null> {
    return this.options.chatService.getSession(asId<"SessionId">(sessionId));
  }

  /** This window's host-instance id, stamped onto sessions it owns. */
  get hostInstanceId(): string {
    return this.options.hostInstanceId;
  }

  /**
   * True when `heartbeatAt` is within the staleness window relative to now - i.e.
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

  /**
   * The clipboard-ready trimmed chat log (dialogue + files touched; no
   * commands, reasoning, or host briefing). Works for any stored session -
   * live or ended - because it reads only durable events.
   */
  async buildChatLogExport(sessionId: string): Promise<string> {
    const id = asId<"SessionId">(sessionId);
    const session = await this.options.chatService.getSession(id);
    if (session === null) {
      throw new Error(`Session ${sessionId} was not found.`);
    }
    const events = await this.options.chatService.getTimeline(id);
    return buildChatLog(session, events);
  }

  /**
   * Asks the session's agent for a structured summary of the trimmed chat
   * log, out-of-band via a sidecar connection on its live runtime. The
   * exchange never touches the session transcript. Requires the session to be
   * live in this window; the caller surfaces the error otherwise.
   */
  async generateChatSummary(sessionId: string): Promise<string> {
    this.options.securityPolicy?.assertNetworkedAiAllowed();
    const log = await this.buildChatLogExport(sessionId);
    this.options.securityPolicy?.assertNetworkedAiAllowed();
    return this.options.chatService.runSidecarPrompt(asId<"SessionId">(sessionId), buildSummaryPrompt(log));
  }

  private async refreshModelsForSession(sessionId: SessionId, providerId?: string): Promise<void> {
    try {
      this.options.securityPolicy?.assertNetworkedAiAllowed();
      const catalog = await this.options.chatService.listModels(sessionId);
      this.absorbCatalog({ ...catalog, displayName: catalog.displayName || catalog.providerId });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.options.logger.warn("chat provider model discovery failed", { sessionId, error: reason });
      if (providerId !== undefined) {
        const descriptor = providerDescriptor(providerId);
        this.absorbCatalog(this.unavailableCatalog(
          providerId,
          descriptor?.displayName ?? providerId,
          `Model discovery at session start failed: ${reason}`
        ));
      }
    }
  }

  private assertSupportedModelSelection(model: ChatModelSelection | undefined): void {
    if (model === undefined) return;
    if (!isRegisteredProvider(model.providerId)) {
      const supported = PROVIDER_REGISTRY.map((descriptor) => descriptor.displayName).join(", ");
      throw new Error(`Provider ${model.providerId} is not wired yet. Supported providers: ${supported}.`);
    }
  }

  private normalizeModelSelection(model: ChatModelSelection | undefined): ChatModelSelection {
    if (model === undefined) {
      return { providerId: CODEX_PROVIDER_ID };
    }
    const providerId = model.providerId === LEGACY_CODEX_PROVIDER_ID ? CODEX_PROVIDER_ID : model.providerId;
    return {
      providerId,
      ...(model.model === undefined ? {} : { model: model.model }),
      ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort })
    };
  }

  private acquireRunSlot(): void {
    if (this.runInFlight) {
      throw new Error("An isolated run is already in progress; wait for it to finish.");
    }
    this.runInFlight = true;
  }

  /**
   * Boot timeline reporter for one session (UX overhaul P4). The bus comes
   * through the chat service so no second wiring point is needed; partial test
   * compositions without one simply report nothing.
   */
  private bootStages(sessionId: SessionId): BootStageReporter {
    const chatService: ChatSessionService | undefined = this.options.chatService;
    return new BootStageReporter(chatService?.bus, sessionId);
  }

  private async prepareWorkspace(
    prefix: string,
    workspaceContext?: ChatWorkspaceContext,
    providerId?: string,
    boot?: BootStageReporter
  ): Promise<PreparedWorkspace> {
    this.options.securityPolicy?.assertNetworkedAiAllowed();
    const effectiveContext = this.enforceWorkspacePolicy(workspaceContext);
    // Stage 1: the disposable workspace the sandbox will own.
    boot?.stage("create");
    const workspace = await this.options.workspaceStore.createWorkspace(prefix);
    try {
      await writeFile(path.join(workspace.workspacePath, "README.md"), "# Isolated run disposable workspace\n", "utf8");
      // Stage 2, in its two shapes: clone mode seeds repositories INTO the
      // workspace, everything else resolves live mounts around it.
      boot?.stage(effectiveContext?.mode === "clone" ? "clone" : "mount");
      // Clone mode: each root is git-cloned INTO the workspace, and buildMountPolicy
      // yields NO project-root mounts for clone mode - so the only rw mount is the
      // workspace itself, which now contains the clones. That is the design.
      const clones = effectiveContext?.mode === "clone"
        ? await this.prepareClones(
            workspace,
            effectiveContext.roots,
            effectiveContext.dirtyHandling ?? "carry",
            effectiveContext.seedPatches ?? [],
            this.options.securityPolicy?.cloneOmission
          )
        : [];
      // Ridden providers run inside the image of the CLI they ride, with
      // their own scoped egress replacing the image's native service list.
      const rideKind = providerId === undefined ? "codex" : providerDescriptor(providerId)?.ride ?? "codex";
      const egress = providerId === undefined ? undefined : providerEgressResources(providerId);
      const template = this.withSecurityPolicyMetadata(buildIsolatedRunTemplate({
        workspacePath: workspace.workspacePath,
        ids: this.options.ids,
        approvedAt: this.options.clock.isoNow(),
        provider: rideKind,
        ...(egress === undefined ? {} : { networkResources: egress }),
        ...(effectiveContext === undefined ? {} : {
          projectRoots: effectiveContext.roots,
          sessionMode: effectiveContext.mode,
          ...(effectiveContext.readOnlyRoots === undefined ? {} : { readOnlyRoots: effectiveContext.readOnlyRoots })
        }),
        ...(this.options.deniedPaths === undefined ? {} : { deniedPaths: this.options.deniedPaths })
      }));
      this.options.securityPolicy?.assertNetworkedAiAllowed();
      return {
        workspace,
        template,
        isolation: isolationSummaryFromTemplate(template, workspace.workspacePath),
        clones,
        ...(effectiveContext === undefined ? {} : { workspaceContext: effectiveContext })
      };
    } catch (error) {
      await this.cleanupWorkspaceQuietly(workspace);
      throw error;
    }
  }

  /**
   * Clone-mode workspace preparation. Verifies host git is available, and
   * for each root requires it is a git repo (a non-git root aborts with a clear
   * error rather than silently mounting nothing), then clones the developer's
   * current local HEAD with the chosen dirty-state handling into
   * `<workspace>/repos/<basename>` as the sync base. Returns the resolved clone
   * list the caller stashes per session id.
   */
  private async prepareClones(
    workspace: TempWorkspace,
    roots: readonly string[],
    dirtyHandling: "carry" | "fresh",
    seedPatches: readonly WorkspaceSeedPatch[] = [],
    omission?: ClonePathOmission
  ): Promise<SessionCloneRepo[]> {
    const git = await this.options.cloneSync.detectGit();
    if (!git.available) {
      throw new Error(this.options.securityPolicy?.managed === true
        ? "Clone mode requires an approved Git installation. Ask your administrator to install Git in the standard machine location, then reload the window."
        : "Clone mode requires git on the host PATH, but `git --version` failed. Install git (or fix PATH) and reload the window.");
    }
    const cloneParentDir = path.join(workspace.workspacePath, "repos");
    const gitMetadataParentDir = path.join(workspace.root, "git");
    const clones: SessionCloneRepo[] = [];
    const usedNames = new Set<string>();
    for (const root of roots) {
      const preflight = await this.options.cloneSync.preflightRepo(root);
      if (!preflight.isGitRepo) {
        throw new Error(`Clone mode requires git repositories; "${root}" is not one.`);
      }
      // Two workspace-set members can legitimately share a basename (for
      // example client-a/api and client-b/api). Keep each clone addressable
      // instead of letting the second `git clone` collide with repos/api.
      const baseName = path.basename(preflight.localRepoPath) || "repo";
      let name = baseName;
      let suffix = 2;
      while (usedNames.has(name.toLowerCase())) {
        name = `${baseName}-${String(suffix)}`;
        suffix += 1;
      }
      usedNames.add(name.toLowerCase());
      // Upstream changeset seeds (ADR 0014) match clones by the same deduped
      // name derivation, so an upstream capture from the same policy lands in
      // the same-named clone here. A conflicting seed throws out of initClone
      // (honest failed start), naming the upstream it came from.
      const seedsForRepo = seedPatches
        .filter((seed) => seed.repoName === name)
        .map((seed) => ({ label: seed.label, patch: seed.patch }));
      const result = await this.options.cloneSync.initClone({
        localRepoPath: preflight.localRepoPath,
        cloneParentDir,
        gitMetadataParentDir,
        name,
        dirtyHandling,
        ...(omission === undefined ? {} : { omission }),
        ...(seedsForRepo.length === 0 ? {} : { seedPatches: seedsForRepo })
      });
      clones.push({
        name,
        clonePath: result.clonePath,
        localRepoPath: preflight.localRepoPath,
        branch: result.branch,
        ...(omission === undefined ? {} : { omission })
      });
    }
    return clones;
  }

  private enforceWorkspacePolicy(context: ChatWorkspaceContext | undefined): ChatWorkspaceContext | undefined {
    if (context === undefined) return undefined;
    const roots = context.roots.map((root) => this.assertWorkspaceRootAllowed(root));
    const readOnlyRoots = context.readOnlyRoots?.map((root) => this.assertWorkspaceRootAllowed(root));
    const mode = this.options.securityPolicy?.cloneOnly === true && roots.length > 0 ? "clone" : context.mode;
    if (mode !== context.mode) {
      this.options.logger.info("workspace mode tightened by security policy", { requested: context.mode, effective: mode });
    }
    return {
      ...context,
      mode,
      roots,
      ...(readOnlyRoots === undefined ? {} : { readOnlyRoots })
    };
  }

  private assertStoredSessionAllowed(
    session: ChatSessionRecord,
    additionalRoots?: { readonly roots: readonly string[]; readonly readOnlyRoots: readonly string[] }
  ): void {
    this.options.securityPolicy?.assertNetworkedAiAllowed();
    if (
      this.options.securityPolicy?.cloneOnly === true
      && session.mode !== "clone"
      && (session.workspaceRoots?.length ?? 0) > 0
    ) {
      throw new Error("This older session used live project mounts and cannot be resumed under clone-only policy. Start a new chat; its project context will be cloned automatically.");
    }
    for (const root of [
      ...(session.workspaceRoots ?? []),
      ...(additionalRoots?.roots ?? []),
      ...(additionalRoots?.readOnlyRoots ?? [])
    ]) {
      this.assertWorkspaceRootAllowed(root);
    }
  }

  private assertWorkspaceRootAllowed(root: string): string {
    if (this.options.securityPolicy !== undefined) {
      return this.options.securityPolicy.assertHostPathAllowed(root);
    }
    assertMountAllowed(root, this.options.deniedPaths ?? []);
    return normalizeHostPath(root);
  }

  /** Adds compact, content-free policy evidence to the durable runtime ledger. */
  private withSecurityPolicyMetadata(template: RuntimeTemplate): RuntimeTemplate {
    const policy = this.options.securityPolicy;
    if (policy === undefined) return template;
    const omissionsEnabled = policy.cloneOmission.sensitive || policy.cloneOmission.paths.length > 0;
    return {
      ...template,
      advancedOptions: {
        ...template.advancedOptions,
        securityPolicy: {
          id: policy.policyId ?? "personal",
          managed: policy.managed,
          cloneOnly: policy.cloneOnly,
          omissionsEnabled,
          networkedAiAllowed: policy.allowNetworkedAiOnThisMachine,
          ...(policy.allowedProjectRoots === undefined ? {} : { allowedRootCount: policy.allowedProjectRoots.length })
        }
      }
    };
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
    // Report the template's actual kind, not a hardcoded literal: the isolation
    // card must state the real containment model (a hyperv validation runtime is
    // not a docker sandbox).
    runtimeKind: template.type,
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
 * it can parse, empty on any failure - callers then report the sandbox as
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
  // First prompts arrive with the host briefing prepended; titles must derive
  // from the USER's words ("[host briefing]Mode: IMPLEMENTATION…" is not a title).
  const cleaned = stripHostBriefing(prompt).trim() || prompt.trim();
  return cleaned.length > CHAT_TITLE_MAX ? `${cleaned.slice(0, CHAT_TITLE_MAX)}…` : cleaned;
}

/**
 * Restores a session's immutable workspace boundary. Persisted roots win over
 * a caller hint, and a saved plan/clone mode can never be widened to live
 * implementation access during resume.
 */
export function resolveResumeWorkspaceContext(
  stored: ChatSessionRecord,
  requested?: ChatWorkspaceContext
): ChatWorkspaceContext | undefined {
  if (requested !== undefined && stored.mode !== undefined && requested.mode !== stored.mode) {
    throw new Error(`Session ${stored.sessionId} is ${stored.mode} mode and cannot be resumed as ${requested.mode} mode.`);
  }
  if (stored.workspaceRoots === undefined || stored.workspaceRoots.length === 0) {
    return requested;
  }
  return {
    mode: stored.mode ?? "implementation",
    roots: stored.workspaceRoots,
    ...(stored.readOnlyRoots === undefined ? {} : { readOnlyRoots: stored.readOnlyRoots }),
    ...(stored.mode === "clone" ? { dirtyHandling: stored.cloneDirtyHandling ?? "carry" } : {})
  };
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
    ...(readOnlyRoots.length === 0 ? {} : { readOnlyRoots }),
    ...(base?.dirtyHandling === undefined ? {} : { dirtyHandling: base.dirtyHandling })
  };
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

function transportForProvider(providerId: string): AgentTransport {
  return providerTransport(providerId);
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

function isFinalTextEvent(value: unknown): value is { readonly type: "agent.text"; readonly final: boolean } {
  return typeof value === "object" &&
    value !== null &&
    (value as { readonly type?: unknown }).type === "agent.text" &&
    typeof (value as { readonly final?: unknown }).final === "boolean";
}
