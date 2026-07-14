/**
 * Extension entrypoint.
 *
 * Composes the backend once, then wires the two presentation surfaces —
 * command palette and control panel webview — as thin delegations over the
 * same IsolatedRunService. Activation always succeeds: a missing Docker Sandbox
 * yields a degraded backend that the surfaces render as an actionable state.
 */

import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { defaultDeniedPaths, normalizePathKey } from "@drydock/core";
import { registerIsolatedRunCommands } from "./commands/registerIsolatedRunCommands.js";
import { createBackend } from "./compositionRoot.js";
import { OutputChannelLogger } from "./outputChannelLogger.js";
import { AgentsPanelProvider } from "./webview/agentsPanelProvider.js";
import { BASELINE_SCHEME, BaselineContentProvider } from "./webview/baselineContentProvider.js";
import { ControlPanelProvider } from "./webview/controlPanelProvider.js";
import { MEMORY_SCHEME, MemoryContentProvider } from "./webview/memoryContentProvider.js";
import { PlannerPanelProvider } from "./webview/plannerPanelProvider.js";
import { createAspectOverlayReader } from "./services/plannerAspectOverlay.js";
import { createRecipeOverlayReader } from "./services/recipeOverlay.js";
import {
  filterPolicyOverlayRoots,
  loadEffectiveSecurityPolicy,
  resolvePolicyOverlayFile,
  type EffectiveSecurityPolicy,
  type UserSecurityPreferences
} from "./services/securityPolicy.js";
import { TaskBoardPanelProvider } from "./webview/taskBoardPanelProvider.js";
import { TaskReviewCommentsController } from "./webview/taskReviewCommentsController.js";
import { TaskReviewPanelProvider } from "./webview/taskReviewPanelProvider.js";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Drydock");
  context.subscriptions.push(output);
  const logger = new OutputChannelLogger(output);

  // Resolve a private child-process environment before composing the backend.
  // Never mutate the shared extension-host environment: doing so would leak
  // Drydock-specific PATH and variable overrides into other extensions.
  const runtimeEnvironment = resolveRuntimeEnvironment(logger);

  const stateRootPath = resolveStateRootPath();
  const baseDeniedPaths = resolveDeniedPaths();
  let securityPolicy: EffectiveSecurityPolicy | undefined;
  let startupBlockReason: string | undefined;
  try {
    securityPolicy = loadEffectiveSecurityPolicy({
      baseDeniedPaths,
      user: resolveUserSecurityPreferences()
    });
    logger.info("effective security policy loaded", {
      summary: securityPolicy.summary().label,
      ...(securityPolicy.policyId === undefined ? {} : { policyId: securityPolicy.policyId })
    });
  } catch (error) {
    startupBlockReason = `Security policy blocked startup: ${error instanceof Error ? error.message : String(error)}`;
    logger.error(startupBlockReason);
  }
  const appServerInactivityTimeoutMs = vscode.workspace
    .getConfiguration("drydock")
    .get<number>("runtime.appServerInactivityTimeoutMs", 300_000);
  // Department aspect packs: `.drydock/planner-aspects.json` in any open
  // workspace folder merges read-only into the planner's aspect registry.
  const workspaceRoots = (): readonly string[] => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  const policyWorkspaceRoots = (repoRelativeFile: string): (() => readonly string[]) => () =>
    filterPolicyOverlayRoots(securityPolicy, workspaceRoots(), repoRelativeFile);
  const policyOverlayFile = (root: string, filePath: string): string | undefined =>
    resolvePolicyOverlayFile(securityPolicy, root, filePath);
  const plannerAspectOverlays = createAspectOverlayReader(
    policyWorkspaceRoots(".drydock/planner-aspects.json"),
    policyOverlayFile
  );
  // Team recipe packs (ADR 0007): `.drydock/recipes.json` merges read-only
  // into the recipe registry the same way.
  const recipeOverlays = createRecipeOverlayReader(
    policyWorkspaceRoots(".drydock/recipes.json"),
    logger,
    () => vscode.workspace.isTrusted,
    policyOverlayFile
  );
  // Run-slot budget (ADR 0015), resolved live: an explicit setting wins;
  // 0/absent derives "auto (N)" from machine spec — half the cores, one run
  // per ~4 GB of RAM, clamped to 1..8.
  const maxConcurrentRuns = (): number => {
    const configured = vscode.workspace.getConfiguration("drydock").get<number>("orchestrator.maxConcurrentRuns", 0);
    if (Number.isFinite(configured) && configured > 0) {
      return Math.floor(configured);
    }
    const byCpu = Math.floor(os.cpus().length / 2);
    const byRam = Math.floor(os.totalmem() / (4 * 1024 ** 3));
    return Math.max(1, Math.min(8, byCpu, Math.max(1, byRam)));
  };
  const autoAnswerQuestionsEnabled = (): boolean =>
    vscode.workspace.getConfiguration("drydock").get<boolean>("autoAnswer.questions", true);
  const backend = await createBackend({
    stateRootPath,
    logger,
    runtimeEnvironment,
    deniedPaths: securityPolicy?.deniedPaths ?? baseDeniedPaths,
    ...(securityPolicy === undefined ? {} : { securityPolicy }),
    ...(startupBlockReason === undefined ? {} : { startupBlockReason }),
    appServerInactivityTimeoutMs,
    plannerAspectOverlays,
    recipeOverlays,
    maxConcurrentRuns,
    autoAnswerQuestionsEnabled
  });
  context.subscriptions.push(new vscode.Disposable(() => backend.dispose()));
  await writeStorePointer(context, stateRootPath);

  const panel = new ControlPanelProvider(context.extensionUri, backend, logger);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(ControlPanelProvider.viewType, panel));
  if (backend.available) {
    // Serves the diff editor's read-only baseline (left) pane from the blob store.
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(
        BASELINE_SCHEME,
        new BaselineContentProvider(backend.workspaceReview)
      )
    );
    // Serves the read-only memory document opened from the Work tab's Memories list.
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(
        MEMORY_SCHEME,
        new MemoryContentProvider(backend.memory)
      )
    );
  }
  // Construction order: the controller's onCommentsChanged callback needs the
  // panel provider, and the provider needs the controller. Resolve the cycle
  // with a `let`-captured provider reference: the callback closes over
  // `taskReviewPanels`, which is assigned on the next line before any panel can
  // open (so the reference is always live by the time the callback fires).
  let taskReviewPanels: TaskReviewPanelProvider;
  let taskReviewComments: TaskReviewCommentsController | undefined;
  if (backend.available) {
    taskReviewComments = new TaskReviewCommentsController({
      workspaceReview: backend.workspaceReview,
      logger,
      onCommentsChanged: (sessionId) => taskReviewPanels.notifySessionCommentsChanged(sessionId)
    });
    context.subscriptions.push(taskReviewComments);
  }
  taskReviewPanels = new TaskReviewPanelProvider(context.extensionUri, backend, logger, taskReviewComments);
  // Gutter "+" reply and thread resolve actions route here. The commands are
  // always registered; with the backend unavailable there is no controller, so
  // they surface the degraded-backend reason instead.
  context.subscriptions.push(vscode.commands.registerCommand("drydock.taskReview.addComment", (reply: vscode.CommentReply) => {
    if (taskReviewComments === undefined) {
      void vscode.window.showErrorMessage(backend.available ? "Task review is unavailable." : backend.reason);
      return;
    }
    void taskReviewComments.addFromReply(reply);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("drydock.taskReview.resolveThread", (thread: vscode.CommentThread) => {
    if (taskReviewComments === undefined) {
      void vscode.window.showErrorMessage(backend.available ? "Task review is unavailable." : backend.reason);
      return;
    }
    void taskReviewComments.resolveThread(thread);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("drydock.taskReview.open", async (taskId?: unknown) => {
    if (!backend.available) {
      void vscode.window.showErrorMessage(backend.reason);
      return;
    }
    let resolvedId = typeof taskId === "string" ? taskId : undefined;
    const tasks = await backend.tasks.listTaskSummaries();
    let title = "Task";
    if (resolvedId === undefined) {
      const pick = await vscode.window.showQuickPick(
        tasks.map((task) => ({ label: task.title, description: task.state, taskId: task.taskId })),
        { placeHolder: "Select a task to review across its projects" }
      );
      if (pick === undefined) return;
      resolvedId = pick.taskId;
      title = pick.label;
    } else {
      title = tasks.find((task) => task.taskId === resolvedId)?.title ?? title;
    }
    await taskReviewPanels.open(resolvedId, title);
  }));
  // Task Board: single global panel, so the command takes no arguments — it
  // opens (or reveals) the one instance. The control panel's taskBoard.open
  // relay routes here.
  const taskBoardPanel = new TaskBoardPanelProvider(context.extensionUri, backend, logger);
  context.subscriptions.push(vscode.commands.registerCommand("drydock.taskBoard.open", async () => {
    if (!backend.available) {
      void vscode.window.showErrorMessage(backend.reason);
      return;
    }
    await taskBoardPanel.open();
  }));
  // Agents (ADR 0013): single global fleet panel over every session across
  // every task. The control panel's agents.open relay routes here; fleet row
  // clicks navigate back to the sidebar via the provider's showSession.
  const agentsPanel = new AgentsPanelProvider(context.extensionUri, backend, logger, (sessionId, nodeId) => {
    panel.showSession(sessionId, nodeId);
  });
  context.subscriptions.push(vscode.commands.registerCommand("drydock.agents.open", async () => {
    if (!backend.available) {
      void vscode.window.showErrorMessage(backend.reason);
      return;
    }
    await agentsPanel.open();
  }));
  // Planner (ADR 0012): single global panel; landing, intake, and the
  // three-column plan view all live inside it. The control panel's
  // planner.open relay routes here.
  const plannerPanel = new PlannerPanelProvider(context.extensionUri, backend, logger);
  context.subscriptions.push(vscode.commands.registerCommand("drydock.planner.open", async (planId?: unknown) => {
    if (!backend.available) {
      void vscode.window.showErrorMessage(backend.reason);
      return;
    }
    await plannerPanel.open(typeof planId === "string" ? planId : undefined);
  }));
  if (backend.available) {
    // A plan session booting (from the panel, the sidebar Plan tab, or a
    // revive-on-send) auto-opens the full planning workspace ON that plan.
    backend.bus.subscribe((event) => {
      if (event.kind === "planner-session-started") {
        void plannerPanel.open(event.planId).catch((error: unknown) => {
          logger.warn("planner auto-open failed", {
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
    });
  }
  registerIsolatedRunCommands(context, output, backend);

  if (backend.available) {
    void backend.reconcileOnActivate().catch((error: unknown) => {
      logger.warn("startup reconciliation failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
    void backend.appService.sweepTempWorkspaces()
      .then((removed) => {
        if (removed > 0) logger.info("swept aged temp workspaces", { removed });
      })
      .catch((error: unknown) => {
        logger.warn("temp workspace sweep failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
  } else {
    logger.warn(backend.reason);
  }
}

export function deactivate(): void {
  // Disposal (SQLite close, webview, output channel) runs via context.subscriptions.
}

/**
 * The effective mount denylist: the user's configured `deniedPaths` merged with
 * the default sensitive home-config roots (dedup by normalized path key). The
 * defaults are omitted only when `disableDefaultDeniedPaths` is explicitly set —
 * the opt-out escape hatch for the rare user who must mount one of them.
 */
function resolveDeniedPaths(): string[] {
  const config = vscode.workspace.getConfiguration("drydock");
  const configured = config.get<string[]>("deniedPaths", []);
  const disableDefaults = config.get<boolean>("disableDefaultDeniedPaths", false);
  const merged = disableDefaults ? [...configured] : [...configured, ...defaultDeniedPaths(os.homedir())];
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const entry of merged) {
    const key = normalizePathKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

function resolveUserSecurityPreferences(): UserSecurityPreferences {
  const config = vscode.workspace.getConfiguration("drydock");
  return {
    allowedProjectRoots: config.get<string[]>("security.allowedProjectRoots", []),
    cloneOnly: config.get<boolean>("security.cloneOnly", false),
    omitSensitiveFiles: config.get<boolean>("security.omitSensitiveFiles", false),
    omittedRepoPaths: config.get<string[]>("security.omittedRepoPaths", []),
    networkedAiEnabled: config.get<boolean>("security.networkedAiEnabled", true)
  };
}

/**
 * Resolves the environment inherited by Drydock-owned child processes. The
 * returned object is private to the backend; the shared extension-host
 * `process.env` is never changed. `runtime.env` sets/overrides variables,
 * `runtime.pathAdditions` prepends PATH
 * directories, and `runtime.copyEnv` names variables that MUST be present (a
 * warning fires if one is missing, since a GUI-launched host may not carry a
 * terminal's session vars). Additive and reload-scoped.
 */
function resolveRuntimeEnvironment(logger: OutputChannelLogger): NodeJS.ProcessEnv {
  const config = vscode.workspace.getConfiguration("drydock");
  const environment: NodeJS.ProcessEnv = { ...process.env };

  const extraEnv = config.get<Record<string, string>>("runtime.env", {});
  for (const [key, value] of Object.entries(extraEnv)) {
    if (typeof value === "string" && key.length > 0) {
      environment[key] = value;
    }
  }

  const copyEnv = config.get<string[]>("runtime.copyEnv", []);
  const missing = copyEnv.filter((name) => typeof name === "string" && name.length > 0 && environment[name] === undefined);
  if (missing.length > 0) {
    logger.warn("drydock.runtime.copyEnv lists variables not present in the extension host environment", { missing });
  }

  const pathAdditions = config.get<string[]>("runtime.pathAdditions", [])
    .filter((dir) => typeof dir === "string" && dir.length > 0);
  if (pathAdditions.length > 0) {
    const existing = (environment["PATH"] ?? "").split(path.delimiter);
    const additions = pathAdditions.filter((dir) => !existing.includes(dir));
    if (additions.length > 0) {
      environment["PATH"] = [...additions, ...existing].join(path.delimiter);
      logger.info("applied drydock.runtime.pathAdditions", { added: additions });
    }
  }
  return environment;
}

function resolveStateRootPath(): string {
  const configured = vscode.workspace.getConfiguration("drydock").get<string>("stateRoot", "").trim();
  if (configured === "") {
    return path.join(os.homedir(), ".drydock");
  }
  if (configured === "~" || configured.startsWith("~/") || configured.startsWith("~\\")) {
    return path.join(os.homedir(), configured.slice(1));
  }
  return configured;
}

/** Best-effort pointer so tooling can find the configured state root. */
async function writeStorePointer(context: vscode.ExtensionContext, stateRootPath: string): Promise<void> {
  try {
    await mkdir(context.globalStorageUri.fsPath, { recursive: true });
    await writeFile(
      path.join(context.globalStorageUri.fsPath, "store-pointer.json"),
      `${JSON.stringify({ stateRoot: stateRootPath, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8"
    );
  } catch {
    // The pointer is a convenience; state itself lives under stateRootPath.
  }
}
