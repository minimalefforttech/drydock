/**
 * Diff review contracts.
 *
 * A baseline captures one root's file state (path, size, mtime, hash) with
 * content-addressed blobs for revert. Diffs compare the live tree against the
 * baseline independently of Git. Review sessions attach file/line comments
 * with thread states to those changes.
 */

import type { BaselineId, ReviewCommentId, ReviewSessionId, SessionId } from "./ids.js";

/**
 * What a baseline (and its review) covers. A session owns up to three scopes
 * per root: `session-start` is the immutable snapshot taken when the session
 * began (never advanced — backs the Full Session view), `current-session` is
 * the working baseline that accept advances per file (the Session view), and
 * `turn` is re-captured at each user message send (the This Turn view).
 */
export type DiffScope = "current-session" | "session-start" | "turn" | "workspace";

/**
 * Which frame the Changes list diffs against: `turn` = since the last user
 * message, `session` = since session start with accepted files re-baselined,
 * `full-session` = since session start including accepted changes.
 */
export type DiffViewMode = "turn" | "session" | "full-session";

export interface DiffBaselineRecord {
  readonly baselineId: BaselineId;
  readonly scope: DiffScope;
  readonly sessionId?: SessionId;
  /** Absolute host path of the snapshotted root. */
  readonly rootPath: string;
  readonly createdAt: string;
}

export interface FileBaselineSnapshot {
  /** Root-relative path with forward slashes. */
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mtimeMs: number;
  /**
   * When this snapshot was captured. Files whose mtime is within the racy
   * window of this moment are re-hashed during diff instead of trusting
   * size+mtime (an edit inside the same mtime tick would otherwise hide).
   */
  readonly capturedAtMs: number;
  /** False when the file exceeded the blob cap: change detection works, revert does not. */
  readonly blobStored: boolean;
}

export type DiffChangeKind = "add" | "modify" | "delete" | "rename";

export interface DiffFileChange {
  readonly path: string;
  readonly changeKind: DiffChangeKind;
  /** Previous path for rename-like add/delete pairs. */
  readonly oldPath?: string;
  readonly baselineSha256?: string;
  readonly currentSha256?: string;
  readonly currentSize?: number;
  /** Line-diff stats vs the baseline; absent for binary/oversized files. */
  readonly addedLines?: number;
  readonly removedLines?: number;
  readonly revertSupported: boolean;
  /** Present when revert is unsupported; a user-visible explanation. */
  readonly reason?: string;
}

export type ReviewThreadStatus =
  | "open"
  | "acknowledged"
  | "delegated"
  | "resolved"
  | "wont-fix"
  | "blocked";

/** Review sessions cover code diffs, documentation, and plans. */
export type ReviewScope = DiffScope | "docs" | "plan";

export interface ReviewSessionRecord {
  readonly reviewSessionId: ReviewSessionId;
  readonly scope: ReviewScope;
  readonly sessionId?: SessionId;
  readonly status: "open" | "closed";
  readonly createdAt: string;
}

export type ReviewCommentAuthor = "user" | "agent-reviewer" | "guard";

export interface ReviewCommentRecord {
  readonly commentId: ReviewCommentId;
  readonly reviewSessionId: ReviewSessionId;
  /** Root-relative file path the thread is anchored to. */
  readonly filePath: string;
  /** 1-based inclusive line range. */
  readonly startLine: number;
  readonly endLine: number;
  readonly body: string;
  readonly author: ReviewCommentAuthor;
  readonly status: ReviewThreadStatus;
  /** Preprocessed doc-review intent; absent on code comments. */
  readonly intent?: string;
  /** Stable plan-block anchor (plan scope); survives line drift across revisions. */
  readonly blockId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DiffBaselineStore {
  insertBaseline(record: DiffBaselineRecord, snapshots: readonly FileBaselineSnapshot[]): Promise<void>;
  getBaseline(baselineId: BaselineId): Promise<DiffBaselineRecord | null>;
  /** Newest-first baselines for a session, or workspace-scope when sessionId is omitted. */
  listBaselines(sessionId?: SessionId): Promise<DiffBaselineRecord[]>;
  listFileSnapshots(baselineId: BaselineId): Promise<FileBaselineSnapshot[]>;
  /** Inserts or replaces the per-file baseline row (accept-one-file). */
  replaceFileSnapshot(baselineId: BaselineId, snapshot: FileBaselineSnapshot): Promise<void>;
  deleteFileSnapshot(baselineId: BaselineId, path: string): Promise<void>;
  /** Removes the baseline record and all its file snapshots (blobs are shared and stay). */
  deleteBaseline(baselineId: BaselineId): Promise<void>;
}

export interface ReviewStore {
  insertReviewSession(record: ReviewSessionRecord): Promise<void>;
  getReviewSession(reviewSessionId: ReviewSessionId): Promise<ReviewSessionRecord | null>;
  /** The open review session for a scope/session pair, if one exists. */
  findOpenReviewSession(scope: ReviewScope, sessionId?: SessionId): Promise<ReviewSessionRecord | null>;
  insertComment(record: ReviewCommentRecord): Promise<void>;
  getComment(commentId: ReviewCommentId): Promise<ReviewCommentRecord | null>;
  updateCommentStatus(commentId: ReviewCommentId, status: ReviewThreadStatus, updatedAt: string): Promise<void>;
  listComments(reviewSessionId: ReviewSessionId): Promise<ReviewCommentRecord[]>;
}

/** Content-addressed blob storage used for baseline revert support. */
export interface BlobStore {
  /** Hashes and stores the file; returns its digest and size. */
  putFile(absolutePath: string): Promise<{ readonly sha256: string; readonly size: number }>;
  /** Hashes and stores an already-bounded in-memory snapshot. */
  putBytes(bytes: Uint8Array): Promise<{ readonly sha256: string; readonly size: number }>;
  readBlob(sha256: string): Promise<Uint8Array | null>;
  hasBlob(sha256: string): Promise<boolean>;
}
