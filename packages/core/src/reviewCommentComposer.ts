/**
 * Reviewer-comment → revision-turn composer (shared).
 *
 * Plan-docs review (Phase 2) and cross-project task review both turn a
 * session's open review comments into one host-authored revision prompt and
 * flip the included comments to "delegated" so they do not resurface on the
 * next compose. The mechanics live here once; callers differ only in which
 * comment anchors belong to their surface (`plan:<doc>` vs code paths) and how
 * a comment renders as a prompt line.
 */

import type { ReviewCommentRecord, SessionId } from "@drydock/contracts";
import type { CodeReviewService } from "./codeReviewService.js";

/** A composed reviewer-comment turn plus how many comments it delegated. */
export interface ComposedCommentTurn {
  readonly prompt: string;
  readonly count: number;
}

export interface ComposeReviewCommentTurnInput {
  readonly review: CodeReviewService;
  readonly sessionId: SessionId;
  /** Which comment anchors belong to the calling surface. */
  readonly anchorFilter: (filePath: string) => boolean;
  /** Instruction line the comment list is appended to. */
  readonly header: string;
  readonly renderLine: (comment: ReviewCommentRecord) => string;
}

/**
 * Composes a revision turn from the session's open comments that match the
 * anchor filter, marking each included comment "delegated". Returns null when
 * nothing is open to send (callers treat that as an accepted no-op). Comments
 * live in the session's `current-session` review scope.
 */
export async function composeReviewCommentTurn(
  input: ComposeReviewCommentTurnInput
): Promise<ComposedCommentTurn | null> {
  const review = await input.review.ensureReviewSession("current-session", input.sessionId);
  const comments = (await input.review.listComments(review.reviewSessionId))
    .filter((comment) => comment.status === "open" && input.anchorFilter(comment.filePath));
  if (comments.length === 0) {
    return null;
  }
  const prompt = `${input.header}\n${comments.map(input.renderLine).join("\n")}`;
  for (const comment of comments) {
    await input.review.setCommentStatus(comment.commentId, "delegated");
  }
  return { prompt, count: comments.length };
}
