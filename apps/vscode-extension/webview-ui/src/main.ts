/**
 * Control panel webview boot (chat panel redesign, Phase 1).
 *
 * Restores persisted state, builds the three-tab shell (Chat | Work | System),
 * wires the shared bridge so views can cross tab boundaries, initializes each
 * view, and runs the boot loads (panel.init + session.list). Rendering logic
 * lives in the view modules; this file only orchestrates.
 *
 * SECURITY: every module renders dynamic strings via textContent — never
 * innerHTML — so agent output can never become markup. The versioned
 * request/response/push envelope protocol is unchanged.
 */

import type { PanelInitState } from "@drydock/contracts";
import { request, startMessaging } from "./messaging.js";
import {
  applyInitState,
  currentSession,
  persist as persistState,
  restore,
  type AppState
} from "./state.js";
import { buildTabs } from "./tabs.js";
import type { PanelBridge, ViewContext } from "./viewContext.js";
import { createChatTab } from "./views/chatTab.js";
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

startMessaging();

const chatTab = createChatTab(ctx);
const workTab = createWorkTab(ctx);
const systemTab = createSystemTab(ctx);

const tabs = buildTabs(state, (tab) => {
  if (tab === "work") workTab.refresh();
});

bridge.switchTab = (tab) => tabs.select(tab);
bridge.chat = chatTab;
bridge.work = workTab;
bridge.system = systemTab;

tabs.panels.chat.append(chatTab.root);
tabs.panels.work.append(workTab.root);
tabs.panels.system.append(systemTab.root);

app.replaceChildren(tabs.bar, tabs.panels.chat, tabs.panels.work, tabs.panels.system);

// Initial render from restored state, then activate the persisted tab.
chatTab.render();
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

// Workspace state powers the Work tab and the Chat context strip; load once at
// boot so the context chip reflects any selected set immediately.
void request({ type: "workspace.state" }).then((response) => {
  if (response.ok && response.payload.type === "workspace.state") {
    state.workspacePolicy = response.payload.state;
    workTab.render();
    chatTab.render();
    persist();
  }
});
// Internal work tasks power the Work-tab Tasks section and the session-card
// task chips; load once at boot alongside the other Work-tab data.
void request({ type: "task.list" }).then((response) => {
  if (response.ok && response.payload.type === "task.list") {
    state.tasks = [...response.payload.tasks];
    workTab.render();
    persist();
  }
});
