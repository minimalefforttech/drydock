/**
 * In-memory capture of the raw agent stream for the CURRENT turn only.
 *
 * This is a debug aid, not durable history: each turn overwrites the previous
 * one (`beginTurn`) and the buffer is tail-capped, so memory stays bounded even
 * with hundreds of live sessions. The chat tab reads a session's snapshot on
 * demand to show "what the sandbox process is emitting right now" plus a
 * last-activity timestamp for the running indicator.
 *
 * Adapters write here at the exact seam where the raw frames already exist -
 * Claude's buffered `result.stdout`, each Codex app-server notification - so no
 * process plumbing changes are needed.
 */

import type { SessionId } from "@drydock/contracts";
import type { Clock } from "./clock.js";

/** Write port handed to the agent adapters; keeps them decoupled from the store. */
export interface RawStreamSink {
  /** Resets the session's buffer at the start of a new turn. */
  beginTurn(sessionId: SessionId): void;
  /** Appends raw output; the store tail-caps and stamps last-activity time. */
  write(sessionId: SessionId, text: string): void;
}

export interface RawStreamSnapshot {
  readonly text: string;
  /** ISO time of the most recent write - drives "seconds since last response". */
  readonly lastChunkAt: string;
}

const DEFAULT_MAX_CHARS = 64_000;

export class SessionRawStreamStore implements RawStreamSink {
  private readonly buffers = new Map<string, { text: string; lastChunkAt: string }>();

  constructor(
    private readonly clock: Clock,
    private readonly maxChars: number = DEFAULT_MAX_CHARS
  ) {}

  beginTurn(sessionId: SessionId): void {
    this.buffers.set(String(sessionId), { text: "", lastChunkAt: this.clock.isoNow() });
  }

  write(sessionId: SessionId, text: string): void {
    if (text.length === 0) {
      return;
    }
    const key = String(sessionId);
    const current = this.buffers.get(key)?.text ?? "";
    let next = current + text;
    if (next.length > this.maxChars) {
      // Keep the TAIL: a hang shows up at the end of the stream, so the most
      // recent output is the part worth surfacing.
      next = next.slice(next.length - this.maxChars);
    }
    this.buffers.set(key, { text: next, lastChunkAt: this.clock.isoNow() });
  }

  snapshot(sessionId: SessionId | string): RawStreamSnapshot | null {
    const entry = this.buffers.get(String(sessionId));
    return entry === undefined ? null : { text: entry.text, lastChunkAt: entry.lastChunkAt };
  }

  clear(sessionId: SessionId | string): void {
    this.buffers.delete(String(sessionId));
  }
}
