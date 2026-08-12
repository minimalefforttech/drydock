/**
 * Mirror status tests. The reader is the receipt's only source of truth about
 * the mirror, so the failure modes matter as much as the happy path: anything
 * it cannot establish must read as null (unknown), never as a green default.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MIRROR_STATE_FILE_NAME, readMirrorStatus } from "./xrootMirrorStatus.js";

async function withMirrorRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "drydock-xroot-"));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeState(root: string, content: string): Promise<void> {
  await writeFile(join(root, MIRROR_STATE_FILE_NAME), content, "utf8");
}

test("reads a written state file", async () => {
  await withMirrorRoot(async (root) => {
    await writeState(
      root,
      JSON.stringify({
        manifestVersion: 7,
        syncedAt: "2026-08-12T10:00:00.000Z",
        subtrees: [
          { subtree: "Pipeline\\rez\\packages\\internal", ok: true, exitCode: 1 },
          { subtree: "Pipeline\\rez\\packages\\external", ok: true, exitCode: 0 }
        ],
        skippedVersions: ["Pipeline\\rez\\packages\\internal\\fr_core\\2.0.0"]
      })
    );
    assert.deepEqual(await readMirrorStatus(root), {
      manifestVersion: 7,
      syncedAt: "2026-08-12T10:00:00.000Z",
      ok: true,
      skippedVersions: ["Pipeline\\rez\\packages\\internal\\fr_core\\2.0.0"]
    });
  });
});

test("one failed subtree makes the mirror not ok", async () => {
  await withMirrorRoot(async (root) => {
    await writeState(
      root,
      JSON.stringify({
        manifestVersion: 7,
        syncedAt: "2026-08-12T10:00:00.000Z",
        subtrees: [
          { subtree: "Pipeline\\rez\\packages\\internal", ok: true, exitCode: 1 },
          { subtree: "Pipeline\\rez\\packages\\staging", ok: false, exitCode: 16 }
        ],
        skippedVersions: []
      })
    );
    const status = await readMirrorStatus(root);
    assert.equal(status?.ok, false);
    assert.deepEqual(status?.skippedVersions, []);
  });
});

test("an absent state file is unknown, not a failure", async () => {
  await withMirrorRoot(async (root) => {
    assert.equal(await readMirrorStatus(root), null);
  });
});

test("corrupt JSON is unknown", async () => {
  await withMirrorRoot(async (root) => {
    await writeState(root, '{ "manifestVersion": 7, ');
    assert.equal(await readMirrorStatus(root), null);
  });
});

test("a state file missing required fields is unknown", async () => {
  await withMirrorRoot(async (root) => {
    await writeState(root, JSON.stringify({ syncedAt: "2026-08-12T10:00:00.000Z", subtrees: [] }));
    assert.equal(await readMirrorStatus(root), null);

    await writeState(root, JSON.stringify({ manifestVersion: 7, syncedAt: "2026-08-12T10:00:00.000Z" }));
    assert.equal(await readMirrorStatus(root), null);
  });
});
