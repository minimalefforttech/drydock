/**
 * Board-column service (task board and subtasks).
 *
 * Board columns are global, ordered, user-configurable groupings within one
 * of four fixed categories (backlog/pending/in-progress/done). Category -
 * never the column name - drives every automation rule; this service owns
 * that invariant plus the reorder/delete policy. Persistence lives in the
 * store.
 */

import { COLUMN_CATEGORIES } from "@drydock/contracts";
import type {
  BoardColumnRecord,
  BoardColumnStore,
  ColumnCategory,
  SubtaskStore,
  WorkTaskStore
} from "@drydock/contracts";
import { asId } from "@drydock/contracts";
import type { IdGenerator } from "@drydock/core";

export interface BoardServiceOptions {
  readonly ids: IdGenerator;
  readonly store: BoardColumnStore;
  /** Card carriers reassigned when a column is deleted. */
  readonly tasks: WorkTaskStore;
  readonly subtasks: SubtaskStore;
}

export class BoardService {
  constructor(private readonly options: BoardServiceOptions) {}

  /** Ordered by sortOrder ascending, as persisted. */
  listColumns(): Promise<BoardColumnRecord[]> {
    return this.options.store.listColumns();
  }

  /** The automation target for a category: its lowest-sortOrder column. */
  async firstColumnOf(category: ColumnCategory): Promise<BoardColumnRecord> {
    const columns = (await this.options.store.listColumns()).filter((column) => column.category === category);
    const first = columns[0];
    if (first === undefined) {
      throw new Error(`No column exists in category ${category}.`);
    }
    return first;
  }

  async addColumn(name: string, category: ColumnCategory, sortOrder?: number): Promise<BoardColumnRecord> {
    if (name.trim() === "") {
      throw new Error("Column name must not be empty.");
    }
    if (!COLUMN_CATEGORIES.includes(category)) {
      throw new Error(`Unknown column category ${category}.`);
    }
    const existing = await this.options.store.listColumns();
    const record: BoardColumnRecord = {
      columnId: this.options.ids.columnId(),
      name: name.trim(),
      category,
      sortOrder: sortOrder ?? nextSortOrder(existing)
    };
    await this.options.store.insertColumn(record);
    return record;
  }

  async renameColumn(columnId: string, name: string): Promise<BoardColumnRecord> {
    if (name.trim() === "") {
      throw new Error("Column name must not be empty.");
    }
    const id = asId<"ColumnId">(columnId);
    const existing = await this.options.store.getColumn(id);
    if (existing === null) {
      throw new Error(`Column ${columnId} was not found.`);
    }
    await this.options.store.updateColumn(id, { name: name.trim() });
    return { ...existing, name: name.trim() };
  }

  /**
   * Reorders columns within their existing categories: `orderedColumnIds` is
   * the full, global, front-to-back column order. Each column's sortOrder is
   * rewritten to its index in that list; categories are read from storage and
   * never change here (moving a column to a different category is a separate
   * operation the board UI deliberately does not expose).
   */
  async reorder(orderedColumnIds: readonly string[]): Promise<BoardColumnRecord[]> {
    const existing = await this.options.store.listColumns();
    const byId = new Map(existing.map((column) => [column.columnId as string, column]));
    if (orderedColumnIds.length !== existing.length || !orderedColumnIds.every((id) => byId.has(id))) {
      throw new Error("Reorder must include every existing column exactly once.");
    }
    for (const [index, columnId] of orderedColumnIds.entries()) {
      await this.options.store.updateColumn(asId<"ColumnId">(columnId), { sortOrder: index });
    }
    return this.options.store.listColumns();
  }

  /**
   * Deletes a column, moving its task and subtask cards to the nearest
   * remaining column of the SAME category (nearest by sortOrder distance;
   * ties prefer the column earlier in sort order). Every category must keep
   * at least one column - deleting the last column of a category is rejected.
   */
  async deleteColumn(columnId: string): Promise<void> {
    const id = asId<"ColumnId">(columnId);
    const existing = await this.options.store.getColumn(id);
    if (existing === null) {
      throw new Error(`Column ${columnId} was not found.`);
    }
    const siblings = (await this.options.store.listColumns()).filter(
      (column) => column.category === existing.category && column.columnId !== id
    );
    if (siblings.length === 0) {
      throw new Error(`Cannot delete the last ${existing.category} column; every category needs at least one.`);
    }
    const target = nearestColumn(existing, siblings);
    await this.options.tasks.reassignTasksColumn(id, target.columnId);
    await this.options.subtasks.reassignSubtasksColumn(id, target.columnId);
    await this.options.store.deleteColumn(id);
  }
}

function nextSortOrder(existing: readonly BoardColumnRecord[]): number {
  return existing.reduce((max, column) => Math.max(max, column.sortOrder), -1) + 1;
}

/** Nearest sibling by sortOrder distance; ties prefer the lower sortOrder. */
function nearestColumn(deleted: BoardColumnRecord, siblings: readonly BoardColumnRecord[]): BoardColumnRecord {
  return siblings.reduce((closest, candidate) => {
    const closestDistance = Math.abs(closest.sortOrder - deleted.sortOrder);
    const candidateDistance = Math.abs(candidate.sortOrder - deleted.sortOrder);
    if (candidateDistance < closestDistance) {
      return candidate;
    }
    if (candidateDistance === closestDistance && candidate.sortOrder < closest.sortOrder) {
      return candidate;
    }
    return closest;
  });
}
