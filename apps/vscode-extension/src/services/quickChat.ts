/**
 * Quick chat (UX overhaul, P4): the zero-form path to an agent.
 *
 * One keystroke, one question, one chat. Everything the hub composer asks the
 * user to confirm, this command decides: the task is titled from the prompt,
 * the model is whatever was used last (or the first catalog entry), and the
 * window's own folders mount directly with no persisted workspace set. It
 * exists because the composer - however well prefilled - is still a form, and
 * "just start something" should never cost one.
 *
 * Nothing here is new protocol: it drives the same services the panel's
 * `chat.startSession` / `chat.sendTurn` handlers drive, in the same order
 * (start → link → baseline → detached first turn), so a quick chat is
 * indistinguishable from a composed one once it exists.
 */

import * as vscode from "vscode";
import type { Logger } from "@drydock/core";
import type { Backend, BackendReady } from "../compositionRoot.js";
import type { ChatWorkspaceContext } from "./isolatedRunService.js";
import { quickChatTaskTitle, resolveQuickChatModel } from "./quickChatShared.js";

/** Command id contributed in package.json; the architect owns the wiring. */
export const QUICK_CHAT_COMMAND = "drydock.quickChat";

/** Durable last-used model for quick chat (the `app_state` key/value table). */
const LAST_MODEL_KEY = "quickChat.lastModel";

/** Absolute fsPaths of this window's open file-scheme folders. */
function openFolderRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === "file")
    .map((folder) => folder.uri.fsPath);
}

export function registerQuickChat(backend: Backend, logger: Logger): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(QUICK_CHAT_COMMAND, async () => {
      if (!backend.available) {
        void vscode.window.showErrorMessage(backend.reason);
        return;
      }
      const prompt = await vscode.window.showInputBox({
        title: "Quick chat",
        prompt: "What should the agent do?",
        placeHolder: "Describe the work; a task is created from it",
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() === "" ? "A chat needs a prompt." : undefined)
      });
      // Esc (or an empty box) cancels outright: nothing is created.
      if (prompt === undefined || prompt.trim() === "") return;
      try {
        await runQuickChat(backend, logger, prompt.trim());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("quick chat failed", { error: message });
        void vscode.window.showErrorMessage(`Quick chat could not start: ${message}`);
      }
    })
  ];
}

async function runQuickChat(backend: BackendReady, logger: Logger, prompt: string): Promise<void> {
  const taskTitle = quickChatTaskTitle(prompt);
  const task = await backend.tasks.createTask(taskTitle);
  // Creating a task this way is also choosing it: the bench follows the spine.
  backend.activeTasks.set(task.taskId);

  const model = resolveQuickChatModel(
    backend.appState.getAppState(LAST_MODEL_KEY),
    backend.appService.listChatProviderCatalogs()
  );

  // The window's folders mount directly - no workspace set is created or
  // persisted. Session mount persistence already carries a resume through.
  let workspace: ChatWorkspaceContext | undefined;
  const roots = openFolderRoots();
  if (roots.length > 0) {
    try {
      workspace = await backend.workspaceReview.resolveWorkspaceSelection({ auto: true, mode: "implementation" }, roots);
    } catch (error) {
      // A policy-blocked folder should not sink the chat: start without mounts
      // and let the agent ask for access the normal way.
      logger.warn("quick chat could not mount the window folders", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const started = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "Drydock: starting quick chat…" },
    () => backend.appService.startChatSession(model, `${task.title} · chat 1`, workspace)
  );
  const sessionId = started.session.sessionId;
  await backend.tasks.link(task.taskId, { sessionId });
  if (workspace !== undefined) {
    try {
      await backend.workspaceReview.createSessionBaselines(sessionId, workspace.roots);
    } catch (error) {
      logger.warn("quick chat baseline creation failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  // Only a start that got this far is worth remembering.
  if (model !== undefined) {
    backend.appState.setAppState(LAST_MODEL_KEY, JSON.stringify(model));
  }

  // The rail is where the answer will appear, so focus it before the turn runs.
  await vscode.commands.executeCommand("drydock.chatRail.focus").then(undefined, () => undefined);

  // Detached first turn, exactly as the panel runs one: the command returns and
  // the transcript streams into the rail.
  void (async () => {
    try {
      await backend.workspaceReview.beginTurnBaselines(sessionId);
    } catch (error) {
      logger.warn("quick chat turn baseline capture failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    await backend.appService.sendChatTurn(sessionId, prompt, model);
  })().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("quick chat first turn failed", { sessionId, error: message });
    void vscode.window.showErrorMessage(`The quick chat started, but its first message failed: ${message}`);
  });
}
