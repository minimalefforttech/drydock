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

  const managedPolicySeen = context.globalState.get<boolean>("drydock.managedPolicySeen", false);
  let baseDeniedPaths = resolveDeniedPaths(false);
  let securityPolicy: EffectiveSecurityPolicy | undefined;
  let startupBlockReason: string | undefined;
  let managedHome: string | undefined;
  try {
    securityPolicy = loadEffectiveSecurityPolicy({
      baseDeniedPaths,
      user: resolveUserSecurityPreferences(),
      requireStudioPolicy: managedPolicySeen
    });
    if (securityPolicy.managed) {
      managedHome = os.userInfo().homedir;
      // Latch managed mode before any further I/O so a remove/replace race can
      // never turn the next activation into an unmanaged fallback.
      await context.globalState.update("drydock.managedPolicySeen", true);
      // Local settings may narrow managed policy, but must never remove the
      // built-in credential/config denylist.
      baseDeniedPaths = resolveDeniedPaths(true, managedHome);
      securityPolicy = loadEffectiveSecurityPolicy({
        baseDeniedPaths,
        user: resolveUserSecurityPreferences(),
        requireStudioPolicy: true
      });
    }
    logger.info("effective security policy loaded", {
      summary: securityPolicy.summary().label,
      ...(securityPolicy.policyId === undefined ? {} : { policyId: securityPolicy.policyId })
    });
  } catch (error) {
    startupBlockReason = `Security policy blocked startup: ${error instanceof Error ? error.message : String(error)}`;
    logger.error(startupBlockReason);
  }
  const managedMode = managedPolicySeen || securityPolicy?.managed === true;
  if (managedMode && managedHome === undefined) managedHome = os.userInfo().homedir;
  // Resolve a private child-process environment after policy. Never mutate the
  // extension host environment or let managed mode inherit setting overrides.
  const runtimeEnvironment = resolveRuntimeEnvironment(logger, managedMode);
  const stateRootPath = resolveStateRootPath(logger, managedMode, managedHome);
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
    policyOverlayFile,
    () => vscode.workspace.isTrusted
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
    !managedMode && vscode.workspace.getConfiguration("drydock").get<boolean>("autoAnswer.questions", true);
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
  context.subscriptions.push(vscode.commands.registerCommand("drydock.security.exportEvidence", async () => {
    if (!backend.available) {
      void vscode.window.showErrorMessage(backend.reason);
      return;
    }
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(
        os.homedir(),
        `drydock-security-events-${new Date().toISOString().slice(0, 10)}.jsonl`
      )),
      filters: { "JSON Lines": ["jsonl"] },
      saveLabel: "Export security events"
    });
    if (target === undefined) return;
    try {
      const jsonl = await backend.securityEvents.exportSecurityEvents();
      await vscode.workspace.fs.writeFile(target, Buffer.from(jsonl, "utf8"));
      void vscode.window.showInformationMessage("Security events exported.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("security event export failed", { error: message });
      void vscode.window.showErrorMessage(`Security event export failed: ${message}`);
    }
  }));

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
  context.subscriptions.push(vscode.commands.registerCommand("drydock.taskReview.open", async (taskId?: unknown, options?: unknown) => {
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
    const startGuide = typeof options === "object" && options !== null
      && (options as { readonly startGuide?: unknown }).startGuide === true;
    await taskReviewPanels.open(resolvedId, title, startGuide);
  }));
  // Task Board: single global panel, so the command takes no arguments — it
  // opens (or reveals) the one instance. The control panel's taskBoard.open
  // relay routes here.
  const taskBoardPanel = new TaskBoardPanelProvider(context.extensionUri, backend, logger);
  context.subscriptions.push(vscode.commands.registerCommand("drydock.taskBoard.open", async (options?: unknown) => {
    if (!backend.available) {
      void vscode.window.showErrorMessage(backend.reason);
      return;
    }
    const startGuide = typeof options === "object" && options !== null
      && (options as { readonly startGuide?: unknown }).startGuide === true;
    await taskBoardPanel.open(startGuide);
  }));
  // Agents (ADR 0013): single global fleet panel over every session across
  // every task. The control panel's agents.open relay routes here; fleet row
  // clicks navigate back to the sidebar via the provider's showSession.
  const agentsPanel = new AgentsPanelProvider(context.extensionUri, backend, logger, (sessionId, nodeId) => {
    panel.showSession(sessionId, nodeId);
  });
  context.subscriptions.push(vscode.commands.registerCommand("drydock.agents.open", async (options?: unknown) => {
    if (!backend.available) {
      void vscode.window.showErrorMessage(backend.reason);
      return;
    }
    const startGuide = typeof options === "object" && options !== null
      && (options as { readonly startGuide?: unknown }).startGuide === true;
    await agentsPanel.open(startGuide);
  }));
  // Planner (ADR 0012): the editor panel owns intake, outputs, and artifact
  // review; the Drydock Plan tab remains its planning-chat sidebar. Selection
  // is synchronized in both directions without moving focus during panel use.
  const plannerPanel = new PlannerPanelProvider(
    context.extensionUri,
    backend,
    logger,
    (planId, reveal) => panel.showPlan(planId, reveal)
  );
  context.subscriptions.push(vscode.commands.registerCommand("drydock.planner.open", async (planId?: unknown, options?: unknown) => {
    if (!backend.available) {
      void vscode.window.showErrorMessage(backend.reason);
      return;
    }
    const startGuide = typeof options === "object" && options !== null
      && (options as { readonly startGuide?: unknown }).startGuide === true;
    await plannerPanel.open(typeof planId === "string" ? planId : undefined, startGuide);
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
    void backend.reconcileOnActivate()
      .then(() => backend.appService.sweepTempWorkspaces())
      .then((removed) => {
        if (removed > 0) logger.info("swept aged temp workspaces", { removed });
      })
      .catch((error: unknown) => {
        logger.warn("startup reconciliation or temp workspace sweep failed", {
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
function resolveDeniedPaths(enforceDefaults: boolean, homeDirectory: string = os.homedir()): string[] {
  const config = vscode.workspace.getConfiguration("drydock");
  const configured = config.get<string[]>("deniedPaths", []);
  const disableDefaults = !enforceDefaults && config.get<boolean>("disableDefaultDeniedPaths", false);
  const merged = disableDefaults ? [...configured] : [...configured, ...defaultDeniedPaths(homeDirectory)];
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
function resolveRuntimeEnvironment(logger: OutputChannelLogger, managed: boolean): NodeJS.ProcessEnv {
  const config = vscode.workspace.getConfiguration("drydock");
  const environment: NodeJS.ProcessEnv = { ...process.env };

  if (managed) {
    const blockedEnvironmentKeys = new Set([
      "ANTHROPIC_API_KEY",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AZURE_OPENAI_API_KEY",
      "AZURE_CLIENT_CERTIFICATE_PATH",
      "AZURE_CLIENT_SECRET",
      "BASH_ENV",
      "CLAUDE_API_KEY",
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
      "CODEX_PATH",
      "CURL_CA_BUNDLE",
      "DATABASE_URL",
      "DOCKER_AUTH_CONFIG",
      "DOCKER_CERT_PATH",
      "DOCKER_CONFIG",
      "DOCKER_CONTEXT",
      "DOCKER_HOST",
      "DOCKER_TLS_VERIFY",
      "DOTNET_STARTUP_HOOKS",
      "ELECTRON_RUN_AS_NODE",
      "ENV",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "IFS",
      "JAVA_TOOL_OPTIONS",
      "JDK_JAVA_OPTIONS",
      "KUBECONFIG",
      "NETRC",
      "NODE_EXTRA_CA_CERTS",
      "NODE_OPTIONS",
      "NODE_PATH",
      "NPM_CONFIG_USERCONFIG",
      "OPENAI_API_KEY",
      "PERL5LIB",
      "PERL5OPT",
      "PGPASSFILE",
      "PROMPT_COMMAND",
      "PYTHONHOME",
      "PYTHONPATH",
      "PYTHONSTARTUP",
      "REQUESTS_CA_BUNDLE",
      "RUBYLIB",
      "RUBYOPT",
      "SBX_PATH",
      "SSH_AGENT_PID",
      "SSH_ASKPASS",
      "SSH_AUTH_SOCK",
      "SSL_CERT_DIR",
      "SSL_CERT_FILE",
      "TEMP",
      "TMP",
      "TMPDIR",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "_JAVA_OPTIONS"
    ]);
    let removed = 0;
    for (const key of Object.keys(environment)) {
      const upper = key.toUpperCase();
      const secretLike = /(?:^|_)(?:ACCESS_KEY|API_KEY|CONNECTION_STRING|CREDENTIALS?|PASS(?:WORD|WD)?|PRIVATE_KEY|SECRET|TOKEN)(?:$|_)/.test(upper);
      const injectionLike = upper.startsWith("GIT_")
        || upper.startsWith("DYLD_")
        || upper.startsWith("LD_")
        || upper.startsWith("BASH_FUNC_")
        || upper.startsWith("VSCODE_GIT_ASKPASS");
      if (blockedEnvironmentKeys.has(upper) || secretLike || injectionLike) {
        delete environment[key];
        removed += 1;
      }
    }
    const trustedHome = os.userInfo().homedir;
    setEnvironmentKey(environment, "HOME", trustedHome);
    if (process.platform === "win32") {
      const root = path.parse(trustedHome).root;
      setEnvironmentKey(environment, "USERPROFILE", trustedHome);
      setEnvironmentKey(environment, "HOMEDRIVE", root.replace(/[\\/]$/, ""));
      setEnvironmentKey(environment, "HOMEPATH", trustedHome.slice(root.length - 1));
      setEnvironmentKey(environment, "APPDATA", path.join(trustedHome, "AppData", "Roaming"));
      setEnvironmentKey(environment, "LOCALAPPDATA", path.join(trustedHome, "AppData", "Local"));
    }
    const hasLocalOverrides = Object.keys(config.get<Record<string, string>>("runtime.env", {})).length > 0
      || config.get<string[]>("runtime.pathAdditions", []).length > 0
      || config.get<string[]>("runtime.copyEnv", []).length > 0;
    if (hasLocalOverrides) {
      logger.warn("Managed mode ignored local runtime environment and PATH overrides.");
    }
    if (removed > 0) logger.info("removed ambient credentials and process-injection settings from managed runtime tools", { count: removed });
    return environment;
  }

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

function setEnvironmentKey(environment: NodeJS.ProcessEnv, name: string, value: string): void {
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() === name.toUpperCase()) delete environment[key];
  }
  environment[name] = value;
}

function resolveStateRootPath(logger: OutputChannelLogger, managed: boolean, managedHome?: string): string {
  const configured = vscode.workspace.getConfiguration("drydock").get<string>("stateRoot", "").trim();
  if (managed && configured !== "") {
    logger.warn("Managed mode ignored the custom state root and is using the fixed local state location.");
    return path.join(managedHome ?? os.userInfo().homedir, ".drydock");
  }
  if (managed) return path.join(managedHome ?? os.userInfo().homedir, ".drydock");
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
