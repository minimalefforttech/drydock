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
  type PanelResponse,
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
  let activeAssistantId: string | null = null;
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
  const titleLabel = el("span", "chat-title");
  titleLabel.title = "Click to rename";
  const statusDotEl = statusDot("state-ended", "no live session");
  titleWrap.append(statusDotEl, titleLabel);

  titleLabel.addEventListener("click", () => beginRename());

  const infoButton = iconButton("ⓘ", "Isolation summary");
  const infoPopover = popover(infoButton, (content) => buildIsolationPopover(content));

  const overflowButton = iconButton("⋯", "More actions");
  const overflowPopover = popover(overflowButton, (content) => buildOverflowMenu(content));

  header.append(backButton, titleWrap, el("span", "chat-header-spacer"), infoPopover, overflowPopover);

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

  contextStrip.append(mounts);

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

  const sendButton = button("Send", "primary");
  sendButton.classList.add("composer-send");
  const cancelButton = button("Cancel", "ghost");
  cancelButton.classList.add("composer-cancel");
  cancelButton.classList.add("hidden");
  const composerModelControls = el("div", "composer-model-controls");
  composerModelControls.append(providerSelect, modelSelect, thinkingSelect);
  const composerActions = el("div", "composer-actions");
  composerActions.append(modeControl, composerModelControls, el("span", "composer-spacer"), sendButton, cancelButton);

  // Plan-documents pill row (compact; shown above the composer when the
  // selected session has collected plan documents — issue 7, Phase 2).
  const planDocsRow = el("div", "plan-docs-row hidden");

  const composer = el("div", "composer");
  composer.append(planDocsRow, promptInput, composerActions);

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

  // Task notes are task-scoped context, not file-change review UI.
  const taskNotes = collapsible("Task Notes");
  taskNotes.details.classList.add("task-notes-section");
  const taskNoteInput = document.createElement("textarea");
  taskNoteInput.className = "task-note-input";
  taskNoteInput.rows = 3;
  taskNoteInput.placeholder = "Add a task note...";
  const addTaskNoteButton = button("Add note", "small primary");
  const taskNoteActions = el("div", "task-note-actions");
  taskNoteActions.append(addTaskNoteButton);
  const taskNoteForm = el("div", "task-note-form");
  taskNoteForm.append(taskNoteInput, taskNoteActions);
  const taskNotesList = el("div", "task-notes");
  taskNotes.body.append(taskNotesList, taskNoteForm);

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
  addTaskNoteButton.addEventListener("click", () => addTaskNote());
  taskNoteInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      addTaskNote();
    }
  });

  // Owner order: scrollable chat body, pinned composer.
  const chatScroll = el("div", "chat-scroll");
  chatScroll.append(
    header,
    contextStrip,
    authBanner,
    transcriptRegion,
    questionCardsWrap,
    taskNotes.details,
    changes.details
  );
  root.append(chatScroll, composer);

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
      applyTranscriptLine(payload.line);
    }
  });
  onPush("chat.turnStarted", (payload) => {
    if (payload.sessionId === state.selectedSessionId) {
      activeAssistantId = null;
      setTurnActive(true);
    }
  });
  onPush("chat.turnCompleted", (payload) => {
    if (payload.sessionId === state.selectedSessionId) {
      activeAssistantId = null;
      logChat(`turn ${payload.status}`);
      setTurnActive(false);
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

  function isSelectedBackendReady(): boolean {
    if (!state.selectedSessionId || !isSessionLiveish(state, state.selectedSessionId)) return false;
    const session = currentSession(state);
    return session !== undefined && normalizeProviderId(session.providerId) === normalizeProviderId(providerSelect.value);
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
    const prompt = promptInput.value.trim();
    if (!prompt || turnActive || starting || backendBusy) return;
    const model = currentModelSelection();
    promptInput.value = "";
    state.promptDraft = "";
    ctx.persist();

    if (state.selectedSessionId && isSelectedBackendReady()) {
      setTurnActive(true);
      const response = await request({ type: "chat.sendTurn", sessionId: state.selectedSessionId, prompt, model });
      if (!response.ok) {
        logChat(`could not send: ${response.error.message}`);
        setTurnActive(false);
      }
      return;
    }

    // Lazy spin-up: the first submitted message starts the micro-VM.
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
      logChat(`could not start chat: ${response.error.message}`);
      refreshControls();
      return;
    }
    if (response.payload.type === "chat.start") {
      upsertSession(state, response.payload.session);
      state.selectedSessionId = response.payload.session.sessionId;
      manualModelSessionId = null;
      state.lastSequence = 0;
      state.chatMessages = [];
      state.diagnostics = state.diagnostics.slice(-3);
      state.agentGroups = {};
      expandedGroups.clear();
      state.changedFiles.clear();
      openedDiffKeys = new Set();
      activeAssistantId = null;
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
    if (!providerChanged) return;

    backendBusy = true;
    refreshControls();
    logChat(`switching provider to ${selection.providerId} — restarting backend and replaying context`);
    const response = await request({ type: "chat.restartBackend", sessionId: state.selectedSessionId, model: selection });
    backendBusy = false;
    if (!response.ok) {
      logChat(`restart failed: ${response.error.message}`);
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
      row.textContent = `${mount.mode === "read-write" ? "rw" : "ro"} ${mount.runtimePath}${mount.hostDisplayPath ? ` ← ${mount.hostDisplayPath}` : ""}`;
      content.append(row);
    }
    const net = el("div", "popover-line");
    net.textContent = iso.network === "provider-scoped"
      ? `Network: provider-scoped (${iso.networkAllowlist ?? ""})`
      : "Network: none";
    content.append(net);
  }

  function buildOverflowMenu(content: HTMLElement): void {
    const newChat = menuItem("New chat", () => resetToNewChat());
    // A session running elsewhere is owned by another window: Restart/End/Delete
    // are refused, and Resume makes no sense (it is active). Only New chat shows.
    if (selectedRunsElsewhere()) {
      const note = el("div", "menu-item disabled");
      note.textContent = "Running in another window (read-only)";
      content.append(note, newChat);
      return;
    }
    const restart = menuItem("Restart backend", () => void restartBackendAction());
    // Resume boots a fresh backend on an ended/failed session (context replayed);
    // enabled only when the selected session is resumable.
    const resume = menuItem("Resume backend", () => void resumeBackendAction());
    const end = menuItem("End session", () => void endSessionAction());
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
      }
      if (!resumable || backendBusy) resume.classList.add("disabled");
    }
    content.append(restart, resume, end, del, newChat);
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
    logChat("resuming backend on a fresh runtime — context is replayed (takes a few seconds)…");
    const workspace = state.openFolderNames.length > 0
      ? { auto: true as const, mode: "implementation" as const }
      : undefined;
    const response = await request({
      type: "chat.resumeSession",
      sessionId: session.sessionId,
      ...(workspace ? { workspace } : {})
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
    state.diagnostics = [];
    state.agentGroups = {};
    expandedGroups.clear();
    state.changedFiles.clear();
    activeAssistantId = null;
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

  function appendUserLine(prompt: string, createdAt = new Date().toISOString(), shouldPersist = true): void {
    state.chatMessages.push({ id: nextMessageId("user"), role: "user", createdAt, text: prompt });
    activeAssistantId = null;
    renderChat();
    if (shouldPersist) ctx.persist();
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
    turnActive = next;
    refreshControls();
    renderHeader();
  }

  // ---------------------------------------------------------------------------
  // Rendering (textContent only for dynamic data)
  // ---------------------------------------------------------------------------
  function renderHeader(): void {
    const session = currentSession(state);
    titleLabel.textContent = session ? session.title : "New chat";
    // Status dot: elsewhere (ring) / running (turn active) / live / ended.
    let stateClass = "state-ended";
    let label = "no live session";
    if (session?.runningElsewhere === true) {
      stateClass = "state-elsewhere";
      label = "running in another window (read-only)";
    } else if (session && isSessionLiveish(state, session.sessionId)) {
      if (turnActive) { stateClass = "state-running"; label = "turn in progress"; }
      else { stateClass = "state-live"; label = "live"; }
    }
    statusDotEl.className = `status-dot ${stateClass}`;
    statusDotEl.title = label;
    statusDotEl.setAttribute("aria-label", label);
    titleWrap.replaceChildren(statusDotEl, titleLabel);
  }

  /**
   * Mounts <details>: a "1 mount · rw" style summary; expanding lists each mount
   * (mode chip + runtimePath ← hostDisplayPath). Before a session starts, the
   * summary shows the upcoming context ("Auto: <folders>" / set name / no mounts)
   * and expanding lists the planned `/workspace/root-N` mapping when workspace
   * state is available.
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
      path.textContent = `${prefix ? `${prefix} · ` : ""}${mount.runtimePath}${mount.hostDisplayPath ? ` ← ${mount.hostDisplayPath}` : ""}`;
      row.append(modeChip, path);
      mountsBody.append(row);
    }
  }

  function plannedWorkspaceMounts(): DisplayMount[] {
    const names = plannedWorkspaceProjectNames();
    const mode = state.composerMode === "plan" ? "read-only" : "read-write";
    return names.map((name, index) => {
      const project = state.workspacePolicy?.projects.find((candidate) => candidate.name === name);
      return {
        runtimePath: `/workspace/root-${String(index + 1)}`,
        mode,
        hostDisplayPath: project?.displayPath ?? name
      };
    });
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
    renderAuthBanner();
    refreshControls();
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
    lensStrip.classList.toggle("hidden", session === undefined);
    spawnRoleSelect.classList.add("hidden");
    if (transcriptView === "agents") renderAgentsLens();
    chatLog.replaceChildren();
    if (state.chatMessages.length === 0) {
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
    // Keep the scrollable chat body pinned to the newest entry as it grows/streams.
    if (pinToBottom) chatScroll.scrollTop = chatScroll.scrollHeight;
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
    const streaming = message.streaming === true;
    const row = el("div", `chat-message role-${message.role}${streaming ? " streaming" : ""}`);
    const meta = el("div", "chat-meta");
    meta.textContent = `${message.role === "user" ? "You" : "Assistant"} · ${formatTime(message.createdAt)}`;
    row.append(meta);

    if (message.role === "user") {
      const body = el("div", "chat-user-body");
      appendTextWithFileTokens(body, message.text);
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

  /** Builds one structural markdown block as DOM (textContent leaves only). */
  function assistantBlock(block: DocBlock): HTMLElement {
    switch (block.kind) {
      case "heading": {
        const level = Math.min(block.level ?? 1, 4);
        const heading = el(`h${String(level)}`, "md-heading");
        heading.textContent = block.text;
        return heading;
      }
      case "list": {
        const ul = el("ul", "md-list");
        for (const item of block.items ?? []) {
          const li = el("li");
          li.textContent = item;
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
        p.textContent = block.text;
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
    changes.summaryLabel.textContent = `Changes (${String(count)} file${count === 1 ? "" : "s"})`;
    workingSetTitle.textContent = `Working set (${String(count)} file${count === 1 ? "" : "s"})`;
    setChangesScrollCap(count);
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
    const total = cloneRepos.reduce((sum, repo) => sum + repo.files.length, 0);
    changes.summaryLabel.textContent = `Changes (${String(total)} file${total === 1 ? "" : "s"})`;
    workingSetTitle.textContent = `Clone sync (${String(total)} file${total === 1 ? "" : "s"})`;
    setChangesScrollCap(total);
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

  function selectedTaskForNotes(): WorkTaskSummary | undefined {
    const sessionId = state.selectedSessionId;
    if (sessionId === null) return undefined;
    return state.tasks.find((task) => task.linkedSessionIds.includes(sessionId));
  }

  function selectedTaskNotes(): readonly TaskNote[] {
    const task = selectedTaskForNotes();
    if (task === undefined) return [];
    return state.taskNotes
      .filter((note) => note.taskId === task.taskId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  function addTaskNote(): void {
    const task = selectedTaskForNotes();
    if (task === undefined) return;
    const text = taskNoteInput.value.replace(/\s+$/, "");
    if (text.trim().length === 0) return;
    const note: TaskNote = {
      noteId: nextMessageId("task-note"),
      taskId: task.taskId,
      createdAt: new Date().toISOString(),
      text
    };
    state.taskNotes = [...state.taskNotes, note];
    taskNoteInput.value = "";
    ctx.persist();
    renderTaskNotes();
  }

  function deleteTaskNote(noteId: string): void {
    state.taskNotes = state.taskNotes.filter((note) => note.noteId !== noteId);
    ctx.persist();
    renderTaskNotes();
  }

  function renderTaskNotes(): void {
    const task = selectedTaskForNotes();
    const notes = selectedTaskNotes();
    taskNotes.summaryLabel.textContent = notes.length > 0 ? `Task Notes (${String(notes.length)})` : "Task Notes";
    taskNoteInput.disabled = task === undefined;
    addTaskNoteButton.disabled = task === undefined;
    taskNoteInput.placeholder = task === undefined ? "No linked task" : "Add a task note...";
    taskNotesList.replaceChildren();

    if (task === undefined) {
      const empty = el("div", "empty");
      empty.textContent = "No linked task.";
      taskNotesList.append(empty);
      return;
    }
    if (notes.length === 0) {
      const empty = el("div", "empty");
      empty.textContent = "No task notes.";
      taskNotesList.append(empty);
      return;
    }
    for (const note of notes) {
      const row = el("div", "task-note-row");
      const head = el("div", "task-note-head");
      const meta = el("span", "task-note-meta");
      meta.textContent = formatTime(note.createdAt);
      const remove = iconButton("x", "Delete note", "task-note-delete danger");
      wireInlineConfirmIcon(remove, "x", "Confirm", "Delete note", () => deleteTaskNote(note.noteId), "Confirm delete note");
      head.append(meta, remove);
      const body = el("div", "task-note-body");
      body.textContent = note.text;
      row.append(head, body);
      taskNotesList.append(row);
    }
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
      promptInput.placeholder = "This chat is running in another VS Code window (read-only here)";
      sendButton.disabled = true;
      cancelButton.classList.add("hidden");
      providerSelect.disabled = true;
      modelSelect.disabled = true;
      thinkingSelect.disabled = true;
      return;
    }
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

    const inserted: string[] = [];
    for (const path of paths) {
      const runtimePath = hostPathToRuntimePath(path);
      if (runtimePath !== null) {
        inserted.push(`[file:${encodeFilePathToken(runtimePath)}]`);
      } else {
        inserted.push(`[file-unmounted:${encodeFilePathToken(path)}]`);
        logChat(`note: ${path} is not mounted — the agent can request access to it`);
      }
    }
    insertIntoComposer(inserted);
  }

  function droppedPaths(data: DataTransfer): string[] {
    // Prefer a uri-list (VS Code explorer / OS file drops); fall back to plain
    // text and finally Electron's File.path when available.
    const uriList = data.getData("text/uri-list");
    const text = uriList && uriList.trim().length > 0 ? uriList : data.getData("text/plain");
    const paths = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map(fileUriToPath);
    if (paths.length > 0) return paths;
    return Array.from(data.files)
      .map((file) => {
        const maybePath = (file as File & { readonly path?: string }).path;
        return maybePath && maybePath.length > 0 ? maybePath : file.name;
      })
      .filter((path) => path.length > 0);
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

  /** Appends the given paths to the composer, one per line, and refocuses it. */
  function insertIntoComposer(paths: readonly string[]): void {
    const existing = promptInput.value;
    const addition = paths.join("\n");
    promptInput.value = existing.length === 0
      ? addition
      : `${existing}${existing.endsWith("\n") ? "" : "\n"}${addition}`;
    state.promptDraft = promptInput.value;
    ctx.persist();
    promptInput.focus();
    promptInput.setSelectionRange(promptInput.value.length, promptInput.value.length);
  }

  // ---------------------------------------------------------------------------
  // Public view API
  // ---------------------------------------------------------------------------
  function selectSession(sessionId: string | null): void {
    state.selectedSessionId = sessionId;
    manualModelSessionId = null;
    state.chatMessages = [];
    state.diagnostics = [];
    state.agentGroups = {};
    expandedGroups.clear();
    state.lastSequence = 0;
    activeAssistantId = null;
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
    renderTaskNotes();
    renderFacts();
    renderAccessCards();
    renderPlanDocs();
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
    state.selectedSessionId = null;
    manualModelSessionId = null;
    state.chatMessages = [];
    state.diagnostics = [];
    state.agentGroups = {};
    expandedGroups.clear();
    state.lastSequence = 0;
    activeAssistantId = null;
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
    renderTaskNotes();
    renderFacts();
    renderAccessCards();
    renderPlanDocs();
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
    renderTaskNotes();
    renderFacts();
    renderAccessCards();
    renderPlanDocs();
  }

  return { root, render, selectSession, resetToNewChat, logChat };
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
