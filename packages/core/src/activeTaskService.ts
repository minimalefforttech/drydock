/**
 * Active-task spine.
 *
 * Exactly one task at a time is "the task this window is working on"; surfaces
 * follow it instead of each keeping a private selection. The value is durable
 * (app-state key `activeTaskId`, restored on activation) and every change is
 * announced as `active-task-changed` so subscribers never poll.
 */

import { asId, type TaskId } from "@drydock/contracts";
import type { ProductEventBus } from "./eventBus.js";

/** The slice of the app-state store this service needs. */
export interface ActiveTaskStatePort {
  getAppState(key: string): string | null;
  setAppState(key: string, value: string): void;
  deleteAppState(key: string): void;
}

export interface ActiveTaskServiceOptions {
  readonly appState: ActiveTaskStatePort;
  readonly bus: ProductEventBus;
}

export const ACTIVE_TASK_STATE_KEY = "activeTaskId";

export class ActiveTaskService {
  private activeTaskId: TaskId | null = null;

  constructor(private readonly options: ActiveTaskServiceOptions) {}

  /** Loads the persisted spine into memory; called once during backend creation. */
  restore(): void {
    const stored = this.options.appState.getAppState(ACTIVE_TASK_STATE_KEY);
    this.activeTaskId = stored === null ? null : asId<"TaskId">(stored);
  }

  get(): TaskId | null {
    return this.activeTaskId;
  }

  /** Persists and announces a new spine; an unchanged value is a no-op. */
  set(taskId: TaskId | null): void {
    if (taskId === this.activeTaskId) {
      return;
    }
    this.activeTaskId = taskId;
    if (taskId === null) {
      this.options.appState.deleteAppState(ACTIVE_TASK_STATE_KEY);
    } else {
      this.options.appState.setAppState(ACTIVE_TASK_STATE_KEY, taskId);
    }
    this.options.bus.publish({ kind: "active-task-changed", taskId });
  }
}
