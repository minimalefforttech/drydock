/**
 * Shared baseline-diff opener.
 *
 * Opens VS Code's diff editor with the baseline blob on the left (a read-only
 * virtual doc from the `drydock-baseline` scheme) and the current file on the
 * right (live on disk). A deleted file has no right side, so it opens the
 * baseline doc alone. Both the control panel (Changes list) and the task-review
 * panel drive the same flow, so it lives here once; the task-review panel passes
 * a `viewColumn` so its diffs open Beside the navigator rather than replacing it.
 */

import path from "node:path";
import * as vscode from "vscode";
import { hostPathIdentityKey } from "@drydock/core";
import type { WorkspaceReviewAppService } from "../services/workspaceReviewAppService.js";
import { baselineUri } from "./baselineContentProvider.js";

/**
 * Opens the baseline↔current diff for one changed file. Throws for an unknown
 * baseline so the caller reports it over the error channel. When `viewColumn` is
 * given it is forwarded to the diff/open command (with `preview: true`); omitting
 * it preserves the control panel's original behaviour (no options argument).
 */
export async function openBaselineDiff(
  workspaceReview: WorkspaceReviewAppService,
  baselineId: string,
  relativePath: string,
  viewColumn?: vscode.ViewColumn
): Promise<void> {
  const rootPath = await workspaceReview.baselineRootPath(baselineId);
  if (rootPath === null) {
    throw new Error(`Diff baseline ${baselineId} was not found.`);
  }
  const leftUri = baselineUri(baselineId, relativePath);
  const currentUri = currentFileUri(rootPath, relativePath);
  const title = `${relativePath} (baseline ↔ current)`;
  // A deleted file is absent on disk: fall back to the baseline doc alone
  // rather than diffing against a nonexistent right side.
  if (!(await uriExists(currentUri))) {
    if (viewColumn === undefined) {
      await vscode.commands.executeCommand("vscode.open", leftUri);
    } else {
      await vscode.commands.executeCommand("vscode.open", leftUri, { viewColumn, preview: true });
    }
    return;
  }
  if (viewColumn === undefined) {
    await vscode.commands.executeCommand("vscode.diff", leftUri, currentUri, title);
  } else {
    await vscode.commands.executeCommand("vscode.diff", leftUri, currentUri, title, { viewColumn, preview: true });
  }
}

/**
 * Prefer the spelling of an already-open workspace folder for the live side of
 * a diff. A stored canonical path may be UNC while this window has the same
 * folder open through a mapped drive that VS Code already trusts.
 */
function currentFileUri(rootPath: string, relativePath: string): vscode.Uri {
  // Mirrors SessionDiffService's resolveInsideRoot containment check: relativePath
  // is host-computed today (not reachable via normal UI), but nothing at this
  // call site stopped a forged "..\\..\\.ssh\\id_rsa" from opening as a "diff"
  // before. Checked once, up front, so it covers both branches below.
  const resolvedRoot = path.resolve(rootPath);
  const absolutePath = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, absolutePath);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path ${relativePath} escapes the baseline root.`);
  }
  const rootKey = hostPathIdentityKey(rootPath);
  const openRoot = (vscode.workspace.workspaceFolders ?? []).find((folder) =>
    folder.uri.scheme === "file" && hostPathIdentityKey(folder.uri.fsPath) === rootKey
  );
  if (openRoot !== undefined) {
    const parts = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
    return vscode.Uri.joinPath(openRoot.uri, ...parts);
  }
  return vscode.Uri.file(absolutePath);
}

/** True when a file-scheme URI resolves on disk; used to detect deletes. */
async function uriExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
