/**
 * Plan tab (ADR 0012): the planning chat in the sidebar, between Tasks and
 * Edit.
 *
 * The tab IS a chat: with no plan underway, the first message you type becomes
 * a new plan's brief — the host creates the plan, boots its session, and the
 * Planner panel auto-opens on it while the conversation streams here. Above
 * the transcript, a collapsible "Recent plans" list is the history: each row
 * shows an in-progress dot while its session is live and opens that plan in
 * the Planner panel. Artifact browsing, annotations, and intake refinement all
 * live in the panel — this tab is the conversation, kept close.
 *
 * The transcript renders through the SAME shared components as the Edit tab
 * and the panel rail (chat/transcriptModel + messageRow).
 *
 * SECURITY: every dynamic string renders via textContent — never innerHTML.
 */

import type { PlanSummary } from "@drydock/contracts";
import {
  chatMessageRow,
  renderBriefedUserBody,
  workingIndicatorRow,
  type MessageRowContext
} from "../chat/messageRow.js";
import {
  TranscriptFolder,
  type AgentGroup,
  type ChatMessage
} from "../chat/transcriptModel.js";
import { button, collapsible, el, option, relativeTime, select, statusDot } from "../components.js";
import { onPush, request } from "../messaging.js";
import { upsertTasks } from "../state.js";
import type { PlanTabView, ViewContext } from "../viewContext.js";

export function createPlanTab(ctx: ViewContext): PlanTabView {
  const state = ctx.state;
  const root = el("div", "plan-tab");

  // ---------------------------------------------------------------------------
  // Rail state: the current plan's session, folded through the shared reducer.
  // ---------------------------------------------------------------------------

  let plans: PlanSummary[] = [];
  let railMessages: ChatMessage[] = [];
  let railGroups: Record<string, AgentGroup> = {};
  let railSessionId: string | null = null;
  let railLastSequence = 0;
  let turnActive = false;
  let booting = false;
  /** "＋ New plan" pressed: the composer starts a fresh plan on send. */
  let composeNew = false;
  /** Task the next created plan belongs to ("" = orphan; discouraged). */
  let pendingTaskId = "";
  let turnStartedAt: number | undefined;
  let lastActivityAt: number | undefined;
  let reasoningActive = false;
  let reasoningText = "";
  let tickTimer: number | undefined;
  let notice: string | null = null;

  const folder = new TranscriptFolder(
    {
      get messages() { return railMessages; },
      get groups() { return railGroups; }
    },
    {
      onDiagnostic: () => {},
      onFileEdit: () => {},
      onSystemMessage: (text, tone) => {
        folder.appendSystemMessage({ text, tone });
      },
      onReasoning: (text) => {
        reasoningActive = true;
        reasoningText += text;
        renderLog();
      },
      onRender: () => renderLog(),
      onPersist: () => {
        // Rail state rebuilds from the durable timeline; nothing persists here.
      }
    }
  );

  const rowContext: MessageRowContext = {
    authorLabel: () => {
      const session = activeSession();
      return session?.model ? `Planner · ${session.model}` : "Planner";
    },
    openLink: (href) => {
      void request({ type: "chat.openFile", path: href });
    },
    renderUserBody: (container, text) => renderBriefedUserBody(container, text),
    groups: () => railGroups
  };

  function activePlan(): PlanSummary | undefined {
    if (composeNew) return undefined;
    const open = plans.filter((plan) => plan.status !== "archived");
    if (state.planTabPlanId !== null) {
      const chosen = open.find((plan) => plan.planId === state.planTabPlanId);
      if (chosen !== undefined) return chosen;
    }
    return open[0];
  }

  function sessionSummaryFor(sessionId: string | null): { readonly model?: string; readonly live?: boolean; readonly status?: string } | undefined {
    if (!sessionId) return undefined;
    return state.sessions.find((session) => session.sessionId === sessionId);
  }

  function activeSession(): { readonly model?: string; readonly live?: boolean; readonly status?: string } | undefined {
    return sessionSummaryFor(activePlan()?.sessionId ?? null);
  }

  /** Authoritative live flag, falling back to status for pre-field summaries. */
  function liveish(sessionId: string | null): boolean {
    const session = sessionSummaryFor(sessionId);
    if (session === undefined) return false;
    return session.live ?? session.status === "active";
  }

  // ---------------------------------------------------------------------------
  // Structure: recent-plans collapsible / status / log / composer.
  // ---------------------------------------------------------------------------

  const recent = collapsible("Recent plans", false);
  recent.details.classList.add("plan-tab-recent");

  const headerRow = el("div", "plan-tab-header");
  const currentLabel = el("span", "plan-tab-current");
  const newPlanButton = button("＋ New plan", "ghost small");
  newPlanButton.title = "Start a fresh planning chat (the first message becomes the plan's brief)";
  newPlanButton.addEventListener("click", () => {
    composeNew = true;
    resetRail(null);
    render();
    promptInput.focus();
  });
  const openPanelButton = button("Open Planner ↗", "small plan-tab-open");
  openPanelButton.title = "Open the full planning workspace (tree, viewers, annotations)";
  openPanelButton.addEventListener("click", () => {
    const plan = activePlan();
    void request({ type: "planner.open", ...(plan === undefined ? {} : { planId: plan.planId }) });
  });
  headerRow.append(currentLabel, el("span", "composer-spacer"), newPlanButton, openPanelButton);

  const statusRow = el("div", "plan-tab-status");
  const log = el("div", "plan-tab-log chat-log");
  const noticeRow = el("div", "plan-tab-notice hidden");

  const composer = el("div", "plan-tab-composer");
  // Create mode: plans belong to tasks (ADR 0006 doctrine) — pick the owner
  // before the first message; orphan stays possible but reads as the exception.
  const taskRow = el("div", "plan-tab-task-row");
  const taskLabel = el("span", "plan-tab-footnote");
  taskLabel.textContent = "for task";
  const taskSelect = select("plan-tab-task-select", "The task this plan belongs to");
  taskSelect.addEventListener("change", () => {
    pendingTaskId = taskSelect.value;
    render();
  });
  taskRow.append(taskLabel, taskSelect);
  const promptInput = document.createElement("textarea");
  promptInput.className = "plan-tab-input";
  promptInput.rows = 3;
  const actions = el("div", "plan-tab-actions");
  const mountsNote = el("span", "plan-tab-footnote");
  const stopButton = button("Stop", "ghost small");
  stopButton.addEventListener("click", () => {
    const sessionId = activePlan()?.sessionId;
    if (!sessionId || !turnActive) return;
    stopButton.disabled = true;
    void request({ type: "chat.cancelTurn", sessionId }).then(() => {
      stopButton.disabled = false;
    });
  });
  const sendButton = button("Send", "primary small");
  const submit = (): void => {
    if (state.workspacePolicy?.security?.networkedAiAllowed !== true) {
      notice = planAllocationMessage();
      render();
      return;
    }
    const prompt = promptInput.value.trim();
    if (prompt.length === 0) return;
    const plan = activePlan();
    if (plan === undefined) {
      // Chat-first start: the message IS the new plan's brief. The session
      // boot auto-opens the Planner panel on this plan; the conversation
      // streams right here.
      promptInput.value = "";
      booting = true;
      render();
      void request({
        type: "planner.create",
        brief: prompt,
        aspectIds: [],
        contextRoots: [],
        ...(pendingTaskId === "" ? {} : { taskId: pendingTaskId })
      }).then((response) => {
        if (!response.ok) {
          booting = false;
          notice = response.error.message;
          render();
          return;
        }
        if (response.payload.type !== "planner.create") return;
        composeNew = false;
        state.planTabPlanId = response.payload.plan.planId;
        ctx.persist();
        void refreshPlans().then(() => {
          render();
          return syncRail();
        });
      });
      return;
    }
    promptInput.value = "";
    if (plan.sessionId === null) booting = true;
    render();
    void request({ type: "planner.sendTurn", planId: plan.planId, prompt }).then((response) => {
      if (!response.ok) {
        booting = false;
        notice = response.error.message;
        render();
      }
    });
  };
  sendButton.addEventListener("click", submit);
  promptInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });
  actions.append(mountsNote, stopButton, sendButton);
  composer.append(taskRow, promptInput, actions);

  root.append(recent.details, headerRow, statusRow, noticeRow, log, composer);

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function planRowDot(plan: PlanSummary): HTMLElement {
    // The "in progress" icon: working while its session runs a turn here,
    // live while the session is up, hollow when it needs a reconnect.
    if (plan.sessionId !== null && plan.sessionId === railSessionId && (turnActive || booting)) {
      return statusDot("state-working", "planning in progress");
    }
    if (plan.sessionId !== null && liveish(plan.sessionId)) {
      return statusDot("state-working", "planning in progress");
    }
    if (plan.sessionId !== null) {
      return statusDot("state-offline", "session offline — reconnects on send");
    }
    return statusDot("state-none", "no session yet");
  }

  function renderRecent(): void {
    recent.summaryLabel.textContent = `Recent plans (${String(plans.filter((plan) => plan.status !== "archived").length)})`;
    recent.body.replaceChildren();
    const open = plans.filter((plan) => plan.status !== "archived");
    if (open.length === 0) {
      const empty = el("div", "plan-tab-recent-empty");
      empty.textContent = "Nothing yet — your first message below starts a plan.";
      recent.body.append(empty);
      return;
    }
    for (const plan of open) {
      const row = el("button", "plan-tab-recent-row");
      row.title = "Open this plan in the Planner";
      const title = el("span", "plan-tab-recent-title");
      title.textContent = plan.title;
      const meta = el("span", "plan-tab-recent-meta");
      const taskPart = plan.taskTitle === undefined ? "" : `${plan.taskTitle} · `;
      meta.textContent = `${taskPart}${String(plan.artifactCount)} artifact${plan.artifactCount === 1 ? "" : "s"} · ${String(plan.openAnnotationCount)} ✎ · ${relativeTime(plan.updatedAt)}`;
      row.append(planRowDot(plan), title, meta);
      row.addEventListener("click", () => {
        // Follow the plan here AND open it in the full workspace.
        composeNew = false;
        state.planTabPlanId = plan.planId;
        ctx.persist();
        void request({ type: "planner.open", planId: plan.planId });
        void syncRail();
        render();
      });
      recent.body.append(row);
    }
  }

  function renderTaskPicker(creating: boolean): void {
    taskRow.classList.toggle("hidden", !creating);
    if (!creating) return;
    taskSelect.replaceChildren();
    taskSelect.append(option("", "no task (orphan)"));
    for (const task of state.tasks) {
      if (task.state === "done") continue;
      taskSelect.append(option(task.taskId, task.title));
    }
    if (pendingTaskId !== "" && !state.tasks.some((task) => task.taskId === pendingTaskId)) {
      pendingTaskId = "";
    }
    taskSelect.value = pendingTaskId;
  }

  function render(): void {
    renderRecent();
    const plan = activePlan();

    currentLabel.replaceChildren();
    const titleText = el("span");
    titleText.textContent = plan === undefined ? "New plan" : plan.title;
    currentLabel.append(titleText);
    if (plan !== undefined) {
      // The owning task, surfaced right where the plan is named — an orphan
      // reads as the exception it should be.
      const chip = el("span", plan.taskId === null ? "plan-tab-task-chip orphan" : "plan-tab-task-chip");
      chip.textContent = plan.taskId === null ? "no task" : (plan.taskTitle ?? "task");
      chip.title = plan.taskId === null
        ? "Orphan plan — planning from a task is recommended"
        : `Belongs to task: ${plan.taskTitle ?? plan.taskId}`;
      currentLabel.append(chip);
    }
    openPanelButton.classList.toggle("hidden", plan === undefined && plans.length === 0);
    renderTaskPicker(plan === undefined && !booting);

    statusRow.replaceChildren();
    if (plan !== undefined) {
      let stateClass = "state-none";
      let label = "no session yet — send a message to start planning";
      if (booting) {
        stateClass = "state-starting";
        label = "starting the planning session…";
      } else if (turnActive) {
        stateClass = "state-working";
        label = "agent working…";
      } else if (plan.sessionId !== null && liveish(plan.sessionId)) {
        stateClass = "state-live";
        label = "session live";
      } else if (plan.sessionId !== null) {
        stateClass = "state-offline";
        label = "offline — send a message to reconnect";
      }
      const dot = statusDot(stateClass, label);
      const text = el("span", "plan-tab-status-text");
      text.textContent = label;
      const meta = el("span", "plan-tab-footnote");
      meta.textContent = `${String(plan.artifactCount)} artifact${plan.artifactCount === 1 ? "" : "s"} · ${String(plan.openAnnotationCount)} open ✎`;
      statusRow.append(dot, text, el("span", "composer-spacer"), meta);
    } else if (booting) {
      statusRow.append(statusDot("state-starting", "starting"), textSpan("creating the plan…"));
    }

    noticeRow.classList.toggle("hidden", notice === null);
    if (notice !== null) {
      noticeRow.replaceChildren();
      const text = el("span");
      text.textContent = notice;
      const dismiss = button("✕", "ghost small");
      dismiss.addEventListener("click", () => {
        notice = null;
        render();
      });
      noticeRow.append(text, dismiss);
    }

    const allocated = state.workspacePolicy?.security?.networkedAiAllowed === true;
    promptInput.disabled = !allocated;
    sendButton.disabled = !allocated;
    promptInput.placeholder = allocated
      ? plan === undefined
        ? "Describe what you're building — this starts a new plan…"
        : "Refine the plan…"
      : planAllocationMessage();
    mountsNote.textContent = plan === undefined
      ? (pendingTaskId === ""
        ? "orphan plan — picking a task is recommended"
        : "a new plan boots its own read-only session")
      : "plan session · project mounts :ro";
    stopButton.disabled = !turnActive;
    renderLog();
  }

  function planAllocationMessage(): string {
    const security = state.workspacePolicy?.security;
    if (security === undefined) return "Loading the workstation security policy…";
    return security.managed
      ? "AI planning is not allocated on this workstation. Ask your administrator if you need access."
      : "Networked AI is off. Enable Drydock › Security: Networked AI Enabled, then reload the window.";
  }

  function textSpan(text: string): HTMLElement {
    const node = el("span", "plan-tab-status-text");
    node.textContent = text;
    return node;
  }

  function renderLog(): void {
    log.replaceChildren();
    const plan = activePlan();
    if (plan === undefined && !booting) {
      const empty = el("div", "plan-tab-empty");
      const lead = el("div", "chat-empty-lead");
      lead.textContent = "Plan something.";
      const hint = el("div", "chat-empty-modes");
      hint.textContent = "Your first message becomes the plan's brief — the Planner opens with the drafts as they land.";
      empty.append(lead, hint);
      log.append(empty);
      return;
    }
    if (railMessages.length === 0 && !turnActive && !booting) {
      const empty = el("div", "plan-tab-empty");
      empty.textContent = plan?.sessionId === null
        ? "Send a message below to start this plan's session."
        : "The plan session's transcript will appear here.";
      log.append(empty);
      return;
    }
    for (const message of railMessages) {
      log.append(chatMessageRow(message, rowContext));
    }
    if (turnActive || booting) {
      log.append(workingIndicatorRow({
        ...(turnStartedAt === undefined ? {} : { turnStartedAt }),
        ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
        ...(reasoningActive ? { reasoning: { text: reasoningText } } : {})
      }));
    } else if (reasoningActive) {
      log.append(workingIndicatorRow({ reasoning: { text: reasoningText } }));
    }
    log.scrollTop = log.scrollHeight;
  }

  function setTicking(active: boolean): void {
    if (tickTimer !== undefined) {
      window.clearInterval(tickTimer);
      tickTimer = undefined;
    }
    if (active) {
      tickTimer = window.setInterval(() => {
        if (!turnActive && !booting) return;
        const existing = log.querySelector(".chat-working, .chat-reasoning");
        if (existing) {
          existing.replaceWith(workingIndicatorRow({
            ...(turnStartedAt === undefined ? {} : { turnStartedAt }),
            ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
            ...(reasoningActive ? { reasoning: { text: reasoningText } } : {})
          }));
        }
      }, 1_000);
    }
  }

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  function resetRail(sessionId: string | null): void {
    railSessionId = sessionId;
    railMessages = [];
    railGroups = {};
    railLastSequence = 0;
    reasoningActive = false;
    reasoningText = "";
    folder.clearLiveState();
  }

  /** Incremental timeline pull — the same replay mechanism every rail uses. */
  async function syncRail(): Promise<void> {
    const sessionId = activePlan()?.sessionId ?? null;
    if (sessionId === null) {
      if (railSessionId !== null) {
        resetRail(null);
        renderLog();
      }
      return;
    }
    if (railSessionId !== sessionId) {
      resetRail(sessionId);
    }
    const response = await request({ type: "session.timeline", sessionId, fromSequence: railLastSequence + 1 });
    if (!response.ok || response.payload.type !== "session.timeline") return;
    if (railSessionId !== sessionId) return;
    for (const line of response.payload.lines) {
      if (line.sequence <= railLastSequence) continue;
      folder.apply(line, false);
      railLastSequence = line.sequence;
    }
    renderLog();
  }

  async function refreshPlans(): Promise<void> {
    const response = await request({ type: "planner.plans" });
    if (response.ok && response.payload.type === "planner.plans") {
      plans = [...response.payload.plans];
    }
  }

  // ---------------------------------------------------------------------------
  // Pushes (multiple subscribers per type are supported; the Edit tab keeps its own)
  // ---------------------------------------------------------------------------

  onPush("chat.event", (payload) => {
    if (payload.sessionId !== railSessionId) return;
    if (payload.line.sequence <= railLastSequence) return;
    railLastSequence = payload.line.sequence;
    if (turnActive) lastActivityAt = Date.now();
    folder.apply(payload.line, false);
  });
  onPush("chat.turnStarted", (payload) => {
    if (payload.sessionId !== railSessionId) return;
    turnActive = true;
    booting = false;
    folder.clearActiveAssistant();
    folder.resetTurn();
    reasoningActive = false;
    reasoningText = "";
    turnStartedAt = Date.now();
    lastActivityAt = Date.now();
    setTicking(true);
    render();
  });
  onPush("chat.turnCompleted", (payload) => {
    if (payload.sessionId !== railSessionId) return;
    turnActive = false;
    turnStartedAt = undefined;
    setTicking(false);
    folder.clearActiveAssistant();
    void syncRail();
    void refreshPlans().then(() => render());
  });
  onPush("planner.changed", () => {
    void refreshPlans().then(() => {
      render();
      return syncRail();
    });
  });
  onPush("planner.sessionReady", (payload) => {
    booting = false;
    if (!payload.ok) {
      notice = payload.error ?? "The planning session failed to start.";
    }
    void refreshPlans().then(() => {
      render();
      return syncRail();
    });
  });
  onPush("session.updated", (payload) => {
    if (payload.session.sessionId === railSessionId) render();
  });

  async function refreshTasks(): Promise<void> {
    // The task picker's options; harmless if the Tasks tab already fetched.
    const response = await request({ type: "task.list" });
    if (response.ok && response.payload.type === "task.list") {
      upsertTasks(state, response.payload.tasks);
    }
  }

  function refresh(): void {
    void refreshTasks().then(() => render());
    void refreshPlans().then(() => {
      render();
      return syncRail();
    });
  }

  function startForTask(taskId: string): void {
    composeNew = true;
    pendingTaskId = taskId;
    resetRail(null);
    void refreshTasks().then(() => render());
    render();
    promptInput.focus();
  }

  render();
  return { root, render, refresh, startForTask };
}
