/**
 * Unit tests for SQLite plan-document persistence: upsert-by-(session,name),
 * name-ordered listing, per-session delete count, and reopen durability.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { asId } from "@drydock/contracts";
import type { PlanDocRecord } from "@drydock/contracts";
import { applyMigrations } from "./migrations.js";
import { SqlitePlanDocStore } from "./planDocStore.js";
import { SqliteConnection } from "./sqliteConnection.js";

test("plan docs upsert by (session, name), list ordered, and survive a reopen", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "plan-docs.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const store = new SqlitePlanDocStore(connection);

    await store.upsertDoc(doc("session-1", "b/second.md", "markdown", "b1", 1));
    await store.upsertDoc(doc("session-1", "a/first.md", "markdown", "a1", 1));
    // Re-collecting the same name replaces the row (INSERT OR REPLACE); the app
    // service owns revision numbering, so a bumped revision is written verbatim.
    await store.upsertDoc(doc("session-1", "a/first.md", "markdown", "a2", 2));
    // A different session is isolated.
    await store.upsertDoc(doc("session-2", "other.mmd", "mermaid", "graph", 1));
    connection.close();

    const reopened = new SqliteConnection(dbPath);
    applyMigrations(reopened);
    const reopenedStore = new SqlitePlanDocStore(reopened);
    const docs = await reopenedStore.listDocs(asId<"SessionId">("session-1"));
    const single = await reopenedStore.getDoc(asId<"SessionId">("session-1"), "a/first.md");
    const other = await reopenedStore.listDocs(asId<"SessionId">("session-2"));
    reopened.close();

    // Ordered by name, one row per name, with the replaced revision + content.
    assert.deepEqual(docs.map((record) => record.name), ["a/first.md", "b/second.md"]);
    assert.equal(single?.revision, 2);
    assert.equal(single?.content, "a2");
    assert.equal(other.length, 1);
    assert.equal(other[0]?.format, "mermaid");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleteSessionDocs returns the removed count and only touches its session", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "plan-docs-delete.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const store = new SqlitePlanDocStore(connection);

    await store.upsertDoc(doc("session-1", "one.md", "markdown", "1", 1));
    await store.upsertDoc(doc("session-1", "two.md", "markdown", "2", 1));
    await store.upsertDoc(doc("session-2", "keep.md", "markdown", "k", 1));

    const removed = await store.deleteSessionDocs(asId<"SessionId">("session-1"));
    assert.equal(removed, 2);
    assert.equal((await store.listDocs(asId<"SessionId">("session-1"))).length, 0);
    // The other session is untouched.
    assert.equal((await store.listDocs(asId<"SessionId">("session-2"))).length, 1);
    // A second delete removes nothing.
    assert.equal(await store.deleteSessionDocs(asId<"SessionId">("session-1")), 0);
    connection.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function doc(sessionId: string, name: string, format: PlanDocRecord["format"], content: string, revision: number): PlanDocRecord {
  return {
    sessionId: asId<"SessionId">(sessionId),
    name,
    format,
    content,
    revision,
    collectedAt: "2026-07-04T00:00:00.000Z"
  };
}
