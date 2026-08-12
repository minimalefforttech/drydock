/**
 * Native chrome behind the left rail (UX overhaul, P1).
 *
 * The rail's view-title actions are real VS Code commands so they get native
 * placement, keybindings and the command palette for free. Board / Agents /
 * Planner already have commands; these two are the rail's own.
 */

import * as vscode from "vscode";
import type { Logger } from "@drydock/core";
import type { Backend } from "../compositionRoot.js";

/**
 * Registers `drydock.rail.newTask` (title → task → spine) and
 * `drydock.rail.resetWorkspacePrompt` (undo a "Don't ask for this task").
 * Both no-op with a readable message when the backend is unavailable.
 */
export function registerRailCommands(backend: Backend, logger: Logger): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("drydock.rail.newTask", async () => {
      if (!backend.available) {
        void vscode.window.showErrorMessage(backend.reason);
        return;
      }
      const title = await vscode.window.showInputBox({
        title: "New task",
        prompt: "What is this task about?",
        placeHolder: "Task title",
        validateInput: (value) => (value.trim() === "" ? "A task needs a title." : undefined)
      });
      if (title === undefined || title.trim() === "") return;
      try {
        const record = await backend.tasks.createTask(title.trim());
        // Creating a task is also choosing it: the whole bench follows the spine.
        backend.activeTasks.set(record.taskId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("rail new task failed", { error: message });
        void vscode.window.showErrorMessage(`Could not create the task: ${message}`);
      }
    }),
    vscode.commands.registerCommand("drydock.rail.resetWorkspacePrompt", async () => {
      if (!backend.available) {
        void vscode.window.showErrorMessage(backend.reason);
        return;
      }
      // The toast's "Don't ask for this task" is durable, so it needs a way
      // back; until the hub's task menu exists (P3) this command is it.
      const silenced = (await backend.tasks.listTaskSummaries()).filter((task) => task.dontAskWorkspace === true);
      if (silenced.length === 0) {
        void vscode.window.showInformationMessage("No task is hiding its workspace prompt.");
        return;
      }
      const picked = await vscode.window.showQuickPick(
        silenced.map((task) => ({ label: task.title, description: "re-enable the workspace prompt", taskId: task.taskId })),
        { title: "Re-enable the workspace prompt for…" }
      );
      if (picked === undefined) return;
      await backend.tasks.updateTask(picked.taskId, { dontAskWorkspace: false });
    })
  ];
}
