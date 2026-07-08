/**
 * Workspace policy and diff review application facade.
 *
 * One truth for the panel and commands: project/workspace-set registration,
 * access request resolution (including the runtime-generation restart that
 * applies an approved mount), session/workspace diff baselines, accept/revert,
 * and review comment threads. No `vscode` imports belong here.
 */

import path from "node:path";
import {
  asId,
  type AccessRequestRecord,
  type AccessRequestSummary,
  type BaselineId,
  type ChatWorkspaceSelection,
  type DiffBaselineRecord,
  type DiffFileSummary,
  type ProjectRecord,
  type ProjectSummary,
  type ReviewCommentRecord,
  type ReviewCommentSummary,
  type ReviewThreadStatus,
  type SessionId,
  type WorkspacePolicyState,
  type WorkspaceSetMember,
  type WorkspaceSetRecord,
  type WorkspaceSetSummary
} from "@drydock/contracts";
import {
  extractAccessRequests,
  normalizePathKey,
  sensitivePathMatch,
  type AccessRequestService,
  type ChatSessionService,
  type CodeReviewService,
  type Logger,
  type ProductEventBus,
  type SessionDiffService
} from "@drydock/core";
import type { ProjectCatalogService, WorkspaceSetService } from "@drydock/work-management";
import type { ChatWorkspaceContext } from "./isolatedRunService.js";

export interface WorkspaceReviewAppServiceOptions {
  readonly logger: Logger;
  readonly projectCatalog: ProjectCatalogService;
  readonly workspaceSets: WorkspaceSetService;
  readonly accessRequests: AccessRequestService;
  readonly diff: SessionDiffService;
  readonly review: CodeReviewService;
  readonly chatService: ChatSessionService;
  readonly bus: ProductEventBus;
}

export class WorkspaceReviewAppService {
  constructor(private readonly options: WorkspaceReviewAppServiceOptions) {}

  // MARK: Workspace policy

  async getPolicyState(): Promise<WorkspacePolicyState> {
    const [projects, sets, requests] = await Promise.all([
      this.options.projectCatalog.listProjects(),
      this.options.workspaceSets.listWorkspaceSets(),
      this.options.accessRequests.listRequests()
    ]);
    const byId = new Map(projects.map((project) => [project.projectId, project]));
    return {
      projects: projects.map(toProjectSummary),
      workspaceSets: sets.map((set) => toWorkspaceSetSummary(set, byId)),
      accessRequests: requests.map(toAccessRequestSummary)
    };
  }

  async registerProjects(paths: readonly string[]): Promise<ProjectSummary[]> {
    const projects: ProjectSummary[] = [];
    for (const projectPath of paths) {
      projects.push(toProjectSummary(await this.options.projectCatalog.registerProject({ path: projectPath })));
    }
    return projects;
  }

  /** Removes a registered project (and its set memberships); returns fresh state. */
  async removeProject(projectId: string): Promise<WorkspacePolicyState> {
    await this.options.projectCatalog.removeProject(asId<"ProjectId">(projectId));
    return this.getPolicyState();
  }

  /**
   * The host paths this session was granted via approved access requests, split
   * by mount mode. A resume re-mounts these alongside the session's original
   * project roots so a granted folder (e.g. one the agent asked for) survives a
   * revive instead of forcing the agent to re-request it every time.
   */
  async approvedAccessRoots(sessionId: string): Promise<{ readonly roots: readonly string[]; readonly readOnlyRoots: readonly string[] }> {
    const approved = (await this.options.accessRequests.listRequests("approved"))
      .filter((request) => request.sessionId === sessionId);
    const roots: string[] = [];
    const readOnlyRoots: string[] = [];
    for (const request of approved) {
      roots.push(request.hostPath);
      if (request.mode === "read-only") {
        readOnlyRoots.push(request.hostPath);
      }
    }
    return { roots, readOnlyRoots };
  }

  /** Repoints a project at a new host folder; returns fresh state. */
  async updateProjectPath(projectId: string, newPath: string): Promise<WorkspacePolicyState> {
    await this.options.projectCatalog.updateProjectPath(asId<"ProjectId">(projectId), newPath);
    return this.getPolicyState();
  }

  /** Creates a set from an explicit, ordered member list; returns fresh state. */
  async createWorkspaceSet(name: string, members: readonly WorkspaceSetMemberInput[]): Promise<WorkspacePolicyState> {
    await this.options.workspaceSets.createWorkspaceSet(name, toMembers(members));
    return this.getPolicyState();
  }

  /** Replaces a set's name and membership; returns fresh state. */
  async updateWorkspaceSet(
    workspaceSetId: string,
    name: string,
    members: readonly WorkspaceSetMemberInput[]
  ): Promise<WorkspacePolicyState> {
    await this.options.workspaceSets.updateWorkspaceSet(asId<"WorkspaceSetId">(workspaceSetId), name, toMembers(members));
    return this.getPolicyState();
  }

  /** Deletes a set (never its member projects); returns fresh state. */
  async deleteWorkspaceSet(workspaceSetId: string): Promise<WorkspacePolicyState> {
    await this.options.workspaceSets.deleteWorkspaceSet(asId<"WorkspaceSetId">(workspaceSetId));
    return this.getPolicyState();
  }

  /**
   * Resolves a panel workspace selection into mount roots for a new session.
   * The `auto` selection derives its roots from the window's open file-scheme
   * folders (passed in by the host); an explicit set resolves through the same
   * mount-root path the workspace-set flow uses.
   */
  async resolveWorkspaceSelection(
    selection: ChatWorkspaceSelection,
    openFolderRoots: readonly string[] = []
  ): Promise<ChatWorkspaceContext> {
    if ("auto" in selection) {
      if (openFolderRoots.length === 0) {
        throw new Error("No local folders are open in this window.");
      }
      return { mode: selection.mode, roots: [...openFolderRoots] };
    }
    const setId = asId<"WorkspaceSetId">(selection.workspaceSetId);
    const [roots, readOnlyRoots] = await Promise.all([
      this.options.workspaceSets.resolveMountRoots(setId),
      this.options.workspaceSets.resolveReadOnlyRoots(setId)
    ]);
    return {
      workspaceSetId: selection.workspaceSetId,
      mode: selection.mode,
      roots,
      ...(readOnlyRoots.length === 0 ? {} : { readOnlyRoots })
    };
  }

  /** Ordered absolute mount roots for a workspace set (used by "open in new window"). */
  resolveWorkspaceSetRoots(workspaceSetId: string): Promise<string[]> {
    return this.options.workspaceSets.resolveMountRoots(asId<"WorkspaceSetId">(workspaceSetId));
  }

  async requestAccess(input: {
    readonly sessionId: string;
    readonly hostPath: string;
    readonly mode: "read-only" | "read-write";
    readonly reason: string;
  }): Promise<AccessRequestSummary> {
    const record = await this.options.accessRequests.createRequest({
      sessionId: asId<"SessionId">(input.sessionId),
      hostPath: input.hostPath,
      mode: input.mode,
      reason: input.reason
    });
    return toAccessRequestSummary(record);
  }

  /**
   * Approval applies the mount by restarting only the affected session's
   * runtime generation; the request is marked approved only after the restart
   * succeeds, so a failed restart leaves it pending and retryable. An
   * editedHostPath (the approval card's Edit affordance) rewrites the pending
   * request's path before approval; it is ignored on a denial.
   */
  async resolveAccess(accessRequestId: string, approve: boolean, editedHostPath?: string): Promise<AccessRequestSummary> {
    const id = asId<"AccessRequestId">(accessRequestId);
    if (!approve) {
      return toAccessRequestSummary(await this.options.accessRequests.denyRequest(id, "user"));
    }
    if (editedHostPath !== undefined) {
      await this.options.accessRequests.editRequestPath(id, editedHostPath);
    }
    const { request, mount } = await this.options.accessRequests.prepareApproval(id);
    await this.options.chatService.expandSessionMounts(request.sessionId, [mount], "access-request-approved");
    return toAccessRequestSummary(await this.options.accessRequests.markApproved(id, "user"));
  }

  /**
   * Turns an agent's final text into pending access requests. Each parsed block
   * is deduplicated against existing pending requests for the same session,
   * resolved path, and mode so a re-emitting agent does not stack identical
   * approvals; a relative path (rejected by createRequest) is logged and
   * skipped rather than failing the whole batch. Every created record is
   * announced on the bus so the panel renders its approval card.
   */
  async detectAgentAccessRequests(sessionId: SessionId, finalText: string): Promise<AccessRequestSummary[]> {
    const parsed = extractAccessRequests(finalText);
    if (parsed.length === 0) {
      return [];
    }
    const pending = (await this.options.accessRequests.listRequests("pending"))
      .filter((request) => request.sessionId === sessionId);
    const summaries: AccessRequestSummary[] = [];
    for (const candidate of parsed) {
      if (pending.some((request) => request.mode === candidate.mode && samePath(request.hostPath, candidate.path))) {
        continue;
      }
      try {
        const record = await this.options.accessRequests.createRequest({
          sessionId,
          hostPath: candidate.path,
          mode: candidate.mode,
          reason: candidate.reason
        });
        pending.push(record);
        this.options.bus.publish({ kind: "access-requested", request: record });
        summaries.push(toAccessRequestSummary(record));
      } catch (error) {
        this.options.logger.warn("agent access request skipped", {
          sessionId,
          hostPath: candidate.path,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return summaries;
  }

  // MARK: Diff baselines

  /** Baselines every root of an implementation-mode session at session start. */
  async createSessionBaselines(sessionId: string, roots: readonly string[]): Promise<void> {
    for (const rootPath of roots) {
      await this.options.diff.createBaseline({
        scope: "current-session",
        sessionId: asId<"SessionId">(sessionId),
        rootPath
      });
    }
  }

  /** Snapshots the set's roots so later workspace edits diff against now. */
  async snapshotWorkspace(workspaceSetId: string): Promise<string[]> {
    const roots = await this.options.workspaceSets.resolveMountRoots(asId<"WorkspaceSetId">(workspaceSetId));
    const baselineIds: string[] = [];
    for (const rootPath of roots) {
      const record = await this.options.diff.createBaseline({ scope: "workspace", rootPath });
      baselineIds.push(record.baselineId);
    }
    return baselineIds;
  }

  /**
   * Changed files against the newest baseline per root — session-scoped when a
   * sessionId is given, otherwise the latest workspace snapshots.
   */
  async diffStatus(sessionId?: string): Promise<DiffFileSummary[]> {
    const baselines = await this.options.diff.listBaselines(
      sessionId === undefined ? undefined : asId<"SessionId">(sessionId)
    );
    const changes: DiffFileSummary[] = [];
    for (const baseline of latestPerRoot(baselines)) {
      const rootName = path.basename(baseline.rootPath);
      for (const change of await this.options.diff.computeDiff(baseline.baselineId)) {
        changes.push({
          baselineId: baseline.baselineId,
          rootName,
          path: change.path,
          changeKind: change.changeKind,
          ...(change.oldPath === undefined ? {} : { oldPath: change.oldPath }),
          ...(change.addedLines === undefined ? {} : { addedLines: change.addedLines }),
          ...(change.removedLines === undefined ? {} : { removedLines: change.removedLines }),
          revertSupported: change.revertSupported,
          ...(change.reason === undefined ? {} : { reason: change.reason })
        });
      }
    }
    return changes;
  }

  /**
   * Baseline-side text for the diff editor's read-only left pane. Returns "" for
   * a path not in the baseline (an added file, whose baseline is empty) and null
   * only for an unknown baseline or an unreadable (binary/oversized) blob.
   */
  async readBaselineFileText(baselineId: string, filePath: string): Promise<string | null> {
    const id = asId<"BaselineId">(baselineId);
    const baseline = await this.options.diff.getBaseline(id);
    if (baseline === null) {
      return null;
    }
    const text = await this.options.diff.readBaselineText(id, filePath);
    // Not in the baseline → an added file; show an empty left side rather than null.
    return text ?? "";
  }

  /** Absolute host path of a baseline root, for locating the current file on disk. */
  async baselineRootPath(baselineId: string): Promise<string | null> {
    const baseline = await this.options.diff.getBaseline(asId<"BaselineId">(baselineId));
    return baseline?.rootPath ?? null;
  }

  /** Accepts one file (resets only that file's baseline) and returns the refreshed diff. */
  async acceptFile(baselineId: string, filePath: string): Promise<DiffFileSummary[]> {
    const id = asId<"BaselineId">(baselineId);
    await this.options.diff.acceptFile(id, filePath);
    return this.refreshedStatus(id);
  }

  /** Reverts one file from the baseline blob and returns the refreshed diff. */
  async revertFile(baselineId: string, filePath: string): Promise<DiffFileSummary[]> {
    const id = asId<"BaselineId">(baselineId);
    await this.options.diff.revertFile(id, filePath);
    return this.refreshedStatus(id);
  }

  // MARK: Review threads

  async reviewState(sessionId?: string): Promise<{ reviewSessionId: string; comments: ReviewCommentSummary[] }> {
    const review = await this.ensureReview(sessionId);
    const comments = await this.options.review.listComments(review.reviewSessionId);
    return { reviewSessionId: review.reviewSessionId, comments: comments.map(toReviewCommentSummary) };
  }

  async addComment(input: {
    readonly sessionId?: string;
    readonly filePath: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly body: string;
  }): Promise<ReviewCommentSummary> {
    const review = await this.ensureReview(input.sessionId);
    const comment = await this.options.review.addComment({
      reviewSessionId: review.reviewSessionId,
      filePath: input.filePath,
      startLine: input.startLine,
      endLine: input.endLine,
      body: input.body,
      author: "user"
    });
    return toReviewCommentSummary(comment);
  }

  async setCommentStatus(commentId: string, status: ReviewThreadStatus): Promise<ReviewCommentSummary> {
    const comment = await this.options.review.setCommentStatus(asId<"ReviewCommentId">(commentId), status);
    return toReviewCommentSummary(comment);
  }

  // MARK: Helpers

  private ensureReview(sessionId?: string) {
    return sessionId === undefined
      ? this.options.review.ensureReviewSession("workspace")
      : this.options.review.ensureReviewSession("current-session", asId<"SessionId">(sessionId));
  }

  private async refreshedStatus(baselineId: BaselineId): Promise<DiffFileSummary[]> {
    const baseline = await this.options.diff.getBaseline(baselineId);
    return this.diffStatus(baseline?.sessionId);
  }
}

function latestPerRoot(baselines: readonly DiffBaselineRecord[]): DiffBaselineRecord[] {
  const byRoot = new Map<string, DiffBaselineRecord>();
  for (const baseline of baselines) {
    const key = normalizePathKey(baseline.rootPath);
    if (!byRoot.has(key)) {
      byRoot.set(key, baseline);
    }
  }
  return [...byRoot.values()];
}

function toProjectSummary(record: ProjectRecord): ProjectSummary {
  return {
    projectId: record.projectId,
    name: record.name,
    displayPath: record.path,
    kind: record.kind
  };
}

/** Panel-side shape for a set member before it is validated into an id. */
interface WorkspaceSetMemberInput {
  readonly projectId: string;
  readonly readOnly: boolean;
}

function toMembers(members: readonly WorkspaceSetMemberInput[]): WorkspaceSetMember[] {
  return members.map((member) => ({ projectId: asId<"ProjectId">(member.projectId), readOnly: member.readOnly }));
}

function toWorkspaceSetSummary(record: WorkspaceSetRecord, byId: ReadonlyMap<string, ProjectRecord>): WorkspaceSetSummary {
  const members = record.members.map((member) => {
    const project = byId.get(member.projectId);
    return {
      projectId: member.projectId,
      name: project?.name ?? member.projectId,
      displayPath: project?.path ?? "",
      readOnly: member.readOnly
    };
  });
  return {
    workspaceSetId: record.workspaceSetId,
    name: record.name,
    projectNames: members.map((member) => member.name),
    members
  };
}

/** Compares two host paths by resolving both, matching createRequest's storage. */
function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

export function toAccessRequestSummary(record: AccessRequestRecord): AccessRequestSummary {
  // sensitive (+ its display reason naming the matched trigger) is spread-in
  // only when matched so the fields stay absent otherwise (house style); the
  // approval card escalates to a typed confirmation and shows WHY.
  const match = sensitivePathMatch(record.hostPath);
  return {
    accessRequestId: record.accessRequestId,
    sessionId: record.sessionId,
    displayPath: record.hostPath,
    mode: record.mode,
    reason: record.reason,
    status: record.status,
    requestedAt: record.requestedAt,
    ...(match === null ? {} : {
      sensitive: true,
      sensitiveReason: match.kind === "directory"
        ? `"${match.match}" is a credential/secret directory`
        : `"${match.match}" matches a credentials/secrets file pattern`
    })
  };
}

function toReviewCommentSummary(record: ReviewCommentRecord): ReviewCommentSummary {
  return {
    commentId: record.commentId,
    filePath: record.filePath,
    startLine: record.startLine,
    endLine: record.endLine,
    body: record.body,
    author: record.author,
    status: record.status,
    createdAt: record.createdAt
  };
}
