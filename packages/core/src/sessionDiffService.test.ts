/**
 * Unit tests for the Stage 4 session diff service: change detection,
 * rename pairing, single-file accept, revert, and explicit unsupported files.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DiffFileChange, SessionId } from "@drydock/contracts";
import type { Clock } from "./clock.js";
import { RandomIdGenerator } from "./ids.js";
import type { Logger } from "./logger.js";
import { SessionDiffService } from "./sessionDiffService.js";
import { MemoryBlobStore, MemoryDiffBaselineStore } from "./testSupport/memoryDiffStores.js";

test("diff detects add, modify, delete, and rename-like pairs", async () => {
  const harness = await makeHarness();
  try {
    await writeFile(file(harness.root, "kept.txt"), "kept");
    await writeFile(file(harness.root, "changed.txt"), "before");
    await writeFile(file(harness.root, "removed.txt"), "removed");
    await writeFile(file(harness.root, "moved.txt"), "identical-content");
    await mkdir(path.join(harness.root, ".git"));
    await writeFile(file(harness.root, ".git/config"), "excluded");
    const baseline = await harness.service.createBaseline({ scope: "current-session", rootPath: harness.root });

    await writeFile(file(harness.root, "changed.txt"), "after");
    await writeFile(file(harness.root, "created.txt"), "brand new");
    await rm(file(harness.root, "removed.txt"));
    await rename(file(harness.root, "moved.txt"), file(harness.root, "renamed.txt"));

    const changes = await harness.service.computeDiff(baseline.baselineId);
    const byPath = new Map(changes.map((change) => [change.path, change]));

    assert.equal(changes.length, 4);
    assert.equal(byPath.get("changed.txt")?.changeKind, "modify");
    assert.equal(byPath.get("created.txt")?.changeKind, "add");
    assert.equal(byPath.get("removed.txt")?.changeKind, "delete");
    assert.equal(byPath.get("renamed.txt")?.changeKind, "rename");
    assert.equal(byPath.get("renamed.txt")?.oldPath, "moved.txt");
    assert.equal(byPath.has(".git/config"), false);
    assert.equal(changes.every((change) => change.revertSupported), true);
  } finally {
    await harness.cleanup();
  }
});

test("line stats: modify counts real churn, add counts inserts, binary is omitted", async () => {
  const harness = await makeHarness();
  try {
    await writeFile(file(harness.root, "edited.txt"), "a\nb\nc\n");
    // A NUL byte makes this file binary; its stats must be omitted on modify.
    await writeFile(file(harness.root, "image.bin"), Buffer.from([0x89, 0x00, 0x50, 0x4e]));
    const baseline = await harness.service.createBaseline({ scope: "current-session", rootPath: harness.root });

    await writeFile(file(harness.root, "edited.txt"), "a\nB\nc\nd\n"); // b→B modified, d inserted
    await writeFile(file(harness.root, "added.txt"), "one\ntwo\nthree\n"); // 3 new lines
    await writeFile(file(harness.root, "image.bin"), Buffer.from([0x89, 0x00, 0x50, 0x99]));

    const changes = await harness.service.computeDiff(baseline.baselineId);
    const byPath = new Map(changes.map((change) => [change.path, change]));

    const edited = byPath.get("edited.txt");
    assert.equal(edited?.addedLines, 2);
    assert.equal(edited?.removedLines, 1);

    const added = byPath.get("added.txt");
    assert.equal(added?.addedLines, 3);
    assert.equal(added?.removedLines, 0);

    const binary = byPath.get("image.bin");
    assert.equal(binary?.changeKind, "modify");
    assert.equal(binary?.addedLines, undefined);
    assert.equal(binary?.removedLines, undefined);
  } finally {
    await harness.cleanup();
  }
});

test("line stats: delete counts baseline lines, oversized modify omits stats", async () => {
  const harness = await makeHarness({ maxBlobBytes: 8 });
  try {
    await writeFile(file(harness.root, "gone.txt"), "x\ny"); // <= 8 bytes: text stats available
    await writeFile(file(harness.root, "big.txt"), "way-more-than-eight-bytes\nsecond");
    const baseline = await harness.service.createBaseline({ scope: "current-session", rootPath: harness.root });

    await rm(file(harness.root, "gone.txt"));
    await writeFile(file(harness.root, "big.txt"), "still-way-more-than-eight\nchanged");

    const changes = await harness.service.computeDiff(baseline.baselineId);
    const byPath = new Map(changes.map((change) => [change.path, change]));

    const gone = byPath.get("gone.txt");
    assert.equal(gone?.changeKind, "delete");
    assert.equal(gone?.addedLines, 0);
    assert.equal(gone?.removedLines, 2);

    // Over the blob cap on both sides: line stats omitted (revert also unsupported).
    const big = byPath.get("big.txt");
    assert.equal(big?.changeKind, "modify");
    assert.equal(big?.addedLines, undefined);
    assert.equal(big?.removedLines, undefined);
  } finally {
    await harness.cleanup();
  }
});

test("readBaselineText returns baseline content and null for added files", async () => {
  const harness = await makeHarness();
  try {
    await writeFile(file(harness.root, "tracked.txt"), "original\ncontent");
    const baseline = await harness.service.createBaseline({ scope: "current-session", rootPath: harness.root });
    await writeFile(file(harness.root, "tracked.txt"), "edited");

    assert.equal(await harness.service.readBaselineText(baseline.baselineId, "tracked.txt"), "original\ncontent");
    // Not in the baseline (would be an add): null, so the diff editor shows an empty left side.
    assert.equal(await harness.service.readBaselineText(baseline.baselineId, "brand-new.txt"), null);
  } finally {
    await harness.cleanup();
  }
});

test("accepting one file resets only that file's baseline", async () => {
  const harness = await makeHarness();
  try {
    await writeFile(file(harness.root, "a.txt"), "a1");
    await writeFile(file(harness.root, "b.txt"), "b1");
    const baseline = await harness.service.createBaseline({ scope: "current-session", rootPath: harness.root });

    await writeFile(file(harness.root, "a.txt"), "a2");
    await writeFile(file(harness.root, "b.txt"), "b2");
    await harness.service.acceptFile(baseline.baselineId, "a.txt");

    const changes = await harness.service.computeDiff(baseline.baselineId);
    assert.deepEqual(changes.map((change) => change.path), ["b.txt"]);
  } finally {
    await harness.cleanup();
  }
});

test("cloneBaseline copies snapshots into a new scope without re-walking; delete removes it", async () => {
  const harness = await makeHarness();
  try {
    await writeFile(file(harness.root, "a.txt"), "a1");
    const working = await harness.service.createBaseline({
      scope: "current-session",
      sessionId: "session-1" as SessionId,
      rootPath: harness.root
    });
    const copy = await harness.service.cloneBaseline(working.baselineId, "session-start");

    assert.equal(copy.scope, "session-start");
    assert.equal(copy.sessionId, "session-1");
    assert.equal(copy.rootPath, working.rootPath);
    assert.notEqual(copy.baselineId, working.baselineId);
    // The copy diffs independently: an edit shows against BOTH, and accepting
    // into the working baseline leaves the copy's snapshot untouched.
    await writeFile(file(harness.root, "a.txt"), "a2");
    await harness.service.acceptFile(working.baselineId, "a.txt");
    assert.deepEqual(await harness.service.computeDiff(working.baselineId), []);
    assert.equal((await harness.service.computeDiff(copy.baselineId)).length, 1);

    await harness.service.deleteBaseline(copy.baselineId);
    assert.equal(await harness.service.getBaseline(copy.baselineId), null);
    await assert.rejects(harness.service.computeDiff(copy.baselineId), /not found/);
  } finally {
    await harness.cleanup();
  }
});

test("revert restores modified and deleted files and deletes added files", async () => {
  const harness = await makeHarness();
  try {
    await writeFile(file(harness.root, "modified.txt"), "original");
    await writeFile(file(harness.root, "deleted.txt"), "original-deleted");
    const baseline = await harness.service.createBaseline({ scope: "current-session", rootPath: harness.root });

    await writeFile(file(harness.root, "modified.txt"), "tampered");
    await rm(file(harness.root, "deleted.txt"));
    await writeFile(file(harness.root, "added.txt"), "should go away");

    await harness.service.revertFile(baseline.baselineId, "modified.txt");
    await harness.service.revertFile(baseline.baselineId, "deleted.txt");
    await harness.service.revertFile(baseline.baselineId, "added.txt");

    assert.equal(await readFile(file(harness.root, "modified.txt"), "utf8"), "original");
    assert.equal(await readFile(file(harness.root, "deleted.txt"), "utf8"), "original-deleted");
    await assert.rejects(stat(file(harness.root, "added.txt")));
    assert.deepEqual(await harness.service.computeDiff(baseline.baselineId), []);

    // Traversal outside the root is refused before any write happens.
    await assert.rejects(harness.service.revertFile(baseline.baselineId, "../escape.txt"), /escapes/);
  } finally {
    await harness.cleanup();
  }
});

test("accept and revert refuse intermediate links that redirect outside the baseline root", async (t) => {
  const harness = await makeHarness();
  try {
    const originalDirectory = path.join(harness.root, "redirect");
    const outsideDirectory = path.join(path.dirname(harness.root), "outside");
    await mkdir(originalDirectory);
    await mkdir(outsideDirectory);
    await writeFile(path.join(originalDirectory, "tracked.txt"), "baseline");
    const baseline = await harness.service.createBaseline({ scope: "current-session", rootPath: harness.root });

    await rm(originalDirectory, { recursive: true });
    await writeFile(path.join(outsideDirectory, "tracked.txt"), "outside-safe");
    await writeFile(path.join(outsideDirectory, "added.txt"), "must-not-delete");
    try {
      await symlink(outsideDirectory, originalDirectory, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("This Windows account cannot create symbolic links.");
        return;
      }
      throw error;
    }

    await assert.rejects(
      harness.service.acceptFile(baseline.baselineId, "redirect/tracked.txt"),
      /symbolic link|junction/
    );
    await assert.rejects(
      harness.service.revertFile(baseline.baselineId, "redirect/tracked.txt"),
      /symbolic link|junction/
    );
    await assert.rejects(
      harness.service.revertFile(baseline.baselineId, "redirect/added.txt"),
      /symbolic link|junction/
    );
    assert.equal(await readFile(path.join(outsideDirectory, "tracked.txt"), "utf8"), "outside-safe");
    assert.equal(await readFile(path.join(outsideDirectory, "added.txt"), "utf8"), "must-not-delete");
  } finally {
    await harness.cleanup();
  }
});

test("diff file APIs reject absolute and drive-qualified paths on every host", async () => {
  const harness = await makeHarness();
  try {
    const baseline = await harness.service.createBaseline({ scope: "current-session", rootPath: harness.root });
    await assert.rejects(harness.service.revertFile(baseline.baselineId, "/outside.txt"), /relative/);
    await assert.rejects(harness.service.acceptFile(baseline.baselineId, "C:\\outside.txt"), /relative/);
    await assert.rejects(harness.service.revertFile(baseline.baselineId, "\\\\server\\share\\outside.txt"), /relative/);

    const gitConfig = file(harness.root, ".git/config");
    await mkdir(path.dirname(gitConfig), { recursive: true });
    await writeFile(gitConfig, "safe");
    await assert.rejects(harness.service.revertFile(baseline.baselineId, ".git/config"), /excluded/);
    assert.equal(await readFile(gitConfig, "utf8"), "safe");
  } finally {
    await harness.cleanup();
  }
});

test("files over the blob cap are tracked but explicitly non-revertable", async () => {
  const harness = await makeHarness({ maxBlobBytes: 8 });
  try {
    await writeFile(file(harness.root, "big.bin"), "way-more-than-eight-bytes");
    const baseline = await harness.service.createBaseline({ scope: "current-session", rootPath: harness.root });

    await writeFile(file(harness.root, "big.bin"), "different-oversized-content");
    const changes = await harness.service.computeDiff(baseline.baselineId);
    const change = changes[0] as DiffFileChange;

    assert.equal(changes.length, 1);
    assert.equal(change.changeKind, "modify");
    assert.equal(change.revertSupported, false);
    assert.match(change.reason ?? "", /cap/);
    await assert.rejects(harness.service.revertFile(baseline.baselineId, "big.bin"), /not supported/);
  } finally {
    await harness.cleanup();
  }
});

test("denied paths are excluded from snapshots and diffs", async () => {
  const harness = await makeHarness();
  try {
    const deniedDir = path.join(harness.root, "denied");
    await mkdir(deniedDir);
    const denyingService = new SessionDiffService({
      ids: new RandomIdGenerator(),
      clock: fixedClock(),
      logger: nullLogger(),
      store: new MemoryDiffBaselineStore(),
      blobs: harness.blobs,
      deniedPaths: [deniedDir]
    });
    await writeFile(file(harness.root, "visible.txt"), "visible");
    await writeFile(file(harness.root, "denied/secret.txt"), "secret");
    const baseline = await denyingService.createBaseline({ scope: "workspace", rootPath: harness.root });

    await writeFile(file(harness.root, "denied/secret.txt"), "changed secret");
    const changes = await denyingService.computeDiff(baseline.baselineId);
    assert.deepEqual(changes, []);
    await assert.rejects(denyingService.acceptFile(baseline.baselineId, "denied/secret.txt"), /denied/);
    await assert.rejects(denyingService.revertFile(baseline.baselineId, "denied/secret.txt"), /denied/);
    assert.equal(await readFile(file(harness.root, "denied/secret.txt"), "utf8"), "changed secret");
  } finally {
    await harness.cleanup();
  }
});

interface Harness {
  readonly root: string;
  readonly service: SessionDiffService;
  readonly blobs: MemoryBlobStore;
  cleanup(): Promise<void>;
}

async function makeHarness(options?: { readonly maxBlobBytes?: number }): Promise<Harness> {
  const base = await mkdtemp(path.join(os.tmpdir(), "drydock-diff-"));
  const root = path.join(base, "workspace");
  await mkdir(root);
  const blobs = new MemoryBlobStore();
  const service = new SessionDiffService({
    ids: new RandomIdGenerator(),
    clock: fixedClock(),
    logger: nullLogger(),
    store: new MemoryDiffBaselineStore(),
    blobs,
    ...(options?.maxBlobBytes === undefined ? {} : { maxBlobBytes: options.maxBlobBytes })
  });
  return {
    root,
    service,
    blobs,
    cleanup: () => rm(base, { recursive: true, force: true })
  };
}

function file(root: string, relative: string): string {
  return path.join(root, relative);
}

function fixedClock(): Clock {
  return {
    now: () => new Date("2026-07-02T00:00:00.000Z"),
    isoNow: () => "2026-07-02T00:00:00.000Z"
  };
}

function nullLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}
