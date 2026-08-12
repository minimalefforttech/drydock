/**
 * Agents editor panel webview (UX overhaul P5) - the fleet as a flat list.
 *
 * ONE row per session, recent-first, in the background-tasks shape: line 1 is
 * dot · title · owning task · elapsed, line 2 is a single live mono activity
 * line. Rows that need a person pin to the top with a coloured left edge.
 * Expanding a row in place adds the raw-stream tail, its subagent children and
 * a meta line - nothing else competes for attention. The grouped grid, hover
 * cards and chip clusters of ADR 0013 are gone; group-by-task is an opt-in
 * toggle that renders the SAME rows under task headers.
 *
 * Data plane: one agents.state snapshot, then hot pushes fold in place
 * (session.agentActivity / chat.turnStarted / chat.turnCompleted /
 * session.updated / session.deleted) while the coarse agents.changed push
 * schedules a debounced refetch - self-healing, never polling. Re-renders are
 * damped to at most one per second (a fleet mid-fan-out pushes far faster than
 * anyone can read) and nothing ever scrolls the list for you.
 *
 * The activity line is derived by `fleetActivityLine` in contracts - the same
 * function the host calls for the snapshot - so a pushed row and a refetched
 * row cannot disagree.
 *
 * A collapsed Runtimes fold sits at the bottom (UX overhaul P7): the container
 * inventory the retired System tab used to own - name, state, uptime, Stop,
 * "Clean up stale", and a sign-in escape hatch when the sandbox tooling refuses
 * to answer. It loads on open and after its own actions; it never polls.
 *
 * SECURITY: every dynamic string (titles, activity lines, raw-stream tails,
 * error messages) renders via textContent - NEVER innerHTML, no DOM-from-string
 * of any kind. The panel's strict CSP has no 'unsafe-inline' for styles, so all
 * styling is by CLASS, never style attributes.
 */

import {
  fleetActivityLine,
  sessionRollupStatus,
  subagentReportingForTransport,
  WEBVIEW_PROTOCOL_VERSION,
  type AccessRequestSummary,
  type AgentActivityItem,
  type AgentActivitySummary,
  type AgentQuestionSummary,
  type AgentsOverviewState,
  type AgentsSessionLine,
  type AgentsTaskGroup,
  type ChatSessionSummary,
  type HostToWebviewMessage,
  type PanelPushPayload,
  type PanelRequestPayload,
  type PanelResponse,
  type RuntimeSummary,
  type TaskRollupStatus
} from "@drydock/contracts";
import { createHelpExperience, setHelpTooltip } from "./help.js";
import { createDemoModeController, demoResponse, isDemoMode } from "./demoMode.js";
import { nextWorkflowStep } from "./guideHandoffs.js";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): PersistedState | undefined;
  setState(state: PersistedState): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** Only the toolbar picks persist across reloads; the fleet is re-fetched on boot. */
interface PersistedState {
  readonly filter: FilterMode;
  readonly groupByTask?: boolean;
}

type FilterMode = "all" | "attention" | "active";
const FILTER_MODES: readonly FilterMode[] = ["all", "attention", "active"];
const FILTER_LABEL: Record<FilterMode, string> = {
  all: "All",
  attention: "Needs you",
  active: "Active"
};

const REQUEST_TIMEOUT_MS = 60_000;
const REFETCH_DEBOUNCE_MS = 300;
/** Update damping: a fan-out pushes faster than anyone reads. */
const RENDER_THROTTLE_MS = 1000;
/** Settled rows stay in the main list this long, then sink below the fold. */
const SINK_AFTER_MS = 10 * 60_000;
/** Raw-stream tail shown when a row is expanded. */
const RAW_TAIL_LINES = 12;
const MAX_CHILD_DEPTH = 4;

const vscodeApi = acquireVsCodeApi();
const app = document.getElementById("app");
if (!app) throw new Error("missing #app root");

const demoMode = createDemoModeController(loadOverview);

const help = createHelpExperience({
  id: "agents",
  title: "Agents guide",
  intro: "One row per agent, most recent first. Rows that need an answer pin to the top; everything else stays quiet until you open it.",
  showWelcome: true,
  dataMode: demoMode.helpMode,
  pages: [
    {
      id: "reading",
      label: "Reading a row",
      title: "Read one agent row",
      intro: "Each row is one chat session: a status dot, its title, the task that owns it, and how long it has been at this.",
      sections: [
        { title: "Status dot", body: "The same dot language every Drydock surface uses: awaiting an answer, failed, running, starting, idle, done, offline." },
        { title: "Activity line", body: "The single line below the title reports what the agent is doing now - a pending question, the current command, or the latest output line." },
        { title: "Pinned rows", body: "A coloured left edge marks a row that is waiting on you. Those rows sort above everything else regardless of filter." },
        { title: "Elapsed", body: "The right-hand time is the current turn's duration while a turn runs, and the age of the last activity otherwise." }
      ]
    },
    {
      id: "acting",
      label: "Acting on a row",
      title: "Open, stop, and land",
      intro: "Row actions appear on hover or keyboard focus so the resting list stays quiet.",
      sections: [
        { title: "Open chat", body: "Select a row (or press Enter) to open that session's chat. The chevron expands the row in place instead." },
        { title: "Expand", body: "An expanded row shows the tail of the raw agent stream, its delegated subagents, and a meta line. The tail is fetched once per expand - it never polls." },
        { title: "Stop and end", body: "Stop cancels the current turn (two clicks). The overflow menu ends the session, opens a terminal into its container, or re-reads the raw stream." },
        { title: "Land changes", body: "A finished row offers Land changes only while a captured changeset is still unlanded. Landing pulls that work into your working copy." }
      ]
    },
    {
      id: "sorting",
      label: "Filters & grouping",
      title: "Narrow the fleet",
      intro: "Filters and grouping change only what you see - never what an agent is doing.",
      sections: [
        { title: "Filters", body: "All shows every session. Needs you shows only rows waiting on a person. Active hides finished history." },
        { title: "The fold", body: "Finished and failed rows drop below a thin divider once they are ten minutes old, so the live fleet stays at the top." },
        { title: "Group by task", body: "The opt-in toggle renders the same rows under task headers when you are tracking several tasks at once." },
        { title: "Token total", body: "The toolbar total is folded from activity reported in this window. It is not a billing record." }
      ]
    }
  ],
  tour: [
    { title: "Scan the fleet", body: "One row per agent, most recent first, with the running total of reported tokens on the right.", target: ".bar" },
    { title: "Filter the list", body: "All, Needs you, or Active. The pick persists for this panel only.", target: () => app.querySelector<HTMLElement>(".seg") ?? app },
    { title: "Read one row", body: "Status dot, title, owning task, elapsed - and one live line reporting the current command, output, or pending question.", target: () => app.querySelector<HTMLElement>(".row") ?? app },
    { title: "Expand in place", body: "The chevron opens the raw-stream tail, the delegated subagents, and the row's meta line without leaving the list.", target: () => app.querySelector<HTMLElement>(".twist") ?? app },
    // The action cluster only exists on hover, so the tour points at the row's
    // right column - the place those actions appear.
    { title: "Act on a row", body: "Hover or focus a row and this column becomes Open chat, Stop, and an overflow menu (end session, container terminal, raw stream).", target: () => app.querySelector<HTMLElement>(".row-right") ?? app.querySelector<HTMLElement>(".row") ?? app },
    { title: "Land finished work", body: "A finished row offers Land changes while its captured changeset is unlanded. Landing pulls that clone work into your working copy.", target: () => app.querySelector<HTMLElement>(".row-land") ?? app.querySelector<HTMLElement>(".fold") ?? app },
    { title: "Group by task", body: "Optional: the same rows under task headers, for when several tasks run at once.", target: () => app.querySelector<HTMLElement>(".group-toggle") ?? app },
    nextWorkflowStep({
      current: "agents",
      request,
      taskId: () => overview?.groups[0]?.task.taskId ?? "demo-task-onboarding"
    })
  ]
});

// ---------------------------------------------------------------------------
// Messaging (correlation pattern shared with the other panels: 60s, pending map)
// ---------------------------------------------------------------------------

const pending = new Map<string, { resolve: (value: PanelResponse) => void; timer: number }>();
let requestCounter = 0;

function request(payload: PanelRequestPayload): Promise<PanelResponse> {
  requestCounter += 1;
  const requestId = `agents-req-${String(requestCounter)}-${String(Date.now())}`;
  const demo = demoResponse(payload, requestId);
  if (demo !== null) return Promise.resolve(demo);
  return new Promise<PanelResponse>((resolve) => {
    const timer = window.setTimeout(() => {
      pending.delete(requestId);
      resolve({
        protocolVersion: WEBVIEW_PROTOCOL_VERSION,
        kind: "response",
        requestId,
        ok: false,
        error: { message: "The extension host did not answer in time." }
      });
    }, REQUEST_TIMEOUT_MS);
    pending.set(requestId, { resolve, timer });
    vscodeApi.postMessage({ protocolVersion: WEBVIEW_PROTOCOL_VERSION, kind: "request", requestId, payload });
  });
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = event.data as HostToWebviewMessage;
  if (typeof message !== "object" || message === null) return;
  if (message.protocolVersion !== WEBVIEW_PROTOCOL_VERSION) return;
  if (message.kind === "response") {
    const entry = pending.get(message.requestId);
    if (entry) {
      window.clearTimeout(entry.timer);
      pending.delete(message.requestId);
      entry.resolve(message);
    }
    return;
  }
  if (message.kind === "push") applyPush(message.payload);
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let overview: AgentsOverviewState | null = null;
let loadError: string | null = null;
let pendingGuideStart = document.body.dataset["startGuide"] === "true";
/** Live per-session activity overlay: fresher than the snapshot's copies. */
const activityBySession = new Map<string, AgentActivitySummary>();
/** Host-derived one-liners from the last snapshot, keyed by session. */
const linesBySession = new Map<string, AgentsSessionLine>();
/** Sessions with a live turn right now (boot: root status; then turn pushes). */
const turnRunning = new Set<string>();
/** Sessions whose LAST turn failed (cleared by the next turn start). */
const failedTurn = new Set<string>();
/** Rows expanded in place (session-local; nothing expands by default). */
const expanded = new Set<string>();
/** Raw-stream tails, fetched once per expand - never polled. */
const rawTails = new Map<string, { readonly status: "loading" | "ready" | "error"; readonly text: string }>();
/** Two-click arming, matching the board's destructive-action convention. */
let armedStopId: string | null = null;
let armedLandId: string | null = null;
/** Per-row outcome notes (landing results, action errors). */
const rowNotes = new Map<string, string>();
/** The one open row overflow menu, if any. */
let openMenuId: string | null = null;

// --- Runtimes fold (UX overhaul P7) -----------------------------------------
// The System tab's runtime list, demoted to a fold at the bottom of the fleet:
// what containers exist, stop one, clean up the strays. Collapsed by default and
// never polled - it loads when opened and after its own actions, so a closed
// fold costs nothing.
let runtimesOpen = false;
let runtimes: readonly RuntimeSummary[] = [];
let runtimesError: string | null = null;
let runtimesLoaded = false;
/** Runtime id armed for Stop (two clicks, matching the row convention). */
let armedRuntimeId: string | null = null;

const saved = vscodeApi.getState();
let filter: FilterMode = saved?.filter ?? "active";
let groupByTask = saved?.groupByTask === true;

function persist(): void {
  vscodeApi.setState({ filter, ...(groupByTask ? { groupByTask: true } : {}) });
}

/** Time-labeled nodes refreshed by the 1s ticker without a full re-render. */
let tickers: Array<{ readonly node: Text; readonly compute: () => string }> = [];

// ---------------------------------------------------------------------------
// Data access helpers
// ---------------------------------------------------------------------------

function allSessions(): ChatSessionSummary[] {
  if (overview === null) return [];
  return [...overview.groups.flatMap((group) => [...group.sessions]), ...overview.orphanSessions];
}

function activityFor(session: ChatSessionSummary): AgentActivitySummary | undefined {
  return activityBySession.get(session.sessionId) ?? session.agentActivity;
}

function pendingQuestionsFor(sessionId: string): AgentQuestionSummary[] {
  return (overview?.questions ?? []).filter((question) => question.sessionId === sessionId && question.status === "pending");
}

function pendingAccessFor(sessionId: string): AccessRequestSummary[] {
  return (overview?.accessRequests ?? []).filter((entry) => entry.sessionId === sessionId && entry.status === "pending");
}

/** Waiting on a PERSON: a question or an access decision. Failure is its own status. */
function needsAnswer(session: ChatSessionSummary): boolean {
  return pendingQuestionsFor(session.sessionId).length > 0 || pendingAccessFor(session.sessionId).length > 0;
}

function hasFailed(session: ChatSessionSummary): boolean {
  return session.status === "failed" || failedTurn.has(session.sessionId);
}

function turnActive(session: ChatSessionSummary): boolean {
  return turnRunning.has(session.sessionId) || activityFor(session)?.root?.status === "running";
}

/** The shared dot vocabulary (contracts roll-up), so no surface can fork it. */
function rowStatus(session: ChatSessionSummary): TaskRollupStatus {
  return sessionRollupStatus({
    status: hasFailed(session) ? "failed" : session.status,
    ...(session.live === undefined ? {} : { live: session.live }),
    ...(session.runningElsewhere === undefined ? {} : { runningElsewhere: session.runningElsewhere }),
    needsAttention: needsAnswer(session),
    turnActive: turnActive(session)
  });
}

/**
 * The row's live line. The host derives it for the snapshot; here it is
 * re-derived whenever an activity push lands, through the SAME function.
 */
function activityLineFor(session: ChatSessionSummary): string | undefined {
  const stored = linesBySession.get(session.sessionId);
  // The snapshot's line stands until this webview knows something fresher: a
  // folded activity push, or a turn that failed since the fetch.
  const fresher = activityBySession.has(session.sessionId) || failedTurn.has(session.sessionId);
  if (!fresher && stored?.activityLine !== undefined) return stored.activityLine;
  const question = pendingQuestionsFor(session.sessionId)[0]?.question;
  const root = activityFor(session)?.root;
  return fleetActivityLine({
    status: hasFailed(session) ? "failed" : session.status,
    ...(session.live === undefined ? {} : { live: session.live }),
    ...(session.runningElsewhere === undefined ? {} : { runningElsewhere: session.runningElsewhere }),
    ...(question === undefined ? {} : { pendingQuestion: question }),
    ...(pendingAccessFor(session.sessionId).length > 0 ? { pendingAccess: true } : {}),
    ...(root === undefined ? {} : { root }),
    ...(session.description === undefined ? {} : { description: session.description })
  });
}

/** When the user became the blocker on this row (oldest pending item). */
function waitingSinceFor(sessionId: string): number | undefined {
  const stamps = [
    ...pendingQuestionsFor(sessionId).map((question) => Date.parse(question.createdAt)),
    ...pendingAccessFor(sessionId).map((entry) => Date.parse(entry.requestedAt))
  ].filter((value) => Number.isFinite(value));
  return stamps.length === 0 ? undefined : Math.min(...stamps);
}

/** Last time anything happened on this row - the ordering key. */
function lastActivityAt(session: ChatSessionSummary): number {
  const root = activityFor(session)?.root;
  const stamp = root?.lastActivityAt ?? root?.startedAt ?? session.updatedAt;
  const parsed = Date.parse(stamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Snapshot boot: derive live turn/failed state from each root's fold status. */
function seedTurnStateFromSnapshot(): void {
  turnRunning.clear();
  failedTurn.clear();
  activityBySession.clear();
  for (const session of allSessions()) {
    const root = session.agentActivity?.root;
    if (root === undefined) continue;
    if (root.status === "running" && session.live === true) turnRunning.add(session.sessionId);
    if (root.status === "failed") failedTurn.add(session.sessionId);
  }
}

/** Snapshot boot: adopt the host-derived one-liner for every row that has one. */
function seedLinesFromSnapshot(state: AgentsOverviewState): void {
  linesBySession.clear();
  for (const line of state.sessionLines ?? []) linesBySession.set(line.sessionId, line);
}

// ---------------------------------------------------------------------------
// Pushes
// ---------------------------------------------------------------------------

let refetchTimer = 0;

function scheduleRefetch(): void {
  if (refetchTimer) window.clearTimeout(refetchTimer);
  refetchTimer = window.setTimeout(() => {
    refetchTimer = 0;
    void loadOverview();
  }, REFETCH_DEBOUNCE_MS);
}

function applyPush(payload: PanelPushPayload): void {
  switch (payload.type) {
    case "help.startTour":
      if (overview === null) {
        pendingGuideStart = true;
      } else {
        window.setTimeout(() => help.startTour(), 0);
      }
      return;
    case "agents.changed":
      scheduleRefetch();
      return;
    case "session.agentActivity":
      activityBySession.set(payload.sessionId, payload.activity);
      scheduleRender();
      return;
    case "chat.turnStarted":
      turnRunning.add(payload.sessionId);
      failedTurn.delete(payload.sessionId);
      activityBySession.delete(payload.sessionId);
      scheduleRender();
      return;
    case "chat.turnCompleted":
      turnRunning.delete(payload.sessionId);
      if (payload.status === "failed") failedTurn.add(payload.sessionId);
      scheduleRender();
      return;
    case "session.updated":
      // A session we don't know (new chat, changed task membership): the
      // snapshot's grouping is stale - coarse heal.
      if (!replaceSession(payload.session)) scheduleRefetch();
      else scheduleRender();
      return;
    case "session.deleted":
      if (removeSession(payload.sessionId)) scheduleRender();
      activityBySession.delete(payload.sessionId);
      linesBySession.delete(payload.sessionId);
      turnRunning.delete(payload.sessionId);
      failedTurn.delete(payload.sessionId);
      expanded.delete(payload.sessionId);
      rawTails.delete(payload.sessionId);
      return;
    default:
      return;
  }
}

/** Replaces a known session's summary in place; false when it is not held. */
function replaceSession(session: ChatSessionSummary): boolean {
  if (overview === null) return false;
  let found = false;
  const swap = (list: readonly ChatSessionSummary[]): readonly ChatSessionSummary[] =>
    list.map((candidate) => {
      if (candidate.sessionId !== session.sessionId) return candidate;
      found = true;
      return session;
    });
  const groups = overview.groups.map((group): AgentsTaskGroup => ({ ...group, sessions: swap(group.sessions) }));
  const orphanSessions = swap(overview.orphanSessions);
  if (found) overview = { ...overview, groups, orphanSessions };
  return found;
}

function removeSession(sessionId: string): boolean {
  if (overview === null) return false;
  let found = false;
  const drop = (list: readonly ChatSessionSummary[]): readonly ChatSessionSummary[] =>
    list.filter((candidate) => {
      if (candidate.sessionId !== sessionId) return true;
      found = true;
      return false;
    });
  const groups = overview.groups
    .map((group): AgentsTaskGroup => ({ ...group, sessions: drop(group.sessions) }))
    .filter((group) => group.sessions.length > 0);
  const orphanSessions = drop(overview.orphanSessions);
  if (found) overview = { ...overview, groups, orphanSessions };
  return found;
}

// ---------------------------------------------------------------------------
// DOM helpers (in-module, textContent only)
// ---------------------------------------------------------------------------

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, title: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = label;
  node.title = title;
  setHelpTooltip(node, title);
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return node;
}

/** A text node whose content re-computes on the shared 1s ticker. */
function tickerText(compute: () => string): Text {
  const node = document.createTextNode(compute());
  tickers.push({ node, compute });
  return node;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${String(totalSeconds)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function formatAgo(ms: number): string {
  const delta = Date.now() - ms;
  if (!Number.isFinite(delta) || delta < 60_000) return "just now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  return `${String(Math.floor(hours / 24))}d ago`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tok`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k tok`;
  return `${String(tokens)} tok`;
}

// ---------------------------------------------------------------------------
// Row model + ordering (presentation policy lives here, not in the host)
// ---------------------------------------------------------------------------

interface FleetRow {
  readonly session: ChatSessionSummary;
  readonly taskId: string | null;
  readonly taskTitle: string;
  readonly status: TaskRollupStatus;
  /** Waiting on a person, or failed: pinned above everything, edge-marked. */
  readonly pinned: boolean;
  readonly at: number;
}

function buildRows(): FleetRow[] {
  if (overview === null) return [];
  const rows: FleetRow[] = [];
  const add = (session: ChatSessionSummary, taskId: string | null, taskTitle: string): void => {
    const status = rowStatus(session);
    rows.push({
      session,
      taskId,
      taskTitle,
      status,
      pinned: status === "awaiting" || status === "failed",
      at: lastActivityAt(session)
    });
  };
  for (const group of overview.groups) {
    for (const session of group.sessions) add(session, group.task.taskId, group.task.title);
  }
  for (const session of overview.orphanSessions) add(session, null, "no task");
  rows.sort((a, b) => {
    // Awaiting outranks failed outranks everything (the shared roll-up
    // precedence); within a class the most recent activity leads.
    const pin = Number(b.pinned) - Number(a.pinned);
    if (pin !== 0) return pin;
    if (a.pinned && b.pinned) {
      const awaiting = Number(b.status === "awaiting") - Number(a.status === "awaiting");
      if (awaiting !== 0) return awaiting;
    }
    return b.at - a.at;
  });
  return rows;
}

function rowVisible(row: FleetRow): boolean {
  if (filter === "attention") return row.pinned;
  if (filter === "active") {
    return row.pinned
      || row.session.live === true
      || row.session.runningElsewhere === true
      || row.status === "running"
      // A booting resume/reclaim is active - hiding it would make the session
      // vanish exactly while the user waits on it.
      || row.status === "starting";
  }
  return true;
}

/** Settled rows sink below the fold once they are ten minutes cold. */
function isSunk(row: FleetRow): boolean {
  if (row.pinned) return false;
  if (row.status !== "done" && row.status !== "offline") return false;
  return Date.now() - row.at >= SINK_AFTER_MS;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

let renderTimer = 0;
let lastRenderAt = 0;

/** Coalesces pushes into at most one rebuild per second. */
function scheduleRender(): void {
  if (renderTimer !== 0) return;
  const wait = Math.max(0, RENDER_THROTTLE_MS - (Date.now() - lastRenderAt));
  renderTimer = window.setTimeout(() => {
    renderTimer = 0;
    render();
  }, wait);
}

function render(): void {
  if (!app) return;
  if (renderTimer !== 0) {
    window.clearTimeout(renderTimer);
    renderTimer = 0;
  }
  lastRenderAt = Date.now();
  tickers = [];
  const surface = el("div", "fleet");
  surface.append(renderToolbar());

  /** Every exit path ends with the runtimes fold pinned to the bottom. */
  const finish = (): void => {
    surface.append(renderRuntimesFold());
    app.replaceChildren(surface);
  };

  if (loadError !== null) {
    surface.append(el("div", "empty error", loadError));
    finish();
    return;
  }
  if (overview === null) {
    surface.append(el("div", "empty", "Loading the fleet…"));
    finish();
    return;
  }

  const rows = buildRows().filter(rowVisible);
  if (rows.length === 0) {
    surface.append(renderEmptyState());
    finish();
    return;
  }

  const list = el("div", "rows");
  if (groupByTask) {
    // The SAME rows, under task headers - grouping never reorders within a task.
    const seen = new Set<string>();
    for (const row of rows) {
      const key = row.taskId ?? "";
      if (seen.has(key)) continue;
      seen.add(key);
      const members = rows.filter((candidate) => (candidate.taskId ?? "") === key);
      const head = el("div", "task-head");
      head.append(el("span", "task-head-title", row.taskTitle));
      head.append(el("span", "task-head-count", `${String(members.length)} agent${members.length === 1 ? "" : "s"}`));
      list.append(head);
      for (const member of members) list.append(renderRow(member));
    }
  } else {
    const live = rows.filter((row) => !isSunk(row));
    const sunk = rows.filter(isSunk);
    for (const row of live) list.append(renderRow(row));
    if (sunk.length > 0) {
      list.append(el("div", "fold", `Earlier · ${String(sunk.length)}`));
      for (const row of sunk) list.append(renderRow(row));
    }
  }
  surface.append(list);
  // Nothing scrolls the list for you: the scroller keeps its offset across a
  // rebuild, and no row is ever scrolled into view.
  finish();
}

function renderToolbar(): HTMLElement {
  const bar = el("div", "bar");
  bar.append(el("span", "bar-title", "Agents"));

  const seg = el("div", "seg");
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", "Agent filter");
  for (const mode of FILTER_MODES) {
    const item = button(FILTER_LABEL[mode], `Show ${FILTER_LABEL[mode].toLowerCase()}`, filter === mode ? "seg-item on" : "seg-item", () => {
      filter = mode;
      persist();
      render();
    });
    item.setAttribute("aria-pressed", String(filter === mode));
    seg.append(item);
  }
  bar.append(seg);

  const right = el("div", "bar-right");
  const toggle = button("Group by task", "Render the same rows under task headers", groupByTask ? "ghost group-toggle on" : "ghost group-toggle", () => {
    groupByTask = !groupByTask;
    persist();
    render();
  });
  toggle.setAttribute("aria-pressed", String(groupByTask));
  right.append(toggle);

  // Fleet cost line: live token total across every session's fold. Honest
  // scope - this window's live data, not a billing ledger.
  const tokens = allSessions().reduce((sum, session) => sum + (activityFor(session)?.root?.tokens ?? 0), 0);
  if (tokens > 0) {
    const total = el("span", "bar-tokens mono", `Σ ${formatTokens(tokens)}`);
    setHelpTooltip(total, "Tokens reported by agent activity in this window. Not a billing record.");
    right.append(total);
  }
  right.append(help.launcher("fleet-help-launcher"));
  bar.append(right);
  return bar;
}

function renderRow(row: FleetRow): HTMLElement {
  const session = row.session;
  const sessionId = session.sessionId;
  const isExpanded = expanded.has(sessionId);
  const classes = ["row", `status-${row.status}`];
  if (row.pinned) classes.push(row.status === "failed" ? "pinned pin-failed" : "pinned");
  if (row.status === "done" || row.status === "offline") classes.push("settled");
  if (isExpanded) classes.push("open");
  const node = el("div", classes.join(" "));

  const twist = button(isExpanded ? "⌄" : "›", isExpanded ? "Collapse this agent" : "Expand this agent in place", "twist", () => {
    if (expanded.has(sessionId)) expanded.delete(sessionId);
    else {
      expanded.add(sessionId);
      void loadRawTail(sessionId);
    }
    render();
  });
  twist.setAttribute("aria-expanded", String(isExpanded));
  node.append(twist);

  const open = document.createElement("button");
  open.type = "button";
  open.className = "row-open";
  open.title = "Open this session's chat";
  const line1 = el("span", "row-line1");
  line1.append(el("span", `dot dot-${row.status}`));
  line1.append(el("span", "row-title", session.title));
  if (row.taskTitle !== "") line1.append(el("span", "row-task", row.taskTitle));
  open.append(line1);
  const activity = row.status === "done" || row.status === "offline" || row.status === "failed"
    ? linesBySession.get(sessionId)?.resultLine ?? activityLineFor(session)
    : activityLineFor(session);
  open.append(el("span", "row-line2 mono", activity ?? ""));
  open.addEventListener("click", () => {
    openChat(sessionId);
  });
  node.append(open);

  node.append(renderRowRight(row));

  const note = rowNotes.get(sessionId);
  if (note !== undefined) {
    const noteNode = el("div", "row-note", note);
    noteNode.setAttribute("role", "status");
    node.append(noteNode);
  }
  if (isExpanded) node.append(renderExpansion(row));
  return node;
}

function renderRowRight(row: FleetRow): HTMLElement {
  const session = row.session;
  const sessionId = session.sessionId;
  // An open menu keeps the hover-revealed actions visible after the rebuild.
  const right = el("div", openMenuId === sessionId ? "row-right menu-open" : "row-right");

  // Landing (ADR 0014, per-row since P5): only while a captured changeset
  // waits, and never mid-turn (the host refuses a pull under a live turn).
  if (linesBySession.get(sessionId)?.landable === true && row.status !== "running" && row.status !== "starting") {
    const armed = armedLandId === sessionId;
    const land = button(armed ? "Confirm land" : "Land changes", "Pull this run's clone work into your working copy and mark it landed", armed ? "pill row-land armed" : "pill row-land", () => {
      if (armedLandId !== sessionId) {
        armedLandId = sessionId;
        render();
        return;
      }
      armedLandId = null;
      rowNotes.set(sessionId, "Landing…");
      render();
      void request({ type: "agents.landSession", sessionId }).then((response) => {
        rowNotes.set(sessionId, response.ok && response.payload.type === "agents.landSession"
          ? response.payload.message
          : `landing failed: ${response.ok ? "unexpected response" : response.error.message}`);
        scheduleRefetch();
        render();
      });
    });
    land.disabled = isDemoMode();
    if (isDemoMode()) land.title = "Demo data does not write to your working copy. Switch to Live data to land this work.";
    right.append(land);
  }
  if (row.status === "failed") {
    // No session-level retry request reaches this panel's dispatch yet, so
    // Retry opens the chat, where the composer's retry lives.
    right.append(button("Retry ↗", "Open this chat to re-run the failed turn", "pill row-retry", () => {
      openChat(sessionId);
    }));
  }

  const elapsed = el("span", "row-elapsed mono");
  const root = activityFor(session)?.root;
  const waitingSince = row.status === "awaiting" ? waitingSinceFor(sessionId) : undefined;
  if (session.runningElsewhere === true) {
    elapsed.append(document.createTextNode("-"));
  } else if (waitingSince !== undefined) {
    // A pinned row's useful number is how long the PERSON has been the
    // blocker, not when the agent last spoke.
    elapsed.append(tickerText(() => `waiting ${formatDuration(Date.now() - waitingSince).replace(/ \d\ds$/, "")}`));
  } else if (row.status === "running" && root?.startedAt !== undefined) {
    const startedAt = Date.parse(root.startedAt);
    elapsed.append(tickerText(() => formatDuration(Date.now() - startedAt)));
  } else {
    elapsed.append(tickerText(() => formatAgo(row.at)));
  }
  right.append(elapsed);

  const actions = el("div", "row-actions");
  actions.append(button("Open chat ⇥", "Open this session's chat", "ghost", () => {
    openChat(sessionId);
  }));
  // Stop follows the TURN, not the dot: a row pinned for a question can still
  // have a turn in flight, and that is exactly when stopping matters.
  if (turnActive(session) && session.live === true) {
    const armed = armedStopId === sessionId;
    actions.append(button(armed ? "Confirm" : "Stop", "Cancel this session's current turn", armed ? "ghost stop armed" : "ghost stop", () => {
      if (armedStopId !== sessionId) {
        armedStopId = sessionId;
        render();
        return;
      }
      armedStopId = null;
      void request({ type: "chat.cancelTurn", sessionId }).then((response) => {
        // A refused cancel (ended meanwhile, running elsewhere) heals on refetch.
        if (!response.ok) {
          rowNotes.set(sessionId, response.error.message);
          scheduleRefetch();
        }
        render();
      });
      render();
    }));
  }
  if (session.runningElsewhere !== true) {
    const more = button("⋯", "More actions", openMenuId === sessionId ? "ghost more on" : "ghost more", () => {
      openMenuId = openMenuId === sessionId ? null : sessionId;
      render();
    });
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", String(openMenuId === sessionId));
    actions.append(more);
    if (openMenuId === sessionId) actions.append(renderRowMenu(sessionId));
  }
  right.append(actions);
  return right;
}

function renderRowMenu(sessionId: string): HTMLElement {
  const menu = el("div", "menu");
  menu.setAttribute("role", "menu");
  const item = (label: string, title: string, run: () => void): void => {
    const node = button(label, title, "menu-item", () => {
      openMenuId = null;
      run();
    });
    node.setAttribute("role", "menuitem");
    menu.append(node);
  };
  item("End session", "End this chat session and release its runtime", () => {
    void request({ type: "chat.endSession", sessionId }).then((response) => {
      if (!response.ok) rowNotes.set(sessionId, response.error.message);
      scheduleRefetch();
      render();
    });
    render();
  });
  item("Container terminal", "Open a terminal inside this chat's container", () => {
    void request({ type: "runtime.openTerminal", sessionId }).then((response) => {
      if (!response.ok) rowNotes.set(sessionId, response.error.message);
      render();
    });
  });
  item("Raw stream", "Expand this row and re-read the raw agent stream", () => {
    expanded.add(sessionId);
    rawTails.delete(sessionId);
    void loadRawTail(sessionId);
    render();
  });
  return menu;
}

/**
 * Expand-in-place: the raw-stream tail, the delegated subagents, and one meta
 * line. Nothing here polls - the tail is fetched once per expand.
 */
function renderExpansion(row: FleetRow): HTMLElement {
  const session = row.session;
  const wrap = el("div", "row-expand");
  const tail = rawTails.get(session.sessionId);
  const well = el("pre", "raw mono");
  if (tail === undefined || tail.status === "loading") well.textContent = "reading the raw stream…";
  else if (tail.status === "error") well.textContent = tail.text;
  else well.textContent = tail.text === "" ? "no raw stream captured in this window yet" : tail.text;
  wrap.append(well);

  const activity = activityFor(session);
  const agents = activity?.agents ?? [];
  if (agents.length > 0) {
    const byParent = new Map<string, AgentActivityItem[]>();
    for (const agent of agents) {
      const key = agent.parentNodeId ?? "root";
      const bucket = byParent.get(key);
      if (bucket === undefined) byParent.set(key, [agent]);
      else bucket.push(agent);
    }
    const appendLevel = (parentKey: string, depth: number): void => {
      for (const agent of byParent.get(parentKey) ?? []) {
        wrap.append(renderChildRow(session, agent, depth));
        appendLevel(agent.nodeId, Math.min(depth + 1, MAX_CHILD_DEPTH));
      }
    };
    appendLevel("root", 0);
  }
  const tier = subagentReportingForTransport(session.transport ?? "");
  if (tier !== "full" && turnRunning.has(session.sessionId)) {
    // Honest tiers: a silent tree must say WHY it is silent.
    wrap.append(el("div", "child-note", tier === "lifecycle"
      ? "this transport reports subagent lifecycle only - no per-agent feed"
      : "no subagent signal for this transport"));
  }

  const parts: string[] = [session.providerId];
  if (session.model !== undefined) parts.push(session.model);
  if (session.mode !== undefined) parts.push(session.mode);
  if (session.spawnedRole !== undefined) parts.push(`role · ${session.spawnedRole}`);
  if (session.transport !== undefined) parts.push(session.transport);
  const root = activity?.root;
  if (root?.tokens !== undefined) parts.push(formatTokens(root.tokens));
  if (root !== undefined && root.toolUses > 0) parts.push(`${String(root.toolUses)} calls`);
  wrap.append(el("div", "meta mono", parts.join(" · ")));
  return wrap;
}

function renderChildRow(session: ChatSessionSummary, agent: AgentActivityItem, depth: number): HTMLElement {
  const status: TaskRollupStatus = agent.status === "running"
    ? "running"
    : agent.status === "failed"
      ? "failed"
      : agent.status === "unknown" ? "offline" : "done";
  const node = document.createElement("button");
  node.type = "button";
  node.className = `child depth-${String(Math.min(depth, MAX_CHILD_DEPTH))}`;
  node.title = "Open this agent in the chat's Agents lens";
  node.append(el("span", `dot dot-${status}`));
  node.append(el("span", "child-label", agent.label));
  const line = agent.lastCommand === undefined ? agent.lastActivity ?? "" : `$ ${agent.lastCommand}`;
  node.append(el("span", "child-line mono", line));
  const right = el("span", "child-elapsed mono");
  if (agent.status === "running" && agent.startedAt !== undefined) {
    const startedAt = Date.parse(agent.startedAt);
    right.append(tickerText(() => formatDuration(Date.now() - startedAt)));
  } else if (agent.startedAt !== undefined && agent.endedAt !== undefined) {
    right.textContent = formatDuration(Date.parse(agent.endedAt) - Date.parse(agent.startedAt));
  }
  node.append(right);
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    void request({ type: "agents.openSession", sessionId: session.sessionId, nodeId: agent.nodeId });
  });
  return node;
}

function renderEmptyState(): HTMLElement {
  if (filter === "attention") return el("div", "empty", "Nothing is waiting on you.");
  if (filter === "active" && allSessions().length > 0) {
    return el("div", "empty", "No agents are working right now. Switch to All to see finished chats.");
  }
  return el("div", "empty", "No agents yet - start a chat from a task and it shows up here.");
}

/**
 * Runtimes fold: the containers behind the fleet, one quiet line each. It is a
 * fold rather than a dashboard on purpose - the rows above are the work, this is
 * the plumbing you open when something looks stuck.
 */
function renderRuntimesFold(): HTMLElement {
  const section = el("div", runtimesOpen ? "runtimes-fold open" : "runtimes-fold");

  const live = runtimes.filter((runtime) => runtime.status !== "removed");
  const summary = button(
    `${runtimesOpen ? "▾" : "▸"} Runtimes${runtimesLoaded && live.length > 0 ? ` · ${String(live.length)}` : ""}`,
    "Containers behind these agents: state, uptime, and cleanup",
    "runtimes-summary",
    () => {
      runtimesOpen = !runtimesOpen;
      armedRuntimeId = null;
      render();
      if (runtimesOpen && !runtimesLoaded) void loadRuntimes();
    }
  );
  summary.setAttribute("aria-expanded", String(runtimesOpen));
  section.append(summary);
  if (!runtimesOpen) return section;

  const body = el("div", "runtimes-body");

  if (runtimesError !== null) {
    body.append(el("div", "runtimes-note error", runtimesError));
    // The only interactive recovery Drydock can offer from here: the sandbox
    // tooling refuses to answer until it has a signed-in session.
    body.append(button("Sign in to Docker Sandbox", "Open a terminal running `sbx login`", "ghost", () => {
      void request({ type: "runtime.sbxLogin" }).then((response) => {
        runtimesError = response.ok
          ? "Opened a terminal running `sbx login`. Finish the sign-in, then reopen this fold."
          : response.error.message;
        render();
      });
    }));
    section.append(body);
    return section;
  }

  if (!runtimesLoaded) {
    body.append(el("div", "runtimes-note", "Reading the runtime inventory…"));
    section.append(body);
    return section;
  }
  if (live.length === 0) {
    body.append(el("div", "runtimes-note", "No runtimes are recorded right now."));
  }
  for (const runtime of live) body.append(renderRuntimeRow(runtime));

  const actions = el("div", "runtimes-actions");
  actions.append(button("Clean up stale", "Reap quarantined or lost runtimes whose sandbox is already gone, then purge old removed rows", "ghost", () => {
    void request({ type: "runtime.reconcile" }).then((response) => {
      if (!response.ok) {
        runtimesError = response.error.message;
        render();
        return;
      }
      void loadRuntimes();
    });
  }));
  body.append(actions);
  section.append(body);
  return section;
}

function renderRuntimeRow(runtime: RuntimeSummary): HTMLElement {
  const row = el("div", "runtime-row");
  row.append(el("span", "runtime-name mono", runtime.externalName));
  row.append(el("span", `runtime-state state-${runtime.status}`, runtime.status));
  const uptime = el("span", "runtime-uptime");
  const startedAt = Date.parse(runtime.startedAt);
  uptime.append(tickerText(() =>
    Number.isFinite(startedAt) ? formatDuration(Date.now() - startedAt) : "-"));
  row.append(uptime);

  const armed = armedRuntimeId === runtime.runtimeId;
  row.append(button(armed ? "Confirm stop" : "Stop", "Stop and remove this container", armed ? "runtime-stop armed" : "runtime-stop", () => {
    if (!armed) {
      armedRuntimeId = runtime.runtimeId;
      render();
      return;
    }
    armedRuntimeId = null;
    void request({ type: "isolatedRun.stopRuntime", runtimeId: runtime.runtimeId }).then((response) => {
      if (!response.ok) runtimesError = response.error.message;
      void loadRuntimes();
    });
  }));
  return row;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Loads the runtime inventory on demand: opening the fold, or after an action. */
async function loadRuntimes(): Promise<void> {
  const response = await request({ type: "isolatedRun.listRuntimes" });
  runtimesLoaded = true;
  if (!response.ok) {
    runtimesError = response.error.message;
  } else if (response.payload.type === "isolatedRun.listRuntimes") {
    runtimes = response.payload.runtimes;
    runtimesError = null;
  }
  render();
}

/** Navigation seam: the host reveals the chat and pushes panel.showSession. */
function openChat(sessionId: string): void {
  void request({ type: "agents.openSession", sessionId });
}

async function loadRawTail(sessionId: string): Promise<void> {
  if (rawTails.has(sessionId)) return;
  rawTails.set(sessionId, { status: "loading", text: "" });
  const response = await request({ type: "chat.rawStream", sessionId });
  if (!response.ok) {
    rawTails.set(sessionId, { status: "error", text: response.error.message });
  } else if (response.payload.type === "chat.rawStream") {
    const lines = response.payload.text.split(/\r?\n/);
    while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
    rawTails.set(sessionId, { status: "ready", text: lines.slice(-RAW_TAIL_LINES).join("\n") });
  }
  render();
}

// ---------------------------------------------------------------------------
// Boot + ticker
// ---------------------------------------------------------------------------

async function loadOverview(): Promise<void> {
  const response = await request({ type: "agents.state" });
  if (!response.ok) {
    loadError = response.error.message;
    render();
    return;
  }
  if (response.payload.type !== "agents.state") return;
  overview = response.payload.state;
  loadError = null;
  seedTurnStateFromSnapshot();
  seedLinesFromSnapshot(overview);
  render();
  if (pendingGuideStart) {
    pendingGuideStart = false;
    window.setTimeout(() => help.startTour(), 0);
  }
}

// An outside click closes the row menu; the ⋯ button stops propagation itself.
document.addEventListener("click", () => {
  if (openMenuId === null) return;
  openMenuId = null;
  render();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (openMenuId === null && armedStopId === null && armedLandId === null && armedRuntimeId === null) return;
  openMenuId = null;
  armedStopId = null;
  armedLandId = null;
  armedRuntimeId = null;
  render();
});

window.setInterval(() => {
  for (const ticker of tickers) ticker.node.textContent = ticker.compute();
}, 1000);

render();
void loadOverview();
