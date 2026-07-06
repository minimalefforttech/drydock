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
  try {
    const connection = new SqliteConnection(dbPath);
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
