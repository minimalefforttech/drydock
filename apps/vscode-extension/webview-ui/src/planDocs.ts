/**
 * Plan-docs editor panel webview (chat-panel redesign, Phase 2 — plan mode v2).
 *
 * The reviewer's surface for the plan documents an agent wrote in plan mode:
 * a documents nav (hidden when there is only one), the active document split
 * into 1-based indexed blocks, hover-to-comment on any block, and a comments
 * dock (right on wide viewports, below content when narrow). Open comments are
 * sent back to the agent as one revision turn; new revisions arrive via the
 * planDocs.updated push and re-render while preserving the selected doc.
 *
 * SECURITY: every dynamic string (doc names, agent-authored markdown, comment
 * bodies) renders via textContent — NEVER innerHTML. Markdown is rendered
 * STRUCTURALLY: the splitter classifies blocks and each block is built from DOM
 * nodes whose text leaves are set with textContent, so raw HTML inside the
 * markdown stays literal text. INLINE markdown (bold, links, inline code) is
 * NOT parsed in v1 — paragraph/heading/list text is shown verbatim. Mermaid
 * blocks RENDER as diagrams (owner-approved 2026-07-04): the 3.3 MB mermaid
 * bundle is script-injected lazily — NEVER imported statically here — only when
 * a rendered doc actually contains a diagram, its SVG output flows exclusively
 * through adoptSanitizedSvg (the sole DOM-from-string path; no innerHTML), and
 * on any render/adoption failure the block falls back to source-with-badge plus
 * a short error line. Re-renders use replaceChildren, so listeners on discarded
 * nodes are dropped with them.
 */

import {
  WEBVIEW_PROTOCOL_VERSION,
  type HostToWebviewMessage,
  type PanelPushPayload,
  type PanelRequestPayload,
  type PanelResponse,
  type PlanDocDetail,
  type ReviewCommentSummary,
  type ReviewThreadStatus
} from "@drydock/contracts";
import { splitBlocks, type DocBlock } from "./markdownBlocks.js";
import { adoptSanitizedSvg } from "./svgAdopt.js";
// TYPE-ONLY import: the mermaid runtime bundle (~3.3 MB) is NEVER imported here
// — it is script-injected lazily by loadMermaid(). Importing the type erases at
// compile time, so no mermaid code folds into the main planDocs bundle.
import type { PlanDocsMermaidApi } from "./planDocsMermaid.js";

declare global {
  interface Window {
    vscodeAiPlanDocsMermaid?: PlanDocsMermaidApi;
  }
}

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): PersistedState | undefined;
  setState(state: PersistedState): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** Only the selected doc name persists; everything else is re-fetched on boot. */
interface PersistedState {
  readonly selectedDocName: string | null;
}

const vscodeApi = acquireVsCodeApi();
const app = document.getElementById("app");
if (!app) throw new Error("missing #app root");
const sessionId = app.dataset["sessionId"] ?? "";

const REQUEST_TIMEOUT_MS = 60_000;
const REVIEW_STATUSES: readonly ReviewThreadStatus[] = ["open", "acknowledged", "delegated", "resolved", "wont-fix", "blocked"];
/**
 * A comment is "open" (i.e. will be sent to the agent) only when its status is
 * exactly "open" — this mirrors PlanDocsAppService.composeCommentTurn, which
 * sends only status==="open" comments and then flips them to "delegated". The
 * header count must match what the backend will actually send.
 */
function isOpenComment(status: ReviewThreadStatus): boolean {
  return status === "open";
}
const pending = new Map<string, { resolve: (value: PanelResponse) => void; timer: number }>();
let requestCounter = 0;

let docs: readonly PlanDocDetail[] = [];
/** All plan comments across every doc (filePath starts "plan:"). */
let comments: readonly ReviewCommentSummary[] = [];
let selectedDocName: string | null = null;

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

function request(payload: PanelRequestPayload): Promise<PanelResponse> {
  requestCounter += 1;
  const requestId = `plandocs-req-${String(requestCounter)}-${String(Date.now())}`;
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

function applyPush(payload: PanelPushPayload): void {
  if (payload.type === "planDocs.updated" && payload.sessionId === sessionId) {
    // The summaries carry the bumped revisions; re-fetch full detail to render.
    void refresh({ flashUpdates: true });
  }
}

// ---------------------------------------------------------------------------
// Lazy mermaid loader
// ---------------------------------------------------------------------------

/**
 * Loads the mermaid bundle on demand and resolves its namespaced API. Memoized:
 * concurrent diagram blocks share one script injection and one promise. If the
 * global already exists (e.g. re-render after a prior load) it resolves at once;
 * otherwise a <script> is injected with #app's data-mermaid-src and data-nonce
 * (the CSP admits the script only under that nonce). This is invoked ONLY when a
 * rendered doc contains a diagram, so a diagram-less panel never parses 3.3 MB.
 */
let mermaidLoad: Promise<PlanDocsMermaidApi> | undefined;

function loadMermaid(): Promise<PlanDocsMermaidApi> {
  if (mermaidLoad !== undefined) return mermaidLoad;
  mermaidLoad = new Promise<PlanDocsMermaidApi>((resolve, reject) => {
    const existing = window.vscodeAiPlanDocsMermaid;
    if (existing !== undefined) {
      resolve(existing);
      return;
    }
    const src = app?.dataset["mermaidSrc"] ?? "";
    const nonce = app?.dataset["nonce"] ?? "";
    if (src === "") {
      reject(new Error("Mermaid bundle source is not configured on #app."));
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.nonce = nonce;
    script.addEventListener("load", () => {
      const api = window.vscodeAiPlanDocsMermaid;
      if (api === undefined) {
        reject(new Error("Mermaid bundle loaded but did not expose its renderer."));
        return;
      }
      resolve(api);
    });
    script.addEventListener("error", () => {
      reject(new Error("Failed to load the mermaid diagram bundle."));
    });
    document.head.append(script);
  });
  return mermaidLoad;
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

const headerBar = el("div", "pd-header");
const headerTitle = el("h2", "pd-title");
const headerRevBadge = el("span", "pd-rev-badge");
const headerSpacer = el("span", "pd-header-spacer");
const sendButton = button("Send comments", "primary small");
const sendNote = el("span", "pd-send-note hidden");
headerBar.append(headerTitle, headerRevBadge, headerSpacer, sendButton, sendNote);

const body = el("div", "pd-body");
const nav = el("nav", "pd-nav");
const contentColumn = el("div", "pd-content");
const dock = el("aside", "pd-dock");
body.append(nav, contentColumn, dock);

const emptyState = el("div", "pd-empty");
emptyState.textContent = "No plan documents collected yet. Run a plan-mode turn to generate them.";

app.append(headerBar, emptyState, body);

sendButton.addEventListener("click", () => void onSendComments());

// ---------------------------------------------------------------------------
// Selectors / helpers
// ---------------------------------------------------------------------------

function activeDoc(): PlanDocDetail | undefined {
  if (selectedDocName !== null) {
    const found = docs.find((doc) => doc.name === selectedDocName);
    if (found) return found;
  }
  return docs[0];
}

function planFilePath(docName: string): string {
  return `plan:${docName}`;
}

function docNameFromFilePath(filePath: string): string {
  return filePath.startsWith("plan:") ? filePath.slice("plan:".length) : filePath;
}

function commentsForDoc(docName: string): ReviewCommentSummary[] {
  return comments
    .filter((comment) => docNameFromFilePath(comment.filePath) === docName)
    .sort((a, b) => (a.startLine - b.startLine) || (a.createdAt < b.createdAt ? -1 : 1));
}

function commentsForBlock(docName: string, blockIndex: number): ReviewCommentSummary[] {
  return commentsForDoc(docName).filter((comment) => comment.startLine === blockIndex);
}

function openCommentCount(): number {
  return comments.filter((comment) => isOpenComment(comment.status)).length;
}

// ---------------------------------------------------------------------------
// Rendering (textContent only for dynamic data)
// ---------------------------------------------------------------------------

function render(): void {
  const hasDocs = docs.length > 0;
  emptyState.classList.toggle("hidden", hasDocs);
  body.classList.toggle("hidden", !hasDocs);
  headerBar.classList.toggle("hidden", !hasDocs);
  if (!hasDocs) {
    persist();
    return;
  }
  const doc = activeDoc();
  if (doc === undefined) return;
  selectedDocName = doc.name;

  headerTitle.textContent = doc.name;
  headerRevBadge.textContent = `rev ${String(doc.revision)}`;

  const open = openCommentCount();
  sendButton.disabled = open === 0;
  sendButton.textContent = open === 0 ? "No open comments" : `Send ${String(open)} open comment${open === 1 ? "" : "s"} to agent`;

  renderNav();
  renderContent(doc);
  renderDock(doc);
  persist();
}

function renderNav(): void {
  nav.replaceChildren();
  // Hidden when only one document.
  if (docs.length <= 1) {
    nav.classList.add("hidden");
    return;
  }
  nav.classList.remove("hidden");
  for (const doc of docs) {
    const item = el("button", "pd-nav-item");
    if (doc.name === selectedDocName) item.classList.add("active");
    const name = el("span", "pd-nav-name");
    name.textContent = doc.name;
    const rev = el("span", "pd-nav-rev");
    rev.textContent = `rev ${String(doc.revision)}`;
    const openForDoc = commentsForDoc(doc.name).filter((comment) => isOpenComment(comment.status)).length;
    item.append(name, rev);
    if (openForDoc > 0) {
      const pill = el("span", "pd-count-pill");
      pill.textContent = String(openForDoc);
      item.append(pill);
    }
    // A pending revision flash lives here (added/cleared in refresh()).
    const flash = flashByDoc.get(doc.name);
    if (flash !== undefined) {
      const flashEl = el("span", "pd-nav-flash");
      flashEl.textContent = `updated to rev ${String(flash)}`;
      item.append(flashEl);
    }
    item.addEventListener("click", () => {
      selectedDocName = doc.name;
      render();
    });
    nav.append(item);
  }
}

/** Block DOM nodes for the active doc, keyed by block index (for anchor scroll). */
const blockNodes = new Map<number, HTMLElement>();

function renderContent(doc: PlanDocDetail): void {
  contentColumn.replaceChildren();
  blockNodes.clear();
  const blocks = splitBlocks(doc.content, doc.format);
  if (blocks.length === 0) {
    const empty = el("div", "pd-block-empty");
    empty.textContent = "This document is empty.";
    contentColumn.append(empty);
    return;
  }
  // Pay the 3.3 MB mermaid parse ONLY when this doc actually has a diagram;
  // a diagram-less panel never triggers the load. Each mermaid block awaits the
  // same memoized promise below.
  const hasMermaid = blocks.some((block) => block.kind === "mermaid");
  if (hasMermaid) void loadMermaid();
  for (const block of blocks) {
    const node = renderBlock(doc, block);
    blockNodes.set(block.index, node);
    contentColumn.append(node);
  }
}

function renderBlock(doc: PlanDocDetail, block: DocBlock): HTMLElement {
  const wrap = el("div", `pd-block pd-block-${block.kind}`);
  const content = el("div", "pd-block-content");
  wrap.append(content);

  // Hover affordance: a comment icon button, top-right of the block.
  const commentButton = el("button", "pd-comment-icon");
  commentButton.textContent = "💬";
  commentButton.title = "Comment on this block";
  commentButton.setAttribute("aria-label", "Comment on this block");
  wrap.append(commentButton);

  // Count pill for existing comments on this block; click focuses the dock.
  const existing = commentsForBlock(doc.name, block.index);
  if (existing.length > 0) {
    const pill = el("button", "pd-block-count");
    pill.textContent = `${String(existing.length)} comment${existing.length === 1 ? "" : "s"}`;
    pill.title = "Jump to comments";
    pill.addEventListener("click", () => focusDockEntry(existing[0]?.commentId));
    wrap.append(pill);
  }

  const commentBoxWrap = el("div", "pd-comment-box-wrap");
  // Opens (or re-focuses) the inline comment box, optionally prefilled — reused
  // by both the hover 💬 button and mermaid node-clicks.
  const openCommentBox = (prefill = ""): void => {
    if (commentBoxWrap.childElementCount === 0) {
      commentBoxWrap.append(buildCommentBox(doc, block.index, () => commentBoxWrap.replaceChildren(), prefill));
    }
    const textarea = commentBoxWrap.querySelector("textarea");
    if (textarea instanceof HTMLTextAreaElement) {
      if (prefill !== "" && textarea.value === "") textarea.value = prefill;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }
  };
  commentButton.addEventListener("click", () => {
    if (commentBoxWrap.childElementCount > 0) {
      commentBoxWrap.replaceChildren();
      return;
    }
    openCommentBox();
  });

  // Body: mermaid renders asynchronously (placeholder → adopted SVG); every
  // other kind is synchronous DOM.
  if (block.kind === "mermaid") {
    content.append(renderMermaidBlock(doc, block, openCommentBox));
  } else {
    content.append(renderBlockBody(block));
  }

  wrap.append(commentBoxWrap);
  return wrap;
}

function renderBlockBody(block: DocBlock): HTMLElement {
  switch (block.kind) {
    case "heading": {
      // Clamp deeper levels to h4 per the layout contract.
      const level = Math.min(block.level ?? 1, 4);
      const heading = el(`h${String(level)}`, "pd-heading");
      heading.textContent = block.text;
      return heading;
    }
    case "paragraph": {
      const p = el("p", "pd-paragraph");
      p.textContent = block.text;
      return p;
    }
    case "list": {
      const ul = el("ul", "pd-list");
      for (const item of block.items ?? []) {
        const li = el("li");
        li.textContent = item;
        ul.append(li);
      }
      return ul;
    }
    case "code":
    case "mermaid": {
      // The source-with-badge presentation, shared by code blocks and the
      // mermaid fallback (invalid source / render failure).
      const figure = el("div", block.kind === "mermaid" ? "pd-code pd-mermaid" : "pd-code");
      const badge = el("span", block.kind === "mermaid" ? "pd-badge pd-badge-diagram" : "pd-badge");
      badge.textContent = block.kind === "mermaid" ? "diagram" : (block.language && block.language.length > 0 ? block.language : "code");
      const pre = document.createElement("pre");
      pre.className = "pd-pre";
      const code = document.createElement("code");
      code.textContent = block.text;
      pre.append(code);
      figure.append(badge, pre);
      return figure;
    }
  }
}

/** Strips a mermaid `%%{...}%%` init/config directive span (may be multi-line). */
const MERMAID_DIRECTIVE_RE = /%%\{[\s\S]*?\}%%/g;

/**
 * Renders a mermaid block: an immediate placeholder, then asynchronously the
 * adopted SVG (or a source+error fallback). The returned element is a stable
 * container the async result replaces in place.
 */
function renderMermaidBlock(doc: PlanDocDetail, block: DocBlock, openCommentBox: (prefill?: string) => void): HTMLElement {
  const placeholder = el("div", "pd-mermaid-placeholder");
  placeholder.textContent = "rendering diagram…";

  // DEFENSE-IN-DEPTH: strip every %%{init:...}%% / directive span so agent
  // source cannot steer theme/config — theme is host-controlled in
  // planDocsMermaid.ts (securityLevel strict, htmlLabels off).
  const source = block.text.replace(MERMAID_DIRECTIVE_RE, "").trim();
  // Deterministic, DOM-id-safe render id: docName + block index, sanitized.
  const renderId = `pd-mermaid-${sanitizeId(doc.name)}-${String(block.index)}`;

  void loadMermaid()
    .then((api) => api.render(renderId, source))
    .then((result) => {
      // STALE-RENDER GUARD: a panel re-render (replaceChildren) between the
      // start of this async chain and now will have detached the placeholder;
      // appending into a discarded subtree would resurrect stale DOM. Bail.
      if (!placeholder.isConnected) return;
      const svg = adoptSanitizedSvg(document, result.svg);
      if (svg === null) {
        replaceWithFallback(placeholder, block, "This diagram could not be displayed; showing its source.");
        return;
      }
      const figure = buildMermaidFigure(svg, block, openCommentBox);
      placeholder.replaceWith(figure);
    })
    .catch(() => {
      if (!placeholder.isConnected) return;
      replaceWithFallback(placeholder, block, "This diagram could not be rendered; showing its source.");
    });

  return placeholder;
}

/** Builds the rendered-diagram figure: adopted SVG + a "diagram"/view-source footer. */
function buildMermaidFigure(svg: SVGSVGElement, block: DocBlock, openCommentBox: (prefill?: string) => void): HTMLElement {
  const figure = el("figure", "mermaid-figure");
  const svgWrap = el("div", "mermaid-svg-wrap");
  svgWrap.append(svg);

  // Source view (hidden until toggled): the ORIGINAL block source as textContent.
  const sourceView = document.createElement("pre");
  sourceView.className = "pd-pre mermaid-source hidden";
  const code = document.createElement("code");
  code.textContent = block.text;
  sourceView.append(code);

  const footer = el("figcaption", "mermaid-footer");
  const badge = el("span", "pd-badge pd-badge-diagram");
  badge.textContent = "diagram";
  const toggle = el("button", "mermaid-view-source");
  toggle.setAttribute("type", "button");
  toggle.textContent = "view source";
  toggle.addEventListener("click", () => {
    // Swap the SVG and its source view; the button label tracks what a click
    // will show NEXT.
    const showingSource = !sourceView.classList.contains("hidden");
    sourceView.classList.toggle("hidden", showingSource);
    svgWrap.classList.toggle("hidden", !showingSource);
    toggle.textContent = showingSource ? "view source" : "view diagram";
  });
  footer.append(badge, toggle);
  figure.append(svgWrap, sourceView, footer);

  wireNodeClicks(svg, openCommentBox);
  return figure;
}

/** Replaces the placeholder with the source-view fallback plus one error line. */
function replaceWithFallback(placeholder: HTMLElement, block: DocBlock, message: string): void {
  const container = el("div", "pd-mermaid-fallback");
  container.append(renderBlockBody(block));
  const error = el("div", "pd-mermaid-error");
  error.textContent = message;
  container.append(error);
  placeholder.replaceWith(container);
}

/**
 * One delegated click listener per figure: a click landing inside a node group
 * (`g[id]`) opens the block's comment box prefilled `[node: <label>] `, so the
 * comment records which node it targets. The anchor stays the block index — no
 * schema change.
 */
function wireNodeClicks(svg: SVGSVGElement, openCommentBox: (prefill?: string) => void): void {
  svg.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const group = target.closest("g[id]");
    if (group === null || !svg.contains(group)) return;
    const label = (group.textContent ?? "").trim() || group.id;
    openCommentBox(`[node: ${label}] `);
  });
}

/** Sanitizes a doc name into a DOM-id-safe token (deterministic). */
function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function buildCommentBox(doc: PlanDocDetail, blockIndex: number, onDone: () => void, prefill = ""): HTMLElement {
  const box = el("div", "pd-comment-box");
  const textarea = document.createElement("textarea");
  textarea.className = "pd-comment-input";
  textarea.rows = 2;
  textarea.placeholder = "Note or correction for this block…";
  if (prefill !== "") textarea.value = prefill;
  const actions = el("div", "pd-comment-box-actions");
  const add = button("Add", "primary small");
  const cancel = button("Cancel", "ghost small");
  actions.append(add, cancel);
  box.append(textarea, actions);

  cancel.addEventListener("click", onDone);
  add.addEventListener("click", () => {
    const bodyText = textarea.value.trim();
    if (!bodyText) return;
    add.disabled = true;
    void request({
      type: "review.addComment",
      sessionId,
      filePath: planFilePath(doc.name),
      startLine: blockIndex,
      endLine: blockIndex,
      body: bodyText
    }).then((response) => {
      add.disabled = false;
      if (!response.ok || response.payload.type !== "review.addComment") return;
      comments = [...comments, response.payload.comment];
      onDone();
      render();
    });
  });
  return box;
}

function renderDock(doc: PlanDocDetail): void {
  dock.replaceChildren();
  const heading = el("h3", "pd-dock-heading");
  heading.textContent = "Comments";
  dock.append(heading);

  const active = commentsForDoc(doc.name);
  if (active.length === 0) {
    const empty = el("div", "pd-dock-empty");
    empty.textContent = "No comments on this document. Hover a block to add one.";
    dock.append(empty);
  } else {
    for (const comment of active) dock.append(dockEntry(comment));
  }

  // Collapsed "other docs" group: comments on documents other than the active.
  const others = comments.filter((comment) => docNameFromFilePath(comment.filePath) !== doc.name);
  if (others.length > 0) {
    const details = document.createElement("details");
    details.className = "pd-dock-others";
    const summary = document.createElement("summary");
    summary.textContent = `Other documents (${String(others.length)})`;
    details.append(summary);
    for (const comment of others.sort((a, b) => (a.filePath < b.filePath ? -1 : 1) || (a.startLine - b.startLine))) {
      details.append(dockEntry(comment, true));
    }
    dock.append(details);
  }
}

function dockEntry(comment: ReviewCommentSummary, showDoc = false): HTMLElement {
  const entry = el("div", "pd-dock-entry");
  entry.dataset["commentId"] = comment.commentId;
  if (comment.status === "delegated") entry.classList.add("delegated");

  const anchor = el("button", "pd-dock-anchor");
  const docName = docNameFromFilePath(comment.filePath);
  anchor.textContent = showDoc ? `${docName} · block ${String(comment.startLine)}` : `Block ${String(comment.startLine)}`;
  anchor.title = "Jump to this block";
  anchor.addEventListener("click", () => scrollToBlock(comment.startLine));

  const bodyEl = el("div", "pd-dock-body");
  bodyEl.textContent = comment.body;

  const statusSelect = document.createElement("select");
  statusSelect.className = "pd-dock-status";
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
      if (!response.ok || response.payload.type !== "review.setCommentStatus") return;
      const updated = response.payload.comment;
      comments = comments.map((c) => (c.commentId === comment.commentId ? updated : c));
      render();
    });
  });

  entry.append(anchor, bodyEl, statusSelect);
  return entry;
}

function scrollToBlock(blockIndex: number): void {
  const node = blockNodes.get(blockIndex);
  if (node === undefined) return;
  node.scrollIntoView({ behavior: "smooth", block: "center" });
  node.classList.add("pd-block-highlight");
  window.setTimeout(() => node.classList.remove("pd-block-highlight"), 1_200);
}

function focusDockEntry(commentId: string | undefined): void {
  if (commentId === undefined) return;
  const entry = dock.querySelector(`.pd-dock-entry[data-comment-id="${cssEscape(commentId)}"]`);
  if (entry instanceof HTMLElement) {
    entry.scrollIntoView({ behavior: "smooth", block: "center" });
    entry.classList.add("pd-dock-flash");
    window.setTimeout(() => entry.classList.remove("pd-dock-flash"), 1_200);
  }
}

/** Minimal attribute-selector escaping (ids are generated, but be safe). */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Send comments
// ---------------------------------------------------------------------------

async function onSendComments(): Promise<void> {
  if (openCommentCount() === 0) return;
  sendButton.disabled = true;
  const response = await request({ type: "planDocs.sendComments", sessionId });
  sendButton.disabled = false;
  if (!response.ok) {
    showSendNote(`could not send: ${response.error.message}`, true);
    return;
  }
  if (response.payload.type === "planDocs.sendComments") {
    if (response.payload.accepted && response.payload.sentCount > 0) {
      showSendNote("sent — the agent is revising; new revisions appear when collected", false);
      // The host flips those comments to delegated; reflect it on next refresh.
      void refresh();
    } else {
      showSendNote("nothing open to send", false);
    }
  }
}

function showSendNote(text: string, isError: boolean): void {
  sendNote.textContent = text;
  sendNote.classList.toggle("pd-send-note-error", isError);
  sendNote.classList.remove("hidden");
  window.setTimeout(() => sendNote.classList.add("hidden"), 8_000);
}

// ---------------------------------------------------------------------------
// Refresh + boot
// ---------------------------------------------------------------------------

/** Doc name → new revision, cleared shortly after a revision flash renders. */
const flashByDoc = new Map<string, number>();

async function refresh(options: { flashUpdates?: boolean } = {}): Promise<void> {
  const previousRevisions = new Map(docs.map((doc) => [doc.name, doc.revision]));
  const previousSelected = selectedDocName;
  const previousScroll = contentColumn.scrollTop;

  const [docsResponse, reviewResponse] = await Promise.all([
    request({ type: "planDocs.state", sessionId }),
    request({ type: "review.state", sessionId })
  ]);

  if (docsResponse.ok && docsResponse.payload.type === "planDocs.state") {
    docs = docsResponse.payload.docs;
  }
  if (reviewResponse.ok && reviewResponse.payload.type === "review.state") {
    comments = reviewResponse.payload.comments.filter((comment) => comment.filePath.startsWith("plan:"));
  }

  // Preserve the selected doc where possible.
  if (previousSelected !== null && docs.some((doc) => doc.name === previousSelected)) {
    selectedDocName = previousSelected;
  }

  if (options.flashUpdates) {
    flashByDoc.clear();
    for (const doc of docs) {
      const prev = previousRevisions.get(doc.name);
      if (prev !== undefined && doc.revision > prev) {
        flashByDoc.set(doc.name, doc.revision);
      }
    }
    if (flashByDoc.size > 0) {
      window.setTimeout(() => { flashByDoc.clear(); renderNav(); }, 4_000);
    }
  }

  render();
  // Restore scroll position on the content column where it still applies.
  contentColumn.scrollTop = previousScroll;
}

function persist(): void {
  vscodeApi.setState({ selectedDocName });
}

const saved = vscodeApi.getState();
if (saved && typeof saved.selectedDocName === "string") {
  selectedDocName = saved.selectedDocName;
}
void refresh();

// ---------------------------------------------------------------------------
// Local DOM helpers (kept in-module; the shared component helpers live in the
// control-panel bundle, which this standalone entry does not import).
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
