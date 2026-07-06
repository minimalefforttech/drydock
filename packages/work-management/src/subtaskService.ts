/**
 * Subtask service (task board and subtasks).
 *
 * Subtasks are child work items of exactly one task; dependencies are
 * directed edges between two subtasks of that SAME task, validated here
 * (same-task, no self-edge, no duplicate, acyclic). Card movement (moveCard)
 * stamps/clears doneAt on entering/leaving a done-category column; "blocked"
 * is always computed, never stored. Persistence lives in the stores.
 */

import { asId } from "@drydock/contracts";
import type {
  BoardColumnRecord,
  BoardColumnStore,
  ColumnId,
  SubtaskDependencyRecord,
  SubtaskId,
  SubtaskRecord,
  SubtaskStore,
  TaskId,
  WorkTaskRecord,
  WorkTaskStore
} from "@drydock/contracts";
import type { Clock, IdGenerator, ProductEventBus } from "@drydock/core";

export interface SubtaskServiceOptions {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly store: SubtaskStore;
  readonly tasks: WorkTaskStore;
  readonly columns: BoardColumnStore;
  /**
   * Optional: publishes "card-entered-done" (subtask transitions into a
   * done-category column, manual moves included) and "board-changed" (after
   * any successful create/update/delete/moveCard) for the orchestrator and UI
   * to react to. Omitted in most existing tests — every publish is guarded so
   * the service works identically without a bus.
   */
  readonly bus?: ProductEventBus;
}

export interface SubtaskCreateInput {
  readonly title: string;
  readonly description?: string;
  readonly prompt?: string;
  readonly origin?: "manual" | "review";
  /**
   * opt-in cascade: start when dependencies finish (default false). A
   * dependent auto-starts only when this is set AND all upstreams are done
   * AND it has a prompt AND it is not in a backlog-category column; manual
   * start never runs dependencies (Force start override, manual only). The
   * cascade lives in subtaskOrchestrator.ts — this is just the flag.
   */
  readonly autoStart?: boolean;
  /** Defaults to the first backlog-category column when omitted. */
  readonly columnId?: string;
}

export interface SubtaskUpdateInput {
  readonly title?: string;
  /** "" clears the description to null; a string overwrites it. */
  readonly description?: string;
  /** "" clears the prompt to null; a string overwrites it. */
  readonly prompt?: string;
  readonly autoStart?: boolean;
}

/** One card reference: exactly one of taskId/subtaskId is set. */
export type CardRef = { readonly taskId: string } | { readonly subtaskId: string };

export class SubtaskService {
  constructor(private readonly options: SubtaskServiceOptions) {}

  async createSubtask(taskId: string, input: SubtaskCreateInput): Promise<SubtaskRecord> {
    if (input.title.trim() === "") {
      throw new Error("Subtask title must not be empty.");
    }
    const owningTaskId = asId<"TaskId">(taskId);
    if (await this.options.tasks.getTask(owningTaskId) === null) {
      throw new Error(`Task ${taskId} was not found.`);
    }
    const columnId = input.columnId !== undefined
      ? asId<"ColumnId">(input.columnId)
      : (await this.firstColumnOfCategory("backlog")).columnId;
    const siblingCount = (await this.options.store.listForTask(owningTaskId)).length;
    const now = this.options.clock.isoNow();
    const record: SubtaskRecord = {
      subtaskId: this.options.ids.subtaskId(),
      taskId: owningTaskId,
      title: input.title.trim(),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      origin: input.origin ?? "manual",
      autoStart: input.autoStart ?? false,
      columnId,
      sortOrder: siblingCount,
      createdAt: now,
      updatedAt: now
    };
    await this.options.store.insertSubtask(record);
    this.options.bus?.publish({ kind: "board-changed" });
    return record;
  }

  async updateSubtask(subtaskId: string, input: SubtaskUpdateInput): Promise<SubtaskRecord> {
    if (input.title === undefined && input.description === undefined && input.prompt === undefined && input.autoStart === undefined) {
      throw new Error("Subtask update must change at least one field.");
    }
    if (input.title !== undefined && input.title.trim() === "") {
      throw new Error("Subtask title must not be empty.");
    }
    const id = asId<"SubtaskId">(subtaskId);
    const existing = await this.options.store.getSubtask(id);
    if (existing === null) {
      throw new Error(`Subtask ${subtaskId} was not found.`);
    }
    await this.options.store.updateSubtask(id, {
      updatedAt: this.options.clock.isoNow(),
      ...(input.title === undefined ? {} : { title: input.title.trim() }),
      // "" clears the description/prompt; the store maps null to a NULL column.
      ...(input.description === undefined ? {} : { description: input.description === "" ? null : input.description }),
      ...(input.prompt === undefined ? {} : { prompt: input.prompt === "" ? null : input.prompt }),
      ...(input.autoStart === undefined ? {} : { autoStart: input.autoStart })
    });
    const updated = await this.options.store.getSubtask(id);
    if (updated === null) {
      throw new Error(`Subtask ${subtaskId} vanished during update.`);
    }
    this.options.bus?.publish({ kind: "board-changed" });
    return updated;
  }

  async deleteSubtask(subtaskId: string): Promise<void> {
    await this.options.store.deleteSubtask(asId<"SubtaskId">(subtaskId));
    this.options.bus?.publish({ kind: "board-changed" });
  }

  getSubtask(subtaskId: string): Promise<SubtaskRecord | null> {
    return this.options.store.getSubtask(asId<"SubtaskId">(subtaskId));
  }

  listForTask(taskId: string): Promise<SubtaskRecord[]> {
    return this.options.store.listForTask(asId<"TaskId">(taskId));
  }

  listAll(): Promise<SubtaskRecord[]> {
    return this.options.store.listAll();
  }

  /**
   * Adds a dependency edge. Validated: both endpoints share taskId, no
   * self-edge, no duplicate edge, and the edge must not create a cycle
   * (checked via DFS over the task's existing edges plus this candidate).
   */
  async addDependency(fromSubtaskId: string, toSubtaskId: string): Promise<SubtaskDependencyRecord> {
    const fromId = asId<"SubtaskId">(fromSubtaskId);
    const toId = asId<"SubtaskId">(toSubtaskId);
    if (fromId === toId) {
      throw new Error("SUBTASK_DEPENDENCY_SELF_EDGE: a subtask cannot depend on itself.");
    }
    const from = await this.options.store.getSubtask(fromId);
    const to = await this.options.store.getSubtask(toId);
    if (from === null) {
      throw new Error(`Subtask ${fromSubtaskId} was not found.`);
    }
    if (to === null) {
      throw new Error(`Subtask ${toSubtaskId} was not found.`);
    }
    if (from.taskId !== to.taskId) {
      throw new Error("SUBTASK_DEPENDENCY_CROSS_TASK: a dependency cannot cross tasks.");
    }
    const existingEdges = await this.options.store.listDependenciesForTask(from.taskId);
    if (existingEdges.some((edge) => edge.fromSubtaskId === fromId && edge.toSubtaskId === toId)) {
      throw new Error("SUBTASK_DEPENDENCY_DUPLICATE: this dependency already exists.");
    }
    if (createsCycle(existingEdges, fromId, toId)) {
      throw new Error("SUBTASK_DEPENDENCY_CYCLE: this dependency would create a cycle.");
    }
    const record: SubtaskDependencyRecord = {
      taskId: from.taskId,
      fromSubtaskId: fromId,
      toSubtaskId: toId,
      createdAt: this.options.clock.isoNow()
    };
    await this.options.store.insertDependency(record);
    this.options.bus?.publish({ kind: "board-changed" });
    return record;
  }

  async removeDependency(fromSubtaskId: string, toSubtaskId: string): Promise<void> {
    await this.options.store.removeDependency(asId<"SubtaskId">(fromSubtaskId), asId<"SubtaskId">(toSubtaskId));
    this.options.bus?.publish({ kind: "board-changed" });
  }

  listDependenciesForTask(taskId: string): Promise<SubtaskDependencyRecord[]> {
    return this.options.store.listDependenciesForTask(asId<"TaskId">(taskId));
  }

  /**
   * Moves a task or subtask card to columnId, stamping doneAt when the
   * destination column is in the `done` category and clearing it otherwise
   * (entering a non-done column always clears any prior doneAt).
   */
  async moveCard(card: CardRef, columnId: string): Promise<WorkTaskRecord | SubtaskRecord> {
    const destination = await this.options.columns.getColumn(asId<"ColumnId">(columnId));
    if (destination === null) {
      throw new Error(`Column ${columnId} was not found.`);
    }
    const doneAt = destination.category === "done" ? this.options.clock.isoNow() : null;
    if ("taskId" in card) {
      const id = asId<"TaskId">(card.taskId);
      const existing = await this.options.tasks.getTask(id);
      if (existing === null) {
        throw new Error(`Task ${card.taskId} was not found.`);
      }
      await this.options.tasks.updateTask(id, {
        updatedAt: this.options.clock.isoNow(),
        columnId: destination.columnId,
        doneAt
      });
      const updated = await this.options.tasks.getTask(id);
      if (updated === null) {
        throw new Error(`Task ${card.taskId} vanished during move.`);
      }
      this.options.bus?.publish({ kind: "board-changed" });
      return updated;
    }
    const id = asId<"SubtaskId">(card.subtaskId);
    const existing = await this.options.store.getSubtask(id);
    if (existing === null) {
      throw new Error(`Subtask ${card.subtaskId} was not found.`);
    }
    await this.options.store.updateSubtask(id, {
      updatedAt: this.options.clock.isoNow(),
      columnId: destination.columnId,
      doneAt
    });
    const updated = await this.options.store.getSubtask(id);
    if (updated === null) {
      throw new Error(`Subtask ${card.subtaskId} vanished during move.`);
    }
    // Fires for EVERY transition into a done-category column, manual drags
    // included (the doc's "manual drags always win / trigger dependent
    // evaluation" rule) — not just orchestrator-driven completions.
    if (destination.category === "done") {
      this.options.bus?.publish({ kind: "card-entered-done", taskId: updated.taskId, subtaskId: updated.subtaskId });
    }
    this.options.bus?.publish({ kind: "board-changed" });
    return updated;
  }

  /**
   * A subtask is blocked iff any upstream dependency's subtask is NOT
   * currently sitting in a done-category column. Computed, never stored.
   * `columnsById` and `subtasksById` are supplied by the caller (usually
   * pre-fetched once for a whole task/board render) to avoid refetching per
   * subtask; pass fresh maps to avoid stale category/column reads.
   */
  isBlocked(
    subtaskId: SubtaskId,
    dependencies: readonly SubtaskDependencyRecord[],
    subtasksById: ReadonlyMap<SubtaskId, SubtaskRecord>,
    columnsById: ReadonlyMap<ColumnId, BoardColumnRecord>
  ): boolean {
    const upstreamIds = dependencies
      .filter((edge) => edge.toSubtaskId === subtaskId)
      .map((edge) => edge.fromSubtaskId);
    return upstreamIds.some((upstreamId) => {
      const upstream = subtasksById.get(upstreamId);
      if (upstream === undefined) {
        return false;
      }
      const column = columnsById.get(upstream.columnId);
      return column === undefined || column.category !== "done";
    });
  }

  private async firstColumnOfCategory(category: BoardColumnRecord["category"]): Promise<BoardColumnRecord> {
    const columns = (await this.options.columns.listColumns()).filter((column) => column.category === category);
    const first = columns[0];
    if (first === undefined) {
      throw new Error(`No column exists in category ${category}.`);
    }
    return first;
  }
}

/**
 * DFS cycle check: would adding fromId -> toId create a path back from toId
 * to fromId through the existing edge set? Existing edges are already
 * guaranteed acyclic (each was validated on insert), so it suffices to check
 * whether fromId is reachable from toId.
 */
function createsCycle(existingEdges: readonly SubtaskDependencyRecord[], fromId: SubtaskId, toId: SubtaskId): boolean {
  const adjacency = new Map<SubtaskId, SubtaskId[]>();
  for (const edge of existingEdges) {
    const list = adjacency.get(edge.fromSubtaskId);
    if (list === undefined) {
      adjacency.set(edge.fromSubtaskId, [edge.toSubtaskId]);
    } else {
      list.push(edge.toSubtaskId);
    }
  }
  const visited = new Set<SubtaskId>();
  const stack: SubtaskId[] = [toId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || visited.has(current)) {
      continue;
    }
    visited.add(current);
    if (current === fromId) {
      return true;
    }
    for (const next of adjacency.get(current) ?? []) {
      stack.push(next);
    }
  }
  return false;
}
