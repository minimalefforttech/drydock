/**
 * System tab: backend availability, tools, runtimes, and the global event log.
 *
 * - Availability banner + tools (probe app-server, refresh status).
 * - Runtimes list (stop buttons) + a "show removed (24h)" checkbox that
 *   re-requests isolatedRun.listRuntimes with includeRemoved.
 * - Chat diagnostics: selected-session facts + per-session turn/tool feed.
 * - Global event log: non-session lines (probe/run/runtime/cleanup) route here.
 * - Footer facts (state root, sbx path).
 *
 * SECURITY: dynamic strings render via textContent — never innerHTML. Lists
 * re-render with replaceChildren so stop-button handlers cannot leak.
 */

import { type RuntimeStatsSummary, type RuntimeSummary } from "@drydock/contracts";
import { badge, button, el, formatTime } from "../components.js";
import { setHelpTooltip } from "../help.js";
import { onPush, request } from "../messaging.js";
import { currentSession, type DiagnosticEntry } from "../state.js";
import type { SystemTabView, ViewContext } from "../viewContext.js";

export function createSystemTab(ctx: ViewContext): SystemTabView {
  const state = ctx.state;
  const root = el("div", "system-tab");

  const banner = el("div", "banner hidden");

  const toolsHeading = el("h3");
  toolsHeading.textContent = "Tools";
  const probeButton = button("Probe app-server", "small");
  setHelpTooltip(probeButton, "Run a diagnostic check against the Codex app-server transport.");
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
  const cleanupButton = button("Clean up stale", "small ghost");
  cleanupButton.title = "Reap quarantined/lost runtimes whose sandbox is already gone, and purge old removed rows";
  setHelpTooltip(cleanupButton, "Remove quarantined or lost runtimes whose sandbox no longer exists, then purge old runtime records.");
  const runtimesControls = el("div", "button-row");
  runtimesControls.append(showRemovedLabel, cleanupButton);
  const runtimesList = el("div", "runtimes");

  const logHeading = el("h3");
  logHeading.textContent = "Event log";
  const systemLogEl = el("div", "diagnostics-log");

  const chatDiagnosticsHeading = el("h3");
  chatDiagnosticsHeading.textContent = "Chat diagnostics";
  const chatFactsGrid = el("div", "facts-grid");
  const chatDiagnosticsLogEl = el("div", "diagnostics-log");

  const footer = el("div", "footer");

  root.append(
    banner,
    toolsHeading,
    toolsRow,
    runtimesHeading,
    runtimesControls,
    runtimesList,
    chatDiagnosticsHeading,
    chatFactsGrid,
    chatDiagnosticsLogEl,
    logHeading,
    systemLogEl,
    footer
  );

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  probeButton.addEventListener("click", () => {
    if (state.workspacePolicy?.security?.networkedAiAllowed !== true) return;
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
  cleanupButton.addEventListener("click", () => {
    cleanupButton.disabled = true;
    void request({ type: "runtime.reconcile" }).then((response) => {
      cleanupButton.disabled = false;
      if (!response.ok) {
        logSystemLine(`clean up failed: ${response.error.message}`);
        return;
      }
      logSystemLine("cleaned up stale runtimes (reaped gone sandboxes, purged old removed rows)");
      void refreshRuntimes();
    });
  });

  async function refreshRuntimes(): Promise<void> {
    const response = await request({ type: "isolatedRun.listRuntimes", includeRemoved: showRemovedCheckbox.checked });
    if (response.ok && response.payload.type === "isolatedRun.listRuntimes") {
      state.runtimes = response.payload.runtimes;
      renderRuntimes();
      ctx.persist();
    }
  }

  // Live per-sandbox CPU/mem/IO, measured host-side (each sandbox's nerdbox shim
  // process tree) — one cheap snapshot covers every sandbox, so we show them all
  // while the System tab is visible. Ephemeral — not persisted.
  const statsByRuntime = new Map<string, RuntimeStatsSummary>();
  let statsInFlight = false;
  async function pollStats(): Promise<void> {
    if (statsInFlight || state.activeTab !== "system") return;
    statsInFlight = true;
    try {
      const response = await request({ type: "runtime.stats" });
      if (response.ok && response.payload.type === "runtime.stats") {
        statsByRuntime.clear();
        for (const entry of response.payload.stats) statsByRuntime.set(entry.runtimeId, entry);
        renderRuntimes();
      }
    } finally {
      statsInFlight = false;
    }
  }
  // Ticks only while the System tab is visible (a cheap flag check otherwise);
  // the first sample also fires immediately on activation from render().
  window.setInterval(() => void pollStats(), 2_500);

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
    const head = el("div", "runtime-head");
    const status = badge(runtime.status, `status-${runtime.status}`);
    const name = el("span", "runtime-name");
    name.textContent = runtime.externalName;
    head.append(status, name);
    if (runtime.status !== "removed") {
      const stop = button("Stop", "ghost small");
      stop.disabled = ctx.isDemo();
      if (ctx.isDemo()) stop.title = "Demo data does not control runtimes. Switch to Live data to stop this runtime.";
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
      head.append(stop);
    }
    row.append(head);
    // Live host-side resource line for running sandboxes — the "is it actually
    // doing anything?" signal (CPU / memory / I/O), refreshed by the stats poll.
    if (runtime.status === "running") {
      row.append(statsLine(statsByRuntime.get(runtime.runtimeId)));
    }
    return row;
  }

  function statsLine(stats: RuntimeStatsSummary | undefined): HTMLElement {
    const line = el("div", "runtime-stats");
    if (stats === undefined) {
      line.textContent = "measuring…";
      return line;
    }
    if (!stats.available) {
      line.textContent = "stats unavailable";
      return line;
    }
    const parts = [
      `CPU ${stats.cpuPercent === null ? "…" : `${String(Math.round(stats.cpuPercent))}%`}`,
      `mem ${stats.memBytes === null ? "—" : formatBytes(stats.memBytes)}`,
      `IO ↓${formatRate(stats.ioReadBytesPerSec)} ↑${formatRate(stats.ioWriteBytesPerSec)}`
    ];
    if (stats.loadAvg1 !== null) parts.push(`load ${stats.loadAvg1.toFixed(2)}`);
    if (stats.threads !== null) parts.push(`${String(stats.threads)} thr`);
    line.textContent = parts.join("  ·  ");
    return line;
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${String(Math.round(bytes))} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} ${units[unit]}`;
  }

  function formatRate(bytesPerSec: number | null): string {
    if (bytesPerSec === null) return "…";
    if (bytesPerSec < 1) return "0";
    return `${formatBytes(bytesPerSec)}/s`;
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
      systemLogEl.append(diagnosticRow(entry));
    }
    systemLogEl.scrollTop = systemLogEl.scrollHeight;
  }

  function renderChatDiagnostics(): void {
    chatFactsGrid.replaceChildren();
    const session = currentSession(state);
    const iso = state.lastIsolation;
    const rows: [string, string][] = [
      ["session id", session?.sessionId ?? "—"],
      ["provider", session?.providerId ?? "—"],
      ["model", session?.model ?? "—"]
    ];
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
      chatFactsGrid.append(k, v);
    }

    chatDiagnosticsLogEl.replaceChildren();
    if (state.selectedSessionId === null) {
      const empty = el("div", "empty");
      empty.textContent = "No chat selected.";
      chatDiagnosticsLogEl.append(empty);
      return;
    }
    if (state.diagnostics.length === 0) {
      const empty = el("div", "empty");
      empty.textContent = "No diagnostics for the selected chat.";
      chatDiagnosticsLogEl.append(empty);
      return;
    }
    for (const entry of state.diagnostics) {
      chatDiagnosticsLogEl.append(diagnosticRow(entry));
    }
    chatDiagnosticsLogEl.scrollTop = chatDiagnosticsLogEl.scrollHeight;
  }

  function diagnosticRow(entry: DiagnosticEntry): HTMLElement {
    const rowEl = el("div", `diagnostic-row kind-${entry.eventType.replace(/\./g, "-")}`);
    const meta = el("span", "diagnostic-meta");
    meta.textContent = `${formatTime(entry.createdAt)} ${entry.eventType} `;
    const text = el("span", "diagnostic-text");
    text.textContent = entry.summary;
    rowEl.append(meta, text);
    return rowEl;
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
    const security = state.workspacePolicy?.security;
    probeButton.disabled = ctx.isDemo() || security?.networkedAiAllowed !== true;
    probeButton.title = probeButton.disabled
      ? ctx.isDemo()
        ? "Demo data does not contact the app server. Switch to Live data to run this diagnostic."
        : security === undefined
        ? "Loading the workstation security policy…"
        : security.managed
          ? "AI use is not allocated on this workstation."
          : "Enable Drydock › Security: Networked AI Enabled, then reload the window."
      : "Probe the configured app-server backend.";
    cleanupButton.disabled = ctx.isDemo();
    cleanupButton.title = ctx.isDemo()
      ? "Demo data does not inspect or remove runtimes. Switch to Live data to clean up runtime records."
      : "Reap quarantined/lost runtimes whose sandbox is already gone, and purge old removed rows";
    renderRuntimes();
    // Fetch a fresh sample the moment the tab is shown (the interval covers the rest).
    void pollStats();
    renderChatDiagnostics();
    renderLog();
  }

  return { root, render, logSystem, setAvailability, setFooter };
}
