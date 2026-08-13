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
  WorkspaceSetMember,
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

  async createWorkspaceSet(name: string, members: readonly WorkspaceSetMember[]): Promise<WorkspaceSetRecord> {
    const cleanName = this.validateSet(name, members);
    await this.assertProjectsExist(members);
    const now = this.options.clock.isoNow();
    const record: WorkspaceSetRecord = {
      workspaceSetId: this.options.ids.workspaceSetId(),
      name: cleanName,
      projectIds: members.map((member) => member.projectId),
      members: members.map((member) => ({ ...member })),
      createdAt: now,
      updatedAt: now
    };
    await this.options.store.insertWorkspaceSet(record);
    return record;
  }

  /** Replaces a set's name and membership; the id, createdAt are preserved. */
  async updateWorkspaceSet(
    workspaceSetId: WorkspaceSetId,
    name: string,
    members: readonly WorkspaceSetMember[]
  ): Promise<WorkspaceSetRecord> {
    const existing = await this.options.store.getWorkspaceSet(workspaceSetId);
    if (existing === null) {
      throw new Error(`Workspace set ${workspaceSetId} was not found.`);
    }
    const cleanName = this.validateSet(name, members);
    await this.assertProjectsExist(members);
    const record: WorkspaceSetRecord = {
      workspaceSetId,
      name: cleanName,
      projectIds: members.map((member) => member.projectId),
      members: members.map((member) => ({ ...member })),
      createdAt: existing.createdAt,
      updatedAt: this.options.clock.isoNow()
    };
    await this.options.store.updateWorkspaceSet(record);
    return record;
  }

  async deleteWorkspaceSet(workspaceSetId: WorkspaceSetId): Promise<void> {
    await this.options.store.deleteWorkspaceSet(workspaceSetId);
  }

  private validateSet(name: string, members: readonly WorkspaceSetMember[]): string {
    const cleanName = name.trim();
    if (cleanName === "") {
      throw new Error("Workspace set name must not be empty.");
    }
    if (members.length === 0) {
      throw new Error("A workspace set needs at least one project.");
    }
    const seen = new Set<string>();
    for (const member of members) {
      if (seen.has(member.projectId)) {
        throw new Error(`Project ${member.projectId} is listed twice in the set.`);
      }
      seen.add(member.projectId);
    }
    return cleanName;
  }

  private async assertProjectsExist(members: readonly WorkspaceSetMember[]): Promise<void> {
    for (const member of members) {
      if (await this.options.catalog.getProject(member.projectId) === null) {
        throw new Error(`Project ${member.projectId} is not in the catalog.`);
      }
    }
  }

  listWorkspaceSets(): Promise<WorkspaceSetRecord[]> {
    return this.options.store.listWorkspaceSets();
  }

  /**
   * Ordered member projects; missing catalog entries are a hard error.
   *
   * A zero-member set is ALSO a hard error here (T3.5), mirroring validateSet's
   * "at least one project" rule at create/update time: a set can only reach
   * zero members if something removed its last project without going through
   * this service, so resolving it should fail loudly rather than silently
   * hand back zero mounts. SqliteProjectCatalogStore.deleteProject prunes a
   * set it empties out for exactly this reason; this guard is the backstop
   * for any other store implementation (or pre-existing data) that doesn't.
   */
  async resolveProjects(workspaceSetId: WorkspaceSetId): Promise<ProjectRecord[]> {
    const record = await this.options.store.getWorkspaceSet(workspaceSetId);
    if (record === null) {
      throw new Error(`Workspace set ${workspaceSetId} was not found.`);
    }
    if (record.projectIds.length === 0) {
      throw new Error(`Workspace set ${workspaceSetId} has no projects left; delete or edit this set.`);
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

  /** Absolute paths of the set's read-only members (mount `:ro`), in order. */
  async resolveReadOnlyRoots(workspaceSetId: WorkspaceSetId): Promise<string[]> {
    const record = await this.options.store.getWorkspaceSet(workspaceSetId);
    if (record === null) {
      throw new Error(`Workspace set ${workspaceSetId} was not found.`);
    }
    const readOnly = new Set(record.members.filter((member) => member.readOnly).map((member) => member.projectId));
    return (await this.resolveProjects(workspaceSetId))
      .filter((project) => readOnly.has(project.projectId))
      .map((project) => project.path);
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
