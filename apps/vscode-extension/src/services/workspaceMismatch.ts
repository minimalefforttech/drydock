/**
 * Workspace-mismatch prompt (UX overhaul, P1).
 *
 * When the active-task spine moves, the task's workspace set may not match the
 * folders this window has open. Sandbox mounts never depend on the window's
 * folders - this is a convenience nudge only, so it is a NON-BLOCKING toast
 * that can always be ignored, and it asks at most once per task per window
 * session (or never again, if the user says so).
 *
 * Every host capability arrives as an injected port (folders, toast,
 * updateWorkspaceFolders, task/workspace reads) so the decision rules below
 * are unit-testable without vscode. The thin vscode adapter lives in
 * `workspaceMismatchHost.ts`.
 */

import { hostPathIdentityKey, type Logger, type ProductBusEvent } from "@drydock/core";
import type { WorkspacePolicyState, WorkTaskSummary } from "@drydock/contracts";

/** Toast actions, in the order the toast offers them. */
export const SWITCH_FOLDERS_ACTION = "Switch folders";
export const KEEP_CURRENT_ACTION = "Keep current";
export const DONT_ASK_ACTION = "Don't ask for this task";

export interface WorkspaceSwitchInput {
  readonly taskId: string;
  /** Absolute roots of the task's workspace set; empty = the task pins no set. */
  readonly setRoots: readonly string[];
  /** Absolute roots of the folders open in this window. */
  readonly windowRoots: readonly string[];
  /** The task's persisted "don't ask for this task" flag. */
  readonly dontAsk?: boolean;
  /** Tasks already asked in THIS window session. */
  readonly askedTaskIds: ReadonlySet<string>;
}

export type WorkspaceSwitchDecision =
  | { readonly prompt: true }
  | { readonly prompt: false; readonly reason: "no-set" | "opted-out" | "match" | "already-asked" };

/**
 * Whether switching to this task should raise the mismatch toast. Pure: the
 * caller resolves the roots and remembers what it already asked.
 */
export function shouldPromptWorkspaceSwitch(input: WorkspaceSwitchInput): WorkspaceSwitchDecision {
  if (input.setRoots.length === 0) return { prompt: false, reason: "no-set" };
  if (input.dontAsk === true) return { prompt: false, reason: "opted-out" };
  if (sameRootSet(input.setRoots, input.windowRoots)) return { prompt: false, reason: "match" };
  if (input.askedTaskIds.has(input.taskId)) return { prompt: false, reason: "already-asked" };
  return { prompt: true };
}

/**
 * Normalized SET equality: order and duplicates are irrelevant, and paths
 * compare by host identity (case/separator/symlink normalization), so
 * `C:\Repos\api` and `c:/repos/api/` are the same root.
 */
export function sameRootSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a.map(hostPathIdentityKey));
  const right = new Set(b.map(hostPathIdentityKey));
  if (left.size !== right.size) return false;
  for (const key of left) {
    if (!right.has(key)) return false;
  }
  return true;
}

export interface WorkspaceMismatchTaskPort {
  listTaskSummaries(): Promise<readonly WorkTaskSummary[]>;
  /** Persists the per-task opt-out (work_tasks.dont_ask_workspace). */
  setDontAskWorkspace(taskId: string): Promise<void>;
}

export interface WorkspaceMismatchWorkspacePort {
  getPolicyState(): Promise<WorkspacePolicyState>;
}

/** The three window capabilities the toast needs, injected for testability. */
export interface WorkspaceMismatchHostPort {
  /** Absolute fsPaths of the window's open file-scheme folders. */
  currentRoots(): readonly string[];
  /** Non-modal notification; resolves to the chosen action, or undefined. */
  prompt(message: string, actions: readonly string[]): Promise<string | undefined>;
  /** Replaces every open folder with `roots` (single-folder windows reload). */
  applyRoots(roots: readonly string[]): Promise<void>;
}

export interface WorkspaceMismatchDeps {
  readonly bus: { subscribe(handler: (event: ProductBusEvent) => void): () => void };
  readonly tasks: WorkspaceMismatchTaskPort;
  readonly workspaces: WorkspaceMismatchWorkspacePort;
  readonly host: WorkspaceMismatchHostPort;
  readonly logger: Logger;
}

/**
 * Subscribes to the active-task spine and raises the mismatch toast when the
 * new task's set roots differ from the window's folders. Returns a disposable
 * that unsubscribes.
 */
export function registerWorkspaceMismatchPrompt(deps: WorkspaceMismatchDeps): { dispose(): void } {
  // One ask per task per window session; the durable opt-out lives in SQLite.
  const asked = new Set<string>();
  const unsubscribe = deps.bus.subscribe((event: ProductBusEvent) => {
    if (event.kind !== "active-task-changed" || event.taskId === null) return;
    const taskId = event.taskId as string;
    void handleActiveTask(deps, taskId, asked).catch((error: unknown) => {
      // A nudge must never break task switching.
      deps.logger.warn("workspace mismatch prompt failed", {
        taskId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });
  return { dispose: unsubscribe };
}

async function handleActiveTask(deps: WorkspaceMismatchDeps, taskId: string, asked: Set<string>): Promise<void> {
  const tasks = await deps.tasks.listTaskSummaries();
  const task = tasks.find((candidate) => candidate.taskId === taskId);
  if (task === undefined) return;
  const state = await deps.workspaces.getPolicyState();
  // First linked set wins: a task with several sets has no single "where".
  const setId = task.linkedWorkspaceSetIds[0];
  const set = setId === undefined
    ? undefined
    : state.workspaceSets.find((candidate) => candidate.workspaceSetId === setId);
  const setRoots = (set?.members ?? [])
    .map((member) => member.displayPath)
    .filter((root) => root.length > 0);
  const windowRoots = deps.host.currentRoots();
  const decision = shouldPromptWorkspaceSwitch({
    taskId,
    setRoots,
    windowRoots,
    ...(task.dontAskWorkspace === undefined ? {} : { dontAsk: task.dontAskWorkspace }),
    askedTaskIds: asked
  });
  if (!decision.prompt || set === undefined) return;

  asked.add(taskId);
  const choice = await deps.host.prompt(
    `\u300E${task.title}\u300F uses workspace set ${set.name}. This window has different folders open.`,
    [SWITCH_FOLDERS_ACTION, KEEP_CURRENT_ACTION, DONT_ASK_ACTION]
  );
  if (choice === SWITCH_FOLDERS_ACTION) {
    await deps.host.applyRoots(setRoots);
    return;
  }
  if (choice === DONT_ASK_ACTION) {
    await deps.tasks.setDontAskWorkspace(taskId);
  }
  // "Keep current" (and a dismissed toast) do nothing on purpose.
}
