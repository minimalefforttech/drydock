/**
 * Chat rail webview boot (UX overhaul P2).
 *
 * The one home for the chat since the Control Panel retired (ADR 0020): the
 * same state store, the same messaging bridge, and the same view module
 * (`views/chatTab.ts` over `chat/*`) the four-tab panel's Edit tab used to
 * mount - minus the tab strip and its siblings. Nothing was forked; the chat
 * reaches its host through two callbacks (`focusOwningTask` / `hostChanged`)
 * and the rail answers both with its attribution line.
 *
 * The rail adds three quiet things of its own, all around the mounted chat
 * rather than inside it: a faint line naming the chat's owning task (clicking
 * follows it on the active-task spine, which retargets the Task Hub), a "Track
 * as subtask" affordance that appears only after a chat's first turn completes
 * (the composer deliberately has no subtask toggle, so linkage happens here,
 * after the work has proved it deserves a card - the created card takes the
 * chat with it via `task.link { subtaskId }`), and a one-line backend notice
 * when the host reports itself unavailable.
 *
 * Protocol: this webview attaches to the shared dispatch
 * (`ControlPanelProvider.attachWebview`), so requests, responses, and pushes
 * ride the unchanged versioned envelope.
 *
 * SECURITY: every dynamic string reaches the DOM via textContent - never
 * innerHTML - so agent output can never become markup.
 */

import type { PanelInitState } from "@drydock/contracts";
import { el } from "./components.js";
import { isDemoMode } from "./demoMode.js";
import { loadMcpState } from "./mcpControls.js";
import { onPush, request, startMessaging } from "./messaging.js";
import {
  applyInitState,
  applySessionAttention,
  currentSession,
  owningTaskForSession,
  persist as persistState,
  restore,
  upsertTask,
  type AppState
} from "./state.js";
import type { PanelBridge, ViewContext } from "./viewContext.js";
import { createChatTab } from "./views/chatTab.js";

const app = document.getElementById("app");
if (!app) throw new Error("missing #app root");

const state: AppState = restore();

function persist(): void {
  persistState(state);
}

// Filled once the chat exists; the chat only reaches through the bridge at
// event time, never during construction, so the deferred wiring is safe.
const bridge = {} as PanelBridge;
const ctx: ViewContext = { state, persist, bridge, isDemo: isDemoMode };

startMessaging();

const chatTab = createChatTab(ctx);

// ---------------------------------------------------------------------------
// Rail header: task attribution + the back-to-hub seam
// ---------------------------------------------------------------------------
// A single faint line above the chat naming the task this chat belongs to. It
// is deliberately not a chip or a breadcrumb: the shipped header row below it
// stays the visual anchor.
const attributionRow = el("div", "chat-rail-attribution hidden");
const attributionButton = el("button", "chat-rail-task") as HTMLButtonElement;
attributionButton.type = "button";
attributionButton.title = "Follow this chat's task";
attributionRow.append(attributionButton);

// Backend-unavailable line. The System tab used to show this banner; with that
// tab retired the reason surfaces here rather than nowhere.
const noticeRow = el("div", "chat-rail-notice hidden");

// --- Track as subtask -------------------------------------------------------
// Sessions whose first turn finished in this window. Deliberately in-memory:
// the affordance is a post-turn nudge, not durable state, and a reload simply
// waits for the next turn rather than re-offering out of nowhere.
const turnedSessions = new Set<string>();
/** Sessions already offered-and-acted-on, so the row never comes back. */
const trackedSessions = new Set<string>();

const trackRow = el("div", "chat-rail-track hidden");
const trackButton = el("button", "chat-rail-track-action") as HTMLButtonElement;
trackButton.type = "button";
trackButton.textContent = "Track as subtask";
trackButton.title = "Add this chat's work to the task board as a subtask";
trackRow.append(trackButton);

/**
 * Shown only when this chat hangs directly off a task (never for a chat that
 * already belongs to a subtask) and only once a turn has actually completed.
 */
function trackableTask(): { readonly taskId: string; readonly title: string } | undefined {
  const sessionId = state.selectedSessionId;
  if (sessionId === null) return undefined;
  if (!turnedSessions.has(sessionId) || trackedSessions.has(sessionId)) return undefined;
  const direct = state.tasks.find((task) => task.linkedSessionIds.includes(sessionId));
  if (direct === undefined) return undefined;
  const alreadySubtask = state.tasks.some((task) =>
    task.subtasks.some((subtask) => subtask.linkedSessionIds.includes(sessionId)));
  if (alreadySubtask) return undefined;
  return { taskId: direct.taskId, title: direct.title };
}

function renderTrackRow(): void {
  trackRow.classList.toggle("hidden", trackableTask() === undefined);
}

trackButton.addEventListener("click", () => {
  const target = trackableTask();
  const sessionId = state.selectedSessionId;
  if (target === undefined || sessionId === null) return;
  const title = currentSession(state)?.title ?? "Tracked chat";
  // Snapshot the cards this task already has: the create response returns the
  // whole task, so the new card is whichever id is not in this set.
  const knownSubtaskIds = new Set(
    (state.tasks.find((task) => task.taskId === target.taskId)?.subtasks ?? []).map((subtask) => subtask.subtaskId)
  );
  trackButton.disabled = true;
  void request({ type: "subtask.create", taskId: target.taskId, title }).then(async (response) => {
    trackButton.disabled = false;
    if (!response.ok) {
      noticeRow.textContent = `Could not create the subtask: ${response.error.message}`;
      noticeRow.classList.remove("hidden");
      return;
    }
    if (response.payload.type !== "subtask.create") return;
    upsertTask(state, response.payload.task);
    // The offer is spent whether or not the link lands: the card exists, and a
    // second click would only create a duplicate.
    trackedSessions.add(sessionId);
    // The chat moves WITH the card: `task.link` carries the new subtask id, so
    // the conversation hangs off the card rather than the parent task.
    const created = response.payload.task.subtasks.find((subtask) => !knownSubtaskIds.has(subtask.subtaskId));
    const subtaskId = created?.subtaskId;
    if (subtaskId !== undefined) {
      const linked = await request({ type: "task.link", taskId: target.taskId, sessionId, subtaskId });
      if (!linked.ok) {
        noticeRow.textContent = `The card was created, but linking this chat to it failed: ${linked.error.message}`;
        noticeRow.classList.remove("hidden");
      } else if (linked.payload.type === "task.link") {
        upsertTask(state, linked.payload.task);
      }
    }
    renderAttribution();
    persist();
  });
});

function renderAttribution(): void {
  const task = owningTaskForSession(state, state.selectedSessionId);
  attributionButton.textContent = task === undefined ? "" : task.title;
  attributionRow.classList.toggle("hidden", task === undefined);
  renderTrackRow();
}

/**
 * Back-to-task: set the active-task spine to this chat's task so every surface
 * agrees on what is being worked on. The spine is the durable half of the
 * navigation - the Task Hub retargets off the resulting push.
 */
function followOwningTask(): void {
  const task = owningTaskForSession(state, state.selectedSessionId);
  if (task === undefined) return;
  state.activeTaskId = task.taskId;
  persist();
  void request({ type: "active.set", taskId: task.taskId });
}

attributionButton.addEventListener("click", followOwningTask);

// ---------------------------------------------------------------------------
// Host callbacks
// ---------------------------------------------------------------------------
// The chat reaches its host for exactly two things: "take me back to my task"
// and "shared state moved, redraw your own chrome". Both are the rail's
// attribution line.
bridge.focusOwningTask = followOwningTask;
bridge.hostChanged = renderAttribution;

/**
 * Backend availability. The retired System tab used to own this banner; with no
 * System tab the reason surfaces on the rail's own notice row or nowhere.
 */
function setAvailability(available: boolean, reason?: string): void {
  noticeRow.textContent = available ? "" : (reason ?? "The Drydock backend is unavailable.");
  noticeRow.classList.toggle("hidden", available);
}

app.replaceChildren(attributionRow, trackRow, noticeRow, chatTab.root);

// Session switching happens inside the chat's own header, which does not always
// call back into the host. Re-evaluating the offer after any click in the chat
// keeps it from pointing at a session the user has already left.
chatTab.root.addEventListener("click", () => renderTrackRow());

chatTab.render();
renderAttribution();

// ---------------------------------------------------------------------------
// Pushes the rail host owns
// ---------------------------------------------------------------------------
// The chat subscribes to everything about its own session; these are the few
// shared-state pushes the retired Tasks tab used to absorb and that the chat
// still depends on (workspace context, task identity, session lifecycle).
onPush("workspace.folders", (payload) => {
  state.openFolderNames = [...payload.openFolderNames];
  chatTab.render();
  persist();
});

onPush("session.deleted", (payload) => {
  state.sessions = state.sessions.filter((session) => session.sessionId !== payload.sessionId);
  turnedSessions.delete(payload.sessionId);
  trackedSessions.delete(payload.sessionId);
  if (state.selectedSessionId === payload.sessionId) chatTab.resetToNewChat();
  renderAttribution();
  persist();
});

// A finished turn is what earns the "Track as subtask" offer: before it there
// is nothing worth a board card, and the chat itself already carries the intent.
onPush("chat.turnCompleted", (payload) => {
  if (!turnedSessions.has(payload.sessionId)) {
    turnedSessions.add(payload.sessionId);
    renderTrackRow();
  }
});

onPush("session.attention", (payload) => {
  if (!applySessionAttention(state, payload.sessionId, payload.reasons)) return;
  if (payload.sessionId === state.selectedSessionId) chatTab.render();
  persist();
});

onPush("task.updated", (payload) => {
  upsertTask(state, payload.task);
  renderAttribution();
  chatTab.render();
  persist();
});

onPush("task.deleted", (payload) => {
  state.tasks = state.tasks.filter((task) => task.taskId !== payload.taskId);
  state.taskNotes = state.taskNotes.filter((note) => note.taskId !== payload.taskId);
  renderAttribution();
  chatTab.render();
  persist();
});

onPush("activeTask", (payload) => {
  // The spine moved somewhere else in the window. P2 only follows it in the
  // attribution line - the rail never yanks the chat the user is reading; the
  // hub owns retargeting from P3 on.
  state.activeTaskId = payload.activeTaskId;
  renderAttribution();
  persist();
});

// ---------------------------------------------------------------------------
// Boot loads
// ---------------------------------------------------------------------------
/** Guards the single automatic panel.init retry after a failed boot. */
let initRetryScheduled = false;

async function refreshRailData(): Promise<void> {
  const [initResponse, sessionsResponse, questionsResponse, workspaceResponse, tasksResponse, activeResponse] =
    await Promise.all([
      request({ type: "panel.init" }),
      request({ type: "session.list" }),
      request({ type: "question.list" }),
      request({ type: "workspace.state" }),
      request({ type: "task.list" }),
      request({ type: "active.get" })
    ]);

  if (!initResponse.ok || initResponse.payload.type !== "panel.init") {
    setAvailability(false, initResponse.ok ? "Unexpected init response." : initResponse.error.message);
    // One delayed retry: a failed init otherwise leaves the rail with no
    // provider catalogs (they are deliberately not restored from persisted
    // webview state) until the user manually pokes something.
    if (!initRetryScheduled) {
      initRetryScheduled = true;
      setTimeout(() => { void refreshRailData(); }, 3_000);
    }
  } else {
    const init: PanelInitState = initResponse.payload.state;
    setAvailability(init.availability.available, init.availability.reason);
    applyInitState(state, init);
    chatTab.render();
    persist();
  }

  if (sessionsResponse.ok && sessionsResponse.payload.type === "session.list") {
    state.sessions = [...sessionsResponse.payload.sessions];
    chatTab.render();
    if (state.selectedSessionId !== null && currentSession(state) !== undefined) {
      chatTab.selectSession(state.selectedSessionId);
    } else if (state.selectedSessionId !== null) {
      chatTab.resetToNewChat();
    }
    persist();
  }

  if (questionsResponse.ok && questionsResponse.payload.type === "question.list") {
    state.questions = [...questionsResponse.payload.questions];
    chatTab.render();
    persist();
  }

  if (workspaceResponse.ok && workspaceResponse.payload.type === "workspace.state") {
    state.workspacePolicy = workspaceResponse.payload.state;
    chatTab.render();
    persist();
  }

  if (tasksResponse.ok && tasksResponse.payload.type === "task.list") {
    state.tasks = [...tasksResponse.payload.tasks];
    chatTab.render();
    persist();
  }

  // The spine is host-authoritative; a degraded backend simply answers with an
  // error and the rail keeps whatever it restored.
  if (activeResponse.ok && activeResponse.payload.type === "active.get") {
    state.activeTaskId = activeResponse.payload.activeTaskId;
    persist();
  }

  renderAttribution();

  // MCP rows inside the chat's FileMap disclosure. Cheap host read; failures
  // just leave the rows out.
  if (await loadMcpState(state)) chatTab.render();
}

void refreshRailData();
