/**
 * SQLite-backed key/value app state: small, durable UI state such as the
 * active-task spine's `activeTaskId`. Reads and writes are synchronous - the
 * callers restore during activation and write on user navigation, so a single
 * indexed row per key stays cheaper than an async hop.
 */

import type { SqliteConnection } from "./sqliteConnection.js";

export class SqliteAppStateStore {
  constructor(private readonly connection: SqliteConnection) {}

  getAppState(key: string): string | null {
    const row = this.connection.database.prepare(`
      SELECT value
      FROM app_state
      WHERE key = ?
    `).get(key) as { readonly value: string } | undefined;
    return row === undefined ? null : row.value;
  }

  setAppState(key: string, value: string): void {
    this.connection.database.prepare(`
      INSERT INTO app_state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(key, value, new Date().toISOString());
  }

  deleteAppState(key: string): void {
    this.connection.database.prepare(`
      DELETE FROM app_state
      WHERE key = ?
    `).run(key);
  }
}
