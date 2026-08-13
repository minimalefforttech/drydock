/**
 * SQLite validation-runtime store tests (ADR 0022): registry CRUD + archive,
 * the (project, source) association key that lets a managed row coexist with a
 * personal one, settings defaults and partial writes, job queue ordering and
 * filters, receipt supersession, and durability across a reopen.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { asId } from "@drydock/contracts";
import type {
  NamedRuntimeConfig,
  RuntimeAssociation,
  ValidationJob,
  ValidationJobState,
  ValidationReceipt,
  ValidationRuntimeLifecycle
} from "@drydock/contracts";
import { applyMigrations } from "./migrations.js";
import { SqliteConnection } from "./sqliteConnection.js";
import { SqliteValidationRuntimeStore } from "./validationRuntimeStore.js";

function runtime(input: {
  runtimeId: string;
  displayName?: string;
  lifecycle?: ValidationRuntimeLifecycle;
  capabilities?: readonly string[];
  policyProfileRef?: string;
  profileException?: boolean;
  updatedAt?: string;
}): NamedRuntimeConfig {
  return {
    runtimeId: asId<"ValidationRuntimeId">(input.runtimeId),
    displayName: input.displayName ?? input.runtimeId,
    image: "win11-dcc-2026.03",
    lifecycle: input.lifecycle ?? "keep-warm",
    capabilities: input.capabilities ?? ["maya", "houdini"],
    policyProfileRef: input.policyProfileRef ?? "validation_default",
    ...(input.profileException === undefined ? {} : { profileException: input.profileException }),
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-08-01T00:00:00.000Z"
  };
}

function job(input: {
  jobId: string;
  taskId?: string;
  sessionId?: string;
  state?: ValidationJobState;
  queuedAt?: string;
}): ValidationJob {
  return {
    jobId: asId<"ValidationJobId">(input.jobId),
    sessionId: asId<"SessionId">(input.sessionId ?? "session-1"),
    chatId: asId<"ChatId">("chat-1"),
    ...(input.taskId === undefined ? {} : { taskId: asId<"TaskId">(input.taskId) }),
    profileRef: "validation_default",
    changesetRef: `sha-${input.jobId}`,
    state: input.state ?? "queued",
    queuedAt: input.queuedAt ?? "2026-08-12T09:00:00.000Z",
    updatedAt: input.queuedAt ?? "2026-08-12T09:00:00.000Z"
  };
}

function receipt(input: {
  receiptId: string;
  jobId: string;
  verdict?: ValidationReceipt["verdict"];
  createdAt?: string;
}): ValidationReceipt {
  return {
    receiptId: asId<"ValidationReceiptId">(input.receiptId),
    jobId: asId<"ValidationJobId">(input.jobId),
    runtimeId: asId<"ValidationRuntimeId">("vrt-1"),
    policyProfileRef: "validation_default",
    changesetRef: `sha-${input.jobId}`,
    mirrorVersion: 42,
    mirrorFreshnessAt: "2026-08-12T08:55:00.000Z",
    // A degraded/torn mirror (T3.1): false/non-empty here so the round-trip
    // below exercises the real JSON encode/decode, not just the absent case.
    mirrorOk: false,
    mirrorSkippedVersions: ["1.4.2-rc1"],
    licenseWaitMs: 1_500,
    probesGreenAt: "2026-08-12T08:00:00.000Z",
    verdict: input.verdict ?? "passed",
    summary: "12 passed",
    superseded: false,
    createdAt: input.createdAt ?? "2026-08-12T09:10:00.000Z"
  };
}

test("runtime registry round-trips, updates, archives, and survives a reopen", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "validation-runtimes.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const store = new SqliteValidationRuntimeStore(connection);

    // The registry starts empty - nothing is seeded (ADR 0022).
    assert.deepEqual(await store.listRuntimes(), []);
    assert.deepEqual(await store.getSettings(), { topologyPreset: "single" });

    const base = runtime({ runtimeId: "vrt-1", displayName: "default" });
    await store.insertRuntime(base);
    await store.insertRuntime(runtime({
      runtimeId: "vrt-2",
      displayName: "production_tester",
      lifecycle: "on-demand",
      capabilities: ["maya"],
      policyProfileRef: "production_tester",
      profileException: true
    }));

    // Ordered by display name; optional flags only present when set.
    const listed = await store.listRuntimes();
    assert.deepEqual(listed.map((entry) => entry.displayName), ["default", "production_tester"]);
    assert.deepEqual(listed[0], base);
    assert.equal(listed[1]?.profileException, true);
    assert.equal("archived" in (listed[0] ?? {}), false);

    // Partial update touches only named fields.
    await store.updateRuntime(asId<"ValidationRuntimeId">("vrt-1"), {
      lifecycle: "pinned",
      capabilities: ["maya", "houdini", "msvc"],
      updatedAt: "2026-08-12T10:00:00.000Z"
    });
    const updated = await store.getRuntime(asId<"ValidationRuntimeId">("vrt-1"));
    assert.equal(updated?.lifecycle, "pinned");
    assert.deepEqual(updated?.capabilities, ["maya", "houdini", "msvc"]);
    assert.equal(updated?.image, base.image);
    assert.equal(updated?.updatedAt, "2026-08-12T10:00:00.000Z");

    // Archived runtimes leave the default list but stay retrievable.
    await store.archiveRuntime(asId<"ValidationRuntimeId">("vrt-2"), true, "2026-08-12T11:00:00.000Z");
    assert.deepEqual((await store.listRuntimes()).map((entry) => entry.runtimeId), [asId<"ValidationRuntimeId">("vrt-1")]);
    assert.equal((await store.listRuntimes(true)).length, 2);
    assert.equal((await store.getRuntime(asId<"ValidationRuntimeId">("vrt-2")))?.archived, true);
    assert.equal(await store.getRuntime(asId<"ValidationRuntimeId">("ghost")), null);
    connection.close();

    const reopened = new SqliteConnection(dbPath);
    applyMigrations(reopened);
    const reopenedStore = new SqliteValidationRuntimeStore(reopened);
    const durable = await reopenedStore.listRuntimes(true);
    reopened.close();
    assert.deepEqual(durable.map((entry) => entry.runtimeId), [
      asId<"ValidationRuntimeId">("vrt-1"),
      asId<"ValidationRuntimeId">("vrt-2")
    ]);
    assert.deepEqual(durable[0]?.capabilities, ["maya", "houdini", "msvc"]);
    assert.equal(durable[1]?.archived, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the exec address round-trips, clears with null, and tolerates junk", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "connection.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const store = new SqliteValidationRuntimeStore(connection);

    // A runtime with no address is legal: routable, not yet executable.
    await store.insertRuntime(runtime({ runtimeId: "vrt-blank" }));
    assert.equal("connection" in ((await store.getRuntime(asId<"ValidationRuntimeId">("vrt-blank"))) ?? {}), false);

    await store.insertRuntime({
      ...runtime({ runtimeId: "vrt-1" }),
      connection: { host: "10.10.0.5", port: 2222, user: "validator" }
    });
    assert.deepEqual((await store.getRuntime(asId<"ValidationRuntimeId">("vrt-1")))?.connection, {
      host: "10.10.0.5",
      port: 2222,
      user: "validator"
    });

    // Editing the address leaves the rest of the record alone; the default port
    // is absent rather than invented.
    await store.updateRuntime(asId<"ValidationRuntimeId">("vrt-1"), {
      connection: { host: "10.10.0.9", user: "validator" },
      updatedAt: "2026-08-12T10:00:00.000Z"
    });
    const moved = await store.getRuntime(asId<"ValidationRuntimeId">("vrt-1"));
    assert.deepEqual(moved?.connection, { host: "10.10.0.9", user: "validator" });
    assert.equal(moved?.image, "win11-dcc-2026.03");

    // null clears the address (the runtime becomes unreachable, not deleted).
    await store.updateRuntime(asId<"ValidationRuntimeId">("vrt-1"), { connection: null, updatedAt: "2026-08-12T11:00:00.000Z" });
    assert.equal("connection" in ((await store.getRuntime(asId<"ValidationRuntimeId">("vrt-1"))) ?? {}), false);
    connection.close();

    // Durable across a reopen, and half-formed rows read as "no address" rather
    // than handing the adapter something to dial.
    const reopened = new SqliteConnection(dbPath);
    applyMigrations(reopened);
    const reopenedStore = new SqliteValidationRuntimeStore(reopened);
    reopened.database.exec(`
      UPDATE validation_runtimes SET connection_json = '{"host":"10.10.0.5"}' WHERE runtime_id = 'vrt-1';
      UPDATE validation_runtimes SET connection_json = '{oops' WHERE runtime_id = 'vrt-blank';
    `);
    assert.equal("connection" in ((await reopenedStore.getRuntime(asId<"ValidationRuntimeId">("vrt-1"))) ?? {}), false);
    assert.equal("connection" in ((await reopenedStore.getRuntime(asId<"ValidationRuntimeId">("vrt-blank"))) ?? {}), false);
    // An out-of-range port is dropped, but the reachable part of the address stays.
    reopened.database.exec(`UPDATE validation_runtimes SET connection_json = '{"host":"h","user":"u","port":0}' WHERE runtime_id = 'vrt-1'`);
    assert.deepEqual((await reopenedStore.getRuntime(asId<"ValidationRuntimeId">("vrt-1")))?.connection, { host: "h", user: "u" });
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a state file created before the exec address existed gains the column on open", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  try {
    const connection = new SqliteConnection(path.join(dir, "upgrade.sqlite"));
    // The M2 table shape, exactly as it shipped to dev machines this morning.
    connection.database.exec(`
      CREATE TABLE validation_runtimes (
        runtime_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        image TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        policy_profile_ref TEXT NOT NULL,
        profile_exception INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    applyMigrations(connection);
    const store = new SqliteValidationRuntimeStore(connection);
    await store.insertRuntime({
      ...runtime({ runtimeId: "vrt-1" }),
      connection: { host: "10.10.0.5", user: "validator" }
    });

    assert.deepEqual((await store.getRuntime(asId<"ValidationRuntimeId">("vrt-1")))?.connection, {
      host: "10.10.0.5",
      user: "validator"
    });
    connection.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("associations key on (project, source) so a managed row never clobbers a personal one", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  try {
    const connection = new SqliteConnection(path.join(dir, "associations.sqlite"));
    applyMigrations(connection);
    const store = new SqliteValidationRuntimeStore(connection);

    const personal: RuntimeAssociation = {
      projectRootId: asId<"WorkspaceRootId">("root-a"),
      runtimeId: asId<"ValidationRuntimeId">("vrt-1"),
      source: "personal",
      updatedAt: "2026-08-12T09:00:00.000Z"
    };
    const managed: RuntimeAssociation = {
      projectRootId: asId<"WorkspaceRootId">("root-a"),
      runtimeId: asId<"ValidationRuntimeId">("vrt-2"),
      source: "managed",
      pinned: true,
      updatedAt: "2026-08-12T09:05:00.000Z"
    };
    await store.upsertAssociation(personal);
    await store.upsertAssociation(managed);
    await store.upsertAssociation({
      projectRootId: asId<"WorkspaceRootId">("root-b"),
      runtimeId: asId<"ValidationRuntimeId">("vrt-1"),
      source: "personal",
      updatedAt: "2026-08-12T09:06:00.000Z"
    });

    // Both rows for root-a survive; pinned only where set.
    assert.deepEqual(await store.getAssociations(asId<"WorkspaceRootId">("root-a")), [managed, personal]);
    assert.equal((await store.listAssociations()).length, 3);

    // Re-upsert of the same key replaces in place.
    await store.upsertAssociation({ ...personal, runtimeId: asId<"ValidationRuntimeId">("vrt-3"), updatedAt: "2026-08-12T10:00:00.000Z" });
    const rowsAfter = await store.getAssociations(asId<"WorkspaceRootId">("root-a"));
    assert.equal(rowsAfter.length, 2);
    assert.equal(rowsAfter.find((row) => row.source === "personal")?.runtimeId, asId<"ValidationRuntimeId">("vrt-3"));

    // Source-scoped delete leaves the other row; unscoped delete clears both.
    await store.deleteAssociation(asId<"WorkspaceRootId">("root-a"), "personal");
    assert.deepEqual(await store.getAssociations(asId<"WorkspaceRootId">("root-a")), [managed]);
    await store.deleteAssociation(asId<"WorkspaceRootId">("root-a"));
    assert.deepEqual(await store.getAssociations(asId<"WorkspaceRootId">("root-a")), []);
    assert.equal((await store.listAssociations()).length, 1);
    connection.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("settings default to the single preset, take partial writes, and tolerate junk", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  try {
    const connection = new SqliteConnection(path.join(dir, "settings.sqlite"));
    applyMigrations(connection);
    const store = new SqliteValidationRuntimeStore(connection);

    assert.deepEqual(await store.getSettings(), { topologyPreset: "single" });

    await store.setSettings({
      defaultRuntimeId: asId<"ValidationRuntimeId">("vrt-1"),
      topologyPreset: "per-project",
      warmCap: 2,
      autoCreate: { templateRuntimeId: asId<"ValidationRuntimeId">("vrt-tpl"), reapAfterIdleDays: 14 }
    }, "2026-08-12T09:00:00.000Z");
    assert.deepEqual(await store.getSettings(), {
      defaultRuntimeId: asId<"ValidationRuntimeId">("vrt-1"),
      topologyPreset: "per-project",
      warmCap: 2,
      autoCreate: { templateRuntimeId: asId<"ValidationRuntimeId">("vrt-tpl"), reapAfterIdleDays: 14 }
    });

    // A partial write touches only named keys; an empty update is a no-op.
    await store.setSettings({ warmCap: 4 }, "2026-08-12T09:30:00.000Z");
    await store.setSettings({}, "2026-08-12T09:31:00.000Z");
    assert.equal((await store.getSettings()).warmCap, 4);
    assert.equal((await store.getSettings()).topologyPreset, "per-project");

    // null clears a key rather than leaving a stale value behind.
    await store.setSettings({ warmCap: null, autoCreate: null }, "2026-08-12T10:00:00.000Z");
    assert.deepEqual(await store.getSettings(), {
      defaultRuntimeId: asId<"ValidationRuntimeId">("vrt-1"),
      topologyPreset: "per-project"
    });

    // Hand-edited nonsense degrades to defaults instead of throwing.
    connection.database.exec(`
      UPDATE validation_settings SET value = 'nonsense' WHERE key = 'topologyPreset';
      INSERT INTO validation_settings (key, value, updated_at) VALUES
        ('warmCap', 'abc', 't'),
        ('autoCreate', '{oops', 't');
    `);
    assert.deepEqual(await store.getSettings(), {
      defaultRuntimeId: asId<"ValidationRuntimeId">("vrt-1"),
      topologyPreset: "single"
    });
    connection.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("task overrides (own table) and quarantine (settings KV) round-trip independently", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  try {
    const connection = new SqliteConnection(path.join(dir, "kv.sqlite"));
    applyMigrations(connection);
    const store = new SqliteValidationRuntimeStore(connection);

    // Absent means "follows the cascade" / "not quarantined", never a guess.
    assert.equal(await store.getTaskOverride(asId<"TaskId">("task-1")), null);
    assert.equal(await store.getQuarantine(asId<"ValidationRuntimeId">("vrt-1")), null);

    await store.setTaskOverride(asId<"TaskId">("task-1"), asId<"ValidationRuntimeId">("vrt-2"), "2026-08-12T09:00:00.000Z");
    await store.setTaskOverride(asId<"TaskId">("task-2"), asId<"ValidationRuntimeId">("vrt-3"), "2026-08-12T09:00:00.000Z");
    await store.setQuarantine(
      asId<"ValidationRuntimeId">("vrt-1"),
      { probeId: "probe.egress", detail: "EGRESS SUCCEEDED: reached nas:445", at: "2026-08-12T09:12:00.000Z" },
      "2026-08-12T09:12:00.000Z"
    );
    // Neither namespace touches the registry settings keys (T5.2: overrides
    // moved OUT of this table into their own; quarantine stays here).
    await store.setSettings({ topologyPreset: "default-plus-named" }, "2026-08-12T09:00:00.000Z");

    assert.equal(await store.getTaskOverride(asId<"TaskId">("task-1")), asId<"ValidationRuntimeId">("vrt-2"));
    assert.equal(await store.getTaskOverride(asId<"TaskId">("task-2")), asId<"ValidationRuntimeId">("vrt-3"));
    assert.deepEqual(await store.getQuarantine(asId<"ValidationRuntimeId">("vrt-1")), {
      probeId: "probe.egress",
      detail: "EGRESS SUCCEEDED: reached nas:445",
      at: "2026-08-12T09:12:00.000Z"
    });
    assert.deepEqual(await store.getSettings(), { topologyPreset: "default-plus-named" });

    // The incident outlives the process that found it (edge case E5).
    connection.close();
    const reopened = new SqliteConnection(path.join(dir, "kv.sqlite"));
    applyMigrations(reopened);
    const reopenedStore = new SqliteValidationRuntimeStore(reopened);
    assert.equal((await reopenedStore.getQuarantine(asId<"ValidationRuntimeId">("vrt-1")))?.probeId, "probe.egress");
    assert.equal(await reopenedStore.getTaskOverride(asId<"TaskId">("task-1")), asId<"ValidationRuntimeId">("vrt-2"));

    // Only an explicit clear removes either.
    await reopenedStore.setQuarantine(asId<"ValidationRuntimeId">("vrt-1"), null, "2026-08-12T10:00:00.000Z");
    await reopenedStore.setTaskOverride(asId<"TaskId">("task-1"), null, "2026-08-12T10:00:00.000Z");
    assert.equal(await reopenedStore.getQuarantine(asId<"ValidationRuntimeId">("vrt-1")), null);
    assert.equal(await reopenedStore.getTaskOverride(asId<"TaskId">("task-1")), null);
    assert.equal(await reopenedStore.getTaskOverride(asId<"TaskId">("task-2")), asId<"ValidationRuntimeId">("vrt-3"));

    // A hand-mangled payload reads as "no flag" rather than blocking a queue
    // forever with a reason nobody can render.
    reopened.database.exec(`
      INSERT INTO validation_settings (key, value, updated_at)
      VALUES ('quarantine.vrt-9', '{oops', 't');
    `);
    assert.equal(await reopenedStore.getQuarantine(asId<"ValidationRuntimeId">("vrt-9")), null);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("task overrides survive the KV-to-table migration and the legacy keys are removed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  try {
    const connection = new SqliteConnection(path.join(dir, "legacy-overrides.sqlite"));
    // The pre-T5.2 shape: task overrides lived as `override.task.<taskId>` rows
    // in validation_settings, exactly like quarantine still does today. Seed
    // that shape by hand, then run migrations for the first time on this file.
    connection.database.exec(`
      CREATE TABLE validation_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO validation_settings (key, value, updated_at) VALUES
        ('override.task.task-1', 'vrt-2', '2026-08-01T00:00:00.000Z'),
        ('override.task.task-2', 'vrt-3', '2026-08-02T00:00:00.000Z'),
        ('quarantine.vrt-9', '{"probeId":"probe.egress","detail":"d","at":"t"}', '2026-08-01T00:00:00.000Z');
    `);

    applyMigrations(connection);
    const store = new SqliteValidationRuntimeStore(connection);

    // The rows are readable through the new table-backed accessor...
    assert.equal(await store.getTaskOverride(asId<"TaskId">("task-1")), asId<"ValidationRuntimeId">("vrt-2"));
    assert.equal(await store.getTaskOverride(asId<"TaskId">("task-2")), asId<"ValidationRuntimeId">("vrt-3"));
    assert.deepEqual(
      (await store.listTaskOverridesForRuntime(asId<"ValidationRuntimeId">("vrt-2"))).map((row) => row.taskId),
      [asId<"TaskId">("task-1")]
    );
    // ...the legacy KV rows are gone (not just shadowed)...
    const remainingKv = connection.database.prepare(`
      SELECT COUNT(*) AS count FROM validation_settings WHERE key LIKE 'override.task.%'
    `).get() as { readonly count: number };
    assert.equal(remainingKv.count, 0);
    // ...and an unrelated KV row (quarantine) is untouched by the move.
    assert.equal((await store.getQuarantine(asId<"ValidationRuntimeId">("vrt-9")))?.probeId, "probe.egress");

    // Idempotent: re-running migrations (a second window opening the same
    // file) must not throw or duplicate rows.
    applyMigrations(connection);
    const overrideCount = connection.database.prepare(`
      SELECT COUNT(*) AS count FROM validation_task_overrides
    `).get() as { readonly count: number };
    assert.equal(overrideCount.count, 2);
    connection.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("jobs queue in submission order, take state patches, and filter by task/session/state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "jobs.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const store = new SqliteValidationRuntimeStore(connection);

    // Inserted out of order on purpose: the queue orders by queuedAt.
    await store.insertJob(job({ jobId: "vjb-2", taskId: "task-1", queuedAt: "2026-08-12T09:02:00.000Z" }));
    await store.insertJob(job({ jobId: "vjb-1", taskId: "task-1", queuedAt: "2026-08-12T09:01:00.000Z" }));
    await store.insertJob(job({ jobId: "vjb-3", taskId: "task-2", sessionId: "session-2", queuedAt: "2026-08-12T09:03:00.000Z" }));

    assert.deepEqual((await store.listQueuedJobs()).map((entry) => entry.jobId), [
      asId<"ValidationJobId">("vjb-1"),
      asId<"ValidationJobId">("vjb-2"),
      asId<"ValidationJobId">("vjb-3")
    ]);

    // A state patch stamps updatedAt and leaves untouched fields alone.
    await store.updateJobState(asId<"ValidationJobId">("vjb-1"), {
      state: "running",
      resolvedRuntimeId: asId<"ValidationRuntimeId">("vrt-1"),
      startedAt: "2026-08-12T09:05:00.000Z",
      queuePosition: 0,
      updatedAt: "2026-08-12T09:05:00.000Z"
    });
    const running = await store.getJob(asId<"ValidationJobId">("vjb-1"));
    assert.equal(running?.state, "running");
    assert.equal(running?.resolvedRuntimeId, asId<"ValidationRuntimeId">("vrt-1"));
    assert.equal(running?.queuePosition, 0);
    assert.equal(running?.updatedAt, "2026-08-12T09:05:00.000Z");
    assert.equal(running?.changesetRef, "sha-vjb-1");

    // Parking records the human-readable reason; clearing it uses null.
    await store.updateJobState(asId<"ValidationJobId">("vjb-2"), {
      state: "parked",
      parkedReason: "\"cpp-builds\" is quarantined after a failed isolation check.",
      updatedAt: "2026-08-12T09:06:00.000Z"
    });
    assert.equal(
      (await store.getJob(asId<"ValidationJobId">("vjb-2")))?.parkedReason,
      "\"cpp-builds\" is quarantined after a failed isolation check."
    );
    await store.updateJobState(asId<"ValidationJobId">("vjb-2"), { state: "queued", parkedReason: null, updatedAt: "2026-08-12T09:07:00.000Z" });
    assert.equal("parkedReason" in ((await store.getJob(asId<"ValidationJobId">("vjb-2"))) ?? {}), false);

    // Filters: task, session, state set, combined, and the empty-set case.
    assert.deepEqual((await store.listJobs({ taskId: asId<"TaskId">("task-1") })).map((entry) => entry.jobId), [
      asId<"ValidationJobId">("vjb-1"),
      asId<"ValidationJobId">("vjb-2")
    ]);
    assert.deepEqual((await store.listJobs({ sessionId: asId<"SessionId">("session-2") })).map((entry) => entry.jobId), [
      asId<"ValidationJobId">("vjb-3")
    ]);
    assert.deepEqual((await store.listJobs({ states: ["queued"] })).map((entry) => entry.jobId), [
      asId<"ValidationJobId">("vjb-2"),
      asId<"ValidationJobId">("vjb-3")
    ]);
    assert.deepEqual(
      (await store.listJobs({ taskId: asId<"TaskId">("task-1"), states: ["running", "parked"] })).map((entry) => entry.jobId),
      [asId<"ValidationJobId">("vjb-1")]
    );
    assert.deepEqual(await store.listJobs({ states: [] }), []);
    assert.equal((await store.listJobs()).length, 3);
    assert.equal(await store.getJob(asId<"ValidationJobId">("ghost")), null);
    connection.close();

    const reopened = new SqliteConnection(dbPath);
    applyMigrations(reopened);
    const reopenedStore = new SqliteValidationRuntimeStore(reopened);
    const durable = await reopenedStore.getJob(asId<"ValidationJobId">("vjb-1"));
    reopened.close();
    assert.equal(durable?.state, "running");
    assert.equal(durable?.startedAt, "2026-08-12T09:05:00.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("receipts bind to their job, mark superseded with a stamp, and list newest-first per task", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  try {
    const connection = new SqliteConnection(path.join(dir, "receipts.sqlite"));
    applyMigrations(connection);
    const store = new SqliteValidationRuntimeStore(connection);

    await store.insertJob(job({ jobId: "vjb-1", taskId: "task-1", state: "completed" }));
    await store.insertJob(job({ jobId: "vjb-2", taskId: "task-1", state: "completed", queuedAt: "2026-08-12T09:20:00.000Z" }));
    await store.insertJob(job({ jobId: "vjb-3", taskId: "task-2", state: "completed" }));

    const first = receipt({ receiptId: "vrc-1", jobId: "vjb-1", createdAt: "2026-08-12T09:10:00.000Z" });
    await store.insertReceipt(first);
    await store.insertReceipt(receipt({ receiptId: "vrc-2", jobId: "vjb-2", verdict: "failed", createdAt: "2026-08-12T09:30:00.000Z" }));
    await store.insertReceipt(receipt({ receiptId: "vrc-3", jobId: "vjb-3", createdAt: "2026-08-12T09:40:00.000Z" }));

    assert.deepEqual(await store.getReceipt(asId<"ValidationReceiptId">("vrc-1")), first);
    assert.equal((await store.getReceiptByJob(asId<"ValidationJobId">("vjb-2")))?.verdict, "failed");
    assert.equal(await store.getReceiptByJob(asId<"ValidationJobId">("ghost")), null);

    // Evidence goes stale when the working set moves on (edge case D2).
    await store.markReceiptSuperseded(asId<"ValidationReceiptId">("vrc-1"), "2026-08-12T09:45:00.000Z");
    const stale = await store.getReceipt(asId<"ValidationReceiptId">("vrc-1"));
    assert.equal(stale?.superseded, true);
    assert.equal(stale?.supersededAt, "2026-08-12T09:45:00.000Z");
    assert.equal((await store.getReceipt(asId<"ValidationReceiptId">("vrc-2")))?.superseded, false);

    // Task rollup joins through jobs, newest first, and never leaks other tasks.
    assert.deepEqual((await store.listReceiptsByTask(asId<"TaskId">("task-1"))).map((entry) => entry.receiptId), [
      asId<"ValidationReceiptId">("vrc-2"),
      asId<"ValidationReceiptId">("vrc-1")
    ]);
    assert.deepEqual((await store.listReceiptsByTask(asId<"TaskId">("task-2"))).map((entry) => entry.receiptId), [
      asId<"ValidationReceiptId">("vrc-3")
    ]);
    assert.deepEqual(await store.listReceiptsByTask(asId<"TaskId">("task-ghost")), []);

    // Receipts are foreign-keyed to jobs: evidence cannot dangle.
    await assert.rejects(async () => {
      await store.insertReceipt(receipt({ receiptId: "vrc-4", jobId: "vjb-ghost" }));
    });
    connection.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
