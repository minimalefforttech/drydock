/**
 * Plan-document contracts (chat panel redesign, Phase 2 — plan mode v2).
 *
 * In plan mode the agent writes documents into the `plan/` directory of its
 * container workspace; the host collects them after each turn (the workspace
 * is a host-side temp dir, so collection is a bounded local read) and stores
 * them as text rows keyed by session + name. Revisions bump only when content
 * changes, so the review panel can tell edits from re-collections. Block
 * comments reuse the review-comment service with the `plan:<name>` filePath
 * convention; there is no separate plan-doc comment store.
 */

import type { SessionId } from "./ids.js";

export type PlanDocFormat = "markdown" | "mermaid";

export interface PlanDocRecord {
  readonly sessionId: SessionId;
  /** Path relative to the workspace `plan/` directory, forward-slashed. */
  readonly name: string;
  readonly format: PlanDocFormat;
  readonly content: string;
  /** Starts at 1; bumps only when collected content differs. */
  readonly revision: number;
  readonly collectedAt: string;
}

/** Collection bounds: anything beyond these is skipped, never truncated. */
export const PLAN_DOC_MAX_FILES = 20;
export const PLAN_DOC_MAX_BYTES = 256 * 1024;

export interface PlanDocStore {
  /** Insert-or-replace by (sessionId, name); the caller owns revision logic. */
  upsertDoc(record: PlanDocRecord): Promise<void>;
  getDoc(sessionId: SessionId, name: string): Promise<PlanDocRecord | null>;
  /** Ordered by name for a stable nav; content included. */
  listDocs(sessionId: SessionId): Promise<PlanDocRecord[]>;
  deleteSessionDocs(sessionId: SessionId): Promise<number>;
}
