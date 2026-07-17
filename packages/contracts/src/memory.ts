/**
 * Memory contracts.
 *
 * Agents propose durable insights via a ```memory-candidate``` fenced block in
 * their final text (same host-parsed sentinel pattern as access requests - the
 * runtime has no host network route). Candidates are inert until a human
 * approves them; approved memories are injected into future session briefings.
 * Nothing an agent writes becomes persistent context without review - that is
 * the whole point of the approval gate. Users can also add memories directly
 * (quick-add); those are human-authored and land already approved.
 *
 * Memories are SCOPED (global / workspace / task) and optionally TAGGED so a
 * briefing only carries what applies to the session at hand. Tags come from a
 * glob rule table matched against the mounted roots (see @drydock/core
 * tagRules): `*.py` → python, `package.py` → rez, and so on.
 */

import type { MemoryCandidateId, SessionId } from "./ids.js";

export type MemoryCandidateStatus = "pending" | "approved" | "rejected";

/**
 * Where a memory applies. `global` briefs every session; `workspace` briefs
 * sessions whose mounted roots intersect the memory's stored roots;
 * `task` briefs sessions linked to the memory's task.
 */
export type MemoryScope = "global" | "workspace" | "task";

/** Who authored the memory: agent proposals gate on approval; user entries land approved. */
export type MemoryOrigin = "agent" | "user";

export interface MemoryCandidateRecord {
  readonly memoryCandidateId: MemoryCandidateId;
  readonly sessionId: SessionId;
  /** Plain text; rendered textContent-only and injected verbatim into briefings. */
  readonly content: string;
  readonly status: MemoryCandidateStatus;
  readonly createdAt: string;
  readonly resolvedAt?: string;
  /** Absent on legacy rows = global (the pre-scoping behavior). */
  readonly scope?: MemoryScope;
  /**
   * Scope anchor. Task scope: the taskId. Workspace scope: normalized
   * absolute root paths the memory travels with. Global: absent.
   */
  readonly scopeTaskId?: string;
  readonly scopeRoots?: readonly string[];
  /** Tag selectors (from the glob rule table); empty/absent = applies untagged. */
  readonly tags?: readonly string[];
  /** Absent on legacy rows = agent. */
  readonly origin?: MemoryOrigin;
}

/** Human edits applied when approving a pending candidate (trim, retarget). */
export interface MemoryCandidateEdits {
  readonly content?: string;
  readonly scope?: MemoryScope;
  readonly scopeTaskId?: string;
  readonly scopeRoots?: readonly string[];
  readonly tags?: readonly string[];
}

export const MEMORY_CANDIDATE_MAX_LENGTH = 2_000;
/** Upper bound honored per agent text, to bound review spam. */
export const MAX_MEMORY_CANDIDATES_PER_TEXT = 3;
/** Newest approved memories injected into a session briefing, per scope group. */
export const MEMORY_BRIEFING_LIMIT = 10;
export const MAX_MEMORY_TAGS = 8;
export const MAX_MEMORY_TAG_LENGTH = 32;

export interface MemoryCandidateStore {
  insertCandidate(record: MemoryCandidateRecord): Promise<void>;
  getCandidate(memoryCandidateId: MemoryCandidateId): Promise<MemoryCandidateRecord | null>;
  /** Newest-first; all statuses when the filter is omitted. */
  listCandidates(status?: MemoryCandidateStatus): Promise<MemoryCandidateRecord[]>;
  updateCandidateStatus(memoryCandidateId: MemoryCandidateId, status: MemoryCandidateStatus, resolvedAt: string): Promise<void>;
  /** Applies human edits to a still-pending candidate (approval-time trims). */
  updateCandidateContent(memoryCandidateId: MemoryCandidateId, edits: MemoryCandidateEdits): Promise<void>;
  deleteCandidate(memoryCandidateId: MemoryCandidateId): Promise<void>;
}
