/**
 * Roll-up precedence tests (UX overhaul, P1). The precedence is a product
 * decision (awaiting outranks failed), so it is pinned here.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  rollupTaskStatus,
  sessionRollupStatus,
  subtaskRollupStatus,
  TASK_ROLLUP_STATUSES,
  type TaskRollupStatus
} from "./taskStatus.js";

test("rollupTaskStatus follows awaiting > failed > running > starting/queued > idle > done/offline", () => {
  assert.equal(rollupTaskStatus(["done", "failed", "awaiting"]), "awaiting");
  assert.equal(rollupTaskStatus(["running", "failed", "idle"]), "failed");
  assert.equal(rollupTaskStatus(["idle", "running", "queued"]), "running");
  assert.equal(rollupTaskStatus(["idle", "queued"]), "queued");
  assert.equal(rollupTaskStatus(["idle", "starting"]), "starting");
  assert.equal(rollupTaskStatus(["done", "idle", "offline"]), "idle");
  assert.equal(rollupTaskStatus(["done", "offline"]), "done");
  assert.equal(rollupTaskStatus(["offline", "done"]), "offline");
});

test("rollupTaskStatus is offline for a task with no children", () => {
  assert.equal(rollupTaskStatus([]), "offline");
});

test("rollupTaskStatus is order-independent across ranks", () => {
  const shuffled: TaskRollupStatus[] = [...TASK_ROLLUP_STATUSES].reverse();
  assert.equal(rollupTaskStatus(shuffled), "awaiting");
  assert.equal(rollupTaskStatus([...TASK_ROLLUP_STATUSES]), "awaiting");
});

test("sessionRollupStatus puts attention above every stored status", () => {
  assert.equal(sessionRollupStatus({ status: "failed", needsAttention: true }), "awaiting");
  assert.equal(sessionRollupStatus({ status: "active", live: true, turnActive: true, needsAttention: true }), "awaiting");
});

test("sessionRollupStatus keeps liveness honest", () => {
  // Stored-active but no live backend in any window: offline, never running.
  assert.equal(sessionRollupStatus({ status: "active" }), "offline");
  assert.equal(sessionRollupStatus({ status: "active", live: true }), "idle");
  assert.equal(sessionRollupStatus({ status: "active", live: true, turnActive: true }), "running");
  // A session running in another window is still alive (view-only here).
  assert.equal(sessionRollupStatus({ status: "active", runningElsewhere: true, turnActive: true }), "running");
  assert.equal(sessionRollupStatus({ status: "starting" }), "starting");
  assert.equal(sessionRollupStatus({ status: "failed" }), "failed");
  assert.equal(sessionRollupStatus({ status: "ended" }), "done");
});

test("subtaskRollupStatus maps board flags onto the shared vocabulary", () => {
  assert.equal(subtaskRollupStatus({ verifyUnmet: true, isRunning: true }), "awaiting");
  assert.equal(subtaskRollupStatus({ isParked: true, isRunning: true }), "failed");
  assert.equal(subtaskRollupStatus({ isRunning: true, isQueued: true }), "running");
  assert.equal(subtaskRollupStatus({ isQueued: true }), "queued");
  assert.equal(subtaskRollupStatus({ doneAt: "2026-08-02T10:00:00.000Z" }), "done");
  assert.equal(subtaskRollupStatus({}), "idle");
});
