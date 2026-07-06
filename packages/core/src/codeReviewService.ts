/**
 * Code review service.
 *
 * Review sessions attach durable file/line comment threads to a diff scope
 * (current session or workspace). Threads move through open, acknowledged,
 * delegated, blocked, resolved, and wont-fix; terminal states can only be
 * reopened, never silently rewritten.
 */

import type {
  ReviewCommentAuthor,
  ReviewCommentId,
  ReviewCommentRecord,
  ReviewScope,
  ReviewSessionRecord,
  ReviewStore,
  ReviewThreadStatus,
  SessionId
} from "@drydock/contracts";
import type { Clock } from "./clock.js";
import type { IdGenerator } from "./ids.js";

const TERMINAL_STATUSES: readonly ReviewThreadStatus[] = ["resolved", "wont-fix"];

export interface CodeReviewServiceOptions {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly store: ReviewStore;
}

export class CodeReviewService {
  constructor(private readonly options: CodeReviewServiceOptions) {}

  /** Returns the open review session for the scope, creating one on demand. */
  async ensureReviewSession(scope: ReviewScope, sessionId?: SessionId): Promise<ReviewSessionRecord> {
    const existing = await this.options.store.findOpenReviewSession(scope, sessionId);
    if (existing !== null) {
      return existing;
    }
    const record: ReviewSessionRecord = {
      reviewSessionId: this.options.ids.reviewSessionId(),
      scope,
      ...(sessionId === undefined ? {} : { sessionId }),
      status: "open",
      createdAt: this.options.clock.isoNow()
    };
    await this.options.store.insertReviewSession(record);
    return record;
  }

  async addComment(input: {
    readonly reviewSessionId: ReviewSessionRecord["reviewSessionId"];
    readonly filePath: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly body: string;
    readonly author: ReviewCommentAuthor;
    /** Preprocessed doc-review intent. */
    readonly intent?: string;
    /** Stable plan-block anchor (plan scope). */
    readonly blockId?: string;
  }): Promise<ReviewCommentRecord> {
    if (input.body.trim() === "") {
      throw new Error("Review comments must have a body.");
    }
    if (!Number.isInteger(input.startLine) || !Number.isInteger(input.endLine) || input.startLine < 1 || input.startLine > input.endLine) {
      throw new Error(`Invalid line range ${String(input.startLine)}-${String(input.endLine)}: lines are 1-based and start must not exceed end.`);
    }
    const review = await this.options.store.getReviewSession(input.reviewSessionId);
    if (review === null || review.status !== "open") {
      throw new Error(`Review session ${input.reviewSessionId} is not open.`);
    }
    const now = this.options.clock.isoNow();
    const record: ReviewCommentRecord = {
      commentId: this.options.ids.reviewCommentId(),
      reviewSessionId: input.reviewSessionId,
      filePath: input.filePath.replace(/\\/g, "/"),
      startLine: input.startLine,
      endLine: input.endLine,
      body: input.body,
      author: input.author,
      status: "open",
      ...(input.intent === undefined ? {} : { intent: input.intent }),
      ...(input.blockId === undefined ? {} : { blockId: input.blockId }),
      createdAt: now,
      updatedAt: now
    };
    await this.options.store.insertComment(record);
    return record;
  }

  /** Moves a thread; terminal threads (resolved, wont-fix) can only reopen. */
  async setCommentStatus(commentId: ReviewCommentId, status: ReviewThreadStatus): Promise<ReviewCommentRecord> {
    const comment = await this.options.store.getComment(commentId);
    if (comment === null) {
      throw new Error(`Review comment ${commentId} was not found.`);
    }
    if (comment.status === status) {
      return comment;
    }
    if (TERMINAL_STATUSES.includes(comment.status) && status !== "open") {
      throw new Error(`Thread ${commentId} is ${comment.status}; reopen it before moving to ${status}.`);
    }
    const updatedAt = this.options.clock.isoNow();
    await this.options.store.updateCommentStatus(commentId, status, updatedAt);
    return { ...comment, status, updatedAt };
  }

  listComments(reviewSessionId: ReviewSessionRecord["reviewSessionId"]): Promise<ReviewCommentRecord[]> {
    return this.options.store.listComments(reviewSessionId);
  }
}
