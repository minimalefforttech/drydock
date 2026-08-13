/**
 * Unit tests for the SQLite MCP registry store's deleteServer (T3.8): the
 * normal path removes both the server row and its override rows, and a
 * forced mid-sequence failure rolls back rather than leaving either behind.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { asId } from "@drydock/contracts";
import type { McpOverride, McpServerRecord } from "@drydock/contracts";
import { applyMigrations } from "./migrations.js";
import { SqliteMcpServerStore } from "./mcpServerStore.js";
import { SqliteConnection } from "./sqliteConnection.js";

test("deleteServer removes the server row and its override rows together", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "mcp-delete.sqlite");
  const connection = new SqliteConnection(dbPath);
  try {
    applyMigrations(connection);
    const store = new SqliteMcpServerStore(connection);

    await store.upsertServer(server("server-1"));
    await store.setOverride(override("server-1"));

    await store.deleteServer(asId<"McpServerId">("server-1"));

    assert.equal(await store.getServer(asId<"McpServerId">("server-1")), null);
    assert.deepEqual(await store.listOverrides("workspace-set", "set-1"), []);
  } finally {
    // Close before rm: Windows refuses to unlink an open database file.
    connection.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("T3.8: deleteServer rolls back when the second delete throws mid-sequence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "mcp-delete-txn.sqlite");
  const connection = new SqliteConnection(dbPath);
  try {
    applyMigrations(connection);
    const store = new SqliteMcpServerStore(connection);
    await store.upsertServer(server("server-1"));
    await store.setOverride(override("server-1"));

    // deleteServer's two DELETEs have no natural constraint to violate (mcp_
    // overrides.server_id carries no FK), so the crash this transaction
    // guards against is forced directly: the SECOND prepared statement's
    // run() is made to throw, simulating a mid-sequence failure, and
    // restored immediately after.
    const rawDb = connection.database as unknown as {
      prepare: (sql: string) => { run: (...args: unknown[]) => unknown };
    };
    const realPrepare = rawDb.prepare.bind(rawDb);
    let calls = 0;
    rawDb.prepare = (sql: string) => {
      calls += 1;
      const statement = realPrepare(sql);
      if (calls === 2) {
        statement.run = () => {
          throw new Error("forced failure");
        };
      }
      return statement;
    };
    try {
      await assert.rejects(() => store.deleteServer(asId<"McpServerId">("server-1")), /forced failure/);
    } finally {
      rawDb.prepare = realPrepare;
    }

    // Rolled back: the first delete (the server row) did not survive on its own.
    assert.notEqual(await store.getServer(asId<"McpServerId">("server-1")), null);
    assert.deepEqual(await store.listOverrides("workspace-set", "set-1"), [
      { scope: "workspace-set", refId: "set-1", serverId: "server-1", state: "on" }
    ]);
  } finally {
    connection.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function server(serverId: string): McpServerRecord {
  return {
    serverId: asId<"McpServerId">(serverId),
    name: `Server ${serverId}`,
    command: "node",
    args: ["server.js"],
    env: {},
    enabledByDefault: true,
    sensitive: false,
    source: "registry",
    createdAt: "2026-07-02T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z"
  };
}

function override(serverId: string): McpOverride {
  return {
    scope: "workspace-set",
    refId: "set-1",
    serverId: asId<"McpServerId">(serverId),
    state: "on"
  };
}
