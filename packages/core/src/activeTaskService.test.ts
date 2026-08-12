/**
 * Unit tests for the active-task spine: persistence, no-op on an unchanged
 * value, restore, and one publish per real change reaching every subscriber.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { asId, type TaskId } from "@drydock/contracts";
import { ACTIVE_TASK_STATE_KEY, ActiveTaskService, type ActiveTaskStatePort } from "./activeTaskService.js";
import { ProductEventBus, type ProductBusEvent } from "./eventBus.js";

function makeAppState(seed?: string): ActiveTaskStatePort & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  if (seed !== undefined) values.set(ACTIVE_TASK_STATE_KEY, seed);
  return {
    values,
    getAppState: (key: string) => values.get(key) ?? null,
    setAppState: (key: string, value: string) => { values.set(key, value); },
    deleteAppState: (key: string) => { values.delete(key); }
  };
}

test("set persists the spine, publishes once, and clears on null", () => {
  const appState = makeAppState();
  const bus = new ProductEventBus();
  const seen: ProductBusEvent[] = [];
  bus.subscribe((event) => seen.push(event));
  const service = new ActiveTaskService({ appState, bus });

  assert.equal(service.get(), null);
  service.set(asId<"TaskId">("task-1"));
  assert.equal(service.get(), "task-1");
  assert.equal(appState.values.get(ACTIVE_TASK_STATE_KEY), "task-1");
  assert.deepEqual(seen, [{ kind: "active-task-changed", taskId: "task-1" }]);

  // Setting the same task again is a no-op: no write, no publish.
  service.set(asId<"TaskId">("task-1"));
  assert.equal(seen.length, 1);

  service.set(null);
  assert.equal(service.get(), null);
  assert.equal(appState.values.has(ACTIVE_TASK_STATE_KEY), false);
  assert.deepEqual(seen[1], { kind: "active-task-changed", taskId: null });
});

test("restore reads the persisted spine and two subscribers observe one set", () => {
  const appState = makeAppState("task-restored");
  const bus = new ProductEventBus();
  const service = new ActiveTaskService({ appState, bus });

  service.restore();
  assert.equal(service.get(), "task-restored");

  const first: (TaskId | null)[] = [];
  const second: (TaskId | null)[] = [];
  bus.subscribe((event) => { if (event.kind === "active-task-changed") first.push(event.taskId); });
  bus.subscribe((event) => { if (event.kind === "active-task-changed") second.push(event.taskId); });

  service.set(asId<"TaskId">("task-next"));
  assert.deepEqual(first, ["task-next"]);
  assert.deepEqual(second, ["task-next"]);
});
