/** Workspace recipe overlay diagnostics and validation tests (ADR 0007). */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryLogger } from "@drydock/core";
import { createRecipeOverlayReader } from "./recipeOverlay.js";

async function withOverlay(
  contents: string,
  run: (read: () => Promise<readonly import("@drydock/contracts").TaskRecipeRecord[]>, logger: MemoryLogger) => Promise<void>,
  isWorkspaceTrusted: () => boolean = () => true
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "drydock-recipes-overlay-"));
  try {
    const overlayDir = path.join(root, ".drydock");
    await mkdir(overlayDir, { recursive: true });
    await writeFile(path.join(overlayDir, "recipes.json"), contents, "utf8");
    const logger = new MemoryLogger();
    await run(createRecipeOverlayReader(() => [root], logger, isWorkspaceTrusted), logger);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("untrusted workspaces cannot contribute repository-controlled recipe prompts", async () => {
  await withOverlay(JSON.stringify([{
    recipeId: "repo-instructions",
    name: "Repository instructions",
    subtasks: [{ key: "work", title: "Work", prompt: "Run repository instructions", autoStart: false }]
  }]), async (read, logger) => {
    assert.deepEqual(await read(), []);
    assert.deepEqual(logger.entries, []);
  }, () => false);
});

test("valid workspace recipes are parsed without diagnostics", async () => {
  await withOverlay(JSON.stringify([{
    recipeId: "release-check",
    name: "Release check",
    subtasks: [
      { key: "build", title: "Build", prompt: "Build {title}", autoStart: false },
      { key: "verify", title: "Verify", prompt: "Verify {title}", autoStart: true, dependsOnKeys: ["build"], model: { providerId: "codex" } }
    ]
  }]), async (read, logger) => {
    const rows = await read();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.recipeId, "release-check");
    assert.deepEqual(rows[0]?.subtasks[1]?.dependsOnKeys, ["build"]);
    assert.deepEqual(logger.entries, []);
  });
});

test("malformed JSON and a non-array root produce actionable diagnostics", async () => {
  await withOverlay("{broken", async (read, logger) => {
    assert.deepEqual(await read(), []);
    assert.equal(logger.entries[0]?.message, "recipe overlay JSON could not be parsed");
    assert.equal(typeof logger.entries[0]?.data?.["filePath"], "string");
  });

  await withOverlay(JSON.stringify({ recipes: [] }), async (read, logger) => {
    assert.deepEqual(await read(), []);
    assert.equal(logger.entries[0]?.message, "recipe overlay root must be an array");
  });
});

test("an invalid entry is rejected as a whole instead of partially normalizing its steps", async () => {
  await withOverlay(JSON.stringify([{
    recipeId: "unsafe",
    name: "Unsafe",
    subtasks: [
      { key: "build", title: "Build", autoStart: "yes", dependsOnKeys: ["prepare", 42] }
    ]
  }]), async (read, logger) => {
    assert.deepEqual(await read(), []);
    const warning = logger.entries.find((entry) => entry.message === "invalid recipe overlay entry skipped");
    assert.ok(warning);
    assert.equal(warning.data?.["entryIndex"], 0);
    assert.ok(Array.isArray(warning.data?.["issues"]));
    assert.match(JSON.stringify(warning.data?.["issues"]), /autoStart must be a boolean/);
    assert.match(JSON.stringify(warning.data?.["issues"]), /dependsOnKeys/);
  });
});

test("duplicate recipe ids are deterministic and diagnosed", async () => {
  const rootA = await mkdtemp(path.join(os.tmpdir(), "drydock-recipes-a-"));
  const rootB = await mkdtemp(path.join(os.tmpdir(), "drydock-recipes-b-"));
  try {
    const contents = JSON.stringify([{
      recipeId: "same",
      name: "Same",
      subtasks: [{ key: "work", title: "Work", autoStart: false }]
    }]);
    for (const root of [rootA, rootB]) {
      const overlayDir = path.join(root, ".drydock");
      await mkdir(overlayDir, { recursive: true });
      await writeFile(path.join(overlayDir, "recipes.json"), contents, "utf8");
    }
    const logger = new MemoryLogger();
    const rows = await createRecipeOverlayReader(() => [rootA, rootB], logger, () => true)();
    assert.equal(rows.length, 1);
    assert.ok(logger.entries.some((entry) => entry.message === "duplicate recipe overlay id ignored"));
  } finally {
    await Promise.all([
      rm(rootA, { recursive: true, force: true }),
      rm(rootB, { recursive: true, force: true })
    ]);
  }
});
