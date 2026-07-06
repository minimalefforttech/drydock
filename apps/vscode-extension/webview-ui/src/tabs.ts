/**
 * Tab bar + router for the chat panel (Tasks | Chat | System).
 *
 * Tasks is the home surface — a lean session list — and Chat is the detail view
 * entered from it (its own back button "‹" returns to Tasks).
 *
 * Hidden tabs keep their DOM (display:none) so switching is instant and view
 * state survives. The active tab is persisted; switching notifies a callback so
 * a view can refresh on activation (e.g. Tasks refetches pending requests).
 *
 * SECURITY: labels here are static; no dynamic strings reach the DOM as markup.
 */

import { el } from "./components.js";
import type { AppState, TabId } from "./state.js";

const TABS: readonly { id: TabId; label: string }[] = [
  { id: "work", label: "Tasks" },
  { id: "chat", label: "Chat" },
  { id: "system", label: "System" }
];

export interface TabShell {
  readonly bar: HTMLElement;
  readonly panels: Record<TabId, HTMLElement>;
  select(tab: TabId): void;
}

/**
 * Builds the tab bar and three panel containers. `onActivate` fires whenever a
 * tab becomes active (including the initial selection) so views can refresh.
 */
export function buildTabs(state: AppState, onActivate: (tab: TabId) => void): TabShell {
  const bar = el("div", "tab-bar");
  bar.setAttribute("role", "tablist");

  const buttons: Record<TabId, HTMLButtonElement> = {} as Record<TabId, HTMLButtonElement>;
  const panels: Record<TabId, HTMLElement> = {} as Record<TabId, HTMLElement>;

  const select = (tab: TabId): void => {
    state.activeTab = tab;
    for (const { id } of TABS) {
      const isActive = id === tab;
      buttons[id].classList.toggle("active", isActive);
      buttons[id].setAttribute("aria-selected", isActive ? "true" : "false");
      panels[id].classList.toggle("hidden", !isActive);
    }
    onActivate(tab);
  };

  for (const { id, label } of TABS) {
    const btn = document.createElement("button");
    btn.className = "tab-button";
    btn.textContent = label;
    btn.setAttribute("role", "tab");
    btn.addEventListener("click", () => select(id));
    buttons[id] = btn;
    bar.append(btn);

    // The chat panel fills the whole viewport (flex column to the bottom); the
    // Tasks/System panels keep their natural, document-scrolled height.
    const panel = el("div", `tab-panel hidden${id === "chat" ? " panel-fill" : ""}`);
    panel.setAttribute("role", "tabpanel");
    panels[id] = panel;
  }

  return { bar, panels, select };
}
