import * as vscode from "vscode";
import type { CloneRepoPreflight } from "@drydock/core";
import type { BackendReady } from "../compositionRoot.js";

interface ProjectPick extends vscode.QuickPickItem {
  readonly projectId: string;
  readonly path: string;
}

/**
 * Native pre-start flow shared by both task surfaces. Returns false only when
 * the user cancels; validation errors throw and use the existing response path.
 */
export async function promptAndSaveTaskClonePolicy(backend: BackendReady, taskId: string): Promise<boolean> {
  const [task, summaries, workspaceState] = await Promise.all([
    backend.tasks.getTask(taskId),
    backend.tasks.listTaskSummaries(),
    backend.workspaceReview.getPolicyState()
  ]);
  if (task === null) {
    throw new Error(`Task ${taskId} was not found.`);
  }
  const summary = summaries.find((candidate) => candidate.taskId === taskId);
  if (summary === undefined) {
    throw new Error(`Task ${taskId} was not found.`);
  }
  const linkedSetIds = [...new Set(summary.linkedWorkspaceSetIds)];
  if (linkedSetIds.length !== 1) {
    throw new Error(`Task ${taskId} must link exactly one workspace set before it can start isolated clone work; found ${String(linkedSetIds.length)}. Link one set, then try again.`);
  }
  const workspaceSetId = linkedSetIds[0] as string;
  const set = workspaceState.workspaceSets.find((candidate) => candidate.workspaceSetId === workspaceSetId);
  if (set === undefined) {
    throw new Error(`Task ${taskId} links missing workspace set ${workspaceSetId}. Relink the task to an existing set.`);
  }
  if (set.members.length === 0) {
    throw new Error(`Workspace set ${set.name} has no project directories to clone.`);
  }

  const currentMemberIds = new Set(set.members.map((member) => member.projectId));
  const savedProjectIds = task.clonePolicy?.workspaceSetId === workspaceSetId
    ? (task.clonePolicy.projectIds as readonly string[]).filter((projectId) => currentMemberIds.has(projectId))
    : [];
  const savedSelection = new Set(savedProjectIds.length > 0 ? savedProjectIds : currentMemberIds);
  const picks: ProjectPick[] = set.members.map((member) => ({
    label: member.name,
    description: member.displayPath,
    detail: "Clone this project into each subtask's independent workspace",
    projectId: member.projectId,
    path: member.displayPath,
    picked: savedSelection.has(member.projectId)
  }));
  const selected = await vscode.window.showQuickPick(picks, {
    canPickMany: true,
    title: `Clone projects for “${task.title}”`,
    placeHolder: "Select one or more project directories (all selected by default)",
    ignoreFocusOut: true
  });
  if (selected === undefined) return false;
  if (selected.length === 0) {
    throw new Error("Select at least one project directory for the task's clone workspace.");
  }

  const preflights = await Promise.all(selected.map(async (project) => ({
    project,
    preflight: await backend.appService.preflightCloneRepo(project.path)
  })));
  const nonGit = preflights.filter(({ preflight }) => !preflight.isGitRepo);
  if (nonGit.length > 0) {
    throw new Error(`Clone mode requires git repositories. These selected directories are not git work trees: ${nonGit.map(({ project }) => project.label).join(", ")}.`);
  }

  const dirty = preflights.filter(({ preflight }) => preflight.dirty);
  let dirtyHandling: "carry" | "fresh" = task.clonePolicy?.dirtyHandling ?? "fresh";
  if (dirty.length > 0) {
    const choice = await promptForDirtyHandling(dirty);
    if (choice === undefined) return false;
    dirtyHandling = choice;
  }

  await backend.tasks.saveClonePolicy(taskId, {
    workspaceSetId,
    // Preserve workspace-set order regardless of click order.
    projectIds: set.members.filter((member) => selected.some((pick) => pick.projectId === member.projectId)).map((member) => member.projectId),
    dirtyHandling
  });
  return true;
}

async function promptForDirtyHandling(
  entries: readonly { readonly project: ProjectPick; readonly preflight: CloneRepoPreflight }[]
): Promise<"carry" | "fresh" | undefined> {
  const carry = "Carry local changes";
  const fresh = "Fresh committed checkout";
  const lines = entries.map(({ project, preflight }) =>
    `${project.label}: ${String(preflight.trackedChanges)} tracked, ${String(preflight.untrackedFiles)} untracked`
  );
  const choice = await vscode.window.showWarningMessage(
    `${String(entries.length)} selected repositor${entries.length === 1 ? "y has" : "ies have"} local changes.`,
    {
      modal: true,
      detail: `${lines.join("\n")}\n\nCarry copies these changes into every subtask clone. Fresh uses each repository's current local committed HEAD only; it does not fetch or pull from a remote.`
    },
    carry,
    fresh
  );
  if (choice === carry) return "carry";
  if (choice === fresh) return "fresh";
  return undefined;
}
