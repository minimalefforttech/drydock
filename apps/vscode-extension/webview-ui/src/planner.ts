/**
 * Planner editor panel webview (ADR 0012).
 *
 * A single-page surface with two screens: the landing (recent plans + the
 * intake form + the aspect-registry editor) and the plan view — outputs tree
 * and heading outline behind a draggable splitter (left by default), the
 * provider viewer (center), and the chat rail (right; the shared chat
 * components land in P3). The two rails swap with ⇄, collapse to icon strips,
 * and auto-collapse below ~900px; layout preferences persist via webview state
 * (UI-local only — domain data is always refetched from the host).
 *
 * SECURITY: every dynamic string renders via textContent — NEVER innerHTML.
 * This entry is self-contained (it does not import the control-panel bundle).
 */

import {
  WEBVIEW_PROTOCOL_VERSION,
  type ChatSessionSummary,
  type HostToWebviewMessage,
  type PanelPushPayload,
  type PanelRequestPayload,
  type PanelResponse,
  type PlanAnnotationSummary,
  type PlanArtifactDetail,
  type PlanAspectSummary,
  type PlannerStateDetail,
  type PlanSummary
} from "@drydock/contracts";
import { badge, button, chip, el, popover, relativeTime, statusDot } from "./components.js";
import {
  chatMessageRow,
  workingIndicatorRow,
  type MessageRowContext
} from "./chat/messageRow.js";
import {
  TranscriptFolder,
  type AgentGroup,
  type ChatMessage as RailMessage
} from "./chat/transcriptModel.js";
import {
  DiagramProvider,
  DocumentProvider,
  ImageProvider,
  PrototypeProvider,
  renderAnnotationDock,
  type ArtifactProvider
} from "./plannerViewer.js";

interface PersistedState {
  readonly selectedPlanId: string | null;
  readonly selectedArtifactId: string | null;
  readonly layoutSwapped: boolean;
  readonly leftCollapsed: boolean;
  readonly rightCollapsed: boolean;
  readonly splitRatio: number;
}

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): PersistedState | undefined;
  setState(state: PersistedState): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscodeApi = acquireVsCodeApi();
const app = document.getElementById("app");
if (!app) throw new Error("missing #app root");

const REQUEST_TIMEOUT_MS = 60_000;
const NARROW_QUERY = "(max-width: 900px)";
const KIND_GLYPHS: Record<PlanArtifactDetail["kind"], string> = {
  document: "▤",
  diagram: "◇",
  image: "▣",
  prototype: "⧉"
};

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

const pending = new Map<string, { resolve: (value: PanelResponse) => void; timer: number }>();
let requestCounter = 0;

function request(payload: PanelRequestPayload): Promise<PanelResponse> {
  requestCounter += 1;
  const requestId = `planner-req-${String(requestCounter)}-${String(Date.now())}`;
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

let plans: readonly PlanSummary[] = [];
let aspects: readonly PlanAspectSummary[] = [];
let currentPlanId: string | null = null;
let currentState: PlannerStateDetail | null = null;
let currentSession: ChatSessionSummary | null = null;
let selectedArtifactId: string | null = null;
/** Session boot in flight (create/startSession acked; sessionReady pending). */
let booting = false;
let turnActive = false;
let notice: { text: string; tone: "info" | "error" } | null = null;
/** Header aspect-chip filter for the outputs tree (transient, click to clear). */
let aspectFilter: string | null = null;
/** Revision seen per artifact, for the "updated" flash on refetch. */
const seenRevisions = new Map<string, number>();
const flashArtifacts = new Set<string>();

let layoutSwapped = false;
let leftCollapsed = false;
let rightCollapsed = false;
let splitRatio = 0.55;
/**
 * Narrow windows auto-collapse both rails to strips; tapping a strip flies the
 * rail out as an overlay. This is transient presentation state — it never
 * touches the persisted collapse preferences.
 */
let narrowOverlay: "outputs" | "chat" | null = null;

// ---------------------------------------------------------------------------
// Chat rail state: the plan session's transcript, folded through the SAME
// shared reducer/renderer as the Chat tab (chat/transcriptModel + messageRow).
// Rebuilt from session.timeline on session switch; live pushes append.
// ---------------------------------------------------------------------------

let railMessages: RailMessage[] = [];
let railGroups: Record<string, AgentGroup> = {};
let railSessionId: string | null = null;
let railLastSequence = 0;
let railTurnStartedAt: number | undefined;
let railLastActivityAt: number | undefined;
let railReasoningActive = false;
let railReasoningText = "";
let railTickTimer: number | undefined;
let railLogEl: HTMLElement | null = null;

const railFolder = new TranscriptFolder(
  {
    get messages() { return railMessages; },
    get groups() { return railGroups; }
  },
  {
    // The planner has no diagnostics feed; unrouted lines stay model-only.
    onDiagnostic: () => {},
    // Artifact changes arrive through collection, not the working set.
    onFileEdit: () => {},
    onSystemMessage: (text, tone) => {
      railFolder.appendSystemMessage({ text, tone });
    },
    onReasoning: (text) => {
      railReasoningActive = true;
      railReasoningText += text;
      renderRailLog();
    },
    onRender: () => renderRailLog(),
    onPersist: () => {
      // Rail state is rebuilt from the durable timeline; nothing UI-local persists.
    }
  }
);

const railContext: MessageRowContext = {
  authorLabel: () => (currentSession?.model ? `Planner · ${currentSession.model}` : "Planner"),
  openLink: (href) => {
    void request({ type: "chat.openFile", path: href });
  },
  renderUserBody: (container, text) => renderRailUserBody(container, text),
  groups: () => railGroups
};

const RAIL_BRIEFING_START = "[host briefing";
const RAIL_BRIEFING_END = "[end host briefing";

/**
 * First turns carry host briefings (the session mount briefing and the
 * planner's own). Collapse any leading `[host briefing…]…[end host briefing…]`
 * spans into disclosures so the rail leads with what was actually asked.
 */
function renderRailUserBody(container: HTMLElement, text: string): void {
  let rest = text;
  for (let guard = 0; guard < 3; guard += 1) {
    const start = rest.indexOf(RAIL_BRIEFING_START);
    if (start === -1) break;
    const endMark = rest.indexOf(RAIL_BRIEFING_END, start);
    if (endMark === -1) break;
    const endLine = rest.indexOf("]", endMark);
    if (endLine === -1) break;
    const briefing = rest.slice(start, endLine + 1);
    const before = rest.slice(0, start).trim();
    if (before.length > 0) {
      const lead = el("div", "host-briefing-remainder");
      lead.textContent = before;
      container.append(lead);
    }
    const disclosure = document.createElement("details");
    disclosure.className = "host-briefing-detail";
    const summary = document.createElement("summary");
    summary.textContent = "Host briefing";
    const pre = document.createElement("pre");
    pre.className = "host-briefing-pre";
    pre.textContent = briefing;
    disclosure.append(summary, pre);
    container.append(disclosure);
    rest = rest.slice(endLine + 1);
  }
  const remainder = rest.trim();
  if (remainder.length > 0 || container.childElementCount === 0) {
    const body = el("div", "host-briefing-remainder");
    body.textContent = remainder.length > 0 ? remainder : text;
    container.append(body);
  }
}

function resetRail(sessionId: string | null): void {
  railSessionId = sessionId;
  railMessages = [];
  railGroups = {};
  railLastSequence = 0;
  railReasoningActive = false;
  railReasoningText = "";
  railFolder.clearLiveState();
  renderRailLog();
}

/** Incremental timeline pull — the same replay mechanism the Chat tab uses. */
async function syncRail(): Promise<void> {
  const sessionId = currentState?.plan.sessionId ?? null;
  if (sessionId === null) {
    if (railSessionId !== null) resetRail(null);
    return;
  }
  if (railSessionId !== sessionId) {
    resetRail(sessionId);
  }
  const response = await request({ type: "session.timeline", sessionId, fromSequence: railLastSequence + 1 });
  if (!response.ok || response.payload.type !== "session.timeline") return;
  if (railSessionId !== sessionId) return;
  for (const line of response.payload.lines) {
    if (line.sequence <= railLastSequence) continue;
    railFolder.apply(line, false);
    railLastSequence = line.sequence;
  }
  renderRailLog();
}

/** Re-renders only the rail's log (never the whole panel) — cheap per push. */
function renderRailLog(): void {
  if (railLogEl === null || !railLogEl.isConnected) return;
  railLogEl.replaceChildren();
  if (railMessages.length === 0 && !turnActive && !booting) {
    const empty = el("div", "pl-rail-empty");
    empty.textContent = railSessionId === null
      ? "No session yet — creating the plan starts one, or send a message below."
      : "The session transcript will appear here.";
    railLogEl.append(empty);
    return;
  }
  for (const message of railMessages) {
    railLogEl.append(chatMessageRow(message, railContext));
  }
  if (turnActive || booting) {
    railLogEl.append(workingIndicatorRow({
      ...(railTurnStartedAt === undefined ? {} : { turnStartedAt: railTurnStartedAt }),
      ...(railLastActivityAt === undefined ? {} : { lastActivityAt: railLastActivityAt }),
      ...(railReasoningActive ? { reasoning: { text: railReasoningText } } : {})
    }));
  } else if (railReasoningActive) {
    // Frozen "Thought for Ns" stays readable until the next turn starts.
    railLogEl.append(workingIndicatorRow({ reasoning: { text: railReasoningText } }));
  }
  railLogEl.scrollTop = railLogEl.scrollHeight;
}

function setRailTicking(active: boolean): void {
  if (railTickTimer !== undefined) {
    window.clearInterval(railTickTimer);
    railTickTimer = undefined;
  }
  if (active) {
    railTickTimer = window.setInterval(() => {
      if (!turnActive && !booting) return;
      const existing = railLogEl?.querySelector(".chat-working, .chat-reasoning");
      if (existing) {
        existing.replaceWith(workingIndicatorRow({
          ...(railTurnStartedAt === undefined ? {} : { turnStartedAt: railTurnStartedAt }),
          ...(railLastActivityAt === undefined ? {} : { lastActivityAt: railLastActivityAt }),
          ...(railReasoningActive ? { reasoning: { text: railReasoningText } } : {})
        }));
      }
    }, 1_000);
  }
}

const saved = vscodeApi.getState();
if (saved) {
  currentPlanId = saved.selectedPlanId;
  selectedArtifactId = saved.selectedArtifactId;
  layoutSwapped = saved.layoutSwapped;
  leftCollapsed = saved.leftCollapsed;
  rightCollapsed = saved.rightCollapsed;
  splitRatio = clampRatio(saved.splitRatio);
}

function persist(): void {
  vscodeApi.setState({
    selectedPlanId: currentPlanId,
    selectedArtifactId,
    layoutSwapped,
    leftCollapsed,
    rightCollapsed,
    splitRatio
  });
}

function clampRatio(value: number): number {
  return Number.isFinite(value) ? Math.min(0.85, Math.max(0.15, value)) : 0.55;
}

function applyPush(payload: PanelPushPayload): void {
  switch (payload.type) {
    case "planner.changed":
      if (payload.planId === currentPlanId) {
        void refreshState();
      } else {
        void refreshPlans();
      }
      return;
    case "planner.sessionReady":
      if (payload.planId !== currentPlanId) return;
      booting = false;
      if (!payload.ok) {
        notice = { text: payload.error ?? "The planning session failed to start.", tone: "error" };
      }
      void refreshState();
      return;
    case "chat.event":
      if (payload.sessionId === railSessionId && payload.line.sequence > railLastSequence) {
        railLastSequence = payload.line.sequence;
        if (turnActive) railLastActivityAt = Date.now();
        railFolder.apply(payload.line, false);
      }
      return;
    case "chat.turnStarted":
      if (currentState?.plan.sessionId === payload.sessionId) {
        turnActive = true;
        railFolder.clearActiveAssistant();
        railFolder.resetTurn();
        railReasoningActive = false;
        railReasoningText = "";
        railTurnStartedAt = Date.now();
        railLastActivityAt = Date.now();
        setRailTicking(true);
        render();
      }
      return;
    case "chat.turnCompleted":
      if (currentState?.plan.sessionId === payload.sessionId) {
        turnActive = false;
        railTurnStartedAt = undefined;
        setRailTicking(false);
        railFolder.clearActiveAssistant();
        // Catch any lines this window missed while the turn streamed.
        void syncRail();
        render();
      }
      return;
    case "session.updated":
      if (currentSession?.sessionId === payload.session.sessionId) {
        currentSession = payload.session;
        render();
      }
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function refreshPlans(): Promise<void> {
  const response = await request({ type: "planner.plans" });
  if (response.ok && response.payload.type === "planner.plans") {
    plans = response.payload.plans;
    if (currentPlanId === null) render();
  }
}

async function refreshAspects(): Promise<void> {
  const response = await request({ type: "planner.aspects.list" });
  if (response.ok && response.payload.type === "planner.aspects.list") {
    aspects = response.payload.aspects;
  }
}

async function refreshState(): Promise<void> {
  if (currentPlanId === null) return;
  const response = await request({ type: "planner.state", planId: currentPlanId });
  if (!response.ok) {
    notice = { text: response.error.message, tone: "error" };
    render();
    return;
  }
  if (response.payload.type !== "planner.state") return;
  const next = response.payload.state;
  // Flash artifacts whose revision moved since we last saw them.
  flashArtifacts.clear();
  for (const artifact of next.artifacts) {
    const seen = seenRevisions.get(artifact.artifactId);
    if (seen !== undefined && seen !== artifact.revision) {
      flashArtifacts.add(artifact.artifactId);
    }
    seenRevisions.set(artifact.artifactId, artifact.revision);
  }
  currentState = next;
  aspects = next.aspects;
  currentSession = response.payload.session;
  if (selectedArtifactId === null || !next.artifacts.some((artifact) => artifact.artifactId === selectedArtifactId)) {
    selectedArtifactId = next.artifacts[0]?.artifactId ?? null;
    persist();
  }
  render();
  void syncRail();
}

async function openPlan(planId: string): Promise<void> {
  currentPlanId = planId;
  currentState = null;
  currentSession = null;
  selectedArtifactId = null;
  seenRevisions.clear();
  resetRail(null);
  persist();
  render();
  await refreshState();
}

function backToLanding(): void {
  currentPlanId = null;
  currentState = null;
  currentSession = null;
  notice = null;
  persist();
  void refreshPlans().then(() => render());
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

const root = el("div", "pl-root");
app.append(root);

const narrowQuery = window.matchMedia(NARROW_QUERY);
function syncNarrow(): void {
  root.classList.toggle("pl-narrow", narrowQuery.matches);
}
narrowQuery.addEventListener("change", () => {
  narrowOverlay = null;
  syncNarrow();
  render();
});
syncNarrow();

/** Wide: the persisted preference. Narrow: strip unless flown out. */
function railCollapsed(side: "outputs" | "chat"): boolean {
  if (narrowQuery.matches) {
    return narrowOverlay !== side;
  }
  return side === "outputs" ? leftCollapsed : rightCollapsed;
}

function expandRail(side: "outputs" | "chat"): void {
  if (narrowQuery.matches) {
    narrowOverlay = side;
  } else if (side === "outputs") {
    leftCollapsed = false;
    persist();
  } else {
    rightCollapsed = false;
    persist();
  }
  render();
}

function collapseRail(side: "outputs" | "chat"): void {
  if (narrowQuery.matches) {
    narrowOverlay = null;
  } else if (side === "outputs") {
    leftCollapsed = true;
    persist();
  } else {
    rightCollapsed = true;
    persist();
  }
  render();
}

// A click outside an open narrow overlay closes it.
document.addEventListener("click", (event) => {
  if (!narrowQuery.matches || narrowOverlay === null) return;
  const target = event.target;
  if (target instanceof Node && root.querySelector(".pl-rail.rail-overlay")?.contains(target) === true) return;
  narrowOverlay = null;
  render();
}, true);

const providers: ArtifactProvider[] = [
  new DocumentProvider(),
  new DiagramProvider(),
  new ImageProvider(),
  new PrototypeProvider()
];
let activeProvider: ArtifactProvider | null = null;

// ---------------------------------------------------------------------------
// Rendering — top level
// ---------------------------------------------------------------------------

function render(): void {
  root.replaceChildren();
  root.append(renderNotice());
  if (currentPlanId === null || currentState === null) {
    root.append(renderLanding());
    return;
  }
  root.append(renderPlanView(currentState));
}

function renderNotice(): HTMLElement {
  const host = el("div", "pl-notice-host");
  if (notice === null) return host;
  const bar = el("div", `pl-notice pl-notice-${notice.tone}`);
  const text = el("span");
  text.textContent = notice.text;
  const dismiss = button("Dismiss", "ghost small");
  dismiss.addEventListener("click", () => {
    notice = null;
    render();
  });
  bar.append(text, dismiss);
  host.append(bar);
  return host;
}

// ---------------------------------------------------------------------------
// Landing: plans list + intake + aspect editor
// ---------------------------------------------------------------------------

/** Intake draft survives re-renders (not persisted — it is conversation-local). */
const intake = {
  brief: "",
  notes: "",
  selectedAspects: new Set<string>(),
  contextRoots: [] as string[],
  manageOpen: false
};

function renderLanding(): HTMLElement {
  const landing = el("div", "pl-landing");
  const plansPane = el("aside", "pl-plans");
  const plansHead = el("div", "pl-rail-head");
  const plansTitle = el("span", "pl-kicker");
  plansTitle.textContent = "PLANS";
  plansHead.append(plansTitle);
  plansPane.append(plansHead);
  const active = plans.filter((plan) => plan.status !== "archived");
  const archived = plans.filter((plan) => plan.status === "archived");
  if (active.length === 0) {
    const empty = el("div", "pl-empty");
    empty.textContent = "No plans yet — describe what you're building on the right.";
    plansPane.append(empty);
  }
  for (const plan of active) {
    plansPane.append(planCard(plan));
  }
  if (archived.length > 0) {
    const label = el("div", "pl-group-label");
    label.textContent = "ARCHIVED";
    plansPane.append(label);
    for (const plan of archived) {
      plansPane.append(planCard(plan));
    }
  }

  const form = el("section", "pl-intake");
  const kicker = el("div", "pl-kicker pl-kicker-accent");
  kicker.textContent = "NEW PLAN";
  form.append(kicker);

  form.append(fieldLabel("What are you building?"));
  const brief = document.createElement("textarea");
  brief.className = "pl-textarea";
  brief.rows = 3;
  brief.placeholder = "The problem, the shape of the solution, anything the agent should aim at…";
  brief.value = intake.brief;
  brief.addEventListener("input", () => {
    intake.brief = brief.value;
    createButton.disabled = intake.brief.trim().length === 0;
  });
  form.append(brief);

  const aspectHead = el("div", "pl-field-row");
  aspectHead.append(fieldLabel("Working on"), hint("select all that apply"));
  const manageLink = button(intake.manageOpen ? "Close manager" : "Manage aspects", "ghost small pl-manage-link");
  manageLink.addEventListener("click", () => {
    intake.manageOpen = !intake.manageOpen;
    render();
  });
  aspectHead.append(manageLink);
  form.append(aspectHead);
  const chipGrid = el("div", "pl-chip-grid");
  for (const aspect of aspects.filter((entry) => !entry.archived)) {
    const selected = intake.selectedAspects.has(aspect.aspectId);
    const node = chip(`${selected ? "✓ " : ""}${aspect.label}`, () => {
      if (selected) intake.selectedAspects.delete(aspect.aspectId);
      else intake.selectedAspects.add(aspect.aspectId);
      render();
    });
    node.classList.add("pl-aspect-chip");
    node.classList.toggle("selected", selected);
    node.title = aspect.instructions;
    chipGrid.append(node);
  }
  form.append(chipGrid);
  if (intake.manageOpen) {
    form.append(renderAspectManager());
  }

  form.append(fieldLabel("Context", "mounted read-only into the planning sandbox"));
  const rootsList = el("div", "pl-roots");
  for (const [index, contextRoot] of intake.contextRoots.entries()) {
    const row = el("div", "pl-root-row");
    const pathText = el("span", "pl-root-path");
    pathText.textContent = contextRoot;
    const remove = button("✕", "ghost small");
    remove.title = "Remove this context root";
    remove.addEventListener("click", () => {
      intake.contextRoots.splice(index, 1);
      render();
    });
    row.append(pathText, badge(":ro", "pl-ro"), remove);
    rootsList.append(row);
  }
  const addRow = el("div", "pl-root-add");
  const rootInput = document.createElement("input");
  rootInput.type = "text";
  rootInput.className = "pl-input";
  rootInput.placeholder = "Absolute folder or file path, e.g. C:\\repos\\app\\src";
  const addRoot = button("Add", "small");
  const commitRoot = (): void => {
    const value = rootInput.value.trim();
    if (value.length === 0) return;
    if (!intake.contextRoots.includes(value)) intake.contextRoots.push(value);
    rootInput.value = "";
    render();
  };
  addRoot.addEventListener("click", commitRoot);
  rootInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") commitRoot();
  });
  addRow.append(rootInput, addRoot);
  rootsList.append(addRow);
  form.append(rootsList);

  form.append(fieldLabel("Pre-information", "constraints, prior decisions, links"));
  const notes = document.createElement("textarea");
  notes.className = "pl-textarea";
  notes.rows = 2;
  notes.placeholder = "Anything the agent should know before it starts…";
  notes.value = intake.notes;
  notes.addEventListener("input", () => {
    intake.notes = notes.value;
  });
  form.append(notes);

  const footer = el("div", "pl-intake-footer");
  const persistenceNote = el("span", "pl-footnote");
  persistenceNote.textContent = "artifacts are collected to ~/.drydock after every turn — sandbox crashes lose nothing";
  const createButton = button("Create plan →", "primary");
  createButton.disabled = intake.brief.trim().length === 0;
  createButton.addEventListener("click", () => void createPlan(createButton));
  footer.append(persistenceNote, createButton);
  form.append(footer);

  landing.append(plansPane, form);
  return landing;
}

function planCard(plan: PlanSummary): HTMLElement {
  const cardNode = el("button", `pl-plan-card${plan.status === "archived" ? " archived" : ""}`);
  const title = el("div", "pl-plan-title");
  title.textContent = plan.title;
  const meta = el("div", "pl-plan-meta");
  meta.textContent = `${String(plan.artifactCount)} artifact${plan.artifactCount === 1 ? "" : "s"} · ${String(plan.openAnnotationCount)} open ✎ · ${relativeTime(plan.updatedAt)}`;
  cardNode.append(title, meta);
  cardNode.addEventListener("click", () => void openPlan(plan.planId));
  return cardNode;
}

async function createPlan(trigger: HTMLButtonElement): Promise<void> {
  trigger.disabled = true;
  trigger.textContent = "Creating…";
  const response = await request({
    type: "planner.create",
    brief: intake.brief.trim(),
    aspectIds: [...intake.selectedAspects],
    contextRoots: [...intake.contextRoots],
    ...(intake.notes.trim().length === 0 ? {} : { notes: intake.notes.trim() })
  });
  if (!response.ok) {
    notice = { text: response.error.message, tone: "error" };
    render();
    return;
  }
  if (response.payload.type !== "planner.create") return;
  booting = true;
  notice = { text: "Plan created — starting the planning session…", tone: "info" };
  intake.brief = "";
  intake.notes = "";
  intake.selectedAspects.clear();
  intake.contextRoots = [];
  await openPlan(response.payload.plan.planId);
}

function renderAspectManager(): HTMLElement {
  const manager = el("div", "pl-aspect-manager");
  for (const aspect of aspects) {
    manager.append(aspectEditorRow(aspect));
  }
  const newHead = el("div", "pl-group-label");
  newHead.textContent = "NEW ASPECT";
  manager.append(newHead, aspectEditorRow(null));
  return manager;
}

function aspectEditorRow(aspect: PlanAspectSummary | null): HTMLElement {
  const row = el("div", `pl-aspect-edit${aspect?.archived === true ? " archived" : ""}`);
  const labelInput = document.createElement("input");
  labelInput.type = "text";
  labelInput.className = "pl-input";
  labelInput.placeholder = "Label (e.g. Brand review)";
  labelInput.value = aspect?.label ?? "";
  const instructionsInput = document.createElement("textarea");
  instructionsInput.className = "pl-textarea";
  instructionsInput.rows = 2;
  instructionsInput.placeholder = "What this aspect asks the agent for…";
  instructionsInput.value = aspect?.instructions ?? "";
  const expectedInput = document.createElement("input");
  expectedInput.type = "text";
  expectedInput.className = "pl-input";
  expectedInput.placeholder = "Expected artifacts, semicolon-separated";
  expectedInput.value = (aspect?.expectedArtifacts ?? []).join("; ");

  const actions = el("div", "pl-aspect-actions");
  const idBadge = el("span", "pl-footnote");
  idBadge.textContent = aspect === null ? "" : `plan/${aspect.aspectId}/${aspect.seeded ? " · seeded" : ""}`;
  const save = button(aspect === null ? "Add aspect" : "Save", "small");
  save.addEventListener("click", () => {
    const label = labelInput.value.trim();
    const instructions = instructionsInput.value.trim();
    if (label.length === 0 || instructions.length === 0) {
      notice = { text: "An aspect needs both a label and instructions.", tone: "error" };
      render();
      return;
    }
    void request({
      type: "planner.aspects.save",
      aspect: {
        ...(aspect === null ? {} : { aspectId: aspect.aspectId }),
        label,
        instructions,
        expectedArtifacts: expectedInput.value.split(";").map((entry) => entry.trim()).filter((entry) => entry.length > 0)
      }
    }).then((response) => {
      if (response.ok && response.payload.type === "planner.aspects.save") {
        aspects = response.payload.aspects;
      } else if (!response.ok) {
        notice = { text: response.error.message, tone: "error" };
      }
      render();
    });
  });
  actions.append(idBadge, save);
  if (aspect !== null) {
    const archiveButton = button(aspect.archived ? "Restore" : "Archive", "ghost small");
    archiveButton.addEventListener("click", () => {
      void request({ type: "planner.aspects.archive", aspectId: aspect.aspectId, archived: !aspect.archived }).then((response) => {
        if (response.ok && response.payload.type === "planner.aspects.archive") {
          aspects = response.payload.aspects;
        }
        render();
      });
    });
    actions.append(archiveButton);
  }
  row.append(labelInput, instructionsInput, expectedInput, actions);
  return row;
}

function fieldLabel(text: string, hintText?: string): HTMLElement {
  const wrap = el("div", "pl-field-label");
  const label = el("span", "pl-label");
  label.textContent = text;
  wrap.append(label);
  if (hintText !== undefined) {
    wrap.append(hint(hintText));
  }
  return wrap;
}

function hint(text: string): HTMLElement {
  const node = el("span", "pl-hint");
  node.textContent = text;
  return node;
}

// ---------------------------------------------------------------------------
// Plan view
// ---------------------------------------------------------------------------

function renderPlanView(state: PlannerStateDetail): HTMLElement {
  const view = el("div", "pl-plan-view");
  view.append(renderPlanHeader(state));

  const body = el("div", `pl-body${layoutSwapped ? " swapped" : ""}`);
  const outputsRail = renderOutputsRail(state);
  const viewer = renderViewer(state);
  const chatRail = renderChatRail();
  // DOM order stays outputs/viewer/chat; the swap is flex `order` via CSS.
  body.append(outputsRail, viewer, chatRail);
  view.append(body);
  return view;
}

function renderPlanHeader(state: PlannerStateDetail): HTMLElement {
  const header = el("header", "pl-header");
  const back = button("← Plans", "ghost small");
  back.addEventListener("click", backToLanding);
  const title = el("span", "pl-title");
  title.textContent = state.plan.title;
  header.append(back, title);

  const aspectMap = new Map(aspects.map((aspect) => [aspect.aspectId, aspect]));
  for (const aspectId of state.plan.aspectIds) {
    const label = aspectMap.get(aspectId)?.label ?? aspectId;
    const node = chip(label, () => {
      aspectFilter = aspectFilter === aspectId ? null : aspectId;
      // Jump the viewer to the filtered aspect's lead artifact.
      if (aspectFilter !== null) {
        const lead = state.artifacts.find((artifact) => artifact.aspectId === aspectFilter);
        if (lead !== undefined) {
          selectedArtifactId = lead.artifactId;
          persist();
        }
      }
      render();
    });
    node.classList.add("pl-aspect-chip", "selected", "small");
    node.classList.toggle("filtering", aspectFilter === aspectId);
    node.title = aspectFilter === aspectId ? "Click to show every aspect" : "Click to filter the outputs to this aspect";
    header.append(node);
  }

  const spacer = el("span", "pl-spacer");
  header.append(spacer);

  header.append(sessionStatus());

  const openCount = state.annotations.filter((annotation) => annotation.status === "open").length;
  const send = button(openCount === 0 ? "No open instructions" : `Send instructions (${String(openCount)})`, "primary small");
  send.disabled = openCount === 0;
  send.addEventListener("click", () => {
    void request({ type: "planner.sendInstructions", planId: state.plan.planId }).then((response) => {
      if (response.ok && response.payload.type === "planner.sendInstructions") {
        notice = { text: `Sent ${String(response.payload.sentCount)} instruction${response.payload.sentCount === 1 ? "" : "s"} to the agent.`, tone: "info" };
      } else if (!response.ok) {
        notice = { text: response.error.message, tone: "error" };
      }
      void refreshState();
    });
  });
  const regenerateTrigger = button("⟳ Regenerate ▾", "ghost small");
  regenerateTrigger.title = "Ask the agent to revisit the whole plan, or one aspect";
  const regenerate = popover(regenerateTrigger, (content, close) => {
    const whole = button("Whole plan", "ghost small pl-regen-item");
    whole.addEventListener("click", () => {
      close();
      void request({ type: "planner.regenerate", planId: state.plan.planId });
      notice = { text: "Regeneration requested for the whole plan.", tone: "info" };
      render();
    });
    content.append(whole);
    for (const aspectId of state.plan.aspectIds) {
      const label = aspectMap.get(aspectId)?.label ?? aspectId;
      const item = button(label, "ghost small pl-regen-item");
      item.addEventListener("click", () => {
        close();
        void request({ type: "planner.regenerate", planId: state.plan.planId, aspectId });
        notice = { text: `Regeneration requested: ${label}.`, tone: "info" };
        render();
      });
      content.append(item);
    }
  });
  const swap = button("⇄", "ghost small");
  swap.title = "Swap the outputs and chat rails";
  swap.addEventListener("click", () => {
    layoutSwapped = !layoutSwapped;
    persist();
    render();
  });
  header.append(send, regenerate, swap);
  return header;
}

function sessionStatus(): HTMLElement {
  const wrap = el("span", "pl-session-status");
  if (booting) {
    wrap.append(statusDot("state-starting", "starting"), textSpan("starting session…"));
    return wrap;
  }
  if (currentSession === null || currentState?.plan.sessionId === null) {
    wrap.append(statusDot("state-none", "no session"), textSpan("no session yet"));
    return wrap;
  }
  if (turnActive) {
    wrap.append(statusDot("state-working", "working"), textSpan("agent working…"));
    return wrap;
  }
  if (currentSession.live === true) {
    wrap.append(statusDot("state-live", "live"), textSpan("session live"));
    return wrap;
  }
  wrap.append(statusDot("state-offline", "offline"), textSpan("offline — send to reconnect"));
  return wrap;
}

function textSpan(text: string): HTMLElement {
  const node = el("span");
  node.textContent = text;
  return node;
}

// ---------------------------------------------------------------------------
// Outputs rail: tree + splitter + outline
// ---------------------------------------------------------------------------

function renderOutputsRail(state: PlannerStateDetail): HTMLElement {
  const collapsed = railCollapsed("outputs");
  const overlay = narrowQuery.matches && narrowOverlay === "outputs";
  const rail = el("aside", `pl-rail pl-rail-outputs${collapsed ? " collapsed" : ""}${overlay ? " rail-overlay" : ""}`);
  if (collapsed) {
    return collapsedStrip(rail, "outputs", state);
  }
  const head = el("div", "pl-rail-head");
  const label = el("span", "pl-kicker");
  label.textContent = "OUTPUTS";
  const collapse = railChevron("Collapse the outputs rail", () => {
    collapseRail("outputs");
  });
  head.append(label, collapse);
  rail.append(head);

  const split = el("div", "pl-split");
  const tree = el("div", "pl-tree");
  tree.style.flexBasis = `${String(Math.round(splitRatio * 100))}%`;
  renderTree(tree, state);
  const divider = el("div", "pl-divider");
  divider.title = "Drag to rebalance";
  wireSplitter(divider, split, tree);
  const outline = el("div", "pl-outline");
  renderOutline(outline, state);
  split.append(tree, divider, outline);
  rail.append(split);

  const footer = el("div", "pl-rail-footer");
  const contextLabel = el("div", "pl-group-label");
  contextLabel.textContent = "CONTEXT";
  const roots = el("div", "pl-footnote");
  roots.textContent = state.plan.contextRoots.length === 0
    ? "no read-only mounts"
    : `${String(state.plan.contextRoots.length)} :ro mount${state.plan.contextRoots.length === 1 ? "" : "s"} · brief ✎`;
  roots.title = state.plan.contextRoots.join("\n");
  footer.append(contextLabel, roots);
  rail.append(footer);
  return rail;
}

function renderTree(host: HTMLElement, state: PlannerStateDetail): void {
  const ordered = [...aspects].sort((a, b) => a.sortOrder - b.sortOrder);
  const groups = new Map<string, PlanArtifactDetail[]>();
  for (const artifact of state.artifacts) {
    const bucket = groups.get(artifact.aspectId) ?? [];
    bucket.push(artifact);
    groups.set(artifact.aspectId, bucket);
  }
  let aspectIds = [
    ...ordered.filter((aspect) => groups.has(aspect.aspectId)).map((aspect) => aspect.aspectId),
    ...(groups.has("general") ? ["general"] : [])
  ];
  if (aspectFilter !== null) {
    aspectIds = aspectIds.filter((aspectId) => aspectId === aspectFilter);
    const clear = button(`filtered: ${aspects.find((aspect) => aspect.aspectId === aspectFilter)?.label ?? aspectFilter} ✕`, "ghost small pl-filter-clear");
    clear.addEventListener("click", () => {
      aspectFilter = null;
      render();
    });
    host.append(clear);
  }
  if (state.artifacts.length === 0) {
    const empty = el("div", "pl-empty");
    empty.textContent = booting || turnActive
      ? "The agent is drafting — artifacts appear here after its first turn."
      : "No artifacts collected yet.";
    host.append(empty);
    return;
  }
  const openByArtifact = new Map<string, number>();
  for (const annotation of state.annotations) {
    if (annotation.status === "open") {
      openByArtifact.set(annotation.artifactId, (openByArtifact.get(annotation.artifactId) ?? 0) + 1);
    }
  }
  for (const aspectId of aspectIds) {
    const label = el("div", "pl-group-label");
    label.textContent = (aspects.find((aspect) => aspect.aspectId === aspectId)?.label ?? aspectId).toUpperCase();
    host.append(label);
    for (const artifact of groups.get(aspectId) ?? []) {
      host.append(treeRow(artifact, openByArtifact.get(artifact.artifactId) ?? 0));
    }
  }
}

function treeRow(artifact: PlanArtifactDetail, openNotes: number): HTMLElement {
  const row = el("div", `pl-tree-row${artifact.artifactId === selectedArtifactId ? " selected" : ""}`);
  const main = el("button", "pl-tree-main");
  const glyph = el("span", "pl-kind-glyph");
  glyph.textContent = KIND_GLYPHS[artifact.kind];
  const title = el("span", "pl-tree-title");
  title.textContent = artifact.title;
  main.append(glyph, title);
  main.addEventListener("click", () => {
    selectedArtifactId = artifact.artifactId;
    persist();
    render();
  });
  row.append(main);
  if (flashArtifacts.has(artifact.artifactId)) {
    row.append(badge("updated", "pl-flash"));
  }
  if (openNotes > 0) {
    row.append(badge(`${String(openNotes)} ✎`, "pl-notes"));
  }
  const rev = el("span", "pl-rev");
  rev.textContent = `rev ${String(artifact.revision)}`;
  row.append(rev);
  const rename = el("button", "pl-row-rename");
  rename.textContent = "✎";
  rename.title = "Rename (empty restores the collected title)";
  rename.addEventListener("click", (event) => {
    event.stopPropagation();
    startRename(row, artifact);
  });
  row.append(rename);
  return row;
}

function startRename(row: HTMLElement, artifact: PlanArtifactDetail): void {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "pl-input pl-rename-input";
  input.value = artifact.title;
  row.replaceChildren(input);
  input.focus();
  input.select();
  const finish = (commit: boolean): void => {
    if (!commit) {
      render();
      return;
    }
    void request({ type: "planner.artifact.rename", artifactId: artifact.artifactId, title: input.value.trim() })
      .then(() => refreshState());
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") finish(true);
    if (event.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(false));
}

function renderOutline(host: HTMLElement, state: PlannerStateDetail): void {
  const label = el("div", "pl-kicker pl-outline-head");
  const artifact = state.artifacts.find((entry) => entry.artifactId === selectedArtifactId);
  label.textContent = artifact === undefined ? "OUTLINE" : `OUTLINE · ${artifact.title.toUpperCase().slice(0, 28)}`;
  host.append(label);
  if (artifact === undefined) {
    return;
  }
  if (artifact.kind === "document") {
    const headings = DocumentProvider.outline(artifact);
    if (headings.length === 0) {
      const empty = el("div", "pl-footnote");
      empty.textContent = "No headings in this document.";
      host.append(empty);
      return;
    }
    for (const heading of headings) {
      const entry = el("button", `pl-outline-item level-${String(Math.min(heading.level, 4))}`);
      entry.textContent = heading.text;
      entry.addEventListener("click", () => activeProvider?.focusAnchor(`block:${String(heading.index)}`));
      host.append(entry);
    }
    return;
  }
  // Non-document artifacts list their annotations here instead.
  const mine = state.annotations.filter((annotation) => annotation.artifactId === artifact.artifactId);
  if (mine.length === 0) {
    const empty = el("div", "pl-footnote");
    empty.textContent = "Annotations on this artifact will list here.";
    host.append(empty);
    return;
  }
  for (const annotation of mine) {
    const entry = el("button", "pl-outline-item level-2");
    entry.textContent = `${annotation.anchor} — ${annotation.body.slice(0, 40)}`;
    entry.addEventListener("click", () => activeProvider?.focusAnchor(annotation.anchor));
    host.append(entry);
  }
}

function wireSplitter(divider: HTMLElement, container: HTMLElement, tree: HTMLElement): void {
  divider.addEventListener("pointerdown", (down) => {
    down.preventDefault();
    divider.setPointerCapture(down.pointerId);
    const onMove = (move: PointerEvent): void => {
      const bounds = container.getBoundingClientRect();
      if (bounds.height <= 0) return;
      splitRatio = clampRatio((move.clientY - bounds.top) / bounds.height);
      tree.style.flexBasis = `${String(Math.round(splitRatio * 100))}%`;
    };
    const onUp = (): void => {
      divider.removeEventListener("pointermove", onMove);
      divider.removeEventListener("pointerup", onUp);
      persist();
    };
    divider.addEventListener("pointermove", onMove);
    divider.addEventListener("pointerup", onUp);
  });
}

// ---------------------------------------------------------------------------
// Chat rail (placeholder until the shared components land in P3)
// ---------------------------------------------------------------------------

function renderChatRail(): HTMLElement {
  const collapsed = railCollapsed("chat");
  const overlay = narrowQuery.matches && narrowOverlay === "chat";
  const rail = el("aside", `pl-rail pl-rail-chat${collapsed ? " collapsed" : ""}${overlay ? " rail-overlay" : ""}`);
  if (collapsed) {
    return collapsedStrip(rail, "chat", currentState);
  }
  const head = el("div", "pl-rail-head");
  const label = el("span", "pl-kicker");
  label.textContent = "PLAN CHAT";
  const collapse = railChevron("Collapse the chat rail", () => {
    collapseRail("chat");
  });
  head.append(label, sessionStatus(), collapse);
  rail.append(head);

  railLogEl = el("div", "pl-chat-log chat-log");
  rail.append(railLogEl);
  renderRailLog();

  const composer = el("div", "pl-composer");
  const promptInput = document.createElement("textarea");
  promptInput.className = "pl-textarea";
  promptInput.rows = 3;
  promptInput.placeholder = "Refine the plan…";
  const actions = el("div", "pl-composer-actions");
  const mounts = el("span", "pl-footnote");
  mounts.textContent = "plan session · project mounts :ro · plan dir :rw";
  const stop = button("Stop", "ghost small");
  stop.disabled = !turnActive;
  stop.addEventListener("click", () => {
    const sessionId = currentState?.plan.sessionId;
    if (!sessionId) return;
    stop.disabled = true;
    void request({ type: "chat.cancelTurn", sessionId });
  });
  const send = button("Send", "primary small");
  const submit = (): void => {
    const prompt = promptInput.value.trim();
    if (prompt.length === 0 || currentPlanId === null) return;
    promptInput.value = "";
    void request({ type: "planner.sendTurn", planId: currentPlanId, prompt }).then((response) => {
      if (!response.ok) {
        notice = { text: response.error.message, tone: "error" };
        render();
      }
    });
  };
  send.addEventListener("click", submit);
  promptInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });
  actions.append(mounts, stop, send);
  composer.append(promptInput, actions);
  rail.append(composer);
  return rail;
}

// ---------------------------------------------------------------------------
// Collapsed rails: icon strips that fly out as overlays
// ---------------------------------------------------------------------------

function collapsedStrip(rail: HTMLElement, side: "outputs" | "chat", state: PlannerStateDetail | null): HTMLElement {
  rail.classList.add("collapsed");
  const expand = railChevron(side === "outputs" ? "Expand the outputs rail" : "Expand the chat rail", () => {
    expandRail(side);
  }, true);
  const strip = el("div", "pl-strip");
  if (side === "outputs" && state !== null) {
    const kinds = new Set(state.artifacts.map((artifact) => artifact.kind));
    for (const kind of ["document", "diagram", "image", "prototype"] as const) {
      if (!kinds.has(kind)) continue;
      const glyph = el("span", "pl-strip-glyph");
      glyph.textContent = KIND_GLYPHS[kind];
      strip.append(glyph);
    }
    const openCount = state.annotations.filter((annotation) => annotation.status === "open").length;
    if (openCount > 0) {
      strip.append(el("span", "pl-strip-dot"));
    }
  }
  if (side === "chat") {
    const glyph = el("span", "pl-strip-glyph");
    glyph.textContent = "💬";
    strip.append(glyph);
    if (turnActive) strip.append(el("span", "pl-strip-dot"));
  }
  strip.addEventListener("click", (event) => {
    event.stopPropagation();
    expandRail(side);
  });
  rail.append(strip, expand);
  return rail;
}

function railChevron(label: string, onClick: () => void, expanded = false): HTMLButtonElement {
  const node = el("button", "pl-chevron") as HTMLButtonElement;
  node.textContent = expanded ? "»" : "«";
  node.title = label;
  node.setAttribute("aria-label", label);
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return node;
}

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

function renderViewer(state: PlannerStateDetail): HTMLElement {
  const viewer = el("section", "pl-viewer");
  const artifact = state.artifacts.find((entry) => entry.artifactId === selectedArtifactId);
  if (artifact === undefined) {
    const empty = el("div", "pl-empty pl-viewer-empty");
    empty.textContent = state.artifacts.length === 0
      ? "Artifacts land here as the agent writes them."
      : "Select an artifact from the outputs rail.";
    viewer.append(empty);
    activeProvider = null;
    return viewer;
  }

  const head = el("div", "pl-viewer-head");
  const aspectLabel = aspects.find((aspect) => aspect.aspectId === artifact.aspectId)?.label ?? artifact.aspectId;
  const kickerRow = el("div", "pl-kicker pl-kicker-accent");
  kickerRow.textContent = `${aspectLabel.toUpperCase()} · REV ${String(artifact.revision)}`;
  const titleRow = el("div", "pl-viewer-title-row");
  const title = el("h2", "pl-viewer-title");
  title.textContent = artifact.title;
  const pathText = el("span", "pl-footnote");
  pathText.textContent = `plan/${artifact.relPath}`;
  const openFile = button("open file ↗", "ghost small");
  openFile.addEventListener("click", () => {
    void request({ type: "planner.openArtifact", artifactId: artifact.artifactId }).then((response) => {
      if (!response.ok) {
        notice = { text: response.error.message, tone: "error" };
        render();
      }
    });
  });
  titleRow.append(title, badge(artifact.kind, "pl-kind"), pathText, openFile);
  head.append(kickerRow, titleRow);
  viewer.append(head);

  const instructionHost = el("div", "pl-instruction-host");
  viewer.append(instructionHost);

  const content = el("div", "pl-viewer-content");
  viewer.append(content);

  const provider = providers.find((candidate) => candidate.kind === artifact.kind) ?? null;
  activeProvider = provider;
  let dockNodes = new Map<string, HTMLElement>();
  const events = {
    onAnnotate: (anchor: string, prefill?: string) => {
      openInstructionBox(instructionHost, state.plan.planId, artifact, anchor, prefill);
    },
    onFocusDock: (annotationId: string) => {
      const node = dockNodes.get(annotationId);
      if (node !== undefined) {
        node.scrollIntoView({ block: "center", behavior: "smooth" });
        node.classList.add("pl-block-flash");
        window.setTimeout(() => node.classList.remove("pl-block-flash"), 1600);
      }
    },
    onSetPrototypeScripts: (artifactId: string, enabled: boolean) => {
      void request({ type: "planner.setPrototypeScripts", artifactId, enabled }).then((response) => {
        if (!response.ok) {
          notice = { text: response.error.message, tone: "error" };
        }
        return refreshState();
      });
    }
  };
  provider?.render(content, artifact, state.annotations, events);

  const dock = el("div", "pl-dock");
  const dockHead = el("div", "pl-kicker");
  const mineCount = state.annotations.filter((annotation) => annotation.artifactId === artifact.artifactId).length;
  dockHead.textContent = `INSTRUCTIONS · ${String(mineCount)}`;
  const dockBody = el("div", "pl-dock-body-host");
  dockNodes = renderAnnotationDock(dockBody, artifact, state.annotations, {
    onSetStatus: (annotationId, status) => {
      void request({ type: "planner.annotation.setStatus", annotationId, status }).then(() => refreshState());
    },
    onRemove: (annotationId) => {
      void request({ type: "planner.annotation.remove", annotationId }).then(() => refreshState());
    },
    onFocusAnchor: (anchor) => activeProvider?.focusAnchor(anchor)
  });
  dock.append(dockHead, dockBody);
  viewer.append(dock);
  return viewer;
}

function openInstructionBox(
  host: HTMLElement,
  planId: string,
  artifact: PlanArtifactDetail,
  anchor: string,
  prefill?: string
): void {
  host.replaceChildren();
  const box = el("div", "pl-instruction-box");
  const label = el("div", "pl-kicker pl-kicker-accent");
  label.textContent = `INSTRUCTION · ${anchor.toUpperCase()}`;
  const textarea = document.createElement("textarea");
  textarea.className = "pl-textarea";
  textarea.rows = 2;
  textarea.placeholder = "What should change here…";
  if (prefill !== undefined && prefill.length > 0) textarea.value = prefill;
  const actions = el("div", "pl-instruction-actions");
  const add = button("Add instruction", "primary small");
  const cancel = button("Cancel", "ghost small");
  cancel.addEventListener("click", () => host.replaceChildren());
  add.addEventListener("click", () => {
    const body = textarea.value.trim();
    if (body.length === 0) return;
    add.disabled = true;
    void request({ type: "planner.annotation.add", planId, artifactId: artifact.artifactId, anchor, body })
      .then((response) => {
        if (!response.ok) {
          notice = { text: response.error.message, tone: "error" };
        }
        host.replaceChildren();
        return refreshState();
      });
  });
  actions.append(add, cancel);
  box.append(label, textarea, actions);
  host.append(box);
  textarea.focus();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

void (async () => {
  await refreshAspects();
  await refreshPlans();
  if (currentPlanId !== null && plans.some((plan) => plan.planId === currentPlanId)) {
    await openPlan(currentPlanId);
  } else {
    currentPlanId = null;
    render();
  }
})();
