/**
 * Planner editor panel webview (ADR 0012).
 *
 * A plan-document review workspace: plan files and heading outline on the
 * left, the selected artifact viewer in the centre, and a plan-wide notes
 * queue on the right. Plan creation, selection, aspect management, and the
 * planning conversation stay in the Drydock sidebar.
 * Both rails collapse at narrower editor widths; layout preferences persist
 * via webview state (UI-local only - domain data is always refetched).
 *
 * SECURITY: every dynamic string renders via textContent - NEVER innerHTML.
 * This entry is self-contained (it does not import the control-panel bundle).
 */

import {
  WEBVIEW_PROTOCOL_VERSION,
  type ChatSessionSummary,
  type HostToWebviewMessage,
  type PanelPushPayload,
  type PanelRequestPayload,
  type PanelResponse,
  type PlanArtifactDetail,
  type PlanAspectSummary,
  type PlannerStateDetail,
  type PlanSummary
} from "@drydock/contracts";
import { badge, button, chip, el, popover, statusDot } from "./components.js";
import {
  captureModalFocus,
  prepareModalFocus,
  queueModalFocus,
  type ModalFocusSnapshot
} from "./modalFocus.js";
import {
  DiagramProvider,
  DocumentProvider,
  ImageProvider,
  PrototypeProvider,
  renderAnnotationDock,
  type ArtifactProvider
} from "./plannerViewer.js";
import { createHelpExperience, setHelpTooltip } from "./help.js";
import { createDemoModeController, demoResponse, isDemoMode } from "./demoMode.js";
import { nextWorkflowStep } from "./guideHandoffs.js";

interface PersistedState {
  readonly selectedPlanId: string | null;
  readonly selectedArtifactId: string | null;
  readonly leftCollapsed: boolean;
  readonly rightCollapsed?: boolean;
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
const NARROW_QUERY = "(max-width: 1080px)";
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
/** A guide handoff that arrived while planner.showPlan was still loading its selected plan. */
let pendingGuideStart = document.body.dataset["startGuide"] === "true";
/** Revision seen per artifact, for the "updated" flash on refetch. */
const seenRevisions = new Map<string, number>();
const flashArtifacts = new Set<string>();

let leftCollapsed = false;
let rightCollapsed = false;
let splitRatio = 0.55;
/**
 * Narrow windows auto-collapse both rails to strips; tapping a strip flies the
 * rail out as an overlay. This is transient presentation state - it never
 * touches the persisted collapse preferences.
 */
let narrowOverlay: "outputs" | "notes" | null = null;

const saved = vscodeApi.getState();
if (saved) {
  currentPlanId = saved.selectedPlanId;
  selectedArtifactId = saved.selectedArtifactId;
  leftCollapsed = saved.leftCollapsed;
  rightCollapsed = saved.rightCollapsed ?? false;
  splitRatio = clampRatio(saved.splitRatio);
}

function persist(): void {
  vscodeApi.setState({
    selectedPlanId: currentPlanId,
    selectedArtifactId,
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
    case "planner.showPlan":
      // Another surface (an auto-open on session start)
      // asked this panel to land on a specific plan.
      if (payload.planId !== currentPlanId) {
        void openPlan(payload.planId);
      }
      return;
    case "help.startTour":
      if (currentPlanId !== null && currentState === null) {
        pendingGuideStart = true;
      } else {
        window.setTimeout(() => help.startTour(), 0);
      }
      return;
    case "chat.turnStarted":
      if (currentState?.plan.sessionId === payload.sessionId) {
        turnActive = true;
        render();
      }
      return;
    case "chat.turnCompleted":
      if (currentState?.plan.sessionId === payload.sessionId) {
        turnActive = false;
        void refreshState();
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
  if (pendingGuideStart) {
    pendingGuideStart = false;
    window.setTimeout(() => help.startTour(), 0);
  }
}

async function openPlan(planId: string): Promise<void> {
  currentPlanId = planId;
  currentState = null;
  currentSession = null;
  selectedArtifactId = null;
  seenRevisions.clear();
  persist();
  render();
  await refreshState();
}

async function showTourPlan(): Promise<void> {
  if (currentPlanId !== null && currentState !== null) {
    narrowOverlay = null;
    render();
    return;
  }
  if (plans.length === 0) await refreshPlans();
  const planId = currentPlanId ?? plans.find((plan) => plan.status !== "archived")?.planId ?? plans[0]?.planId;
  if (planId === undefined) {
    render();
    return;
  }
  await openPlan(planId);
}

async function showTourFiles(): Promise<void> {
  await showTourPlan();
  if (narrowQuery.matches) narrowOverlay = "outputs";
  else leftCollapsed = false;
  render();
}

async function showTourViewer(): Promise<void> {
  await showTourPlan();
  narrowOverlay = null;
  render();
}

async function showTourNotes(): Promise<void> {
  await showTourPlan();
  if (narrowQuery.matches) narrowOverlay = "notes";
  else rightCollapsed = false;
  render();
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

const root = el("div", "pl-root");
app.append(root);

const demoMode = createDemoModeController(reloadPlannerData);

const help = createHelpExperience({
  id: "planner",
  title: "Planner guide",
  intro: "Review a plan's files, move through its outline, and queue notes for the next revision.",
  showWelcome: true,
  dataMode: demoMode.helpMode,
  pages: [
    {
      id: "workspace",
      label: "Review files",
      title: "Navigate plan files",
      intro: "Planner is the document workspace. Create and select plans in the Drydock Plan tab, then use this panel to review the generated files.",
      sections: [
        { title: "Choose a file", body: "Plan files are grouped by aspect. Select a file to open it in the viewer; the revision and queued-note count stay visible in the file list." },
        { title: "Use the outline", body: "For documents, select a heading to move to that section. Diagrams, images, and prototypes list their anchored notes instead." },
        { title: "Open the collected file", body: "Use Open file when you need the artifact in a normal editor tab. Demo files stay in memory and cannot be opened on disk." },
        { title: "Use the responsive rails", body: "At narrower editor widths, Plan files and Notes queue collapse to edge strips. Select a strip to open that rail over the viewer." }
      ]
    },
    {
      id: "notes",
      label: "Queue notes",
      title: "Record and send revision notes",
      intro: "Notes remain attached to a plan file until you send or resolve them.",
      sections: [
        { title: "Add a file note", body: "Use Add note for a file-level request, or use the note action on a document block, diagram node, image region, or prototype region for a specific anchor." },
        { title: "Review the queue", body: "The Notes queue groups every note by file and keeps its state visible: open, delegated, resolved, or parked." },
        { title: "Send the open notes", body: "Send notes submits every open item as one revision request. The planning agent can then update the affected artifacts together." },
        { title: "Follow up in Plan", body: "Use the Drydock Plan tab for planning questions and broader changes that are not tied to a specific file or section." }
      ]
    },
    {
      id: "handoff",
      label: "Revise & hand off",
      title: "Request broader revisions or create board work",
      intro: "Use the header actions for changes that apply beyond one queued note.",
      sections: [
        { title: "Regenerate content", body: "Regenerate one aspect for a targeted rewrite, or the whole plan when the brief or direction has changed." },
        { title: "Create subtasks", body: "Preview checklist-derived candidates before adding them to the Task Board. Creating subtasks does not start an agent." }
      ]
    }
  ],
  tour: [
    { title: "Review the selected plan", body: "Planner is where you review the selected plan's files. Create plans, choose plans, and continue the planning conversation in the Drydock Plan tab.", target: () => root.querySelector<HTMLElement>(".pl-header-main") ?? root, prepare: showTourPlan },
    { title: "Choose a plan file", body: "Plan files are grouped by aspect. Select a file to open it; each row also shows its revision and any open notes.", target: () => root.querySelector<HTMLElement>(".pl-tree") ?? root, prepare: showTourFiles },
    { title: "Use the file outline", body: "The outline follows the selected file. Select a document heading to move to that section, or an anchored note to locate it in a visual artifact.", target: () => root.querySelector<HTMLElement>(".pl-outline") ?? root, prepare: showTourFiles },
    { title: "Read the selected file", body: "The viewer renders documents, diagrams, images, and prototypes. Open file moves a collected artifact into a normal editor tab when it exists on disk.", target: () => root.querySelector<HTMLElement>(".pl-viewer-head") ?? root, prepare: showTourViewer },
    { title: "Add a revision note", body: "Add a file-level note here, or attach a note to a specific block, node, or region inside the artifact.", target: () => root.querySelector<HTMLElement>(".pl-add-note") ?? root.querySelector<HTMLElement>(".pl-viewer-head") ?? root, prepare: showTourViewer },
    { title: "Work through the notes queue", body: "The queue groups notes by plan file and keeps open, delegated, resolved, and parked states visible while you review.", target: () => root.querySelector<HTMLElement>(".pl-notes-body") ?? root, prepare: showTourNotes },
    { title: "Send the open notes", body: "Send notes submits all open items together for the next revision. Broader rewrites use Regenerate; checklist items can be created as board subtasks.", target: () => root.querySelector<HTMLElement>(".pl-notes-send") ?? root.querySelector<HTMLElement>(".pl-plan-actions") ?? root, prepare: showTourNotes },
    nextWorkflowStep({
      current: "planner",
      request,
      taskId: () => currentState?.plan.taskId ?? "demo-task-onboarding",
      planId: () => currentState?.plan.planId ?? plans[0]?.planId
    })
  ]
});

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
function outputsRailCollapsed(): boolean {
  if (narrowQuery.matches) {
    return narrowOverlay !== "outputs";
  }
  return leftCollapsed;
}

function notesRailCollapsed(): boolean {
  if (narrowQuery.matches) {
    return narrowOverlay !== "notes";
  }
  return rightCollapsed;
}

function expandOutputsRail(): void {
  if (narrowQuery.matches) {
    narrowOverlay = "outputs";
  } else {
    leftCollapsed = false;
    persist();
  }
  render();
}

function collapseOutputsRail(): void {
  if (narrowQuery.matches) {
    narrowOverlay = null;
  } else {
    leftCollapsed = true;
    persist();
  }
  render();
}

function expandNotesRail(): void {
  if (narrowQuery.matches) {
    narrowOverlay = "notes";
  } else {
    rightCollapsed = false;
    persist();
  }
  render();
}

function collapseNotesRail(): void {
  if (narrowQuery.matches) {
    narrowOverlay = null;
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
let noteNodes = new Map<string, HTMLElement>();

// ---------------------------------------------------------------------------
// Rendering - top level
// ---------------------------------------------------------------------------

function render(): void {
  const focusSnapshot = captureMaterializeFocus();
  root.replaceChildren();
  root.append(renderNotice());
  if (currentPlanId === null || currentState === null) {
    root.append(renderEmptyPlanner());
  } else {
    root.append(renderPlanView(currentState));
    if (materializeDraft !== null) {
      root.append(renderMaterializeOverlay(materializeDraft));
    }
  }
  finishMaterializeRender(materializeDraft !== null && currentPlanId !== null && currentState !== null, focusSnapshot);
}

function renderEmptyPlanner(): HTMLElement {
  const empty = el("section", "pl-empty-workspace");
  const head = el("header", "pl-header pl-empty-header");
  const title = el("span", "pl-title");
  title.textContent = "Plan workspace";
  head.append(title, el("span", "pl-spacer"), help.launcher("pl-help-launcher"));

  const body = el("div", "pl-empty-workspace-body");
  const kicker = el("div", "pl-kicker pl-kicker-accent");
  kicker.textContent = "NO PLAN SELECTED";
  const heading = el("h2", "pl-empty-workspace-title");
  heading.textContent = "Choose a plan in the Drydock Plan tab";
  const copy = el("p", "pl-empty-workspace-copy");
  copy.textContent = "Plan creation and selection stay in the sidebar. Planner opens the selected plan's files, outline, viewer, and notes queue.";
  body.append(kicker, heading, copy);
  empty.append(head, body);
  return empty;
}

// --- Plan → board (ADR 0012) -------------------------------------------------

interface MaterializeDraft {
  readonly planId: string;
  /** null while planner.subtaskCandidates is in flight. */
  candidates: string[] | null;
  selected: Set<number>;
  taskId?: string;
  taskTitle?: string;
  submitting: boolean;
  error: string | null;
}

let materializeDraft: MaterializeDraft | null = null;

let materializeRenderedOpen = false;
let materializeReturnFocus: (() => HTMLElement | null) | null = null;

function captureMaterializeFocus(): ModalFocusSnapshot | null {
  return captureModalFocus(root.querySelector<HTMLElement>(".pl-mat-modal"));
}

function finishMaterializeRender(open: boolean, snapshot: ModalFocusSnapshot | null): void {
  const overlay = root.querySelector<HTMLElement>(".pl-mat-overlay");
  for (const child of [...root.children]) {
    if (child !== overlay) child.toggleAttribute("inert", open);
  }

  if (!open) {
    const shouldRestore = materializeRenderedOpen;
    const returnFocus = materializeReturnFocus;
    materializeRenderedOpen = false;
    materializeReturnFocus = null;
    if (shouldRestore && returnFocus !== null) {
      queueMicrotask(() => returnFocus()?.focus());
    }
    return;
  }

  materializeRenderedOpen = true;
  const modal = overlay?.querySelector<HTMLElement>(".pl-mat-modal") ?? null;
  if (modal === null) return;
  queueModalFocus(modal, snapshot);
}

function closeMaterialize(): void {
  if (materializeDraft?.submitting === true) return;
  materializeDraft = null;
  render();
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || materializeDraft === null) return;
  event.preventDefault();
  event.stopPropagation();
  closeMaterialize();
});

/**
 * The materialization dialog: the plan's checkbox items, each toggleable,
 * created as subtasks on the owning task. Creates, NEVER starts - starting
 * stays a board/human act (0007 discipline).
 */
function renderMaterializeOverlay(draft: MaterializeDraft): HTMLElement {
  const overlay = el("div", "pl-mat-overlay");
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay && !draft.submitting) {
      closeMaterialize();
    }
  });
  const modal = el("div", "pl-mat-modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-labelledby", "pl-mat-title");
  modal.setAttribute("aria-describedby", "pl-mat-hint");
  prepareModalFocus(modal);

  const title = el("h2", "pl-mat-title");
  title.id = "pl-mat-title";
  title.textContent = "Materialize subtasks";
  modal.append(title);
  const hint = el("div", "pl-mat-hint");
  hint.id = "pl-mat-hint";
  hint.textContent = draft.taskTitle !== undefined
    ? `Creates the selected items as subtasks on "${draft.taskTitle}". This action does not start an agent.`
    : "This plan has no owning task - assign one from the Drydock Plan tab first.";
  modal.append(hint);

  if (draft.candidates === null) {
    const scanning = el("div", "pl-mat-empty");
    scanning.textContent = "Scanning the plan's documents…";
    modal.append(scanning);
  } else if (draft.candidates.length === 0) {
    const none = el("div", "pl-mat-empty");
    none.textContent = "No checkbox items ( - [ ] … ) found in the plan's documents.";
    modal.append(none);
  } else {
    const list = el("div", "pl-mat-list");
    draft.candidates.forEach((candidate, index) => {
      const row = el("label", "pl-mat-row");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.dataset["modalFocus"] = `candidate:${String(index)}`;
      box.checked = draft.selected.has(index);
      box.addEventListener("change", () => {
        if (box.checked) draft.selected.add(index);
        else draft.selected.delete(index);
        const create = modal.querySelector<HTMLButtonElement>(".pl-mat-create");
        if (create) create.disabled = draft.submitting || draft.selected.size === 0 || draft.taskId === undefined;
      });
      const text = el("span", "pl-mat-row-title");
      text.textContent = candidate;
      row.append(box, text);
      list.append(row);
    });
    modal.append(list);
  }

  const foot = el("div", "pl-mat-foot");
  const error = el("span", "pl-mat-error");
  if (draft.error !== null) error.textContent = draft.error;
  const cancel = button("Cancel", "ghost small");
  cancel.dataset["modalFocus"] = "cancel";
  cancel.disabled = draft.submitting;
  cancel.addEventListener("click", closeMaterialize);
  const create = button(draft.submitting ? "Creating…" : `Create ${String(draft.selected.size)} subtask${draft.selected.size === 1 ? "" : "s"}`, "primary small pl-mat-create");
  create.dataset["modalFocus"] = "create";
  create.disabled = draft.submitting || draft.selected.size === 0 || draft.taskId === undefined;
  create.addEventListener("click", () => {
    const titles = (draft.candidates ?? []).filter((_, index) => draft.selected.has(index));
    if (titles.length === 0) return;
    draft.submitting = true;
    draft.error = null;
    render();
    void request({ type: "planner.materializeSubtasks", planId: draft.planId, titles }).then((response) => {
      if (response.ok && response.payload.type === "planner.materializeSubtasks") {
        const count = response.payload.createdCount;
        materializeDraft = null;
        notice = { text: `Created ${String(count)} subtask${count === 1 ? "" : "s"} on the board (nothing started).`, tone: "info" };
        render();
        return;
      }
      draft.submitting = false;
      draft.error = response.ok ? "Unexpected response." : response.error.message;
      render();
    });
  });
  foot.append(error, cancel, create);
  modal.append(foot);

  overlay.append(modal);
  return overlay;
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
// Plan view
// ---------------------------------------------------------------------------

function renderPlanView(state: PlannerStateDetail): HTMLElement {
  const view = el("div", "pl-plan-view");
  view.append(renderPlanHeader(state));

  const body = el("div", "pl-body");
  const outputsRail = renderOutputsRail(state);
  const viewer = renderViewer(state);
  const notesRail = renderNotesRail(state);
  body.append(outputsRail, viewer, notesRail);
  view.append(body);
  return view;
}

function renderPlanHeader(state: PlannerStateDetail): HTMLElement {
  const header = el("header", "pl-header");
  const main = el("div", "pl-header-main");
  const title = el("span", "pl-title");
  title.textContent = state.plan.title;
  main.append(title);

  if (state.plan.taskId !== null) {
    const taskChip = el("span", "pl-task-chip");
    taskChip.textContent = state.plan.taskTitle ?? "task";
    taskChip.title = `Belongs to task: ${state.plan.taskTitle ?? state.plan.taskId}`;
    main.append(taskChip);
  }

  const aspectMap = new Map(aspects.map((aspect) => [aspect.aspectId, aspect]));
  const aspectBar = el("nav", "pl-aspect-filter");
  aspectBar.setAttribute("aria-label", "Plan aspects");
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
    aspectBar.append(node);
  }

  const spacer = el("span", "pl-spacer");
  main.append(spacer);

  main.append(help.launcher("pl-help-launcher"));

  main.append(sessionStatus());

  const actions = el("div", "pl-plan-actions");
  const regenerateTrigger = button("⟳ Regenerate ▾", "ghost small");
  regenerateTrigger.disabled = isDemoMode();
  regenerateTrigger.title = isDemoMode()
    ? "Demo data does not contact the planning agent. Switch to Live data to regenerate artifacts."
    : "Ask the agent to revisit the whole plan, or one aspect";
  setHelpTooltip(regenerateTrigger, "Regenerate the entire plan or select one aspect for a targeted revision.");
  const regenerate = popover(regenerateTrigger, (content, close) => {
    const whole = button("Whole plan", "ghost small pl-regen-item");
    whole.addEventListener("click", () => {
      close();
      void request({ type: "planner.regenerate", planId: state.plan.planId }).then((response) => {
        notice = response.ok && response.payload.type === "planner.regenerate"
          ? { text: "Regeneration requested for the whole plan.", tone: "info" }
          : { text: response.ok ? "Unexpected regeneration response." : response.error.message, tone: "error" };
        render();
      });
    });
    content.append(whole);
    for (const aspectId of state.plan.aspectIds) {
      const label = aspectMap.get(aspectId)?.label ?? aspectId;
      const item = button(label, "ghost small pl-regen-item");
      item.addEventListener("click", () => {
        close();
        void request({ type: "planner.regenerate", planId: state.plan.planId, aspectId }).then((response) => {
          notice = response.ok && response.payload.type === "planner.regenerate"
            ? { text: `Regeneration requested: ${label}.`, tone: "info" }
            : { text: response.ok ? "Unexpected regeneration response." : response.error.message, tone: "error" };
          render();
        });
      });
      content.append(item);
    }
  });
  // Plan → board (ADR 0012): propose the plan's checkbox items as subtasks.
  const toBoard = button("⇪ To board…", "ghost small pl-to-board");
  toBoard.title = "Create selected checklist items as subtasks on this plan's task; does not start an agent";
  setHelpTooltip(toBoard, "Preview checklist items and create selected items as subtasks. This action does not start an agent.");
  toBoard.addEventListener("click", () => {
    materializeReturnFocus = () => root.querySelector<HTMLElement>(".pl-to-board");
    materializeDraft = { planId: state.plan.planId, candidates: null, selected: new Set(), submitting: false, error: null };
    render();
    void request({ type: "planner.subtaskCandidates", planId: state.plan.planId }).then((response) => {
      const draft = materializeDraft;
      if (draft === null || draft.planId !== state.plan.planId) return; // closed meanwhile
      if (response.ok && response.payload.type === "planner.subtaskCandidates") {
        draft.candidates = [...response.payload.candidates];
        draft.selected = new Set(draft.candidates.map((_, index) => index));
        if (response.payload.taskId !== undefined) draft.taskId = response.payload.taskId;
        if (response.payload.taskTitle !== undefined) draft.taskTitle = response.payload.taskTitle;
      } else {
        draft.candidates = [];
        draft.error = response.ok ? "Unexpected response." : response.error.message;
      }
      render();
    });
  });
  actions.append(regenerate, toBoard);
  main.append(actions);
  header.append(main);
  if (aspectBar.childElementCount > 0) header.append(aspectBar);
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
  wrap.append(statusDot("state-offline", "offline"), textSpan("offline - send to reconnect"));
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
  const collapsed = outputsRailCollapsed();
  const overlay = narrowQuery.matches && narrowOverlay === "outputs";
  const rail = el("aside", `pl-rail pl-rail-outputs${collapsed ? " collapsed" : ""}${overlay ? " rail-overlay" : ""}`);
  if (collapsed) {
    return collapsedOutputsStrip(rail, state);
  }
  const head = el("div", "pl-rail-head");
  const label = el("span", "pl-kicker");
  label.textContent = "PLAN FILES";
  const collapse = railChevron("Collapse the outputs rail", () => {
    collapseOutputsRail();
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
      ? "The agent is drafting - artifacts appear here after its first turn."
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
    entry.textContent = `${annotation.anchor} - ${annotation.body.slice(0, 40)}`;
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
// Collapsed outputs rail: icon strip that flies out as an overlay
// ---------------------------------------------------------------------------

function collapsedOutputsStrip(rail: HTMLElement, state: PlannerStateDetail): HTMLElement {
  rail.classList.add("collapsed");
  const expand = railChevron("Expand the outputs rail", () => {
    expandOutputsRail();
  }, true);
  const strip = el("div", "pl-strip");
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
  strip.addEventListener("click", (event) => {
    event.stopPropagation();
    expandOutputsRail();
  });
  rail.append(strip, expand);
  return rail;
}

function renderNotesRail(state: PlannerStateDetail): HTMLElement {
  noteNodes = new Map<string, HTMLElement>();
  const collapsed = notesRailCollapsed();
  const overlay = narrowQuery.matches && narrowOverlay === "notes";
  const rail = el("aside", `pl-rail pl-rail-notes${collapsed ? " collapsed" : ""}${overlay ? " rail-overlay" : ""}`);
  if (collapsed) return collapsedNotesStrip(rail, state);

  const openCount = state.annotations.filter((annotation) => annotation.status === "open").length;
  const head = el("div", "pl-rail-head");
  const label = el("span", "pl-kicker");
  label.textContent = "NOTES QUEUE";
  const count = badge(String(openCount), openCount > 0 ? "pl-notes" : "");
  const collapse = railChevron("Collapse the notes queue", collapseNotesRail, true);
  head.append(collapse, label, count);
  rail.append(head);

  const body = el("div", "pl-notes-body");
  const artifactsWithNotes = state.artifacts.filter((artifact) => state.annotations.some((annotation) => annotation.artifactId === artifact.artifactId));
  if (artifactsWithNotes.length === 0) {
    const empty = el("div", "pl-dock-empty");
    empty.textContent = "No notes yet. Add a file note or attach one to a block, node, or region in the viewer.";
    body.append(empty);
  }
  for (const artifact of artifactsWithNotes) {
    const section = el("section", `pl-note-group${artifact.artifactId === selectedArtifactId ? " selected" : ""}`);
    const groupHead = el("button", "pl-note-group-head");
    const title = el("span", "pl-note-group-title");
    title.textContent = artifact.title;
    const groupOpen = state.annotations.filter((annotation) => annotation.artifactId === artifact.artifactId && annotation.status === "open").length;
    groupHead.append(title, badge(`${String(groupOpen)} open`, groupOpen > 0 ? "pl-notes" : ""));
    groupHead.addEventListener("click", () => {
      selectedArtifactId = artifact.artifactId;
      narrowOverlay = null;
      persist();
      render();
    });
    const entries = el("div", "pl-dock-body-host");
    const nodes = renderAnnotationDock(entries, artifact, state.annotations, {
      onSetStatus: (annotationId, status) => {
        void request({ type: "planner.annotation.setStatus", annotationId, status }).then(() => refreshState());
      },
      onRemove: (annotationId) => {
        void request({ type: "planner.annotation.remove", annotationId }).then(() => refreshState());
      },
      onFocusAnchor: (anchor) => {
        selectedArtifactId = artifact.artifactId;
        narrowOverlay = null;
        persist();
        render();
        queueMicrotask(() => activeProvider?.focusAnchor(anchor));
      }
    });
    for (const [annotationId, node] of nodes) noteNodes.set(annotationId, node);
    section.append(groupHead, entries);
    body.append(section);
  }
  rail.append(body);

  const footer = el("div", "pl-notes-footer");
  const send = button(openCount === 0 ? "No open notes" : `Send notes (${String(openCount)})`, "primary small pl-notes-send");
  send.disabled = isDemoMode() || openCount === 0;
  send.title = isDemoMode()
    ? "Demo data does not contact the planning agent. Switch to Live data to send notes."
    : "Send every open note as one revision request";
  send.addEventListener("click", () => {
    void request({ type: "planner.sendInstructions", planId: state.plan.planId }).then((response) => {
      if (response.ok && response.payload.type === "planner.sendInstructions") {
        notice = { text: `Sent ${String(response.payload.sentCount)} note${response.payload.sentCount === 1 ? "" : "s"} for revision.`, tone: "info" };
      } else if (!response.ok) {
        notice = { text: response.error.message, tone: "error" };
      }
      void refreshState();
    });
  });
  const hintText = el("span", "pl-footnote");
  hintText.textContent = "open notes are sent together";
  footer.append(hintText, send);
  rail.append(footer);
  return rail;
}

function collapsedNotesStrip(rail: HTMLElement, state: PlannerStateDetail): HTMLElement {
  rail.classList.add("collapsed");
  const expand = railChevron("Expand the notes queue", expandNotesRail);
  const strip = el("div", "pl-strip pl-notes-strip");
  const glyph = el("span", "pl-strip-glyph");
  glyph.textContent = "✎";
  const openCount = state.annotations.filter((annotation) => annotation.status === "open").length;
  const count = el("span", "pl-strip-count");
  count.textContent = String(openCount);
  strip.append(glyph, count);
  strip.addEventListener("click", (event) => {
    event.stopPropagation();
    expandNotesRail();
  });
  rail.append(expand, strip);
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
  openFile.disabled = isDemoMode();
  if (isDemoMode()) openFile.title = "Demo artifacts are stored in memory and do not have a local file.";
  openFile.addEventListener("click", () => {
    void request({ type: "planner.openArtifact", artifactId: artifact.artifactId }).then((response) => {
      if (!response.ok) {
        notice = { text: response.error.message, tone: "error" };
        render();
      }
    });
  });
  const addNote = button("Add note", "ghost small pl-add-note");
  addNote.title = "Add a file-level revision note";
  setHelpTooltip(addNote, "Add a note for this whole plan file. Use the note action inside the content when the request belongs to a specific section or region.");
  addNote.addEventListener("click", () => {
    openInstructionBox(instructionHost, state.plan.planId, artifact, "whole file");
  });
  titleRow.append(title, badge(artifact.kind, "pl-kind"), pathText, openFile, addNote);
  head.append(kickerRow, titleRow);
  viewer.append(head);

  const instructionHost = el("div", "pl-instruction-host");
  viewer.append(instructionHost);

  const content = el("div", "pl-viewer-content");
  viewer.append(content);

  const provider = providers.find((candidate) => candidate.kind === artifact.kind) ?? null;
  activeProvider = provider;
  const events = {
    onAnnotate: (anchor: string, prefill?: string) => {
      openInstructionBox(instructionHost, state.plan.planId, artifact, anchor, prefill);
    },
    onFocusDock: (annotationId: string) => {
      const focusNote = (): void => {
        const node = noteNodes.get(annotationId);
        if (node === undefined) return;
        node.scrollIntoView({ block: "center", behavior: "smooth" });
        node.classList.add("pl-block-flash");
        window.setTimeout(() => node.classList.remove("pl-block-flash"), 1600);
      };
      if (notesRailCollapsed()) {
        if (narrowQuery.matches) narrowOverlay = "notes";
        else rightCollapsed = false;
        render();
        queueMicrotask(focusNote);
      } else {
        focusNote();
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
  label.textContent = `NOTE · ${anchor.toUpperCase()}`;
  const textarea = document.createElement("textarea");
  textarea.className = "pl-textarea";
  textarea.rows = 2;
  textarea.placeholder = "What should change here…";
  if (prefill !== undefined && prefill.length > 0) textarea.value = prefill;
  const actions = el("div", "pl-instruction-actions");
  const add = button("Add note", "primary small");
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

async function reloadPlannerData(): Promise<void> {
  await refreshAspects();
  await refreshPlans();
  const nextPlanId = currentPlanId !== null && plans.some((plan) => plan.planId === currentPlanId)
    ? currentPlanId
    : plans.find((plan) => plan.status !== "archived")?.planId ?? plans[0]?.planId;
  if (nextPlanId === undefined) {
    currentPlanId = null;
    currentState = null;
    render();
  } else {
    await openPlan(nextPlanId);
  }
  if (pendingGuideStart) {
    pendingGuideStart = false;
    window.setTimeout(() => help.startTour(), 0);
  }
}

void reloadPlannerData();
