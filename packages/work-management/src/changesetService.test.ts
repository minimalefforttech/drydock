/**
 * ChangesetService unit tests (ADR 0014): capture replaces a subtask's prior
 * set (latest wins, empty clears), seeding reads only unlanded rows in
 * upstream order and fails loudly on a missing blob, and landing narrows by
 * session (and optionally repo).
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { asId } from "@drydock/contracts";
import type { SessionId, SubtaskId, TaskChangesetRecord, TaskChangesetStore } from "@drydock/contracts";
import { MemoryLogger, ProductEventBus } from "@drydock/core";
import { ChangesetService, type ChangesetBlobPort } from "./changesetService.js";

class FakeChangesetStore implements TaskChangesetStore {
  rows: TaskChangesetRecord[] = [];

  async replaceForSubtask(subtaskId: SubtaskId, records: readonly TaskChangesetRecord[]): Promise<void> {
    this.rows = [...this.rows.filter((row) => row.subtaskId !== subtaskId), ...records];
  }

  async listForSubtasks(subtaskIds: readonly SubtaskId[]): Promise<TaskChangesetRecord[]> {
    const wanted = new Set<string>(subtaskIds);
    return this.rows.filter((row) => wanted.has(row.subtaskId));
  }

  async listUnlandedSubtaskIds(subtaskIds: readonly SubtaskId[]): Promise<SubtaskId[]> {
    const wanted = new Set<string>(subtaskIds);
    return [...new Set(this.rows.filter((row) => wanted.has(row.subtaskId) && row.landedAt === undefined).map((row) => row.subtaskId))];
  }

  async listUnlanded(): Promise<TaskChangesetRecord[]> {
    return this.rows.filter((row) => row.landedAt === undefined);
  }

  async markLandedBySession(sessionId: SessionId, landedAt: string, repoName?: string): Promise<number> {
    let changed = 0;
    this.rows = this.rows.map((row) => {
      if (row.sessionId !== sessionId || row.landedAt !== undefined) return row;
      if (repoName !== undefined && row.repoName !== repoName) return row;
      changed += 1;
      return { ...row, landedAt };
    });
    return changed;
  }

  async deleteForSubtask(subtaskId: SubtaskId): Promise<number> {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => row.subtaskId !== subtaskId);
    return before - this.rows.length;
  }
}

class FakeBlobs implements ChangesetBlobPort {
  readonly byId = new Map<string, string>();
  private counter = 0;

  async putText(text: string): Promise<{ sha256: string; bytes: number }> {
    this.counter += 1;
    const sha256 = `sha-${String(this.counter)}`;
    this.byId.set(sha256, text);
    return { sha256, bytes: Buffer.byteLength(text, "utf8") };
  }

  async readText(sha256: string): Promise<string | null> {
    return this.byId.get(sha256) ?? null;
  }
}

function harness(): { service: ChangesetService; store: FakeChangesetStore; blobs: FakeBlobs; bus: ProductEventBus } {
  const store = new FakeChangesetStore();
  const blobs = new FakeBlobs();
  const bus = new ProductEventBus();
  let ids = 0;
  const service = new ChangesetService({
    store,
    blobs,
    clock: { isoNow: () => "2026-07-12T00:00:00.000Z", now: () => new Date("2026-07-12T00:00:00.000Z") },
    logger: new MemoryLogger(),
    bus,
    changesetId: () => {
      ids += 1;
      return `changeset-${String(ids)}`;
    }
  });
  return { service, store, blobs, bus };
}

const CAPTURE = {
  taskId: "task-1",
  subtaskId: "sub-up",
  sessionId: "session-1"
};

test("capture stores one row per repo, skips empty patches, and replaces the prior set", async () => {
  const { service, store, blobs } = harness();

  const first = await service.captureForSubtask({
    ...CAPTURE,
    patches: [
      { repoName: "api", patch: "diff-api-v1", fileCount: 2 },
      { repoName: "web", patch: "", fileCount: 0 } // empty → skipped
    ]
  });
  assert.equal(first.length, 1);
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0]?.repoName, "api");
  assert.equal(await blobs.readText(store.rows[0]?.patchSha256 ?? ""), "diff-api-v1");

  // Latest wins: a re-capture replaces the whole set.
  await service.captureForSubtask({
    ...CAPTURE,
    patches: [{ repoName: "api", patch: "diff-api-v2", fileCount: 1 }]
  });
  assert.equal(store.rows.length, 1);
  assert.equal(await blobs.readText(store.rows[0]?.patchSha256 ?? ""), "diff-api-v2");

  // Empty capture clears - a re-done subtask with no changes stops seeding.
  await service.captureForSubtask({ ...CAPTURE, patches: [] });
  assert.equal(store.rows.length, 0);
});

test("seedPatchesFor returns unlanded patches in upstream order and skips landed rows", async () => {
  const { service } = harness();
  await service.captureForSubtask({
    taskId: "task-1",
    subtaskId: "sub-b",
    sessionId: "session-b",
    patches: [{ repoName: "api", patch: "patch-b", fileCount: 1 }]
  });
  await service.captureForSubtask({
    taskId: "task-1",
    subtaskId: "sub-a",
    sessionId: "session-a",
    patches: [{ repoName: "api", patch: "patch-a", fileCount: 1 }]
  });

  // Upstream order (a before b) wins over capture order (b was captured first).
  const seeds = await service.seedPatchesFor(["sub-a", "sub-b"]);
  assert.deepEqual(seeds.map((seed) => seed.patch), ["patch-a", "patch-b"]);
  assert.deepEqual(seeds.map((seed) => seed.label), ["sub-a/api", "sub-b/api"]);

  // Landing sub-a's session removes it from the seeding view.
  await service.markLandedBySession("session-a");
  const remaining = await service.seedPatchesFor(["sub-a", "sub-b"]);
  assert.deepEqual(remaining.map((seed) => seed.patch), ["patch-b"]);
});

test("a missing patch blob fails seeding loudly instead of silently seeding less", async () => {
  const { service, store } = harness();
  await service.captureForSubtask({
    ...CAPTURE,
    patches: [{ repoName: "api", patch: "diff", fileCount: 1 }]
  });
  // Simulate a pruned blob store: the row survives, the bytes are gone.
  store.rows = store.rows.map((row) => ({ ...row, patchSha256: "sha-vanished" }));

  await assert.rejects(service.seedPatchesFor(["sub-up"]), /missing its patch blob/);
});

test("landing narrows by session and repo, flags unlanded ids, and publishes board-changed", async () => {
  const { service, bus } = harness();
  const events: string[] = [];
  bus.subscribe((event) => {
    events.push(event.kind);
  });

  await service.captureForSubtask({
    ...CAPTURE,
    patches: [
      { repoName: "api", patch: "diff-api", fileCount: 1 },
      { repoName: "web", patch: "diff-web", fileCount: 1 }
    ]
  });
  assert.deepEqual([...await service.unlandedSubtaskIds(["sub-up", "sub-other"])], ["sub-up"]);

  // Repo-scoped pull lands only that repo's row.
  assert.equal(await service.markLandedBySession("session-1", "api"), 1);
  assert.equal((await service.unlandedSubtaskIds(["sub-up"])).size, 1);

  // Full pull lands the rest; the unlanded flag clears.
  assert.equal(await service.markLandedBySession("session-1"), 1);
  assert.equal((await service.unlandedSubtaskIds(["sub-up"])).size, 0);

  // Wrong session lands nothing (idempotent bookkeeping).
  assert.equal(await service.markLandedBySession(asId<"SessionId">("session-x") as string), 0);
  assert.ok(events.filter((kind) => kind === "board-changed").length >= 3);
});
