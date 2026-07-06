/**
 * Content-addressed blob store (Stage 4 diff baselines).
 *
 * Blobs live under `<root>/sha256/<aa>/<sha>` and are deduplicated by digest.
 * Writes go through a temp file plus rename so a crashed write never leaves a
 * half-written blob behind a valid digest path.
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { BlobStore } from "@drydock/contracts";

export class ContentAddressedBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  async putFile(absolutePath: string): Promise<{ readonly sha256: string; readonly size: number }> {
    const [sha256, fileStat] = await Promise.all([hashFile(absolutePath), stat(absolutePath)]);
    const target = this.blobPath(sha256);
    if (!await exists(target)) {
      await mkdir(path.dirname(target), { recursive: true });
      const temp = `${target}.${randomUUID().slice(0, 8)}.tmp`;
      await copyFile(absolutePath, temp);
      try {
        await rename(temp, target);
      } catch {
        // A concurrent writer won the rename; the temp copy is redundant.
        await rm(temp, { force: true });
      }
    }
    return { sha256, size: fileStat.size };
  }

  async readBlob(sha256: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.blobPath(sha256));
    } catch {
      return null;
    }
  }

  async hasBlob(sha256: string): Promise<boolean> {
    return exists(this.blobPath(sha256));
  }

  private blobPath(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error("Blob digests must be lowercase hex sha256.");
    }
    return path.join(this.root, "sha256", sha256.slice(0, 2), sha256);
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: string | Buffer) => {
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}
