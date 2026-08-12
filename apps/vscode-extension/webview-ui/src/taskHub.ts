/**
 * Task Hub webview (UX overhaul, P3).
 *
 * The centre pane of the calm workbench: ONE overview of the task the
 * active-task spine points at - attention rail, stat tiles, Chats, Subtasks,
 * Plans, and a collapsed System card. Every card is a summary plus one link out
 * to the surface that owns the depth (Board / Agents / Planner / Review); the
 * hub never duplicates their detail and never becomes the only way to do
 * anything (the solo-mode guarantee).
 *
 * Data is the single composite `hub.state` read, healed off pushes: the spine
 * moving refetches for the new task, and session/turn/question/access/board/
 * planner events refetch the current one (debounced - a cascade fires many bus
 * events back to back). Nothing polls.
 *
 * SECURITY: every dynamic string (task/chat/plan titles, questions, mount
 * paths, launch command) is written with textContent - NEVER innerHTML, no
 * DOM-from-string. The strict CSP has no 'unsafe-inline' for styles, so every
 * state cue is a CLASS; there is not one style attribute in this file.
 */

import {
  rollupTaskStatus,
  sessionRollupStatus,
  subtaskRollupStatus,
  type HubAttentionItem,
  type HubChatSummary,
  type HubState,
  type PanelSurface,
  type PlanSummary,
  type RuntimeSummary,
  type SubtaskSummary,
  type TaskRollupStatus
} from "@drydock/contracts";
import { composerContextFor, createComposer } from "./hubComposer.js";
import { icon } from "./hubIcons.js";
import { onPush, request, startMessaging, vscode } from "./hubMessaging.js";

/** How long the transient back-chip stays up after a retarget (design: ~6s). */
const BACK_CHIP_MS = 6_000;
/** Bus cascades fire many events per action; one refetch covers them all. */
const REFRESH_DEBOUNCE_MS = 200;
const TITLE_MAX = 200;

// ---------------------------------------------------------------------------
// Tiny DOM helpers (self-contained: the hub bundle imports no panel modules)
// ---------------------------------------------------------------------------

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, label: string, title: string, run: () => void): HTMLButtonElement {
  const node = document.createElement("button");
  node.className = className;
  node.textContent = label;
  node.title = title;
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    run();
  });
  return node;
}

/** Rows are buttons in spirit: click, Enter and Space all activate. */
function activatable(node: HTMLElement, run: () => void): void {
  node.tabIndex = 0;
  node.setAttribute("role", "button");
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    run();
  });
  node.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.target !== node) return;
    event.preventDefault();
    event.stopPropagation();
    run();
  });
}

function dot(status: TaskRollupStatus, className = "dot"): HTMLElement {
  return el("span", `${className} dot-${status}`);
}

/** "just now" / "12m" / "3h" / "5d" - one compact token, never a sentence. */
function relative(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(Math.max(1, minutes))}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)}h`;
  return `${String(Math.round(hours / 24))}d`;
}

function bytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(0)} MB`;
  return `${(value / 1024).toFixed(0)} KB`;
}

function compactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

function openSurface(surface: PanelSurface, extra: { readonly taskId?: string; readonly planId?: string } = {}): void {
  void request({ type: "panel.openSurface", surface, ...extra });
}

/** Focuses whichever chat surface is listening (chat rail, Edit tab fallback). */
function openChat(sessionId: string): void {
  void request({ type: "agents.openSession", sessionId });
}

function setActiveTask(target: string | null): void {
  void request({ type: "active.set", taskId: target });
}

// ---------------------------------------------------------------------------
// Webview-local persisted state
// ---------------------------------------------------------------------------

interface HubPersistedState {
  readonly systemOpen?: boolean;
}

function restore(): HubPersistedState {
  const stored: unknown = vscode.getState();
  if (typeof stored !== "object" || stored === null) return {};
  return stored as HubPersistedState;
}

// ---------------------------------------------------------------------------
// Controller state
// ---------------------------------------------------------------------------

const root = el("div", "hub");
let taskId: string | null = null;
/** One step of history: what the spine pointed at before the current task. */
let previousTaskId: string | null = null;
let previousTaskTitle: string | null = null;
let hubState: HubState | null = null;
let notice: string | null = null;
let booted = false;
let systemOpen = restore().systemOpen === true;
let backChipUntil = 0;
let backChipTimer: number | undefined;
/** The live chip node, so retiring it never has to re-render mid-interaction. */
let backChipNode: HTMLElement | null = null;
let refreshTimer: number | undefined;
/** Guards against an in-flight fetch for a task the spine has already left. */
let fetchToken = 0;
/** A refetch arrived while the composer held focus; it runs when the card frees. */
let refreshDeferred = false;

/**
 * The new-chat composer (P4). ONE node for the panel's lifetime: it holds a
 * draft, a live boot timeline and keyboard focus, none of which survive being
 * rebuilt, so the hub appends this same node on every render instead of
 * constructing a new one.
 */
const composer = createComposer({
  refresh: () => { void load(); },
  openChat: (sessionId) => openChat(sessionId),
  openPlanner: (target) => openSurface("planner", { taskId: target })
});

function persist(): void {
  vscode.setState({ systemOpen });
}

function scheduleRefresh(): void {
  // A full render moves the composer's node, which blurs whatever the user is
  // typing into. Hold the refetch until the card is done with the keyboard.
  if (composer.isBusy()) {
    refreshDeferred = true;
    return;
  }
  if (refreshTimer !== undefined) return;
  // A refetch held back while the composer had the keyboard is already overdue;
  // it does not wait out another debounce window.
  refreshTimer = window.setTimeout(() => {
    refreshTimer = undefined;
    void load();
  }, refreshDeferred ? 0 : REFRESH_DEBOUNCE_MS);
}

async function load(): Promise<void> {
  refreshDeferred = false;
  const target = taskId;
  if (target === null) {
    hubState = null;
    booted = true;
    render();
    return;
  }
  fetchToken += 1;
  const token = fetchToken;
  const response = await request({ type: "hub.state", taskId: target });
  // A retarget (or a newer refresh) landed while this was in flight: drop it
  // rather than painting a stale task over the current one.
  if (token !== fetchToken || taskId !== target) return;
  booted = true;
  if (response.ok && response.payload.type === "hub.state") {
    hubState = response.payload.state;
    notice = null;
  } else {
    hubState = null;
    notice = response.ok ? "The hub received an unexpected response." : response.error.message;
  }
  render();
}

/** The spine moved: remember one step back and raise the transient chip. */
function onSpineMoved(next: string | null): void {
  if (next === taskId) return;
  previousTaskId = taskId;
  previousTaskTitle = hubState?.task.title ?? null;
  taskId = next;
  hubState = null;
  notice = null;
  if (previousTaskId !== null) {
    backChipUntil = Date.now() + BACK_CHIP_MS;
    if (backChipTimer !== undefined) window.clearTimeout(backChipTimer);
    backChipTimer = window.setTimeout(() => {
      backChipTimer = undefined;
      backChipUntil = 0;
      backChipNode?.remove();
      backChipNode = null;
    }, BACK_CHIP_MS);
  }
  render();
  void load();
}

/** Back-chip and Alt+Left both do this: one step, no stack. */
function goBack(): void {
  if (previousTaskId === null) return;
  setActiveTask(previousTaskId);
  dismissBackChip();
}

/**
 * Retires the chip WITHOUT a re-render: this runs on pointerdown, and tearing
 * the tree down between pointerdown and click would swallow the click the user
 * is in the middle of making.
 */
function dismissBackChip(): void {
  if (backChipUntil === 0) return;
  backChipUntil = 0;
  if (backChipTimer !== undefined) {
    window.clearTimeout(backChipTimer);
    backChipTimer = undefined;
  }
  backChipNode?.remove();
  backChipNode = null;
}

// ---------------------------------------------------------------------------
// Derived status
// ---------------------------------------------------------------------------

function chatStatus(chat: HubChatSummary): TaskRollupStatus {
  return sessionRollupStatus({
    status: chat.status,
    ...(chat.live === undefined ? {} : { live: chat.live }),
    ...(chat.runningElsewhere === undefined ? {} : { runningElsewhere: chat.runningElsewhere }),
    ...(chat.needsAttention === undefined ? {} : { needsAttention: chat.needsAttention }),
    ...(chat.turnActive === undefined ? {} : { turnActive: chat.turnActive })
  });
}

/** ONE roll-up shared with the rail and the board (contracts owns the precedence). */
function hubRollup(state: HubState): TaskRollupStatus {
  const statuses: TaskRollupStatus[] = [];
  for (const chat of state.chats) statuses.push(chatStatus(chat));
  for (const sub of state.subtasks) statuses.push(subtaskRollupStatus(sub));
  return rollupTaskStatus(statuses);
}

/** Nothing running, nothing waiting, and the work has landed: quiet the cards. */
function isAllDone(state: HubState): boolean {
  if (state.attention.length > 0) return false;
  if (state.stats.runtimeCount > 0) return false;
  if (state.chats.length === 0 && state.subtasks.length === 0) return false;
  return hubRollup(state) === "done";
}

function isUntouched(state: HubState): boolean {
  return state.chats.length === 0 && state.subtasks.length === 0 && state.plans.length === 0;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(): void {
  const children: HTMLElement[] = [];
  backChipNode = null;
  if (backChipUntil > Date.now() && previousTaskId !== null) {
    backChipNode = buildBackChip();
    children.push(backChipNode);
  }
  if (notice !== null) {
    children.push(el("p", "hub-notice", notice));
  }
  if (taskId === null) {
    children.push(buildNoTaskState());
    root.replaceChildren(...children);
    return;
  }
  const state = hubState;
  if (state === null) {
    // A failed load already says why; do not stack "Loading…" on top of it.
    if (notice === null) children.push(el("p", "hub-empty", booted ? "Loading…" : ""));
    root.replaceChildren(...children);
    return;
  }
  const allDone = isAllDone(state);
  // The composer's prefills follow the task; the card itself keeps its draft.
  composer.setContext(composerContextFor(state));
  children.push(buildHeader(state, allDone));
  if (state.attention.length > 0) children.push(buildAttentionRail(state.attention));
  if (state.stats.runtimeCount > 0) children.push(buildTiles(state));
  if (isUntouched(state)) {
    children.push(buildInvite(state), composer.root);
  } else {
    children.push(buildChatsCard(state, allDone));
    if (state.subtasks.length > 0) children.push(buildSubtasksCard(state, allDone));
    if (state.plans.length > 0) children.push(buildPlansCard(state, allDone));
  }
  children.push(buildSystemCard(state));
  root.replaceChildren(...children);
}

function buildBackChip(): HTMLElement {
  const chip = document.createElement("button");
  chip.className = "hub-backchip";
  chip.title = "Return to the previous task (Alt+Left)";
  chip.append(
    icon("back"),
    el("span", undefined, previousTaskTitle === null ? "Back" : `Back to ${previousTaskTitle}`)
  );
  chip.addEventListener("click", (event) => {
    event.stopPropagation();
    goBack();
  });
  return chip;
}

function buildNoTaskState(): HTMLElement {
  const wrap = el("div", "hub-blank");
  wrap.append(
    el("p", "hub-blank-title", "No task selected"),
    el("p", "hub-blank-line", "Pick a task in the Drydock rail, or start a new one — the hub follows whatever you select.")
  );
  const actions = el("div", "hub-blank-actions");
  actions.append(
    button("hub-chip-action", "Open Board", "Open the task board", () => openSurface("board")),
    button("hub-chip-action", "Open Agents", "Open the agents panel", () => openSurface("agents"))
  );
  wrap.append(actions);
  return wrap;
}

// --- header -----------------------------------------------------------------

function buildHeader(state: HubState, allDone: boolean): HTMLElement {
  const header = el("header", allDone ? "hub-header done" : "hub-header");
  const band = el("div", "hub-header-band");
  const titleWrap = el("div", "hub-title-wrap");
  titleWrap.append(dot(hubRollup(state), "dot dot-lg"));
  const title = el("h1", "hub-title", state.task.title);
  title.title = "Click to rename";
  activatable(title, () => beginRename(titleWrap, state));
  titleWrap.append(title);
  if (state.workspaceName !== undefined) {
    titleWrap.append(el("span", "hub-chip", state.workspaceName));
  }
  band.append(titleWrap, buildLinks(state), buildOverflow(state));
  header.append(band, buildMetaLine(state));
  return header;
}

function buildLinks(state: HubState): HTMLElement {
  const links = el("nav", "hub-links");
  const entry = (name: string, label: string, run: () => void): HTMLElement => {
    const chip = el("button", "hub-link");
    chip.append(icon(name), el("span", undefined, label));
    chip.title = `Open ${label}`;
    chip.addEventListener("click", (event) => {
      event.stopPropagation();
      run();
    });
    return chip;
  };
  links.append(
    entry("board", "Board", () => openSurface("board", { taskId: state.task.taskId })),
    entry("agents", "Agents", () => openSurface("agents")),
    entry("plans", "Planner", () => openSurface("planner", { taskId: state.task.taskId })),
    entry("review", "Review", () => openSurface("review", { taskId: state.task.taskId }))
  );
  return links;
}

function buildMetaLine(state: HubState): HTMLElement {
  const parts: string[] = [];
  parts.push(plural(state.chats.length, "chat"));
  if (state.subtasks.length > 0) parts.push(plural(state.subtasks.length, "subtask"));
  if (state.plans.length > 0) parts.push(plural(state.plans.length, "plan"));
  if (state.task.openReviewCommentCount !== undefined && state.task.openReviewCommentCount > 0) {
    parts.push(plural(state.task.openReviewCommentCount, "open comment"));
  }
  const worked = state.task.lastWorkedAt ?? state.task.updatedAt;
  parts.push(`worked ${relative(worked)}`);
  return el("p", "hub-meta", parts.join(" · "));
}

/** Inline rename in place, committed through the existing task.update message. */
function beginRename(host: HTMLElement, state: HubState): void {
  const input = document.createElement("input");
  input.className = "hub-title-input";
  input.type = "text";
  input.value = state.task.title;
  input.maxLength = TITLE_MAX;
  let settled = false;
  const commit = (save: boolean): void => {
    if (settled) return;
    settled = true;
    const next = input.value.trim();
    if (save && next.length > 0 && next !== state.task.title) {
      void request({ type: "task.update", taskId: state.task.taskId, title: next }).then((response) => {
        if (!response.ok) notice = response.error.message;
        void load();
      });
      return;
    }
    render();
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); commit(true); }
    else if (event.key === "Escape") { event.preventDefault(); commit(false); }
  });
  input.addEventListener("blur", () => commit(true));
  const dotNode = host.firstElementChild;
  host.replaceChildren(...(dotNode === null ? [] : [dotNode]), input);
  input.focus();
  input.select();
}

function buildOverflow(state: HubState): HTMLElement {
  const wrap = el("div", "hub-overflow");
  const closeMenu = (): void => wrap.classList.remove("open");
  const trigger = button("hub-overflow-trigger", "⋯", "More task actions", () => {
    const open = wrap.classList.toggle("open");
    if (!open) return;
    // Any pointerdown OUTSIDE the menu closes it. Inside is left alone: hiding
    // the item between pointerdown and click would swallow the click itself.
    const close = (event: Event): void => {
      if (event.target instanceof Node && wrap.contains(event.target)) return;
      closeMenu();
      document.removeEventListener("pointerdown", close, true);
    };
    document.addEventListener("pointerdown", close, true);
  });
  const item = (label: string, className: string, title: string, run: () => void): HTMLElement =>
    button(className, label, title, () => {
      closeMenu();
      run();
    });
  const menu = el("div", "hub-menu");
  menu.append(
    item("Rename task", "hub-menu-item", "Rename this task", () => {
      const titleWrap = root.querySelector(".hub-title-wrap");
      if (titleWrap instanceof HTMLElement) beginRename(titleWrap, state);
    }),
    item("Mark done (archive)", "hub-menu-item", "Move this task to done", () => {
      void request({ type: "task.update", taskId: state.task.taskId, state: "done" }).then((response) => {
        if (!response.ok) notice = response.error.message;
        void load();
      });
    }),
    item("Delete task…", "hub-menu-item danger", "Delete this task", () => {
      void request({
        type: "ui.confirm",
        message: `Delete "${state.task.title}"?`,
        detail: "The task and its subtasks are removed. Chats and their history are not deleted.",
        confirmLabel: "Delete task"
      }).then((response) => {
        if (!response.ok || response.payload.type !== "ui.confirm" || !response.payload.confirmed) return;
        void request({ type: "task.delete", taskId: state.task.taskId });
      });
    })
  );
  wrap.append(trigger, menu);
  return wrap;
}

// --- attention --------------------------------------------------------------

function buildAttentionRail(items: readonly HubAttentionItem[]): HTMLElement {
  const rail = el("section", "hub-attention");
  const band = el("div", "hub-band attention");
  band.append(icon("attention"), el("span", "hub-band-label", "Needs you"));
  band.append(el("span", "hub-band-count", String(items.length)));
  rail.append(band);
  const list = el("div", "hub-attention-list");
  for (const item of items) {
    const row = el("div", "hub-attention-row");
    row.append(el("span", "hub-attention-kind", item.kind === "question" ? "asked" : "access"));
    row.append(el("span", "hub-attention-text", item.headline));
    activatable(row, () => openChat(item.sessionId));
    list.append(row);
  }
  rail.append(list);
  return rail;
}

// --- tiles ------------------------------------------------------------------

function buildTiles(state: HubState): HTMLElement {
  const strip = el("section", "hub-tiles");
  const tile = (label: string, value: string): HTMLElement => {
    const node = el("div", "hub-tile");
    node.append(el("span", "hub-tile-value", value), el("span", "hub-tile-label", label));
    return node;
  };
  const stats = state.stats;
  strip.append(
    tile("sandboxes", String(stats.runtimeCount)),
    tile("cpu", stats.cpuPercent === undefined ? "—" : `${stats.cpuPercent.toFixed(0)}%`),
    tile("memory", stats.memBytes === undefined ? "—" : bytes(stats.memBytes)),
    tile("tokens", stats.tokens === undefined ? "—" : compactCount(stats.tokens))
  );
  return strip;
}

// --- cards ------------------------------------------------------------------

interface Card {
  readonly root: HTMLElement;
  readonly body: HTMLElement;
}

function buildCard(iconName: string, label: string, link?: { readonly text: string; readonly run: () => void }): Card {
  const section = el("section", "hub-card");
  const band = el("div", "hub-band");
  band.append(icon(iconName), el("span", "hub-band-label", label));
  if (link !== undefined) {
    band.append(button("hub-band-link", link.text, link.text, link.run));
  }
  const body = el("div", "hub-card-body");
  section.append(band, body);
  return { root: section, body };
}

function buildChatsCard(state: HubState, allDone: boolean): HTMLElement {
  const card = buildCard("chats", "Chats", {
    text: "Agents ↗",
    run: () => openSurface("agents")
  });
  if (allDone) {
    card.body.append(el("p", "hub-summary-line", `${plural(state.chats.length, "chat")}, all finished.`));
    // Even an all-done task can be picked back up; the composer is how.
    card.body.append(composer.root);
    return card.root;
  }
  if (state.chats.length === 0) {
    card.body.append(el("p", "hub-empty", "No chats yet."));
  }
  for (const chat of state.chats) {
    card.body.append(buildChatRow(chat));
  }
  card.body.append(composer.root);
  return card.root;
}

function buildChatRow(chat: HubChatSummary): HTMLElement {
  const row = el("div", chat.needsAttention === true ? "hub-row attention" : "hub-row");
  row.append(dot(chatStatus(chat)));
  row.append(el("span", "hub-row-title", chat.title));
  const provider = chat.model === undefined ? chat.providerId : `${chat.providerId} · ${chat.model}`;
  row.append(el("span", "hub-chip quiet", provider));
  row.append(el("span", "hub-row-time", relative(chat.lastActivityAt)));
  activatable(row, () => openChat(chat.sessionId));
  return row;
}

function buildSubtasksCard(state: HubState, allDone: boolean): HTMLElement {
  const card = buildCard("subtasks", "Subtasks", {
    text: "Board ↗",
    run: () => openSurface("board", { taskId: state.task.taskId })
  });
  if (allDone) {
    card.body.append(el("p", "hub-summary-line", `${plural(state.subtasks.length, "subtask")}, all done.`));
    return card.root;
  }
  const titleById = new Map(state.subtasks.map((sub) => [sub.subtaskId, sub.title]));
  for (const sub of state.subtasks) {
    card.body.append(buildSubtaskRow(sub, titleById, state.task.taskId));
  }
  return card.root;
}

function buildSubtaskRow(
  sub: SubtaskSummary,
  titleById: ReadonlyMap<string, string>,
  taskId_: string
): HTMLElement {
  const row = el("div", "hub-row");
  row.append(dot(subtaskRollupStatus(sub)));
  row.append(el("span", "hub-row-title", sub.title));
  if (sub.dependsOn.length > 0) {
    // Prose, not a graph: the board owns the DAG.
    const names = sub.dependsOn.map((id) => titleById.get(id) ?? id).join(", ");
    row.append(el("span", "hub-row-note", `after: ${names}`));
  }
  // Chips only when true - a row with nothing to say says nothing.
  if (sub.isQueued === true) row.append(el("span", "hub-chip quiet", "queued"));
  if (sub.isParked === true) row.append(el("span", "hub-chip warn", "parked"));
  if (sub.verifyUnmet === true) row.append(el("span", "hub-chip warn", "verify"));
  if (sub.hasUnlandedChangeset === true) row.append(el("span", "hub-chip quiet", "to land"));
  activatable(row, () => openSurface("board", { taskId: taskId_ }));
  return row;
}

function buildPlansCard(state: HubState, allDone: boolean): HTMLElement {
  const card = buildCard("plans", "Plans", {
    text: "Planner ↗",
    run: () => openSurface("planner", { taskId: state.task.taskId })
  });
  if (allDone) {
    card.body.append(el("p", "hub-summary-line", `${plural(state.plans.length, "plan")}.`));
    return card.root;
  }
  for (const plan of state.plans) {
    card.body.append(buildPlanRow(plan, state.task.taskId));
  }
  return card.root;
}

function buildPlanRow(plan: PlanSummary, taskId_: string): HTMLElement {
  const row = el("div", "hub-row");
  row.append(el("span", "hub-row-title", plan.title));
  row.append(el("span", "hub-chip quiet", plural(plan.artifactCount, "doc")));
  if (plan.openAnnotationCount > 0) {
    row.append(el("span", "hub-chip warn", plural(plan.openAnnotationCount, "note")));
  }
  row.append(el("span", "hub-row-time", relative(plan.updatedAt)));
  activatable(row, () => openSurface("planner", { taskId: taskId_, planId: plan.planId }));
  return row;
}

// --- system -----------------------------------------------------------------

function buildSystemCard(state: HubState): HTMLElement {
  const details = document.createElement("details");
  details.className = "hub-card hub-system";
  details.open = systemOpen;
  details.addEventListener("toggle", () => {
    systemOpen = details.open;
    persist();
  });
  const summary = document.createElement("summary");
  summary.className = "hub-band";
  summary.append(icon("system"), el("span", "hub-band-label", "System"));
  summary.append(el("span", "hub-band-count", plural(state.system.runtimes.length, "runtime")));
  details.append(summary);

  const body = el("div", "hub-card-body");
  if (state.system.runtimes.length === 0) {
    body.append(el("p", "hub-empty", "No sandboxes for this task right now."));
  }
  for (const runtime of state.system.runtimes) {
    body.append(buildRuntimeRow(runtime));
  }
  body.append(el("p", "hub-system-line", state.system.mounts.length === 0
    ? "Mounts: none recorded."
    : `Mounts: ${state.system.mounts.join("  ·  ")}`));
  if (state.system.launchCommand !== undefined) {
    const launch = document.createElement("details");
    launch.className = "hub-launch";
    const launchSummary = document.createElement("summary");
    launchSummary.textContent = "Launch command";
    const pre = el("pre", "hub-launch-pre", state.system.launchCommand);
    launch.append(launchSummary, pre);
    body.append(launch);
  }
  const rawNote = el("p", "hub-system-line quiet");
  rawNote.append(document.createTextNode("Raw agent stream lives with the run — "));
  rawNote.append(button("hub-inline-link", "open Agents ↗", "Open the agents panel", () => openSurface("agents")));
  body.append(rawNote);
  details.append(body);
  return details;
}

function buildRuntimeRow(runtime: RuntimeSummary): HTMLElement {
  const row = el("div", "hub-row static");
  row.append(dot(runtime.status === "running" ? "running" : "offline"));
  row.append(el("span", "hub-row-title", runtime.externalName));
  row.append(el("span", "hub-chip quiet", runtime.status));
  if (runtime.agentRole !== undefined) row.append(el("span", "hub-chip quiet", runtime.agentRole));
  row.append(el("span", "hub-row-time", relative(runtime.startedAt)));
  if (runtime.status === "running") {
    const stop = el("button", "hub-row-action");
    stop.append(icon("stop"), el("span", undefined, "Stop"));
    stop.title = `Stop ${runtime.externalName}`;
    stop.addEventListener("click", (event) => {
      event.stopPropagation();
      void request({ type: "isolatedRun.stopRuntime", runtimeId: runtime.runtimeId }).then((response) => {
        if (!response.ok) notice = response.error.message;
        void load();
      });
    });
    row.append(stop);
  }
  return row;
}

// --- empty / new-task invite -------------------------------------------------

function buildInvite(state: HubState): HTMLElement {
  const wrap = el("div", "hub-blank");
  wrap.append(
    el("p", "hub-blank-title", "Nothing here yet"),
    el("p", "hub-blank-line", "Start a chat below, or draft a plan first and let it fill the board.")
  );
  const actions = el("div", "hub-blank-actions");
  actions.append(
    button("hub-chip-action", "Draft a plan", "Open the planner for this task", () => {
      openSurface("planner", { taskId: state.task.taskId });
    }),
    button("hub-chip-action", "Open Board", "Open the task board", () => {
      openSurface("board", { taskId: state.task.taskId });
    })
  );
  wrap.append(actions);
  return wrap;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const app = document.getElementById("app");
if (!app) throw new Error("missing #app root");
app.replaceChildren(root);

startMessaging();

// Any deliberate interaction retires the transient back-chip.
root.addEventListener("pointerdown", () => dismissBackChip(), true);

// The composer's boot timeline. Host-published stages, so they render the same
// whatever the agent transport does with its own output.
onPush("chat.bootProgress", (payload) => composer.onBootProgress(payload.sessionId, payload.stage));
onPush("session.updated", (payload) => composer.onSessionUpdated(payload.session));
// Model catalogs refresh out-of-band (discovery, connects, session starts);
// without this relay a long-lived hub tab never learns about new models.
onPush("provider.models", (payload) => composer.onProviderModels(payload.providerCatalogs));

onPush("activeTask", (payload) => onSpineMoved(payload.activeTaskId));
onPush("hub.back", () => goBack());
onPush("task.deleted", (payload) => {
  if (payload.taskId !== taskId) return;
  taskId = null;
  hubState = null;
  render();
});
onPush("task.updated", (payload) => {
  if (payload.task.taskId !== taskId) return;
  scheduleRefresh();
});
for (const type of [
  "session.updated",
  "session.deleted",
  "session.attention",
  "chat.turnStarted",
  "chat.turnCompleted",
  "question.asked",
  "question.resolved",
  "policy.accessRequested",
  "board.changed",
  "agents.changed",
  "planner.changed",
  "runtime.inventory"
] as const) {
  onPush(type, () => scheduleRefresh());
}

void request({ type: "active.get" }).then((response) => {
  taskId = response.ok && response.payload.type === "active.get" ? response.payload.activeTaskId : null;
  void load();
});
