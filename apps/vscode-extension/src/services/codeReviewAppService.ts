/**
 * Code Review panel application facade (in-panel PR-style review -
 * docs/design/code-review-panel.md).
 *
 * Same data spine as the v1 task review: the task/session scopes project the
 * TaskReviewAppService aggregation; the only new capability is serving DIFF
 * CONTENT (hunk rows, image data URIs, byte sizes) to the webview, computed
 * host-side from baseline text + the live tree - or, for the uncommitted
 * scope, from `git` against HEAD in each project root. Notes (one body, many
 * anchors) store one ReviewCommentRecord per anchor through the existing
 * guarded addComment path, so v1 submit semantics send them verbatim.
 *
 * No `vscode` imports here; the panel provider passes window facts (open
 * folder roots) in. Git use is status/diff/show only - no network transports.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  CodeReviewAnchor,
  CodeReviewFile,
  CodeReviewPanelState,
  CodeReviewScope,
  DiffChangeKind,
  ReviewCommentSummary,
  ReviewDiffHunk,
  ReviewDiffRow,
  ReviewFileDiff,
  TaskReviewSessionRef,
  TaskReviewState
} from "@drydock/contracts";
import type { Logger } from "@drydock/core";

/** v1 aggregation port; TaskReviewAppService satisfies this structurally. */
export interface CodeReviewTaskPort {
  computeState(taskId: string): Promise<TaskReviewState>;
}

/** Baseline/content + comment port; WorkspaceReviewAppService satisfies this. */
export interface CodeReviewDiffPort {
  readBaselineFileText(baselineId: string, filePath: string): Promise<string | null>;
  baselineRootPath(baselineId: string): Promise<string | null>;
  reviewState(sessionId?: string): Promise<{ reviewSessionId: string; comments: ReviewCommentSummary[] }>;
  addComment(input: {
    sessionId?: string;
    filePath: string;
    startLine: number;
    endLine: number;
    body: string;
  }): Promise<ReviewCommentSummary>;
}

export interface CodeReviewAppServiceOptions {
  readonly logger: Logger;
  readonly taskReview: CodeReviewTaskPort;
  readonly diffs: CodeReviewDiffPort;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico"]);
const IMAGE_DATA_URI_CAP = 1_500_000;
const TEXT_SIZE_CAP = 2_000_000;
const MAX_DIFF_LINES = 20_000;
const MAX_ROWS = 5_000;
const LARGE_DIFF_LINES = 400;
const GENERATED_PATTERNS = [/(^|\/)package-lock\.json$/, /(^|\/)yarn\.lock$/, /(^|\/)pnpm-lock\.yaml$/, /\.min\.(js|css)$/, /(^|\/)dist\//];
const CONTEXT_LINES = 3;

function runGit(root: string, args: readonly string[]): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile("git", [...args], { cwd: root, maxBuffer: 32 * 1024 * 1024, encoding: "buffer" }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

function isImagePath(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function looksBinary(bytes: Buffer): boolean {
  const probe = bytes.subarray(0, 8000);
  return probe.includes(0);
}

function isGenerated(filePath: string): boolean {
  return GENERATED_PATTERNS.some((pattern) => pattern.test(filePath));
}

function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".ico") return "image/x-icon";
  return `image/${ext.slice(1)}`;
}

export class CodeReviewAppService {
  constructor(private readonly options: CodeReviewAppServiceOptions) {}

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /**
   * Aggregated panel state for one task+scope. `openFolderRoots` are this
   * window's file-scheme workspace folders - the uncommitted scope diffs them
   * against HEAD; the other scopes ignore them.
   */
  async computeState(taskId: string, scope: CodeReviewScope, openFolderRoots: readonly string[]): Promise<CodeReviewPanelState> {
    const base = await this.options.taskReview.computeState(taskId);
    const primary = this.primarySession(base);
    if (scope === "uncommitted") {
      return this.computeUncommittedState(taskId, base, primary, openFolderRoots);
    }
    const projects = base.projects
      .map((project) => ({
        name: project.name,
        files: project.files
          .filter((file) => scope === "task" || file.sessionId === primary?.sessionId)
          .map((file): CodeReviewFile => {
            const stats = file.addedLines !== undefined || file.removedLines !== undefined;
            const contentKind: CodeReviewFile["contentKind"] = isImagePath(file.path) ? "image" : stats ? "text" : "binary";
            const changed = (file.addedLines ?? 0) + (file.removedLines ?? 0);
            return {
              repo: file.repo,
              path: file.path,
              changeKind: file.changeKind,
              ...(file.addedLines === undefined ? {} : { addedLines: file.addedLines }),
              ...(file.removedLines === undefined ? {} : { removedLines: file.removedLines }),
              contentKind,
              commentCount: file.commentCount,
              sessionId: file.sessionId,
              sessionTitle: file.sessionTitle,
              ...(file.baselineId === undefined ? {} : { baselineId: file.baselineId }),
              ...(file.clone === undefined ? {} : { clone: file.clone }),
              ...(file.conflicted === undefined ? {} : { conflicted: file.conflicted }),
              ...(changed > LARGE_DIFF_LINES || isGenerated(file.path) ? { largeDiff: true } : {})
            };
          })
      }))
      .filter((project) => project.files.length > 0);
    return {
      taskId,
      title: base.title,
      scope,
      projects,
      openCommentCount: base.openCommentCount,
      ...(primary === undefined ? {} : { primarySession: primary }),
      ...(base.revisionInFlight === undefined ? {} : { revisionInFlight: base.revisionInFlight }),
      ...(base.notes === undefined ? {} : { notes: base.notes })
    };
  }

  /** Most recently linked session with changed files, else the first linked session. */
  private primarySession(base: TaskReviewState): TaskReviewSessionRef | undefined {
    const withFiles = new Set<string>();
    for (const project of base.projects) {
      for (const file of project.files) withFiles.add(file.sessionId);
    }
    return base.sessions.find((session) => withFiles.has(session.sessionId)) ?? base.sessions[0];
  }

  /** git working tree + index vs HEAD across the window's project roots. */
  private async computeUncommittedState(
    taskId: string,
    base: TaskReviewState,
    primary: TaskReviewSessionRef | undefined,
    roots: readonly string[]
  ): Promise<CodeReviewPanelState> {
    const notes: string[] = [];
    const projects: { name: string; files: CodeReviewFile[] }[] = [];
    // Open comments join by the `<repo>:<path>` anchor across linked sessions.
    const commentCounts = new Map<string, number>();
    for (const session of base.sessions) {
      const review = await this.options.diffs.reviewState(session.sessionId);
      for (const comment of review.comments) {
        if (comment.status !== "open" || comment.filePath.startsWith("plan:")) continue;
        commentCounts.set(comment.filePath, (commentCounts.get(comment.filePath) ?? 0) + 1);
      }
    }
    for (const root of roots) {
      const repo = path.basename(root);
      const status = await runGit(root, ["status", "--porcelain=v1", "-z"]);
      if (status === null) {
        notes.push(`${repo}: not a git repository (or git failed) - skipped in the uncommitted scope.`);
        continue;
      }
      const stats = await this.numstat(root);
      const files: CodeReviewFile[] = [];
      for (const entry of status.toString("utf8").split("\0")) {
        if (entry.length < 4) continue;
        const xy = entry.slice(0, 2);
        const filePath = entry.slice(3).replace(/\\/g, "/");
        if (filePath.length === 0) continue;
        const changeKind: DiffChangeKind = xy.includes("A") || xy === "??"
          ? "add"
          : xy.includes("D") ? "delete" : xy.includes("R") ? "rename" : "modify";
        const stat = stats.get(filePath);
        let added = stat?.added;
        let removed = stat?.removed;
        let contentKind: CodeReviewFile["contentKind"] = isImagePath(filePath) ? "image" : "text";
        let bytesAfter: number | undefined;
        const absolute = path.join(root, filePath);
        if (xy === "??" && contentKind === "text") {
          // Untracked file: numstat does not cover it; count its lines directly.
          try {
            const bytes = await fs.readFile(absolute);
            if (looksBinary(bytes)) {
              contentKind = "binary";
              bytesAfter = bytes.length;
            } else {
              added = bytes.toString("utf8").split("\n").length;
              removed = 0;
            }
          } catch {
            notes.push(`${repo}/${filePath}: unreadable - stats unavailable.`);
          }
        }
        if (stat?.binary === true && contentKind === "text") contentKind = "binary";
        const changed = (added ?? 0) + (removed ?? 0);
        const key = `${repo}:${filePath}`;
        files.push({
          repo,
          path: filePath,
          changeKind,
          ...(added === undefined ? {} : { addedLines: added }),
          ...(removed === undefined ? {} : { removedLines: removed }),
          contentKind,
          ...(bytesAfter === undefined ? {} : { bytesAfter }),
          commentCount: commentCounts.get(key) ?? 0,
          ...(changed > LARGE_DIFF_LINES || isGenerated(filePath) ? { largeDiff: true } : {})
        });
      }
      files.sort((a, b) => a.path.localeCompare(b.path));
      if (files.length > 0) projects.push({ name: repo, files });
    }
    return {
      taskId,
      title: base.title,
      scope: "uncommitted",
      projects,
      openCommentCount: base.openCommentCount,
      ...(primary === undefined ? {} : { primarySession: primary }),
      ...(base.revisionInFlight === undefined ? {} : { revisionInFlight: base.revisionInFlight }),
      ...(notes.length === 0 ? {} : { notes })
    };
  }

  private async numstat(root: string): Promise<Map<string, { added?: number; removed?: number; binary?: boolean }>> {
    const out = await runGit(root, ["diff", "HEAD", "--numstat", "-z"]);
    const map = new Map<string, { added?: number; removed?: number; binary?: boolean }>();
    if (out === null) return map;
    // -z numstat entries: "added\tremoved\tpath\0" (renames add a second NUL field).
    const fields = out.toString("utf8").split("\0").filter((field) => field.length > 0);
    for (const field of fields) {
      const parts = field.split("\t");
      if (parts.length < 3) continue;
      const [addedRaw, removedRaw, filePath] = parts as [string, string, string];
      if (addedRaw === "-" || removedRaw === "-") {
        map.set(filePath.replace(/\\/g, "/"), { binary: true });
      } else {
        map.set(filePath.replace(/\\/g, "/"), { added: Number(addedRaw), removed: Number(removedRaw) });
      }
    }
    return map;
  }

  // -------------------------------------------------------------------------
  // File diff content
  // -------------------------------------------------------------------------

  async fileDiff(input: {
    scope: CodeReviewScope;
    repo: string;
    path: string;
    baselineId?: string;
    ignoreWhitespace?: boolean;
    openFolderRoots: readonly string[];
  }): Promise<ReviewFileDiff> {
    const sides = input.scope === "uncommitted"
      ? await this.uncommittedSides(input.repo, input.path, input.openFolderRoots)
      : await this.baselineSides(input.baselineId, input.path);
    if (sides.kind === "oversized") return sides.diff;

    if (isImagePath(input.path)) {
      const toUri = (bytes: Buffer | null): string | undefined =>
        bytes !== null && bytes.length > 0 && bytes.length <= IMAGE_DATA_URI_CAP
          ? `data:${mimeFor(input.path)};base64,${bytes.toString("base64")}`
          : undefined;
      const before = toUri(sides.oldBytes);
      const after = toUri(sides.newBytes);
      return {
        kind: "image",
        ...(before === undefined ? {} : { beforeDataUri: before }),
        ...(after === undefined ? {} : { afterDataUri: after }),
        ...(sides.oldBytes === null ? {} : { bytesBefore: sides.oldBytes.length }),
        ...(sides.newBytes === null ? {} : { bytesAfter: sides.newBytes.length })
      };
    }
    if ((sides.oldBytes !== null && looksBinary(sides.oldBytes)) || (sides.newBytes !== null && looksBinary(sides.newBytes))) {
      return {
        kind: "binary",
        ...(sides.oldBytes === null ? {} : { bytesBefore: sides.oldBytes.length }),
        ...(sides.newBytes === null ? {} : { bytesAfter: sides.newBytes.length })
      };
    }
    const oldText = sides.oldBytes === null ? "" : sides.oldBytes.toString("utf8");
    const newText = sides.newBytes === null ? "" : sides.newBytes.toString("utf8");
    return computeTextDiff(oldText, newText, input.ignoreWhitespace === true);
  }

  private async baselineSides(baselineId: string | undefined, filePath: string): Promise<
    { kind: "ok"; oldBytes: Buffer | null; newBytes: Buffer | null } | { kind: "oversized"; diff: ReviewFileDiff }
  > {
    if (baselineId === undefined) {
      return { kind: "oversized", diff: { kind: "oversized", reason: "No baseline backs this file (clone or stale entry) - open it in the owning session." } };
    }
    const oldText = await this.options.diffs.readBaselineFileText(baselineId, filePath);
    const root = await this.options.diffs.baselineRootPath(baselineId);
    let newBytes: Buffer | null = null;
    if (root !== null) {
      try {
        newBytes = await fs.readFile(path.join(root, filePath));
      } catch {
        newBytes = null; // deleted on disk
      }
    }
    if (newBytes !== null && newBytes.length > TEXT_SIZE_CAP && !isImagePath(filePath)) {
      return { kind: "oversized", diff: { kind: "oversized", reason: "File exceeds the in-panel diff size cap - open it in the editor." } };
    }
    // Baseline blobs surface as text; image bytes for the before side are a
    // recorded fast-follow (blob byte access) - the after side renders today.
    const oldBytes = oldText === null ? null : Buffer.from(oldText, "utf8");
    return { kind: "ok", oldBytes: isImagePath(filePath) ? null : oldBytes, newBytes };
  }

  private async uncommittedSides(repo: string, filePath: string, roots: readonly string[]): Promise<
    { kind: "ok"; oldBytes: Buffer | null; newBytes: Buffer | null } | { kind: "oversized"; diff: ReviewFileDiff }
  > {
    const root = roots.find((candidate) => path.basename(candidate) === repo);
    if (root === undefined) {
      return { kind: "oversized", diff: { kind: "oversized", reason: `Project root "${repo}" is not open in this window.` } };
    }
    const oldBytes = await runGit(root, ["show", `HEAD:${filePath}`]);
    let newBytes: Buffer | null = null;
    try {
      newBytes = await fs.readFile(path.join(root, filePath));
    } catch {
      newBytes = null;
    }
    if (newBytes !== null && newBytes.length > TEXT_SIZE_CAP && !isImagePath(filePath)) {
      return { kind: "oversized", diff: { kind: "oversized", reason: "File exceeds the in-panel diff size cap - open it in the editor." } };
    }
    return { kind: "ok", oldBytes, newBytes };
  }

  // -------------------------------------------------------------------------
  // Notes (one body, many anchors → one comment record per anchor)
  // -------------------------------------------------------------------------

  async addNote(taskId: string, body: string, anchors: readonly CodeReviewAnchor[]): Promise<ReviewCommentSummary[]> {
    const base = await this.options.taskReview.computeState(taskId);
    const primary = this.primarySession(base);
    const linked = new Set(base.sessions.map((session) => session.sessionId));
    const comments: ReviewCommentSummary[] = [];
    for (const anchor of anchors) {
      // Anchor owners must be sessions the task links; anything else falls back
      // to the primary session rather than widening reach.
      const owner = anchor.sessionId !== undefined && linked.has(anchor.sessionId)
        ? anchor.sessionId
        : primary?.sessionId;
      if (owner === undefined) {
        throw new Error("This task has no linked session to receive review comments.");
      }
      comments.push(await this.options.diffs.addComment({
        sessionId: owner,
        filePath: `${anchor.repo}:${anchor.path}`,
        startLine: anchor.startLine,
        endLine: anchor.endLine,
        body
      }));
    }
    this.options.logger.info("code review note added", { taskId, anchors: anchors.length });
    return comments;
  }
}

// ---------------------------------------------------------------------------
// Text diff (Myers O(ND) on lines, bounded; whitespace-insensitive compare mode)
// ---------------------------------------------------------------------------

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  // A trailing newline yields one phantom empty tail line; drop it so line
  // counts match what editors show.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function normalizeWs(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

/** Edit script entries: 0 = keep, -1 = delete (old), 1 = insert (new). */
function myersDiff(oldLines: readonly string[], newLines: readonly string[]): number[] | null {
  const n = oldLines.length;
  const m = newLines.length;
  const max = n + m;
  const dCap = Math.min(max, 4000);
  const offset = dCap;
  const v = new Int32Array(2 * dCap + 1);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= dCap; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))) {
        x = v[offset + k + 1] as number;
      } else {
        x = (v[offset + k - 1] as number) + 1;
      }
      let y = x - k;
      while (x < n && y < m && oldLines[x] === newLines[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        // Backtrack into the edit script.
        const script: number[] = [];
        let px = x;
        let py = y;
        for (let depth = d; depth > 0; depth -= 1) {
          const prev = trace[depth] as Int32Array;
          const pk = px - py;
          let prevK: number;
          if (pk === -depth || (pk !== depth && (prev[offset + pk - 1] as number) < (prev[offset + pk + 1] as number))) {
            prevK = pk + 1;
          } else {
            prevK = pk - 1;
          }
          const prevX = prev[offset + prevK] as number;
          const prevY = prevX - prevK;
          while (px > prevX && py > prevY) {
            script.push(0);
            px -= 1;
            py -= 1;
          }
          if (px === prevX) {
            script.push(1);
            py -= 1;
          } else {
            script.push(-1);
            px -= 1;
          }
        }
        while (px > 0 && py > 0) {
          script.push(0);
          px -= 1;
          py -= 1;
        }
        while (px > 0) { script.push(-1); px -= 1; }
        while (py > 0) { script.push(1); py -= 1; }
        script.reverse();
        return script;
      }
    }
  }
  return null; // too divergent for the d-cap - caller degrades to replace-all
}

export function computeTextDiff(oldText: string, newText: string, ignoreWhitespace: boolean): ReviewFileDiff {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES) {
    return { kind: "oversized", reason: "File exceeds the in-panel diff line cap - open it in the editor." };
  }
  const oldKeys = ignoreWhitespace ? oldLines.map(normalizeWs) : oldLines;
  const newKeys = ignoreWhitespace ? newLines.map(normalizeWs) : newLines;
  let script = myersDiff(oldKeys, newKeys);
  if (script === null) {
    script = [...oldLines.map(() => -1), ...newLines.map(() => 1)];
  }

  // Script → rows with line numbers.
  const rows: ReviewDiffRow[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (const op of script) {
    if (op === 0) {
      rows.push({ kind: "context", oldNo, newNo, text: newLines[newNo - 1] ?? "" });
      oldNo += 1;
      newNo += 1;
    } else if (op === -1) {
      rows.push({ kind: "del", oldNo, text: oldLines[oldNo - 1] ?? "" });
      oldNo += 1;
    } else {
      rows.push({ kind: "add", newNo, text: newLines[newNo - 1] ?? "" });
      newNo += 1;
    }
  }

  // Rows → hunks with CONTEXT_LINES of context, gaps collapsed.
  const changed = rows.map((row) => row.kind !== "context");
  const keep = new Array<boolean>(rows.length).fill(false);
  for (let i = 0; i < rows.length; i += 1) {
    if (!(changed[i] ?? false)) continue;
    for (let j = Math.max(0, i - CONTEXT_LINES); j <= Math.min(rows.length - 1, i + CONTEXT_LINES); j += 1) {
      keep[j] = true;
    }
  }
  const hunks: ReviewDiffHunk[] = [];
  let current: ReviewDiffRow[] = [];
  let truncated = false;
  let emitted = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    const first = current[0] as ReviewDiffRow;
    const oldStart = first.oldNo ?? Math.max(1, (first.newNo ?? 1));
    const newStart = first.newNo ?? Math.max(1, (first.oldNo ?? 1));
    hunks.push({
      oldStart,
      oldLines: current.filter((row) => row.kind !== "add").length,
      newStart,
      newLines: current.filter((row) => row.kind !== "del").length,
      rows: current
    });
    current = [];
  };
  for (let i = 0; i < rows.length; i += 1) {
    if (!(keep[i] ?? false)) {
      flush();
      continue;
    }
    if (emitted >= MAX_ROWS) {
      truncated = true;
      break;
    }
    current.push(rows[i] as ReviewDiffRow);
    emitted += 1;
  }
  flush();
  return { kind: "text", hunks, ...(truncated ? { truncated: true } : {}) };
}
