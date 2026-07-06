/**
 * Command-palette surface for the isolated agent run.
 *
 * Every command is a thin delegation into IsolatedRunService; commands render to
 * the output channel while the control panel renders the same service through
 * webview messages. Commands stay registered even when the backend is
 * degraded so users get an actionable error instead of "command not found".
 */

import * as vscode from "vscode";
import { summarizeAgentEvent } from "@drydock/contracts";
import type { Backend } from "../compositionRoot.js";
import { ISOLATED_RUN_DEFAULT_PROMPT, type IsolatedRunService } from "../services/isolatedRunService.js";

export function registerIsolatedRunCommands(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  backend: Backend
): void {
  const requireBackend = (): IsolatedRunService | null => {
    if (!backend.available) {
      void vscode.window.showErrorMessage(backend.reason);
      return null;
    }
    return backend.appService;
  };

  context.subscriptions.push(vscode.commands.registerCommand("drydock.isolatedRun.start", async () => {
    const appService = requireBackend();
    if (!appService) return;
    const prompt = await vscode.window.showInputBox({
      title: "Isolated agent prompt",
      prompt: "Prompt to run inside a Docker Sandbox Codex runtime",
      value: ISOLATED_RUN_DEFAULT_PROMPT
    });
    if (!prompt) return;

    output.show(true);
    try {
      const outcome = await appService.startPromptRun(prompt, {
        onStarted: (isolation) => {
          output.appendLine(`Starting isolated runtime for ${isolation.workspaceDisplayPath} (network: ${isolation.network})`);
        }
      });
      output.appendLine(`Session ${outcome.sessionId} completed with cleanup=${outcome.cleanupStatus}`);
      for (const event of outcome.events) {
        const line = summarizeAgentEvent(event);
        output.appendLine(`${line.createdAt} ${line.eventType} ${line.summary}`);
      }
      vscode.window.showInformationMessage(`Isolated run completed (${String(outcome.events.length)} events).`);
    } catch (error) {
      reportFailure(output, "Isolated run failed", error);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("drydock.isolatedRun.appServerProbe", async () => {
    const appService = requireBackend();
    if (!appService) return;
    output.show(true);
    output.appendLine("Starting isolated app-server probe runtime");
    try {
      const outcome = await appService.runAppServerProbe();
      output.appendLine(`App-server probe status: ${outcome.probe.status}`);
      if (outcome.probe.threadId) output.appendLine(`App-server thread id: ${outcome.probe.threadId}`);
      if (outcome.probe.turnId) output.appendLine(`App-server turn id: ${outcome.probe.turnId}`);
      if (outcome.probe.error) output.appendLine(`App-server error: ${outcome.probe.error.message}`);
      for (const diagnostic of outcome.probe.diagnostics) {
        output.appendLine(`App-server diagnostic: ${diagnostic}`);
      }
      for (const diagnostic of outcome.cleanupDiagnostics) {
        output.appendLine(`App-server probe ${diagnostic}`);
      }
      vscode.window.showInformationMessage(`App-server probe: ${outcome.probe.status}`);
    } catch (error) {
      reportFailure(output, "App-server probe failed", error);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("drydock.isolatedRun.status", async () => {
    const appService = requireBackend();
    if (!appService) return;
    const runtimes = await appService.listRuntimes();
    output.show(true);
    output.appendLine(`Runtime inventory (${String(runtimes.length)} records)`);
    for (const runtime of runtimes) {
      output.appendLine(`${runtime.runtimeId} ${runtime.status} ${runtime.externalName}`);
    }
    vscode.window.showInformationMessage(`Runtime inventory has ${String(runtimes.length)} runtime record(s).`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("drydock.isolatedRun.stop", async () => {
    const appService = requireBackend();
    if (!appService) return;
    const runtimes = await appService.listActiveRuntimes();
    if (runtimes.length === 0) {
      vscode.window.showInformationMessage("No runtimes need cleanup.");
      return;
    }
    const pick = await vscode.window.showQuickPick(runtimes.map((runtime) => ({
      label: runtime.externalName,
      description: runtime.status,
      runtime
    })), { title: "Stop and remove runtime" });
    if (!pick) return;
    const cleanup = await appService.stopRuntime(pick.runtime.runtimeId, "force-remove");
    output.show(true);
    output.appendLine(`Cleanup ${pick.runtime.externalName}: ${cleanup.status} (${cleanup.diagnostics.join(", ")})`);
    vscode.window.showInformationMessage(`Runtime cleanup: ${cleanup.status}`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("drydock.panel.open", async () => {
    await vscode.commands.executeCommand("drydock.controlPanel.focus");
  }));
}

function reportFailure(output: vscode.OutputChannel, prefix: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  output.appendLine(`${prefix}: ${message}`);
  void vscode.window.showErrorMessage(message);
}
