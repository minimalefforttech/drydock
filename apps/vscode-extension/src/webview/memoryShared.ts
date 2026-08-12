/**
 * Shared memory projections for the panel hosts (ADR 0019, surfaced per ADR
 * 0020 in Configure › Memories).
 *
 * Two hosts answer the `memory.*` contracts - the chat-side dispatch
 * (`controlPanelProvider`) and the Configure panel - and both must ship the
 * exact same display-safe summary and resolve approval-time edits to the same
 * anchors. Extracted here (the boardShared/hubShared pattern) so the
 * projection cannot fork between hosts. vscode-free on purpose: the anchor
 * lookups arrive as narrow ports, unit-tested with plain fakes.
 *
 * SECURITY: `toMemoryCandidateSummary` is the display boundary - resolvedAt
 * and workspace root PATHS stay host-side (the label carries folder
 * basenames, never locations).
 */

import type {
  MemoryCandidateEdits,
  MemoryCandidateRecord,
  MemoryCandidateSummary,
  MemoryEditsInput,
  MemoryScope
} from "@drydock/contracts";
import type { BackendReady } from "../compositionRoot.js";

/**
 * Display-safe projection of a memory; resolvedAt and workspace root PATHS are
 * host-only (the label carries folder basenames, not locations).
 */
export function toMemoryCandidateSummary(record: MemoryCandidateRecord, taskTitles?: ReadonlyMap<string, string>): MemoryCandidateSummary {
  const scope = record.scope ?? "global";
  let scopeLabel: string | undefined;
  if (scope === "task" && record.scopeTaskId !== undefined) {
    scopeLabel = taskTitles?.get(record.scopeTaskId) ?? record.scopeTaskId;
  } else if (scope === "workspace" && record.scopeRoots !== undefined && record.scopeRoots.length > 0) {
    scopeLabel = record.scopeRoots
      .map((root) => root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? root)
      .join(", ");
  }
  return {
    memoryCandidateId: record.memoryCandidateId,
    sessionId: record.sessionId,
    content: record.content,
    status: record.status,
    createdAt: record.createdAt,
    scope,
    ...(scopeLabel === undefined ? {} : { scopeLabel }),
    tags: record.tags ?? [],
    origin: record.origin ?? "agent"
  };
}

/** taskId → title, for memory scope labels. Best-effort: empty map on failure. */
export async function memoryTaskTitles(
  listTasks: () => Promise<readonly { readonly taskId: string; readonly title: string }[]>
): Promise<ReadonlyMap<string, string>> {
  try {
    return new Map((await listTasks()).map((task) => [task.taskId, task.title]));
  } catch {
    return new Map();
  }
}

/** The narrow host lookups approval-time edit resolution needs. */
export interface MemoryAnchorPorts {
  /** The candidate being resolved, for its source session id. */
  getCandidate(memoryCandidateId: string): Promise<{ readonly sessionId: string } | null>;
  /** Task summaries with linked sessions - the task-scope anchor lookup. */
  listTaskSummaries(): Promise<readonly { readonly taskId: string; readonly linkedSessionIds: readonly string[] }[]>;
  /** The source session's mounted roots; undefined when unknown. */
  sessionRoots(sessionId: string): Promise<readonly string[] | undefined>;
}

/** Binds the anchor lookups to the live backend; both panel hosts share it. */
export function memoryAnchorPorts(backend: BackendReady): MemoryAnchorPorts {
  return {
    getCandidate: (memoryCandidateId) => backend.memory.getCandidate(memoryCandidateId),
    listTaskSummaries: () => backend.tasks.listTaskSummaries(),
    sessionRoots: async (sessionId) => {
      const stored = await backend.appService.getChatSession(sessionId).catch(() => null);
      return stored?.workspaceRoots;
    }
  };
}

/**
 * Resolves webview-side approval edits (scope kind + tags + content) into
 * store-level edits with real anchors: task scope anchors to the source
 * session's linked task, workspace scope to the source session's mounted
 * roots (falling back to the window's open folders).
 */
export async function resolveMemoryEdits(
  ports: MemoryAnchorPorts,
  memoryCandidateId: string,
  edits: MemoryEditsInput | undefined,
  fallbackRoots: readonly string[]
): Promise<MemoryCandidateEdits | undefined> {
  if (edits === undefined) return undefined;
  const resolved: {
    content?: string;
    scope?: MemoryScope;
    scopeTaskId?: string;
    scopeRoots?: readonly string[];
    tags?: readonly string[];
  } = {
    ...(edits.content === undefined ? {} : { content: edits.content }),
    ...(edits.tags === undefined ? {} : { tags: edits.tags })
  };
  if (edits.scope !== undefined) {
    resolved.scope = edits.scope;
    const existing = await ports.getCandidate(memoryCandidateId);
    const sourceSessionId = existing?.sessionId;
    if (edits.scope === "task" && sourceSessionId !== undefined) {
      const tasks = await ports.listTaskSummaries();
      const owner = tasks.find((task) => task.linkedSessionIds.includes(sourceSessionId));
      if (owner !== undefined) resolved.scopeTaskId = owner.taskId;
    } else if (edits.scope === "workspace") {
      const stored = sourceSessionId === undefined || sourceSessionId === "user"
        ? undefined
        : await ports.sessionRoots(sourceSessionId);
      const roots = stored !== undefined && stored.length > 0 ? stored : fallbackRoots;
      if (roots.length > 0) resolved.scopeRoots = roots;
    }
  }
  return resolved;
}
