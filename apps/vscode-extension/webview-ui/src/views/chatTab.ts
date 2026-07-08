/**
 * Chat tab: the default surface, styled as a DEV LOG (GitHub-Copilot-chat-like),
 * not an online chat bot.
 *
 * Full-height flex column: scrollable chat body (header, context strip,
 * transcript, open questions, access cards, Changes working set with Task
 * Notes) → pinned composer (with the plan-docs pill). Assistant turns render
 * full-width as structural markdown blocks (shared splitter); user turns as a
 * compact tinted card. Files dragged from the VS Code explorer or the OS drop
 * their (mount-relative) paths into the composer.
 *
 * SECURITY: all dynamic strings (agent output, titles, mounts, model names, file
 * paths) are assigned via textContent — never innerHTML — so nothing
 * agent-authored can become markup. Markdown is rendered STRUCTURALLY: the
 * splitter classifies blocks and each block is built from DOM nodes whose text
 * leaves are set with textContent, so raw HTML in output stays literal. Mermaid
 * fences render via the same lazy, sanitized SVG path as plan docs. Re-renders
 * use replaceChildren so stale handlers cannot leak.
 */

import {
  MAX_CLIPBOARD_LENGTH,
  reduceAgentTree,
  subagentReportingForTransport,
  treeSourceFromLine,
  type AgentRole,
  type AgentTreeNode,
  type AgentTreeSource,
  type ChatModelSelection,
  type ChatSessionSummary,
  type ChatWorkspaceSelection,
  type CloneFileChange,
  type CloneRepoState,
  type CloneSyncResult,
  type DiffFileSummary,
  type IsolationSummary,
  type PanelResponse,
  type RuntimeStatsSummary,
  type SequencedTranscriptLine,
  type WorkTaskSummary
} from "@drydock/contracts";
import {
  button,
  collapsible,
  el,
  formatTime,
  iconButton,
  inlineConfirmButton,
  option,
  popover,
  select,
  statusDot
} from "../components.js";
import { splitBlocks, type DocBlock } from "../markdownBlocks.js";
import { onPush, request } from "../messaging.js";
import {
  AGENT_GROUP_ENTRY_CAP,
  currentSession,
  fallbackCatalog,
  isSessionLiveish,
  normalizeProviderId,
  upsertAccessRequest,
  upsertQuestion,
  upsertSession,
  type AgentGroup,
  type ChatMessage,
  type DiagnosticEntry,
  type TaskNote,
  type ThinkingEffort
} from "../state.js";
import { adoptSanitizedSvg } from "../svgAdopt.js";
import type { PlanDocsMermaidApi } from "../planDocsMermaid.js";
import type { ChatTabView, ViewContext } from "../viewContext.js";
import { renderAttentionStack, type AttentionItem } from "./attentionStack.js";

declare global {
  interface Window {
    vscodeAiPlanDocsMermaid?: PlanDocsMermaidApi;
  }
}

let mermaidLoad: Promise<PlanDocsMermaidApi> | undefined;
let mermaidRenderSequence = 0;

/** Strips a mermaid `%%{...}%%` init/config directive span (may be multi-line). */
const MERMAID_DIRECTIVE_RE = /%%\{[\s\S]*?\}%%/g;

function loadMermaid(): Promise<PlanDocsMermaidApi> {
  if (mermaidLoad !== undefined) return mermaidLoad;
  mermaidLoad = new Promise<PlanDocsMermaidApi>((resolve, reject) => {
    const existing = window.vscodeAiPlanDocsMermaid;
    if (existing !== undefined) {
      resolve(existing);
      return;
    }
    const app = document.getElementById("app");
    const src = app?.dataset["mermaidSrc"] ?? "";
    const nonce = app?.dataset["nonce"] ?? "";
    if (src === "") {
      mermaidLoad = undefined;
      reject(new Error("Mermaid bundle source is not configured on #app."));
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.nonce = nonce;
    script.addEventListener("load", () => {
      const api = window.vscodeAiPlanDocsMermaid;
      if (api === undefined) {
        mermaidLoad = undefined;
        reject(new Error("Mermaid bundle loaded but did not expose its renderer."));
        return;
      }
      resolve(api);
    });
    script.addEventListener("error", () => {
      mermaidLoad = undefined;
      reject(new Error("Failed to load the mermaid diagram bundle."));
    });
    document.head.append(script);
  });
  return mermaidLoad;
}

/** Change-kind → single-glyph badge + color class (Copilot working-set style). */
const CHANGE_GLYPH: Record<DiffFileSummary["changeKind"], { glyph: string; cls: string }> = {
  add: { glyph: "+", cls: "kind-add" },
  modify: { glyph: "±", cls: "kind-modify" },
  delete: { glyph: "−", cls: "kind-delete" },
  rename: { glyph: "→", cls: "kind-rename" }
};

const THINKING_EFFORT_OPTIONS: readonly { id: ThinkingEffort; label: string }[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" }
];

type DisplayMount = {
  readonly runtimePath: string;
  readonly mode: "read-only" | "read-write";
  readonly hostDisplayPath?: string;
};

export function createChatTab(ctx: ViewContext): ChatTabView {
  const state = ctx.state;
  const root = el("div", "chat-tab");

  // --- transient (non-persisted) runtime flags --------------------------------
  let turnActive = false;
  let starting = false;
  let backendBusy = false;
  // A reconnect (resume/reclaim) or provider switch is booting a fresh runtime
  // before the turn can send. Drives a live indicator so the gap isn't silent.
  let reconnecting = false;
  let reconnectStartedAt: number | undefined;
  let reconnectLabel = "Reconnecting…";
  // Whether the current turn has streamed any assistant text yet — drives the
  // "finished without output" notice so a silent turn no longer looks stuck.
  let sawAssistantTextThisTurn = false;
  // The last prompt actually submitted, for the Retry button on error notices.
  let lastSentPrompt: string | null = null;
  // Set by a caller (e.g. workTab's "Create and start chat") right after it
  // switches to this tab, BEFORE chat.startSession has resolved — there is no
  // session yet to select. Drives a transcript placeholder distinct from
  // `starting` (the lazy first-send spin-up on an already-selected new chat).
  let pendingSessionStart = false;
  // FIX 4: when the current turn started (for the elapsed-seconds counter on
  // the "Assistant is working…" indicator); undefined while no turn is active.
  let turnStartedAt: number | undefined;
  // When the selected session last produced any streamed output — drives the
  // "seconds since last response" running indicator (a growing value flags a
  // stuck turn). Reset at turn start, bumped on each transcript push.
  let lastActivityAt: number | undefined;
  let workingIndicatorTimer: number | undefined;
  // 1s poll of the backend raw-stream buffer; runs ONLY while the raw panel is
  // open, so idle sessions cost nothing.
  let rawStreamTimer: number | undefined;
  // Seconds of streamed silence before the working indicator offers a poke.
  const POKE_AFTER_SECONDS = 30;
  // Auto-expand the Changes section when the file count grows within a session.
  let lastChangeCount = 0;
  let lastChangeSessionId: string | null = null;
  let activeAssistantId: string | null = null;
  // Correlates a command's "started" row with its terminal update, keyed by the
  // command text, so a command shows once and gains its exit code + output.
  const runningCommands = new Map<string, string>();
  // Live "Thinking" disclosure: accumulates agent.reasoning text for the
  // running turn. Reset at chat.turnStarted; frozen (not cleared) once the
  // turn ends so "Thought for Ns" stays readable until the next turn starts.
  let reasoningText = "";
  let reasoningActive = false;
  /** Expanded subagent groups: render-local so re-renders keep them open. */
  const expandedGroups = new Set<string>();
  let diffChanges: readonly DiffFileSummary[] = [];
  // Clone-mode sync working set: per-repo agent changes in the clone, shown
  // in the Changes section for a clone session INSTEAD of diffChanges. Kept as a
  // separate source so the two never tangle; cleared on every session switch.
  let cloneRepos: readonly CloneRepoState[] = [];
  // Model can be changed on an existing provider without a runtime reload; keep
  // that in-flight preference across model-catalog pushes until the session is
  // switched or the next turn persists it.
  let manualModelSessionId: string | null = null;
  // Files whose diff was opened this panel session (via diff.openFile). In-memory
  // only (not persisted) and scoped to the current selected session — cleared on
  // every session switch. Drives the "unreviewed" marker + Accept-all exposure.
  let openedDiffKeys = new Set<string>();

  // --- header -----------------------------------------------------------------
  const header = el("div", "chat-header");
  const backButton = iconButton("‹", "Back to sessions", "chat-back");
  backButton.addEventListener("click", () => ctx.bridge.switchTab("work"));
  const titleWrap = el("div", "chat-title-wrap");
  // CH·hierarchy: an optional small muted line above the title naming the
  // parent task, shown only when the selected session belongs to a subtask
  // (see renderHeader). Hidden (empty) otherwise.
  const titleTextWrap = el("div", "chat-title-text");
  const titleParentLabel = el("span", "chat-title-parent hidden");
  const titleLabel = el("span", "chat-title");
  titleLabel.title = "Click to rename";
  titleTextWrap.append(titleParentLabel, titleLabel);
  const statusDotEl = statusDot("state-ended", "no live session");
  titleWrap.append(statusDotEl, titleTextWrap);

  titleLabel.addEventListener("click", () => beginRename());

  // Notes live in the pinned top bar: an icon with a small count badge that
  // opens a popover holding the notes list + add-note form (built fresh on each
  // open by buildNotesPopover). Notes scope to the active subtask when the chat
  // is a subtask session, otherwise to the linked task.
  const notesButton = iconButton("✎", "Notes", "chat-notes-button");
  const notesBadge = el("span", "notes-badge hidden");
  notesButton.append(notesBadge);
  const notesPopover = popover(notesButton, (content) => buildNotesPopover(content));

  const infoButton = iconButton("ⓘ", "Isolation summary");
  const infoPopover = popover(infoButton, (content) => buildIsolationPopover(content));

  const overflowButton = iconButton("⋯", "More actions");
  const overflowPopover = popover(overflowButton, (content) => buildOverflowMenu(content));

  header.append(backButton, titleWrap, el("span", "chat-header-spacer"), notesPopover, infoPopover, overflowPopover);

  // --- context strip ----------------------------------------------------------
  // Runtime context stays in the scrollable body; send-time controls live in
  // the pinned composer so the current request and its model choice sit
  // together.
  const contextStrip = el("div", "context-strip");
  const providerSelect = select("provider-select compact", "Provider");
  const modelSelect = select("model-select compact", "Model");
  const thinkingSelect = select("thinking-select compact", "Thinking effort");
  for (const effort of THINKING_EFFORT_OPTIONS) {
    thinkingSelect.append(option(effort.id, effort.label));
  }
  thinkingSelect.value = state.thinkingEffort;

  const mounts = document.createElement("details");
  mounts.className = "context-mounts section";
  const mountsSummary = document.createElement("summary");
  mountsSummary.className = "context-mounts-summary";
  const mountsBody = el("div", "context-mounts-body");
  mounts.append(mountsSummary, mountsBody);

  // Debug: the raw agent stream for the current/last turn, fetched on demand.
  // Collapsed by default; opening it starts a 1s poll, closing it stops it.
  const rawStream = document.createElement("details");
  rawStream.className = "context-raw section";
  const rawStreamSummary = document.createElement("summary");
  rawStreamSummary.className = "context-raw-summary";
  rawStreamSummary.textContent = "Raw stream (last response)";
  const rawStreamMeta = el("span", "context-raw-meta");
  rawStreamSummary.append(rawStreamMeta);
  const rawStreamBody = el("pre", "context-raw-body");
  rawStream.append(rawStreamSummary, rawStreamBody);
  rawStream.addEventListener("toggle", () => {
    stopRawStreamPolling();
    if (rawStream.open) {
      void pollRawStream();
      rawStreamTimer = window.setInterval(() => void pollRawStream(), 1_000);
    }
  });

  contextStrip.append(mounts, rawStream);

  providerSelect.addEventListener("change", () => {
    manualModelSessionId = null;
    renderProviderControls(false);
    ctx.persist();
    void onSelectionChange();
  });
  modelSelect.addEventListener("change", () => {
    manualModelSessionId = state.selectedSessionId;
    state.selectedModel = modelSelect.value;
    ctx.persist();
  });
  thinkingSelect.addEventListener("change", () => {
    const value = thinkingSelect.value;
    if (value === "low" || value === "medium" || value === "high") {
      state.thinkingEffort = value;
      ctx.persist();
    }
  });

  // Auth banner (keyed off the SELECTED provider only).
  const authBanner = el("div", "auth-banner hidden");
  const authBannerText = el("span", "auth-banner-text");
  const loginButton = button("Log in", "small primary");
  const recheckAuthButton = button("Recheck", "ghost small");
  authBanner.append(authBannerText, loginButton, recheckAuthButton);

  // Reclaim banner: a session marked "running in another window" is read-only
  // here. Most often it's THIS window right after a reload — the old instance's
  // heartbeat has not gone stale yet — so "Take over here" reclaims + revives it
  // in this window (transcript replayed). If it really is another live window,
  // this takes control here regardless.
  const reclaimBanner = el("div", "reclaim-banner hidden");
  const reclaimBannerText = el("span", "reclaim-banner-text");
  const reclaimButton = button("Take over here", "small primary");
  reclaimBanner.append(reclaimBannerText, reclaimButton);

  reclaimButton.addEventListener("click", () => {
    const sessionId = state.selectedSessionId;
    if (sessionId === null) return;
    reclaimButton.disabled = true;
    reclaimBannerText.textContent = "Taking over…";
    void request({ type: "chat.reclaim", sessionId }).then((response) => {
      reclaimButton.disabled = false;
      if (!response.ok) {
        appendSystemMessage(`Couldn't take over this chat: ${response.error.message}`, "error");
        renderHeader();
        refreshControls();
        return;
      }
      if (response.payload.type === "chat.reclaim") {
        upsertSession(state, response.payload.session);
        state.providerCatalogs = [...response.payload.providerCatalogs];
        state.selectedSessionId = response.payload.session.sessionId;
        setTurnActive(false);
        appendSystemMessage("Took this chat over in this window. History and project mounts were restored from the saved session.");
      }
      renderHeader();
      renderProviderControls();
      renderChat();
      refreshControls();
      ctx.persist();
    });
  });

  loginButton.addEventListener("click", () => {
    const providerId = normalizeProviderId(providerSelect.value);
    loginButton.disabled = true;
    void request({ type: "provider.login", providerId }).then((response) => {
      loginButton.disabled = false;
      if (!response.ok) {
        logChat(`login failed to start: ${response.error.message}`);
        return;
      }
      if (response.payload.type === "provider.login") {
        logChat(`login started in a terminal (${response.payload.launched}); click Recheck when it finishes`);
      }
    });
  });
  recheckAuthButton.addEventListener("click", () => {
    recheckAuthButton.disabled = true;
    void request({ type: "provider.list" }).then((response) => {
      recheckAuthButton.disabled = false;
      if (response.ok && response.payload.type === "provider.list") {
        state.providerCatalogs = [...response.payload.providerCatalogs];
        renderProviderControls();
        ctx.persist();
      }
    });
  });

  // --- transcript -------------------------------------------------------------
  const chatLog = el("div", "chat-log");

  // --- Agents lens: alternate hierarchy view over the same feed --------------
  const agentsLens = el("div", "agents-lens hidden");
  let transcriptView: "log" | "agents" = "log";
  const lensStrip = el("div", "transcript-lens-strip hidden");
  const lensControl = el("div", "segmented lens-segmented");
  const logViewButton = button("Chat", "segment active");
  const agentsViewButton = button("Agents", "segment");
  lensControl.append(logViewButton, agentsViewButton);
  const setTranscriptView = (view: "log" | "agents"): void => {
    transcriptView = view;
    logViewButton.classList.toggle("active", view === "log");
    agentsViewButton.classList.toggle("active", view === "agents");
    chatLog.classList.toggle("hidden", view === "agents");
    agentsLens.classList.toggle("hidden", view === "log");
    if (view === "agents") renderAgentsLens();
  };
  logViewButton.addEventListener("click", () => setTranscriptView("log"));
  agentsViewButton.addEventListener("click", () => setTranscriptView("agents"));
  window.setInterval(() => {
    if (!hasLiveAgentRows()) return;
    if (transcriptView === "agents") renderAgentsLens();
    else renderChat(false);
  }, 15_000);
  // Spawn-role control: placeholder-first select; choosing a role
  // spawns a child session under the selected live chat.
  const spawnRoleSelect = select("spawn-role-select");
  spawnRoleSelect.classList.add("hidden");
  const resetSpawnRoleSelect = (): void => {
    spawnRoleSelect.replaceChildren(
      option("", "+ role…"),
      ...["researcher", "planner", "worker", "tester", "reviewer"].map((role) => option(role, role))
    );
    spawnRoleSelect.value = "";
  };
  resetSpawnRoleSelect();
  spawnRoleSelect.addEventListener("change", () => {
    const role = spawnRoleSelect.value;
    resetSpawnRoleSelect();
    if (role === "" || state.selectedSessionId === null) return;
    spawnRoleSelect.disabled = true;
    void request({ type: "chat.spawnRole", sessionId: state.selectedSessionId, role: role as AgentRole }).then((response) => {
      spawnRoleSelect.disabled = false;
      if (!response.ok) {
        logChat(`spawn ${role} failed: ${response.error.message}`);
        return;
      }
      if (response.payload.type === "chat.spawnRole") {
        upsertSession(state, response.payload.session);
        logChat(`spawned ${role} session "${response.payload.session.title}" — its mounts are a subset of this session's`);
        ctx.persist();
        ctx.bridge.work.render();
        renderAgentsLens();
      }
    });
  });
  lensStrip.append(lensControl);

  // --- inline access-request cards (appended after the transcript log) --------
  const accessCardsWrap = el("div", "access-cards");
  // Pending agent questions sit outside the transcript block and inside the
  // shared chat scroller. Hidden whenever no question is open.
  const questionCardsWrap = el("div", "question-cards hidden");

  // Transcript block inside the chat body. The outer chat-scroll owns overflow;
  // this block keeps a useful minimum so questions/changes cannot squeeze it.
  const transcriptRegion = el("div", "transcript-region");
  transcriptRegion.append(lensStrip, chatLog, agentsLens, accessCardsWrap);

  // --- composer ---------------------------------------------------------------
  const promptInput = document.createElement("textarea");
  promptInput.className = "prompt-input";
  promptInput.rows = 3;
  promptInput.placeholder = "Ask the isolated agent…";
  promptInput.value = state.promptDraft;
  promptInput.addEventListener("input", () => {
    state.promptDraft = promptInput.value;
    ctx.persist();
  });
  promptInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      sendButton.click();
    }
  });

  // Mode segmented control [Plan | Develop]. Clone is transfer plumbing for
  // existing clone sessions, not a composer mode.
  const modeControl = el("div", "segmented");
  const planModeBtn = button("Plan", "segment");
  const developModeBtn = button("Develop", "segment");
  modeControl.append(planModeBtn, developModeBtn);
  const applyModeButtons = (): void => {
    planModeBtn.classList.toggle("active", state.composerMode === "plan");
    developModeBtn.classList.toggle("active", state.composerMode !== "plan");
  };
  planModeBtn.addEventListener("click", () => {
    state.composerMode = "plan";
    applyModeButtons();
    ctx.persist();
  });
  developModeBtn.addEventListener("click", () => {
    state.composerMode = "implementation";
    applyModeButtons();
    ctx.persist();
  });

  const sendButton = button("⏎", "primary");
  sendButton.classList.add("composer-send");
  sendButton.title = "Send (Ctrl+Enter)";
  sendButton.setAttribute("aria-label", "Send");
  const cancelButton = button("Stop", "ghost");
  cancelButton.classList.add("composer-cancel");
  cancelButton.classList.add("hidden");

  // Model button + popup tree (providers → models). The native provider/model
  // <select>s stay in the DOM (hidden) as the source of truth so all the
  // existing selection/restart logic keeps working; the tree drives them.
  const modelButton = button("Model", "composer-model-button");
  const modelButtonChevron = el("span", "composer-model-chevron");
  modelButtonChevron.textContent = "▾";
  modelButton.append(modelButtonChevron);
  const modelPopover = popover(modelButton, (content, close) => buildModelTree(content, close));
  const hiddenModelControls = el("div", "composer-hidden-controls hidden");
  hiddenModelControls.append(providerSelect, modelSelect);

  const composerActions = el("div", "composer-actions");
  composerActions.append(
    modeControl,
    modelPopover,
    thinkingSelect,
    el("span", "composer-spacer"),
    sendButton,
    cancelButton,
    hiddenModelControls
  );

  // Plan-documents pill row (compact; shown above the composer when the
  // selected session has collected plan documents — issue 7, Phase 2).
  const planDocsRow = el("div", "plan-docs-row hidden");

  // Attachment chips: dropped files + the (clickable) active editor. VS
  // Code-style removable chips; converted to [file:…] tokens on send.
  const attachmentsRow = el("div", "composer-attachments hidden");
  type ComposerAttachment = { readonly hostPath: string; readonly runtimePath: string | null; readonly name: string };
  const attachments: ComposerAttachment[] = [];

  const composer = el("div", "composer");
  composer.append(planDocsRow, attachmentsRow, promptInput, composerActions);

  // Live sandbox usage for the selected chat, pinned just below the transcript —
  // the "is this agent actually working" signal right where you're watching it.
  const sandboxStatsBar = el("div", "sandbox-stats hidden");

  sendButton.addEventListener("click", () => void onSend());
  cancelButton.addEventListener("click", () => {
    if (!state.selectedSessionId || !turnActive) return;
    cancelButton.disabled = true;
    void request({ type: "chat.cancelTurn", sessionId: state.selectedSessionId }).then((response) => {
      cancelButton.disabled = false;
      if (!response.ok) logChat(`cancel failed: ${response.error.message}`);
    });
  });

  // --- Changes: Copilot-style working set (collapsed) -------------------------
  const changes = collapsible("Changes");
  changes.body.classList.add("changes-body");
  const workingSetHeader = el("div", "working-set-header");
  const workingSetTitle = el("span", "working-set-title");
  const refreshDiffButton = iconButton("↻", "Refresh diff", "working-set-refresh");
  const snapshotButton = button("Snapshot workspace", "ghost small working-set-snapshot");
  // Accept-all is the higher-friction inverse of the per-file one-click accept:
  // an inline-confirm whose armed label states the exposure (unreviewed count).
  const acceptAllButton = button("Accept all", "small");
  wireAcceptAllConfirm(acceptAllButton);
  const discardAllButton = inlineConfirmButton("Discard all", "Confirm?", () => void discardAll(), "ghost small danger");
  const workingSetActions = el("div", "working-set-actions");
  workingSetActions.append(refreshDiffButton, snapshotButton, acceptAllButton, discardAllButton);
  // Clone-mode header actions: shown only for a clone session, in place of
  // Accept-all / Discard-all. Both are gated while a turn runs (mirrors the
  // turnActive diff gating). Refresh (↻) is shared with the diff path.
  const pullAllButton = button("Pull all into editor", "small clone-pull-all");
  const pushButton = button("Push local → VM", "ghost small clone-push");
  const cloneActions = el("div", "working-set-actions clone-actions hidden");
  cloneActions.append(pullAllButton, pushButton);
  workingSetHeader.append(workingSetTitle, el("span", "working-set-spacer"), workingSetActions, cloneActions);
  // Clone-sync caption: one dim line above the Pull/Push action row that
  // explains the vocabulary shift (pull/push vs accept/discard). Shown only for
  // a clone session; hidden on the diff path.
  const cloneCaption = el("div", "clone-caption hidden");
  cloneCaption.textContent = "Clone sync — changes move by pull/push, not accept/discard";
  const changedFilesList = el("div", "changed-files working-set-files");

  pullAllButton.addEventListener("click", () => void runCloneOp(() =>
    request({ type: "clone.pull", sessionId: requireSelectedSessionId() }), "pull all into editor"));
  pushButton.addEventListener("click", () => void runCloneOp(() =>
    request({ type: "clone.push", sessionId: requireSelectedSessionId() }), "push local → VM"));

  // Notes moved to the pinned top bar (see notesButton / buildNotesPopover); the
  // list + add-note form are built inside the popover, fresh on each open.

  changes.body.append(cloneCaption, workingSetHeader, changedFilesList);

  refreshDiffButton.addEventListener("click", () => void loadDiffStatus());
  snapshotButton.addEventListener("click", () => {
    const workspaceSetId = state.selectedWorkspaceSetId;
    if (!workspaceSetId) {
      logChat("select a workspace set (Tasks tab) before snapshotting");
      return;
    }
    snapshotButton.disabled = true;
    void request({ type: "diff.snapshotWorkspace", workspaceSetId }).then((response) => {
      snapshotButton.disabled = false;
      if (!response.ok) {
        logChat(`snapshot failed: ${response.error.message}`);
        return;
      }
      logChat("workspace snapshot taken; edits from now on show in the diff");
      void loadDiffStatus();
    });
  });
  // Owner order: pinned top bar → scrollable chat body → docked composer. The
  // header sits OUTSIDE chat-scroll so it stays pinned while the transcript
  // scrolls under it. The Changes tray (changes.details) is docked directly
  // above the composer — collapsed by default, hidden entirely when empty.
  const chatScroll = el("div", "chat-scroll");
  chatScroll.append(
    contextStrip,
    authBanner,
    reclaimBanner,
    transcriptRegion,
    questionCardsWrap
  );
  changes.details.classList.add("changes-tray");
  const composerDock = el("div", "composer-dock");
  composerDock.append(changes.details, composer);
  root.append(header, chatScroll, sandboxStatsBar, composerDock);

  // --- drag-drop: file paths from the explorer/OS into the composer -----------
  wireComposerDropTarget();

  // ---------------------------------------------------------------------------
  // Push subscriptions
  // ---------------------------------------------------------------------------
  onPush("run.started", (payload) => {
    state.lastIsolation = payload.isolation;
    ctx.persist();
    renderContextStrip();
    renderFacts();
  });
  onPush("provider.models", (payload) => {
    state.providerCatalogs = [...payload.providerCatalogs];
    renderProviderControls();
    ctx.persist();
  });
  onPush("chat.event", (payload) => {
    if (payload.sessionId === state.selectedSessionId && payload.line.sequence > state.lastSequence) {
      state.lastSequence = payload.line.sequence;
      // Streamed output arrived: reset the "since last output" running indicator.
      if (turnActive) lastActivityAt = Date.now();
      applyTranscriptLine(payload.line);
    }
  });
  onPush("chat.turnStarted", (payload) => {
    if (payload.sessionId === state.selectedSessionId) {
      activeAssistantId = null;
      sawAssistantTextThisTurn = false;
      reasoningText = "";
      reasoningActive = false;
      setTurnActive(true);
    }
  });
  onPush("chat.turnCompleted", (payload) => {
    if (payload.sessionId === state.selectedSessionId) {
      activeAssistantId = null;
      logChat(`turn ${payload.status}`);
      setTurnActive(false);
      // Make the outcome visible in the transcript. A failed turn's reason is
      // already shown from its agent.error line; here we cover cancelled turns
      // and turns that completed without producing any output (the "did nothing,
      // looked stuck" case), which otherwise leave no trace in the chat.
      if (payload.status === "cancelled") {
        appendSystemMessage("You stopped this turn. Send another message to continue, or End the session to shut the agent down.");
      } else if (payload.status === "completed" && !sawAssistantTextThisTurn) {
        appendSystemMessage("The agent finished this turn without producing any output. If this keeps happening, check the Launch command in the session menu and the System tab — the backend may not be running correctly.", "info", true);
      }
      // SEEN SIGNAL: the user is watching this session, so pull any lines we
      // missed AND tell the host we've seen the completed turn (a timeline
      // request clears this session's turn attention → the badge clears). Cheap:
      // fromSequence caps it to just the tail; usually empty.
      void loadTimelineIncremental(payload.sessionId);
      // A clone session's agent may have edited the clone this turn; refetch its
      // sync state so the Changes section reflects the new agent changes.
      if (isCloneSelected()) {
        void loadCloneState();
      }
    }
  });
  onPush("run.failed", (payload) => {
    logChat(`failed — ${payload.message}`);
    setTurnActive(false);
    starting = false;
    refreshControls();
  });
  onPush("session.updated", (payload) => {
    upsertSession(state, payload.session);
    if (payload.session.sessionId === state.selectedSessionId) {
      renderHeader();
      renderProviderControls();
      renderFacts();
    }
    ctx.persist();
  });
  onPush("question.asked", (payload) => {
    upsertQuestion(state, payload.question);
    ctx.persist();
    ctx.bridge.work.renderAttention();
    if (payload.question.sessionId === state.selectedSessionId) renderAccessCards();
  });
  onPush("question.resolved", (payload) => {
    upsertQuestion(state, payload.question);
    ctx.persist();
    ctx.bridge.work.renderAttention();
    if (payload.question.sessionId === state.selectedSessionId) renderAccessCards();
  });
  onPush("policy.accessRequested", (payload) => {
    upsertAccessRequest(state, payload.accessRequest);
    ctx.persist();
    ctx.bridge.work.renderAttention();
    if (payload.accessRequest.sessionId === state.selectedSessionId) {
      renderAccessCards();
    }
  });
  onPush("planDocs.updated", (payload) => {
    if (payload.sessionId !== state.selectedSessionId) return;
    state.planDocs = { sessionId: payload.sessionId, docs: payload.docs.map((doc) => ({ name: doc.name, format: doc.format, revision: doc.revision })) };
    ctx.persist();
    renderPlanDocs();
    logChat(`plan documents updated (${String(payload.docs.length)})`);
  });
  onPush("editor.active", (payload) => {
    state.activeEditor = payload.editor;
    renderAttachments();
  });

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  function currentModelSelection(): ChatModelSelection {
    const model = modelSelect.value.trim();
    return {
      providerId: normalizeProviderId(providerSelect.value),
      ...(model === "" ? {} : { model })
    };
  }

  function currentWorkspaceSelection(mode: "plan" | "implementation" | "clone"): ChatWorkspaceSelection | undefined {
    // Explicit set (advanced, Tasks tab) wins; else auto-mount open folders; else
    // omit workspace entirely so the host mounts nothing. Clone mode needs roots
    // to clone, so it rides the same set/auto resolution as the other modes.
    if (state.selectedWorkspaceSetId) {
      return { workspaceSetId: state.selectedWorkspaceSetId, mode };
    }
    if (state.openFolderNames.length > 0) {
      return { auto: true, mode };
    }
    return undefined;
  }

  async function onSend(): Promise<void> {
    // A session running elsewhere is read-only here; refuse sends outright.
    if (selectedRunsElsewhere()) return;
    const basePrompt = promptInput.value.trim();
    if (!basePrompt || starting || backendBusy) return;
    if (turnActive) {
      // A turn is still running — don't silently swallow the message (the old
      // behaviour, which made the chat look dead after a Stop that didn't take).
      appendSystemMessage("A turn is still running. Press Stop to interrupt it — or End the session to shut the agent down — then send again.");
      return;
    }
    const model = currentModelSelection();
    // Fold attachment chips into the prompt as [file:…] tokens (rendered as
    // chips in the transcript), then clear them for the next message.
    const tokenLines = attachmentTokenLines();
    const prompt = tokenLines.length > 0 ? `${basePrompt}\n${tokenLines.join("\n")}` : basePrompt;
    promptInput.value = "";
    state.promptDraft = "";
    clearAttachments();
    lastSentPrompt = prompt;
    ctx.persist();

    // Send to the selected session whenever it is live in this window — even if
    // the composer's provider dropdown differs (the host surfaces a genuine
    // provider mismatch as a visible error). Previously a mismatch fell through
    // and silently started a BRAND-NEW chat, which looked like "nothing happened".
    const selected = state.selectedSessionId
      ? state.sessions.find((candidate) => candidate.sessionId === state.selectedSessionId)
      : undefined;

    if (selected !== undefined && isSessionLiveish(state, selected.sessionId)) {
      setTurnActive(true);
      const response = await request({ type: "chat.sendTurn", sessionId: selected.sessionId, prompt, model });
      if (response.ok) return;
      setTurnActive(false);
      // The backend died since we last heard (a reload race where `live` was
      // briefly stale). Hide the raw "no longer live" error and revive instead.
      if (/no longer live|not live/i.test(response.error.message)) {
        await reviveAndSend(selected, prompt, model);
      } else {
        appendSystemMessage(`Couldn't send: ${response.error.message}`, "error", true);
      }
      return;
    }

    // A SELECTED but offline session (ended/failed, or its backend was lost on
    // reload) is REVIVED, not replaced — its durable transcript + context survive
    // the new backend. Only a brand-new chat (nothing selected) clears the log.
    if (selected !== undefined) {
      await reviveAndSend(selected, prompt, model);
      return;
    }

    // Lazy spin-up: the FIRST message of a brand-new chat (nothing selected)
    // starts the micro-VM. This is the ONLY path that clears the transcript.
    starting = true;
    refreshControls();
    const mode = state.composerMode === "plan" ? "plan" : "implementation";
    const workspace = currentWorkspaceSelection(mode);
    const workspaceNote = workspace
      ? "workspaceSetId" in workspace
        ? ` · set (${workspace.mode})`
        : ` · auto (${workspace.mode})`
      : "";
    logChat(`starting isolated micro-VM for ${model.providerId}${model.model ? `/${model.model}` : ""}${workspaceNote} (takes a few seconds)…`);
    const response = await request({
      type: "chat.start",
      prompt,
      model,
      ...(workspace ? { workspace } : {})
    });
    starting = false;
    if (!response.ok) {
      appendSystemMessage(`Couldn't start the chat backend: ${response.error.message}`, "error", true);
      refreshControls();
      return;
    }
    if (response.payload.type === "chat.start") {
      upsertSession(state, response.payload.session);
      state.selectedSessionId = response.payload.session.sessionId;
      manualModelSessionId = null;
      state.lastSequence = 0;
      state.chatMessages = [];
    runningCommands.clear();
      state.diagnostics = state.diagnostics.slice(-3);
      state.agentGroups = {};
      expandedGroups.clear();
      state.changedFiles.clear();
      openedDiffKeys = new Set();
      activeAssistantId = null;
      reasoningText = "";
      reasoningActive = false;
      renderHeader();
      renderProviderControls();
      renderChat();
      renderChangedFiles();
      renderFacts();
      setTurnActive(true);
      ctx.persist();
    }
  }

  /**
   * Revives an offline session HERE — replaying its durable transcript so the
   * chat history + context survive the new backend (restarting the container is
   * fine) — then sends the queued prompt. An `active`/`starting` row (backend
   * lost on reload, or "owned" by another window) is force-reclaimed; an
   * ended/failed row resumes normally, re-mounting the open folders.
   */
  /** Native modal confirm via the host; false on cancel or any error. */
  async function confirmHost(message: string, detail: string, confirmLabel: string): Promise<boolean> {
    const response = await request({ type: "ui.confirm", message, detail, confirmLabel });
    return response.ok && response.payload.type === "ui.confirm" && response.payload.confirmed;
  }

  /** Confirms a provider switch that will tear down and reboot a running container. */
  function confirmProviderSwitch(fromProvider: string, toProvider: string): Promise<boolean> {
    return confirmHost(
      `This chat is running with ${providerLabel(fromProvider)}. Switch to ${providerLabel(toProvider)}?`,
      "This starts a new container, and some in-progress context may be lost.",
      `Switch to ${providerLabel(toProvider)}`
    );
  }

  async function reviveAndSend(session: ChatSessionSummary, prompt: string, model: ChatModelSelection): Promise<void> {
    // A provider switch reboots on the NEW provider's sandbox; same-provider is a
    // plain reconnect. Both keep the durable transcript + project mounts.
    const providerChanged = normalizeProviderId(session.providerId) !== model.providerId;
    const isActive = session.status === "active" || session.status === "starting";
    // Force-switching a session that's still running (active) destroys its live
    // container — confirm first. Ended/failed sessions are already down, so a
    // provider change on revive needs no prompt.
    if (providerChanged && isActive) {
      if (!(await confirmProviderSwitch(session.providerId, model.providerId))) {
        promptInput.value = prompt;
        state.promptDraft = prompt;
        appendSystemMessage(`Kept this chat on ${providerLabel(session.providerId)}. Its model dropdown is unchanged.`);
        renderProviderControls();
        return;
      }
    }
    starting = true;
    reconnecting = true;
    reconnectStartedAt = Date.now();
    reconnectLabel = providerChanged ? `Switching to ${providerLabel(model.providerId)}…` : "Reconnecting…";
    setWorkingIndicatorTicking(true);
    refreshControls();
    appendSystemMessage(providerChanged
      ? `Switching this chat to ${providerLabel(model.providerId)} — restarting the backend and replaying context…`
      : "Reconnecting the chat — history, context, and project mounts are kept…");
    // Send the composer model so a provider switch rebuilds the sandbox for the
    // NEW agent (resuming without it booted the OLD provider, then the turn failed
    // with a provider mismatch). Send NO workspace: the host re-mounts the
    // session's ORIGINAL persisted project roots so the revived agent can still
    // edit the project (an auto/open-folders override would remount the wrong ones).
    // Active sessions revive via reclaim (it force-takes-over + reboots); a
    // provider switch adds the model so reclaim rebuilds on the new agent. Ended/
    // failed sessions resume (which already rebuilds for the model's provider).
    const reviveResponse = isActive
      ? await request({ type: "chat.reclaim", sessionId: session.sessionId, ...(providerChanged ? { model } : {}) })
      : await request({ type: "chat.resumeSession", sessionId: session.sessionId, model });
    starting = false;
    reconnecting = false;
    if (!reviveResponse.ok) {
      setWorkingIndicatorTicking(false);
      appendSystemMessage(`Couldn't ${providerChanged ? "switch" : "reconnect"} the chat: ${reviveResponse.error.message}`, "error", true);
      refreshControls();
      return;
    }
    if (reviveResponse.payload.type === "chat.resumeSession" || reviveResponse.payload.type === "chat.reclaim") {
      upsertSession(state, reviveResponse.payload.session);
      state.providerCatalogs = [...reviveResponse.payload.providerCatalogs];
      renderHeader();
      renderProviderControls();
      renderFacts();
      ctx.persist();
    }
    setTurnActive(true);
    const sendResponse = await request({ type: "chat.sendTurn", sessionId: session.sessionId, prompt, model });
    if (!sendResponse.ok) {
      setTurnActive(false);
      appendSystemMessage(`Couldn't send: ${sendResponse.error.message}`, "error", true);
    }
  }

  /**
   * Provider change on a LIVE session restarts the backend, keeping the
   * transcript. Model changes stay in the composer and are sent with the next
   * turn as long as the provider stays the same. No live session → the selection
   * just persists for next start.
   */
  async function onSelectionChange(): Promise<void> {
    if (!state.selectedSessionId || !isSessionLiveish(state, state.selectedSessionId)) return;
    if (turnActive || backendBusy || starting) return;
    const session = currentSession(state);
    if (!session) return;
    const selection = currentModelSelection();
    const providerChanged = normalizeProviderId(session.providerId) !== selection.providerId;
    // A model-only change (same provider) needs no restart — it rides the next
    // turn. Only a provider change reboots the container, so confirm that first.
    if (!providerChanged) return;
    if (!(await confirmProviderSwitch(session.providerId, selection.providerId))) {
      renderProviderControls();
      return;
    }

    backendBusy = true;
    // Visible switching indicator + notice (was a silent dev-log line).
    reconnecting = true;
    reconnectStartedAt = Date.now();
    reconnectLabel = `Switching to ${providerLabel(selection.providerId)}…`;
    setWorkingIndicatorTicking(true);
    refreshControls();
    appendSystemMessage(`Switching this chat to ${providerLabel(selection.providerId)} — restarting the backend and replaying context…`);
    const response = await request({ type: "chat.restartBackend", sessionId: state.selectedSessionId, model: selection });
    backendBusy = false;
    reconnecting = false;
    setWorkingIndicatorTicking(false);
    if (!response.ok) {
      appendSystemMessage(`Couldn't switch to ${providerLabel(selection.providerId)}: ${response.error.message}`, "error", true);
      // Revert the selects to the session's actual provider/model.
      renderProviderControls();
      refreshControls();
      return;
    }
    if (response.payload.type === "chat.restartBackend") {
      upsertSession(state, response.payload.session);
      state.providerCatalogs = [...response.payload.providerCatalogs];
      renderHeader();
      renderProviderControls();
      renderFacts();
      ctx.persist();
    }
    appendSystemMessage(`Switched to ${providerLabel(selection.providerId)}. Send a message to continue.`);
    refreshControls();
  }

  function beginRename(): void {
    const session = currentSession(state);
    if (!session) return;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "text-input rename-input";
    input.value = session.title;
    let done = false;
    const commit = (save: boolean): void => {
      if (done) return;
      done = true;
      const title = input.value.trim();
      titleLabel.replaceChildren();
      renderHeader();
      if (save && title.length > 0 && title !== session.title) {
        void request({ type: "session.rename", sessionId: session.sessionId, title }).then((response) => {
          if (!response.ok) {
            logChat(`rename failed: ${response.error.message}`);
            return;
          }
          if (response.payload.type === "session.rename") {
            upsertSession(state, response.payload.session);
            renderHeader();
            ctx.persist();
          }
        });
      }
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); commit(true); }
      else if (event.key === "Escape") { event.preventDefault(); commit(false); }
    });
    input.addEventListener("blur", () => commit(true));
    titleWrap.replaceChildren(statusDotEl, input);
    input.focus();
    input.select();
  }

  // ---------------------------------------------------------------------------
  // Popover / menu builders
  // ---------------------------------------------------------------------------
  function buildIsolationPopover(content: HTMLElement): void {
    const iso = state.lastIsolation;
    if (iso === null) {
      const empty = el("div", "empty");
      empty.textContent = "Isolation details appear when a chat backend starts.";
      content.append(empty);
      return;
    }
    const kind = el("div", "popover-line");
    kind.textContent = `Runtime: ${iso.runtimeKind}`;
    const mountsLine = el("div", "popover-line");
    mountsLine.textContent = `Mounts: ${String(iso.mounts.length)}`;
    content.append(kind, mountsLine);
    for (const mount of iso.mounts) {
      const row = el("div", "popover-mount");
      const { text, title } = mountPathText(mount);
      row.textContent = `${mount.mode === "read-write" ? "rw" : "ro"} ${text}`;
      if (title) row.title = title;
      content.append(row);
    }
    const net = el("div", "popover-line");
    net.textContent = iso.network === "provider-scoped"
      ? `Network: provider-scoped (${iso.networkAllowlist ?? ""})`
      : "Network: none";
    content.append(net);
    content.append(buildLaunchCommandDisclosure(iso));
  }

  /**
   * Reconstructs the `sbx create` invocation the docker-sandbox adapter issued
   * for the live run, so the isolation popover can show it as copyable text
   * (CH·3). The sandbox name is not known client-side (it is composed from
   * internal session/generation ids server-side), so it is approximated from
   * the session id and called out as illustrative; the agent, workspace, and
   * mount list/flags are reconstructed exactly the way
   * DockerSandboxRuntimeAdapter.createRuntime builds them (see
   * packages/runtime-adapters/src/dockerSandboxRuntimeAdapter.ts): the
   * workspace path is the positional arg, and every other mount whose
   * hostDisplayPath differs from it is appended as `path` (read-write) or
   * `path:ro` (read-only).
   */
  function buildLaunchCommandDisclosure(iso: IsolationSummary): HTMLElement {
    const disclosure = document.createElement("details");
    disclosure.className = "launch-command-detail";
    const summary = document.createElement("summary");
    summary.textContent = "Launch command";
    disclosure.append(summary);

    const session = currentSession(state);
    const agent = session !== undefined && normalizeProviderId(session.providerId) === "claude" ? "claude" : "codex";
    const sessionId = state.selectedSessionId ?? "session";
    const sandboxName = `drydock-${sessionId.slice(0, 8)}`;
    const extraMounts = iso.mounts
      .filter((mount) => mount.hostDisplayPath !== undefined && mount.hostDisplayPath !== iso.workspaceDisplayPath)
      .map((mount) => mount.mode === "read-only" ? `${mount.hostDisplayPath}:ro` : mount.hostDisplayPath);
    const commandLine = [
      "sbx", "create", "--name", sandboxName, agent, iso.workspaceDisplayPath, ...extraMounts
    ].join(" ");

    const pre = document.createElement("pre");
    pre.className = "launch-command-pre";
    pre.textContent = commandLine;
    const caption = el("div", "launch-command-caption");
    caption.textContent = `Sandbox name is illustrative (actual name is server-assigned); agent, workspace, and mounts are exact.`;
    disclosure.append(pre, caption);
    return disclosure;
  }

  function buildOverflowMenu(content: HTMLElement): void {
    const newChat = menuItem("New chat", () => resetToNewChat());
    // A session running elsewhere is owned by another window: Restart/End/Delete
    // are refused. "Take over here" reclaims it into this window; New chat too.
    if (selectedRunsElsewhere()) {
      const note = el("div", "menu-item disabled");
      note.textContent = "Running in another window (read-only)";
      const takeOver = menuItem("Take over here", () => reclaimButton.click());
      content.append(note, takeOver, newChat);
      return;
    }
    const restart = menuItem("Restart backend", () => void restartBackendAction());
    // Resume boots a fresh backend on an ended/failed session (context replayed);
    // enabled only when the selected session is resumable.
    const resume = menuItem("Resume backend", () => void resumeBackendAction());
    const end = menuItem("End session", () => void endSessionAction());
    const openTerminal = menuItem("Open container terminal", () => void openContainerTerminalAction());
    const del = el("div", "menu-item danger");
    const deleteChat = inlineConfirmButton("Delete chat", "Confirm delete", () => void deleteSessionAction(), "ghost small danger menu-danger");
    deleteChat.title = "Delete chat (requires confirmation)";
    del.append(deleteChat);
    const session = currentSession(state);
    const live = state.selectedSessionId !== null && isSessionLiveish(state, state.selectedSessionId);
    const resumable = session !== undefined && (session.status === "ended" || session.status === "failed");
    if (!state.selectedSessionId) {
      restart.classList.add("disabled");
      resume.classList.add("disabled");
      end.classList.add("disabled");
      del.classList.add("disabled");
      deleteChat.disabled = true;
    } else {
      if (!live) {
        restart.classList.add("disabled");
        end.classList.add("disabled");
        openTerminal.classList.add("disabled");
      }
      if (!resumable || backendBusy) resume.classList.add("disabled");
    }
    content.append(restart, resume, end, openTerminal, del, newChat);
  }

  /** Opens a VS Code terminal shelled into the selected chat's live container. */
  async function openContainerTerminalAction(): Promise<void> {
    if (!state.selectedSessionId || !isSessionLiveish(state, state.selectedSessionId)) return;
    const response = await request({ type: "runtime.openTerminal", sessionId: state.selectedSessionId });
    if (!response.ok) {
      appendSystemMessage(`Couldn't open the container terminal: ${response.error.message}`, "error");
    }
  }

  function menuItem(label: string, onClick: () => void): HTMLElement {
    const item = el("button", "menu-item");
    item.textContent = label;
    item.addEventListener("click", onClick);
    return item;
  }

  async function restartBackendAction(): Promise<void> {
    if (!state.selectedSessionId || !isSessionLiveish(state, state.selectedSessionId)) return;
    backendBusy = true;
    refreshControls();
    const selection = currentModelSelection();
    logChat(`restarting backend with ${selection.providerId}${selection.model ? `/${selection.model}` : ""} — context is replayed`);
    const response = await request({ type: "chat.restartBackend", sessionId: state.selectedSessionId, model: selection });
    backendBusy = false;
    if (!response.ok) {
      logChat(`restart failed: ${response.error.message}`);
    } else if (response.payload.type === "chat.restartBackend") {
      upsertSession(state, response.payload.session);
      state.providerCatalogs = [...response.payload.providerCatalogs];
      renderHeader();
      renderProviderControls();
      renderFacts();
      ctx.persist();
    }
    refreshControls();
  }

  /**
   * Resume backend (overflow menu): boots a fresh backend on the selected
   * ended/failed session with context replayed. `backendBusy` disables the send
   * path and the menu item while the container boots (takes seconds). On success
   * the header/facts re-render off the returned session record.
   */
  async function resumeBackendAction(): Promise<void> {
    const session = currentSession(state);
    if (!session || !(session.status === "ended" || session.status === "failed")) return;
    if (backendBusy || starting || turnActive) return;
    backendBusy = true;
    refreshControls();
    logChat("resuming backend on a fresh runtime — context + original project mounts are replayed (takes a few seconds)…");
    const response = await request({
      type: "chat.resumeSession",
      sessionId: session.sessionId
    });
    backendBusy = false;
    if (!response.ok) {
      logChat(`resume failed: ${response.error.message}`);
    } else if (response.payload.type === "chat.resumeSession") {
      upsertSession(state, response.payload.session);
      state.providerCatalogs = [...response.payload.providerCatalogs];
      logChat("session resumed on a fresh backend — context replayed");
      renderHeader();
      renderProviderControls();
      renderFacts();
      ctx.persist();
    }
    refreshControls();
  }

  async function endSessionAction(): Promise<void> {
    if (!state.selectedSessionId) return;
    const response = await request({ type: "chat.endSession", sessionId: state.selectedSessionId });
    if (!response.ok) {
      logChat(`end failed: ${response.error.message}`);
      return;
    }
    if (response.payload.type === "chat.endSession") {
      upsertSession(state, response.payload.session);
      logChat("session ended; runtime removed");
      setTurnActive(false);
      renderHeader();
      renderProviderControls();
      ctx.persist();
    }
  }

  async function deleteSessionAction(): Promise<void> {
    const sessionId = state.selectedSessionId;
    if (!sessionId) return;
    const response = await request({ type: "session.delete", sessionId });
    if (!response.ok) {
      logChat(`delete failed: ${response.error.message}`);
      return;
    }
    // The host also pushes session.deleted; workTab drops it from the list.
    state.sessions = state.sessions.filter((s) => s.sessionId !== sessionId);
    resetToNewChat();
    ctx.persist();
  }

  // ---------------------------------------------------------------------------
  // Loaders
  // ---------------------------------------------------------------------------
  async function loadTimeline(sessionId: string): Promise<void> {
    const response = await request({ type: "session.timeline", sessionId });
    if (!response.ok || response.payload.type !== "session.timeline") return;
    if (state.selectedSessionId !== sessionId) return;
    state.chatMessages = [];
    runningCommands.clear();
    state.diagnostics = [];
    state.agentGroups = {};
    expandedGroups.clear();
    state.changedFiles.clear();
    activeAssistantId = null;
    // Reset before replay: applyTranscriptLine below re-accumulates reasoning
    // from this session's own stored agent.reasoning lines (via
    // appendReasoning), so without this reset a switch away from a session
    // that was mid-turn would leave its "Thinking…" leftover showing under
    // the newly selected (unrelated) session.
    reasoningText = "";
    reasoningActive = false;
    for (const line of response.payload.lines) {
      applyTranscriptLine(line, false);
      if (line.sequence > state.lastSequence) state.lastSequence = line.sequence;
    }
    activeAssistantId = null;
    renderChat();
    renderDiagnostics();
    renderChangedFiles();
    ctx.persist();
  }

  /**
   * Incremental timeline sync + SEEN SIGNAL. Requests only lines past
   * `lastSequence` (`fromSequence`), APPENDS them through the normal transcript
   * path (no transcript reset), and — as a side effect the host relies on — the
   * very act of requesting this session's timeline clears its turn attention, so
   * the activity-bar badge clears while the user watches. The tail is usually
   * empty; this stays cheap.
   */
  async function loadTimelineIncremental(sessionId: string): Promise<void> {
    const response = await request({ type: "session.timeline", sessionId, fromSequence: state.lastSequence + 1 });
    if (!response.ok || response.payload.type !== "session.timeline") return;
    // A later selection may have superseded this request; don't touch the new one.
    if (state.selectedSessionId !== sessionId) return;
    let applied = false;
    for (const line of response.payload.lines) {
      if (line.sequence <= state.lastSequence) continue;
      applyTranscriptLine(line);
      state.lastSequence = line.sequence;
      applied = true;
    }
    if (applied) ctx.persist();
  }

  async function loadDiffStatus(): Promise<void> {
    const response = await request({ type: "diff.status", ...(state.selectedSessionId ? { sessionId: state.selectedSessionId } : {}) });
    if (!response.ok) {
      logChat(`diff failed: ${response.error.message}`);
      return;
    }
    if (response.payload.type === "diff.status") {
      diffChanges = response.payload.changes;
      renderChangedFiles();
    }
  }

  // ---------------------------------------------------------------------------
  // Clone-mode sync: the Changes section is the sync surface
  // ---------------------------------------------------------------------------
  /** True when the SELECTED session is a clone-mode session (drives the Changes source). */
  function isCloneSelected(): boolean {
    return currentSession(state)?.mode === "clone";
  }

  function requireSelectedSessionId(): string {
    return state.selectedSessionId ?? "";
  }

  /**
   * Fetches per-repo clone sync state for the selected clone session and repaints
   * the Changes section. A non-clone selection clears the clone source so the two
   * data paths never overlap. Requested on selection and after every turn for it.
   */
  async function loadCloneState(): Promise<void> {
    const sessionId = state.selectedSessionId;
    if (!sessionId || !isCloneSelected()) {
      cloneRepos = [];
      renderChangedFiles();
      return;
    }
    const response = await request({ type: "clone.state", sessionId });
    // A later selection may have superseded this request; ignore stale results.
    if (state.selectedSessionId !== sessionId) return;
    if (response.ok && response.payload.type === "clone.state") {
      cloneRepos = response.payload.repos;
    } else if (!response.ok) {
      logChat(`clone state failed: ${response.error.message}`);
      cloneRepos = [];
    }
    renderChangedFiles();
    // The mounts details also lists the clones, so keep it in step.
    renderContextStrip();
  }

  /**
   * Runs one clone sync op (pull/push/discard), logs the diagnostics line from
   * the result (message + conflicted files), then refetches clone.state so the
   * rows reflect the new base. Header ops are gated while a turn runs. `label`
   * only names the op for the failure line.
   */
  async function runCloneOp(op: () => Promise<PanelResponse>, label: string): Promise<void> {
    if (turnActive) {
      logChat(`cannot ${label} while a turn is running`);
      return;
    }
    if (!state.selectedSessionId) return;
    pullAllButton.disabled = true;
    pushButton.disabled = true;
    const response = await op();
    if (!response.ok) {
      logChat(`${label} failed: ${response.error.message}`);
    } else if (response.payload.type === "clone.pull" || response.payload.type === "clone.push") {
      logCloneResult(response.payload.result);
    }
    await loadCloneState();
    refreshCloneActions();
  }

  /** Logs one diagnostics line from a sync result: its message + any conflicts. */
  function logCloneResult(result: CloneSyncResult): void {
    const conflicts = result.conflictedFiles.length > 0
      ? ` — conflicts: ${result.conflictedFiles.join(", ")}`
      : "";
    logChat(`${result.message}${conflicts}`);
  }

  /** Enables/disables the clone header buttons, mirroring the turnActive gating. */
  function refreshCloneActions(): void {
    const disabled = turnActive || cloneRepos.length === 0;
    pullAllButton.disabled = disabled;
    pushButton.disabled = turnActive;
  }

  // ---------------------------------------------------------------------------
  // Transcript logic (moved verbatim from the single-file panel)
  // ---------------------------------------------------------------------------
  function applyTranscriptLine(line: SequencedTranscriptLine | DiagnosticEntry, shouldPersist = true): void {
    const agentPath = "agentPath" in line && Array.isArray(line.agentPath) ? line.agentPath : undefined;
    const nodeId = "nodeId" in line && typeof line.nodeId === "string" ? line.nodeId : undefined;

    // Lineage routing. Spawns open a collapsible group at this point in
    // the flow; node_done closes one; everything else carrying a non-root
    // agentPath belongs INSIDE its group, never interleaved into the main log.
    if (line.eventType === "agent.spawn" && nodeId !== undefined) {
      openAgentGroup(line, nodeId, agentPath ?? [], shouldPersist);
      return;
    }
    if (line.eventType === "agent.node_done" && nodeId !== undefined) {
      closeAgentGroup(line, nodeId, shouldPersist);
      return;
    }
    if (agentPath !== undefined && agentPath.length > 0) {
      routeChildLine(line, agentPath, shouldPersist);
      return;
    }

    if (line.eventType === "user.message") {
      appendUserLine(line.summary, line.createdAt, shouldPersist);
      return;
    }
    if (line.eventType === "agent.text") {
      appendAssistantText(line.summary, "final" in line && line.final === true, line.createdAt, shouldPersist);
      return;
    }
    if (line.eventType === "agent.reasoning") {
      appendReasoning(line.summary, shouldPersist);
      return;
    }
    if (line.eventType === "agent.error") {
      // Surface the failure in the chat, not just the Diagnostics feed. The
      // detail (when present) carries the real reason; fall back to the summary.
      const detail = "detail" in line && typeof line.detail === "string" && line.detail.length > 0 ? line.detail : line.summary;
      appendSystemMessage(`The agent hit an error: ${detail}`, "error", true);
      appendDiagnostic(diagnosticFromLine(line), shouldPersist);
      return;
    }
    if (line.eventType === "agent.command") {
      // The shell commands the agent runs in the container are the "docker shell"
      // activity — render them inline (a dev needs to watch them), not just in
      // the hidden Diagnostics feed. Still diagnose for the flat debug truth.
      appendCommand(line);
      appendDiagnostic(diagnosticFromLine(line), shouldPersist);
      return;
    }
    if (line.eventType === "agent.file_edit") {
      const filePath = "filePath" in line && typeof line.filePath === "string"
        ? line.filePath
        : line.summary.split(" ").slice(1).join(" ");
      const changeKind = "fileChangeKind" in line && typeof line.fileChangeKind === "string"
        ? line.fileChangeKind
        : line.summary.split(" ")[0] ?? "update";
      if (filePath) {
        state.changedFiles.set(filePath, changeKind);
        renderChangedFiles();
      }
    }
    appendDiagnostic(diagnosticFromLine(line), shouldPersist);
    if (line.eventType === "agent.done") {
      activeAssistantId = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Subagent groups: lineage-attributed lines collect into collapsible
  // blocks anchored where the spawn happened. Diagnostics still receives every
  // line (prefixed by owner label) as the flat debug truth.
  // ---------------------------------------------------------------------------

  /** Carries the structured lineage fields into the flat Diagnostics feed. */
  function diagnosticFromLine(line: SequencedTranscriptLine | DiagnosticEntry, prefix?: string): DiagnosticEntry {
    return {
      createdAt: line.createdAt,
      eventType: line.eventType,
      summary: prefix === undefined ? line.summary : `[${prefix}] ${line.summary}`,
      ...("agentPath" in line && Array.isArray(line.agentPath) && line.agentPath.length > 0 ? { agentPath: line.agentPath } : {}),
      ...("nodeId" in line && typeof line.nodeId === "string" ? { nodeId: line.nodeId } : {}),
      ...("label" in line && typeof line.label === "string" ? { label: line.label } : {}),
      ...("subagentType" in line && typeof line.subagentType === "string" ? { subagentType: line.subagentType } : {}),
      ...("model" in line && typeof line.model === "string" ? { model: line.model } : {}),
      ...("nodeStatus" in line && typeof line.nodeStatus === "string" ? { nodeStatus: line.nodeStatus } : {}),
      ...("toolStatus" in line && typeof line.toolStatus === "string" ? { toolStatus: line.toolStatus } : {}),
      ...("commandName" in line && typeof line.commandName === "string" ? { commandName: line.commandName } : {}),
      ...("detail" in line && typeof line.detail === "string" ? { detail: line.detail } : {}),
      ...("usage" in line && line.usage !== undefined ? { usage: line.usage } : {})
    };
  }

  /** Group lookup that synthesizes missing nodes (and ancestors) instead of dropping. */
  function ensureAgentGroup(nodeId: string, parentPath: readonly string[], createdAt: string): AgentGroup {
    const existing = state.agentGroups[nodeId];
    if (existing !== undefined) return existing;
    let parentNodeId: string | undefined;
    if (parentPath.length > 0) {
      const parentId = parentPath[parentPath.length - 1] as string;
      ensureAgentGroup(parentId, parentPath.slice(0, -1), createdAt);
      parentNodeId = parentId;
    }
    const group: AgentGroup = {
      nodeId,
      ...(parentNodeId === undefined ? {} : { parentNodeId }),
      label: `agent ${nodeId.slice(-8)}`,
      status: "running",
      toolCalls: 0,
      commands: 0,
      fileEdits: 0,
      errors: 0,
      createdAt,
      entries: [],
      children: []
    };
    state.agentGroups[nodeId] = group;
    if (parentNodeId === undefined) {
      state.chatMessages.push({ id: nextMessageId("group"), role: "group", createdAt, text: "", nodeId });
    } else {
      const parent = state.agentGroups[parentNodeId];
      if (parent !== undefined && !parent.children.includes(nodeId)) parent.children.push(nodeId);
    }
    return group;
  }

  function openAgentGroup(line: SequencedTranscriptLine | DiagnosticEntry, nodeId: string, parentPath: readonly string[], shouldPersist: boolean): void {
    const group = ensureAgentGroup(nodeId, parentPath, line.createdAt);
    if ("label" in line && typeof line.label === "string") group.label = line.label;
    if ("subagentType" in line && typeof line.subagentType === "string") group.subagentType = line.subagentType;
    if ("model" in line && typeof line.model === "string") group.model = line.model;
    if ("detail" in line && typeof line.detail === "string") group.promptPreview = line.detail;
    group.lastActivity = line.summary;
    group.lastActivityAt = line.createdAt;
    appendDiagnostic(diagnosticFromLine(line), shouldPersist);
    renderChat();
    if (shouldPersist) ctx.persist();
  }

  function closeAgentGroup(line: SequencedTranscriptLine | DiagnosticEntry, nodeId: string, shouldPersist: boolean): void {
    const group = ensureAgentGroup(nodeId, [], line.createdAt);
    const status = "nodeStatus" in line ? line.nodeStatus : undefined;
    if (group.status === "running" && (status === "completed" || status === "failed" || status === "cancelled")) {
      group.status = status;
      group.endedAt = line.createdAt;
    }
    if ("detail" in line && typeof line.detail === "string") group.resultPreview = line.detail;
    if ("usage" in line && line.usage !== undefined) group.usage = line.usage;
    group.lastActivity = line.summary;
    group.lastActivityAt = line.createdAt;
    appendDiagnostic(diagnosticFromLine(line, group.label), shouldPersist);
    renderChat();
    if (shouldPersist) ctx.persist();
  }

  function routeChildLine(line: SequencedTranscriptLine | DiagnosticEntry, agentPath: readonly string[], shouldPersist: boolean): void {
    const nodeId = agentPath[agentPath.length - 1] as string;
    const group = ensureAgentGroup(nodeId, agentPath.slice(0, -1), line.createdAt);
    const toolStatus = "toolStatus" in line ? line.toolStatus : undefined;
    if (line.eventType === "agent.tool_call" && toolStatus === "started") group.toolCalls += 1;
    if (line.eventType === "agent.command" && toolStatus === "started") group.commands += 1;
    if ((line.eventType === "agent.tool_call" || line.eventType === "agent.command")
      && "commandName" in line
      && typeof line.commandName === "string") {
      group.lastCommand = line.commandName;
    }
    if (line.eventType === "agent.error") group.errors += 1;
    if (line.eventType === "agent.file_edit") {
      group.fileEdits += 1;
      // Child edits land in the SAME runtime/workspace: the working set owns them too.
      const filePath = "filePath" in line && typeof line.filePath === "string" ? line.filePath : undefined;
      const changeKind = "fileChangeKind" in line && typeof line.fileChangeKind === "string" ? line.fileChangeKind : "update";
      if (filePath !== undefined) {
        state.changedFiles.set(filePath, changeKind);
        renderChangedFiles();
      }
    }
    group.lastActivity = line.summary;
    group.lastActivityAt = line.createdAt;
    group.entries.push({
      createdAt: line.createdAt,
      eventType: line.eventType,
      summary: line.summary,
      ...("detail" in line && typeof line.detail === "string" ? { detail: line.detail } : {}),
      ...(line.eventType === "agent.text" ? { prose: true } : {})
    });
    if (group.entries.length > AGENT_GROUP_ENTRY_CAP) group.entries.shift();
    appendDiagnostic(diagnosticFromLine(line, group.label), shouldPersist);
    renderChat();
    if (shouldPersist) ctx.persist();
  }

  function appendAssistantText(text: string, final: boolean, createdAt: string, shouldPersist = true): void {
    sawAssistantTextThisTurn = true;
    const currentIndex = activeAssistantId === null
      ? -1
      : state.chatMessages.findIndex((message) => message.id === activeAssistantId);
    if (currentIndex === -1) {
      const id = nextMessageId("assistant");
      activeAssistantId = final ? null : id;
      state.chatMessages.push({ id, role: "assistant", createdAt, text, ...(final ? {} : { streaming: true }) });
    } else {
      const current = state.chatMessages[currentIndex];
      if (current === undefined) return;
      const nextText = final ? text : `${current.text}${text}`;
      state.chatMessages[currentIndex] = final
        ? { id: current.id, role: current.role, createdAt: current.createdAt, text: nextText }
        : { ...current, text: nextText, streaming: true };
      if (final) activeAssistantId = null;
    }
    renderChat();
    if (shouldPersist) ctx.persist();
  }

  /**
   * Accumulates streamed agent.reasoning text into the live "Thinking"
   * disclosure (see workingIndicatorRow). Not persisted into
   * state.chatMessages — it is a live-turn affordance only, so a reload
   * loses in-flight reasoning the same way it already loses the working
   * indicator itself; the shouldPersist param is accepted for symmetry with
   * the other appendX functions (replay calls it with false).
   */
  function appendReasoning(text: string, shouldPersist = true): void {
    reasoningActive = true;
    reasoningText += text;
    if (turnActive && transcriptView === "log") {
      const existing = chatLog.querySelector(".chat-working, .chat-reasoning");
      if (existing) existing.replaceWith(workingIndicatorRow());
      else renderChat(false);
    }
    void shouldPersist;
  }

  function appendUserLine(prompt: string, createdAt = new Date().toISOString(), shouldPersist = true): void {
    state.chatMessages.push({ id: nextMessageId("user"), role: "user", createdAt, text: prompt });
    activeAssistantId = null;
    renderChat();
    if (shouldPersist) ctx.persist();
  }

  /**
   * A visible in-transcript notice. Turn errors, stopped/empty turns, and send
   * failures used to land only in the hidden Diagnostics feed — so a chat that
   * did nothing looked stuck with no explanation. This surfaces them inline.
   */
  function appendSystemMessage(text: string, tone: "error" | "info" = "info", retry = false): void {
    // Only offer Retry when we actually have a prompt to resend.
    const canRetry = retry && lastSentPrompt !== null;
    // A Docker Sandbox (host session) auth failure gets a one-click sbx sign-in.
    const signIn = /sbx login|not authenticated|Docker Sandbox session|no valid user session|secret not found/i.test(text);
    // A PROVIDER auth failure — the agent itself isn't signed in for the sandbox
    // (Claude "Not logged in · Please run /login", Codex 401) — gets a one-click
    // "Authenticate <provider>" button that runs the provider's sbx-secret login.
    const providerAuth = !signIn && /not logged in|please run \/login|authentication_failed|apikeysource\W+none|invalid api key|401 unauthorized|needs[- ]login/i.test(text);
    const authProviderId = providerAuth ? selectedProviderId() : undefined;
    state.chatMessages.push({
      id: nextMessageId("system"),
      role: "system",
      createdAt: new Date().toISOString(),
      text,
      tone,
      ...(canRetry ? { retry: true } : {}),
      ...(signIn ? { signIn: true } : {}),
      ...(providerAuth ? { authenticate: true, ...(authProviderId === undefined ? {} : { authProviderId }) } : {})
    });
    activeAssistantId = null;
    renderChat();
    ctx.persist();
  }

  /** Provider of the selected session, falling back to the composer's choice. */
  function selectedProviderId(): string {
    const session = currentSession(state);
    return normalizeProviderId(session ? session.providerId : providerSelect.value);
  }

  /** Human label for a provider id (we only support claude and codex). */
  function providerLabel(providerId: string): string {
    const normalized = normalizeProviderId(providerId);
    if (normalized === "claude") return "Claude";
    if (normalized === "codex") return "Codex";
    return providerId.length > 0 ? providerId : "provider";
  }

  /** Re-sends the last submitted prompt (the Retry button on an error notice). */
  function retryLastTurn(): void {
    if (lastSentPrompt === null || turnActive || starting || backendBusy) return;
    promptInput.value = lastSentPrompt;
    void onSend();
  }

  /**
   * Renders a shell command the agent ran, coalescing its started→terminal
   * events into one row that gains an exit code + captured output. The summary
   * is `<cmd> [<status>[ exit N]]`; we split the command text from the suffix so
   * the row reads like a terminal line.
   */
  function appendCommand(line: SequencedTranscriptLine | DiagnosticEntry): void {
    const summary = line.summary;
    const status = "toolStatus" in line && (line.toolStatus === "started" || line.toolStatus === "completed" || line.toolStatus === "failed")
      ? line.toolStatus
      : "started";
    const commandText = summary.replace(/\s*\[[^\]]*\]\s*$/, "").trim() || summary;
    const exitMatch = /exit (-?\d+)/.exec(summary);
    const commandExit = exitMatch ? Number(exitMatch[1]) : undefined;
    const output = "detail" in line && typeof line.detail === "string" && line.detail.length > 0 ? line.detail : undefined;

    const existingId = runningCommands.get(commandText);
    const existingIndex = existingId === undefined ? -1 : state.chatMessages.findIndex((message) => message.id === existingId);
    const id = existingIndex >= 0 ? state.chatMessages[existingIndex]!.id : nextMessageId("command");
    const message: ChatMessage = {
      id,
      role: "command",
      createdAt: line.createdAt,
      text: commandText,
      commandStatus: status,
      ...(commandExit === undefined ? {} : { commandExit }),
      ...(output === undefined ? {} : { commandOutput: output })
    };
    if (existingIndex >= 0) {
      state.chatMessages[existingIndex] = message;
    } else {
      state.chatMessages.push(message);
    }
    if (status === "started") {
      runningCommands.set(commandText, id);
    } else {
      runningCommands.delete(commandText);
    }
    renderChat();
    ctx.persist();
  }

  function appendDiagnostic(entry: DiagnosticEntry, shouldPersist = true): void {
    state.diagnostics.push(entry);
    renderDiagnostics();
    if (shouldPersist) ctx.persist();
  }

  function logChat(summary: string): void {
    appendDiagnostic({ createdAt: new Date().toISOString(), eventType: "panel", summary });
  }

  function setTurnActive(next: boolean): void {
    const changed = turnActive !== next;
    turnActive = next;
    turnStartedAt = next ? Date.now() : undefined;
    // Seed last-activity to turn start; transcript pushes bump it as output arrives.
    if (next) lastActivityAt = Date.now();
    setWorkingIndicatorTicking(next);
    refreshControls();
    renderHeader();
    // Only the transcript's working-indicator visibility changed here, and only
    // when the flag actually flipped (avoids clobbering an in-progress render).
    if (changed) renderChat(false);
  }

  // ---------------------------------------------------------------------------
  // Rendering (textContent only for dynamic data)
  // ---------------------------------------------------------------------------
  function renderHeader(): void {
    const session = currentSession(state);
    // pendingSessionStart wins outright: a caller switched here ahead of a NEW
    // session landing, so any still-selected PREVIOUS session must not show
    // through (it would look like the new chat reused the old one).
    if (pendingSessionStart) {
      titleLabel.textContent = "Starting…";
    } else {
      titleLabel.textContent = session ? session.title : "New chat";
    }
    // Hierarchy: a small muted line above the title naming the parent task,
    // shown only when the selected session belongs to a subtask (the main
    // title already shows the subtask's own name via session.title). A
    // session linked directly to a task (no subtask) shows no parent line —
    // the title already names it.
    const parentTitle = pendingSessionStart ? undefined : subtaskParentTitleForSelectedSession();
    titleParentLabel.textContent = parentTitle ?? "";
    titleParentLabel.classList.toggle("hidden", parentTitle === undefined);
    // Status dot: starting / running (turn active) / live / offline / none.
    let stateClass = "state-ended";
    let label = "no chat selected";
    if (pendingSessionStart) {
      stateClass = "state-running";
      label = "starting the chat backend";
    } else if (session && isSessionLiveish(state, session.sessionId)) {
      if (turnActive) { stateClass = "state-running"; label = "turn in progress"; }
      else { stateClass = "state-live"; label = "live"; }
    } else if (session !== undefined) {
      // Selected but its backend is not live here (ended, or lost on reload).
      // Not a lock — sending a message reconnects it with its context.
      stateClass = "state-offline";
      label = "offline — send a message to reconnect";
    }
    statusDotEl.className = `status-dot ${stateClass}`;
    statusDotEl.title = label;
    statusDotEl.setAttribute("aria-label", label);
    titleWrap.replaceChildren(statusDotEl, titleTextWrap);
  }

  /**
   * FIX 3: finds the subtask (if any) whose `linkedSessionIds` includes the
   * selected session, by scanning `state.tasks[].subtasks[]`, and returns its
   * parent task's title for display above the main title (which already shows
   * the subtask's own name via session.title). Returns undefined when the
   * selected session is not a subtask session (a plain task-linked session
   * already shows its name as the main title; nothing extra to add above it).
   */
  function subtaskParentTitleForSelectedSession(): string | undefined {
    const sessionId = state.selectedSessionId;
    if (sessionId === null) return undefined;
    for (const task of state.tasks) {
      for (const subtask of task.subtasks) {
        if (subtask.linkedSessionIds.includes(sessionId)) return task.title;
      }
    }
    return undefined;
  }

  /**
   * Mounts <details>: a "1 mount · rw" style summary; expanding lists each mount
   * (mode chip + runtimePath ← hostDisplayPath). Before a session starts, the
   * summary shows the upcoming context ("Auto: <folders>" / set name / no mounts)
   * and expanding lists the planned sandbox mount path when workspace state is
   * available.
   */
  function renderContextStrip(): void {
    mountsBody.replaceChildren();
    const iso = state.lastIsolation;
    const live = state.selectedSessionId !== null && isSessionLiveish(state, state.selectedSessionId);
    // Clone session: no live root mounts — the mounts details lists the clones
    // (`clone: <name>@<branch>`) plus a "no live mounts" note. Reuses cloneRepos
    // from the clone.state fetch the Changes section already drives.
    if (isCloneSelected()) {
      mountsSummary.textContent = `${String(cloneRepos.length)} clone${cloneRepos.length === 1 ? "" : "s"} · no live mounts`;
      for (const repo of cloneRepos) {
        const row = el("div", "context-mount-row");
        const chipEl = el("span", "chip mode-clone");
        chipEl.textContent = "clone";
        const label = el("span", "context-mount-path");
        label.textContent = `${repo.name}@${repo.branch}`;
        row.append(chipEl, label);
        mountsBody.append(row);
      }
      const note = el("div", "empty");
      note.textContent = "no live mounts — changes reach you through sync";
      mountsBody.append(note);
      return;
    }
    if (live && iso !== null) {
      const rw = iso.mounts.some((m) => m.mode === "read-write");
      mountsSummary.textContent = `${String(iso.mounts.length)} mount${iso.mounts.length === 1 ? "" : "s"} · ${rw ? "rw" : "ro"}`;
      if (iso.mounts.length === 0) {
        const empty = el("div", "empty");
        empty.textContent = "No mounts.";
        mountsBody.append(empty);
        return;
      }
      appendMountRows(iso.mounts);
      return;
    }
    // Before a session starts: the summary shows the upcoming context.
    const plannedMounts = plannedWorkspaceMounts();
    if (state.selectedWorkspaceSetId) {
      const set = state.workspacePolicy?.workspaceSets.find((s) => s.workspaceSetId === state.selectedWorkspaceSetId);
      mountsSummary.textContent = set ? `Set: ${set.name}` : "Set selected";
    } else if (state.openFolderNames.length > 0) {
      mountsSummary.textContent = `Auto: ${state.openFolderNames.join(", ")}`;
    } else {
      mountsSummary.textContent = "No mounts";
    }
    if (plannedMounts.length === 0) {
      const empty = el("div", "empty");
      empty.textContent = state.openFolderNames.length > 0 || state.selectedWorkspaceSetId
        ? "Workspace mappings will appear after projects are registered."
        : "No workspace folders selected.";
      mountsBody.append(empty);
      return;
    }
    appendMountRows(plannedMounts, "planned");
  }

  function appendMountRows(mounts: readonly DisplayMount[], prefix?: string): void {
    for (const mount of mounts) {
      const row = el("div", "context-mount-row");
      const modeChip = el("span", `chip mode-${mount.mode === "read-write" ? "read-write" : "read-only"}`);
      modeChip.textContent = mount.mode === "read-write" ? "rw" : "ro";
      const path = el("span", "context-mount-path");
      const { text, title } = mountPathText(mount, prefix);
      path.textContent = text;
      if (title) path.title = title;
      row.append(modeChip, path);
      mountsBody.append(row);
    }
  }

  function plannedWorkspaceMounts(): DisplayMount[] {
    const names = plannedWorkspaceProjectNames();
    const mode = state.composerMode === "plan" ? "read-only" : "read-write";
    return names.map((name) => {
      const project = state.workspacePolicy?.projects.find((candidate) => candidate.name === name);
      const hostDisplayPath = project?.displayPath ?? name;
      return {
        runtimePath: hostPathToSandboxPath(hostDisplayPath),
        mode,
        hostDisplayPath
      };
    });
  }

  /**
   * Client mirror of core's sandboxRuntimePath: the real in-container mount
   * point for a host folder (`H:\a\b` → `/h/a/b`). Used for the pre-start mount
   * preview so the advertised path matches where sbx actually mounts it.
   */
  function hostPathToSandboxPath(hostPath: string): string {
    const drive = /^([A-Za-z]):[\\/]?(.*)$/.exec(hostPath);
    if (drive) {
      return `/${drive[1]!.toLowerCase()}/${(drive[2] ?? "").replace(/\\/g, "/")}`;
    }
    return hostPath.replace(/\\/g, "/");
  }

  /**
   * FIX 2: true when a mount's runtime path IS the sandbox mirror of its host
   * path — i.e. "directly available" at the location a user would expect from
   * the host path, so the `← hostDisplayPath` arrow would be pure noise. This
   * is the common case (auto-mounted project roots); only an approved mount
   * placed somewhere else in the sandbox genuinely needs the arrow.
   */
  function mountIsDirectlyAvailable(mount: DisplayMount): boolean {
    return mount.hostDisplayPath === undefined || hostPathToSandboxPath(mount.hostDisplayPath) === mount.runtimePath;
  }

  /**
   * FIX 2: the mount-line text (mode chip aside) — `<runtimePath>` alone when
   * directly available (with a "direct" marker via title/suffix), else
   * `<runtimePath> ← <hostDisplayPath>` when they genuinely differ.
   */
  function mountPathText(mount: DisplayMount, prefix?: string): { text: string; title?: string } {
    const lead = prefix ? `${prefix} · ` : "";
    if (mountIsDirectlyAvailable(mount)) {
      return { text: `${lead}${mount.runtimePath} · direct`, title: "mounted at its host location" };
    }
    return { text: `${lead}${mount.runtimePath} ← ${mount.hostDisplayPath ?? ""}` };
  }

  function plannedWorkspaceProjectNames(): string[] {
    if (state.selectedWorkspaceSetId) {
      const set = state.workspacePolicy?.workspaceSets.find((candidate) => candidate.workspaceSetId === state.selectedWorkspaceSetId);
      return [...(set?.projectNames ?? [])];
    }
    return [...state.openFolderNames];
  }

  function renderProviderControls(preserveSelection = true): void {
    const previousProvider = normalizeProviderId(providerSelect.value || state.providerId);
    const previousModel = preserveSelection ? (modelSelect.value || state.selectedModel) : "";
    const selectedSession = currentSession(state);
    const selectedSessionProvider = selectedSession === undefined ? "" : normalizeProviderId(selectedSession.providerId);
    const desiredProvider = normalizeProviderId(preserveSelection ? selectedSessionProvider || previousProvider : previousProvider);
    providerSelect.replaceChildren();
    const catalogs = state.providerCatalogs.length === 0 ? [fallbackCatalog()] : state.providerCatalogs;
    for (const catalog of catalogs) {
      providerSelect.append(option(catalog.providerId, catalog.displayName));
    }
    providerSelect.value = catalogs.some((catalog) => normalizeProviderId(catalog.providerId) === desiredProvider)
      ? (catalogs.find((catalog) => normalizeProviderId(catalog.providerId) === desiredProvider)?.providerId ?? desiredProvider)
      : catalogs[0]?.providerId ?? state.providerId;
    state.providerId = normalizeProviderId(providerSelect.value);

    const catalog = catalogs.find((candidate) => normalizeProviderId(candidate.providerId) === normalizeProviderId(providerSelect.value)) ?? catalogs[0];
    modelSelect.replaceChildren();
    if (catalog === undefined || catalog.models.length === 0) {
      modelSelect.append(option("", "Start backend to load models"));
      modelSelect.disabled = true;
    } else {
      modelSelect.disabled = false;
      for (const model of catalog.models) {
        const node = option(model.id, model.displayName);
        if (model.description) node.title = model.description;
        modelSelect.append(node);
      }
      const selectedProvider = normalizeProviderId(providerSelect.value);
      const sameProviderAsSession = selectedSessionProvider === selectedProvider;
      const manualModel = manualModelSessionId === state.selectedSessionId ? state.selectedModel || previousModel : "";
      const selectedModel = manualModel || (sameProviderAsSession ? selectedSession?.model ?? "" : "") || previousModel;
      const defaultModel = catalog.models.find((model) => model.isDefault)?.id ?? catalog.models[0]?.id ?? "";
      modelSelect.value = catalog.models.some((model) => model.id === selectedModel) ? selectedModel : defaultModel;
      state.selectedModel = modelSelect.value;
    }

    thinkingSelect.value = state.thinkingEffort;
    renderModelButton();
    renderAuthBanner();
    refreshControls();
  }

  /** Syncs the composer's model button label to the (hidden) select values. */
  function renderModelButton(): void {
    const catalogs = state.providerCatalogs.length === 0 ? [fallbackCatalog()] : state.providerCatalogs;
    const providerId = normalizeProviderId(providerSelect.value);
    const catalog = catalogs.find((candidate) => normalizeProviderId(candidate.providerId) === providerId);
    const providerName = catalog?.displayName ?? providerLabel(providerId);
    const model = catalog?.models.find((candidate) => candidate.id === modelSelect.value);
    const modelName = model?.displayName ?? (modelSelect.value || "default");
    modelButton.replaceChildren();
    const label = el("span", "composer-model-label");
    // Button shows just the model name (compact); provider lives in the tree.
    label.textContent = catalog === undefined ? "Model" : modelName;
    modelButton.title = catalog === undefined ? "Choose a model" : `Model: ${providerName} · ${modelName}`;
    modelButton.append(label, modelButtonChevron);
  }

  /**
   * Applies a (provider, model) pick from the model tree by driving the hidden
   * selects and reusing their change handlers — a provider change fires the
   * confirm-and-restart flow (onSelectionChange), a same-provider change just
   * records the model for the next turn.
   */
  function selectModelFromTree(providerId: string, modelId: string): void {
    const normalized = normalizeProviderId(providerId);
    const providerChanged = normalizeProviderId(providerSelect.value) !== normalized;
    if (providerChanged) {
      providerSelect.value = catalogProviderValue(normalized);
      manualModelSessionId = null;
      renderProviderControls(false);
    }
    // Set the model after any provider rebuild so it isn't clobbered by the
    // provider's default; mark it manual so the next turn carries it.
    if ([...modelSelect.options].some((opt) => opt.value === modelId)) {
      modelSelect.value = modelId;
      state.selectedModel = modelId;
      manualModelSessionId = state.selectedSessionId;
    }
    renderModelButton();
    ctx.persist();
    if (providerChanged) void onSelectionChange();
  }

  /** The catalog's own casing for a normalized provider id (for the select value). */
  function catalogProviderValue(normalizedProviderId: string): string {
    const catalogs = state.providerCatalogs.length === 0 ? [fallbackCatalog()] : state.providerCatalogs;
    return catalogs.find((candidate) => normalizeProviderId(candidate.providerId) === normalizedProviderId)?.providerId
      ?? normalizedProviderId;
  }

  /**
   * Builds the model popup tree: every registered provider as a group, its
   * models beneath, the current one checked. Auth state and refresh source are
   * surfaced as small hints; picking a model routes through selectModelFromTree.
   */
  function buildModelTree(content: HTMLElement, close: () => void): void {
    const catalogs = state.providerCatalogs.length === 0 ? [fallbackCatalog()] : state.providerCatalogs;
    const activeProvider = normalizeProviderId(providerSelect.value);
    const activeModel = modelSelect.value;
    for (const catalog of catalogs) {
      const providerId = normalizeProviderId(catalog.providerId);
      const group = el("div", "model-tree-group");
      const groupHead = el("div", "model-tree-provider");
      const name = el("span", "model-tree-provider-name");
      name.textContent = catalog.displayName;
      groupHead.append(name);
      if (catalog.authStatus === "needs-login") {
        const hint = el("span", "model-tree-auth");
        hint.textContent = "needs login";
        groupHead.append(hint);
      }
      group.append(groupHead);
      const models = catalog.models.filter((model) => !model.hidden);
      if (models.length === 0) {
        const empty = el("div", "model-tree-empty");
        empty.textContent = catalog.source === "fallback" ? "start a chat to load models" : "no models";
        group.append(empty);
      }
      for (const model of models) {
        const row = el("button", "model-tree-model");
        const isActive = providerId === activeProvider && model.id === activeModel;
        if (isActive) row.classList.add("active");
        const check = el("span", "model-tree-check");
        check.textContent = isActive ? "✓" : "";
        const modelName = el("span", "model-tree-model-name");
        modelName.textContent = model.displayName;
        row.append(check, modelName);
        if (model.description) row.title = model.description;
        row.addEventListener("click", () => {
          selectModelFromTree(catalog.providerId, model.id);
          close();
        });
        group.append(row);
      }
      content.append(group);
    }
  }

  /**
   * Keys off the selected provider only. Normalize IDs on both sides; if no
   * catalog matches the selected provider, show NO banner (never fall back to
   * another provider's catalog).
   */
  function renderAuthBanner(): void {
    const selected = normalizeProviderId(providerSelect.value);
    const catalog = state.providerCatalogs.find((c) => normalizeProviderId(c.providerId) === selected);
    if (catalog === undefined || catalog.authStatus !== "needs-login") {
      authBanner.classList.add("hidden");
      return;
    }
    authBannerText.textContent = `${catalog.displayName} is not signed in for the sandbox. Log in to start chats${catalog.loginHint ? ` (runs: ${catalog.loginHint})` : ""}.`;
    authBanner.classList.remove("hidden");
  }

  function renderChat(pinToBottom = true): void {
    // The lens strip appears once a session is selected; the spawn-role
    // control only for live-in-this-window sessions (a child needs a live
    // parent to inherit mounts from).
    const session = currentSession(state);
    // pendingSessionStart wins outright — see renderHeader for why a stale
    // previously-selected session must not show through here either.
    lensStrip.classList.toggle("hidden", pendingSessionStart || session === undefined);
    spawnRoleSelect.classList.add("hidden");
    if (transcriptView === "agents") renderAgentsLens();
    chatLog.replaceChildren();
    if (pendingSessionStart) {
      chatLog.append(startingPlaceholder());
      return;
    }
    if (state.chatMessages.length === 0 && !turnActive && !reasoningActive) {
      // Empty transcript orients the first-run user: a call to action plus a dim
      // line naming the two composer modes. Clone remains a transfer/sync
      // detail for clone sessions, not a first-run chat mode.
      const empty = el("div", "chat-empty");
      const lead = el("div", "chat-empty-lead");
      lead.textContent = "Ask the isolated agent to start.";
      const modes = el("div", "chat-empty-modes");
      modes.textContent = "Plan = read-only · Develop = edits your files (read-write)";
      empty.append(lead, modes);
      chatLog.append(empty);
      return;
    }
    for (const message of state.chatMessages) {
      chatLog.append(chatMessageRow(message));
    }
    // FIX 4: while a turn is running, a bottom-of-transcript activity
    // indicator fills the gap between turnStarted and the first streamed
    // output (previously blank — looked stuck). Removed as soon as the turn
    // ends (setTurnActive(false) re-renders without it) UNLESS reasoning was
    // captured this turn, in which case its disclosure persists (collapsed,
    // relabeled "Thought for Ns") until the next turn starts.
    if (turnActive) chatLog.append(workingIndicatorRow());
    else if (reconnecting) chatLog.append(reconnectingIndicatorRow());
    else if (reasoningActive) chatLog.append(reasoningDisclosure(false));
    // Keep the scrollable chat body pinned to the newest entry as it grows/streams.
    if (pinToBottom) chatScroll.scrollTop = chatScroll.scrollHeight;
  }

  /**
   * FIX 1: centered placeholder shown in place of the transcript while a
   * caller has switched to Chat before chat.startSession resolved (no session
   * to render yet). A rotating-border spinner (CSS) plus a short caption;
   * `.spinner` falls back to a static ring under prefers-reduced-motion.
   */
  function startingPlaceholder(): HTMLElement {
    const wrap = el("div", "chat-starting");
    const spinner = el("div", "spinner");
    const caption = el("div", "chat-starting-caption");
    caption.textContent = "Starting the chat backend…";
    wrap.append(spinner, caption);
    return wrap;
  }

  /**
   * FIX 4 (+ reasoning follow-up): activity indicator appended at the bottom
   * of the transcript for the duration of a running turn, filling the gap
   * between turnStarted and the first streamed output. Reasoning (agent.text
   * "thinking" — Claude thinking blocks, Codex reasoning items) is now
   * captured as agent.reasoning events (see applyTranscriptLine/
   * appendReasoning above); when any has arrived this turn, the indicator
   * becomes the live "Thinking" disclosure instead of the generic dots row,
   * so the minutes-long silent gap on a long turn shows real progress rather
   * than just "working…".
   */
  function workingIndicatorRow(): HTMLElement {
    if (reasoningActive) return reasoningDisclosure(true);
    const row = el("div", "chat-working");
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    const elapsed = turnStartedAt === undefined ? 0 : Math.max(0, Math.floor((Date.now() - turnStartedAt) / 1000));
    // Primary signal is time since the last streamed output: a value that keeps
    // climbing means the turn is running but silent (a likely hang). Total
    // elapsed lives in the tooltip.
    const sinceLast = lastActivityAt === undefined ? elapsed : Math.max(0, Math.floor((Date.now() - lastActivityAt) / 1000));
    row.title = `${String(elapsed)}s since this turn started`;
    const label = el("span", "chat-working-label");
    if (reducedMotion) {
      // No pulsing dots under reduced motion — a static label only.
      label.textContent = `Working… (${String(sinceLast)}s since last output)`;
      row.append(label);
    } else {
      const dots = el("span", "chat-working-dots");
      dots.append(el("span", "dot"), el("span", "dot"), el("span", "dot"));
      label.textContent = `Assistant is working… (${String(sinceLast)}s since last output)`;
      row.append(dots, label);
    }
    // After a sustained silence, offer a gentle nudge instead of leaving the user
    // to guess whether it's stuck. The poke is a graceful interrupt (not a kill).
    if (sinceLast >= POKE_AFTER_SECONDS) {
      row.append(pokeButton());
    }
    return row;
  }

  /** "Give it a poke?" — a soft turn/interrupt to try to break a quiet standoff. */
  function pokeButton(): HTMLElement {
    const btn = button("Give it a poke?", "small chat-poke");
    btn.title = "Nudge the agent with a graceful interrupt to try to break a standoff — the session and container stay alive.";
    btn.addEventListener("click", () => {
      const sessionId = state.selectedSessionId;
      if (!sessionId) return;
      btn.disabled = true;
      btn.textContent = "Poking…";
      void request({ type: "chat.poke", sessionId }).then((response) => {
        if (!response.ok) {
          btn.disabled = false;
          btn.textContent = "Give it a poke?";
          logChat(`poke failed: ${response.error.message}`);
          return;
        }
        if (response.payload.type === "chat.poke" && response.payload.poked) {
          appendSystemMessage("Poked the agent — asked it to wrap up the current step. Give it a moment; if nothing changes, Stop the turn or End the session.");
        } else {
          appendSystemMessage("Nothing to poke here — the turn isn't live in this window. Try Stop, or send again to reconnect.");
        }
      });
    });
    return btn;
  }

  /**
   * Live, collapsible "Thinking" block: streams accumulated agent.reasoning
   * text as it arrives, collapsed by default so it never dominates the
   * transcript (the user opts in to reading it). `live` selects the summary
   * label ("Thinking… (Ns)" while the turn runs vs. "Thought for Ns" once it
   * ends) and whether the pulsing dots render — CSS handles the
   * prefers-reduced-motion fallback the same way workingIndicatorRow does.
   * Content renders via textContent only (CSP): no markdown, just the raw
   * reasoning stream.
   */
  function reasoningDisclosure(live: boolean): HTMLElement {
    const details = document.createElement("details");
    details.className = "chat-reasoning";
    const summary = document.createElement("summary");
    const elapsed = turnStartedAt === undefined ? 0 : Math.max(0, Math.floor((Date.now() - turnStartedAt) / 1000));
    const label = el("span", "chat-reasoning-label");
    label.textContent = live ? `Thinking… (${String(elapsed)}s)` : `Thought for ${String(elapsed)}s`;
    summary.append(label);
    if (live) {
      const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
      if (!reducedMotion) {
        const dots = el("span", "chat-working-dots");
        dots.append(el("span", "dot"), el("span", "dot"), el("span", "dot"));
        summary.append(dots);
      }
    }
    details.append(summary);
    const body = el("pre", "chat-reasoning-body");
    body.textContent = reasoningText;
    details.append(body);
    return details;
  }

  /** Whole seconds since an ISO timestamp, floored at zero. */
  function secondsSince(iso: string): number {
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return 0;
    return Math.max(0, Math.floor((Date.now() - then) / 1000));
  }

  function stopRawStreamPolling(): void {
    if (rawStreamTimer !== undefined) {
      window.clearInterval(rawStreamTimer);
      rawStreamTimer = undefined;
    }
  }

  /**
   * Fetches the selected session's current-turn raw buffer and renders it.
   * Keeps the view pinned to the bottom unless the user has scrolled up to read
   * earlier output (the live tail is where a hang shows).
   */
  async function pollRawStream(): Promise<void> {
    const sessionId = state.selectedSessionId;
    if (!sessionId) {
      rawStreamBody.textContent = "No chat selected.";
      rawStreamMeta.textContent = "";
      return;
    }
    const response = await request({ type: "chat.rawStream", sessionId });
    if (!response.ok || response.payload.type !== "chat.rawStream") return;
    // The selection may have changed while the request was in flight.
    if (state.selectedSessionId !== sessionId) return;
    const { text, lastChunkAt } = response.payload;
    const atBottom = rawStreamBody.scrollHeight - rawStreamBody.scrollTop - rawStreamBody.clientHeight < 40;
    rawStreamBody.textContent = text.length === 0
      ? "No raw output captured yet — send a message to start a turn."
      : text;
    if (atBottom) rawStreamBody.scrollTop = rawStreamBody.scrollHeight;
    rawStreamMeta.textContent = lastChunkAt === null ? "" : `· ${String(secondsSince(lastChunkAt))}s since last output`;
  }

  /**
   * Live indicator shown while a reconnect (resume/reclaim) boots a fresh runtime,
   * before the turn can start streaming. Without it the "Reconnecting…" notice
   * just sat there with no sign of progress. Elapsed climbs each second; past ~20s
   * it adds a reassurance that starting a sandbox can take a moment.
   */
  function reconnectingIndicatorRow(): HTMLElement {
    const row = el("div", "chat-working chat-reconnecting");
    const elapsed = reconnectStartedAt === undefined ? 0 : Math.max(0, Math.floor((Date.now() - reconnectStartedAt) / 1000));
    const suffix = elapsed >= 45
      ? " — still trying; if it doesn't recover, End the session or reload the window"
      : elapsed >= 20
        ? " — starting the sandbox can take a bit"
        : "";
    const text = `${reconnectLabel} (${String(elapsed)}s)${suffix}`;
    const label = el("span", "chat-working-label");
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    if (reducedMotion) {
      label.textContent = text;
      row.append(label);
      return row;
    }
    const dots = el("span", "chat-working-dots");
    dots.append(el("span", "dot"), el("span", "dot"), el("span", "dot"));
    label.textContent = text;
    row.append(dots, label);
    return row;
  }

  // --- sandbox usage bar (pinned below the transcript) -----------------------
  let sandboxStatsInFlight = false;
  function renderSandboxStats(stats: RuntimeStatsSummary | null): void {
    // null = no running sandbox for this session → hide entirely.
    if (stats === null) {
      sandboxStatsBar.classList.add("hidden");
      sandboxStatsBar.replaceChildren();
      return;
    }
    const label = el("span", "sandbox-stats-label");
    label.textContent = "sandbox";
    const value = el("span", "sandbox-stats-value");
    if (!stats.available) {
      // Running, but the host couldn't measure it (non-Windows, or the probe
      // failed) — show the bar so it's visible rather than silently absent.
      value.textContent = "usage unavailable";
    } else {
      const parts = [
        `CPU ${stats.cpuPercent === null ? "…" : `${String(Math.round(stats.cpuPercent))}%`}`,
        `mem ${stats.memBytes === null ? "—" : formatStatBytes(stats.memBytes)}`,
        `IO ↓${formatStatRate(stats.ioReadBytesPerSec)} ↑${formatStatRate(stats.ioWriteBytesPerSec)}`
      ];
      if (stats.threads !== null) parts.push(`${String(stats.threads)} thr`);
      value.textContent = parts.join("  ·  ");
    }
    sandboxStatsBar.replaceChildren(label, value);
    sandboxStatsBar.classList.remove("hidden");
  }
  async function pollSandboxStats(): Promise<void> {
    if (sandboxStatsInFlight) return;
    const sessionId = state.selectedSessionId;
    // Only gate on being on the Chat tab with a session selected; the backend
    // returns null when there's no running sandbox, which hides the bar. (Do NOT
    // gate on isSessionLiveish — a running runtime can exist even when the
    // window's `live` flag is momentarily stale, which was hiding the bar.)
    if (state.activeTab !== "chat" || !sessionId) {
      renderSandboxStats(null);
      return;
    }
    sandboxStatsInFlight = true;
    try {
      const response = await request({ type: "chat.runtimeStats", sessionId });
      if (response.ok && response.payload.type === "chat.runtimeStats" && state.selectedSessionId === sessionId) {
        renderSandboxStats(response.payload.stats);
      }
    } finally {
      sandboxStatsInFlight = false;
    }
  }
  window.setInterval(() => void pollSandboxStats(), 2_500);

  function formatStatBytes(bytes: number): string {
    if (bytes < 1024) return `${String(Math.round(bytes))} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} ${units[unit]}`;
  }
  function formatStatRate(bytesPerSec: number | null): string {
    if (bytesPerSec === null) return "…";
    if (bytesPerSec < 1) return "0";
    return `${formatStatBytes(bytesPerSec)}/s`;
  }

  /** Starts/stops the 1s tick that keeps the working / reconnecting indicator fresh. */
  function setWorkingIndicatorTicking(active: boolean): void {
    if (workingIndicatorTimer !== undefined) {
      window.clearInterval(workingIndicatorTimer);
      workingIndicatorTimer = undefined;
    }
    if (active) {
      workingIndicatorTimer = window.setInterval(() => {
        if ((!turnActive && !reconnecting) || transcriptView !== "log") return;
        const existing = chatLog.querySelector(".chat-working, .chat-reasoning");
        if (existing) existing.replaceWith(turnActive ? workingIndicatorRow() : reconnectingIndicatorRow());
      }, 1_000);
    }
  }

  /**
   * A dev-log entry. User turns are a compact tinted card; assistant turns are
   * FULL-WIDTH structural markdown blocks (no bubble). Both carry a small dim
   * meta line. While streaming, a subtle cursor affordance sits after the body.
   */
  function chatMessageRow(message: ChatMessage): HTMLElement {
    if (message.role === "group") {
      return message.nodeId !== undefined && state.agentGroups[message.nodeId] !== undefined
        ? agentGroupBlock(message.nodeId)
        : el("div", "chat-message role-group empty");
    }
    if (message.role === "system") {
      // A visible in-transcript notice: turn errors, stopped/empty turns, and
      // send failures that used to vanish into the Diagnostics feed.
      const row = el("div", `chat-message role-system${message.tone === "error" ? " tone-error" : ""}`);
      const body = el("div", "chat-system-body");
      body.textContent = message.text;
      row.append(body);
      if (message.signIn === true) {
        const signInButton = button("Sign in to Docker Sandbox", "small primary chat-system-signin");
        signInButton.addEventListener("click", () => {
          void request({ type: "runtime.sbxLogin" }).then((response) => {
            if (!response.ok) logChat(`sbx login failed to launch: ${response.error.message}`);
            else appendSystemMessage("Opened a terminal running `sbx login`. Complete the sign-in, then reload the window and send again.");
          });
        });
        row.append(signInButton);
      }
      if (message.authenticate === true) {
        const providerId = message.authProviderId ?? selectedProviderId();
        const authButton = button(`Authenticate ${providerLabel(providerId)}`, "small primary chat-system-signin");
        authButton.addEventListener("click", () => {
          authButton.disabled = true;
          void request({ type: "provider.login", providerId }).then((response) => {
            authButton.disabled = false;
            if (!response.ok) {
              logChat(`login failed to launch: ${response.error.message}`);
              return;
            }
            appendSystemMessage(
              normalizeProviderId(providerId) === "claude"
                ? "Opened a terminal running Claude in a sandbox. Type /login there to sign in (a browser opens), then close the terminal and click Retry."
                : `Opened a terminal to sign ${providerLabel(providerId)} in for the sandbox. Complete the OAuth flow, then click Retry or send again.`
            );
          });
        });
        row.append(authButton);
      }
      if (message.retry === true) {
        const retryButton = button("Retry", "small chat-system-retry");
        retryButton.addEventListener("click", () => retryLastTurn());
        row.append(retryButton);
      }
      return row;
    }
    if (message.role === "command") {
      const row = el("div", `chat-message role-command status-${message.commandStatus ?? "started"}`);
      const commandLine = el("div", "chat-command-line");
      const promptGlyph = el("span", "chat-command-prompt");
      promptGlyph.textContent = "$";
      const commandText = el("span", "chat-command-text");
      commandText.textContent = message.text;
      const statusChip = el("span", "chat-command-status");
      statusChip.textContent = message.commandStatus === "started"
        ? "running…"
        : message.commandStatus === "failed"
          ? `failed${message.commandExit === undefined ? "" : ` · exit ${String(message.commandExit)}`}`
          : `exit ${message.commandExit === undefined ? "0" : String(message.commandExit)}`;
      commandLine.append(promptGlyph, commandText, statusChip);
      row.append(commandLine);
      if (message.commandOutput !== undefined && message.commandOutput.length > 0) {
        const lineCount = message.commandOutput.replace(/\n+$/, "").split("\n").length;
        const output = document.createElement("details");
        output.className = "chat-command-output";
        // Short output shows inline; anything over 3 lines collapses by default.
        output.open = lineCount <= 3;
        const summary = document.createElement("summary");
        summary.textContent = lineCount <= 3 ? "output" : `output (${String(lineCount)} lines)`;
        const pre = document.createElement("pre");
        pre.textContent = message.commandOutput;
        output.append(summary, pre);
        row.append(output);
      }
      return row;
    }
    const streaming = message.streaming === true;
    const row = el("div", `chat-message role-${message.role}${streaming ? " streaming" : ""}`);
    const meta = el("div", "chat-meta");
    meta.textContent = `${message.role === "user" ? "You" : authorLabel()} · ${formatTime(message.createdAt)}`;
    row.append(meta);

    if (message.role === "user") {
      const body = el("div", "chat-user-body");
      appendUserMessageBody(body, message.text);
      row.append(body);
    } else {
      const body = el("div", "chat-assistant-body");
      // Structural markdown: mermaid fences render as sanitized diagrams here.
      for (const block of splitBlocks(message.text, "markdown")) {
        body.append(assistantBlock(block));
      }
      if (streaming) body.append(el("span", "stream-cursor"));
      row.append(body);
    }
    return row;
  }

  /**
   * CH·10: assistant meta label. "Orchestrator" names the role (agent types
   * land later); the model comes from the current session's provider catalog
   * (falling back to the session's raw model id, then omitted entirely).
   */
  function authorLabel(): string {
    const session = currentSession(state);
    const model = session === undefined ? undefined : displayModelName(session.providerId, session.model);
    return model === undefined ? "Orchestrator" : `Orchestrator · ${model}`;
  }

  /** Model id → catalog display name for the given provider; raw id if no catalog match. */
  function displayModelName(providerId: string, model: string | undefined): string | undefined {
    if (model === undefined || model === "") return undefined;
    const catalog = state.providerCatalogs.find((c) => normalizeProviderId(c.providerId) === normalizeProviderId(providerId));
    return catalog?.models.find((candidate) => candidate.id === model)?.displayName ?? model;
  }

  const HOST_BRIEFING_START = "[host briefing]";
  const HOST_BRIEFING_END = "[end host briefing]";

  /**
   * CH·5: a user message's first turn is host-prefixed with a
   * `[host briefing]` … `[end host briefing]` block (see
   * packages/core/src/accessRequestProtocol.ts buildSessionBriefing). Splits it
   * out into a collapsed `<details>` ("Host briefing") so the transcript leads
   * with what the user actually typed; falls back to the plain render when the
   * delimiters are not both present (robust to older/replayed messages).
   */
  function appendUserMessageBody(container: HTMLElement, text: string): void {
    const startIdx = text.indexOf(HOST_BRIEFING_START);
    const endIdx = startIdx === -1 ? -1 : text.indexOf(HOST_BRIEFING_END, startIdx + HOST_BRIEFING_START.length);
    if (startIdx === -1 || endIdx === -1) {
      appendTextWithFileTokens(container, text);
      return;
    }
    const briefingText = text.slice(startIdx, endIdx + HOST_BRIEFING_END.length);
    const remainder = `${text.slice(0, startIdx)}${text.slice(endIdx + HOST_BRIEFING_END.length)}`.trim();

    const disclosure = document.createElement("details");
    disclosure.className = "host-briefing-detail";
    const summary = document.createElement("summary");
    summary.textContent = "Host briefing";
    const pre = document.createElement("pre");
    pre.className = "host-briefing-pre";
    pre.textContent = briefingText;
    disclosure.append(summary, pre);
    container.append(disclosure);

    if (remainder.length > 0) {
      const rest = el("div", "host-briefing-remainder");
      appendTextWithFileTokens(rest, remainder);
      container.append(rest);
    }
  }

  function appendTextWithFileTokens(container: HTMLElement, text: string): void {
    const tokenRe = /\[(file|file-unmounted):([^\]\r\n]+)\]/g;
    let cursor = 0;
    for (const match of text.matchAll(tokenRe)) {
      const start = match.index ?? 0;
      if (start > cursor) container.append(document.createTextNode(text.slice(cursor, start)));
      const kind = match[1] === "file-unmounted" ? "file-unmounted" : "file";
      const path = decodeFilePathToken(match[2] ?? "");
      const chip = el("span", `chat-file-token ${kind === "file-unmounted" ? "unmounted" : ""}`.trim());
      chip.textContent = `[${fileDisplayName(path)}]`;
      chip.title = fileTokenTitle(kind, path);
      container.append(chip);
      cursor = start + match[0].length;
    }
    if (cursor < text.length) container.append(document.createTextNode(text.slice(cursor)));
  }

  function fileTokenTitle(kind: "file" | "file-unmounted", path: string): string {
    if (kind === "file-unmounted") return `host: ${path}\nnot mounted in the container`;
    const hostPath = hostPathForRuntimePath(path);
    return hostPath === null ? `container: ${path}` : `container: ${path}\nhost: ${hostPath}`;
  }

  function fileDisplayName(path: string): string {
    const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
    return normalized.split("/").filter(Boolean).pop() ?? path;
  }

  /**
   * One subagent's collapsible group block. Collapsed by default —
   * the header ticks live (status, counts, last activity) so a resting log
   * stays scannable; expanding reveals the child's own dev-log, nested child
   * groups (depth-N), the prompt it was given, and its result. All dynamic
   * strings are agent-authored → textContent only, everywhere.
   */
  function agentGroupBlock(nodeId: string): HTMLElement {
    const group = state.agentGroups[nodeId] as AgentGroup;
    const details = document.createElement("details");
    details.className = `agent-group status-${group.status}`;
    details.id = `agent-group-${nodeId}`;
    if (expandedGroups.has(nodeId)) details.open = true;
    details.addEventListener("toggle", () => {
      if (details.open) expandedGroups.add(nodeId);
      else expandedGroups.delete(nodeId);
    });

    const summary = document.createElement("summary");
    summary.className = "agent-group-header";
    const dot = el("span", `agent-group-dot status-${group.status}`);
    const label = el("span", "agent-group-label");
    label.textContent = `⑂ ${group.label}`;
    summary.append(dot, label);
    if (group.subagentType !== undefined || group.model !== undefined) {
      const type = el("span", "agent-group-type");
      type.textContent = group.subagentType ?? group.model ?? "";
      summary.append(type);
    }
    const stats = el("span", "agent-group-stats");
    const calls = group.toolCalls + group.commands;
    const parts: string[] = [];
    parts.push(durationLabel(group.createdAt, group.endedAt));
    const tokens = usageTokens(group.usage);
    if (tokens !== null) parts.push(`${formatTokenCount(tokens)} tokens`);
    if (calls > 0) parts.push(`${String(calls)} tool use${calls === 1 ? "" : "s"}`);
    if (group.fileEdits > 0) parts.push(`${String(group.fileEdits)} file${group.fileEdits === 1 ? "" : "s"}`);
    if (group.lastCommand !== undefined) parts.push(group.lastCommand);
    stats.textContent = parts.join(" · ");
    summary.append(stats);
    // R1 vocabulary: failure is the loud chip; completion stays quiet.
    if (group.status === "failed") {
      const chip = el("span", "agent-group-chip chip-failed");
      chip.textContent = "· failed";
      summary.append(chip);
    } else if (group.status === "completed") {
      const chip = el("span", "agent-group-chip chip-done");
      chip.textContent = "✓";
      summary.append(chip);
    } else if (group.status === "running" && isIdleSince(group.lastActivityAt ?? group.createdAt)) {
      const chip = el("span", "agent-group-chip chip-idle");
      chip.textContent = `idle ${durationLabel(group.lastActivityAt ?? group.createdAt, undefined)}`;
      summary.append(chip);
    } else if (group.status === "running" && group.lastActivity !== undefined) {
      const activity = el("span", "agent-group-activity");
      activity.textContent = group.lastActivity;
      summary.append(activity);
    }
    details.append(summary);

    const body = el("div", "agent-group-body");
    if (group.promptPreview !== undefined) {
      const prompt = el("div", "agent-group-prompt");
      prompt.textContent = `asked: ${group.promptPreview}`;
      body.append(prompt);
    }
    if (group.entries.length === 0 && sessionSubagentTier() === "lifecycle") {
      const note = el("div", "agent-group-note");
      note.textContent = "This transport reports subagent lifecycle only — no per-agent feed.";
      body.append(note);
    }
    for (const entry of group.entries) {
      if (entry.prose === true) {
        const prose = el("div", "agent-group-prose");
        for (const block of splitBlocks(entry.summary, "markdown")) {
          prose.append(assistantBlock(block));
        }
        body.append(prose);
      } else {
        const row = el("div", `agent-group-entry kind-${entry.eventType.replace(/\./g, "-")}`);
        const meta = el("span", "diagnostic-meta");
        meta.textContent = `${formatTime(entry.createdAt)} `;
        const text = el("span", "diagnostic-text");
        text.textContent = entry.summary;
        row.append(meta, text);
        if (entry.detail !== undefined && entry.detail.length > 0 && entry.detail !== entry.summary) {
          const disclosure = document.createElement("details");
          disclosure.className = "agent-entry-detail";
          const dSummary = document.createElement("summary");
          dSummary.textContent = "output";
          const pre = document.createElement("pre");
          pre.className = "agent-entry-detail-pre";
          pre.textContent = entry.detail;
          disclosure.append(dSummary, pre);
          row.append(disclosure);
        }
        body.append(row);
      }
    }
    for (const childId of group.children) {
      if (state.agentGroups[childId] !== undefined) {
        body.append(agentGroupBlock(childId));
      }
    }
    if (group.resultPreview !== undefined) {
      const result = el("div", "agent-group-result");
      result.textContent = `result: ${group.resultPreview}`;
      body.append(result);
    }
    if (tokens !== null) {
      const usageRow = el("div", "agent-group-usage");
      usageRow.textContent = `${formatTokenCount(tokens)} tokens`;
      body.append(usageRow);
    }
    details.append(body);
    return details;
  }

  /**
   * The Agents lens: the same feed as Chat, viewed hierarchy-first.
   * Native subagents come from the contracts tree reducer over the structured
   * diagnostics; product-owned role sessions graft in from the
   * session list as `role-session` rows. Clicking a native node jumps to its
   * expanded Chat group; clicking a role session opens that session.
   */
  function renderAgentsLens(): void {
    agentsLens.replaceChildren();
    const session = currentSession(state);
    if (session === undefined) {
      const empty = el("div", "agents-lens-empty");
      empty.textContent = "No session selected.";
      agentsLens.append(empty);
      return;
    }
    const tree = reduceAgentTree(state.diagnostics.map(treeSourceFromDiagnostic));
    const tier = sessionSubagentTier();
    const byParent = new Map<string | undefined, AgentTreeNode[]>();
    for (const node of tree.nodes) {
      const list = byParent.get(node.parentId) ?? [];
      list.push(node);
      byParent.set(node.parentId, list);
    }
    const depthByNode = new Map<string, number>();
    const assignDepth = (node: AgentTreeNode, depth: number): void => {
      depthByNode.set(node.nodeId, depth);
      for (const child of byParent.get(node.nodeId) ?? []) assignDepth(child, depth + 1);
    };
    const root = tree.nodes.find((node) => node.kind === "root");
    if (root !== undefined) {
      assignDepth(root, 0);
      agentsLens.append(rootAgentCard(root, session));
    }

    const nativeNodes = tree.nodes.filter((node) => node.kind === "native");
    const roleChildren = state.sessions.filter((candidate) => candidate.parentSessionId === session.sessionId);
    const runningNative = nativeNodes.filter((node) => node.status === "running");
    const finishedNative = nativeNodes.filter((node) => node.status !== "running");
    const runningRoles = roleChildren.filter((child) => child.status === "active" || child.status === "starting");
    const finishedRoles = roleChildren.filter((child) => child.status !== "active" && child.status !== "starting");

    renderAgentSection(
      "Running",
      [...runningNative.map((node) => nativeAgentCard(node, depthByNode.get(node.nodeId) ?? 1)), ...runningRoles.map(roleAgentCard)],
      true
    );
    renderAgentSection(
      `Finished ${String(finishedNative.length + finishedRoles.length)}`,
      [...finishedNative.map((node) => nativeAgentCard(node, depthByNode.get(node.nodeId) ?? 1)), ...finishedRoles.map(roleAgentCard)],
      false
    );

    if (tree.nodes.length <= 1 && roleChildren.length === 0) {
      const empty = el("div", "agents-lens-empty");
      empty.textContent = tier === "none"
        ? "This session's transport does not report subagent activity (or it was recorded before subagent tracking)."
        : "No delegated agents this session. Fan-outs will appear here as a tree.";
      agentsLens.append(empty);
    } else if (tier === "lifecycle") {
      const note = el("div", "agents-lens-empty");
      note.textContent = "Lifecycle-tier transport: spawn, status and result are tracked — per-agent feeds are not reported.";
      agentsLens.append(note);
    }
  }

  function renderAgentSection(title: string, cards: readonly HTMLElement[], open: boolean): void {
    if (cards.length === 0) return;
    if (open) {
      const section = el("div", "agent-task-section");
      const heading = el("div", "agent-task-section-title");
      heading.textContent = title;
      section.append(heading, ...cards);
      agentsLens.append(section);
      return;
    }
    const details = document.createElement("details");
    details.className = "agent-task-section agent-task-section-collapsible";
    const summary = document.createElement("summary");
    summary.className = "agent-task-section-title";
    summary.textContent = title;
    details.append(summary, ...cards);
    agentsLens.append(details);
  }

  function rootAgentCard(node: AgentTreeNode, session: ChatSessionSummary): HTMLElement {
    const displayStatus = node.status === "running" && !turnActive ? "completed" : node.status;
    const card = el("div", `agent-task-card root agent-status-${displayStatus}`);
    const title = el("div", "agent-task-title");
    title.textContent = `${session.providerId}${session.model === undefined ? "" : `/${session.model}`}`;
    const meta = el("div", "agent-task-meta");
    meta.textContent = agentMetaLine("Agent", node);
    card.append(title, meta);
    if (node.lastActivity !== undefined) {
      const activity = el("div", "agent-task-activity");
      activity.textContent = node.lastActivity;
      card.append(activity);
    }
    return card;
  }

  function nativeAgentCard(node: AgentTreeNode, depth: number): HTMLElement {
    const idle = node.status === "running" && isIdleSince(node.lastActivityAt ?? node.startedAt);
    const card = el("div", `agent-task-card agent-status-${node.status}${idle ? " idle" : ""}`);
    card.style.marginLeft = `${String(Math.max(0, depth - 1) * 12)}px`;
    const title = el("div", "agent-task-title-row");
    const label = el("span", "agent-task-title");
    label.textContent = node.label;
    title.append(label);
    if (node.subagentType !== undefined || node.model !== undefined) {
      const type = el("span", "agent-task-type");
      type.textContent = node.subagentType ?? node.model ?? "";
      title.append(type);
    }
    const status = agentStatusChip(node.status, idle, node.lastActivityAt ?? node.startedAt);
    if (status !== null) title.append(status);

    const meta = el("div", "agent-task-meta");
    meta.textContent = agentMetaLine("Agent", node);
    const actions = el("div", "agent-task-actions");
    const transcript = button("View transcript", "link-button agent-task-link");
    transcript.addEventListener("click", (event) => {
      event.stopPropagation();
      expandedGroups.add(node.nodeId);
      setTranscriptView("log");
      renderChat();
      document.getElementById(`agent-group-${node.nodeId}`)?.scrollIntoView({ block: "center" });
    });
    actions.append(transcript);
    card.append(title, meta, actions);
    if (node.lastActivity !== undefined && node.status === "running") {
      const activity = el("div", "agent-task-activity");
      activity.textContent = node.lastActivity;
      card.append(activity);
    }
    return card;
  }

  function roleAgentCard(session: ChatSessionSummary): HTMLElement {
    const running = session.status === "active" || session.status === "starting";
    const card = el("div", `agent-task-card role-session agent-status-${running ? "running" : session.status === "failed" ? "failed" : "completed"}`);
    const title = el("div", "agent-task-title-row");
    const label = el("span", "agent-task-title");
    label.textContent = session.title;
    const type = el("span", "agent-task-type");
    type.textContent = `${session.spawnedRole ?? "role"} session`;
    title.append(label, type);
    const meta = el("div", "agent-task-meta");
    const end = running ? undefined : session.updatedAt;
    meta.textContent = `Agent · ${durationLabel(session.createdAt, end)} · ${session.status}`;
    const actions = el("div", "agent-task-actions");
    const transcript = button("View transcript", "link-button agent-task-link");
    transcript.addEventListener("click", (event) => {
      event.stopPropagation();
      selectSession(session.sessionId);
    });
    actions.append(transcript);
    card.append(title, meta, actions);
    return card;
  }

  function agentMetaLine(kind: string, node: AgentTreeNode): string {
    const bits = [kind, durationLabel(node.startedAt ?? new Date().toISOString(), node.endedAt)];
    const tokens = usageTokens(node.usage);
    if (tokens !== null) bits.push(`${formatTokenCount(tokens)} tokens`);
    const tools = toolUseCount(node);
    if (tools > 0) bits.push(`${String(tools)} tool use${tools === 1 ? "" : "s"}`);
    if (node.lastCommand !== undefined) bits.push(node.lastCommand);
    return bits.join(" · ");
  }

  function agentStatusChip(status: AgentTreeNode["status"], idle: boolean, lastActivityAt: string | undefined): HTMLElement | null {
    if (status === "failed") {
      const chip = el("span", "agent-task-chip chip-failed");
      chip.textContent = "failed";
      return chip;
    }
    if (status === "completed") {
      const chip = el("span", "agent-task-chip chip-done");
      chip.textContent = "done";
      return chip;
    }
    if (idle && lastActivityAt !== undefined) {
      const chip = el("span", "agent-task-chip chip-idle");
      chip.textContent = `idle ${durationLabel(lastActivityAt, undefined)}`;
      return chip;
    }
    return null;
  }

  /** Subagent reporting tier for the SELECTED session's transport. */
  function sessionSubagentTier(): string {
    const transport = currentSession(state)?.transport;
    return transport === undefined ? "none" : subagentReportingForTransport(transport);
  }

  function treeSourceFromDiagnostic(entry: DiagnosticEntry): AgentTreeSource {
    const source = treeSourceFromLine(entry);
    if (entry.agentPath !== undefined && entry.agentPath.length > 0) {
      return { ...source, summary: entry.summary.replace(/^\[[^\]]+\]\s+/, "") };
    }
    return source;
  }

  function hasLiveAgentRows(): boolean {
    return Object.values(state.agentGroups).some((group) => group.status === "running");
  }

  function isIdleSince(iso: string | undefined): boolean {
    if (iso === undefined) return false;
    const last = Date.parse(iso);
    return Number.isFinite(last) && Date.now() - last >= state.agentIdleThresholdMs;
  }

  function toolUseCount(node: AgentTreeNode): number {
    return node.counts.toolCalls + node.counts.commands + node.counts.fileEdits;
  }

  function durationLabel(startedAt: string, endedAt: string | undefined): string {
    const end = endedAt === undefined ? Date.now() : new Date(endedAt).getTime();
    const seconds = Math.max(0, Math.round((end - new Date(startedAt).getTime()) / 1000));
    if (seconds < 60) return `${String(seconds)}s`;
    return `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`;
  }

  function formatTokenCount(tokens: number): string {
    if (tokens < 1_000) return String(tokens);
    if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
    return `${(tokens / 1_000_000).toFixed(1)}m`;
  }

  /** Duck-typed total tokens from a transport usage object, else null. */
  function usageTokens(usage: unknown): number | null {
    if (typeof usage !== "object" || usage === null) return null;
    const record = usage as Record<string, unknown>;
    if (typeof record["totalTokens"] === "number") return record["totalTokens"];
    const total = record["total"];
    if (typeof total === "object" && total !== null && typeof (total as Record<string, unknown>)["totalTokens"] === "number") {
      return (total as Record<string, unknown>)["totalTokens"] as number;
    }
    return null;
  }

  function codeBlockFigure(block: DocBlock, label?: string, extraClass = ""): HTMLElement {
    const classes = ["md-code"];
    if (extraClass.length > 0) classes.push(extraClass);
    const figure = el("div", classes.join(" "));
    const header = el("div", "md-code-header");
    const badge = el("span", "md-code-badge");
    badge.textContent = label ?? (block.language && block.language.length > 0 ? block.language : "code");
    const copy = iconButton("⧉", "Copy code", "md-code-copy");
    copy.addEventListener("click", () => copyText(block.text, copy));
    header.append(badge, copy);
    const pre = document.createElement("pre");
    pre.className = "md-pre";
    const code = document.createElement("code");
    code.textContent = block.text;
    pre.append(code);
    figure.append(header, pre);
    return figure;
  }

  function mermaidBlock(block: DocBlock): HTMLElement {
    const placeholder = el("div", "md-mermaid-placeholder");
    placeholder.textContent = "rendering diagram...";
    const source = block.text.replace(MERMAID_DIRECTIVE_RE, "").trim();
    mermaidRenderSequence += 1;
    const renderId = `chat-mermaid-${String(Date.now())}-${String(mermaidRenderSequence)}`;

    void loadMermaid()
      .then((api) => api.render(renderId, source))
      .then((result) => {
        if (!placeholder.isConnected) return;
        const svg = adoptSanitizedSvg(document, result.svg);
        if (svg === null) {
          placeholder.replaceWith(mermaidFallback(block, "This diagram could not be displayed; showing its source."));
          return;
        }
        placeholder.replaceWith(mermaidFigure(svg, block));
      })
      .catch(() => {
        if (!placeholder.isConnected) return;
        placeholder.replaceWith(mermaidFallback(block, "This diagram could not be rendered; showing its source."));
      });

    return placeholder;
  }

  function mermaidFigure(svg: SVGSVGElement, block: DocBlock): HTMLElement {
    const figure = el("figure", "md-mermaid-figure");
    const toolbar = el("div", "md-code-header md-mermaid-header");
    const badge = el("span", "md-code-badge md-mermaid-badge");
    badge.textContent = "diagram";
    const copy = iconButton("⧉", "Copy mermaid source", "md-code-copy");
    copy.addEventListener("click", () => copyText(block.text, copy));
    const toggle = iconButton("</>", "Show mermaid source", "md-mermaid-toggle");
    toolbar.append(badge, copy, toggle);

    const svgWrap = el("div", "md-mermaid-svg-wrap");
    svgWrap.append(svg);
    const sourceView = document.createElement("pre");
    sourceView.className = "md-pre md-mermaid-source hidden";
    const code = document.createElement("code");
    code.textContent = block.text;
    sourceView.append(code);

    toggle.addEventListener("click", () => {
      const showingSource = !sourceView.classList.contains("hidden");
      sourceView.classList.toggle("hidden", showingSource);
      svgWrap.classList.toggle("hidden", !showingSource);
      badge.textContent = showingSource ? "diagram" : "mermaid";
      const nextLabel = showingSource ? "Show mermaid source" : "Show diagram";
      toggle.textContent = showingSource ? "</>" : "▧";
      toggle.title = nextLabel;
      toggle.setAttribute("aria-label", nextLabel);
    });

    figure.append(toolbar, svgWrap, sourceView);
    return figure;
  }

  function mermaidFallback(block: DocBlock, message: string): HTMLElement {
    const wrap = el("div", "md-mermaid-fallback");
    wrap.append(codeBlockFigure(block, "mermaid"));
    const error = el("div", "md-mermaid-error");
    error.textContent = message;
    wrap.append(error);
    return wrap;
  }

  function copyText(text: string, copyButton: HTMLButtonElement): void {
    const original = copyButton.textContent ?? "Copy";
    const mark = (label: string): void => {
      copyButton.textContent = label;
      window.setTimeout(() => {
        copyButton.textContent = original;
      }, 1_500);
    };
    void (async () => {
      try {
        if (text.length <= MAX_CLIPBOARD_LENGTH) {
          const response = await request({ type: "clipboard.writeText", text });
          if (response.ok && response.payload.type === "clipboard.writeText") {
            mark("✓");
            return;
          }
        }
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
          } else {
            fallbackCopyText(text);
          }
        } catch {
          fallbackCopyText(text);
        }
        mark("✓");
      } catch {
        mark("!");
      }
    })();
  }

  function fallbackCopyText(text: string): void {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("copy failed");
  }

  /**
   * Inline markdown → DOM: links (clickable — file refs open in the editor,
   * http(s) in the browser), inline code, bold, italic. Everything else stays a
   * plain text node (CSP-safe: no innerHTML). Code fences are handled separately.
   */
  function appendInline(parent: HTMLElement, text: string): void {
    const pattern = /\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|(?:\*|_)([^*_\s][^*_]*?)(?:\*|_)/g;
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > last) parent.append(document.createTextNode(text.slice(last, match.index)));
      if (match[1] !== undefined && match[2] !== undefined) {
        parent.append(inlineLink(match[1], match[2]));
      } else if (match[3] !== undefined) {
        const code = el("code", "md-inline-code");
        code.textContent = match[3];
        parent.append(code);
      } else if (match[4] !== undefined) {
        const strong = document.createElement("strong");
        strong.textContent = match[4];
        parent.append(strong);
      } else if (match[5] !== undefined) {
        const em = document.createElement("em");
        em.textContent = match[5];
        parent.append(em);
      }
      last = pattern.lastIndex;
    }
    if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
  }

  /** A clickable markdown link; the host decides file-open vs. external. */
  function inlineLink(label: string, href: string): HTMLElement {
    const anchor = el("a", "md-link") as HTMLAnchorElement;
    anchor.textContent = label;
    anchor.href = "#";
    anchor.title = href;
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      void request({ type: "chat.openFile", path: href });
    });
    return anchor;
  }

  /** Builds one structural markdown block as DOM (inline markdown + textContent leaves). */
  function assistantBlock(block: DocBlock): HTMLElement {
    switch (block.kind) {
      case "heading": {
        const level = Math.min(block.level ?? 1, 4);
        const heading = el(`h${String(level)}`, "md-heading");
        appendInline(heading, block.text);
        return heading;
      }
      case "list": {
        const ul = el("ul", "md-list");
        for (const item of block.items ?? []) {
          const li = el("li");
          appendInline(li, item);
          ul.append(li);
        }
        return ul;
      }
      case "code":
        return codeBlockFigure(block);
      case "mermaid":
        return mermaidBlock(block);
      case "paragraph":
      default: {
        const p = el("p", "md-paragraph");
        appendInline(p, block.text);
        return p;
      }
    }
  }

  /**
   * Renders attention around the selected transcript. Access requests stay
   * inline with the log; open questions are hoisted to their own fixed slot
   * outside the transcript scroller and hidden when none are pending.
   */
  const accessAttentionCursor = { index: 0 };
  const questionAttentionCursor = { index: 0 };
  function renderAccessCards(): void {
    accessCardsWrap.replaceChildren();
    questionCardsWrap.replaceChildren();
    questionCardsWrap.classList.add("hidden");
    if (!state.selectedSessionId) return;
    const accessItems = sessionAccessItems(state.selectedSessionId);
    const questionItems = sessionQuestionItems(state.selectedSessionId);
    renderAttentionStack(accessCardsWrap, accessItems, accessAttentionCursor, {
      onResolved: () => {
        renderAccessCards();
        ctx.bridge.work.renderAttention();
        ctx.persist();
      },
      onError: (message) => {
        logChat(message);
        renderAccessCards();
      },
      access: {
        onResolved: (approve) => {
          logChat(approve
            ? "access approved — backend restarts with the new mount; the agent continues automatically"
            : "access denied — the agent is told to continue without it");
          void loadWorkspaceStateAndReconcile();
        },
        onError: (message) => {
          logChat(`resolve access failed: ${message}`);
          renderAccessCards();
        }
      }
    });
    if (questionItems.length === 0) return;
    questionCardsWrap.classList.remove("hidden");
    renderAttentionStack(questionCardsWrap, questionItems, questionAttentionCursor, {
      onResolved: () => {
        renderAccessCards();
        ctx.bridge.work.renderAttention();
        ctx.persist();
      },
      onError: (message) => {
        logChat(message);
        renderAccessCards();
      },
      access: {
        onResolved: () => {
          // This stack only receives questions, but the renderer shares one
          // callback contract with access-card callers.
          renderAccessCards();
        },
        onError: (message) => {
          logChat(message);
          renderAccessCards();
        }
      }
    });
  }

  /** Pending access requests for one session, oldest first. */
  function sessionAccessItems(sessionId: string): AttentionItem[] {
    return (state.workspacePolicy?.accessRequests ?? [])
      .filter((candidate) => candidate.sessionId === sessionId && candidate.status === "pending")
      .map((candidate) => ({ kind: "access" as const, access: candidate }))
      .sort((a, b) => a.access.requestedAt < b.access.requestedAt ? -1 : 1);
  }

  /** Pending open questions for one session, oldest first. */
  function sessionQuestionItems(sessionId: string): AttentionItem[] {
    return state.questions
      .filter((candidate) => candidate.sessionId === sessionId && candidate.status === "pending")
      .map((candidate) => ({ kind: "question" as const, question: candidate }))
      .sort((a, b) => a.question.createdAt < b.question.createdAt ? -1 : 1);
  }

  /** Refetches workspace state after a resolve so stale/resolved cards drop from both tabs. */
  async function loadWorkspaceStateAndReconcile(): Promise<void> {
    const response = await request({ type: "workspace.state" });
    if (response.ok && response.payload.type === "workspace.state") {
      state.workspacePolicy = response.payload.state;
      ctx.persist();
      renderAccessCards();
      ctx.bridge.work.renderAttention();
    }
  }

  function renderDiagnostics(): void {
    ctx.bridge.system.render();
  }

  /** Facts grid from the SELECTED session record (actual provider/model), not the picker. */
  function renderFacts(): void {
    ctx.bridge.system.render();
  }

  /**
   * Renders the Copilot-style working set. The details summary tracks the count;
   * a de-emphasized Snapshot button shows only when no session is selected
   * (workspace scope). Server-provided diff rows (with baselineId) render the
   * rich per-file affordances; the legacy in-memory changedFiles map is a
   * read-only fallback when no diff has been fetched.
   */
  function renderChangedFiles(): void {
    // Clone session: the Changes section becomes the sync surface. This is a
    // clean toggle — clone rows come from cloneRepos, never from diffChanges — so
    // the diff and clone data sources never tangle.
    if (isCloneSelected()) {
      renderCloneChanges();
      return;
    }
    workingSetActions.classList.remove("hidden");
    cloneActions.classList.add("hidden");
    cloneCaption.classList.add("hidden");
    const count = diffChanges.length > 0 ? diffChanges.length : state.changedFiles.size;
    // Aggregate line stats for the tray summary (+A −R); only diff rows carry
    // them, so the legacy in-memory fallback shows the count without stats.
    const stats = diffChanges.length > 0
      ? diffChanges.reduce(
          (acc, change) => ({
            added: acc.added + (change.addedLines ?? 0),
            removed: acc.removed + (change.removedLines ?? 0)
          }),
          { added: 0, removed: 0 }
        )
      : null;
    setChangesSummary(count, stats?.added ?? null, stats?.removed ?? null);
    workingSetTitle.textContent = `Working set (${String(count)} file${count === 1 ? "" : "s"})`;
    setChangesScrollCap(count);
    autoExpandChangesOnGrowth(count);
    // Empty-hide: a real chat session with no edits hides the tray entirely. The
    // no-session (workspace) scope stays visible so Snapshot remains reachable.
    changes.details.classList.toggle("hidden", count === 0 && state.selectedSessionId !== null);
    // Snapshot only makes sense in the no-session (workspace) scope.
    snapshotButton.classList.toggle("hidden", state.selectedSessionId !== null);
    const actionable = diffChanges.length > 0;
    acceptAllButton.disabled = !actionable;
    discardAllButton.disabled = !actionable;

    changedFilesList.replaceChildren();
    if (diffChanges.length > 0) {
      for (const change of diffChanges) changedFilesList.append(diffRow(change));
      return;
    }
    if (state.changedFiles.size === 0) {
      const empty = el("div", "empty");
      empty.textContent = "No files changed. Refresh diff to compare against the baseline.";
      changedFilesList.append(empty);
      return;
    }
    for (const [filePath, changeKind] of state.changedFiles) {
      const row = el("div", "changed-file-row working-set-row");
      const glyph = el("span", "change-glyph kind-modify");
      glyph.textContent = "±";
      glyph.title = changeKind;
      const name = fileNameCell(filePath);
      row.append(glyph, name);
      changedFilesList.append(row);
    }
  }

  /** Basename bold + dim directory suffix, readable at ~300px. */
  function fileNameCell(fullPath: string): HTMLElement {
    const name = el("span", "changed-file-path working-set-name");
    const parts = fullPath.split(/[\\/]/);
    const base = parts.pop() ?? fullPath;
    const dir = parts.join("/");
    const baseEl = el("span", "file-base");
    baseEl.textContent = base;
    name.append(baseEl);
    if (dir.length > 0) {
      const dirEl = el("span", "file-dir");
      dirEl.textContent = ` ${dir}`;
      name.append(dirEl);
    }
    name.title = fullPath;
    return name;
  }

  /**
   * Clone-mode Changes rendering: one section per repo (`<name>@<branch>`
   * header) with a row per changed file. Reuses the working-set row visuals
   * (glyph, path, +N/−M); conflicted rows get a ⚠ marker class. Per-file verbs
   * differ from the diff path: ✓ becomes "Pull into editor" (per-file inbound,
   * no baseline semantics) and ✕ becomes "Discard in clone" (inline-confirm).
   * Header buttons are Pull all / Push (already wired); both gate on turnActive.
   */
  function renderCloneChanges(): void {
    workingSetActions.classList.add("hidden");
    cloneActions.classList.remove("hidden");
    cloneCaption.classList.remove("hidden");
    snapshotButton.classList.add("hidden");
    // Clone sessions use the tray as the sync surface — always shown, never
    // empty-hidden (the empty state explains where the agent's changes land).
    changes.details.classList.remove("hidden");
    const total = cloneRepos.reduce((sum, repo) => sum + repo.files.length, 0);
    setChangesSummary(total, null, null);
    workingSetTitle.textContent = `Clone sync (${String(total)} file${total === 1 ? "" : "s"})`;
    setChangesScrollCap(total);
    autoExpandChangesOnGrowth(total);
    refreshCloneActions();

    changedFilesList.replaceChildren();
    if (total === 0) {
      const empty = el("div", "empty");
      empty.textContent = cloneRepos.length === 0
        ? "No clone state. The agent's changes appear here once it edits the clone."
        : "No changes in the clone yet.";
      changedFilesList.append(empty);
      return;
    }
    for (const repo of cloneRepos) {
      const head = el("div", "clone-repo-head");
      head.textContent = `${repo.name}@${repo.branch}`;
      head.title = "Clone repo · branch";
      changedFilesList.append(head);
      for (const file of repo.files) {
        changedFilesList.append(cloneRow(repo.name, file));
      }
    }
  }

  function cloneRow(repo: string, file: CloneFileChange): HTMLElement {
    const row = el("div", `changed-file-row working-set-row${file.conflicted === true ? " conflicted" : ""}`);
    const meta = CHANGE_GLYPH[file.changeKind];
    const glyph = el("span", `change-glyph ${meta.cls}`);
    glyph.textContent = meta.glyph;
    glyph.title = file.changeKind;

    // Conflicted rows carry a ⚠ marker plus a small `conflict` chip, so the
    // state is named as a word, not glyph-only — same pill idiom as the CLONE chip.
    if (file.conflicted === true) {
      const warn = el("span", "conflict-marker");
      warn.textContent = "⚠";
      warn.title = "Conflict markers present — resolve in the editor";
      warn.setAttribute("aria-label", "conflicted");
      const conflictChip = el("span", "chip chip-conflict");
      conflictChip.textContent = "conflict";
      row.append(warn, conflictChip);
    }

    const name = fileNameCell(file.path);

    const stats = el("span", "working-set-stats");
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

    const actions = el("span", "working-set-row-actions");
    // Per-file ✓ → Pull into editor (per-file inbound patch; NO baseline advance).
    const pull = iconButton("✓", "Pull into editor", "row-accept");
    pull.addEventListener("click", (event) => {
      event.stopPropagation();
      void runCloneOp(
        () => request({ type: "clone.pull", sessionId: requireSelectedSessionId(), repo, path: file.path }),
        `pull ${file.path}`
      );
    });
    // Per-file ✕ → Discard in clone (inline-confirm → clone.discard).
    const discard = iconButton("✕", "Discard in clone", "row-discard");
    wireInlineConfirmIcon(discard, "✕", "?", "Discard in clone", () => {
      discard.disabled = true;
      void request({ type: "clone.discard", sessionId: requireSelectedSessionId(), repo, path: file.path }).then((response) => {
        if (!response.ok) {
          logChat(`discard failed: ${response.error.message}`);
          discard.disabled = false;
          return;
        }
        logChat(`discarded ${file.path} in clone`);
        void loadCloneState();
      });
    });
    actions.append(pull, discard);

    row.append(glyph, name, stats, actions);
    return row;
  }

  function setChangesScrollCap(fileCount: number): void {
    changedFilesList.classList.toggle("scroll-capped", fileCount > 3);
  }

  /**
   * Writes the docked tray's summary label — "<n> file(s) changed  +A  −R",
   * colouring the added/removed counts. Line stats are omitted (null) for the
   * legacy in-memory fallback and for clone sync, which have no per-file diff.
   */
  function setChangesSummary(count: number, added: number | null, removed: number | null): void {
    changes.summaryLabel.replaceChildren();
    const label = el("span", "changes-summary-count");
    label.textContent = `${String(count)} file${count === 1 ? "" : "s"} changed`;
    changes.summaryLabel.append(label);
    if (added !== null && removed !== null && (added > 0 || removed > 0)) {
      const add = el("span", "changes-summary-add");
      add.textContent = `+${String(added)}`;
      const del = el("span", "changes-summary-del");
      del.textContent = `−${String(removed)}`;
      changes.summaryLabel.append(add, del);
    }
  }

  /**
   * Opens the (collapsed) Changes section when the changed-file count grows
   * within the SAME session — so a new edit surfaces without a click. A session
   * switch only re-baselines the count (no auto-open on selecting an old chat).
   */
  function autoExpandChangesOnGrowth(count: number): void {
    if (state.selectedSessionId !== lastChangeSessionId) {
      lastChangeSessionId = state.selectedSessionId;
      lastChangeCount = count;
      return;
    }
    if (count > lastChangeCount) changes.details.open = true;
    lastChangeCount = count;
  }

  /** Stable key for a diff file (matches diff.openFile's identity). */
  function diffKey(change: Pick<DiffFileSummary, "baselineId" | "path">): string {
    return `${change.baselineId}::${change.path}`;
  }

  function diffRow(change: DiffFileSummary): HTMLElement {
    const row = el("div", "changed-file-row working-set-row");
    const meta = CHANGE_GLYPH[change.changeKind];
    const glyph = el("span", `change-glyph ${meta.cls}`);
    glyph.textContent = meta.glyph;
    glyph.title = change.changeKind;

    // "unreviewed" dot for files whose diff was never opened this panel session.
    const reviewed = openedDiffKeys.has(diffKey(change));
    if (!reviewed) {
      const unreviewed = el("span", "unreviewed-dot");
      unreviewed.textContent = "•";
      unreviewed.title = "Unreviewed — diff not opened this session";
      unreviewed.setAttribute("aria-label", "unreviewed");
      row.append(unreviewed);
    }

    const displayPath = change.oldPath !== undefined
      ? `${change.rootName}/${change.oldPath} → ${change.path}`
      : `${change.rootName}/${change.path}`;
    const name = fileNameCell(displayPath);
    name.classList.add("working-set-open");
    name.title = "Open diff (baseline ↔ current)";
    name.addEventListener("click", () => {
      // Mark reviewed optimistically; opening a diff is the review act.
      openedDiffKeys.add(diffKey(change));
      row.querySelector(".unreviewed-dot")?.remove();
      renderChangedFiles();
      void request({ type: "diff.openFile", baselineId: change.baselineId, path: change.path }).then((response) => {
        if (!response.ok) logChat(`open diff failed: ${response.error.message}`);
      });
    });

    const stats = el("span", "working-set-stats");
    if (change.addedLines !== undefined && change.addedLines > 0) {
      const added = el("span", "stat-added");
      added.textContent = `+${String(change.addedLines)}`;
      stats.append(added);
    }
    if (change.removedLines !== undefined && change.removedLines > 0) {
      const removed = el("span", "stat-removed");
      removed.textContent = `−${String(change.removedLines)}`;
      stats.append(removed);
    }
    // Irreversibility is stated inline: a row whose discard is unsupported
    // gets a dim `no rollback` tag next to the stats, carrying the same size-cap
    // tooltip as the disabled ✕ — the blast-radius fact isn't hover-only.
    if (!change.revertSupported) {
      const noRollback = el("span", "no-rollback-tag");
      noRollback.textContent = "no rollback";
      noRollback.title = change.reason ?? "revert unsupported";
      stats.append(noRollback);
    }

    const actions = el("span", "working-set-row-actions");
    const accept = iconButton("✓", "Accept — resets this file's baseline", "row-accept");
    accept.addEventListener("click", (event) => {
      event.stopPropagation();
      accept.disabled = true;
      void request({ type: "diff.acceptFile", baselineId: change.baselineId, path: change.path }).then((response) => {
        applyDiffActionResponse(response, `accepted ${change.path}`);
      });
    });
    // Discard is inline-confirm: first click arms it, second sends revertFile.
    const discard = iconButton("✕", "Discard — rolls back this change", "row-discard");
    if (!change.revertSupported) {
      discard.disabled = true;
      discard.title = change.reason ?? "revert unsupported";
    } else {
      wireInlineConfirmIcon(discard, "✕", "?", "Discard — rolls back this change", () => {
        discard.disabled = true;
        void request({ type: "diff.revertFile", baselineId: change.baselineId, path: change.path }).then((response) => {
          applyDiffActionResponse(response, `discarded ${change.path}`);
        });
      });
    }
    actions.append(accept, discard);

    row.append(glyph, name, stats, actions);
    return row;
  }

  function applyDiffActionResponse(response: PanelResponse, successLine: string): void {
    if (!response.ok) {
      logChat(`diff action failed: ${response.error.message}`);
      return;
    }
    if (response.payload.type === "diff.acceptFile" || response.payload.type === "diff.revertFile") {
      diffChanges = response.payload.changes;
      logChat(successLine);
      renderChangedFiles();
    }
  }

  /**
   * Wires Accept-all as an inline-confirm whose armed label names the exposure.
   * First click arms and swaps the label to `Accept N (M unreviewed)?` (or a
   * plain `Accept N?` when nothing is unreviewed); second click runs the existing
   * sequential accept loop. Blur or a 4s timeout disarms. The label is computed
   * at arm time from the CURRENT diff list + opened-diff set, so it always
   * reflects what the user is about to accept.
   */
  function wireAcceptAllConfirm(node: HTMLButtonElement): void {
    let armed = false;
    let timer = 0;
    const disarm = (): void => {
      armed = false;
      node.textContent = "Accept all";
      node.classList.remove("armed");
      if (timer) window.clearTimeout(timer);
    };
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      if (node.disabled) return;
      if (!armed) {
        const total = diffChanges.length;
        if (total === 0) return;
        const unreviewed = diffChanges.filter((change) => !openedDiffKeys.has(diffKey(change))).length;
        armed = true;
        node.textContent = unreviewed > 0
          ? `Accept ${String(total)} (${String(unreviewed)} unreviewed)?`
          : `Accept ${String(total)}?`;
        node.classList.add("armed");
        timer = window.setTimeout(disarm, 4_000);
        return;
      }
      disarm();
      void acceptAll();
    });
    node.addEventListener("blur", disarm);
  }

  /**
   * Accept-all / Discard-all iterate the CURRENT list sequentially (await each;
   * stop on first error and log it). The response of each call carries the fresh
   * list, so we snapshot the paths up front and drive off that.
   */
  async function acceptAll(): Promise<void> {
    const targets = diffChanges.map((change) => ({ baselineId: change.baselineId, path: change.path }));
    if (targets.length === 0) return;
    acceptAllButton.disabled = true;
    discardAllButton.disabled = true;
    for (const target of targets) {
      const response = await request({ type: "diff.acceptFile", baselineId: target.baselineId, path: target.path });
      if (!response.ok) {
        logChat(`accept all stopped at ${target.path}: ${response.error.message}`);
        break;
      }
      if (response.payload.type === "diff.acceptFile") diffChanges = response.payload.changes;
    }
    logChat("accept all complete");
    renderChangedFiles();
  }

  async function discardAll(): Promise<void> {
    const targets = diffChanges
      .filter((change) => change.revertSupported)
      .map((change) => ({ baselineId: change.baselineId, path: change.path }));
    if (targets.length === 0) return;
    acceptAllButton.disabled = true;
    discardAllButton.disabled = true;
    for (const target of targets) {
      const response = await request({ type: "diff.revertFile", baselineId: target.baselineId, path: target.path });
      if (!response.ok) {
        logChat(`discard all stopped at ${target.path}: ${response.error.message}`);
        break;
      }
      if (response.payload.type === "diff.revertFile") diffChanges = response.payload.changes;
    }
    logChat("discard all complete");
    renderChangedFiles();
  }

  /**
   * CH·13: the owning task for the selected session. A direct
   * `linkedSessionIds` match wins; otherwise walk the session's
   * `parentSessionId` chain (a spawned/subtask child session may not be
   * directly linked even though it belongs to the same task as its ancestor)
   * and match a task linking any ancestor. Guards against cycles with a
   * visited set since session records are host-provided.
   */
  function selectedTaskForNotes(): WorkTaskSummary | undefined {
    const sessionId = state.selectedSessionId;
    if (sessionId === null) return undefined;
    const direct = state.tasks.find((task) => task.linkedSessionIds.includes(sessionId));
    if (direct !== undefined) return direct;
    const visited = new Set<string>();
    let current = state.sessions.find((session) => session.sessionId === sessionId)?.parentSessionId;
    while (current !== undefined && !visited.has(current)) {
      visited.add(current);
      const viaAncestor = state.tasks.find((task) => task.linkedSessionIds.includes(current as string));
      if (viaAncestor !== undefined) return viaAncestor;
      current = state.sessions.find((session) => session.sessionId === current)?.parentSessionId;
    }
    return undefined;
  }

  /**
   * The subtask (if any) whose `linkedSessionIds` includes the selected session,
   * so notes scope to that subtask. Mirrors
   * `subtaskParentTitleForSelectedSession` (direct-link match), returning the
   * subtask id instead of the parent title. Undefined for a plain task session.
   */
  function selectedSubtaskIdForNotes(): string | undefined {
    const sessionId = state.selectedSessionId;
    if (sessionId === null) return undefined;
    for (const task of state.tasks) {
      for (const subtask of task.subtasks) {
        if (subtask.linkedSessionIds.includes(sessionId)) return subtask.subtaskId;
      }
    }
    return undefined;
  }

  /**
   * Notes for the current context. A subtask session shows only that subtask's
   * notes (matching `subtaskId`); a plain task session shows the task-level
   * notes (no `subtaskId`). This keeps the two scopes from bleeding together.
   */
  function selectedTaskNotes(): readonly TaskNote[] {
    const task = selectedTaskForNotes();
    if (task === undefined) return [];
    const subtaskId = selectedSubtaskIdForNotes();
    return state.taskNotes
      .filter((note) => note.taskId === task.taskId
        && (subtaskId === undefined ? note.subtaskId === undefined : note.subtaskId === subtaskId))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  function commitTaskNote(text: string): void {
    const task = selectedTaskForNotes();
    if (task === undefined) return;
    const trimmed = text.replace(/\s+$/, "");
    if (trimmed.trim().length === 0) return;
    const subtaskId = selectedSubtaskIdForNotes();
    const note: TaskNote = {
      noteId: nextMessageId("task-note"),
      taskId: task.taskId,
      ...(subtaskId === undefined ? {} : { subtaskId }),
      createdAt: new Date().toISOString(),
      text: trimmed
    };
    state.taskNotes = [...state.taskNotes, note];
    ctx.persist();
    renderNotesButton();
  }

  function deleteTaskNote(noteId: string): void {
    state.taskNotes = state.taskNotes.filter((note) => note.noteId !== noteId);
    ctx.persist();
    renderNotesButton();
  }

  /**
   * The pinned top-bar notes icon: a count badge and enabled state. Disabled
   * (nothing to attach notes to) when the selected session has no linked task.
   */
  function renderNotesButton(): void {
    const task = selectedTaskForNotes();
    const count = selectedTaskNotes().length;
    notesButton.disabled = task === undefined;
    notesButton.classList.toggle("has-notes", count > 0);
    notesBadge.textContent = count > 0 ? String(count) : "";
    notesBadge.classList.toggle("hidden", count === 0);
    const scope = selectedSubtaskIdForNotes() !== undefined ? "subtask" : "task";
    notesButton.title = task === undefined
      ? "Notes — no linked task"
      : count > 0 ? `Notes (${String(count)}) — this ${scope}` : `Notes — this ${scope}`;
  }

  /**
   * Builds the notes popover (fresh on each open, via the shared `popover`
   * component): a context caption, the notes list with per-row delete, and the
   * add-note form. Add/delete re-render the list in place through the local
   * `renderList` closure and refresh the header badge via renderNotesButton.
   */
  function buildNotesPopover(content: HTMLElement): void {
    const task = selectedTaskForNotes();
    const caption = el("div", "notes-popover-caption");
    if (task === undefined) {
      caption.textContent = "No linked task";
      const empty = el("div", "empty");
      empty.textContent = "This chat isn't linked to a task, so there's nowhere to keep notes.";
      content.append(caption, empty);
      return;
    }
    const onSubtask = selectedSubtaskIdForNotes() !== undefined;
    caption.textContent = onSubtask ? `${task.title} · this subtask` : task.title;

    const list = el("div", "task-notes");
    const form = el("div", "task-note-form");
    const input = document.createElement("textarea");
    input.className = "task-note-input";
    input.rows = 3;
    input.placeholder = onSubtask ? "Add a note for this subtask…" : "Add a note for this task…";
    const addButton = button("Add note", "small primary");
    const actions = el("div", "task-note-actions");
    actions.append(addButton);
    form.append(input, actions);

    const renderList = (): void => {
      const notes = selectedTaskNotes();
      list.replaceChildren();
      if (notes.length === 0) {
        const empty = el("div", "empty");
        empty.textContent = "No notes yet.";
        list.append(empty);
        return;
      }
      for (const note of notes) {
        const row = el("div", "task-note-row");
        const head = el("div", "task-note-head");
        const meta = el("span", "task-note-meta");
        meta.textContent = formatTime(note.createdAt);
        const remove = iconButton("x", "Delete note", "task-note-delete danger");
        wireInlineConfirmIcon(remove, "x", "Confirm", "Delete note", () => { deleteTaskNote(note.noteId); renderList(); }, "Confirm delete note");
        head.append(meta, remove);
        const body = el("div", "task-note-body");
        body.textContent = note.text;
        row.append(head, body);
        list.append(row);
      }
    };
    renderList();

    const submit = (): void => {
      commitTaskNote(input.value);
      input.value = "";
      renderList();
      input.focus();
    };
    addButton.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        submit();
      }
    });

    content.append(caption, list, form);
  }

  /**
   * Fetches plan documents for the selected session and updates the pill row.
   * A docless session (or no selection) clears the pill.
   */
  async function loadPlanDocs(): Promise<void> {
    const sessionId = state.selectedSessionId;
    if (!sessionId) {
      state.planDocs = null;
      renderPlanDocs();
      return;
    }
    const response = await request({ type: "planDocs.state", sessionId });
    // A later selection may have superseded this request; ignore stale results.
    if (state.selectedSessionId !== sessionId) return;
    if (response.ok && response.payload.type === "planDocs.state") {
      const list = response.payload.docs.map((doc) => ({ name: doc.name, format: doc.format, revision: doc.revision }));
      state.planDocs = list.length > 0 ? { sessionId, docs: list } : null;
    } else {
      state.planDocs = null;
    }
    ctx.persist();
    renderPlanDocs();
  }

  /** Renders the compact "Plan documents (N)" pill row above the composer. */
  function renderPlanDocs(): void {
    planDocsRow.replaceChildren();
    const planDocs = state.planDocs;
    const visible = planDocs !== null && planDocs.sessionId === state.selectedSessionId && planDocs.docs.length > 0;
    planDocsRow.classList.toggle("hidden", !visible);
    if (!visible || planDocs === null) return;
    const pill = el("span", "plan-docs-pill");
    pill.textContent = `Plan documents (${String(planDocs.docs.length)})`;
    const openButton = button("Open", "ghost small");
    openButton.addEventListener("click", () => {
      const sessionId = state.selectedSessionId;
      if (!sessionId) return;
      void request({ type: "planDocs.open", sessionId }).then((response) => {
        if (!response.ok) logChat(`could not open plan documents: ${response.error.message}`);
      });
    });
    planDocsRow.append(pill, openButton);
  }

  /** True when the selected session is running in another VS Code window (read-only here). */
  function selectedRunsElsewhere(): boolean {
    return currentSession(state)?.runningElsewhere === true;
  }

  function refreshControls(): void {
    // A session running elsewhere is view-only here: lock the composer + Send and
    // explain why via the placeholder. Provider/model stay locked too.
    const elsewhere = selectedRunsElsewhere();
    if (elsewhere) {
      promptInput.disabled = true;
      promptInput.placeholder = "Read-only — this chat is owned by another VS Code window. Use “Take over here” to reclaim it.";
      sendButton.disabled = true;
      cancelButton.classList.add("hidden");
      providerSelect.disabled = true;
      modelSelect.disabled = true;
      thinkingSelect.disabled = true;
      reclaimBannerText.textContent = "This chat is marked as running in another VS Code window. If this is the right window (e.g. you just reloaded), take it over here.";
      reclaimBanner.classList.remove("hidden");
      return;
    }
    reclaimBanner.classList.add("hidden");
    promptInput.disabled = false;
    promptInput.placeholder = "Ask the isolated agent…";
    const disabled = starting || backendBusy;
    sendButton.disabled = disabled || turnActive;
    cancelButton.classList.toggle("hidden", !turnActive);
    const hasModelOptions = modelSelect.options.length > 0 && modelSelect.options[0]?.value !== "";
    providerSelect.disabled = backendBusy || turnActive || starting;
    modelSelect.disabled = !hasModelOptions || backendBusy || starting;
    thinkingSelect.disabled = backendBusy || starting;
  }

  // ---------------------------------------------------------------------------
  // Drag-drop of file paths into the composer
  // ---------------------------------------------------------------------------
  /**
   * Files dragged from the VS Code explorer (or the OS) onto the composer append
   * explicit file tokens to the textarea (one per line). Mounted host paths are
   * rewritten to the runtime path the container can see.
   *
   * CH·6: `dragover` already called `preventDefault()` (required for `drop` to
   * fire at all) and set `dropEffect`, so that half was not the bug. The gap
   * was in `droppedPaths` below, which only read `text/uri-list`/`text/plain`
   * — VS Code explorer drops into a webview do not reliably populate
   * `text/uri-list`; see `droppedPaths` for the format list now covered.
   */
  function wireComposerDropTarget(): void {
    const zones = [promptInput, composer];
    for (const zone of zones) {
      zone.addEventListener("dragover", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        zone.classList.add("drop-active");
      });
      zone.addEventListener("dragleave", (event) => {
        event.stopPropagation();
        // Only clear when the pointer actually leaves the zone (not a child).
        if (event.relatedTarget instanceof Node && zone.contains(event.relatedTarget)) return;
        zone.classList.remove("drop-active");
      });
      zone.addEventListener("drop", (event) => {
        event.preventDefault();
        event.stopPropagation();
        zone.classList.remove("drop-active");
        handleDrop(event);
      });
    }
  }

  function handleDrop(event: DragEvent): void {
    const data = event.dataTransfer;
    if (!data) return;
    const paths = droppedPaths(data);
    if (paths.length === 0) return;
    for (const path of paths) addAttachment(path);
  }

  /** Adds a host file path as a composer attachment chip (dedup by host path). */
  function addAttachment(hostPath: string): void {
    const normalized = normalizeComparablePath(hostPath).toLowerCase();
    if (attachments.some((a) => normalizeComparablePath(a.hostPath).toLowerCase() === normalized)) return;
    const runtimePath = hostPathToRuntimePath(hostPath);
    const name = hostPath.split(/[\\/]/).filter((part) => part.length > 0).pop() ?? hostPath;
    if (runtimePath === null) logChat(`note: ${hostPath} is not mounted — the agent can request access to it`);
    attachments.push({ hostPath, runtimePath, name });
    renderAttachments();
  }

  function removeAttachment(hostPath: string): void {
    const normalized = normalizeComparablePath(hostPath).toLowerCase();
    const index = attachments.findIndex((a) => normalizeComparablePath(a.hostPath).toLowerCase() === normalized);
    if (index >= 0) {
      attachments.splice(index, 1);
      renderAttachments();
    }
  }

  function clearAttachments(): void {
    if (attachments.length === 0) return;
    attachments.length = 0;
    renderAttachments();
  }

  /** `[file:…]` / `[file-unmounted:…]` tokens for the current attachments. */
  function attachmentTokenLines(): string[] {
    return attachments.map((a) => a.runtimePath !== null
      ? `[file:${encodeFilePathToken(a.runtimePath)}]`
      : `[file-unmounted:${encodeFilePathToken(a.hostPath)}]`);
  }

  /**
   * Renders the composer attachment chips: the active editor as a clickable
   * "add" chip (when not already attached), then each attachment as a removable
   * VS Code-style chip. Hidden when there's nothing to show.
   */
  function renderAttachments(): void {
    attachmentsRow.replaceChildren();
    const active = state.activeEditor;
    const activeKey = active !== null ? normalizeComparablePath(active.path).toLowerCase() : null;
    const alreadyAttached = activeKey !== null
      && attachments.some((a) => normalizeComparablePath(a.hostPath).toLowerCase() === activeKey);
    if (active !== null && !alreadyAttached) {
      const add = el("button", "composer-attach-add");
      const icon = el("span", "composer-attach-addicon");
      icon.textContent = "+";
      const name = el("span", "composer-attach-name");
      name.textContent = active.name;
      add.append(icon, name);
      add.title = `Add open editor: ${active.path}`;
      add.addEventListener("click", () => addAttachment(active.path));
      attachmentsRow.append(add);
    }
    for (const attachment of attachments) {
      const chip = el("span", `composer-attach-chip${attachment.runtimePath === null ? " unmounted" : ""}`);
      const name = el("span", "composer-attach-name");
      name.textContent = attachment.name;
      chip.title = attachment.runtimePath === null
        ? `${attachment.hostPath}\nnot mounted in the container`
        : attachment.hostPath;
      const remove = iconButton("×", "Remove attachment", "composer-attach-remove");
      remove.addEventListener("click", () => removeAttachment(attachment.hostPath));
      chip.append(name, remove);
      attachmentsRow.append(chip);
    }
    attachmentsRow.classList.toggle("hidden", attachmentsRow.children.length === 0);
  }

  /**
   * CH·6: VS Code explorer drags do not reliably populate the standard
   * `text/uri-list` format the way an OS file drop does — a webview drop from
   * the explorer typically carries `application/vnd.code.uri-list` (VS Code's
   * own webview-drop format, newline-separated `file://` URIs) and/or
   * `resourceurls` (a JSON-encoded array of URI strings; used by older/some
   * tree views). Reading only `text/uri-list`/`text/plain` (the previous
   * behavior) silently drops explorer-originated drags. Try every format VS
   * Code is known to use, in order of specificity, before falling back to
   * plain OS file drops.
   */
  function droppedPaths(data: DataTransfer): string[] {
    const candidates = [
      data.getData("application/vnd.code.uri-list"),
      data.getData("text/uri-list"),
      resourceUrlsToLines(data.getData("resourceurls")),
      data.getData("text/plain")
    ];
    for (const candidate of candidates) {
      if (candidate === undefined || candidate.trim().length === 0) continue;
      const paths = candidate
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"))
        .map(fileUriToPath);
      if (paths.length > 0) return paths;
    }
    // Last resort: plain OS file drops (Electron exposes File.path; the web
    // platform does not, so name-only is the final fallback).
    return Array.from(data.files)
      .map((file) => {
        const maybePath = (file as File & { readonly path?: string }).path;
        return maybePath && maybePath.length > 0 ? maybePath : file.name;
      })
      .filter((path) => path.length > 0);
  }

  /** Parses the `resourceurls` payload (JSON array of URI strings) into newline-joined text, or undefined if absent/malformed. */
  function resourceUrlsToLines(raw: string): string | undefined {
    if (raw.trim().length === 0) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return undefined;
      const uris = parsed.filter((entry): entry is string => typeof entry === "string");
      return uris.length > 0 ? uris.join("\n") : undefined;
    } catch {
      return undefined;
    }
  }

  /** Decodes a file:// URI to an fs path; leaves non-URI text untouched. */
  function fileUriToPath(value: string): string {
    if (!/^file:\/\//i.test(value)) return value;
    try {
      const url = new URL(value);
      let pathname = decodeURIComponent(url.pathname);
      // Windows drive paths arrive as "/C:/foo" → "C:/foo".
      if (/^\/[a-zA-Z]:/.test(pathname)) pathname = pathname.slice(1);
      // UNC host, if any, becomes a leading share.
      return url.host ? `//${url.host}${pathname}` : pathname;
    } catch {
      return value;
    }
  }

  /**
   * If `absPath` sits under a known host root, returns the runtime path (mount
   * root + relative remainder); otherwise null. Case-insensitive compare on
   * Windows-style paths so "C:\\x" matches "c:/x".
   */
  function hostPathToRuntimePath(absPath: string): string | null {
    const needle = normalizeComparablePath(absPath).toLowerCase();
    for (const mount of mappableMounts()) {
      const host = mount.hostDisplayPath;
      if (host === undefined || host.length === 0) continue;
      const root = normalizeComparablePath(host).toLowerCase();
      if (needle === root) return mount.runtimePath;
      if (needle.startsWith(`${root}/`)) {
        const remainder = normalizeComparablePath(absPath).slice(root.length).replace(/^\/+/, "");
        return `${mount.runtimePath.replace(/\/+$/, "")}/${remainder}`;
      }
    }
    return null;
  }

  function hostPathForRuntimePath(runtimePath: string): string | null {
    const needle = normalizeComparablePath(runtimePath);
    for (const mount of mappableMounts()) {
      if (mount.hostDisplayPath === undefined || mount.hostDisplayPath.length === 0) continue;
      const root = normalizeComparablePath(mount.runtimePath);
      if (needle === root) return mount.hostDisplayPath;
      if (needle.startsWith(`${root}/`)) {
        const remainder = needle.slice(root.length).replace(/^\/+/, "");
        const separator = mount.hostDisplayPath.includes("\\") ? "\\" : "/";
        return `${mount.hostDisplayPath.replace(/[\\/]+$/, "")}${separator}${remainder.replace(/\//g, separator)}`;
      }
    }
    return null;
  }

  function mappableMounts(): readonly DisplayMount[] {
    const session = currentSession(state);
    if (session !== undefined && isSessionLiveish(state, session.sessionId) && state.lastIsolation !== null) {
      return state.lastIsolation.mounts;
    }
    return plannedWorkspaceMounts();
  }

  function normalizeComparablePath(path: string): string {
    return path.replace(/\\/g, "/").replace(/\/+$/, "");
  }

  function encodeFilePathToken(path: string): string {
    return encodeURI(path).replace(/\[/g, "%5B").replace(/\]/g, "%5D");
  }

  function decodeFilePathToken(path: string): string {
    try {
      return decodeURI(path);
    } catch {
      return path;
    }
  }

  // ---------------------------------------------------------------------------
  // Public view API
  // ---------------------------------------------------------------------------
  /**
   * FIX 1: shows/clears the "Starting the chat backend…" placeholder for a
   * caller (e.g. workTab's "Create and start chat") that switches to this tab
   * before chat.startSession has resolved. `selectSession` (called once the
   * real session lands) clears it as a side effect too, so callers only need
   * this for the failure path or an explicit early clear.
   */
  function showStarting(active: boolean): void {
    pendingSessionStart = active;
    renderHeader();
    renderChat();
  }

  function selectSession(sessionId: string | null): void {
    pendingSessionStart = false;
    state.selectedSessionId = sessionId;
    manualModelSessionId = null;
    state.chatMessages = [];
    runningCommands.clear();
    state.diagnostics = [];
    state.agentGroups = {};
    expandedGroups.clear();
    state.lastSequence = 0;
    activeAssistantId = null;
    reasoningText = "";
    reasoningActive = false;
    state.changedFiles.clear();
    diffChanges = [];
    cloneRepos = [];
    openedDiffKeys = new Set();
    setTurnActive(false);
    // Drop the previous session's pill immediately; loadPlanDocs refreshes it.
    if (state.planDocs !== null && state.planDocs.sessionId !== sessionId) state.planDocs = null;
    renderHeader();
    renderContextStrip();
    renderProviderControls();
    renderChat();
    renderDiagnostics();
    renderChangedFiles();
    renderNotesButton();
    renderFacts();
    renderAccessCards();
    renderPlanDocs();
    renderAttachments();
    ctx.persist();
    if (sessionId) {
      void loadTimeline(sessionId);
      // Clone sessions draw the Changes section from clone.state; other sessions
      // from diff.status. Only one source is fetched so they never overlap.
      if (isCloneSelected()) {
        void loadCloneState();
      } else {
        void loadDiffStatus();
      }
      void loadPlanDocs();
    }
  }

  function resetToNewChat(): void {
    pendingSessionStart = false;
    state.selectedSessionId = null;
    manualModelSessionId = null;
    state.chatMessages = [];
    runningCommands.clear();
    state.diagnostics = [];
    state.agentGroups = {};
    expandedGroups.clear();
    state.lastSequence = 0;
    activeAssistantId = null;
    reasoningText = "";
    reasoningActive = false;
    state.changedFiles.clear();
    diffChanges = [];
    cloneRepos = [];
    openedDiffKeys = new Set();
    state.planDocs = null;
    setTurnActive(false);
    renderHeader();
    renderContextStrip();
    renderProviderControls();
    renderChat();
    renderDiagnostics();
    renderChangedFiles();
    renderNotesButton();
    renderFacts();
    renderAccessCards();
    renderPlanDocs();
    renderAttachments();
    ctx.persist();
  }

  function render(): void {
    root.classList.toggle("code-wrap", state.codeBlockWordWrap);
    applyModeButtons();
    renderHeader();
    renderContextStrip();
    renderProviderControls();
    renderChat();
    renderDiagnostics();
    renderChangedFiles();
    renderNotesButton();
    renderFacts();
    renderAccessCards();
    renderPlanDocs();
    renderAttachments();
    // Refresh the sandbox usage bar promptly on tab activation / session switch
    // (the interval keeps it live thereafter).
    void pollSandboxStats();
  }

  return { root, render, selectSession, resetToNewChat, logChat, showStarting };
}

/**
 * Turns an icon button into a two-click inline-confirm: first click shows the
 * confirm glyph (armed), second runs `onConfirm`; blur or a 3s timeout reverts.
 * Mirrors components.inlineConfirmButton but for the compact icon buttons in the
 * working-set rows (no text label swap).
 */
function wireInlineConfirmIcon(
  node: HTMLButtonElement,
  glyph: string,
  confirmGlyph: string,
  title: string,
  onConfirm: () => void,
  confirmTitle = "Confirm"
): void {
  let armed = false;
  let timer = 0;
  const disarm = (): void => {
    armed = false;
    node.textContent = glyph;
    node.title = title;
    node.setAttribute("aria-label", title);
    node.classList.remove("armed");
    if (timer) window.clearTimeout(timer);
  };
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!armed) {
      armed = true;
      node.textContent = confirmGlyph;
      node.title = confirmTitle;
      node.setAttribute("aria-label", confirmTitle);
      node.classList.add("armed");
      timer = window.setTimeout(disarm, 3_000);
      return;
    }
    disarm();
    onConfirm();
  });
  node.addEventListener("blur", disarm);
}

function nextMessageId(prefix: string): string {
  return `${prefix}-${String(Date.now())}-${String(Math.random()).slice(2)}`;
}
