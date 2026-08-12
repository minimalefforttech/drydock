/**
 * CLI end-to-end: the compiled entry point is spawned the way a hook or the
 * extension would spawn it, and its stdout must be parseable JSON.
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { saveManifest } from "./manifest.js";
import type { MirrorManifest } from "./manifest.js";
import { joinUnderRoot } from "./syncPlan.js";

const CLI = fileURLToPath(new URL("./index.js", import.meta.url));
const INTERNAL = "Pipeline\\rez\\packages\\internal";

interface CliRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: readonly string[]): Promise<CliRun> {
  return new Promise<CliRun>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("plan prints the sync plan as JSON", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "drydock-xroot-"));
  try {
    const sourceRoot = path.join(root, "share");
    const definition = joinUnderRoot(sourceRoot, `${INTERNAL}\\fr_core\\1.0.0\\package.py`);
    await mkdir(path.dirname(definition), { recursive: true });
    await writeFile(definition, 'name = "fr_core"\n', "utf8");
    await mkdir(joinUnderRoot(sourceRoot, `${INTERNAL}\\fr_core\\2.0.0`), { recursive: true });

    const manifest: MirrorManifest = {
      version: 2,
      updatedAt: "2026-08-12T09:00:00.000Z",
      sourceRoot,
      mirrorRoot: path.join(root, "xroot"),
      shareName: "xroot",
      subtrees: [INTERNAL],
      stubDirs: ["Projects"],
      redirects: []
    };
    const manifestPath = path.join(root, "xroot-manifest.json");
    await saveManifest(manifestPath, manifest);

    const run = await runCli(["plan", "--manifest", manifestPath]);
    assert.equal(run.code, 0, run.stderr);
    const parsed = JSON.parse(run.stdout) as {
      manifestVersion: number;
      entries: { subtree: string; mode: string; excludeDirs: string[] }[];
      skippedVersions: string[];
    };
    assert.equal(parsed.manifestVersion, 2);
    assert.deepEqual(parsed.skippedVersions, [`${INTERNAL}\\fr_core\\2.0.0`]);
    assert.equal(parsed.entries.length, 1);
    assert.equal(parsed.entries[0]?.mode, "package-repo");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing manifest flag fails on stderr with exit 1", async () => {
  const run = await runCli(["plan"]);
  assert.equal(run.code, 1);
  assert.equal(run.stdout, "");
  assert.ok(run.stderr.includes("--manifest <path> is required"), run.stderr);
});
