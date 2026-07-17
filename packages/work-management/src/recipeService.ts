/**
 * Task recipes (ADR 0007): templates that materialize into a task, its
 * subtasks, their dependency DAG, and per-role defaults (prompt, autoStart,
 * seedMode, and ADR 0002 model routing) - in one action that CREATES and
 * never starts. Stored
 * rows (seeded + user) merge with read-only overlay rows supplied by the
 * host from the workspace's `.drydock/recipes.json` (the planner-aspects
 * overlay pattern); overlay ids are prefixed so they can never collide with
 * or mutate stored rows.
 */

import type { SubtaskRecord, TaskRecipeRecord, TaskRecipeStore, TaskRecipeSubtask, WorkTaskRecord } from "@drydock/contracts";
import type { Logger } from "@drydock/core";

/** Task/subtask creation, satisfied by TaskService + SubtaskService structurally. */
export interface RecipeTaskPort {
  createTask(title: string, description?: string): Promise<WorkTaskRecord>;
}

export interface RecipeSubtaskPort {
  createSubtask(taskId: string, input: {
    readonly title: string;
    readonly prompt?: string;
    readonly autoStart?: boolean;
    readonly seedMode?: "local" | "upstream";
    readonly model?: { readonly providerId: string; readonly model?: string };
    readonly verifyMode?: "hitl";
  }): Promise<SubtaskRecord>;
  addDependency(fromSubtaskId: string, toSubtaskId: string): Promise<unknown>;
}

export interface RecipeServiceOptions {
  readonly store: TaskRecipeStore;
  readonly tasks: RecipeTaskPort;
  readonly subtasks: RecipeSubtaskPort;
  readonly logger: Logger;
  /** Read-only workspace overlay (.drydock/recipes.json), resolved per list. */
  readonly overlays?: () => Promise<readonly TaskRecipeRecord[]>;
}

export class RecipeService {
  constructor(private readonly options: RecipeServiceOptions) {}

  /** Stored (non-archived) rows plus validated overlay rows, name-sorted. */
  async listRecipes(): Promise<TaskRecipeRecord[]> {
    const stored = await this.options.store.listRecipes();
    const overlays = await this.resolveOverlays();
    return [...stored, ...overlays].sort((a, b) => a.name.localeCompare(b.name));
  }

  async getRecipe(recipeId: string): Promise<TaskRecipeRecord | null> {
    const stored = await this.options.store.getRecipe(recipeId);
    if (stored !== null) return stored;
    return (await this.resolveOverlays()).find((recipe) => recipe.recipeId === recipeId) ?? null;
  }

  /**
   * Creates the task + subtasks + DAG from a recipe. Steps materialize in
   * recipe order (keys resolved to fresh subtask ids); `{title}` in prompts
   * is replaced with the task title. The complete recipe and dependency DAG
   * are validated before the task write, so predictable input defects cannot
   * leave a partially materialized task. NOTHING starts - creation and
   * starting stay separate acts.
   */
  async materializeTask(recipeId: string, title: string): Promise<WorkTaskRecord> {
    const recipe = await this.getRecipe(recipeId);
    if (recipe === null) {
      throw new Error(`Recipe ${recipeId} was not found.`);
    }
    const normalizedTitle = title.trim();
    const issues = validateRecipe(recipe);
    if (normalizedTitle === "") {
      issues.push("task title must not be empty");
    }
    if (issues.length > 0) {
      throw new Error(`Recipe "${recipe.name}" is invalid: ${issues.join("; ")}.`);
    }
    const task = await this.options.tasks.createTask(normalizedTitle, `Created from recipe "${recipe.name}".`);
    const idByKey = new Map<string, string>();
    for (const step of recipe.subtasks) {
      const created = await this.options.subtasks.createSubtask(task.taskId as string, {
        title: step.title,
        ...(step.prompt === undefined ? {} : { prompt: step.prompt.replaceAll("{title}", normalizedTitle) }),
        autoStart: step.autoStart,
        ...(step.seedMode === undefined ? {} : { seedMode: step.seedMode }),
        ...(step.model === undefined ? {} : { model: step.model }),
        ...(step.verify === undefined ? {} : { verifyMode: step.verify })
      });
      idByKey.set(step.key, created.subtaskId as string);
    }
    for (const step of recipe.subtasks) {
      const toId = idByKey.get(step.key);
      if (toId === undefined) continue;
      for (const fromKey of step.dependsOnKeys) {
        const fromId = idByKey.get(fromKey);
        // validateRecipe established that every key exists before any writes.
        if (fromId === undefined) throw new Error(`Validated recipe dependency ${fromKey} was not materialized.`);
        await this.options.subtasks.addDependency(fromId, toId);
      }
    }
    return task;
  }

  /** Overlay rows normalized read-only: prefixed ids, archived stripped. */
  private async resolveOverlays(): Promise<TaskRecipeRecord[]> {
    if (this.options.overlays === undefined) return [];
    try {
      const rows = await this.options.overlays();
      const valid: TaskRecipeRecord[] = [];
      for (const recipe of rows) {
        const normalized: TaskRecipeRecord = {
          ...recipe,
          recipeId: recipe.recipeId.startsWith("overlay:") ? recipe.recipeId : `overlay:${recipe.recipeId}`,
          source: "overlay" as const,
          archived: false
        };
        const issues = validateRecipe(normalized);
        if (issues.length > 0) {
          this.options.logger.warn("invalid recipe overlay skipped", {
            recipeId: normalized.recipeId,
            issues
          });
          continue;
        }
        valid.push(normalized);
      }
      return valid;
    } catch (error) {
      this.options.logger.warn("recipe overlay resolution failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }
}

/**
 * Returns every deterministic recipe/DAG defect that would make
 * materialization unsafe. The validator deliberately runs independently of
 * persistence so callers can fail before creating the parent task.
 */
export function validateRecipe(recipe: TaskRecipeRecord): string[] {
  const issues: string[] = [];
  if (typeof recipe.recipeId !== "string" || recipe.recipeId.trim() === "") issues.push("recipe id must not be empty");
  if (typeof recipe.name !== "string" || recipe.name.trim() === "") issues.push("recipe name must not be empty");

  const steps: readonly TaskRecipeSubtask[] = Array.isArray(recipe.subtasks) ? recipe.subtasks : [];
  if (!Array.isArray(recipe.subtasks) || steps.length === 0) {
    issues.push("recipe has no steps to materialize");
    return issues;
  }

  const keys = new Set<string>();
  for (const [index, step] of steps.entries()) {
    const label = `step ${String(index + 1)}`;
    if (typeof step !== "object" || step === null) {
      issues.push(`${label} must be an object`);
      continue;
    }
    if (typeof step.key !== "string" || step.key.trim() === "") {
      issues.push(`${label} key must not be empty`);
    } else if (step.key !== step.key.trim()) {
      issues.push(`${label} key must not have surrounding whitespace`);
    } else if (keys.has(step.key)) {
      issues.push(`duplicate step key "${step.key}"`);
    } else {
      keys.add(step.key);
    }
    if (typeof step.title !== "string" || step.title.trim() === "") {
      issues.push(`${label} title must not be empty`);
    }
    if (step.prompt !== undefined && (typeof step.prompt !== "string" || step.prompt.trim() === "")) {
      issues.push(`${label} prompt must not be empty when supplied`);
    }
    if (typeof step.autoStart !== "boolean") {
      issues.push(`${label} autoStart must be a boolean`);
    }
    if (step.autoStart === true && (typeof step.prompt !== "string" || step.prompt.trim() === "")) {
      issues.push(`${label} cannot auto-start without a prompt`);
    }
    if (step.seedMode !== undefined && step.seedMode !== "local" && step.seedMode !== "upstream") {
      issues.push(`${label} seedMode must be local or upstream`);
    }
    if (step.verify !== undefined && step.verify !== "hitl") {
      issues.push(`${label} verify mode must be hitl`);
    }
    if (step.model !== undefined) {
      if (typeof step.model !== "object" || step.model === null || typeof step.model.providerId !== "string" || step.model.providerId.trim() === "") {
        issues.push(`${label} model providerId must not be empty`);
      } else if (step.model.model !== undefined && (typeof step.model.model !== "string" || step.model.model.trim() === "")) {
        issues.push(`${label} model name must not be empty when supplied`);
      }
    }
    if (!Array.isArray(step.dependsOnKeys)) {
      issues.push(`${label} dependencies must be an array`);
    }
  }

  const graph = new Map<string, Set<string>>();
  for (const step of steps) {
    if (typeof step !== "object" || step === null || typeof step.key !== "string" || !Array.isArray(step.dependsOnKeys)) continue;
    const dependencies = new Set<string>();
    for (const dependency of step.dependsOnKeys) {
      if (typeof dependency !== "string" || dependency.trim() === "") {
        issues.push(`step "${step.key}" has an empty or invalid dependency key`);
        continue;
      }
      if (dependency !== dependency.trim()) {
        issues.push(`step "${step.key}" dependency "${dependency}" has surrounding whitespace`);
        continue;
      }
      if (dependencies.has(dependency)) {
        issues.push(`step "${step.key}" repeats dependency "${dependency}"`);
        continue;
      }
      dependencies.add(dependency);
      if (dependency === step.key) {
        issues.push(`step "${step.key}" cannot depend on itself`);
      } else if (!keys.has(dependency)) {
        issues.push(`step "${step.key}" references missing dependency "${dependency}"`);
      }
    }
    if (keys.has(step.key) && !graph.has(step.key)) graph.set(step.key, dependencies);
  }

  if (graph.size === keys.size && graphHasCycle(graph)) {
    issues.push("dependency graph contains a cycle");
  }
  return issues;
}

function graphHasCycle(graph: ReadonlyMap<string, ReadonlySet<string>>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    for (const dependency of graph.get(key) ?? []) {
      if (graph.has(dependency) && visit(dependency)) return true;
    }
    visiting.delete(key);
    visited.add(key);
    return false;
  };
  return [...graph.keys()].some(visit);
}
