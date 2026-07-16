/**
 * Session diff service.
 *
 * Tracks what changed under a root independently of Git: a baseline records
 * path/size/mtime/hash per file with content-addressed blobs for revert, the
 * diff engine detects add/modify/delete plus rename-like add/delete pairs,
 * accept resets one file's baseline, revert restores from the stored blob.
 * Files over the blob cap are tracked as changed but explicitly non-revertable.
 */

import { createHash } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  BaselineId,
  BlobStore,
  DiffBaselineRecord,
  DiffBaselineStore,
  DiffFileChange,
  DiffScope,
  FileBaselineSnapshot,
  SessionId
} from "@drydock/contracts";
import type { Clock } from "./clock.js";
import type { IdGenerator } from "./ids.js";
import { countLineChanges } from "./lineDiff.js";
import type { Logger } from "./logger.js";
import { isPathDenied } from "./mountPolicy.js";

export const DEFAULT_MAX_BLOB_BYTES = 5 * 1024 * 1024;
/** Never snapshotted: VCS internals, dependency trees, product state, and
 * common generated/cache trees that only produce review noise. */
export const DEFAULT_EXCLUDED_NAMES = [
  ".git", "node_modules", ".drydock-owner",
  "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache",
  ".ruff_cache", ".tox", ".DS_Store", "Thumbs.db"
] as const;
/** Generated-artifact file extensions never worth reviewing. */
export const DEFAULT_EXCLUDED_EXTENSIONS = [".pyc", ".pyo"] as const;
/**
 * Files whose mtime falls within this window before their snapshot capture are
 * re-hashed during diff: size+mtime cannot prove they are unchanged when the
 * edit and the snapshot share an mtime tick (Git's "racily clean" problem).
 */
export const RACY_MTIME_WINDOW_MS = 2_000;
/** A NUL byte within this prefix marks a file as binary; its line stats are omitted. */
const BINARY_SNIFF_BYTES = 8_000;

export interface SessionDiffServiceOptions {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly store: DiffBaselineStore;
  readonly blobs: BlobStore;
  /** Files larger than this are tracked without a revert blob. */
  readonly maxBlobBytes?: number;
  readonly excludedNames?: readonly string[];
  readonly deniedPaths?: readonly string[];
  /**
   * Optional gitignore oracle: given a root and candidate root-relative paths
   * (forward slashes), returns the subset the repo ignores. Applied to new
   * baselines AND both sides of every diff, so legacy baselines that already
   * snapshotted ignored churn (.pyc, caches) stop reporting it as changes.
   * Absent or failing → nothing extra is filtered.
   */
  readonly gitIgnoreFilter?: (rootPath: string, relativePaths: readonly string[]) => Promise<ReadonlySet<string>>;
}

interface WalkedFile {
  readonly rootPath: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export class SessionDiffService {
  private readonly maxBlobBytes: number;
  private readonly excludedNames: ReadonlySet<string>;
  private readonly deniedPaths: readonly string[];

  constructor(private readonly options: SessionDiffServiceOptions) {
    this.maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
    this.excludedNames = new Set(options.excludedNames ?? DEFAULT_EXCLUDED_NAMES);
    this.deniedPaths = options.deniedPaths ?? [];
  }

  // MARK: Baselines

  async createBaseline(input: {
    readonly scope: DiffScope;
    readonly rootPath: string;
    readonly sessionId?: SessionId;
  }): Promise<DiffBaselineRecord> {
    // Store the canonical root. An explicitly selected symlinked workspace is
    // supported, but later replacement of that root with a link cannot redirect
    // diff reads or revert writes somewhere else on the host.
    const rootPath = await realpath(path.resolve(input.rootPath));
    const rootStat = await lstat(rootPath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`Diff root is not a real directory: ${input.rootPath}`);
    }
    const files = await this.filterIgnored(rootPath, await this.walk(rootPath));
    const snapshots: FileBaselineSnapshot[] = [];
    for (const file of files) {
      snapshots.push(await this.snapshotFile(file));
    }
    const record: DiffBaselineRecord = {
      baselineId: this.options.ids.baselineId(),
      scope: input.scope,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      rootPath,
      createdAt: this.options.clock.isoNow()
    };
    await this.options.store.insertBaseline(record, snapshots);
    this.options.logger.info("diff baseline created", {
      baselineId: record.baselineId,
      scope: record.scope,
      fileCount: snapshots.length
    });
    return record;
  }

  listBaselines(sessionId?: SessionId): Promise<DiffBaselineRecord[]> {
    return this.options.store.listBaselines(sessionId);
  }

  getBaseline(baselineId: BaselineId): Promise<DiffBaselineRecord | null> {
    return this.options.store.getBaseline(baselineId);
  }

  /**
   * Copies an existing baseline's file snapshots into a new record with the
   * given scope — no tree walk, no hashing, no new blobs (blobs are
   * content-addressed and shared). Backs the session-start and turn scopes,
   * which start life as exact copies of another frame.
   */
  async cloneBaseline(sourceBaselineId: BaselineId, scope: DiffScope): Promise<DiffBaselineRecord> {
    const source = await this.requiredBaseline(sourceBaselineId);
    const snapshots = await this.options.store.listFileSnapshots(sourceBaselineId);
    const record: DiffBaselineRecord = {
      baselineId: this.options.ids.baselineId(),
      scope,
      ...(source.sessionId === undefined ? {} : { sessionId: source.sessionId }),
      rootPath: source.rootPath,
      createdAt: this.options.clock.isoNow()
    };
    await this.options.store.insertBaseline(record, snapshots);
    return record;
  }

  /** Removes a baseline and its snapshot rows; shared content blobs stay. */
  deleteBaseline(baselineId: BaselineId): Promise<void> {
    return this.options.store.deleteBaseline(baselineId);
  }

  /** All file snapshots of a baseline (path-keyed comparisons across frames). */
  listFileSnapshots(baselineId: BaselineId): Promise<FileBaselineSnapshot[]> {
    return this.options.store.listFileSnapshots(baselineId);
  }

  // MARK: Diff engine

  async computeDiff(baselineId: BaselineId): Promise<DiffFileChange[]> {
    const baseline = await this.requiredBaseline(baselineId);
    // BOTH sides pass the junk/gitignore filters: a legacy baseline that
    // snapshotted ignored churn must not report it as deletions, and the live
    // walk must not report it as adds/modifications.
    const snapshots = (await this.options.store.listFileSnapshots(baselineId))
      .filter((snapshot) => !this.isJunkPath(snapshot.path));
    const walked = (await this.walk(baseline.rootPath)).filter((file) => !this.isJunkPath(file.relativePath));
    const ignored = await this.ignoredSet(baseline.rootPath, [
      ...new Set([...walked.map((file) => file.relativePath), ...snapshots.map((snapshot) => snapshot.path)])
    ]);
    const filteredSnapshots = snapshots.filter((snapshot) => !ignored.has(snapshot.path));
    const current = walked.filter((file) => !ignored.has(file.relativePath));
    const baselineByPath = new Map(filteredSnapshots.map((snapshot) => [snapshot.path, snapshot]));
    const currentByPath = new Map(current.map((file) => [file.relativePath, file]));

    const added: { readonly file: WalkedFile; readonly sha256: string }[] = [];
    const changes: DiffFileChange[] = [];

    for (const file of current) {
      const snapshot = baselineByPath.get(file.relativePath);
      if (snapshot === undefined) {
        added.push({ file, sha256: await this.hashCurrentFile(file) });
        continue;
      }
      // Same size and mtime is trusted as unchanged only when the snapshot
      // provably postdates the mtime tick; racy candidates are hashed, and
      // mtime-only touches still do not report as modifications.
      const raciness = file.mtimeMs + RACY_MTIME_WINDOW_MS > snapshot.capturedAtMs;
      if (snapshot.size === file.size && snapshot.mtimeMs === file.mtimeMs && !raciness) {
        continue;
      }
      const currentSha256 = await this.hashCurrentFile(file);
      if (currentSha256 === snapshot.sha256) {
        continue;
      }
      changes.push({
        path: file.relativePath,
        changeKind: "modify",
        baselineSha256: snapshot.sha256,
        currentSha256,
        currentSize: file.size,
        currentMtimeMs: file.mtimeMs,
        ...(await this.modifyLineStats(snapshot, file)),
        ...this.revertability(snapshot)
      });
    }

    const deleted = filteredSnapshots.filter((snapshot) => !currentByPath.has(snapshot.path));
    const pairedAdds = new Set<string>();
    for (const snapshot of deleted) {
      // Rename-like pair: a deleted baseline file whose content reappeared at
      // exactly one new path.
      const match = added.find((candidate) => candidate.sha256 === snapshot.sha256 && !pairedAdds.has(candidate.file.relativePath));
      if (match !== undefined) {
        pairedAdds.add(match.file.relativePath);
        changes.push({
          path: match.file.relativePath,
          changeKind: "rename",
          oldPath: snapshot.path,
          baselineSha256: snapshot.sha256,
          currentSha256: match.sha256,
          currentSize: match.file.size,
          currentMtimeMs: match.file.mtimeMs,
          ...(await this.modifyLineStats(snapshot, match.file)),
          ...this.revertability(snapshot)
        });
        continue;
      }
      changes.push({
        path: snapshot.path,
        changeKind: "delete",
        baselineSha256: snapshot.sha256,
        ...(await this.deleteLineStats(snapshot)),
        ...this.revertability(snapshot)
      });
    }

    for (const { file, sha256 } of added) {
      if (pairedAdds.has(file.relativePath)) {
        continue;
      }
      // Reverting an add is deleting the file; always supported.
      changes.push({
        path: file.relativePath,
        changeKind: "add",
        currentSha256: sha256,
        currentSize: file.size,
        currentMtimeMs: file.mtimeMs,
        ...(await this.addLineStats(file)),
        revertSupported: true
      });
    }

    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }

  // MARK: Accept / revert

  /** Resets only this file's baseline to the current on-disk state. */
  async acceptFile(baselineId: BaselineId, relativePath: string): Promise<void> {
    const baseline = await this.requiredBaseline(baselineId);
    const posixPath = normalizeRelativeFilePath(relativePath);
    const absolutePath = await this.resolveInsideRoot(baseline.rootPath, posixPath);
    const fileStat = await lstatIfExists(absolutePath);
    if (fileStat !== null) {
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        throw new Error(`Path ${relativePath} is not a regular file inside the baseline root.`);
      }
      const snapshot = await this.snapshotFile({
        rootPath: baseline.rootPath,
        relativePath: posixPath,
        absolutePath,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs
      });
      await this.options.store.replaceFileSnapshot(baselineId, snapshot);
    } else {
      await this.options.store.deleteFileSnapshot(baselineId, posixPath);
    }
  }

  /**
   * Restores one file to its baseline state: added files are deleted, modified
   * and deleted files are rewritten from the stored blob. Throws a visible
   * error when the baseline blob was over the cap.
   */
  async revertFile(baselineId: BaselineId, relativePath: string): Promise<void> {
    const baseline = await this.requiredBaseline(baselineId);
    const posixPath = normalizeRelativeFilePath(relativePath);
    const absolutePath = await this.resolveInsideRoot(baseline.rootPath, posixPath);
    const snapshots = await this.options.store.listFileSnapshots(baselineId);
    const snapshot = snapshots.find((candidate) => candidate.path === posixPath);

    if (snapshot === undefined) {
      // Not in the baseline: the file was added during the session.
      await this.resolveInsideRoot(baseline.rootPath, posixPath);
      await rm(absolutePath, { force: true });
      return;
    }
    if (!snapshot.blobStored) {
      throw new Error(`Revert of ${posixPath} is not supported: the baseline file exceeded the ${String(this.maxBlobBytes)}-byte blob cap.`);
    }
    const content = await this.options.blobs.readBlob(snapshot.sha256);
    if (content === null) {
      throw new Error(`Revert of ${posixPath} failed: baseline blob ${snapshot.sha256.slice(0, 12)}… is missing.`);
    }
    await mkdir(path.dirname(absolutePath), { recursive: true });
    // mkdir is intentionally followed by a second check: an existing
    // intermediate link must never turn a restore into an out-of-root write.
    await this.resolveInsideRoot(baseline.rootPath, posixPath);
    await writeFile(absolutePath, content);
  }

  // MARK: Walking and snapshotting

  private async snapshotFile(file: WalkedFile): Promise<FileBaselineSnapshot> {
    const freshFile = await this.validateWalkedFile(file);
    const capturedAtMs = this.options.clock.now().getTime();
    if (freshFile.size > this.maxBlobBytes) {
      await this.validateWalkedFile(freshFile);
      return {
        path: freshFile.relativePath,
        sha256: await hashFile(freshFile.absolutePath),
        size: freshFile.size,
        mtimeMs: freshFile.mtimeMs,
        capturedAtMs,
        blobStored: false
      };
    }
    // The tree walk may have completed well before this individual file is
    // copied into the blob store, so validate again immediately before open.
    await this.validateWalkedFile(freshFile);
    const blob = await this.options.blobs.putFile(freshFile.absolutePath);
    return {
      path: freshFile.relativePath,
      sha256: blob.sha256,
      size: blob.size,
      mtimeMs: freshFile.mtimeMs,
      capturedAtMs,
      blobStored: true
    };
  }

  /** True when any path segment is an excluded name or the file has a generated extension. */
  private isJunkPath(relativePath: string): boolean {
    const segments = relativePath.split("/");
    if (segments.some((segment) => this.excludedNames.has(segment))) return true;
    const leaf = (segments[segments.length - 1] ?? "").toLowerCase();
    return DEFAULT_EXCLUDED_EXTENSIONS.some((extension) => leaf.endsWith(extension));
  }

  /** The gitignore oracle's verdict for `paths`, or an empty set when absent/failing. */
  private async ignoredSet(rootPath: string, paths: readonly string[]): Promise<ReadonlySet<string>> {
    if (this.options.gitIgnoreFilter === undefined || paths.length === 0) return new Set();
    try {
      return await this.options.gitIgnoreFilter(rootPath, paths);
    } catch {
      return new Set();
    }
  }

  /** Applies junk + gitignore filtering to a fresh walk (baseline creation). */
  private async filterIgnored(rootPath: string, files: readonly WalkedFile[]): Promise<WalkedFile[]> {
    const candidates = files.filter((file) => !this.isJunkPath(file.relativePath));
    const ignored = await this.ignoredSet(rootPath, candidates.map((file) => file.relativePath));
    return candidates.filter((file) => !ignored.has(file.relativePath));
  }

  private async walk(rootPath: string): Promise<WalkedFile[]> {
    const resolvedRoot = path.resolve(rootPath);
    const rootStat = await lstat(resolvedRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`Diff root is no longer a real directory: ${rootPath}`);
    }
    const files: WalkedFile[] = [];
    const visit = async (directory: string): Promise<void> => {
      await assertNoSymbolicLinkComponents(resolvedRoot, directory);
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (this.excludedNames.has(entry.name)) {
          continue;
        }
        const absolutePath = path.join(directory, entry.name);
        if (this.deniedPaths.length > 0 && isPathDenied(absolutePath, this.deniedPaths)) {
          continue;
        }
        // Re-check the entry itself instead of trusting the readdir snapshot;
        // this also recognizes Windows junctions through lstat.
        const entryStat = await lstatIfExists(absolutePath);
        if (entryStat === null || entryStat.isSymbolicLink()) {
          continue;
        }
        if (entryStat.isDirectory()) {
          await visit(absolutePath);
          continue;
        }
        if (entryStat.isFile()) {
          files.push({
            rootPath: resolvedRoot,
            relativePath: toPosix(path.relative(rootPath, absolutePath)),
            absolutePath,
            size: entryStat.size,
            mtimeMs: entryStat.mtimeMs
          });
        }
      }
    };
    await visit(resolvedRoot);
    return files;
  }

  private async requiredBaseline(baselineId: BaselineId): Promise<DiffBaselineRecord> {
    const baseline = await this.options.store.getBaseline(baselineId);
    if (baseline === null) {
      throw new Error(`Diff baseline ${baselineId} was not found.`);
    }
    return baseline;
  }

  /** Rejects traversal and link redirection before any filesystem access. */
  private async resolveInsideRoot(rootPath: string, relativePath: string): Promise<string> {
    if (relativePath.split("/").some((segment) => this.excludedNames.has(segment))) {
      throw new Error(`Path ${relativePath} is excluded from diff operations.`);
    }
    const absolutePath = path.resolve(rootPath, relativePath);
    const relative = path.relative(path.resolve(rootPath), absolutePath);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Path ${relativePath} escapes the baseline root.`);
    }
    if (this.deniedPaths.length > 0 && isPathDenied(absolutePath, this.deniedPaths)) {
      throw new Error(`Path ${relativePath} is denied by the active mount policy.`);
    }
    await assertNoSymbolicLinkComponents(path.resolve(rootPath), absolutePath);
    return absolutePath;
  }

  private revertability(snapshot: FileBaselineSnapshot): { readonly revertSupported: boolean; readonly reason?: string } {
    return snapshot.blobStored
      ? { revertSupported: true }
      : { revertSupported: false, reason: "baseline file exceeded the blob size cap" };
  }

  // MARK: Line-diff stats

  /**
   * Baseline text for a file by path, or null when the path is not in the
   * baseline (an added file) or its blob is unreadable as text. Backs the
   * host's baseline↔current diff editor.
   */
  async readBaselineText(baselineId: BaselineId, relativePath: string): Promise<string | null> {
    const posixPath = normalizeRelativeFilePath(relativePath);
    const snapshots = await this.options.store.listFileSnapshots(baselineId);
    const snapshot = snapshots.find((candidate) => candidate.path === posixPath);
    if (snapshot === undefined) {
      return null;
    }
    return this.readBaselineFileText(snapshot);
  }

  /**
   * Baseline text for a snapshot, or null when it cannot be read as text:
   * the blob was never stored (over the cap), it is missing, oversized, or
   * binary. Reused by the diff engine and the host's baseline diff editor.
   */
  async readBaselineFileText(snapshot: FileBaselineSnapshot): Promise<string | null> {
    if (!snapshot.blobStored || snapshot.size > this.maxBlobBytes) {
      return null;
    }
    const blob = await this.options.blobs.readBlob(snapshot.sha256);
    if (blob === null) {
      return null;
    }
    const buffer = Buffer.from(blob);
    return isBinary(buffer) ? null : buffer.toString("utf8");
  }

  /** Current on-disk text, or null when oversized or binary. */
  private async readCurrentFileText(file: WalkedFile): Promise<string | null> {
    const freshFile = await this.validateWalkedFile(file);
    if (freshFile.size > this.maxBlobBytes) return null;
    const buffer = await readFile(freshFile.absolutePath);
    return isBinary(buffer) ? null : buffer.toString("utf8");
  }

  private async hashCurrentFile(file: WalkedFile): Promise<string> {
    const freshFile = await this.validateWalkedFile(file);
    return hashFile(freshFile.absolutePath);
  }

  /** Revalidates an earlier walk result immediately before opening the file. */
  private async validateWalkedFile(file: WalkedFile): Promise<WalkedFile> {
    const absolutePath = await this.resolveInsideRoot(file.rootPath, file.relativePath);
    if (path.relative(absolutePath, file.absolutePath) !== "") {
      throw new Error(`Diff path changed while it was being inspected: ${file.relativePath}`);
    }
    const info = await lstat(absolutePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Diff path is no longer a regular file: ${file.relativePath}`);
    }
    return {
      rootPath: file.rootPath,
      relativePath: file.relativePath,
      absolutePath,
      size: info.size,
      mtimeMs: info.mtimeMs
    };
  }

  /** modify/rename: full line diff, omitted when either side is unavailable as text. */
  private async modifyLineStats(snapshot: FileBaselineSnapshot, file: WalkedFile): Promise<LineStats> {
    const [baselineText, currentText] = await Promise.all([
      this.readBaselineFileText(snapshot),
      this.readCurrentFileText(file)
    ]);
    if (baselineText === null || currentText === null) {
      return {};
    }
    const counts = countLineChanges(baselineText, currentText);
    return { addedLines: counts.added, removedLines: counts.removed };
  }

  /** add: every current line is added; only the current file is read. */
  private async addLineStats(file: WalkedFile): Promise<LineStats> {
    const currentText = await this.readCurrentFileText(file);
    if (currentText === null) {
      return {};
    }
    return { addedLines: countLineChanges("", currentText).added, removedLines: 0 };
  }

  /** delete: every baseline line is removed; only the baseline blob is read. */
  private async deleteLineStats(snapshot: FileBaselineSnapshot): Promise<LineStats> {
    const baselineText = await this.readBaselineFileText(snapshot);
    if (baselineText === null) {
      return {};
    }
    return { addedLines: 0, removedLines: countLineChanges(baselineText, "").removed };
  }
}

type LineStats = { readonly addedLines?: number; readonly removedLines?: number };

/** Treats a NUL byte in the sniff prefix as the binary signal (Git's heuristic). */
function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

/** A diff file key is portable relative syntax, never a host absolute path. */
function normalizeRelativeFilePath(value: string): string {
  if (value.includes("\0")) {
    throw new Error("Diff path contains an invalid NUL character.");
  }
  const posix = toPosix(value);
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) {
    throw new Error(`Diff path must be relative: ${value}`);
  }
  const normalized = path.posix.normalize(posix);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Path ${value} escapes the baseline root.`);
  }
  return normalized;
}

async function lstatIfExists(filePath: string): Promise<Stats | null> {
  try {
    return await lstat(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return null;
    }
    throw error;
  }
}

/**
 * Refuses any existing symlink/junction between an owned root and a target.
 * Missing suffixes are allowed so callers can safely create a new file after
 * validating every existing parent.
 */
async function assertNoSymbolicLinkComponents(rootPath: string, targetPath: string): Promise<void> {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path ${targetPath} escapes the baseline root.`);
  }

  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Diff root is no longer a real directory: ${rootPath}`);
  }

  if (relative === "") return;
  const components = relative.split(path.sep).filter((component) => component.length > 0);
  let current = root;
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index] as string);
    const info = await lstatIfExists(current);
    if (info === null) return;
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing path through symbolic link or junction: ${current}`);
    }
    if (index < components.length - 1 && !info.isDirectory()) {
      throw new Error(`Path component is not a directory: ${current}`);
    }
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: string | Buffer) => {
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}
