/**
 * Cross-project Task Review editor panel webview.
 *
 * The reviewer's single surface over every changed file a task's linked
 * sessions produced, across all their projects: a left navigator (projects →
 * changed files, with change glyphs, +N/−M stats, comment badges, clone/conflict
 * markers, and a panel-local reviewed indicator) and a comment dock (right on
 * wide viewports, below when narrow) grouping every open thread by file. Review
 * happens in the native diff editor — a baseline-backed row sends
 * diff.openFile and VS Code opens the diff Beside. Open comments are sent back
 * to the owning sessions as revision turns via taskReview.submit; the panel
 * refetches when a linked session's turn boundary fires taskReview.updated.
 *
 * SECURITY: every dynamic string (task/session titles, repo/file paths, comment
 * bodies, submit outcomes, error lines) renders via textContent — NEVER
 * innerHTML, NEVER insertAdjacentHTML, no DOM-from-string of any kind. Re-renders
 * use replaceChildren, so listeners on discarded nodes are dropped with them.
 * This entry is self-contained (it does not import the control-panel bundle);
 * the small DOM helpers live in-module.
 *
 * PANEL-LOCAL STATE: the set of files whose diff was opened this panel session
 * is tracked here and persisted via vscodeApi.setState (mirroring how planDocs
 * persists selectedDocName) so a webview reload keeps the reviewed marks. It is
 * deliberately NOT a contract field — "reviewed" is a per-reviewer, per-panel
 * notion, not shared state.
 */

import {
  WEBVIEW_PROTOCOL_VERSION,
  type DiffChangeKind,
  type HostToWebviewMessage,
  type PanelPushPayload,
  type PanelRequestPayload,
  type PanelResponse,
  type ReviewCommentSummary,
  type ReviewThreadStatus,
  type TaskReviewFile,
  type TaskReviewSessionRef,
  type TaskReviewState
} from "@drydock/contracts";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): PersistedState | undefined;
  setState(state: PersistedState): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** Only the opened-file keys persist; the aggregated state is re-fetched on boot. */
interface PersistedState {
  readonly openedKeys: readonly string[];
}

const vscodeApi = acquireVsCodeApi();
const app = document.getElementById("app");
if (!app) throw new Error("missing #app root");
const taskId = app.dataset["taskId"] ?? "";

const REQUEST_TIMEOUT_MS = 60_000;
const PUSH_DEBOUNCE_MS = 300;
const REVIEW_STATUSES: readonly ReviewThreadStatus[] = ["open", "acknowledged", "delegated", "resolved", "wont-fix", "blocked"];

/** Change-kind → single-glyph badge + color class (mirrors the working set). */
const CHANGE_GLYPH: Record<DiffChangeKind, { glyph: string; cls: string }> = {
  add: { glyph: "+", cls: "kind-add" },
  modify: { glyph: "±", cls: "kind-modify" },
  delete: { glyph: "−", cls: "kind-delete" },
  rename: { glyph: "→", cls: "kind-rename" }
};

const pending = new Map<string, { resolve: (value: PanelResponse) => void; timer: number }>();
let requestCounter = 0;

let reviewState: TaskReviewState | null = null;
/** Per-session comment list, filtered to non-`plan:` anchors (keyed by sessionId). */
const commentsBySession = new Map<string, readonly ReviewCommentSummary[]>();
/** Files whose diff was opened this panel session (`repo:path@sessionId`); persisted. */
let openedKeys = new Set<string>();
/** Which inline add-comment form is open, keyed by file key; at most one at a time. */
let openFormKey: string | null = null;

/**
 * Per-file snapshot captured during each render, keyed by fileKey, so the NEXT
 * refetch can diff against it. Purely client-side — content never rides the
 * push; the flash is computed from the refetched state the panel already fetches.
 */
interface FileSnapshot {
  readonly changeKind: DiffChangeKind;
  readonly addedLines: number;
  readonly removedLines: number;
  readonly commentCount: number;
  readonly conflicted: boolean;
}
const prevSnapshot = new Map<string, FileSnapshot>();
/** Scalar side of the snapshot: counts that are not per-file but still signal a delta. */
let prevScalars: { openCommentCount: number; revisionInFlight: number } | null = null;
/** File keys whose entry changed (or is new) since the last render; drives the row flash. */
let flashKeys = new Set<string>();
/** Timer that clears the `updated · just now` stamp; reset on each new announcement. */
let updatedStampTimer = 0;
const UPDATED_STAMP_MS = 5_000;

// ---------------------------------------------------------------------------
// Messaging (correlation pattern copied from planDocs.ts: 60s timeout, pending map)
// ---------------------------------------------------------------------------

function request(payload: PanelRequestPayload): Promise<PanelResponse> {
  requestCounter += 1;
  const requestId = `taskreview-req-${String(requestCounter)}-${String(Date.now())}`;
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
  if (payload.type === "taskReview.updated" && payload.taskId === taskId) {
    // Turn boundaries can arrive in bursts (start then complete); collapse a
    // burst into one refetch so the panel does not thrash.
    if (pushDebounceTimer) window.clearTimeout(pushDebounceTimer);
    pushDebounceTimer = window.setTimeout(() => {
      pushDebounceTimer = 0;
      void refresh();
    }, PUSH_DEBOUNCE_MS);
  }
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

const headerBar = el("div", "tr-header");
const headerTitle = el("h2", "tr-title");
const refreshButton = iconButton("↻", "Refresh — refetch changed files and comments", "tr-refresh");
// Dim decaying stamp next to ↻ announcing a meaningful refetch; transparent
// + out of the a11y tree at rest, revealed via the tr-stamp-visible modifier.
const updatedStamp = el("span", "tr-updated-stamp");
updatedStamp.textContent = "updated · just now";
const revisionChip = el("span", "tr-revision-chip hidden");
const headerSpacer = el("span", "tr-header-spacer");
const submitButton = button("Submit review → agents", "primary small tr-submit");
const resultLine = el("div", "tr-result hidden");
headerBar.append(headerTitle, refreshButton, updatedStamp, revisionChip, headerSpacer, submitButton, resultLine);

const body = el("div", "tr-body");
const nav = el("nav", "tr-nav");
const dock = el("aside", "tr-dock");
body.append(nav, dock);

const emptyState = el("div", "tr-empty");
emptyState.textContent = "Loading task review…";

app.append(headerBar, emptyState, body);

refreshButton.addEventListener("click", () => void refresh());
submitButton.addEventListener("click", () => void onSubmit());

// ---------------------------------------------------------------------------
// Selectors / helpers
// ---------------------------------------------------------------------------

/** Panel-local reviewed-tracking key: repo + path + owning session. */
function fileKey(file: Pick<TaskReviewFile, "repo" | "path" | "sessionId">): string {
  return `${file.repo}:${file.path}@${file.sessionId}`;
}

/** The `<repo>:<path>` comment anchor for a file (matches the owning session's scope). */
function fileAnchor(file: Pick<TaskReviewFile, "repo" | "path">): string {
  return `${file.repo}:${file.path}`;
}

/** Every non-`plan:` comment across every linked session (what the dock groups). */
function allComments(): ReviewCommentSummary[] {
  const out: ReviewCommentSummary[] = [];
  for (const list of commentsBySession.values()) out.push(...list);
  return out;
}

/** Session title lookup for the dock's dim author line. */
function sessionTitle(sessionId: string): string {
  return reviewState?.sessions.find((s) => s.sessionId === sessionId)?.sessionTitle ?? sessionId;
}

/**
 * Single rendering point for a session reference's human label — used by BOTH the
 * dock's author/meta line and the submit result line. Keeping every
 * session-name render funnelled here is the forward-compat seam the owner asked
 * for: when a future optional `role` lands on TaskReviewSessionRef (multi-agent
 * roles next phase), it becomes a dim suffix (e.g. `Rename sweep (reviewer)`)
 * appended in this one place, and every surface picks it up at once.
 */
function sessionLabel(ref: TaskReviewSessionRef): string {
  return ref.sessionTitle;
}

/**
 * Locates a baseline-backed file whose `<repo>:<path>` anchor matches a comment's
 * filePath, so a dock thread can jump to the same diff a row click opens. Legacy
 * plain-path comments also resolve (path without the `repo:` prefix).
 */
function fileForAnchor(anchor: string): TaskReviewFile | undefined {
  if (reviewState === null) return undefined;
  for (const project of reviewState.projects) {
    for (const file of project.files) {
      if (file.baselineId === undefined) continue;
      if (anchor === fileAnchor(file) || anchor === file.path) return file;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Rendering (textContent only for dynamic data)
// ---------------------------------------------------------------------------

function render(): void {
  const state = reviewState;
  const hasState = state !== null;
  emptyState.classList.toggle("hidden", hasState);
  body.classList.toggle("hidden", !hasState);
  headerBar.classList.toggle("hidden", !hasState);
  if (state === null) {
    persist();
    return;
  }

  headerTitle.textContent = state.title;

  const open = state.openCommentCount;
  submitButton.disabled = open === 0;
  submitButton.textContent = open === 0
    ? "No open comments"
    : `Submit review → agents (${String(open)})`;

  if (state.revisionInFlight !== undefined && state.revisionInFlight > 0) {
    revisionChip.textContent = `${String(state.revisionInFlight)} agent(s) revising…`;
    revisionChip.classList.remove("hidden");
  } else {
    revisionChip.classList.add("hidden");
  }

  renderNav(state);
  renderDock();
  persist();
  // Rebuild the snapshot from the state just rendered so the NEXT refetch has a
  // baseline to diff against. Consume the one-shot flash set after the DOM
  // has taken it, so a plain re-render doesn't re-flash.
  captureSnapshot(state);
  flashKeys = new Set();
}

/** Records the per-file + scalar snapshot of a rendered state for the next diff. */
function captureSnapshot(state: TaskReviewState): void {
  prevSnapshot.clear();
  for (const project of state.projects) {
    for (const file of project.files) {
      prevSnapshot.set(fileKey(file), {
        changeKind: file.changeKind,
        addedLines: file.addedLines ?? 0,
        removedLines: file.removedLines ?? 0,
        commentCount: file.commentCount,
        conflicted: file.conflicted === true
      });
    }
  }
  prevScalars = {
    openCommentCount: state.openCommentCount,
    revisionInFlight: state.revisionInFlight ?? 0
  };
}

/**
 * Diffs a freshly-fetched state against the prior render snapshot. Returns
 * the set of file keys whose entry changed or is new. `changed` is true when any
 * row differs, a file key appeared/vanished, or a tracked scalar moved. The very
 * first refetch (no prior snapshot) reports no change so it never announces.
 */
function diffAgainstSnapshot(state: TaskReviewState): { changed: boolean; keys: Set<string> } {
  const keys = new Set<string>();
  if (prevScalars === null) return { changed: false, keys };

  const nextKeys = new Set<string>();
  for (const project of state.projects) {
    for (const file of project.files) {
      const key = fileKey(file);
      nextKeys.add(key);
      const prev = prevSnapshot.get(key);
      if (
        prev === undefined ||
        prev.changeKind !== file.changeKind ||
        prev.addedLines !== (file.addedLines ?? 0) ||
        prev.removedLines !== (file.removedLines ?? 0) ||
        prev.commentCount !== file.commentCount ||
        prev.conflicted !== (file.conflicted === true)
      ) {
        keys.add(key);
      }
    }
  }
  // A vanished file is a delta even though it has no row to flash.
  let keySetChanged = false;
  for (const known of prevSnapshot.keys()) {
    if (!nextKeys.has(known)) keySetChanged = true;
  }
  const scalarsChanged =
    prevScalars.openCommentCount !== state.openCommentCount ||
    prevScalars.revisionInFlight !== (state.revisionInFlight ?? 0);

  const changed = keys.size > 0 || keySetChanged || scalarsChanged;
  return { changed, keys };
}

/** Shows the dim `updated · just now` stamp and (re)arms its decay timer. */
function announceUpdate(): void {
  updatedStamp.classList.add("tr-stamp-visible");
  if (updatedStampTimer) window.clearTimeout(updatedStampTimer);
  updatedStampTimer = window.setTimeout(() => {
    updatedStampTimer = 0;
    updatedStamp.classList.remove("tr-stamp-visible");
  }, UPDATED_STAMP_MS);
}

function renderNav(state: TaskReviewState): void {
  nav.replaceChildren();

  // Collapsed one-line marker legend: decodes the row vocabulary without a
  // tooltip hunt. textContent-only, zero runtime cost.
  const legend = document.createElement("details");
  legend.className = "tr-legend";
  const legendSummary = document.createElement("summary");
  legendSummary.textContent = "Legend";
  const legendLine = el("div", "tr-legend-line");
  legendLine.textContent = "± modify · + add · − delete · → rename · • unreviewed · ◑ opened · ✓ reviewed · ⚠ conflict";
  legend.append(legendSummary, legendLine);
  nav.append(legend);

  if (state.projects.length === 0) {
    const empty = el("div", "tr-nav-empty");
    empty.textContent = "No changed files across this task's linked sessions yet.";
    nav.append(empty);
  }
  for (const project of state.projects) {
    const group = el("section", "tr-project");
    const head = el("div", "tr-project-head");
    const name = el("span", "tr-project-name");
    name.textContent = project.name;
    const count = el("span", "tr-project-count");
    count.textContent = `${String(project.files.length)} file${project.files.length === 1 ? "" : "s"}`;
    head.append(name, count);
    group.append(head);
    for (const file of project.files) group.append(fileRow(file));
    nav.append(group);
  }

  // Degraded-fetch honesty lines (e.g. a clone session not live in this window).
  for (const note of state.notes ?? []) {
    const noteEl = el("div", "tr-note");
    noteEl.textContent = note;
    nav.append(noteEl);
  }
}

function fileRow(file: TaskReviewFile): HTMLElement {
  const key = fileKey(file);
  const isClone = file.clone === true;
  const conflicted = file.conflicted === true;
  const flashed = flashKeys.has(key);
  const row = el("div", `tr-file-row${conflicted ? " conflicted" : ""}${isClone ? " clone" : ""}${flashed ? " tr-row-flash" : ""}`);
  // One-shot flash: drop the class on animationend so a later refetch can re-trigger it.
  if (flashed) {
    row.addEventListener("animationend", () => row.classList.remove("tr-row-flash"), { once: true });
  }

  const meta = CHANGE_GLYPH[file.changeKind];
  const glyph = el("span", `change-glyph ${meta.cls}`);
  glyph.textContent = meta.glyph;
  glyph.title = file.changeKind;
  row.append(glyph);

  // Conflicted clone rows carry a ⚠ marker (unresolved sync markers).
  if (conflicted) {
    const warn = el("span", "conflict-marker");
    warn.textContent = "⚠";
    warn.title = "Conflict markers present — resolve in the owning chat's working set";
    warn.setAttribute("aria-label", "conflicted");
    row.append(warn);
  }

  const opened = openedKeys.has(key);
  // Unreviewed dot: baseline-backed file never opened this panel session. Clone
  // rows are informational, so they carry no reviewed lifecycle.
  if (!isClone && !opened) {
    const unreviewed = el("span", "unreviewed-dot");
    unreviewed.textContent = "•";
    unreviewed.title = "Unreviewed — diff not opened this session";
    unreviewed.setAttribute("aria-label", "unreviewed");
    row.append(unreviewed);
  }

  const name = el("span", "tr-file-path");
  const parts = file.path.split(/[\\/]/);
  const base = parts.pop() ?? file.path;
  const dir = parts.join("/");
  const baseEl = el("span", "file-base");
  baseEl.textContent = base;
  name.append(baseEl);
  if (dir.length > 0) {
    const dirEl = el("span", "file-dir");
    dirEl.textContent = ` ${dir}`;
    name.append(dirEl);
  }
  // Title attribute surfaces the owning session title (per spec).
  name.title = file.sessionTitle;
  if (!isClone && file.baselineId !== undefined) {
    name.classList.add("tr-file-open");
    name.addEventListener("click", () => openFileDiff(file));
  }
  row.append(name);

  const stats = el("span", "tr-file-stats");
  if (file.addedLines !== undefined && file.addedLines > 0) {
    const added = el("span", "stat-added");
    added.textContent = `+${String(file.addedLines)}`;
    stats.append(added);
  }
  if (file.removedLines !== undefined && file.removedLines > 0) {
    const removed = el("span", "stat-removed");
    removed.textContent = `−${String(file.removedLines)}`;
    stats.append(removed);
  }
  row.append(stats);

  const markers = el("span", "tr-file-markers");
  if (file.commentCount > 0) {
    const badge = el("span", "tr-comment-badge");
    badge.textContent = `💬${String(file.commentCount)}`;
    badge.title = `${String(file.commentCount)} open comment${file.commentCount === 1 ? "" : "s"} on this file`;
    markers.append(badge);
  }
  if (isClone) {
    const chipEl = el("span", "tr-clone-chip");
    chipEl.textContent = "clone";
    markers.append(chipEl);
  }
  // Reviewed ✓: opened AND comment-free (baseline-backed only).
  if (!isClone && opened && file.commentCount === 0) {
    const reviewed = el("span", "tr-reviewed");
    reviewed.textContent = "✓";
    reviewed.title = "Reviewed — diff opened, no open comments";
    reviewed.setAttribute("aria-label", "reviewed");
    markers.append(reviewed);
  }
  // Opened ◑: opened but still carries ≥1 open comment — the third reviewed
  // state, now with its own affirmative glyph instead of rendering as nothing.
  if (!isClone && opened && file.commentCount > 0) {
    const openedMark = el("span", "tr-opened");
    openedMark.textContent = "◑";
    openedMark.title = "Opened — has open comments";
    openedMark.setAttribute("aria-label", "opened");
    markers.append(openedMark);
  }
  row.append(markers);

  // Per-file 💬+ affordance toggles an inline add-comment form. The 💬 prefix
  // de-overloads the bare `+` (which is also the green add-change glyph).
  // Clone rows can still be commented on (anchor lands in the owning session's scope).
  const addButton = iconButton("💬+", "Add a comment on this file", "tr-file-add");
  addButton.addEventListener("click", () => {
    openFormKey = openFormKey === key ? null : key;
    render();
  });
  row.append(addButton);

  // Clone rows are informational: no pointer affordance, a tooltip naming where
  // to actually pull/discard. The whole row carries the hint.
  if (isClone) {
    row.title = `Pull/discard in the owning chat's working set (clone session: ${file.sessionTitle})`;
  }

  const wrap = el("div", "tr-file-wrap");
  wrap.append(row);
  if (openFormKey === key) {
    wrap.append(buildCommentForm(file));
  }
  return wrap;
}

function openFileDiff(file: TaskReviewFile): void {
  if (file.baselineId === undefined) return;
  const key = fileKey(file);
  openedKeys.add(key);
  persist();
  void request({ type: "diff.openFile", baselineId: file.baselineId, path: file.path }).then((response) => {
    if (!response.ok) showResult(`open diff failed: ${response.error.message}`, true);
  });
  render();
}

function buildCommentForm(file: TaskReviewFile): HTMLElement {
  const form = el("div", "tr-comment-form");
  const lineInput = document.createElement("input");
  lineInput.type = "number";
  lineInput.className = "tr-comment-line";
  lineInput.min = "1";
  lineInput.value = "1";
  lineInput.title = "Line number";
  lineInput.setAttribute("aria-label", "Line number");

  const textarea = document.createElement("textarea");
  textarea.className = "tr-comment-input";
  textarea.rows = 2;
  textarea.placeholder = "Note or correction for this file…";

  const actions = el("div", "tr-comment-form-actions");
  const add = button("Add", "primary small");
  const cancel = button("Cancel", "ghost small");
  const error = el("span", "tr-comment-error hidden");
  actions.append(add, cancel, error);
  form.append(lineInput, textarea, actions);

  const closeForm = (): void => {
    openFormKey = null;
    render();
  };
  cancel.addEventListener("click", closeForm);
  add.addEventListener("click", () => {
    const line = Number(lineInput.value);
    const bodyText = textarea.value.trim();
    if (!Number.isInteger(line) || line < 1) {
      showFormError(error, "Line must be a whole number ≥ 1.");
      return;
    }
    if (bodyText.length === 0) {
      showFormError(error, "Comment cannot be empty.");
      return;
    }
    add.disabled = true;
    void request({
      type: "review.addComment",
      sessionId: file.sessionId,
      filePath: fileAnchor(file),
      startLine: line,
      endLine: line,
      body: bodyText
    }).then((response) => {
      add.disabled = false;
      if (!response.ok || response.payload.type !== "review.addComment") {
        showFormError(error, response.ok ? "Unexpected response." : response.error.message);
        return;
      }
      openFormKey = null;
      // The commentCount on the file (and openCommentCount) changed: refetch the
      // owning session's comments and the aggregated state.
      void Promise.all([loadSessionComments(file.sessionId), loadState()]).then(() => render());
    });
  });
  return form;
}

function showFormError(node: HTMLElement, message: string): void {
  node.textContent = message;
  node.classList.remove("hidden");
}

function renderDock(): void {
  dock.replaceChildren();
  const heading = el("h3", "tr-dock-heading");
  heading.textContent = "Comments";
  dock.append(heading);

  const comments = allComments();
  if (comments.length === 0) {
    const empty = el("div", "tr-dock-empty");
    empty.textContent = "No comments yet. Use 💬+ on a file to add one.";
    dock.append(empty);
    return;
  }

  // Group threads by filePath (anchor) across sessions.
  const byFile = new Map<string, ReviewCommentSummary[]>();
  for (const comment of comments) {
    const list = byFile.get(comment.filePath);
    if (list) list.push(comment);
    else byFile.set(comment.filePath, [comment]);
  }
  const anchors = [...byFile.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const anchor of anchors) {
    const group = el("section", "tr-dock-group");
    const groupHead = el("div", "tr-dock-group-head");
    groupHead.textContent = anchor;
    const target = fileForAnchor(anchor);
    if (target !== undefined) {
      groupHead.classList.add("tr-dock-jump");
      groupHead.title = "Open this file's diff";
      groupHead.addEventListener("click", () => openFileDiff(target));
    }
    group.append(groupHead);
    const list = byFile.get(anchor) ?? [];
    list.sort((a, b) => (a.startLine - b.startLine) || (a.createdAt < b.createdAt ? -1 : 1));
    for (const comment of list) group.append(dockEntry(comment));
    dock.append(group);
  }
}

function dockEntry(comment: ReviewCommentSummary): HTMLElement {
  const entry = el("div", "tr-dock-entry");
  entry.dataset["commentId"] = comment.commentId;
  // Delegated comments are in-flight with the agent: dim + italic.
  if (comment.status === "delegated") entry.classList.add("delegated");

  const anchor = el("div", "tr-dock-anchor");
  const range = comment.endLine > comment.startLine
    ? `${String(comment.startLine)}-${String(comment.endLine)}`
    : String(comment.startLine);
  anchor.textContent = `${comment.filePath}:${range}`;

  const bodyEl = el("div", "tr-dock-body");
  bodyEl.textContent = comment.body;

  const authorEl = el("div", "tr-dock-meta");
  // Session name renders through the same sessionLabel() seam as the submit line.
  const ownerId = sessionForComment(comment.commentId);
  const ownerRef = reviewState?.sessions.find((s) => s.sessionId === ownerId);
  const ownerName = ownerRef ? sessionLabel(ownerRef) : sessionTitle(ownerId);
  authorEl.textContent = `${comment.author} · ${ownerName}`;

  const statusSelect = document.createElement("select");
  statusSelect.className = "tr-dock-status";
  for (const status of REVIEW_STATUSES) {
    const opt = document.createElement("option");
    opt.value = status;
    opt.textContent = status;
    statusSelect.append(opt);
  }
  statusSelect.value = comment.status;
  statusSelect.addEventListener("change", () => {
    const status = statusSelect.value as ReviewThreadStatus;
    void request({ type: "review.setCommentStatus", commentId: comment.commentId, status }).then((response) => {
      if (!response.ok || response.payload.type !== "review.setCommentStatus") {
        showResult(response.ok ? "unexpected response" : `set status failed: ${response.error.message}`, true);
        return;
      }
      const updated = response.payload.comment;
      // Update in place, then refetch the aggregated state (openCommentCount
      // changed) and re-render.
      const owner = sessionForComment(comment.commentId);
      const list = commentsBySession.get(owner);
      if (list) {
        commentsBySession.set(owner, list.map((c) => (c.commentId === comment.commentId ? updated : c)));
      }
      void loadState().then(() => render());
    });
  });

  entry.append(anchor, bodyEl, authorEl, statusSelect);
  return entry;
}

/** Reverse lookup: which session's list owns a comment id (for author/status routing). */
function sessionForComment(commentId: string): string {
  for (const [sessionId, list] of commentsBySession) {
    if (list.some((c) => c.commentId === commentId)) return sessionId;
  }
  return "";
}

function showResult(text: string, isError: boolean): void {
  resultLine.replaceChildren();
  const line = el("div", isError ? "tr-result-error" : "tr-result-line");
  line.textContent = text;
  resultLine.append(line);
  resultLine.classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

async function onSubmit(): Promise<void> {
  if (reviewState === null || reviewState.openCommentCount === 0) return;
  submitButton.disabled = true;
  const response = await request({ type: "taskReview.submit", taskId });
  if (!response.ok) {
    submitButton.disabled = false;
    showResult(`submit failed: ${response.error.message}`, true);
    return;
  }
  if (response.payload.type !== "taskReview.submit") {
    submitButton.disabled = false;
    return;
  }
  const { dispatched, sessions, sentSessions, errors } = response.payload;
  resultLine.replaceChildren();
  const line = el("div", "tr-result-line");
  const noun = `comment${dispatched === 1 ? "" : "s"}`;
  if (sentSessions !== undefined && sentSessions.length > 0) {
    // R2: name the sessions that received the dispatch, joined with ", ". Built
    // via textContent through sessionLabel() — plain text, no links/handlers
    // (the jump link is deferred machinery per the design doc).
    const names = sentSessions.map((ref) => sessionLabel(ref)).join(", ");
    line.textContent = `Sent ${String(dispatched)} ${noun} to ${names}.`;
  } else {
    // Fallback to the count-only line when the response omits refs.
    line.textContent = `Sent ${String(dispatched)} comment(s) to ${String(sessions)} session(s).`;
  }
  resultLine.append(line);
  for (const err of errors ?? []) {
    const errEl = el("div", "tr-result-error");
    errEl.textContent = err;
    resultLine.append(errEl);
  }
  resultLine.classList.remove("hidden");
  // Delegations changed: refetch state + every session's comments, then render.
  // Silent — the result line above is the user's feedback; no R11 flash/stamp on
  // a change the user just made.
  await refresh(false);
}

// ---------------------------------------------------------------------------
// Loaders + boot
// ---------------------------------------------------------------------------

async function loadState(): Promise<void> {
  const response = await request({ type: "taskReview.state", taskId });
  if (response.ok && response.payload.type === "taskReview.state") {
    reviewState = response.payload.state;
    return;
  }
  if (!response.ok) {
    // Failure honesty: a dead boot must not sit on "Loading…" forever, and a
    // failed refresh of an already-rendered panel surfaces on the result line.
    if (reviewState === null) {
      emptyState.textContent = `Task review failed to load: ${response.error.message}`;
    } else {
      showResult(`refresh failed: ${response.error.message}`, true);
    }
  }
}

async function loadSessionComments(sessionId: string): Promise<void> {
  const response = await request({ type: "review.state", sessionId });
  if (response.ok && response.payload.type === "review.state") {
    // Task-review comments exclude plan-doc threads (those belong to the
    // plan-docs panel); everything else is a code comment this dock owns.
    commentsBySession.set(
      sessionId,
      response.payload.comments.filter((comment) => !comment.filePath.startsWith("plan:"))
    );
  }
}

/**
 * Refetches state + every linked session's comments and re-renders. `announce`
 * (default true) gates the R11 changed-row flash + `updated · just now` stamp;
 * onSubmit passes false because the user just triggered the change and already
 * has an explicit result line (no need to also blink at them).
 */
async function refresh(announce = true): Promise<void> {
  await loadState();
  const state = reviewState;
  if (state !== null) {
    // Fetch each linked session's comment list (including zero-file sessions —
    // their comments still surface in the dock). Prune sessions that vanished.
    const live = new Set(state.sessions.map((s) => s.sessionId));
    for (const known of [...commentsBySession.keys()]) {
      if (!live.has(known)) commentsBySession.delete(known);
    }
    await Promise.all(state.sessions.map((s) => loadSessionComments(s.sessionId)));

    // Announce a MEANINGFUL refetch: diff the fresh state against the prior
    // render snapshot BEFORE render() replaces the DOM. A no-op refetch stays
    // silent; the first render (no prior snapshot) never announces. Manual ↻ and
    // pushed taskReview.updated share this gate.
    if (announce) {
      const { changed, keys } = diffAgainstSnapshot(state);
      if (changed) {
        flashKeys = keys;
        announceUpdate();
      }
    }
  }
  render();
}

function persist(): void {
  vscodeApi.setState({ openedKeys: [...openedKeys] });
}

const saved = vscodeApi.getState();
if (saved && Array.isArray(saved.openedKeys)) {
  openedKeys = new Set(saved.openedKeys.filter((key): key is string => typeof key === "string"));
}
void refresh();

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
