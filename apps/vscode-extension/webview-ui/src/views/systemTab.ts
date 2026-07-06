/**
 * System tab: backend availability, tools, runtimes, and the global event log.
 *
 * - Availability banner + tools (probe app-server, refresh status).
 * - Runtimes list (stop buttons) + a "show removed (24h)" checkbox that
 *   re-requests isolatedRun.listRuntimes with includeRemoved.
 * - Global event log: non-session lines (probe/run/runtime/cleanup) route here;
 *   per-session turn events stay in the Chat tab diagnostics feed.
 * - Footer facts (state root, sbx path).
 *
 * SECURITY: dynamic strings render via textContent — never innerHTML. Lists
 * re-render with replaceChildren so stop-button handlers cannot leak.
 */

import { type RuntimeSummary } from "@drydock/contracts";
import { badge, button, el, formatTime } from "../components.js";
import { onPush, request } from "../messaging.js";
import { type DiagnosticEntry } from "../state.js";
import type { SystemTabView, ViewContext } from "../viewContext.js";

export function createSystemTab(ctx: ViewContext): SystemTabView {
  const state = ctx.state;
  const root = el("div", "system-tab");

  const banner = el("div", "banner hidden");

  const toolsHeading = el("h3");
  toolsHeading.textContent = "Tools";
  const probeButton = button("Probe app-server", "small");
  const refreshButton = button("Refresh status", "small");
  const toolsRow = el("div", "button-row");
  toolsRow.append(probeButton, refreshButton);

  const runtimesHeading = el("h3");
  runtimesHeading.textContent = "Runtimes";
  const showRemovedLabel = el("label", "checkbox-row");
  const showRemovedCheckbox = document.createElement("input");
  showRemovedCheckbox.type = "checkbox";
  const showRemovedText = el("span");
  showRemovedText.textContent = "show removed (24h)";
  showRemovedLabel.append(showRemovedCheckbox, showRemovedText);
  const runtimesList = el("div", "runtimes");

  const logHeading = el("h3");
  logHeading.textContent = "Event log";
  const systemLogEl = el("div", "diagnostics-log");

  const footer = el("div", "footer");

  root.append(banner, toolsHeading, toolsRow, runtimesHeading, showRemovedLabel, runtimesList, logHeading, systemLogEl, footer);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  probeButton.addEventListener("click", () => {
    logSystemLine("starting app-server probe…");
    void request({ type: "isolatedRun.probeAppServer" }).then((response) => {
      if (!response.ok) logSystemLine(`could not start probe: ${response.error.message}`);
    });
  });
  refreshButton.addEventListener("click", () => {
    void refreshRuntimes();
    void request({ type: "provider.list" }).then((response) => {
      if (response.ok && response.payload.type === "provider.list") {
        state.providerCatalogs = [...response.payload.providerCatalogs];
        ctx.bridge.chat.render();
        ctx.persist();
      }
    });
  });
  showRemovedCheckbox.addEventListener("change", () => void refreshRuntimes());

  async function refreshRuntimes(): Promise<void> {
    const response = await request({ type: "isolatedRun.listRuntimes", includeRemoved: showRemovedCheckbox.checked });
    if (response.ok && response.payload.type === "isolatedRun.listRuntimes") {
      state.runtimes = response.payload.runtimes;
      renderRuntimes();
      ctx.persist();
    }
  }

  // ---------------------------------------------------------------------------
  // Push subscriptions (global, non-session events)
  // ---------------------------------------------------------------------------
  onPush("panel.availability", (payload) => {
    setAvailability(payload.availability.available, payload.availability.reason);
  });
  onPush("runtime.inventory", (payload) => {
    // Inventory push is filtered to non-removed; if "show removed" is on, keep
    // the fuller listing until the next explicit refresh.
    if (!showRemovedCheckbox.checked) {
      state.runtimes = payload.runtimes;
      renderRuntimes();
      ctx.persist();
    }
  });
  onPush("probe.completed", (payload) => {
    logSystemLine(`app-server probe: ${payload.status}`);
    for (const diagnostic of payload.diagnostics) logSystemLine(`probe diagnostic: ${diagnostic}`);
  });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function setAvailability(available: boolean, reason?: string): void {
    if (available) {
      banner.classList.add("hidden");
    } else {
      banner.classList.remove("hidden");
      banner.textContent = reason ?? "The isolated backend is unavailable.";
    }
  }

  function renderRuntimes(): void {
    runtimesList.replaceChildren();
    if (state.runtimes.length === 0) {
      const empty = el("div", "empty");
      empty.textContent = "No runtime records.";
      runtimesList.append(empty);
      return;
    }
    for (const runtime of state.runtimes) {
      runtimesList.append(runtimeRow(runtime));
    }
  }

  function runtimeRow(runtime: RuntimeSummary): HTMLElement {
    const row = el("div", "runtime-row");
    const status = badge(runtime.status, `status-${runtime.status}`);
    const name = el("span", "runtime-name");
    name.textContent = runtime.externalName;
    row.append(status, name);
    if (runtime.status !== "removed") {
      const stop = button("Stop", "ghost small");
      stop.addEventListener("click", () => {
        stop.disabled = true;
        void request({ type: "isolatedRun.stopRuntime", runtimeId: runtime.runtimeId }).then((response) => {
          if (response.ok && response.payload.type === "isolatedRun.stopRuntime") {
            logSystemLine(`cleanup ${runtime.externalName}: ${response.payload.status}`);
          } else if (!response.ok) {
            logSystemLine(`cleanup failed: ${response.error.message}`);
            stop.disabled = false;
          }
        });
      });
      row.append(stop);
    }
    return row;
  }

  function renderLog(): void {
    systemLogEl.replaceChildren();
    if (state.systemLog.length === 0) {
      const empty = el("div", "empty");
      empty.textContent = "No events.";
      systemLogEl.append(empty);
      return;
    }
    for (const entry of state.systemLog) {
      const rowEl = el("div", `diagnostic-row kind-${entry.eventType.replace(/\./g, "-")}`);
      const meta = el("span", "diagnostic-meta");
      meta.textContent = `${formatTime(entry.createdAt)} ${entry.eventType} `;
      const text = el("span", "diagnostic-text");
      text.textContent = entry.summary;
      rowEl.append(meta, text);
      systemLogEl.append(rowEl);
    }
    systemLogEl.scrollTop = systemLogEl.scrollHeight;
  }

  function logSystem(entry: DiagnosticEntry): void {
    state.systemLog.push(entry);
    // Cap the log so it cannot grow unbounded across a long session.
    if (state.systemLog.length > 300) state.systemLog = state.systemLog.slice(-300);
    renderLog();
    ctx.persist();
  }

  function logSystemLine(summary: string): void {
    logSystem({ createdAt: new Date().toISOString(), eventType: "panel", summary });
  }

  function setFooter(stateRootDisplayPath: string, sbxDisplayPath?: string): void {
    const parts = [`state root: ${stateRootDisplayPath}`];
    if (sbxDisplayPath) parts.push(`sbx: ${sbxDisplayPath}`);
    footer.textContent = parts.join(" · ");
  }

  function render(): void {
    renderRuntimes();
    renderLog();
  }

  return { root, render, logSystem, setAvailability, setFooter };
}
