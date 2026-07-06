/**
 * In-memory Stage 4 store fakes shared by core unit tests.
 */

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type {
  BaselineId,
  BlobStore,
  DiffBaselineRecord,
  DiffBaselineStore,
  DiffScope,
  FileBaselineSnapshot,
  ReviewCommentId,
  ReviewCommentRecord,
  ReviewSessionId,
  ReviewSessionRecord,
  ReviewStore,
  ReviewThreadStatus,
  SessionId
} from "@drydock/contracts";

export class MemoryDiffBaselineStore implements DiffBaselineStore {
  private readonly baselines = new Map<BaselineId, DiffBaselineRecord>();
  private readonly snapshots = new Map<BaselineId, Map<string, FileBaselineSnapshot>>();

  insertBaseline(record: DiffBaselineRecord, snapshots: readonly FileBaselineSnapshot[]): Promise<void> {
    this.baselines.set(record.baselineId, record);
    this.snapshots.set(record.baselineId, new Map(snapshots.map((snapshot) => [snapshot.path, snapshot])));
    return Promise.resolve();
  }

  getBaseline(baselineId: BaselineId): Promise<DiffBaselineRecord | null> {
    return Promise.resolve(this.baselines.get(baselineId) ?? null);
  }

  listBaselines(sessionId?: SessionId): Promise<DiffBaselineRecord[]> {
    const all = [...this.baselines.values()].reverse();
    return Promise.resolve(all.filter((baseline) =>
      sessionId === undefined ? baseline.sessionId === undefined : baseline.sessionId === sessionId
    ));
  }

  listFileSnapshots(baselineId: BaselineId): Promise<FileBaselineSnapshot[]> {
    return Promise.resolve([...(this.snapshots.get(baselineId)?.values() ?? [])]);
  }

  replaceFileSnapshot(baselineId: BaselineId, snapshot: FileBaselineSnapshot): Promise<void> {
    this.snapshots.get(baselineId)?.set(snapshot.path, snapshot);
    return Promise.resolve();
  }

  deleteFileSnapshot(baselineId: BaselineId, path: string): Promise<void> {
    this.snapshots.get(baselineId)?.delete(path);
    return Promise.resolve();
  }
}

/** File-content-in-memory blob store; digests match the production store. */
export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();

  async putFile(absolutePath: string): Promise<{ readonly sha256: string; readonly size: number }> {
    const content = await readFile(absolutePath);
    const sha256 = createHash("sha256").update(content).digest("hex");
    this.blobs.set(sha256, content);
    return { sha256, size: content.byteLength };
  }

  readBlob(sha256: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.blobs.get(sha256) ?? null);
  }

  hasBlob(sha256: string): Promise<boolean> {
    return Promise.resolve(this.blobs.has(sha256));
  }
}

export class MemoryReviewStore implements ReviewStore {
  private readonly sessions = new Map<ReviewSessionId, ReviewSessionRecord>();
  private readonly comments = new Map<ReviewCommentId, ReviewCommentRecord>();

  insertReviewSession(record: ReviewSessionRecord): Promise<void> {
    this.sessions.set(record.reviewSessionId, record);
    return Promise.resolve();
  }

  getReviewSession(reviewSessionId: ReviewSessionId): Promise<ReviewSessionRecord | null> {
    return Promise.resolve(this.sessions.get(reviewSessionId) ?? null);
  }

  findOpenReviewSession(scope: DiffScope, sessionId?: SessionId): Promise<ReviewSessionRecord | null> {
    const match = [...this.sessions.values()].find((session) =>
      session.scope === scope && session.sessionId === sessionId && session.status === "open"
    );
    return Promise.resolve(match ?? null);
  }

  insertComment(record: ReviewCommentRecord): Promise<void> {
    this.comments.set(record.commentId, record);
    return Promise.resolve();
  }

  getComment(commentId: ReviewCommentId): Promise<ReviewCommentRecord | null> {
    return Promise.resolve(this.comments.get(commentId) ?? null);
  }

  updateCommentStatus(commentId: ReviewCommentId, status: ReviewThreadStatus, updatedAt: string): Promise<void> {
    const current = this.comments.get(commentId);
    if (current !== undefined) {
      this.comments.set(commentId, { ...current, status, updatedAt });
    }
    return Promise.resolve();
  }

  listComments(reviewSessionId: ReviewSessionId): Promise<ReviewCommentRecord[]> {
    return Promise.resolve([...this.comments.values()].filter((comment) => comment.reviewSessionId === reviewSessionId));
  }
}
