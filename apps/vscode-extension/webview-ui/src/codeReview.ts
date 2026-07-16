/**
 * Code Review editor panel webview (in-panel PR-style review).
 *
 * GitHub/GitLab-style continuous review over a task's changes: a left
 * navigator (projects → compressed folder tree → files) and a right review
 * scroll of file cards in navigator order — text diffs (unified or split),
 * image before/after, binary byte deltas, large/generated files collapsed by
 * default. A header scope seg switches between All uncommitted / Task /
 * Session; whitespace hiding refetches host-side.
 *
 * COMMENTING (selection-driven): selecting diff rows shows the comment box on
 * mouseup, anchored after the LAST selected row. Further selections (any file)
 * add ranges to the same pending note — chips list them, ✕ removes one, and
 * Dismiss clears the box. Comment stores the note (one comment per anchor via
 * codeReview.addNote) and hides the box. Open threads render inline under
 * their anchored rows and go back to the owning agents via taskReview.submit.
 *
 * SECURITY: every dynamic string (titles, paths, diff row text, comment
 * bodies) renders via textContent — NEVER innerHTML, no DOM-from-string.
 * Re-renders use replaceChildren so stale listeners drop with their nodes.
 */

import {
  WEBVIEW_PROTOCOL_VERSION,
  type CodeReviewAnchor,
  type CodeReviewFile,
  type CodeReviewPanelState,
  type CodeReviewScope,
  type DiffChangeKind,
  type HostToWebviewMessage,
  type PanelRequestPayload,
  type PanelResponse,
  type ReviewCommentSummary,
  type ReviewDiffHunk,
  type ReviewDiffRow,
  type ReviewFileDiff,
  type ReviewThreadStatus
} from "@drydock/contracts";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): PersistedState | undefined;
  setState(state: PersistedState): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

interface PersistedState {
  readonly scope?: CodeReviewScope;
  readonly ignoreWhitespace?: boolean;
  readonly split?: boolean;
  readonly viewedKeys?: readonly string[];
}

const vscodeApi = acquireVsCodeApi();
const app = document.getElementById("app");
if (!app) throw new Error("missing #app root");
const taskId = app.dataset["taskId"] ?? "";

const REQUEST_TIMEOUT_MS = 60_000;
const PUSH_DEBOUNCE_MS = 300;
const REVIEW_STATUSES: readonly ReviewThreadStatus[] = ["open", "acknowledged", "delegated", "resolved", "wont-fix", "blocked"];
const CHANGE_GLYPH: Record<DiffChangeKind, { glyph: string; cls: string }> = {
  add: { glyph: "+", cls: "kind-add" },
  modify: { glyph: "±", cls: "kind-modify" },
  delete: { glyph: "−", cls: "kind-delete" },
  rename: { glyph: "→", cls: "kind-rename" }
};

// ---------------------------------------------------------------------------
// Messaging (correlation pattern shared with the other standalone panels)
// ---------------------------------------------------------------------------

const pending = new Map<string, { resolve: (value: PanelResponse) => void; timer: number }>();
let requestCounter = 0;

function request(payload: PanelRequestPayload): Promise<PanelResponse> {
  requestCounter += 1;
  const requestId = `codereview-req-${String(requestCounter)}-${String(Date.now())}`;
  return new Promise<PanelResponse>((resolve) => {
    const timer = window.setTimeout(() => {
      pending.delete(requestId);
      resolve({
        protocolVersion: WEBVIEW_PROTOCOL_VERSION,
        kind: "response",
        requestId,
        ok: false,
        error: { message: `Request ${payload.type} timed out.` }
      });
    }, REQUEST_TIMEOUT_MS);
    pending.set(requestId, { resolve, timer });
    vscodeApi.postMessage({ protocolVersion: WEBVIEW_PROTOCOL_VERSION, kind: "request", requestId, payload });
  });
}

let refetchTimer = 0;
window.addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = event.data as HostToWebviewMessage;
  if (typeof message !== "object" || message === null) return;
  if (message.kind === "response") {
    const waiter = pending.get(message.requestId);
    if (waiter) {
      pending.delete(message.requestId);
      window.clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
    return;
  }
  if (message.kind === "push" && message.payload.type === "codeReview.updated") {
    if (refetchTimer) window.clearTimeout(refetchTimer);
    refetchTimer = window.setTimeout(() => {
      refetchTimer = 0;
      void loadState({ preserveDiffs: false });
    }, PUSH_DEBOUNCE_MS);
  }
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const persisted = vscodeApi.getState();
let scope: CodeReviewScope = persisted?.scope ?? "task";
let ignoreWhitespace = persisted?.ignoreWhitespace ?? false;
let split = persisted?.split ?? false;
let viewedKeys = new Set<string>(persisted?.viewedKeys ?? []);

let state: CodeReviewPanelState | null = null;
let statusLine = "";
/** repo:path → fetched diff (invalidated on scope/whitespace change + pushes). */
const diffCache = new Map<string, ReviewFileDiff>();
/** repo:path → open+all comments anchored to that file. */
const commentsByFile = new Map<string, ReviewCommentSummary[]>();
/** repo:path → user collapse override (wins over the largeDiff default). */
const collapseOverride = new Map<string, boolean>();
/** Cards whose diff fetch is in flight (dedupe). */
const fetchInFlight = new Set<string>();

/** Pending note: accumulated selection ranges awaiting one comment body. */
interface PendingRange {
  readonly anchor: CodeReviewAnchor;
  readonly rows: HTMLTableRowElement[];
}
let pendingRanges: PendingRange[] = [];
let composerDraft = "";

function fileKey(file: { repo: string; path: string }): string {
  return `${file.repo}:${file.path}`;
}

function persist(): void {
  vscodeApi.setState({ scope, ignoreWhitespace, split, viewedKeys: [...viewedKeys] });
}

function allFiles(): CodeReviewFile[] {
  return (state?.projects ?? []).flatMap((project) => [...project.files]);
}

function isCollapsed(file: CodeReviewFile): boolean {
  const override = collapseOverride.get(fileKey(file));
  if (override !== undefined) return override;
  return file.largeDiff === true;
}

/** Open comments for a file, matching the `<repo>:<path>` anchor or the plain path. */
function commentsFor(file: CodeReviewFile): ReviewCommentSummary[] {
  return commentsByFile.get(fileKey(file)) ?? [];
}

// ---------------------------------------------------------------------------
// DOM helpers (self-contained, textContent only)
// ---------------------------------------------------------------------------

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement("button");
  node.className = className;
  node.textContent = label;
  node.addEventListener("click", onClick);
  return node;
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "—";
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

const header = el("header", "cr-header");
const sidebar = el("aside", "cr-sidebar");
const main = el("main", "cr-main");
const bodyRow = el("div", "cr-body");
bodyRow.append(sidebar, main);
app.append(header, bodyRow);

// Lazy per-card diff fetch: fetch when a card approaches the viewport.
const cardObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const key = (entry.target as HTMLElement).dataset["key"];
    if (key !== undefined) void ensureDiff(key);
  }
}, { root: main, rootMargin: "600px 0px" });

// Scroll-spy: highlight the sidebar row of the card nearest the viewport top.
const spyObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const key = (entry.target as HTMLElement).dataset["key"];
    if (key === undefined) continue;
    for (const row of sidebar.querySelectorAll<HTMLElement>(".cr-file-row")) {
      row.classList.toggle("current", row.dataset["key"] === key);
    }
    break;
  }
}, { root: main, rootMargin: "0px 0px -75% 0px" });

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function loadState(options: { preserveDiffs: boolean }): Promise<void> {
  const response = await request({ type: "codeReview.state", taskId, scope });
  if (!response.ok || response.payload.type !== "codeReview.state") {
    statusLine = response.ok ? "unexpected response" : response.error.message;
    render();
    return;
  }
  state = response.payload.state;
  if (!options.preserveDiffs) diffCache.clear();
  await loadComments();
  render();
}

/** Fetches every relevant session's comments and indexes them by file key. */
async function loadComments(): Promise<void> {
  commentsByFile.clear();
  if (state === null) return;
  const sessionIds = new Set<string>();
  for (const file of allFiles()) {
    if (file.sessionId !== undefined) sessionIds.add(file.sessionId);
  }
  if (state.primarySession !== undefined) sessionIds.add(state.primarySession.sessionId);
  const seen = new Set<string>();
  for (const sessionId of sessionIds) {
    const response = await request({ type: "review.state", sessionId });
    if (!response.ok || response.payload.type !== "review.state") continue;
    for (const comment of response.payload.comments) {
      if (seen.has(comment.commentId) || comment.filePath.startsWith("plan:")) continue;
      seen.add(comment.commentId);
      const list = commentsByFile.get(comment.filePath) ?? [];
      list.push(comment);
      commentsByFile.set(comment.filePath, list);
    }
  }
}

async function ensureDiff(key: string): Promise<void> {
  if (diffCache.has(key) || fetchInFlight.has(key)) return;
  const file = allFiles().find((candidate) => fileKey(candidate) === key);
  if (file === undefined || isCollapsed(file)) return;
  fetchInFlight.add(key);
  const response = await request({
    type: "codeReview.fileDiff",
    taskId,
    scope,
    repo: file.repo,
    path: file.path,
    ...(file.baselineId === undefined ? {} : { baselineId: file.baselineId }),
    ...(ignoreWhitespace ? { ignoreWhitespace: true } : {})
  });
  fetchInFlight.delete(key);
  if (!response.ok || response.payload.type !== "codeReview.fileDiff") return;
  diffCache.set(key, response.payload.diff);
  const card = main.querySelector<HTMLElement>(`.cr-card[data-key="${CSS.escape(key)}"]`);
  if (card !== null) renderCardBody(card, file);
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function renderHeader(): void {
  header.replaceChildren();
  const title = el("h1", "cr-title", "Code Review");
  const taskName = el("span", "cr-task-name", state === null ? "" : ` — ${state.title}`);
  title.append(taskName);

  const scopeSeg = el("div", "seg cr-scope-seg");
  const scopes: { id: CodeReviewScope; label: string; help: string }[] = [
    { id: "uncommitted", label: "All uncommitted", help: "Everything git would commit across this task's projects, including your own edits" },
    { id: "task", label: "Task", help: "Every linked session's changes (baseline diffs)" },
    { id: "session", label: "Session", help: "The primary session's changes only" }
  ];
  for (const entry of scopes) {
    const seg = button(entry.label, `segment${scope === entry.id ? " active" : ""}`, () => {
      if (scope === entry.id) return;
      scope = entry.id;
      collapseOverride.clear();
      dismissComposer();
      persist();
      void loadState({ preserveDiffs: false });
    });
    seg.title = entry.help;
    scopeSeg.append(seg);
  }

  const wsLabel = el("label", "cr-opt");
  const wsBox = document.createElement("input");
  wsBox.type = "checkbox";
  wsBox.checked = ignoreWhitespace;
  wsBox.addEventListener("change", () => {
    ignoreWhitespace = wsBox.checked;
    persist();
    diffCache.clear();
    dismissComposer();
    render();
  });
  wsLabel.append(wsBox, el("span", "", "Hide whitespace"));

  const viewSeg = el("div", "seg");
  const unifiedSeg = button("Unified", `segment${split ? "" : " active"}`, () => setSplit(false));
  const splitSeg = button("Split", `segment${split ? " active" : ""}`, () => setSplit(true));
  viewSeg.append(unifiedSeg, splitSeg);

  const spacer = el("span", "cr-spacer");
  const counts = el("span", "cr-count", state === null ? "" : `${String(state.openCommentCount)} open comment${state.openCommentCount === 1 ? "" : "s"}`);

  const sendLabel = state === null || state.openCommentCount === 0
    ? "No open comments"
    : `Send ${String(state.openCommentCount)} comment${state.openCommentCount === 1 ? "" : "s"} to agents`;
  const send = button(sendLabel, "cr-send", () => void submitAll(send));
  send.disabled = state === null || state.openCommentCount === 0;
  if (scope === "uncommitted" && state?.primarySession !== undefined) {
    send.title = `Uncommitted-scope comments route to: ${state.primarySession.sessionTitle}`;
  }

  const refresh = button("↻", "cr-icon-btn", () => void loadState({ preserveDiffs: false }));
  refresh.title = "Refresh";

  header.append(title, scopeSeg, wsLabel, viewSeg, spacer, counts, send, refresh);
  if (statusLine) header.append(el("div", "cr-status", statusLine));
  if (state?.revisionInFlight !== undefined && state.revisionInFlight > 0) {
    header.append(el("div", "cr-status cr-inflight", `${String(state.revisionInFlight)} agent revision${state.revisionInFlight === 1 ? "" : "s"} in flight…`));
  }
  for (const note of state?.notes ?? []) {
    header.append(el("div", "cr-status", note));
  }
}

function setSplit(next: boolean): void {
  if (split === next) return;
  split = next;
  persist();
  dismissComposer();
  render();
}

async function submitAll(trigger: HTMLButtonElement): Promise<void> {
  trigger.disabled = true;
  const response = await request({ type: "taskReview.submit", taskId });
  if (!response.ok || response.payload.type !== "taskReview.submit") {
    statusLine = response.ok ? "unexpected submit response" : response.error.message;
  } else {
    const { dispatched, sentSessions, errors } = response.payload;
    const names = (sentSessions ?? []).map((session) => session.sessionTitle).join(", ");
    statusLine = dispatched > 0
      ? `Sent ${String(dispatched)} comment${dispatched === 1 ? "" : "s"} to ${names || "agents"}.`
      : "Nothing to send.";
    if (errors !== undefined && errors.length > 0) statusLine += ` ${errors.join(" ")}`;
  }
  await loadState({ preserveDiffs: true });
}

// ---------------------------------------------------------------------------
// Sidebar (projects → compressed folder tree → files)
// ---------------------------------------------------------------------------

interface TreeFolder {
  name: string;
  folders: Map<string, TreeFolder>;
  files: CodeReviewFile[];
}

function buildTree(files: readonly CodeReviewFile[]): TreeFolder {
  const root: TreeFolder = { name: "", folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let child = node.folders.get(part);
      if (child === undefined) {
        child = { name: part, folders: new Map(), files: [] };
        node.folders.set(part, child);
      }
      node = child;
    }
    node.files.push(file);
  }
  return root;
}

/** Joins single-child folder chains ("src" → "exporters" becomes "src/exporters"). */
function compressTree(node: TreeFolder): TreeFolder {
  const folders = new Map<string, TreeFolder>();
  for (const child of node.folders.values()) {
    let merged = compressTree(child);
    while (merged.files.length === 0 && merged.folders.size === 1) {
      const inner = [...merged.folders.values()][0] as TreeFolder;
      merged = { name: `${merged.name}/${inner.name}`, folders: inner.folders, files: inner.files };
    }
    folders.set(merged.name, merged);
  }
  return { name: node.name, folders, files: node.files };
}

function renderSidebar(): void {
  sidebar.replaceChildren();
  if (state === null) return;
  let totalFiles = 0;
  let totalAdded = 0;
  let totalRemoved = 0;
  for (const project of state.projects) {
    const added = project.files.reduce((sum, file) => sum + (file.addedLines ?? 0), 0);
    const removed = project.files.reduce((sum, file) => sum + (file.removedLines ?? 0), 0);
    totalFiles += project.files.length;
    totalAdded += added;
    totalRemoved += removed;
    const head = el("div", "cr-proj");
    head.append(
      el("span", "cr-proj-name", project.name),
      statSpan(added, removed),
      el("span", "cr-proj-count", `· ${String(project.files.length)} file${project.files.length === 1 ? "" : "s"}`)
    );
    sidebar.append(head);
    renderTreeInto(sidebar, compressTree(buildTree(project.files)), 0);
  }
  if (state.projects.length === 0) {
    sidebar.append(el("div", "cr-empty", scope === "uncommitted"
      ? "No uncommitted changes in this task's projects."
      : "No changed files in this scope."));
  }
  const foot = el("div", "cr-side-foot");
  foot.append(
    el("span", "", `${String(totalFiles)} file${totalFiles === 1 ? "" : "s"} · `),
    statSpan(totalAdded, totalRemoved),
    el("span", "", ` · ${String(state.projects.length)} project${state.projects.length === 1 ? "" : "s"}`)
  );
  sidebar.append(foot);
}

function statSpan(added: number, removed: number): HTMLElement {
  const span = el("span", "cr-stats");
  span.append(el("span", "plus", `+${String(added)}`), el("span", "", " "), el("span", "minus", `−${String(removed)}`));
  return span;
}

function renderTreeInto(container: HTMLElement, node: TreeFolder, depth: number): void {
  for (const folder of node.folders.values()) {
    container.append(el("div", `cr-folder depth-${String(Math.min(depth, 4))}`, `${folder.name}/`));
    renderTreeInto(container, folder, depth + 1);
  }
  for (const file of node.files) {
    container.append(sidebarFileRow(file, depth));
  }
}

function sidebarFileRow(file: CodeReviewFile, depth: number): HTMLElement {
  const key = fileKey(file);
  const row = el("div", `cr-file-row depth-${String(Math.min(depth, 4))}`);
  row.dataset["key"] = key;
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  const kind = CHANGE_GLYPH[file.changeKind];
  row.append(el("span", `cr-glyph ${kind.cls}`, kind.glyph));
  const name = file.path.split("/").pop() ?? file.path;
  const label = el("span", "cr-file-name", name);
  label.title = `${file.repo}/${file.path}`;
  row.append(label);
  if (file.addedLines !== undefined || file.removedLines !== undefined) {
    row.append(statSpan(file.addedLines ?? 0, file.removedLines ?? 0));
  } else {
    row.append(el("span", "cr-file-kind-note", file.contentKind));
  }
  const openCount = commentsFor(file).filter((comment) => comment.status === "open").length;
  if (openCount > 0) row.append(el("span", "cr-badge", `💬 ${String(openCount)}`));
  if (file.conflicted === true) row.append(el("span", "cr-mark-warn", "⚠"));
  if (viewedKeys.has(key)) row.append(el("span", "cr-mark-viewed", "✓"));
  if (file.largeDiff === true) row.append(el("span", "cr-tag", "large"));
  const jump = (): void => {
    main.querySelector(`.cr-card[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  row.addEventListener("click", jump);
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); jump(); }
  });
  return row;
}

// ---------------------------------------------------------------------------
// Review scroll (file cards)
// ---------------------------------------------------------------------------

function render(): void {
  renderHeader();
  renderSidebar();
  renderCards();
}

function renderCards(): void {
  dismissComposer();
  main.replaceChildren();
  if (state === null) {
    main.append(el("div", "cr-empty", "Loading review…"));
    return;
  }
  for (const project of state.projects) {
    for (const file of project.files) {
      main.append(fileCard(file));
    }
  }
  if (allFiles().length === 0) {
    main.append(el("div", "cr-empty", "Nothing to review in this scope."));
  }
}

function fileCard(file: CodeReviewFile): HTMLElement {
  const key = fileKey(file);
  const card = el("section", `cr-card${isCollapsed(file) ? " collapsed" : ""}`);
  card.dataset["key"] = key;

  const head = el("div", "cr-card-head");
  const chev = el("span", "cr-chev", isCollapsed(file) ? "▸" : "▾");
  const path = el("span", "cr-path");
  const slash = file.path.lastIndexOf("/");
  if (slash >= 0) path.append(el("span", "dim", file.path.slice(0, slash + 1)));
  path.append(el("span", "", file.path.slice(slash + 1)));
  path.title = `${file.repo}/${file.path}`;
  if (file.oldPath !== undefined) path.append(el("span", "dim", `  (was ${file.oldPath})`));
  head.append(chev, el("span", "cr-repo-chip", file.repo), path, el("span", `cr-kind-chip ${CHANGE_GLYPH[file.changeKind].cls}`, file.changeKind));
  if (file.addedLines !== undefined || file.removedLines !== undefined) {
    head.append(statSpan(file.addedLines ?? 0, file.removedLines ?? 0));
  }
  if (file.sessionTitle !== undefined) {
    head.append(el("span", "cr-sess-chip", `⑂ ${file.sessionTitle}${file.clone === true ? " · clone" : ""}`));
  }
  const actions = el("div", "cr-head-actions");
  const viewedLabel = el("label", "cr-viewed");
  const viewedBox = document.createElement("input");
  viewedBox.type = "checkbox";
  viewedBox.checked = viewedKeys.has(key);
  viewedBox.addEventListener("click", (event) => event.stopPropagation());
  viewedBox.addEventListener("change", () => {
    if (viewedBox.checked) viewedKeys.add(key);
    else viewedKeys.delete(key);
    persist();
    renderSidebar();
  });
  viewedLabel.append(viewedBox, el("span", "", "Viewed"));
  const openEditor = button("Open in editor", "cr-link-btn", () => {
    if (file.baselineId === undefined) return;
    void request({ type: "diff.openFile", baselineId: file.baselineId, path: file.path });
  });
  if (file.baselineId === undefined) {
    openEditor.disabled = true;
    openEditor.title = scope === "uncommitted" ? "Uncommitted scope has no baseline diff editor yet" : "No baseline for this file";
  }
  actions.append(viewedLabel, openEditor);
  head.append(actions);
  head.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("button,input,label,select")) return;
    const collapsed = !isCollapsed(file);
    collapseOverride.set(key, collapsed);
    card.classList.toggle("collapsed", collapsed);
    chev.textContent = collapsed ? "▸" : "▾";
    if (!collapsed) void ensureDiff(key);
    renderCardBody(card, file);
  });
  card.append(head);

  if (file.conflicted === true) {
    card.append(el("div", "cr-conflict-note", "⚠ Unresolved sync conflict markers — resolve in the owning session's sync view before landing."));
  }

  const body = el("div", "cr-card-body");
  card.append(body);
  renderCardBody(card, file);
  cardObserver.observe(card);
  spyObserver.observe(card);
  return card;
}

function renderCardBody(card: HTMLElement, file: CodeReviewFile): void {
  const body = card.querySelector<HTMLElement>(".cr-card-body");
  if (body === null) return;
  body.replaceChildren();
  const key = fileKey(file);
  if (isCollapsed(file)) {
    const reason = file.largeDiff === true ? "Large diff" : "Collapsed";
    const note = el("div", "cr-collapsed-note",
      `${reason} (+${String(file.addedLines ?? 0)} −${String(file.removedLines ?? 0)}) — click to expand`);
    body.append(note);
    return;
  }
  const diff = diffCache.get(key);
  if (diff === undefined) {
    body.append(el("div", "cr-loading", "Loading diff…"));
    void ensureDiff(key);
    return;
  }
  if (diff.kind === "binary") {
    const delta = (diff.bytesAfter ?? 0) - (diff.bytesBefore ?? 0);
    const sign = delta >= 0 ? "+" : "−";
    body.append(el("div", "cr-bin-row",
      `Binary file · ${formatBytes(diff.bytesBefore)} → ${formatBytes(diff.bytesAfter)} (${sign}${formatBytes(Math.abs(delta))})`));
  } else if (diff.kind === "oversized") {
    body.append(el("div", "cr-bin-row", `Diff unavailable: ${diff.reason}`));
  } else if (diff.kind === "image") {
    const wrap = el("div", "cr-img-wrap");
    const cell = (label: string, uri: string | undefined, bytes: number | undefined, cls: string): HTMLElement => {
      const box = el("div", `cr-img-cell ${cls}`);
      if (uri !== undefined) {
        const frame = el("div", "cr-img-frame");
        const img = document.createElement("img");
        img.src = uri;
        img.alt = `${label} ${file.path}`;
        frame.append(img);
        box.append(frame);
      }
      box.append(el("div", "cr-img-meta", `${label} · ${formatBytes(bytes)}`));
      return box;
    };
    if (diff.beforeDataUri !== undefined || diff.bytesBefore !== undefined) {
      wrap.append(cell("before", diff.beforeDataUri, diff.bytesBefore, "before"));
    }
    if (diff.afterDataUri !== undefined || diff.bytesAfter !== undefined) {
      wrap.append(cell("after", diff.afterDataUri, diff.bytesAfter, "after"));
    }
    body.append(wrap);
  } else {
    renderTextDiff(body, file, diff.hunks, diff.truncated === true);
  }
  renderUnanchoredThreads(body, file);
}

// ---------------------------------------------------------------------------
// Text diff rendering (unified + split) with inline threads
// ---------------------------------------------------------------------------

function renderTextDiff(body: HTMLElement, file: CodeReviewFile, hunks: readonly ReviewDiffHunk[], truncated: boolean): void {
  const rowIndex = new Map<number, HTMLTableRowElement>();
  for (const hunk of hunks) {
    if (split) body.append(splitHunk(file, hunk, rowIndex));
    else body.append(unifiedHunk(file, hunk, rowIndex));
  }
  if (truncated) {
    body.append(el("div", "cr-collapsed-note", "Diff truncated — open in the editor for the rest."));
  }
  // Inline threads: after the anchored row when visible, else at the card foot.
  for (const comment of commentsFor(file)) {
    const anchorRow = rowIndex.get(comment.endLine);
    const threadEl = threadBlock(file, comment);
    if (anchorRow !== undefined && anchorRow.parentElement !== null) {
      const table = anchorRow.closest("table");
      const holder = el("tr", "cr-thread-row");
      const cell = document.createElement("td");
      cell.colSpan = split ? 2 : 3;
      cell.append(threadEl);
      holder.append(cell);
      if (table !== null && !split) anchorRow.after(holder);
      else body.append(threadEl);
    } else {
      body.append(threadEl);
    }
  }
}

function unifiedHunk(file: CodeReviewFile, hunk: ReviewDiffHunk, rowIndex: Map<number, HTMLTableRowElement>): HTMLElement {
  const table = document.createElement("table");
  table.className = "cr-diff";
  table.dataset["repo"] = file.repo;
  table.dataset["path"] = file.path;
  const tbody = document.createElement("tbody");
  const sep = document.createElement("tr");
  sep.className = "cr-hunk-sep";
  const sepCell = document.createElement("td");
  sepCell.colSpan = 3;
  sepCell.textContent = `@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@`;
  sep.append(sepCell);
  tbody.append(sep);
  for (const row of hunk.rows) {
    const tr = document.createElement("tr");
    tr.className = `cr-row cr-row-${row.kind}`;
    if (row.oldNo !== undefined) tr.dataset["old"] = String(row.oldNo);
    if (row.newNo !== undefined) tr.dataset["new"] = String(row.newNo);
    const oldNo = document.createElement("td");
    oldNo.className = "cr-lineno";
    oldNo.textContent = row.oldNo === undefined ? "" : String(row.oldNo);
    const newNo = document.createElement("td");
    newNo.className = "cr-lineno";
    newNo.textContent = row.newNo === undefined ? "" : String(row.newNo);
    const code = document.createElement("td");
    code.className = "cr-code";
    code.dataset["sign"] = row.kind === "add" ? "+" : row.kind === "del" ? "−" : " ";
    code.textContent = row.text;
    tr.append(oldNo, newNo, code);
    tbody.append(tr);
    if (row.newNo !== undefined) rowIndex.set(row.newNo, tr);
  }
  table.append(tbody);
  return table;
}

/** Split view: pair del-runs with add-runs inside each change block. */
function splitHunk(file: CodeReviewFile, hunk: ReviewDiffHunk, rowIndex: Map<number, HTMLTableRowElement>): HTMLElement {
  interface SplitPair { left?: ReviewDiffRow; right?: ReviewDiffRow }
  const pairs: SplitPair[] = [];
  let dels: ReviewDiffRow[] = [];
  let adds: ReviewDiffRow[] = [];
  const flush = (): void => {
    const count = Math.max(dels.length, adds.length);
    for (let i = 0; i < count; i += 1) {
      pairs.push({ ...(dels[i] === undefined ? {} : { left: dels[i] }), ...(adds[i] === undefined ? {} : { right: adds[i] }) });
    }
    dels = [];
    adds = [];
  };
  for (const row of hunk.rows) {
    if (row.kind === "del") dels.push(row);
    else if (row.kind === "add") adds.push(row);
    else {
      flush();
      pairs.push({ left: row, right: row });
    }
  }
  flush();

  const grid = el("div", "cr-split-grid");
  const buildSide = (side: "left" | "right"): HTMLElement => {
    const table = document.createElement("table");
    table.className = "cr-diff cr-diff-split";
    table.dataset["repo"] = file.repo;
    table.dataset["path"] = file.path;
    const tbody = document.createElement("tbody");
    const sep = document.createElement("tr");
    sep.className = "cr-hunk-sep";
    const sepCell = document.createElement("td");
    sepCell.colSpan = 2;
    sepCell.textContent = side === "left"
      ? `@@ -${String(hunk.oldStart)},${String(hunk.oldLines)}`
      : `@@ +${String(hunk.newStart)},${String(hunk.newLines)}`;
    sep.append(sepCell);
    tbody.append(sep);
    for (const pair of pairs) {
      const row = side === "left" ? pair.left : pair.right;
      const tr = document.createElement("tr");
      const lineno = document.createElement("td");
      lineno.className = "cr-lineno";
      const code = document.createElement("td");
      code.className = "cr-code";
      if (row === undefined) {
        tr.className = "cr-row cr-row-empty";
        code.dataset["sign"] = " ";
      } else {
        const kind = row.kind === "context" ? "context" : side === "left" ? "del" : "add";
        tr.className = `cr-row cr-row-${kind}`;
        const no = side === "left" ? row.oldNo : row.newNo;
        lineno.textContent = no === undefined ? "" : String(no);
        if (row.oldNo !== undefined) tr.dataset["old"] = String(row.oldNo);
        if (row.newNo !== undefined) tr.dataset["new"] = String(row.newNo);
        code.dataset["sign"] = kind === "add" ? "+" : kind === "del" ? "−" : " ";
        code.textContent = row.text;
        if (side === "right" && row.newNo !== undefined) rowIndex.set(row.newNo, tr);
      }
      tr.append(lineno, code);
      tbody.append(tr);
    }
    table.append(tbody);
    return table;
  };
  const left = el("div", "cr-split-side");
  left.append(buildSide("left"));
  const right = el("div", "cr-split-side");
  right.append(buildSide("right"));
  grid.append(left, right);
  return grid;
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

function threadBlock(file: CodeReviewFile, comment: ReviewCommentSummary): HTMLElement {
  const block = el("div", `cr-thread${comment.status === "delegated" ? " delegated" : ""}`);
  const head = el("div", "cr-thread-head");
  const isUser = comment.author === "user";
  head.append(el("span", "cr-author", isUser ? "you" : comment.author === "guard" ? "guard" : "reviewer"));
  if (!isUser) head.append(el("span", "cr-author-badge", comment.author === "guard" ? "guard" : "agent"));
  const range = comment.startLine === comment.endLine ? String(comment.startLine) : `${String(comment.startLine)}-${String(comment.endLine)}`;
  head.append(el("span", "cr-thread-anchor", `${file.path}:${range}`));
  const statusSel = document.createElement("select");
  statusSel.className = "cr-status-sel";
  for (const status of REVIEW_STATUSES) {
    const option = document.createElement("option");
    option.value = status;
    option.textContent = status;
    if (status === comment.status) option.selected = true;
    statusSel.append(option);
  }
  statusSel.addEventListener("change", () => {
    void request({ type: "review.setCommentStatus", commentId: comment.commentId, status: statusSel.value as ReviewThreadStatus })
      .then(() => loadState({ preserveDiffs: true }));
  });
  head.append(statusSel);
  block.append(head, el("div", "cr-thread-body", comment.body));
  return block;
}

/** Threads whose anchor row is not in the rendered hunks (context gaps) — card foot. */
function renderUnanchoredThreads(body: HTMLElement, file: CodeReviewFile): void {
  // threadBlock placement handles visible anchors; nothing extra needed here
  // beyond non-text files, whose comments would otherwise be invisible.
  const diff = diffCache.get(fileKey(file));
  if (diff !== undefined && diff.kind === "text") return;
  for (const comment of commentsFor(file)) {
    body.append(threadBlock(file, comment));
  }
}

// ---------------------------------------------------------------------------
// Selection-driven commenting
// ---------------------------------------------------------------------------

const composer = el("div", "cr-composer hidden");
const chipsRow = el("div", "cr-anchor-chips");
const composerText = document.createElement("textarea");
composerText.className = "cr-composer-text";
composerText.placeholder = "Leave instructions for the agent — file and lines ride along automatically";
composerText.addEventListener("input", () => { composerDraft = composerText.value; });
const composerActions = el("div", "cr-composer-actions");
const commentButton = button("Comment", "cr-btn primary", () => void submitNote());
const dismissButton = button("Dismiss", "cr-btn", () => dismissComposer());
const composerHint = el("span", "cr-composer-hint", "select more code to add ranges");
composerActions.append(commentButton, dismissButton, composerHint);
composer.append(chipsRow, composerText, composerActions);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !composer.classList.contains("hidden")) dismissComposer();
});

/** Clears the pending note: highlights, chips, draft, and the box itself. */
function dismissComposer(): void {
  for (const range of pendingRanges) {
    for (const row of range.rows) row.classList.remove("cr-row-pending");
  }
  pendingRanges = [];
  composerDraft = "";
  composerText.value = "";
  composer.classList.add("hidden");
  composer.remove();
}

function renderChips(): void {
  chipsRow.replaceChildren();
  for (const range of pendingRanges) {
    const { anchor } = range;
    const lines = anchor.startLine === anchor.endLine ? String(anchor.startLine) : `${String(anchor.startLine)}-${String(anchor.endLine)}`;
    const chip = el("span", "cr-anchor-chip", `${anchor.repo}:${anchor.path}:${lines}`);
    const remove = button("✕", "cr-chip-remove", () => {
      for (const row of range.rows) row.classList.remove("cr-row-pending");
      pendingRanges = pendingRanges.filter((candidate) => candidate !== range);
      if (pendingRanges.length === 0) {
        dismissComposer();
      } else {
        renderChips();
        placeComposer(pendingRanges[pendingRanges.length - 1] as PendingRange);
      }
    });
    chip.append(remove);
    chipsRow.append(chip);
  }
}

/** Shows the box directly under the LAST row of the given range. */
function placeComposer(range: PendingRange): void {
  const lastRow = range.rows[range.rows.length - 1];
  if (lastRow === undefined) return;
  composer.classList.remove("hidden");
  const table = lastRow.closest("table");
  const card = lastRow.closest(".cr-card");
  if (table !== null && card !== null) {
    // Insert after the table containing the last selected row (keeps the box
    // out of the <table> DOM so it spans the card width in both view modes).
    const grid = table.closest(".cr-split-grid");
    (grid ?? table).after(composer);
  } else {
    main.append(composer);
  }
  composerText.value = composerDraft;
  composerText.focus();
}

/**
 * mouseup: turn the current text selection into a pending range. Rows are
 * identified by their `data-new`/`data-old` line attributes inside one card's
 * diff; the box appears (or moves) after the last selected row.
 */
document.addEventListener("mouseup", (event) => {
  if (event.target instanceof Element && event.target.closest(".cr-composer") !== null) return;
  window.setTimeout(() => captureSelection(), 0);
});

function captureSelection(): void {
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  const startRow = closestDiffRow(range.startContainer);
  const endRow = closestDiffRow(range.endContainer);
  if (startRow === null || endRow === null) return;
  const startTable = startRow.closest("table");
  const endTable = endRow.closest("table");
  if (startTable === null || startTable !== endTable) {
    // Cross-hunk/cross-file selections: use the card of the selection END so
    // the captured range matches where the reviewer finished dragging.
    return;
  }
  const repo = startTable.dataset["repo"];
  const path = startTable.dataset["path"];
  if (repo === undefined || path === undefined) return;

  // Collect the contiguous rows between start and end (inclusive).
  const rows: HTMLTableRowElement[] = [];
  let cursor: Element | null = startRow;
  while (cursor !== null) {
    if (cursor instanceof HTMLTableRowElement && cursor.classList.contains("cr-row")) {
      rows.push(cursor);
    }
    if (cursor === endRow) break;
    cursor = cursor.nextElementSibling;
  }
  if (rows.length === 0 || cursor !== endRow) return;

  const lineNumbers = rows
    .map((row) => row.dataset["new"] !== undefined ? Number(row.dataset["new"]) : undefined)
    .filter((line): line is number => line !== undefined);
  // Pure-deletion selections anchor to old-side numbers.
  const oldNumbers = rows
    .map((row) => row.dataset["old"] !== undefined ? Number(row.dataset["old"]) : undefined)
    .filter((line): line is number => line !== undefined);
  const usable = lineNumbers.length > 0 ? lineNumbers : oldNumbers;
  if (usable.length === 0) return;

  const file = allFiles().find((candidate) => candidate.repo === repo && candidate.path === path);
  const anchor: CodeReviewAnchor = {
    repo,
    path,
    startLine: Math.min(...usable),
    endLine: Math.max(...usable),
    ...(file?.sessionId === undefined ? {} : { sessionId: file.sessionId })
  };
  // Duplicate range guard (same file, same lines): ignore instead of stacking.
  if (pendingRanges.some((candidate) =>
    candidate.anchor.repo === anchor.repo && candidate.anchor.path === anchor.path
    && candidate.anchor.startLine === anchor.startLine && candidate.anchor.endLine === anchor.endLine)) {
    selection.removeAllRanges();
    return;
  }
  for (const row of rows) row.classList.add("cr-row-pending");
  const pendingRange: PendingRange = { anchor, rows };
  pendingRanges.push(pendingRange);
  selection.removeAllRanges();
  renderChips();
  placeComposer(pendingRange);
}

function closestDiffRow(node: Node): HTMLTableRowElement | null {
  const element = node instanceof Element ? node : node.parentElement;
  const row = element?.closest("tr.cr-row");
  return row instanceof HTMLTableRowElement ? row : null;
}

async function submitNote(): Promise<void> {
  const body = composerText.value.trim();
  if (body.length === 0 || pendingRanges.length === 0) return;
  commentButton.disabled = true;
  const response = await request({
    type: "codeReview.addNote",
    taskId,
    scope,
    body,
    anchors: pendingRanges.map((range) => range.anchor)
  });
  commentButton.disabled = false;
  if (!response.ok || response.payload.type !== "codeReview.addNote") {
    statusLine = response.ok ? "unexpected addNote response" : response.error.message;
    renderHeader();
    return;
  }
  dismissComposer();
  await loadState({ preserveDiffs: true });
}

// ---------------------------------------------------------------------------
// Keyboard: j/k file navigation
// ---------------------------------------------------------------------------

document.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
  if (event.key !== "j" && event.key !== "k") return;
  const cards = [...main.querySelectorAll<HTMLElement>(".cr-card")];
  if (cards.length === 0) return;
  const currentKey = sidebar.querySelector<HTMLElement>(".cr-file-row.current")?.dataset["key"];
  const index = cards.findIndex((card) => card.dataset["key"] === currentKey);
  const next = event.key === "j" ? Math.min(cards.length - 1, index + 1) : Math.max(0, index - 1);
  cards[next]?.scrollIntoView({ block: "start", behavior: "smooth" });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

render();
void loadState({ preserveDiffs: false });
