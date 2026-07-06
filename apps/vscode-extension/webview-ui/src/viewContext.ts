/**
 * Shared context wiring the three tab views together without circular imports.
 *
 * main.ts constructs the context (state + cross-view callbacks) and hands it to
 * each view's `create*Tab` factory. Views call these callbacks to cross tab
 * boundaries (e.g. a Work card selecting a session and jumping to Chat).
 *
 * SECURITY: no rendering happens here; views render dynamic strings via
 * textContent only (never innerHTML).
 */

import type { AppState, DiagnosticEntry, TabId } from "./state.js";

export interface ChatTabView {
  readonly root: HTMLElement;
  /** Re-renders the whole Chat tab from current state. */
  render(): void;
  /** Selects a session (loads timeline/diff/review) and renders. */
  selectSession(sessionId: string | null): void;
  /** Resets to the new-chat state (used after deleting the selected session). */
  resetToNewChat(): void;
  /** Appends a line to the per-session chat diagnostics feed. */
  logChat(summary: string): void;
}

export interface WorkTabView {
  readonly root: HTMLElement;
  render(): void;
  /** Refetches pending access requests + sessions on tab activation. */
  refresh(): void;
  /** Re-renders just the "needs attention" access-request cards from state. */
  renderAttention(): void;
}

export interface SystemTabView {
  readonly root: HTMLElement;
  render(): void;
  /** Appends a line to the global (non-session) event log. */
  logSystem(entry: DiagnosticEntry): void;
  /** Renders the backend availability banner + disables controls when down. */
  setAvailability(available: boolean, reason?: string): void;
  /** Fills the footer facts (state root, sbx path) from panel.init. */
  setFooter(stateRootDisplayPath: string, sbxDisplayPath?: string): void;
}

/** Callbacks a view may invoke; assigned by main.ts once all views exist. */
export interface PanelBridge {
  switchTab(tab: TabId): void;
  chat: ChatTabView;
  work: WorkTabView;
  system: SystemTabView;
}

export interface ViewContext {
  readonly state: AppState;
  /** Persist current state (debounce-free; setState is cheap). */
  persist(): void;
  /** Lazily-resolved bridge to sibling views (set after all are built). */
  readonly bridge: PanelBridge;
}
