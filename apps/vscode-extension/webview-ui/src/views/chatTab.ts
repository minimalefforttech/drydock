/**
 * Chat tab: the default surface, styled as a DEV LOG (GitHub-Copilot-chat-like),
 * not an online chat bot.
 *
 * Full-height flex column: header (back button ‹, editable title, status dot,
 * isolation ⓘ popover, overflow ⋯ menu) → context strip (provider/model row +
 * a native collapsed mounts <details>) → transcript (flex:1, its own scroll)
 * with inline access-request cards → Changes working set (Copilot-style, with a
 * relocated Comments sub-section) → composer (with the plan-docs pill) →
 * Diagnostics. Assistant turns render full-width as structural markdown blocks
 * (shared splitter); user turns as a compact tinted card. Files dragged from the
 * VS Code explorer or the OS drop their (mount-relative) paths into the composer.
 *
 * SECURITY: all dynamic strings (agent output, titles, mounts, model names, file
 * paths) are assigned via textContent — never innerHTML — so nothing
 * agent-authored can become markup. Markdown is rendered STRUCTURALLY: the
 * splitter classifies blocks and each block is built from DOM nodes whose text
 * leaves are set with textContent, so raw HTML in output stays literal. Mermaid
 * fences render as CODE here (no diagram in chat). Re-renders use replaceChildren
 * so stale handlers cannot leak.
 */

import {
  reduceAgentTree,
  subagentReportingForTransport,
  treeSourceFromLine,
  type AgentRole,
  type AgentTreeNode,
  type ChatModelSelection,
  type ChatWorkspaceSelection,
  type CloneFileChange,
  type CloneRepoState,
  type CloneSyncResult,
  type DiffFileSummary,
  type PanelResponse,
  type ReviewCommentSummary,
  type ReviewThreadStatus,
  type SequencedTranscriptLine
} from "@drydock/contracts";
import {
  button,
  collapsible,
  el,
  formatTime,
  iconButton,
  inlineConfirmButton,
  numberInput,
  option,
  popover,
  select,
  statusDot,
  textInput
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
  upsertTask,
  type AgentGroup,
  type ChatMessage,
  type DiagnosticEntry
} from "../state.js";
import type { ChatTabView, ViewContext } from "../viewContext.js";
import { renderAttentionStack, type AttentionItem } from "./attentionStack.js";

const REVIEW_STATUSES: readonly ReviewThreadStatus[] = ["open", "acknowledged", "delegated", "resolved", "wont-fix", "blocked"];

/** Change-kind → single-glyph badge + color class (Copilot working-set style). */
const CHANGE_GLYPH: Record<DiffFileSummary["changeKind"], { glyph: string; cls: string }> = {
  add: { glyph: "+", cls: "kind-add" },
  modify: { glyph: "±", cls: "kind-modify" },
  delete: { glyph: "−", cls: "kind-delete" },
  rename: { glyph: "→", cls: "kind-rename" }
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
  let reviewComments: readonly ReviewCommentSummary[] = [];
  // Clone-mode sync working set: per-repo agent changes in the clone, shown
  // in the Changes section for a clone session INSTEAD of diffChanges. Kept as a
  // separate source so the two never tangle; cleared on every session switch.
  let cloneRepos: readonly CloneRepoState[] = [];
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
  // Provider/model selects FIRST (one row); a native collapsed mounts <details>
  // BELOW them.
  const contextStrip = el("div", "context-strip");
  const providerRow = el("div", "context-provider-row");
  const providerSelect = select("provider-select compact", "Provider");
  const modelSelect = select("model-select compact", "Model");
  providerRow.append(providerSelect, modelSelect);

  const mounts = document.createElement("details");
  mounts.className = "context-mounts section";
  const mountsSummary = document.createElement("summary");
  mountsSummary.className = "context-mounts-summary";
  const mountsBody = el("div", "context-mounts-body");
  mounts.append(mountsSummary, mountsBody);

  contextStrip.append(providerRow, mounts);

  providerSelect.addEventListener("change", () => {
    renderProviderControls(false);
    ctx.persist();
    void onSelectionChange();
  });
  modelSelect.addEventListener("change", () => {
    state.selectedModel = modelSelect.value;
    ctx.persist();
    void onSelectionChange();
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
  const logViewButton = button("Log", "segment active");
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
  // Spawn-role control: placeholder-first select; choosing a role
  // spawns a child session under the selected live chat.
  const spawnRoleSelect = select("spawn-role-select");
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
  lensStrip.append(lensControl, spawnRoleSelect);

  // --- inline access-request cards (appended after the transcript) -----------
  const accessCardsWrap = el("div", "access-cards");

  // The scrollable transcript region (transcript + access cards); flex:1 so it
  // absorbs the panel's free vertical space and scrolls independently.
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

  // Mode segmented control [Chat | Plan | Clone] → implementation | plan | clone.
  const modeControl = el("div", "segmented");
  const chatModeBtn = button("Chat", "segment");
  const planModeBtn = button("Plan", "segment");
  const cloneModeBtn = button("Clone", "segment");
  modeControl.append(chatModeBtn, planModeBtn, cloneModeBtn);
  const applyModeButtons = (): void => {
    chatModeBtn.classList.toggle("active", state.composerMode === "implementation");
    planModeBtn.classList.toggle("active", state.composerMode === "plan");
    cloneModeBtn.classList.toggle("active", state.composerMode === "clone");
  };
  chatModeBtn.addEventListener("click", () => {
    state.composerMode = "implementation";
    applyModeButtons();
    ctx.persist();
  });
  planModeBtn.addEventListener("click", () => {
    state.composerMode = "plan";
    applyModeButtons();
    ctx.persist();
  });
  cloneModeBtn.addEventListener("click", () => {
    state.composerMode = "clone";
    applyModeButtons();
    ctx.persist();
  });

  const sendButton = button("Send", "primary");
  const cancelButton = button("Cancel", "ghost");
  cancelButton.classList.add("hidden");
  const composerActions = el("div", "composer-actions");
  composerActions.append(modeControl, el("span", "composer-spacer"), sendButton, cancelButton);

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

  // Comments moved INSIDE Changes as their own nested collapsed <details>.
  const comments = collapsible("Comments");
  comments.details.classList.add("comments-section");
  const commentFileInput = textInput("file path");
  const commentStartInput = numberInput("from", 1);
  const commentEndInput = numberInput("to", 1);
  const commentBodyInput = textInput("comment");
  const addCommentButton = button("Comment", "small");
  const reviewFormRow = el("div", "button-row");
  reviewFormRow.append(commentFileInput, commentStartInput, commentEndInput, commentBodyInput, addCommentButton);
  const reviewList = el("div", "review-comments");
  comments.body.append(reviewFormRow, reviewList);

  changes.body.append(cloneCaption, workingSetHeader, changedFilesList, comments.details);

  refreshDiffButton.addEventListener("click", () => void loadDiffStatus());
  snapshotButton.addEventListener("click", () => {
    const workspaceSetId = state.selectedWorkspaceSetId;
    if (!workspaceSetId) {
      logChat("select a workspace set (Work tab) before snapshotting");
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
  addCommentButton.addEventListener("click", () => {
    const filePath = commentFileInput.value.trim();
    const body = commentBodyInput.value.trim();
    const startLine = Number(commentStartInput.value);
    const endLine = Number(commentEndInput.value);
    if (!filePath || !body || !Number.isInteger(startLine) || !Number.isInteger(endLine)) return;
    void request({
      type: "review.addComment",
      ...(state.selectedSessionId ? { sessionId: state.selectedSessionId } : {}),
      filePath,
      startLine,
      endLine,
      body
    }).then((response) => {
      if (!response.ok) {
        logChat(`comment failed: ${response.error.message}`);
        return;
      }
      commentBodyInput.value = "";
      void loadReviewState();
    });
  });

  // --- Diagnostics (collapsed) ------------------------------------------------
  const diagnostics = collapsible("Diagnostics");
  const factsGrid = el("div", "facts-grid");
  const diagnosticsLog = el("div", "diagnostics-log");
  diagnostics.body.append(factsGrid, diagnosticsLog);

  // Owner order: transcript, Changes, composer, Diagnostics.
  root.append(
    header,
    contextStrip,
    authBanner,
    transcriptRegion,
    changes.details,
    composer,
    diagnostics.details
  );

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
    // Explicit set (advanced, Work tab) wins; else auto-mount open folders; else
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
    const mode = state.composerMode;
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
   * Provider/model change on a LIVE session restarts the backend, keeping the
   * transcript. On failure, revert the selects to the session's actual
   * provider/model. No live session → the selection just persists for next start.
   */
  async function onSelectionChange(): Promise<void> {
    if (!state.selectedSessionId || !isSessionLiveish(state, state.selectedSessionId)) return;
    if (turnActive || backendBusy || starting) return;
    const session = currentSession(state);
    if (!session) return;
    const selection = currentModelSelection();
    const providerChanged = normalizeProviderId(session.providerId) !== selection.providerId;
    const modelChanged = (selection.model ?? "") !== (session.model ?? "");
    if (!providerChanged && !modelChanged) return;

    backendBusy = true;
    refreshControls();
    logChat(`restarting backend with ${selection.providerId}${selection.model ? `/${selection.model}` : ""} — context is replayed`);
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
    del.append(inlineConfirmButton("Delete chat", "Confirm delete", () => void deleteSessionAction(), "ghost small danger menu-danger"));
    const session = currentSession(state);
    const live = state.selectedSessionId !== null && isSessionLiveish(state, state.selectedSessionId);
    const resumable = session !== undefined && (session.status === "ended" || session.status === "failed");
    if (!state.selectedSessionId) {
      restart.classList.add("disabled");
      resume.classList.add("disabled");
      end.classList.add("disabled");
      del.classList.add("disabled");
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

  async function loadReviewState(): Promise<void> {
    const response = await request({ type: "review.state", ...(state.selectedSessionId ? { sessionId: state.selectedSessionId } : {}) });
    if (response.ok && response.payload.type === "review.state") {
      reviewComments = response.payload.comments;
      renderReviewComments();
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
      ...("nodeStatus" in line && typeof line.nodeStatus === "string" ? { nodeStatus: line.nodeStatus } : {}),
      ...("toolStatus" in line && typeof line.toolStatus === "string" ? { toolStatus: line.toolStatus } : {}),
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
    if ("detail" in line && typeof line.detail === "string") group.promptPreview = line.detail;
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
   * and the body is empty.
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
      for (const mount of iso.mounts) {
        const row = el("div", "context-mount-row");
        const modeChip = el("span", `chip mode-${mount.mode === "read-write" ? "read-write" : "read-only"}`);
        modeChip.textContent = mount.mode === "read-write" ? "rw" : "ro";
        const path = el("span", "context-mount-path");
        path.textContent = `${mount.runtimePath}${mount.hostDisplayPath ? ` ← ${mount.hostDisplayPath}` : ""}`;
        row.append(modeChip, path);
        mountsBody.append(row);
      }
      return;
    }
    // Before a session starts: the summary shows the upcoming context.
    if (state.selectedWorkspaceSetId) {
      const set = state.workspacePolicy?.workspaceSets.find((s) => s.workspaceSetId === state.selectedWorkspaceSetId);
      mountsSummary.textContent = set ? `Set: ${set.name}` : "Set selected";
    } else if (state.openFolderNames.length > 0) {
      mountsSummary.textContent = `Auto: ${state.openFolderNames.join(", ")}`;
    } else {
      mountsSummary.textContent = "No mounts";
    }
  }

  function renderProviderControls(preserveSelection = true): void {
    const previousProvider = normalizeProviderId(providerSelect.value || state.providerId);
    const previousModel = preserveSelection ? (modelSelect.value || state.selectedModel) : "";
    const selectedSession = currentSession(state);
    const desiredProvider = normalizeProviderId(preserveSelection ? selectedSession?.providerId ?? previousProvider : previousProvider);
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
      const selectedModel = selectedSession?.providerId === providerSelect.value
        ? selectedSession.model ?? previousModel
        : previousModel;
      const defaultModel = catalog.models.find((model) => model.isDefault)?.id ?? catalog.models[0]?.id ?? "";
      modelSelect.value = catalog.models.some((model) => model.id === selectedModel) ? selectedModel : defaultModel;
      state.selectedModel = modelSelect.value;
    }

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

  function renderChat(): void {
    // The lens strip appears once a session is selected; the spawn-role
    // control only for live-in-this-window sessions (a child needs a live
    // parent to inherit mounts from).
    const session = currentSession(state);
    lensStrip.classList.toggle("hidden", session === undefined);
    const canSpawn = session !== undefined
      && (session.status === "active" || session.status === "starting")
      && session.runningElsewhere !== true;
    spawnRoleSelect.classList.toggle("hidden", !canSpawn);
    if (transcriptView === "agents") renderAgentsLens();
    chatLog.replaceChildren();
    if (state.chatMessages.length === 0) {
      // Empty transcript orients the first-run user: a call to action plus a dim
      // line naming the mode consequences the [Chat|Plan|Clone] segment hides.
      // textContent only. Clone is an "isolated copy" that reaches the
      // user by pull — deliberately NOT a worktree.
      const empty = el("div", "chat-empty");
      const lead = el("div", "chat-empty-lead");
      lead.textContent = "Ask the isolated agent to start.";
      const modes = el("div", "chat-empty-modes");
      modes.textContent = "Chat = edits your files (read-write) · Plan = read-only · Clone = isolated copy, changes reach you by pull";
      empty.append(lead, modes);
      chatLog.append(empty);
      return;
    }
    for (const message of state.chatMessages) {
      chatLog.append(chatMessageRow(message));
    }
    // Keep the transcript pinned to the newest entry as it grows/streams.
    transcriptRegion.scrollTop = transcriptRegion.scrollHeight;
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
      body.textContent = message.text;
      row.append(body);
    } else {
      const body = el("div", "chat-assistant-body");
      // Structural markdown: mermaid fences render as CODE here (no diagram).
      for (const block of splitBlocks(message.text, "markdown")) {
        body.append(assistantBlock(block));
      }
      if (streaming) body.append(el("span", "stream-cursor"));
      row.append(body);
    }
    return row;
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
    if (calls > 0) parts.push(`${String(calls)} call${calls === 1 ? "" : "s"}`);
    if (group.fileEdits > 0) parts.push(`${String(group.fileEdits)} file${group.fileEdits === 1 ? "" : "s"}`);
    parts.push(durationLabel(group.createdAt, group.endedAt));
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
    const tokens = usageTokens(group.usage);
    if (tokens !== null) {
      const usageRow = el("div", "agent-group-usage");
      usageRow.textContent = `${String(tokens)} tokens`;
      body.append(usageRow);
    }
    details.append(body);
    return details;
  }

  /**
   * The Agents lens: the same feed as the Log, viewed hierarchy-first.
   * Native subagents come from the contracts tree reducer over the structured
   * diagnostics; product-owned role sessions graft in from the
   * session list as `role-session` rows. Clicking a native node jumps to its
   * expanded Log group; clicking a role session opens that session.
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
    const tree = reduceAgentTree(state.diagnostics.map((entry) => treeSourceFromLine(entry)));
    const tier = sessionSubagentTier();
    const byParent = new Map<string | undefined, AgentTreeNode[]>();
    for (const node of tree.nodes) {
      const list = byParent.get(node.parentId) ?? [];
      list.push(node);
      byParent.set(node.parentId, list);
    }

    const renderNode = (node: AgentTreeNode, depth: number): void => {
      const row = el("div", `agents-lens-row status-${node.status}${node.kind === "root" ? " is-root" : ""}`);
      row.style.paddingLeft = `${String(depth * 14)}px`;
      const dot = el("span", `agent-group-dot status-${node.status === "running" && node.kind === "root" && !turnActive ? "completed" : node.status}`);
      const label = el("span", "agents-lens-label");
      label.textContent = node.kind === "root"
        ? `${session.providerId}${session.model === undefined ? "" : `/${session.model}`}`
        : `⑂ ${node.label}`;
      row.append(dot, label);
      if (node.subagentType !== undefined || node.model !== undefined) {
        const type = el("span", "agents-lens-meta");
        type.textContent = node.subagentType ?? node.model ?? "";
        row.append(type);
      }
      const calls = node.counts.toolCalls + node.counts.commands;
      const meta = el("span", "agents-lens-meta");
      const bits: string[] = [];
      if (calls > 0) bits.push(`${String(calls)} call${calls === 1 ? "" : "s"}`);
      if (node.counts.fileEdits > 0) bits.push(`${String(node.counts.fileEdits)} file${node.counts.fileEdits === 1 ? "" : "s"}`);
      if (node.counts.errors > 0) bits.push(`${String(node.counts.errors)} err`);
      const tokens = usageTokens(node.usage);
      if (tokens !== null) bits.push(`${String(tokens)} tok`);
      meta.textContent = bits.join(" · ");
      row.append(meta);
      if (node.status === "failed") {
        const chip = el("span", "agent-group-chip chip-failed");
        chip.textContent = "· failed";
        row.append(chip);
      } else if (node.lastActivity !== undefined && node.status === "running") {
        const activity = el("span", "agents-lens-activity");
        activity.textContent = node.lastActivity;
        row.append(activity);
      }
      if (node.kind !== "root") {
        row.classList.add("clickable");
        row.addEventListener("click", () => {
          // Jump to the node's expanded group in the Log.
          expandedGroups.add(node.nodeId);
          setTranscriptView("log");
          renderChat();
          document.getElementById(`agent-group-${node.nodeId}`)?.scrollIntoView({ block: "center" });
        });
      }
      agentsLens.append(row);
      for (const child of byParent.get(node.nodeId) ?? []) {
        renderNode(child, depth + 1);
      }
    };
    const root = tree.nodes.find((node) => node.kind === "root");
    if (root !== undefined) renderNode(root, 0);

    // Child role sessions of this session, grafted under the root.
    const roleChildren = state.sessions.filter((candidate) => candidate.parentSessionId === session.sessionId);
    for (const child of roleChildren) {
      const row = el("div", `agents-lens-row role-session status-${child.status} clickable`);
      row.style.paddingLeft = "14px";
      const dot = el("span", `agent-group-dot status-${child.status === "active" || child.status === "starting" ? "running" : child.status === "failed" ? "failed" : "completed"}`);
      const label = el("span", "agents-lens-label");
      label.textContent = `⑂ ${child.title}`;
      const roleChip = el("span", "agents-lens-meta");
      roleChip.textContent = `${child.spawnedRole ?? "role"} session · ${child.status}`;
      row.append(dot, label, roleChip);
      row.addEventListener("click", () => selectSession(child.sessionId));
      agentsLens.append(row);
    }

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

  /** Subagent reporting tier for the SELECTED session's transport. */
  function sessionSubagentTier(): string {
    const transport = currentSession(state)?.transport;
    return transport === undefined ? "none" : subagentReportingForTransport(transport);
  }

  function durationLabel(startedAt: string, endedAt: string | undefined): string {
    const end = endedAt === undefined ? Date.now() : new Date(endedAt).getTime();
    const seconds = Math.max(0, Math.round((end - new Date(startedAt).getTime()) / 1000));
    if (seconds < 60) return `${String(seconds)}s`;
    return `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`;
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
      case "mermaid": {
        // Mermaid fences show as code (with a language badge) — no diagram here.
        const figure = el("div", "md-code");
        const badge = el("span", "md-code-badge");
        badge.textContent = block.kind === "mermaid"
          ? "mermaid"
          : (block.language && block.language.length > 0 ? block.language : "code");
        const pre = document.createElement("pre");
        pre.className = "md-pre";
        const code = document.createElement("code");
        code.textContent = block.text;
        pre.append(code);
        figure.append(badge, pre);
        return figure;
      }
      case "paragraph":
      default: {
        const p = el("p", "md-paragraph");
        p.textContent = block.text;
        return p;
      }
    }
  }

  /**
   * Renders the SELECTED session's pending questions + access requests as ONE
   * stacked card with a `‹ i/N ›` pager (attention stack) instead of a pile of
   * full cards. Oldest-first across both kinds, so the pager walks items in
   * the order the agent raised them. Reconciles against the latest
   * `state.workspacePolicy`/`state.questions` on every call, so items resolved
   * elsewhere (e.g. the Work tab) never linger.
   */
  const attentionCursor = { index: 0 };
  function renderAccessCards(): void {
    accessCardsWrap.replaceChildren();
    if (!state.selectedSessionId) return;
    const items = sessionAttentionItems(state.selectedSessionId);
    renderAttentionStack(accessCardsWrap, items, attentionCursor, {
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
  }

  /** Pending questions + access requests for one session, oldest first. */
  function sessionAttentionItems(sessionId: string): AttentionItem[] {
    const access: AttentionItem[] = (state.workspacePolicy?.accessRequests ?? [])
      .filter((candidate) => candidate.sessionId === sessionId && candidate.status === "pending")
      .map((candidate) => ({ kind: "access", access: candidate }));
    const questions: AttentionItem[] = state.questions
      .filter((candidate) => candidate.sessionId === sessionId && candidate.status === "pending")
      .map((candidate) => ({ kind: "question", question: candidate }));
    return [...access, ...questions].sort((a, b) => {
      const aAt = a.kind === "access" ? a.access.requestedAt : a.question.createdAt;
      const bAt = b.kind === "access" ? b.access.requestedAt : b.question.createdAt;
      return aAt < bAt ? -1 : 1;
    });
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
    diagnosticsLog.replaceChildren();
    if (state.diagnostics.length === 0) {
      const empty = el("div", "empty");
      empty.textContent = "No diagnostics.";
      diagnosticsLog.append(empty);
      return;
    }
    for (const entry of state.diagnostics) {
      diagnosticsLog.append(diagnosticRow(entry));
    }
    diagnosticsLog.scrollTop = diagnosticsLog.scrollHeight;
  }

  function diagnosticRow(entry: DiagnosticEntry): HTMLElement {
    const row = el("div", `diagnostic-row kind-${entry.eventType.replace(/\./g, "-")}`);
    const meta = el("span", "diagnostic-meta");
    meta.textContent = `${formatTime(entry.createdAt)} ${entry.eventType} `;
    const text = el("span", "diagnostic-text");
    text.textContent = entry.summary;
    row.append(meta, text);
    return row;
  }

  /** Facts grid from the SELECTED session record (actual provider/model), not the picker. */
  function renderFacts(): void {
    factsGrid.replaceChildren();
    const session = currentSession(state);
    const iso = state.lastIsolation;
    const rows: [string, string][] = [];
    rows.push(["session id", session?.sessionId ?? "—"]);
    rows.push(["provider", session?.providerId ?? "—"]);
    rows.push(["model", session?.model ?? "—"]);
    if (iso) {
      rows.push(["runtime", iso.runtimeKind]);
      rows.push(["workspace", iso.workspaceDisplayPath]);
      rows.push(["mounts", String(iso.mounts.length)]);
      rows.push(["network", iso.network === "provider-scoped" ? `provider-scoped (${iso.networkAllowlist ?? ""})` : "none"]);
    }
    for (const [key, value] of rows) {
      const k = el("span", "fact-key");
      k.textContent = key;
      const v = el("span", "fact-value");
      v.textContent = value;
      factsGrid.append(k, v);
    }
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

  function renderReviewComments(): void {
    reviewList.replaceChildren();
    if (reviewComments.length === 0) {
      const empty = el("div", "empty");
      empty.textContent = "No review comments.";
      reviewList.append(empty);
      return;
    }
    for (const comment of reviewComments) {
      const row = el("div", "review-comment-row");
      const meta = el("span", "diagnostic-meta");
      meta.textContent = `${comment.filePath}:${String(comment.startLine)}-${String(comment.endLine)} `;
      const body = el("span", "diagnostic-text");
      body.textContent = comment.body;
      const statusSelect = select("");
      for (const status of REVIEW_STATUSES) statusSelect.append(option(status, status));
      statusSelect.value = comment.status;
      statusSelect.addEventListener("change", () => {
        const status = statusSelect.value as ReviewThreadStatus;
        void request({ type: "review.setCommentStatus", commentId: comment.commentId, status }).then((response) => {
          if (!response.ok) logChat(`status change failed: ${response.error.message}`);
          void loadReviewState();
        });
      });
      // Mini-task from a comment: create a task, link the current chat (if any),
      // mark the thread delegated, then refresh comments + tasks. Disabled in flight.
      const toTask = iconButton("→ task", "Create a task from this comment", "comment-to-task");
      toTask.addEventListener("click", () => {
        toTask.disabled = true;
        void createTaskFromComment(comment).finally(() => { toTask.disabled = false; });
      });
      row.append(meta, body, statusSelect, toTask);
      reviewList.append(row);
    }
  }

  /**
   * Turns a review comment into a task: task.create {title, description} →
   * task.link {sessionId} (when a session is selected) → review.setCommentStatus
   * {delegated} → refresh comments + Work-tab tasks. Any step failing logs one
   * line and stops (earlier steps stay). The new task is upserted into shared
   * state so the Work tab shows it without a round-trip.
   */
  async function createTaskFromComment(comment: ReviewCommentSummary): Promise<void> {
    const title = `Review: ${comment.body.slice(0, 60)}`;
    const description = `From a review comment on ${comment.filePath}:${String(comment.startLine)}-${String(comment.endLine)}`;
    const createResponse = await request({ type: "task.create", title, description });
    if (!createResponse.ok || createResponse.payload.type !== "task.create") {
      logChat(`comment → task failed: ${createResponse.ok ? "unexpected response" : createResponse.error.message}`);
      return;
    }
    const task = createResponse.payload.task;
    upsertTask(state, task);
    if (state.selectedSessionId) {
      const linkResponse = await request({ type: "task.link", taskId: task.taskId, sessionId: state.selectedSessionId });
      if (!linkResponse.ok) {
        logChat(`comment → task link failed: ${linkResponse.error.message}`);
      } else if (linkResponse.payload.type === "task.link") {
        upsertTask(state, linkResponse.payload.task);
      }
    }
    const statusResponse = await request({ type: "review.setCommentStatus", commentId: comment.commentId, status: "delegated" });
    if (!statusResponse.ok) logChat(`comment → task status update failed: ${statusResponse.error.message}`);
    logChat(`created task from comment: ${title}`);
    ctx.persist();
    void loadReviewState();
    ctx.bridge.work.render();
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
      return;
    }
    promptInput.disabled = false;
    promptInput.placeholder = "Ask the isolated agent…";
    const disabled = starting || backendBusy;
    sendButton.disabled = disabled || turnActive;
    cancelButton.classList.toggle("hidden", !turnActive);
    const hasModelOptions = modelSelect.options.length > 0 && modelSelect.options[0]?.value !== "";
    providerSelect.disabled = backendBusy || turnActive || starting;
    modelSelect.disabled = !hasModelOptions || backendBusy || turnActive || starting;
  }

  // ---------------------------------------------------------------------------
  // Drag-drop of file paths into the composer
  // ---------------------------------------------------------------------------
  /**
   * Files dragged from the VS Code explorer (or the OS) onto the transcript or
   * composer append their paths to the textarea (one per line). Paths under a
   * known mount host root are rewritten relative to that root (what the agent can
   * actually see); otherwise the absolute path is inserted and a diagnostics line
   * notes that it is not mounted. Text insertion only — no new messages.
   */
  function wireComposerDropTarget(): void {
    const zones = [transcriptRegion, composer];
    for (const zone of zones) {
      zone.addEventListener("dragover", (event) => {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        zone.classList.add("drop-active");
      });
      zone.addEventListener("dragleave", (event) => {
        // Only clear when the pointer actually leaves the zone (not a child).
        if (event.relatedTarget instanceof Node && zone.contains(event.relatedTarget)) return;
        zone.classList.remove("drop-active");
      });
      zone.addEventListener("drop", (event) => {
        event.preventDefault();
        zone.classList.remove("drop-active");
        handleDrop(event);
      });
    }
  }

  function handleDrop(event: DragEvent): void {
    const data = event.dataTransfer;
    if (!data) return;
    // Prefer a uri-list (explorer/OS file drops); fall back to plain text.
    const uriList = data.getData("text/uri-list");
    const raw = uriList && uriList.trim().length > 0 ? uriList : data.getData("text/plain");
    if (!raw || raw.trim().length === 0) return;
    const paths = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map(fileUriToPath);
    if (paths.length === 0) return;

    const inserted: string[] = [];
    for (const path of paths) {
      const rel = toMountRelative(path);
      if (rel !== null) {
        inserted.push(rel);
      } else {
        inserted.push(path);
        logChat(`note: ${path} is not mounted — the agent can request access to it`);
      }
    }
    insertIntoComposer(inserted);
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
   * If `absPath` sits under a live mount's host root, returns the runtime path
   * (mount root + relative remainder); otherwise null. Case-insensitive compare
   * on Windows-style paths so "C:\\x" matches "c:/x".
   */
  function toMountRelative(absPath: string): string | null {
    const iso = state.lastIsolation;
    if (iso === null) return null;
    const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");
    const needle = norm(absPath).toLowerCase();
    for (const mount of iso.mounts) {
      const host = mount.hostDisplayPath;
      if (host === undefined || host.length === 0) continue;
      const root = norm(host).toLowerCase();
      if (needle === root) return mount.runtimePath;
      if (needle.startsWith(`${root}/`)) {
        const remainder = norm(absPath).slice(root.length).replace(/^\/+/, "");
        return `${mount.runtimePath.replace(/\/+$/, "")}/${remainder}`;
      }
    }
    return null;
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
    state.chatMessages = [];
    state.diagnostics = [];
    state.agentGroups = {};
    expandedGroups.clear();
    state.lastSequence = 0;
    activeAssistantId = null;
    state.changedFiles.clear();
    diffChanges = [];
    cloneRepos = [];
    reviewComments = [];
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
    renderReviewComments();
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
      void loadReviewState();
      void loadPlanDocs();
    }
  }

  function resetToNewChat(): void {
    state.selectedSessionId = null;
    state.chatMessages = [];
    state.diagnostics = [];
    state.agentGroups = {};
    expandedGroups.clear();
    state.lastSequence = 0;
    activeAssistantId = null;
    state.changedFiles.clear();
    diffChanges = [];
    cloneRepos = [];
    reviewComments = [];
    openedDiffKeys = new Set();
    state.planDocs = null;
    setTurnActive(false);
    renderHeader();
    renderContextStrip();
    renderProviderControls();
    renderChat();
    renderDiagnostics();
    renderChangedFiles();
    renderReviewComments();
    renderFacts();
    renderAccessCards();
    renderPlanDocs();
    ctx.persist();
  }

  function render(): void {
    applyModeButtons();
    renderHeader();
    renderContextStrip();
    renderProviderControls();
    renderChat();
    renderDiagnostics();
    renderChangedFiles();
    renderReviewComments();
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
  onConfirm: () => void
): void {
  let armed = false;
  let timer = 0;
  const disarm = (): void => {
    armed = false;
    node.textContent = glyph;
    node.title = title;
    node.classList.remove("armed");
    if (timer) window.clearTimeout(timer);
  };
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!armed) {
      armed = true;
      node.textContent = confirmGlyph;
      node.title = "Confirm discard?";
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
