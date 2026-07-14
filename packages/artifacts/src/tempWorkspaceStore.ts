/**
 * Product-owned temporary workspace and artifact store.
 *
 * The store creates disposable roots with ownership tokens so cleanup can
 * refuse accidental deletion of user workspaces.
 */

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
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
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(prefix)) {
      throw new Error("Temporary workspace prefix must be a short file-name-safe value.");
    }
    const ownerToken = randomUUID();
    const ownerRoot = path.resolve(this.ownerRoot);
    const root = path.join(ownerRoot, `${prefix}-${ownerToken.slice(0, 8)}`);
    const workspacePath = path.join(root, "workspace");
    await mkdir(ownerRoot, { recursive: true, mode: 0o700 });
    await mkdir(root, { mode: 0o700 });
    try {
      await mkdir(workspacePath, { mode: 0o700 });
      await writeFile(path.join(root, ".drydock-owner"), ownerToken, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return { root, workspacePath, ownerToken };
  }

  async writeArtifact(workspace: TempWorkspace, relativePath: string, content: string): Promise<ArtifactRef> {
    const { root } = await this.assertOwnedWorkspace(workspace);
    const normalized = normalizeOwnedRelativePath(relativePath);
    const artifactRoot = path.join(root, "artifacts");
    const target = path.resolve(artifactRoot, normalized);
    assertStrictlyInside(artifactRoot, target, `Artifact path escapes its workspace: ${relativePath}`);
    await assertNoLinkComponents(root, target);
    await mkdir(path.dirname(target), { recursive: true });
    // Re-check after creating parents so an existing link/junction is refused
    // immediately before the write.
    await assertNoLinkComponents(root, target);
    await writeFile(target, content, { encoding: "utf8", mode: 0o600 });
    // The bytes are already in memory; hashing them avoids reopening a path
    // that could have changed after the write.
    const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
    return {
      artifactId: asId<"ArtifactId">(`artifact-${sha256.slice(0, 16)}`),
      path: target,
      sha256
    };
  }

  async cleanupWorkspace(workspace: TempWorkspace): Promise<void> {
    const { root } = await this.assertOwnedWorkspace(workspace);
    await rm(root, { recursive: true, force: true });
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
    const ownerRoot = path.resolve(this.ownerRoot);
    let entries;
    try {
      entries = await readdir(ownerRoot, { withFileTypes: true });
    } catch {
      return 0;
    }
    let removed = 0;
    const now = Date.now();
    const protectedPaths = await Promise.all(protectedWorkspacePaths.map(async (candidate) => ({
      lexical: path.resolve(candidate),
      canonical: await realpath(candidate).catch(() => path.resolve(candidate))
    })));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const root = path.join(ownerRoot, entry.name);
      try {
        await assertNoLinkComponents(ownerRoot, root);
        const rootStat = await lstat(root);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) continue;
        const ownerPath = path.join(root, ".drydock-owner");
        await assertNoLinkComponents(root, ownerPath);
        const ownerStat = await lstat(ownerPath);
        if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) continue;
        const ownerToken = await readFile(ownerPath, "utf8");
        if (!isWorkspaceTokenForRoot(ownerToken, root)) continue;
        const canonicalRoot = await realpath(root);
        if (protectedPaths.some((candidate) =>
          isInsideOrEqual(root, candidate.lexical) || isInsideOrEqual(canonicalRoot, candidate.canonical)
        )) continue;
        const newestMs = Math.max(ownerStat.mtimeMs, rootStat.mtimeMs);
        if (now - newestMs < olderThanMs) continue;
        await this.assertOwnedWorkspace({
          root,
          workspacePath: path.join(root, "workspace"),
          ownerToken
        });
        await rm(root, { recursive: true, force: true });
        removed += 1;
      } catch {
        // Missing token file means the directory is not product-owned; leave it.
      }
    }
    return removed;
  }

  private async assertOwnedWorkspace(workspace: TempWorkspace): Promise<{ readonly root: string }> {
    const ownerRoot = path.resolve(this.ownerRoot);
    const root = path.resolve(workspace.root);
    assertStrictlyInside(ownerRoot, root, `Refusing workspace outside owner root: ${workspace.root}`);
    if (!samePath(path.resolve(workspace.workspacePath), path.join(root, "workspace"))) {
      throw new Error(`Workspace path does not match its product-owned root: ${workspace.workspacePath}`);
    }
    await assertNoLinkComponents(ownerRoot, root);
    const [canonicalOwnerRoot, canonicalRoot] = await Promise.all([realpath(ownerRoot), realpath(root)]);
    assertStrictlyInside(canonicalOwnerRoot, canonicalRoot, `Refusing workspace outside owner root: ${workspace.root}`);

    const ownerPath = path.join(root, ".drydock-owner");
    await assertNoLinkComponents(root, ownerPath);
    const ownerStat = await lstat(ownerPath);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) {
      throw new Error(`Workspace ownership marker is not a regular file: ${ownerPath}`);
    }
    const storedToken = await readFile(ownerPath, "utf8");
    if (storedToken !== workspace.ownerToken || !isWorkspaceTokenForRoot(storedToken, root)) {
      throw new Error(`Workspace ownership token does not match: ${workspace.root}`);
    }
    return { root };
  }
}

function normalizeOwnedRelativePath(value: string): string {
  if (value.includes("\0")) {
    throw new Error("Artifact path contains an invalid NUL character.");
  }
  const portable = value.replace(/\\/g, "/");
  if (portable.startsWith("/") || /^[A-Za-z]:/.test(portable)) {
    throw new Error(`Artifact path must be relative: ${value}`);
  }
  const normalized = path.posix.normalize(portable);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Artifact path escapes its workspace: ${value}`);
  }
  return normalized;
}

function assertStrictlyInside(rootPath: string, candidatePath: string, message: string): void {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(message);
  }
}

function isInsideOrEqual(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  return path.relative(left, right) === "";
}

function isWorkspaceTokenForRoot(token: string, root: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)
    && path.basename(root).endsWith(`-${token.slice(0, 8)}`);
}

async function assertNoLinkComponents(rootPath: string, targetPath: string): Promise<void> {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path escapes product-owned root: ${targetPath}`);
  }
  if (relative === "") return;

  const components = relative.split(path.sep).filter((component) => component.length > 0);
  let current = root;
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index] as string);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing path through symbolic link or junction: ${current}`);
    }
    if (index < components.length - 1 && !info.isDirectory()) {
      throw new Error(`Path component is not a directory: ${current}`);
    }
  }
}
