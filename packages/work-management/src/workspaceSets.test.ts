/**
 * Unit tests for the Stage 3 project catalog and workspace set services.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  ProjectCatalogStore,
  ProjectId,
  ProjectRecord,
  WorkspaceSetId,
  WorkspaceSetRecord,
  WorkspaceSetStore
} from "@drydock/contracts";
import { RandomIdGenerator, type Clock } from "@drydock/core";
import { ProjectCatalogService } from "./projectCatalogService.js";
import { WorkspaceSetService } from "./workspaceSetService.js";

test("project registration is idempotent per normalized path and detects git", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "drydock-catalog-"));
  try {
    const gitProject = path.join(base, "GitProject");
    await mkdir(path.join(gitProject, ".git"), { recursive: true });
    const plainProject = path.join(base, "plain");
    await mkdir(plainProject);

    const catalog = new ProjectCatalogService({ ids: new RandomIdGenerator(), clock: fixedClock(), store: new MemoryProjectCatalogStore() });
    const first = await catalog.registerProject({ path: gitProject });
    // A trailing separator still resolves to the same project. Case identity is
    // deliberately left to the host filesystem rather than assumed by the test.
    const duplicate = await catalog.registerProject({ path: `${gitProject}${path.sep}` });
    if (process.platform === "win32") {
      const differentlyCased = await catalog.registerProject({ path: gitProject.toUpperCase() });
      assert.equal(differentlyCased.projectId, first.projectId);
    }
    const plain = await catalog.registerProject({ path: plainProject, name: "Plain Name" });

    assert.equal(first.projectId, duplicate.projectId);
    assert.equal(first.kind, "git");
    assert.equal(first.name, "GitProject");
    assert.equal(plain.kind, "folder");
    assert.equal(plain.name, "Plain Name");
    assert.equal((await catalog.listProjects()).length, 2);

    await assert.rejects(catalog.registerProject({ path: path.join(base, "missing") }), /existing directory/);
    const foreignAbsolute = process.platform === "win32" ? "/srv/project" : "C:\\studio\\project";
    await assert.rejects(catalog.registerProject({ path: foreignAbsolute }), /on this host/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("project registration resolves symlink and junction aliases", async (context) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "drydock-catalog-link-"));
  try {
    const projectPath = path.join(base, "project");
    const aliasPath = path.join(base, "alias");
    await mkdir(projectPath);
    try {
      await symlink(projectPath, aliasPath, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip("Creating links is not permitted on this host.");
        return;
      }
      throw error;
    }

    const catalog = new ProjectCatalogService({
      ids: new RandomIdGenerator(),
      clock: fixedClock(),
      store: new MemoryProjectCatalogStore()
    });
    const direct = await catalog.registerProject({ path: projectPath });
    const throughAlias = await catalog.registerProject({ path: aliasPath });

    assert.equal(throughAlias.projectId, direct.projectId);
    assert.equal(throughAlias.path, await realpath(projectPath));
    assert.equal((await catalog.listProjects()).length, 1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("workspace sets resolve ordered mount roots and projections", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "drydock-sets-"));
  try {
    const catalogStore = new MemoryProjectCatalogStore();
    const catalog = new ProjectCatalogService({ ids: new RandomIdGenerator(), clock: fixedClock(), store: catalogStore });
    const pathA = path.join(base, "a");
    const pathB = path.join(base, "b");
    await mkdir(pathA);
    await mkdir(pathB);
    const projectA = await catalog.registerProject({ path: pathA });
    const projectB = await catalog.registerProject({ path: pathB });

    const sets = new WorkspaceSetService({
      ids: new RandomIdGenerator(),
      clock: fixedClock(),
      catalog: catalogStore,
      store: new MemoryWorkspaceSetStore()
    });
    const set = await sets.createWorkspaceSet("Studio", [rw(projectB.projectId), rw(projectA.projectId)]);

    assert.deepEqual(await sets.resolveMountRoots(set.workspaceSetId), [pathB, pathA]);
    const projection = await sets.projection(set.workspaceSetId);
    assert.equal(projection.name, "Studio");
    assert.deepEqual(projection.folderPaths, [pathB, pathA]);

    await assert.rejects(sets.createWorkspaceSet("", [rw(projectA.projectId)]), /name/);
    await assert.rejects(sets.createWorkspaceSet("Empty", []), /at least one project/);
    await assert.rejects(
      sets.createWorkspaceSet("Ghost", [rw("project-missing" as ProjectId)]),
      /not in the catalog/
    );
    await assert.rejects(
      sets.createWorkspaceSet("Dupe", [rw(projectA.projectId), rw(projectA.projectId)]),
      /listed twice/
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("T3.5: resolving a workspace set left with zero projects errors instead of returning no mounts", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "drydock-sets-empty-"));
  try {
    const catalogStore = new MemoryProjectCatalogStore();
    const catalog = new ProjectCatalogService({ ids: new RandomIdGenerator(), clock: fixedClock(), store: catalogStore });
    const setStore = new MemoryWorkspaceSetStore();
    const sets = new WorkspaceSetService({ ids: new RandomIdGenerator(), clock: fixedClock(), catalog: catalogStore, store: setStore });

    const projectPath = path.join(base, "a");
    await mkdir(projectPath);
    const projectA = await catalog.registerProject({ path: projectPath });
    const set = await sets.createWorkspaceSet("Solo", [rw(projectA.projectId)]);

    // Simulate a store implementation (or pre-existing data) that left a set
    // with zero members - something validateSet itself never permits through
    // createWorkspaceSet/updateWorkspaceSet. SqliteProjectCatalogStore.
    // deleteProject prunes this state away entirely on the real store (see
    // stage34Store.test.ts); this proves the service-level backstop for any
    // store that doesn't.
    await setStore.updateWorkspaceSet({ ...set, projectIds: [], members: [] });

    await assert.rejects(() => sets.resolveProjects(set.workspaceSetId), /no projects left/);
    await assert.rejects(() => sets.resolveMountRoots(set.workspaceSetId), /no projects left/);
    await assert.rejects(() => sets.projection(set.workspaceSetId), /no projects left/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("workspace sets carry per-member read-only, update, and delete", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "drydock-sets-edit-"));
  try {
    const catalogStore = new MemoryProjectCatalogStore();
    const catalog = new ProjectCatalogService({ ids: new RandomIdGenerator(), clock: fixedClock(), store: catalogStore });
    const pathA = path.join(base, "a");
    const pathB = path.join(base, "b");
    await mkdir(pathA);
    await mkdir(pathB);
    const projectA = await catalog.registerProject({ path: pathA });
    const projectB = await catalog.registerProject({ path: pathB });

    const store = new MemoryWorkspaceSetStore();
    const sets = new WorkspaceSetService({ ids: new RandomIdGenerator(), clock: fixedClock(), catalog: catalogStore, store });

    const set = await sets.createWorkspaceSet("Studio", [
      { projectId: projectA.projectId, readOnly: false },
      { projectId: projectB.projectId, readOnly: true }
    ]);
    assert.deepEqual(set.members, [
      { projectId: projectA.projectId, readOnly: false },
      { projectId: projectB.projectId, readOnly: true }
    ]);
    assert.deepEqual(set.projectIds, [projectA.projectId, projectB.projectId]);

    // Update: rename, drop B, flip A to read-only.
    const updated = await sets.updateWorkspaceSet(set.workspaceSetId, "Solo", [{ projectId: projectA.projectId, readOnly: true }]);
    assert.equal(updated.name, "Solo");
    assert.deepEqual(updated.members, [{ projectId: projectA.projectId, readOnly: true }]);
    assert.deepEqual((await store.getWorkspaceSet(set.workspaceSetId))?.members, [{ projectId: projectA.projectId, readOnly: true }]);

    // Repathing a project rewrites its record; removing it prunes the catalog.
    const pathC = path.join(base, "c");
    await mkdir(pathC);
    const repathed = await catalog.updateProjectPath(projectA.projectId, pathC);
    assert.equal(repathed.path, pathC);
    await catalog.removeProject(projectB.projectId);
    assert.equal((await catalog.listProjects()).length, 1);

    await sets.deleteWorkspaceSet(set.workspaceSetId);
    assert.equal(await store.getWorkspaceSet(set.workspaceSetId), null);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

/** A read-write member, the common case in these tests. */
function rw(projectId: ProjectId) {
  return { projectId, readOnly: false };
}

function fixedClock(): Clock {
  return {
    now: () => new Date("2026-07-02T00:00:00.000Z"),
    isoNow: () => "2026-07-02T00:00:00.000Z"
  };
}

class MemoryProjectCatalogStore implements ProjectCatalogStore {
  private readonly projects = new Map<ProjectId, ProjectRecord>();
  private readonly byPathKey = new Map<string, ProjectId>();

  insertProject(record: ProjectRecord, pathKey: string): Promise<void> {
    this.projects.set(record.projectId, record);
    this.byPathKey.set(pathKey, record.projectId);
    return Promise.resolve();
  }

  updateProject(record: ProjectRecord, pathKey: string): Promise<void> {
    for (const [key, id] of this.byPathKey) {
      if (id === record.projectId) this.byPathKey.delete(key);
    }
    this.projects.set(record.projectId, record);
    this.byPathKey.set(pathKey, record.projectId);
    return Promise.resolve();
  }

  deleteProject(projectId: ProjectId): Promise<void> {
    this.projects.delete(projectId);
    for (const [key, id] of this.byPathKey) {
      if (id === projectId) this.byPathKey.delete(key);
    }
    return Promise.resolve();
  }

  getProject(projectId: ProjectId): Promise<ProjectRecord | null> {
    return Promise.resolve(this.projects.get(projectId) ?? null);
  }

  getProjectByPathKey(pathKey: string): Promise<ProjectRecord | null> {
    const projectId = this.byPathKey.get(pathKey);
    return Promise.resolve(projectId === undefined ? null : this.projects.get(projectId) ?? null);
  }

  listProjects(): Promise<ProjectRecord[]> {
    return Promise.resolve([...this.projects.values()]);
  }
}

class MemoryWorkspaceSetStore implements WorkspaceSetStore {
  private readonly sets = new Map<WorkspaceSetId, WorkspaceSetRecord>();

  insertWorkspaceSet(record: WorkspaceSetRecord): Promise<void> {
    this.sets.set(record.workspaceSetId, record);
    return Promise.resolve();
  }

  updateWorkspaceSet(record: WorkspaceSetRecord): Promise<void> {
    this.sets.set(record.workspaceSetId, record);
    return Promise.resolve();
  }

  deleteWorkspaceSet(workspaceSetId: WorkspaceSetId): Promise<void> {
    this.sets.delete(workspaceSetId);
    return Promise.resolve();
  }

  getWorkspaceSet(workspaceSetId: WorkspaceSetId): Promise<WorkspaceSetRecord | null> {
    return Promise.resolve(this.sets.get(workspaceSetId) ?? null);
  }

  listWorkspaceSets(): Promise<WorkspaceSetRecord[]> {
    return Promise.resolve([...this.sets.values()]);
  }
}
