/**
 * Unit tests for MemoryService: capture with dedupe, approve/reject state
 * machine (incl. double-resolve rejection), and the approved-contents
 * briefing projection over an in-memory store.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { RandomIdGenerator, type Clock } from "@drydock/core";
import type {
  MemoryCandidateEdits,
  MemoryCandidateId,
  MemoryCandidateRecord,
  MemoryCandidateStatus,
  MemoryCandidateStore
} from "@drydock/contracts";
import { MemoryService } from "./memoryService.js";

test("captureCandidates inserts pending records and dedupes on trimmed content", async () => {
  const store = new MemoryMemoryStore();
  const service = new MemoryService(options(store));

  const first = await service.captureCandidates("session-1", [{ content: "run the linter" }, { content: "  prefer async fs  " }]);
  assert.equal(first.length, 2);
  assert.equal(first[0]?.status, "pending");
  // Trimmed content is stored verbatim.
  assert.equal(first[1]?.content, "prefer async fs");

  // A re-emitted note (matching a stored candidate of ANY status) is skipped,
  // as is a duplicate within the same batch.
  const second = await service.captureCandidates("session-1", [{ content: "run the linter" }, { content: "new note" }, { content: "new note" }]);
  assert.deepEqual(second.map((record) => record.content), ["new note"]);
  assert.equal((await service.listCandidates("pending")).length, 3);
});

test("resolve approves/rejects once and lists approved contents newest-first", async () => {
  const store = new MemoryMemoryStore();
  const service = new MemoryService(options(store));
  const created = await service.captureCandidates("session-1", [{ content: "first" }, { content: "second" }, { content: "third" }]);
  const [first, second, third] = created;

  const approvedFirst = await service.resolve(first!.memoryCandidateId, true);
  assert.equal(approvedFirst.status, "approved");
  assert.ok(approvedFirst.resolvedAt);

  await service.resolve(third!.memoryCandidateId, true);
  await service.resolve(second!.memoryCandidateId, false);

  // Double-resolve is rejected.
  await assert.rejects(() => service.resolve(first!.memoryCandidateId, false), /already approved/);
  // Unknown id is rejected.
  await assert.rejects(() => service.resolve("memory-missing", true), /was not found/);

  // Only approved contents, newest-first, capped by the limit.
  const contents = await service.listApprovedContents(10);
  assert.deepEqual(contents, ["third", "first"]);
  assert.deepEqual(await service.listApprovedContents(1), ["third"]);
});

test("getCandidate fetches by id and returns null when unknown", async () => {
  const store = new MemoryMemoryStore();
  const service = new MemoryService(options(store));
  const [created] = await service.captureCandidates("session-1", [{ content: "run the linter" }]);

  const found = await service.getCandidate(created!.memoryCandidateId);
  assert.deepEqual(found, created);
  assert.equal(await service.getCandidate("memory-missing"), null);
});

function options(store: MemoryCandidateStore): {
  ids: RandomIdGenerator;
  clock: Clock;
  store: MemoryCandidateStore;
} {
  return { ids: new RandomIdGenerator(), clock: countingClock(), store };
}

/** Distinct, monotonically increasing timestamps so newest-first is testable. */
function countingClock(): Clock {
  let tick = 0;
  return {
    now: () => new Date("2026-07-03T00:00:00.000Z"),
    isoNow: () => {
      tick += 1;
      return `2026-07-03T00:00:${String(tick).padStart(2, "0")}.000Z`;
    }
  };
}

class MemoryMemoryStore implements MemoryCandidateStore {
  private readonly candidates: MemoryCandidateRecord[] = [];

  insertCandidate(record: MemoryCandidateRecord): Promise<void> {
    this.candidates.push(record);
    return Promise.resolve();
  }

  getCandidate(memoryCandidateId: MemoryCandidateId): Promise<MemoryCandidateRecord | null> {
    return Promise.resolve(this.candidates.find((record) => record.memoryCandidateId === memoryCandidateId) ?? null);
  }

  listCandidates(status?: MemoryCandidateStatus): Promise<MemoryCandidateRecord[]> {
    const filtered = status === undefined ? this.candidates : this.candidates.filter((record) => record.status === status);
    // Newest created first, mirroring the SQLite store.
    return Promise.resolve([...filtered].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
  }

  updateCandidateStatus(memoryCandidateId: MemoryCandidateId, status: MemoryCandidateStatus, resolvedAt: string): Promise<void> {
    const index = this.candidates.findIndex((record) => record.memoryCandidateId === memoryCandidateId);
    const existing = this.candidates[index];
    if (existing !== undefined) {
      this.candidates[index] = { ...existing, status, resolvedAt };
    }
    return Promise.resolve();
  }

  updateCandidateContent(memoryCandidateId: MemoryCandidateId, edits: MemoryCandidateEdits): Promise<void> {
    const index = this.candidates.findIndex((record) => record.memoryCandidateId === memoryCandidateId);
    const existing = this.candidates[index];
    if (existing !== undefined) {
      this.candidates[index] = {
        ...existing,
        content: edits.content ?? existing.content,
        ...(edits.scope === undefined ? {} : { scope: edits.scope }),
        ...(edits.tags === undefined ? {} : { tags: edits.tags })
      };
    }
    return Promise.resolve();
  }

  deleteCandidate(memoryCandidateId: MemoryCandidateId): Promise<void> {
    const index = this.candidates.findIndex((record) => record.memoryCandidateId === memoryCandidateId);
    if (index !== -1) this.candidates.splice(index, 1);
    return Promise.resolve();
  }
}
