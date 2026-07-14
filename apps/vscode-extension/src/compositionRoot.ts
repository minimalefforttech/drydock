/**
 * Composition root for the extension's backend services.
 *
 * Wiring is typed against ports where they exist so adapters stay swappable.
 * Missing host tooling (no `sbx`) produces a degraded-but-alive backend value
 * instead of throwing: activation must always succeed so the command surface
 * and the control panel can render an actionable "not available" state.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClaudeAdapter, CodexAdapter, CodexAppServerTransport } from "@drydock/agent-adapters";
import { asId, type AgentAdapter } from "@drydock/contracts";
import { ContentAddressedBlobStore, TempWorkspaceStore } from "@drydock/artifacts";
import type { ChatSessionStore, EventStore, RuntimeInventoryStore } from "@drydock/contracts";
import {
  AccessRequestService,
  AgentQuestionService,
  ChatSessionService,
  CloneSyncService,
  CodeReviewService,
  extractAgentQuestions,
  extractMemoryCandidates,
  ProductEventBus,
  RandomIdGenerator,
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
  SqliteSubtaskHoldStore,
  SqliteSubtaskStore,
  SqliteTaskChangesetStore,
  SqliteTaskFaqStore,
  SqliteTaskRecipeStore,
  SqliteWorkSessionStore,
  SqliteWorkspaceSetStore,
  SqliteWorkTaskStore
} from "@drydock/storage-sqlite";
import { BoardService, ChangesetService, MemoryService, ProjectCatalogService, RecipeService, SubtaskOrchestrator, SubtaskService, TaskService, WorkspaceSetService } from "@drydock/work-management";
import { PlannerAppService } from "./services/plannerAppService.js";
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
  /** Task recipes (ADR 0007): templates that materialize task + subtask DAGs. */
  readonly recipes: RecipeService;
  readonly questions: AgentQuestionService;
  readonly memory: MemoryService;
  readonly workInsights: WorkInsightsAppService;
  readonly bus: ProductEventBus;
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
  /** ADR 0007: the global gate for task-FAQ question auto-answering. */
  readonly autoAnswerQuestionsEnabled?: () => boolean;
}

/**
 * Ensures the runtime tool directories are on the extension host's PATH before
 * any `sbx` call. A GUI-launched VS Code inherits a login-time PATH that often
 * omits Docker Desktop's `resources\bin` — where the Docker credential helper
 * (`docker-credential-desktop`) lives that `sbx` shells out to for its session
 * token. Without the helper on PATH, `sbx create` fails auth with
 * "secret not found / not authenticated to Docker", even though the identical
 * command works in a terminal (whose PATH does include that dir). Prepends the
 * sbx binary's own dir plus the known Docker Desktop bin locations; each is
 * added only if it exists and is not already present.
 */
function ensureRuntimeToolsOnPath(sbxPath: string, environment: NodeJS.ProcessEnv, logger: Logger): void {
  const programFiles = environment["ProgramFiles"] ?? "C:\\Program Files";
  const candidates = [
    path.dirname(sbxPath),
    path.join(os.homedir(), "AppData", "Local", "DockerSandboxes", "bin"),
    path.join(programFiles, "Docker", "Docker", "resources", "bin")
  ];
  const existing = (environment["PATH"] ?? "").split(path.delimiter);
  const additions = candidates.filter((dir) => dir.length > 0 && existsSync(dir) && !existing.includes(dir));
  if (additions.length > 0) {
    environment["PATH"] = [...additions, ...existing].join(path.delimiter);
    logger.info("augmented PATH for runtime tools", { added: additions });
  }
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
  const sbxPath = discoverDockerSandboxCommand(runtimeEnvironment);
  if (!sbxPath) {
    return {
      available: false,
      reason: "Docker Sandbox `sbx` was not found. Install Docker Sandbox (or set SBX_PATH to sbx.exe) and reload the window.",
      stateRootPath,
      dispose: () => { /* nothing composed */ }
    };
  }
  ensureRuntimeToolsOnPath(sbxPath, runtimeEnvironment, logger);

  const stateDir = path.join(stateRootPath, "state");
  const tmpDir = path.join(stateRootPath, "tmp");
  await mkdir(stateDir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });

  const ids = new RandomIdGenerator();
  const clock = new SystemClock();
  const commandRunner = new SpawnCommandRunner(runtimeEnvironment);
  const connection = new SqliteConnection(path.join(stateDir, "state.sqlite"));
  applyMigrations(connection);
  const inventory: RuntimeInventoryStore = new SqliteRuntimeInventoryStore(connection);
  const eventStore: EventStore = new SqliteEventStore(connection);
  const sessionStore: ChatSessionStore = new SqliteChatSessionStore(connection);
  const bus = new ProductEventBus();
  // Work-session touch history and agent memory candidates. Constructed early
  // so the app service can inject approved memory into the first briefing of
  // each session.
  const workSessionStore = new SqliteWorkSessionStore(connection);
  const memory = new MemoryService({ ids, clock, store: new SqliteMemoryCandidateStore(connection) });
  const runtimeAdapter = new DockerSandboxRuntimeAdapter({
    sbxPath,
    commandRunner,
    cwd: stateRootPath,
    logger
  });
  const lifecycle = new RuntimeLifecycleService({ clock, inventory, runtimeAdapter, logger });
  const cleanup = new RuntimeCleanupService({ clock, inventory, runtimeAdapter, logger });
  const hostCodexPath = discoverStandaloneCodexCommand(runtimeEnvironment);
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
  const workflow = new IsolatedRunWorkflow({ ids, logger, lifecycle, cleanup, agentAdapter: agent, eventStore });
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
    hostInstanceId
  });
  const runtimeReconcile = new RuntimeReconcileService({ clock, inventory, runtimeAdapter, logger });
  // Clone mode: host-side git plumbing (clone/status/inbound/outbound/discard)
  // over the shared CommandRunner. No docker, no network — pure host git.
  const cloneSync = new CloneSyncService({ runner: commandRunner });
  const workspaceStore = new TempWorkspaceStore(tmpDir);
  const prober = new CodexAppServerTransport({
    command: sbxPath,
    argsForRuntime: (handle) => ["exec", handle.externalName],
    cwd: stateRootPath
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
    cloneSync,
    hostInstanceId,
    memoryService: memory,
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
    deniedPaths
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
    ...(options.securityPolicy === undefined ? {} : { securityPolicy: options.securityPolicy })
  });
  // Cross-project task review: a VIEW over the task's linked sessions —
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
      if (sessionId === undefined) return; // never ran — nothing to capture
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
      void questions.captureFromParsed(event.sessionId, parsedQuestions).then((created) => {
        for (const question of created) {
          bus.publish({ kind: "question-asked", question });
        }
      }).catch((error: unknown) => {
        logger.warn("agent question capture failed", {
          sessionId: event.sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
    const memoryTexts = extractMemoryCandidates(finalText);
    if (memoryTexts.length > 0) {
      void memory.captureCandidates(event.sessionId, memoryTexts).then((created) => {
        for (const candidate of created) {
          bus.publish({ kind: "memory-candidate-added", candidate });
        }
      }).catch((error: unknown) => {
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
  // collected artifacts persist — sessions are disposable, plans are not).
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
      result.missingExternal.length > 0 || result.externalOnly.length > 0 || purgedRuntimes > 0
    ) {
      logger.info("startup reconciliation", {
        endedSessions: sessionCounts.ended,
        adoptedSessions: sessionCounts.adopted,
        sessionsElsewhere: sessionCounts.elsewhere,
        lostRuntimes: result.missingExternal.length,
        externalOnly: [...result.externalOnly],
        purgedRuntimes
      });
    }
    bus.publish({ kind: "inventory-changed" });
    // Continuity (ADR 0015): queued/parked holds reload AFTER sessions and
    // runtimes reconcile, so restored queue entries start against a settled
    // world. Failures log; a broken hold never blocks activation.
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
    recipes,
    memory,
    workInsights,
    bus,
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
      stopHeartbeats();
      try {
        connection.close();
      } catch {
        // Already closed or never opened fully; disposal stays quiet.
      }
    }
  };
}
