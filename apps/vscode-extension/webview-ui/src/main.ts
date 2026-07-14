/**
 * Control panel webview boot (chat panel redesign, Phase 1).
 *
 * Restores persisted state, builds the three-tab shell (Tasks | Chat | System),
 * wires the shared bridge so views can cross tab boundaries, initializes each
 * view, and runs the boot loads (panel.init + session.list). Rendering logic
 * lives in the view modules; this file only orchestrates.
 *
 * SECURITY: every module renders dynamic strings via textContent — never
 * innerHTML — so agent output can never become markup. The versioned
 * request/response/push envelope protocol is unchanged.
 */

import type { PanelInitState } from "@drydock/contracts";
import { onPush, request, startMessaging } from "./messaging.js";
import {
  applyInitState,
  currentSession,
  persist as persistState,
  restore,
  type AppState
} from "./state.js";
import { buildTabs } from "./tabs.js";
import { createHelpExperience } from "./help.js";
import type { PanelBridge, ViewContext } from "./viewContext.js";
import { createChatTab } from "./views/chatTab.js";
import { createPlanTab } from "./views/planTab.js";
import { createSystemTab } from "./views/systemTab.js";
import { createWorkTab } from "./views/workTab.js";

const app = document.getElementById("app");
if (!app) throw new Error("missing #app root");

const state: AppState = restore();

function persist(): void {
  persistState(state);
}

// The bridge is created empty and filled once all views exist; views only reach
// through it at event time, never during construction, so the deferred wiring
// is safe.
const bridge = {} as PanelBridge;
const ctx: ViewContext = { state, persist, bridge };

async function requireAccepted(responsePromise: ReturnType<typeof request>): Promise<void> {
  const response = await responsePromise;
  if (!response.ok) throw new Error(response.error.message);
}

function taskForReviewGuide(): string {
  const selected = state.selectedSessionId === null
    ? undefined
    : state.tasks.find((task) => task.linkedSessionIds.includes(state.selectedSessionId as string));
  const taskId = selected?.taskId ?? state.tasks[0]?.taskId;
  if (taskId === undefined) {
    throw new Error("Create a task before opening the Task Review guide.");
  }
  return taskId;
}

startMessaging();

const chatTab = createChatTab(ctx);
const planTab = createPlanTab(ctx);
const workTab = createWorkTab(ctx);
const systemTab = createSystemTab(ctx);

const tabs = buildTabs(state, (tab) => {
  if (tab === "work") workTab.refresh();
  if (tab === "plan") planTab.refresh();
  if (tab === "system") systemTab.render();
});

onPush("panel.showPlan", (payload) => {
  planTab.selectPlan(payload.planId);
  tabs.select("plan");
});

const help = createHelpExperience({
  id: "control-panel",
  title: "Drydock setup guide",
  intro: "Create a task, select its workspace, then use Plan or Edit depending on whether you need planning or implementation.",
  showWelcome: true,
  pages: [
    {
      id: "start",
      label: "Start here",
      title: "Create and run a task",
      intro: "A task owns its workspace, plans, agent sessions, subtasks, and review state.",
      sections: [
        {
          title: "Create the task",
          body: "In Tasks, enter a task name and select the workspace the agent can access. Select Create & start chat to create the task and open an implementation session."
        },
        {
          title: "Create a plan when needed",
          body: "Use Plan before implementation when requirements or execution steps are unclear. Select the task first; the first message becomes the planning brief."
        },
        {
          title: "Run the implementation",
          body: "Use Edit for the active agent session. Check the isolation summary and mounts, select the model, attach relevant files, and send a specific instruction."
        },
        {
          title: "Review the changes",
          body: "Open Task Review to inspect diffs from linked sessions, add comments, and submit revision instructions. Land the changes after review."
        }
      ]
    },
    {
      id: "safety",
      label: "Access and runtime",
      title: "Check access before starting a session",
      intro: "The selected workspace and security policy determine what the runtime can read and write.",
      sections: [
        {
          title: "Workspace sets",
          body: "Select only the projects required for the task. Mark context-only projects read-only so the runtime cannot modify them."
        },
        {
          title: "Clone policy",
          body: "Clone-only mode writes to private clones instead of live project folders. Omitted paths and denied roots are not mounted into the runtime."
        },
        {
          title: "Attention requests",
          body: "Questions, failed runs, and access requests appear at the top of Tasks. Check the requested path and reason before approving access."
        },
        {
          title: "Runtime controls",
          body: "Use System to inspect provider availability and runtime state, run transport diagnostics, and remove stale runtime records."
        }
      ]
    },
    {
      id: "panels",
      label: "Panel map",
      title: "Use the editor panels",
      intro: "The sidebar contains the primary task, plan, session, and runtime controls. Open an editor panel for a wider task-specific view.",
      sections: [
        {
          title: "Task Board",
          body: "Move tasks and subtasks between stages, define subtask dependencies, and start eligible work."
        },
        {
          title: "Planner",
          body: "Inspect generated plan artifacts, add annotations, send revision instructions, and create board subtasks from checklist items."
        },
        {
          title: "Agents",
          body: "Inspect sessions across tasks, including running, idle, failed, and waiting states."
        },
        {
          title: "Task Review",
          body: "Inspect changed files across projects, add review comments, and submit open comments to the responsible sessions."
        }
      ]
    }
  ],
  tour: [
    {
      title: "Choose the working surface",
      body: "Tasks manages task state. Plan creates and revises plans. Edit controls one agent session. System shows provider and runtime status.",
      target: ".tab-bar",
      prepare: () => tabs.select("work")
    },
    {
      title: "Create the task record",
      body: "Create the task before starting work. Plans, sessions, subtasks, and review comments remain grouped under this task.",
      target: ".tasks-heading-row",
      prepare: () => tabs.select("work")
    },
    {
      title: "Set workspace access",
      body: "Expand the form and select only the workspace the task needs. Use Create & start chat when the first instruction is ready; use Create task only when work will start later.",
      target: ".task-create-form",
      prepare: () => tabs.select("work")
    },
    {
      title: "Plan before implementation when needed",
      body: "Select the task and enter a brief when requirements, architecture, or execution order need to be worked out. Existing plans can be reopened from the same tab.",
      target: ".plan-tab-composer",
      prepare: () => tabs.select("plan")
    },
    {
      title: "Check the active session",
      body: "Confirm the task, session, notes, and isolation details in the Edit header before giving the agent another instruction.",
      target: ".chat-header",
      prepare: () => tabs.select("chat")
    },
    {
      title: "Send the next instruction",
      body: "Use the composer to select the model, attach relevant files, and state the next concrete change or check. Send one instruction when the expected result is clear.",
      target: ".composer",
      prepare: () => tabs.select("chat")
    },
    {
      title: "Inspect runtime status",
      body: "Use System to check provider availability, live runtimes, diagnostics, and cleanup controls when a session does not start or stop as expected.",
      target: ".system-tab",
      prepare: () => tabs.select("system")
    },
    {
      title: "Continue with an editor-panel guide",
      body: "Choose the next workflow to explore",
      target: ".tab-bar",
      prepare: () => tabs.select("work"),
      nextLabel: "Finish here",
      actions: [
        {
          label: "Task Board guide",
          description: "Stages, dependencies, starting work, and verification.",
          run: () => requireAccepted(request({ type: "taskBoard.open", startGuide: true }))
        },
        {
          label: "Agents guide",
          description: "Fleet status, attention, session navigation, and landing.",
          run: () => requireAccepted(request({ type: "agents.open", startGuide: true }))
        },
        {
          label: "Planner guide",
          description: "Plan intake, artifacts, revisions, and board handoff.",
          run: () => requireAccepted(request({
            type: "planner.open",
            ...(state.planTabPlanId === null ? {} : { planId: state.planTabPlanId }),
            startGuide: true
          }))
        },
        {
          label: "Task Review guide",
          description: "Changed files, comments, and revision dispatch.",
          run: () => requireAccepted(request({ type: "taskReview.open", taskId: taskForReviewGuide(), startGuide: true }))
        }
      ]
    }
  ]
});
tabs.bar.append(help.launcher("dd-help-launcher-tabs"));

bridge.switchTab = (tab) => tabs.select(tab);
bridge.chat = chatTab;
bridge.plan = planTab;
bridge.work = workTab;
bridge.system = systemTab;

tabs.panels.chat.append(chatTab.root);
tabs.panels.plan.append(planTab.root);
tabs.panels.work.append(workTab.root);
tabs.panels.system.append(systemTab.root);

app.replaceChildren(tabs.bar, tabs.panels.work, tabs.panels.plan, tabs.panels.chat, tabs.panels.system);

// Initial render from restored state, then activate the persisted tab.
chatTab.render();
planTab.render();
workTab.render();
systemTab.render();
tabs.select(state.activeTab);

// ---------------------------------------------------------------------------
// Boot loads
// ---------------------------------------------------------------------------
void request({ type: "panel.init" }).then((response) => {
  if (!response.ok || response.payload.type !== "panel.init") {
    systemTab.setAvailability(false, response.ok ? "Unexpected init response." : response.error.message);
    return;
  }
  const init: PanelInitState = response.payload.state;
  systemTab.setAvailability(init.availability.available, init.availability.reason);
  applyInitState(state, init);
  systemTab.setFooter(init.stateRootDisplayPath, init.availability.sbxDisplayPath);
  systemTab.render();
  chatTab.render();
  persist();
});

void request({ type: "session.list" }).then((response) => {
  if (response.ok && response.payload.type === "session.list") {
    state.sessions = [...response.payload.sessions];
    workTab.render();
    chatTab.render();
    if (state.selectedSessionId && state.sessions.some((s) => s.sessionId === state.selectedSessionId)) {
      // Reload the selected session's timeline/diff/review.
      chatTab.selectSession(state.selectedSessionId);
    } else if (state.selectedSessionId && currentSession(state) === undefined) {
      // Persisted selection no longer exists → fall back to a clean new chat.
      chatTab.resetToNewChat();
    }
    persist();
  }
});

// Pending agent questions hydrate the attention stack (chat + work surfaces).
void request({ type: "question.list" }).then((response) => {
  if (response.ok && response.payload.type === "question.list") {
    state.questions = [...response.payload.questions];
    workTab.render();
    chatTab.render();
    persist();
  }
});

// Workspace state powers the Tasks tab and the Chat context strip; load once at
// boot so the context chip reflects any selected set immediately.
void request({ type: "workspace.state" }).then((response) => {
  if (response.ok && response.payload.type === "workspace.state") {
    state.workspacePolicy = response.payload.state;
    workTab.render();
    chatTab.render();
    planTab.render();
    systemTab.render();
    persist();
  }
});
// Internal work tasks power the Tasks-tab task list and the session-card
// task chips; load once at boot alongside the other Tasks-tab data.
void request({ type: "task.list" }).then((response) => {
  if (response.ok && response.payload.type === "task.list") {
    state.tasks = [...response.payload.tasks];
    workTab.render();
    chatTab.render();
    persist();
  }
});
