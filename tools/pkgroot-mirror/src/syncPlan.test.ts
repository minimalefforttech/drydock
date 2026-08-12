/**
 * Sync-plan tests against real temp trees.
 *
 * The torn-package rule (edge case E2) is filesystem behavior, so the fixture is
 * a real rez-shaped repo: families with version directories, one of them caught
 * mid-publish with no definition file.
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSyncPlan, joinUnderRoot } from "./syncPlan.js";
import type { SyncFsFacade, SyncPlanEntry } from "./syncPlan.js";

const INTERNAL = "Pipeline\\rez\\packages\\internal";
const EXTERNAL = "Pipeline\\rez\\packages\\external";
const CONFIGS = "Pipeline\\rez\\configs";

async function makeFixture(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "drydock-pkgroot-"));
  const files: readonly string[] = [
    // internal: one healthy family, one torn version, one yaml-defined version
    `${INTERNAL}\\pipe_core\\1.0.0\\package.py`,
    `${INTERNAL}\\pipe_core\\1.0.0\\python\\pipe_core\\__init__.py`,
    `${INTERNAL}\\pipe_rig\\2.3.1\\package.yaml`,
    // external: healthy
    `${EXTERNAL}\\pyside\\6.5.0\\package.py`,
    // configs: no package definitions anywhere -> copied whole
    `${CONFIGS}\\rezconfig.py`,
    `${CONFIGS}\\sub\\extra.py`
  ];
  for (const file of files) {
    const abs = joinUnderRoot(root, file);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, "# fixture\n", "utf8");
  }
  // The torn one: a version directory with payload but no definition file.
  await mkdir(joinUnderRoot(root, `${INTERNAL}\\pipe_core\\2.0.0\\python`), { recursive: true });
  await writeFile(joinUnderRoot(root, `${INTERNAL}\\pipe_core\\2.0.0\\python\\half.py`), "# torn\n", "utf8");

  return { root, cleanup: async (): Promise<void> => rm(root, { recursive: true, force: true }) };
}

function entryFor(entries: readonly SyncPlanEntry[], subtree: string): SyncPlanEntry {
  const found = entries.find((entry) => entry.subtree === subtree);
  if (found === undefined) throw new Error(`plan has no entry for ${subtree}`);
  return found;
}

test("package repos exclude torn versions and copy everything else", async () => {
  const fixture = await makeFixture();
  try {
    const plan = buildSyncPlan(fixture.root, [INTERNAL, EXTERNAL, CONFIGS, "Pipeline\\absent"]);

    const internal = entryFor(plan.entries, INTERNAL);
    assert.equal(internal.mode, "package-repo");
    assert.equal(internal.sourceExists, true);
    assert.deepEqual(internal.excludeDirs, [joinUnderRoot(fixture.root, `${INTERNAL}\\pipe_core\\2.0.0`)]);

    const external = entryFor(plan.entries, EXTERNAL);
    assert.equal(external.mode, "package-repo");
    assert.deepEqual(external.excludeDirs, []);

    assert.deepEqual(plan.skippedVersions, [`${INTERNAL}\\pipe_core\\2.0.0`]);
  } finally {
    await fixture.cleanup();
  }
});

test("package.yaml counts as a package definition", async () => {
  const fixture = await makeFixture();
  try {
    const plan = buildSyncPlan(fixture.root, [INTERNAL]);
    const yamlVersion = joinUnderRoot(fixture.root, `${INTERNAL}\\pipe_rig\\2.3.1`);
    const internal = entryFor(plan.entries, INTERNAL);
    assert.ok(!internal.excludeDirs.includes(yamlVersion), "yaml-defined version must not be treated as torn");
  } finally {
    await fixture.cleanup();
  }
});

test("a subtree that is not a package repo is copied whole", async () => {
  const fixture = await makeFixture();
  try {
    const plan = buildSyncPlan(fixture.root, [CONFIGS]);
    assert.deepEqual(plan.entries, [
      { subtree: CONFIGS, mode: "whole", sourceExists: true, excludeDirs: [] }
    ]);
    assert.deepEqual(plan.skippedVersions, []);
  } finally {
    await fixture.cleanup();
  }
});

test("a missing source subtree is planned but flagged, not silently dropped", async () => {
  const fixture = await makeFixture();
  try {
    const plan = buildSyncPlan(fixture.root, ["Pipeline\\absent"]);
    assert.deepEqual(plan.entries, [
      { subtree: "Pipeline\\absent", mode: "whole", sourceExists: false, excludeDirs: [] }
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test("unversioned packages keep their payload directories", () => {
  // In-memory facade: pipe_tools has its definition in the family directory, so
  // its subdirectories are payload rather than half-published versions.
  const root = path.join("R", "repo");
  const tree = new Map<string, readonly string[]>([
    [root, ["pipe_tools", "pipe_other"]],
    [path.join(root, "pipe_tools"), ["bin"]],
    [path.join(root, "pipe_tools", "bin"), []],
    [path.join(root, "pipe_other"), ["1.0.0"]],
    [path.join(root, "pipe_other", "1.0.0"), []]
  ]);
  const files = new Set([
    path.join(root, "pipe_tools", "package.py"),
    path.join(root, "pipe_other", "1.0.0", "package.py")
  ]);
  const fake: SyncFsFacade = {
    listDirectories: (dir) => tree.get(dir) ?? [],
    fileExists: (file) => files.has(file),
    directoryExists: (dir) => tree.has(dir)
  };

  const plan = buildSyncPlan("R", ["repo"], fake);
  assert.deepEqual(plan.entries, [{ subtree: "repo", mode: "package-repo", sourceExists: true, excludeDirs: [] }]);
  assert.deepEqual(plan.skippedVersions, []);
});
