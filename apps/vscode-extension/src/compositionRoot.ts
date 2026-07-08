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
import type { AgentAdapter } from "@drydock/contracts";
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
  SqlitePlanDocStore,
  SqliteProjectCatalogStore,
  SqliteReviewStore,
  SqliteRuntimeInventoryStore,
  SqliteSubtaskStore,
  SqliteWorkSessionStore,
  SqliteWorkspaceSetStore,
  SqliteWorkTaskStore
} from "@drydock/storage-sqlite";
import { BoardService, MemoryService, ProjectCatalogService, SubtaskOrchestrator, SubtaskService, TaskService, WorkspaceSetService } from "@drydock/work-management";
import { PlanDocsAppService } from "./services/planDocsAppService.js";
import { IsolatedRunService } from "./services/isolatedRunService.js";
import { createSubtaskRunBridge } from "./services/subtaskRunBridge.js";
import { TaskReviewAppService } from "./services/taskReviewAppService.js";
import { WorkInsightsAppService } from "./services/workInsightsAppService.js";
import { WorkspaceReviewAppService } from "./services/workspaceReviewAppService.js";

export interface BackendReady {
  readonly available: true;
  readonly appService: IsolatedRunService;
  readonly workspaceReview: WorkspaceReviewAppService;
  readonly planDocs: PlanDocsAppService;
  readonly taskReview: TaskReviewAppService;
  readonly tasks: TaskService;
  readonly board: BoardService;
  readonly subtasks: SubtaskService;
  readonly orchestrator: SubtaskOrchestrator;
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
  /** Paths excluded from mounts, snapshots, and diffs (drydock.deniedPaths). */
  readonly deniedPaths?: readonly string[];
  /** Codex app-server stall watchdog window in ms (drydock.runtime.appServerInactivityTimeoutMs). */
  readonly appServerInactivityTimeoutMs?: number;
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
function ensureRuntimeToolsOnPath(sbxPath: string, logger: Logger): void {
  const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const candidates = [
    path.dirname(sbxPath),
    path.join(os.homedir(), "AppData", "Local", "DockerSandboxes", "bin"),
    path.join(programFiles, "Docker", "Docker", "resources", "bin")
  ];
  const existing = (process.env["PATH"] ?? "").split(path.delimiter);
  const additions = candidates.filter((dir) => dir.length > 0 && existsSync(dir) && !existing.includes(dir));
  if (additions.length > 0) {
    process.env["PATH"] = [...additions, ...existing].join(path.delimiter);
    logger.info("augmented PATH for runtime tools", { added: additions });
  }
}

export async function createBackend(options: CreateBackendOptions): Promise<Backend> {
  const { stateRootPath, logger } = options;
  const deniedPaths = options.deniedPaths ?? [];
  const sbxPath = discoverDockerSandboxCommand();
  if (!sbxPath) {
    return {
      available: false,
      reason: "Docker Sandbox `sbx` was not found. Install Docker Sandbox (or set SBX_PATH to sbx.exe) and reload the window.",
      stateRootPath,
      dispose: () => { /* nothing composed */ }
    };
  }
  ensureRuntimeToolsOnPath(sbxPath, logger);

  const stateDir = path.join(stateRootPath, "state");
  const tmpDir = path.join(stateRootPath, "tmp");
  await mkdir(stateDir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });

  const ids = new RandomIdGenerator();
  const clock = new SystemClock();
  const commandRunner = new SpawnCommandRunner();
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
  const hostCodexPath = discoverStandaloneCodexCommand();
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
    sbxPath,
    commandRunner,
    ...(hostCodexPath === null ? {} : { hostCodexPath })
  });

  // Workspace policy and diff review.
  const projectCatalogStore = new SqliteProjectCatalogStore(connection);
  const projectCatalog = new ProjectCatalogService({ ids, clock, store: projectCatalogStore });
  const workspaceSets = new WorkspaceSetService({
    ids,
    clock,
    catalog: projectCatalogStore,
    store: new SqliteWorkspaceSetStore(connection)
  });
  const accessRequests = new AccessRequestService({ ids, clock, store: new SqliteAccessRequestStore(connection), deniedPaths });
  // Agent questions (attention stack): same protocol family as access requests.
  const questions = new AgentQuestionService({ ids, clock, store: new SqliteAgentQuestionStore(connection) });
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
  const tasks = new TaskService({
    ids,
    clock,
    store: workTaskStore,
    columns: boardColumnStore,
    workSessions: workSessionStore,
    subtasks: subtaskStore
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
    bus
  });
  // Cross-project task review: a VIEW over the task's linked sessions —
  // aggregates their changed files (baseline diffs + clone sync state) and
  // routes the reviewer's comments back as revision turns. It reads only
  // projections and satisfies its ports structurally from the concrete services.
  const taskReview = new TaskReviewAppService({ logger, tasks, sessions: appService, diffs: workspaceReview, review });
  // Subtask auto-start orchestration (task board, Orchestration phase): the
  // bridge starts an isolated chat session exactly like the panel's chat.start
  // flow (session + baselines + detached first turn); the orchestrator
  // subscribes to the bus, moves cards on completion, and cascades to
  // autoStart dependents. Its link port pairs TaskService.link (records the
  // session->subtask link) with the store's listLinks (resolves a completed
  // session back to its subtask).
  const orchestrator = new SubtaskOrchestrator({
    subtasks,
    board,
    links: {
      link: (taskId, target) => tasks.link(taskId, target),
      listLinks: () => workTaskStore.listLinks()
    },
    bus,
    startRun: createSubtaskRunBridge({ logger, sessions: appService, workspaces: workspaceReview, taskLinks: workTaskStore }),
    logger
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

  // Plan mode v2 (chat-panel redesign, Phase 2): after each plan-mode turn the
  // host collects the agent's `plan/` output into a per-session doc store and
  // announces it on the bus; deleting a session drops its collected docs.
  const planDocs = new PlanDocsAppService({
    logger,
    clock,
    store: new SqlitePlanDocStore(connection),
    chatService,
    bus,
    review
  });
  bus.subscribe((event) => {
    if (event.kind === "turn-completed" && appService.getSessionMode(event.sessionId) === "plan") {
      void planDocs.collectPlanDocs(event.sessionId).catch((error: unknown) => {
        logger.warn("plan-doc collection failed", {
          sessionId: event.sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
      return;
    }
    if (event.kind === "session-deleted") {
      void planDocs.deleteSessionDocs(event.sessionId).catch((error: unknown) => {
        logger.warn("plan-doc cleanup failed", {
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
  };
  // Heartbeat keeps this window's live sessions marked "running here" for
  // sibling windows; its disposer stops the timer on backend teardown.
  const stopHeartbeats = chatService.startHeartbeats();

  return {
    available: true,
    appService,
    workspaceReview,
    questions,
    planDocs,
    taskReview,
    tasks,
    board,
    subtasks,
    orchestrator,
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
