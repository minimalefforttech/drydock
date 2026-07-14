import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TempWorkspaceStore, type TempWorkspace } from "./tempWorkspaceStore.js";

test("workspace and artifact names cannot traverse product-owned roots", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "drydock-artifact-paths-"));
  const store = new TempWorkspaceStore(path.join(base, "owned"));
  try {
    await assert.rejects(store.createWorkspace("../escape"), /prefix/);
    const workspace = await store.createWorkspace("run");
    await assert.rejects(store.writeArtifact(workspace, "../escape.txt", "secret"), /escapes/);
    await assert.rejects(store.writeArtifact(workspace, "/escape.txt", "secret"), /relative/);
    await assert.rejects(store.writeArtifact(workspace, "C:\\escape.txt", "secret"), /relative/);
    await assert.rejects(store.writeArtifact(workspace, "\\\\server\\share\\escape.txt", "secret"), /relative/);
    await assert.rejects(stat(path.join(workspace.root, "escape.txt")));
    await store.cleanupWorkspace(workspace);
    await assert.rejects(stat(workspace.root));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("artifact writes refuse intermediate links that redirect outside the workspace", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "drydock-artifact-link-"));
  const store = new TempWorkspaceStore(path.join(base, "owned"));
  try {
    const workspace = await store.createWorkspace("run");
    const artifactRoot = path.join(workspace.root, "artifacts");
    const outside = path.join(base, "outside");
    await mkdir(artifactRoot);
    await mkdir(outside);
    await writeFile(path.join(outside, "sentinel.txt"), "safe");
    try {
      await symlink(outside, path.join(artifactRoot, "redirect"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("This Windows account cannot create symbolic links.");
        return;
      }
      throw error;
    }

    await assert.rejects(
      store.writeArtifact(workspace, "redirect/result.txt", "must stay inside"),
      /symbolic link|junction/
    );
    await assert.rejects(stat(path.join(outside, "result.txt")));
    await store.cleanupWorkspace(workspace);
    assert.equal(await readFile(path.join(outside, "sentinel.txt"), "utf8"), "safe");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("cleanup requires the exact owner token and refuses an intermediate redirect", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "drydock-artifact-cleanup-"));
  const ownerRoot = path.join(base, "owned");
  const outside = path.join(base, "outside");
  const store = new TempWorkspaceStore(ownerRoot);
  try {
    const workspace = await store.createWorkspace("run");
    await assert.rejects(
      store.cleanupWorkspace({ ...workspace, ownerToken: randomUUID() }),
      /ownership token/
    );
    assert.equal((await readFile(path.join(workspace.root, ".drydock-owner"), "utf8")), workspace.ownerToken);

    const forgedToken = randomUUID();
    const forgedName = `run-${forgedToken.slice(0, 8)}`;
    const outsideRoot = path.join(outside, forgedName);
    await mkdir(path.join(outsideRoot, "workspace"), { recursive: true });
    await writeFile(path.join(outsideRoot, ".drydock-owner"), forgedToken, "utf8");
    try {
      await symlink(outside, path.join(ownerRoot, "redirect"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("This Windows account cannot create symbolic links.");
        return;
      }
      throw error;
    }
    const forged: TempWorkspace = {
      root: path.join(ownerRoot, "redirect", forgedName),
      workspacePath: path.join(ownerRoot, "redirect", forgedName, "workspace"),
      ownerToken: forgedToken
    };
    await assert.rejects(store.cleanupWorkspace(forged), /symbolic link|junction/);
    assert.equal(await readFile(path.join(outsideRoot, ".drydock-owner"), "utf8"), forgedToken);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("sweep removes only unprotected product-owned workspaces", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "drydock-artifact-sweep-"));
  const store = new TempWorkspaceStore(path.join(base, "owned"));
  try {
    const removable = await store.createWorkspace("old");
    const protectedWorkspace = await store.createWorkspace("active");
    assert.equal(await store.sweepOwnedWorkspaces(-1, [protectedWorkspace.workspacePath]), 1);
    await assert.rejects(stat(removable.root));
    assert.equal((await stat(protectedWorkspace.root)).isDirectory(), true);
    await store.cleanupWorkspace(protectedWorkspace);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
