/**
 * Shared "does this panel follow the active task?" rule (UX overhaul, P3).
 *
 * Selecting a task moves the whole bench: the hub retargets in place, and the
 * Planner and Task Review panels follow it. The escape hatch is the native one
 * users already know - PIN THE TAB. A pinned panel is a deliberate "keep this
 * where it is", so the follow is skipped and nothing is yanked mid-read.
 *
 * VS Code prefixes an extension webview's tab `viewType` (today
 * `mainThreadWebview-<viewType>`), so the match is a suffix, never equality on
 * the raw string. Everything here is defensive: a tab-model surprise must never
 * take a panel down, so an unreadable tab model reads as "not pinned, do not
 * follow" - the conservative answer.
 */

import * as vscode from "vscode";

/**
 * True when a tab for this webview viewType (optionally narrowed to one tab
 * label, for per-task panels) is pinned. Unknown/unreadable → false.
 */
export function isPanelTabPinned(viewType: string, label?: string): boolean {
  try {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (label !== undefined && tab.label !== label) continue;
        const input: unknown = tab.input;
        if (typeof input !== "object" || input === null) continue;
        const candidate = (input as { readonly viewType?: unknown }).viewType;
        if (typeof candidate !== "string") continue;
        if (candidate === viewType || candidate.endsWith(`-${viewType}`)) {
          return tab.isPinned;
        }
      }
    }
  } catch {
    // The tab model is stable API, but a follow decision is never worth a throw.
  }
  return false;
}

/** A panel follows the spine unless the user pinned its tab. */
export function panelFollowsActiveTask(viewType: string, label?: string): boolean {
  return !isPanelTabPinned(viewType, label);
}
