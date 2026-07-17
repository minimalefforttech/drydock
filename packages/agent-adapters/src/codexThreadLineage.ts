/**
 * Per-session codex thread lineage (see docs/adr/0002-product-owned-orchestration.md).
 *
 * The app-server multiplexes every thread's notifications onto one
 * connection: the session's root thread plus any collab-agent child threads
 * it spawns (probe 2026-07-05: three threads in one turn). This state maps a
 * notification's threadId to the emitting agent's `agentPath`, tracks
 * per-thread token usage so it can be attached to the child's terminal
 * event, and gates terminal emission so wait/close/turn signals produce one
 * `agent.node_done` per child, not three.
 */

import type { JsonObject } from "@drydock/contracts";

export { capPreview, NODE_RESULT_PREVIEW_MAX, SPAWN_PROMPT_PREVIEW_MAX } from "./previewCaps.js";

export class CodexThreadLineage {
  private readonly paths = new Map<string, readonly string[]>();
  private readonly lastUsage = new Map<string, JsonObject>();
  private readonly terminal = new Set<string>();

  constructor(private readonly rootThreadId: string) {}

  /** Absent threadIds are treated as root: pre-collab notifications omit it. */
  isRoot(threadId: string | undefined): boolean {
    return threadId === undefined || threadId === this.rootThreadId;
  }

  /** Registers a spawn edge; idempotent (first registration wins the parent). */
  registerChild(childThreadId: string, parentThreadId: string | undefined): readonly string[] {
    const existing = this.paths.get(childThreadId);
    if (existing !== undefined) return existing;
    const parentPath = this.pathFor(parentThreadId) ?? [];
    const path = [...parentPath, childThreadId];
    this.paths.set(childThreadId, path);
    return path;
  }

  /** Root → []; registered child → its path; unknown → undefined. */
  pathFor(threadId: string | undefined): readonly string[] | undefined {
    if (this.isRoot(threadId)) return [];
    return this.paths.get(threadId as string);
  }

  /**
   * Attribution never drops: an item on a thread we never saw spawned still
   * gets a stable node under root (the real thread id stays the node id so a
   * late-arriving spawn edge merges instead of forking).
   */
  attributionFor(threadId: string | undefined): readonly string[] {
    return this.pathFor(threadId) ?? this.registerChild(threadId as string, undefined);
  }

  noteUsage(threadId: string, usage: JsonObject): void {
    this.lastUsage.set(threadId, usage);
  }

  usageFor(threadId: string): JsonObject | undefined {
    return this.lastUsage.get(threadId);
  }

  /** True exactly once per child - the caller may emit its node_done. */
  markTerminal(threadId: string): boolean {
    if (this.terminal.has(threadId)) return false;
    this.terminal.add(threadId);
    return true;
  }
}

/** collab agentsStates status → normalized terminal status; null = still running. */
export function terminalStatusFrom(status: string | null): "completed" | "failed" | "cancelled" | null {
  if (status === "completed") return "completed";
  if (status === "errored") return "failed";
  if (status === "interrupted" || status === "shutdown" || status === "notFound"
    || status === "not_found") return "cancelled";
  return null;
}

/** Display label for a spawned agent: first prompt line, else the id tail. */
export function spawnLabel(prompt: string | null, threadId: string): string {
  if (prompt !== null) {
    const firstLine = prompt.split(/\r?\n/, 1)[0]?.trim() ?? "";
    if (firstLine.length > 0) {
      return firstLine.length > 48 ? `${firstLine.slice(0, 48)}…` : firstLine;
    }
  }
  return `agent ${threadId.slice(-8)}`;
}
