/**
 * SQLite-backed validation-runtime store (ADR 0022): the named runtime
 * registry, the project -> runtime association table, registry settings, the
 * job queue, and evidence receipts.
 *
 * Shape notes:
 * - Associations key on (project_root_id, source) so a studio-managed row and a
 *   personal row coexist for one project; picking between them is routing's job
 *   (`resolveValidationRuntime`), not storage's (edge case H6).
 * - Settings live in one key/value table (the app_state pattern) with typed
 *   accessors; unknown or malformed keys degrade to the documented defaults
 *   rather than throwing, so a hand-edited state file cannot brick Configure.
 * - Nothing is seeded. The registry starts empty and the setup wizard creates
 *   the default runtime.
 * - Every timestamp arrives as a parameter; the store never reads the clock.
 */

import type {
  AgentId,
  ChatId,
  NamedRuntimeConfig,
  NamedRuntimeUpdate,
  RuntimeAssociation,
  RuntimeAssociationSource,
  SessionId,
  SubtaskId,
  TaskId,
  ValidationAutoCreateRule,
  ValidationJob,
  ValidationJobFilter,
  ValidationJobId,
  ValidationJobPatch,
  ValidationJobState,
  ValidationQuarantineRecord,
  ValidationReceipt,
  ValidationReceiptId,
  ValidationRegistrySettings,
  ValidationRegistrySettingsUpdate,
  ValidationRuntimeConnection,
  ValidationRuntimeId,
  ValidationRuntimeLifecycle,
  ValidationRuntimeStore,
  ValidationTopologyPreset,
  ValidationVerdict,
  WorkspaceRootId
} from "@drydock/contracts";
import type { SqliteConnection } from "./sqliteConnection.js";

/** Settings keys in `validation_settings`; unknown keys are ignored on read. */
const SETTING_DEFAULT_RUNTIME_ID = "defaultRuntimeId";
const SETTING_TOPOLOGY_PRESET = "topologyPreset";
const SETTING_WARM_CAP = "warmCap";
const SETTING_AUTO_CREATE = "autoCreate";
/**
 * Namespaced key prefixes sharing the same table. Both are one small durable
 * fact per subject - a task's chosen runtime, a runtime's live incident - so
 * they ride the settings KV rather than earning tables of their own.
 */
const SETTING_TASK_OVERRIDE_PREFIX = "override.task.";
const SETTING_QUARANTINE_PREFIX = "quarantine.";

type SqlValue = string | number | null;

export class SqliteValidationRuntimeStore implements ValidationRuntimeStore {
  constructor(private readonly connection: SqliteConnection) {}

  // -------------------------------------------------------------------------
  // Registry
  // -------------------------------------------------------------------------

  async listRuntimes(includeArchived = false): Promise<NamedRuntimeConfig[]> {
    const rows = this.connection.database.prepare(`
      SELECT *
      FROM validation_runtimes
      ${includeArchived ? "" : "WHERE archived = 0"}
      ORDER BY display_name ASC, rowid ASC
    `).all() as unknown as RuntimeRow[];
    return rows.map(mapRuntime);
  }

  async getRuntime(runtimeId: ValidationRuntimeId): Promise<NamedRuntimeConfig | null> {
    const row = this.connection.database.prepare(`
      SELECT *
      FROM validation_runtimes
      WHERE runtime_id = ?
    `).get(runtimeId) as RuntimeRow | undefined;
    return row ? mapRuntime(row) : null;
  }

  async insertRuntime(record: NamedRuntimeConfig): Promise<void> {
    this.connection.database.prepare(`
      INSERT INTO validation_runtimes (
        runtime_id, display_name, image, lifecycle, capabilities_json,
        policy_profile_ref, profile_exception, archived, connection_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.runtimeId,
      record.displayName,
      record.image,
      record.lifecycle,
      JSON.stringify(record.capabilities),
      record.policyProfileRef,
      record.profileException === true ? 1 : 0,
      record.archived === true ? 1 : 0,
      record.connection === undefined ? null : JSON.stringify(record.connection),
      record.createdAt,
      record.updatedAt
    );
  }

  async updateRuntime(runtimeId: ValidationRuntimeId, update: NamedRuntimeUpdate): Promise<void> {
    const assignments: string[] = [];
    const values: SqlValue[] = [];
    if (update.displayName !== undefined) {
      assignments.push("display_name = ?");
      values.push(update.displayName);
    }
    if (update.image !== undefined) {
      assignments.push("image = ?");
      values.push(update.image);
    }
    if (update.lifecycle !== undefined) {
      assignments.push("lifecycle = ?");
      values.push(update.lifecycle);
    }
    if (update.capabilities !== undefined) {
      assignments.push("capabilities_json = ?");
      values.push(JSON.stringify(update.capabilities));
    }
    if (update.policyProfileRef !== undefined) {
      assignments.push("policy_profile_ref = ?");
      values.push(update.policyProfileRef);
    }
    if (update.profileException !== undefined) {
      assignments.push("profile_exception = ?");
      values.push(update.profileException ? 1 : 0);
    }
    if (update.connection !== undefined) {
      // `null` clears the address; omitting the key leaves the stored one alone.
      assignments.push("connection_json = ?");
      values.push(update.connection === null ? null : JSON.stringify(update.connection));
    }
    if (update.archived !== undefined) {
      assignments.push("archived = ?");
      values.push(update.archived ? 1 : 0);
    }
    if (update.updatedAt !== undefined) {
      assignments.push("updated_at = ?");
      values.push(update.updatedAt);
    }
    if (assignments.length === 0) return;
    values.push(runtimeId);
    this.connection.database.prepare(`
      UPDATE validation_runtimes SET ${assignments.join(", ")} WHERE runtime_id = ?
    `).run(...values);
  }

  async archiveRuntime(runtimeId: ValidationRuntimeId, archived: boolean, updatedAt: string): Promise<void> {
    this.connection.database.prepare(`
      UPDATE validation_runtimes
      SET archived = ?, updated_at = ?
      WHERE runtime_id = ?
    `).run(archived ? 1 : 0, updatedAt, runtimeId);
  }

  // -------------------------------------------------------------------------
  // Associations
  // -------------------------------------------------------------------------

  async listAssociations(): Promise<RuntimeAssociation[]> {
    const rows = this.connection.database.prepare(`
      SELECT *
      FROM validation_associations
      ORDER BY project_root_id ASC, source ASC
    `).all() as unknown as AssociationRow[];
    return rows.map(mapAssociation);
  }

  async getAssociations(projectRootId: WorkspaceRootId): Promise<RuntimeAssociation[]> {
    const rows = this.connection.database.prepare(`
      SELECT *
      FROM validation_associations
      WHERE project_root_id = ?
      ORDER BY source ASC
    `).all(projectRootId) as unknown as AssociationRow[];
    return rows.map(mapAssociation);
  }

  async upsertAssociation(record: RuntimeAssociation): Promise<void> {
    this.connection.database.prepare(`
      INSERT INTO validation_associations (project_root_id, source, runtime_id, pinned, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_root_id, source) DO UPDATE SET
        runtime_id = excluded.runtime_id,
        pinned = excluded.pinned,
        updated_at = excluded.updated_at
    `).run(
      record.projectRootId,
      record.source,
      record.runtimeId,
      record.pinned === true ? 1 : 0,
      record.updatedAt
    );
  }

  async deleteAssociation(projectRootId: WorkspaceRootId, source?: RuntimeAssociationSource): Promise<void> {
    if (source === undefined) {
      this.connection.database.prepare(`
        DELETE FROM validation_associations
        WHERE project_root_id = ?
      `).run(projectRootId);
      return;
    }
    this.connection.database.prepare(`
      DELETE FROM validation_associations
      WHERE project_root_id = ? AND source = ?
    `).run(projectRootId, source);
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  async getSettings(): Promise<ValidationRegistrySettings> {
    const rows = this.connection.database.prepare(`
      SELECT key, value
      FROM validation_settings
    `).all() as unknown as SettingRow[];
    const values = new Map<string, string>();
    for (const row of rows) values.set(row.key, row.value);

    const preset = values.get(SETTING_TOPOLOGY_PRESET);
    const defaultRuntimeId = values.get(SETTING_DEFAULT_RUNTIME_ID);
    const warmCap = parseWarmCap(values.get(SETTING_WARM_CAP));
    const autoCreate = parseAutoCreate(values.get(SETTING_AUTO_CREATE));
    return {
      ...(defaultRuntimeId === undefined || defaultRuntimeId.length === 0
        ? {}
        : { defaultRuntimeId: defaultRuntimeId as ValidationRuntimeId }),
      topologyPreset: isTopologyPreset(preset) ? preset : "single",
      ...(warmCap === null ? {} : { warmCap }),
      ...(autoCreate === null ? {} : { autoCreate })
    };
  }

  async setSettings(update: ValidationRegistrySettingsUpdate, updatedAt: string): Promise<void> {
    const writes: { readonly key: string; readonly value: string | null }[] = [];
    if (update.defaultRuntimeId !== undefined) {
      writes.push({ key: SETTING_DEFAULT_RUNTIME_ID, value: update.defaultRuntimeId });
    }
    if (update.topologyPreset !== undefined) {
      writes.push({ key: SETTING_TOPOLOGY_PRESET, value: update.topologyPreset });
    }
    if (update.warmCap !== undefined) {
      writes.push({ key: SETTING_WARM_CAP, value: update.warmCap === null ? null : String(update.warmCap) });
    }
    if (update.autoCreate !== undefined) {
      writes.push({
        key: SETTING_AUTO_CREATE,
        value: update.autoCreate === null ? null : JSON.stringify(update.autoCreate)
      });
    }
    if (writes.length === 0) return;

    const db = this.connection.database;
    db.exec("BEGIN IMMEDIATE;");
    try {
      const upsert = db.prepare(`
        INSERT INTO validation_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `);
      const clear = db.prepare(`DELETE FROM validation_settings WHERE key = ?`);
      for (const write of writes) {
        if (write.value === null) clear.run(write.key);
        else upsert.run(write.key, write.value, updatedAt);
      }
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Task overrides + quarantine (same KV table, namespaced keys)
  // -------------------------------------------------------------------------

  async getTaskOverride(taskId: TaskId): Promise<ValidationRuntimeId | null> {
    const value = this.readSetting(`${SETTING_TASK_OVERRIDE_PREFIX}${taskId}`);
    return value === null || value.length === 0 ? null : (value as ValidationRuntimeId);
  }

  async setTaskOverride(taskId: TaskId, runtimeId: ValidationRuntimeId | null, updatedAt: string): Promise<void> {
    this.writeSetting(`${SETTING_TASK_OVERRIDE_PREFIX}${taskId}`, runtimeId, updatedAt);
  }

  /** An unreadable payload reads as "no quarantine flag" - see the note below. */
  async getQuarantine(runtimeId: ValidationRuntimeId): Promise<ValidationQuarantineRecord | null> {
    const raw = this.readSetting(`${SETTING_QUARANTINE_PREFIX}${runtimeId}`);
    if (raw === null || raw.length === 0) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      // Deliberate: a corrupt flag row is reported as a corrupt flag by the
      // service layer's own probe run, not silently treated as an incident that
      // blocks the queue forever with no readable detail.
      return null;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const probeId = record["probeId"];
    const detail = record["detail"];
    const at = record["at"];
    if (typeof probeId !== "string" || typeof detail !== "string" || typeof at !== "string") return null;
    return { probeId, detail, at };
  }

  async setQuarantine(
    runtimeId: ValidationRuntimeId,
    payload: ValidationQuarantineRecord | null,
    updatedAt: string
  ): Promise<void> {
    this.writeSetting(
      `${SETTING_QUARANTINE_PREFIX}${runtimeId}`,
      payload === null ? null : JSON.stringify({ probeId: payload.probeId, detail: payload.detail, at: payload.at }),
      updatedAt
    );
  }

  private readSetting(key: string): string | null {
    const row = this.connection.database.prepare(`
      SELECT value
      FROM validation_settings
      WHERE key = ?
    `).get(key) as { readonly value: string } | undefined;
    return row === undefined ? null : row.value;
  }

  /** `null` deletes the row, matching setSettings' clear semantics. */
  private writeSetting(key: string, value: string | null, updatedAt: string): void {
    if (value === null) {
      this.connection.database.prepare(`DELETE FROM validation_settings WHERE key = ?`).run(key);
      return;
    }
    this.connection.database.prepare(`
      INSERT INTO validation_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(key, value, updatedAt);
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  async insertJob(record: ValidationJob): Promise<void> {
    this.connection.database.prepare(`
      INSERT INTO validation_jobs (
        job_id, session_id, chat_id, task_id, subtask_id, agent_id,
        project_root_id, requested_runtime_id, resolved_runtime_id, profile_ref,
        changeset_ref, state, parked_reason, queue_position, license_wait_ms,
        receipt_id, queued_at, started_at, completed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.jobId,
      record.sessionId,
      record.chatId,
      record.taskId ?? null,
      record.subtaskId ?? null,
      record.agentId ?? null,
      record.projectRootId ?? null,
      record.requestedRuntimeId ?? null,
      record.resolvedRuntimeId ?? null,
      record.profileRef,
      record.changesetRef,
      record.state,
      record.parkedReason ?? null,
      record.queuePosition ?? null,
      record.licenseWaitMs ?? null,
      record.receiptId ?? null,
      record.queuedAt,
      record.startedAt ?? null,
      record.completedAt ?? null,
      record.updatedAt
    );
  }

  async getJob(jobId: ValidationJobId): Promise<ValidationJob | null> {
    const row = this.connection.database.prepare(`
      SELECT *
      FROM validation_jobs
      WHERE job_id = ?
    `).get(jobId) as JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  async updateJobState(jobId: ValidationJobId, patch: ValidationJobPatch): Promise<void> {
    const assignments: string[] = [];
    const values: SqlValue[] = [];
    if (patch.state !== undefined) {
      assignments.push("state = ?");
      values.push(patch.state);
    }
    if (patch.parkedReason !== undefined) {
      assignments.push("parked_reason = ?");
      values.push(patch.parkedReason);
    }
    if (patch.queuePosition !== undefined) {
      assignments.push("queue_position = ?");
      values.push(patch.queuePosition);
    }
    if (patch.licenseWaitMs !== undefined) {
      assignments.push("license_wait_ms = ?");
      values.push(patch.licenseWaitMs);
    }
    if (patch.receiptId !== undefined) {
      assignments.push("receipt_id = ?");
      values.push(patch.receiptId);
    }
    if (patch.resolvedRuntimeId !== undefined) {
      assignments.push("resolved_runtime_id = ?");
      values.push(patch.resolvedRuntimeId);
    }
    if (patch.startedAt !== undefined) {
      assignments.push("started_at = ?");
      values.push(patch.startedAt);
    }
    if (patch.completedAt !== undefined) {
      assignments.push("completed_at = ?");
      values.push(patch.completedAt);
    }
    assignments.push("updated_at = ?");
    values.push(patch.updatedAt);
    values.push(jobId);
    this.connection.database.prepare(`
      UPDATE validation_jobs SET ${assignments.join(", ")} WHERE job_id = ?
    `).run(...values);
  }

  async listJobs(filter?: ValidationJobFilter): Promise<ValidationJob[]> {
    const clauses: string[] = [];
    const values: SqlValue[] = [];
    if (filter?.taskId !== undefined) {
      clauses.push("task_id = ?");
      values.push(filter.taskId);
    }
    if (filter?.sessionId !== undefined) {
      clauses.push("session_id = ?");
      values.push(filter.sessionId);
    }
    if (filter?.states !== undefined) {
      // An explicit empty state set matches nothing - it is a real filter, not
      // an absent one, so it must not silently widen to "every state".
      if (filter.states.length === 0) return [];
      clauses.push(`state IN (${filter.states.map(() => "?").join(", ")})`);
      values.push(...filter.states);
    }
    const rows = this.connection.database.prepare(`
      SELECT *
      FROM validation_jobs
      ${clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`}
      ORDER BY queued_at ASC, rowid ASC
    `).all(...values) as unknown as JobRow[];
    return rows.map(mapJob);
  }

  async listQueuedJobs(): Promise<ValidationJob[]> {
    const rows = this.connection.database.prepare(`
      SELECT *
      FROM validation_jobs
      WHERE state = 'queued'
      ORDER BY queued_at ASC, rowid ASC
    `).all() as unknown as JobRow[];
    return rows.map(mapJob);
  }

  // -------------------------------------------------------------------------
  // Receipts
  // -------------------------------------------------------------------------

  async insertReceipt(record: ValidationReceipt): Promise<void> {
    this.connection.database.prepare(`
      INSERT INTO validation_receipts (
        receipt_id, job_id, runtime_id, policy_profile_ref, changeset_ref,
        mirror_version, mirror_freshness_at, fixture_manifest_hash,
        license_wait_ms, probes_green_at, image_generation, revert_generation,
        verdict, summary, failing_test, failing_assertion, superseded,
        superseded_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.receiptId,
      record.jobId,
      record.runtimeId,
      record.policyProfileRef,
      record.changesetRef,
      record.mirrorVersion ?? null,
      record.mirrorFreshnessAt ?? null,
      record.fixtureManifestHash ?? null,
      record.licenseWaitMs,
      record.probesGreenAt ?? null,
      record.imageGeneration ?? null,
      record.revertGeneration ?? null,
      record.verdict,
      record.summary ?? null,
      record.failingTest ?? null,
      record.failingAssertion ?? null,
      record.superseded ? 1 : 0,
      record.supersededAt ?? null,
      record.createdAt
    );
  }

  async getReceipt(receiptId: ValidationReceiptId): Promise<ValidationReceipt | null> {
    const row = this.connection.database.prepare(`
      SELECT *
      FROM validation_receipts
      WHERE receipt_id = ?
    `).get(receiptId) as ReceiptRow | undefined;
    return row ? mapReceipt(row) : null;
  }

  async getReceiptByJob(jobId: ValidationJobId): Promise<ValidationReceipt | null> {
    const row = this.connection.database.prepare(`
      SELECT *
      FROM validation_receipts
      WHERE job_id = ?
      ORDER BY created_at DESC, rowid DESC
    `).get(jobId) as ReceiptRow | undefined;
    return row ? mapReceipt(row) : null;
  }

  async markReceiptSuperseded(receiptId: ValidationReceiptId, updatedAt: string): Promise<void> {
    this.connection.database.prepare(`
      UPDATE validation_receipts
      SET superseded = 1, superseded_at = ?
      WHERE receipt_id = ?
    `).run(updatedAt, receiptId);
  }

  async listReceiptsByTask(taskId: TaskId): Promise<ValidationReceipt[]> {
    const rows = this.connection.database.prepare(`
      SELECT receipts.*
      FROM validation_receipts AS receipts
      JOIN validation_jobs AS jobs ON jobs.job_id = receipts.job_id
      WHERE jobs.task_id = ?
      ORDER BY receipts.created_at DESC, receipts.rowid DESC
    `).all(taskId) as unknown as ReceiptRow[];
    return rows.map(mapReceipt);
  }
}

// ---------------------------------------------------------------------------
// Rows + mappers
// ---------------------------------------------------------------------------

interface RuntimeRow {
  readonly runtime_id: string;
  readonly display_name: string;
  readonly image: string;
  readonly lifecycle: string;
  readonly capabilities_json: string;
  readonly policy_profile_ref: string;
  readonly profile_exception: number;
  readonly archived: number;
  readonly connection_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface AssociationRow {
  readonly project_root_id: string;
  readonly source: string;
  readonly runtime_id: string;
  readonly pinned: number;
  readonly updated_at: string;
}

interface SettingRow {
  readonly key: string;
  readonly value: string;
}

interface JobRow {
  readonly job_id: string;
  readonly session_id: string;
  readonly chat_id: string;
  readonly task_id: string | null;
  readonly subtask_id: string | null;
  readonly agent_id: string | null;
  readonly project_root_id: string | null;
  readonly requested_runtime_id: string | null;
  readonly resolved_runtime_id: string | null;
  readonly profile_ref: string;
  readonly changeset_ref: string;
  readonly state: string;
  readonly parked_reason: string | null;
  readonly queue_position: number | null;
  readonly license_wait_ms: number | null;
  readonly receipt_id: string | null;
  readonly queued_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly updated_at: string;
}

interface ReceiptRow {
  readonly receipt_id: string;
  readonly job_id: string;
  readonly runtime_id: string;
  readonly policy_profile_ref: string;
  readonly changeset_ref: string;
  readonly mirror_version: number | null;
  readonly mirror_freshness_at: string | null;
  readonly fixture_manifest_hash: string | null;
  readonly license_wait_ms: number;
  readonly probes_green_at: string | null;
  readonly image_generation: number | null;
  readonly revert_generation: number | null;
  readonly verdict: string;
  readonly summary: string | null;
  readonly failing_test: string | null;
  readonly failing_assertion: string | null;
  readonly superseded: number;
  readonly superseded_at: string | null;
  readonly created_at: string;
}

const LIFECYCLES: readonly ValidationRuntimeLifecycle[] = ["keep-warm", "on-demand", "pinned"];
const TOPOLOGY_PRESETS: readonly ValidationTopologyPreset[] = ["single", "default-plus-named", "per-project"];
const JOB_STATES: readonly ValidationJobState[] = [
  "queued",
  "starting",
  "syncing",
  "resolving",
  "running",
  "license-wait",
  "completed",
  "parked",
  "aborted",
  "failed"
];
const VERDICTS: readonly ValidationVerdict[] = ["passed", "failed", "error"];

function mapRuntime(row: RuntimeRow): NamedRuntimeConfig {
  const connection = parseConnection(row.connection_json);
  return {
    runtimeId: row.runtime_id as ValidationRuntimeId,
    displayName: row.display_name,
    image: row.image,
    // An unreadable lifecycle degrades to the safest choice: boot per job.
    lifecycle: LIFECYCLES.includes(row.lifecycle as ValidationRuntimeLifecycle)
      ? (row.lifecycle as ValidationRuntimeLifecycle)
      : "on-demand",
    capabilities: parseStringArray(row.capabilities_json),
    policyProfileRef: row.policy_profile_ref,
    ...(connection === null ? {} : { connection }),
    ...(row.profile_exception === 0 ? {} : { profileException: true }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.archived === 0 ? {} : { archived: true })
  };
}

function mapAssociation(row: AssociationRow): RuntimeAssociation {
  return {
    projectRootId: row.project_root_id as WorkspaceRootId,
    runtimeId: row.runtime_id as ValidationRuntimeId,
    // Unknown sources read as personal: managed authority is never inferred.
    source: row.source === "managed" ? "managed" : "personal",
    ...(row.pinned === 0 ? {} : { pinned: true }),
    updatedAt: row.updated_at
  };
}

function mapJob(row: JobRow): ValidationJob {
  return {
    jobId: row.job_id as ValidationJobId,
    sessionId: row.session_id as SessionId,
    chatId: row.chat_id as ChatId,
    ...(row.task_id === null ? {} : { taskId: row.task_id as TaskId }),
    ...(row.subtask_id === null ? {} : { subtaskId: row.subtask_id as SubtaskId }),
    ...(row.agent_id === null ? {} : { agentId: row.agent_id as AgentId }),
    ...(row.project_root_id === null ? {} : { projectRootId: row.project_root_id as WorkspaceRootId }),
    ...(row.requested_runtime_id === null ? {} : { requestedRuntimeId: row.requested_runtime_id as ValidationRuntimeId }),
    ...(row.resolved_runtime_id === null ? {} : { resolvedRuntimeId: row.resolved_runtime_id as ValidationRuntimeId }),
    profileRef: row.profile_ref,
    changesetRef: row.changeset_ref,
    // An unreadable state reads as failed, never as a state that implies progress.
    state: JOB_STATES.includes(row.state as ValidationJobState) ? (row.state as ValidationJobState) : "failed",
    ...(row.parked_reason === null ? {} : { parkedReason: row.parked_reason }),
    ...(row.queue_position === null ? {} : { queuePosition: row.queue_position }),
    ...(row.license_wait_ms === null ? {} : { licenseWaitMs: row.license_wait_ms }),
    ...(row.receipt_id === null ? {} : { receiptId: row.receipt_id as ValidationReceiptId }),
    queuedAt: row.queued_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    updatedAt: row.updated_at
  };
}

function mapReceipt(row: ReceiptRow): ValidationReceipt {
  return {
    receiptId: row.receipt_id as ValidationReceiptId,
    jobId: row.job_id as ValidationJobId,
    runtimeId: row.runtime_id as ValidationRuntimeId,
    policyProfileRef: row.policy_profile_ref,
    changesetRef: row.changeset_ref,
    ...(row.mirror_version === null ? {} : { mirrorVersion: row.mirror_version }),
    ...(row.mirror_freshness_at === null ? {} : { mirrorFreshnessAt: row.mirror_freshness_at }),
    ...(row.fixture_manifest_hash === null ? {} : { fixtureManifestHash: row.fixture_manifest_hash }),
    licenseWaitMs: row.license_wait_ms,
    ...(row.probes_green_at === null ? {} : { probesGreenAt: row.probes_green_at }),
    ...(row.image_generation === null ? {} : { imageGeneration: row.image_generation }),
    ...(row.revert_generation === null ? {} : { revertGeneration: row.revert_generation }),
    // An unreadable verdict is `error`, never an invented pass.
    verdict: VERDICTS.includes(row.verdict as ValidationVerdict) ? (row.verdict as ValidationVerdict) : "error",
    ...(row.summary === null ? {} : { summary: row.summary }),
    ...(row.failing_test === null ? {} : { failingTest: row.failing_test }),
    ...(row.failing_assertion === null ? {} : { failingAssertion: row.failing_assertion }),
    superseded: row.superseded !== 0,
    ...(row.superseded_at === null ? {} : { supersededAt: row.superseded_at }),
    createdAt: row.created_at
  };
}

/** Tolerant JSON string-array parse: junk reads as "no capabilities declared". */
function parseStringArray(json: string): readonly string[] {
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

/**
 * Tolerant exec-address parse (ADR 0022 M3). A row whose JSON is unreadable, or
 * that names no host/user, reads as NO CONNECTION - the runtime then shows as
 * unreachable and the job service parks, which beats handing the adapter a
 * half-formed address to dial.
 */
function parseConnection(raw: string | null): ValidationRuntimeConnection | null {
  if (raw === null || raw.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const host = candidate["host"];
  const user = candidate["user"];
  if (typeof host !== "string" || host.length === 0) return null;
  if (typeof user !== "string" || user.length === 0) return null;
  const port = candidate["port"];
  const validPort = typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65_535;
  return {
    host,
    ...(validPort ? { port: port as number } : {}),
    user
  };
}

function isTopologyPreset(value: string | undefined): value is ValidationTopologyPreset {
  return value !== undefined && TOPOLOGY_PRESETS.includes(value as ValidationTopologyPreset);
}

/** A malformed or negative cap reads as "no cap set", never as cap 0. */
function parseWarmCap(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/** Tolerant auto-create parse; anything unreadable reads as "rule not set". */
function parseAutoCreate(raw: string | undefined): ValidationAutoCreateRule | null {
  if (raw === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const days = candidate["reapAfterIdleDays"];
  if (typeof days !== "number" || !Number.isFinite(days) || days < 0) return null;
  const template = candidate["templateRuntimeId"];
  return {
    ...(typeof template === "string" && template.length > 0
      ? { templateRuntimeId: template as ValidationRuntimeId }
      : {}),
    reapAfterIdleDays: days
  };
}
