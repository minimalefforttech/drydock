/**
 * Unit tests for the SQLite app-state key/value store: set/get, overwrite,
 * delete, and durability across a reopened connection.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteAppStateStore } from "./appStateStore.js";
import { applyMigrations } from "./migrations.js";
import { SqliteConnection } from "./sqliteConnection.js";

test("app state round-trips set, overwrite, delete, and survives reopen", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "app-state.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const store = new SqliteAppStateStore(connection);

    assert.equal(store.getAppState("activeTaskId"), null);
    store.setAppState("activeTaskId", "task-1");
    assert.equal(store.getAppState("activeTaskId"), "task-1");

    // Upsert replaces the value rather than inserting a second row.
    store.setAppState("activeTaskId", "task-2");
    assert.equal(store.getAppState("activeTaskId"), "task-2");
    const count = connection.database.prepare(`SELECT COUNT(*) AS count FROM app_state`).get() as { readonly count: number };
    assert.equal(count.count, 1);
    connection.close();

    // A reopened connection reads the persisted value (window reload).
    const reopened = new SqliteConnection(dbPath);
    applyMigrations(reopened);
    const reopenedStore = new SqliteAppStateStore(reopened);
    assert.equal(reopenedStore.getAppState("activeTaskId"), "task-2");

    reopenedStore.deleteAppState("activeTaskId");
    assert.equal(reopenedStore.getAppState("activeTaskId"), null);
    // Deleting a missing key is a no-op, not an error.
    reopenedStore.deleteAppState("activeTaskId");
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
