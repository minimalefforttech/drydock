/**
 * Planner application facade (ADR 0012).
 *
 * One truth for the plan lifecycle: intake, the planning chat session, artifact
 * collection, workspace hydration, annotations, and the composed turns that
 * drive the agent. The agent writes into its workspace `plan/` directory (a
 * host bind mount, so a sandbox crash never loses bytes); after every turn -
 * and on panel open - this service collects those files into durable rows:
 * text kinds inline in SQLite, images into the content-addressed blob store.
 * A fresh session for an existing plan is hydrated from the store before its
 * first turn, so sessions stay disposable while plans persist.
 *
 * No `vscode` imports belong here; session access goes through structural
 * ports satisfied by IsolatedRunService/ChatSessionService.
 */

import { lstat, mkdir, open, opendir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  asId,
  describePlanAnchor,
  PLANNER_ASPECT_FALLBACK_ID,
  PLANNER_INLINE_IMAGE_BYTES,
  PLANNER_MAX_FILES,
  PLANNER_MAX_IMAGE_BYTES,
  PLANNER_MAX_TEXT_BYTES,
  plannerImageMime,
  plannerKindForFile,
  type BlobStore,
  type ChatModelSelection,
  type PlanAnnotationRecord,
  type PlanAnnotationStatus,
  type PlanAnnotationStore,
  type PlanAnnotationSummary,
  type PlanArtifactId,
  type PlanArtifactRecord,
  type PlanArtifactStore,
  type PlanAspectRecord,
  type PlanAspectStore,
  type PlanAspectSummary,
  type PlanArtifactDetail,
  type PlanArtifactSummary,
  type PlanId,
  type PlannerAspectSaveInput,
  type PlannerStateDetail,
  type PlanRecord,
  type PlanStore,
  type PlanSummary,
  type ChatSessionRecord,
  type SessionId,
  type TurnTerminalStatus
} from "@drydock/contracts";
import type { Clock, IdGenerator, Logger, ProductEventBus } from "@drydock/core";
import type { ChatWorkspaceContext } from "./isolatedRunService.js";

/** Session control surface, satisfied structurally by IsolatedRunService. */
export interface PlannerSessionsPort {
  startChatSession(
    model?: ChatModelSelection,
    title?: string,
    workspace?: ChatWorkspaceContext
  ): Promise<{ readonly session: { readonly sessionId: SessionId } }>;
  /** claimOwnership + force resume: revives ended, failed, and orphaned-active sessions alike. */
  reclaimChatSession(sessionId: string, model?: ChatModelSelection): Promise<unknown>;
  endChatSession(sessionId: string, reason: string): Promise<unknown>;
  sendChatTurn(sessionId: string, prompt: string): Promise<{ readonly status: TurnTerminalStatus }>;
  isChatSessionLive(sessionId: string): boolean;
  hasActiveChatTurn(sessionId: string): boolean;
}

/** Workspace/record lookups, satisfied structurally by ChatSessionService. */
export interface PlannerChatPort {
  getSessionWorkspacePath(sessionId: SessionId): string | null;
  getSession(sessionId: SessionId): Promise<ChatSessionRecord | null>;
}

/**
 * Task linkage, satisfied structurally by TaskService. Plans generally belong
 * to tasks (ADR 0006 doctrine); the plan's session is linked to its task on
 * every boot so the task's chats, board chips, and touch history see it.
 */
export interface PlannerTasksPort {
  /** Idempotent (INSERT OR IGNORE store semantics). */
  link(taskId: string, target: { readonly sessionId: string }): Promise<void>;
  listTaskSummaries(): Promise<readonly { readonly taskId: string; readonly title: string }[]>;
}

export interface PlannerAppServiceOptions {
  readonly logger: Logger;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly plans: PlanStore;
  readonly artifacts: PlanArtifactStore;
  readonly annotations: PlanAnnotationStore;
  readonly aspects: PlanAspectStore;
  readonly blobs: BlobStore;
  readonly sessions: PlannerSessionsPort;
  readonly chat: PlannerChatPort;
  readonly tasks?: PlannerTasksPort;
  readonly bus: ProductEventBus;
  /**
   * Optional department aspect packs (e.g. a repo's .drydock/planner-aspects.json),
   * merged read-only at list time; a SQLite row with the same id wins.
   */
  readonly aspectOverlays?: () => Promise<readonly PlanAspectRecord[]>;
}

export interface CreatePlanInput {
  readonly brief: string;
  readonly aspectIds: readonly string[];
  readonly contextRoots: readonly string[];
  readonly notes?: string;
  readonly title?: string;
  /** The owning task; omitted/null = an orphan plan (allowed, discouraged). */
  readonly taskId?: string | null;
}

export interface UpdatePlanIntakeInput {
  readonly title?: string;
  readonly brief?: string;
  readonly aspectIds?: readonly string[];
  readonly contextRoots?: readonly string[];
  readonly notes?: string;
  /** null clears the link back to an orphan plan. */
  readonly taskId?: string | null;
}

const PLAN_TITLE_MAX = 64;
const MANIFEST_NAME = "manifest.json";
const PLANNER_MAX_VISITED_ENTRIES = PLANNER_MAX_FILES * 10;

export class PlannerAppService {
  private readonly hydrationRequired = new Set<string>();

  constructor(private readonly options: PlannerAppServiceOptions) {}

  // -------------------------------------------------------------------------
  // Plan lifecycle
  // -------------------------------------------------------------------------

  async createPlan(input: CreatePlanInput): Promise<PlanRecord> {
    const now = this.options.clock.isoNow();
    const record: PlanRecord = {
      planId: this.options.ids.planId(),
      title: input.title ?? titleFromBrief(input.brief),
      brief: input.brief,
      aspectIds: input.aspectIds,
      contextRoots: input.contextRoots,
      notes: input.notes ?? "",
      status: "draft",
      sessionId: null,
      taskId: input.taskId == null ? null : asId<"TaskId">(input.taskId),
      createdAt: now,
      updatedAt: now
    };
    await this.options.plans.insertPlan(record);
    return record;
  }

  async updateIntake(planId: string, input: UpdatePlanIntakeInput): Promise<PlanRecord> {
    const id = asId<"PlanId">(planId);
    const { taskId, ...rest } = input;
    await this.options.plans.updatePlan(id, {
      ...rest,
      ...(taskId === undefined ? {} : { taskId: taskId === null ? null : asId<"TaskId">(taskId) }),
      updatedAt: this.options.clock.isoNow()
    });
    const updated = await this.requirePlan(id);
    // A (re)linked task adopts the existing session immediately.
    if (taskId !== undefined && taskId !== null && updated.sessionId !== null) {
      await this.linkPlanTask(updated.taskId, updated.sessionId);
    }
    this.publishChanged(id);
    return updated;
  }

  async archivePlan(planId: string, archived: boolean): Promise<PlanRecord> {
    const id = asId<"PlanId">(planId);
    const plan = await this.requirePlan(id);
    const status = archived ? "archived" : (plan.sessionId === null ? "draft" : "active");
    await this.options.plans.updatePlan(id, { status, updatedAt: this.options.clock.isoNow() });
    this.publishChanged(id);
    return this.requirePlan(id);
  }

  async listPlans(): Promise<PlanSummary[]> {
    const records = await this.options.plans.listPlans();
    const titles = await this.taskTitles();
    return Promise.all(records.map((record) => this.toPlanSummary(record, titles)));
  }

  async getPlan(planId: string): Promise<PlanRecord | null> {
    return this.options.plans.getPlan(asId<"PlanId">(planId));
  }

  async getPlanBySessionId(sessionId: string): Promise<PlanRecord | null> {
    return this.options.plans.getPlanBySessionId(asId<"SessionId">(sessionId));
  }

  /** The plan session's durable record, for panel-side summary decoration. */
  async getSessionRecord(sessionId: string): Promise<ChatSessionRecord | null> {
    return this.options.chat.getSession(asId<"SessionId">(sessionId));
  }

  /** Full panel state for one plan; runs an on-open collection sweep first. */
  async getPlanState(planId: string): Promise<PlannerStateDetail> {
    const id = asId<"PlanId">(planId);
    let plan = await this.requirePlan(id);
    if (plan.sessionId !== null) {
      // The sweep catches files written by a turn whose completion the host
      // never saw (a crashed sandbox, a killed window). Failures degrade to
      // the stored rows rather than blocking the panel.
      try {
        await this.collectPlanArtifacts(id);
        plan = await this.requirePlan(id);
      } catch (error) {
        this.options.logger.warn("planner on-open collection failed", {
          planId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    const [artifacts, annotations, aspects, titles] = await Promise.all([
      this.options.artifacts.listArtifacts(id),
      this.options.annotations.listAnnotations(id),
      this.listAspects(true),
      this.taskTitles()
    ]);
    return {
      plan: await this.toPlanSummary(plan, titles),
      artifacts: await Promise.all(artifacts.map((artifact) => this.toArtifactDetail(artifact))),
      annotations: annotations.map(toAnnotationSummary),
      aspects: aspects.map(toAspectSummary)
    };
  }

  /** taskId → title, one summaries fetch per call site; empty without a port. */
  private async taskTitles(): Promise<ReadonlyMap<string, string>> {
    if (this.options.tasks === undefined) {
      return new Map();
    }
    try {
      const summaries = await this.options.tasks.listTaskSummaries();
      return new Map(summaries.map((summary) => [summary.taskId, summary.title]));
    } catch (error) {
      this.options.logger.warn("plan task title lookup failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      return new Map();
    }
  }

  // -------------------------------------------------------------------------
  // Session control
  // -------------------------------------------------------------------------

  /**
   * Boots (or revives) the plan's session, hydrates its workspace from the
   * store, and - when the plan has no artifacts yet - fires the initial
   * briefing turn detached. Resolves once the session is live; callers ack the
   * webview first and follow with a planner.sessionReady push.
   */
  async startPlanSession(planId: string, model?: ChatModelSelection): Promise<SessionId> {
    const id = asId<"PlanId">(planId);
    const plan = await this.requirePlan(id);
    const sessionId = await this.ensureLiveSession(plan, model);
    const artifactCount = await this.options.artifacts.countArtifacts(id);
    if (artifactCount === 0) {
      const briefing = await this.composeBriefing(plan);
      this.sendDetached(id, sessionId, briefing);
    }
    return sessionId;
  }

  /** Sends a free-form turn from the sidebar Plan tab, reviving if needed. */
  async sendPlanTurn(planId: string, prompt: string): Promise<void> {
    const id = asId<"PlanId">(planId);
    const plan = await this.requirePlan(id);
    const sessionId = await this.ensureLiveSession(plan);
    await this.options.sessions.sendChatTurn(sessionId, prompt);
  }

  /**
   * Composes one revision turn from every open annotation and sends it before
   * flipping them to delegated (stamped with the artifact revision they were
   * written against). A refused turn leaves every annotation open so the user
   * can retry it. Zero open annotations is an accepted no-op.
   */
  async sendInstructions(planId: string): Promise<{ readonly sentCount: number }> {
    const id = asId<"PlanId">(planId);
    const plan = await this.requirePlan(id);
    const open = (await this.options.annotations.listAnnotations(id)).filter((annotation) => annotation.status === "open");
    if (open.length === 0) {
      return { sentCount: 0 };
    }
    const artifacts = await this.options.artifacts.listArtifacts(id);
    const byId = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));
    const lines: string[] = [];
    for (const annotation of open) {
      const artifact = byId.get(annotation.artifactId);
      const title = artifact === undefined ? annotation.artifactId : effectiveTitle(artifact);
      const relPath = artifact === undefined ? "?" : `plan/${artifact.relPath}`;
      lines.push(`- ${title} (${relPath}, ${describePlanAnchor(annotation.anchor)}): ${annotation.body}`);
    }
    const prompt = [
      "[host] Reviewer instructions on the plan artifacts - address each item and update the matching files under plan/, revising in place:",
      ...lines
    ].join("\n");

    const sessionId = await this.ensureLiveSession(plan);
    const turn = await this.options.sessions.sendChatTurn(sessionId, prompt);
    if (turn.status !== "completed") {
      throw new Error(`Planner instruction turn ${turn.status}; annotations remain open for retry.`);
    }
    const now = this.options.clock.isoNow();
    for (const annotation of open) {
      const artifact = byId.get(annotation.artifactId);
      await this.options.annotations.updateAnnotation(annotation.annotationId, {
        status: "delegated",
        delegatedRev: artifact?.revision ?? null,
        updatedAt: now
      });
    }
    this.publishChanged(id);
    return { sentCount: open.length };
  }

  /** Asks the agent to regenerate one aspect (or refresh the whole plan). */
  async regenerate(planId: string, aspectId?: string): Promise<void> {
    const id = asId<"PlanId">(planId);
    const plan = await this.requirePlan(id);
    const sessionId = await this.ensureLiveSession(plan);
    if (aspectId === undefined) {
      const briefing = await this.composeBriefing(plan);
      this.sendDetached(id, sessionId, `${briefing}\n\nRevisit every artifact against the brief and revise the files in place where they fall short.`);
      return;
    }
    const aspect = (await this.listAspects(true)).find((entry) => entry.aspectId === aspectId);
    const label = aspect?.label ?? aspectId;
    const detail = aspect === undefined
      ? ""
      : ` ${aspect.instructions} Expected: ${aspect.expectedArtifacts.join("; ")}.`;
    this.sendDetached(
      id,
      sessionId,
      `[host] Regenerate the "${label}" portion of the plan.${detail} Update only files under plan/${aspectId}/, revising in place.`
    );
  }

  /**
   * Boots the plan's session when none is live. A fresh boot always hydrates
   * the workspace `plan/` directory from the store first, so the agent revises
   * current state instead of starting blind.
   */
  private async ensureLiveSession(plan: PlanRecord, model?: ChatModelSelection): Promise<SessionId> {
    if (plan.sessionId !== null && this.options.sessions.isChatSessionLive(plan.sessionId)) {
      if (!this.hydrationRequired.has(plan.sessionId)) {
        return plan.sessionId;
      }
      // A prior hydration failure must never turn a retry into a successful
      // live-session fast path. End that incomplete revival before trying again.
      await this.options.sessions.endChatSession(plan.sessionId, "planner-hydration-retry");
    }
    if (plan.sessionId !== null) {
      this.hydrationRequired.add(plan.sessionId);
      await this.options.sessions.reclaimChatSession(plan.sessionId, model);
      await this.hydrateRequiredWorkspace(plan.planId, plan.sessionId);
      await this.linkPlanTask(plan.taskId, plan.sessionId);
      this.options.bus.publish({ kind: "planner-session-started", planId: plan.planId, sessionId: plan.sessionId });
      return plan.sessionId;
    }
    const workspace: ChatWorkspaceContext = {
      mode: "plan",
      roots: plan.contextRoots
    };
    const started = await this.options.sessions.startChatSession(model, `Plan - ${plan.title}`, workspace);
    const sessionId = started.session.sessionId;
    this.hydrationRequired.add(sessionId);
    await this.options.plans.updatePlan(plan.planId, {
      sessionId,
      status: "active",
      updatedAt: this.options.clock.isoNow()
    });
    await this.hydrateRequiredWorkspace(plan.planId, sessionId);
    await this.linkPlanTask(plan.taskId, sessionId);
    this.publishChanged(plan.planId);
    this.options.bus.publish({ kind: "planner-session-started", planId: plan.planId, sessionId });
    return sessionId;
  }

  private async hydrateRequiredWorkspace(planId: PlanId, sessionId: SessionId): Promise<void> {
    try {
      await this.hydrateWorkspace(planId, sessionId);
      this.hydrationRequired.delete(sessionId);
    } catch (error) {
      try {
        await this.options.sessions.endChatSession(sessionId, "planner-hydration-failed");
      } catch (cleanupError) {
        this.options.logger.error("planner hydration cleanup failed", {
          planId,
          sessionId,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        });
      }
      throw error;
    }
  }

  /**
   * Links the plan's session to its owning task (best-effort, idempotent) so
   * the task's chats dropdown, board chips, and touch history all see the
   * planning session like any other.
   */
  private async linkPlanTask(taskId: string | null, sessionId: SessionId): Promise<void> {
    if (taskId === null || this.options.tasks === undefined) {
      return;
    }
    try {
      await this.options.tasks.link(taskId, { sessionId });
    } catch (error) {
      this.options.logger.warn("plan session task link failed", {
        taskId,
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private sendDetached(planId: PlanId, sessionId: SessionId, prompt: string): void {
    void this.options.sessions.sendChatTurn(sessionId, prompt).catch((error: unknown) => {
      this.options.logger.error("planner turn failed to run", {
        planId,
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  /** Clears the session link when a session is deleted out from under a plan. */
  async onSessionDeleted(sessionId: string): Promise<void> {
    const plan = await this.options.plans.getPlanBySessionId(asId<"SessionId">(sessionId));
    if (plan === null) {
      return;
    }
    await this.options.plans.updatePlan(plan.planId, {
      sessionId: null,
      updatedAt: this.options.clock.isoNow()
    });
    this.publishChanged(plan.planId);
  }

  // -------------------------------------------------------------------------
  // Collection & hydration
  // -------------------------------------------------------------------------

  /**
   * Collects the session's `plan/` directory into the durable store. Text
   * kinds (document/diagram/prototype) land inline; images go through the blob
   * store and keep only their digest here. Revision bumps only on content
   * change; a deleted file never deletes its row (partial-write tolerance);
   * artifact ids, title overrides, and the prototype scripts flag survive
   * re-collection. Publishes planner-changed only when something changed.
   */
  async collectPlanArtifacts(planId: string): Promise<PlanArtifactRecord[]> {
    const id = asId<"PlanId">(planId);
    const plan = await this.requirePlan(id);
    if (plan.sessionId === null) {
      return this.options.artifacts.listArtifacts(id);
    }
    const workspacePath = this.options.chat.getSessionWorkspacePath(plan.sessionId);
    if (workspacePath === null) {
      return this.options.artifacts.listArtifacts(id);
    }
    const planRoot = await existingPlanRoot(workspacePath);
    if (planRoot === null) {
      return this.options.artifacts.listArtifacts(id);
    }
    const files = await this.readPlanFiles(id, planRoot);
    const manifest = await readManifestTitles(planRoot, this.options.logger, id);
    const knownAspects = new Set((await this.listAspects(true)).map((aspect) => aspect.aspectId));

    let changed = false;
    for (const file of files) {
      const existing = await this.options.artifacts.getArtifactByPath(id, file.relPath);
      const aspectId = aspectForPath(file.relPath, knownAspects);
      const title = manifest.get(file.relPath) ?? file.fallbackTitle;

      if (file.kind === "image") {
        const put = await putBoundedPlanImage(this.options.blobs, planRoot, file.relPath);
        if (put === null) {
          this.options.logger.warn("planner collection skipped an oversized file", {
            planId: id,
            relPath: file.relPath,
            limit: PLANNER_MAX_IMAGE_BYTES
          });
          continue;
        }
        if (existing !== null && existing.blobSha256 === put.sha256 && existing.title === title && existing.aspectId === aspectId) {
          continue;
        }
        await this.options.artifacts.upsertArtifact({
          artifactId: existing?.artifactId ?? this.options.ids.planArtifactId(),
          planId: id,
          relPath: file.relPath,
          kind: "image",
          aspectId,
          title,
          titleOverride: existing?.titleOverride ?? null,
          revision: existing === null ? 1 : (existing.blobSha256 === put.sha256 ? existing.revision : existing.revision + 1),
          content: null,
          blobSha256: put.sha256,
          byteSize: put.size,
          mime: plannerImageMime(file.relPath),
          scriptsEnabled: existing?.scriptsEnabled ?? false,
          collectedAt: this.options.clock.isoNow()
        });
        changed = true;
        continue;
      }

      const content = file.content;
      if (content === null) {
        throw new Error(`Planner text artifact was not snapshotted: ${file.relPath}`);
      }
      if (existing !== null && existing.content === content && existing.title === title && existing.aspectId === aspectId) {
        continue;
      }
      await this.options.artifacts.upsertArtifact({
        artifactId: existing?.artifactId ?? this.options.ids.planArtifactId(),
        planId: id,
        relPath: file.relPath,
        kind: file.kind,
        aspectId,
        title,
        titleOverride: existing?.titleOverride ?? null,
        revision: existing === null ? 1 : (existing.content === content ? existing.revision : existing.revision + 1),
        content,
        blobSha256: null,
        byteSize: null,
        mime: null,
        scriptsEnabled: existing?.scriptsEnabled ?? false,
        collectedAt: this.options.clock.isoNow()
      });
      changed = true;
    }

    if (changed) {
      await this.options.plans.updatePlan(id, { updatedAt: this.options.clock.isoNow() });
      this.publishChanged(id);
    }
    return this.options.artifacts.listArtifacts(id);
  }

  /**
   * Materializes the stored artifacts back into a session workspace's `plan/`
   * directory (fresh boots and revivals). Unreadable blobs degrade to a warn -
   * the agent regenerates what it cannot see.
   */
  async hydrateWorkspace(planId: PlanId, sessionId: SessionId): Promise<void> {
    const workspacePath = this.options.chat.getSessionWorkspacePath(sessionId);
    if (workspacePath === null) {
      throw new Error("Planner hydration cannot continue because the session workspace is unavailable.");
    }
    const workspaceRoot = await canonicalDirectory(workspacePath, "Planner workspace");
    const artifacts = await this.options.artifacts.listArtifacts(planId);
    for (const artifact of artifacts) {
      if (!isSafeRelPath(artifact.relPath)) {
        this.options.logger.warn("planner hydration skipped an unsafe path", { planId, relPath: artifact.relPath });
        continue;
      }
      await safeHydrationTarget(workspaceRoot, artifact.relPath);
      if (artifact.content !== null) {
        await writeFile(await assertSafeHydrationTarget(workspaceRoot, artifact.relPath), artifact.content, "utf8");
        continue;
      }
      if (artifact.blobSha256 !== null) {
        const bytes = await this.options.blobs.readBlob(artifact.blobSha256);
        if (bytes === null) {
          this.options.logger.warn("planner hydration missing image blob", { planId, relPath: artifact.relPath });
          continue;
        }
        await writeFile(await assertSafeHydrationTarget(workspaceRoot, artifact.relPath), bytes);
      }
    }
  }

  private async readPlanFiles(
    planId: PlanId,
    planRoot: PlanFilesystemRoot
  ): Promise<{ relPath: string; kind: Exclude<PlanArtifactRecord["kind"], never>; fallbackTitle: string; content: string | null }[]> {
    let candidates: string[];
    try {
      candidates = [];
      const scan = { visited: 0, exhausted: false };
      for await (const relPath of walkPlanCandidates(planRoot, "", scan)) {
        candidates.push(relPath);
      }
      if (scan.exhausted) {
        this.options.logger.warn("planner collection stopped at the directory entry scan cap", {
          planId,
          limit: PLANNER_MAX_VISITED_ENTRIES,
          visited: scan.visited
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    candidates.sort((a, b) => a.localeCompare(b));
    if (candidates.length > PLANNER_MAX_FILES) {
      this.options.logger.warn("planner collection skipped files over the count cap", {
        planId,
        limit: PLANNER_MAX_FILES,
        skipped: candidates.slice(PLANNER_MAX_FILES)
      });
      candidates = candidates.slice(0, PLANNER_MAX_FILES);
    }

    const accepted: { relPath: string; kind: PlanArtifactRecord["kind"]; fallbackTitle: string; content: string | null }[] = [];
    for (const relPath of candidates) {
      const kind = plannerKindForFile(relPath);
      if (kind === null) {
        continue;
      }
      let fallbackTitle = humanizeFileName(relPath);
      if (kind === "image") {
        accepted.push({ relPath, kind, fallbackTitle, content: null });
        continue;
      }
      const snapshot = await readBoundedPlanFile(planRoot, relPath, PLANNER_MAX_TEXT_BYTES);
      if (snapshot.bytes === null) {
        this.options.logger.warn("planner collection skipped an oversized file", {
          planId,
          relPath,
          size: snapshot.observedSize,
          limit: PLANNER_MAX_TEXT_BYTES
        });
        continue;
      }
      const content = snapshot.bytes.toString("utf8");
      if (kind === "document") {
        const heading = firstMarkdownHeading(content);
        if (heading !== null) {
          fallbackTitle = heading;
        }
      }
      accepted.push({ relPath, kind, fallbackTitle, content });
    }
    return accepted;
  }

  // -------------------------------------------------------------------------
  // Annotations
  // -------------------------------------------------------------------------

  async addAnnotation(planId: string, artifactId: string, anchor: string, body: string): Promise<PlanAnnotationSummary> {
    const id = asId<"PlanId">(planId);
    const artifact = await this.options.artifacts.getArtifact(asId<"PlanArtifactId">(artifactId));
    if (artifact === null || artifact.planId !== id) {
      throw new Error("The annotated artifact does not belong to this plan.");
    }
    const now = this.options.clock.isoNow();
    const record: PlanAnnotationRecord = {
      annotationId: this.options.ids.planAnnotationId(),
      planId: id,
      artifactId: artifact.artifactId,
      anchor,
      body,
      status: "open",
      delegatedRev: null,
      createdAt: now,
      updatedAt: now
    };
    await this.options.annotations.insertAnnotation(record);
    this.publishChanged(id);
    return toAnnotationSummary(record);
  }

  async setAnnotationStatus(annotationId: string, status: PlanAnnotationStatus): Promise<PlanAnnotationSummary> {
    const id = asId<"PlanAnnotationId">(annotationId);
    const existing = await this.options.annotations.getAnnotation(id);
    if (existing === null) {
      throw new Error("The annotation no longer exists.");
    }
    await this.options.annotations.updateAnnotation(id, {
      status,
      // Reopening clears the delegated stamp so a later send re-stamps it.
      ...(status === "open" ? { delegatedRev: null } : {}),
      updatedAt: this.options.clock.isoNow()
    });
    const updated = await this.options.annotations.getAnnotation(id);
    this.publishChanged(existing.planId);
    if (updated === null) {
      throw new Error("The annotation no longer exists.");
    }
    return toAnnotationSummary(updated);
  }

  async removeAnnotation(annotationId: string): Promise<void> {
    const id = asId<"PlanAnnotationId">(annotationId);
    const existing = await this.options.annotations.getAnnotation(id);
    if (existing === null) {
      return;
    }
    await this.options.annotations.deleteAnnotation(id);
    this.publishChanged(existing.planId);
  }

  // -------------------------------------------------------------------------
  // Artifacts
  // -------------------------------------------------------------------------

  async renameArtifact(artifactId: string, title: string): Promise<PlanArtifactSummary> {
    const id = asId<"PlanArtifactId">(artifactId);
    const artifact = await this.requireArtifact(id);
    const trimmed = title.trim();
    await this.options.artifacts.setTitleOverride(id, trimmed.length === 0 ? null : trimmed);
    const updated = await this.requireArtifact(id);
    this.publishChanged(artifact.planId);
    return toArtifactSummary(updated);
  }

  async setPrototypeScripts(artifactId: string, enabled: boolean): Promise<PlanArtifactSummary> {
    const id = asId<"PlanArtifactId">(artifactId);
    const artifact = await this.requireArtifact(id);
    if (artifact.kind !== "prototype") {
      throw new Error("Only prototype artifacts have a scripts toggle.");
    }
    await this.options.artifacts.setScriptsEnabled(id, enabled);
    const updated = await this.requireArtifact(id);
    this.publishChanged(artifact.planId);
    return toArtifactSummary(updated);
  }

  async getArtifact(artifactId: string): Promise<PlanArtifactRecord | null> {
    return this.options.artifacts.getArtifact(asId<"PlanArtifactId">(artifactId));
  }

  /** Absolute host path of an artifact's workspace file, when a session exists. */
  async artifactHostPath(artifactId: string): Promise<string | null> {
    const artifact = await this.requireArtifact(asId<"PlanArtifactId">(artifactId));
    const plan = await this.requirePlan(artifact.planId);
    if (plan.sessionId === null || !isSafeRelPath(artifact.relPath)) {
      return null;
    }
    const workspacePath = this.options.chat.getSessionWorkspacePath(plan.sessionId);
    if (workspacePath === null) {
      return null;
    }
    return path.join(workspacePath, "plan", ...artifact.relPath.split("/"));
  }

  // -------------------------------------------------------------------------
  // Aspect registry
  // -------------------------------------------------------------------------

  /** SQLite rows plus any overlay pack; a stored row wins an id collision. */
  async listAspects(includeArchived = false): Promise<PlanAspectRecord[]> {
    const stored = await this.options.aspects.listAspects(includeArchived);
    if (this.options.aspectOverlays === undefined) {
      return stored;
    }
    let overlays: readonly PlanAspectRecord[] = [];
    try {
      overlays = await this.options.aspectOverlays();
    } catch (error) {
      this.options.logger.warn("planner aspect overlay read failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    const knownIds = new Set(stored.map((aspect) => aspect.aspectId));
    const merged = [...stored];
    for (const overlay of overlays) {
      if (!knownIds.has(overlay.aspectId)) {
        merged.push(overlay);
      }
    }
    return merged.sort((a, b) => (a.sortOrder - b.sortOrder) || a.label.localeCompare(b.label));
  }

  async saveAspect(input: PlannerAspectSaveInput): Promise<PlanAspectSummary[]> {
    if (input.aspectId !== undefined) {
      const existing = await this.options.aspects.getAspect(input.aspectId);
      if (existing === null) {
        throw new Error(`Aspect "${input.aspectId}" does not exist.`);
      }
      await this.options.aspects.upsertAspect({
        ...existing,
        label: input.label,
        instructions: input.instructions,
        expectedArtifacts: input.expectedArtifacts
      });
    } else {
      const aspectId = await this.freshAspectId(input.label);
      const all = await this.options.aspects.listAspects(true);
      const sortOrder = all.reduce((max, aspect) => Math.max(max, aspect.sortOrder), -1) + 1;
      await this.options.aspects.upsertAspect({
        aspectId,
        label: input.label,
        instructions: input.instructions,
        expectedArtifacts: input.expectedArtifacts,
        sortOrder,
        archived: false,
        seeded: false
      });
    }
    return (await this.listAspects(true)).map(toAspectSummary);
  }

  async archiveAspect(aspectId: string, archived: boolean): Promise<PlanAspectSummary[]> {
    await this.options.aspects.setArchived(aspectId, archived);
    return (await this.listAspects(true)).map(toAspectSummary);
  }

  private async freshAspectId(label: string): Promise<string> {
    const base = slugify(label);
    let candidate = base;
    for (let suffix = 2; (await this.options.aspects.getAspect(candidate)) !== null; suffix += 1) {
      candidate = `${base}-${String(suffix)}`;
    }
    return candidate;
  }

  // -------------------------------------------------------------------------
  // Briefing
  // -------------------------------------------------------------------------

  /** The planning contract sent as the session's first turn. */
  async composeBriefing(plan: PlanRecord): Promise<string> {
    const aspects = await this.listAspects(true);
    const byId = new Map(aspects.map((aspect) => [aspect.aspectId, aspect]));
    const aspectLines = plan.aspectIds
      .map((aspectId) => {
        const aspect = byId.get(aspectId);
        if (aspect === undefined) {
          return `- ${aspectId} (write under plan/${aspectId}/)`;
        }
        const expected = aspect.expectedArtifacts.length === 0 ? "" : ` Expected: ${aspect.expectedArtifacts.join("; ")}.`;
        return `- ${aspect.label} (write under plan/${aspect.aspectId}/): ${aspect.instructions}${expected}`;
      });
    const sections = [
      `[host briefing - planner]`,
      `You are drafting the plan "${plan.title}". The ask follows after this briefing.`,
      ...(plan.notes.trim().length === 0 ? [] : [`Pre-information from the reviewer:\n${plan.notes}`]),
      [
        "Write every artifact under the `plan/` directory of your workspace, one subdirectory per aspect below.",
        "Formats: Markdown (`.md`) for documents - the first `# H1` becomes the display title; Mermaid (`.mmd`, or ```mermaid fences inside a document) for diagrams;",
        "PNG/SVG images for mockups; one self-contained `.html` file (inline CSS/JS, no external requests) for a clickable prototype.",
        `Revise files in place - the reviewer sees revisions, not copies. Keep text files under ${String(PLANNER_MAX_TEXT_BYTES / 1024)} KB, images under ${String(PLANNER_MAX_IMAGE_BYTES / (1024 * 1024))} MB, and at most ${String(PLANNER_MAX_FILES)} files.`,
        "Optionally maintain `plan/manifest.json` mapping relative paths to display titles."
      ].join(" "),
      ...(aspectLines.length === 0 ? [] : [`Aspects to cover:\n${aspectLines.join("\n")}`]),
      "The project context is mounted read-only; the plan directory is writable.",
      "[end host briefing - planner]",
      "",
      // The brief sits OUTSIDE the briefing delimiters so a rail's collapsed
      // rendering leads with the user's own words, not host preamble.
      plan.brief,
      "Draft the initial plan artifacts now."
    ];
    return sections.join("\n\n");
  }

  // -------------------------------------------------------------------------
  // Projections & helpers
  // -------------------------------------------------------------------------

  private async toPlanSummary(record: PlanRecord, taskTitles: ReadonlyMap<string, string>): Promise<PlanSummary> {
    const [artifactCount, openAnnotationCount] = await Promise.all([
      this.options.artifacts.countArtifacts(record.planId),
      this.options.annotations.countOpenAnnotations(record.planId)
    ]);
    const taskTitle = record.taskId === null ? undefined : taskTitles.get(record.taskId);
    return {
      planId: record.planId,
      title: record.title,
      brief: record.brief,
      aspectIds: record.aspectIds,
      contextRoots: record.contextRoots,
      notes: record.notes,
      status: record.status,
      sessionId: record.sessionId,
      taskId: record.taskId,
      ...(taskTitle === undefined ? {} : { taskTitle }),
      artifactCount,
      openAnnotationCount,
      updatedAt: record.updatedAt
    };
  }

  private async toArtifactDetail(record: PlanArtifactRecord): Promise<PlanArtifactDetail> {
    const summary = toArtifactSummary(record);
    if (record.content !== null) {
      return { ...summary, content: record.content };
    }
    if (record.blobSha256 !== null) {
      if (record.byteSize !== null && record.byteSize <= PLANNER_INLINE_IMAGE_BYTES) {
        const bytes = await this.options.blobs.readBlob(record.blobSha256);
        if (bytes !== null) {
          const mime = record.mime ?? "application/octet-stream";
          return { ...summary, imageDataUri: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}` };
        }
      }
      return { ...summary, oversizedImage: true };
    }
    return summary;
  }

  private async requirePlan(planId: PlanId): Promise<PlanRecord> {
    const plan = await this.options.plans.getPlan(planId);
    if (plan === null) {
      throw new Error("The plan no longer exists.");
    }
    return plan;
  }

  private async requireArtifact(artifactId: PlanArtifactId): Promise<PlanArtifactRecord> {
    const artifact = await this.options.artifacts.getArtifact(artifactId);
    if (artifact === null) {
      throw new Error("The artifact no longer exists.");
    }
    return artifact;
  }

  private publishChanged(planId: PlanId): void {
    this.options.bus.publish({ kind: "planner-changed", planId });
  }
}

// ---------------------------------------------------------------------------
// Filesystem boundary helpers
// ---------------------------------------------------------------------------

interface PlanFilesystemRoot {
  readonly workspace: string;
  readonly planPath: string;
  readonly canonicalPlan: string;
}

async function* walkPlanCandidates(
  root: PlanFilesystemRoot,
  relativeDirectory: string,
  scan: { visited: number; exhausted: boolean }
): AsyncGenerator<string> {
  const directoryPath = relativeDirectory.length === 0
    ? await checkedPlanRoot(root)
    : await checkedPlanDirectory(root, relativeDirectory);
  const directory = await opendir(directoryPath);
  for await (const entry of directory) {
    if (scan.visited >= PLANNER_MAX_VISITED_ENTRIES) {
      scan.exhausted = true;
      return;
    }
    scan.visited += 1;
    const relPath = relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new Error("Planner collection refused a symbolic link or junction under plan/.");
    }
    if (entry.isDirectory()) {
      if (isSafeRelPath(relPath)) {
        yield* walkPlanCandidates(root, relPath, scan);
        if (scan.exhausted) return;
      }
      continue;
    }
    if (
      entry.isFile()
      && relPath !== MANIFEST_NAME
      && isSafeRelPath(relPath)
      && plannerKindForFile(relPath) !== null
    ) {
      yield relPath;
    }
  }
}

async function existingPlanRoot(workspacePath: string): Promise<PlanFilesystemRoot | null> {
  const workspace = await canonicalDirectory(workspacePath, "Planner workspace");
  const planPath = path.join(workspace, "plan");
  let info;
  try {
    info = await lstat(planPath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  assertDirectoryIsNotLink(info, planPath);
  const canonicalPlan = await realpath(planPath);
  assertPathWithin(canonicalPlan, workspace, "Planner plan directory escaped its workspace.");
  return { workspace, planPath, canonicalPlan };
}

async function canonicalDirectory(candidate: string, label: string): Promise<string> {
  const canonical = await realpath(candidate);
  if (!(await stat(canonical)).isDirectory()) {
    throw new Error(`${label} is not a directory: ${candidate}`);
  }
  return canonical;
}

/** Revalidates every component immediately before a collection operation. */
async function checkedPlanFile(root: PlanFilesystemRoot, relPath: string): Promise<string> {
  if (!isSafeRelPath(relPath)) {
    throw new Error(`Planner collection refused an unsafe path: ${relPath}`);
  }
  const currentPlan = await checkedPlanRoot(root);
  let current = root.planPath;
  const segments = relPath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index] ?? "");
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw new Error(`Planner collection refused a symbolic link or junction: ${relPath}`);
    }
    const isFinal = index === segments.length - 1;
    if ((!isFinal && !info.isDirectory()) || (isFinal && !info.isFile())) {
      throw new Error(`Planner collection refused a non-file path: ${relPath}`);
    }
  }
  const canonical = await realpath(current);
  assertPathWithin(canonical, currentPlan, `Planner artifact escaped plan/: ${relPath}`);
  return canonical;
}

async function checkedPlanDirectory(root: PlanFilesystemRoot, relPath: string): Promise<string> {
  if (!isSafeRelPath(relPath)) {
    throw new Error(`Planner collection refused an unsafe directory: ${relPath}`);
  }
  const currentPlan = await checkedPlanRoot(root);
  let current = root.planPath;
  for (const segment of relPath.split("/")) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Planner collection refused a linked or non-directory path: ${relPath}`);
    }
  }
  const canonical = await realpath(current);
  assertPathWithin(canonical, currentPlan, `Planner directory escaped plan/: ${relPath}`);
  return canonical;
}

interface BoundedPlanRead {
  readonly bytes: Buffer | null;
  readonly observedSize: number;
}

/** Reads at most limit + 1 bytes from one already-open regular-file handle. */
async function readBoundedPlanFile(
  root: PlanFilesystemRoot,
  relPath: string,
  limit: number
): Promise<BoundedPlanRead> {
  const handle = await open(await checkedPlanFile(root, relPath), "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Error(`Planner collection refused a non-file path: ${relPath}`);
    }
    if (info.size > limit) {
      return { bytes: null, observedSize: info.size };
    }
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > limit) {
      return { bytes: null, observedSize: total };
    }
    return { bytes: buffer.subarray(0, total), observedSize: total };
  } finally {
    await handle.close();
  }
}

/** Passes only the already-bounded snapshot into durable blob storage. */
async function putBoundedPlanImage(
  blobs: BlobStore,
  root: PlanFilesystemRoot,
  relPath: string
): Promise<{ readonly sha256: string; readonly size: number } | null> {
  const snapshot = await readBoundedPlanFile(root, relPath, PLANNER_MAX_IMAGE_BYTES);
  if (snapshot.bytes === null) return null;
  const put = await blobs.putBytes(snapshot.bytes);
  if (put.size !== snapshot.bytes.byteLength) {
    throw new Error("Planner blob store returned an inconsistent snapshot size.");
  }
  return put;
}

async function checkedPlanRoot(root: PlanFilesystemRoot): Promise<string> {
  const info = await lstat(root.planPath);
  assertDirectoryIsNotLink(info, root.planPath);
  const current = await realpath(root.planPath);
  assertPathWithin(current, root.workspace, "Planner plan directory escaped its workspace.");
  if (path.relative(current, root.canonicalPlan) !== "") {
    throw new Error("Planner plan directory changed during collection.");
  }
  return current;
}

async function safeHydrationTarget(workspace: string, relPath: string): Promise<void> {
  if (!isSafeRelPath(relPath)) {
    throw new Error(`Planner hydration refused an unsafe path: ${relPath}`);
  }
  const segments = relPath.split("/");
  await ensureSafeDirectories(workspace, ["plan", ...segments.slice(0, -1)]);
  await assertSafeHydrationTarget(workspace, relPath);
}

async function ensureSafeDirectories(workspace: string, segments: readonly string[]): Promise<void> {
  let current = workspace;
  for (const segment of segments) {
    current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (!isMissing(error)) throw error;
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      info = await lstat(current);
    }
    assertDirectoryIsNotLink(info, current);
    assertPathWithin(await realpath(current), workspace, "Planner hydration directory escaped its workspace.");
  }
}

/** Rechecks all parents and the final target immediately before writeFile. */
async function assertSafeHydrationTarget(workspace: string, relPath: string): Promise<string> {
  if (!isSafeRelPath(relPath)) {
    throw new Error(`Planner hydration refused an unsafe path: ${relPath}`);
  }
  const segments = ["plan", ...relPath.split("/")];
  let current = workspace;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index] ?? "");
    const isFinal = index === segments.length - 1;
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (isFinal && isMissing(error)) {
        assertPathWithin(
          await realpath(path.dirname(current)),
          workspace,
          "Planner hydration target escaped its workspace."
        );
        return current;
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`Planner hydration refused a symbolic link or junction: ${relPath}`);
    }
    if ((!isFinal && !info.isDirectory()) || (isFinal && !info.isFile())) {
      throw new Error(`Planner hydration refused an invalid target: ${relPath}`);
    }
    assertPathWithin(await realpath(current), workspace, "Planner hydration path escaped its workspace.");
  }
  return current;
}

function assertDirectoryIsNotLink(info: Awaited<ReturnType<typeof lstat>>, candidate: string): void {
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Planner refused a linked or non-directory path: ${candidate}`);
  }
}

function assertPathWithin(candidate: string, root: string, message: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(message);
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function effectiveTitle(artifact: PlanArtifactRecord): string {
  return artifact.titleOverride ?? artifact.title;
}

function toArtifactSummary(record: PlanArtifactRecord): PlanArtifactSummary {
  return {
    artifactId: record.artifactId,
    relPath: record.relPath,
    kind: record.kind,
    aspectId: record.aspectId,
    title: effectiveTitle(record),
    revision: record.revision,
    scriptsEnabled: record.scriptsEnabled,
    collectedAt: record.collectedAt
  };
}

function toAnnotationSummary(record: PlanAnnotationRecord): PlanAnnotationSummary {
  return {
    annotationId: record.annotationId,
    artifactId: record.artifactId,
    anchor: record.anchor,
    body: record.body,
    status: record.status,
    delegatedRev: record.delegatedRev,
    createdAt: record.createdAt
  };
}

function toAspectSummary(record: PlanAspectRecord): PlanAspectSummary {
  return {
    aspectId: record.aspectId,
    label: record.label,
    instructions: record.instructions,
    expectedArtifacts: record.expectedArtifacts,
    sortOrder: record.sortOrder,
    archived: record.archived,
    seeded: record.seeded
  };
}

/** First path segment when it names a known aspect; "general" otherwise. */
function aspectForPath(relPath: string, knownAspects: ReadonlySet<string>): string {
  const separator = relPath.indexOf("/");
  if (separator <= 0) {
    return PLANNER_ASPECT_FALLBACK_ID;
  }
  const head = relPath.slice(0, separator);
  return knownAspects.has(head) ? head : PLANNER_ASPECT_FALLBACK_ID;
}

/** Rejects traversal, absolute paths, and drive-letter escapes in stored paths. */
function isSafeRelPath(relPath: string): boolean {
  if (relPath.length === 0 || relPath.length > 512) return false;
  if (relPath.includes("\\") || relPath.includes(":")) return false;
  if (relPath.startsWith("/")) return false;
  return relPath.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function firstMarkdownHeading(content: string): string | null {
  const match = /^#\s+(.+)$/m.exec(content);
  if (match === null) {
    return null;
  }
  const heading = (match[1] ?? "").trim();
  return heading.length === 0 ? null : heading.slice(0, 120);
}

/** "ui-ux/login_flow.mmd" → "Login flow". */
function humanizeFileName(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  const stem = base.replace(/\.[^.]+$/, "");
  const spaced = stem.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (spaced.length === 0) {
    return base;
  }
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function titleFromBrief(brief: string): string {
  const firstLine = (brief.split(/\r?\n/, 1)[0] ?? "").trim();
  if (firstLine.length <= PLAN_TITLE_MAX) {
    return firstLine.length === 0 ? "New plan" : firstLine;
  }
  return `${firstLine.slice(0, PLAN_TITLE_MAX - 1).trimEnd()}…`;
}

function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length === 0 ? "aspect" : slug;
}

/** plan/manifest.json → relPath → display title; tolerant of any malformation. */
async function readManifestTitles(
  planRoot: PlanFilesystemRoot,
  logger: Logger,
  planId: PlanId
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  let raw: string;
  try {
    const snapshot = await readBoundedPlanFile(planRoot, MANIFEST_NAME, PLANNER_MAX_TEXT_BYTES);
    if (snapshot.bytes === null) {
      logger.warn("planner collection ignored an oversized manifest", {
        planId,
        size: snapshot.observedSize,
        limit: PLANNER_MAX_TEXT_BYTES
      });
      return titles;
    }
    raw = snapshot.bytes.toString("utf8");
  } catch (error) {
    if (isMissing(error)) return titles;
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return titles;
    }
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const relPath = key.replace(/\\/g, "/").replace(/^plan\//, "");
      if (typeof value === "string" && value.trim().length > 0) {
        titles.set(relPath, value.trim().slice(0, 120));
      } else if (typeof value === "object" && value !== null) {
        const title = (value as Record<string, unknown>)["title"];
        if (typeof title === "string" && title.trim().length > 0) {
          titles.set(relPath, title.trim().slice(0, 120));
        }
      }
    }
  } catch {
    // Malformed manifest: fall back to headings/filenames.
  }
  return titles;
}
