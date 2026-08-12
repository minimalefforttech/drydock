/**
 * Robocopy tests. These run the real `robocopy.exe` against real temp trees:
 * the exit-code bitfield and `/MIR` deletion semantics are the whole point of
 * this module, and a fake process would only test the fake.
 *
 * Non-Windows hosts skip the process tests; the parsing and argument-shape
 * tests are pure and always run.
 */

import { strict as assert } from "node:assert";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { MirrorManifest } from "./manifest.js";
import { buildSyncPlan, joinUnderRoot } from "./syncPlan.js";
import {
  buildRobocopyCommands,
  countRobocopyRecords,
  describeRobocopyExit,
  ensureStubDirs,
  MIRROR_STATE_FILE_NAME,
  ROBOCOPY_FIXED_ARGS,
  robocopyOk,
  runRobocopy,
  syncMirror
} from "./robocopyRunner.js";

const INTERNAL = "Pipeline\\rez\\packages\\internal";

interface Fixture {
  readonly root: string;
  readonly manifest: MirrorManifest;
  readonly cleanup: () => Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "drydock-pkgroot-"));
  const sourceRoot = path.join(root, "share");
  const mirrorRoot = path.join(root, "pkgroot");
  const files: readonly string[] = [
    `${INTERNAL}\\pipe_core\\1.0.0\\package.py`,
    `${INTERNAL}\\pipe_core\\1.0.0\\python\\pipe_core\\__init__.py`,
    `${INTERNAL}\\pipe_rig\\2.3.1\\package.py`
  ];
  for (const file of files) {
    const abs = joinUnderRoot(sourceRoot, file);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, "# fixture\n", "utf8");
  }
  // Torn version: payload without a definition file.
  await mkdir(joinUnderRoot(sourceRoot, `${INTERNAL}\\pipe_core\\2.0.0`), { recursive: true });
  await writeFile(joinUnderRoot(sourceRoot, `${INTERNAL}\\pipe_core\\2.0.0\\half.py`), "# torn\n", "utf8");

  const manifest: MirrorManifest = {
    version: 7,
    updatedAt: "2026-08-12T09:00:00.000Z",
    sourceRoot,
    mirrorRoot,
    shareName: "pkgroot",
    subtrees: [INTERNAL],
    stubDirs: ["Projects"],
    redirects: [{ env: "STUDIO_ASSET_API_ROOT", from: "P:\\Projects", mode: "stub" }]
  };
  return { root, manifest, cleanup: async (): Promise<void> => rm(root, { recursive: true, force: true }) };
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

test("real robocopy: initial mirror, no-change run, deletion, torn skip, state file", async (t) => {
  if (process.platform !== "win32") {
    t.skip("robocopy is Windows-only");
    return;
  }
  const fixture = await makeFixture();
  const { manifest } = fixture;
  try {
    const plan = buildSyncPlan(manifest.sourceRoot, manifest.subtrees);
    assert.deepEqual(plan.skippedVersions, [`${INTERNAL}\\pipe_core\\2.0.0`]);

    // 1. Initial sync: files copied is exit code 1, which is success.
    const first = await syncMirror(manifest, plan, { now: () => new Date("2026-08-12T10:00:00.000Z") });
    const firstResult = first.results[0];
    if (firstResult === undefined) throw new Error("no subtree result");
    assert.equal(first.ok, true);
    assert.equal(firstResult.exitCode, 1, "files copied");
    assert.equal(firstResult.ok, true);
    assert.equal(firstResult.copied, 3);
    assert.equal(firstResult.error, undefined);

    const mirroredDefinition = joinUnderRoot(manifest.mirrorRoot, `${INTERNAL}\\pipe_core\\1.0.0\\package.py`);
    assert.equal(await exists(mirroredDefinition), true, "definition file must be mirrored");

    // 2. The torn version never reaches the mirror (edge case E2).
    assert.equal(
      await exists(joinUnderRoot(manifest.mirrorRoot, `${INTERNAL}\\pipe_core\\2.0.0`)),
      false,
      "torn version must be excluded from the mirror"
    );

    // 3. Stub directory exists and is empty (P:\Projects fails closed).
    const stub = joinUnderRoot(manifest.mirrorRoot, "Projects");
    assert.deepEqual(first.stubDirs, [stub]);
    assert.deepEqual(await readdir(stub), []);

    // 4. State file carries the manifest version and the skip report.
    const stateFile = path.join(manifest.mirrorRoot, MIRROR_STATE_FILE_NAME);
    assert.equal(first.stateFile, stateFile);
    const state = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, unknown>;
    assert.equal(state["manifestVersion"], 7);
    assert.equal(state["syncedAt"], "2026-08-12T10:00:00.000Z");
    assert.deepEqual(state["subtrees"], [{ subtree: INTERNAL, ok: true, exitCode: 1 }]);
    assert.deepEqual(state["skippedVersions"], [`${INTERNAL}\\pipe_core\\2.0.0`]);

    // 5. Re-run with nothing to do: exit 0, still ok.
    const second = await syncMirror(manifest, plan);
    const secondResult = second.results[0];
    if (secondResult === undefined) throw new Error("no subtree result");
    assert.equal(secondResult.exitCode, 0, "no change");
    assert.equal(secondResult.ok, true);
    assert.equal(secondResult.copied, 0);

    // 6. /MIR removes what the source dropped; extras-removed is exit bit 2.
    await rm(joinUnderRoot(manifest.sourceRoot, `${INTERNAL}\\pipe_core\\1.0.0\\python\\pipe_core\\__init__.py`));
    const third = await syncMirror(manifest, plan);
    const thirdResult = third.results[0];
    if (thirdResult === undefined) throw new Error("no subtree result");
    assert.equal(thirdResult.ok, true, "extras removed is a successful run");
    assert.equal(thirdResult.exitCode & 2, 2, `expected the extras bit, got ${String(thirdResult.exitCode)}`);
    assert.equal(thirdResult.removed, 1);
    assert.equal(
      await exists(joinUnderRoot(manifest.mirrorRoot, `${INTERNAL}\\pipe_core\\1.0.0\\python\\pipe_core\\__init__.py`)),
      false,
      "/MIR must remove files the source dropped"
    );
  } finally {
    await fixture.cleanup();
  }
});

test("real robocopy: a missing source subtree fails with its own exit code", async (t) => {
  if (process.platform !== "win32") {
    t.skip("robocopy is Windows-only");
    return;
  }
  const fixture = await makeFixture();
  try {
    const manifest: MirrorManifest = { ...fixture.manifest, subtrees: ["Pipeline\\absent"] };
    const plan = buildSyncPlan(manifest.sourceRoot, manifest.subtrees);
    const outcome = await syncMirror(manifest, plan);
    const result = outcome.results[0];
    if (result === undefined) throw new Error("no subtree result");

    assert.equal(outcome.ok, false);
    assert.equal(result.ok, false);
    assert.ok(result.exitCode >= 8, `expected a failure code, got ${String(result.exitCode)}`);
    assert.ok((result.error ?? "").includes("Pipeline\\absent"), result.error);

    // The state file still records the failed run: unknown beats a stale green.
    const state = JSON.parse(
      await readFile(path.join(manifest.mirrorRoot, MIRROR_STATE_FILE_NAME), "utf8")
    ) as Record<string, unknown>;
    assert.deepEqual(state["subtrees"], [{ subtree: "Pipeline\\absent", ok: false, exitCode: result.exitCode }]);
  } finally {
    await fixture.cleanup();
  }
});

test("real robocopy: a missing executable is a result, not a crash", async (t) => {
  if (process.platform !== "win32") {
    t.skip("robocopy is Windows-only");
    return;
  }
  const fixture = await makeFixture();
  try {
    const plan = buildSyncPlan(fixture.manifest.sourceRoot, fixture.manifest.subtrees);
    const command = buildRobocopyCommands(plan, fixture.manifest.mirrorRoot, path.join(fixture.root, "no-such.exe"))[0];
    if (command === undefined) throw new Error("no command built");
    const result = await runRobocopy(command);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, -1);
    assert.ok((result.error ?? "").includes("--robocopy"), result.error);
  } finally {
    await fixture.cleanup();
  }
});

test("exit codes read as a bitfield, not an errorlevel", () => {
  assert.equal(robocopyOk(0), true);
  assert.equal(robocopyOk(1), true);
  assert.equal(robocopyOk(3), true);
  assert.equal(robocopyOk(7), true);
  assert.equal(robocopyOk(8), false);
  assert.equal(robocopyOk(16), false);
  assert.equal(robocopyOk(-1), false);
  assert.equal(describeRobocopyExit(0), "no change");
  assert.equal(describeRobocopyExit(3), "files copied; extra files removed");
  assert.equal(describeRobocopyExit(16), "fatal error; no files copied");
  assert.equal(describeRobocopyExit(-1), "robocopy did not start");
});

test("arguments are a fixed list plus validated paths", async () => {
  const fixture = await makeFixture();
  try {
    const plan = buildSyncPlan(fixture.manifest.sourceRoot, fixture.manifest.subtrees);
    const command = buildRobocopyCommands(plan, fixture.manifest.mirrorRoot)[0];
    if (command === undefined) throw new Error("no command built");
    const torn = joinUnderRoot(fixture.manifest.sourceRoot, `${INTERNAL}\\pipe_core\\2.0.0`);
    assert.deepEqual(command.args, [
      joinUnderRoot(fixture.manifest.sourceRoot, INTERNAL),
      joinUnderRoot(fixture.manifest.mirrorRoot, INTERNAL),
      ...ROBOCOPY_FIXED_ARGS,
      "/XD",
      torn
    ]);
    assert.equal(command.exe.endsWith("robocopy.exe"), true);
  } finally {
    await fixture.cleanup();
  }
});

test("per-file records separate copies from /MIR deletions", () => {
  const stdout = [
    "",
    "\t    New File  \t\t       7\tC:\\src\\a.txt",
    "\t    Changed   \t\t       8\tC:\\src\\b.txt",
    "\t  *EXTRA File \t\t       7\tC:\\dst\\gone.txt",
    ""
  ].join("\r\n");
  assert.deepEqual(countRobocopyRecords(stdout), { copied: 2, removed: 1 });
});

test("stub directories are created empty and are idempotent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "drydock-pkgroot-"));
  try {
    const first = await ensureStubDirs(root, ["Projects", "Scratch\\Deep"]);
    assert.deepEqual(first, [path.join(root, "Projects"), path.join(root, "Scratch", "Deep")]);
    assert.deepEqual(await readdir(path.join(root, "Projects")), []);
    await ensureStubDirs(root, ["Projects"]);
    assert.deepEqual(await readdir(path.join(root, "Projects")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a plan from a different source root is refused", async () => {
  const fixture = await makeFixture();
  try {
    const plan = buildSyncPlan(path.join(fixture.root, "elsewhere"), fixture.manifest.subtrees);
    await assert.rejects(syncMirror(fixture.manifest, plan), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes("Rebuild the plan from this manifest"), error.message);
      return true;
    });
  } finally {
    await fixture.cleanup();
  }
});
