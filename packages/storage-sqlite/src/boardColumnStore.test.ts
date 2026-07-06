/**
 * Unit tests for SQLite board-column persistence: seeded defaults after
 * migration, insert/update/delete, and ordering by sortOrder.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { asId } from "@drydock/contracts";
import type { BoardColumnRecord } from "@drydock/contracts";
import { SqliteBoardColumnStore } from "./boardColumnStore.js";
import { applyMigrations } from "./migrations.js";
import { SqliteConnection } from "./sqliteConnection.js";

test("migration seeds the six default board columns in category order", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "board-columns.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const store = new SqliteBoardColumnStore(connection);

    const columns = await store.listColumns();
    connection.close();

    assert.deepEqual(columns.map((column) => column.columnId), [
      "col-backlog",
      "col-todo",
      "col-blocked",
      "col-in-progress",
      "col-review",
      "col-finished"
    ]);
    assert.deepEqual(columns.map((column) => column.category), [
      "backlog",
      "pending",
      "pending",
      "in-progress",
      "done",
      "done"
    ]);
    assert.deepEqual(columns.map((column) => column.name), [
      "Backlog",
      "ToDo",
      "Blocked",
      "In Progress",
      "Review",
      "Finished"
    ]);

    // Re-running migrations against the same DB must not duplicate the seed.
    const reopened = new SqliteConnection(dbPath);
    applyMigrations(reopened);
    const reopenedStore = new SqliteBoardColumnStore(reopened);
    const columnsAfterReopen = await reopenedStore.listColumns();
    reopened.close();
    assert.equal(columnsAfterReopen.length, 6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("board columns insert, update, and delete", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "board-columns-crud.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const store = new SqliteBoardColumnStore(connection);

    const custom: BoardColumnRecord = {
      columnId: asId<"ColumnId">("col-custom"),
      name: "Design Review",
      category: "pending",
      sortOrder: 10
    };
    await store.insertColumn(custom);
    assert.deepEqual(await store.getColumn(custom.columnId), custom);

    await store.updateColumn(custom.columnId, { name: "Design QA", sortOrder: 11 });
    const updated = await store.getColumn(custom.columnId);
    assert.equal(updated?.name, "Design QA");
    assert.equal(updated?.sortOrder, 11);
    assert.equal(updated?.category, "pending");

    await store.deleteColumn(custom.columnId);
    assert.equal(await store.getColumn(custom.columnId), null);
    connection.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
