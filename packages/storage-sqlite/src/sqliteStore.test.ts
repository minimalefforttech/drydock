/**
 * Unit tests for SQLite runtime inventory and event-store persistence.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { asId } from "@drydock/contracts";
import type { AgentEvent, ChatSessionRecord, RuntimeInventoryRecord, StoredEvent } from "@drydock/contracts";
import { SqliteEventStore } from "./eventStore.js";
import { applyMigrations } from "./migrations.js";
import { SqliteRuntimeInventoryStore } from "./runtimeInventoryStore.js";
import { SqliteChatSessionStore } from "./sessionStore.js";
import { SqliteConnection } from "./sqliteConnection.js";

test("stores runtime inventory and replays events after reopening", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "state.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const inventory = new SqliteRuntimeInventoryStore(connection);
    const eventStore = new SqliteEventStore(connection);
    const record = runtimeRecord();
    await inventory.insertRuntime(record);
    await inventory.updateRuntimeStatus(record.runtimeId, "running", "2026-07-01T00:00:01.000Z");
    await eventStore.appendAgentEvent(agentEvent());
    connection.close();

    const reopened = new SqliteConnection(dbPath);
    applyMigrations(reopened);
    const replayedRuntime = await new SqliteRuntimeInventoryStore(reopened).getRuntime(record.runtimeId);
    const replayedEvents = await new SqliteEventStore(reopened).listEvents(record.sessionId);
    reopened.close();

    assert.equal(replayedRuntime?.status, "running");
    assert.equal(replayedEvents.length, 1);
    assert.equal(replayedEvents[0]?.eventType, "agent.text");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat sessions insert, update, and list newest-first with limit", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "stage2-sessions.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const sessions = new SqliteChatSessionStore(connection);
    await sessions.insertSession(sessionRecord("session-a", "2026-07-01T00:00:00.000Z"));
    // session-b and session-c share updated_at so listing must tie-break by
    // insertion order (rowid DESC), newest insert first.
    await sessions.insertSession(sessionRecord("session-b", "2026-07-01T00:00:01.000Z"));
    await sessions.insertSession(sessionRecord("session-c", "2026-07-01T00:00:01.000Z"));

    const inserted = await sessions.getSession(asId<"SessionId">("session-a"));
    assert.equal(inserted?.status, "starting");
    assert.equal(inserted?.title, "Session session-a");
    assert.equal(inserted !== null && "runtimeId" in inserted, false);
    assert.equal(inserted !== null && "endedAt" in inserted, false);
    assert.equal(await sessions.getSession(asId<"SessionId">("session-missing")), null);

    await sessions.updateSession(asId<"SessionId">("session-a"), {
      status: "ended",
      updatedAt: "2026-07-01T00:00:02.000Z",
      endedAt: "2026-07-01T00:00:02.000Z"
    });

    const updated = await sessions.getSession(asId<"SessionId">("session-a"));
    assert.equal(updated?.status, "ended");
    assert.equal(updated?.endedAt, "2026-07-01T00:00:02.000Z");
    assert.equal(updated?.updatedAt, "2026-07-01T00:00:02.000Z");
    assert.equal(updated?.title, "Session session-a");
    assert.equal(updated?.createdAt, "2026-07-01T00:00:00.000Z");

    const listed = await sessions.listSessions();
    assert.deepEqual(listed.map((session) => session.sessionId), ["session-a", "session-c", "session-b"]);

    const limited = await sessions.listSessions(2);
    assert.deepEqual(limited.map((session) => session.sessionId), ["session-a", "session-c"]);
    connection.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("event appends return durable idempotent sequences and support resume", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "stage2-events.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const eventStore = new SqliteEventStore(connection);
    const sessionId = asId<"SessionId">("session-test");

    const first = await eventStore.appendStoredEvent(storedEvent("event-1", "2026-07-01T00:00:01.000Z"));
    const second = await eventStore.appendStoredEvent(storedEvent("event-2", "2026-07-01T00:00:02.000Z"));
    const third = await eventStore.appendAgentEvent(agentEvent("event-3"));
    assert.ok(first < second && second < third, "sequences must increase");

    // Re-appending the same event id is idempotent: no duplicate row, and the
    // original sequence is returned.
    const replayed = await eventStore.appendStoredEvent(storedEvent("event-1", "2026-07-01T00:00:01.000Z"));
    assert.equal(replayed, first);

    const all = await eventStore.listEvents(sessionId);
    assert.equal(all.length, 3);
    assert.deepEqual(all.map((event) => event.sequence), [first, second, third]);

    const tail = await eventStore.listEvents(sessionId, first);
    assert.deepEqual(tail.map((event) => event.id), ["event-2", "event-3"]);

    const none = await eventStore.listEvents(sessionId, third);
    assert.equal(none.length, 0);
    connection.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat session workspace roots round-trip so a resume re-mounts the project", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "stage2-roots.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const sessions = new SqliteChatSessionStore(connection);
    await sessions.insertSession({
      ...sessionRecord("session-roots", "2026-07-01T00:00:00.000Z"),
      workspaceRoots: ["C:\\proj\\app", "C:\\proj\\shared"],
      readOnlyRoots: ["C:\\proj\\shared"]
    });

    // Reopen to prove the JSON columns persist across a restart.
    connection.close();
    const reopened = new SqliteConnection(dbPath);
    applyMigrations(reopened);
    const stored = await new SqliteChatSessionStore(reopened).getSession(asId<"SessionId">("session-roots"));
    assert.deepEqual(stored?.workspaceRoots, ["C:\\proj\\app", "C:\\proj\\shared"]);
    assert.deepEqual(stored?.readOnlyRoots, ["C:\\proj\\shared"]);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat session description round-trips, clears with null, and delete removes the row", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "stage2-description.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const sessions = new SqliteChatSessionStore(connection);
    await sessions.insertSession({ ...sessionRecord("session-desc", "2026-07-01T00:00:00.000Z"), description: "seed note" });

    const seeded = await sessions.getSession(asId<"SessionId">("session-desc"));
    assert.equal(seeded?.description, "seed note");

    await sessions.updateSession(asId<"SessionId">("session-desc"), {
      description: "edited note",
      updatedAt: "2026-07-01T00:00:01.000Z"
    });
    assert.equal((await sessions.getSession(asId<"SessionId">("session-desc")))?.description, "edited note");

    // null clears the column; the projection then omits the field entirely.
    await sessions.updateSession(asId<"SessionId">("session-desc"), {
      description: null,
      updatedAt: "2026-07-01T00:00:02.000Z"
    });
    const cleared = await sessions.getSession(asId<"SessionId">("session-desc"));
    assert.equal(cleared !== null && "description" in cleared, false);

    await sessions.deleteSession(asId<"SessionId">("session-desc"));
    assert.equal(await sessions.getSession(asId<"SessionId">("session-desc")), null);
    connection.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat session ownership (host instance + heartbeat) round-trips and clears with null", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "stage2-ownership.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const sessions = new SqliteChatSessionStore(connection);

    // Insert stamps ownership as part of the record.
    await sessions.insertSession({
      ...sessionRecord("session-own", "2026-07-01T00:00:00.000Z"),
      hostInstanceId: "host-a",
      heartbeatAt: "2026-07-01T00:00:00.000Z"
    });
    const seeded = await sessions.getSession(asId<"SessionId">("session-own"));
    assert.equal(seeded?.hostInstanceId, "host-a");
    assert.equal(seeded?.heartbeatAt, "2026-07-01T00:00:00.000Z");

    // A heartbeat-only partial update leaves host_instance_id untouched.
    await sessions.updateSession(asId<"SessionId">("session-own"), {
      heartbeatAt: "2026-07-01T00:00:20.000Z",
      updatedAt: "2026-07-01T00:00:20.000Z"
    });
    const beat = await sessions.getSession(asId<"SessionId">("session-own"));
    assert.equal(beat?.hostInstanceId, "host-a");
    assert.equal(beat?.heartbeatAt, "2026-07-01T00:00:20.000Z");

    // null clears both columns; the projection then omits the fields entirely.
    await sessions.updateSession(asId<"SessionId">("session-own"), {
      hostInstanceId: null,
      heartbeatAt: null,
      updatedAt: "2026-07-01T00:00:30.000Z"
    });
    const cleared = await sessions.getSession(asId<"SessionId">("session-own"));
    assert.equal(cleared !== null && "hostInstanceId" in cleared, false);
    assert.equal(cleared !== null && "heartbeatAt" in cleared, false);

    // A session inserted without ownership omits the fields (no accidental "").
    await sessions.insertSession(sessionRecord("session-plain", "2026-07-01T00:00:00.000Z"));
    const plain = await sessions.getSession(asId<"SessionId">("session-plain"));
    assert.equal(plain !== null && "hostInstanceId" in plain, false);
    assert.equal(plain !== null && "heartbeatAt" in plain, false);
    connection.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleteSessionEvents removes only the target session's events", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "stage2-delete-events.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const eventStore = new SqliteEventStore(connection);
    const target = asId<"SessionId">("session-target");
    const other = asId<"SessionId">("session-other");
    await eventStore.appendStoredEvent({ ...storedEvent("evt-a", "2026-07-01T00:00:01.000Z"), sessionId: target });
    await eventStore.appendStoredEvent({ ...storedEvent("evt-b", "2026-07-01T00:00:02.000Z"), sessionId: target });
    await eventStore.appendStoredEvent({ ...storedEvent("evt-c", "2026-07-01T00:00:03.000Z"), sessionId: other });

    const deleted = await eventStore.deleteSessionEvents(target);
    assert.equal(deleted, 2);
    assert.equal((await eventStore.listEvents(target)).length, 0);
    assert.equal((await eventStore.listEvents(other)).length, 1);
    connection.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("purgeRuntimes deletes only terminal rows past their retention window", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "purge.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const inventory = new SqliteRuntimeInventoryStore(connection);
    const now = "2026-07-10T00:00:00.000Z";
    const dayMs = 24 * 60 * 60 * 1000;

    // removed 2 days ago → past the 24h window; removed 1h ago → retained.
    await inventory.insertRuntime({ ...runtimeRecord(), runtimeId: asId<"RuntimeId">("rt-removed-old") });
    await inventory.updateRuntimeStatus(asId<"RuntimeId">("rt-removed-old"), "removed", "2026-07-08T00:00:00.000Z");
    await inventory.insertRuntime({ ...runtimeRecord(), runtimeId: asId<"RuntimeId">("rt-removed-fresh") });
    await inventory.updateRuntimeStatus(asId<"RuntimeId">("rt-removed-fresh"), "removed", "2026-07-09T23:00:00.000Z");
    // lost 10 days ago → past the 7d window; lost 2 days ago → retained.
    await inventory.insertRuntime({ ...runtimeRecord(), runtimeId: asId<"RuntimeId">("rt-lost-old") });
    await inventory.updateRuntimeStatus(asId<"RuntimeId">("rt-lost-old"), "lost", "2026-06-30T00:00:00.000Z");
    await inventory.insertRuntime({ ...runtimeRecord(), runtimeId: asId<"RuntimeId">("rt-lost-fresh") });
    await inventory.updateRuntimeStatus(asId<"RuntimeId">("rt-lost-fresh"), "lost", "2026-07-08T00:00:00.000Z");
    // running rows are never purged regardless of age.
    await inventory.insertRuntime({ ...runtimeRecord(), runtimeId: asId<"RuntimeId">("rt-running"), startedAt: "2026-01-01T00:00:00.000Z" });
    await inventory.updateRuntimeStatus(asId<"RuntimeId">("rt-running"), "running", "2026-01-01T00:00:00.000Z");

    const purged = await inventory.purgeRuntimes({ now, removedOlderThanMs: dayMs, lostOlderThanMs: 7 * dayMs });
    assert.equal(purged, 2);
    const remaining = new Set((await inventory.listRuntimes()).map((runtime) => runtime.runtimeId));
    assert.deepEqual(
      [...remaining].sort(),
      ["rt-lost-fresh", "rt-removed-fresh", "rt-running"]
    );
    connection.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("updateRuntimeMetadata shallow-merges patches and stamps last_seen_at", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "stage2-metadata.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const inventory = new SqliteRuntimeInventoryStore(connection);
    const record = runtimeRecord();
    await inventory.insertRuntime(record);

    await inventory.updateRuntimeMetadata(record.runtimeId, { externalPid: 42 }, "2026-07-01T00:00:05.000Z");
    const merged = await inventory.getRuntime(record.runtimeId);
    assert.deepEqual(merged?.metadata, { workspacePath: "C:\\tmp\\workspace", externalPid: 42 });
    assert.equal(merged?.lastSeenAt, "2026-07-01T00:00:05.000Z");

    await inventory.updateRuntimeMetadata(record.runtimeId, { workspacePath: "D:\\moved" }, "2026-07-01T00:00:06.000Z");
    const overwritten = await inventory.getRuntime(record.runtimeId);
    assert.deepEqual(overwritten?.metadata, { workspacePath: "D:\\moved", externalPid: 42 });
    assert.equal(overwritten?.lastSeenAt, "2026-07-01T00:00:06.000Z");

    // Unknown runtimes are a silent no-op.
    await inventory.updateRuntimeMetadata(asId<"RuntimeId">("runtime-missing"), { ignored: true }, "2026-07-01T00:00:07.000Z");
    connection.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function runtimeRecord(): RuntimeInventoryRecord {
  return {
    runtimeId: asId<"RuntimeId">("runtime-test"),
    runtimeGenerationId: asId<"RuntimeGenerationId">("generation-test"),
    sessionId: asId<"SessionId">("session-test"),
    chatId: asId<"ChatId">("chat-test"),
    agentRole: "worker",
    templateId: "isolated-run",
    adapter: "docker-sandbox",
    externalName: "drydock-test",
    status: "starting",
    startedAt: "2026-07-01T00:00:00.000Z",
    cleanupFailureCount: 0,
    metadata: { workspacePath: "C:\\tmp\\workspace" }
  };
}

function agentEvent(id = "event-test"): AgentEvent {
  return {
    id: asId<"EventId">(id),
    type: "agent.text",
    sessionId: asId<"SessionId">("session-test"),
    runId: asId<"RunId">("run-test"),
    agentRole: "worker",
    createdAt: "2026-07-01T00:00:02.000Z",
    text: "hello",
    final: true
  };
}

function storedEvent(id: string, createdAt: string): StoredEvent {
  return {
    id: asId<"EventId">(id),
    sessionId: asId<"SessionId">("session-test"),
    runId: asId<"RunId">("run-test"),
    eventType: "agent.text",
    createdAt,
    payload: { text: "hello" }
  };
}

function sessionRecord(sessionId: string, timestamp: string): ChatSessionRecord {
  return {
    sessionId: asId<"SessionId">(sessionId),
    chatId: asId<"ChatId">(`chat-${sessionId}`),
    title: `Session ${sessionId}`,
    status: "starting",
    providerId: "codex",
    model: "gpt-5",
    transport: "codex-app-server",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}
