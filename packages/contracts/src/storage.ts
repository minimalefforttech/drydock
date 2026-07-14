/**
 * Durable state ports used by the backend services.
 *
 * Storage implementations own persistence mechanics, while services own
 * lifecycle and policy decisions.
 */

import type { AgentEvent, StoredEvent } from "./events.js";
import type { ProjectId, RuntimeId, SessionId } from "./ids.js";
import type { JsonObject } from "./json.js";
import type { RuntimeInventoryRecord, RuntimeStatus } from "./runtime.js";

export interface EventStore {
  /** Appends (idempotently) and returns the durable replay sequence. */
  appendAgentEvent(event: AgentEvent): Promise<number>;
  appendStoredEvent(event: StoredEvent): Promise<number>;
  /** Replay in sequence order; fromSequence is exclusive when provided. */
  listEvents(sessionId: SessionId, fromSequence?: number): Promise<StoredEvent[]>;
}

/** Small stable outcome vocabulary for content-free security evidence. */
export type SecurityEventOutcome = "allowed" | "denied" | "succeeded" | "failed";

/** A security decision or lifecycle fact before its durable sequence is assigned. */
export interface SecurityEventInput {
  /** Canonical UTC ISO timestamp, for example 2026-07-14T03:04:05.000Z. */
  readonly occurredAt: string;
  /** Stable lowercase dot-separated code, for example policy.access.denied. */
  readonly eventCode: string;
  readonly outcome: SecurityEventOutcome;
  readonly actorId?: string;
  readonly hostId?: string;
  readonly policyId?: string;
  readonly sessionId?: SessionId;
  readonly runtimeId?: RuntimeId;
  readonly projectId?: ProjectId;
  /** Low-cardinality facts only; the adapter removes content and credentials. */
  readonly metadata?: JsonObject;
}

export interface SecurityEventRecord extends SecurityEventInput {
  readonly sequence: number;
  readonly metadata: JsonObject;
}

export interface SecurityEventStore {
  appendSecurityEvent(event: SecurityEventInput): Promise<number>;
  /** Lists in append order; fromSequence is exclusive and limit is optional. */
  listSecurityEvents(fromSequence?: number, limit?: number): Promise<SecurityEventRecord[]>;
  /** Exports newline-delimited JSON in append order. */
  exportSecurityEvents(fromSequence?: number): Promise<string>;
}

export interface RuntimeInventoryStore {
  insertRuntime(record: RuntimeInventoryRecord): Promise<void>;
  updateRuntimeStatus(runtimeId: RuntimeId, status: RuntimeStatus, timestamp: string): Promise<void>;
  /** Shallow-merges the patch into the stored metadata JSON. */
  updateRuntimeMetadata(runtimeId: RuntimeId, patch: JsonObject, timestamp: string): Promise<void>;
  updateCleanupAttempt(runtimeId: RuntimeId, timestamp: string, failed: boolean): Promise<void>;
  getRuntime(runtimeId: RuntimeId): Promise<RuntimeInventoryRecord | null>;
  listRuntimes(): Promise<RuntimeInventoryRecord[]>;
}
