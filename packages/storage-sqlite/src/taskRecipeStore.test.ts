/**
 * SQLite recipe store tests (ADR 0007): migration seeds defaults once (and
 * only into an empty table), records round-trip including step JSON, and
 * archived rows leave the default list.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyMigrations } from "./migrations.js";
import { SqliteConnection } from "./sqliteConnection.js";
import { parseRecipeSubtasks, SqliteTaskRecipeStore } from "./taskRecipeStore.js";

test("migration seeds recipes once; user rows round-trip with steps; archive hides", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "recipes.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const store = new SqliteTaskRecipeStore(connection);

    const seeded = await store.listRecipes();
    assert.ok(seeded.length >= 2);
    assert.ok(seeded.every((recipe) => recipe.source === "seeded"));
    const chain = seeded.find((recipe) => recipe.recipeId === "recipe-research-implement-test");
    assert.equal(chain?.subtasks.length, 3);
    assert.equal(chain?.subtasks[1]?.seedMode, "upstream");
    assert.deepEqual(chain?.subtasks[2]?.dependsOnKeys, ["implement"]);

    await store.insertRecipe({
      recipeId: "recipe-user-1",
      name: "Custom",
      source: "user",
      archived: false,
      subtasks: [
        { key: "one", title: "One", prompt: "p", autoStart: true, seedMode: "local", dependsOnKeys: [], model: { providerId: "codex", model: "gpt-5.5" } }
      ],
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z"
    });

    // Archiving a seeded row removes it from the default list — and a re-run
    // of migrations must NOT resurrect or duplicate the seeds.
    await store.setArchived("recipe-implement-verify", true, "2026-07-12T01:00:00.000Z");
    connection.close();

    const reopened = new SqliteConnection(dbPath);
    applyMigrations(reopened);
    const reopenedStore = new SqliteTaskRecipeStore(reopened);
    const listed = await reopenedStore.listRecipes();
    const custom = listed.find((recipe) => recipe.recipeId === "recipe-user-1");
    reopened.close();

    assert.ok(!listed.some((recipe) => recipe.recipeId === "recipe-implement-verify"));
    assert.equal(listed.filter((recipe) => recipe.recipeId === "recipe-research-implement-test").length, 1);
    assert.deepEqual(custom?.subtasks[0]?.model, { providerId: "codex", model: "gpt-5.5" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseRecipeSubtasks tolerates junk and validates shapes", () => {
  assert.deepEqual(parseRecipeSubtasks("not json"), []);
  assert.deepEqual(parseRecipeSubtasks(JSON.stringify({ nope: true })), []);
  const parsed = parseRecipeSubtasks(JSON.stringify([
    { key: "ok", title: "Ok", autoStart: "yes", dependsOnKeys: ["a", 3], seedMode: "sideways", model: { providerId: "" } },
    { key: "", title: "missing key" },
    { key: "full", title: "Full", prompt: "p", autoStart: true, seedMode: "upstream", dependsOnKeys: ["ok"], model: { providerId: "claude" } }
  ]));
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], { key: "ok", title: "Ok", autoStart: false, dependsOnKeys: ["a"] });
  assert.deepEqual(parsed[1], { key: "full", title: "Full", prompt: "p", autoStart: true, seedMode: "upstream", dependsOnKeys: ["ok"], model: { providerId: "claude" } });
});
