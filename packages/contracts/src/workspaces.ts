/**
 * Workspace policy contracts.
 *
 * Projects and workspace sets are durable product records; mount policies for
 * agent runtimes derive from a workspace set plus a session mode. Access
 * requests are the explicit approval path for widening a live session's
 * mounts. Stores own persistence; services own lifecycle and policy.
 */

import type { AccessRequestId, ProjectId, SessionId, WorkspaceSetId } from "./ids.js";

/** How a session may touch workspace roots. Plan mode is technically read-only. */
export type SessionMode = "plan" | "implementation" | "clone";

/**
 * Where a catalog project was picked from (background-lane plan D2). Present
 * only on projects added via the remote picker; the local folder stays the
 * project's identity - origin is provenance, never a live connection.
 */
export interface ProjectOrigin {
  /** "github" | "gitlab" (extensible; unknown values round-trip untouched). */
  readonly provider: string;
  /** Host the project came from ("github.com", "gitlab.mystudio.local"). */
  readonly host: string;
  /** Provider-side path ("org/repo"). */
  readonly remotePath: string;
  readonly webUrl?: string;
  readonly defaultBranch?: string;
}

export interface ProjectRecord {
  readonly projectId: ProjectId;
  readonly name: string;
  /** Absolute host path, original casing preserved for display. */
  readonly path: string;
  readonly kind: "git" | "folder";
  /** Remote provenance (plan D2); absent on plain local folders. */
  readonly origin?: ProjectOrigin;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One project's membership in a set, carrying its per-set mount intent. */
export interface WorkspaceSetMember {
  readonly projectId: ProjectId;
  /** Read-only members mount `:ro`; read-write (false) is the default. */
  readonly readOnly: boolean;
}

export interface WorkspaceSetRecord {
  readonly workspaceSetId: WorkspaceSetId;
  readonly name: string;
  /** Ordered project membership; order drives mount and projection order. */
  readonly projectIds: readonly ProjectId[];
  /**
   * Same membership as `projectIds`, in the same order, carrying each member's
   * read-only flag. `projectIds` stays as the ordered id list existing readers
   * rely on; `members` is authoritative for the per-path read/write intent.
   */
  readonly members: readonly WorkspaceSetMember[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type AccessRequestStatus = "pending" | "approved" | "denied";

export interface AccessRequestRecord {
  readonly accessRequestId: AccessRequestId;
  readonly sessionId: SessionId;
  readonly hostPath: string;
  readonly mode: "read-only" | "read-write";
  readonly reason: string;
  readonly status: AccessRequestStatus;
  readonly requestedAt: string;
  readonly resolvedAt?: string;
  readonly resolvedBy?: string;
}

export interface ProjectCatalogStore {
  /** pathKey is the caller-normalized comparison key for record.path. */
  insertProject(record: ProjectRecord, pathKey: string): Promise<void>;
  /** Rewrites path/name/kind/updatedAt for an existing project (repath). */
  updateProject(record: ProjectRecord, pathKey: string): Promise<void>;
  /** Removes a project and any workspace-set memberships referencing it. */
  deleteProject(projectId: ProjectId): Promise<void>;
  getProject(projectId: ProjectId): Promise<ProjectRecord | null>;
  /** Lookup by normalized path key so one host folder is one project. */
  getProjectByPathKey(pathKey: string): Promise<ProjectRecord | null>;
  listProjects(): Promise<ProjectRecord[]>;
}

export interface WorkspaceSetStore {
  insertWorkspaceSet(record: WorkspaceSetRecord): Promise<void>;
  /** Replaces a set's name and full membership in place, bumping updatedAt. */
  updateWorkspaceSet(record: WorkspaceSetRecord): Promise<void>;
  /** Deletes a set and its membership rows. */
  deleteWorkspaceSet(workspaceSetId: WorkspaceSetId): Promise<void>;
  getWorkspaceSet(workspaceSetId: WorkspaceSetId): Promise<WorkspaceSetRecord | null>;
  listWorkspaceSets(): Promise<WorkspaceSetRecord[]>;
}

export interface AccessRequestStore {
  insertRequest(record: AccessRequestRecord): Promise<void>;
  getRequest(accessRequestId: AccessRequestId): Promise<AccessRequestRecord | null>;
  updateRequestStatus(
    accessRequestId: AccessRequestId,
    status: AccessRequestStatus,
    resolvedAt: string,
    resolvedBy: string
  ): Promise<void>;
  /** Corrects a pending request's path (the approval card's Edit affordance). */
  updateRequestPath(accessRequestId: AccessRequestId, hostPath: string): Promise<void>;
  listRequests(status?: AccessRequestStatus): Promise<AccessRequestRecord[]>;
}
