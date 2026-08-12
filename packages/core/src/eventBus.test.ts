/**
 * Unit tests for the product bus and the boot-stage reporter.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { asId, type SessionId } from "@drydock/contracts";
import { BootStageReporter, ProductEventBus, type BootStage, type ProductBusEvent } from "./eventBus.js";

const SESSION: SessionId = asId<"SessionId">("session-boot");

function collect(bus: ProductEventBus): BootStage[] {
  const stages: BootStage[] = [];
  bus.subscribe((event: ProductBusEvent) => {
    if (event.kind !== "boot-progress") return;
    assert.equal(event.sessionId, SESSION);
    stages.push(event.stage);
  });
  return stages;
}

test("boot stages publish in order and never repeat", () => {
  const bus = new ProductEventBus();
  const stages = collect(bus);
  const reporter = new BootStageReporter(bus, SESSION);

  reporter.stage("create");
  reporter.stage("clone");
  // A shared seam can report defensively; the timeline must not stutter.
  reporter.stage("clone");
  reporter.stage("start");

  assert.deepEqual(stages, ["create", "clone", "start"]);
});

test("a reporter without a bus is inert, and a throwing subscriber never reaches the boot", () => {
  assert.doesNotThrow(() => new BootStageReporter(undefined, SESSION).stage("create"));

  const bus = new ProductEventBus();
  bus.subscribe(() => {
    throw new Error("subscriber exploded");
  });
  const stages = collect(bus);
  const reporter = new BootStageReporter(bus, SESSION);

  assert.doesNotThrow(() => reporter.stage("create"));
  // The surviving subscriber still saw it: handlers are isolated from each other.
  assert.deepEqual(stages, ["create"]);
});
