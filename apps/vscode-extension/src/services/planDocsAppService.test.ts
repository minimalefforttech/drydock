/**
 * Unit tests for plan-doc collection and comment composition: collection bounds
 * (file cap + byte cap), revision bumps only on content change, deleted-file
 * retention, and the compose+delegate flow over the `plan:` comment convention.
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  asId,
  PLAN_DOC_MAX_BYTES,
  PLAN_DOC_MAX_FILES,
  type SessionId
} from "@drydock/contracts";
import {
  ChatSessionService,
  CodeReviewService,
  MemoryLogger,
  ProductEventBus,
  RandomIdGenerator,
  SystemClock,
  type ProductBusEvent
} from "@drydock/core";
import { applyMigrations, SqlitePlanDocStore, SqliteConnection, SqliteReviewStore } from "@drydock/storage-sqlite";
import { PlanDocsAppService } from "./planDocsAppService.js";

interface Harness {
  readonly service: PlanDocsAppService;
  readonly review: CodeReviewService;
  readonly workspacePath: string;
  readonly planDir: string;
  readonly busEvents: ProductBusEvent[];
  close(): void;
  cleanup(): Promise<void>;
}

async function makeHarness(sessionId = "session-1"): Promise<Harness> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-plandocs-"));
  const workspacePath = path.join(dir, "workspace");
  const planDir = path.join(workspacePath, "plan");
  await mkdir(planDir, { recursive: true });

  const connection = new SqliteConnection(path.join(dir, "plan-docs.sqlite"));
  applyMigrations(connection);
  const clock = new SystemClock();
  const ids = new RandomIdGenerator();
  const review = new CodeReviewService({ ids, clock, store: new SqliteReviewStore(connection) });
  const bus = new ProductEventBus();
  const busEvents: ProductBusEvent[] = [];
  bus.subscribe((event) => busEvents.push(event));

  // The app service only needs getSessionWorkspacePath off the chat service.
  const chatService = {
    getSessionWorkspacePath: (id: SessionId): string | null => (id === sessionId ? workspacePath : null)
  } as unknown as ChatSessionService;

  const service = new PlanDocsAppService({
    logger: new MemoryLogger(),
    clock,
    store: new SqlitePlanDocStore(connection),
    chatService,
    bus,
    review
  });
  return {
    service,
    review,
    workspacePath,
    planDir,
    busEvents,
    close: () => connection.close(),
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

test("collectPlanDocs bumps revision only when content changes and retains deleted files", async () => {
  const harness = await makeHarness();
  try {
    await writeFile(path.join(harness.planDir, "overview.md"), "# Plan\nfirst");
    await mkdir(path.join(harness.planDir, "diagrams"), { recursive: true });
    await writeFile(path.join(harness.planDir, "diagrams", "flow.mmd"), "graph TD; A-->B");

    const first = await harness.service.collectPlanDocs("session-1");
    // Ordered by name; forward-slashed nested path; formats detected by extension.
    assert.deepEqual(first.map((doc) => doc.name), ["diagrams/flow.mmd", "overview.md"]);
    assert.equal(first.find((doc) => doc.name === "overview.md")?.revision, 1);
    assert.equal(first.find((doc) => doc.name === "diagrams/flow.mmd")?.format, "mermaid");
    assert.equal(harness.busEvents.filter((e) => e.kind === "plan-docs-updated").length, 1);

    // Re-collect with no changes: no revision bump, no new publish.
    const unchanged = await harness.service.collectPlanDocs("session-1");
    assert.equal(unchanged.find((doc) => doc.name === "overview.md")?.revision, 1);
    assert.equal(harness.busEvents.filter((e) => e.kind === "plan-docs-updated").length, 1);

    // Change one file, delete the other: the changed row bumps, and the deleted
    // file's row is retained (partial writes must not destroy review state).
    await writeFile(path.join(harness.planDir, "overview.md"), "# Plan\nsecond");
    await rm(path.join(harness.planDir, "diagrams", "flow.mmd"));
    const after = await harness.service.collectPlanDocs("session-1");
    assert.deepEqual(after.map((doc) => doc.name), ["diagrams/flow.mmd", "overview.md"]);
    assert.equal(after.find((doc) => doc.name === "overview.md")?.revision, 2);
    assert.equal(after.find((doc) => doc.name === "diagrams/flow.mmd")?.revision, 1);
    assert.equal(harness.busEvents.filter((e) => e.kind === "plan-docs-updated").length, 2);
  } finally {
    harness.close();
    await harness.cleanup();
  }
});

test("collectPlanDocs enforces the file-count and byte caps and returns [] off-session", async () => {
  const harness = await makeHarness();
  try {
    // One file over the byte cap is skipped; a small sibling is kept.
    await writeFile(path.join(harness.planDir, "small.md"), "ok");
    await writeFile(path.join(harness.planDir, "big.md"), "x".repeat(PLAN_DOC_MAX_BYTES + 1));
    // More than the file cap of non-oversized markdown files.
    for (let i = 0; i < PLAN_DOC_MAX_FILES + 5; i += 1) {
      await writeFile(path.join(harness.planDir, `doc-${String(i).padStart(3, "0")}.md`), `d${String(i)}`);
    }

    const docs = await harness.service.collectPlanDocs("session-1");
    // Alphabetical order wins the count cap (applied before the size filter):
    // "big.md" sorts first and occupies a cap slot, then is dropped for size, so
    // 20 candidates yield 19 accepted rows and "big.md" never lands. "small.md"
    // sorts last and falls outside the 20-file window entirely.
    assert.equal(docs.some((doc) => doc.name === "big.md"), false);
    assert.equal(docs.length, PLAN_DOC_MAX_FILES - 1);
    assert.equal(docs.some((doc) => doc.name === "small.md"), false);
    // Everything kept is a capped, in-bounds doc file.
    assert.equal(docs.every((doc) => doc.name.startsWith("doc-")), true);

    // A session with no live workspace collects nothing.
    assert.deepEqual(await harness.service.collectPlanDocs("session-unknown"), []);
  } finally {
    harness.close();
    await harness.cleanup();
  }
});

test("collectPlanDocs on a missing plan directory returns []", async () => {
  const harness = await makeHarness();
  try {
    await rm(harness.planDir, { recursive: true, force: true });
    assert.deepEqual(await harness.service.collectPlanDocs("session-1"), []);
    assert.equal(harness.busEvents.filter((e) => e.kind === "plan-docs-updated").length, 0);
  } finally {
    harness.close();
    await harness.cleanup();
  }
});

test("composeCommentTurn builds a prompt, delegates open plan comments, and ignores the rest", async () => {
  const harness = await makeHarness();
  try {
    const sessionId = asId<"SessionId">("session-1");
    const review = await harness.review.ensureReviewSession("current-session", sessionId);
    // Two open plan comments, one already resolved, one non-plan comment.
    const c1 = await harness.review.addComment({
      reviewSessionId: review.reviewSessionId,
      filePath: "plan:overview.md",
      startLine: 2,
      endLine: 2,
      body: "Tighten the scope.",
      author: "user"
    });
    await harness.review.addComment({
      reviewSessionId: review.reviewSessionId,
      filePath: "plan:diagrams/flow.mmd",
      startLine: 5,
      endLine: 5,
      body: "Wrong arrow direction.",
      author: "user"
    });
    const resolved = await harness.review.addComment({
      reviewSessionId: review.reviewSessionId,
      filePath: "plan:overview.md",
      startLine: 9,
      endLine: 9,
      body: "Already handled.",
      author: "user"
    });
    await harness.review.setCommentStatus(resolved.commentId, "resolved");
    await harness.review.addComment({
      reviewSessionId: review.reviewSessionId,
      filePath: "src/index.ts",
      startLine: 1,
      endLine: 1,
      body: "Not a plan comment.",
      author: "user"
    });

    const composed = await harness.service.composeCommentTurn("session-1");
    assert.notEqual(composed, null);
    assert.equal(composed?.count, 2);
    assert.match(composed?.prompt ?? "", /Reviewer comments on your plan documents/);
    assert.match(composed?.prompt ?? "", /- overview\.md \(block 2\): Tighten the scope\./);
    assert.match(composed?.prompt ?? "", /- diagrams\/flow\.mmd \(block 5\): Wrong arrow direction\./);

    // The included comments are now delegated, so a second compose finds nothing.
    const again = await harness.service.composeCommentTurn("session-1");
    assert.equal(again, null);
    assert.equal(
      (await harness.review.listComments(review.reviewSessionId)).find((c) => c.commentId === c1.commentId)?.status,
      "delegated"
    );
  } finally {
    harness.close();
    await harness.cleanup();
  }
});
