/** SQLite-backed append-only security evidence. */

import type {
  JsonObject,
  ProjectId,
  RuntimeId,
  SecurityEventInput,
  SecurityEventOutcome,
  SecurityEventRecord,
  SecurityEventStore,
  SessionId
} from "@drydock/contracts";
import { sanitizeSecurityMetadata } from "./persistenceSanitizer.js";
import type { SqliteConnection } from "./sqliteConnection.js";

const EVENT_CODE_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const OUTCOMES = new Set<SecurityEventOutcome>(["allowed", "denied", "succeeded", "failed"]);
const MAX_IDENTIFIER_CHARS = 256;
const MAX_LIST_LIMIT = 10_000;

export class SqliteSecurityEventStore implements SecurityEventStore {
  constructor(private readonly connection: SqliteConnection) {}

  async appendSecurityEvent(event: SecurityEventInput): Promise<number> {
    validateSecurityEvent(event);
    const metadata = sanitizeSecurityMetadata(event.metadata);
    const result = this.connection.database.prepare(`
      INSERT INTO security_events (
        occurred_at, event_code, outcome, actor_id, host_id, policy_id,
        session_id, runtime_id, project_id, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.occurredAt,
      event.eventCode,
      event.outcome,
      event.actorId ?? null,
      event.hostId ?? null,
      event.policyId ?? null,
      event.sessionId ?? null,
      event.runtimeId ?? null,
      event.projectId ?? null,
      JSON.stringify(metadata)
    );
    return Number(result.lastInsertRowid);
  }

  async listSecurityEvents(fromSequence?: number, limit?: number): Promise<SecurityEventRecord[]> {
    validateSequence(fromSequence);
    validateLimit(limit);
    const sequenceFilter = fromSequence === undefined ? "" : "WHERE sequence > ?";
    const limitClause = limit === undefined ? "" : "LIMIT ?";
    const parameters: number[] = [];
    if (fromSequence !== undefined) parameters.push(fromSequence);
    if (limit !== undefined) parameters.push(limit);
    const rows = this.connection.database.prepare(`
      SELECT sequence, occurred_at, event_code, outcome, actor_id, host_id,
             policy_id, session_id, runtime_id, project_id, metadata_json
      FROM security_events
      ${sequenceFilter}
      ORDER BY sequence ASC
      ${limitClause}
    `).all(...parameters) as unknown as SecurityEventRow[];
    return rows.map(toSecurityEventRecord);
  }

  async exportSecurityEvents(fromSequence?: number): Promise<string> {
    const records = await this.listSecurityEvents(fromSequence);
    return records.length === 0
      ? ""
      : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  }
}

function validateSecurityEvent(event: SecurityEventInput): void {
  if (!isCanonicalUtcTimestamp(event.occurredAt)) {
    throw new Error("Security event occurredAt must be a canonical UTC ISO timestamp");
  }
  if (!EVENT_CODE_PATTERN.test(event.eventCode) || event.eventCode.length > MAX_IDENTIFIER_CHARS) {
    throw new Error("Security event code must be a lowercase dot-separated identifier");
  }
  if (!OUTCOMES.has(event.outcome)) {
    throw new Error(`Unsupported security event outcome: ${String(event.outcome)}`);
  }
  validateIdentifier("actorId", event.actorId);
  validateIdentifier("hostId", event.hostId);
  validateIdentifier("policyId", event.policyId);
  validateIdentifier("sessionId", event.sessionId);
  validateIdentifier("runtimeId", event.runtimeId);
  validateIdentifier("projectId", event.projectId);
}

function isCanonicalUtcTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validateIdentifier(name: string, value: string | undefined): void {
  if (value === undefined) return;
  if (value.length === 0 || value.length > MAX_IDENTIFIER_CHARS || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Security event ${name} must be a non-empty identifier of at most ${String(MAX_IDENTIFIER_CHARS)} characters`);
  }
}

function validateSequence(sequence: number | undefined): void {
  if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 0)) {
    throw new Error("Security event sequence must be a non-negative integer");
  }
}

function validateLimit(limit: number | undefined): void {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT)) {
    throw new Error(`Security event limit must be between 1 and ${String(MAX_LIST_LIMIT)}`);
  }
}

function toSecurityEventRecord(row: SecurityEventRow): SecurityEventRecord {
  return {
    sequence: row.sequence,
    occurredAt: row.occurred_at,
    eventCode: row.event_code,
    outcome: row.outcome as SecurityEventOutcome,
    metadata: JSON.parse(row.metadata_json) as JsonObject,
    ...(row.actor_id === null ? {} : { actorId: row.actor_id }),
    ...(row.host_id === null ? {} : { hostId: row.host_id }),
    ...(row.policy_id === null ? {} : { policyId: row.policy_id }),
    ...(row.session_id === null ? {} : { sessionId: row.session_id as SessionId }),
    ...(row.runtime_id === null ? {} : { runtimeId: row.runtime_id as RuntimeId }),
    ...(row.project_id === null ? {} : { projectId: row.project_id as ProjectId })
  };
}

interface SecurityEventRow {
  readonly sequence: number;
  readonly occurred_at: string;
  readonly event_code: string;
  readonly outcome: string;
  readonly actor_id: string | null;
  readonly host_id: string | null;
  readonly policy_id: string | null;
  readonly session_id: string | null;
  readonly runtime_id: string | null;
  readonly project_id: string | null;
  readonly metadata_json: string;
}
