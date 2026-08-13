/**
 * summarizeStoredEvent must never throw: getChatTimeline maps it over every
 * row in a session's replay, so one legacy/corrupt/future-shape row has to
 * degrade instead of failing the whole transcript load (audit T3.7,
 * docs/design/audit-2026-08-13-handoff.md).
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { summarizeStoredEvent } from "./events.js";
import type { StoredEvent } from "./events.js";
import { asId } from "./ids.js";

function baseStoredEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    id: asId<"EventId">("event-1"),
    sessionId: asId<"SessionId">("session-1"),
    eventType: "agent.text",
    createdAt: "2026-08-13T00:00:00.000Z",
    payload: { type: "agent.text", createdAt: "2026-08-13T00:00:00.000Z", text: "hi", final: true },
    ...overrides
  };
}

test("summarizeStoredEvent degrades an unrecognized future/legacy event_type instead of throwing", () => {
  const event = baseStoredEvent({ eventType: "agent.some_future_type", payload: { anything: "goes" } });
  const line = summarizeStoredEvent(event);
  assert.equal(line.eventType, "agent.some_future_type");
  assert.match(line.summary, /Unrecognized event/);
  assert.match(line.summary, /agent\.some_future_type/);
});

test("summarizeStoredEvent degrades a recognized event_type whose payload is corrupt/legacy-shaped", () => {
  // agent.command's summary reads event.command[0] - a payload missing that
  // array (an older schema, or a hand-corrupted row) throws a plain
  // TypeError deep inside summarizeAgentEvent, not assertNever. This must
  // degrade the same way as an unrecognized type, not escape the try/catch.
  const event = baseStoredEvent({
    eventType: "agent.command",
    payload: { type: "agent.command", createdAt: "2026-08-13T00:00:00.000Z", status: "started" }
  });
  const line = summarizeStoredEvent(event);
  assert.equal(line.eventType, "agent.command");
  assert.match(line.summary, /Unrecognized event/);
});

test("summarizeStoredEvent still renders a recognized, well-formed event normally", () => {
  const line = summarizeStoredEvent(baseStoredEvent());
  assert.equal(line.eventType, "agent.text");
  assert.equal(line.summary, "hi");
});

test("summarizeStoredEvent still renders the user's own message in full, unclipped", () => {
  const event = baseStoredEvent({ eventType: "user.message", payload: { text: "hello there" } });
  const line = summarizeStoredEvent(event);
  assert.equal(line.eventType, "user.message");
  assert.equal(line.summary, "hello there");
});
