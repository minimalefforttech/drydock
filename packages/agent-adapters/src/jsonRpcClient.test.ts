/**
 * Stall-watchdog behavior for the app-server JSON-RPC client's nextNotification.
 * These exercise the timeout/abort lifecycle without spawning a process: an
 * idle waiter only touches the client's queue and timer bookkeeping.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { LineJsonRpcClient, NotificationTimeoutError } from "./jsonRpcClient.js";

test("nextNotification rejects with NotificationTimeoutError after the inactivity window", async () => {
  const client = new LineJsonRpcClient("noop", [], ".");
  await assert.rejects(
    () => client.nextNotification(undefined, 30),
    (error: unknown) => error instanceof NotificationTimeoutError && error.timeoutMs === 30
  );
});

test("an already-aborted signal rejects as aborted, never as a timeout", async () => {
  const client = new LineJsonRpcClient("noop", [], ".");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => client.nextNotification(controller.signal, 1000),
    (error: unknown) => error instanceof Error && /aborted/i.test(error.message) && !(error instanceof NotificationTimeoutError)
  );
});

test("timeoutMs=0 installs no stall timeout - a later abort still wins", async () => {
  const client = new LineJsonRpcClient("noop", [], ".");
  const controller = new AbortController();
  const pending = client.nextNotification(controller.signal, 0);
  const timer = setTimeout(() => controller.abort(), 20);
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof Error && /aborted/i.test(error.message) && !(error instanceof NotificationTimeoutError)
  );
  clearTimeout(timer);
});
