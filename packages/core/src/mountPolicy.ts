/**
 * Pure mount-policy helpers.
 *
 * Mounts derive from workspace roots plus a session mode: plan mode is
 * read-only, implementation mode is read-write, clone mode never mounts live
 * roots. Denied paths are excluded in both containment directions - a denied
 * path can neither be mounted nor be exposed inside a mounted root.
 */

import path from "node:path";
import type { MountPolicy, SessionMode } from "@drydock/contracts";
import type { IdGenerator } from "./ids.js";

export type { SessionMode };

export interface BuildMountPolicyRequest {
  readonly mode: SessionMode;
  readonly workspaceRoots: readonly string[];
  /**
   * Workspace roots that must mount read-only even in implementation mode - the
   * per-member read-only flag from a workspace set. Matched by normalized path
   * key. Plan mode is read-only regardless.
   */
  readonly readOnlyRoots?: readonly string[];
  readonly sharedRead: readonly string[];
  readonly sharedWrite: readonly string[];
  readonly deniedPaths?: readonly string[];
  readonly approvedBy?: string;
  readonly approvedAt?: string;
}

const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_ABSOLUTE = /^[\\/]{2}(?![?.][\\/])[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/;
const WINDOWS_EXTENDED_DRIVE_ABSOLUTE = /^\\\\\?\\[A-Za-z]:\\/;
const WINDOWS_EXTENDED_UNC_ABSOLUTE = /^\\\\\?\\UNC\\[^\\/]+\\[^\\/]+(?:\\|$)/i;

/**
 * True when a host path is fully qualified without relying on the current
 * process platform. In particular, Windows drive and UNC paths remain valid
 * inputs when validation or tests run on a POSIX host. Drive-relative paths
 * (`C:folder`) and current-drive-rooted paths (`\\folder`) stay rejected
 * because their meaning depends on process state.
 */
export function isHostPathAbsolute(value: string): boolean {
  // Backslash pairs and exactly-two-slash server prefixes are Windows UNC
  // syntax. Three or more leading forward slashes remain valid POSIX roots.
  if (value.startsWith("\\\\") || /^\/\/[^/]/.test(value)) {
    return WINDOWS_UNC_ABSOLUTE.test(value)
      || WINDOWS_EXTENDED_DRIVE_ABSOLUTE.test(value)
      || WINDOWS_EXTENDED_UNC_ABSOLUTE.test(value);
  }
  return path.posix.isAbsolute(value) || WINDOWS_DRIVE_ABSOLUTE.test(value);
}

/**
 * True only when an absolute path belongs to the selected host platform.
 * Use this before filesystem access; `isHostPathAbsolute` is intentionally
 * broader for persisted/displayed paths and cross-platform protocol input.
 */
export function isNativeHostPathAbsolute(
  value: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform === "win32") {
    return isWindowsAbsolutePath(value);
  }
  return path.posix.isAbsolute(value) && !isWindowsAbsolutePath(value);
}

/** Normalize an absolute foreign host path with its own platform semantics. */
export function normalizeHostPath(value: string): string {
  const ordinaryWindowsPath = withoutExtendedWindowsPrefix(value);
  if (ordinaryWindowsPath !== null) {
    return path.win32.normalize(ordinaryWindowsPath);
  }
  if (isWindowsAbsolutePath(value)) {
    return path.win32.normalize(value);
  }
  if (path.posix.isAbsolute(value)) {
    return path.posix.normalize(value);
  }
  return path.resolve(value);
}

/** Join a child name without rewriting a foreign Windows/UNC host path. */
function joinHostPath(root: string, child: string): string {
  const normalizedRoot = normalizeHostPath(root);
  if (isWindowsAbsolutePath(normalizedRoot)) {
    return path.win32.join(normalizedRoot, child);
  }
  return path.posix.isAbsolute(normalizedRoot)
    ? path.posix.join(normalizedRoot, child)
    : path.join(normalizedRoot, child);
}

function isWindowsAbsolutePath(value: string): boolean {
  return WINDOWS_DRIVE_ABSOLUTE.test(value)
    || WINDOWS_UNC_ABSOLUTE.test(value)
    || WINDOWS_EXTENDED_DRIVE_ABSOLUTE.test(value)
    || WINDOWS_EXTENDED_UNC_ABSOLUTE.test(value);
}

/**
 * Collapse Windows' extended-length aliases before comparison. Keeping both
 * spellings would let the same directory acquire different policy keys.
 */
function withoutExtendedWindowsPrefix(value: string): string | null {
  if (WINDOWS_EXTENDED_DRIVE_ABSOLUTE.test(value)) {
    return value.slice(4);
  }
  if (WINDOWS_EXTENDED_UNC_ABSOLUTE.test(value)) {
    return `\\\\${value.slice(8)}`;
  }
  return null;
}

export function buildMountPolicy(request: BuildMountPolicyRequest, ids: IdGenerator): MountPolicy[] {
  const deniedPaths = request.deniedPaths ?? [];
  const readOnlyKeys = new Set((request.readOnlyRoots ?? []).map((root) => normalizePathKey(root)));
  const mounts: MountPolicy[] = [];
  if (request.mode !== "clone") {
    for (const root of request.workspaceRoots) {
      assertMountAllowed(root, deniedPaths);
      const writable = request.mode === "implementation" && !readOnlyKeys.has(normalizePathKey(root));
      mounts.push(policy({
        ids,
        hostPath: root,
        runtimePath: sandboxRuntimePath(root),
        mode: writable ? "read-write" : "read-only",
        source: "workspace-root",
        ...approvalFields(request)
      }));
    }
  }

  for (const root of request.sharedRead) {
    assertMountAllowed(root, deniedPaths);
    mounts.push(policy({
      ids,
      hostPath: root,
      runtimePath: sandboxRuntimePath(root),
      mode: "read-only",
      source: "shared-read",
      ...approvalFields(request)
    }));
  }

  for (const root of request.sharedWrite) {
    assertMountAllowed(root, deniedPaths);
    mounts.push(policy({
      ids,
      hostPath: root,
      runtimePath: sandboxRuntimePath(root),
      mode: "read-write",
      source: "shared-write",
      ...approvalFields(request)
    }));
  }

  return mounts;
}

/**
 * The in-container path where the Docker Sandbox runtime mounts a host folder:
 * a drive-letter mirror on Windows (`H:\pipeline\work` → `/h/pipeline/work`),
 * otherwise the resolved POSIX path. sbx derives the mount point from the host
 * path - it is NOT caller-assignable - so this is the ONE true location, and
 * every mount briefing, UI label, and grant note must advertise it. An agent
 * told a different path (e.g. a synthetic `/workspace/root-1`) writes into an
 * unmounted container overlay and its edits never reach the host.
 */
export function sandboxRuntimePath(hostPath: string): string {
  const resolved = normalizeHostPath(hostPath);
  const drive = /^([A-Za-z]):[\\/]?(.*)$/.exec(resolved);
  if (drive) {
    return `/${drive[1]!.toLowerCase()}/${(drive[2] ?? "").replace(/\\/g, "/")}`;
  }
  return resolved.replace(/\\/g, "/");
}

/**
 * Role sessions: a child session must never inherit broader access
 * than its parent (threat-model.md). Every child mount must sit inside some
 * parent mount, and read-write requires the covering parent mount to be
 * read-write. Applies at spawn AND at every later mount expansion. The
 * child's own disposable workspace is the caller's concern (it is product
 * scratch, not host reach) - pass only host-reach mounts here.
 */
export function assertChildMountsWithinParent(
  childMounts: readonly MountPolicy[],
  parentMounts: readonly MountPolicy[],
  caseInsensitive?: boolean
): void {
  for (const child of childMounts) {
    const covering = parentMounts.filter((parent) => isPathWithin(child.hostPath, parent.hostPath, caseInsensitive));
    if (covering.length === 0) {
      throw new Error(
        `Child session mount ${child.hostPath} is outside the parent session's access. Grant it to the parent first.`
      );
    }
    if (child.mode === "read-write" && !covering.some((parent) => parent.mode === "read-write")) {
      throw new Error(
        `Child session mount ${child.hostPath} requests read-write but the parent's access there is read-only.`
      );
    }
  }
}

export function assertWorkspaceInsideOwner(workspacePath: string, ownerRoot: string): void {
  if (!isPathWithin(workspacePath, ownerRoot)) {
    throw new Error(`Workspace ${workspacePath} is outside owner root ${ownerRoot}.`);
  }
}

// MARK: Path policy

/**
 * Canonical comparison key for host paths: resolved, forward slashes, no
 * trailing separator, case-folded on case-insensitive platforms (Windows).
 */
export function normalizePathKey(
  value: string,
  caseInsensitive: boolean = isWindowsAbsolutePath(value)
    || (process.platform === "win32" && !path.posix.isAbsolute(value))
): string {
  let key = normalizeHostPath(value).replace(/\\/g, "/");
  if (key.length > 1 && key.endsWith("/")) {
    key = key.slice(0, -1);
  }
  return caseInsensitive ? key.toLowerCase() : key;
}

/** True when child equals parent or lives underneath it (normalized keys). */
export function isPathWithin(child: string, parent: string, caseInsensitive?: boolean): boolean {
  const childKey = normalizePathKey(child, caseInsensitive);
  const parentKey = normalizePathKey(parent, caseInsensitive);
  const descendantPrefix = parentKey.endsWith("/") ? parentKey : `${parentKey}/`;
  return childKey === parentKey || childKey.startsWith(descendantPrefix);
}

/** True when the path is denied or contains/lives inside a denied path. */
export function isPathDenied(hostPath: string, deniedPaths: readonly string[], caseInsensitive?: boolean): boolean {
  return deniedPaths.some((denied) =>
    isPathWithin(hostPath, denied, caseInsensitive) || isPathWithin(denied, hostPath, caseInsensitive)
  );
}

/**
 * Refuses mounts that intersect a denied path in either direction: mounting a
 * parent of a denied path would expose it, mounting inside one is direct
 * access. Also refuses a filesystem root outright (a drive root like `C:\` or
 * `/`, or a bare UNC share root `\\server\share`) - mounting an entire volume
 * is never intentional and defeats the blast-radius bound. Throws a
 * user-visible error instead of silently skipping.
 */
export function assertMountAllowed(hostPath: string, deniedPaths: readonly string[], caseInsensitive?: boolean): void {
  if (isFilesystemRoot(hostPath)) {
    throw new Error(`Refusing to mount a filesystem root: ${hostPath}`);
  }
  if (isPathDenied(hostPath, deniedPaths, caseInsensitive)) {
    throw new Error(`Mount of ${hostPath} is refused: it intersects a denied path.`);
  }
}

/**
 * True when the resolved path is a whole-volume root: a drive/POSIX root equal
 * to its own `path.parse().root` (`C:\`, `/`), or a bare UNC share root
 * (`\\server\share`) with no deeper segment. UNC roots parse with the share as
 * the root, so the deeper-segment check is what separates `\\srv\share` (root)
 * from `\\srv\share\dir` (mountable).
 */
export function isFilesystemRoot(hostPath: string): boolean {
  const resolved = normalizeHostPath(hostPath);
  if (!isWindowsAbsolutePath(resolved)) {
    return resolved === path.posix.parse(resolved).root;
  }
  const withoutTrailingSeparators = resolved.replace(/[\\/]+$/, "");
  if (/^[A-Za-z]:$/.test(withoutTrailingSeparators)) {
    return true;
  }
  if (/^\\\\[^\\/]+\\[^\\/]+$/i.test(withoutTrailingSeparators)) {
    return true;
  }
  return false;
}

/**
 * The sensitive host directories that ship denied by default (opt-out via
 * setting). These are home-relative config/credential roots the agent should
 * never mount without an explicit, deliberate override.
 */
export function defaultDeniedPaths(homeDir: string): string[] {
  return [".ssh", ".aws", ".gnupg", ".kube", ".azure", ".docker"].map((segment) =>
    joinHostPath(homeDir, segment)
  );
}

/** Path segments that mark a directory as credential/secret-bearing. */
const SENSITIVE_SEGMENTS: readonly string[] = [".ssh", ".aws", ".gnupg", ".kube", ".azure", ".docker", "secrets"];

/**
 * Basename patterns that flag a sensitive file. Each is tested case-insensitively
 * against the path's basename; `*`/`.` behave as literal glob/extension anchors.
 */
const SENSITIVE_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env$/i,
  /^\.env\..+$/i,
  /^id_rsa.*$/i,
  /^id_ed25519.*$/i,
  /^id_ecdsa.*$/i,
  /^.+\.pem$/i,
  /^.+\.key$/i,
  /^.+\.p12$/i,
  /^.+\.pfx$/i,
  /^credentials$/i,
  /^credentials\.json$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i
];

/** What flagged a path as sensitive: the matched segment or basename, verbatim. */
export interface SensitivePathMatch {
  readonly kind: "directory" | "file";
  readonly match: string;
}

/**
 * The credential/secret trigger for a candidate path, or null when none: the
 * first path segment matching a sensitive directory name (case-insensitive),
 * else a basename matching a sensitive-file pattern. Pure and separator-
 * agnostic - accepts Windows or POSIX separators. Drives the risk-tiered
 * approval card and its "why this escalated" wording.
 */
export function sensitivePathMatch(candidatePath: string): SensitivePathMatch | null {
  const segments = candidatePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
  const directory = segments.find((segment) => SENSITIVE_SEGMENTS.includes(segment.toLowerCase()));
  if (directory !== undefined) {
    return { kind: "directory", match: directory };
  }
  const basename = segments[segments.length - 1];
  if (basename === undefined) {
    return null;
  }
  return SENSITIVE_BASENAME_PATTERNS.some((pattern) => pattern.test(basename))
    ? { kind: "file", match: basename }
    : null;
}

/** True when a candidate path names a credential/secret directory or file. */
export function isSensitivePath(candidatePath: string): boolean {
  return sensitivePathMatch(candidatePath) !== null;
}

// MARK: Construction helpers

function approvalFields(request: BuildMountPolicyRequest): { readonly approvedBy?: string; readonly approvedAt?: string } {
  if (request.approvedBy === undefined || request.approvedAt === undefined) {
    return {};
  }
  return { approvedBy: request.approvedBy, approvedAt: request.approvedAt };
}

function policy(input: {
  readonly ids: IdGenerator;
  readonly hostPath: string;
  readonly runtimePath: string;
  readonly mode: MountPolicy["mode"];
  readonly source: MountPolicy["source"];
  readonly approvedBy?: string;
  readonly approvedAt?: string;
}): MountPolicy {
  const base = {
    mountId: input.ids.mountId(),
    hostPath: normalizeHostPath(input.hostPath),
    runtimePath: input.runtimePath,
    mode: input.mode,
    source: input.source
  };
  return input.approvedBy === undefined || input.approvedAt === undefined
    ? base
    : { ...base, approvedBy: input.approvedBy, approvedAt: input.approvedAt };
}
