import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { asId } from "@drydock/contracts";
import type { JsonObject, StoredEvent } from "@drydock/contracts";
import { SqliteEventStore } from "./eventStore.js";
import { applyMigrations } from "./migrations.js";
import { PERSISTED_OUTPUT_MAX_CHARS } from "./persistenceSanitizer.js";
import { SqliteConnection } from "./sqliteConnection.js";

test("event persistence removes transport frames, redacts credentials, and caps only output", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-event-hardening-"));
  const connection = new SqliteConnection(path.join(dir, "state.sqlite"));
  try {
    applyMigrations(connection);
    const normalText = "normal replay text ".repeat(1_200);
    const longOutput = `Bearer secret-token ${"x".repeat(PERSISTED_OUTPUT_MAX_CHARS)}`;
    const payload: JsonObject = {
      text: normalText,
      output: longOutput,
      raw: { fullTransportFrame: "must not persist" },
      nested: {
        safe: "kept",
        apiKey: "super-secret",
        rawFrame: { payload: "must not persist" },
        children: [{ raw: "must not persist" }, { authorization: "Bearer nested-secret" }]
      },
      note: [
        "api_key=visible-in-log",
        "{\"x-api-key\": \"quoted-secret\"}",
        "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
        "AKIA1234567890ABCDEF"
      ].join("\n")
    };
    const event: StoredEvent = {
      id: asId<"EventId">("event-hardening"),
      sessionId: asId<"SessionId">("session-hardening"),
      eventType: "agent.tool_call",
      createdAt: "2026-07-14T03:04:05.000Z",
      payload
    };

    await new SqliteEventStore(connection).appendStoredEvent(event);
    const stored = (await new SqliteEventStore(connection).listEvents(event.sessionId))[0];
    assert.ok(stored);
    assert.equal(stored.payload["text"], normalText, "ordinary transcript text must not be capped");
    const output = stored.payload["output"];
    assert.ok(typeof output === "string");
    assert.equal(output.length, PERSISTED_OUTPUT_MAX_CHARS);
    assert.match(output, /^Bearer \[REDACTED\]/);
    assert.match(output, /\[truncated by storage\]$/);
    assert.equal("raw" in stored.payload, false);

    const nested = stored.payload["nested"] as JsonObject;
    assert.equal(nested["safe"], "kept");
    assert.equal(nested["apiKey"], "[REDACTED]");
    assert.equal("rawFrame" in nested, false);
    const children = nested["children"] as JsonObject[];
    assert.equal("raw" in (children[0] ?? {}), false);
    assert.equal(children[1]?.["authorization"], "[REDACTED]");

    const note = stored.payload["note"];
    assert.ok(typeof note === "string");
    assert.doesNotMatch(note, /visible-in-log|quoted-secret|private-material|AKIA1234567890ABCDEF/);
    assert.match(note, /api_key=\[REDACTED\]/);
    assert.match(note, /\[REDACTED PRIVATE KEY\]/);
    assert.equal("raw" in payload, true, "the persistence boundary must not mutate its caller");
  } finally {
    connection.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("migrations sanitize event payloads written by older releases", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-event-migration-"));
  const connection = new SqliteConnection(path.join(dir, "state.sqlite"));
  try {
    connection.database.exec(`
      CREATE TABLE session_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT,
        event_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      )
    `);
    connection.database.prepare(`
      INSERT INTO session_events (id, session_id, event_type, created_at, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      "legacy-event",
      "legacy-session",
      "agent.tool_call",
      "2026-01-01T00:00:00.000Z",
      JSON.stringify({ rawFrame: { secret: "transport" }, apiKey: "legacy-secret", text: "kept" })
    );

    applyMigrations(connection);
    const row = connection.database.prepare(`
      SELECT payload_json FROM session_events WHERE id = ?
    `).get("legacy-event") as { readonly payload_json: string };
    const payload = JSON.parse(row.payload_json) as JsonObject;
    assert.equal("rawFrame" in payload, false);
    assert.equal(payload["apiKey"], "[REDACTED]");
    assert.equal(payload["text"], "kept");

    // Idempotence: a later activation neither reprocesses nor changes the row.
    applyMigrations(connection);
    const after = connection.database.prepare(`
      SELECT payload_json FROM session_events WHERE id = ?
    `).get("legacy-event") as { readonly payload_json: string };
    assert.equal(after.payload_json, row.payload_json);
  } finally {
    connection.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("listEvents degrades a row with corrupt payload_json instead of throwing (T3.7)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-event-corrupt-"));
  const connection = new SqliteConnection(path.join(dir, "state.sqlite"));
  try {
    applyMigrations(connection);
    // Bypass appendStoredEvent (which always writes valid JSON) to simulate a
    // hand-corrupted or partially-written row landing in the column.
    connection.database.prepare(`
      INSERT INTO session_events (id, session_id, run_id, event_type, created_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("corrupt-event", "session-corrupt", null, "agent.text", "2026-08-13T00:00:00.000Z", "{not valid json");

    const eventStore = new SqliteEventStore(connection);
    await eventStore.appendStoredEvent({
      id: asId<"EventId">("event-ok"),
      sessionId: asId<"SessionId">("session-corrupt"),
      eventType: "agent.text",
      createdAt: "2026-08-13T00:00:01.000Z",
      payload: { text: "still loads" }
    });

    // The whole session must still load: the corrupt row degrades to an empty
    // payload instead of throwing out of listEvents' .map() and losing the
    // healthy row that follows it.
    const events = await eventStore.listEvents(asId<"SessionId">("session-corrupt"));
    assert.equal(events.length, 2);
    assert.equal(events[0]?.id, "corrupt-event");
    assert.deepEqual(events[0]?.payload, {});
    assert.equal(events[1]?.id, "event-ok");
    assert.deepEqual(events[1]?.payload, { text: "still loads" });
  } finally {
    connection.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy credential bytes are erased from the database and migration WAL", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-event-erasure-"));
  const databasePath = path.join(dir, "state.sqlite");
  const secret = `legacy-private-value-${"x".repeat(12_000)}`;
  const deletedSecret = `deleted-legacy-private-value-${"y".repeat(12_000)}`;
  const connection = new SqliteConnection(databasePath);
  try {
    connection.database.exec("PRAGMA secure_delete = OFF");
    connection.database.exec(`
      CREATE TABLE session_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT,
        event_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      )
    `);
    connection.database.prepare(`
      INSERT INTO session_events (id, session_id, event_type, created_at, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `).run("legacy-secret", "session", "agent.tool_call", "2026-01-01T00:00:00.000Z", JSON.stringify({ apiKey: secret }));
    connection.database.prepare(`
      INSERT INTO session_events (id, session_id, event_type, created_at, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `).run("deleted-legacy-secret", "session", "agent.tool_call", "2026-01-01T00:00:00.000Z", JSON.stringify({ apiKey: deletedSecret }));
    connection.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    connection.database.prepare("DELETE FROM session_events WHERE id = ?").run("deleted-legacy-secret");
    connection.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    connection.database.exec("PRAGMA secure_delete = ON");
    applyMigrations(connection);
    const needles = [Buffer.from(secret, "utf8"), Buffer.from(deletedSecret, "utf8")];
    const databaseBytes = await readFile(databasePath);
    for (const needle of needles) assert.equal(databaseBytes.includes(needle), false);
    try {
      const walBytes = await readFile(`${databasePath}-wal`);
      for (const needle of needles) assert.equal(walBytes.includes(needle), false);
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error
        && (error as { readonly code?: unknown }).code === "ENOENT")) throw error;
    }
  } finally {
    connection.close();
    await rm(dir, { recursive: true, force: true });
  }
});
