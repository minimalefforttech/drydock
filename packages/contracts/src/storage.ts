/**
 * Durable state ports used by the backend services.
 *
 * Storage implementations own persistence mechanics, while services own
 * lifecycle and policy decisions.
 */

import type { AgentEvent, StoredEvent } from "./events.js";
import type { RuntimeId, SessionId } from "./ids.js";
import type { JsonObject } from "./json.js";
import type { RuntimeInventoryRecord, RuntimeStatus } from "./runtime.js";

export interface EventStore {
  /** Appends (idempotently) and returns the durable replay sequence. */
  appendAgentEvent(event: AgentEvent): Promise<number>;
  appendStoredEvent(event: StoredEvent): Promise<number>;
  /** Replay in sequence order; fromSequence is exclusive when provided. */
  listEvents(sessionId: SessionId, fromSequence?: number): Promise<StoredEvent[]>;
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

