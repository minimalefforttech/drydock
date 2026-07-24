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

import type { SubtaskGate, SubtaskRecord, TaskApproach, TaskHandoffMode, TaskLane, TaskRecipeRecord, TaskRecipeStore, TaskRecipeSubtask, WorkTaskRecord } from "@drydock/contracts";
import type { Logger } from "@drydock/core";

/** Ticket-shape fields the recipe pre-fills and the form may override (plan D1). */
export interface RecipeTicketOverrides {
  readonly lane?: TaskLane;
  readonly handoffMode?: TaskHandoffMode;
  readonly branchName?: string;
  readonly approach?: TaskApproach;
}

/** Task/subtask creation, satisfied by TaskService + SubtaskService structurally. */
export interface RecipeTaskPort {
  createTask(title: string, description?: string, ticket?: RecipeTicketOverrides): Promise<WorkTaskRecord>;
}

export interface RecipeSubtaskPort {
  createSubtask(taskId: string, input: {
    readonly title: string;
    readonly prompt?: string;
    readonly autoStart?: boolean;
    readonly seedMode?: "local" | "upstream";
    readonly model?: { readonly providerId: string; readonly model?: string };
    readonly verifyMode?: "hitl";
    readonly stageIndex?: number;
    readonly gate?: SubtaskGate;
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
  /**
   * Product-preference ticket defaults (plan D10) - the rung BELOW recipe
   * defaults in the config ladder. Resolved per materialization so a
   * System-tab edit applies to the very next ticket.
   */
  readonly preferences?: () => Promise<{
    readonly lane?: TaskLane;
    readonly handoffMode?: TaskHandoffMode;
    readonly approach?: TaskApproach;
  }>;
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
  async materializeTask(recipeId: string, title: string, overrides?: RecipeTicketOverrides): Promise<WorkTaskRecord> {
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
    // Ticket shape resolution (plan D10 ladder): explicit form overrides win,
    // then recipe defaults, then product preferences. The branch default
    // comes from the leading ticket key in the title when nothing set one
    // ("PIPE-231 fix retry" -> "PIPE-231").
    const preferenceDefaults = (await this.options.preferences?.()) ?? {};
    const lane = overrides?.lane ?? recipe.lane ?? preferenceDefaults.lane;
    const handoffMode = overrides?.handoffMode ?? recipe.handoffMode ?? preferenceDefaults.handoffMode;
    const approach = overrides?.approach ?? recipe.approach ?? preferenceDefaults.approach;
    const branchName = overrides?.branchName
      ?? (handoffMode === "branch" ? ticketKeyFromTitle(normalizedTitle) : undefined);
    const ticket: RecipeTicketOverrides = {
      ...(lane === undefined ? {} : { lane }),
      ...(handoffMode === undefined ? {} : { handoffMode }),
      ...(branchName === undefined ? {} : { branchName }),
      ...(approach === undefined ? {} : { approach })
    };
    const task = await this.options.tasks.createTask(normalizedTitle, `Created from recipe "${recipe.name}".`, ticket);

    // Plan-first (plan D5): prepend a planner step and gate every recipe
    // step behind human plan approval - unless the recipe already declares
    // its own gates (then its author's shape wins). The planner runs first;
    // nothing implements until a person approves.
    const planFirst = ticket.approach === "plan-first" && !recipe.subtasks.some((step) => step.gate !== undefined);
    const planStepId = planFirst ? await this.createPlannerStep(task.taskId as string, normalizedTitle) : undefined;

    const idByKey = new Map<string, string>();
    for (const step of recipe.subtasks) {
      const created = await this.options.subtasks.createSubtask(task.taskId as string, {
        title: step.title,
        ...(step.prompt === undefined ? {} : { prompt: step.prompt.replaceAll("{title}", normalizedTitle) }),
        autoStart: step.autoStart,
        ...(step.seedMode === undefined ? {} : { seedMode: step.seedMode }),
        ...(step.model === undefined ? {} : { model: step.model }),
        ...(step.verify === undefined ? {} : { verifyMode: step.verify }),
        ...(step.stageIndex === undefined ? {} : { stageIndex: step.stageIndex }),
        ...(step.gate === undefined
          ? (planFirst ? { gate: "plan-approval" as const } : {})
          : { gate: step.gate })
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
      // The planner precedes every recipe ROOT step so the DAG reads
      // plan -> (gated) implementation, and the cascade waits on both the
      // plan's completion and the human's approval.
      if (planStepId !== undefined && step.dependsOnKeys.length === 0) {
        await this.options.subtasks.addDependency(planStepId, toId);
      }
    }
    return task;
  }

  /**
   * Materializes a task whose steps come from AD-HOC stages (plan D4) rather
   * than the recipe's own steps - the recipe still supplies ticket defaults
   * (lane/handoff/approach) and the plan-first shape. Stages become a linear
   * same-branch chain: stageIndex 1..N, each depending on its predecessor,
   * autoStart on, prompts defaulted from the stage title when absent.
   * Creation never starts anything (ADR 0007).
   */
  async materializeStagedTask(
    recipeId: string,
    title: string,
    stages: readonly { readonly title: string; readonly prompt?: string }[],
    overrides?: RecipeTicketOverrides
  ): Promise<WorkTaskRecord> {
    const recipe = await this.getRecipe(recipeId);
    if (recipe === null) {
      throw new Error(`Recipe ${recipeId} was not found.`);
    }
    const normalizedTitle = title.trim();
    if (normalizedTitle === "") throw new Error("Task title must not be empty.");
    if (stages.length === 0) throw new Error("Staged tasks need at least one stage.");
    for (const [index, stage] of stages.entries()) {
      if (stage.title.trim() === "") throw new Error(`Stage ${String(index + 1)} needs a title.`);
    }
    const preferenceDefaults = (await this.options.preferences?.()) ?? {};
    const lane = overrides?.lane ?? recipe.lane ?? preferenceDefaults.lane;
    const handoffMode = overrides?.handoffMode ?? recipe.handoffMode ?? preferenceDefaults.handoffMode;
    const approach = overrides?.approach ?? recipe.approach ?? preferenceDefaults.approach;
    const branchName = overrides?.branchName
      ?? (handoffMode === "branch" ? ticketKeyFromTitle(normalizedTitle) : undefined);
    const ticket: RecipeTicketOverrides = {
      ...(lane === undefined ? {} : { lane }),
      ...(handoffMode === undefined ? {} : { handoffMode }),
      ...(branchName === undefined ? {} : { branchName }),
      ...(approach === undefined ? {} : { approach })
    };
    const task = await this.options.tasks.createTask(
      normalizedTitle,
      `Created from recipe "${recipe.name}" with ${String(stages.length)} custom stage${stages.length === 1 ? "" : "s"}.`,
      ticket
    );
    const planFirst = ticket.approach === "plan-first";
    const planStepId = planFirst ? await this.createPlannerStep(task.taskId as string, normalizedTitle) : undefined;
    let previousId: string | undefined;
    for (const [index, stage] of stages.entries()) {
      const stageTitle = stage.title.trim();
      const stagePrompt = (stage.prompt ?? "").trim();
      const created = await this.options.subtasks.createSubtask(task.taskId as string, {
        title: stageTitle,
        prompt: stagePrompt !== "" ? stagePrompt : `Complete stage "${stageTitle}" of "${normalizedTitle}".`,
        autoStart: true,
        stageIndex: index + 1,
        ...(planFirst ? { gate: "plan-approval" as const } : {})
      });
      if (previousId !== undefined) {
        await this.options.subtasks.addDependency(previousId, created.subtaskId as string);
      } else if (planStepId !== undefined) {
        await this.options.subtasks.addDependency(planStepId, created.subtaskId as string);
      }
      previousId = created.subtaskId as string;
    }
    return task;
  }

  /** The plan-first leading step, shared by both materialization shapes (plan D5). */
  private async createPlannerStep(taskId: string, taskTitle: string): Promise<string> {
    const planStep = await this.options.subtasks.createSubtask(taskId, {
      title: "Plan",
      prompt: [
        `Plan the work for "${taskTitle}" before anything is implemented.`,
        "Read the mounted code, lay out a concrete step-by-step plan with risks and the files involved,",
        "and finish your final message with a ```handoff fenced block summarizing the plan for the implementer.",
        "Do not change any files - this stage is planning only."
      ].join(" "),
      autoStart: true
    });
    return planStep.subtaskId as string;
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
 * Default branch name for a branch-handoff ticket: the leading ticket key
 * when the title carries one ("PIPE-231 fix retry" -> "PIPE-231"), else a
 * slug of the whole title. Plain names, never a product prefix (plan D3).
 */
function ticketKeyFromTitle(title: string): string {
  const key = /^([A-Za-z][A-Za-z0-9_]*-\d+)\b/.exec(title)?.[1];
  if (key !== undefined) return key;
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug === "" ? "task" : slug;
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
  // Ticket defaults arrive from untrusted overlay JSON too - check the enums.
  if (recipe.lane !== undefined && recipe.lane !== "normal" && (recipe.lane as string) !== "background") {
    issues.push("recipe lane must be normal or background");
  }
  if (recipe.handoffMode !== undefined && recipe.handoffMode !== "patch" && (recipe.handoffMode as string) !== "branch") {
    issues.push("recipe handoffMode must be patch or branch");
  }
  if (recipe.approach !== undefined && recipe.approach !== "implement" && (recipe.approach as string) !== "plan-first") {
    issues.push("recipe approach must be implement or plan-first");
  }

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
    if (step.stageIndex !== undefined && (!Number.isInteger(step.stageIndex) || step.stageIndex < 1)) {
      issues.push(`${label} stageIndex must be an integer >= 1`);
    }
    if (step.gate !== undefined && (step.gate as string) !== "plan-approval") {
      issues.push(`${label} gate must be plan-approval`);
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

  // Stage chain (plan D4): indexes unique, and each stage after the first
  // depends on its predecessor - the chain is explicit in the DAG, never
  // implied by index order alone.
  const stageByIndex = new Map<number, TaskRecipeSubtask>();
  for (const step of steps) {
    if (typeof step !== "object" || step === null || step.stageIndex === undefined) continue;
    if (!Number.isInteger(step.stageIndex) || step.stageIndex < 1) continue;
    const existing = stageByIndex.get(step.stageIndex);
    if (existing !== undefined) {
      issues.push(`steps "${existing.key}" and "${step.key}" share stage index ${String(step.stageIndex)}`);
      continue;
    }
    stageByIndex.set(step.stageIndex, step);
  }
  for (const [index, step] of stageByIndex) {
    if (index === 1) continue;
    const predecessor = stageByIndex.get(index - 1);
    if (predecessor === undefined) {
      issues.push(`stage ${String(index)} ("${step.key}") has no stage ${String(index - 1)} predecessor`);
    } else if (Array.isArray(step.dependsOnKeys) && !step.dependsOnKeys.includes(predecessor.key)) {
      issues.push(`stage ${String(index)} ("${step.key}") must depend on stage ${String(index - 1)} ("${predecessor.key}")`);
    }
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
