/**
 * SQLite stage-handoff store tests (plan D4): upsert-latest-wins per
 * producing subtask, caller-ordered listing, delete, and durability across
 * a reopen.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { asId } from "@drydock/contracts";
import { applyMigrations } from "./migrations.js";
import { SqliteConnection } from "./sqliteConnection.js";
import { SqliteSubtaskHandoffStore } from "./subtaskHandoffStore.js";

test("handoff notes upsert (latest wins), list in caller order, and survive a reopen", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "handoffs.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const store = new SqliteSubtaskHandoffStore(connection);

    await store.upsertHandoff({
      subtaskId: asId<"SubtaskId">("stage-1"),
      taskId: asId<"TaskId">("task-1"),
      note: "draft",
      source: "summary",
      createdAt: "2026-07-24T00:00:00.000Z"
    });
    // Latest completion replaces the note (and can upgrade the source).
    await store.upsertHandoff({
      subtaskId: asId<"SubtaskId">("stage-1"),
      taskId: asId<"TaskId">("task-1"),
      note: "guard added; wiring remains",
      source: "agent",
      createdAt: "2026-07-24T01:00:00.000Z"
    });
    await store.upsertHandoff({
      subtaskId: asId<"SubtaskId">("stage-2"),
      taskId: asId<"TaskId">("task-1"),
      note: "wiring done",
      source: "agent",
      createdAt: "2026-07-24T02:00:00.000Z"
    });
    connection.close();

    const reopened = new SqliteConnection(dbPath);
    applyMigrations(reopened);
    const reopenedStore = new SqliteSubtaskHandoffStore(reopened);

    const one = await reopenedStore.getHandoff(asId<"SubtaskId">("stage-1"));
    assert.equal(one?.note, "guard added; wiring remains");
    assert.equal(one?.source, "agent");

    // Caller order preserved (upstream edge order matters to briefings);
    // unknown ids are skipped, never invented.
    const listed = await reopenedStore.listForSubtasks([
      asId<"SubtaskId">("stage-2"),
      asId<"SubtaskId">("ghost"),
      asId<"SubtaskId">("stage-1")
    ]);
    assert.deepEqual(listed.map((row) => row.subtaskId), ["stage-2", "stage-1"]);

    assert.equal(await reopenedStore.deleteForSubtask(asId<"SubtaskId">("stage-1")), 1);
    assert.equal(await reopenedStore.getHandoff(asId<"SubtaskId">("stage-1")), null);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
