/**
 * Composition root for the extension's backend services.
 *
 * Wiring is typed against ports where they exist so adapters stay swappable.
 * Missing host tooling (no `sbx`) produces a degraded-but-alive backend value
 * instead of throwing: activation must always succeed so the command surface
 * and the control panel can render an actionable "not available" state.
 */

import { execFile as execFileCb } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, realpathSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClaudeAdapter, CodexAdapter, CodexAppServerTransport } from "@drydock/agent-adapters";
import { asId, PROVIDER_REGISTRY, PROVIDER_TOKEN_FILE, type AgentAdapter, type AgentModelCatalog, type ProviderDescriptor } from "@drydock/contracts";
import { ContentAddressedBlobStore, TempWorkspaceStore } from "@drydock/artifacts";
import type { ChatSessionStore, EventStore, RuntimeInventoryStore, SecurityEventInput, SecurityEventStore } from "@drydock/contracts";
import {
  AccessRequestService,
  ActiveTaskService,
  AgentQuestionService,
  ChatSessionService,
  CloneSyncService,
  CodeReviewService,
  computeChangesetRef,
  ValidationJobService,
  ValidationProbeService,
  extractAgentQuestions,
  extractPreviewAnnouncements,
  extractMemoryCandidates,
  mergeTagRules,
  ProductEventBus,
  RandomIdGenerator,
  normalizePathKey,
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
  discoverPowerShellCommand,
  discoverSshCommand,
  discoverStandaloneClaudeCommand,
  discoverStandaloneCodexCommand,
  DockerSandboxRuntimeAdapter,
  HyperVControl,
  HyperVRuntimeAdapter
} from "@drydock/runtime-adapters";
import {
  applyMigrations,
  SqliteAccessRequestStore,
  SqliteAgentQuestionStore,
  SqliteAppStateStore,
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
  SqliteSecurityEventStore,
  SqliteSubtaskHoldStore,
  SqliteSubtaskStore,
  SqliteTaskChangesetStore,
  SqliteTaskFaqStore,
  SqliteTaskRecipeStore,
  SqliteValidationRuntimeStore,
  SqliteMcpServerStore,
  SqliteWorkSessionStore,
  SqliteWorkspaceSetStore,
  SqliteWorkTaskStore
} from "@drydock/storage-sqlite";
import { BoardService, ChangesetService, importServersFromConfigJson, McpRegistryService, MemoryService, ProjectCatalogService, RecipeService, SubtaskOrchestrator, SubtaskService, TaskService, WorkspaceSetService } from "@drydock/work-management";
import { PlannerAppService } from "./services/plannerAppService.js";
import { IsolatedRunService, type ProviderSecretRefStore } from "./services/isolatedRunService.js";
import { fetchProviderModelsFromHost } from "./services/modelDiscovery.js";
import { createProviderRuntimePreparer } from "./services/providerWire.js";
import { createSubtaskRunBridge } from "./services/subtaskRunBridge.js";
import type { EffectiveSecurityPolicy } from "./services/securityPolicy.js";
import { TaskReviewAppService } from "./services/taskReviewAppService.js";
import { TaskFaqAutoAnswerCoordinator } from "./services/taskFaqAutoAnswer.js";
import { ValidationAppService } from "./services/validationAppService.js";
import { canonicalizeProductionRequestPath, WorkspaceReviewAppService } from "./services/workspaceReviewAppService.js";

/** app_state key holding the last successful live model discoveries. */
const CATALOG_CACHE_KEY = "providerCatalogCache.v1";

export interface BackendReady {
  readonly available: true;
  readonly appService: IsolatedRunService;
  readonly workspaceReview: WorkspaceReviewAppService;
  readonly planner: PlannerAppService;
  readonly taskReview: TaskReviewAppService;
  readonly tasks: TaskService;
  /** Active-task spine: the one task every surface follows in this window. */
  readonly activeTasks: ActiveTaskService;
  /**
   * Durable key/value UI state (the `app_state` table). Providers persist small
   * one-time flags here - e.g. "the chat rail already tried its placement move"
   * - so nothing user-visible depends on globalState/workspaceState.
   */
  readonly appState: SqliteAppStateStore;
  readonly board: BoardService;
  readonly subtasks: SubtaskService;
  readonly orchestrator: SubtaskOrchestrator;
  /** Chain changesets (ADR 0014): capture/query/land bookkeeping. */
  readonly changesets: ChangesetService;
  /** Task recipes (ADR 0007): templates that materialize task + subtask DAGs. */
  readonly recipes: RecipeService;
  readonly questions: AgentQuestionService;
  readonly memory: MemoryService;
  /** MCP registry: definitions + tri-state overrides (design doc). */
  readonly mcp: McpRegistryService;
  /** Merged glob->tag rule table (defaults + drydock.memory.tagRules). */
  readonly tagRules: readonly import("@drydock/core").TagRule[];
  readonly bus: ProductEventBus;
  /** Content-free, append-only security evidence with JSONL export. */
  readonly securityEvents: SecurityEventStore;
  /** Debug-only per-session capture of the current turn's raw agent stream. */
  readonly rawStreamStore: SessionRawStreamStore;
  /** Session + inventory reconciliation, run once after activation. */
  readonly reconcileOnActivate: () => Promise<void>;
  /**
   * Builds a Hyper-V validation-runtime adapter for one named runtime's exec
   * address (ADR 0022 M3). Undefined off Windows or when ssh/powershell
   * discovery failed - validation is then unavailable, and callers say so rather
   * than pretending a runtime can be reached.
   */
  readonly hyperVAdapterFactory?: (
    connection: import("@drydock/contracts").ValidationRuntimeConnection
  ) => import("@drydock/runtime-adapters").HyperVRuntimeAdapter;
  /** Host-wide Hyper-V queries (VM state, checkpoints, counters); same caveat. */
  readonly hyperVControl?: import("@drydock/runtime-adapters").HyperVControl;
  /**
   * Validation runtimes (ADR 0022 M7): the registry, the queue, the probes, and
   * the fixture snapshots, behind one host-side service. Always present when the
   * backend composed - off Windows it simply reports `hostSupported: false`, so
   * every surface can say "Windows host required" instead of rendering an empty
   * registry as though one could be filled in here.
   */
  readonly validation?: ValidationAppService;
  readonly sbxDisplayPath: string;
  /** Host Claude CLI, when present; powers the guided sign-in flow only. */
  readonly hostClaudePath?: string;
  /** Private environment for Drydock-owned child processes (login flows). */
  readonly runtimeEnvironment: NodeJS.ProcessEnv;
  /** Platform secret store backing `vscode-secret:<provider>` refs, when supplied. */
  readonly providerSecrets?: ProviderSecretRefStore;
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
  /** Platform secret store (VS Code SecretStorage) for `vscode-secret:<provider>` API keys. */
  readonly providerSecrets?: ProviderSecretRefStore;
  /**
   * ADR 0022 validation settings, read at activation like every other
   * `drydock.*` machine-scope setting and parsed defensively here:
   *
   * - `validationProbeConfig` is `drydock.validation.probeConfig`: the REAL
   *   production path, mirror root, blocked endpoints, and toolset canary the
   *   must-fail probes attempt. Absent leaves every probe `unknown` - which is
   *   the honest answer, never a pass.
   * - `validationMirrorRoot` is `drydock.validation.mirrorRoot`, stamped onto
   *   receipts as mirror version + freshness (edge case G1).
   * - `validationDefaultProfile` is `drydock.validation.defaultProfile`: the
   *   suite the palette command runs. Absent makes the command say so.
   */
  readonly validationProbeConfig?: unknown;
  readonly validationMirrorRoot?: string;
  readonly validationDefaultProfile?: unknown;
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

/**
 * Reads `drydock.validation.probeConfig` defensively. A malformed setting
 * leaves the probes UNCONFIGURED (every probe reports `unknown`) rather than
 * half-configured: a suite that silently skips the production-read check would
 * be worse than one that admits it never ran (edge case G2).
 */
function parseValidationProbeConfig(
  value: unknown,
  logger: Logger
): import("@drydock/core").ValidationProbeConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    logger.warn("drydock.validation.probeConfig is not an object; validation probes stay unconfigured");
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const productionUncPath = typeof record["productionUncPath"] === "string" ? record["productionUncPath"] : "";
  const mirrorDriveRoot = typeof record["mirrorDriveRoot"] === "string" ? record["mirrorDriveRoot"] : "";
  const rawEgress = Array.isArray(record["disallowedEgress"]) ? record["disallowedEgress"] : [];
  const disallowedEgress: { host: string; port: number }[] = [];
  for (const entry of rawEgress) {
    if (typeof entry !== "object" || entry === null) continue;
    const endpoint = entry as Record<string, unknown>;
    const host = endpoint["host"];
    const port = endpoint["port"];
    if (typeof host !== "string" || host === "") continue;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) continue;
    disallowedEgress.push({ host, port });
  }
  const rawArgv = record["toolsetResolveArgv"];
  const toolsetResolveArgv = Array.isArray(rawArgv) && rawArgv.every((entry) => typeof entry === "string")
    ? (rawArgv as string[])
    : undefined;
  if (productionUncPath === "" && mirrorDriveRoot === "" && disallowedEgress.length === 0 && toolsetResolveArgv === undefined) {
    return undefined;
  }
  return {
    productionUncPath,
    mirrorDriveRoot,
    disallowedEgress,
    ...(toolsetResolveArgv === undefined ? {} : { toolsetResolveArgv })
  };
}

/**
 * Reads `drydock.validation.defaultProfile`. A profile with no `profileRef` or
 * no command cannot produce attributable evidence, so it is rejected outright
 * and the palette command says validation is not configured yet.
 */
function parseValidationProfile(
  value: unknown,
  logger: Logger
): import("@drydock/contracts").ValidationProfile | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    logger.warn("drydock.validation.defaultProfile is not an object; validation has no default profile");
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const profileRef = record["profileRef"];
  const argv = record["argv"];
  if (typeof profileRef !== "string" || profileRef.trim() === "") return undefined;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((entry) => typeof entry === "string")) {
    logger.warn("drydock.validation.defaultProfile declares no command to run; validation has no default profile");
    return undefined;
  }
  const env: Record<string, string> = {};
  const rawEnv = record["env"];
  if (typeof rawEnv === "object" && rawEnv !== null && !Array.isArray(rawEnv)) {
    for (const [key, entry] of Object.entries(rawEnv as Record<string, unknown>)) {
      if (typeof entry === "string") env[key] = entry;
    }
  }
  const capabilities = record["requiredCapabilities"];
  const licenseWaitPatterns = record["licenseWaitPatterns"];
  return {
    profileRef,
    argv: argv as string[],
    ...(Object.keys(env).length === 0 ? {} : { env }),
    ...(Array.isArray(capabilities) && capabilities.every((entry) => typeof entry === "string")
      ? { requiredCapabilities: capabilities as string[] }
      : {}),
    ...(Array.isArray(licenseWaitPatterns) && licenseWaitPatterns.every((entry) => typeof entry === "string")
      ? { licenseWaitPatterns: licenseWaitPatterns as string[] }
      : {})
  };
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
  // ADR 0022 M3: Hyper-V validation runtimes are a SECOND runtime class, not a
  // replacement for sandboxes. Two pieces are composed here and handed to the
  // backend; neither is on any session path.
  //  - `hyperVControl` needs only powershell.exe and answers host-wide questions
  //    (which VMs exist, their state, checkpoints, counters).
  //  - `hyperVAdapterFactory` builds one adapter PER NAMED RUNTIME, because the
  //    exec channel's address is per-runtime configuration rather than a single
  //    host-wide endpoint. M4's job service calls it as it resolves a runtime.
  // Both stay undefined off Windows or when discovery fails, so callers must
  // degrade honestly instead of assuming Hyper-V is available.
  const sshPath = process.platform === "win32" ? discoverSshCommand(runtimeEnvironment) : null;
  const powershellPath = process.platform === "win32" ? discoverPowerShellCommand(runtimeEnvironment) : null;
  const hyperVControl = powershellPath === null
    ? undefined
    : new HyperVControl({ powershellPath, commandRunner, cwd: stateRootPath, environment: runtimeEnvironment });
  // Product-owned SSH material. The known-hosts file is where the adapter pins
  // each guest's key on first connect (never the user's ~/.ssh/known_hosts); the
  // identity file is the product's own key, used only once the M7 wizard has
  // generated it - hence the existence check at build time, not compose time.
  const hyperVKnownHostsFile = path.join(stateDir, "hyperv_known_hosts");
  const hyperVIdentityFile = path.join(stateDir, "hyperv_ed25519");
  const hyperVAdapterFactory = sshPath === null || powershellPath === null
    ? undefined
    : (target: import("@drydock/contracts").ValidationRuntimeConnection): HyperVRuntimeAdapter =>
        new HyperVRuntimeAdapter({
          sshPath,
          powershellPath,
          commandRunner,
          cwd: stateRootPath,
          logger,
          connection: target,
          knownHostsFile: hyperVKnownHostsFile,
          ...(existsSync(hyperVIdentityFile) ? { identityFile: hyperVIdentityFile } : {}),
          environment: runtimeEnvironment
        });
  // Session plumbing stays docker-only for now: validation runtimes are driven
  // by M4's job service, not by the session lifecycle.
  const runtimeAdapters = [runtimeAdapter];
  const lifecycle = new RuntimeLifecycleService({
    clock,
    inventory,
    runtimeAdapters,
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
  const cleanup = new RuntimeCleanupService({ clock, inventory, runtimeAdapters, logger });
  const hostCodexPath = managed ? null : discoverStandaloneCodexCommand(runtimeEnvironment);
  // Host Claude CLI powers only the guided sign-in flow (`claude setup-token`
  // on the host, where the browser works); prompts still never run host-side.
  const hostClaudePath = managed ? null : discoverStandaloneClaudeCommand(runtimeEnvironment);
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
  // Ridden providers (OpenRouter, DeepSeek, Kimi, ...) reuse the two native
  // adapters, parameterized from the registry: codex rides get their key env
  // sentinel prefixed into the app-server spawn (the sandbox proxy injects the
  // real value); claude rides get the Anthropic-compatible wire config with a
  // runtime-scoped token file. Model catalogs are LIVE: each rider's
  // listModels queries the registry-described models endpoint on the host.
  const riderCatalogSource = (descriptor: ProviderDescriptor) => () =>
    fetchProviderModelsFromHost(descriptor, {
      ...(options.providerSecrets === undefined ? {} : { providerSecrets: options.providerSecrets }),
      logger,
      isoNow: () => clock.isoNow()
    });
  const riderAdapters: AgentAdapter[] = PROVIDER_REGISTRY
    .filter((descriptor) => descriptor.wire !== undefined)
    .map((descriptor) => {
      if (descriptor.wire?.kind === "openai-compat" && descriptor.wire.envKey !== undefined) {
        const envKey = descriptor.wire.envKey;
        return new CodexAdapter({
          ...adapterOptions,
          providerId: descriptor.providerId,
          catalogSource: riderCatalogSource(descriptor),
          appServer: {
            ...adapterOptions.appServer,
            argsForRuntime: (handle: { readonly externalName: string }) =>
              ["exec", handle.externalName, "env", `${envKey}=proxy-managed`]
          }
        });
      }
      return new ClaudeAdapter({
        ids,
        clock,
        logger,
        runtimeExecutor: runtimeAdapter,
        rawSink: rawStreamStore,
        providerId: descriptor.providerId,
        catalogSource: riderCatalogSource(descriptor),
        wire: {
          baseUrl: descriptor.wire?.baseUrl ?? "",
          tokenFile: PROVIDER_TOKEN_FILE,
          ...(descriptor.wire?.smallFastModel === undefined ? {} : { smallFastModel: descriptor.wire.smallFastModel })
        }
      });
    });
  const agentAdapters: ReadonlyMap<string, AgentAdapter> = new Map<string, AgentAdapter>([
    [agent.providerId, agent],
    [claudeAgent.providerId, claudeAgent],
    ...riderAdapters.map((adapter): [string, AgentAdapter] => [adapter.providerId, adapter])
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
    // Ridden providers write their CLI config / runtime-scoped token into
    // every fresh runtime generation; native providers are a no-op.
    prepareRuntime: createProviderRuntimePreparer({
      runtimeExecutor: runtimeAdapter,
      ...(options.providerSecrets === undefined ? {} : { providerSecrets: options.providerSecrets }),
      logger
    }),
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
  const runtimeReconcile = new RuntimeReconcileService({ clock, inventory, runtimeAdapters, logger });
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
  // Durable key/value UI state; also backs the discovered-model catalog cache
  // (constructed here because the app service loads the cache at build time).
  const appState = new SqliteAppStateStore(connection);
  const catalogCache = {
    load: (): readonly AgentModelCatalog[] | undefined => {
      const rawCache = appState.getAppState(CATALOG_CACHE_KEY);
      if (rawCache === null) return undefined;
      try {
        const parsed = JSON.parse(rawCache) as unknown;
        if (!Array.isArray(parsed)) return undefined;
        return parsed.filter((entry): entry is AgentModelCatalog =>
          entry !== null && typeof entry === "object"
          && typeof (entry as AgentModelCatalog).providerId === "string"
          && Array.isArray((entry as AgentModelCatalog).models));
      } catch {
        return undefined;
      }
    },
    save: (catalogs: readonly AgentModelCatalog[]): void => {
      appState.setAppState(CATALOG_CACHE_KEY, JSON.stringify(catalogs));
    }
  };
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
    catalogCache,
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
    ...(hostCodexPath === null ? {} : { hostCodexPath }),
    ...(options.providerSecrets === undefined ? {} : { providerSecrets: options.providerSecrets })
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
  // Late-bound (ADR 0022): the ValidationAppService that classifies production
  // paths is constructed after the access-request service; the closure below
  // reads this at call time, exactly like the runtimeAvailability knot.
  let isProductionRequestPath: ((candidate: string) => boolean) | undefined;
  const accessRequests = new AccessRequestService({
    ids,
    clock,
    store: new SqliteAccessRequestStore(connection),
    deniedPaths,
    ...(options.securityPolicy === undefined
      ? {}
      : {
          validateHostPath: (candidate: string) => {
            // ADR 0022 A1/B1: a production-tier path (a STUDIO-managed data
            // denial, never a credential default) must be REQUESTABLE so the
            // snapshot flow can answer it - the normal gate would refuse it
            // here and leave the sanctioned fixture route unreachable. It stays
            // unmountable: prepareApproval still refuses denied paths, and
            // approval routes through the fixture port instead. Only an
            // existing regular file passes, and a canonical target that escapes
            // the production tier (symlink/junction) falls back to the normal
            // gate.
            if (isProductionRequestPath?.(candidate) === true) {
              // Keep the managed-policy freshness check the normal gate would
              // run: a policy tightened since startup must still fail closed on
              // this path.
              options.securityPolicy?.assertPolicyCurrent();
              const canonical = canonicalizeProductionRequestPath(candidate);
              if (isProductionRequestPath(canonical) === true) return canonical;
              return options.securityPolicy?.assertHostPathAllowed(canonical) ?? canonical;
            }
            return options.securityPolicy?.assertHostPathAllowed(candidate) ?? candidate;
          }
        })
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
  // Active-task spine: restored before any surface can read it, so a reloaded
  // window resumes on the task it was working on.
  const activeTasks = new ActiveTaskService({ appState, bus });
  activeTasks.restore();
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

  // -------------------------------------------------------------------------
  // Validation runtimes (ADR 0022 M7)
  // -------------------------------------------------------------------------
  //
  // Three services, one dependency knot, resolved once here:
  //   probes -> exec channel        (needs an adapter for a named runtime)
  //   jobs   -> availability        (needs the app service's quarantine ladder)
  //   app    -> jobs + probes       (owns registry rules, fixtures, the rail)
  //
  // The knot is broken with ONE late binding (`validationApp`), because the job
  // service only asks for availability while draining a queue - long after
  // composition. Everything else is constructor-wired.
  const validationStore = new SqliteValidationRuntimeStore(connection);
  const validationProbeConfig = parseValidationProbeConfig(options.validationProbeConfig, logger);
  const validationDefaultProfile = parseValidationProfile(options.validationDefaultProfile, logger);
  const validationHostSupported = hyperVAdapterFactory !== undefined && hyperVControl !== undefined;
  // One adapter (and one adopted handle) per named runtime, rebuilt when its
  // exec address changes. The adapter's exec ignores the handle for addressing
  // - the connection is fixed at construction - so probes can run before the
  // adopt sequence has ever completed, which is exactly what a health check on
  // a stopped runtime needs.
  const validationAdapters = new Map<string, {
    readonly key: string;
    readonly adapter: HyperVRuntimeAdapter;
    handle: import("@drydock/contracts").RuntimeHandle | null;
    adopting: Promise<import("@drydock/contracts").RuntimeHandle> | null;
  }>();
  const validationVmName = (displayName: string): string => {
    const slug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return `drydock-validation-${slug === "" ? "runtime" : slug}`;
  };
  const validationAdapterFor = (
    runtime: import("@drydock/contracts").NamedRuntimeConfig
  ): import("@drydock/core").ValidationExecAdapter | null => {
    const connection = runtime.connection;
    if (hyperVAdapterFactory === undefined || connection === undefined) return null;
    const key = `${connection.user}@${connection.host}:${String(connection.port ?? 22)}`;
    const id = String(runtime.runtimeId);
    let entry = validationAdapters.get(id);
    if (entry === undefined || entry.key !== key) {
      entry = { key, adapter: hyperVAdapterFactory(connection), handle: null, adopting: null };
      validationAdapters.set(id, entry);
    }
    const held = entry;
    const externalName = validationVmName(runtime.displayName);
    const liteHandle = (): import("@drydock/contracts").RuntimeHandle => ({
      runtimeId: asId<"RuntimeId">(`validation-${id}`),
      runtimeGenerationId: asId<"RuntimeGenerationId">(`validation-gen-${id}`),
      sessionId: asId<"SessionId">(`validation-${id}`),
      adapter: "hyperv",
      externalName,
      workspacePath: externalName,
      mounts: [],
      status: "running"
    });
    return {
      ensureRunning: async (): Promise<void> => {
        if (held.handle !== null) return;
        // Adopt ONCE per address; concurrent jobs share the same attempt rather
        // than racing two Start-VM sequences at the same guest.
        held.adopting ??= held.adapter.createRuntime(
          {
            sessionId: asId<"SessionId">(`validation-${id}`),
            chatId: asId<"ChatId">(`validation-${id}`),
            agentRole: "tester",
            template: {
              id: `validation-${id}`,
              type: "hyperv",
              image: runtime.image,
              network: "disabled",
              mounts: [],
              environment: {},
              adapterProviderIds: [],
              advancedOptions: {}
            },
            workspacePath: externalName,
            generationId: asId<"RuntimeGenerationId">(`validation-gen-${id}`),
            runtimeId: asId<"RuntimeId">(`validation-${id}`)
          },
          externalName
        ).finally(() => { held.adopting = null; });
        held.handle = await held.adopting;
      },
      exec: (args, timeoutMs, input, signal, onStdoutLine) => held.adapter.exec(
        held.handle ?? liteHandle(),
        args,
        timeoutMs,
        input,
        signal,
        onStdoutLine
      ),
      sweepGuestJob: (jobToken, timeoutMs, signal) =>
        held.adapter.sweepGuestJob(held.handle ?? liteHandle(), jobToken, timeoutMs, signal)
    };
  };
  const validationProbes = new ValidationProbeService({
    clock,
    logger,
    bus,
    execFor: (runtime) => validationAdapterFor(runtime)?.exec ?? null,
    config: () => validationProbeConfig,
    // The incident is applied durably BEFORE the banner event fires, so a
    // surface reacting to the event always finds a blocked queue (E5).
    quarantine: async (runtimeId, probeId, detail) => {
      await validationApp?.quarantine(runtimeId, probeId, detail);
    }
  });
  let validationApp: ValidationAppService | undefined;
  const validationJobs = new ValidationJobService({
    store: validationStore,
    clock,
    logger,
    bus,
    runtimeAvailability: async (runtime) => (await validationApp?.availabilityForJob(runtime)) ?? "missing",
    adapterFor: validationAdapterFor,
    // The ADR 0014 capture seam, reused verbatim: a validation job ships the
    // same outbound patches a subtask's changeset capture would, so evidence
    // binds to exactly the snapshot the chain would have landed.
    changesetSource: async (request) => {
      const patches = await appService.buildOutboundPatches(String(request.sessionId));
      if (patches === null || patches.length === 0) return null;
      return {
        changesetRef: computeChangesetRef(patches.map((patch) => ({
          repoName: patch.repoName,
          patchSha256: createHash("sha256").update(patch.patch, "utf8").digest("hex")
        }))),
        patches: patches.map((patch) => ({ repoName: patch.repoName, patch: patch.patch }))
      };
    },
    // Only the configured default profile can be rehydrated after a restart;
    // anything else parks with a readable sentence rather than guessing (E7).
    profileFor: async (profileRef) =>
      validationDefaultProfile?.profileRef === profileRef ? validationDefaultProfile : null,
    ...(options.validationMirrorRoot === undefined || options.validationMirrorRoot === ""
      ? {}
      : { mirrorRoot: () => options.validationMirrorRoot }),
    probesGreenAt: (runtimeId) => validationProbes.probesGreenAt(runtimeId)
  });
  validationApp = new ValidationAppService({
    logger,
    clock,
    store: validationStore,
    jobs: validationJobs,
    probes: validationProbes,
    bus,
    host: {
      supported: validationHostSupported,
      ...(hyperVControl === undefined
        ? {}
        : {
            vmState: async (vmName: string) => {
              const vm = await hyperVControl.getVm(vmName);
              return vm === null ? null : vm.state === "running" ? "running" : "other";
            }
          })
    },
    ...(options.securityPolicy === undefined ? {} : { securityPolicy: options.securityPolicy }),
    projects: async () => (await projectCatalogStore.listProjects())
      .map((project) => ({ projectRootId: String(project.projectId), label: project.name })),
    // The association tier needs a project: a task's is the first member of the
    // first workspace set it links. A task with no set simply has no
    // association tier and falls through to the default.
    taskProjectRootId: async (taskId) => {
      const task = (await tasks.listTaskSummaries()).find((summary) => summary.taskId === taskId);
      const setId = task?.linkedWorkspaceSetIds[0];
      if (setId === undefined) return undefined;
      const set = (await workspaceSets.listWorkspaceSets()).find((candidate) => candidate.workspaceSetId === setId);
      const member = set?.members[0];
      return member === undefined ? undefined : String(member.projectId);
    },
    ...(validationDefaultProfile === undefined ? {} : { defaultProfile: () => validationDefaultProfile }),
    sessionContext: async (sessionId) => {
      const session = await sessionStore.getSession(asId<"SessionId">(sessionId));
      if (session === null) return null;
      const links = await workTaskStore.listLinks();
      const link = links.find((candidate) => candidate.sessionId === sessionId);
      return {
        chatId: String(session.chatId),
        ...(link?.taskId === undefined ? {} : { taskId: String(link.taskId) }),
        ...(link?.subtaskId === undefined || link.subtaskId === null ? {} : { subtaskId: String(link.subtaskId) })
      };
    },
    fixtureStagingRoot: path.join(stateDir, "fixtures"),
    securityEvent: (event) => {
      appendSecurityEvent({
        eventCode: event.eventCode,
        outcome: event.outcome,
        ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
        ...(event.metadata === undefined ? {} : { metadata: event.metadata as import("@drydock/contracts").JsonObject })
      });
    },
    ids: { validationRuntimeId: () => asId<"ValidationRuntimeId">(`vruntime-${randomUUID().replace(/-/g, "").slice(0, 12)}`) }
  });
  {
    const classifierSource = validationApp;
    isProductionRequestPath = (candidate: string) => classifierSource.isProductionPath(candidate);
  }

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
    ...(options.securityPolicy === undefined ? {} : { securityPolicy: options.securityPolicy }),
    // ADR 0022 A1/B1: approving a production-tier path takes the snapshot
    // route, never a mount. The validation service owns the copy and the ledger
    // entry; the review service just knows which door to use.
    productionFixtures: validationApp
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

  // Task recipes (ADR 0007): stored templates (seeded once by migration)
  // plus a read-only overlay from the workspace's .drydock/recipes.json,
  // supplied by extension.ts exactly like the planner aspect overlays.
  const recipes = new RecipeService({
    store: new SqliteTaskRecipeStore(connection),
    tasks,
    subtasks,
    logger,
    ...(options.recipeOverlays === undefined ? {} : { overlays: options.recipeOverlays })
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
  const orchestrator = new SubtaskOrchestrator({
    subtasks,
    board,
    links: {
      link: (taskId, target) => tasks.link(taskId, target),
      listLinks: () => workTaskStore.listLinks()
    },
    bus,
    startRun: createSubtaskRunBridge({ logger, sessions: appService, workspaces: workspaceReview, tasks, changesets }),
    logger,
    ...(options.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: options.maxConcurrentRuns }),
    isSessionLive: (sessionId) => appService.isChatSessionLive(sessionId),
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
    // ADR 0022 M4: sessions only ever adopt sandboxes, so this stays a single
    // sbx fetch; the union across adapters arrives with hyperv inventory rows.
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
    // The validation queue reloads on the same principle (E7): jobs the host
    // left mid-flight requeue once, and the probe cadence arms behind them.
    try {
      await validationApp?.restore();
    } catch (error) {
      logger.warn("validation queue restore failed", {
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
    activeTasks,
    appState,
    board,
    subtasks,
    orchestrator,
    changesets,
    recipes,
    memory,
    mcp,
    tagRules,
    bus,
    securityEvents,
    rawStreamStore,
    reconcileOnActivate,
    ...(hyperVAdapterFactory === undefined ? {} : { hyperVAdapterFactory }),
    ...(hyperVControl === undefined ? {} : { hyperVControl }),
    validation: validationApp,
    sbxDisplayPath: sbxPath,
    ...(hostClaudePath === null ? {} : { hostClaudePath }),
    runtimeEnvironment,
    ...(options.providerSecrets === undefined ? {} : { providerSecrets: options.providerSecrets }),
    stateRootPath,
    dispose: () => {
      // Drop the orchestrator's bus subscription and stop the heartbeat before
      // closing the DB so no handler or tick writes to a closed connection
      // during window teardown.
      faqAutoAnswer.dispose();
      orchestrator.dispose();
      // Stops the probe cadence timer and drops the fixture-cleanup listener.
      validationApp?.dispose();
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
