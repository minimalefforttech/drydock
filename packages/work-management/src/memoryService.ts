/**
 * Memory service (docs/design/mcp-and-memory.md).
 *
 * Agents propose durable insights; each parsed note is captured as a pending
 * candidate, inert until a human approves it (with edit-before-approve -
 * agent proposals run wordy). Users quick-add short memories that land
 * already approved. Approved memories feed session briefings GROUPED BY SCOPE
 * (task → workspace → global, most specific first) and filtered by workspace
 * tags, so a briefing only carries what applies. Persistence lives in the
 * store; capture dedupe, the approve/reject state machine, scope resolution,
 * and the briefing projection live here.
 */

import { asId, MEMORY_BRIEFING_LIMIT } from "@drydock/contracts";
import type {
  MemoryCandidateEdits,
  MemoryCandidateRecord,
  MemoryCandidateStatus,
  MemoryCandidateStore,
  MemoryScope
} from "@drydock/contracts";
import type { Clock, IdGenerator } from "@drydock/core";

export interface MemoryServiceOptions {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly store: MemoryCandidateStore;
}

/** One agent-proposed candidate at capture time (parsed fence output). */
export interface CapturedMemoryInput {
  readonly content: string;
  readonly scope?: MemoryScope;
  readonly tags?: readonly string[];
}

/** Where the source session sat, so scope suggestions resolve to anchors. */
export interface MemoryCaptureContext {
  /** Source session's mounted roots - the workspace-scope anchor. */
  readonly sessionRoots?: readonly string[];
  /** Task linked to the source session - the task-scope anchor. */
  readonly taskId?: string;
}

/** A user quick-add entry; short, already human-authored, lands approved. */
export interface UserMemoryInput {
  readonly content: string;
  readonly scope: MemoryScope;
  readonly taskId?: string;
  readonly roots?: readonly string[];
  readonly tags?: readonly string[];
}

/** What a session is, for briefing selection. */
export interface MemoryBriefingQuery {
  readonly sessionRoots: readonly string[];
  readonly taskIds: readonly string[];
  /** Tags detected in the session's roots (glob rule table). */
  readonly detectedTags: readonly string[];
  /** Managed-policy guard: drop global (provenance-free) memories. */
  readonly blockGlobal?: boolean;
}

export interface MemoryBriefingGroup {
  readonly label: string;
  readonly notes: readonly string[];
}

/** Normalizes a root path for intersection tests: slashes + case + no trailing sep. */
function normalizeRoot(root: string): string {
  return root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function rootsIntersect(a: readonly string[] | undefined, b: readonly string[]): boolean {
  if (a === undefined || a.length === 0) return false;
  const normalized = new Set(b.map(normalizeRoot));
  return a.some((root) => normalized.has(normalizeRoot(root)));
}

/** A tagged memory applies only when at least one tag was detected; untagged always applies. */
function tagsApply(memory: MemoryCandidateRecord, detectedTags: readonly string[]): boolean {
  if (memory.tags === undefined || memory.tags.length === 0) return true;
  const detected = new Set(detectedTags.map((tag) => tag.toLowerCase()));
  return memory.tags.some((tag) => detected.has(tag.toLowerCase()));
}

/** Legacy rows (no scope column) read back as global - the pre-scoping behavior. */
function scopeOf(memory: MemoryCandidateRecord): MemoryScope {
  return memory.scope ?? "global";
}

export class MemoryService {
  constructor(private readonly options: MemoryServiceOptions) {}

  /**
   * Captures agent-proposed notes as pending candidates. Each content is
   * trimmed; content matching an existing candidate of ANY status is skipped
   * (dedupe against re-emitting agents and re-approvals alike). Scope
   * suggestions resolve against the capture context: workspace (the default
   * when the agent names none) anchors to the source session's roots, task to
   * its linked task - a task suggestion without a linked task falls back to
   * workspace. Returns only the records actually created.
   */
  async captureCandidates(
    sessionId: string,
    inputs: readonly CapturedMemoryInput[],
    context: MemoryCaptureContext = {}
  ): Promise<MemoryCandidateRecord[]> {
    if (inputs.length === 0) {
      return [];
    }
    const session = asId<"SessionId">(sessionId);
    const seen = new Set(
      (await this.options.store.listCandidates()).map((candidate) => candidate.content)
    );
    const created: MemoryCandidateRecord[] = [];
    for (const input of inputs) {
      const content = input.content.trim();
      if (content.length === 0 || seen.has(content)) {
        continue;
      }
      let scope: MemoryScope = input.scope ?? "workspace";
      if (scope === "task" && context.taskId === undefined) scope = "workspace";
      if (scope === "workspace" && (context.sessionRoots === undefined || context.sessionRoots.length === 0)) scope = "global";
      const record: MemoryCandidateRecord = {
        memoryCandidateId: this.options.ids.memoryCandidateId(),
        sessionId: session,
        content,
        status: "pending",
        createdAt: this.options.clock.isoNow(),
        scope,
        origin: "agent",
        ...(scope === "task" && context.taskId !== undefined ? { scopeTaskId: context.taskId } : {}),
        ...(scope === "workspace" && context.sessionRoots !== undefined ? { scopeRoots: context.sessionRoots } : {}),
        ...(input.tags === undefined || input.tags.length === 0 ? {} : { tags: input.tags })
      };
      await this.options.store.insertCandidate(record);
      // Guard against duplicates within this same batch too.
      seen.add(content);
      created.push(record);
    }
    return created;
  }

  /**
   * User quick-add: human-authored, so no review gate - the record lands
   * approved immediately. The sessionId column carries the "user" sentinel.
   */
  async addUserMemory(input: UserMemoryInput): Promise<MemoryCandidateRecord> {
    const content = input.content.trim();
    if (content.length === 0) {
      throw new Error("A memory needs content.");
    }
    let scope = input.scope;
    if (scope === "task" && input.taskId === undefined) scope = "workspace";
    if (scope === "workspace" && (input.roots === undefined || input.roots.length === 0)) scope = "global";
    const now = this.options.clock.isoNow();
    const record: MemoryCandidateRecord = {
      memoryCandidateId: this.options.ids.memoryCandidateId(),
      sessionId: asId<"SessionId">("user"),
      content,
      status: "approved",
      createdAt: now,
      resolvedAt: now,
      scope,
      origin: "user",
      ...(scope === "task" && input.taskId !== undefined ? { scopeTaskId: input.taskId } : {}),
      ...(scope === "workspace" && input.roots !== undefined ? { scopeRoots: input.roots } : {}),
      ...(input.tags === undefined || input.tags.length === 0 ? {} : { tags: input.tags })
    };
    await this.options.store.insertCandidate(record);
    return record;
  }

  /**
   * Approves or rejects a pending candidate, applying any human edits first
   * (trimmed content, retargeted scope, adjusted tags) - the ask-user gate is
   * edit-then-approve. Re-resolving an already-resolved candidate is rejected
   * so an approval/rejection cannot be flipped after the fact.
   */
  async resolve(memoryCandidateId: string, approve: boolean, edits?: MemoryCandidateEdits): Promise<MemoryCandidateRecord> {
    const id = asId<"MemoryCandidateId">(memoryCandidateId);
    const existing = await this.options.store.getCandidate(id);
    if (existing === null) {
      throw new Error(`Memory candidate ${memoryCandidateId} was not found.`);
    }
    if (existing.status !== "pending") {
      throw new Error(`Memory candidate ${memoryCandidateId} is already ${existing.status}.`);
    }
    if (approve && edits !== undefined) {
      await this.options.store.updateCandidateContent(id, edits);
    }
    const status: MemoryCandidateStatus = approve ? "approved" : "rejected";
    const resolvedAt = this.options.clock.isoNow();
    await this.options.store.updateCandidateStatus(id, status, resolvedAt);
    const resolved = await this.options.store.getCandidate(id);
    if (resolved === null) {
      throw new Error(`Memory candidate ${memoryCandidateId} vanished during resolution.`);
    }
    return resolved;
  }

  /** Removes a memory outright (approved entries have no other exit). */
  async deleteMemory(memoryCandidateId: string): Promise<void> {
    await this.options.store.deleteCandidate(asId<"MemoryCandidateId">(memoryCandidateId));
  }

  listCandidates(status?: MemoryCandidateStatus): Promise<MemoryCandidateRecord[]> {
    return this.options.store.listCandidates(status);
  }

  /** Fetches one candidate by id, or null when it does not exist. */
  getCandidate(memoryCandidateId: string): Promise<MemoryCandidateRecord | null> {
    return this.options.store.getCandidate(asId<"MemoryCandidateId">(memoryCandidateId));
  }

  /**
   * Briefing projection: approved memories that APPLY to this session,
   * grouped by scope most specific first (task → workspace → global), each
   * group newest-first and capped. Tagged memories require a detected tag;
   * unsure means unlisted, matching the evidence-based-views posture.
   */
  async briefingGroups(query: MemoryBriefingQuery): Promise<MemoryBriefingGroup[]> {
    const selected = await this.briefingRecords(query);
    return selected.map((group) => ({ label: group.label, notes: group.records.map((record) => record.content) }));
  }

  /** Same selection as briefingGroups, with full records for provenance views. */
  async briefingRecords(query: MemoryBriefingQuery): Promise<{ label: string; records: MemoryCandidateRecord[] }[]> {
    const approved = await this.options.store.listCandidates("approved");
    const taskIds = new Set(query.taskIds);
    const task: MemoryCandidateRecord[] = [];
    const workspace: MemoryCandidateRecord[] = [];
    const global: MemoryCandidateRecord[] = [];
    for (const memory of approved) {
      if (!tagsApply(memory, query.detectedTags)) continue;
      const scope = scopeOf(memory);
      if (scope === "task") {
        if (memory.scopeTaskId !== undefined && taskIds.has(memory.scopeTaskId) && task.length < MEMORY_BRIEFING_LIMIT) {
          task.push(memory);
        }
      } else if (scope === "workspace") {
        if (rootsIntersect(memory.scopeRoots, query.sessionRoots) && workspace.length < MEMORY_BRIEFING_LIMIT) {
          workspace.push(memory);
        }
      } else if (query.blockGlobal !== true && global.length < MEMORY_BRIEFING_LIMIT) {
        global.push(memory);
      }
    }
    const groups: { label: string; records: MemoryCandidateRecord[] }[] = [];
    if (task.length > 0) groups.push({ label: "this task", records: task });
    if (workspace.length > 0) groups.push({ label: "this workspace", records: workspace });
    if (global.length > 0) groups.push({ label: "global", records: global });
    return groups;
  }

  /** Newest-first approved contents, capped - the legacy flat projection. */
  async listApprovedContents(limit: number): Promise<string[]> {
    const approved = await this.options.store.listCandidates("approved");
    return approved.slice(0, limit).map((candidate) => candidate.content);
  }
}
