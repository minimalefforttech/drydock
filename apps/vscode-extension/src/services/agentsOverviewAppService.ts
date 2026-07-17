/**
 * Agents panel overview assembly (ADR 0013).
 *
 * Pure projection: joins sessions onto tasks (via task links, with unlinked
 * role children grafted under their nearest linked ancestor), collects the
 * leftovers into the orphan drawer, and carries the pending "waiting on you"
 * sets. No new storage, no ordering policy - ordering is presentation and
 * lives in the webview, so this stays a dumb, deterministic join that unit
 * tests can pin exactly.
 */

import type {
  AccessRequestSummary,
  AgentQuestionSummary,
  AgentsOverviewState,
  AgentsTaskGroup,
  ChatSessionRecord,
  ChatSessionSummary,
  ColumnCategory,
  LandingItem,
  TaskChangesetRecord,
  WorkTaskSummary
} from "@drydock/contracts";

/** The one board-column slice the fleet header chip needs. */
export interface AgentsOverviewColumn {
  readonly columnId: string;
  readonly name: string;
  readonly category: ColumnCategory;
}

/**
 * Narrow ports so tests drive the assembly with plain fakes. The provider
 * adapts the real backend: sessions from IsolatedRunService, tasks/columns
 * from the work-management services, pendings from the question/access
 * services, and decoration through the same summary path the sidebar uses.
 */
export interface AgentsOverviewPorts {
  listSessions(): Promise<readonly ChatSessionRecord[]>;
  listTaskSummaries(): Promise<readonly WorkTaskSummary[]>;
  listColumns(): Promise<readonly AgentsOverviewColumn[]>;
  listPendingQuestions(): Promise<readonly AgentQuestionSummary[]>;
  listPendingAccessRequests(): Promise<readonly AccessRequestSummary[]>;
  /** MUST be the sidebar's decoration (live, runningElsewhere, agentActivity). */
  decorateSession(record: ChatSessionRecord): ChatSessionSummary;
  /** Unlanded changeset rows for the Landing drawer (ADR 0014); optional port. */
  listUnlandedChangesets?(): Promise<readonly TaskChangesetRecord[]>;
  now(): string;
  agentIdleThresholdMs(): number;
}

/**
 * Folds unlanded changeset rows into Landing rows: one per subtask, overlap
 * computed by path-set intersection across subtasks (rows without stored
 * paths make a pair's overlap UNKNOWN - flagged, never assumed disjoint).
 * Disjoint-first ordering, oldest capture first within each class.
 */
export function buildLandingItems(
  rows: readonly TaskChangesetRecord[],
  tasks: readonly WorkTaskSummary[]
): LandingItem[] {
  const bySubtask = new Map<string, TaskChangesetRecord[]>();
  for (const row of rows) {
    const bucket = bySubtask.get(row.subtaskId as string);
    if (bucket === undefined) bySubtask.set(row.subtaskId as string, [row]);
    else bucket.push(row);
  }
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const pathSets = new Map<string, Set<string> | null>();
  for (const [subtaskId, group] of bySubtask) {
    // Paths are namespaced by repo so same-named files in different repos
    // never collide; a single missing path list poisons the whole set (null
    // = unknown).
    let set: Set<string> | null = new Set<string>();
    for (const row of group) {
      if (row.paths === undefined) {
        set = null;
        break;
      }
      for (const path of row.paths) set.add(`${row.repoName}:${path}`);
    }
    pathSets.set(subtaskId, set);
  }

  const items: LandingItem[] = [];
  for (const [subtaskId, group] of bySubtask) {
    const first = group[0];
    if (first === undefined) continue;
    const task = taskById.get(first.taskId as string);
    const subtask = task?.subtasks.find((candidate) => candidate.subtaskId === subtaskId);
    const own = pathSets.get(subtaskId) ?? null;
    const overlapsWith: string[] = [];
    let overlapUnknown = own === null;
    for (const [otherId, otherSet] of pathSets) {
      if (otherId === subtaskId) continue;
      if (own === null || otherSet === null) {
        overlapUnknown = true;
        continue;
      }
      for (const path of own) {
        if (otherSet.has(path)) {
          overlapsWith.push(otherId);
          break;
        }
      }
    }
    items.push({
      taskId: first.taskId as string,
      taskTitle: task?.title ?? (first.taskId as string),
      subtaskId,
      subtaskTitle: subtask?.title ?? subtaskId,
      sessionId: first.sessionId as string,
      repos: group.map((row) => ({ repoName: row.repoName, fileCount: row.fileCount })),
      capturedAt: group.reduce((latest, row) => (row.capturedAt > latest ? row.capturedAt : latest), first.capturedAt),
      overlapsWith,
      ...(overlapUnknown ? { overlapUnknown: true } : {})
    });
  }
  items.sort((a, b) => {
    const risk = (item: LandingItem): number => (item.overlapsWith.length > 0 ? 2 : item.overlapUnknown === true ? 1 : 0);
    const byRisk = risk(a) - risk(b);
    if (byRisk !== 0) return byRisk;
    return a.capturedAt.localeCompare(b.capturedAt);
  });
  return items;
}

export async function buildAgentsOverview(ports: AgentsOverviewPorts): Promise<AgentsOverviewState> {
  const [records, tasks, columns, questions, accessRequests] = await Promise.all([
    ports.listSessions(),
    ports.listTaskSummaries(),
    ports.listColumns(),
    ports.listPendingQuestions(),
    ports.listPendingAccessRequests()
  ]);

  const recordsById = new Map(records.map((record) => [record.sessionId as string, record]));
  // First task in list order wins a doubly-linked session, so a session never
  // renders twice and reassignment is deterministic across refetches.
  const taskBySession = new Map<string, string>();
  for (const task of tasks) {
    for (const sessionId of task.linkedSessionIds) {
      if (recordsById.has(sessionId) && !taskBySession.has(sessionId)) {
        taskBySession.set(sessionId, task.taskId);
      }
    }
  }

  // Graft unlinked role children under their nearest linked ancestor so a
  // spawned researcher/reviewer never lands in the orphan drawer while its
  // parent sits in a task group. Bounded walk guards a (never-expected)
  // parent cycle.
  const taskForSession = (sessionId: string): string | undefined => {
    let currentId: string | undefined = sessionId;
    for (let hop = 0; hop < 16 && currentId !== undefined; hop += 1) {
      const assigned = taskBySession.get(currentId);
      if (assigned !== undefined) return assigned;
      currentId = recordsById.get(currentId)?.parentSessionId as string | undefined;
    }
    return undefined;
  };

  const sessionsByTask = new Map<string, ChatSessionSummary[]>();
  const orphanSessions: ChatSessionSummary[] = [];
  for (const record of records) {
    const summary = ports.decorateSession(record);
    const taskId = taskForSession(record.sessionId as string);
    if (taskId === undefined) {
      orphanSessions.push(summary);
      continue;
    }
    const bucket = sessionsByTask.get(taskId);
    if (bucket === undefined) {
      sessionsByTask.set(taskId, [summary]);
    } else {
      bucket.push(summary);
    }
  }

  const columnsById = new Map(columns.map((column) => [column.columnId, column]));
  const groups: AgentsTaskGroup[] = [];
  for (const task of tasks) {
    const sessions = sessionsByTask.get(task.taskId);
    if (sessions === undefined || sessions.length === 0) continue;
    const column = columnsById.get(task.columnId);
    groups.push({
      task,
      ...(column === undefined ? {} : { columnName: column.name, columnCategory: column.category }),
      sessions
    });
  }

  const unlanded = ports.listUnlandedChangesets === undefined ? [] : await ports.listUnlandedChangesets();
  const landing = buildLandingItems(unlanded, tasks);

  return {
    generatedAt: ports.now(),
    groups,
    orphanSessions,
    questions,
    accessRequests,
    agentIdleThresholdMs: ports.agentIdleThresholdMs(),
    ...(landing.length === 0 ? {} : { landing })
  };
}
