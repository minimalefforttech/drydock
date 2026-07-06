/**
 * Memory-candidate contracts.
 *
 * Agents propose durable insights via a ```memory-candidate``` fenced block in
 * their final text (same host-parsed sentinel pattern as access requests — the
 * runtime has no host network route). Candidates are inert until a human
 * approves them; approved memories are injected into future session briefings.
 * Nothing an agent writes becomes persistent context without review — that is
 * the whole point of the approval gate.
 */

import type { MemoryCandidateId, SessionId } from "./ids.js";

export type MemoryCandidateStatus = "pending" | "approved" | "rejected";

export interface MemoryCandidateRecord {
  readonly memoryCandidateId: MemoryCandidateId;
  readonly sessionId: SessionId;
  /** Plain text; rendered textContent-only and injected verbatim into briefings. */
  readonly content: string;
  readonly status: MemoryCandidateStatus;
  readonly createdAt: string;
  readonly resolvedAt?: string;
}

export const MEMORY_CANDIDATE_MAX_LENGTH = 2_000;
/** Upper bound honored per agent text, to bound review spam. */
export const MAX_MEMORY_CANDIDATES_PER_TEXT = 3;
/** Newest approved memories injected into a session briefing. */
export const MEMORY_BRIEFING_LIMIT = 10;

export interface MemoryCandidateStore {
  insertCandidate(record: MemoryCandidateRecord): Promise<void>;
  getCandidate(memoryCandidateId: MemoryCandidateId): Promise<MemoryCandidateRecord | null>;
  /** Newest-first; all statuses when the filter is omitted. */
  listCandidates(status?: MemoryCandidateStatus): Promise<MemoryCandidateRecord[]>;
  updateCandidateStatus(memoryCandidateId: MemoryCandidateId, status: MemoryCandidateStatus, resolvedAt: string): Promise<void>;
}
