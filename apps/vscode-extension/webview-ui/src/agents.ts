/**
 * Agents editor panel webview (ADR 0013) — the fleet view.
 *
 * One scrollable scan list over every session across every task: task groups
 * (board-column chip, rollups, board/review jumps), session rows nesting role
 * children by parentSessionId, and native subagent rows from the same
 * AgentActivityItem set the sidebar ⑂ chips read. Rows key liveness off
 * `live` (authoritative), render the ADR 0008 running-elsewhere posture with
 * no controls, and keep capability tiers honest ("lifecycle only", "no
 * subagent signal") instead of showing an all-quiet tree.
 *
 * Data plane: one agents.state snapshot, then hot pushes fold in place
 * (session.agentActivity / chat.turnStarted / chat.turnCompleted /
 * session.updated / session.deleted) while the coarse agents.changed push
 * schedules a debounced refetch — self-healing, never polling. Durations and
 * idle labels tick locally from timestamps.
 *
 * SECURITY: every dynamic string (task/session titles, agent labels, activity
 * previews, error messages) renders via textContent — NEVER innerHTML, no
 * DOM-from-string of any kind. The panel's strict CSP has no 'unsafe-inline'
 * for styles, so depth/status/accent styling is by CLASS only, never style
 * attributes. This entry is self-contained (it does not import the
 * control-panel bundle); the small DOM helpers live in-module.
 */

import {
  CARD_DETAIL_LEVELS,
  cardDetailLevel,
  subagentReportingForTransport,
  WEBVIEW_PROTOCOL_VERSION,
  type AccessRequestSummary,
  type AgentActivityItem,
  type AgentActivitySummary,
  type AgentQuestionSummary,
  type AgentsOverviewState,
  type AgentsTaskGroup,
  type CardDetailLevel,
  type ChatSessionSummary,
  type LandingItem,
  type HostToWebviewMessage,
  type PanelPushPayload,
  type PanelRequestPayload,
  type PanelResponse
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

/** Only the toolbar filters persist across webview reloads; the fleet is re-fetched on boot. */
interface PersistedState {
  readonly filter: FilterMode;
  /** Explicit toolbar Detail choice (ADR 0013); absent = follow the config default. */
  readonly cardDetail?: CardDetailLevel;
}

type FilterMode = "active" | "attention" | "all";
const FILTER_MODES: readonly FilterMode[] = ["active", "attention", "all"];
const FILTER_LABEL: Record<FilterMode, string> = {
  active: "Active",
  attention: "Needs attention",
  all: "All"
};

const vscodeApi = acquireVsCodeApi();
const app = document.getElementById("app");
if (!app) throw new Error("missing #app root");

const demoMode = createDemoModeController(loadOverview);

const help = createHelpExperience({
  id: "agents",
  title: "Agents guide",
  intro: "Inspect agent sessions across tasks, open sessions that need attention, and review clone changes before landing them.",
  showWelcome: true,
  dataMode: demoMode.helpMode,
  pages: [
    {
      id: "reading",
      label: "Session status",
      title: "Interpret session status",
      intro: "The list places sessions that are waiting or running before inactive history. Filters change only the current view.",
      sections: [
        { title: "Running", body: "A green dot and duration indicate that a turn is in progress. The activity field shows the latest reported command or tool event." },
        { title: "Waiting", body: "Questions, access requests, failed turns, and subtasks awaiting human verification add attention indicators. Open the session for agent-specific items or the Task Board for verification." },
        { title: "Idle", body: "Idle indicates that a live session has reported no activity for longer than the configured threshold. Open the session to determine whether it is blocked." },
        { title: "Token totals", body: "Token totals are calculated from activity reported during the current window. They are not a billing record." }
      ]
    },
    {
      id: "groups",
      label: "Tasks & agents",
      title: "Open tasks and sessions",
      intro: "Sessions are grouped under their owning task. Nested rows show delegated sessions or provider-reported subagent activity.",
      sections: [
        { title: "Use the task header", body: "The header shows the task, board stage, attention count, running count, and links to its board and review views." },
        { title: "Open a session", body: "Select a session row to open that session in the sidebar. Hover the row to inspect provider, model, capability, activity, timing, and token data." },
        { title: "Inspect nested sessions", body: "Indented rows preserve delegated parent-child relationships. Provider subagent rows show the lifecycle and activity available from that transport." },
        { title: "Find unowned sessions", body: "Sessions without a linked task appear in the Orphan sessions drawer." }
      ]
    },
    {
      id: "landing",
      label: "Landing work",
      title: "Review and land clone changes",
      intro: "Clone changes remain separate from the working copy until you confirm a pull.",
      sections: [
        { title: "Check ordering", body: "Candidates without known path overlap appear first. This ordering does not guarantee that a pull will be conflict-free." },
        { title: "Inspect overlap", body: "An overlap indicator identifies concurrent changes to related paths. Open the other work before pulling." },
        { title: "Confirm the pull", body: "Pull requires confirmation and uses the same clone integration path as the session Changes tray." },
        { title: "Request revisions first", body: "Open Task Review when changes require agent feedback before they are pulled into the working copy." }
      ]
    }
  ],
  tour: [
    { title: "Read the status summary", body: "The toolbar reports running and idle sessions plus every item waiting on you, including Task Board verification.", target: ".toolbar" },
    { title: "Filter the session list", body: "Filter by activity or attention state, choose the row detail level, or search by task and session title. These controls change only the current view.", target: () => app.querySelector<HTMLElement>(".seg") ?? app },
    { title: "Read the task rollup", body: "Each task header shows its board stage, waiting count, active sessions, and token rollup. Expand or collapse the group without changing session state.", target: () => app.querySelector<HTMLElement>(".group:not(.drawer) .ghead") ?? app },
    { title: "Handle verification and attention", body: "Verification rows link to the Task Board. Questions and access requests appear on the responsible session; open that session before responding.", target: () => app.querySelector<HTMLElement>(".task-verification") ?? app.querySelector<HTMLElement>(".group:not(.drawer)") ?? app },
    { title: "Open the responsible session", body: "Select a session row to open its chat in the sidebar. Hover the row for provider, model, capability, activity, questions, access requests, timing, and tokens.", target: () => app.querySelector<HTMLElement>(".session-row") ?? app },
    { title: "Inspect delegated work", body: "Indented session and agent rows preserve parent-child relationships. A transport note explains when per-agent activity is unavailable.", target: () => app.querySelector<HTMLElement>(".row-sub, .session-row.depth-1, .row-note.depth-1") ?? app.querySelector<HTMLElement>(".session-row") ?? app },
    { title: "Open the task board or review", body: "Use Board to manage stages and verification. Use Review to inspect changed files and send revision comments for this task.", target: () => app.querySelector<HTMLElement>(".group:not(.drawer) .gmeta") ?? app.querySelector<HTMLElement>(".group:not(.drawer)") ?? app },
    { title: "Inspect and pull landing work", body: "The Landing drawer orders unlanded clone changes by known overlap. Inspect related work first, then confirm Pull when the changes should enter the working copy.", target: () => app.querySelector<HTMLElement>(".landing-row") ?? app.querySelector<HTMLElement>(".landing") ?? app, prepare: () => { if (!landingOpen) { landingOpen = true; render(); } } },
    nextWorkflowStep({
      current: "agents",
      request,
      taskId: () => overview?.groups[0]?.task.taskId ?? "demo-task-onboarding"
    })
  ]
});

const REQUEST_TIMEOUT_MS = 60_000;
const REFETCH_DEBOUNCE_MS = 300;
const MAX_NEST_DEPTH = 6;

// ---------------------------------------------------------------------------
// Messaging (correlation pattern copied from taskBoard.ts: 60s timeout, pending map)
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
  if (message.kind === "push") {
    applyPush(message.payload);
  }
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let overview: AgentsOverviewState | null = null;
let loadError: string | null = null;
let pendingGuideStart = document.body.dataset["startGuide"] === "true";
/** Live per-session activity overlay: fresher than the snapshot's copies. */
const activityBySession = new Map<string, AgentActivitySummary>();
/** Sessions with a live turn right now (boot: root status; then turn pushes). */
const turnRunning = new Set<string>();
/** Sessions whose LAST turn failed (cleared by the next turn start). */
const failedTurn = new Set<string>();
let filter: FilterMode = vscodeApi.getState()?.filter ?? "active";
/**
 * Row density (ADR 0013). The explicit toolbar pick persists per panel; null
 * falls through to the config default the provider injected as
 * `<body data-card-detail="…">`. minimal = one state chip per row (waiting →
 * failed → nothing; the dot already carries "running"), the rest in the
 * hover card.
 */
let cardDetailChoice: CardDetailLevel | null = ((): CardDetailLevel | null => {
  const saved = vscodeApi.getState()?.cardDetail;
  return saved === undefined ? null : cardDetailLevel(saved);
})();

function detailLevel(): CardDetailLevel {
  return cardDetailChoice ?? cardDetailLevel(document.body.dataset["cardDetail"]);
}
let textFilter = "";
/** Collapsed task groups (session-local; groups default expanded). */
const collapsedGroups = new Set<string>();
let orphansOpen = false;
/** Landing drawer (ADR 0014): open state + armed Pull confirm + last outcome line. */
let landingOpen = false;
let armedLandId: string | null = null;
let landingNotice: string | null = null;
/** Session id whose Stop confirm is armed (two-click, like board deletes). */
let armedStopId: string | null = null;
/** One DOM rebuild per animation frame, even when several sessions push together. */
let renderFrame = 0;

/** Time-labeled nodes refreshed by the 1s ticker without a full re-render. */
let tickers: Array<{ readonly node: Text; readonly compute: () => string }> = [];

function persist(): void {
  vscodeApi.setState({ filter, ...(cardDetailChoice === null ? {} : { cardDetail: cardDetailChoice }) });
}

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
  return (overview?.accessRequests ?? []).filter((request_) => request_.sessionId === sessionId && request_.status === "pending");
}

function needsAttention(session: ChatSessionSummary): boolean {
  return pendingQuestionsFor(session.sessionId).length > 0
    || pendingAccessFor(session.sessionId).length > 0
    || failedTurn.has(session.sessionId)
    || session.status === "failed";
}

function isIdle(session: ChatSessionSummary): boolean {
  if (!(session.live === true) || turnRunning.has(session.sessionId)) return false;
  const thresholdMs = overview?.agentIdleThresholdMs ?? 300_000;
  const last = activityFor(session)?.root?.lastActivityAt ?? session.updatedAt;
  return Date.now() - Date.parse(last) >= thresholdMs;
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
    case "session.updated": {
      if (!replaceSession(payload.session)) {
        // A session we don't know (new chat, changed task membership): the
        // snapshot's grouping is stale — coarse heal.
        scheduleRefetch();
        return;
      }
      scheduleRender();
      return;
    }
    case "session.deleted":
      if (removeSession(payload.sessionId)) scheduleRender();
      activityBySession.delete(payload.sessionId);
      turnRunning.delete(payload.sessionId);
      failedTurn.delete(payload.sessionId);
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

function chip(text: string, className = ""): HTMLElement {
  return el("span", `chip ${className}`.trim(), text);
}

function actionButton(label: string, title: string, onClick: () => void, className = ""): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = `action ${className}`.trim();
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
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${String(totalSeconds)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${String(minutes)}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function formatAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  if (ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
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
// Ordering + filtering (presentation policy lives here, not in the host)
// ---------------------------------------------------------------------------

function sessionVisible(session: ChatSessionSummary): boolean {
  if (filter === "attention" && !needsAttention(session)) return false;
  if (filter === "active") {
    const active = session.live === true || session.runningElsewhere === true
      || turnRunning.has(session.sessionId) || needsAttention(session)
      // ADR 0013: a booting resume/reclaim is active — hiding it would make
      // the session vanish exactly while the user waits on it.
      || session.status === "starting";
    if (!active) return false;
  }
  return true;
}

function matchesText(session: ChatSessionSummary, group?: AgentsTaskGroup): boolean {
  if (textFilter === "") return true;
  const needle = textFilter.toLowerCase();
  return session.title.toLowerCase().includes(needle)
    || (group?.task.title.toLowerCase().includes(needle) ?? false);
}

interface SessionNode {
  readonly session: ChatSessionSummary;
  readonly children: SessionNode[];
}

/** Builds the role-lineage forest for one group's flat session list. */
function sessionForest(sessions: readonly ChatSessionSummary[]): SessionNode[] {
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  const nodes = new Map<string, SessionNode>();
  const forSession = (session: ChatSessionSummary): SessionNode => {
    const existing = nodes.get(session.sessionId);
    if (existing) return existing;
    const created: SessionNode = { session, children: [] };
    nodes.set(session.sessionId, created);
    return created;
  };
  const roots: SessionNode[] = [];
  for (const session of sessions) {
    const node = forSession(session);
    const parent = session.parentSessionId === undefined ? undefined : byId.get(session.parentSessionId);
    if (parent === undefined || parent.sessionId === session.sessionId) {
      roots.push(node);
    } else {
      forSession(parent).children.push(node);
    }
  }
  const byCreatedAt = (a: SessionNode, b: SessionNode): number => a.session.createdAt.localeCompare(b.session.createdAt);
  for (const node of nodes.values()) node.children.sort(byCreatedAt);
  roots.sort((a, b) => {
    const attention = Number(needsAttention(b.session)) - Number(needsAttention(a.session));
    if (attention !== 0) return attention;
    const running = Number(turnRunning.has(b.session.sessionId)) - Number(turnRunning.has(a.session.sessionId));
    if (running !== 0) return running;
    const live = Number(b.session.live === true) - Number(a.session.live === true);
    if (live !== 0) return live;
    return b.session.updatedAt.localeCompare(a.session.updatedAt);
  });
  return roots;
}

function groupRunningCount(group: AgentsTaskGroup): number {
  return group.sessions.filter((session) => turnRunning.has(session.sessionId)).length;
}

function groupVerificationCount(group: AgentsTaskGroup): number {
  return group.task.subtasks.filter((subtask) => subtask.verifyUnmet === true).length;
}

function groupAttentionCount(group: AgentsTaskGroup): number {
  return group.sessions.filter((session) => needsAttention(session)).length + groupVerificationCount(group);
}

function orderedGroups(): AgentsTaskGroup[] {
  if (overview === null) return [];
  return [...overview.groups].sort((a, b) => {
    const attention = groupAttentionCount(b) - groupAttentionCount(a);
    if (attention !== 0) return attention;
    const running = groupRunningCount(b) - groupRunningCount(a);
    if (running !== 0) return running;
    return (b.task.lastWorkedAt ?? b.task.updatedAt).localeCompare(a.task.lastWorkedAt ?? a.task.updatedAt);
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function scheduleRender(): void {
  if (renderFrame !== 0) return;
  renderFrame = window.requestAnimationFrame(() => {
    renderFrame = 0;
    render();
  });
}

function render(): void {
  if (!app) return;
  if (renderFrame !== 0) {
    window.cancelAnimationFrame(renderFrame);
    renderFrame = 0;
  }
  tickers = [];
  const level = detailLevel();
  document.body.classList.toggle("detail-minimal", level === "minimal");
  document.body.classList.toggle("detail-standard", level === "standard");
  document.body.classList.toggle("detail-full", level === "full");
  const surface = el("div", "fleet");
  surface.append(renderToolbar());
  if (loadError !== null) {
    surface.append(el("div", "empty error", loadError));
    app.replaceChildren(surface);
    return;
  }
  if (overview === null) {
    surface.append(el("div", "empty", "Loading the fleet…"));
    app.replaceChildren(surface);
    return;
  }

  let renderedGroups = 0;
  for (const group of orderedGroups()) {
    const taskVerificationVisible = groupVerificationCount(group) > 0 && (filter === "active" || filter === "attention");
    const visible = group.sessions.filter((session) => (taskVerificationVisible || sessionVisible(session)) && matchesText(session, group));
    if (visible.length === 0) continue;
    renderedGroups += 1;
    surface.append(renderGroup(group, visible));
  }

  if (overview.landing !== undefined && overview.landing.length > 0) {
    surface.append(renderLandingDrawer(overview.landing));
  }

  const visibleOrphans = overview.orphanSessions.filter((session) => sessionVisible(session) && matchesText(session));
  if (visibleOrphans.length > 0) {
    surface.append(renderOrphanDrawer(visibleOrphans));
  }

  if (renderedGroups === 0 && visibleOrphans.length === 0) {
    surface.append(renderEmptyState());
  }
  app.replaceChildren(surface);
}

function renderToolbar(): HTMLElement {
  const bar = el("div", "toolbar");
  const rollup = el("div", "rollup");
  rollup.setAttribute("role", "status");
  rollup.setAttribute("aria-live", "polite");
  rollup.setAttribute("aria-atomic", "true");
  const sessions = allSessions();
  const runningCount = sessions.filter((session) => turnRunning.has(session.sessionId)).length;
  const waitingCount = sessions.filter((session) => needsAttention(session)).length
    + (overview?.groups.reduce((sum, group) => sum + groupVerificationCount(group), 0) ?? 0);
  const idleCount = sessions.filter((session) => isIdle(session)).length;
  const runningPart = el("span", "rollup-running", `● ${String(runningCount)} running`);
  const waitingPart = el("span", waitingCount > 0 ? "rollup-waiting loud" : "rollup-waiting", `${String(waitingCount)} waiting on you`);
  const idlePart = el("span", "rollup-idle", `${String(idleCount)} idle`);
  rollup.append(runningPart, el("span", "rollup-sep", "·"), waitingPart, el("span", "rollup-sep", "·"), idlePart);
  // Fleet cost line (ADR 0013): live token total across every session's fold.
  // Honest scope: this window's live data — no durable ledger exists yet.
  const fleetTokens = sessions.reduce((sum, session) => sum + (activityFor(session)?.root?.tokens ?? 0), 0);
  if (fleetTokens > 0) {
    rollup.append(el("span", "rollup-sep", "·"), el("span", "rollup-tokens", `Σ ${formatTokens(fleetTokens)}`));
  }

  const seg = el("div", "seg");
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", "Agent filter");
  for (const mode of FILTER_MODES) {
    const segButton = document.createElement("button");
    segButton.type = "button";
    segButton.className = filter === mode ? "seg-item on" : "seg-item";
    segButton.textContent = FILTER_LABEL[mode];
    segButton.setAttribute("aria-pressed", String(filter === mode));
    segButton.addEventListener("click", () => {
      filter = mode;
      persist();
      render();
    });
    seg.append(segButton);
  }

  // Detail seg (ADR 0013): per-panel density override over the config default.
  const detailSeg = el("div", "seg seg-detail");
  detailSeg.setAttribute("role", "group");
  detailSeg.setAttribute("aria-label", "Row detail");
  const DETAIL_SHORT: Record<CardDetailLevel, string> = { minimal: "Min", standard: "Std", full: "Full" };
  for (const level of CARD_DETAIL_LEVELS) {
    const segButton = document.createElement("button");
    segButton.type = "button";
    segButton.className = detailLevel() === level ? "seg-item on" : "seg-item";
    segButton.textContent = DETAIL_SHORT[level];
    segButton.setAttribute("aria-pressed", String(detailLevel() === level));
    segButton.title = `Detail: ${level}${level === "minimal" ? " — one state chip per row; hover a row for the rest" : ""}`;
    segButton.addEventListener("click", () => {
      cardDetailChoice = level;
      persist();
      render();
    });
    detailSeg.append(segButton);
  }

  const search = document.createElement("input");
  search.type = "text";
  search.className = "filter-input";
  search.placeholder = "Filter tasks & sessions…";
  search.setAttribute("aria-label", "Filter tasks and sessions");
  search.value = textFilter;
  search.addEventListener("input", () => {
    textFilter = search.value.trim();
    // Re-render everything below the toolbar, but keep this input's focus:
    // render() rebuilds the DOM, so restore focus and caret afterwards.
    const caret = search.selectionStart;
    render();
    const fresh = app?.querySelector<HTMLInputElement>(".filter-input");
    if (fresh) {
      fresh.focus();
      if (caret !== null) fresh.setSelectionRange(caret, caret);
    }
  });

  setHelpTooltip(search, "Filter the current list by task or session title. This changes only the displayed rows.");
  bar.append(rollup, seg, detailSeg, search, help.launcher("fleet-help-launcher"));
  return bar;
}

function renderGroup(group: AgentsTaskGroup, visible: readonly ChatSessionSummary[]): HTMLElement {
  const section = el("section", "group");
  const head = el("div", "ghead");
  const collapsed = collapsedGroups.has(group.task.taskId);
  const toggleButton = document.createElement("button");
  toggleButton.type = "button";
  toggleButton.className = "ghead-toggle";
  toggleButton.setAttribute("aria-expanded", String(!collapsed));
  toggleButton.title = collapsed ? "Expand task agents" : "Collapse task agents";

  const toggle = el("span", "gtoggle", collapsed ? "▸" : "▾");
  const title = el("span", "gtitle", group.task.title);
  toggleButton.append(toggle, title);
  if (group.columnName !== undefined) {
    toggleButton.append(chip(group.columnName, `colchip cat-${group.columnCategory ?? "none"}`));
  }
  const attention = groupAttentionCount(group);
  if (attention > 0) toggleButton.append(chip(`${String(attention)} waiting`, "chip-attention"));
  head.append(toggleButton);

  const meta = el("span", "gmeta");
  const running = groupRunningCount(group);
  if (running > 0) meta.append(el("span", "gmeta-part", `${String(running)} running`));
  // Per-task token rollup (ADR 0013): header metadata, folded from the same
  // live activity the rows use. Hidden at minimal detail (passive metadata).
  if (detailLevel() !== "minimal") {
    const groupTokens = group.sessions.reduce((sum, session) => sum + (activityFor(session)?.root?.tokens ?? 0), 0);
    if (groupTokens > 0) meta.append(el("span", "gmeta-tokens", formatTokens(groupTokens)));
  }
  meta.append(
    actionButton("board", "Open the Task Board panel", () => {
      void request({ type: "taskBoard.open" });
    }, "link"),
    actionButton("review", "Open Task Review for this task", () => {
      void request({ type: "taskReview.open", taskId: group.task.taskId });
    }, "link")
  );
  head.append(meta);
  toggleButton.addEventListener("click", () => {
    if (collapsedGroups.has(group.task.taskId)) {
      collapsedGroups.delete(group.task.taskId);
    } else {
      collapsedGroups.add(group.task.taskId);
    }
    render();
  });
  section.append(head);

  if (!collapsed) {
    const verificationCount = groupVerificationCount(group);
    if (verificationCount > 0) {
      const verification = el("div", "row row-note task-verification");
      verification.append(
        chip("verify", "chip-attention"),
        el("span", "task-verification-label", `${String(verificationCount)} subtask${verificationCount === 1 ? "" : "s"} awaiting human verification`),
        actionButton("open board", "Open the Task Board to inspect and record verification", () => {
          void request({ type: "taskBoard.open" });
        }, "link")
      );
      section.append(verification);
    }
    const visibleIds = new Set(visible.map((session) => session.sessionId));
    for (const root of sessionForest(group.sessions)) {
      appendSessionNode(section, root, 0, visibleIds);
    }
  }
  return section;
}

function appendSessionNode(target: HTMLElement, node: SessionNode, depth: number, visibleIds: ReadonlySet<string>): void {
  // A hidden parent still renders (dimmed) when a visible child needs its
  // anchor; a fully-hidden subtree is skipped.
  const subtreeVisible = (candidate: SessionNode): boolean =>
    visibleIds.has(candidate.session.sessionId) || candidate.children.some(subtreeVisible);
  if (!subtreeVisible(node)) return;
  target.append(renderSessionRow(node.session, depth, !visibleIds.has(node.session.sessionId)));
  const activity = activityFor(node.session);
  appendSubagentRows(target, node.session, activity, depth + 1);
  const cappedDepth = Math.min(depth + 1, MAX_NEST_DEPTH);
  for (const child of node.children) {
    appendSessionNode(target, child, cappedDepth, visibleIds);
  }
}

function sessionDotClass(session: ChatSessionSummary): string {
  if (session.status === "failed" || failedTurn.has(session.sessionId)) return "dot dot-fail";
  if (session.runningElsewhere === true) return "dot dot-half";
  // ADR 0013: a reclaimed/resumed session is BOOTING — not idle, not ended.
  if (session.status === "starting") return "dot dot-boot";
  if (turnRunning.has(session.sessionId)) return "dot dot-run";
  if (session.live === true) return "dot dot-idle";
  return "dot dot-hollow";
}

function renderSessionRow(session: ChatSessionSummary, depth: number, dimmed: boolean): HTMLElement {
  const row = el("div", `row session-row depth-${String(Math.min(depth, MAX_NEST_DEPTH))}${dimmed ? " dimmed" : ""}`);
  row.title = "Open this session's chat in the sidebar";
  const open = (): void => {
    void request({ type: "agents.openSession", sessionId: session.sessionId });
  };

  row.append(el("span", sessionDotClass(session)));
  const title = document.createElement("button");
  title.type = "button";
  title.className = "session-open stitle";
  title.textContent = session.title;
  title.title = "Open this session's chat in the sidebar";
  title.addEventListener("click", (event) => {
    event.stopPropagation();
    open();
  });
  row.append(title);

  const level = detailLevel();
  const activity = activityFor(session);
  const questions = pendingQuestionsFor(session.sessionId);
  const access = pendingAccessFor(session.sessionId);
  const turnFailed = failedTurn.has(session.sessionId) || session.status === "failed";
  const fanFailed = activity !== undefined && activity.failed > 0;

  if (level === "minimal") {
    // One-chip rule (ADR 0013): waiting-on-you beats failed beats everything;
    // "running" needs no chip — the dot and the live duration already say it.
    if (questions.length > 0) row.append(chip(questions.length === 1 ? "? question" : `? ${String(questions.length)} questions`, "chip-q"));
    else if (access.length > 0) row.append(chip(access.length === 1 ? "⚠ access" : `⚠ ${String(access.length)} access`, "chip-a"));
    else if (turnFailed) row.append(chip("✗ failed", "chip-x"));
    else if (fanFailed) row.append(chip("⑂ failed", "chip-fan chip-fan-failed"));
  } else {
    const model = session.model === undefined ? "" : ` · ${session.model}`;
    row.append(chip(`${session.providerId}${model}`, "chip-provider"));
    if (session.mode !== undefined && session.mode !== "implementation") row.append(chip(session.mode, "chip-mode"));
    if (session.spawnedRole !== undefined) row.append(chip(`role · ${session.spawnedRole}`, "chip-role"));
    if (activity !== undefined && activity.running > 0) {
      row.append(chip(`⑂ ${String(activity.running)}`, fanFailed ? "chip-fan chip-fan-failed" : "chip-fan"));
    } else if (fanFailed) {
      row.append(chip("⑂ failed", "chip-fan chip-fan-failed"));
    }
    if (questions.length > 0) row.append(chip(questions.length === 1 ? "? question" : `? ${String(questions.length)} questions`, "chip-q"));
    if (access.length > 0) row.append(chip(access.length === 1 ? "⚠ access" : `⚠ ${String(access.length)} access`, "chip-a"));
    if (turnFailed) row.append(chip("✗ failed", "chip-x"));
  }

  row.append(renderSessionActivityLine(session, activity, questions));
  row.append(renderSessionMeta(session, activity));
  if (level !== "full") row.append(buildSessionHoverCard(session, activity, questions.length, access.length));

  row.addEventListener("click", () => {
    open();
  });
  return row;
}

function renderSessionActivityLine(
  session: ChatSessionSummary,
  activity: AgentActivitySummary | undefined,
  questions: readonly AgentQuestionSummary[]
): HTMLElement {
  const line = el("span", "act");
  if (session.runningElsewhere === true) {
    line.classList.add("note");
    line.textContent = "running in another window — view only";
    return line;
  }
  if (session.status === "starting") {
    // ADR 0013: honest boot state while a resume/reclaim recreates the
    // runtime and clones — neither idle nor running a turn yet.
    line.classList.add("note");
    line.textContent = "resuming — recreating the runtime and clones";
    return line;
  }
  const firstQuestion = questions[0];
  if (firstQuestion !== undefined) {
    line.textContent = `waiting: “${firstQuestion.question}”`;
    return line;
  }
  const root = activity?.root;
  if (root !== undefined && (root.lastActivity !== undefined || root.lastCommand !== undefined)) {
    const command = root.lastCommand === undefined ? "" : `$ ${root.lastCommand} — `;
    line.textContent = `${command}${root.lastActivity ?? ""}`;
    return line;
  }
  if (session.description !== undefined && session.description !== "") {
    line.textContent = session.description;
    return line;
  }
  line.textContent = session.live === true ? "no activity this turn yet" : "";
  return line;
}

function renderSessionMeta(session: ChatSessionSummary, activity: AgentActivitySummary | undefined): HTMLElement {
  const meta = el("span", "rmeta");
  const root = activity?.root;
  const running = turnRunning.has(session.sessionId);

  if (session.runningElsewhere === true) {
    meta.append(el("span", "rmeta-part", "—"));
    return meta;
  }
  if (running && root?.startedAt !== undefined) {
    const startedAt = root.startedAt;
    const duration = el("span", "rmeta-part num");
    duration.append(tickerText(() => formatDuration(Date.now() - Date.parse(startedAt))));
    meta.append(duration);
  } else if (isIdle(session)) {
    const last = root?.lastActivityAt ?? session.updatedAt;
    const idleNode = el("span", "rmeta-part idle-label");
    idleNode.append(tickerText(() => `idle ${formatAgo(last).replace(" ago", "")}`));
    meta.append(idleNode);
  } else {
    const updated = el("span", "rmeta-part quiet");
    updated.append(tickerText(() => formatAgo(session.updatedAt)));
    meta.append(updated);
  }
  const level = detailLevel();
  if (level !== "minimal" && root?.tokens !== undefined) meta.append(el("span", "rmeta-part num", formatTokens(root.tokens)));
  if (level === "full" && root !== undefined && root.toolUses > 0) {
    meta.append(el("span", "rmeta-part quiet", `${String(root.toolUses)} calls`));
  }

  if (running && session.live === true) {
    const armed = armedStopId === session.sessionId;
    meta.append(actionButton(armed ? "Confirm" : "Stop", "Cancel this session's current turn", () => {
      if (armedStopId !== session.sessionId) {
        armedStopId = session.sessionId;
        render();
        return;
      }
      armedStopId = null;
      void request({ type: "chat.cancelTurn", sessionId: session.sessionId }).then((response) => {
        // A refused cancel (ended meanwhile, running elsewhere) heals on refetch.
        if (!response.ok) scheduleRefetch();
      });
      render();
    }, armed ? "stop armed" : "stop"));
  }
  return meta;
}

function appendSubagentRows(
  target: HTMLElement,
  session: ChatSessionSummary,
  activity: AgentActivitySummary | undefined,
  depth: number
): void {
  const tier = subagentReportingForTransport(session.transport ?? "");
  const agents = activity?.agents ?? [];
  if (agents.length === 0) {
    // Honest tiers: a silent tree must say WHY it is silent — but only while
    // work is live (ended rows carry their history in the transcript).
    if (tier === "none" && turnRunning.has(session.sessionId)) {
      target.append(el("div", `row row-note depth-${String(Math.min(depth, MAX_NEST_DEPTH))}`, "no subagent signal for this transport"));
    }
    return;
  }
  const byParent = new Map<string, AgentActivityItem[]>();
  for (const agent of agents) {
    const key = agent.parentNodeId ?? "root";
    const bucket = byParent.get(key);
    if (bucket === undefined) {
      byParent.set(key, [agent]);
    } else {
      bucket.push(agent);
    }
  }
  const appendLevel = (parentKey: string, level: number): void => {
    for (const agent of byParent.get(parentKey) ?? []) {
      target.append(renderSubagentRow(session, agent, level));
      appendLevel(agent.nodeId, Math.min(level + 1, MAX_NEST_DEPTH));
    }
  };
  appendLevel("root", depth);
  if (tier === "lifecycle") {
    target.append(el("div", `row row-note depth-${String(Math.min(depth, MAX_NEST_DEPTH))}`, "this transport reports lifecycle only — no per-agent feed"));
  }
}

function subagentDotClass(status: AgentActivityItem["status"]): string {
  switch (status) {
    case "running": return "dot dot-run";
    case "failed": return "dot dot-fail";
    case "cancelled": return "dot dot-hollow";
    case "unknown": return "dot dot-unknown";
    case "completed": return "dot dot-done";
  }
}

function renderSubagentRow(session: ChatSessionSummary, agent: AgentActivityItem, depth: number): HTMLElement {
  const row = el("div", `row row-sub depth-${String(Math.min(depth, MAX_NEST_DEPTH))}`);
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  row.title = "Open this agent in the sidebar's Agents lens";
  row.append(el("span", subagentDotClass(agent.status)));
  row.append(el("span", "slabel", agent.label));
  if (agent.status === "failed") row.append(chip("failed", "chip-x"));
  if (agent.status === "unknown") row.append(chip("unknown", "chip-mode"));

  const line = el("span", "act");
  const command = agent.lastCommand === undefined ? "" : `${agent.lastCommand} — `;
  line.textContent = `${command}${agent.lastActivity ?? ""}`;
  row.append(line);

  const meta = el("span", "rmeta");
  if (agent.status === "running" && agent.startedAt !== undefined) {
    const startedAt = agent.startedAt;
    const duration = el("span", "rmeta-part num");
    duration.append(tickerText(() => formatDuration(Date.now() - Date.parse(startedAt))));
    meta.append(duration);
  } else if (agent.startedAt !== undefined && agent.endedAt !== undefined) {
    meta.append(el("span", "rmeta-part num", formatDuration(Date.parse(agent.endedAt) - Date.parse(agent.startedAt))));
  }
  if (detailLevel() !== "minimal") {
    if (agent.toolUses > 0) meta.append(el("span", "rmeta-part quiet", `${String(agent.toolUses)} calls`));
    if (agent.tokens !== undefined) meta.append(el("span", "rmeta-part num", formatTokens(agent.tokens)));
  }
  row.append(meta);

  const open = (): void => {
    void request({ type: "agents.openSession", sessionId: session.sessionId, nodeId: agent.nodeId });
  };
  row.addEventListener("click", (event) => {
    event.stopPropagation();
    open();
  });
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  });
  return row;
}

/**
 * The consolidated hover card (ADR 0013): ONE popover per row carrying
 * everything the current detail level hides — never per-chip tooltips.
 * Pure CSS reveal on row :hover/:focus-within; pointer-events stay off so
 * it never intercepts row clicks.
 */
function buildSessionHoverCard(
  session: ChatSessionSummary,
  activity: AgentActivitySummary | undefined,
  questionCount: number,
  accessCount: number
): HTMLElement {
  const hover = el("div", "hovercard");
  const row = (label: string, value: string): void => {
    const line = el("div", "hrow");
    line.append(el("span", "hlabel", label), el("span", "hvalue", value));
    hover.append(line);
  };
  row("provider", session.model === undefined ? session.providerId : `${session.providerId} · ${session.model}`);
  if (session.mode !== undefined) row("mode", session.mode);
  if (session.spawnedRole !== undefined) row("role", session.spawnedRole);
  if (session.transport !== undefined) row("transport", session.transport);
  if (activity !== undefined && (activity.running > 0 || activity.failed > 0)) {
    const parts = [];
    if (activity.running > 0) parts.push(`${String(activity.running)} running`);
    if (activity.failed > 0) parts.push(`${String(activity.failed)} failed`);
    row("subagents", parts.join(" · "));
  }
  const root = activity?.root;
  if (root?.tokens !== undefined) row("tokens", formatTokens(root.tokens));
  if (root !== undefined && root.toolUses > 0) row("tool calls", String(root.toolUses));
  if (questionCount > 0) row("questions", String(questionCount));
  if (accessCount > 0) row("access", String(accessCount));
  row("updated", formatAgo(session.updatedAt));
  return hover;
}

/**
 * Landing drawer (ADR 0014): subtasks with unlanded changesets, disjoint
 * first. Pull = the same full clone pull as the Changes tray (two-click),
 * after which the landed rows leave the drawer on the refetch. Overlap chips
 * never hide — they are exactly the thing to look at before pulling.
 */
function renderLandingDrawer(items: readonly LandingItem[]): HTMLElement {
  const section = el("section", "group drawer landing");
  const head = el("div", "ghead");
  const toggleButton = document.createElement("button");
  toggleButton.type = "button";
  toggleButton.className = "ghead-toggle";
  toggleButton.setAttribute("aria-expanded", String(landingOpen));
  toggleButton.title = landingOpen ? "Collapse Landing" : "Expand Landing";
  toggleButton.append(
    el("span", "gtoggle", landingOpen ? "▾" : "▸"),
    el("span", "gtitle", `Landing (${String(items.length)})`)
  );
  head.append(toggleButton, el("span", "gmeta", "unlanded changesets · disjoint first"));
  toggleButton.addEventListener("click", () => {
    landingOpen = !landingOpen;
    render();
  });
  section.append(head);
  if (!landingOpen) return section;

  if (landingNotice !== null) {
    const notice = el("div", "row row-note", landingNotice);
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    section.append(notice);
  }
  for (const item of items) {
    const row = el("div", "row depth-0 landing-row");
    row.append(el("span", item.overlapsWith.length > 0 ? "dot dot-unknown" : "dot dot-done"));
    row.append(el("span", "stitle", `${item.taskTitle} · ${item.subtaskTitle}`));
    if (item.overlapsWith.length > 0) {
      row.append(chip(`⚠ overlaps ${String(item.overlapsWith.length)}`, "chip-a"));
    } else if (item.overlapUnknown === true) {
      row.append(chip("overlap unknown", "chip-mode"));
    }
    const line = el("span", "act");
    line.textContent = item.repos.map((repo) => `${repo.repoName} (${String(repo.fileCount)} file${repo.fileCount === 1 ? "" : "s"})`).join(" · ");
    row.append(line);

    const meta = el("span", "rmeta");
    meta.append(el("span", "rmeta-part quiet", formatAgo(item.capturedAt)));
    const armed = armedLandId === item.subtaskId;
    const pull = actionButton(armed ? "Confirm pull" : "Pull", "Pull this run's clone work into your working copy and mark it landed", () => {
      if (armedLandId !== item.subtaskId) {
        armedLandId = item.subtaskId;
        render();
        return;
      }
      armedLandId = null;
      landingNotice = `Pulling ${item.subtaskTitle}…`;
      render();
      void request({ type: "agents.landSession", sessionId: item.sessionId }).then((response) => {
        landingNotice = response.ok && response.payload.type === "agents.landSession"
          ? response.payload.message
          : `pull failed: ${response.ok ? "unexpected response" : response.error.message}`;
        scheduleRefetch();
        render();
      });
    }, armed ? "stop armed" : "");
    pull.disabled = isDemoMode();
    if (isDemoMode()) pull.title = "Demo data does not write to your working copy. Switch to Live data to pull this work.";
    meta.append(pull);
    row.append(meta);
    section.append(row);
  }
  return section;
}

function renderOrphanDrawer(orphans: readonly ChatSessionSummary[]): HTMLElement {
  const section = el("section", "group drawer");
  const head = el("div", "ghead");
  const toggleButton = document.createElement("button");
  toggleButton.type = "button";
  toggleButton.className = "ghead-toggle";
  toggleButton.setAttribute("aria-expanded", String(orphansOpen));
  toggleButton.title = orphansOpen ? "Collapse sessions without a task" : "Expand sessions without a task";
  toggleButton.append(
    el("span", "gtoggle", orphansOpen ? "▾" : "▸"),
    el("span", "gtitle quiet", `Sessions without a task (${String(orphans.length)})`)
  );
  head.append(toggleButton);
  toggleButton.addEventListener("click", () => {
    orphansOpen = !orphansOpen;
    render();
  });
  section.append(head);
  if (orphansOpen) {
    const visibleIds = new Set(orphans.map((session) => session.sessionId));
    for (const root of sessionForest(orphans)) {
      appendSessionNode(section, root, 0, visibleIds);
    }
  }
  return section;
}

function renderEmptyState(): HTMLElement {
  if (filter === "attention") {
    return el("div", "empty", "Nothing is waiting on you.");
  }
  if (filter === "active" && allSessions().length > 0) {
    return el("div", "empty", "No agents are active right now. Switch to All to see finished sessions.");
  }
  return el("div", "empty", "No sessions yet — start a chat from a task, and the fleet shows up here.");
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
  render();
  if (pendingGuideStart) {
    pendingGuideStart = false;
    window.setTimeout(() => help.startTour(), 0);
  }
}

window.setInterval(() => {
  for (const ticker of tickers) {
    ticker.node.textContent = ticker.compute();
  }
}, 1000);

render();
void loadOverview();
