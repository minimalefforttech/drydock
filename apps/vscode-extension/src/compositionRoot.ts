/**
 * Composition root for the extension's backend services.
 *
 * Wiring is typed against ports where they exist so adapters stay swappable.
 * Missing host tooling (no `sbx`) produces a degraded-but-alive backend value
 * instead of throwing: activation must always succeed so the command surface
 * and the control panel can render an actionable "not available" state.
 */

import { execFile as execFileCb } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, realpathSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClaudeAdapter, CodexAdapter, CodexAppServerTransport } from "@drydock/agent-adapters";
import { asId, type AgentAdapter } from "@drydock/contracts";
import { ContentAddressedBlobStore, TempWorkspaceStore } from "@drydock/artifacts";
import type { ChatSessionStore, EventStore, RuntimeInventoryStore, SecurityEventInput, SecurityEventStore } from "@drydock/contracts";
import {
  AccessRequestService,
  AgentQuestionService,
  ChatSessionService,
  CloneSyncService,
  CodeReviewService,
  extractAgentQuestions,
  extractPreviewAnnouncements,
  extractMemoryCandidates,
  mergeTagRules,
  ProductEventBus,
  RandomIdGenerator,
  normalizePathKey,
  parseHandoffNote,
  RuntimeCleanupService,
  RuntimeLifecycleService,
  RuntimeReconcileService,
  SessionDiffService,
  SessionRawStreamStore,
  SpawnCommandRunner,
  IsolatedRunWorkflow,
  SystemClock,
  type Logger
} from "@drydock/core";
import {
  discoverDockerSandboxCommand,
  discoverStandaloneCodexCommand,
  DockerSandboxRuntimeAdapter
} from "@drydock/runtime-adapters";
import {
  applyMigrations,
  SqliteAccessRequestStore,
  SqliteAgentQuestionStore,
  SqliteBoardColumnStore,
  SqliteChatSessionStore,
  SqliteConnection,
  SqliteDiffBaselineStore,
  SqliteEventStore,
  SqliteMemoryCandidateStore,
  SqlitePlanAnnotationStore,
  SqlitePlanArtifactStore,
  SqlitePlanAspectStore,
  SqlitePlanStore,
  SqliteProjectCatalogStore,
  SqliteReviewStore,
  SqliteRuntimeInventoryStore,
  SqlitePreferenceStore,
  SqliteSecurityEventStore,
  SqliteSubtaskHandoffStore,
  SqliteSubtaskHoldStore,
  SqliteSubtaskStore,
  SqliteTaskChangesetStore,
  SqliteTaskFaqStore,
  SqliteTaskRecipeStore,
  SqliteMcpServerStore,
  SqliteWorkSessionStore,
  SqliteWorkspaceSetStore,
  SqliteWorkTaskStore
} from "@drydock/storage-sqlite";
import { BoardService, ChangesetService, importServersFromConfigJson, McpRegistryService, MemoryService, PreferencesService, ProjectCatalogService, RecipeService, SubtaskOrchestrator, SubtaskService, TaskService, WorkspaceSetService } from "@drydock/work-management";
import { PlannerAppService } from "./services/plannerAppService.js";
import { InspectionService } from "./services/inspectionService.js";
import { IsolatedRunService } from "./services/isolatedRunService.js";
import { createSubtaskRunBridge } from "./services/subtaskRunBridge.js";
import type { EffectiveSecurityPolicy } from "./services/securityPolicy.js";
import { TaskReviewAppService } from "./services/taskReviewAppService.js";
import { TaskFaqAutoAnswerCoordinator } from "./services/taskFaqAutoAnswer.js";
import { WorkInsightsAppService } from "./services/workInsightsAppService.js";
import { WorkspaceReviewAppService } from "./services/workspaceReviewAppService.js";

export interface BackendReady {
  readonly available: true;
  readonly appService: IsolatedRunService;
  readonly workspaceReview: WorkspaceReviewAppService;
  readonly planner: PlannerAppService;
  readonly taskReview: TaskReviewAppService;
  readonly tasks: TaskService;
  readonly board: BoardService;
  readonly subtasks: SubtaskService;
  readonly orchestrator: SubtaskOrchestrator;
  /** Chain changesets (ADR 0014): capture/query/land bookkeeping. */
  readonly changesets: ChangesetService;
  /** Inspection workspaces (plan D6): materialize finished work for a human to step into. */
  readonly inspection: InspectionService;
  /** Product preferences (plan D10): the workflow-defaults rung of the config ladder. */
  readonly preferences: PreferencesService;
  /** Host git plumbing (clone/sync/land/inspect verbs) for panel-level flows. */
  readonly cloneSync: CloneSyncService;
  /** Durable project catalog (remote picks register here with origin metadata). */
  readonly projectCatalog: ProjectCatalogService;
  /** Task recipes (ADR 0007): templates that materialize task + subtask DAGs. */
  readonly recipes: RecipeService;
  readonly questions: AgentQuestionService;
  readonly memory: MemoryService;
  /** MCP registry: definitions + tri-state overrides (design doc). */
  readonly mcp: McpRegistryService;
  /** Merged glob->tag rule table (defaults + drydock.memory.tagRules). */
  readonly tagRules: readonly import("@drydock/core").TagRule[];
  readonly workInsights: WorkInsightsAppService;
  readonly bus: ProductEventBus;
  /** Content-free, append-only security evidence with JSONL export. */
  readonly securityEvents: SecurityEventStore;
  /** Debug-only per-session capture of the current turn's raw agent stream. */
  readonly rawStreamStore: SessionRawStreamStore;
  /** Session + inventory reconciliation, run once after activation. */
  readonly reconcileOnActivate: () => Promise<void>;
  readonly sbxDisplayPath: string;
  readonly stateRootPath: string;
  dispose(): void;
}

export interface BackendUnavailable {
  readonly available: false;
  readonly reason: string;
  readonly stateRootPath: string;
  dispose(): void;
}

export type Backend = BackendReady | BackendUnavailable;

export interface CreateBackendOptions {
  readonly stateRootPath: string;
  readonly logger: Logger;
  /** Private environment inherited only by Drydock-owned child processes. */
  readonly runtimeEnvironment?: NodeJS.ProcessEnv;
  /** Paths excluded from mounts, snapshots, and diffs (drydock.deniedPaths). */
  readonly deniedPaths?: readonly string[];
  /** One immutable activation-time snapshot of Studio + personal restrictions. */
  readonly securityPolicy?: EffectiveSecurityPolicy;
  /** Invalid managed policy fails closed while keeping the extension UI alive. */
  readonly startupBlockReason?: string;
  /** Codex app-server stall watchdog window in ms (drydock.runtime.appServerInactivityTimeoutMs). */
  readonly appServerInactivityTimeoutMs?: number;
  /** Repo aspect packs merged read-only into the planner registry (ADR 0012). */
  readonly plannerAspectOverlays?: () => Promise<readonly import("@drydock/contracts").PlanAspectRecord[]>;
  /** Repo recipe packs merged read-only into the recipe registry (ADR 0007). */
  readonly recipeOverlays?: () => Promise<readonly import("@drydock/contracts").TaskRecipeRecord[]>;
  /** ADR 0015: live run-slot budget (drydock.orchestrator.maxConcurrentRuns; host derives the auto default). */
  readonly maxConcurrentRuns?: () => number;
  /** Background sub-budget (drydock.orchestrator.maxBackgroundRuns; host derives auto = half the slots). */
  readonly maxBackgroundRuns?: () => number;
  /** ADR 0007: the global gate for task-FAQ question auto-answering. */
  readonly autoAnswerQuestionsEnabled?: () => boolean;
  /** ADR 0017: studio-registered prototype themes (drydock.prototypeThemes). */
  readonly prototypeThemes?: readonly { readonly name: string; readonly css: string }[];
  /** Validated MCP config JSON (drydock.mcp.configPath) for /workspace/.mcp.json. */
  readonly mcpConfigJson?: string;
  /** Studio-level standing instructions (drydock.teamInstructionsPath). */
  readonly teamInstructions?: string;
  /** Raw drydock.memory.tagRules setting value; merged onto the shipped defaults. */
  readonly memoryTagRules?: unknown;
}

/**
 * Ensures the runtime tool directories are on the extension host's PATH before
 * any `sbx` call. A GUI-launched VS Code inherits a login-time PATH that often
 * omits Docker Desktop's `resources\bin` - where the Docker credential helper
 * (`docker-credential-desktop`) lives that `sbx` shells out to for its session
 * token. Without the helper on PATH, `sbx create` fails auth with
 * "secret not found / not authenticated to Docker", even though the identical
 * command works in a terminal (whose PATH does include that dir). Prepends the
 * sbx binary's own dir plus the known Docker Desktop bin locations; each is
 * added only if it exists and is not already present.
 */
function ensureRuntimeToolsOnPath(
  sbxPath: string,
  environment: NodeJS.ProcessEnv,
  logger: Logger,
  managed: boolean,
  userHome: string
): void {
  const programFiles = managed ? "C:\\Program Files" : (environment["ProgramFiles"] ?? "C:\\Program Files");
  const candidates = process.platform === "win32"
    ? [
        path.dirname(sbxPath),
        "C:\\Windows\\System32",
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
        "C:\\Windows",
        ...(managed ? [] : [path.join(userHome, "AppData", "Local", "DockerSandboxes", "bin")]),
        path.join(programFiles, "Docker", "Docker", "resources", "bin"),
        path.join(programFiles, "Git", "cmd")
      ]
    : process.platform === "darwin"
      ? [
          path.dirname(sbxPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin",
          ...(managed ? [] : ["/usr/local/bin", "/opt/homebrew/bin"])
        ]
      : [path.dirname(sbxPath), "/usr/bin", "/bin", ...(managed ? [] : ["/usr/local/bin"])];
  const available = candidates.filter((dir, index) => {
    if (!path.isAbsolute(dir) || candidates.findIndex((candidate) => normalizePathKey(candidate) === normalizePathKey(dir)) !== index) {
      return false;
    }
    try {
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
  if (managed) {
    environment["PATH"] = available.join(path.delimiter);
    if (process.platform === "win32") environment["PATHEXT"] = ".EXE;.COM";
    logger.info("set restricted PATH for managed runtime tools", { directories: available });
    return;
  }
  const existing = (environment["PATH"] ?? "").split(path.delimiter);
  const additions = available.filter((dir) => !existing.includes(dir));
  if (additions.length > 0) {
    environment["PATH"] = [...additions, ...existing].join(path.delimiter);
    logger.info("augmented PATH for runtime tools", { added: additions });
  }
}

/** Managed mode accepts only the product's expected installation locations. */
function discoverManagedDockerSandboxCommand(): string | null {
  const candidates = process.platform === "win32"
    ? [
        "C:\\Program Files\\Drydock\\bin\\sbx.exe",
        "C:\\Program Files\\Docker\\Docker\\resources\\bin\\sbx.exe"
      ]
    : process.platform === "darwin"
      ? ["/Applications/Docker.app/Contents/Resources/bin/sbx"]
      : ["/usr/bin/sbx"];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return realpathSync.native(candidate);
    } catch {
      // Continue to the next fixed install location.
    }
  }
  return null;
}

/** Resolves Git before any agent-writable repository becomes a process cwd. */
function discoverHostGitCommand(environment: NodeJS.ProcessEnv, managed: boolean): string | null {
  const programFiles = managed ? "C:\\Program Files" : (environment["ProgramFiles"] ?? "C:\\Program Files");
  const preferred = process.platform === "win32"
    ? [path.join(programFiles, "Git", "cmd", "git.exe"), path.join(programFiles, "Git", "bin", "git.exe")]
    : process.platform === "darwin"
      ? ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"]
      : ["/usr/bin/git", "/usr/local/bin/git"];
  const names = process.platform === "win32" ? ["git.exe"] : ["git"];
  const fromPath = managed
    ? []
    : (environment["PATH"] ?? "")
        .split(path.delimiter)
        .map((entry) => entry.replace(/^"|"$/g, ""))
        .filter((entry) => path.isAbsolute(entry))
        .flatMap((entry) => names.map((name) => path.join(entry, name)));
  for (const candidate of [...preferred, ...fromPath]) {
    try {
      if (statSync(candidate).isFile()) return realpathSync.native(candidate);
    } catch {
      // Continue to the next fixed/absolute candidate.
    }
  }
  return null;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(directory, 0o700);
}

function setEnvironmentKey(environment: NodeJS.ProcessEnv, name: string, value: string): void {
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() === name.toUpperCase()) delete environment[key];
  }
  environment[name] = value;
}

export async function createBackend(options: CreateBackendOptions): Promise<Backend> {
  const { stateRootPath, logger } = options;
  const deniedPaths = options.deniedPaths ?? [];
  if (options.startupBlockReason !== undefined) {
    return {
      available: false,
      reason: options.startupBlockReason,
      stateRootPath,
      dispose: () => { /* policy prevented composition */ }
    };
  }
  const runtimeEnvironment = options.runtimeEnvironment ?? { ...process.env };
  const managed = options.securityPolicy?.managed === true;
  const userHome = managed ? os.userInfo().homedir : os.homedir();
  const discoveredSbxPath = managed
    ? discoverManagedDockerSandboxCommand()
    : discoverDockerSandboxCommand(runtimeEnvironment);
  const sbxPath = discoveredSbxPath !== null
    && (!managed || path.isAbsolute(discoveredSbxPath))
    ? discoveredSbxPath
    : null;
  if (!sbxPath) {
    return {
      available: false,
      reason: managed
        ? "An approved Docker Sandbox installation was not found. Ask your administrator to install it in the standard location, then reload the window."
        : "Docker Sandbox `sbx` was not found. Install Docker Sandbox (or set SBX_PATH to sbx.exe) and reload the window.",
      stateRootPath,
      dispose: () => { /* nothing composed */ }
    };
  }
  ensureRuntimeToolsOnPath(sbxPath, runtimeEnvironment, logger, managed, userHome);

  const stateDir = path.join(stateRootPath, "state");
  const tmpDir = path.join(stateRootPath, "tmp");
  await ensurePrivateDirectory(stateRootPath);
  await ensurePrivateDirectory(stateDir);
  await ensurePrivateDirectory(tmpDir);
  if (managed) {
    setEnvironmentKey(runtimeEnvironment, "TEMP", tmpDir);
    setEnvironmentKey(runtimeEnvironment, "TMP", tmpDir);
    setEnvironmentKey(runtimeEnvironment, "TMPDIR", tmpDir);
  }

  const ids = new RandomIdGenerator();
  const clock = new SystemClock();
  const commandRunner = new SpawnCommandRunner(runtimeEnvironment);
  const connection = new SqliteConnection(path.join(stateDir, "state.sqlite"));
  applyMigrations(connection);
  const securityEvents: SecurityEventStore = new SqliteSecurityEventStore(connection);
  const inventory: RuntimeInventoryStore = new SqliteRuntimeInventoryStore(connection);
  const eventStore: EventStore = new SqliteEventStore(connection);
  const sessionStore: ChatSessionStore = new SqliteChatSessionStore(connection);
  const bus = new ProductEventBus();
  const actorId = os.userInfo().username;
  const hostId = os.hostname();
  const appendSecurityEvent = (
    event: Omit<SecurityEventInput, "occurredAt" | "actorId" | "hostId" | "policyId">
  ): void => {
    void securityEvents.appendSecurityEvent({
      ...event,
      occurredAt: clock.isoNow(),
      actorId,
      hostId,
      ...(options.securityPolicy?.policyId === undefined ? {} : { policyId: options.securityPolicy.policyId })
    }).catch((error: unknown) => {
      logger.warn("security evidence write failed", {
        eventCode: event.eventCode,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  };
  appendSecurityEvent({
    eventCode: "policy.loaded",
    outcome: "succeeded",
    metadata: {
      managed: options.securityPolicy?.managed === true,
      cloneOnly: options.securityPolicy?.cloneOnly === true,
      networkedAiAllowed: options.securityPolicy?.allowNetworkedAiOnThisMachine !== false,
      ...(options.securityPolicy?.allowedProjectRoots === undefined
        ? {}
        : { allowedRootCount: options.securityPolicy.allowedProjectRoots.length }),
      ...(options.securityPolicy?.policyFingerprint === undefined
        ? {}
        : { policyFingerprint: options.securityPolicy.policyFingerprint })
    }
  });
  const lastSessionStatus = new Map<string, string>();
  const stopSecurityEvidence = bus.subscribe((event) => {
    switch (event.kind) {
      case "turn-started":
        appendSecurityEvent({
          eventCode: "runtime.turn.started",
          outcome: "succeeded",
          sessionId: event.sessionId,
          metadata: { runId: event.runId }
        });
        break;
      case "turn-completed":
        appendSecurityEvent({
          eventCode: "runtime.turn.completed",
          outcome: event.status === "completed" ? "succeeded" : "failed",
          sessionId: event.sessionId,
          metadata: { runId: event.runId, status: event.status }
        });
        break;
      case "session-updated": {
        const previous = lastSessionStatus.get(event.session.sessionId);
        if (previous === event.session.status) break;
        lastSessionStatus.set(event.session.sessionId, event.session.status);
        appendSecurityEvent({
          eventCode: "runtime.session.status",
          outcome: event.session.status === "failed" ? "failed" : "succeeded",
          sessionId: event.session.sessionId,
          ...(event.session.runtimeId === undefined ? {} : { runtimeId: event.session.runtimeId }),
          metadata: { status: event.session.status, mode: event.session.mode ?? "mount" }
        });
        break;
      }
      case "session-deleted":
        lastSessionStatus.delete(event.sessionId);
        appendSecurityEvent({
          eventCode: "runtime.session.deleted",
          outcome: "succeeded",
          sessionId: event.sessionId
        });
        break;
      case "access-requested":
        appendSecurityEvent({
          eventCode: "access.requested",
          outcome: "succeeded",
          sessionId: event.request.sessionId,
          metadata: {
            accessRequestId: event.request.accessRequestId,
            mode: event.request.mode
          }
        });
        break;
      case "access-resolved":
        appendSecurityEvent({
          eventCode: "access.resolved",
          outcome: event.request.status === "approved" ? "allowed" : "denied",
          sessionId: event.request.sessionId,
          metadata: {
            accessRequestId: event.request.accessRequestId,
            mode: event.request.mode,
            status: event.request.status
          }
        });
        break;
      default:
        break;
    }
  });
  // Work-session touch history and agent memory candidates. Constructed early
  // so the app service can inject approved memory into the first briefing of
  // each session.
  const workSessionStore = new SqliteWorkSessionStore(connection);
  const memory = new MemoryService({ ids, clock, store: new SqliteMemoryCandidateStore(connection) });
  const tagRules = mergeTagRules(options.memoryTagRules);
  // MCP registry: sqlite-defined servers plus read-only rows imported from the
  // legacy drydock.mcp.configPath file (tagged "from settings").
  const mcpImported = options.mcpConfigJson === undefined ? [] : importServersFromConfigJson(options.mcpConfigJson, clock.isoNow());
  const mcp = new McpRegistryService({ clock, store: new SqliteMcpServerStore(connection), importedServers: mcpImported });
  const runtimeAdapter = new DockerSandboxRuntimeAdapter({
    sbxPath,
    commandRunner,
    cwd: stateRootPath,
    logger
  });
  const lifecycle = new RuntimeLifecycleService({
    clock,
    inventory,
    runtimeAdapter,
    logger,
    ...(options.securityPolicy === undefined
      ? {}
      : {
          authorizeStart: (request: import("@drydock/contracts").StartRuntimeRequest) => {
            options.securityPolicy?.assertNetworkedAiAllowed();
            for (const mount of request.template.mounts) {
              if (mount.approvedBy === "isolated-run") continue;
              const canonical = options.securityPolicy?.assertHostPathAllowed(mount.hostPath) ?? mount.hostPath;
              if (normalizePathKey(canonical) !== normalizePathKey(mount.hostPath)) {
                throw new Error("A selected project path changed after approval. Re-select it before starting the runtime.");
              }
            }
          }
        })
  });
  const cleanup = new RuntimeCleanupService({ clock, inventory, runtimeAdapter, logger });
  const hostCodexPath = managed ? null : discoverStandaloneCodexCommand(runtimeEnvironment);
  // Debug-only capture of the current turn's raw agent stream, read on demand by
  // the chat tab's raw view. Bounded + last-turn-only, so it scales to many sessions.
  const rawStreamStore = new SessionRawStreamStore(clock);
  const adapterOptions = {
    ids,
    clock,
    logger,
    runtimeExecutor: runtimeAdapter,
    commandRunner,
    appServer: {
      command: sbxPath,
      argsForRuntime: (handle: { readonly externalName: string }) => ["exec", handle.externalName],
      cwd: stateRootPath,
      environment: runtimeEnvironment,
      ...(options.securityPolicy === undefined
        ? {}
        : { authorizePrompt: () => options.securityPolicy?.assertNetworkedAiAllowed() }),
      rawSink: rawStreamStore,
      ...(options.appServerInactivityTimeoutMs === undefined ? {} : { inactivityTimeoutMs: options.appServerInactivityTimeoutMs })
    }
  };
  const agent = new CodexAdapter(hostCodexPath === null ? adapterOptions : { ...adapterOptions, hostCodexPath });
  const claudeAgent = new ClaudeAdapter({ ids, clock, logger, runtimeExecutor: runtimeAdapter, rawSink: rawStreamStore });
  const agentAdapters: ReadonlyMap<string, AgentAdapter> = new Map<string, AgentAdapter>([
    [agent.providerId, agent],
    [claudeAgent.providerId, claudeAgent]
  ]);
  const workflow = new IsolatedRunWorkflow({
    ids,
    logger,
    lifecycle,
    cleanup,
    agentAdapter: agent,
    eventStore,
    ...(options.securityPolicy === undefined
      ? {}
      : { authorizePrompt: () => options.securityPolicy?.assertNetworkedAiAllowed() })
  });
  // One identity per activation: stamped onto every session this window
  // owns so a sibling window can tell our fresh heartbeats from its own.
  const hostInstanceId = randomUUID();
  const chatService = new ChatSessionService({
    ids,
    clock,
    logger,
    lifecycle,
    cleanup,
    agentAdapters,
    eventStore,
    sessionStore,
    inventory,
    bus,
    hostInstanceId,
    ...(options.securityPolicy === undefined
      ? {}
      : { validateTurn: () => options.securityPolicy?.assertNetworkedAiAllowed() }),
    validateRuntimeAdoption: () => {
      options.securityPolicy?.assertPolicyCurrent();
      throw new Error(
        "Surviving runtime adoption is disabled. Resume the chat to start a fresh runtime under current access rules."
      );
    }
  });
  const runtimeReconcile = new RuntimeReconcileService({ clock, inventory, runtimeAdapter, logger });
  // Clone mode: host-side git plumbing (clone/status/inbound/outbound/discard)
  // over the shared CommandRunner. No docker, no network - pure host git.
  const gitPath = discoverHostGitCommand(runtimeEnvironment, options.securityPolicy?.managed === true)
    ?? (managed
      ? process.platform === "win32"
        ? "C:\\Program Files\\Drydock\\unavailable-git.exe"
        : "/nonexistent/drydock/git"
      : path.join(stateRootPath, "unavailable", process.platform === "win32" ? "git.exe" : "git"));
  const cloneSync = new CloneSyncService({
    runner: commandRunner,
    gitPath,
    environment: runtimeEnvironment,
    temporaryDirectory: tmpDir,
    ...(options.securityPolicy === undefined
      ? {}
      : { authorizeHostPath: (candidate: string) => options.securityPolicy?.assertHostPathAllowed(candidate) ?? candidate })
  });
  const workspaceStore = new TempWorkspaceStore(tmpDir);
  const prober = new CodexAppServerTransport({
    command: sbxPath,
    argsForRuntime: (handle) => ["exec", handle.externalName],
    cwd: stateRootPath,
    environment: runtimeEnvironment,
    ...(options.securityPolicy === undefined
      ? {}
      : { authorizePrompt: () => options.securityPolicy?.assertNetworkedAiAllowed() })
  });
  const appService = new IsolatedRunService({
    ids,
    clock,
    logger,
    workspaceStore,
    workflow,
    lifecycle,
    cleanup,
    inventory,
    prober,
    chatService,
    runtimeExecutor: runtimeAdapter,
    ...(options.prototypeThemes === undefined ? {} : { userPrototypeThemes: options.prototypeThemes }),
    ...(options.mcpConfigJson === undefined ? {} : { mcpConfigJson: options.mcpConfigJson }),
    ...(options.teamInstructions === undefined ? {} : { teamInstructions: options.teamInstructions }),
    cloneSync,
    hostInstanceId,
    memoryService: memory,
    tagRules,
    mcpRegistry: mcp,
    // Closures over services declared below (invoked long after composition).
    sessionTaskIds: async (sessionId: string) =>
      (await workTaskStore.listLinks())
        .filter((link) => link.sessionId === sessionId)
        .map((link) => link.taskId as string),
    workspaceSetRefs: async () => {
      const sets = await workspaceSets.listWorkspaceSets();
      const refs: { workspaceSetId: string; roots: readonly string[] }[] = [];
      for (const set of sets) {
        try {
          refs.push({ workspaceSetId: set.workspaceSetId, roots: await workspaceSets.resolveMountRoots(set.workspaceSetId) });
        } catch {
          // A set with missing catalog entries simply cannot match a session.
        }
      }
      return refs;
    },
    deniedPaths,
    ...(options.securityPolicy === undefined ? {} : { securityPolicy: options.securityPolicy }),
    sbxPath,
    commandRunner,
    environment: runtimeEnvironment,
    ...(hostCodexPath === null ? {} : { hostCodexPath })
  });

  // Workspace policy and diff review.
  const projectCatalogStore = new SqliteProjectCatalogStore(connection);
  const projectCatalog = new ProjectCatalogService({
    ids,
    clock,
    store: projectCatalogStore,
    ...(options.securityPolicy === undefined
      ? {}
      : { validateProjectPath: (candidate: string) => options.securityPolicy?.assertHostPathAllowed(candidate) ?? candidate })
  });
  const workspaceSetStore = new SqliteWorkspaceSetStore(connection);
  const workspaceSets = new WorkspaceSetService({
    ids,
    clock,
    catalog: projectCatalogStore,
    store: workspaceSetStore
  });
  const accessRequests = new AccessRequestService({
    ids,
    clock,
    store: new SqliteAccessRequestStore(connection),
    deniedPaths,
    ...(options.securityPolicy === undefined
      ? {}
      : { validateHostPath: (candidate: string) => options.securityPolicy?.assertHostPathAllowed(candidate) ?? candidate })
  });
  // Agent questions (attention stack): same protocol family as access requests.
  // The bus announces resolutions so cross-surface pending sets stay live.
  const questions = new AgentQuestionService({ ids, clock, store: new SqliteAgentQuestionStore(connection), bus });
  // Task board and subtasks: board columns are global, seeded with six
  // defaults by the migration; subtasks are child work items of exactly one
  // task. Both share the same connection as every other store.
  const workTaskStore = new SqliteWorkTaskStore(connection);
  const boardColumnStore = new SqliteBoardColumnStore(connection);
  const subtaskStore = new SqliteSubtaskStore(connection);
  const board = new BoardService({ ids, store: boardColumnStore, tasks: workTaskStore, subtasks: subtaskStore });
  // The bus lets moveCard announce "card-entered-done" (cascade trigger) and
  // board mutations announce "board-changed" for the panel to re-fetch.
  const subtasks = new SubtaskService({ ids, clock, store: subtaskStore, tasks: workTaskStore, columns: boardColumnStore, bus });
  // Internal work tasks (chat-panel redesign, Phase 2). Shares the same
  // ids/clock/connection as every other service so ids stay uniform and links
  // reference live workspace-set and session rows. The work-session store
  // powers touch history and each task's lastWorkedAt; the subtask store
  // powers cascading subtask deletion when a task is deleted.
  const taskFaqStore = new SqliteTaskFaqStore(connection);
  const tasks = new TaskService({
    ids,
    clock,
    store: workTaskStore,
    columns: boardColumnStore,
    workSessions: workSessionStore,
    subtasks: subtaskStore,
    workspaceSets: workspaceSetStore,
    bus,
    faqs: taskFaqStore
  });
  const workInsights = new WorkInsightsAppService({ workSessions: workSessionStore, tasks, chatService, workspaceSets });
  const diff = new SessionDiffService({
    ids,
    clock,
    logger,
    store: new SqliteDiffBaselineStore(connection),
    blobs: new ContentAddressedBlobStore(path.join(stateRootPath, "artifacts", "blobs")),
    deniedPaths,
    // Gitignore oracle: `git check-ignore --stdin -z` per root, so baselines
    // and diffs never report ignored churn (.pyc, caches, build output).
    // Exit 1 (nothing ignored), a non-git root, or a missing git all resolve
    // to "filter nothing" - the diff stays honest rather than failing.
    gitIgnoreFilter: (rootPath, relativePaths) => new Promise((resolve) => {
      const child = execFileCb(
        "git",
        ["check-ignore", "--stdin", "-z"],
        { cwd: rootPath, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (_error, stdout) => {
          const text = typeof stdout === "string" ? stdout : String(stdout ?? "");
          resolve(new Set(text.split("\0").filter((entry) => entry.length > 0)));
        }
      );
      child.on("error", () => resolve(new Set()));
      child.stdin?.on("error", () => { /* git exited early; the callback still resolves */ });
      child.stdin?.end(relativePaths.join("\0") + "\0");
    })
  });
  const review = new CodeReviewService({ ids, clock, store: new SqliteReviewStore(connection) });
  const workspaceReview = new WorkspaceReviewAppService({
    logger,
    projectCatalog,
    workspaceSets,
    accessRequests,
    diff,
    review,
    chatService,
    bus,
    // agent.file_edit replay scopes session diffs to files the agent touched.
    events: eventStore,
    ...(options.securityPolicy === undefined ? {} : { securityPolicy: options.securityPolicy })
  });
  // Cross-project task review: a VIEW over the task's linked sessions -
  // aggregates their changed files (baseline diffs + clone sync state) and
  // routes the reviewer's comments back as revision turns. It reads only
  // projections and satisfies its ports structurally from the concrete services.
  const taskReview = new TaskReviewAppService({ logger, tasks, sessions: appService, diffs: workspaceReview, review });
  // Chain changesets (ADR 0014): a subtask card entering Review captures its
  // clone's outbound patch durably (blob store + task_changesets rows), and a
  // dependent whose stored seedMode is "upstream" seeds its fresh clone from
  // those patches at start. Patch text rides through the same blob store as
  // diff baselines / planner artifacts.
  const changesetBlobs = new ContentAddressedBlobStore(path.join(stateRootPath, "artifacts", "blobs"));
  const changesets = new ChangesetService({
    store: new SqliteTaskChangesetStore(connection),
    blobs: {
      putText: async (text) => {
        const stored = await changesetBlobs.putText(text);
        return { sha256: stored.sha256, bytes: stored.size };
      },
      readText: async (sha256) => {
        const blob = await changesetBlobs.readBlob(sha256);
        return blob === null ? null : Buffer.from(blob).toString("utf8");
      }
    },
    clock,
    logger,
    bus
  });

  // Stage handoffs (plan D4): one bounded note per finished stage, parsed
  // from a ```handoff fenced block in the worker's final text (or a
  // capture-derived summary fallback), forwarded into the next stage's
  // first turn by the run bridge.
  const handoffs = new SqliteSubtaskHandoffStore(connection);

  // Inspection workspaces (plan D6): human-only views of finished work,
  // materialized from durable changesets (copy flavor) or the landed task
  // branch (worktree flavor) under <stateRoot>/inspect - outside the swept
  // tmp area, cleaned by human decision only. Never mounted into a sandbox;
  // the opener must never auto-trust one.
  const inspection = new InspectionService({
    logger,
    workspaceStore: new TempWorkspaceStore(path.join(stateRootPath, "inspect")),
    cloneSync,
    tasks: { getTask: (taskId) => workTaskStore.getTask(asId<"TaskId">(taskId)) },
    policies: tasks,
    workspaces: workspaceReview,
    changesets,
    subtasks: { getSubtask: (subtaskId) => subtasks.getSubtask(subtaskId) },
    onLandedBranchMissing: async (taskId) => {
      await workTaskStore.updateTask(asId<"TaskId">(taskId), { landedBranch: null, updatedAt: clock.isoNow() });
      bus.publish({ kind: "board-changed" });
    }
  });

  // Product preferences (plan D10): the workflow-defaults rung of the config
  // ladder, edited later in the System tab; recipes and tickets override it.
  const preferences = new PreferencesService(new SqlitePreferenceStore(connection), logger);

  // Task recipes (ADR 0007): stored templates (seeded once by migration)
  // plus a read-only overlay from the workspace's .drydock/recipes.json,
  // supplied by extension.ts exactly like the planner aspect overlays.
  const recipes = new RecipeService({
    store: new SqliteTaskRecipeStore(connection),
    tasks,
    subtasks,
    logger,
    ...(options.recipeOverlays === undefined ? {} : { overlays: options.recipeOverlays }),
    preferences: () => preferences.getNewTicketDefaults()
  });

  // Subtask auto-start orchestration (task board, Orchestration phase): the
  // bridge starts an isolated chat session exactly like the panel's chat.start
  // flow (session + baselines + detached first turn); the orchestrator
  // subscribes to the bus, moves cards on completion, and cascades to
  // autoStart dependents. Its link port pairs TaskService.link (records the
  // session->subtask link) with the store's listLinks (resolves a completed
  // session back to its subtask). The card-entered-done hook captures the
  // finishing subtask's changeset BEFORE dependents evaluate, so an
  // auto-started dependent with upstream seeding reads a fresh store.
  // Per-task serialization of stage branch advances (see the hook below).
  const stageAdvanceLocks = new Map<string, Promise<void>>();
  const orchestrator = new SubtaskOrchestrator({
    subtasks,
    board,
    links: {
      link: (taskId, target) => tasks.link(taskId, target),
      listLinks: () => workTaskStore.listLinks()
    },
    bus,
    startRun: createSubtaskRunBridge({
      logger,
      sessions: appService,
      workspaces: workspaceReview,
      tasks,
      changesets,
      tickets: {
        getTicket: async (taskId) => {
          const task = await workTaskStore.getTask(asId<"TaskId">(taskId));
          if (task === null) return null;
          return {
            ...(task.handoffMode === undefined ? {} : { handoffMode: task.handoffMode }),
            ...(task.branchName === undefined ? {} : { branchName: task.branchName }),
            ...(task.landedBranch === undefined ? {} : { landedBranch: task.landedBranch })
          };
        }
      },
      handoffs: {
        listForSubtasks: async (subtaskIds) =>
          (await handoffs.listForSubtasks(subtaskIds.map((id) => asId<"SubtaskId">(id))))
            .map((record) => ({ subtaskId: record.subtaskId as string, note: record.note }))
      }
    }),
    logger,
    ...(options.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: options.maxConcurrentRuns }),
    ...(options.maxBackgroundRuns === undefined ? {} : { maxBackgroundRuns: options.maxBackgroundRuns }),
    // Lane resolution reads the owning task fresh per start so a card edit
    // applies to the very next dispatch. Missing task = normal lane.
    resolveTaskLane: async (taskId) => (await workTaskStore.getTask(asId<"TaskId">(taskId)))?.lane ?? "normal",
    isSessionLive: (sessionId) => appService.isChatSessionLive(sessionId),
    endOrphanedSession: (sessionId, reason) => appService.endChatSession(sessionId, reason),
    holds: new SqliteSubtaskHoldStore(connection),
    onCardEnteredDone: async ({ taskId, subtaskId }) => {
      const sessionIds = await workTaskStore.listSessionIdsBySubtask(asId<"SubtaskId">(subtaskId));
      const sessionId = sessionIds[sessionIds.length - 1];
      if (sessionId === undefined) return; // never ran - nothing to capture
      const patches = await appService.buildOutboundPatches(sessionId);
      if (patches === null) {
        // Window reload or ended session: the clone is gone. Reject so the
        // orchestrator cannot auto-start dependents from an absent or stale
        // capture set. A later done-entry event can retry the capture.
        throw new Error(`Changeset capture unavailable for subtask ${subtaskId}: clone state for session ${sessionId} is no longer available.`);
      }
      await changesets.captureForSubtask({ taskId, subtaskId, sessionId, patches });

      const subtaskRecord = await subtasks.getSubtask(subtaskId);
      if (subtaskRecord?.stageIndex === undefined) return;

      // Stage handoff fallback (plan D4): a stage that emitted no ```handoff
      // block still leaves an honest, capture-derived baton for its successor.
      if (await handoffs.getHandoff(asId<"SubtaskId">(subtaskId)) === null) {
        const files = patches.flatMap((patch) => patch.paths).slice(0, 40);
        await handoffs.upsertHandoff({
          subtaskId: asId<"SubtaskId">(subtaskId),
          taskId: asId<"TaskId">(taskId),
          note: [
            `Stage "${subtaskRecord.title}" completed without an explicit handoff note.`,
            files.length > 0 ? `Files it changed: ${files.join(", ")}` : "It changed no files."
          ].join("\n"),
          source: "summary",
          createdAt: clock.isoNow()
        });
      }

      // Stage branch advance (plan D4): a finishing stage of a branch-handoff
      // task lands its work onto the task's OWN branch - ref-only, and
      // fast-forward-only once the canonical name exists. A drifted branch
      // rejects this hook, which blocks dependent auto-start: the chain parks
      // instead of force-writing over human commits. Advances SERIALIZE per
      // task (concurrency audit M2): two staged completions racing the
      // read-land-persist of landedBranch could otherwise fork the branch -
      // inside the lock each advance re-reads the task, so the second sees
      // the first's canonical name and fast-forwards instead of suffixing.
      const priorAdvance = stageAdvanceLocks.get(taskId) ?? Promise.resolve();
      const advance = priorAdvance.then(async () => {
        const task = await workTaskStore.getTask(asId<"TaskId">(taskId));
        if (task?.handoffMode !== "branch" || task.branchName === undefined || patches.length === 0) return;
        const requested = task.landedBranch ?? task.branchName;
        try {
          const landed = await appService.landSessionAsBranch(sessionId, requested, {
            onCollision: task.landedBranch === undefined ? "suffix" : "fail",
            repoNames: patches.map((patch) => patch.repoName)
          });
          if (landed !== null && landed.branch !== task.landedBranch) {
            await workTaskStore.updateTask(asId<"TaskId">(taskId), { landedBranch: landed.branch, updatedAt: clock.isoNow() });
          }
          // A successful advance clears any earlier drift park (the human
          // reconciled the branch and re-dragged/retried the stage).
          if (subtaskRecord.branchDriftAt !== undefined) {
            await subtasks.updateSubtask(subtaskId, { branchDrift: false });
          }
        } catch (error) {
          // Drift is a first-class, visible state (workflow audit M5): stamp
          // the stage so the board can wear the chip and offer the retry,
          // then rethrow so the hook still blocks the cascade.
          if (error instanceof Error && error.message.includes("BRANCH_DRIFTED")) {
            await subtasks.updateSubtask(subtaskId, { branchDrift: true }).catch(() => undefined);
          }
          throw error;
        }
      });
      stageAdvanceLocks.set(taskId, advance.catch(() => undefined));
      await advance;
    }
  });

  // Agent final-text detection: a session's final agent text may carry fenced
  // access-request blocks (mount asks) and/or memory-candidate blocks (durable
  // insights for review). Both are parsed once the turn's terminal text lands.
  // Access-request detection is gated on the session still being live (a mount
  // can only be applied to a running runtime); memory capture is not, since a
  // candidate is just an inert review item.
  bus.subscribe((event) => {
    if (event.kind !== "agent-event" || event.event.type !== "agent.text" || !event.event.final) {
      return;
    }
    const finalText = event.event.text;
    // Stage handoff notes (plan D4): a ```handoff fenced block in a
    // subtask-linked session's final text becomes the durable baton for the
    // next stage. Plain chats have no successor to brief - silently skipped.
    void (async () => {
      const note = parseHandoffNote(finalText);
      if (note === null) return;
      const links = await workTaskStore.listLinks();
      const link = links.find((entry) => entry.sessionId === event.sessionId && entry.subtaskId !== undefined);
      if (link?.subtaskId === undefined) return;
      await handoffs.upsertHandoff({
        subtaskId: link.subtaskId,
        taskId: link.taskId,
        note,
        source: "agent",
        createdAt: clock.isoNow()
      });
    })().catch((error: unknown) => {
      logger.warn("handoff note capture failed", {
        sessionId: event.sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    if (appService.isChatSessionLive(event.sessionId)) {
      void workspaceReview.detectAgentAccessRequests(event.sessionId, finalText).catch((error: unknown) => {
        logger.warn("agent access request detection failed", {
          sessionId: event.sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
    // Agent questions ride the same final-text protocol; every new pending
    // question is announced so the panel stacks it and flags attention.
    const parsedQuestions = extractAgentQuestions(finalText);
    if (parsedQuestions.length > 0) {
      // ADR 0016: resolve agent-referenced illustrations (question images and
      // manual-check step images) from the live sandbox BEFORE capture, so the
      // stored record renders anywhere. Failures degrade to path-only refs.
      void (async () => {
        const enriched = await Promise.all(parsedQuestions.map(async (candidate) => ({
          ...candidate,
          ...(candidate.imagePaths === undefined ? {} : {
            resolvedImages: await Promise.all(candidate.imagePaths.map(async (imagePath) => {
              const dataUri = await appService.readSandboxImageDataUri(event.sessionId, imagePath);
              return { path: imagePath, ...(dataUri === null ? {} : { dataUri }) };
            }))
          }),
          ...(candidate.steps === undefined ? {} : {
            resolvedSteps: await Promise.all(candidate.steps.map(async (step) => {
              const dataUri = step.imagePath === undefined
                ? null
                : await appService.readSandboxImageDataUri(event.sessionId, step.imagePath);
              return { text: step.text, ...(dataUri === null ? {} : { imageDataUri: dataUri }) };
            }))
          })
        })));
        const created = await questions.captureFromParsed(event.sessionId, enriched);
        for (const question of created) {
          bus.publish({ kind: "question-asked", question });
        }
      })().catch((error: unknown) => {
        logger.warn("agent question capture failed", {
          sessionId: event.sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
    // Preview announcements (ADR 0017): start the host proxy and announce it.
    const parsedPreviews = extractPreviewAnnouncements(finalText);
    for (const announcement of parsedPreviews) {
      void appService.registerPreview(event.sessionId, announcement.port, announcement.path, announcement.title)
        .then((preview) => {
          bus.publish({ kind: "preview-available", preview });
        })
        .catch((error: unknown) => {
          logger.warn("preview registration failed", {
            sessionId: event.sessionId,
            port: announcement.port,
            error: error instanceof Error ? error.message : String(error)
          });
        });
    }
    const memoryCandidates = extractMemoryCandidates(finalText);
    if (memoryCandidates.length > 0) {
      // Resolve the capture context so scope suggestions anchor to something
      // real: workspace scope -> the source session's mounted roots, task
      // scope -> the task this session is linked to.
      void (async () => {
        const stored = await chatService.getSession(asId<"SessionId">(event.sessionId));
        const links = await workTaskStore.listLinks();
        const taskId = links.find((link) => link.sessionId === event.sessionId)?.taskId;
        const created = await memory.captureCandidates(event.sessionId, memoryCandidates, {
          ...(stored?.workspaceRoots === undefined ? {} : { sessionRoots: stored.workspaceRoots }),
          ...(taskId === undefined ? {} : { taskId })
        });
        for (const candidate of created) {
          bus.publish({ kind: "memory-candidate-added", candidate });
        }
      })().catch((error: unknown) => {
        logger.warn("agent memory candidate capture failed", {
          sessionId: event.sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
  });

  const faqAutoAnswer = new TaskFaqAutoAnswerCoordinator({
    bus,
    tasks: workTaskStore,
    faqs: taskFaqStore,
    questions,
    sessions: appService,
    logger,
    enabled: options.autoAnswerQuestionsEnabled ?? (() => false)
  });

  // Work-session touch history: every completed turn touches the work
  // session for each task linked to that chat session (fire-and-forget). The
  // access-request/memory subscriber above keys off final agent text; this one
  // keys off the turn's terminal status, so both run per turn independently.
  bus.subscribe((event) => {
    if (event.kind !== "turn-completed") {
      return;
    }
    void tasks.recordSessionActivity(event.sessionId, clock.isoNow()).catch((error: unknown) => {
      logger.warn("work session activity recording failed", {
        sessionId: event.sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });

  // Deleting a session drops its work-session touch history (fire-and-forget);
  // the plan-doc subscriber below handles the same event for its own cleanup.
  bus.subscribe((event) => {
    if (event.kind !== "session-deleted") {
      return;
    }
    void workSessionStore.deleteForSession(event.sessionId).catch((error: unknown) => {
      logger.warn("work session cleanup failed", {
        sessionId: event.sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });

  // Planner (ADR 0012): first-class plans over the same connection. The
  // turn-completed hook collects the session's plan/ directory for the plan
  // that owns that session; session deletion just unlinks (the plan and its
  // collected artifacts persist - sessions are disposable, plans are not).
  const planner = new PlannerAppService({
    logger,
    clock,
    ids,
    plans: new SqlitePlanStore(connection),
    artifacts: new SqlitePlanArtifactStore(connection),
    annotations: new SqlitePlanAnnotationStore(connection),
    aspects: new SqlitePlanAspectStore(connection),
    blobs: new ContentAddressedBlobStore(path.join(stateRootPath, "artifacts", "blobs")),
    sessions: appService,
    chat: chatService,
    // Plans belong to tasks: the plan's session is linked to its owning task
    // on every boot, and summaries resolve task titles for display.
    tasks: {
      link: (taskId, target) => tasks.link(taskId, target),
      listTaskSummaries: () => tasks.listTaskSummaries()
    },
    bus,
    ...(options.plannerAspectOverlays === undefined ? {} : { aspectOverlays: options.plannerAspectOverlays })
  });
  bus.subscribe((event) => {
    if (event.kind === "turn-completed") {
      void planner.getPlanBySessionId(event.sessionId).then(async (plan) => {
        if (plan !== null) {
          await planner.collectPlanArtifacts(plan.planId);
        }
      }).catch((error: unknown) => {
        logger.warn("planner artifact collection failed", {
          sessionId: event.sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
      return;
    }
    if (event.kind === "session-deleted") {
      void planner.onSessionDeleted(event.sessionId).catch((error: unknown) => {
        logger.warn("planner session unlink failed", {
          sessionId: event.sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
  });

  const PURGE_REMOVED_OLDER_THAN_MS = 24 * 60 * 60 * 1000;
  const PURGE_LOST_OLDER_THAN_MS = 7 * 24 * 60 * 60 * 1000;
  const RUNTIME_NAME_PREFIX = "drydock";
  const reconcileOnActivate = async (): Promise<void> => {
    let deallocatedSessions = 0;
    let deallocatedRuntimes = 0;
    if (options.securityPolicy?.allowNetworkedAiOnThisMachine === false) {
      try {
        deallocatedSessions = await chatService.endAllSessionsForDeallocation();
      } catch (error) {
        logger.error("session deallocation cleanup failed; continuing with runtime inventory", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
      const runtimes = await inventory.listRuntimes();
      for (const runtime of runtimes) {
        if (runtime.status === "removed") continue;
        try {
          const result = await cleanup.cleanupRuntime(runtime.runtimeId, "force-remove");
          if (result.status === "removed") deallocatedRuntimes += 1;
        } catch (error) {
          logger.error("runtime deallocation cleanup failed", {
            runtimeId: runtime.runtimeId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
    // Fetch the live external-name set ONCE and share it with the session
    // reconciler (adoption) so the two reconcilers do not each list sbx.
    const externalRuntimeNames = new Set(await runtimeAdapter.listExternalRuntimeNames(RUNTIME_NAME_PREFIX));
    const sessionCounts = await chatService.reconcileSessions(externalRuntimeNames);
    const result = await runtimeReconcile.reconcile();
    // Purge runs after reconcile so newly-lost runtimes are stamped before the
    // retention window is measured against them.
    const purgedRuntimes = await appService.purgeRuntimes(PURGE_REMOVED_OLDER_THAN_MS, PURGE_LOST_OLDER_THAN_MS);
    if (
      sessionCounts.ended > 0 || sessionCounts.adopted > 0 || sessionCounts.elsewhere > 0 ||
      result.missingExternal.length > 0 || result.externalOnly.length > 0 || purgedRuntimes > 0 ||
      deallocatedSessions > 0 || deallocatedRuntimes > 0
    ) {
      logger.info("startup reconciliation", {
        endedSessions: sessionCounts.ended,
        adoptedSessions: sessionCounts.adopted,
        sessionsElsewhere: sessionCounts.elsewhere,
        lostRuntimes: result.missingExternal.length,
        externalOnly: [...result.externalOnly],
        purgedRuntimes,
        deallocatedSessions,
        deallocatedRuntimes
      });
    }
    bus.publish({ kind: "inventory-changed" });
    // Continuity (ADR 0015): queued/parked holds reload AFTER sessions and
    // runtimes reconcile, so restored queue entries start against a settled
    // world. Failures log; a broken hold never blocks activation.
    if (options.securityPolicy?.allowNetworkedAiOnThisMachine === false) return;
    try {
      await orchestrator.restore();
    } catch (error) {
      logger.warn("orchestrator hold restore failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };
  // Heartbeat keeps this window's live sessions marked "running here" for
  // sibling windows; its disposer stops the timer on backend teardown.
  const stopHeartbeats = chatService.startHeartbeats();

  return {
    available: true,
    appService,
    workspaceReview,
    questions,
    planner,
    taskReview,
    tasks,
    board,
    subtasks,
    orchestrator,
    changesets,
    inspection,
    preferences,
    cloneSync,
    projectCatalog,
    recipes,
    memory,
    mcp,
    tagRules,
    workInsights,
    bus,
    securityEvents,
    rawStreamStore,
    reconcileOnActivate,
    sbxDisplayPath: sbxPath,
    stateRootPath,
    dispose: () => {
      // Drop the orchestrator's bus subscription and stop the heartbeat before
      // closing the DB so no handler or tick writes to a closed connection
      // during window teardown.
      faqAutoAnswer.dispose();
      orchestrator.dispose();
      stopSecurityEvidence();
      stopHeartbeats();
      try {
        connection.close();
      } catch {
        // Already closed or never opened fully; disposal stays quiet.
      }
    }
  };
}
