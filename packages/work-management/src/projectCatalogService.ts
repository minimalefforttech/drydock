/**
 * Project catalog service (Stage 3).
 *
 * Projects are durable records with stable IDs: one normalized host path is
 * one project, original casing is preserved for display, and IDs are never
 * derived from paths. Persistence lives in the injected store.
 */

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { ProjectCatalogStore, ProjectId, ProjectRecord } from "@drydock/contracts";
import { normalizePathKey, type Clock, type IdGenerator } from "@drydock/core";

export interface ProjectCatalogServiceOptions {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly store: ProjectCatalogStore;
}

export class ProjectCatalogService {
  constructor(private readonly options: ProjectCatalogServiceOptions) {}

  /**
   * Registers a host folder as a project. Idempotent: re-registering the same
   * normalized path returns the existing record.
   */
  async registerProject(input: { readonly path: string; readonly name?: string }): Promise<ProjectRecord> {
    const absolute = path.resolve(input.path);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      throw new Error(`Project path is not an existing directory: ${absolute}`);
    }
    const pathKey = normalizePathKey(absolute);
    const existing = await this.options.store.getProjectByPathKey(pathKey);
    if (existing !== null) {
      return existing;
    }
    const now = this.options.clock.isoNow();
    const record: ProjectRecord = {
      projectId: this.options.ids.projectId(),
      name: input.name ?? path.basename(absolute),
      path: absolute,
      kind: existsSync(path.join(absolute, ".git")) ? "git" : "folder",
      createdAt: now,
      updatedAt: now
    };
    await this.options.store.insertProject(record, pathKey);
    return record;
  }

  /**
   * Repoints a project at a new host folder. The new path must be an existing
   * directory that no other project already owns (path is the identity key).
   * Re-derives kind and bumps updatedAt.
   */
  async updateProjectPath(projectId: ProjectId, newPath: string): Promise<ProjectRecord> {
    const existing = await this.options.store.getProject(projectId);
    if (existing === null) {
      throw new Error(`Project ${projectId} is not in the catalog.`);
    }
    const absolute = path.resolve(newPath);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      throw new Error(`Project path is not an existing directory: ${absolute}`);
    }
    const pathKey = normalizePathKey(absolute);
    const owner = await this.options.store.getProjectByPathKey(pathKey);
    if (owner !== null && owner.projectId !== projectId) {
      throw new Error(`Another project already uses ${absolute}.`);
    }
    const record: ProjectRecord = {
      ...existing,
      path: absolute,
      kind: existsSync(path.join(absolute, ".git")) ? "git" : "folder",
      updatedAt: this.options.clock.isoNow()
    };
    await this.options.store.updateProject(record, pathKey);
    return record;
  }

  /** Removes a project from the catalog and every set that referenced it. */
  async removeProject(projectId: ProjectId): Promise<void> {
    await this.options.store.deleteProject(projectId);
  }

  listProjects(): Promise<ProjectRecord[]> {
    return this.options.store.listProjects();
  }
}
