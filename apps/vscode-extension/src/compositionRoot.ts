/**
 * Composition root for the extension's backend services.
 *
 * Wiring is typed against ports where they exist so adapters stay swappable.
 * Missing host tooling (no `sbx`) produces a degraded-but-alive backend value
 * instead of throwing: activation must always succeed so the command surface
 * and the control panel can render an actionable "not available" state.
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
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
  SqliteChatSessionStore,
  SqliteConnection,
  SqliteDiffBaselineStore,
  SqliteEventStore,
  SqliteMemoryCandidateStore,
  SqlitePlanDocStore,
  SqliteProjectCatalogStore,
  SqliteReviewStore,
  SqliteRuntimeInventoryStore,
  SqliteWorkSessionStore,
  SqliteWorkspaceSetStore,
  SqliteWorkTaskStore
} from "@drydock/storage-sqlite";
import { MemoryService, ProjectCatalogService, TaskService, WorkspaceSetService } from "@drydock/work-management";
import { PlanDocsAppService } from "./services/planDocsAppService.js";
import { IsolatedRunService } from "./services/isolatedRunService.js";
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
  readonly questions: AgentQuestionService;
  readonly memory: MemoryService;
  readonly workInsights: WorkInsightsAppService;
  readonly bus: ProductEventBus;
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
  const adapterOptions = {
    ids,
    clock,
    logger,
    runtimeExecutor: runtimeAdapter,
    commandRunner,
    appServer: {
      command: sbxPath,
      argsForRuntime: (handle: { readonly externalName: string }) => ["exec", handle.externalName],
      cwd: stateRootPath
    }
  };
  const agent = new CodexAdapter(hostCodexPath === null ? adapterOptions : { ...adapterOptions, hostCodexPath });
  const claudeAgent = new ClaudeAdapter({ ids, clock, logger, runtimeExecutor: runtimeAdapter });
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
  // Internal work tasks (chat-panel redesign, Phase 2). Shares the same
  // ids/clock/connection as every other service so ids stay uniform and links
  // reference live workspace-set and session rows. The work-session store
  // powers touch history and each task's lastWorkedAt.
  const tasks = new TaskService({ ids, clock, store: new SqliteWorkTaskStore(connection), workSessions: workSessionStore });
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
    memory,
    workInsights,
    bus,
    reconcileOnActivate,
    sbxDisplayPath: sbxPath,
    stateRootPath,
    dispose: () => {
      // Stop the heartbeat before closing the DB so no tick writes to a closed
      // connection during window teardown.
      stopHeartbeats();
      try {
        connection.close();
      } catch {
        // Already closed or never opened fully; disposal stays quiet.
      }
    }
  };
}
