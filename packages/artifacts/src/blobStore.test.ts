/**
 * Unit tests for the content-addressed blob store.
 */

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ContentAddressedBlobStore } from "./blobStore.js";

test("blobs deduplicate by digest and read back byte-identical", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "drydock-blobs-"));
  try {
    const store = new ContentAddressedBlobStore(path.join(base, "blobs"));
    const fileA = path.join(base, "a.txt");
    const fileB = path.join(base, "b.txt");
    await writeFile(fileA, "same content");
    await writeFile(fileB, "same content");

    const first = await store.putFile(fileA);
    const second = await store.putFile(fileB);
    const expected = createHash("sha256").update("same content").digest("hex");

    assert.equal(first.sha256, expected);
    assert.equal(second.sha256, expected);
    assert.equal(first.size, "same content".length);
    assert.equal(await store.hasBlob(expected), true);
    assert.equal(Buffer.from((await store.readBlob(expected)) ?? []).toString("utf8"), "same content");

    assert.equal(await store.readBlob("f".repeat(64)), null);
    // Malformed digests can never resolve to a path (traversal guard).
    assert.equal(await store.readBlob("../not-a-digest"), null);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
