/**
 * Unit tests for the Stage 3 project catalog and workspace set services.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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
    // Different casing and a trailing separator still resolve to the same project.
    const duplicate = await catalog.registerProject({ path: `${gitProject.toUpperCase()}${path.sep}` });
    const plain = await catalog.registerProject({ path: plainProject, name: "Plain Name" });

    assert.equal(first.projectId, duplicate.projectId);
    assert.equal(first.kind, "git");
    assert.equal(first.name, "GitProject");
    assert.equal(plain.kind, "folder");
    assert.equal(plain.name, "Plain Name");
    assert.equal((await catalog.listProjects()).length, 2);

    await assert.rejects(catalog.registerProject({ path: path.join(base, "missing") }), /existing directory/);
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
    const set = await sets.createWorkspaceSet("Studio", [projectB.projectId, projectA.projectId]);

    assert.deepEqual(await sets.resolveMountRoots(set.workspaceSetId), [pathB, pathA]);
    const projection = await sets.projection(set.workspaceSetId);
    assert.equal(projection.name, "Studio");
    assert.deepEqual(projection.folderPaths, [pathB, pathA]);

    await assert.rejects(sets.createWorkspaceSet("", [projectA.projectId]), /name/);
    await assert.rejects(sets.createWorkspaceSet("Empty", []), /at least one project/);
    await assert.rejects(
      sets.createWorkspaceSet("Ghost", ["project-missing" as ProjectId]),
      /not in the catalog/
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

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

  getWorkspaceSet(workspaceSetId: WorkspaceSetId): Promise<WorkspaceSetRecord | null> {
    return Promise.resolve(this.sets.get(workspaceSetId) ?? null);
  }

  listWorkspaceSets(): Promise<WorkspaceSetRecord[]> {
    return Promise.resolve([...this.sets.values()]);
  }
}
