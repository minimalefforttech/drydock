/**
 * SQLite connection for durable state.
 *
 * Uses Node 22's `node:sqlite` driver so the prototype avoids native package
 * installation while keeping a replaceable adapter boundary.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export class SqliteConnection {
  readonly database: DatabaseSync;
  private closed = false;

  constructor(readonly databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    // Overwrite deleted/replaced cells so redaction migrations do not leave
    // recoverable credential bytes in SQLite freelist pages.
    this.database.exec("PRAGMA secure_delete = ON;");
    this.database.exec("PRAGMA busy_timeout = 5000;");
    this.database.exec("PRAGMA journal_mode = WAL;");
    this.database.exec("PRAGMA foreign_keys = ON;");
  }

  /** Idempotent: `DatabaseSync.close()` throws on a second call, and a
   * belt-and-braces close in a `finally` must never mask the real failure. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }
}
