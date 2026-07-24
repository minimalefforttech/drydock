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
  tasks: { title: string; description?: string; ticket?: Record<string, unknown> }[];
  subtasks: { taskId: string; input: Record<string, unknown> }[];
  edges: { from: string; to: string }[];
}

function harness(
  rows: TaskRecipeRecord[],
  overlays?: () => Promise<readonly TaskRecipeRecord[]>,
  preferences?: () => Promise<{ lane?: "normal" | "background"; handoffMode?: "patch" | "branch"; approach?: "implement" | "plan-first" }>
): { service: RecipeService; created: Created; logger: MemoryLogger } {
  const created: Created = { tasks: [], subtasks: [], edges: [] };
  const logger = new MemoryLogger();
  let subtaskCounter = 0;
  const service = new RecipeService({
    store: new FakeRecipeStore(rows),
    logger,
    tasks: {
      createTask: async (title, description, ticket) => {
        created.tasks.push({
          title,
          ...(description === undefined ? {} : { description }),
          ...(ticket === undefined ? {} : { ticket: ticket as Record<string, unknown> })
        });
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
    ...(overlays === undefined ? {} : { overlays }),
    ...(preferences === undefined ? {} : { preferences })
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

test("ticket defaults flow from the recipe, overrides win, branch defaults from the title's ticket key", async () => {
  const rows = [recipe({ lane: "background", handoffMode: "branch", approach: "plan-first" })];
  const { service, created } = harness(rows);

  await service.materializeTask("recipe-1", "PIPE-231 fix double submit");
  assert.deepEqual(created.tasks[0]?.ticket, {
    lane: "background",
    handoffMode: "branch",
    branchName: "PIPE-231",
    approach: "plan-first"
  });

  // Explicit form overrides win over recipe defaults, including the branch name.
  await service.materializeTask("recipe-1", "PIPE-232 second", { lane: "normal", branchName: "hotfix-a" });
  assert.deepEqual(created.tasks[1]?.ticket, {
    lane: "normal",
    handoffMode: "branch",
    branchName: "hotfix-a",
    approach: "plan-first"
  });

  // No leading ticket key: the branch default is a slug of the title.
  await service.materializeTask("recipe-1", "Fix the farm submit retry!");
  assert.equal(created.tasks[2]?.ticket?.["branchName"], "fix-the-farm-submit-retry");

  // Patch-handoff recipes never invent a branch name.
  const patchRows = [recipe({ recipeId: "recipe-patch", lane: "background" })];
  const patch = harness(patchRows);
  await patch.service.materializeTask("recipe-patch", "PIPE-300 docs pass");
  assert.deepEqual(patch.created.tasks[0]?.ticket, { lane: "background" });
});

test("stage steps materialize with their index and chains validate before any write", async () => {
  const staged = recipe({
    recipeId: "recipe-staged",
    subtasks: [
      { key: "s1", title: "Stage 1", prompt: "p1", autoStart: true, dependsOnKeys: [], stageIndex: 1 },
      { key: "s2", title: "Stage 2", prompt: "p2", autoStart: true, dependsOnKeys: ["s1"], stageIndex: 2, gate: "plan-approval" }
    ]
  });
  const { service, created } = harness([staged]);
  await service.materializeTask("recipe-staged", "PIPE-114 cleanup");
  assert.equal(created.subtasks[0]?.input["stageIndex"], 1);
  assert.equal(created.subtasks[1]?.input["stageIndex"], 2);
  assert.equal(created.subtasks[1]?.input["gate"], "plan-approval");

  // Duplicate index and a missing predecessor edge both reject pre-write.
  const bad = recipe({
    recipeId: "recipe-bad-stages",
    subtasks: [
      { key: "s1", title: "S1", prompt: "p", autoStart: true, dependsOnKeys: [], stageIndex: 1 },
      { key: "s2", title: "S2", prompt: "p", autoStart: true, dependsOnKeys: [], stageIndex: 2 },
      { key: "s2b", title: "S2b", prompt: "p", autoStart: true, dependsOnKeys: [], stageIndex: 2 }
    ]
  });
  const broken = harness([bad]);
  await assert.rejects(() => broken.service.materializeTask("recipe-bad-stages", "T"), /share stage index 2/);
  await assert.rejects(() => broken.service.materializeTask("recipe-bad-stages", "T"), /must depend on stage 1/);
  assert.equal(broken.created.tasks.length, 0);
});

test("preference defaults sit below recipe defaults in the ticket ladder", async () => {
  const prefs = async (): Promise<{ lane?: "normal" | "background"; handoffMode?: "patch" | "branch" }> =>
    ({ lane: "background", handoffMode: "branch" });

  // No recipe defaults: preferences fill the ticket (and the branch derives
  // from the title's ticket key).
  const a = harness([recipe({ recipeId: "recipe-plain" })], undefined, prefs);
  await a.service.materializeTask("recipe-plain", "PIPE-77 tidy");
  assert.deepEqual(a.created.tasks[0]?.ticket, { lane: "background", handoffMode: "branch", branchName: "PIPE-77" });

  // A recipe default beats the preference; the preference still fills gaps.
  const b = harness([recipe({ recipeId: "recipe-lane", lane: "normal" })], undefined, prefs);
  await b.service.materializeTask("recipe-lane", "PIPE-78 tidy");
  assert.equal(b.created.tasks[0]?.ticket?.["lane"], "normal");
  assert.equal(b.created.tasks[0]?.ticket?.["handoffMode"], "branch");
});

test("plan-first prepends a planner step and gates every recipe step behind approval", async () => {
  const { service, created } = harness([recipe()]);
  await service.materializeTask("recipe-1", "PIPE-9 do it", { approach: "plan-first" });

  // Planner first (auto-start, ends with a handoff), then the recipe's steps,
  // every one gated - nothing implements until a person approves.
  assert.equal(created.subtasks[0]?.input["title"], "Plan");
  assert.equal(created.subtasks[0]?.input["autoStart"], true);
  assert.match(String(created.subtasks[0]?.input["prompt"]), /handoff/);
  assert.equal(created.subtasks[1]?.input["gate"], "plan-approval");
  assert.equal(created.subtasks[2]?.input["gate"], "plan-approval");

  // The planner precedes the recipe's ROOT step; interior edges are kept.
  assert.deepEqual(created.edges, [
    { from: "sub-1", to: "sub-2" },
    { from: "sub-2", to: "sub-3" }
  ]);
});

test("materializeStagedTask replaces steps with a linear chain; plan-first prepends and gates it", async () => {
  const rows = [recipe({ recipeId: "recipe-defaults", lane: "background", handoffMode: "branch" })];
  const { service, created } = harness(rows);

  await service.materializeStagedTask("recipe-defaults", "PIPE-114 exporter cleanup", [
    { title: "Guard the queue client", prompt: "Add acquire_dispatch_slot." },
    { title: "Wire submit hooks" },
    { title: "Docs sweep", prompt: "Update docs/retry.md." }
  ]);

  // Recipe defaults still shape the ticket; the branch derives from the key.
  assert.deepEqual(created.tasks[0]?.ticket, { lane: "background", handoffMode: "branch", branchName: "PIPE-114" });
  // The recipe's own steps are REPLACED: three stages, chained 1 -> 2 -> 3,
  // auto-start, with a default prompt where none was given.
  assert.equal(created.subtasks.length, 3);
  assert.deepEqual(created.subtasks.map((entry) => entry.input["stageIndex"]), [1, 2, 3]);
  assert.equal(created.subtasks.every((entry) => entry.input["autoStart"] === true), true);
  assert.match(String(created.subtasks[1]?.input["prompt"]), /Wire submit hooks/);
  assert.deepEqual(created.edges, [
    { from: "sub-1", to: "sub-2" },
    { from: "sub-2", to: "sub-3" }
  ]);

  // Plan-first: planner first, every stage gated, plan -> stage 1 edge.
  const planFirst = harness(rows);
  await planFirst.service.materializeStagedTask("recipe-defaults", "PIPE-115 soak", [
    { title: "Stage one" },
    { title: "Stage two" }
  ], { approach: "plan-first" });
  assert.equal(planFirst.created.subtasks[0]?.input["title"], "Plan");
  assert.equal(planFirst.created.subtasks[1]?.input["gate"], "plan-approval");
  assert.equal(planFirst.created.subtasks[2]?.input["gate"], "plan-approval");
  assert.deepEqual(planFirst.created.edges, [
    { from: "sub-1", to: "sub-2" },
    { from: "sub-2", to: "sub-3" }
  ]);

  // Empty and untitled stages refuse before any write.
  const broken = harness(rows);
  await assert.rejects(() => broken.service.materializeStagedTask("recipe-defaults", "T", []), /at least one stage/);
  await assert.rejects(
    () => broken.service.materializeStagedTask("recipe-defaults", "T", [{ title: "  " }]),
    /Stage 1 needs a title/
  );
  assert.equal(broken.created.tasks.length, 0);
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
