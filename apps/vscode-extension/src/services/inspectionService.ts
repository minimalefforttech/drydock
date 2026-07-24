/**
 * Inspection workspaces (background-lane plan D6): human-only, host-side
 * views of a finished subtask's tree, built entirely from durable data -
 * never the sandbox's live clone (which may still receive revision turns and
 * dies with its session).
 *
 * Two flavors, chosen per repo:
 *  - worktree: `git worktree add` on the real repo at the landed task branch
 *    (instant, git-native; removal never deletes the branch). ADR 0004's
 *    worktree rejection targets SANDBOX workspaces; nothing here is ever
 *    mounted into one.
 *  - copy: a fresh clone detached at the capture's origin commit with the
 *    captured patch applied and left UNCOMMITTED, so vanilla git UI shows
 *    exactly what the worker produced.
 *
 * The workspace lives under its own root (<stateRoot>/inspect), deliberately
 * OUTSIDE the swept tmp area: it is cleaned by a human decision, never by a
 * timer racing an open window. The opener must never auto-trust it - the
 * tree is worker-authored content and VS Code's Restricted Mode is the
 * proportional friction (B4) between that content and host execution.
 *
 * No `vscode` imports: the extension layer opens the returned folder.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { TaskClonePolicy, WorkTaskRecord } from "@drydock/contracts";
import type { Logger } from "@drydock/core";
import type { TempWorkspaceStore } from "@drydock/artifacts";
import { repoRootsByCloneName } from "./repoNameMap.js";

export interface InspectionCloneSyncPort {
  preflightRepo(root: string): Promise<{ readonly isGitRepo: boolean; readonly localRepoPath: string }>;
  materializeInspectionClone(input: {
    readonly localRepoPath: string;
    readonly cloneParentDir: string;
    readonly name: string;
    readonly originCommit?: string;
    readonly patch: string;
  }): Promise<{ readonly clonePath: string; readonly exactBase: boolean }>;
  addInspectionWorktree(localRepoPath: string, worktreePath: string, branch: string): Promise<void>;
}

export interface InspectionTaskPort {
  getTask(taskId: string): Promise<WorkTaskRecord | null>;
}

export interface InspectionPolicyPort {
  requireClonePolicy(taskId: string): Promise<TaskClonePolicy>;
}

export interface InspectionWorkspaceResolverPort {
  resolveTaskCloneWorkspace(policy: TaskClonePolicy): Promise<{ readonly roots: readonly string[] }>;
}

export interface InspectionChangesetPort {
  inspectionPatchesFor(subtaskId: string): Promise<readonly {
    readonly repoName: string;
    readonly patch: string;
    readonly originCommit?: string;
    readonly exact: boolean;
  }[]>;
}

export interface InspectionSubtaskPort {
  getSubtask(subtaskId: string): Promise<{ readonly title: string } | null>;
}

export interface InspectionServiceOptions {
  readonly logger: Logger;
  /** Dedicated store rooted OUTSIDE the swept tmp area (<stateRoot>/inspect). */
  readonly workspaceStore: TempWorkspaceStore;
  readonly cloneSync: InspectionCloneSyncPort;
  readonly tasks: InspectionTaskPort;
  readonly policies: InspectionPolicyPort;
  readonly workspaces: InspectionWorkspaceResolverPort;
  readonly changesets: InspectionChangesetPort;
  readonly subtasks: InspectionSubtaskPort;
  /**
   * Heals a stale landed-branch badge (data audit F2): called when the
   * recorded landedBranch no longer exists in a repo (the user deleted it),
   * so the task stops claiming a landing that is gone. Best-effort.
   */
  readonly onLandedBranchMissing?: (taskId: string) => Promise<void>;
}

export interface InspectionRepoEntry {
  readonly name: string;
  readonly flavor: "worktree" | "copy";
  /** worktree flavor: the branch checked out. */
  readonly branch?: string;
  /** copy flavor: false = origin was gone, 3-way fallback on current HEAD. */
  readonly exactBase?: boolean;
}

export interface MaterializedInspection {
  /** The folder to open (repos nested one level under it). */
  readonly workspaceRoot: string;
  readonly markerPath: string;
  readonly repos: readonly InspectionRepoEntry[];
  readonly taskTitle: string;
  readonly subtaskTitle: string;
}

/** Marker file name the extension activation looks for at a folder root. */
export const INSPECTION_MARKER = ".drydock-inspection.json";

export class InspectionService {
  constructor(private readonly options: InspectionServiceOptions) {}

  /**
   * Builds an inspection workspace for one finished subtask. Requires a
   * captured changeset set (Review entry writes it); an uncaptured subtask
   * has nothing durable to show and is refused honestly.
   */
  async materialize(taskId: string, subtaskId: string): Promise<MaterializedInspection> {
    const task = await this.options.tasks.getTask(taskId);
    if (task === null) throw new Error(`Task ${taskId} was not found.`);
    const subtask = await this.options.subtasks.getSubtask(subtaskId);
    if (subtask === null) throw new Error(`Subtask ${subtaskId} was not found.`);
    const patches = await this.options.changesets.inspectionPatchesFor(subtaskId);
    if (patches.length === 0) {
      throw new Error("Nothing captured for this subtask yet - it enters Review (and captures durably) when its run completes.");
    }

    // Repo-name -> local path, derived EXACTLY like prepareClones derives
    // clone names (basename, deduped in root order) so capture rows match.
    const policy = await this.options.policies.requireClonePolicy(taskId);
    const { roots } = await this.options.workspaces.resolveTaskCloneWorkspace(policy);
    const rootByName = await repoRootsByCloneName(this.options.cloneSync, roots);

    const workspace = await this.options.workspaceStore.createWorkspace("inspect");
    const reposDir = path.join(workspace.workspacePath, "repos");
    const branch = task.landedBranch ?? task.branchName;
    const entries: InspectionRepoEntry[] = [];
    for (const patch of patches) {
      const localRepoPath = rootByName.get(patch.repoName);
      if (localRepoPath === undefined) {
        throw new Error(`Captured repo "${patch.repoName}" is not in the task's current clone policy; update the policy or re-run the subtask.`);
      }
      let entry: InspectionRepoEntry | undefined;
      if (task.handoffMode === "branch" && branch !== undefined) {
        try {
          await this.options.cloneSync.addInspectionWorktree(localRepoPath, path.join(reposDir, patch.repoName), branch);
          entry = { name: patch.repoName, flavor: "worktree", branch };
        } catch (error) {
          // The branch has not landed in this repo (yet) - the durable copy
          // flavor always works; say why we fell back.
          const message = error instanceof Error ? error.message : String(error);
          this.options.logger.info("inspection worktree unavailable; materializing a copy", {
            repo: patch.repoName,
            branch,
            error: message
          });
          // A RECORDED landing whose branch vanished means the user deleted
          // it - heal the stale badge instead of claiming it forever.
          if (task.landedBranch !== undefined && branch === task.landedBranch && message.includes("does not exist")) {
            await this.options.onLandedBranchMissing?.(taskId).catch(() => undefined);
          }
        }
      }
      if (entry === undefined) {
        const made = await this.options.cloneSync.materializeInspectionClone({
          localRepoPath,
          cloneParentDir: reposDir,
          name: patch.repoName,
          ...(patch.originCommit === undefined ? {} : { originCommit: patch.originCommit }),
          patch: patch.patch
        });
        entry = { name: patch.repoName, flavor: "copy", exactBase: made.exactBase };
      }
      entries.push(entry);
    }

    const markerPath = path.join(workspace.workspacePath, INSPECTION_MARKER);
    await writeFile(markerPath, `${JSON.stringify({
      taskId,
      subtaskId,
      taskTitle: task.title,
      subtaskTitle: subtask.title,
      repos: entries,
      createdAt: new Date().toISOString(),
      note: "Human-only inspection workspace. Edits here are not synced back; keep tweaks as review comments or Export Patch."
    }, null, 2)}\n`, "utf8");

    return {
      workspaceRoot: workspace.workspacePath,
      markerPath,
      repos: entries,
      taskTitle: task.title,
      subtaskTitle: subtask.title
    };
  }
}
