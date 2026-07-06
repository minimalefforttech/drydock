/**
 * Workspace set service (Stage 3).
 *
 * Workspace sets are product-owned, ordered project groupings independent of
 * `.code-workspace` files. Mount roots and the VS Code folder projection both
 * derive from the same resolved membership so they cannot drift apart.
 */

import type {
  ProjectCatalogStore,
  ProjectRecord,
  WorkspaceSetId,
  WorkspaceSetRecord,
  WorkspaceSetStore
} from "@drydock/contracts";
import type { Clock, IdGenerator } from "@drydock/core";

export interface WorkspaceSetServiceOptions {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly catalog: ProjectCatalogStore;
  readonly store: WorkspaceSetStore;
}

/** What the extension host applies to the VS Code window for a set. */
export interface WorkspaceProjection {
  readonly name: string;
  readonly folderPaths: readonly string[];
}

export class WorkspaceSetService {
  constructor(private readonly options: WorkspaceSetServiceOptions) {}

  async createWorkspaceSet(name: string, projectIds: readonly ProjectRecord["projectId"][]): Promise<WorkspaceSetRecord> {
    if (name.trim() === "") {
      throw new Error("Workspace set name must not be empty.");
    }
    if (projectIds.length === 0) {
      throw new Error("A workspace set needs at least one project.");
    }
    for (const projectId of projectIds) {
      if (await this.options.catalog.getProject(projectId) === null) {
        throw new Error(`Project ${projectId} is not in the catalog.`);
      }
    }
    const now = this.options.clock.isoNow();
    const record: WorkspaceSetRecord = {
      workspaceSetId: this.options.ids.workspaceSetId(),
      name: name.trim(),
      projectIds: [...projectIds],
      createdAt: now,
      updatedAt: now
    };
    await this.options.store.insertWorkspaceSet(record);
    return record;
  }

  listWorkspaceSets(): Promise<WorkspaceSetRecord[]> {
    return this.options.store.listWorkspaceSets();
  }

  /** Ordered member projects; missing catalog entries are a hard error. */
  async resolveProjects(workspaceSetId: WorkspaceSetId): Promise<ProjectRecord[]> {
    const record = await this.options.store.getWorkspaceSet(workspaceSetId);
    if (record === null) {
      throw new Error(`Workspace set ${workspaceSetId} was not found.`);
    }
    const projects: ProjectRecord[] = [];
    for (const projectId of record.projectIds) {
      const project = await this.options.catalog.getProject(projectId);
      if (project === null) {
        throw new Error(`Workspace set ${workspaceSetId} references missing project ${projectId}.`);
      }
      projects.push(project);
    }
    return projects;
  }

  /** Ordered absolute mount roots for the set. */
  async resolveMountRoots(workspaceSetId: WorkspaceSetId): Promise<string[]> {
    return (await this.resolveProjects(workspaceSetId)).map((project) => project.path);
  }

  async projection(workspaceSetId: WorkspaceSetId): Promise<WorkspaceProjection> {
    const record = await this.options.store.getWorkspaceSet(workspaceSetId);
    if (record === null) {
      throw new Error(`Workspace set ${workspaceSetId} was not found.`);
    }
    const projects = await this.resolveProjects(workspaceSetId);
    return { name: record.name, folderPaths: projects.map((project) => project.path) };
  }
}
