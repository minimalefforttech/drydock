/**
 * SQLite-backed Planner stores (ADR 0012): plans, collected artifacts,
 * anchored annotations, and the configurable aspect registry.
 *
 * Revision numbering, aspect/title resolution, and blob handling live in the
 * app service — these stores persist what they are handed. Artifact rows key
 * on artifact_id with a UNIQUE(plan_id, rel_path) guard; the service preserves
 * artifact ids across re-collections so annotations stay attached.
 */

import type {
  PlanAnnotationId,
  PlanAnnotationRecord,
  PlanAnnotationStore,
  PlanAnnotationUpdate,
  PlanArtifactId,
  PlanArtifactRecord,
  PlanArtifactStore,
  PlanAspectRecord,
  PlanAspectStore,
  PlanId,
  PlanRecord,
  PlanStore,
  PlanStoreUpdate,
  SessionId,
  TaskId
} from "@drydock/contracts";
import type { SqliteConnection } from "./sqliteConnection.js";

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export class SqlitePlanStore implements PlanStore {
  constructor(private readonly connection: SqliteConnection) {}

  async insertPlan(record: PlanRecord): Promise<void> {
    this.connection.database.prepare(`
      INSERT INTO planner_plans (
        plan_id, title, brief, aspect_ids_json, context_roots_json,
        notes, status, session_id, task_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.planId,
      record.title,
      record.brief,
      JSON.stringify(record.aspectIds),
      JSON.stringify(record.contextRoots),
      record.notes,
      record.status,
      record.sessionId,
      record.taskId,
      record.createdAt,
      record.updatedAt
    );
  }

  async updatePlan(planId: PlanId, update: PlanStoreUpdate): Promise<void> {
    const assignments: string[] = [];
    const values: (string | null)[] = [];
    if (update.title !== undefined) {
      assignments.push("title = ?");
      values.push(update.title);
    }
    if (update.brief !== undefined) {
      assignments.push("brief = ?");
      values.push(update.brief);
    }
    if (update.aspectIds !== undefined) {
      assignments.push("aspect_ids_json = ?");
      values.push(JSON.stringify(update.aspectIds));
    }
    if (update.contextRoots !== undefined) {
      assignments.push("context_roots_json = ?");
      values.push(JSON.stringify(update.contextRoots));
    }
    if (update.notes !== undefined) {
      assignments.push("notes = ?");
      values.push(update.notes);
    }
    if (update.status !== undefined) {
      assignments.push("status = ?");
      values.push(update.status);
    }
    if (update.sessionId !== undefined) {
      assignments.push("session_id = ?");
      values.push(update.sessionId);
    }
    if (update.taskId !== undefined) {
      assignments.push("task_id = ?");
      values.push(update.taskId);
    }
    if (update.updatedAt !== undefined) {
      assignments.push("updated_at = ?");
      values.push(update.updatedAt);
    }
    if (assignments.length === 0) {
      return;
    }
    values.push(planId);
    this.connection.database.prepare(`
      UPDATE planner_plans SET ${assignments.join(", ")} WHERE plan_id = ?
    `).run(...values);
  }

  async getPlan(planId: PlanId): Promise<PlanRecord | null> {
    const row = this.connection.database.prepare(`
      SELECT * FROM planner_plans WHERE plan_id = ?
    `).get(planId) as PlanRow | undefined;
    return row ? mapPlan(row) : null;
  }

  async getPlanBySessionId(sessionId: SessionId): Promise<PlanRecord | null> {
    const row = this.connection.database.prepare(`
      SELECT * FROM planner_plans WHERE session_id = ?
    `).get(sessionId) as PlanRow | undefined;
    return row ? mapPlan(row) : null;
  }

  async listPlans(): Promise<PlanRecord[]> {
    const rows = this.connection.database.prepare(`
      SELECT * FROM planner_plans ORDER BY updated_at DESC
    `).all() as unknown as PlanRow[];
    return rows.map(mapPlan);
  }

  async deletePlan(planId: PlanId): Promise<void> {
    // Children first: FK enforcement is on for every connection.
    this.connection.database.prepare(`DELETE FROM planner_annotations WHERE plan_id = ?`).run(planId);
    this.connection.database.prepare(`DELETE FROM planner_artifacts WHERE plan_id = ?`).run(planId);
    this.connection.database.prepare(`DELETE FROM planner_plans WHERE plan_id = ?`).run(planId);
  }
}

interface PlanRow {
  readonly plan_id: string;
  readonly title: string;
  readonly brief: string;
  readonly aspect_ids_json: string;
  readonly context_roots_json: string;
  readonly notes: string;
  readonly status: string;
  readonly session_id: string | null;
  readonly task_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function mapPlan(row: PlanRow): PlanRecord {
  return {
    planId: row.plan_id as PlanId,
    title: row.title,
    brief: row.brief,
    aspectIds: parseStringArray(row.aspect_ids_json),
    contextRoots: parseStringArray(row.context_roots_json),
    notes: row.notes,
    status: row.status as PlanRecord["status"],
    sessionId: row.session_id === null ? null : (row.session_id as SessionId),
    taskId: row.task_id === null ? null : (row.task_id as TaskId),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export class SqlitePlanArtifactStore implements PlanArtifactStore {
  constructor(private readonly connection: SqliteConnection) {}

  async upsertArtifact(record: PlanArtifactRecord): Promise<void> {
    this.connection.database.prepare(`
      INSERT OR REPLACE INTO planner_artifacts (
        artifact_id, plan_id, rel_path, kind, aspect_id, title, title_override,
        revision, content, blob_sha256, byte_size, mime, scripts_enabled, collected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.artifactId,
      record.planId,
      record.relPath,
      record.kind,
      record.aspectId,
      record.title,
      record.titleOverride,
      record.revision,
      record.content,
      record.blobSha256,
      record.byteSize,
      record.mime,
      record.scriptsEnabled ? 1 : 0,
      record.collectedAt
    );
  }

  async getArtifact(artifactId: PlanArtifactId): Promise<PlanArtifactRecord | null> {
    const row = this.connection.database.prepare(`
      SELECT * FROM planner_artifacts WHERE artifact_id = ?
    `).get(artifactId) as PlanArtifactRow | undefined;
    return row ? mapArtifact(row) : null;
  }

  async getArtifactByPath(planId: PlanId, relPath: string): Promise<PlanArtifactRecord | null> {
    const row = this.connection.database.prepare(`
      SELECT * FROM planner_artifacts WHERE plan_id = ? AND rel_path = ?
    `).get(planId, relPath) as PlanArtifactRow | undefined;
    return row ? mapArtifact(row) : null;
  }

  async listArtifacts(planId: PlanId): Promise<PlanArtifactRecord[]> {
    const rows = this.connection.database.prepare(`
      SELECT * FROM planner_artifacts WHERE plan_id = ? ORDER BY aspect_id, rel_path
    `).all(planId) as unknown as PlanArtifactRow[];
    return rows.map(mapArtifact);
  }

  async countArtifacts(planId: PlanId): Promise<number> {
    const row = this.connection.database.prepare(`
      SELECT COUNT(*) AS count FROM planner_artifacts WHERE plan_id = ?
    `).get(planId) as { readonly count: number };
    return row.count;
  }

  async setScriptsEnabled(artifactId: PlanArtifactId, enabled: boolean): Promise<void> {
    this.connection.database.prepare(`
      UPDATE planner_artifacts SET scripts_enabled = ? WHERE artifact_id = ?
    `).run(enabled ? 1 : 0, artifactId);
  }

  async setTitleOverride(artifactId: PlanArtifactId, titleOverride: string | null): Promise<void> {
    this.connection.database.prepare(`
      UPDATE planner_artifacts SET title_override = ? WHERE artifact_id = ?
    `).run(titleOverride, artifactId);
  }

  async deletePlanArtifacts(planId: PlanId): Promise<number> {
    const result = this.connection.database.prepare(`
      DELETE FROM planner_artifacts WHERE plan_id = ?
    `).run(planId);
    return Number(result.changes);
  }
}

interface PlanArtifactRow {
  readonly artifact_id: string;
  readonly plan_id: string;
  readonly rel_path: string;
  readonly kind: string;
  readonly aspect_id: string;
  readonly title: string;
  readonly title_override: string | null;
  readonly revision: number;
  readonly content: string | null;
  readonly blob_sha256: string | null;
  readonly byte_size: number | null;
  readonly mime: string | null;
  readonly scripts_enabled: number;
  readonly collected_at: string;
}

function mapArtifact(row: PlanArtifactRow): PlanArtifactRecord {
  return {
    artifactId: row.artifact_id as PlanArtifactId,
    planId: row.plan_id as PlanId,
    relPath: row.rel_path,
    kind: row.kind as PlanArtifactRecord["kind"],
    aspectId: row.aspect_id,
    title: row.title,
    titleOverride: row.title_override,
    revision: row.revision,
    content: row.content,
    blobSha256: row.blob_sha256,
    byteSize: row.byte_size,
    mime: row.mime,
    scriptsEnabled: row.scripts_enabled !== 0,
    collectedAt: row.collected_at
  };
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

export class SqlitePlanAnnotationStore implements PlanAnnotationStore {
  constructor(private readonly connection: SqliteConnection) {}

  async insertAnnotation(record: PlanAnnotationRecord): Promise<void> {
    this.connection.database.prepare(`
      INSERT INTO planner_annotations (
        annotation_id, plan_id, artifact_id, anchor, body, status,
        delegated_rev, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.annotationId,
      record.planId,
      record.artifactId,
      record.anchor,
      record.body,
      record.status,
      record.delegatedRev,
      record.createdAt,
      record.updatedAt
    );
  }

  async updateAnnotation(annotationId: PlanAnnotationId, update: PlanAnnotationUpdate): Promise<void> {
    const assignments: string[] = [];
    const values: (string | number | null)[] = [];
    if (update.body !== undefined) {
      assignments.push("body = ?");
      values.push(update.body);
    }
    if (update.status !== undefined) {
      assignments.push("status = ?");
      values.push(update.status);
    }
    if (update.delegatedRev !== undefined) {
      assignments.push("delegated_rev = ?");
      values.push(update.delegatedRev);
    }
    if (update.updatedAt !== undefined) {
      assignments.push("updated_at = ?");
      values.push(update.updatedAt);
    }
    if (assignments.length === 0) {
      return;
    }
    values.push(annotationId);
    this.connection.database.prepare(`
      UPDATE planner_annotations SET ${assignments.join(", ")} WHERE annotation_id = ?
    `).run(...values);
  }

  async getAnnotation(annotationId: PlanAnnotationId): Promise<PlanAnnotationRecord | null> {
    const row = this.connection.database.prepare(`
      SELECT * FROM planner_annotations WHERE annotation_id = ?
    `).get(annotationId) as PlanAnnotationRow | undefined;
    return row ? mapAnnotation(row) : null;
  }

  async listAnnotations(planId: PlanId): Promise<PlanAnnotationRecord[]> {
    const rows = this.connection.database.prepare(`
      SELECT * FROM planner_annotations WHERE plan_id = ? ORDER BY created_at, annotation_id
    `).all(planId) as unknown as PlanAnnotationRow[];
    return rows.map(mapAnnotation);
  }

  async countOpenAnnotations(planId: PlanId): Promise<number> {
    const row = this.connection.database.prepare(`
      SELECT COUNT(*) AS count FROM planner_annotations WHERE plan_id = ? AND status = 'open'
    `).get(planId) as { readonly count: number };
    return row.count;
  }

  async deleteAnnotation(annotationId: PlanAnnotationId): Promise<void> {
    this.connection.database.prepare(`
      DELETE FROM planner_annotations WHERE annotation_id = ?
    `).run(annotationId);
  }

  async deletePlanAnnotations(planId: PlanId): Promise<number> {
    const result = this.connection.database.prepare(`
      DELETE FROM planner_annotations WHERE plan_id = ?
    `).run(planId);
    return Number(result.changes);
  }
}

interface PlanAnnotationRow {
  readonly annotation_id: string;
  readonly plan_id: string;
  readonly artifact_id: string;
  readonly anchor: string;
  readonly body: string;
  readonly status: string;
  readonly delegated_rev: number | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function mapAnnotation(row: PlanAnnotationRow): PlanAnnotationRecord {
  return {
    annotationId: row.annotation_id as PlanAnnotationId,
    planId: row.plan_id as PlanId,
    artifactId: row.artifact_id as PlanArtifactId,
    anchor: row.anchor,
    body: row.body,
    status: row.status as PlanAnnotationRecord["status"],
    delegatedRev: row.delegated_rev,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// ---------------------------------------------------------------------------
// Aspect registry
// ---------------------------------------------------------------------------

export class SqlitePlanAspectStore implements PlanAspectStore {
  constructor(private readonly connection: SqliteConnection) {}

  async upsertAspect(record: PlanAspectRecord): Promise<void> {
    this.connection.database.prepare(`
      INSERT OR REPLACE INTO planner_aspects (
        aspect_id, label, instructions, expected_artifacts_json, sort_order, archived, seeded
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.aspectId,
      record.label,
      record.instructions,
      JSON.stringify(record.expectedArtifacts),
      record.sortOrder,
      record.archived ? 1 : 0,
      record.seeded ? 1 : 0
    );
  }

  async getAspect(aspectId: string): Promise<PlanAspectRecord | null> {
    const row = this.connection.database.prepare(`
      SELECT * FROM planner_aspects WHERE aspect_id = ?
    `).get(aspectId) as PlanAspectRow | undefined;
    return row ? mapAspect(row) : null;
  }

  async listAspects(includeArchived = false): Promise<PlanAspectRecord[]> {
    const rows = this.connection.database.prepare(
      includeArchived
        ? `SELECT * FROM planner_aspects ORDER BY sort_order, label`
        : `SELECT * FROM planner_aspects WHERE archived = 0 ORDER BY sort_order, label`
    ).all() as unknown as PlanAspectRow[];
    return rows.map(mapAspect);
  }

  async setArchived(aspectId: string, archived: boolean): Promise<void> {
    this.connection.database.prepare(`
      UPDATE planner_aspects SET archived = ? WHERE aspect_id = ?
    `).run(archived ? 1 : 0, aspectId);
  }
}

interface PlanAspectRow {
  readonly aspect_id: string;
  readonly label: string;
  readonly instructions: string;
  readonly expected_artifacts_json: string;
  readonly sort_order: number;
  readonly archived: number;
  readonly seeded: number;
}

function mapAspect(row: PlanAspectRow): PlanAspectRecord {
  return {
    aspectId: row.aspect_id,
    label: row.label,
    instructions: row.instructions,
    expectedArtifacts: parseStringArray(row.expected_artifacts_json),
    sortOrder: row.sort_order,
    archived: row.archived !== 0,
    seeded: row.seeded !== 0
  };
}

/** Defensive JSON-array read: malformed persisted JSON degrades to []. */
function parseStringArray(json: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}
