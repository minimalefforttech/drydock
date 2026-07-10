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
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
/** Never snapshotted: VCS internals, dependency trees, product state. */
export const DEFAULT_EXCLUDED_NAMES = [".git", "node_modules", ".drydock-owner"] as const;
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
}

interface WalkedFile {
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
    const rootPath = path.resolve(input.rootPath);
    const files = await this.walk(rootPath);
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
    const snapshots = await this.options.store.listFileSnapshots(baselineId);
    const baselineByPath = new Map(snapshots.map((snapshot) => [snapshot.path, snapshot]));
    const current = await this.walk(baseline.rootPath);
    const currentByPath = new Map(current.map((file) => [file.relativePath, file]));

    const added: { readonly file: WalkedFile; readonly sha256: string }[] = [];
    const changes: DiffFileChange[] = [];

    for (const file of current) {
      const snapshot = baselineByPath.get(file.relativePath);
      if (snapshot === undefined) {
        added.push({ file, sha256: await hashFile(file.absolutePath) });
        continue;
      }
      // Same size and mtime is trusted as unchanged only when the snapshot
      // provably postdates the mtime tick; racy candidates are hashed, and
      // mtime-only touches still do not report as modifications.
      const raciness = file.mtimeMs + RACY_MTIME_WINDOW_MS > snapshot.capturedAtMs;
      if (snapshot.size === file.size && snapshot.mtimeMs === file.mtimeMs && !raciness) {
        continue;
      }
      const currentSha256 = await hashFile(file.absolutePath);
      if (currentSha256 === snapshot.sha256) {
        continue;
      }
      changes.push({
        path: file.relativePath,
        changeKind: "modify",
        baselineSha256: snapshot.sha256,
        currentSha256,
        currentSize: file.size,
        ...(await this.modifyLineStats(snapshot, file)),
        ...this.revertability(snapshot)
      });
    }

    const deleted = snapshots.filter((snapshot) => !currentByPath.has(snapshot.path));
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
    const absolutePath = this.resolveInsideRoot(baseline.rootPath, relativePath);
    if (await exists(absolutePath)) {
      const fileStat = await stat(absolutePath);
      const snapshot = await this.snapshotFile({
        relativePath: toPosix(relativePath),
        absolutePath,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs
      });
      await this.options.store.replaceFileSnapshot(baselineId, snapshot);
    } else {
      await this.options.store.deleteFileSnapshot(baselineId, toPosix(relativePath));
    }
  }

  /**
   * Restores one file to its baseline state: added files are deleted, modified
   * and deleted files are rewritten from the stored blob. Throws a visible
   * error when the baseline blob was over the cap.
   */
  async revertFile(baselineId: BaselineId, relativePath: string): Promise<void> {
    const baseline = await this.requiredBaseline(baselineId);
    const posixPath = toPosix(relativePath);
    const absolutePath = this.resolveInsideRoot(baseline.rootPath, posixPath);
    const snapshots = await this.options.store.listFileSnapshots(baselineId);
    const snapshot = snapshots.find((candidate) => candidate.path === posixPath);

    if (snapshot === undefined) {
      // Not in the baseline: the file was added during the session.
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
    await writeFile(absolutePath, content);
  }

  // MARK: Walking and snapshotting

  private async snapshotFile(file: WalkedFile): Promise<FileBaselineSnapshot> {
    const capturedAtMs = this.options.clock.now().getTime();
    if (file.size > this.maxBlobBytes) {
      return {
        path: file.relativePath,
        sha256: await hashFile(file.absolutePath),
        size: file.size,
        mtimeMs: file.mtimeMs,
        capturedAtMs,
        blobStored: false
      };
    }
    const blob = await this.options.blobs.putFile(file.absolutePath);
    return {
      path: file.relativePath,
      sha256: blob.sha256,
      size: file.size,
      mtimeMs: file.mtimeMs,
      capturedAtMs,
      blobStored: true
    };
  }

  private async walk(rootPath: string): Promise<WalkedFile[]> {
    const files: WalkedFile[] = [];
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (this.excludedNames.has(entry.name)) {
          continue;
        }
        const absolutePath = path.join(directory, entry.name);
        if (this.deniedPaths.length > 0 && isPathDenied(absolutePath, this.deniedPaths)) {
          continue;
        }
        if (entry.isSymbolicLink()) {
          continue;
        }
        if (entry.isDirectory()) {
          await visit(absolutePath);
          continue;
        }
        if (entry.isFile()) {
          const fileStat = await stat(absolutePath);
          files.push({
            relativePath: toPosix(path.relative(rootPath, absolutePath)),
            absolutePath,
            size: fileStat.size,
            mtimeMs: fileStat.mtimeMs
          });
        }
      }
    };
    await visit(path.resolve(rootPath));
    return files;
  }

  private async requiredBaseline(baselineId: BaselineId): Promise<DiffBaselineRecord> {
    const baseline = await this.options.store.getBaseline(baselineId);
    if (baseline === null) {
      throw new Error(`Diff baseline ${baselineId} was not found.`);
    }
    return baseline;
  }

  /** Rejects traversal outside the baseline root before any filesystem write. */
  private resolveInsideRoot(rootPath: string, relativePath: string): string {
    const absolutePath = path.resolve(rootPath, relativePath);
    const relative = path.relative(path.resolve(rootPath), absolutePath);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path ${relativePath} escapes the baseline root.`);
    }
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
    const posixPath = toPosix(relativePath);
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
    if (file.size > this.maxBlobBytes) {
      return null;
    }
    const buffer = await readFile(file.absolutePath);
    return isBinary(buffer) ? null : buffer.toString("utf8");
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

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
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
