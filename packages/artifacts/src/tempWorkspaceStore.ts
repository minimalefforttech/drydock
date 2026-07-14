/**
 * Product-owned temporary workspace and artifact store.
 *
 * The store creates disposable roots with ownership tokens so cleanup can
 * refuse accidental deletion of user workspaces.
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ArtifactId } from "@drydock/contracts";
import { asId } from "@drydock/contracts";

export interface TempWorkspace {
  readonly root: string;
  readonly workspacePath: string;
  readonly ownerToken: string;
}

export interface ArtifactRef {
  readonly artifactId: ArtifactId;
  readonly path: string;
  readonly sha256: string;
}

export class TempWorkspaceStore {
  constructor(private readonly ownerRoot = path.join(os.tmpdir(), "drydock-workspaces")) {}

  async createWorkspace(prefix: string): Promise<TempWorkspace> {
    const ownerToken = randomUUID();
    const root = path.join(this.ownerRoot, `${prefix}-${ownerToken.slice(0, 8)}`);
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    await writeFile(path.join(root, ".drydock-owner"), ownerToken, "utf8");
    return { root, workspacePath, ownerToken };
  }

  async writeArtifact(workspace: TempWorkspace, relativePath: string, content: string): Promise<ArtifactRef> {
    const target = path.join(workspace.root, "artifacts", relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    const sha256 = await hashFile(target);
    return {
      artifactId: asId<"ArtifactId">(`artifact-${sha256.slice(0, 16)}`),
      path: target,
      sha256
    };
  }

  async cleanupWorkspace(workspace: TempWorkspace): Promise<void> {
    // path.relative is separator-safe; a raw prefix check would accept
    // sibling directories that merely share the owner root as a name prefix.
    const relative = path.relative(path.resolve(this.ownerRoot), path.resolve(workspace.root));
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Refusing to clean workspace outside owner root: ${workspace.root}`);
    }
    await rm(workspace.root, { recursive: true, force: true });
  }

  /**
   * Removes aged product-owned workspace roots. Ownership is proven by the
   * token file; the age floor keeps concurrently active windows safe.
   * Returns the number of roots removed.
   */
  async sweepOwnedWorkspaces(
    olderThanMs: number = 24 * 60 * 60 * 1000,
    protectedWorkspacePaths: readonly string[] = []
  ): Promise<number> {
    let entries;
    try {
      entries = await readdir(this.ownerRoot, { withFileTypes: true });
    } catch {
      return 0;
    }
    let removed = 0;
    const now = Date.now();
    const protectedPaths = protectedWorkspacePaths.map((candidate) => path.resolve(candidate));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const root = path.join(this.ownerRoot, entry.name);
      try {
        const resolvedRoot = path.resolve(root);
        if (protectedPaths.some((candidate) => {
          const relative = path.relative(resolvedRoot, candidate);
          return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
        })) continue;
        const ownerStat = await stat(path.join(root, ".drydock-owner"));
        const rootStat = await stat(root);
        const newestMs = Math.max(ownerStat.mtimeMs, rootStat.mtimeMs);
        if (now - newestMs < olderThanMs) continue;
        await rm(root, { recursive: true, force: true });
        removed += 1;
      } catch {
        // Missing token file means the directory is not product-owned; leave it.
      }
    }
    return removed;
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
