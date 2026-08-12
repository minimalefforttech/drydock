/**
 * Extension entrypoint.
 *
 * Composes the backend once, then wires the two presentation surfaces -
 * command palette and control panel webview - as thin delegations over the
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
import { ChatRailViewProvider } from "./webview/chatRailViewProvider.js";
import { ControlPanelProvider } from "./webview/controlPanelProvider.js";
import { RailViewProvider, RAIL_VIEW_TYPES, type RailViewKind } from "./webview/railViewProvider.js";
import { TaskHubPanelProvider } from "./webview/taskHubPanelProvider.js";
import { ConfigurePanelProvider } from "./webview/configurePanelProvider.js";
import { createMcpProjectOverlayReader } from "./services/mcpProjectOverlay.js";
import { registerRailCommands } from "./webview/railCommands.js";
import { registerQuickChat } from "./services/quickChat.js";
import { registerWorkspaceMismatchForBackend } from "./services/workspaceMismatchHost.js";
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
import { CodeReviewPanelProvider } from "./webview/codeReviewPanelProvider.js";
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
  // Project MCP servers: `.drydock/mcp.json` merges read-only into the
  // Configure panel with `project` provenance, mirroring the recipe packs.
  const mcpProjectOverlays = createMcpProjectOverlayReader(
    policyWorkspaceRoots(".drydock/mcp.json"),
    logger,
    () => vscode.workspace.isTrusted,
    policyOverlayFile
  );
  // Run-slot budget (ADR 0015), resolved live: an explicit setting wins;
  // 0/absent derives "auto (N)" from machine spec - half the cores, one run
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
  // ADR 0017: studio-registered prototype themes ({name, cssPath}), loaded at
  // activation; unreadable entries are skipped with a warning, never fatal.
  const prototypeThemes: { name: string; css: string }[] = [];
  for (const entry of vscode.workspace.getConfiguration("drydock").get<readonly { name?: string; cssPath?: string }[]>("prototypeThemes", [])) {
    if (typeof entry.name !== "string" || typeof entry.cssPath !== "string") continue;
    try {
      const css = await vscode.workspace.fs.readFile(vscode.Uri.file(entry.cssPath));
      prototypeThemes.push({ name: entry.name, css: Buffer.from(css).toString("utf8") });
    } catch {
      logger.warn("prototype theme unreadable; skipped", { name: entry.name, cssPath: entry.cssPath });
    }
  }
  // MCP passthrough: a host .mcp.json validated at activation, written into
  // each session's /workspace before its first turn (claude transports).
  let mcpConfigJson: string | undefined;
  const mcpConfigPath = vscode.workspace.getConfiguration("drydock").get<string>("mcp.configPath", "");
  if (mcpConfigPath.length > 0) {
    try {
      const raw = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(mcpConfigPath))).toString("utf8");
      JSON.parse(raw);
      mcpConfigJson = raw;
    } catch (error) {
      logger.warn("drydock.mcp.configPath unreadable or not valid JSON; MCP passthrough disabled", {
        mcpConfigPath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  // Studio-level standing instructions appended to every session briefing.
  let teamInstructions: string | undefined;
  const teamInstructionsPath = vscode.workspace.getConfiguration("drydock").get<string>("teamInstructionsPath", "");
  if (teamInstructionsPath.length > 0) {
    try {
      teamInstructions = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(teamInstructionsPath))).toString("utf8").slice(0, 8_000);
    } catch {
      logger.warn("drydock.teamInstructionsPath unreadable; skipped", { teamInstructionsPath });
    }
  }
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
    autoAnswerQuestionsEnabled,
    prototypeThemes,
    ...(mcpConfigJson === undefined ? {} : { mcpConfigJson }),
    ...(teamInstructions === undefined ? {} : { teamInstructions }),
    // Glob→tag rules extending the shipped defaults (memory tag selection).
    memoryTagRules: vscode.workspace.getConfiguration("drydock").get("memory.tagRules", []),
    // ADR 0022: what the isolation probes attempt, where the package mirror
    // lives, and which suite the manual run executes. All three are personal
    // machine-scope settings; absent means the product says so rather than
    // inventing a green probe or an unattributable run.
    validationProbeConfig: vscode.workspace.getConfiguration("drydock").get("validation.probeConfig"),
    validationMirrorRoot: vscode.workspace.getConfiguration("drydock").get<string>("validation.mirrorRoot", ""),
    validationDefaultProfile: vscode.workspace.getConfiguration("drydock").get("validation.defaultProfile"),
    // `vscode-secret:<provider>` API keys live in the platform secret store
    // (OS keychain via VS Code SecretStorage); values never reach the webview,
    // logs, or the sqlite stores.
    providerSecrets: {
      has: async (providerId) => (await context.secrets.get(`drydock.providerKey.${providerId}`)) !== undefined,
      get: async (providerId) => context.secrets.get(`drydock.providerKey.${providerId}`),
      set: async (providerId, value) => { await context.secrets.store(`drydock.providerKey.${providerId}`, value); },
      delete: async (providerId) => { await context.secrets.delete(`drydock.providerKey.${providerId}`); }
    }
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

  const panel = new ControlPanelProvider(backend, logger);
  const chatRail = new ChatRailViewProvider(context.extensionUri, panel, backend, logger);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(ChatRailViewProvider.viewType, chatRail));
  context.subscriptions.push(chatRail);
  for (const kind of ["tasks", "recents", "workspaces"] as const satisfies readonly RailViewKind[]) {
    const rail = new RailViewProvider(context.extensionUri, panel, kind, backend, logger);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(RAIL_VIEW_TYPES[kind], rail), rail);
  }
  context.subscriptions.push(...registerRailCommands(backend, logger));
  context.subscriptions.push(...registerQuickChat(backend, logger));
  context.subscriptions.push(registerWorkspaceMismatchForBackend(backend, logger));
  const taskHubPanel = new TaskHubPanelProvider(context.extensionUri, panel, backend, logger);
  context.subscriptions.push(taskHubPanel);
  context.subscriptions.push(vscode.commands.registerCommand("drydock.taskHub.open", async (taskId?: unknown) => {
    if (!backend.available) {
      void vscode.window.showErrorMessage(backend.reason);
      return;
    }
    await taskHubPanel.open(typeof taskId === "string" ? taskId : undefined);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("drydock.taskHub.back", () => taskHubPanel.back()));
  // ADR 0022 F2: manual entry points feed the same queue and produce the same
  // chip. The palette validates the ACTIVE task's newest chat, because that is
  // the session whose changeset a developer means by "run validation".
  context.subscriptions.push(vscode.commands.registerCommand("drydock.validation.run", async () => {
    if (!backend.available) {
      void vscode.window.showErrorMessage(backend.reason);
      return;
    }
    const validation = backend.validation;
    if (validation === undefined) {
      void vscode.window.showErrorMessage(
        "Validation runtimes need a Windows host with Hyper-V and OpenSSH; this machine cannot run them."
      );
      return;
    }
    const sessions = await backend.appService.listChatSessions(50);
    const activeTaskId = backend.activeTasks.get();
    const linked = activeTaskId === null
      ? new Set<string>()
      : new Set((await backend.tasks.listTaskSummaries())
          .filter((task) => task.taskId === activeTaskId)
          .flatMap((task) => task.linkedSessionIds));
    const candidate = sessions.find((session) => linked.has(session.sessionId)) ?? sessions[0];
    if (candidate === undefined) {
      void vscode.window.showInformationMessage("Start a chat first - validation runs against a session's changeset.");
      return;
    }
    try {
      const result = await validation.runForSession(candidate.sessionId);
      void vscode.window.showInformationMessage(result.message);
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }));
  const configurePanel = new ConfigurePanelProvider(context.extensionUri, backend, logger, mcpProjectOverlays, plannerAspectOverlays);
  context.subscriptions.push(configurePanel);
  context.subscriptions.push(vscode.commands.registerCommand("drydock.configure.open", async () => {
    await configurePanel.open();
  }));
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
    const startGuide = typeof options === "object" && options !== null
      && (options as { readonly startGuide?: unknown }).startGuide === true;
    if (!backend.available && !startGuide) {
      void vscode.window.showErrorMessage(backend.reason);
      return;
    }
    let resolvedId = typeof taskId === "string" ? taskId : startGuide ? "demo-task-onboarding" : undefined;
    let title = startGuide && !backend.available ? "Demo task" : "Task";
    const tasks = backend.available ? await backend.tasks.listTaskSummaries() : [];
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
    await taskReviewPanels.open(resolvedId, title, startGuide);
  }));
  // EXPERIMENTAL terminal attach: open an interactive shell inside a running
  // sandbox (`sbx exec <name> /bin/sh` as a VS Code terminal). Verification
  // spike: whether the sbx CLI allocates a usable TTY this way is exactly what
  // this command exists to test - failures print in the terminal itself.
  context.subscriptions.push(vscode.commands.registerCommand("drydock.session.attachTerminal", async (sessionId?: unknown) => {
    if (!backend.available) {
      void vscode.window.showErrorMessage(backend.reason);
      return;
    }
    const running = (await backend.appService.listRuntimes()).filter((runtime) => runtime.status === "running");
    if (running.length === 0) {
      void vscode.window.showInformationMessage("No running sandboxes to attach to - start a chat first.");
      return;
    }
    // Invoked with a sessionId (Edit-tab menu / panels) → that session's
    // sandbox directly; palette invocation quick-picks when several run.
    const bySession = typeof sessionId === "string"
      ? running.find((runtime) => runtime.sessionId === sessionId)
      : undefined;
    if (typeof sessionId === "string" && bySession === undefined) {
      void vscode.window.showInformationMessage("This chat has no running sandbox - resume it first.");
      return;
    }
    const pick = bySession !== undefined
      ? { runtime: bySession }
      : running.length === 1
        ? { runtime: running[0] }
        : await vscode.window.showQuickPick(
            running.map((runtime) => ({ label: runtime.externalName, description: runtime.startedAt, runtime })),
            { placeHolder: "Attach a shell to which running sandbox?" }
          );
    if (pick?.runtime === undefined) return;
    const confirmed = await vscode.window.showWarningMessage(
      `Open an interactive shell inside "${pick.runtime.externalName}"? You act with the agent's own permissions in its sandbox (host mounts included).`,
      { modal: true },
      "Attach shell"
    );
    if (confirmed !== "Attach shell") return;
    const sbxPath = backend.appService.getSbxPath();
    if (sbxPath === null) {
      void vscode.window.showErrorMessage("The sandbox CLI path is not configured on this host.");
      return;
    }
    // `sbx exec -i` (stdin attached, NO pseudo-TTY) is the mode proven to move
    // bytes both ways against the real sbx CLI; `-t` under VS Code's conpty
    // produced no output. `sh -i` still prints prompts without a TTY. Line
    // editing is the terminal's own (line-buffered); full PTY support is the
    // recorded follow-up. The banner sets expectations before the first byte.
    const terminal = vscode.window.createTerminal({
      name: `sandbox: ${pick.runtime.externalName}`,
      shellPath: sbxPath,
      shellArgs: ["exec", "-i", pick.runtime.externalName, "/bin/sh", "-i"],
      message: [
        `\x1b[1mDrydock sandbox shell - ${pick.runtime.externalName}\x1b[0m`,
        "You are inside the agent's container with its permissions (host mounts included).",
        "Line-buffered mode: type a command and press Enter; interactive TUIs (vim, top) will not render.",
        "The agent's workspace is under /workspace. Type `exit` to detach."
      ].join("\r\n")
    });
    terminal.show();
  }));
  // Apply a Drydock-exported .patch file to an open folder - the receive half
  // of carrying changesets between machines. Human-driven end to end: pick the
  // file, pick the target folder, confirm the modal; applies with
  // `git apply --3way --binary` and NEVER commits or pushes.
  context.subscriptions.push(vscode.commands.registerCommand("drydock.clone.applyPatch", async () => {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === "file");
    if (folders.length === 0) {
      void vscode.window.showErrorMessage("Open the target repository folder first, then run Apply Patch again.");
      return;
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "Patch files": ["patch", "diff"] },
      title: "Select the Drydock-exported .patch file"
    });
    const patchUri = picked?.[0];
    if (patchUri === undefined) return;
    const folder = folders.length === 1
      ? folders[0]
      : await vscode.window.showQuickPick(
          folders.map((candidate) => ({ label: candidate.name, description: candidate.uri.fsPath, folder: candidate })),
          { placeHolder: "Apply the patch to which open folder?" }
        ).then((pick) => pick?.folder);
    if (folder === undefined) return;
    const confirmed = await vscode.window.showWarningMessage(
      `Apply ${patchUri.fsPath} to "${folder.name}"? This edits your working tree (three-way merge; conflicts leave markers). Nothing is committed.`,
      { modal: true },
      "Apply patch"
    );
    if (confirmed !== "Apply patch") return;
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve) => {
      execFile(
        "git",
        ["apply", "--3way", "--binary", patchUri.fsPath],
        { cwd: folder.uri.fsPath, maxBuffer: 32 * 1024 * 1024 },
        (error, _stdout, stderr) => {
          if (error) {
            void vscode.window.showErrorMessage(`git apply failed: ${String(stderr || error.message).slice(0, 400)}`);
          } else {
            void vscode.window.showInformationMessage(`Patch applied to "${folder.name}" - review the working tree, then commit as usual.`);
          }
          resolve();
        }
      );
    });
  }));
  // Code Review panel (in-panel PR-style review, docs/design/code-review-panel.md):
  // one panel per task, opened from the command palette or the sidebar relay.
  const codeReviewPanels = new CodeReviewPanelProvider(context.extensionUri, backend, logger);
  context.subscriptions.push(vscode.commands.registerCommand("drydock.codeReview.open", async (taskId?: unknown) => {
    if (!backend.available) {
      void vscode.window.showErrorMessage(backend.reason);
      return;
    }
    let resolvedId = typeof taskId === "string" ? taskId : undefined;
    let title = "Task";
    const tasks = await backend.tasks.listTaskSummaries();
    if (resolvedId === undefined) {
      const pick = await vscode.window.showQuickPick(
        tasks.map((task) => ({ label: task.title, description: task.state, taskId: task.taskId })),
        { placeHolder: "Select a task to code-review" }
      );
      if (pick === undefined) return;
      resolvedId = pick.taskId;
      title = pick.label;
    } else {
      title = tasks.find((task) => task.taskId === resolvedId)?.title ?? title;
    }
    await codeReviewPanels.open(resolvedId, title);
  }));
  // Task Board: single global panel, so the command takes no arguments - it
  // opens (or reveals) the one instance. The control panel's taskBoard.open
  // relay routes here.
  const taskBoardPanel = new TaskBoardPanelProvider(context.extensionUri, backend, logger);
  context.subscriptions.push(vscode.commands.registerCommand("drydock.taskBoard.open", async (options?: unknown) => {
    const startGuide = typeof options === "object" && options !== null
      && (options as { readonly startGuide?: unknown }).startGuide === true;
    if (!backend.available && !startGuide) {
      void vscode.window.showErrorMessage(backend.reason);
      return;
    }
    await taskBoardPanel.open(startGuide);
  }));
  // Agents (ADR 0013): single global fleet panel over every session across
  // every task. The control panel's agents.open relay routes here; fleet row
  // clicks navigate back to the sidebar via the provider's showSession.
  const agentsPanel = new AgentsPanelProvider(context.extensionUri, backend, logger, (sessionId, nodeId) => {
    panel.showSession(sessionId, nodeId);
  });
  context.subscriptions.push(vscode.commands.registerCommand("drydock.agents.open", async (options?: unknown) => {
    const startGuide = typeof options === "object" && options !== null
      && (options as { readonly startGuide?: unknown }).startGuide === true;
    if (!backend.available && !startGuide) {
      void vscode.window.showErrorMessage(backend.reason);
      return;
    }
    await agentsPanel.open(startGuide);
  }));
  // Planner (ADR 0012): the editor panel owns intake, outputs, and artifact
  // review. It is the only plan surface since the Control Panel's Plan tab
  // retired, so selection lives entirely inside the panel.
  const plannerPanel = new PlannerPanelProvider(context.extensionUri, backend, logger);
  context.subscriptions.push(vscode.commands.registerCommand("drydock.planner.open", async (planId?: unknown, options?: unknown) => {
    const startGuide = typeof options === "object" && options !== null
      && (options as { readonly startGuide?: unknown }).startGuide === true;
    if (!backend.available && !startGuide) {
      void vscode.window.showErrorMessage(backend.reason);
      return;
    }
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
 * defaults are omitted only when `disableDefaultDeniedPaths` is explicitly set -
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
