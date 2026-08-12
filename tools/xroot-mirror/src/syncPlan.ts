/**
 * Sync plan: what to copy, and which package versions to leave behind.
 *
 * Edge case E2 — a sync can catch a package mid-publish. Rez treats a version
 * directory without a definition file as not-a-package (the studio's
 * `check_package_definition_files` setting), so half-written versions are
 * excluded from the copy instead of being mirrored torn. A torn package in the
 * mirror produces confusing, non-reproducible validation failures; a missing one
 * produces an honest "package not found" and shows up in the sync report.
 *
 * Detection is deliberately conservative. A subtree only enters `package-repo`
 * mode when it actually looks like a rez filesystem repo (at least one
 * `<family>/<version>/package.py`); anything else is copied whole and nothing is
 * skipped. Directory enumeration goes through an injectable facade so tests can
 * run against real temp trees and the CLI against the real share.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathSegments } from "./manifest.js";

/** Definition files that make a directory a rez package, in preference order. */
export const PACKAGE_DEFINITION_FILES: readonly string[] = ["package.py", "package.yaml"];

/** The filesystem operations the planner needs; real fs by default. */
export interface SyncFsFacade {
  /** Child directory names (never symlinks/junctions); empty when unreadable. */
  listDirectories(dir: string): readonly string[];
  /** True when a regular file exists at `path`. */
  fileExists(path: string): boolean;
  /** True when a directory exists at `path`. */
  directoryExists(path: string): boolean;
}

export type SyncMode = "whole" | "package-repo";

export interface SyncPlanEntry {
  /** Source-root-relative subtree, normalized to backslashes. */
  readonly subtree: string;
  readonly mode: SyncMode;
  /** False when the source directory is absent; the copy still runs and fails visibly. */
  readonly sourceExists: boolean;
  /** Absolute source directories excluded from the copy (torn versions). */
  readonly excludeDirs: readonly string[];
}

export interface SyncPlan {
  readonly sourceRoot: string;
  readonly entries: readonly SyncPlanEntry[];
  /**
   * Flat report list: source-root-relative paths of version directories left
   * behind because they carry no package definition file.
   */
  readonly skippedVersions: readonly string[];
}

/**
 * Directory entries report symlinks and junctions as neither file nor
 * directory, which matches robocopy's `/XJ`: reparse points are never followed.
 */
export const nodeSyncFs: SyncFsFacade = {
  listDirectories(dir: string): readonly string[] {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  },
  fileExists(path: string): boolean {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  directoryExists(path: string): boolean {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }
};

/** Join a source-root-relative entry onto an absolute root. */
export function joinUnderRoot(root: string, entry: string): string {
  const segments = pathSegments(entry);
  return segments.length === 0 ? root : join(root, ...segments);
}

/** Build the per-subtree copy plan plus the flat skipped-version report. */
export function buildSyncPlan(
  sourceRoot: string,
  subtrees: readonly string[],
  fs: SyncFsFacade = nodeSyncFs
): SyncPlan {
  const entries: SyncPlanEntry[] = [];
  const skippedVersions: string[] = [];

  for (const raw of subtrees) {
    const subtree = pathSegments(raw).join("\\");
    const sourceDir = joinUnderRoot(sourceRoot, subtree);
    if (!fs.directoryExists(sourceDir)) {
      entries.push({ subtree, mode: "whole", sourceExists: false, excludeDirs: [] });
      continue;
    }

    const scan = scanPackageRepo(sourceDir, subtree, fs);
    if (!scan.isPackageRepo) {
      entries.push({ subtree, mode: "whole", sourceExists: true, excludeDirs: [] });
      continue;
    }

    entries.push({
      subtree,
      mode: "package-repo",
      sourceExists: true,
      excludeDirs: scan.tornDirs.map((torn) => torn.absolutePath)
    });
    for (const torn of scan.tornDirs) skippedVersions.push(torn.relativePath);
  }

  return { sourceRoot, entries, skippedVersions };
}

interface TornVersion {
  readonly absolutePath: string;
  readonly relativePath: string;
}

interface RepoScan {
  readonly isPackageRepo: boolean;
  readonly tornDirs: readonly TornVersion[];
}

function scanPackageRepo(sourceDir: string, subtree: string, fs: SyncFsFacade): RepoScan {
  let definedVersions = 0;
  const tornDirs: TornVersion[] = [];

  for (const family of fs.listDirectories(sourceDir)) {
    const familyDir = join(sourceDir, family);
    // An unversioned package puts its definition straight in the family dir;
    // its subdirectories are payload, not versions.
    if (hasDefinition(familyDir, fs)) {
      definedVersions += 1;
      continue;
    }
    for (const version of fs.listDirectories(familyDir)) {
      const versionDir = join(familyDir, version);
      if (hasDefinition(versionDir, fs)) {
        definedVersions += 1;
      } else {
        tornDirs.push({ absolutePath: versionDir, relativePath: `${subtree}\\${family}\\${version}` });
      }
    }
  }

  // No definition anywhere means this is not a package repo: copy it whole and
  // skip nothing rather than guess at directories we do not understand.
  if (definedVersions === 0) return { isPackageRepo: false, tornDirs: [] };
  return { isPackageRepo: true, tornDirs };
}

function hasDefinition(dir: string, fs: SyncFsFacade): boolean {
  return PACKAGE_DEFINITION_FILES.some((name) => fs.fileExists(join(dir, name)));
}
