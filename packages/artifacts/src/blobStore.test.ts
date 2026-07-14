/**
 * Unit tests for the content-addressed blob store.
 */

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

    const text = await store.putText("direct text");
    assert.equal(text.size, Buffer.byteLength("direct text"));
    assert.equal(Buffer.from((await store.readBlob(text.sha256)) ?? []).toString("utf8"), "direct text");

    const bytes = Uint8Array.from([0, 1, 2, 255]);
    const binary = await store.putBytes(bytes);
    assert.deepEqual([...((await store.readBlob(binary.sha256)) ?? [])], [...bytes]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("putFile hashes and sizes its private snapshot when the source changes after copy", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "drydock-blob-snapshot-"));
  try {
    const source = path.join(base, "changing.txt");
    const before = "bytes captured by the store";
    const after = "source changed after snapshot";
    await writeFile(source, before);
    const store = new ContentAddressedBlobStore(path.join(base, "blobs"), async (sourcePath) => {
      // Runs after the store-owned copy and before its hash/stat. This makes the
      // old hash-source/copy-source race deterministic instead of timing-based.
      await writeFile(sourcePath, after);
    });

    const put = await store.putFile(source);
    const beforeDigest = createHash("sha256").update(before).digest("hex");
    const afterDigest = createHash("sha256").update(after).digest("hex");

    assert.equal(put.sha256, beforeDigest);
    assert.equal(put.size, Buffer.byteLength(before));
    assert.equal(Buffer.from((await store.readBlob(put.sha256)) ?? []).toString("utf8"), before);
    assert.equal(await store.hasBlob(afterDigest), false);
    assert.equal(await readFile(source, "utf8"), after);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
