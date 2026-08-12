/**
 * Manifest tests: the allowlist is only worth something if bad entries bounce.
 *
 * Each rejection asserts on the message text, because the message is the
 * product here — a TD editing the allowlist has to be told what to write
 * instead (ADR 0022 / edge case G3).
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectManifestProblems, loadManifest, saveManifest, validateManifest } from "./manifest.js";
import type { MirrorManifest } from "./manifest.js";

function validManifest(): MirrorManifest {
  return {
    version: 3,
    updatedAt: "2026-08-12T09:00:00.000Z",
    sourceRoot: "P:\\",
    mirrorRoot: "D:\\pkgroot",
    shareName: "pkgroot",
    subtrees: ["Pipeline\\rez\\packages\\internal", "Pipeline\\rez\\packages\\external"],
    stubDirs: ["Projects"],
    redirects: [{ env: "STUDIO_ASSET_API_ROOT", from: "P:\\Projects", mode: "stub" }]
  };
}

function rejects(value: unknown, needle: string): void {
  assert.throws(
    () => validateManifest(value),
    (error: unknown) => {
      assert.ok(error instanceof Error, "expected an Error");
      assert.ok(
        error.message.includes(needle),
        `expected message to mention "${needle}", got:\n${error.message}`
      );
      return true;
    }
  );
}

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "drydock-pkgroot-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("valid manifest round-trips through save and load", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "pkgroot-manifest.json");
    const manifest = validManifest();
    await saveManifest(file, manifest);
    assert.deepEqual(await loadManifest(file), manifest);
    assert.deepEqual(collectManifestProblems(manifest), []);
  });
});

test("forward slashes normalize to backslashes on load", () => {
  const manifest = validateManifest({ ...validManifest(), subtrees: ["Pipeline/rez/packages/internal"] });
  assert.deepEqual(manifest.subtrees, ["Pipeline\\rez\\packages\\internal"]);
});

test("version must be a positive integer", () => {
  rejects({ ...validManifest(), version: 0 }, "version must be a positive integer");
  rejects({ ...validManifest(), version: 1.5 }, "version must be a positive integer");
  rejects({ ...validManifest(), version: "3" }, "version must be a positive integer");
});

test("absolute subtree entries are rejected", () => {
  rejects({ ...validManifest(), subtrees: ["\\Pipeline\\rez"] }, 'subtrees[0] "\\Pipeline\\rez" is absolute');
});

test("drive letters inside entries are rejected", () => {
  rejects({ ...validManifest(), subtrees: ["P:\\Pipeline\\rez"] }, "carries a drive letter");
});

test("parent-directory segments are rejected", () => {
  rejects({ ...validManifest(), subtrees: ["Pipeline\\..\\..\\Windows"] }, "escapes the source root");
});

test("duplicate entries are rejected", () => {
  rejects(
    { ...validManifest(), subtrees: ["Pipeline\\rez", "pipeline/rez"] },
    "duplicates subtrees[0]"
  );
});

test("a stub that overlaps a mirrored subtree is rejected", () => {
  rejects({ ...validManifest(), stubDirs: ["Pipeline"] }, "a stub is an empty directory");
});

test("nested subtrees are rejected", () => {
  rejects(
    { ...validManifest(), subtrees: ["Pipeline\\rez", "Pipeline\\rez\\packages\\internal"] },
    "delete each other's files"
  );
});

test("redirect entries need an env name, a source root and a known mode", () => {
  rejects(
    { ...validManifest(), redirects: [{ env: "STUDIO ASSET", from: "P:\\Projects", mode: "stub" }] },
    "must be an environment variable name"
  );
  rejects(
    { ...validManifest(), redirects: [{ env: "STUDIO_ASSET_API_ROOT", from: "P:\\Projects", mode: "open" }] },
    'must be "stub"'
  );
  rejects(
    {
      ...validManifest(),
      redirects: [
        { env: "STUDIO_ASSET_API_ROOT", from: "P:\\Projects", mode: "stub" },
        { env: "STUDIO_ASSET_API_ROOT", from: "P:\\Projects", mode: "fixture" }
      ]
    },
    "one entry per variable"
  );
});

test("share name must be a bare share name", () => {
  rejects({ ...validManifest(), shareName: "host\\pkgroot" }, "must be a bare share name");
});

test("roots must be absolute", () => {
  rejects({ ...validManifest(), mirrorRoot: "pkgroot" }, "must be an absolute path");
});

test("a missing manifest file says so without a stack trace", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "absent.json");
    await assert.rejects(loadManifest(file), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(`No mirror manifest at ${file}`), error.message);
      assert.ok(!error.message.includes("at Object."), "message must not carry a stack trace");
      return true;
    });
  });
});

test("unparseable manifest JSON names the file", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "broken.json");
    await writeFile(file, "{ \"version\": 1, ", "utf8");
    await assert.rejects(loadManifest(file), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(`Mirror manifest ${file} is not valid JSON`), error.message);
      return true;
    });
  });
});
