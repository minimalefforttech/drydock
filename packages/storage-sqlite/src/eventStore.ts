/**
 * SQLite-backed normalized event store.
 *
 * UI projections can replay from this store after the extension host restarts.
 */

import type { AgentEvent, EventStore, JsonObject, SessionId, StoredEvent } from "@drydock/contracts";
import type { SqliteConnection } from "./sqliteConnection.js";

export class SqliteEventStore implements EventStore {
  constructor(private readonly connection: SqliteConnection) {}

  async appendAgentEvent(event: AgentEvent): Promise<number> {
    return this.appendStoredEvent({
      id: event.id,
      sessionId: event.sessionId,
      runId: event.runId,
      eventType: event.type,
      createdAt: event.createdAt,
      payload: event as unknown as JsonObject
    });
  }

  async appendStoredEvent(event: StoredEvent): Promise<number> {
    // OR IGNORE keeps re-appends of an already-stored event id idempotent so
    // replays and retries never throw on the primary key.
    const statement = this.connection.database.prepare(`
      INSERT OR IGNORE INTO session_events (id, session_id, run_id, event_type, created_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = statement.run(
      event.id,
      event.sessionId,
      event.runId ?? null,
      event.eventType,
      event.createdAt,
      JSON.stringify(event.payload)
    );
    if (Number(result.changes) > 0) {
      // The durable sequence is the rowid the insert just assigned.
      return Number(result.lastInsertRowid);
    }
    // Duplicate id: the insert was ignored, so resolve the original sequence.
    const existing = this.connection.database.prepare(`
      SELECT rowid AS seq
      FROM session_events
      WHERE id = ?
    `).get(event.id) as { seq: number } | undefined;
    if (existing === undefined) {
      throw new Error(`Event ${event.id} was neither inserted nor already stored`);
    }
    return Number(existing.seq);
  }

  async listEvents(sessionId: SessionId, fromSequence?: number): Promise<StoredEvent[]> {
    // Replay order is the durable insertion order (rowid), not timestamps:
    // bursts of events share the same millisecond and their random ids would
    // otherwise shuffle the transcript. fromSequence is exclusive so callers
    // resume after the last sequence they already processed.
    const sequenceFilter = fromSequence === undefined ? "" : "AND rowid > ?";
    const parameters: Array<string | number> = fromSequence === undefined
      ? [sessionId]
      : [sessionId, fromSequence];
    const rows = this.connection.database.prepare(`
      SELECT rowid AS seq, id, session_id, run_id, event_type, created_at, payload_json
      FROM session_events
      WHERE session_id = ? ${sequenceFilter}
      ORDER BY rowid ASC
    `).all(...parameters) as unknown as StoredEventRow[];

    return rows.map((row) => {
      const base: Omit<StoredEvent, "runId"> = {
        id: row.id as StoredEvent["id"],
        sessionId: row.session_id as StoredEvent["sessionId"],
        eventType: row.event_type,
        createdAt: row.created_at,
        payload: JSON.parse(row.payload_json) as JsonObject,
        sequence: row.seq
      };
      return row.run_id === null ? base : {
        ...base,
        runId: row.run_id as NonNullable<StoredEvent["runId"]>
      };
    });
  }

  /**
   * Removes every stored event for a session; used when a session is deleted.
   * Not part of the frozen EventStore port — consumers that need it type
   * against this concrete class (or a local method-only interface).
   */
  async deleteSessionEvents(sessionId: SessionId): Promise<number> {
    const result = this.connection.database.prepare(`
      DELETE FROM session_events
      WHERE session_id = ?
    `).run(sessionId);
    return Number(result.changes);
  }
}

interface StoredEventRow {
  readonly seq: number;
  readonly id: string;
  readonly session_id: string;
  readonly run_id: string | null;
  readonly event_type: string;
  readonly created_at: string;
  readonly payload_json: string;
}
