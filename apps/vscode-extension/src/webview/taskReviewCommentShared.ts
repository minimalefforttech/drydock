/**
 * Pure helpers for the Task Review Comments-API surface.
 *
 * This module owns the two conversions the gutter integration must get exactly
 * right, and it deliberately imports NO `vscode` so it stays unit-testable
 * (planDocsShared.ts is the precedent for a no-vscode module under webview/):
 *
 *  - The `<repo>:<path>` comment anchor and its matching rule, which MUST mirror
 *    taskReviewAppService.countFileComments (qualified form OR legacy plain
 *    relative path) so gutter threads and the panel's per-file counts agree.
 *  - The 1-based (stored) ↔ 0-based (vscode.Range) line-number conversion, kept
 *    here and centralized so the off-by-one lives in one tested place.
 *
 * GUTTER_VISIBLE_STATUSES fixes which thread statuses materialize in the gutter:
 * terminal `resolved` / `wont-fix` threads are intentionally not rendered.
 */

import type { ReviewThreadStatus } from "@drydock/contracts";

/** The qualified comment anchor for a file: `<repo>:<path>` (repo = root basename). */
export function commentAnchor(repo: string, relativePath: string): string {
  return `${repo}:${relativePath}`;
}

/**
 * True when a stored comment's filePath anchors to this file — either the
 * qualified `<repo>:<path>` form (task-review convention) or the legacy plain
 * `<path>` form (Changes → Comments). Mirrors
 * taskReviewAppService.countFileComments exactly so gutter threads and per-file
 * badges never disagree.
 */
export function anchorMatchesFile(commentFilePath: string, repo: string, relativePath: string): boolean {
  return commentFilePath === commentAnchor(repo, relativePath) || commentFilePath === relativePath;
}

/**
 * Stored 1-based inclusive lines → 0-based line indices for a vscode.Range.
 * Clamped at 0 so a defensive `0`/negative stored value never yields a negative
 * range line.
 */
export function storedLinesToRange(startLine: number, endLine: number): { startLine0: number; endLine0: number } {
  return {
    startLine0: Math.max(0, startLine - 1),
    endLine0: Math.max(0, endLine - 1)
  };
}

/**
 * 0-based range line indices → stored 1-based inclusive lines, normalized so
 * startLine ≤ endLine (a gutter selection dragged upward arrives reversed).
 */
export function rangeToStoredLines(startLine0: number, endLine0: number): { startLine: number; endLine: number } {
  const a = startLine0 + 1;
  const b = endLine0 + 1;
  return {
    startLine: Math.min(a, b),
    endLine: Math.max(a, b)
  };
}

/**
 * Thread statuses that materialize as gutter threads. Terminal `resolved` /
 * `wont-fix` threads do not appear — the gutter shows only still-actionable
 * review state.
 */
export const GUTTER_VISIBLE_STATUSES: readonly ReviewThreadStatus[] = [
  "open",
  "acknowledged",
  "delegated",
  "blocked"
];
