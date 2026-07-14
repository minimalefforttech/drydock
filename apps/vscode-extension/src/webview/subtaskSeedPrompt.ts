/**
 * Seed-choice prompt (ADR 0014), the taskClonePolicyPrompt pattern: shown
 * before a MANUAL subtask start when the subtask has upstream dependencies
 * but no stored `seedMode` yet. The pick persists on the subtask, so later
 * manual starts AND auto-starts reuse it silently — automation never invents
 * a choice. Cancelling declines the start (accepted:false, like declining
 * the clone-policy prompt). Bulk `task.start` never prompts: unset stays
 * `local` (the classic behavior) until the user chooses.
 */

import * as vscode from "vscode";
import type { BackendReady } from "../compositionRoot.js";

export async function promptAndSaveSubtaskSeedMode(backend: BackendReady, subtaskId: string): Promise<boolean> {
  const subtask = await backend.subtasks.getSubtask(subtaskId);
  if (subtask === null) {
    return true; // let the orchestrator raise its readable NOT_FOUND
  }
  if (subtask.seedMode !== undefined) {
    return true; // stored choice wins silently
  }
  const dependencies = await backend.subtasks.listDependenciesForTask(subtask.taskId);
  const upstreamIds = dependencies
    .filter((edge) => edge.toSubtaskId === subtask.subtaskId)
    .map((edge) => edge.fromSubtaskId as string);
  if (upstreamIds.length === 0) {
    return true; // nothing upstream — nothing to choose
  }
  const unlanded = await backend.changesets.unlandedSubtaskIds(upstreamIds);
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: "Local HEAD",
        description: "Clone your current local snapshot (the classic behavior)",
        mode: "local" as const
      },
      {
        label: "Local HEAD + upstream changesets",
        description: `Also 3-way apply unlanded upstream output (${String(unlanded.size)}/${String(upstreamIds.length)} upstream subtask${upstreamIds.length === 1 ? "" : "s"} with changesets now)`,
        mode: "upstream" as const
      }
    ],
    {
      title: `Seed "${subtask.title}" from…`,
      placeHolder: "Stored on the subtask; auto-start reuses it. Toggle later from the card's ⎘ chip."
    }
  );
  if (pick === undefined) {
    return false; // user cancelled — decline the start
  }
  await backend.subtasks.updateSubtask(subtaskId, { seedMode: pick.mode });
  return true;
}
