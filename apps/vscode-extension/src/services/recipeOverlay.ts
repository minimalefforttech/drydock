/**
 * Workspace recipe packs (ADR 0007): `.drydock/recipes.json` in any open
 * workspace folder merges read-only into the recipe registry — the
 * planner-aspects overlay pattern (plannerAspectOverlay.ts). Malformed
 * files/entries are skipped with structured diagnostics; RecipeService
 * prefixes overlay ids
 * (`overlay:`) so they can never collide with or mutate stored rows.
 *
 * Expected file shape: an array of
 *   { recipeId, name, description?, subtasks: [{ key, title, prompt?,
 *     autoStart?, seedMode?, dependsOnKeys?, model? }] }
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { TaskRecipeRecord } from "@drydock/contracts";
import type { Logger } from "@drydock/core";
import { parseRecipeSubtasks } from "@drydock/storage-sqlite";

const OVERLAY_RELATIVE_PATH = [".drydock", "recipes.json"];
const RECIPE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OVERLAY_STAMP = "1970-01-01T00:00:00.000Z";

export function createRecipeOverlayReader(
  roots: () => readonly string[],
  logger: Pick<Logger, "warn">,
  isWorkspaceTrusted: () => boolean,
  resolveFile: (root: string, filePath: string) => string | undefined = (_root, filePath) => filePath
): () => Promise<readonly TaskRecipeRecord[]> {
  return async () => {
    // Repository recipes contain agent prompts and automation defaults. Match
    // VS Code's executable-content boundary: an untrusted workspace must not
    // be able to contribute those instructions to the product at all.
    if (!isWorkspaceTrusted()) return [];
    const merged: TaskRecipeRecord[] = [];
    const seen = new Set<string>();
    for (const root of roots()) {
      const filePath = resolveFile(root, path.join(root, ...OVERLAY_RELATIVE_PATH));
      if (filePath === undefined) continue;
      for (const recipe of await readOverlayFile(filePath, logger)) {
        if (!seen.has(recipe.recipeId)) {
          seen.add(recipe.recipeId);
          merged.push(recipe);
        } else {
          logger.warn("duplicate recipe overlay id ignored", { filePath, recipeId: recipe.recipeId });
        }
      }
    }
    return merged;
  };
}

async function readOverlayFile(filePath: string, logger: Pick<Logger, "warn">): Promise<TaskRecipeRecord[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn("recipe overlay could not be read", {
        filePath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logger.warn("recipe overlay JSON could not be parsed", {
      filePath,
      error: error instanceof Error ? error.message : String(error)
    });
    return [];
  }
  if (!Array.isArray(parsed)) {
    logger.warn("recipe overlay root must be an array", { filePath });
    return [];
  }
  const recipes: TaskRecipeRecord[] = [];
  for (const [entryIndex, entry] of parsed.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      logInvalidEntry(logger, filePath, entryIndex, ["entry must be an object"]);
      continue;
    }
    const record = entry as Record<string, unknown>;
    const recipeId = record["recipeId"];
    const name = record["name"];
    const description = record["description"];
    const issues: string[] = [];
    if (typeof recipeId !== "string" || !RECIPE_ID_RE.test(recipeId)) {
      issues.push("recipeId must be a lowercase slug of at most 64 characters");
    }
    if (typeof name !== "string" || name.trim() === "" || name.length > 200) {
      issues.push("name must be a non-empty string of at most 200 characters");
    }
    if (description !== undefined && (typeof description !== "string" || description.trim() === "" || description.length > 1_000)) {
      issues.push("description must be a non-empty string of at most 1000 characters when supplied");
    }
    issues.push(...validateRawSubtasks(record["subtasks"]));
    if (issues.length > 0) {
      logInvalidEntry(logger, filePath, entryIndex, issues);
      continue;
    }
    const subtasks = parseRecipeSubtasks(record["subtasks"]);
    if (subtasks.length === 0) {
      logInvalidEntry(logger, filePath, entryIndex, ["subtasks could not be parsed"]);
      continue;
    }
    recipes.push({
      recipeId: recipeId as string,
      name: name as string,
      ...(typeof description === "string" && description.length > 0 && description.length <= 1_000 ? { description } : {}),
      source: "overlay",
      archived: false,
      subtasks,
      createdAt: OVERLAY_STAMP,
      updatedAt: OVERLAY_STAMP
    });
  }
  return recipes;
}

function validateRawSubtasks(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return ["subtasks must be a non-empty array"];
  const issues: string[] = [];
  for (const [index, entry] of value.entries()) {
    const label = `subtask ${String(index + 1)}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      issues.push(`${label} must be an object`);
      continue;
    }
    const step = entry as Record<string, unknown>;
    if (typeof step["key"] !== "string" || step["key"].trim() === "") issues.push(`${label} key must not be empty`);
    if (typeof step["title"] !== "string" || step["title"].trim() === "") issues.push(`${label} title must not be empty`);
    if (step["prompt"] !== undefined && (typeof step["prompt"] !== "string" || step["prompt"].trim() === "")) {
      issues.push(`${label} prompt must not be empty when supplied`);
    }
    if (step["autoStart"] !== undefined && typeof step["autoStart"] !== "boolean") {
      issues.push(`${label} autoStart must be a boolean`);
    }
    if (step["seedMode"] !== undefined && step["seedMode"] !== "local" && step["seedMode"] !== "upstream") {
      issues.push(`${label} seedMode must be local or upstream`);
    }
    if (step["verify"] !== undefined && step["verify"] !== "hitl") {
      issues.push(`${label} verify must be hitl`);
    }
    const dependencies = step["dependsOnKeys"];
    if (dependencies !== undefined && (
      !Array.isArray(dependencies)
      || dependencies.some((dependency) => typeof dependency !== "string" || dependency.trim() === "")
    )) {
      issues.push(`${label} dependsOnKeys must contain only non-empty strings`);
    }
    const model = step["model"];
    if (model !== undefined) {
      if (typeof model !== "object" || model === null || Array.isArray(model)) {
        issues.push(`${label} model must be an object`);
      } else {
        const selection = model as Record<string, unknown>;
        if (typeof selection["providerId"] !== "string" || selection["providerId"].trim() === "") {
          issues.push(`${label} model providerId must not be empty`);
        }
        if (selection["model"] !== undefined && (typeof selection["model"] !== "string" || selection["model"].trim() === "")) {
          issues.push(`${label} model name must not be empty when supplied`);
        }
      }
    }
  }
  return issues;
}

function logInvalidEntry(
  logger: Pick<Logger, "warn">,
  filePath: string,
  entryIndex: number,
  issues: readonly string[]
): void {
  logger.warn("invalid recipe overlay entry skipped", {
    filePath,
    entryIndex,
    issues: [...issues]
  });
}
