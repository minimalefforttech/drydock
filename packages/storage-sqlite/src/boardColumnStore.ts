/**
 * SQLite-backed board-column store.
 *
 * Board columns are global product state (not webview state) so the board
 * looks identical wherever it opens. Persistence mechanics live here; column
 * invariants (every category keeps at least one column, nearest-column
 * reassignment on delete) live in BoardService.
 */

import type {
  BoardColumnRecord,
  BoardColumnStore,
  ColumnCategory,
  ColumnId
} from "@drydock/contracts";
import type { SqliteConnection } from "./sqliteConnection.js";

export class SqliteBoardColumnStore implements BoardColumnStore {
  constructor(private readonly connection: SqliteConnection) {}

  async listColumns(): Promise<BoardColumnRecord[]> {
    const rows = this.connection.database.prepare(`
      SELECT *
      FROM board_columns
      ORDER BY sort_order ASC, rowid ASC
    `).all() as unknown as BoardColumnRow[];
    return rows.map(mapColumn);
  }

  async getColumn(columnId: ColumnId): Promise<BoardColumnRecord | null> {
    const row = this.connection.database.prepare(`
      SELECT *
      FROM board_columns
      WHERE column_id = ?
    `).get(columnId) as BoardColumnRow | undefined;
    return row ? mapColumn(row) : null;
  }

  async insertColumn(record: BoardColumnRecord): Promise<void> {
    this.connection.database.prepare(`
      INSERT INTO board_columns (
        column_id,
        name,
        category,
        sort_order
      ) VALUES (?, ?, ?, ?)
    `).run(
      record.columnId,
      record.name,
      record.category,
      record.sortOrder
    );
  }

  async updateColumn(
    columnId: ColumnId,
    update: { readonly name?: string; readonly category?: ColumnCategory; readonly sortOrder?: number }
  ): Promise<void> {
    // Only the provided fields are written so partial updates never clobber a
    // column set by another code path.
    const assignments: string[] = [];
    const values: (string | number)[] = [];
    if (update.name !== undefined) {
      assignments.push("name = ?");
      values.push(update.name);
    }
    if (update.category !== undefined) {
      assignments.push("category = ?");
      values.push(update.category);
    }
    if (update.sortOrder !== undefined) {
      assignments.push("sort_order = ?");
      values.push(update.sortOrder);
    }
    if (assignments.length === 0) {
      return;
    }
    this.connection.database.prepare(`
      UPDATE board_columns
      SET ${assignments.join(", ")}
      WHERE column_id = ?
    `).run(...values, columnId);
  }

  async deleteColumn(columnId: ColumnId): Promise<void> {
    this.connection.database.prepare(`
      DELETE FROM board_columns
      WHERE column_id = ?
    `).run(columnId);
  }
}

interface BoardColumnRow {
  readonly column_id: string;
  readonly name: string;
  readonly category: ColumnCategory;
  readonly sort_order: number;
}

function mapColumn(row: BoardColumnRow): BoardColumnRecord {
  return {
    columnId: row.column_id as ColumnId,
    name: row.name,
    category: row.category,
    sortOrder: row.sort_order
  };
}
