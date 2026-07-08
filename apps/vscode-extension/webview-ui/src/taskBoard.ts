/**
 * Task Board editor panel webview (task board and subtasks).
 *
 * A kanban surface over the global board: a toolbar (new task, task focus
 * filter, finished-age filter, column settings) above a horizontal column
 * rail. Tasks and subtasks are independent cards that drag freely between
 * columns (HTML5 drag-and-drop with a per-card ⋯ "Move to …" menu as the
 * keyboard/pointerless fallback); moves are optimistic with revert on host
 * rejection. The panel refetches board.state on every board.changed push.
 *
 * Dependency editor: subtask cards carry input/output dots; dragging from an
 * output dot draws a ghost edge and greys out every card that is not a
 * sibling subtask of the same parent task (the boundary is visible, not just
 * enforced — the host validates same-task + acyclicity again on drop).
 * Edges render on an SVG overlay tinted by the parent-task stripe hue, shown
 * for the hovered card by default (toolbar: on hover / all / hidden); clicking
 * an edge selects it and floats a "✕ Remove dependency" at its midpoint.
 * Start actions: runnable subtasks get ▶ Start (disabled + Force start… while
 * blocked — force is manual-only); task cards get ▶ Start ready (N) with a
 * two-click confirm; running/failed chips come from the host's orchestrator
 * projections (isRunning / lastFailureAt).
 *
 * SECURITY: every dynamic string (task/subtask titles, column names,
 * workspace-set names, error messages) renders via textContent — NEVER
 * innerHTML, NEVER insertAdjacentHTML, no DOM-from-string of any kind.
 * Re-renders use replaceChildren, so listeners on discarded nodes are dropped
 * with them. Card stripe/accent colours are picked by CLASS (a fixed 8-class
 * palette over VS Code theme variables), never by inline style attributes —
 * the panel's strict CSP has no 'unsafe-inline' for styles. This entry is
 * self-contained (it does not import the control-panel bundle); the small DOM
 * helpers live in-module.
 */

import {
  WEBVIEW_PROTOCOL_VERSION,
  type BoardColumnSummary,
  type BoardState,
  type ColumnCategory,
  type HostToWebviewMessage,
  type PanelPushPayload,
  type PanelRequestPayload,
  type PanelResponse,
  type SubtaskSummary,
  type WorkTaskSummary
} from "@drydock/contracts";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): PersistedState | undefined;
  setState(state: PersistedState): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/**
 * Only the toolbar filters persist across webview reloads; the board itself is
 * re-fetched on boot. (Product-store persistence for board settings is a noted
 * later item — this is panel-local for now.)
 */
interface PersistedState {
  readonly ageDays: number;
  readonly taskFilter: string | null;
  readonly connectionsMode?: ConnectionsMode;
  /** "Lanes" toolbar toggle: stack columns into per-category lanes instead of one rail. */
  readonly lanesEnabled?: boolean;
}

const vscodeApi = acquireVsCodeApi();
const app = document.getElementById("app");
if (!app) throw new Error("missing #app root");

const REQUEST_TIMEOUT_MS = 60_000;
const PUSH_DEBOUNCE_MS = 300;
const AGE_OPTIONS = [1, 2, 3, 7, 14, 30] as const;
const CATEGORY_ORDER: readonly ColumnCategory[] = ["backlog", "pending", "in-progress", "done"];
const CATEGORY_LABEL: Record<ColumnCategory, string> = {
  "backlog": "backlog",
  "pending": "pending",
  "in-progress": "in progress",
  "done": "done"
};
const STRIPE_CLASS_COUNT = 8;

// ---------------------------------------------------------------------------
// Messaging (correlation pattern copied from taskReview.ts: 60s timeout, pending map)
// ---------------------------------------------------------------------------

const pending = new Map<string, { resolve: (value: PanelResponse) => void; timer: number }>();
let requestCounter = 0;

function request(payload: PanelRequestPayload): Promise<PanelResponse> {
  requestCounter += 1;
  const requestId = `taskboard-req-${String(requestCounter)}-${String(Date.now())}`;
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

let pushDebounceTimer = 0;

function applyPush(payload: PanelPushPayload): void {
  if (payload.type === "board.changed") {
    // Cascades and turn boundaries can arrive in bursts; collapse a burst into
    // one refetch so the board does not thrash.
    if (pushDebounceTimer) window.clearTimeout(pushDebounceTimer);
    pushDebounceTimer = window.setTimeout(() => {
      pushDebounceTimer = 0;
      void refetchBoard();
    }, PUSH_DEBOUNCE_MS);
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let board: BoardState | null = null;
/** workspaceSetId → display name, best-effort from workspace.state. */
const workspaceSetNames = new Map<string, string>();
/** "Hide finished older than N days" — done-category cards with older doneAt hide. */
let ageDays = 1;
/** Focus filter: a taskId, or null for all tasks. */
let taskFilter: string | null = null;
/** Columns whose hidden (aged-out) cards are temporarily revealed. */
const revealedColumns = new Set<string>();
/** Card key ("task:<id>" | "subtask:<id>") whose ⋯ move menu is open. */
let openMenuKey: string | null = null;
/** New-task inline input open in the toolbar (or the empty state). */
let newTaskOpen = false;
/** Open add-subtask input, keyed `${columnId}::${taskId}`. */
let addSubtaskKey: string | null = null;
/** Column-settings modal draft, or null when the modal is closed. */
let settingsDraft: SettingsDraft | null = null;
/** "Lanes" toolbar toggle: ON groups columns into stacked per-category lanes. */
let lanesEnabled = false;
/** Subtask id whose colour-override swatch picker is open (at most one at a time). */
let colorPickerSubtaskId: string | null = null;

// --- Dependency editor + start-action state ---------------------------------

/** Connections rendering: edges for the hovered card, all edges, or none. */
type ConnectionsMode = "hover" | "all" | "off";
const CONNECTIONS_MODES: readonly ConnectionsMode[] = ["hover", "all", "off"];
const CONNECTIONS_LABEL: Record<ConnectionsMode, string> = {
  "hover": "Connections: on hover",
  "all": "Connections: all",
  "off": "Connections: hidden"
};
let connectionsMode: ConnectionsMode = "hover";
/** Subtask id whose Force-start confirm is armed (two-click, like chip deletes). */
let armedForceId: string | null = null;
/** Task id whose "Start ready" confirm is armed. */
let armedTaskStartId: string | null = null;
/** Subtask card under the pointer — drives the "hover" connections mode. */
let hoveredSubtaskId: string | null = null;
/** Selected edge (floats the ✕ delete affordance at its midpoint). */
let selectedEdge: { readonly fromSubtaskId: string; readonly toSubtaskId: string; readonly taskId: string } | null = null;
/** In-flight connection drag from a subtask's output dot (coords in railWrap content space). */
let dragLink: { readonly fromSubtaskId: string; readonly taskId: string; readonly x: number; readonly y: number } | null = null;
/** Wears the shake class briefly after a rejected drop (cycle/duplicate). */
let shakeSubtaskId: string | null = null;

interface DraftColumn {
  readonly columnId?: string;
  name: string;
  readonly category: ColumnCategory;
  /** Two-click delete confirm armed on this chip. */
  armedDelete?: boolean;
}

interface SettingsDraft {
  columns: DraftColumn[];
  deletedColumnIds: string[];
  error: string | null;
  submitting: boolean;
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

const toolbar = el("div", "tb-toolbar");
const railWrap = el("div", "tb-rail-wrap");
const rail = el("div", "tb-rail");
const emptyState = el("div", "tb-empty hidden");
const loadingState = el("div", "tb-loading");
loadingState.textContent = "Loading task board…";
const statusLine = el("div", "tb-status");
const modalRoot = el("div", "tb-modal-root hidden");
railWrap.append(rail);
// Edge overlay: absolutely positioned inside the scroll container so edges
// travel with the content; paths take pointer events (selection), the layer
// itself does not. The floating ✕ lives in its own HTML layer above it.
const SVG_NS = "http://www.w3.org/2000/svg";
const edgeLayer = document.createElementNS(SVG_NS, "svg");
edgeLayer.setAttribute("class", "tb-edges");
const edgeActions = el("div", "tb-edge-actions hidden");
railWrap.append(edgeLayer, edgeActions);
app.append(toolbar, statusLine, loadingState, emptyState, railWrap, modalRoot);
// Card positions shift under inner column scrolling and window resizes; the
// capture listener catches descendants' scroll events (they do not bubble).
railWrap.addEventListener("scroll", () => scheduleEdgeRender(), true);
window.addEventListener("resize", () => scheduleEdgeRender());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) scheduleEdgeRender();
});

// A click anywhere outside an open ⋯ menu closes it (Esc too).
document.addEventListener("click", (event) => {
  if (openMenuKey === null) return;
  const target = event.target;
  if (target instanceof Element && target.closest(".tb-card-menu, .tb-menu-button")) return;
  openMenuKey = null;
  render();
});
// A click anywhere outside an open colour picker closes it (Esc too).
document.addEventListener("click", (event) => {
  if (colorPickerSubtaskId === null) return;
  const target = event.target;
  if (target instanceof Element && target.closest(".tb-color-picker")) return;
  colorPickerSubtaskId = null;
  render();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (dragLink !== null) {
    cancelLinkDrag();
    return;
  }
  let dirty = false;
  if (openMenuKey !== null) {
    openMenuKey = null;
    dirty = true;
  }
  if (colorPickerSubtaskId !== null) {
    colorPickerSubtaskId = null;
    dirty = true;
  }
  if (selectedEdge !== null) {
    selectedEdge = null;
    dirty = true;
  }
  if (armedForceId !== null || armedTaskStartId !== null) {
    armedForceId = null;
    armedTaskStartId = null;
    dirty = true;
  }
  if (dirty) render();
});

// A click anywhere outside the floating ✕ deselects the selected edge (edge
// paths stopPropagation, so selecting one never immediately deselects it).
document.addEventListener("click", (event) => {
  if (selectedEdge === null) return;
  const target = event.target;
  if (target instanceof Element && target.closest(".tb-edge-actions")) return;
  selectedEdge = null;
  scheduleEdgeRender();
});

// ---------------------------------------------------------------------------
// Selectors / helpers
// ---------------------------------------------------------------------------

function sortedColumns(): BoardColumnSummary[] {
  return board === null ? [] : [...board.columns].sort((a, b) => a.sortOrder - b.sortOrder);
}

function columnById(columnId: string): BoardColumnSummary | undefined {
  return board?.columns.find((column) => column.columnId === columnId);
}

function isDoneColumn(columnId: string): boolean {
  return columnById(columnId)?.category === "done";
}

/** Done-category columns in sort order; [0] is the automation target ("Review"). */
function doneColumns(): BoardColumnSummary[] {
  return sortedColumns().filter((column) => column.category === "done");
}

/** The column a bare subtask.create lands in (first backlog column by sortOrder). */
function defaultCreateColumn(): BoardColumnSummary | undefined {
  return sortedColumns().find((column) => column.category === "backlog");
}

/** Deterministic 0..7 palette pick from a hash of the taskId (djb2). */
function stripeIndex(taskId: string): number {
  let hash = 5381;
  for (let i = 0; i < taskId.length; i += 1) {
    hash = ((hash * 33) ^ taskId.charCodeAt(i)) >>> 0;
  }
  return hash % STRIPE_CLASS_COUNT;
}

/**
 * The lowest stripe index (0..7) not already claimed by a sibling subtask's
 * colorOverride — the colour picker's default highlighted choice, so picking
 * distinct colours across a task's subtasks is the path of least resistance.
 * Falls back to 0 once every hue is already in use.
 */
function nextAvailableHue(task: WorkTaskSummary, excludingSubtaskId: string): number {
  const used = new Set(
    task.subtasks
      .filter((subtask) => subtask.subtaskId !== excludingSubtaskId && subtask.colorOverride !== undefined)
      .map((subtask) => subtask.colorOverride)
  );
  for (let i = 0; i < STRIPE_CLASS_COUNT; i += 1) {
    if (!used.has(i)) return i;
  }
  return 0;
}

/** Chip text for a task's linked workspace sets: names when resolvable, else a count. */
function workspaceChipText(task: WorkTaskSummary): string | null {
  const ids = task.linkedWorkspaceSetIds;
  if (ids.length === 0) return null;
  const names = ids.map((id) => workspaceSetNames.get(id)).filter((name): name is string => name !== undefined);
  if (names.length === ids.length) return names.join(", ");
  return `${String(ids.length)} set${ids.length === 1 ? "" : "s"}`;
}

/** True when a done-category card's doneAt is older than the age filter. */
function isAgedOut(columnId: string, doneAt: string | undefined): boolean {
  if (!isDoneColumn(columnId)) return false;
  if (doneAt === undefined) return false; // No stamp → cannot age it out.
  const cutoff = Date.now() - ageDays * 24 * 60 * 60 * 1000;
  return Date.parse(doneAt) < cutoff;
}

/** Tasks passing the focus filter, in stable board order. */
function visibleTasks(): WorkTaskSummary[] {
  if (board === null) return [];
  return taskFilter === null ? [...board.tasks] : board.tasks.filter((task) => task.taskId === taskFilter);
}

interface ColumnCards {
  readonly tasks: WorkTaskSummary[];
  /** Subtasks grouped by parent, in stable task order. */
  readonly groups: { readonly task: WorkTaskSummary; readonly subtasks: SubtaskSummary[] }[];
  readonly hiddenCount: number;
}

/**
 * The cards a column renders after the focus + age filters: task cards first,
 * then subtasks grouped by parent in stable task order (host already sorts a
 * task's subtasks by sortOrder). `hiddenCount` counts age-filtered cards; a
 * column in `revealedColumns` shows them anyway.
 */
function cardsForColumn(columnId: string): ColumnCards {
  const revealed = revealedColumns.has(columnId);
  const tasks: WorkTaskSummary[] = [];
  const groups: { task: WorkTaskSummary; subtasks: SubtaskSummary[] }[] = [];
  let hiddenCount = 0;
  for (const task of visibleTasks()) {
    if (task.columnId === columnId) {
      if (isAgedOut(columnId, task.doneAt) && !revealed) hiddenCount += 1;
      else tasks.push(task);
    }
    const subtasks: SubtaskSummary[] = [];
    for (const subtask of task.subtasks) {
      if (subtask.columnId !== columnId) continue;
      if (isAgedOut(columnId, subtask.doneAt) && !revealed) hiddenCount += 1;
      else subtasks.push(subtask);
    }
    if (subtasks.length > 0) groups.push({ task, subtasks });
  }
  return { tasks, groups, hiddenCount };
}

function showError(text: string): void {
  statusLine.textContent = text;
  statusLine.classList.add("tb-status-error");
  console.error(`[taskBoard] ${text}`);
}

function clearStatus(): void {
  statusLine.textContent = "";
  statusLine.classList.remove("tb-status-error");
}

function persist(): void {
  vscodeApi.setState({ ageDays, taskFilter, connectionsMode, lanesEnabled });
}

/** Subtasks a "Start ready" on the task card would start right now. */
function readySubtasks(task: WorkTaskSummary): SubtaskSummary[] {
  return task.subtasks.filter((subtask) => {
    const category = columnById(subtask.columnId)?.category;
    return subtask.prompt !== undefined && subtask.prompt.length > 0
      && !subtask.isBlocked && !subtask.isRunning
      && category !== "backlog" && category !== "done";
  });
}

// ---------------------------------------------------------------------------
// Rendering (textContent only for dynamic data)
// ---------------------------------------------------------------------------

function render(): void {
  renderToolbar();
  const hasBoard = board !== null;
  loadingState.classList.toggle("hidden", hasBoard);
  const isEmpty = hasBoard && board !== null && board.tasks.length === 0;
  emptyState.classList.toggle("hidden", !isEmpty);
  railWrap.classList.toggle("hidden", !hasBoard || isEmpty);
  if (isEmpty) renderEmptyState();
  if (hasBoard && !isEmpty) renderRail();
  renderModal();
  scheduleEdgeRender();
}

function renderToolbar(): void {
  toolbar.replaceChildren();

  // ＋ New task: toggles an inline title input (also reachable from the empty state).
  if (newTaskOpen) {
    toolbar.append(buildNewTaskForm());
  } else {
    const newTask = button("＋ New task", "primary small tb-new-task");
    newTask.addEventListener("click", () => {
      newTaskOpen = true;
      render();
    });
    toolbar.append(newTask);
  }

  // Task focus filter.
  const taskSelect = document.createElement("select");
  taskSelect.className = "tb-select tb-task-filter";
  taskSelect.title = "Show cards for one task only";
  const allOption = document.createElement("option");
  allOption.value = "";
  allOption.textContent = "All tasks";
  taskSelect.append(allOption);
  for (const task of board?.tasks ?? []) {
    const option = document.createElement("option");
    option.value = task.taskId;
    option.textContent = task.title;
    taskSelect.append(option);
  }
  taskSelect.value = taskFilter ?? "";
  taskSelect.addEventListener("change", () => {
    taskFilter = taskSelect.value === "" ? null : taskSelect.value;
    persist();
    render();
  });
  toolbar.append(taskSelect);

  // Finished-age filter.
  const ageLabel = el("label", "tb-age-label");
  ageLabel.textContent = "Hide finished older than";
  const ageSelect = document.createElement("select");
  ageSelect.className = "tb-select tb-age-filter";
  ageSelect.title = "Done-category cards finished before this age hide behind a per-column counter";
  for (const days of AGE_OPTIONS) {
    const option = document.createElement("option");
    option.value = String(days);
    option.textContent = `${String(days)} day${days === 1 ? "" : "s"}`;
    ageSelect.append(option);
  }
  ageSelect.value = String(ageDays);
  ageSelect.addEventListener("change", () => {
    const parsed = Number(ageSelect.value);
    ageDays = (AGE_OPTIONS as readonly number[]).includes(parsed) ? parsed : 1;
    revealedColumns.clear();
    persist();
    render();
  });
  ageLabel.append(ageSelect);
  toolbar.append(ageLabel);

  // Dependency-connections rendering mode.
  const connSelect = document.createElement("select");
  connSelect.className = "tb-select tb-connections";
  connSelect.title = "How dependency connections render on the board";
  for (const mode of CONNECTIONS_MODES) {
    const option = document.createElement("option");
    option.value = mode;
    option.textContent = CONNECTIONS_LABEL[mode];
    connSelect.append(option);
  }
  connSelect.value = connectionsMode;
  connSelect.addEventListener("change", () => {
    connectionsMode = (CONNECTIONS_MODES as readonly string[]).includes(connSelect.value)
      ? (connSelect.value as ConnectionsMode)
      : "hover";
    persist();
    scheduleEdgeRender();
  });
  toolbar.append(connSelect);

  // Lanes toggle: groups columns into stacked per-category lanes instead of
  // one horizontal rail. Webview-local persisted state, same as the filters above.
  const lanesToggle = button("Lanes", `small tb-lanes-toggle${lanesEnabled ? " active" : ""}`);
  lanesToggle.title = "Group columns into stacked lanes by category (backlog / pending / in progress / done)";
  lanesToggle.setAttribute("aria-pressed", String(lanesEnabled));
  lanesToggle.addEventListener("click", () => {
    lanesEnabled = !lanesEnabled;
    persist();
    render();
  });
  toolbar.append(lanesToggle);

  const spacer = el("span", "tb-toolbar-spacer");
  toolbar.append(spacer);

  // Column settings modal.
  const settings = button("Columns…", "small tb-settings");
  settings.title = "Add, rename, reorder, or delete board columns";
  settings.addEventListener("click", () => {
    openSettings();
  });
  toolbar.append(settings);

  const refresh = iconButton("↻", "Refresh — refetch the board", "tb-refresh");
  refresh.addEventListener("click", () => void refetchBoard());
  toolbar.append(refresh);
}

function buildNewTaskForm(): HTMLElement {
  const form = el("div", "tb-new-task-form");
  const input = document.createElement("input");
  input.type = "text";
  input.className = "tb-input tb-new-task-input";
  input.placeholder = "New task title…";
  input.setAttribute("aria-label", "New task title");
  const create = button("Create", "primary small");
  const cancel = button("Cancel", "ghost small");
  const submit = (): void => {
    const title = input.value.trim();
    if (title.length === 0) return;
    create.disabled = true;
    void request({ type: "task.create", title }).then(async (response) => {
      if (!response.ok) {
        create.disabled = false;
        showError(`create task failed: ${response.error.message}`);
        return;
      }
      newTaskOpen = false;
      clearStatus();
      await refetchBoard();
    });
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submit();
    if (event.key === "Escape") {
      newTaskOpen = false;
      render();
    }
  });
  create.addEventListener("click", submit);
  cancel.addEventListener("click", () => {
    newTaskOpen = false;
    render();
  });
  form.append(input, create, cancel);
  queueMicrotask(() => input.focus());
  return form;
}

function renderEmptyState(): void {
  emptyState.replaceChildren();
  const hint = el("div", "tb-empty-hint");
  hint.textContent = "No tasks yet. Create one to start planning work on the board.";
  emptyState.append(hint);
  if (!newTaskOpen) {
    const create = button("＋ New task", "primary tb-empty-create");
    create.addEventListener("click", () => {
      newTaskOpen = true;
      render();
    });
    emptyState.append(create);
  }
}

/**
 * OFF (default): every column in one horizontal flex row (`.tb-rail`'s own
 * flex layout). ON: columns group by `category` (fixed CATEGORY_ORDER) into
 * stacked `.tb-lane` rows — a labelled lane per category containing that
 * category's columns, lanes stacked vertically. Toggling swaps `rail`'s
 * layout class; the column-building logic (buildColumn) is unchanged either way.
 */
function renderRail(): void {
  rail.replaceChildren();
  rail.classList.toggle("tb-lanes", lanesEnabled);
  const done = doneColumns();
  const firstDone = done[0];
  const nextDone = done[1];
  if (!lanesEnabled) {
    for (const column of sortedColumns()) {
      rail.append(buildColumn(column, firstDone, nextDone));
    }
    return;
  }
  const columnsByCategory = sortedColumns();
  for (const category of CATEGORY_ORDER) {
    const categoryColumns = columnsByCategory.filter((column) => column.category === category);
    if (categoryColumns.length === 0) continue;
    const lane = el("section", `tb-lane cat-${category}`);
    const caption = el("div", "tb-lane-caption");
    caption.textContent = CATEGORY_LABEL[category];
    lane.append(caption);
    const laneCols = el("div", "tb-lane-cols");
    for (const column of categoryColumns) {
      laneCols.append(buildColumn(column, firstDone, nextDone));
    }
    lane.append(laneCols);
    rail.append(lane);
  }
}

function buildColumn(
  column: BoardColumnSummary,
  firstDone: BoardColumnSummary | undefined,
  nextDone: BoardColumnSummary | undefined
): HTMLElement {
  const cards = cardsForColumn(column.columnId);
  const col = el("section", `tb-col cat-${column.category}`);
  col.dataset["columnId"] = column.columnId;

  const head = el("div", "tb-col-head");
  const name = el("span", "tb-col-name");
  name.textContent = column.name;
  const category = el("span", "tb-col-category");
  category.textContent = CATEGORY_LABEL[column.category];
  const count = el("span", "tb-col-count");
  const visibleCount = cards.tasks.length + cards.groups.reduce((sum, group) => sum + group.subtasks.length, 0);
  count.textContent = String(visibleCount);
  head.append(name, category, count);
  col.append(head);

  const body = el("div", "tb-col-body");
  // Drop target for HTML5 drag-and-drop card moves.
  body.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    col.classList.add("tb-drop-target");
  });
  body.addEventListener("dragleave", () => {
    col.classList.remove("tb-drop-target");
  });
  body.addEventListener("drop", (event) => {
    event.preventDefault();
    col.classList.remove("tb-drop-target");
    const raw = event.dataTransfer?.getData("application/x-drydock-card") ?? "";
    if (raw === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const drag = parsed as { cardKind?: unknown; id?: unknown };
    if ((drag.cardKind !== "task" && drag.cardKind !== "subtask") || typeof drag.id !== "string") return;
    void moveCard(drag.cardKind, drag.id, column.columnId);
  });

  // The ghost Review → Finished quick action renders only on cards sitting in
  // the FIRST done column, and only when a next done column exists.
  const ghostTarget = firstDone !== undefined && column.columnId === firstDone.columnId ? nextDone : undefined;

  // Task cards first, then subtasks grouped by parent in stable task order.
  // The add-subtask affordance renders once per (column, task) presence.
  const groupsWithAdd = new Set<string>();
  for (const task of cards.tasks) {
    body.append(buildTaskCard(task, column, ghostTarget));
    groupsWithAdd.add(task.taskId);
    body.append(buildAddSubtaskRow(column, task));
  }
  for (const group of cards.groups) {
    if (group.subtasks.length > 0) {
      const groupEl = el("div", `tb-group stripe-h${String(stripeIndex(group.task.taskId))}`);
      groupEl.dataset["taskId"] = group.task.taskId;
      for (const subtask of group.subtasks) {
        groupEl.append(buildSubtaskCard(subtask, group.task, column, ghostTarget));
      }
      body.append(groupEl);
    }
    if (!groupsWithAdd.has(group.task.taskId)) {
      groupsWithAdd.add(group.task.taskId);
      body.append(buildAddSubtaskRow(column, group.task));
    }
  }
  col.append(body);

  // Per-column footer: aged-out done cards stay reachable behind a counter.
  if (cards.hiddenCount > 0 || revealedColumns.has(column.columnId)) {
    const foot = el("div", "tb-col-foot");
    const revealed = revealedColumns.has(column.columnId);
    const toggle = button(
      revealed ? "Hide old finished" : `${String(cards.hiddenCount)} hidden · Show`,
      "ghost small tb-hidden-toggle"
    );
    toggle.addEventListener("click", () => {
      if (revealed) revealedColumns.delete(column.columnId);
      else revealedColumns.add(column.columnId);
      render();
    });
    foot.append(toggle);
    col.append(foot);
  }

  return col;
}

/** Shared card scaffolding: drag wiring, ⋯ menu button, optional ghost move. */
function wireCard(
  card: HTMLElement,
  cardKind: "task" | "subtask",
  id: string,
  currentColumn: BoardColumnSummary,
  ghostTarget: BoardColumnSummary | undefined
): void {
  card.draggable = true;
  card.addEventListener("dragstart", (event) => {
    if (!event.dataTransfer) return;
    event.dataTransfer.setData("application/x-drydock-card", JSON.stringify({ cardKind, id }));
    event.dataTransfer.effectAllowed = "move";
    card.classList.add("tb-dragging");
  });
  card.addEventListener("dragend", () => {
    card.classList.remove("tb-dragging");
  });

  const menuKey = `${cardKind}:${id}`;
  const menuButton = iconButton("⋯", "Move this card to another column", "tb-menu-button");
  menuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    openMenuKey = openMenuKey === menuKey ? null : menuKey;
    render();
  });
  card.append(menuButton);
  if (openMenuKey === menuKey) {
    card.append(buildMoveMenu(cardKind, id, currentColumn));
  }

  if (ghostTarget !== undefined) {
    const ghost = button(`Move to ${ghostTarget.name} ▸`, "ghost small tb-ghost-move");
    ghost.title = `Manual gate: nothing moves to ${ghostTarget.name} automatically`;
    ghost.addEventListener("click", () => {
      void moveCard(cardKind, id, ghostTarget.columnId);
    });
    card.append(ghost);
  }
}

function buildMoveMenu(cardKind: "task" | "subtask", id: string, currentColumn: BoardColumnSummary): HTMLElement {
  const menu = el("div", "tb-card-menu");
  menu.setAttribute("role", "menu");
  const heading = el("div", "tb-card-menu-head");
  heading.textContent = "Move to";
  menu.append(heading);
  for (const column of sortedColumns()) {
    if (column.columnId === currentColumn.columnId) continue;
    const item = button(`${column.name} ▸`, "ghost small tb-card-menu-item");
    item.setAttribute("role", "menuitem");
    item.addEventListener("click", () => {
      openMenuKey = null;
      void moveCard(cardKind, id, column.columnId);
    });
    menu.append(item);
  }
  return menu;
}

function buildTaskCard(
  task: WorkTaskSummary,
  column: BoardColumnSummary,
  ghostTarget: BoardColumnSummary | undefined
): HTMLElement {
  const card = el("article", `tb-card tb-task-card stripe-h${String(stripeIndex(task.taskId))}`);
  card.dataset["taskId"] = task.taskId;

  const head = el("div", "tb-card-head");
  const tag = el("span", "tb-task-tag");
  tag.textContent = "TASK";
  const title = el("span", "tb-task-title");
  title.textContent = task.title;
  head.append(tag, title);
  card.append(head);

  const meta = el("div", "tb-card-meta");
  const chipText = workspaceChipText(task);
  if (chipText !== null) {
    const chip = el("span", "tb-ws-chip");
    chip.textContent = chipText;
    chip.title = "Linked workspace sets";
    meta.append(chip);
  }
  const total = task.subtasks.length;
  if (total > 0) {
    const doneCount = task.subtasks.filter((subtask) => isDoneColumn(subtask.columnId)).length;
    const progress = el("span", "tb-progress");
    progress.textContent = `${String(doneCount)}/${String(total)} done`;
    meta.append(progress);
  }
  if (meta.childNodes.length > 0) card.append(meta);

  // ▶ Start ready (N): two-click confirm, then task.start — the host starts
  // every ready subtask (prompt, unblocked, not backlog/done/running).
  const ready = readySubtasks(task);
  if (ready.length > 0) {
    const armed = armedTaskStartId === task.taskId;
    const start = button(
      armed ? `Start ${String(ready.length)} ready?` : `▶ Start ready (${String(ready.length)})`,
      `ghost small tb-task-start${armed ? " armed" : ""}`
    );
    start.title = "Start every subtask with a prompt, no unfinished dependencies, and not in Backlog";
    start.addEventListener("click", () => {
      if (!armed) {
        armedTaskStartId = task.taskId;
        render();
        return;
      }
      armedTaskStartId = null;
      void startTask(task.taskId);
    });
    card.append(start);
  }

  wireCard(card, "task", task.taskId, column, ghostTarget);
  return card;
}

function buildSubtaskCard(
  subtask: SubtaskSummary,
  parent: WorkTaskSummary,
  column: BoardColumnSummary,
  ghostTarget: BoardColumnSummary | undefined
): HTMLElement {
  const card = el("article", `tb-card tb-subtask-card stripe-h${String(subtask.colorOverride ?? stripeIndex(parent.taskId))}${subtask.isBlocked ? " blocked" : ""}`);
  card.dataset["subtaskId"] = subtask.subtaskId;
  card.dataset["taskId"] = subtask.taskId;

  const parentLine = el("div", "tb-parent-line");
  parentLine.textContent = parent.title;
  card.append(parentLine);

  const head = el("div", "tb-card-head");
  const title = el("span", "tb-subtask-title");
  title.textContent = subtask.title;
  head.append(title);
  if (subtask.prompt !== undefined && subtask.prompt.length > 0) {
    const promptGlyph = el("span", "tb-prompt-glyph");
    promptGlyph.textContent = "⚡";
    promptGlyph.title = "Has a prompt — startable";
    promptGlyph.setAttribute("aria-label", "has prompt");
    head.append(promptGlyph);
  }
  if (subtask.autoStart) {
    const auto = el("span", "tb-auto-chip");
    auto.textContent = "auto";
    auto.title = "Auto-starts when its dependencies finish";
    head.append(auto);
  }
  if (subtask.isBlocked) {
    const lock = el("span", "tb-lock-chip");
    lock.textContent = "🔒";
    lock.title = "Blocked — an upstream dependency is not done yet";
    lock.setAttribute("aria-label", "blocked");
    head.append(lock);
  }
  card.append(head);

  if (shakeSubtaskId === subtask.subtaskId) card.classList.add("tb-shake");
  card.addEventListener("mouseenter", () => {
    hoveredSubtaskId = subtask.subtaskId;
    scheduleEdgeRender();
  });
  card.addEventListener("mouseleave", () => {
    if (hoveredSubtaskId === subtask.subtaskId) hoveredSubtaskId = null;
    scheduleEdgeRender();
  });

  const actions = buildSubtaskActions(subtask, column);
  if (actions.childNodes.length > 0) card.append(actions);

  card.append(buildColorPicker(subtask, parent));

  // Dependency dots. The input dot is the drop cue; a drop is accepted
  // anywhere on a valid sibling card (friendlier target than a 9px dot).
  const inDot = el("span", "tb-dot tb-dot-in");
  inDot.title = "Dependency input — drop a connection from a sibling subtask here";
  const outDot = el("span", "tb-dot tb-dot-out");
  outDot.title = "Drag onto a sibling subtask to add a dependency";
  outDot.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    beginLinkDrag(subtask, card, event);
  });
  card.append(inDot, outDot);

  wireCard(card, "subtask", subtask.subtaskId, column, ghostTarget);
  return card;
}

/** Run-state chips + start affordances for one subtask card. */
function buildSubtaskActions(subtask: SubtaskSummary, column: BoardColumnSummary): HTMLElement {
  const actions = el("div", "tb-card-actions");
  const startable = subtask.prompt !== undefined && subtask.prompt.length > 0;
  const isDone = column.category === "done";
  // Subtasks aren't just pre-prompts — chats run against them and stay grouped
  // under the task. This chip surfaces that grouping (running or finished
  // chats alike) alongside the ▶ Start affordance for starting another.
  if (subtask.linkedSessionIds.length > 0) {
    const linked = el("span", "tb-linked-chip");
    linked.textContent = `💬 ${String(subtask.linkedSessionIds.length)}`;
    linked.title = `${String(subtask.linkedSessionIds.length)} chat${subtask.linkedSessionIds.length === 1 ? "" : "s"} linked to this subtask`;
    actions.append(linked);
  }
  if (subtask.isRunning) {
    const running = el("span", "tb-running-chip");
    running.textContent = "running";
    running.title = "A chat is in flight for this subtask";
    actions.append(running);
    return actions;
  }
  if (startable && !isDone) {
    if (!subtask.isBlocked) {
      const start = button("▶ Start", "ghost small tb-start");
      start.title = "Start a chat with this subtask's prompt";
      start.addEventListener("click", () => void startSubtask(subtask.subtaskId, false));
      actions.append(start);
    } else {
      // Blocked: Start is disabled; Force start… is the manual-only override
      // (two-click confirm). Automation never forces.
      const start = button("▶ Start", "ghost small tb-start");
      start.disabled = true;
      start.title = "Blocked — upstream dependencies are not finished";
      const armed = armedForceId === subtask.subtaskId;
      const force = button(armed ? "Confirm force start" : "Force start…", `ghost small tb-force${armed ? " armed" : ""}`);
      force.title = "Manual override: start despite unfinished dependencies";
      force.addEventListener("click", () => {
        if (armedForceId !== subtask.subtaskId) {
          armedForceId = subtask.subtaskId;
          render();
          return;
        }
        void startSubtask(subtask.subtaskId, true);
      });
      actions.append(start, force);
    }
    if (subtask.lastFailureAt !== undefined) {
      const failed = el("span", "tb-failed-chip");
      failed.textContent = "failed";
      failed.title = `The last run failed or was cancelled (${new Date(subtask.lastFailureAt).toLocaleString()})`;
      actions.append(failed);
    }
  }
  return actions;
}

/**
 * Dependency-edge colour override control: a small swatch toggle (showing the
 * subtask's current effective hue) that expands into a row of the 8 palette
 * swatches plus a "clear" to revert to the parent task's stripe hue. The
 * highlighted default choice is the next hue not already claimed by a sibling
 * subtask's own override, so distinct colours are the path of least resistance.
 */
function buildColorPicker(subtask: SubtaskSummary, parent: WorkTaskSummary): HTMLElement {
  const wrap = el("div", "tb-color-picker");
  const effective = subtask.colorOverride ?? stripeIndex(parent.taskId);
  const toggle = iconButton("●", "Set this subtask's dependency-edge colour", `tb-color-toggle stripe-h${String(effective)}`);
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    colorPickerSubtaskId = colorPickerSubtaskId === subtask.subtaskId ? null : subtask.subtaskId;
    render();
  });
  wrap.append(toggle);
  if (colorPickerSubtaskId !== subtask.subtaskId) return wrap;

  const popover = el("div", "tb-color-swatches");
  popover.setAttribute("role", "menu");
  const suggested = nextAvailableHue(parent, subtask.subtaskId);
  for (let i = 0; i < STRIPE_CLASS_COUNT; i += 1) {
    const swatch = iconButton(
      "",
      `Stripe ${String(i)}${i === suggested ? " (next available)" : ""}`,
      `tb-color-swatch stripe-h${String(i)}${subtask.colorOverride === i ? " selected" : ""}${i === suggested && subtask.colorOverride === undefined ? " suggested" : ""}`
    );
    swatch.addEventListener("click", (event) => {
      event.stopPropagation();
      colorPickerSubtaskId = null;
      void updateSubtaskColor(subtask.subtaskId, i);
    });
    popover.append(swatch);
  }
  const clear = button("Clear", "ghost small tb-color-clear");
  clear.title = "Revert to the parent task's stripe hue";
  clear.addEventListener("click", (event) => {
    event.stopPropagation();
    colorPickerSubtaskId = null;
    void updateSubtaskColor(subtask.subtaskId, null);
  });
  popover.append(clear);
  wrap.append(popover);
  return wrap;
}

async function updateSubtaskColor(subtaskId: string, colorOverride: number | null): Promise<void> {
  const response = await request({ type: "subtask.update", subtaskId, colorOverride });
  if (!response.ok) {
    showError(`set colour failed: ${response.error.message}`);
    render();
    return;
  }
  clearStatus();
  await refetchBoard();
}

function buildAddSubtaskRow(column: BoardColumnSummary, task: WorkTaskSummary): HTMLElement {
  const key = `${column.columnId}::${task.taskId}`;
  const row = el("div", "tb-add-subtask");
  row.dataset["taskId"] = task.taskId;
  if (addSubtaskKey !== key) {
    const open = button("＋ Add subtask", "ghost small tb-add-subtask-button");
    open.title = `Add a subtask to "${task.title}" in ${column.name}`;
    open.addEventListener("click", () => {
      addSubtaskKey = key;
      render();
    });
    row.append(open);
    return row;
  }
  const input = document.createElement("input");
  input.type = "text";
  input.className = "tb-input tb-add-subtask-input";
  input.placeholder = "Subtask title…";
  input.setAttribute("aria-label", `New subtask for ${task.title}`);
  const add = button("Add", "primary small");
  const cancel = button("Cancel", "ghost small");
  const submit = (): void => {
    const title = input.value.trim();
    if (title.length === 0) return;
    add.disabled = true;
    void createSubtaskInColumn(task, title, column).then(() => {
      addSubtaskKey = null;
    });
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submit();
    if (event.key === "Escape") {
      addSubtaskKey = null;
      render();
    }
  });
  add.addEventListener("click", submit);
  cancel.addEventListener("click", () => {
    addSubtaskKey = null;
    render();
  });
  row.append(input, add, cancel);
  queueMicrotask(() => input.focus());
  return row;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Optimistic column move: mutate the local board copy first, then send
 * board.moveCard. Success adopts the host's fresh board (doneAt stamps,
 * blocked recomputes); failure reverts to the pre-move snapshot and surfaces
 * the error on the status line.
 */
async function moveCard(cardKind: "task" | "subtask", id: string, columnId: string): Promise<void> {
  if (board === null) return;
  const snapshot = board;
  const optimistic: BoardState = {
    columns: board.columns,
    tasks: board.tasks.map((task) => {
      if (cardKind === "task") {
        return task.taskId === id ? { ...task, columnId } : task;
      }
      if (!task.subtasks.some((subtask) => subtask.subtaskId === id)) return task;
      return {
        ...task,
        subtasks: task.subtasks.map((subtask) => (subtask.subtaskId === id ? { ...subtask, columnId } : subtask))
      };
    })
  };
  board = optimistic;
  openMenuKey = null;
  render();

  const response = await request({ type: "board.moveCard", cardKind, id, columnId });
  if (response.ok && response.payload.type === "board.moveCard") {
    board = response.payload.board;
    clearStatus();
    render();
    return;
  }
  board = snapshot;
  render();
  showError(response.ok ? "move failed: unexpected response" : `move failed: ${response.error.message}`);
}

/**
 * "＋ Add subtask" in a specific column: the create contract has no columnId
 * (a fresh subtask lands in the first backlog column), so a non-backlog target
 * gets a follow-up board.moveCard for the freshly created card. The new
 * subtask is identified by diffing the returned task's subtask ids against the
 * pre-create set.
 */
async function createSubtaskInColumn(task: WorkTaskSummary, title: string, column: BoardColumnSummary): Promise<void> {
  const before = new Set(task.subtasks.map((subtask) => subtask.subtaskId));
  const response = await request({ type: "subtask.create", taskId: task.taskId, title });
  if (!response.ok || response.payload.type !== "subtask.create") {
    showError(response.ok ? "add subtask failed: unexpected response" : `add subtask failed: ${response.error.message}`);
    render();
    return;
  }
  const created = response.payload.task.subtasks.find((subtask) => !before.has(subtask.subtaskId));
  const defaultColumn = defaultCreateColumn();
  if (created !== undefined && column.columnId !== (defaultColumn?.columnId ?? column.columnId)) {
    const move = await request({ type: "board.moveCard", cardKind: "subtask", id: created.subtaskId, columnId: column.columnId });
    if (move.ok && move.payload.type === "board.moveCard") {
      board = move.payload.board;
      clearStatus();
      render();
      return;
    }
    showError(move.ok ? "move failed: unexpected response" : `subtask created in ${defaultColumn?.name ?? "the default column"}; move failed: ${move.error.message}`);
  } else {
    clearStatus();
  }
  await refetchBoard();
}

/** Start one subtask; force is the manual-only override for a BLOCKED card. */
async function startSubtask(subtaskId: string, force: boolean): Promise<void> {
  armedForceId = null;
  const response = await request(force ? { type: "subtask.start", subtaskId, force: true } : { type: "subtask.start", subtaskId });
  if (!response.ok) {
    showError(`start failed: ${response.error.message}`);
    render();
    return;
  }
  clearStatus();
  await refetchBoard();
}

/** Start every ready subtask of a task (the host applies the readiness rules). */
async function startTask(taskId: string): Promise<void> {
  const response = await request({ type: "task.start", taskId });
  if (!response.ok) {
    showError(`start failed: ${response.error.message}`);
    render();
    return;
  }
  clearStatus();
  await refetchBoard();
}

// ---------------------------------------------------------------------------
// Dependency editor (dots, drag-to-connect, edge overlay)
// ---------------------------------------------------------------------------

function cardElement(subtaskId: string): HTMLElement | null {
  return rail.querySelector<HTMLElement>(`.tb-subtask-card[data-subtask-id="${CSS.escape(subtaskId)}"]`);
}

interface DotPoint {
  readonly x: number;
  readonly y: number;
}

/** railWrap-content-space coordinates of a card's left/right edge midpoints. */
function dotPoints(cardEl: HTMLElement): { readonly input: DotPoint; readonly output: DotPoint } {
  const base = railWrap.getBoundingClientRect();
  const rect = cardEl.getBoundingClientRect();
  const y = rect.top + rect.height / 2 - base.top + railWrap.scrollTop;
  return {
    input: { x: rect.left - base.left + railWrap.scrollLeft, y },
    output: { x: rect.right - base.left + railWrap.scrollLeft, y }
  };
}

let edgeRenderScheduled = false;

/**
 * Coalesces edge redraws (render, hover, scroll, resize) into one pass. rAF is
 * suspended while the document is hidden (an occluded harness tab, a hidden
 * editor tab), which would leave the scheduled flag stuck until reveal — so a
 * hidden document falls back to a timeout, keeping edge geometry deterministic
 * for automation. Geometry measured in a hidden layout can be degenerate; the
 * visibilitychange listener below re-renders on reveal to correct it.
 */
function scheduleEdgeRender(): void {
  if (edgeRenderScheduled) return;
  edgeRenderScheduled = true;
  const run = (): void => {
    edgeRenderScheduled = false;
    renderEdges();
  };
  if (document.hidden) setTimeout(run, 0);
  else requestAnimationFrame(run);
}

interface VisibleEdge {
  readonly fromSubtaskId: string;
  readonly toSubtaskId: string;
  readonly taskId: string;
  readonly stripe: number;
}

/** Edges to draw under the current connections mode (selected edges always show). */
function visibleEdges(): VisibleEdge[] {
  if (board === null || connectionsMode === "off") return [];
  const edges: VisibleEdge[] = [];
  for (const task of visibleTasks()) {
    for (const subtask of task.subtasks) {
      for (const fromSubtaskId of subtask.dependsOn) {
        if (connectionsMode === "hover") {
          const touchesHover = hoveredSubtaskId !== null
            && (fromSubtaskId === hoveredSubtaskId || subtask.subtaskId === hoveredSubtaskId);
          const isSelected = selectedEdge !== null
            && selectedEdge.fromSubtaskId === fromSubtaskId && selectedEdge.toSubtaskId === subtask.subtaskId;
          if (!touchesHover && !isSelected) continue;
        }
        // An edge tints by its downstream (dependent) subtask's own colour
        // override when set, else the parent task's stripe hue — two
        // overlapping tasks' webs no longer blend together once subtasks pick
        // distinct colours.
        edges.push({
          fromSubtaskId,
          toSubtaskId: subtask.subtaskId,
          taskId: task.taskId,
          stripe: subtask.colorOverride ?? stripeIndex(task.taskId)
        });
      }
    }
  }
  return edges;
}

function edgePath(from: DotPoint, to: DotPoint): string {
  const bend = Math.max(32, Math.min(120, Math.abs(to.x - from.x) / 2));
  return `M ${String(from.x)} ${String(from.y)} C ${String(from.x + bend)} ${String(from.y)}, ${String(to.x - bend)} ${String(to.y)}, ${String(to.x)} ${String(to.y)}`;
}

/** Redraws the overlay: edges (tinted by parent-task stripe), drag ghost, selected-edge ✕. */
function renderEdges(): void {
  while (edgeLayer.firstChild) edgeLayer.firstChild.remove();
  edgeActions.classList.add("hidden");
  if (board === null || railWrap.classList.contains("hidden")) return;
  edgeLayer.setAttribute("width", String(railWrap.scrollWidth));
  edgeLayer.setAttribute("height", String(Math.max(railWrap.scrollHeight, railWrap.clientHeight)));

  for (const edge of visibleEdges()) {
    const fromEl = cardElement(edge.fromSubtaskId);
    const toEl = cardElement(edge.toSubtaskId);
    if (fromEl === null || toEl === null) continue; // an endpoint is filtered or age-hidden
    const from = dotPoints(fromEl).output;
    const to = dotPoints(toEl).input;
    const isSelected = selectedEdge !== null
      && selectedEdge.fromSubtaskId === edge.fromSubtaskId && selectedEdge.toSubtaskId === edge.toSubtaskId;
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", edgePath(from, to));
    path.setAttribute("class", `tb-edge stripe-h${String(edge.stripe)}${isSelected ? " selected" : ""}`);
    path.addEventListener("click", (event) => {
      event.stopPropagation();
      selectedEdge = { fromSubtaskId: edge.fromSubtaskId, toSubtaskId: edge.toSubtaskId, taskId: edge.taskId };
      scheduleEdgeRender();
    });
    edgeLayer.append(path);
    const arrow = document.createElementNS(SVG_NS, "path");
    arrow.setAttribute("d", `M ${String(to.x)} ${String(to.y)} l -8 -4.5 v 9 Z`);
    arrow.setAttribute("class", `tb-edge-arrow stripe-h${String(edge.stripe)}`);
    edgeLayer.append(arrow);
    if (isSelected) positionEdgeActions(from, to, edge);
  }

  if (dragLink !== null) {
    const fromEl = cardElement(dragLink.fromSubtaskId);
    if (fromEl !== null) {
      const ghost = document.createElementNS(SVG_NS, "path");
      ghost.setAttribute("d", edgePath(dotPoints(fromEl).output, { x: dragLink.x, y: dragLink.y }));
      ghost.setAttribute("class", "tb-edge tb-edge-ghost");
      edgeLayer.append(ghost);
    }
  }
}

/** Floats "✕ Remove dependency" at the selected edge's midpoint. */
function positionEdgeActions(from: DotPoint, to: DotPoint, edge: VisibleEdge): void {
  edgeActions.replaceChildren();
  const remove = button("✕ Remove dependency", "ghost small tb-edge-delete");
  remove.addEventListener("click", () => {
    void removeDependency(edge);
  });
  edgeActions.append(remove);
  edgeActions.classList.remove("hidden");
  // CSSOM assignment (not a parsed style attribute) — fine under the strict CSP.
  edgeActions.style.left = `${String(Math.max(0, (from.x + to.x) / 2 - 70))}px`;
  edgeActions.style.top = `${String(Math.max(0, (from.y + to.y) / 2 - 26))}px`;
}

async function removeDependency(edge: VisibleEdge): Promise<void> {
  selectedEdge = null;
  const response = await request({
    type: "subtask.dependency.remove",
    taskId: edge.taskId,
    fromSubtaskId: edge.fromSubtaskId,
    toSubtaskId: edge.toSubtaskId
  });
  if (!response.ok) {
    showError(`remove dependency failed: ${response.error.message}`);
    scheduleEdgeRender();
    return;
  }
  clearStatus();
  await refetchBoard();
}

/**
 * Connection drag from an output dot. While it is live, every card that is not
 * a sibling subtask of the same parent task greys out and drops its dots — the
 * task boundary is visible during the gesture, not just enforced on drop (the
 * host re-validates same-task + acyclicity anyway).
 */
function beginLinkDrag(subtask: SubtaskSummary, cardEl: HTMLElement, event: PointerEvent): void {
  const base = railWrap.getBoundingClientRect();
  dragLink = {
    fromSubtaskId: subtask.subtaskId,
    taskId: subtask.taskId,
    x: event.clientX - base.left + railWrap.scrollLeft,
    y: event.clientY - base.top + railWrap.scrollTop
  };
  // The card's HTML5 column-drag would swallow the pointer gesture: park it.
  cardEl.draggable = false;
  rail.classList.add("tb-linking");
  for (const other of rail.querySelectorAll<HTMLElement>(".tb-card")) {
    const isSibling = other.classList.contains("tb-subtask-card")
      && other.dataset["taskId"] === subtask.taskId
      && other.dataset["subtaskId"] !== subtask.subtaskId;
    if (!isSibling) other.classList.add("tb-dim");
  }
  window.addEventListener("pointermove", onLinkDragMove);
  window.addEventListener("pointerup", onLinkDragEnd);
  scheduleEdgeRender();
}

function onLinkDragMove(event: PointerEvent): void {
  if (dragLink === null) return;
  const base = railWrap.getBoundingClientRect();
  dragLink = {
    ...dragLink,
    x: event.clientX - base.left + railWrap.scrollLeft,
    y: event.clientY - base.top + railWrap.scrollTop
  };
  scheduleEdgeRender();
}

function onLinkDragEnd(event: PointerEvent): void {
  const link = dragLink;
  cancelLinkDrag();
  if (link === null) return;
  const target = document.elementFromPoint(event.clientX, event.clientY);
  const targetCard = target instanceof Element ? target.closest<HTMLElement>(".tb-subtask-card") : null;
  const toSubtaskId = targetCard?.dataset["subtaskId"];
  if (targetCard === null || toSubtaskId === undefined) return; // dropped on nothing → cancel
  if (targetCard.dataset["taskId"] !== link.taskId || toSubtaskId === link.fromSubtaskId) return;
  void addDependency(link.taskId, link.fromSubtaskId, toSubtaskId);
}

function cancelLinkDrag(): void {
  if (dragLink === null && !rail.classList.contains("tb-linking")) return;
  dragLink = null;
  rail.classList.remove("tb-linking");
  window.removeEventListener("pointermove", onLinkDragMove);
  window.removeEventListener("pointerup", onLinkDragEnd);
  // Fresh cards from the re-render restore draggable + drop the dim classes.
  render();
}

async function addDependency(taskId: string, fromSubtaskId: string, toSubtaskId: string): Promise<void> {
  const response = await request({ type: "subtask.dependency.add", taskId, fromSubtaskId, toSubtaskId });
  if (!response.ok) {
    // Cycle/duplicate rejections arrive as readable service errors; shake the
    // refused target so the rejection lands visually too.
    showError(`add dependency failed: ${response.error.message}`);
    shakeSubtaskId = toSubtaskId;
    render();
    window.setTimeout(() => {
      shakeSubtaskId = null;
      render();
    }, 600);
    return;
  }
  clearStatus();
  await refetchBoard();
}

// ---------------------------------------------------------------------------
// Column settings modal
// ---------------------------------------------------------------------------

function openSettings(): void {
  if (board === null) return;
  settingsDraft = {
    columns: sortedColumns().map((column) => ({
      columnId: column.columnId,
      name: column.name,
      category: column.category
    })),
    deletedColumnIds: [],
    error: null,
    submitting: false
  };
  render();
}

function closeSettings(): void {
  settingsDraft = null;
  render();
}

function renderModal(): void {
  const draft = settingsDraft;
  modalRoot.classList.toggle("hidden", draft === null);
  modalRoot.replaceChildren();
  if (draft === null) return;

  const overlay = el("div", "tb-modal-overlay");
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay && !draft.submitting) closeSettings();
  });
  const modal = el("div", "tb-modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-label", "Column settings");

  const head = el("div", "tb-modal-head");
  const title = el("h2", "tb-modal-title");
  title.textContent = "Columns";
  const hint = el("div", "tb-modal-hint");
  hint.textContent = "Four fixed categories drive automation; columns are cosmetic groupings within them. Deleting a column moves its cards to the nearest column of the same category.";
  head.append(title, hint);
  modal.append(head);

  const lanes = el("div", "tb-modal-lanes");
  for (const category of CATEGORY_ORDER) {
    lanes.append(buildCategoryLane(draft, category));
  }
  modal.append(lanes);

  const foot = el("div", "tb-modal-foot");
  const error = el("span", "tb-modal-error");
  if (draft.error !== null) error.textContent = draft.error;
  const footSpacer = el("span", "tb-toolbar-spacer");
  const cancel = button("Cancel", "ghost small");
  cancel.disabled = draft.submitting;
  cancel.addEventListener("click", closeSettings);
  const save = button(draft.submitting ? "Saving…" : "Save columns", "primary small tb-modal-save");
  save.disabled = draft.submitting;
  save.addEventListener("click", () => void submitSettings());
  foot.append(error, footSpacer, cancel, save);
  modal.append(foot);

  overlay.append(modal);
  modalRoot.append(overlay);
}

function buildCategoryLane(draft: SettingsDraft, category: ColumnCategory): HTMLElement {
  const lane = el("section", `tb-lane cat-${category}`);
  const head = el("div", "tb-lane-head");
  head.textContent = CATEGORY_LABEL[category].toUpperCase();
  lane.append(head);

  const chips = draft.columns.filter((column) => column.category === category);
  const list = el("div", "tb-lane-list");
  for (const chip of chips) {
    list.append(buildColumnChip(draft, chip, chips));
  }
  lane.append(list);

  // Add a column to this category.
  const addRow = el("div", "tb-lane-add");
  const input = document.createElement("input");
  input.type = "text";
  input.className = "tb-input tb-lane-add-input";
  input.placeholder = "＋ Add column…";
  input.setAttribute("aria-label", `New ${CATEGORY_LABEL[category]} column name`);
  const add = button("Add", "ghost small");
  const submit = (): void => {
    const name = input.value.trim();
    if (name.length === 0) return;
    draft.columns.push({ name, category });
    draft.error = null;
    render();
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submit();
  });
  add.addEventListener("click", submit);
  addRow.append(input, add);
  lane.append(addRow);

  return lane;
}

function buildColumnChip(draft: SettingsDraft, chip: DraftColumn, siblings: DraftColumn[]): HTMLElement {
  const row = el("div", "tb-chip");
  if (chip.columnId !== undefined) row.dataset["columnId"] = chip.columnId;

  // Rename: the chip's name is a live inline input.
  const input = document.createElement("input");
  input.type = "text";
  input.className = "tb-input tb-chip-name";
  input.value = chip.name;
  input.setAttribute("aria-label", "Column name");
  input.addEventListener("input", () => {
    chip.name = input.value;
  });
  row.append(input);

  const index = siblings.indexOf(chip);
  const up = iconButton("↑", "Move up within this category", "tb-chip-up");
  up.disabled = index <= 0;
  up.addEventListener("click", () => {
    swapDraftColumns(draft, chip, siblings[index - 1]);
  });
  const down = iconButton("↓", "Move down within this category", "tb-chip-down");
  down.disabled = index >= siblings.length - 1;
  down.addEventListener("click", () => {
    swapDraftColumns(draft, chip, siblings[index + 1]);
  });
  row.append(up, down);

  // Delete: two-click inline confirm. The last chip of a category refuses
  // client-side (the service enforces the same invariant).
  const remove = button(chip.armedDelete === true ? "Confirm?" : "✕", `ghost small tb-chip-delete${chip.armedDelete === true ? " armed" : ""}`);
  remove.title = "Delete this column (cards move to the nearest column of the same category)";
  remove.addEventListener("click", () => {
    if (chip.armedDelete !== true) {
      for (const column of draft.columns) column.armedDelete = false;
      chip.armedDelete = true;
      render();
      return;
    }
    if (siblings.length <= 1) {
      chip.armedDelete = false;
      draft.error = `Cannot delete the last ${CATEGORY_LABEL[chip.category]} column; every category needs at least one.`;
      render();
      return;
    }
    if (chip.columnId !== undefined) draft.deletedColumnIds.push(chip.columnId);
    draft.columns = draft.columns.filter((column) => column !== chip);
    draft.error = null;
    render();
  });
  row.append(remove);

  return row;
}

/** Swaps two draft columns' global positions (used for within-category up/down). */
function swapDraftColumns(draft: SettingsDraft, a: DraftColumn, b: DraftColumn | undefined): void {
  if (b === undefined) return;
  const ai = draft.columns.indexOf(a);
  const bi = draft.columns.indexOf(b);
  if (ai < 0 || bi < 0) return;
  draft.columns[ai] = b;
  draft.columns[bi] = a;
  draft.error = null;
  render();
}

async function submitSettings(): Promise<void> {
  const draft = settingsDraft;
  if (draft === null) return;
  for (const column of draft.columns) {
    if (column.name.trim().length === 0) {
      draft.error = "Column names must not be empty.";
      render();
      return;
    }
  }
  draft.submitting = true;
  draft.error = null;
  render();
  // Global sortOrder: lanes in fixed category order, chips in lane order —
  // preserves category grouping in the rail.
  let sortOrder = 0;
  const columns = [];
  for (const category of CATEGORY_ORDER) {
    for (const chip of draft.columns.filter((column) => column.category === category)) {
      columns.push({
        ...(chip.columnId === undefined ? {} : { columnId: chip.columnId }),
        name: chip.name.trim(),
        category: chip.category,
        sortOrder
      });
      sortOrder += 1;
    }
  }
  const response = await request({
    type: "board.columns.update",
    columns,
    ...(draft.deletedColumnIds.length === 0 ? {} : { deletedColumnIds: draft.deletedColumnIds })
  });
  if (response.ok && response.payload.type === "board.columns.update") {
    board = response.payload.board;
    settingsDraft = null;
    clearStatus();
    render();
    return;
  }
  draft.submitting = false;
  draft.error = response.ok ? "Unexpected response." : response.error.message;
  render();
}

// ---------------------------------------------------------------------------
// Loaders + boot
// ---------------------------------------------------------------------------

async function loadBoard(): Promise<void> {
  const response = await request({ type: "board.state" });
  if (response.ok && response.payload.type === "board.state") {
    board = response.payload.board;
    // A focused task that vanished resets the filter to All.
    if (taskFilter !== null && !board.tasks.some((task) => task.taskId === taskFilter)) {
      taskFilter = null;
      persist();
    }
    return;
  }
  if (!response.ok) {
    if (board === null) {
      loadingState.textContent = `Task board failed to load: ${response.error.message}`;
    } else {
      showError(`refresh failed: ${response.error.message}`);
    }
  }
}

/** Best-effort workspace-set name resolution for task-card chips. */
async function loadWorkspaceSetNames(): Promise<void> {
  const response = await request({ type: "workspace.state" });
  if (response.ok && response.payload.type === "workspace.state") {
    workspaceSetNames.clear();
    for (const set of response.payload.state.workspaceSets) {
      workspaceSetNames.set(set.workspaceSetId, set.name);
    }
  }
}

async function refetchBoard(): Promise<void> {
  await loadBoard();
  render();
}

const saved = vscodeApi.getState();
if (saved) {
  if (typeof saved.ageDays === "number" && (AGE_OPTIONS as readonly number[]).includes(saved.ageDays)) {
    ageDays = saved.ageDays;
  }
  if (typeof saved.taskFilter === "string") {
    taskFilter = saved.taskFilter;
  }
  if (saved.connectionsMode === "hover" || saved.connectionsMode === "all" || saved.connectionsMode === "off") {
    connectionsMode = saved.connectionsMode;
  }
  if (typeof saved.lanesEnabled === "boolean") {
    lanesEnabled = saved.lanesEnabled;
  }
}
void Promise.all([loadWorkspaceSetNames(), loadBoard()]).then(() => render());

// ---------------------------------------------------------------------------
// Local DOM helpers (kept in-module; this standalone entry does not import the
// control-panel component bundle).
// ---------------------------------------------------------------------------

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function button(label: string, extraClass = ""): HTMLButtonElement {
  const node = document.createElement("button");
  node.textContent = label;
  node.className = `button ${extraClass}`.trim();
  return node;
}

function iconButton(glyph: string, title: string, extraClass = ""): HTMLButtonElement {
  const node = document.createElement("button");
  node.textContent = glyph;
  node.className = `icon-button ${extraClass}`.trim();
  node.title = title;
  node.setAttribute("aria-label", title);
  return node;
}
