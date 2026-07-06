/**
 * Unit tests for Stage 4 review thread lifecycle and transitions.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { asId } from "@drydock/contracts";
import type { Clock } from "./clock.js";
import { CodeReviewService } from "./codeReviewService.js";
import { RandomIdGenerator } from "./ids.js";
import { MemoryReviewStore } from "./testSupport/memoryDiffStores.js";

test("review sessions are reused per scope and comments anchor to file lines", async () => {
  const service = makeService();
  const sessionId = asId<"SessionId">("session-test");
  const review = await service.ensureReviewSession("current-session", sessionId);
  const again = await service.ensureReviewSession("current-session", sessionId);
  const workspaceReview = await service.ensureReviewSession("workspace");

  assert.equal(review.reviewSessionId, again.reviewSessionId);
  assert.notEqual(review.reviewSessionId, workspaceReview.reviewSessionId);

  const comment = await service.addComment({
    reviewSessionId: review.reviewSessionId,
    filePath: "src\\index.ts",
    startLine: 10,
    endLine: 12,
    body: "This mount check needs a test.",
    author: "user"
  });
  assert.equal(comment.filePath, "src/index.ts");
  assert.equal(comment.status, "open");

  await assert.rejects(service.addComment({
    reviewSessionId: review.reviewSessionId,
    filePath: "src/index.ts",
    startLine: 9,
    endLine: 3,
    body: "bad range",
    author: "user"
  }), /line range/);
  await assert.rejects(service.addComment({
    reviewSessionId: review.reviewSessionId,
    filePath: "src/index.ts",
    startLine: 1,
    endLine: 1,
    body: "   ",
    author: "user"
  }), /body/);

  const listed = await service.listComments(review.reviewSessionId);
  assert.equal(listed.length, 1);
});

test("terminal thread states can only be reopened", async () => {
  const service = makeService();
  const review = await service.ensureReviewSession("workspace");
  const comment = await service.addComment({
    reviewSessionId: review.reviewSessionId,
    filePath: "a.ts",
    startLine: 1,
    endLine: 1,
    body: "thread",
    author: "user"
  });

  const acknowledged = await service.setCommentStatus(comment.commentId, "acknowledged");
  assert.equal(acknowledged.status, "acknowledged");
  const resolved = await service.setCommentStatus(comment.commentId, "resolved");
  assert.equal(resolved.status, "resolved");

  await assert.rejects(service.setCommentStatus(comment.commentId, "delegated"), /reopen/);
  const reopened = await service.setCommentStatus(comment.commentId, "open");
  assert.equal(reopened.status, "open");
  const wontFix = await service.setCommentStatus(comment.commentId, "wont-fix");
  assert.equal(wontFix.status, "wont-fix");
});

function makeService(): CodeReviewService {
  return new CodeReviewService({
    ids: new RandomIdGenerator(),
    clock: fixedClock(),
    store: new MemoryReviewStore()
  });
}

function fixedClock(): Clock {
  return {
    now: () => new Date("2026-07-02T00:00:00.000Z"),
    isoNow: () => "2026-07-02T00:00:00.000Z"
  };
}
