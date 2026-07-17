/**
 * Control panel webview boot (chat panel redesign, Phase 1).
 *
 * Restores persisted state, builds the three-tab shell (Tasks | Chat | System),
 * wires the shared bridge so views can cross tab boundaries, initializes each
 * view, and runs the boot loads (panel.init + session.list). Rendering logic
 * lives in the view modules; this file only orchestrates.
 *
 * SECURITY: every module renders dynamic strings via textContent - never
 * innerHTML - so agent output can never become markup. The versioned
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
import { createDemoModeController, isDemoMode } from "./demoMode.js";
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
const ctx: ViewContext = { state, persist, bridge, isDemo: isDemoMode };

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

const demoMode = createDemoModeController(refreshPanelData);

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
  dataMode: demoMode.helpMode,
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
          title: "Workspaces",
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
      title: "Tasks tab",
      body: "The Tasks tab is where you create and organize task records, respond to attention items, and connect workspaces, chats, subtasks, and review.",
      target: () => tabs.buttons.work,
      prepare: () => tabs.select("work")
    },
    {
      title: "Review items that need a response",
      body: "The attention summary counts access requests, questions, and failed chats. Expand it to answer or dismiss one item at a time before resuming the responsible task.",
      target: () => document.querySelector<HTMLElement>(".attention-section.has-attention .attention-summary")
        ?? document.querySelector<HTMLElement>(".tasks-heading-row"),
      prepare: () => {
        tabs.select("work");
        workTab.showGuideSection("attention");
      }
    },
    {
      title: "Create a task and choose its workspace",
      body: "Enter a task name and optional description, then select the workspace the task may use. Create task only records the work; Create & start chat also opens an implementation session.",
      target: ".task-create-form",
      prepare: () => {
        tabs.select("work");
        workTab.showGuideSection("create");
      }
    },
    {
      title: "Read and update task state",
      body: "The task title and note are editable. The stage pill moves the task between configured columns, and the worked timestamp shows its latest linked activity.",
      target: () => document.querySelector<HTMLElement>(".task-card.active .task-card-top")
        ?? document.querySelector<HTMLElement>(".task-card .task-card-top")
        ?? document.querySelector<HTMLElement>(".task-cards"),
      prepare: () => tabs.select("work")
    },
    {
      title: "Use the task's chats and subtasks",
      body: "Expand Chats to inspect or continue linked sessions. The checklist below tracks smaller work items, blockers, prompts, and auto-start rules owned by this task.",
      target: () => document.querySelector<HTMLElement>(".task-card.active .task-session-summary")
        ?? document.querySelector<HTMLElement>(".task-session-summary")
        ?? document.querySelector<HTMLElement>(".task-cards"),
      prepare: () => {
        tabs.select("work");
        workTab.showGuideSection("linked-chats");
      }
    },
    {
      title: "Move the task forward",
      body: "Use Review and Plan for this task, or link and activate its chat and workspace context. Board manages stages and dependencies; Agents shows sessions across every task.",
      target: () => document.querySelector<HTMLElement>(".task-card.active .task-actions")
        ?? document.querySelector<HTMLElement>(".task-card .task-actions")
        ?? document.querySelector<HTMLElement>(".task-cards"),
      prepare: () => tabs.select("work")
    },
    {
      title: "Review advanced records and access",
      body: "Use Orphaned Chats for unlinked sessions and Memory for reusable suggestions. Workspaces define which folders are available to new chats, including read-only context.",
      target: () => document.querySelector<HTMLElement>(".workspace-access-section > summary")
        ?? document.querySelector<HTMLElement>(".orphaned-chats-section:not(.hidden) > summary")
        ?? document.querySelector<HTMLElement>(".memory-section > summary")
        ?? document.querySelector<HTMLElement>(".work-tab"),
      prepare: () => {
        tabs.select("work");
        workTab.showGuideSection("supporting");
        workTab.showGuideSection("workspace");
      }
    },
    {
      title: "Plan tab",
      body: "The Plan tab is where you create and select plans, provide planning context, and continue the planning conversation.",
      target: () => tabs.buttons.plan,
      prepare: () => tabs.select("plan")
    },
    {
      title: "Select an existing plan",
      body: "Open Plans to select active work, restore an archived plan, or open its files in Planner. The selected row also controls the planning conversation below.",
      target: ".plan-tab-recent",
      prepare: () => {
        tabs.select("plan");
        const plans = document.querySelector<HTMLDetailsElement>(".plan-tab-recent");
        if (plans !== null) plans.open = true;
      }
    },
    {
      title: "Describe the planning result",
      body: "For a new plan, state the problem, the result the plan should produce, and constraints that affect the approach.",
      target: ".plan-tab-brief",
      prepare: () => {
        tabs.select("plan");
        planTab.startForTask("demo-task-onboarding");
      }
    },
    {
      title: "Assign the owning task",
      body: "Select the task that owns the plan so its planning session, generated files, implementation subtasks, and review stay together.",
      target: ".plan-tab-task-select",
      prepare: () => tabs.select("plan")
    },
    {
      title: "Select the planning aspects",
      body: "Choose each area the plan must address explicitly. Manage changes the reusable aspect definitions; it does not start a planning session.",
      target: ".plan-tab-intake-aspects",
      prepare: () => tabs.select("plan")
    },
    {
      title: "Add read-only context",
      body: "Add only the files or folders the planner needs to inspect. Planning context is mounted read-only and cannot be modified by the session.",
      target: ".plan-tab-intake-context",
      prepare: () => tabs.select("plan")
    },
    {
      title: "Create the plan",
      body: "Create plan records the intake and starts its planning session. In Demo data the button stays disabled because no agent or project files are connected.",
      target: ".plan-tab-create",
      prepare: () => tabs.select("plan")
    },
    {
      title: "Continue the planning conversation",
      body: "After the plan exists, use this composer for follow-up questions and broader revisions. Open Planner when you need to review files, outlines, or queued notes.",
      target: ".plan-tab-composer",
      prepare: () => {
        tabs.select("plan");
        planTab.selectPlan(state.planTabPlanId ?? undefined);
      }
    },
    {
      title: "Edit tab",
      body: "The Edit tab is where you inspect one implementation session's context and transcript, then send its next instruction.",
      target: () => tabs.buttons.chat,
      prepare: () => tabs.select("chat")
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
      title: "System tab",
      body: "The System tab is where you check provider availability, runtime inventory, diagnostics, and cleanup controls.",
      target: () => tabs.buttons.system,
      prepare: () => tabs.select("system")
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
          description: "Plan files, outline navigation, notes, revisions, and board handoff.",
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
async function refreshPanelData(): Promise<void> {
  const [initResponse, sessionsResponse, questionsResponse, workspaceResponse, tasksResponse] = await Promise.all([
    request({ type: "panel.init" }),
    request({ type: "session.list" }),
    request({ type: "question.list" }),
    request({ type: "workspace.state" }),
    request({ type: "task.list" })
  ]);

  const response = initResponse;
  if (!response.ok || response.payload.type !== "panel.init") {
    systemTab.setAvailability(false, response.ok ? "Unexpected init response." : response.error.message);
  } else {
    const init: PanelInitState = response.payload.state;
    systemTab.setAvailability(init.availability.available, init.availability.reason);
    applyInitState(state, init);
    systemTab.setFooter(init.stateRootDisplayPath, init.availability.sbxDisplayPath);
    systemTab.render();
    chatTab.render();
    persist();
  }

  const sessions = sessionsResponse;
  if (sessions.ok && sessions.payload.type === "session.list") {
    state.sessions = [...sessions.payload.sessions];
    workTab.render();
    chatTab.render();
    if (state.selectedSessionId && state.sessions.some((item) => item.sessionId === state.selectedSessionId)) {
      chatTab.selectSession(state.selectedSessionId);
    } else if (state.selectedSessionId && currentSession(state) === undefined) {
      chatTab.resetToNewChat();
    }
    persist();
  }

  const questions = questionsResponse;
  if (questions.ok && questions.payload.type === "question.list") {
    state.questions = [...questions.payload.questions];
    workTab.render();
    chatTab.render();
    persist();
  }

  const workspace = workspaceResponse;
  if (workspace.ok && workspace.payload.type === "workspace.state") {
    state.workspacePolicy = workspace.payload.state;
    workTab.render();
    chatTab.render();
    planTab.render();
    systemTab.render();
    persist();
  }

  const tasks = tasksResponse;
  if (tasks.ok && tasks.payload.type === "task.list") {
    state.tasks = [...tasks.payload.tasks];
    workTab.render();
    chatTab.render();
    persist();
  }
}

void refreshPanelData();
