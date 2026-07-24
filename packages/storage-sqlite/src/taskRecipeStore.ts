/**
 * SQLite-backed task-recipe store (ADR 0007). Steps ride as validated JSON
 * (`subtasks_json`); malformed rows surface as empty step lists rather than
 * crashing list views. Overlay recipes (.drydock/recipes.json) never touch
 * this store - RecipeService merges them read-only at list time.
 */

import type { SubtaskModelSelection, SubtaskSeedMode, TaskApproach, TaskHandoffMode, TaskLane, TaskRecipeRecord, TaskRecipeStore, TaskRecipeSubtask } from "@drydock/contracts";
import type { SqliteConnection } from "./sqliteConnection.js";

export class SqliteTaskRecipeStore implements TaskRecipeStore {
  constructor(private readonly connection: SqliteConnection) {}

  async listRecipes(includeArchived = false): Promise<TaskRecipeRecord[]> {
    const rows = this.connection.database.prepare(`
      SELECT *
      FROM task_recipes
      ${includeArchived ? "" : "WHERE archived = 0"}
      ORDER BY name ASC, rowid ASC
    `).all() as unknown as RecipeRow[];
    return rows.map(mapRecipe);
  }

  async getRecipe(recipeId: string): Promise<TaskRecipeRecord | null> {
    const row = this.connection.database.prepare(`
      SELECT *
      FROM task_recipes
      WHERE recipe_id = ?
    `).get(recipeId) as RecipeRow | undefined;
    return row ? mapRecipe(row) : null;
  }

  async insertRecipe(record: TaskRecipeRecord): Promise<void> {
    const defaults = {
      ...(record.lane === undefined ? {} : { lane: record.lane }),
      ...(record.handoffMode === undefined ? {} : { handoffMode: record.handoffMode }),
      ...(record.approach === undefined ? {} : { approach: record.approach })
    };
    this.connection.database.prepare(`
      INSERT INTO task_recipes (recipe_id, name, description, source, archived, subtasks_json, defaults_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.recipeId,
      record.name,
      record.description ?? null,
      record.source,
      record.archived ? 1 : 0,
      JSON.stringify(record.subtasks),
      Object.keys(defaults).length === 0 ? null : JSON.stringify(defaults),
      record.createdAt,
      record.updatedAt
    );
  }

  async setArchived(recipeId: string, archived: boolean, updatedAt: string): Promise<void> {
    this.connection.database.prepare(`
      UPDATE task_recipes
      SET archived = ?, updated_at = ?
      WHERE recipe_id = ?
    `).run(archived ? 1 : 0, updatedAt, recipeId);
  }
}

interface RecipeRow {
  readonly recipe_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly source: string;
  readonly archived: number;
  readonly subtasks_json: string;
  readonly defaults_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function mapRecipe(row: RecipeRow): TaskRecipeRecord {
  return {
    recipeId: row.recipe_id,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    source: row.source === "seeded" || row.source === "overlay" ? row.source : "user",
    archived: row.archived !== 0,
    subtasks: parseRecipeSubtasks(row.subtasks_json),
    ...parseRecipeDefaults(row.defaults_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** Validated ticket defaults from the JSON column; junk degrades to absent. */
function parseRecipeDefaults(json: string | null): { lane?: TaskLane; handoffMode?: TaskHandoffMode; approach?: TaskApproach } {
  if (json === null) return {};
  try {
    const value = JSON.parse(json) as unknown;
    if (typeof value !== "object" || value === null) return {};
    const candidate = value as Record<string, unknown>;
    return {
      ...(candidate["lane"] === "normal" || candidate["lane"] === "background" ? { lane: candidate["lane"] as TaskLane } : {}),
      ...(candidate["handoffMode"] === "patch" || candidate["handoffMode"] === "branch" ? { handoffMode: candidate["handoffMode"] as TaskHandoffMode } : {}),
      ...(candidate["approach"] === "implement" || candidate["approach"] === "plan-first" ? { approach: candidate["approach"] as TaskApproach } : {})
    };
  } catch {
    return {};
  }
}

/** Validates persisted/overlay step JSON to the contract shape (shared with RecipeService). */
export function parseRecipeSubtasks(json: unknown): TaskRecipeSubtask[] {
  let value: unknown = json;
  if (typeof json === "string") {
    try {
      value = JSON.parse(json);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const steps: TaskRecipeSubtask[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const step = entry as Record<string, unknown>;
    if (typeof step["key"] !== "string" || step["key"].length === 0) continue;
    if (typeof step["title"] !== "string" || step["title"].length === 0) continue;
    const dependsOnKeys = Array.isArray(step["dependsOnKeys"])
      ? step["dependsOnKeys"].filter((key): key is string => typeof key === "string")
      : [];
    const seedMode = step["seedMode"];
    const model = step["model"];
    let modelSelection: SubtaskModelSelection | undefined;
    if (typeof model === "object" && model !== null) {
      const candidate = model as Record<string, unknown>;
      if (typeof candidate["providerId"] === "string" && candidate["providerId"].length > 0) {
        modelSelection = {
          providerId: candidate["providerId"],
          ...(typeof candidate["model"] === "string" ? { model: candidate["model"] } : {})
        };
      }
    }
    const stageIndex = step["stageIndex"];
    steps.push({
      key: step["key"],
      title: step["title"],
      ...(typeof step["prompt"] === "string" && step["prompt"].length > 0 ? { prompt: step["prompt"] } : {}),
      autoStart: step["autoStart"] === true,
      ...(seedMode === "local" || seedMode === "upstream" ? { seedMode: seedMode as SubtaskSeedMode } : {}),
      dependsOnKeys,
      ...(modelSelection === undefined ? {} : { model: modelSelection }),
      ...(step["verify"] === "hitl" ? { verify: "hitl" as const } : {}),
      ...(typeof stageIndex === "number" && Number.isInteger(stageIndex) && stageIndex >= 1 ? { stageIndex } : {}),
      ...(step["gate"] === "plan-approval" ? { gate: "plan-approval" as const } : {})
    });
  }
  return steps;
}
