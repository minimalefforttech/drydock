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

test("stop() rejects an in-flight request() directly, without waiting on the process exit event", async () => {
  const client = new LineJsonRpcClient("noop", [], ".");
  // Fakes a still-"running" child whose kill() never emits an "exit" event -
  // start() is real process spawning, which this deliberately bypasses, so
  // the only thing that can settle the pending request() below is stop()
  // itself (T4.7: it used to only reject notification waiters and rely on
  // the child's real "exit" listener for pending requests).
  (client as unknown as { child: unknown }).child = {
    exitCode: null,
    stdin: { write: (): void => {}, end: (): void => {} },
    kill: (): void => {}
  };
  const pending = client.request("probe", null, 120_000);
  await client.stop();
  // A race against a short timer, not a bare await: if stop() regresses to
  // leaving pending requests unsettled, this fails fast instead of hanging
  // the suite for up to the 120s request timeout above.
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timed-out">((resolve) => { timer = setTimeout(() => resolve("timed-out"), 1_000); });
  const outcome = await Promise.race([
    pending.then(
      () => "resolved" as const,
      () => "rejected" as const
    ),
    timedOut
  ]);
  clearTimeout(timer);
  assert.equal(outcome, "rejected", "stop() must settle in-flight requests itself rather than leaving them for the exit event");
  await assert.rejects(pending, /stopped/i);
});
