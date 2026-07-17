/**
 * Plan tab (ADR 0012): the planning chat in the sidebar, between Tasks and
 * Edit.
 *
 * Plan ownership stays in this sidebar surface: the plan list, full new-plan
 * intake, aspect registry, and planning conversation. The editor-area Planner
 * only reviews the selected plan's files, outline, viewer, and notes queue.
 *
 * The transcript renders through the SAME shared components as the Edit tab
 * and the panel rail (chat/transcriptModel + messageRow).
 *
 * SECURITY: every dynamic string renders via textContent - never innerHTML.
 */

import type { PlanAspectSummary, PlanSummary } from "@drydock/contracts";
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
import { button, chip, collapsible, el, option, relativeTime, select, statusDot } from "../components.js";
import { setHelpTooltip } from "../help.js";
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
  let aspects: PlanAspectSummary[] = [];
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
  const intake = {
    brief: "",
    notes: "",
    selectedAspects: new Set<string>(),
    contextRoots: [] as string[],
    manageAspects: false
  };
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
  // Structure: plan list / active-plan header / intake or conversation.
  // ---------------------------------------------------------------------------

  const recent = collapsible("Plans", false);
  recent.details.classList.add("plan-tab-recent");

  const headerRow = el("div", "plan-tab-header");
  const currentLabel = el("span", "plan-tab-current");
  const newPlanButton = button("＋ New plan", "ghost small");
  newPlanButton.title = "Open the new-plan intake";
  setHelpTooltip(newPlanButton, "Create a plan from a brief, owning task, planning aspects, and read-only context.");
  newPlanButton.addEventListener("click", () => {
    if (composeNew && plans.some((plan) => plan.status !== "archived")) {
      composeNew = false;
      render();
      void syncRail();
      return;
    }
    startNewPlan();
  });
  const openPanelButton = button("Open Planner ↗", "small plan-tab-open");
  openPanelButton.title = "Open the plan files, outline, viewer, and notes queue";
  setHelpTooltip(openPanelButton, "Open Planner to review plan files, navigate their outline, and queue revision notes.");
  openPanelButton.addEventListener("click", () => {
    const plan = activePlan();
    void request({ type: "planner.open", ...(plan === undefined ? {} : { planId: plan.planId }) });
  });
  headerRow.append(currentLabel, el("span", "composer-spacer"), newPlanButton, openPanelButton);

  const statusRow = el("div", "plan-tab-status");
  const intakeSurface = el("section", "plan-tab-intake hidden");
  const log = el("div", "plan-tab-log chat-log");
  const noticeRow = el("div", "plan-tab-notice hidden");

  const composer = el("div", "plan-tab-composer");
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
    if (plan === undefined) return;
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
  composer.append(promptInput, actions);

  root.append(recent.details, headerRow, statusRow, noticeRow, intakeSurface, log, composer);

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
      return statusDot("state-offline", "session offline - reconnects on send");
    }
    return statusDot("state-none", "no session yet");
  }

  function startNewPlan(taskId = ""): void {
    composeNew = true;
    // No explicit task → default to the shared current task, so a plan
    // started from the composer lands on the task you're already working.
    pendingTaskId = taskId !== "" ? taskId : (state.activeTaskId ?? "");
    intake.brief = "";
    intake.notes = "";
    intake.selectedAspects.clear();
    intake.contextRoots = [];
    intake.manageAspects = false;
    resetRail(null);
    render();
    queueMicrotask(() => intakeSurface.querySelector<HTMLTextAreaElement>(".plan-tab-brief")?.focus());
  }

  function intakeLabel(text: string, detail?: string): HTMLElement {
    const row = el("div", "plan-tab-intake-label");
    const label = el("span", "plan-tab-intake-label-main");
    label.textContent = text;
    row.append(label);
    if (detail !== undefined) {
      const hint = el("span", "plan-tab-footnote");
      hint.textContent = detail;
      row.append(hint);
    }
    return row;
  }

  function renderIntake(): void {
    intakeSurface.replaceChildren();
    const heading = el("div", "plan-tab-intake-heading");
    const headingCopy = el("div");
    const kicker = el("div", "plan-tab-intake-kicker");
    kicker.textContent = "NEW PLAN";
    const title = el("h2", "plan-tab-intake-title");
    title.textContent = "Plan the work before implementation";
    const intro = el("p", "plan-tab-intake-copy");
    intro.textContent = "Define the expected result, the task that owns the plan, and the context the planner may inspect.";
    headingCopy.append(kicker, title, intro);
    heading.append(headingCopy);
    intakeSurface.append(heading);

    const main = el("div", "plan-tab-intake-main");
    main.append(intakeLabel("Planning brief", "problem, expected result, constraints"));
    const brief = document.createElement("textarea");
    brief.className = "plan-tab-intake-textarea plan-tab-brief";
    brief.rows = 4;
    brief.placeholder = "Describe what needs to be planned and what a usable result should contain…";
    brief.value = intake.brief;
    brief.addEventListener("input", () => {
      intake.brief = brief.value;
      create.disabled = ctx.isDemo() || intake.brief.trim().length === 0;
    });
    main.append(brief);

    main.append(intakeLabel("Owning task", "keeps planning, implementation, and review together"));
    const taskSelect = select("plan-tab-task-select", "The task this plan belongs to");
    setHelpTooltip(taskSelect, "Select the task that will own the plan, its session, generated files, and later subtasks.");
    taskSelect.append(option("", "no task (orphan)"));
    for (const task of state.tasks) {
      if (task.state === "done") continue;
      taskSelect.append(option(task.taskId, task.title));
    }
    if (pendingTaskId !== "" && !state.tasks.some((task) => task.taskId === pendingTaskId)) pendingTaskId = "";
    taskSelect.value = pendingTaskId;
    taskSelect.addEventListener("change", () => {
      pendingTaskId = taskSelect.value;
      // Picking a task here IS choosing the current task - keep Tasks/Edit in sync.
      if (taskSelect.value !== "" && state.activeTaskId !== taskSelect.value) {
        state.activeTaskId = taskSelect.value;
        ctx.bridge.work.render();
        ctx.persist();
      }
    });
    main.append(taskSelect);

    const aspectsSection = el("section", "plan-tab-intake-aspects");
    const aspectsHead = el("div", "plan-tab-intake-section-head");
    aspectsHead.append(intakeLabel("Planning aspects", "select every area the plan must address"));
    const manage = button(intake.manageAspects ? "Close manager" : "Manage", "ghost small");
    manage.addEventListener("click", () => {
      intake.manageAspects = !intake.manageAspects;
      render();
    });
    aspectsHead.append(manage);
    const aspectChips = el("div", "plan-tab-aspect-chips");
    for (const aspect of aspects.filter((entry) => !entry.archived)) {
      const selected = intake.selectedAspects.has(aspect.aspectId);
      const node = chip(`${selected ? "✓ " : ""}${aspect.label}`, () => {
        const nextSelected = !intake.selectedAspects.has(aspect.aspectId);
        if (nextSelected) intake.selectedAspects.add(aspect.aspectId);
        else intake.selectedAspects.delete(aspect.aspectId);
        node.textContent = `${nextSelected ? "✓ " : ""}${aspect.label}`;
        node.classList.toggle("selected", nextSelected);
        node.setAttribute("aria-pressed", nextSelected ? "true" : "false");
      });
      node.classList.add("plan-tab-aspect-chip");
      node.classList.toggle("selected", selected);
      node.setAttribute("aria-pressed", selected ? "true" : "false");
      setHelpTooltip(node, aspect.instructions);
      aspectChips.append(node);
    }
    aspectsSection.append(aspectsHead, aspectChips);
    if (intake.manageAspects) aspectsSection.append(renderAspectManager());
    main.append(aspectsSection);

    const contextSection = el("section", "plan-tab-intake-context");
    contextSection.append(intakeLabel("Read-only context", "files or folders the planning session may inspect"));
    const roots = el("div", "plan-tab-context-roots");
    for (const [index, path] of intake.contextRoots.entries()) {
      const row = el("div", "plan-tab-context-row");
      const text = el("span", "plan-tab-context-path");
      text.textContent = path;
      const mode = el("span", "plan-tab-context-mode");
      mode.textContent = ":ro";
      const remove = button("Remove", "ghost small");
      remove.addEventListener("click", () => {
        intake.contextRoots.splice(index, 1);
        render();
      });
      row.append(text, mode, remove);
      roots.append(row);
    }
    const addRow = el("div", "plan-tab-context-add");
    const pathInput = document.createElement("input");
    pathInput.type = "text";
    pathInput.className = "plan-tab-intake-input";
    pathInput.placeholder = "Absolute file or folder path";
    const add = button("Add", "small");
    const addPath = (): void => {
      const value = pathInput.value.trim();
      if (value.length === 0) return;
      if (!intake.contextRoots.includes(value)) intake.contextRoots.push(value);
      render();
    };
    add.addEventListener("click", addPath);
    pathInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addPath();
      }
    });
    addRow.append(pathInput, add);
    roots.append(addRow);
    contextSection.append(roots);
    main.append(contextSection);

    main.append(intakeLabel("Pre-information", "prior decisions, constraints, or links"));
    const notes = document.createElement("textarea");
    notes.className = "plan-tab-intake-textarea";
    notes.rows = 3;
    notes.placeholder = "Add background the planner should know before it starts…";
    notes.value = intake.notes;
    notes.addEventListener("input", () => {
      intake.notes = notes.value;
    });
    main.append(notes);
    intakeSurface.append(main);

    const footer = el("footer", "plan-tab-intake-footer");
    const persistence = el("span", "plan-tab-footnote");
    persistence.textContent = ctx.isDemo()
      ? "Demo data cannot start a planning session."
      : "Context is mounted read-only; collected plan files remain available between turns.";
    const create = button(booting ? "Creating…" : "Create plan", "primary plan-tab-create");
    create.disabled = booting || ctx.isDemo() || intake.brief.trim().length === 0;
    create.addEventListener("click", () => void createPlan());
    footer.append(persistence, create);
    intakeSurface.append(footer);
  }

  function renderAspectManager(): HTMLElement {
    const manager = el("div", "plan-tab-aspect-manager");
    for (const aspect of aspects) manager.append(renderAspectEditor(aspect));
    manager.append(renderAspectEditor(null));
    return manager;
  }

  function renderAspectEditor(aspect: PlanAspectSummary | null): HTMLElement {
    const row = el("div", `plan-tab-aspect-editor${aspect?.archived === true ? " archived" : ""}`);
    const label = document.createElement("input");
    label.type = "text";
    label.className = "plan-tab-intake-input";
    label.placeholder = aspect === null ? "New aspect label" : "Aspect label";
    label.value = aspect?.label ?? "";
    const instructions = document.createElement("textarea");
    instructions.className = "plan-tab-intake-textarea";
    instructions.rows = 2;
    instructions.placeholder = "What this aspect asks the planner to cover";
    instructions.value = aspect?.instructions ?? "";
    const expected = document.createElement("input");
    expected.type = "text";
    expected.className = "plan-tab-intake-input";
    expected.placeholder = "Expected files, separated by semicolons";
    expected.value = (aspect?.expectedArtifacts ?? []).join("; ");
    const actions = el("div", "plan-tab-aspect-actions");
    const save = button(aspect === null ? "Add aspect" : "Save", "small");
    save.addEventListener("click", () => {
      const nextLabel = label.value.trim();
      const nextInstructions = instructions.value.trim();
      if (nextLabel.length === 0 || nextInstructions.length === 0) {
        notice = "An aspect needs both a label and instructions.";
        render();
        return;
      }
      void request({
        type: "planner.aspects.save",
        aspect: {
          ...(aspect === null ? {} : { aspectId: aspect.aspectId }),
          label: nextLabel,
          instructions: nextInstructions,
          expectedArtifacts: expected.value.split(";").map((value) => value.trim()).filter((value) => value.length > 0)
        }
      }).then((response) => {
        if (response.ok && response.payload.type === "planner.aspects.save") aspects = [...response.payload.aspects];
        else if (!response.ok) notice = response.error.message;
        render();
      });
    });
    actions.append(save);
    if (aspect !== null) {
      const archive = button(aspect.archived ? "Restore" : "Archive", "ghost small");
      archive.addEventListener("click", () => {
        void request({ type: "planner.aspects.archive", aspectId: aspect.aspectId, archived: !aspect.archived }).then((response) => {
          if (response.ok && response.payload.type === "planner.aspects.archive") aspects = [...response.payload.aspects];
          else if (!response.ok) notice = response.error.message;
          render();
        });
      });
      actions.append(archive);
    }
    row.append(label, instructions, expected, actions);
    return row;
  }

  async function createPlan(): Promise<void> {
    if (ctx.isDemo()) return;
    if (state.workspacePolicy?.security?.networkedAiAllowed !== true) {
      notice = planAllocationMessage();
      render();
      return;
    }
    const brief = intake.brief.trim();
    if (brief.length === 0) return;
    booting = true;
    render();
    const response = await request({
      type: "planner.create",
      brief,
      aspectIds: [...intake.selectedAspects],
      contextRoots: [...intake.contextRoots],
      ...(intake.notes.trim().length === 0 ? {} : { notes: intake.notes.trim() }),
      ...(pendingTaskId === "" ? {} : { taskId: pendingTaskId })
    });
    if (!response.ok) {
      booting = false;
      notice = response.error.message;
      render();
      return;
    }
    if (response.payload.type !== "planner.create") return;
    composeNew = false;
    state.planTabPlanId = response.payload.plan.planId;
    intake.brief = "";
    intake.notes = "";
    intake.selectedAspects.clear();
    intake.contextRoots = [];
    ctx.persist();
    await refreshPlans();
    render();
    await syncRail();
  }

  function renderRecent(): void {
    const open = plans.filter((plan) => plan.status !== "archived");
    const archived = plans.filter((plan) => plan.status === "archived");
    recent.summaryLabel.textContent = `Plans (${String(open.length)})`;
    recent.body.replaceChildren();
    if (open.length === 0) {
      const empty = el("div", "plan-tab-recent-empty");
      empty.textContent = "No active plans. Use New plan to define one.";
      recent.body.append(empty);
    }
    for (const plan of open) recent.body.append(planListRow(plan));
    if (archived.length > 0) {
      const label = el("div", "plan-tab-plan-group");
      label.textContent = "ARCHIVED";
      recent.body.append(label);
      for (const plan of archived) recent.body.append(planListRow(plan));
    }
  }

  function planListRow(plan: PlanSummary): HTMLElement {
    const wrap = el("div", `plan-tab-plan-row${state.planTabPlanId === plan.planId && !composeNew ? " selected" : ""}${plan.status === "archived" ? " archived" : ""}`);
    const row = el("button", "plan-tab-recent-row");
    row.title = plan.status === "archived" ? "Restore and open this plan" : "Select this plan and open Planner";
    const title = el("span", "plan-tab-recent-title");
    title.textContent = plan.title;
    const meta = el("span", "plan-tab-recent-meta");
    const taskPart = plan.taskTitle === undefined ? "" : `${plan.taskTitle} · `;
    meta.textContent = `${taskPart}${String(plan.artifactCount)} file${plan.artifactCount === 1 ? "" : "s"} · ${String(plan.openAnnotationCount)} notes · ${relativeTime(plan.updatedAt)}`;
    row.append(planRowDot(plan), title, meta);
    row.addEventListener("click", () => {
      if (plan.status === "archived") {
        void setPlanArchived(plan, false, true);
        return;
      }
      selectPlanAndOpen(plan.planId);
    });
    const archive = button(plan.status === "archived" ? "Restore" : "Archive", "ghost small plan-tab-plan-action");
    archive.addEventListener("click", () => void setPlanArchived(plan, plan.status !== "archived", plan.status === "archived"));
    wrap.append(row, archive);
    return wrap;
  }

  function selectPlanAndOpen(planId: string): void {
    composeNew = false;
    state.planTabPlanId = planId;
    resetRail(null);
    ctx.persist();
    void request({ type: "planner.open", planId });
    render();
    void syncRail();
  }

  async function setPlanArchived(plan: PlanSummary, archived: boolean, openAfter: boolean): Promise<void> {
    const response = await request({ type: "planner.archive", planId: plan.planId, archived });
    if (!response.ok) {
      notice = response.error.message;
      render();
      return;
    }
    await refreshPlans();
    if (!archived && openAfter) {
      selectPlanAndOpen(plan.planId);
      return;
    }
    if (archived && state.planTabPlanId === plan.planId) {
      state.planTabPlanId = plans.find((candidate) => candidate.status !== "archived")?.planId ?? null;
      resetRail(null);
      ctx.persist();
    }
    render();
    await syncRail();
  }

  function render(): void {
    renderRecent();
    const plan = activePlan();
    const creating = plan === undefined;

    currentLabel.replaceChildren();
    const titleText = el("span");
    titleText.textContent = plan === undefined ? "New plan" : plan.title;
    currentLabel.append(titleText);
    if (plan !== undefined) {
      // The owning task, surfaced right where the plan is named - an orphan
      // reads as the exception it should be.
      const chip = el("span", plan.taskId === null ? "plan-tab-task-chip orphan" : "plan-tab-task-chip");
      chip.textContent = plan.taskId === null ? "no task" : (plan.taskTitle ?? "task");
      chip.title = plan.taskId === null
        ? "Orphan plan - planning from a task is recommended"
        : `Belongs to task: ${plan.taskTitle ?? plan.taskId}`;
      currentLabel.append(chip);
    }
    newPlanButton.textContent = composeNew && plans.some((candidate) => candidate.status !== "archived") ? "Cancel" : "＋ New plan";
    newPlanButton.classList.toggle("hidden", creating && !composeNew && plans.length === 0);
    openPanelButton.classList.toggle("hidden", creating);
    intakeSurface.classList.toggle("hidden", !creating);
    log.classList.toggle("hidden", creating);
    composer.classList.toggle("hidden", creating);
    if (creating) renderIntake();

    statusRow.replaceChildren();
    if (plan !== undefined) {
      let stateClass = "state-none";
      let label = "no session yet - send a message to start planning";
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
        label = "offline - send a message to reconnect";
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

    const demo = ctx.isDemo();
    const allocated = state.workspacePolicy?.security?.networkedAiAllowed === true && !demo;
    promptInput.disabled = !allocated;
    sendButton.disabled = !allocated;
    promptInput.placeholder = demo
      ? "Demo data - planning input is disconnected. Switch to Live data to contact an agent."
      : allocated
      ? "Ask a planning question or request a broader change…"
      : planAllocationMessage();
    mountsNote.textContent = "plan session · project mounts :ro";
    stopButton.disabled = !turnActive;
    if (!creating) renderLog();
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
      hint.textContent = "Your first message becomes the plan's brief - the Planner opens with the drafts as they land.";
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

  /** Incremental timeline pull - the same replay mechanism every rail uses. */
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

  async function refreshAspects(): Promise<void> {
    const response = await request({ type: "planner.aspects.list" });
    if (response.ok && response.payload.type === "planner.aspects.list") {
      aspects = [...response.payload.aspects];
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
    void refreshAspects().then(() => render());
    void refreshPlans().then(() => {
      render();
      return syncRail();
    });
  }

  function startForTask(taskId: string): void {
    // An explicit "Plan for this task" gesture also sets the current task.
    if (state.activeTaskId !== taskId) {
      state.activeTaskId = taskId;
      ctx.persist();
    }
    void refreshTasks().then(() => startNewPlan(taskId));
  }

  function selectPlan(planId?: string): void {
    composeNew = false;
    if (planId !== undefined && state.planTabPlanId !== planId) {
      state.planTabPlanId = planId;
      resetRail(null);
      ctx.persist();
    }
    void refreshPlans().then(() => {
      render();
      return syncRail();
    });
  }

  render();
  return { root, render, refresh, selectPlan, startForTask };
}
