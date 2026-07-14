import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { asId } from "@drydock/contracts";
import { applyMigrations } from "./migrations.js";
import { SECURITY_METADATA_MAX_STRING_CHARS } from "./persistenceSanitizer.js";
import { SqliteSecurityEventStore } from "./securityEventStore.js";
import { SqliteConnection } from "./sqliteConnection.js";

test("security evidence is append-only, ordered, resumable, and content-free", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-security-events-"));
  const dbPath = path.join(dir, "state.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const store = new SqliteSecurityEventStore(connection);
    const first = await store.appendSecurityEvent({
      occurredAt: "2026-07-14T03:04:05.000Z",
      eventCode: "policy.project.allowed",
      outcome: "allowed",
      actorId: "user-1",
      hostId: "workstation-7",
      policyId: "policy-v3",
      sessionId: asId<"SessionId">("session-1"),
      runtimeId: asId<"RuntimeId">("runtime-1"),
      projectId: asId<"ProjectId">("project-1"),
      metadata: {
        status: "x".repeat(1_000),
        runId: "run-1",
        command: ["tool", "protected-file.mov"],
        prompt: "protected production content",
        nested: {
          apiKey: "secret-value",
          note: "Authorization: Bearer token-from-log",
          raw: { frame: "transport content" }
        },
        largeFact: "x".repeat(1_000)
      }
    });
    const second = await store.appendSecurityEvent({
      occurredAt: "2026-07-14T03:04:06.000Z",
      eventCode: "runtime.start.succeeded",
      outcome: "succeeded",
      hostId: "workstation-7"
    });
    assert.ok(second > first);

    const firstPage = await store.listSecurityEvents(undefined, 1);
    assert.deepEqual(firstPage.map((event) => event.sequence), [first]);
    const tail = await store.listSecurityEvents(first);
    assert.deepEqual(tail.map((event) => event.sequence), [second]);

    const record = firstPage[0];
    assert.ok(record);
    assert.equal("prompt" in record.metadata, false);
    assert.equal("command" in record.metadata, false);
    assert.equal("nested" in record.metadata, false);
    assert.equal("largeFact" in record.metadata, false);
    assert.equal(record.metadata["runId"], "run-1");
    assert.equal((record.metadata["status"] as string).length, SECURITY_METADATA_MAX_STRING_CHARS);
    connection.close();

    const reopened = new SqliteConnection(dbPath);
    applyMigrations(reopened);
    const exported = await new SqliteSecurityEventStore(reopened).exportSecurityEvents();
    const exportedRows = exported.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(exportedRows.length, 2);
    assert.doesNotMatch(exported, /protected production content|secret-value|token-from-log|transport content/);
    assert.deepEqual(exportedRows.map((row) => row["sequence"]), [first, second]);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("security evidence rejects unstable codes and non-UTC timestamps", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-security-events-invalid-"));
  const connection = new SqliteConnection(path.join(dir, "state.sqlite"));
  try {
    applyMigrations(connection);
    const store = new SqliteSecurityEventStore(connection);
    await assert.rejects(
      store.appendSecurityEvent({
        occurredAt: "2026-07-14T15:04:05+12:00",
        eventCode: "policy.project.allowed",
        outcome: "allowed"
      }),
      /canonical UTC ISO timestamp/
    );
    await assert.rejects(
      store.appendSecurityEvent({
        occurredAt: "2026-07-14T03:04:05.000Z",
        eventCode: "Free form code",
        outcome: "allowed"
      }),
      /lowercase dot-separated identifier/
    );
    assert.equal((await store.listSecurityEvents()).length, 0);
  } finally {
    connection.close();
    await rm(dir, { recursive: true, force: true });
  }
});
