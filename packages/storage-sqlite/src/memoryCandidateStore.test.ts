/**
 * Unit tests for SQLite memory-candidate persistence: insert, newest-first
 * listing (all and by status), and status resolution with resolvedAt.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { asId } from "@drydock/contracts";
import type { MemoryCandidateRecord } from "@drydock/contracts";
import { SqliteMemoryCandidateStore } from "./memoryCandidateStore.js";
import { applyMigrations } from "./migrations.js";
import { SqliteConnection } from "./sqliteConnection.js";

test("memory candidates insert, list newest-first, and resolve status", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "memory-candidates.sqlite");
  const connection = new SqliteConnection(dbPath);
  try {
    applyMigrations(connection);
    const store = new SqliteMemoryCandidateStore(connection);

    await store.insertCandidate(candidate("memory-1", "always run the linter", "2026-07-03T00:00:00.000Z"));
    await store.insertCandidate(candidate("memory-2", "prefer async fs", "2026-07-03T00:00:01.000Z"));
    await store.updateCandidateStatus(asId<"MemoryCandidateId">("memory-1"), "approved", "2026-07-03T00:00:05.000Z");
    connection.close();

    const reopened = new SqliteConnection(dbPath);
    applyMigrations(reopened);
    const reopenedStore = new SqliteMemoryCandidateStore(reopened);
    const all = await reopenedStore.listCandidates();
    const approved = await reopenedStore.listCandidates("approved");
    const pending = await reopenedStore.listCandidates("pending");
    const one = await reopenedStore.getCandidate(asId<"MemoryCandidateId">("memory-1"));
    reopened.close();

    // Newest created first.
    assert.deepEqual(all.map((record) => record.memoryCandidateId), ["memory-2", "memory-1"]);
    assert.deepEqual(approved.map((record) => record.memoryCandidateId), ["memory-1"]);
    assert.deepEqual(pending.map((record) => record.memoryCandidateId), ["memory-2"]);
    assert.equal(one?.status, "approved");
    assert.equal(one?.resolvedAt, "2026-07-03T00:00:05.000Z");
  } finally {
    connection.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("T3.9: insertCandidateIfNoPendingDuplicate dedupes only against PENDING rows", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "memory-candidates.sqlite");
  const connection = new SqliteConnection(dbPath);
  try {
    applyMigrations(connection);
    const store = new SqliteMemoryCandidateStore(connection);

    const firstInsert = await store.insertCandidateIfNoPendingDuplicate(
      candidate("memory-1", "run the linter", "2026-07-03T00:00:00.000Z")
    );
    assert.equal(firstInsert, true);

    // A second PENDING row with the identical content is skipped, not inserted.
    const duplicateInsert = await store.insertCandidateIfNoPendingDuplicate(
      candidate("memory-2", "run the linter", "2026-07-03T00:00:01.000Z")
    );
    assert.equal(duplicateInsert, false);
    assert.equal((await store.listCandidates()).length, 1);

    // Once the original is resolved, it is no longer PENDING, so the same
    // content is free to be proposed again (matches the PENDING-only scope
    // T3.9 asks for; the broader any-status dedupe is MemoryService's job).
    await store.updateCandidateStatus(asId<"MemoryCandidateId">("memory-1"), "approved", "2026-07-03T00:00:02.000Z");
    const afterResolve = await store.insertCandidateIfNoPendingDuplicate(
      candidate("memory-3", "run the linter", "2026-07-03T00:00:03.000Z")
    );
    assert.equal(afterResolve, true);
    assert.deepEqual((await store.listCandidates("pending")).map((record) => record.memoryCandidateId), ["memory-3"]);
  } finally {
    connection.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("T3.9: updateCandidateStatus is a compare-and-swap on status='pending'", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "memory-candidates.sqlite");
  const connection = new SqliteConnection(dbPath);
  try {
    applyMigrations(connection);
    const store = new SqliteMemoryCandidateStore(connection);
    await store.insertCandidate(candidate("memory-1", "run the linter", "2026-07-03T00:00:00.000Z"));

    const firstApply = await store.updateCandidateStatus(asId<"MemoryCandidateId">("memory-1"), "approved", "2026-07-03T00:00:01.000Z");
    assert.equal(firstApply, true);

    // A second call (simulating a losing concurrent resolve) is a no-op: it
    // reports false and does not overwrite the already-applied status/time.
    const secondApply = await store.updateCandidateStatus(asId<"MemoryCandidateId">("memory-1"), "rejected", "2026-07-03T00:00:02.000Z");
    assert.equal(secondApply, false);

    const row = await store.getCandidate(asId<"MemoryCandidateId">("memory-1"));
    assert.equal(row?.status, "approved");
    assert.equal(row?.resolvedAt, "2026-07-03T00:00:01.000Z");

    // An unknown id is also reported as not-applied rather than throwing.
    const unknown = await store.updateCandidateStatus(asId<"MemoryCandidateId">("memory-missing"), "approved", "2026-07-03T00:00:03.000Z");
    assert.equal(unknown, false);
  } finally {
    connection.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function candidate(memoryCandidateId: string, content: string, createdAt: string): MemoryCandidateRecord {
  return {
    memoryCandidateId: asId<"MemoryCandidateId">(memoryCandidateId),
    sessionId: asId<"SessionId">("session-1"),
    content,
    status: "pending",
    createdAt
  };
}
