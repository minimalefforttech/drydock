/**
 * SQLite-backed Stage 4 diff baseline and review stores.
 *
 * Baselines carry their per-file snapshots in diff_baseline_files; review
 * comments are durable threads keyed to file paths and line ranges. Diff
 * computation, accept/revert, and thread-state policy live in core services.
 */

import type {
  BaselineId,
  DiffBaselineRecord,
  DiffBaselineStore,
  DiffScope,
  FileBaselineSnapshot,
  ReviewCommentId,
  ReviewCommentRecord,
  ReviewScope,
  ReviewSessionId,
  ReviewSessionRecord,
  ReviewStore,
  ReviewThreadStatus,
  SessionId
} from "@drydock/contracts";
import type { SqliteConnection } from "./sqliteConnection.js";

// MARK: Diff baselines

export class SqliteDiffBaselineStore implements DiffBaselineStore {
  constructor(private readonly connection: SqliteConnection) {}

  /**
   * Inserts the baseline row and its per-file snapshots in one transaction
   * (T3.8): a throw partway through the snapshot loop (e.g. a duplicate path
   * violating the (baseline_id, path) primary key) leaves neither the
   * baseline row nor any of its snapshot rows behind, instead of a baseline
   * with a partial/missing file list.
   */
  async insertBaseline(record: DiffBaselineRecord, snapshots: readonly FileBaselineSnapshot[]): Promise<void> {
    const db = this.connection.database;
    db.exec("BEGIN");
    try {
      db.prepare(`
        INSERT INTO diff_baselines (baseline_id, scope, session_id, root_path, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(record.baselineId, record.scope, record.sessionId ?? null, record.rootPath, record.createdAt);
      const insertFile = db.prepare(`
        INSERT INTO diff_baseline_files (baseline_id, path, sha256, size, mtime_ms, captured_at_ms, blob_stored)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const snapshot of snapshots) {
        insertFile.run(record.baselineId, snapshot.path, snapshot.sha256, snapshot.size, snapshot.mtimeMs, snapshot.capturedAtMs, snapshot.blobStored ? 1 : 0);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  async getBaseline(baselineId: BaselineId): Promise<DiffBaselineRecord | null> {
    const row = this.connection.database.prepare(
      "SELECT * FROM diff_baselines WHERE baseline_id = ?"
    ).get(baselineId) as BaselineRow | undefined;
    return row ? mapBaseline(row) : null;
  }

  async listBaselines(sessionId?: SessionId): Promise<DiffBaselineRecord[]> {
    const rows = (sessionId === undefined
      ? this.connection.database.prepare(
          "SELECT * FROM diff_baselines WHERE session_id IS NULL ORDER BY created_at DESC, rowid DESC"
        ).all()
      : this.connection.database.prepare(
          "SELECT * FROM diff_baselines WHERE session_id = ? ORDER BY created_at DESC, rowid DESC"
        ).all(sessionId)
    ) as unknown as BaselineRow[];
    return rows.map(mapBaseline);
  }

  async listFileSnapshots(baselineId: BaselineId): Promise<FileBaselineSnapshot[]> {
    const rows = this.connection.database.prepare(
      "SELECT * FROM diff_baseline_files WHERE baseline_id = ? ORDER BY path"
    ).all(baselineId) as unknown as SnapshotRow[];
    return rows.map(mapSnapshot);
  }

  async replaceFileSnapshot(baselineId: BaselineId, snapshot: FileBaselineSnapshot): Promise<void> {
    this.connection.database.prepare(`
      INSERT OR REPLACE INTO diff_baseline_files (baseline_id, path, sha256, size, mtime_ms, captured_at_ms, blob_stored)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(baselineId, snapshot.path, snapshot.sha256, snapshot.size, snapshot.mtimeMs, snapshot.capturedAtMs, snapshot.blobStored ? 1 : 0);
  }

  async deleteFileSnapshot(baselineId: BaselineId, path: string): Promise<void> {
    this.connection.database.prepare(
      "DELETE FROM diff_baseline_files WHERE baseline_id = ? AND path = ?"
    ).run(baselineId, path);
  }

  /** Deletes the baseline's file rows and its own row in one transaction (T3.8). */
  async deleteBaseline(baselineId: BaselineId): Promise<void> {
    const db = this.connection.database;
    db.exec("BEGIN");
    try {
      db.prepare(
        "DELETE FROM diff_baseline_files WHERE baseline_id = ?"
      ).run(baselineId);
      db.prepare(
        "DELETE FROM diff_baselines WHERE baseline_id = ?"
      ).run(baselineId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

interface BaselineRow {
  readonly baseline_id: string;
  readonly scope: DiffScope;
  readonly session_id: string | null;
  readonly root_path: string;
  readonly created_at: string;
}

function mapBaseline(row: BaselineRow): DiffBaselineRecord {
  return {
    baselineId: row.baseline_id as BaselineId,
    scope: row.scope,
    ...(row.session_id === null ? {} : { sessionId: row.session_id as SessionId }),
    rootPath: row.root_path,
    createdAt: row.created_at
  };
}

interface SnapshotRow {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mtime_ms: number;
  readonly captured_at_ms: number;
  readonly blob_stored: number;
}

function mapSnapshot(row: SnapshotRow): FileBaselineSnapshot {
  return {
    path: row.path,
    sha256: row.sha256,
    size: row.size,
    mtimeMs: row.mtime_ms,
    capturedAtMs: row.captured_at_ms,
    blobStored: row.blob_stored === 1
  };
}

// MARK: Review sessions and comments

export class SqliteReviewStore implements ReviewStore {
  constructor(private readonly connection: SqliteConnection) {}

  async insertReviewSession(record: ReviewSessionRecord): Promise<void> {
    this.connection.database.prepare(`
      INSERT INTO review_sessions (review_session_id, scope, session_id, status, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(record.reviewSessionId, record.scope, record.sessionId ?? null, record.status, record.createdAt);
  }

  async getReviewSession(reviewSessionId: ReviewSessionId): Promise<ReviewSessionRecord | null> {
    const row = this.connection.database.prepare(
      "SELECT * FROM review_sessions WHERE review_session_id = ?"
    ).get(reviewSessionId) as ReviewSessionRow | undefined;
    return row ? mapReviewSession(row) : null;
  }

  async findOpenReviewSession(scope: ReviewScope, sessionId?: SessionId): Promise<ReviewSessionRecord | null> {
    const row = (sessionId === undefined
      ? this.connection.database.prepare(
          "SELECT * FROM review_sessions WHERE scope = ? AND session_id IS NULL AND status = 'open' ORDER BY rowid DESC"
        ).get(scope)
      : this.connection.database.prepare(
          "SELECT * FROM review_sessions WHERE scope = ? AND session_id = ? AND status = 'open' ORDER BY rowid DESC"
        ).get(scope, sessionId)
    ) as ReviewSessionRow | undefined;
    return row ? mapReviewSession(row) : null;
  }

  async insertComment(record: ReviewCommentRecord): Promise<void> {
    this.connection.database.prepare(`
      INSERT INTO review_comments (comment_id, review_session_id, file_path, start_line, end_line, body, author, status, intent, block_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.commentId,
      record.reviewSessionId,
      record.filePath,
      record.startLine,
      record.endLine,
      record.body,
      record.author,
      record.status,
      record.intent ?? null,
      record.blockId ?? null,
      record.createdAt,
      record.updatedAt
    );
  }

  async getComment(commentId: ReviewCommentId): Promise<ReviewCommentRecord | null> {
    const row = this.connection.database.prepare(
      "SELECT * FROM review_comments WHERE comment_id = ?"
    ).get(commentId) as CommentRow | undefined;
    return row ? mapComment(row) : null;
  }

  async updateCommentStatus(commentId: ReviewCommentId, status: ReviewThreadStatus, updatedAt: string): Promise<void> {
    this.connection.database.prepare(
      "UPDATE review_comments SET status = ?, updated_at = ? WHERE comment_id = ?"
    ).run(status, updatedAt, commentId);
  }

  async listComments(reviewSessionId: ReviewSessionId): Promise<ReviewCommentRecord[]> {
    const rows = this.connection.database.prepare(
      "SELECT * FROM review_comments WHERE review_session_id = ? ORDER BY created_at, rowid"
    ).all(reviewSessionId) as unknown as CommentRow[];
    return rows.map(mapComment);
  }
}

interface ReviewSessionRow {
  readonly review_session_id: string;
  readonly scope: ReviewScope;
  readonly session_id: string | null;
  readonly status: ReviewSessionRecord["status"];
  readonly created_at: string;
}

function mapReviewSession(row: ReviewSessionRow): ReviewSessionRecord {
  return {
    reviewSessionId: row.review_session_id as ReviewSessionId,
    scope: row.scope,
    ...(row.session_id === null ? {} : { sessionId: row.session_id as SessionId }),
    status: row.status,
    createdAt: row.created_at
  };
}

interface CommentRow {
  readonly comment_id: string;
  readonly review_session_id: string;
  readonly file_path: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly body: string;
  readonly author: ReviewCommentRecord["author"];
  readonly status: ReviewThreadStatus;
  readonly intent: string | null;
  readonly block_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function mapComment(row: CommentRow): ReviewCommentRecord {
  return {
    commentId: row.comment_id as ReviewCommentId,
    reviewSessionId: row.review_session_id as ReviewSessionId,
    filePath: row.file_path,
    startLine: row.start_line,
    endLine: row.end_line,
    body: row.body,
    author: row.author,
    status: row.status,
    ...(row.intent === null ? {} : { intent: row.intent }),
    ...(row.block_id === null ? {} : { blockId: row.block_id }),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
