/**
 * Shared context handed to the chat view by whichever webview hosts it.
 *
 * The Control Panel's four tabs retired with ADR 0020, and with them the
 * cross-tab bridge this file used to describe. What survives is the seam the
 * chat genuinely needs: its own state, and two callbacks back to its host - one
 * for "the user asked to leave this chat", one for "shared state moved under
 * you, refresh your own chrome". `chatRail.ts` is the only host today.
 *
 * SECURITY: no rendering happens here; views render dynamic strings via
 * textContent only (never innerHTML).
 */

import type { AppState } from "./state.js";

export interface ChatTabView {
  readonly root: HTMLElement;
  /** Re-renders the whole chat from current state. */
  render(): void;
  /** Selects a session (loads timeline/diff/review) and renders. */
  selectSession(sessionId: string | null): void;
  /**
   * Shows (or clears) a transient "Starting the chat backend…" placeholder in
   * place of the transcript, for callers that reach the chat before a session
   * exists yet. Cleared automatically by the next `selectSession` call, or pass
   * `false` to clear early (e.g. on failure).
   */
  showStarting(active: boolean): void;
  /** Resets to the new-chat state (used after deleting the selected session). */
  resetToNewChat(): void;
  /** Appends a line to the per-session chat diagnostics feed. */
  logChat(summary: string): void;
}

/** Callbacks the chat may invoke on its host; assigned once the chat exists. */
export interface PanelBridge {
  /**
   * The back chevron: the user is done reading this chat and wants the task it
   * belongs to. The host decides what that means (the rail follows the owning
   * task on the active-task spine).
   */
  focusOwningTask(): void;
  /**
   * Shared state the chat mutated (tasks, links, attention) changed. The host
   * re-renders whatever chrome it draws around the chat.
   */
  hostChanged(): void;
}

export interface ViewContext {
  readonly state: AppState;
  /** True while guide fixtures are replacing all host-backed data/actions. */
  isDemo(): boolean;
  /** Persist current state (debounce-free; setState is cheap). */
  persist(): void;
  /** Lazily-resolved bridge to the host (set after the chat is built). */
  readonly bridge: PanelBridge;
}
