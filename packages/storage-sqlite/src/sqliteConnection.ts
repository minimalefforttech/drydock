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

  constructor(readonly databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL;");
    this.database.exec("PRAGMA foreign_keys = ON;");
  }

  close(): void {
    this.database.close();
  }
}

