/**
 * Tasks tab: overview of pending attention, tasks, and advanced workspace
 * controls.
 *
 * - "Needs attention" strip: pending access requests as cards (approve/deny).
 * - Tasks: the primary work container. Linked chats render inside task cards;
 *   old unlinked chats appear only in the small "needs task" cleanup section.
 * - Workspace sets (advanced, collapsed): register open folders / create set /
 *   pick the set consumed by the Chat context strip + chat.start.
 *
 * The manual request-access form and the entire docs-review UI are removed.
 *
 * SECURITY: all dynamic strings render via textContent — never innerHTML.
 * Re-renders use replaceChildren so per-card handlers cannot leak.
 */

import {
  WORK_TASK_STATES,
  type AccessRequestSummary,
  type AgentActivityItem,
  type AgentActivitySummary,
  type ChatSessionSummary,
  type MemoryCandidateSummary,
  type WorkHistoryEntry,
  type WorkspaceActivateResult,
  type WorkTaskState,
  type WorkTaskSummary
} from "@drydock/contracts";
import {
  badge,
  button,
  card,
  chip,
  collapsible,
  el,
  iconButton,
  inlineConfirmButton,
  option,
  relativeTime,
  select,
  statusDot,
  textInput
} from "../components.js";
import { onPush, request } from "../messaging.js";
import {
  applySessionAttention,
  upsertMemoryCandidate,
  upsertSession,
  upsertTask
} from "../state.js";
import type { ViewContext, WorkTabView } from "../viewContext.js";
import { renderAttentionStack, type AttentionItem } from "./attentionStack.js";

/** One session-row chip: display text + a kind-namespaced CSS class. */
interface SessionChip {
  readonly text: string;
  readonly cls: string;
}

/**
 * True when a session must be acted on now (loudness rule): the session
 * failed, its turn failed, or it has a pending access request. Loud rows get the
 * red/amber halo + bold chip and sort first.
 */
function isSessionLoud(session: ChatSessionSummary, reasons: readonly string[]): boolean {
  return session.status === "failed"
    || reasons.includes("turn-failed")
    || reasons.includes("access-request")
    || reasons.includes("question");
}

/** True when a benign turn completed and the row is not otherwise loud (demotion). */
function isSessionReady(session: ChatSessionSummary, reasons: readonly string[]): boolean {
  return reasons.includes("turn-completed") && !isSessionLoud(session, reasons);
}

/**
 * Ordered title-line chips for a session row. ONE helper so the whole
 * chip vocabulary — and its ordering — lives in a single place.
 *
 * FORWARD-COMPAT (next phase, multi-agent roles): a per-session `role` chip
 * (orchestrator / researcher / worker) becomes one more `{ text, cls }` entry
 * appended here (e.g. `chip-role`) with zero layout rework in the renderer.
 *
 * Classes are kind-namespaced (`.session-chip.chip-failed` etc.) so a new kind
 * only adds a colour rule, never touches the others. `reasons` is the session's
 * active attention list (highest-severity treatment wins for the state chip).
 */
function sessionChips(
  session: ChatSessionSummary,
  reasons: readonly string[],
  activity?: AgentActivitySummary
): SessionChip[] {
  const chips: SessionChip[] = [];
  // State chip: failed (loud) > approval (loud) > ready (demoted). At most one.
  if (session.status === "failed" || reasons.includes("turn-failed")) {
    chips.push({ text: "· failed", cls: "chip-failed" });
  } else if (reasons.includes("access-request")) {
    chips.push({ text: "· approval", cls: "chip-approval" });
  } else if (reasons.includes("question")) {
    chips.push({ text: "· question", cls: "chip-approval" });
  } else if (reasons.includes("turn-completed")) {
    chips.push({ text: "· ready", cls: "chip-ready" });
  }
  // Role chip: the promised forward-compat entry — a spawned child
  // session names its role.
  if (session.spawnedRole !== undefined) {
    chips.push({ text: session.spawnedRole, cls: "chip-role" });
  }
  // Subagent chip: ⑂ N while children run; failed accent when one died.
  const live = activity ?? session.agentActivity;
  if (live !== undefined && (live.running > 0 || live.failed > 0)) {
    chips.push({
      text: live.running > 0 ? `⑂ ${String(live.running)}` : "⑂",
      cls: live.failed > 0 ? "chip-subagents chip-subagents-failed" : "chip-subagents"
    });
  }
  // Clone chip: unchanged kind, kept in the same ordered list.
  if (session.mode === "clone") {
    chips.push({ text: "clone", cls: "chip-clone" });
  }
  return chips;
}

/**
 * Ordered meta-line segments for a session row, joined with " · " by the caller.
 * ONE helper so the meta line is composed in a single place.
 *
 * FORWARD-COMPAT (next phase, multi-agent roles): a `role` segment (e.g. the
 * session's agent role) is one insert into this array — no caller change.
 *
 * Returns [providerModel, stateWord, timeWord]. The caller wraps the stateWord
 * in a `.meta-word-failed` span on a failed row (red accent) instead of the
 * plain " · " join, so the red word rides this same single source of truth.
 */
function sessionMetaSegments(session: ChatSessionSummary): string[] {
  const providerModel = `${session.providerId}${session.model ? `/${session.model}` : ""}`;
  return [providerModel, sessionStateLabel(session), relativeTime(session.updatedAt)];
}

/**
 * Row-ordering comparator with a named loudness rule: LOUD rows first,
 * then READY rows, then the rest — each group stable in the existing
 * newest-first order (the input array is already newest-first by updatedAt).
 *
 * FORWARD-COMPAT (next phase): role weighting extends THIS single function
 * (e.g. an orchestrator row could tie-break above workers) — nothing else moves.
 */
function sessionLoudness(session: ChatSessionSummary, reasons: readonly string[]): number {
  if (isSessionLoud(session, reasons)) return 0; // loudest
  if (isSessionReady(session, reasons)) return 1;
  return 2;
}

/** "running elsewhere" | "running" | "ended" | "failed" — the state the row shows. */
function sessionStateLabel(session: ChatSessionSummary): string {
  if (session.runningElsewhere === true) return "running elsewhere";
  if (session.status === "active" || session.status === "starting") return "running";
  if (session.status === "failed") return "failed";
  return "ended";
}

function durationLabel(startedAt: string | undefined, endedAt: string | undefined): string {
  if (startedAt === undefined) return "";
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return "";
  const end = endedAt === undefined ? Date.now() : Date.parse(endedAt);
  const seconds = Math.max(0, Math.round(((Number.isFinite(end) ? end : Date.now()) - start) / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  return `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`;
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

const TASK_STATE_LABELS: Record<WorkTaskState, string> = {
  "todo": "To do",
  "in-progress": "In progress",
  "blocked": "Blocked",
  "review": "Review",
  "done": "Done"
};

/** One-line log summary of a workspace.activate outcome. */
function activateOutcomeLine(result: WorkspaceActivateResult): string {
  switch (result.outcome) {
    case "replaced": return `workspace replaced: +${String(result.added)} −${String(result.removed)}`;
    case "appended": return `appended ${String(result.added)} folder(s)`;
    case "new-window": return "opened in a new window";
    case "no-change": return "already active";
    case "cancelled": return "cancelled";
  }
}

export function createWorkTab(ctx: ViewContext): WorkTabView {
  const state = ctx.state;
  const root = el("div", "work-tab");

  // --- Needs attention (collapsed one-line summary, expands in place) ---------
  // At rest this is a single line (`⚠ N requests · M failed — review`); clicking
  // it toggles the full access cards (typed-confirm and all — no friction
  // removed). Expansion state is webview-session-local (not persisted). The whole
  // section hides when there is nothing to act on.
  const attentionSection = el("div", "attention-section");
  const attentionSummary = el("button", "attention-summary");
  attentionSummary.setAttribute("aria-expanded", "false");
  const attentionList = el("div", "attention-list hidden");
  attentionSection.append(attentionSummary, attentionList);
  let attentionExpanded = false;
  attentionSummary.addEventListener("click", () => {
    attentionExpanded = !attentionExpanded;
    attentionList.classList.toggle("hidden", !attentionExpanded);
    attentionSummary.setAttribute("aria-expanded", attentionExpanded ? "true" : "false");
  });

  // --- Tasks ------------------------------------------------------------------
  // Task-first creation flow: the title row carries a ▸ toggle that expands an
  // inline form (description + workspace picker + Create / Create & start chat).
  // The form also expands when the title input gains focus, so the fast path
  // (type a title, Enter) still works without any extra click.
  const tasksHeading = el("h3");
  tasksHeading.textContent = "Tasks";

  const taskCreateForm = el("div", "task-create-form");
  const taskCreateRow = el("div", "button-row");
  const expandToggle = iconButton("▸", "More task options", "task-create-toggle");
  const taskTitleInput = textInput("New task…");
  // R10: the lighter "just add a row" action is the plain secondary and names the
  // difference; the accent goes to "Create & start chat" (the task-first path).
  const taskAddButton = button("Create task only", "small");
  taskCreateRow.append(expandToggle, taskTitleInput, taskAddButton);

  const expandable = el("div", "task-create-expandable hidden");
  const taskDescInput = document.createElement("textarea");
  taskDescInput.className = "note-input task-create-desc";
  taskDescInput.rows = 2;
  taskDescInput.placeholder = "Description (optional)";
  const taskWorkspaceSelect = select("task-create-workspace", "Workspace mounted into a started chat");
  // R10: primary (accent) — the task-first happy path (spins a runtime + chat).
  const startChatButton = button("Create & start chat", "small primary");
  const startChatRow = el("div", "button-row");
  startChatRow.append(taskWorkspaceSelect, startChatButton);
  expandable.append(taskDescInput, startChatRow);
  taskCreateForm.append(taskCreateRow, expandable);
  const tasksList = el("div", "task-cards");

  let formExpanded = false;
  const setFormExpanded = (next: boolean): void => {
    formExpanded = next;
    expandable.classList.toggle("hidden", !next);
    expandToggle.textContent = next ? "▾" : "▸";
    if (next) renderTaskWorkspaceOptions();
  };
  expandToggle.addEventListener("click", () => setFormExpanded(!formExpanded));
  taskTitleInput.addEventListener("focus", () => { if (!formExpanded) setFormExpanded(true); });

  /** Rebuilds the creation-form workspace picker from current state. */
  function renderTaskWorkspaceOptions(): void {
    const previous = taskWorkspaceSelect.value;
    taskWorkspaceSelect.replaceChildren();
    if (state.openFolderNames.length > 0) {
      taskWorkspaceSelect.append(option("auto", `Auto: ${state.openFolderNames.join(", ")}`));
    }
    for (const set of state.workspacePolicy?.workspaceSets ?? []) {
      taskWorkspaceSelect.append(option(`set:${set.workspaceSetId}`, set.name));
    }
    taskWorkspaceSelect.append(option("none", "No workspace"));
    // Preserve the prior choice when it still exists; else prefer auto, then none.
    if ([...taskWorkspaceSelect.options].some((o) => o.value === previous)) {
      taskWorkspaceSelect.value = previous;
    } else {
      taskWorkspaceSelect.value = state.openFolderNames.length > 0 ? "auto" : "none";
    }
  }

  /** Resolves the picker value → the workspaceSetId to link (null = none/auto). */
  function pickedWorkspaceSetId(): string | null {
    const value = taskWorkspaceSelect.value;
    return value.startsWith("set:") ? value.slice(4) : null;
  }

  /** Picker value → the chat.startSession workspace selection (undefined = omit). */
  function pickedChatWorkspace(): { workspaceSetId: string; mode: "implementation" } | { auto: true; mode: "implementation" } | undefined {
    const value = taskWorkspaceSelect.value;
    if (value.startsWith("set:")) return { workspaceSetId: value.slice(4), mode: "implementation" };
    if (value === "auto") return { auto: true, mode: "implementation" };
    return undefined;
  }

  const setCreateButtonsDisabled = (disabled: boolean): void => {
    taskAddButton.disabled = disabled;
    startChatButton.disabled = disabled;
  };

  /** Creates the task; returns the new task or null on failure (already logged). */
  async function submitTaskCreate(): Promise<WorkTaskSummary | null> {
    const title = taskTitleInput.value.trim();
    if (!title) return null;
    const description = taskDescInput.value.trim();
    const response = await request({ type: "task.create", title, ...(description ? { description } : {}) });
    if (!response.ok) {
      ctx.bridge.chat.logChat(`create task failed: ${response.error.message}`);
      return null;
    }
    if (response.payload.type !== "task.create") return null;
    upsertTask(state, response.payload.task);
    return response.payload.task;
  }

  /** Clears the form inputs and collapses it after a successful create. */
  function resetTaskCreateForm(): void {
    taskTitleInput.value = "";
    taskDescInput.value = "";
    setFormExpanded(false);
  }

  // Plain Create: task.create [+ task.link {workspaceSetId} when a set is picked].
  const createTask = (): void => {
    if (!taskTitleInput.value.trim()) return;
    setCreateButtonsDisabled(true);
    void (async (): Promise<void> => {
      const task = await submitTaskCreate();
      if (task === null) { setCreateButtonsDisabled(false); return; }
      const setId = formExpanded ? pickedWorkspaceSetId() : null;
      if (setId !== null) {
        const linked = await linkTaskAwait(task.taskId, { workspaceSetId: setId });
        if (linked === null) { setCreateButtonsDisabled(false); return; }
      }
      resetTaskCreateForm();
      renderTasks();
      renderSessions();
      ctx.persist();
      setCreateButtonsDisabled(false);
    })();
  };
  taskAddButton.addEventListener("click", createTask);
  taskTitleInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); createTask(); }
  });

  /**
   * Create & start chat: task.create → (set picked → task.link {workspaceSetId})
   * → chat.startSession {model, workspace} → task.link {sessionId} → upsert the
   * session, select it, jump to Chat. Buttons disabled while in flight; on any
   * step failing we log to chat diagnostics and stop — earlier steps stay (a
   * created task without a chat is a fine partial outcome).
   */
  const createTaskAndStartChat = (): void => {
    if (!taskTitleInput.value.trim()) return;
    setCreateButtonsDisabled(true);
    void (async (): Promise<void> => {
      const task = await submitTaskCreate();
      if (task === null) { setCreateButtonsDisabled(false); return; }
      const setId = pickedWorkspaceSetId();
      if (setId !== null) {
        const linked = await linkTaskAwait(task.taskId, { workspaceSetId: setId });
        if (linked === null) { renderTasks(); ctx.persist(); setCreateButtonsDisabled(false); return; }
      }
      // Start the chat with the panel's current provider/model selection.
      const model = { providerId: state.providerId, ...(state.selectedModel ? { model: state.selectedModel } : {}) };
      const workspace = pickedChatWorkspace();
      const startResponse = await request({
        type: "chat.startSession",
        model,
        ...(workspace ? { workspace } : {})
      });
      if (!startResponse.ok || startResponse.payload.type !== "chat.startSession") {
        ctx.bridge.chat.logChat(`start chat failed: ${startResponse.ok ? "unexpected response" : startResponse.error.message}`);
        renderTasks(); ctx.persist(); setCreateButtonsDisabled(false);
        return;
      }
      const session = startResponse.payload.session;
      upsertSession(state, session);
      state.providerCatalogs = [...startResponse.payload.providerCatalogs];
      // Link the new session to the task.
      const linkedSession = await linkTaskAwait(task.taskId, { sessionId: session.sessionId });
      if (linkedSession === null) {
        // The chat exists and is upserted; only the link failed (already logged).
        resetTaskCreateForm();
        renderTasks(); renderSessions(); ctx.persist();
        ctx.bridge.chat.selectSession(session.sessionId);
        ctx.bridge.switchTab("chat");
        setCreateButtonsDisabled(false);
        return;
      }
      resetTaskCreateForm();
      renderTasks();
      renderSessions();
      ctx.persist();
      ctx.bridge.chat.selectSession(session.sessionId);
      ctx.bridge.switchTab("chat");
      setCreateButtonsDisabled(false);
    })();
  };
  startChatButton.addEventListener("click", createTaskAndStartChat);

  // --- Memory (collapsed) -----------------------------------------------------
  // Agent-proposed memory candidates: pending cards (Approve / Reject) plus a dim
  // collapsed "Approved (N)" sub-list. Memory is not urgent — no toast/attention.
  const memorySection = collapsible("Memory");
  const memoryPending = el("div", "memory-pending");
  const memoryApproved = collapsible("Approved (0)");
  memoryApproved.details.classList.add("memory-approved");
  const memoryApprovedList = el("div", "memory-approved-list");
  memoryApproved.body.append(memoryApprovedList);
  memorySection.body.append(memoryPending, memoryApproved.details);

  // --- Chats needing a task --------------------------------------------------
  // Chats are owned by a task in the main UI. This collapsed cleanup drawer is
  // only for legacy/orphan sessions that have not been linked yet.
  const unassignedSessionsSection = collapsible("Chats needing a task");
  const sessionsList = el("div", "session-cards");
  unassignedSessionsSection.body.append(sessionsList);

  // --- Workspace sets (advanced) ---------------------------------------------
  const workspaceSets = collapsible("Workspace sets (advanced)");
  const registerFoldersButton = button("Register open folders", "small");
  const setNameInput = textInput("New set name");
  const createSetButton = button("Create set", "small");
  const setCreateRow = el("div", "button-row");
  setCreateRow.append(registerFoldersButton, setNameInput, createSetButton);
  const workspaceSetSelect = select("set-select", "Workspace set mounted into new chats");
  const modeSelect = select("mode-select", "Session mode for new chats");
  modeSelect.append(option("plan", "plan (read-only)"), option("implementation", "implementation (read-write)"));
  const setPickRow = el("div", "button-row");
  setPickRow.append(workspaceSetSelect, modeSelect);
  // Explicit set rows (each a touch-history hover anchor); populated in render.
  const setsList = el("div", "sets-list");
  const projectsList = el("div", "projects-list");
  workspaceSets.body.append(setCreateRow, setPickRow, setsList, projectsList);

  workspaceSetSelect.addEventListener("change", () => {
    state.selectedWorkspaceSetId = workspaceSetSelect.value;
    ctx.persist();
    ctx.bridge.chat.render();
  });
  modeSelect.addEventListener("change", () => {
    state.selectedSessionMode = modeSelect.value;
    ctx.persist();
  });
  registerFoldersButton.addEventListener("click", () => {
    void request({ type: "workspace.registerOpenFolders" }).then((response) => {
      if (!response.ok) {
        ctx.bridge.chat.logChat(`register folders failed: ${response.error.message}`);
        return;
      }
      void loadWorkspaceState();
    });
  });
  createSetButton.addEventListener("click", () => {
    const name = setNameInput.value.trim();
    if (!name) return;
    void request({ type: "workspace.createSet", name }).then((response) => {
      if (!response.ok) {
        ctx.bridge.chat.logChat(`create set failed: ${response.error.message}`);
        return;
      }
      setNameInput.value = "";
      void loadWorkspaceState();
    });
  });

  // ---------------------------------------------------------------------------
  // Touch-history hover (work item 3)
  //
  // Hovering a workspace-set chip (task cards) or a set row (advanced) shows a
  // "Recent work" popover. work.history {workspaceSetId} is cached per set for
  // the panel session (invalidated on task.updated) so repeated hovers are free.
  // A single popover element is reused; a 300ms enter-debounce (cancelled on
  // leave) avoids fetch/flicker on transient hovers; dismissal is a small grace
  // period on leaving both chip and popover, plus Escape. No document listeners
  // are left registered when the popover is hidden.
  // ---------------------------------------------------------------------------
  const HOVER_OPEN_DELAY_MS = 300;
  const HOVER_GRACE_MS = 200;
  const historyCache = new Map<string, readonly WorkHistoryEntry[]>();
  const historyPopover = el("div", "history-popover hidden");
  historyPopover.setAttribute("role", "tooltip");
  root.append(historyPopover);

  let hoverOpenTimer = 0;
  let hoverCloseTimer = 0;
  let popoverOverChip = false;
  let popoverOverBody = false;
  let escListenerAttached = false;
  // The set whose history the popover currently intends to show; a fetch that
  // resolves for a different (superseded) set is discarded.
  let activeHistorySetId: string | null = null;

  const onHistoryEsc = (event: KeyboardEvent): void => {
    if (event.key === "Escape") hideHistoryPopover();
  };

  function hideHistoryPopover(): void {
    if (hoverCloseTimer) { window.clearTimeout(hoverCloseTimer); hoverCloseTimer = 0; }
    historyPopover.classList.add("hidden");
    activeHistorySetId = null;
    if (escListenerAttached) {
      document.removeEventListener("keydown", onHistoryEsc, true);
      escListenerAttached = false;
    }
  }

  /** Schedules a dismissal unless the pointer re-enters the chip or the body. */
  function scheduleHistoryClose(): void {
    if (hoverCloseTimer) window.clearTimeout(hoverCloseTimer);
    hoverCloseTimer = window.setTimeout(() => {
      if (!popoverOverChip && !popoverOverBody) hideHistoryPopover();
    }, HOVER_GRACE_MS);
  }

  function renderHistoryPopover(entries: readonly WorkHistoryEntry[] | null): void {
    historyPopover.replaceChildren();
    const title = el("div", "history-popover-title");
    title.textContent = "Recent work";
    historyPopover.append(title);
    if (entries === null) {
      const loading = el("div", "empty");
      loading.textContent = "Loading…";
      historyPopover.append(loading);
      return;
    }
    if (entries.length === 0) {
      const empty = el("div", "empty");
      empty.textContent = "No recorded work yet.";
      historyPopover.append(empty);
      return;
    }
    for (const entry of entries) {
      const row = el("div", "history-popover-row");
      const turns = `${String(entry.turnCount)} turn${entry.turnCount === 1 ? "" : "s"}`;
      row.textContent = `${entry.taskTitle ?? "(no task)"} · ${entry.sessionTitle} · ${relativeTime(entry.lastActivityAt)} · ${turns}`;
      historyPopover.append(row);
    }
  }

  /** Positions the popover under `anchor`, clamped into the panel width. */
  function positionHistoryPopover(anchor: HTMLElement): void {
    const anchorRect = anchor.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const top = anchorRect.bottom - rootRect.top + 4;
    let left = anchorRect.left - rootRect.left;
    // Clamp so a ~260px popover stays inside the ~300px panel.
    const maxLeft = Math.max(0, rootRect.width - 260);
    if (left > maxLeft) left = maxLeft;
    if (left < 0) left = 0;
    historyPopover.style.top = `${String(top)}px`;
    historyPopover.style.left = `${String(left)}px`;
  }

  async function openHistoryFor(workspaceSetId: string, anchor: HTMLElement): Promise<void> {
    activeHistorySetId = workspaceSetId;
    const cached = historyCache.get(workspaceSetId);
    if (cached !== undefined) {
      renderHistoryPopover(cached);
    } else {
      renderHistoryPopover(null); // show a loading frame immediately; fill on response
      showHistoryAt(anchor);
      const response = await request({ type: "work.history", workspaceSetId });
      // A later hover may have superseded this set, or the pointer left entirely.
      if (activeHistorySetId !== workspaceSetId) return;
      if (!popoverOverChip && !popoverOverBody) return;
      if (response.ok && response.payload.type === "work.history") {
        historyCache.set(workspaceSetId, response.payload.entries);
        renderHistoryPopover(response.payload.entries);
      } else if (!response.ok) {
        renderHistoryPopover([]);
      }
    }
    showHistoryAt(anchor);
  }

  /** Positions + reveals the popover and arms the Escape listener. */
  function showHistoryAt(anchor: HTMLElement): void {
    positionHistoryPopover(anchor);
    historyPopover.classList.remove("hidden");
    if (!escListenerAttached) {
      document.addEventListener("keydown", onHistoryEsc, true);
      escListenerAttached = true;
    }
  }

  /**
   * Attaches touch-history hover behavior to a chip/row anchor. Debounced open on
   * enter, cancel-on-leave, grace-period close. Returns nothing; the handlers are
   * scoped to the element and drop with it when its container re-renders.
   */
  function attachHistoryHover(anchor: HTMLElement, workspaceSetId: string): void {
    anchor.addEventListener("mouseenter", () => {
      popoverOverChip = true;
      if (hoverCloseTimer) { window.clearTimeout(hoverCloseTimer); hoverCloseTimer = 0; }
      if (hoverOpenTimer) window.clearTimeout(hoverOpenTimer);
      hoverOpenTimer = window.setTimeout(() => {
        void openHistoryFor(workspaceSetId, anchor);
      }, HOVER_OPEN_DELAY_MS);
    });
    anchor.addEventListener("mouseleave", () => {
      popoverOverChip = false;
      if (hoverOpenTimer) { window.clearTimeout(hoverOpenTimer); hoverOpenTimer = 0; }
      scheduleHistoryClose();
    });
  }

  historyPopover.addEventListener("mouseenter", () => {
    popoverOverBody = true;
    if (hoverCloseTimer) { window.clearTimeout(hoverCloseTimer); hoverCloseTimer = 0; }
  });
  historyPopover.addEventListener("mouseleave", () => {
    popoverOverBody = false;
    scheduleHistoryClose();
  });

  // Tasks-home order: needs-attention summary → Tasks (with chats inside) →
  // orphan-chat cleanup → Memory → Workspace sets (advanced).
  root.append(
    attentionSection,
    tasksHeading,
    taskCreateForm,
    tasksList,
    unassignedSessionsSection.details,
    memorySection.details,
    workspaceSets.details
  );

  // --- push: session.deleted --------------------------------------------------
  onPush("session.deleted", (payload) => {
    state.sessions = state.sessions.filter((s) => s.sessionId !== payload.sessionId);
    if (state.selectedSessionId === payload.sessionId) {
      ctx.bridge.chat.resetToNewChat();
    }
    renderTasks();
    renderSessions();
    // Deleting a failed session changes the attention summary's failed count.
    renderAttention();
    ctx.persist();
  });
  onPush("session.updated", (payload) => {
    // Upsert here too so card rendering never depends on another subscriber's
    // handler running first (push handlers fire in subscription order).
    upsertSession(state, payload.session);
    renderTasks();
    renderSessions();
    // A status flip to/from "failed" shifts the attention summary count.
    renderAttention();
  });
  // The status dot pulses only for the selected session's in-flight turn; these
  // two pushes are the only signal of that (state.chatMessages streaming flag
  // is set by the Chat tab's own handlers, which may run before or after this
  // one, so re-rendering here — not just relying on that flag — keeps the dot
  // in sync regardless of handler order).
  onPush("chat.turnStarted", (payload) => {
    if (payload.sessionId === state.selectedSessionId) {
      renderTasks();
      renderSessions();
    }
  });
  onPush("chat.turnCompleted", (payload) => {
    if (payload.sessionId === state.selectedSessionId) {
      renderTasks();
      renderSessions();
    }
  });
  // --- push: session.attention (Phase 3 waiting-on-user signal) ---------------
  // The host owns the badge/toast; the panel owns the Tasks-row marker + halo and
  // (when the affected session is selected) the chat header's dot.
  onPush("session.attention", (payload) => {
    if (!applySessionAttention(state, payload.sessionId, payload.reasons)) return;
    renderTasks();
    renderSessions();
    if (payload.sessionId === state.selectedSessionId) ctx.bridge.chat.render();
    ctx.persist();
  });
  // --- push: session.agentActivity (⑂ chip) ------------------------------------
  onPush("session.agentActivity", (payload) => {
    const previous = state.agentActivity[payload.sessionId];
    const activity = payload.activity;
    if (activity.running === 0 && activity.failed === 0) {
      if (previous === undefined) return;
      delete state.agentActivity[payload.sessionId];
    } else {
      if (previous !== undefined
        && previous.running === activity.running
        && previous.failed === activity.failed
        && JSON.stringify(previous.agents ?? []) === JSON.stringify(activity.agents ?? [])) return;
      state.agentActivity[payload.sessionId] = activity;
    }
    renderTasks();
    renderSessions();
    ctx.persist();
  });
  // --- push: task.updated / task.deleted --------------------------------------
  onPush("task.updated", (payload) => {
    upsertTask(state, payload.task);
    // A task change can shift its workspace's touch-history; drop the cache so
    // the next hover refetches (invalidate all: the push doesn't name a set).
    historyCache.clear();
    renderTasks();
    // Sessions carry a chip derived from their linking task, so re-render them too.
    renderSessions();
    ctx.bridge.chat.render();
    ctx.persist();
  });
  onPush("task.deleted", (payload) => {
    state.tasks = state.tasks.filter((t) => t.taskId !== payload.taskId);
    state.taskNotes = state.taskNotes.filter((note) => note.taskId !== payload.taskId);
    renderTasks();
    renderSessions();
    ctx.bridge.chat.render();
    ctx.persist();
  });
  // --- push: memory.candidateAdded --------------------------------------------
  // Upsert + re-render. Deliberately NO toast/attention — memory is not urgent.
  onPush("memory.candidateAdded", (payload) => {
    upsertMemoryCandidate(state, payload.candidate);
    renderMemory();
    ctx.persist();
  });

  // ---------------------------------------------------------------------------
  // Loaders
  // ---------------------------------------------------------------------------
  async function loadWorkspaceState(): Promise<void> {
    const response = await request({ type: "workspace.state" });
    if (response.ok && response.payload.type === "workspace.state") {
      state.workspacePolicy = response.payload.state;
      renderAttention();
      renderWorkspaceSets();
      ctx.persist();
    }
  }

  async function loadSessions(): Promise<void> {
    const response = await request({ type: "session.list" });
    if (response.ok && response.payload.type === "session.list") {
      state.sessions = [...response.payload.sessions];
      renderSessions();
    renderTasks();
    // Failed sessions feed the attention summary's "failed" count.
    renderAttention();
    ctx.persist();
  }
  }

  async function loadTasks(): Promise<void> {
    const response = await request({ type: "task.list" });
    if (response.ok && response.payload.type === "task.list") {
      state.tasks = [...response.payload.tasks];
      renderTasks();
      renderSessions();
      ctx.persist();
    }
  }

  async function loadMemory(): Promise<void> {
    const response = await request({ type: "memory.list" });
    if (response.ok && response.payload.type === "memory.list") {
      state.memoryCandidates = [...response.payload.candidates];
      renderMemory();
      ctx.persist();
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  /**
   * Composes the collapsed attention summary line. Renders only the
   * non-zero parts: `⚠ 2 requests · 1 failed — review`, `⚠ 2 requests — review`,
   * `⚠ 1 failed — review`. N = pending access requests, M = failed sessions.
   */
  function attentionSummaryText(requests: number, questions: number, failed: number): string {
    const parts: string[] = [];
    if (requests > 0) parts.push(`${String(requests)} request${requests === 1 ? "" : "s"}`);
    if (questions > 0) parts.push(`${String(questions)} question${questions === 1 ? "" : "s"}`);
    if (failed > 0) parts.push(`${String(failed)} failed`);
    return `⚠ ${parts.join(" · ")} — review`;
  }

  const attentionCursor = { index: 0 };
  function renderAttention(): void {
    const pending = (state.workspacePolicy?.accessRequests ?? []).filter((a) => a.status === "pending");
    const pendingQuestions = state.questions.filter((q) => q.status === "pending");
    // M = failed SESSIONS (status flip), not attention reasons. Failed sessions
    // are shown in their owning task row (or in the orphan cleanup drawer), not
    // duplicated inside the expansion.
    const failedCount = state.sessions.filter((s) => s.status === "failed").length;

    // Hide the whole section when nothing needs acting on.
    if (pending.length === 0 && pendingQuestions.length === 0 && failedCount === 0) {
      attentionSection.classList.remove("has-attention");
      attentionExpanded = false;
      attentionList.classList.add("hidden");
      attentionSummary.setAttribute("aria-expanded", "false");
      attentionList.replaceChildren();
      return;
    }
    attentionSection.classList.add("has-attention");
    attentionSummary.textContent = attentionSummaryText(pending.length, pendingQuestions.length, failedCount);

    // The expansion holds the SAME stacked card the chat surface uses — one
    // item at a time with the ‹ i/N › pager, across all sessions, oldest
    // first (failed sessions are the loud rows below — not duplicated here).
    const items: AttentionItem[] = [
      ...pending.map((access): AttentionItem => ({ kind: "access", access })),
      ...pendingQuestions.map((question): AttentionItem => ({ kind: "question", question }))
    ].sort((a, b) => {
      const aAt = a.kind === "access" ? a.access.requestedAt : a.question.createdAt;
      const bAt = b.kind === "access" ? b.access.requestedAt : b.question.createdAt;
      return aAt < bAt ? -1 : 1;
    });
    renderAttentionStack(attentionList, items, attentionCursor, {
      onResolved: () => {
        renderAttention();
        ctx.bridge.chat.render();
        ctx.persist();
      },
      onError: (message) => {
        ctx.bridge.chat.logChat(message);
        renderAttention();
      },
      access: {
        onResolved: (approve) => {
          ctx.bridge.chat.logChat(approve
            ? "access approved — backend restarts with the new mount; the agent continues automatically"
            : "access denied — the agent is told to continue without it");
          void loadWorkspaceState();
        },
        onError: (message) => {
          ctx.bridge.chat.logChat(`resolve access failed: ${message}`);
          renderAttention();
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Tasks
  // ---------------------------------------------------------------------------
  function renderTasks(): void {
    tasksList.replaceChildren();
    if (state.tasks.length === 0) {
      const empty = el("div", "empty");
      empty.textContent = unassignedSessions().length > 0
        ? "No tasks yet. Create one, then link chats that need a home."
        : "No tasks yet. Add one to track work across chats and workspaces.";
      tasksList.append(empty);
    } else {
      for (const task of state.tasks) {
        tasksList.append(taskCard(task));
      }
    }
  }

  function selectedTaskId(): string | undefined {
    if (state.selectedSessionId === null) return undefined;
    return state.tasks.find((task) => task.linkedSessionIds.includes(state.selectedSessionId as string))?.taskId;
  }

  function activeTaskId(): string | undefined {
    const selected = selectedTaskId();
    if (selected !== undefined) return selected;
    return state.tasks.find((task) => task.linkedSessionIds.some((sessionId) => {
      const session = state.sessions.find((candidate) => candidate.sessionId === sessionId);
      return session !== undefined && (session.status === "active" || session.status === "starting");
    }))?.taskId;
  }

  function activeTaskSession(task: WorkTaskSummary): ChatSessionSummary | undefined {
    if (task.taskId !== activeTaskId()) return undefined;
    if (state.selectedSessionId !== null && task.linkedSessionIds.includes(state.selectedSessionId)) {
      return state.sessions.find((session) => session.sessionId === state.selectedSessionId);
    }
    return task.linkedSessionIds
      .map((sessionId) => state.sessions.find((session) => session.sessionId === sessionId))
      .find((session): session is ChatSessionSummary =>
        session !== undefined && (session.status === "active" || session.status === "starting"));
  }

  function taskCard(task: WorkTaskSummary): HTMLElement {
    const c = card("task-card");
    const activeSession = activeTaskSession(task);
    if (activeSession !== undefined) {
      c.classList.add("active");
      c.setAttribute("aria-current", "true");
    }

    // --- top row: title (click → rename) · state select · delete --------------
    const top = el("div", "task-card-top");
    const title = el("span", "task-card-title");
    title.textContent = task.title;
    title.title = "Click to rename";
    title.addEventListener("click", () => beginTaskRename(task, title));

    const stateSelect = select("task-state-select", "Task state");
    for (const value of WORK_TASK_STATES) {
      stateSelect.append(option(value, TASK_STATE_LABELS[value]));
    }
    stateSelect.value = task.state;
    stateSelect.addEventListener("change", () => {
      updateTask(task.taskId, { state: stateSelect.value as WorkTaskState });
    });

    const del = inlineConfirmButton("🗑", "Confirm", () => void deleteTask(task.taskId), "icon-button danger task-delete");
    del.title = "Delete task (requires confirmation)";

    top.append(title, stateSelect, del);

    // --- description / notes line ---------------------------------------------
    const hasNote = task.description !== undefined && task.description.length > 0;
    const note = el("div", `task-card-note${hasNote ? "" : " placeholder"}`);
    note.textContent = hasNote ? (task.description as string) : "add note…";
    note.addEventListener("click", () => beginTaskNoteEdit(task, note));

    c.append(top, note);

    // --- meta line: "worked <relativeTime>" when the task has work sessions -----
    if (task.lastWorkedAt !== undefined) {
      const meta = el("div", "task-card-meta");
      meta.textContent = `worked ${relativeTime(task.lastWorkedAt)}`;
      c.append(meta);
    }

    // --- linked chats ---------------------------------------------------------
    if (task.linkedSessionIds.length > 0) {
      const details = document.createElement("details");
      details.className = "task-session-dropdown";
      details.open = activeSession !== undefined;
      const summary = document.createElement("summary");
      summary.className = "task-session-summary";
      const countLabel = el("span", "task-session-summary-label");
      countLabel.textContent = `Chats (${String(task.linkedSessionIds.length)})`;
      summary.append(countLabel);
      if (activeSession !== undefined) {
        const activeLabel = el("span", "task-session-active-label");
        activeLabel.textContent = `Active: ${activeSession.title}`;
        summary.append(activeLabel);
      }
      details.append(summary);
      const chats = el("div", "task-session-list");
      for (const sessionId of task.linkedSessionIds) {
        chats.append(taskSessionRow(task, sessionId));
      }
      details.append(chats);
      c.append(details);
    }

    // --- workspace chips row --------------------------------------------------
    const chips = el("div", "task-chips");
    for (const setId of task.linkedWorkspaceSetIds) {
      chips.append(...workspaceSetChip(task, setId));
    }
    if (task.linkedWorkspaceSetIds.length > 0) {
      c.append(chips);
    }

    // --- link actions (ranked by blast radius, left→right) ----------------------
    // Review (primary, read-only, high-frequency) → Link current chat → Link set
    // → Activate… LAST, set apart by a thin divider (window-mutating; its own
    // modal is the deliberate step, so no confirm is added here).
    const actions = el("div", "task-actions");
    // Review: open the cross-project Task Review panel. Only meaningful when
    // the task links ≥1 session (that's what has changed files + comments).
    // When the joined open-comment count is present and >0, name it on the label.
    if (task.linkedSessionIds.length > 0) {
      const count = task.openReviewCommentCount ?? 0;
      const reviewLabel = count > 0 ? `Review (${String(count)} open comment${count === 1 ? "" : "s"})` : "Review";
      const review = button(reviewLabel, "small primary task-review");
      review.title = "Review all changed files across this task's projects";
      review.addEventListener("click", () => {
        void request({ type: "taskReview.open", taskId: task.taskId }).then((response) => {
          if (!response.ok) ctx.bridge.chat.logChat(`open task review failed: ${response.error.message}`);
        });
      });
      actions.append(review);
    }
    const linkChat = button("Link current chat", "small");
    linkChat.disabled = state.selectedSessionId === null;
    linkChat.title = state.selectedSessionId === null
      ? "Select a chat first"
      : "Link the currently selected chat to this task";
    linkChat.addEventListener("click", () => {
      if (state.selectedSessionId === null) return;
      linkTask(task.taskId, { sessionId: state.selectedSessionId });
    });
    actions.append(linkChat);
    if (state.selectedWorkspaceSetId) {
      const linkSet = button("Link set", "small");
      linkSet.title = "Link the workspace set selected in the advanced picker to this task";
      linkSet.addEventListener("click", () => {
        linkTask(task.taskId, { workspaceSetId: state.selectedWorkspaceSetId });
      });
      actions.append(linkSet);
    }
    // Activate: visible on every task for a stable action row; disabled until
    // the task has a linked workspace set for the host to activate.
    const divider = el("span", "task-actions-divider");
    divider.setAttribute("aria-hidden", "true");
    const activate = button("Activate…", "small task-activate");
    const canActivate = task.linkedWorkspaceSetIds.length > 0;
    activate.disabled = !canActivate;
    activate.title = canActivate
      ? "Switch this window's folders to this task's workspace (Replace / Append / new window)"
      : "Link a workspace set to this task before activating it";
    if (canActivate) {
      activate.addEventListener("click", () => {
        void activateWorkspace({ taskId: task.taskId }, activate);
      });
    }
    actions.append(divider, activate);
    c.append(actions);

    return c;
  }

  /** Compact linked-chat row inside a task: selects+jumps; ✕ unlinks. */
  function taskSessionRow(task: WorkTaskSummary, sessionId: string): HTMLElement {
    const session = state.sessions.find((s) => s.sessionId === sessionId);
    const row = el("div", "task-session-row");
    const body = el("div", "task-session-main");
    body.setAttribute("role", "button");
    body.tabIndex = 0;
    const open = (): void => {
      ctx.bridge.chat.selectSession(sessionId);
      ctx.bridge.switchTab("chat");
    };
    body.addEventListener("click", open);
    body.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
    body.title = "Open this chat";

    if (session === undefined) {
      const top = el("div", "task-session-top");
      const title = el("span", "task-session-title");
      title.textContent = `${sessionId.slice(0, 8)}…`;
      top.append(statusDot("state-ended", "missing chat"), title);
      const meta = el("div", "task-session-meta");
      meta.textContent = "chat no longer listed";
      body.append(top, meta);
    } else {
      const elsewhere = session.runningElsewhere === true;
      const reasons = state.attention[session.sessionId] ?? [];
      const chips = sessionChips(session, reasons, state.agentActivity[session.sessionId]);
      const stateChip = chips.find((k) => k.cls === "chip-failed" || k.cls === "chip-approval" || k.cls === "chip-ready");
      const loud = isSessionLoud(session, reasons);
      const ready = isSessionReady(session, reasons);
      const dot = statusDot(sessionDotClass(session), elsewhere ? "running in another window" : session.status);
      if (loud && stateChip) {
        dot.classList.add("attn-halo", stateChip.cls === "chip-failed" ? "attn-loud-failed" : "attn-loud-approval");
      } else if (ready) {
        dot.classList.add("attn-halo", "attn-ready");
      }

      const top = el("div", "task-session-top");
      const title = el("span", "task-session-title");
      title.textContent = session.title;
      top.append(dot, title);
      for (const k of chips) {
        const chipEl = el("span", `session-chip ${k.cls}`);
        chipEl.textContent = k.text;
        if (k.cls === "chip-clone") chipEl.title = "Clone-mode session — changes sync into your editor";
        top.append(chipEl);
      }

      const meta = el("div", `task-session-meta${elsewhere ? " meta-elsewhere" : ""}`);
      const [providerModel, stateWord, timeWord] = sessionMetaSegments(session);
      const showFailedWord = stateChip?.cls === "chip-failed";
      if (showFailedWord) {
        const stateEl = el("span", "meta-word-failed");
        stateEl.textContent = stateWord ?? "";
        meta.append(`${providerModel ?? ""} · `, stateEl, ` · ${timeWord ?? ""}`);
      } else {
        meta.textContent = [providerModel, stateWord, timeWord].join(" · ");
      }
      body.append(top, meta);
      const agentStrip = sessionAgentStrip(state.agentActivity[session.sessionId] ?? session.agentActivity);
      if (agentStrip !== null) body.append(agentStrip);
    }

    const remove = iconButton("✕", "Unlink chat", "chip-remove");
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      unlinkTask(task.taskId, { sessionId });
    });
    row.append(body, remove);
    return row;
  }

  /** Chip for a linked workspace set: label · ↗ open-in-new-window · ✕ unlink. */
  function workspaceSetChip(task: WorkTaskSummary, workspaceSetId: string): HTMLElement[] {
    const set = state.workspacePolicy?.workspaceSets.find((s) => s.workspaceSetId === workspaceSetId);
    const label = set ? set.name : `${workspaceSetId.slice(0, 8)}…`;
    const wrap = el("span", "task-chip");
    const body = el("span", "chip");
    body.textContent = `📁 ${label}`;
    // Touch-history hover on the set chip (work item 3).
    attachHistoryHover(body, workspaceSetId);
    const open = iconButton("↗", "Open in new window", "chip-open");
    open.title = "Opens the set's primary folder in a new VS Code window; this window's chats keep running";
    open.addEventListener("click", (event) => {
      event.stopPropagation();
      void request({ type: "workspace.openInNewWindow", workspaceSetId }).then((response) => {
        if (!response.ok) ctx.bridge.chat.logChat(`open in new window failed: ${response.error.message}`);
      });
    });
    const remove = iconButton("✕", "Unlink workspace set", "chip-remove");
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      unlinkTask(task.taskId, { workspaceSetId });
    });
    wrap.append(body, open, remove);
    return [wrap];
  }

  function beginTaskRename(task: WorkTaskSummary, title: HTMLElement): void {
    const input = textInput("Task title");
    input.classList.add("rename-input");
    input.value = task.title;
    let done = false;
    const commit = (save: boolean): void => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      if (save && next.length > 0 && next !== task.title) {
        updateTask(task.taskId, { title: next });
      } else {
        renderTasks();
      }
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") { event.preventDefault(); commit(true); }
      else if (event.key === "Escape") { event.preventDefault(); commit(false); }
    });
    input.addEventListener("blur", () => commit(true));
    title.replaceChildren(input);
    input.focus();
    input.select();
  }

  function beginTaskNoteEdit(task: WorkTaskSummary, note: HTMLElement): void {
    const textarea = document.createElement("textarea");
    textarea.className = "note-input";
    textarea.rows = 2;
    textarea.value = task.description ?? "";
    let done = false;
    const commit = (save: boolean): void => {
      if (done) return;
      done = true;
      const description = textarea.value.trim();
      if (save && description !== (task.description ?? "")) {
        // "" clears the note; the backend maps "" → NULL.
        updateTask(task.taskId, { description });
      } else {
        renderTasks();
      }
    };
    textarea.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); commit(true); }
      else if (event.key === "Escape") { event.preventDefault(); commit(false); }
    });
    textarea.addEventListener("blur", () => commit(true));
    note.replaceChildren(textarea);
    textarea.focus();
  }

  function updateTask(taskId: string, patch: { title?: string; description?: string; state?: WorkTaskState }): void {
    void request({ type: "task.update", taskId, ...patch }).then((response) => {
      if (!response.ok) {
        ctx.bridge.chat.logChat(`task update failed: ${response.error.message}`);
        renderTasks();
        return;
      }
      if (response.payload.type === "task.update") {
        upsertTask(state, response.payload.task);
        renderTasks();
        renderSessions();
        ctx.persist();
      }
    });
  }

  function linkTask(taskId: string, target: { sessionId: string } | { workspaceSetId: string }): void {
    void request({ type: "task.link", taskId, ...target }).then((response) => {
      if (!response.ok) {
        ctx.bridge.chat.logChat(`link failed: ${response.error.message}`);
        return;
      }
      if (response.payload.type === "task.link") {
        upsertTask(state, response.payload.task);
        renderTasks();
        renderSessions();
        ctx.persist();
      }
    });
  }

  /**
   * Awaitable task.link used by the creation flow, which chains link steps and
   * must stop on the first failure. Upserts the returned task on success and
   * returns it; logs and returns null on failure. Does not re-render (the caller
   * batches a single render after the whole sequence).
   */
  async function linkTaskAwait(taskId: string, target: { sessionId: string } | { workspaceSetId: string }): Promise<WorkTaskSummary | null> {
    const response = await request({ type: "task.link", taskId, ...target });
    if (!response.ok) {
      ctx.bridge.chat.logChat(`link failed: ${response.error.message}`);
      return null;
    }
    if (response.payload.type !== "task.link") return null;
    upsertTask(state, response.payload.task);
    return response.payload.task;
  }

  function unlinkTask(taskId: string, target: { sessionId: string } | { workspaceSetId: string }): void {
    void request({ type: "task.unlink", taskId, ...target }).then((response) => {
      if (!response.ok) {
        ctx.bridge.chat.logChat(`unlink failed: ${response.error.message}`);
        return;
      }
      if (response.payload.type === "task.unlink") {
        upsertTask(state, response.payload.task);
        renderTasks();
        renderSessions();
        ctx.persist();
      }
    });
  }

  async function deleteTask(taskId: string): Promise<void> {
    const response = await request({ type: "task.delete", taskId });
    if (!response.ok) {
      ctx.bridge.chat.logChat(`delete task failed: ${response.error.message}`);
      return;
    }
    if (response.payload.type === "task.delete") {
      state.tasks = state.tasks.filter((t) => t.taskId !== taskId);
      renderTasks();
      renderSessions();
      ctx.persist();
    }
  }

  // ---------------------------------------------------------------------------
  // Memory (work item 5)
  // ---------------------------------------------------------------------------
  function renderMemory(): void {
    const pending = state.memoryCandidates
      .filter((c) => c.status === "pending")
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const approved = state.memoryCandidates
      .filter((c) => c.status === "approved")
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

    memorySection.summaryLabel.textContent = pending.length > 0 ? `Memory (${String(pending.length)})` : "Memory";

    memoryPending.replaceChildren();
    if (pending.length === 0) {
      const empty = el("div", "empty");
      empty.textContent = "No memory suggestions.";
      memoryPending.append(empty);
    } else {
      for (const candidate of pending) memoryPending.append(memoryCard(candidate));
    }

    memoryApproved.summaryLabel.textContent = `Approved (${String(approved.length)})`;
    memoryApproved.details.classList.toggle("hidden", approved.length === 0);
    memoryApprovedList.replaceChildren();
    for (const candidate of approved) {
      const row = el("div", "memory-approved-row");
      row.textContent = candidate.content;
      memoryApprovedList.append(row);
    }
  }

  /** One pending memory candidate: content + source session + Approve / Reject. */
  function memoryCard(candidate: MemoryCandidateSummary): HTMLElement {
    const c = card("memory-card");
    const content = el("div", "memory-card-content");
    content.textContent = candidate.content;
    const source = el("div", "memory-card-source");
    const session = state.sessions.find((s) => s.sessionId === candidate.sessionId);
    source.textContent = `from ${session ? session.title : `${candidate.sessionId.slice(0, 8)}…`}`;
    const actions = el("div", "memory-card-actions");
    const approve = button("Approve", "ghost small");
    approve.addEventListener("click", () => {
      approve.disabled = true;
      resolveMemory(candidate.memoryCandidateId, true);
    });
    // Reject is inline-confirm (irreversible-ish; a second deliberate click).
    const reject = inlineConfirmButton("Reject", "Confirm?", () => resolveMemory(candidate.memoryCandidateId, false), "ghost small danger");
    actions.append(approve, reject);
    c.append(content, source, actions);
    return c;
  }

  function resolveMemory(memoryCandidateId: string, approve: boolean): void {
    void request({ type: "memory.resolve", memoryCandidateId, approve }).then((response) => {
      if (!response.ok) {
        ctx.bridge.chat.logChat(`memory ${approve ? "approve" : "reject"} failed: ${response.error.message}`);
        renderMemory();
        return;
      }
      if (response.payload.type === "memory.resolve") {
        upsertMemoryCandidate(state, response.payload.candidate);
        renderMemory();
        ctx.persist();
      }
    });
  }

  function renderSessions(): void {
    sessionsList.replaceChildren();
    const unassigned = unassignedSessions();
    unassignedSessionsSection.details.classList.toggle("hidden", unassigned.length === 0);
    unassignedSessionsSection.summaryLabel.textContent = `Chats needing a task (${String(unassigned.length)})`;
    if (unassigned.length === 0) {
      return;
    }
    // Ordering: loud rows (failed / waiting-on-access) first, then ready
    // rows, then the rest — stable within each group (state.sessions is already
    // newest-first, and Array.prototype.sort is stable). ONE comparator drives
    // this; the loudness rule lives in sessionLoudness().
    const ordered = [...unassigned].sort((a, b) =>
      sessionLoudness(a, state.attention[a.sessionId] ?? []) - sessionLoudness(b, state.attention[b.sessionId] ?? []));
    for (const session of ordered) {
      sessionsList.append(sessionCard(session));
    }
  }

  /** Legacy/orphan chats that are not owned by any task yet. */
  function unassignedSessions(): ChatSessionSummary[] {
    const linked = new Set<string>();
    for (const task of state.tasks) {
      for (const sessionId of task.linkedSessionIds) linked.add(sessionId);
    }
    return state.sessions.filter((session) => !linked.has(session.sessionId));
  }

  /** Dot state class: hollow ring for elsewhere; green pulse only for the selected session's in-flight turn. */
  function sessionDotClass(session: ChatSessionSummary): string {
    if (session.runningElsewhere === true) return "state-elsewhere";
    const isSelected = session.sessionId === state.selectedSessionId;
    const turnActive = isSelected && state.chatMessages.some((m) => m.streaming === true);
    if (turnActive) return "state-running";
    if (session.status === "active" || session.status === "starting") return "state-live";
    if (session.status === "failed") return "state-failed";
    return "state-ended";
  }

  /** True for sessions the host can resume onto a fresh backend (ended/failed only). */
  function isResumable(session: ChatSessionSummary): boolean {
    return session.status === "ended" || session.status === "failed";
  }

  function sessionCard(session: ChatSessionSummary): HTMLElement {
    const c = card("session-card");
    if (session.sessionId === state.selectedSessionId) c.classList.add("selected");

    const top = el("div", "session-card-top");
    // A session running in another window is read-only here: no Resume, no delete.
    const elsewhere = session.runningElsewhere === true;
    // Row salience: loud rows (failed / waiting-on-access) get an accent
    // halo; a merely-ready row (turn completed) is demoted to a thin 1px ring.
    const reasons = state.attention[session.sessionId] ?? [];
    const chips = sessionChips(session, reasons, state.agentActivity[session.sessionId]);
    // Only true STATE chips drive halo/meta treatment — role/subagent/clone
    // chips are decorative and must not be mistaken for one.
    // The state chip (first chip when present, else the clone chip) names the
    // halo/meta treatment: failed → red, approval → amber, ready → thin ring.
    const stateChip = chips.find((k) => k.cls === "chip-failed" || k.cls === "chip-approval" || k.cls === "chip-ready");
    const loud = isSessionLoud(session, reasons);
    const ready = isSessionReady(session, reasons);
    const dot = statusDot(sessionDotClass(session), elsewhere ? "running in another window" : session.status);
    if (loud && stateChip) {
      // Red halo for failure, amber for a pending access request.
      dot.classList.add("attn-halo", stateChip.cls === "chip-failed" ? "attn-loud-failed" : "attn-loud-approval");
    } else if (ready) {
      dot.classList.add("attn-halo", "attn-ready");
    }
    const title = el("span", "session-card-title");
    title.textContent = session.title;
    // Resume (ended/failed only): hover-revealed alongside delete; boots a fresh
    // backend on the same session row with context replayed. Never for elsewhere.
    if (!elsewhere && isResumable(session)) {
      const resume = button("Resume", "ghost small session-resume");
      resume.title = "Boot a fresh backend on this session; context is replayed";
      resume.addEventListener("click", (event) => {
        event.stopPropagation();
        void resumeSession(session, resume);
      });
      top.append(dot, title, resume);
    } else {
      top.append(dot, title);
    }
    // Delete is refused for a session running elsewhere (owned by another window).
    if (!elsewhere) {
      const del = inlineConfirmButton("🗑", "Confirm", () => void deleteSession(session.sessionId), "icon-button danger session-delete");
      del.title = "Delete chat (requires confirmation)";
      top.append(del);
      // Prevent the delete button's click from also selecting.
      del.addEventListener("click", (event) => event.stopPropagation());
    }

    // Title-line chips, appended in the helper's order: the state chip
    // (bold `· failed` / `· approval`, or non-bold `· ready`) then any clone chip.
    // A future role chip enters via sessionChips() with zero change here.
    let chipAnchor: HTMLElement = title;
    for (const k of chips) {
      const chipEl = el("span", `session-chip ${k.cls}`);
      chipEl.textContent = k.text;
      if (k.cls === "chip-clone") chipEl.title = "Clone-mode session — changes sync into your editor";
      chipAnchor.after(chipEl);
      chipAnchor = chipEl;
    }

    // Meta line: provider/model · state · time. On a failed row the state
    // word renders in the red accent (not dim) — same loudness source as the row.
    const meta = el("div", `session-card-meta${elsewhere ? " meta-elsewhere" : ""}`);
    const [providerModel, stateWord, timeWord] = sessionMetaSegments(session);
    const showFailedWord = stateChip?.cls === "chip-failed";
    if (showFailedWord) {
      const stateEl = el("span", "meta-word-failed");
      stateEl.textContent = stateWord ?? "";
      meta.append(`${providerModel ?? ""} · `, stateEl, ` · ${timeWord ?? ""}`);
    } else {
      meta.textContent = [providerModel, stateWord, timeWord].join(" · ");
    }

    const note = el("div", `session-card-note${session.description ? "" : " placeholder"}`);
    note.textContent = session.description && session.description.length > 0 ? session.description : "add note…";
    note.addEventListener("click", (event) => {
      event.stopPropagation();
      beginNoteEdit(session, note);
    });

    // Clicking the card body (not the note/delete) selects and jumps to Chat —
    // an elsewhere session still opens read-only in the Chat tab. The delete
    // button (when present) stops propagation itself so it never also selects.
    c.addEventListener("click", () => {
      ctx.bridge.chat.selectSession(session.sessionId);
      ctx.bridge.switchTab("chat");
    });

    const agentStrip = sessionAgentStrip(state.agentActivity[session.sessionId] ?? session.agentActivity);
    c.append(top, meta);
    if (agentStrip !== null) c.append(agentStrip);
    c.append(note);

    // Granted-access ledger (Phase 3, B1/B3): a compact "⛨ N grant(s)" chip for
    // approved access requests on this session; clicking toggles an inline list.
    const grants = (state.workspacePolicy?.accessRequests ?? [])
      .filter((a) => a.sessionId === session.sessionId && a.status === "approved");
    if (grants.length > 0) {
      c.append(grantsLedger(grants));
    }

    // Task chip: the first task linking this session, if any.
    const linkingTask = state.tasks.find((task) => task.linkedSessionIds.includes(session.sessionId));
    if (linkingTask !== undefined) {
      const chipRow = el("div", "session-card-tasks");
      const taskChip = chip(`✓ ${linkingTask.title}`);
      taskChip.classList.add("session-task-chip");
      taskChip.title = "Linked task";
      chipRow.append(taskChip);
      c.append(chipRow);
    }
    return c;
  }

  function sessionAgentStrip(activity: AgentActivitySummary | undefined): HTMLElement | null {
    const agents = (activity?.agents ?? [])
      .filter((agent) => agent.status === "running" || agent.status === "failed")
      .slice(0, 2);
    if (agents.length === 0) return null;
    const strip = el("div", "session-agent-strip");
    for (const agent of agents) {
      const row = el("div", `session-agent-row session-agent-status-${agent.status}${isAgentIdle(agent) ? " idle" : ""}`);
      const label = el("span", "session-agent-label");
      label.textContent = agent.label;
      const meta = el("span", "session-agent-meta");
      const parts = [durationLabel(agent.startedAt, agent.endedAt)];
      if (isAgentIdle(agent) && agent.lastActivityAt !== undefined) parts.push(`idle ${durationLabel(agent.lastActivityAt, undefined)}`);
      if (agent.tokens !== undefined) parts.push(`${formatTokenCount(agent.tokens)} tokens`);
      if (agent.lastCommand !== undefined) parts.push(agent.lastCommand);
      meta.textContent = parts.filter(Boolean).join(" · ");
      row.append(label, meta);
      strip.append(row);
    }
    const hidden = (activity?.agents ?? []).filter((agent) => agent.status === "running" || agent.status === "failed").length - agents.length;
    if (hidden > 0) {
      const more = el("div", "session-agent-more");
      more.textContent = `+${String(hidden)} more`;
      strip.append(more);
    }
    return strip;
  }

  function isAgentIdle(agent: AgentActivityItem): boolean {
    if (agent.status !== "running") return false;
    const last = Date.parse(agent.lastActivityAt ?? agent.startedAt ?? "");
    return Number.isFinite(last) && Date.now() - last >= state.agentIdleThresholdMs;
  }

  /**
   * Grants ledger for a session: a "⛨ N grant(s)" chip that toggles an inline
   * list of approved access mounts (`rw D:\builds\maya2026`). Sensitive-flagged
   * grants carry a small warning glyph. Data comes straight from workspace-policy
   * state — no new request. Clicks here must not bubble to the card's select.
   */
  function grantsLedger(grants: readonly AccessRequestSummary[]): HTMLElement {
    const wrap = el("div", "session-grants");
    const chipEl = el("button", "chip chip-button session-grants-chip");
    chipEl.textContent = `⛨ ${String(grants.length)} grant${grants.length === 1 ? "" : "s"}`;
    chipEl.title = "Directories this session was granted access to";
    const list = el("div", "session-grants-list hidden");
    for (const grant of grants) {
      const row = el("div", "session-grant-row");
      const modeEl = el("span", `session-grant-mode ${grant.mode === "read-write" ? "mode-read-write" : "mode-read-only"}`);
      modeEl.textContent = grant.mode === "read-write" ? "rw" : "ro";
      const pathEl = el("span", "session-grant-path");
      pathEl.textContent = grant.displayPath;
      row.append(modeEl, pathEl);
      if (grant.sensitive === true) {
        const warn = el("span", "session-grant-warn");
        warn.textContent = "⚠";
        warn.title = "sensitive path (credentials/keys/secrets)";
        row.append(warn);
      }
      list.append(row);
    }
    chipEl.addEventListener("click", (event) => {
      event.stopPropagation();
      list.classList.toggle("hidden");
    });
    wrap.append(chipEl, list);
    return wrap;
  }

  /**
   * Resumes an ended/failed session onto a fresh backend (context replayed). The
   * button disables while in flight (booting a container takes seconds). On
   * success: upsert the returned session, select it, jump to Chat, log it.
   */
  async function resumeSession(session: ChatSessionSummary, resumeButton: HTMLButtonElement): Promise<void> {
    resumeButton.disabled = true;
    // Include an auto workspace only when the host has open folders (else omit so
    // the host mounts nothing); omit model so the host defaults to the stored one.
    const workspace = state.openFolderNames.length > 0
      ? { auto: true as const, mode: "implementation" as const }
      : undefined;
    const response = await request({
      type: "chat.resumeSession",
      sessionId: session.sessionId,
      ...(workspace ? { workspace } : {})
    });
    if (!response.ok) {
      resumeButton.disabled = false;
      ctx.bridge.chat.logChat(`resume failed: ${response.error.message}`);
      return;
    }
    if (response.payload.type === "chat.resumeSession") {
      upsertSession(state, response.payload.session);
      state.providerCatalogs = [...response.payload.providerCatalogs];
      ctx.persist();
      ctx.bridge.chat.selectSession(response.payload.session.sessionId);
      ctx.bridge.switchTab("chat");
      ctx.bridge.chat.logChat("session resumed on a fresh backend — context replayed");
    }
  }

  function beginNoteEdit(session: ChatSessionSummary, note: HTMLElement): void {
    const textarea = document.createElement("textarea");
    textarea.className = "note-input";
    textarea.rows = 2;
    textarea.value = session.description ?? "";
    let done = false;
    const commit = (save: boolean): void => {
      if (done) return;
      done = true;
      const description = textarea.value.trim();
      if (save && description !== (session.description ?? "")) {
        void request({ type: "session.setDescription", sessionId: session.sessionId, description }).then((response) => {
          if (!response.ok) {
            ctx.bridge.chat.logChat(`note failed: ${response.error.message}`);
            renderSessions();
            return;
          }
          if (response.payload.type === "session.setDescription") {
            upsertSession(state, response.payload.session);
            renderSessions();
            ctx.persist();
          }
        });
      } else {
        renderSessions();
      }
    };
    textarea.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); commit(true); }
      else if (event.key === "Escape") { event.preventDefault(); commit(false); }
    });
    textarea.addEventListener("click", (event) => event.stopPropagation());
    textarea.addEventListener("blur", () => commit(true));
    note.replaceChildren(textarea);
    textarea.focus();
  }

  async function deleteSession(sessionId: string): Promise<void> {
    const response = await request({ type: "session.delete", sessionId });
    if (!response.ok) {
      ctx.bridge.chat.logChat(`delete failed: ${response.error.message}`);
      return;
    }
    // The host pushes session.deleted; that handler drops it + resets selection.
  }

  /**
   * Sends workspace.activate for a task or set and logs the outcome. The host
   * shows the Replace/Append/new-window modal and mutates the window folders;
   * the panel only reports the result. When result.windowReload is set, also log
   * the reload caveat (this window's chats end and may be adopted back).
   */
  async function activateWorkspace(target: { taskId: string } | { workspaceSetId: string }, trigger: HTMLButtonElement): Promise<void> {
    trigger.disabled = true;
    const response = await request({ type: "workspace.activate", ...target });
    trigger.disabled = false;
    if (!response.ok) {
      ctx.bridge.chat.logChat(`activate failed: ${response.error.message}`);
      return;
    }
    if (response.payload.type !== "workspace.activate") return;
    const result = response.payload.result;
    ctx.bridge.chat.logChat(activateOutcomeLine(result));
    if (result.windowReload === true) {
      ctx.bridge.chat.logChat("window will reload — chats end and may be adopted back");
    }
  }

  function renderWorkspaceSets(): void {
    const previousSet = workspaceSetSelect.value || state.selectedWorkspaceSetId;
    workspaceSetSelect.replaceChildren();
    workspaceSetSelect.append(option("", "— no workspace set —"));
    for (const set of state.workspacePolicy?.workspaceSets ?? []) {
      workspaceSetSelect.append(option(set.workspaceSetId, `${set.name} (${set.projectNames.join(", ")})`));
    }
    if ([...workspaceSetSelect.options].some((candidate) => candidate.value === previousSet)) {
      workspaceSetSelect.value = previousSet;
    }
    state.selectedWorkspaceSetId = workspaceSetSelect.value;
    modeSelect.value = state.selectedSessionMode || "implementation";

    // One row per set, each a touch-history hover anchor (work item 3).
    setsList.replaceChildren();
    for (const set of state.workspacePolicy?.workspaceSets ?? []) {
      const row = el("div", "set-row");
      const name = el("span", "set-row-name");
      name.textContent = set.name;
      const paths = el("span", "set-row-paths");
      paths.textContent = set.projectNames.join(", ");
      const activate = button("Activate", "ghost small set-row-activate");
      activate.title = "Switch this window's folders to this set (Replace / Append / new window)";
      activate.addEventListener("click", (event) => {
        event.stopPropagation();
        void activateWorkspace({ workspaceSetId: set.workspaceSetId }, activate);
      });
      row.append(name, paths, activate);
      attachHistoryHover(row, set.workspaceSetId);
      setsList.append(row);
    }

    projectsList.replaceChildren();
    const projects = state.workspacePolicy?.projects ?? [];
    if (projects.length === 0) {
      const empty = el("div", "empty");
      empty.textContent = "No projects registered. Register the open folder(s) to mount real code.";
      projectsList.append(empty);
    }
    for (const project of projects) {
      const row = el("div", "project-row");
      const kind = badge(project.kind);
      const name = el("span", "changed-file-path");
      name.textContent = `${project.name} · ${project.displayPath}`;
      row.append(kind, name);
      projectsList.append(row);
    }
  }

  function render(): void {
    renderAttention();
    renderTasks();
    renderMemory();
    renderSessions();
    renderWorkspaceSets();
  }

  function refresh(): void {
    void loadWorkspaceState();
    void loadSessions();
    void loadTasks();
    void loadMemory();
  }

  // Boot-load memory candidates (also re-hydrated on every tab refresh).
  void loadMemory();

  return { root, render, refresh, renderAttention };
}
