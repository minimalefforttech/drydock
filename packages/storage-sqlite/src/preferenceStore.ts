/**
 * SQLite-backed preference store (plan D10): a validated-JSON-per-key KV.
 * The typed accessors (and junk tolerance) live in PreferencesService; this
 * store is deliberately dumb persistence.
 */

import type { PreferenceStore } from "@drydock/contracts";
import type { SqliteConnection } from "./sqliteConnection.js";

export class SqlitePreferenceStore implements PreferenceStore {
  constructor(private readonly connection: SqliteConnection) {}

  async getPreference(key: string): Promise<string | null> {
    const row = this.connection.database.prepare(`
      SELECT value_json
      FROM preferences
      WHERE key = ?
    `).get(key) as { value_json: string } | undefined;
    return row?.value_json ?? null;
  }

  async setPreference(key: string, valueJson: string | null): Promise<void> {
    if (valueJson === null) {
      this.connection.database.prepare("DELETE FROM preferences WHERE key = ?").run(key);
      return;
    }
    this.connection.database.prepare(`
      INSERT INTO preferences (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(key, valueJson, new Date().toISOString());
  }

  async listPreferences(): Promise<{ readonly key: string; readonly valueJson: string }[]> {
    const rows = this.connection.database.prepare(`
      SELECT key, value_json
      FROM preferences
      ORDER BY key ASC
    `).all() as unknown as { key: string; value_json: string }[];
    return rows.map((row) => ({ key: row.key, valueJson: row.value_json }));
  }
}
