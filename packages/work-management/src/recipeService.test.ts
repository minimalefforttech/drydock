/**
 * RecipeService unit tests (ADR 0007): materialization creates the task,
 * subtasks with per-role defaults, and the DAG (never starting anything);
 * `{title}` substitutes; overlay rows merge read-only with prefixed ids and
 * a broken overlay never breaks the stored list.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { asId } from "@drydock/contracts";
import type { SubtaskRecord, TaskRecipeRecord, TaskRecipeStore, WorkTaskRecord } from "@drydock/contracts";
import { MemoryLogger } from "@drydock/core";
import { RecipeService } from "./recipeService.js";

const NOW = "2026-07-12T00:00:00.000Z";

function recipe(overrides?: Partial<TaskRecipeRecord>): TaskRecipeRecord {
  return {
    recipeId: "recipe-1",
    name: "Implement + verify",
    source: "seeded",
    archived: false,
    subtasks: [
      { key: "implement", title: "Implement", prompt: "Implement \"{title}\" carefully.", autoStart: false, dependsOnKeys: [] },
      {
        key: "verify",
        title: "Verify",
        prompt: "Verify {title}.",
        autoStart: true,
        seedMode: "upstream",
        dependsOnKeys: ["implement"],
        model: { providerId: "claude", model: "claude-fable-5" }
      }
    ],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

class FakeRecipeStore implements TaskRecipeStore {
  constructor(readonly rows: TaskRecipeRecord[]) {}
  async listRecipes(includeArchived = false): Promise<TaskRecipeRecord[]> {
    return this.rows.filter((row) => includeArchived || !row.archived);
  }
  async getRecipe(recipeId: string): Promise<TaskRecipeRecord | null> {
    return this.rows.find((row) => row.recipeId === recipeId) ?? null;
  }
  async insertRecipe(record: TaskRecipeRecord): Promise<void> {
    this.rows.push(record);
  }
  async setArchived(): Promise<void> {}
}

interface Created {
  tasks: { title: string; description?: string }[];
  subtasks: { taskId: string; input: Record<string, unknown> }[];
  edges: { from: string; to: string }[];
}

function harness(rows: TaskRecipeRecord[], overlays?: () => Promise<readonly TaskRecipeRecord[]>): { service: RecipeService; created: Created; logger: MemoryLogger } {
  const created: Created = { tasks: [], subtasks: [], edges: [] };
  const logger = new MemoryLogger();
  let subtaskCounter = 0;
  const service = new RecipeService({
    store: new FakeRecipeStore(rows),
    logger,
    tasks: {
      createTask: async (title, description) => {
        created.tasks.push({ title, ...(description === undefined ? {} : { description }) });
        return { taskId: asId<"TaskId">("task-1"), title, state: "todo", columnId: asId<"ColumnId">("col-backlog"), createdAt: NOW, updatedAt: NOW } as WorkTaskRecord;
      }
    },
    subtasks: {
      createSubtask: async (taskId, input) => {
        subtaskCounter += 1;
        created.subtasks.push({ taskId, input: input as Record<string, unknown> });
        return { subtaskId: asId<"SubtaskId">(`sub-${String(subtaskCounter)}`) } as SubtaskRecord;
      },
      addDependency: async (from, to) => {
        created.edges.push({ from, to });
        return {};
      }
    },
    ...(overlays === undefined ? {} : { overlays })
  });
  return { service, created, logger };
}

test("materializeTask creates task, subtasks with defaults, and the DAG - never starts", async () => {
  const { service, created } = harness([recipe()]);
  const task = await service.materializeTask("recipe-1", "Alembic export");

  assert.equal(task.taskId, "task-1");
  assert.equal(created.tasks.length, 1);
  assert.match(created.tasks[0]?.description ?? "", /recipe "Implement \+ verify"/);

  assert.equal(created.subtasks.length, 2);
  const implement = created.subtasks[0]?.input;
  assert.equal(implement?.["title"], "Implement");
  assert.equal(implement?.["prompt"], 'Implement "Alembic export" carefully.');
  assert.equal(implement?.["autoStart"], false);
  const verify = created.subtasks[1]?.input;
  assert.equal(verify?.["prompt"], "Verify Alembic export.");
  assert.equal(verify?.["autoStart"], true);
  assert.equal(verify?.["seedMode"], "upstream");
  assert.deepEqual(verify?.["model"], { providerId: "claude", model: "claude-fable-5" });

  // One edge: implement (sub-1) → verify (sub-2).
  assert.deepEqual(created.edges, [{ from: "sub-1", to: "sub-2" }]);
});

test("invalid recipes reject before any task, subtask, or edge write", async () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly record: TaskRecipeRecord;
    readonly title?: string;
    readonly expected: RegExp;
  }> = [
    {
      name: "duplicate keys",
      record: recipe({ subtasks: [
        { key: "same", title: "A", autoStart: false, dependsOnKeys: [] },
        { key: "same", title: "B", autoStart: false, dependsOnKeys: [] }
      ] }),
      expected: /duplicate step key "same"/
    },
    {
      name: "missing dependency",
      record: recipe({ subtasks: [
        { key: "a", title: "A", autoStart: false, dependsOnKeys: ["ghost"] }
      ] }),
      expected: /missing dependency "ghost"/
    },
    {
      name: "self dependency",
      record: recipe({ subtasks: [
        { key: "a", title: "A", autoStart: false, dependsOnKeys: ["a"] }
      ] }),
      expected: /cannot depend on itself/
    },
    {
      name: "cycle",
      record: recipe({ subtasks: [
        { key: "a", title: "A", autoStart: false, dependsOnKeys: ["b"] },
        { key: "b", title: "B", autoStart: false, dependsOnKeys: ["a"] }
      ] }),
      expected: /dependency graph contains a cycle/
    },
    {
      name: "empty step title",
      record: recipe({ subtasks: [
        { key: "a", title: "  ", autoStart: false, dependsOnKeys: [] }
      ] }),
      expected: /title must not be empty/
    },
    {
      name: "auto-start without prompt",
      record: recipe({ subtasks: [
        { key: "a", title: "A", autoStart: true, dependsOnKeys: [] }
      ] }),
      expected: /cannot auto-start without a prompt/
    },
    {
      name: "empty task title",
      record: recipe(),
      title: "  ",
      expected: /task title must not be empty/
    }
  ];

  for (const scenario of cases) {
    const { service, created } = harness([scenario.record]);
    await assert.rejects(service.materializeTask("recipe-1", scenario.title ?? "T"), scenario.expected, scenario.name);
    assert.deepEqual(created, { tasks: [], subtasks: [], edges: [] }, scenario.name);
  }
});

test("overlays merge read-only with prefixed ids; a failing overlay degrades to stored rows", async () => {
  const stored = recipe();
  const overlayRow = recipe({ recipeId: "vfx-shot", name: "VFX shot", source: "overlay" });
  const { service } = harness([stored], async () => [overlayRow]);

  const listed = await service.listRecipes();
  assert.deepEqual(listed.map((row) => row.recipeId).sort(), ["overlay:vfx-shot", "recipe-1"]);
  const overlay = listed.find((row) => row.recipeId === "overlay:vfx-shot");
  assert.equal(overlay?.source, "overlay");
  assert.equal(overlay?.archived, false);

  // getRecipe resolves overlay ids too - materialization works from them.
  assert.ok(await service.getRecipe("overlay:vfx-shot"));

  const { service: broken } = harness([stored], async () => {
    throw new Error("boom");
  });
  assert.deepEqual((await broken.listRecipes()).map((row) => row.recipeId), ["recipe-1"]);
});

test("invalid overlay DAGs are excluded and diagnosed", async () => {
  const invalid = recipe({
    recipeId: "bad-overlay",
    source: "overlay",
    subtasks: [{ key: "publish", title: "Publish", autoStart: false, dependsOnKeys: ["review"] }]
  });
  const { service, logger } = harness([recipe()], async () => [invalid]);

  assert.deepEqual((await service.listRecipes()).map((row) => row.recipeId), ["recipe-1"]);
  assert.ok(logger.entries.some((entry) =>
    entry.level === "warn"
    && entry.message === "invalid recipe overlay skipped"
    && entry.data?.["recipeId"] === "overlay:bad-overlay"
  ));
});

test("empty and unknown recipes are refused loudly", async () => {
  const { service } = harness([recipe({ recipeId: "hollow", subtasks: [] })]);
  await assert.rejects(service.materializeTask("hollow", "T"), /no steps/);
  await assert.rejects(service.materializeTask("ghost", "T"), /not found/);
});
