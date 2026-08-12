/**
 * The vscode adapter behind the workspace-mismatch toast (UX overhaul, P1).
 *
 * Kept separate from the decision logic in `workspaceMismatch.ts` so that file
 * stays vscode-free and unit-testable. Nothing here decides anything: it reads
 * the window's folders, shows a non-modal notification, and replaces the
 * folder list when the user asks for it.
 */

import * as vscode from "vscode";
import type { Logger } from "@drydock/core";
import type { Backend } from "../compositionRoot.js";
import { registerWorkspaceMismatchPrompt, type WorkspaceMismatchHostPort } from "./workspaceMismatch.js";

/**
 * One-line wiring for `extension.ts`: subscribes the mismatch prompt to this
 * backend's spine. Returns a no-op disposable when the backend is unavailable
 * (nothing to follow, nothing to prompt about).
 */
export function registerWorkspaceMismatchForBackend(backend: Backend, logger: Logger): { dispose(): void } {
  if (!backend.available) return { dispose: () => undefined };
  return registerWorkspaceMismatchPrompt({
    bus: backend.bus,
    tasks: {
      listTaskSummaries: () => backend.tasks.listTaskSummaries(),
      setDontAskWorkspace: async (taskId: string) => {
        await backend.tasks.updateTask(taskId, { dontAskWorkspace: true });
      }
    },
    workspaces: backend.workspaceReview,
    host: createWorkspaceMismatchHost(),
    logger
  });
}

export function createWorkspaceMismatchHost(): WorkspaceMismatchHostPort {
  return {
    currentRoots(): readonly string[] {
      return (vscode.workspace.workspaceFolders ?? [])
        .filter((folder) => folder.uri.scheme === "file")
        .map((folder) => folder.uri.fsPath);
    },
    async prompt(message: string, actions: readonly string[]): Promise<string | undefined> {
      // Non-modal by design: the mismatch is a convenience nudge, never a gate.
      return vscode.window.showInformationMessage(message, ...actions);
    },
    async applyRoots(roots: readonly string[]): Promise<void> {
      // Replace-all. A window that had exactly one folder (or none) reloads -
      // VS Code's own behaviour for that transition; the prompt says so.
      const added = roots.map((root) => ({ uri: vscode.Uri.file(root) }));
      const current = vscode.workspace.workspaceFolders ?? [];
      const applied = vscode.workspace.updateWorkspaceFolders(0, current.length, ...added);
      if (!applied) {
        throw new Error("VS Code refused the workspace folder change.");
      }
      await Promise.resolve();
    }
  };
}
