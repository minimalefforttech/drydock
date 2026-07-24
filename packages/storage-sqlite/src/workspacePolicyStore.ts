/**
 * SQLite-backed Stage 3 workspace policy stores.
 *
 * Projects, workspace sets, and access requests are durable product records;
 * lifecycle and policy live in the owning services. path_key holds the
 * normalized comparison key so one host folder maps to one project row.
 */

import type {
  AccessRequestId,
  AccessRequestRecord,
  AccessRequestStatus,
  AccessRequestStore,
  ProjectCatalogStore,
  ProjectId,
  ProjectRecord,
  SessionId,
  WorkspaceSetId,
  WorkspaceSetMember,
  WorkspaceSetRecord,
  WorkspaceSetStore
} from "@drydock/contracts";
import type { SqliteConnection } from "./sqliteConnection.js";

// MARK: Project catalog

export class SqliteProjectCatalogStore implements ProjectCatalogStore {
  constructor(private readonly connection: SqliteConnection) {}

  async insertProject(record: ProjectRecord, pathKey: string): Promise<void> {
    this.connection.database.prepare(`
      INSERT INTO project_records (project_id, name, path, path_key, kind, origin_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.projectId,
      record.name,
      record.path,
      pathKey,
      record.kind,
      record.origin === undefined ? null : JSON.stringify(record.origin),
      record.createdAt,
      record.updatedAt
    );
  }

  async updateProject(record: ProjectRecord, pathKey: string): Promise<void> {
    this.connection.database.prepare(`
      UPDATE project_records
      SET name = ?, path = ?, path_key = ?, kind = ?, origin_json = ?, updated_at = ?
      WHERE project_id = ?
    `).run(
      record.name,
      record.path,
      pathKey,
      record.kind,
      record.origin === undefined ? null : JSON.stringify(record.origin),
      record.updatedAt,
      record.projectId
    );
  }

  async deleteProject(projectId: ProjectId): Promise<void> {
    // Drop memberships first so the FK on workspace_set_projects stays satisfied.
    this.connection.database.prepare(
      "DELETE FROM workspace_set_projects WHERE project_id = ?"
    ).run(projectId);
    this.connection.database.prepare(
      "DELETE FROM project_records WHERE project_id = ?"
    ).run(projectId);
  }

  async getProject(projectId: ProjectId): Promise<ProjectRecord | null> {
    const row = this.connection.database.prepare(
      "SELECT * FROM project_records WHERE project_id = ?"
    ).get(projectId) as ProjectRow | undefined;
    return row ? mapProject(row) : null;
  }

  async getProjectByPathKey(pathKey: string): Promise<ProjectRecord | null> {
    const row = this.connection.database.prepare(
      "SELECT * FROM project_records WHERE path_key = ?"
    ).get(pathKey) as ProjectRow | undefined;
    return row ? mapProject(row) : null;
  }

  async listProjects(): Promise<ProjectRecord[]> {
    const rows = this.connection.database.prepare(
      "SELECT * FROM project_records ORDER BY name, project_id"
    ).all() as unknown as ProjectRow[];
    return rows.map(mapProject);
  }
}

interface ProjectRow {
  readonly project_id: string;
  readonly name: string;
  readonly path: string;
  readonly kind: ProjectRecord["kind"];
  readonly origin_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function mapProject(row: ProjectRow): ProjectRecord {
  return {
    projectId: row.project_id as ProjectId,
    name: row.name,
    path: row.path,
    kind: row.kind,
    ...(parseProjectOrigin(row.origin_json) ?? {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** Validated remote provenance from the JSON column; junk degrades to absent. */
function parseProjectOrigin(json: string | null): { origin: NonNullable<ProjectRecord["origin"]> } | null {
  if (json === null) return null;
  try {
    const value = JSON.parse(json) as unknown;
    if (typeof value !== "object" || value === null) return null;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate["provider"] !== "string" || typeof candidate["host"] !== "string" || typeof candidate["remotePath"] !== "string") {
      return null;
    }
    return {
      origin: {
        provider: candidate["provider"],
        host: candidate["host"],
        remotePath: candidate["remotePath"],
        ...(typeof candidate["webUrl"] === "string" ? { webUrl: candidate["webUrl"] } : {}),
        ...(typeof candidate["defaultBranch"] === "string" ? { defaultBranch: candidate["defaultBranch"] } : {})
      }
    };
  } catch {
    return null;
  }
}

// MARK: Workspace sets

export class SqliteWorkspaceSetStore implements WorkspaceSetStore {
  constructor(private readonly connection: SqliteConnection) {}

  async insertWorkspaceSet(record: WorkspaceSetRecord): Promise<void> {
    this.connection.database.prepare(`
      INSERT INTO workspace_sets (workspace_set_id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(record.workspaceSetId, record.name, record.createdAt, record.updatedAt);
    this.replaceMembers(record);
  }

  async updateWorkspaceSet(record: WorkspaceSetRecord): Promise<void> {
    this.connection.database.prepare(`
      UPDATE workspace_sets SET name = ?, updated_at = ? WHERE workspace_set_id = ?
    `).run(record.name, record.updatedAt, record.workspaceSetId);
    this.connection.database.prepare(
      "DELETE FROM workspace_set_projects WHERE workspace_set_id = ?"
    ).run(record.workspaceSetId);
    this.replaceMembers(record);
  }

  async deleteWorkspaceSet(workspaceSetId: WorkspaceSetId): Promise<void> {
    this.connection.database.prepare(
      "DELETE FROM workspace_set_projects WHERE workspace_set_id = ?"
    ).run(workspaceSetId);
    this.connection.database.prepare(
      "DELETE FROM workspace_sets WHERE workspace_set_id = ?"
    ).run(workspaceSetId);
  }

  /** Writes the ordered membership rows, read-only flag included. */
  private replaceMembers(record: WorkspaceSetRecord): void {
    const insertMember = this.connection.database.prepare(`
      INSERT INTO workspace_set_projects (workspace_set_id, project_id, position, read_only)
      VALUES (?, ?, ?, ?)
    `);
    for (const [position, member] of record.members.entries()) {
      insertMember.run(record.workspaceSetId, member.projectId, position, member.readOnly ? 1 : 0);
    }
  }

  async getWorkspaceSet(workspaceSetId: WorkspaceSetId): Promise<WorkspaceSetRecord | null> {
    const row = this.connection.database.prepare(
      "SELECT * FROM workspace_sets WHERE workspace_set_id = ?"
    ).get(workspaceSetId) as WorkspaceSetRow | undefined;
    return row ? this.mapWorkspaceSet(row) : null;
  }

  async listWorkspaceSets(): Promise<WorkspaceSetRecord[]> {
    const rows = this.connection.database.prepare(
      "SELECT * FROM workspace_sets ORDER BY name, workspace_set_id"
    ).all() as unknown as WorkspaceSetRow[];
    return rows.map((row) => this.mapWorkspaceSet(row));
  }

  private mapWorkspaceSet(row: WorkspaceSetRow): WorkspaceSetRecord {
    const rows = this.connection.database.prepare(`
      SELECT project_id, read_only FROM workspace_set_projects
      WHERE workspace_set_id = ?
      ORDER BY position
    `).all(row.workspace_set_id) as unknown as MemberRow[];
    const members: WorkspaceSetMember[] = rows.map((member) => ({
      projectId: member.project_id as ProjectId,
      readOnly: member.read_only === 1
    }));
    return {
      workspaceSetId: row.workspace_set_id as WorkspaceSetId,
      name: row.name,
      projectIds: members.map((member) => member.projectId),
      members,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}

interface WorkspaceSetRow {
  readonly workspace_set_id: string;
  readonly name: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface MemberRow {
  readonly project_id: string;
  readonly read_only: number;
}

// MARK: Access requests

export class SqliteAccessRequestStore implements AccessRequestStore {
  constructor(private readonly connection: SqliteConnection) {}

  async insertRequest(record: AccessRequestRecord): Promise<void> {
    this.connection.database.prepare(`
      INSERT INTO access_requests (access_request_id, session_id, host_path, mode, reason, status, requested_at, resolved_at, resolved_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.accessRequestId,
      record.sessionId,
      record.hostPath,
      record.mode,
      record.reason,
      record.status,
      record.requestedAt,
      record.resolvedAt ?? null,
      record.resolvedBy ?? null
    );
  }

  async getRequest(accessRequestId: AccessRequestId): Promise<AccessRequestRecord | null> {
    const row = this.connection.database.prepare(
      "SELECT * FROM access_requests WHERE access_request_id = ?"
    ).get(accessRequestId) as AccessRequestRow | undefined;
    return row ? mapAccessRequest(row) : null;
  }

  async updateRequestStatus(
    accessRequestId: AccessRequestId,
    status: AccessRequestStatus,
    resolvedAt: string,
    resolvedBy: string
  ): Promise<void> {
    this.connection.database.prepare(`
      UPDATE access_requests
      SET status = ?, resolved_at = ?, resolved_by = ?
      WHERE access_request_id = ?
    `).run(status, resolvedAt, resolvedBy, accessRequestId);
  }

  async updateRequestPath(accessRequestId: AccessRequestId, hostPath: string): Promise<void> {
    this.connection.database.prepare(`
      UPDATE access_requests
      SET host_path = ?
      WHERE access_request_id = ?
    `).run(hostPath, accessRequestId);
  }

  async listRequests(status?: AccessRequestStatus): Promise<AccessRequestRecord[]> {
    const rows = (status === undefined
      ? this.connection.database.prepare("SELECT * FROM access_requests ORDER BY requested_at DESC, rowid DESC").all()
      : this.connection.database.prepare("SELECT * FROM access_requests WHERE status = ? ORDER BY requested_at DESC, rowid DESC").all(status)
    ) as unknown as AccessRequestRow[];
    return rows.map(mapAccessRequest);
  }
}

interface AccessRequestRow {
  readonly access_request_id: string;
  readonly session_id: string;
  readonly host_path: string;
  readonly mode: AccessRequestRecord["mode"];
  readonly reason: string;
  readonly status: AccessRequestStatus;
  readonly requested_at: string;
  readonly resolved_at: string | null;
  readonly resolved_by: string | null;
}

function mapAccessRequest(row: AccessRequestRow): AccessRequestRecord {
  return {
    accessRequestId: row.access_request_id as AccessRequestId,
    sessionId: row.session_id as SessionId,
    hostPath: row.host_path,
    mode: row.mode,
    reason: row.reason,
    status: row.status,
    requestedAt: row.requested_at,
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
    ...(row.resolved_by === null ? {} : { resolvedBy: row.resolved_by })
  };
}
