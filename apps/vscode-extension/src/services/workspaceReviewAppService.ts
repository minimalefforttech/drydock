/**
 * Workspace policy and diff review application facade.
 *
 * One truth for the panel and commands: project/workspace-set registration,
 * access request resolution (including the runtime-generation restart that
 * applies an approved mount), session/workspace diff baselines, accept/revert,
 * and review comment threads. No `vscode` imports belong here.
 */

import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  asId,
  type AccessRequestRecord,
  type AccessRequestSummary,
  type BaselineId,
  type ChatWorkspaceSelection,
  type DiffBaselineRecord,
  type DiffFileChange,
  type DiffFileSummary,
  type DiffViewMode,
  type ProjectRecord,
  type ProjectSummary,
  type ReviewCommentAuthor,
  type ReviewCommentRecord,
  type ReviewCommentSummary,
  type ReviewThreadStatus,
  type SessionId,
  type TaskClonePolicy,
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
import type { EffectiveSecurityPolicy } from "./securityPolicy.js";

export interface WorkspaceReviewAppServiceOptions {
  readonly logger: Logger;
  readonly projectCatalog: ProjectCatalogService;
  readonly workspaceSets: WorkspaceSetService;
  readonly accessRequests: AccessRequestService;
  readonly diff: SessionDiffService;
  readonly review: CodeReviewService;
  readonly chatService: ChatSessionService;
  readonly bus: ProductEventBus;
  readonly securityPolicy?: EffectiveSecurityPolicy;
  /**
   * Session event replay for agent-touched-file scoping (the SqliteEventStore
   * satisfies this). Optional: absent → session diffs stay unfiltered.
   */
  readonly events?: { listEvents(sessionId: SessionId, fromSequence?: number): Promise<readonly { readonly eventType: string; readonly createdAt: string; readonly payload: Record<string, unknown> }[]> };
  /**
   * Production-tier fixture handling (ADR 0022, edge cases A1/B1). Paths the
   * effective policy forbids MOUNTING are still legitimately needed as test
   * material, so approving one takes the snapshot route instead: the file is
   * copied host-side, the grant is recorded, and no mount is ever created.
   * Absent (off Windows, or before validation is composed) leaves today's
   * behaviour exactly as it was - such a path simply cannot be approved.
   */
  readonly productionFixtures?: ProductionFixturePort;
}

/** The snapshot half of the approval flow, structurally (ValidationAppService). */
export interface ProductionFixturePort {
  /** True when this path is a mount-prohibited production location. */
  isProductionPath(hostPath: string): boolean;
  /** Copies the file into the session's fixture staging area and records it. */
  grantProductionFixture(input: {
    readonly sessionId: string;
    readonly hostPath: string;
  }): Promise<{ readonly relativePath: string; readonly bytes: number; readonly manifestHash: string }>;
}

/** What the session's replay proves about agent work. */
export interface AgentWorkEvidence {
  /** Runtime paths named by agent.file_edit events. */
  readonly paths: ReadonlySet<string>;
}

/**
 * Attribution is deliberately evidence-only: a path must be named by an
 * agent.file_edit event. File mtimes cannot distinguish a developer edit from
 * an agent edit while the session is active, so treating activity windows as
 * proof leaks unrelated manual work into the agent's changed-files list.
 */
export function isAgentWork(
  evidence: AgentWorkEvidence,
  change: { readonly path: string; readonly oldPath?: string; readonly currentMtimeMs?: number }
): boolean {
  return isAgentTouched(evidence.paths, change.path, change.oldPath);
}

/**
 * True when a baseline root-relative change matches an agent-touched runtime
 * path (`/workspace/<mount>/<relative>`): exact tail match on the relative
 * remainder. Same-named files across roots can false-positive; that noise is
 * bounded and vastly preferable to attributing unrelated workspace drift.
 */
export function isAgentTouched(touched: ReadonlySet<string>, changePath: string, oldPath?: string): boolean {
  for (const candidate of [changePath, oldPath]) {
    if (candidate === undefined) continue;
    const suffix = `/${candidate}`;
    for (const runtimePath of touched) {
      if (runtimePath === candidate || runtimePath.endsWith(suffix)) return true;
    }
  }
  return false;
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
    const visibleProjects = this.options.securityPolicy === undefined
      ? projects
      : projects.filter((project) => this.options.securityPolicy?.isHostPathAllowed(project.path) === true);
    const visibleIds = new Set(visibleProjects.map((project) => project.projectId as string));
    const visibleSets = sets.filter((set) => set.members.every((member) => visibleIds.has(member.projectId)));
    const byId = new Map(visibleProjects.map((project) => [project.projectId, project]));
    return {
      projects: visibleProjects.map(toProjectSummary),
      workspaceSets: visibleSets.map((set) => toWorkspaceSetSummary(set, byId)),
      accessRequests: requests.map((record) => this.summarize(record)),
      ...(this.options.securityPolicy === undefined ? {} : { security: this.options.securityPolicy.summary() })
    };
  }

  async registerProjects(paths: readonly string[]): Promise<ProjectSummary[]> {
    const projects: ProjectSummary[] = [];
    const blocked: string[] = [];
    for (const projectPath of paths) {
      if (this.options.securityPolicy !== undefined) {
        try {
          this.options.securityPolicy.assertHostPathAllowed(projectPath);
        } catch (error) {
          blocked.push(error instanceof Error ? error.message : String(error));
          continue;
        }
      }
      projects.push(toProjectSummary(await this.options.projectCatalog.registerProject({ path: projectPath })));
    }
    if (blocked.length > 0) {
      this.options.logger.info("project registration omitted paths blocked by policy", { blocked: blocked.length });
    }
    if (projects.length === 0 && blocked.length > 0) {
      throw new Error(blocked[0] ?? "No project paths were permitted by policy.");
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
    const session = await this.options.chatService.getSession(asId<"SessionId">(sessionId));
    if (this.options.securityPolicy?.cloneOnly === true || session?.mode === "clone") {
      return { roots: [], readOnlyRoots: [] };
    }
    const approved = (await this.options.accessRequests.listRequests("approved"))
      .filter((request) => request.sessionId === sessionId);
    const roots: string[] = [];
    const readOnlyRoots: string[] = [];
    for (const request of approved) {
      roots.push(this.options.securityPolicy?.assertHostPathAllowed(request.hostPath) ?? request.hostPath);
      if (request.mode === "read-only") {
        readOnlyRoots.push(this.options.securityPolicy?.assertHostPathAllowed(request.hostPath) ?? request.hostPath);
      }
    }
    return { roots, readOnlyRoots };
  }

  /** Repoints a project at a new host folder; returns fresh state. */
  async updateProjectPath(projectId: string, newPath: string): Promise<WorkspacePolicyState> {
    const approvedPath = this.options.securityPolicy?.assertHostPathAllowed(newPath) ?? newPath;
    await this.options.projectCatalog.updateProjectPath(asId<"ProjectId">(projectId), approvedPath);
    return this.getPolicyState();
  }

  /** Creates a set from an explicit, ordered member list; returns fresh state. */
  async createWorkspaceSet(name: string, members: readonly WorkspaceSetMemberInput[]): Promise<WorkspacePolicyState> {
    await this.assertWorkspaceMembersAllowed(members);
    await this.options.workspaceSets.createWorkspaceSet(name, toMembers(members));
    return this.getPolicyState();
  }

  /** Replaces a set's name and membership; returns fresh state. */
  async updateWorkspaceSet(
    workspaceSetId: string,
    name: string,
    members: readonly WorkspaceSetMemberInput[]
  ): Promise<WorkspacePolicyState> {
    await this.assertWorkspaceMembersAllowed(members);
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
      const roots = this.filterAutoRoots(openFolderRoots);
      if (roots.length === 0) {
        throw new Error("None of the open folders are permitted for AI by the effective project policy.");
      }
      return this.enforceWorkspace({ mode: selection.mode, roots });
    }
    const setId = asId<"WorkspaceSetId">(selection.workspaceSetId);
    const [roots, readOnlyRoots] = await Promise.all([
      this.options.workspaceSets.resolveMountRoots(setId),
      this.options.workspaceSets.resolveReadOnlyRoots(setId)
    ]);
    return this.enforceWorkspace({
      workspaceSetId: selection.workspaceSetId,
      mode: selection.mode,
      roots,
      ...(readOnlyRoots.length === 0 ? {} : { readOnlyRoots })
    });
  }

  /** Resolve a validated task policy to only its selected project roots, in policy order. */
  async resolveTaskCloneWorkspace(policy: TaskClonePolicy): Promise<ChatWorkspaceContext> {
    if (policy.projectIds.length === 0) {
      throw new Error("A task clone policy must select at least one project.");
    }
    const projects = await this.options.workspaceSets.resolveProjects(policy.workspaceSetId);
    const projectById = new Map(projects.map((project) => [project.projectId as string, project]));
    const seen = new Set<string>();
    const roots: string[] = [];
    for (const projectId of policy.projectIds) {
      if (seen.has(projectId)) {
        throw new Error(`Project ${projectId} is selected more than once in the task clone policy.`);
      }
      seen.add(projectId);
      const project = projectById.get(projectId);
      if (project === undefined) {
        throw new Error(`Project ${projectId} is not in workspace set ${policy.workspaceSetId}.`);
      }
      roots.push(project.path);
    }
    return this.enforceWorkspace({
      workspaceSetId: policy.workspaceSetId,
      mode: "clone",
      roots,
      dirtyHandling: policy.dirtyHandling
    });
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
    await this.assertSessionCanWiden(input.sessionId);
    this.assertNotProductionWrite(input.hostPath, input.mode);
    const record = await this.options.accessRequests.createRequest({
      sessionId: asId<"SessionId">(input.sessionId),
      hostPath: input.hostPath,
      mode: input.mode,
      reason: input.reason
    });
    return this.summarize(record);
  }

  /**
   * Approval applies the mount by restarting only the affected session's
   * runtime generation; the request is marked approved only after the restart
   * succeeds, so a failed restart leaves it pending and retryable. An
   * editedHostPath (the approval card's Edit affordance) rewrites the pending
   * request's path before approval; it is ignored on a denial.
   *
   * Escalated approvals (read-write mode, a sensitive path, or a production
   * path) additionally require `confirmedEscalation` - the card's attestation
   * that its typed-confirm gate ran. The HOST derives escalation from the
   * effective path itself rather than trusting the card's classification, so
   * a forged or stale webview message cannot one-click a grant the designed
   * interaction would have made the user type for (F3, follow-up to T2.4).
   */
  async resolveAccess(
    accessRequestId: string,
    approve: boolean,
    editedHostPath?: string,
    confirmedEscalation?: boolean
  ): Promise<AccessRequestSummary> {
    const id = asId<"AccessRequestId">(accessRequestId);
    if (!approve) {
      const denied = await this.options.accessRequests.denyRequest(id, "user");
      this.options.bus.publish({ kind: "access-resolved", request: denied });
      return this.summarize(denied);
    }
    const pending = (await this.options.accessRequests.listRequests("pending"))
      .find((request) => request.accessRequestId === id);
    if (pending !== undefined) {
      const effectivePath = editedHostPath ?? pending.hostPath;
      const escalated = pending.mode === "read-write"
        || sensitivePathMatch(effectivePath) !== null
        || (this.options.productionFixtures?.isProductionPath(effectivePath) ?? false);
      if (escalated && confirmedEscalation !== true) {
        throw new Error(
          "This approval is escalated (read-write, sensitive, or production) and needs the card's typed confirmation."
        );
      }
    }
    if (editedHostPath !== undefined) {
      await this.options.accessRequests.editRequestPath(id, editedHostPath);
    }
    // ADR 0022 A1/B1: a production-tier path is approved as a SNAPSHOT, never
    // as a mount. This runs before prepareApproval on purpose - that call
    // builds the mount and would (correctly) refuse a denied path outright,
    // which would leave the sanctioned fixture route unreachable.
    const production = await this.pendingProductionRequest(id);
    if (production !== null) {
      const fixtures = this.options.productionFixtures;
      if (fixtures === undefined) throw new Error("Fixture snapshots are not available on this machine.");
      // Deliberately no widen check: a snapshot adds no mount, so a clone-only
      // session may receive one. The typed confirm on the card is the gate.
      this.options.securityPolicy?.assertNetworkedAiAllowed();
      const grant = await fixtures.grantProductionFixture({
        sessionId: production.sessionId,
        hostPath: production.hostPath
      });
      const approved = await this.options.accessRequests.markApproved(id, "user");
      this.options.logger.info("production fixture approved as a session snapshot", {
        sessionId: production.sessionId,
        relativePath: grant.relativePath,
        bytes: grant.bytes
      });
      this.options.bus.publish({ kind: "access-resolved", request: approved });
      return this.summarize(approved);
    }
    const { request, mount } = await this.options.accessRequests.prepareApproval(id);
    await this.assertSessionCanWiden(request.sessionId);
    this.options.securityPolicy?.assertNetworkedAiAllowed();
    await this.options.chatService.expandSessionMounts(request.sessionId, [mount], "access-request-approved");
    const approved = await this.options.accessRequests.markApproved(id, "user");
    this.options.bus.publish({ kind: "access-resolved", request: approved });
    return this.summarize(approved);
  }

  /** The pending request when it names a production-tier path; null otherwise. */
  private async pendingProductionRequest(
    accessRequestId: ReturnType<typeof asId<"AccessRequestId">>
  ): Promise<AccessRequestRecord | null> {
    const fixtures = this.options.productionFixtures;
    if (fixtures === undefined) return null;
    const pending = (await this.options.accessRequests.listRequests("pending"))
      .find((request) => request.accessRequestId === accessRequestId);
    if (pending === undefined) return null;
    return fixtures.isProductionPath(pending.hostPath) ? pending : null;
  }

  /** Adds the production/disposition flags this composition can answer for. */
  private summarize(record: AccessRequestRecord): AccessRequestSummary {
    return toAccessRequestSummary(record, productionSummaryOptions(this.options.productionFixtures));
  }

  /**
   * Edge A5: no product path writes to production. A read-write request on a
   * production-tier path is refused with the sanctioned flow named, never
   * escalated into a bigger approval.
   */
  private assertNotProductionWrite(hostPath: string, mode: "read-only" | "read-write"): void {
    const fixtures = this.options.productionFixtures;
    if (mode !== "read-write" || fixtures === undefined) return;
    if (!fixtures.isProductionPath(hostPath)) return;
    throw new Error(
      "Production is read-only everywhere: results land in the dev area through review. " +
        "Request read-only access instead to snapshot this file for the session."
    );
  }

  /** Pending access requests as display-safe summaries (fleet/attention hydration). */
  async listPendingAccessRequests(): Promise<AccessRequestSummary[]> {
    return (await this.options.accessRequests.listRequests("pending")).map((record) => this.summarize(record));
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
    if (!(await this.sessionCanWiden(sessionId))) {
      this.options.logger.info("ignored access request from clone-only session", { sessionId });
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
        // Edge A5: write-back to production is a policy invariant, not a
        // bigger approval - the request is dropped with the review flow named.
        this.assertNotProductionWrite(candidate.path, candidate.mode);
        const record = await this.options.accessRequests.createRequest({
          sessionId,
          hostPath: candidate.path,
          mode: candidate.mode,
          reason: candidate.reason
        });
        pending.push(record);
        this.options.bus.publish({ kind: "access-requested", request: record });
        summaries.push(this.summarize(record));
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

  private filterAutoRoots(openFolderRoots: readonly string[]): string[] {
    const policy = this.options.securityPolicy;
    if (policy === undefined) return [...openFolderRoots];
    const allowed: string[] = [];
    let blocked = 0;
    for (const root of openFolderRoots) {
      try {
        allowed.push(policy.assertHostPathAllowed(root));
      } catch {
        blocked += 1;
      }
    }
    if (blocked > 0) {
      this.options.logger.info("open folders omitted by AI project policy", { blocked, allowed: allowed.length });
    }
    return allowed;
  }

  private enforceWorkspace(context: ChatWorkspaceContext): ChatWorkspaceContext {
    const policy = this.options.securityPolicy;
    if (policy === undefined) return context;
    const roots = context.roots.map((root) => policy.assertHostPathAllowed(root));
    const mode = policy.cloneOnly && roots.length > 0 ? "clone" : context.mode;
    if (mode !== context.mode) {
      this.options.logger.info("workspace mode tightened by security policy", { requested: context.mode, effective: mode });
    }
    return { ...context, mode, roots };
  }

  private async sessionCanWiden(sessionId: string): Promise<boolean> {
    if (this.options.securityPolicy?.cloneOnly === true) return false;
    const getSession = this.options.chatService.getSession;
    if (typeof getSession !== "function") return true;
    const session = await getSession.call(this.options.chatService, asId<"SessionId">(sessionId));
    return session?.mode !== "clone";
  }

  private async assertSessionCanWiden(sessionId: string): Promise<void> {
    if (!(await this.sessionCanWiden(sessionId))) {
      throw new Error("Clone sessions cannot add live host mounts. Add the project to the approved AI project set and start a new clone session.");
    }
  }

  private async assertWorkspaceMembersAllowed(members: readonly WorkspaceSetMemberInput[]): Promise<void> {
    const policy = this.options.securityPolicy;
    if (policy === undefined) return;
    const projects = await this.options.projectCatalog.listProjects();
    const byId = new Map(projects.map((project) => [project.projectId as string, project]));
    for (const member of members) {
      const project = byId.get(member.projectId);
      if (project === undefined) throw new Error(`Project ${member.projectId} is not registered.`);
      policy.assertHostPathAllowed(project.path);
    }
  }

  // MARK: Diff baselines

  /**
   * Baselines every root of an implementation-mode session at session start:
   * a working `current-session` baseline (advanced per file by accept) plus an
   * immutable `session-start` copy that backs the Full Session view. Re-runs
   * on resume/reclaim are additive only - a root that already has baselines
   * keeps them, so the Session view stays continuous across resumes instead of
   * silently resetting to the resume moment.
   */
  async createSessionBaselines(sessionId: string, roots: readonly string[]): Promise<void> {
    const id = asId<"SessionId">(sessionId);
    const existingRoots = new Set(
      (await this.options.diff.listBaselines(id)).map((baseline) => normalizePathKey(baseline.rootPath))
    );
    for (const rootPath of roots) {
      if (existingRoots.has(normalizePathKey(rootPath))) {
        continue;
      }
      const working = await this.options.diff.createBaseline({ scope: "current-session", sessionId: id, rootPath });
      await this.options.diff.cloneBaseline(working.baselineId, "session-start");
    }
  }

  /**
   * Captures the per-root "state at send" turn baselines that back the This
   * Turn view; the host calls this right before dispatching each user turn.
   * The newest turn frame (or the working baseline before the first send) is
   * diffed against disk: an empty diff means that frame already equals the
   * current state, so nothing is written. Otherwise the fresh turn baseline is
   * a row copy of that frame with only the changed files re-snapshotted, and
   * stale turn baselines are deleted after the fresh one lands (a crash in
   * between leaves extras that the next send sweeps).
   */
  async beginTurnBaselines(sessionId: string): Promise<void> {
    const baselines = await this.options.diff.listBaselines(asId<"SessionId">(sessionId));
    for (const frames of groupFramesByRoot(baselines).values()) {
      const source = frames.turns[0] ?? frames.working;
      if (source === undefined) {
        continue;
      }
      const changes = await this.options.diff.computeDiff(source.baselineId);
      if (changes.length === 0) {
        // Source already matches disk; sweep crash leftovers beyond the newest.
        for (const stale of frames.turns.slice(1)) {
          await this.options.diff.deleteBaseline(stale.baselineId);
        }
        continue;
      }
      const fresh = await this.options.diff.cloneBaseline(source.baselineId, "turn");
      for (const change of changes) {
        // acceptFile re-snapshots the path's current state (or drops the row
        // when the file is gone) - for renames both sides need it.
        await this.options.diff.acceptFile(fresh.baselineId, change.path);
        if (change.oldPath !== undefined) {
          await this.options.diff.acceptFile(fresh.baselineId, change.oldPath);
        }
      }
      for (const stale of frames.turns) {
        await this.options.diff.deleteBaseline(stale.baselineId);
      }
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
   * Changed files per root - session-scoped when a sessionId is given,
   * otherwise the latest workspace snapshots. The view picks the frame each
   * root diffs against: `session` uses the working baseline (accept advances
   * it), `turn` the last send's snapshot, `full-session` the immutable
   * session-start snapshot. Missing frames fall back to the working baseline,
   * so legacy sessions and the pre-first-send state degrade to the Session
   * view. Full Session rows whose content already matches the working
   * baseline are marked `accepted` - history, not pending work.
   */
  async diffStatus(sessionId?: string, view: DiffViewMode = "session"): Promise<DiffFileSummary[]> {
    const baselines = await this.options.diff.listBaselines(
      sessionId === undefined ? undefined : asId<"SessionId">(sessionId)
    );
    // Session views list only files explicitly reported by agent.file_edit.
    // A file mtime that overlaps agent activity is not attribution: the user
    // can be editing another file at exactly the same time.
    const evidence = sessionId === undefined ? null : await this.agentWorkEvidence(sessionId);
    if (evidence !== null && evidence.paths.size === 0) {
      return [];
    }
    const changes: DiffFileSummary[] = [];
    for (const frames of groupFramesByRoot(baselines).values()) {
      const baseline = pickViewBaseline(frames, view);
      if (baseline === undefined) {
        continue;
      }
      const rootName = path.basename(baseline.rootPath);
      const workingSha = view === "full-session" && frames.working !== undefined && frames.working.baselineId !== baseline.baselineId
        ? new Map((await this.options.diff.listFileSnapshots(frames.working.baselineId)).map((snapshot) => [snapshot.path, snapshot.sha256]))
        : null;
      for (const change of await this.options.diff.computeDiff(baseline.baselineId)) {
        if (evidence !== null && !isAgentWork(evidence, change)) continue;
        changes.push({
          baselineId: baseline.baselineId,
          rootName,
          path: change.path,
          changeKind: change.changeKind,
          ...(change.oldPath === undefined ? {} : { oldPath: change.oldPath }),
          ...(change.addedLines === undefined ? {} : { addedLines: change.addedLines }),
          ...(change.removedLines === undefined ? {} : { removedLines: change.removedLines }),
          revertSupported: change.revertSupported,
          ...(change.reason === undefined ? {} : { reason: change.reason }),
          ...(workingSha !== null && isAcceptedChange(change, workingSha) ? { accepted: true } : {})
        });
      }
    }
    return changes;
  }

  /**
   * Replays the session's stored file_edit events into explicit work evidence.
   * Empty evidence IS an answer (the session did not report file edits); null
   * only when the port is absent or the scan fails.
   */
  private async agentWorkEvidence(sessionId: string): Promise<AgentWorkEvidence | null> {
    const events = this.options.events;
    if (events === undefined) return null;
    try {
      const stored = await events.listEvents(asId<"SessionId">(sessionId));
      const paths = new Set<string>();
      for (const event of stored) {
        if (event.eventType !== "agent.file_edit") continue;
        const rawPath = event.payload["path"] ?? event.payload["filePath"];
        if (typeof rawPath === "string" && rawPath.length > 0) {
          paths.add(rawPath.replace(/\\/g, "/"));
        }
      }
      return { paths };
    } catch (error) {
      this.options.logger.warn("agent work-evidence scan failed; session diff stays unfiltered", {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
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

  /**
   * Accepts one file - the file's current state becomes its new starting point
   * in BOTH the working (Session) and turn (This Turn) frames of its root, so
   * an accepted row clears from either view. The immutable session-start frame
   * is never advanced: the Full Session view keeps the accepted change as
   * history. Returns the refreshed diff for the caller's active view.
   */
  async acceptFile(baselineId: string, filePath: string, view: DiffViewMode = "session"): Promise<DiffFileSummary[]> {
    const id = asId<"BaselineId">(baselineId);
    const baseline = await this.options.diff.getBaseline(id);
    if (baseline === null) {
      throw new Error(`Diff baseline ${baselineId} was not found.`);
    }
    for (const target of await this.acceptTargets(baseline)) {
      await this.options.diff.acceptFile(target.baselineId, filePath);
    }
    return this.diffStatus(baseline.sessionId, view);
  }

  /**
   * Reverts one file from the row's own frame - a Session row restores the
   * last-accepted content, a This Turn row restores the state at the last
   * send - and returns the refreshed diff for the caller's active view.
   */
  async revertFile(baselineId: string, filePath: string, view: DiffViewMode = "session"): Promise<DiffFileSummary[]> {
    const id = asId<"BaselineId">(baselineId);
    await this.options.diff.revertFile(id, filePath);
    return this.refreshedStatus(id, view);
  }

  /**
   * Accept writes for a row's root: the working and turn frames when they
   * exist (a session row from any view), never session-start. Workspace-scope
   * rows (and a defensive frame-less session row) accept into themselves.
   */
  private async acceptTargets(baseline: DiffBaselineRecord): Promise<DiffBaselineRecord[]> {
    if (baseline.sessionId === undefined) {
      return [baseline];
    }
    const rootKey = normalizePathKey(baseline.rootPath);
    const frames = groupFramesByRoot(await this.options.diff.listBaselines(baseline.sessionId)).get(rootKey);
    const targets = [frames?.working, frames?.turns[0]].filter(
      (candidate): candidate is DiffBaselineRecord => candidate !== undefined
    );
    return targets.length === 0 ? [baseline] : targets;
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
    /**
     * ADR 0004: host-side agent flows (reviewer roles) may author comments;
     * every webview/user path omits this and stays "user". The webview never
     * chooses authorship - it is not part of the panel contract.
     */
    readonly author?: ReviewCommentAuthor;
  }): Promise<ReviewCommentSummary> {
    const review = await this.ensureReview(input.sessionId);
    const comment = await this.options.review.addComment({
      reviewSessionId: review.reviewSessionId,
      filePath: input.filePath,
      startLine: input.startLine,
      endLine: input.endLine,
      body: input.body,
      author: input.author ?? "user"
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

  private async refreshedStatus(baselineId: BaselineId, view: DiffViewMode): Promise<DiffFileSummary[]> {
    const baseline = await this.options.diff.getBaseline(baselineId);
    return this.diffStatus(baseline?.sessionId, view);
  }
}

/** One root's baseline frames, newest-first within each scope. */
interface RootFrames {
  working?: DiffBaselineRecord;
  sessionStart?: DiffBaselineRecord;
  /** All turn baselines, newest first (extras beyond [0] are crash leftovers). */
  turns: DiffBaselineRecord[];
  workspace?: DiffBaselineRecord;
}

/**
 * Groups a newest-first baseline list per root, keeping the newest record per
 * scope (turn keeps them all so stale ones can be swept). Legacy sessions that
 * re-baselined on resume have several `current-session` records per root; the
 * newest wins, preserving the old behaviour.
 */
function groupFramesByRoot(baselines: readonly DiffBaselineRecord[]): Map<string, RootFrames> {
  const byRoot = new Map<string, RootFrames>();
  for (const baseline of baselines) {
    const key = normalizePathKey(baseline.rootPath);
    let frames = byRoot.get(key);
    if (frames === undefined) {
      frames = { turns: [] };
      byRoot.set(key, frames);
    }
    switch (baseline.scope) {
      case "current-session":
        frames.working ??= baseline;
        break;
      case "session-start":
        frames.sessionStart ??= baseline;
        break;
      case "turn":
        frames.turns.push(baseline);
        break;
      case "workspace":
        frames.workspace ??= baseline;
        break;
    }
  }
  return byRoot;
}

/** The frame a view diffs against; missing frames degrade to the working baseline. */
function pickViewBaseline(frames: RootFrames, view: DiffViewMode): DiffBaselineRecord | undefined {
  if (view === "turn") {
    return frames.turns[0] ?? frames.working ?? frames.workspace;
  }
  if (view === "full-session") {
    return frames.sessionStart ?? frames.working ?? frames.workspace;
  }
  return frames.working ?? frames.workspace;
}

/**
 * True when a Full Session change is already reflected in the working
 * baseline (path-keyed sha map) - i.e. it was accepted and nothing moved
 * since: a modify/add/rename matches the working sha (and a rename's old path
 * is gone from it), a delete has no working row at all.
 */
function isAcceptedChange(change: DiffFileChange, workingSha: ReadonlyMap<string, string>): boolean {
  if (change.changeKind === "delete") {
    return !workingSha.has(change.path);
  }
  if (change.currentSha256 === undefined || workingSha.get(change.path) !== change.currentSha256) {
    return false;
  }
  return change.changeKind !== "rename" || (change.oldPath !== undefined && !workingSha.has(change.oldPath));
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

/** Compares two host paths using their own platform syntax. */
function samePath(a: string, b: string): boolean {
  return normalizePathKey(a) === normalizePathKey(b);
}

export function toAccessRequestSummary(
  record: AccessRequestRecord,
  options?: {
    readonly isProduction?: (hostPath: string) => boolean;
    /** F3 fact line: display size for production files; undefined = omit, never guess. */
    readonly sizeLabelFor?: (hostPath: string) => string | undefined;
  }
): AccessRequestSummary {
  // sensitive (+ its display reason naming the matched trigger) is spread-in
  // only when matched so the fields stay absent otherwise (house style); the
  // approval card escalates to a typed confirmation and shows WHY.
  const match = sensitivePathMatch(record.hostPath);
  // ADR 0022 F3: production tier changes what approval MEANS, so the card is
  // told the disposition rather than left to assume a mount. With no classifier
  // supplied the fields stay ABSENT - an unasked question is not a "no".
  const classify = options?.isProduction;
  const production = classify !== undefined && classify(record.hostPath);
  // Size is only read for a PENDING production card - the one surface where the
  // user needs it to decide. Statting resolved/denied history would hit every
  // (possibly disconnected) production share on every hub refresh and hang the
  // extension-host main thread.
  const sizeLabel = production && record.status === "pending"
    ? options?.sizeLabelFor?.(record.hostPath)
    : undefined;
  return {
    ...(classify === undefined
      ? {}
      : production
        ? { production: true, disposition: "snapshot" as const }
        : { disposition: "mount" as const }),
    ...(sizeLabel === undefined ? {} : { sizeLabel }),
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

/**
 * The one production-aware options bundle for access-request summaries, shared
 * by every surface that projects them (facade + control panel pushes) so the
 * card sees the same flags and size wherever the summary was built.
 */
export function productionSummaryOptions(
  fixtures: Pick<ProductionFixturePort, "isProductionPath"> | undefined
): { isProduction: (hostPath: string) => boolean; sizeLabelFor: (hostPath: string) => string | undefined } | undefined {
  if (fixtures === undefined) return undefined;
  return {
    isProduction: (hostPath: string) => fixtures.isProductionPath(hostPath),
    sizeLabelFor: (hostPath: string) => {
      try {
        const stat = statSync(hostPath);
        return stat.isFile() ? formatSizeLabel(stat.size) : undefined;
      } catch {
        return undefined;
      }
    }
  };
}

/** `48 MB` style display size: one decimal under 10, whole above, GB past 1024 MB. */
export function formatSizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
  const gb = mb / 1024;
  return gb < 10 ? `${gb.toFixed(1)} GB` : `${Math.round(gb)} GB`;
}

/**
 * Create-side canonicalization for a production-tier request path (ADR 0022
 * A1/B1). The normal gate (`assertHostPathAllowed`) correctly refuses denied
 * paths, which would make the sanctioned fixture route unreachable - so the
 * composition's `validateHostPath` binding routes production candidates here
 * instead. The trade stays narrow: only an EXISTING regular file passes,
 * folders get the narrower-ask message (A2/A3), and if the canonical target
 * escapes the production tier (symlink/junction) the caller must re-run the
 * normal gate on the returned path.
 */
export function canonicalizeProductionRequestPath(candidate: string): string {
  let stat;
  try {
    stat = statSync(candidate);
  } catch {
    throw new Error(`${candidate} does not exist or is not readable from this machine, so there is nothing to snapshot.`);
  }
  if (!stat.isFile()) {
    throw new Error(
      `${candidate} is a folder. Folders cannot be snapshotted in one grant - request the specific file(s) you need; narrower is faster.`
    );
  }
  try {
    return realpathSync.native(candidate);
  } catch {
    return candidate;
  }
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
