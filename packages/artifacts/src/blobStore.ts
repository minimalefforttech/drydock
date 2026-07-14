/**
 * Content-addressed blob store (Stage 4 diff baselines).
 *
 * Blobs live under `<root>/sha256/<aa>/<sha>` and are deduplicated by digest.
 * Writes first snapshot the source into a store-owned temp file, then hash and
 * stat that immutable copy. The temp is renamed into place so a crashed write
 * never leaves half-written bytes behind a valid digest path.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BlobStore } from "@drydock/contracts";

export class ContentAddressedBlobStore implements BlobStore {
  constructor(
    private readonly root: string,
    /** Deterministic regression seam; production callers leave this undefined. */
    private readonly afterSourceCopy?: (sourcePath: string) => Promise<void>
  ) {}

  async putFile(absolutePath: string): Promise<{ readonly sha256: string; readonly size: number }> {
    const stagingDir = path.join(this.root, ".tmp");
    await mkdir(stagingDir, { recursive: true });
    const temp = path.join(stagingDir, `${randomUUID()}.tmp`);
    try {
      // COPYFILE_EXCL makes this a private store-owned snapshot even in the
      // astronomically unlikely event of a random-name collision. The source
      // may change during/after this copy, but only the resulting temp bytes are
      // hashed, sized, and committed under their digest.
      await copyFile(absolutePath, temp, constants.COPYFILE_EXCL);
      await this.afterSourceCopy?.(absolutePath);
      const [sha256, fileStat] = await Promise.all([hashFile(temp), stat(temp)]);
      const target = this.blobPath(sha256);
      if (!await exists(target)) {
        await mkdir(path.dirname(target), { recursive: true });
        await commitTempBlob(temp, target);
      }
      return { sha256, size: fileStat.size };
    } finally {
      // No-op after a successful rename; removes deduplicated or failed stages.
      await rm(temp, { force: true });
    }
  }

  async putText(text: string): Promise<{ readonly sha256: string; readonly size: number }> {
    return this.putBytes(Buffer.from(text, "utf8"));
  }

  async putBytes(bytes: Uint8Array): Promise<{ readonly sha256: string; readonly size: number }> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const target = this.blobPath(sha256);
    if (!await exists(target)) {
      await mkdir(path.dirname(target), { recursive: true });
      const temp = `${target}.${randomUUID().slice(0, 8)}.tmp`;
      await writeFile(temp, bytes);
      await commitTempBlob(temp, target);
    }
    return { sha256, size: bytes.byteLength };
  }

  async readBlob(sha256: string): Promise<Uint8Array | null> {
    if (!isDigest(sha256)) return null;
    try {
      return await readFile(this.blobPath(sha256));
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw error;
    }
  }

  async hasBlob(sha256: string): Promise<boolean> {
    return exists(this.blobPath(sha256));
  }

  private blobPath(sha256: string): string {
    if (!isDigest(sha256)) {
      throw new Error("Blob digests must be lowercase hex sha256.");
    }
    return path.join(this.root, "sha256", sha256.slice(0, 2), sha256);
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

async function commitTempBlob(temp: string, target: string): Promise<void> {
  try {
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    // On platforms that refuse replacing an existing target, an identical
    // concurrent writer may legitimately win. Suppress only that case; real
    // permission, disk, and filesystem errors must reach the caller.
    if (await exists(target)) return;
    throw error;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function isDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
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
