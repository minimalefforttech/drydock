/**
 * Pure projections behind the Task Hub's one composite read (UX overhaul, P3).
 *
 * `hub.state` is a SUMMARY, never a second source of truth: every field here is
 * folded out of summaries the owning services already produce (tasks/subtasks,
 * chat sessions, plans, pending questions/access requests, the runtime
 * inventory and its stats sampler). Keeping the fold in one vscode-free,
 * service-free function means the hub's rules - which chats belong to a task,
 * what pins to the attention rail, how the tiles add up - are unit-testable in
 * isolation, exactly like `railShared` is for the rail.
 *
 * SECURITY: display-safe summaries in, display-safe summaries out. Nothing here
 * touches the filesystem, a runtime handle, or a secret; the mount lines and the
 * launch command are reconstructed from display strings the host already
 * decided were safe to show.
 */

import type {
  AccessRequestSummary,
  AgentQuestionSummary,
  ChatSessionSummary,
  HubAttentionItem,
  HubChatSummary,
  HubState,
  HubStats,
  HubSystemState,
  PlanSummary,
  RuntimeStatsSummary,
  RuntimeSummary,
  WorkTaskSummary
} from "@drydock/contracts";

/** One mount the task's workspace sets contribute, as display text only. */
export interface HubMountInput {
  readonly displayPath: string;
  readonly readOnly: boolean;
}

/** One runtime owned by a session of this task, with its optional live sample. */
export interface HubRuntimeInput {
  readonly runtime: RuntimeSummary;
  readonly sessionId: string;
  /** Sample for this runtime when the (Windows-only) sampler could take one. */
  readonly stats?: RuntimeStatsSummary;
  /** Sandbox workspace path (inventory metadata) for the launch line. */
  readonly workspaceDisplayPath?: string;
}

/** Everything `buildHubState` folds, all of it already display-safe. */
export interface HubStateInput {
  /** The decorated task summary (links, columnId, subtasks). */
  readonly task: WorkTaskSummary;
  /** Every stored session in the window; this fold picks the task's own. */
  readonly sessions: readonly ChatSessionSummary[];
  /** Every plan; filtered to the ones linked to this task. */
  readonly plans: readonly PlanSummary[];
  /** Pending questions across the window. */
  readonly questions: readonly AgentQuestionSummary[];
  /** Access requests across the window (pending ones become attention rows). */
  readonly accessRequests: readonly AccessRequestSummary[];
  /** Runtimes belonging to this task's sessions. */
  readonly runtimes: readonly HubRuntimeInput[];
  readonly mounts: readonly HubMountInput[];
  readonly workspaceName?: string;
  readonly generatedAt: string;
}

/**
 * Every session id this task owns: its own links plus each subtask's. The Set
 * is the dedupe - a session linked at both levels is one chat, not two.
 */
export function hubTaskSessionIds(task: WorkTaskSummary): Set<string> {
  const linked = new Set<string>(task.linkedSessionIds);
  for (const subtask of task.subtasks) {
    for (const sessionId of subtask.linkedSessionIds) linked.add(sessionId);
  }
  return linked;
}

/**
 * Reconstructs the `sbx create` invocation the docker-sandbox adapter issued
 * for a live run, so the System card can show it as copyable text. Unlike the
 * chat panel's client-side approximation the sandbox name here is the REAL
 * external name from the runtime inventory; the workspace is the positional
 * arg and every other mount is appended as `path` (read-write) or `path:ro`
 * (read-only), matching DockerSandboxRuntimeAdapter.createRuntime.
 */
export function buildLaunchCommand(input: {
  readonly sandboxName: string;
  readonly providerId: string;
  readonly workspaceDisplayPath: string;
  readonly mounts: readonly HubMountInput[];
}): string {
  // Only two adapter agents exist; anything not Claude launches the codex agent
  // (the legacy `codex-openai` id included).
  const agent = input.providerId.startsWith("claude") ? "claude" : "codex";
  const extras = input.mounts
    .filter((mount) => mount.displayPath !== input.workspaceDisplayPath)
    .map((mount) => (mount.readOnly ? `${mount.displayPath}:ro` : mount.displayPath));
  return ["sbx", "create", "--name", input.sandboxName, agent, input.workspaceDisplayPath, ...extras].join(" ");
}

/** "rw <path>" / "ro <path>" - the System card's mounts line. */
function hubMountLine(mount: HubMountInput): string {
  return `${mount.readOnly ? "ro" : "rw"} ${mount.displayPath}`;
}

/**
 * Folds one task's overview. Ordering rules, in one place:
 *
 * - Chats: attention first (a chat that needs you outranks a busier one),
 *   then newest activity, then sessionId so the list never jitters.
 * - Attention: questions before access requests, each oldest-first - the item
 *   that has waited longest is the one to answer.
 * - Plans: whatever order the planner returned (newest-updated first).
 *
 * Unknown session ids are stale links (a deleted session) and are skipped -
 * never guessed at.
 */
export function buildHubState(input: HubStateInput): HubState {
  const linked = hubTaskSessionIds(input.task);
  const attentionSessions = new Set<string>();
  const attention = buildAttention(input, linked, attentionSessions);
  const chats = buildChats(input, linked, attentionSessions);
  const system = buildSystem(input);
  return {
    task: input.task,
    chats,
    subtasks: input.task.subtasks,
    plans: input.plans.filter((plan) => plan.taskId === input.task.taskId),
    attention,
    stats: buildStats(input, linked),
    system,
    ...(input.workspaceName === undefined ? {} : { workspaceName: input.workspaceName }),
    generatedAt: input.generatedAt
  };
}

/** Pending questions + access requests for this task's sessions, oldest first. */
function buildAttention(
  input: HubStateInput,
  linked: ReadonlySet<string>,
  flagged: Set<string>
): HubAttentionItem[] {
  const questions = input.questions
    .filter((question) => question.status === "pending" && linked.has(question.sessionId))
    .sort((a, b) => (a.createdAt === b.createdAt ? a.questionId.localeCompare(b.questionId) : a.createdAt < b.createdAt ? -1 : 1))
    .map((question): HubAttentionItem => ({
      kind: "question",
      sessionId: question.sessionId,
      headline: question.question
    }));
  const access = input.accessRequests
    .filter((request) => request.status === "pending" && linked.has(request.sessionId))
    .sort((a, b) => (a.requestedAt === b.requestedAt
      ? a.accessRequestId.localeCompare(b.accessRequestId)
      : a.requestedAt < b.requestedAt ? -1 : 1))
    .map((request): HubAttentionItem => ({
      kind: "access",
      sessionId: request.sessionId,
      headline: `Wants ${request.mode} access to ${request.displayPath}`
    }));
  const items = [...questions, ...access];
  for (const item of items) flagged.add(item.sessionId);
  return items;
}

function buildChats(
  input: HubStateInput,
  linked: ReadonlySet<string>,
  attentionSessions: ReadonlySet<string>
): HubChatSummary[] {
  const subtaskBySession = new Map<string, string>();
  for (const subtask of input.task.subtasks) {
    for (const sessionId of subtask.linkedSessionIds) {
      if (!subtaskBySession.has(sessionId)) subtaskBySession.set(sessionId, subtask.subtaskId);
    }
  }
  const rows: HubChatSummary[] = [];
  for (const session of input.sessions) {
    if (!linked.has(session.sessionId)) continue;
    const subtaskId = subtaskBySession.get(session.sessionId);
    const turnActive = session.agentActivity?.root?.status === "running";
    rows.push({
      sessionId: session.sessionId,
      title: session.title,
      taskId: input.task.taskId,
      taskTitle: input.task.title,
      status: session.status,
      ...(session.live === undefined ? {} : { live: session.live }),
      ...(session.runningElsewhere === undefined ? {} : { runningElsewhere: session.runningElsewhere }),
      ...(attentionSessions.has(session.sessionId) ? { needsAttention: true } : {}),
      lastActivityAt: session.updatedAt,
      providerId: session.providerId,
      ...(session.model === undefined ? {} : { model: session.model }),
      ...(turnActive ? { turnActive: true } : {}),
      ...(subtaskId === undefined ? {} : { subtaskId })
    });
  }
  rows.sort((a, b) => {
    const attentionA = a.needsAttention === true ? 0 : 1;
    const attentionB = b.needsAttention === true ? 0 : 1;
    if (attentionA !== attentionB) return attentionA - attentionB;
    if (a.lastActivityAt !== b.lastActivityAt) return a.lastActivityAt < b.lastActivityAt ? 1 : -1;
    return a.sessionId.localeCompare(b.sessionId);
  });
  return rows;
}

/**
 * The four tiles. CPU and memory sum only samples that actually came back
 * (`available` with a value); a sum of nothing is absent, not zero - "0%" and
 * "we could not measure" are different claims. Tokens sum the root agent plus
 * its native children, which `agentActivitySummaryOfTree` keeps disjoint.
 */
function buildStats(input: HubStateInput, linked: ReadonlySet<string>): HubStats {
  let cpuPercent: number | undefined;
  let memBytes: number | undefined;
  let runtimeCount = 0;
  for (const entry of input.runtimes) {
    if (entry.runtime.status === "running") runtimeCount += 1;
    const stats = entry.stats;
    if (stats === undefined || !stats.available) continue;
    if (stats.cpuPercent !== null) cpuPercent = (cpuPercent ?? 0) + stats.cpuPercent;
    if (stats.memBytes !== null) memBytes = (memBytes ?? 0) + stats.memBytes;
  }
  let tokens: number | undefined;
  for (const session of input.sessions) {
    if (!linked.has(session.sessionId)) continue;
    const activity = session.agentActivity;
    if (activity === undefined) continue;
    const rootTokens = activity.root?.tokens;
    if (rootTokens !== undefined) tokens = (tokens ?? 0) + rootTokens;
    for (const agent of activity.agents ?? []) {
      if (agent.tokens !== undefined) tokens = (tokens ?? 0) + agent.tokens;
    }
  }
  return {
    ...(cpuPercent === undefined ? {} : { cpuPercent }),
    ...(memBytes === undefined ? {} : { memBytes }),
    ...(tokens === undefined ? {} : { tokens }),
    runtimeCount
  };
}

/**
 * The collapsed System card. The launch line describes the NEWEST running
 * runtime (the one a "what is this actually doing" question is about); with no
 * running runtime, or no recorded workspace path, there is no honest command to
 * show and the field is omitted.
 */
function buildSystem(input: HubStateInput): HubSystemState {
  const sessionById = new Map(input.sessions.map((session) => [session.sessionId, session]));
  const running = input.runtimes
    .filter((entry) => entry.runtime.status === "running" && entry.workspaceDisplayPath !== undefined)
    .sort((a, b) => (a.runtime.startedAt === b.runtime.startedAt
      ? a.runtime.runtimeId.localeCompare(b.runtime.runtimeId)
      : a.runtime.startedAt < b.runtime.startedAt ? 1 : -1))[0];
  const launchCommand = running === undefined || running.workspaceDisplayPath === undefined
    ? undefined
    : buildLaunchCommand({
      sandboxName: running.runtime.externalName,
      providerId: sessionById.get(running.sessionId)?.providerId ?? "codex",
      workspaceDisplayPath: running.workspaceDisplayPath,
      mounts: input.mounts
    });
  return {
    runtimes: input.runtimes.map((entry) => entry.runtime),
    mounts: input.mounts.map(hubMountLine),
    ...(launchCommand === undefined ? {} : { launchCommand })
  };
}
