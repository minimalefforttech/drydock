/**
 * Mirror manifest: the allowlist that defines the curated package namespace.
 *
 * ADR 0022 replaces path translation with a curated namespace. The host mirrors
 * exactly the subtrees this manifest names, so every `P:\Pipeline\...` string in
 * a package definition, `packages_path`, or baked context resolves byte-for-byte
 * unchanged in the guest. Everything the manifest does not name is unnamed in
 * the guest, not merely denied (security-and-mounts.md).
 *
 * The manifest is versioned because receipts cite the version they ran against
 * (edge case G1), and because a newly referenced root is a reviewed proposal,
 * never a silent addition (F2).
 *
 * Validation is strict on purpose: an entry that escapes the source root or
 * carries its own drive letter would widen the namespace past what a reviewer
 * approved. Rejections name the correction rather than dumping a stack trace.
 */

import { readFile, writeFile } from "node:fs/promises";

/** How a prohibited root is presented to a job. */
export type RedirectMode = "stub" | "fixture";

export interface MirrorRedirect {
  /** Environment variable a package assigns, e.g. `STUDIO_ASSET_API_ROOT`. */
  readonly env: string;
  /** The prohibited root it points at, spelled the way packages spell it (`P:\Projects`). */
  readonly from: string;
  /** `stub` fails closed against an empty directory; `fixture` is per-job composition. */
  readonly mode: RedirectMode;
}

export interface MirrorManifest {
  /** Positive integer; bumped on every allowlist change. Receipts cite it. */
  readonly version: number;
  /** ISO timestamp of the last edit. */
  readonly updatedAt: string;
  /** Absolute root the subtrees are relative to (the studio share, e.g. `P:\`). */
  readonly sourceRoot: string;
  /** Absolute local root of the mirror ("pkgroot"). */
  readonly mirrorRoot: string;
  /** Bare SMB share name the guest maps as the pipeline drive. */
  readonly shareName: string;
  /** Source-root-relative directories that are mirrored, e.g. `Pipeline\rez\packages\internal`. */
  readonly subtrees: readonly string[];
  /** Source-root-relative directories that exist in the mirror but stay empty, e.g. `Projects`. */
  readonly stubDirs: readonly string[];
  /** Documented env vars that point at prohibited roots. */
  readonly redirects: readonly MirrorRedirect[];
}

/** Conventional file name for the manifest; nothing enforces it. */
export const MANIFEST_FILE_NAME = "pkgroot-manifest.json";

const ABSOLUTE_ROOT = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]|\/)/;
const DRIVE_PREFIX = /^[A-Za-z]:/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Split a windows-or-posix relative path into its non-empty segments. */
export function pathSegments(entry: string): readonly string[] {
  return entry.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

/** Case-insensitive comparison key for a normalized entry. */
export function entryKey(entry: string): string {
  return entry.toLowerCase();
}

interface ManifestReadResult {
  readonly problems: readonly string[];
  readonly manifest: MirrorManifest | null;
}

/** Human-readable problems with a candidate manifest; empty means usable. */
export function collectManifestProblems(value: unknown): readonly string[] {
  return readManifestValue(value).problems;
}

/**
 * Validate and normalize a manifest value. Throws an Error whose message lists
 * every problem and the fix for each; it never throws anything else.
 */
export function validateManifest(value: unknown, sourceLabel = "Mirror manifest"): MirrorManifest {
  const { problems, manifest } = readManifestValue(value);
  if (manifest === null || problems.length > 0) {
    throw new Error(`${sourceLabel} rejected:\n  - ${problems.join("\n  - ")}`);
  }
  return manifest;
}

/** Parse manifest JSON text. JSON errors name the file, not a stack frame. */
export function parseManifest(text: string, file: string): MirrorManifest {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Mirror manifest ${file} is not valid JSON: ${messageOf(error)}`);
  }
  return validateManifest(value, `Mirror manifest ${file}`);
}

/** Read + validate a manifest file. Missing files say how to get one. */
export async function loadManifest(file: string): Promise<MirrorManifest> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `No mirror manifest at ${file}. The mirror only ever contains what a manifest allows; ` +
        "write one (subtrees, stubDirs, redirects) before syncing."
      );
    }
    throw new Error(`Cannot read mirror manifest ${file}: ${messageOf(error)}`);
  }
  return parseManifest(text, file);
}

/** Validate then write a manifest as formatted JSON with a trailing newline. */
export async function saveManifest(file: string, manifest: MirrorManifest): Promise<void> {
  const validated = validateManifest(manifest, `Mirror manifest ${file}`);
  await writeFile(file, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
}

function readManifestValue(value: unknown): ManifestReadResult {
  const problems: string[] = [];
  const record = asRecord(value);
  if (record === null) {
    return {
      problems: [
        "manifest must be a JSON object with version, updatedAt, sourceRoot, mirrorRoot, shareName, subtrees, stubDirs and redirects"
      ],
      manifest: null
    };
  }

  const version = record["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    problems.push(
      `version must be a positive integer; got ${describe(version)}. ` +
      "Bump it on every allowlist change so receipts can cite what they ran against."
    );
  }

  const updatedAt = record["updatedAt"];
  if (typeof updatedAt !== "string" || updatedAt.trim() === "" || Number.isNaN(Date.parse(updatedAt))) {
    problems.push(`updatedAt must be an ISO timestamp; got ${describe(updatedAt)}.`);
  }

  checkRoot(problems, "sourceRoot", record["sourceRoot"]);
  checkRoot(problems, "mirrorRoot", record["mirrorRoot"]);

  const shareName = record["shareName"];
  if (typeof shareName !== "string" || shareName.trim() === "") {
    problems.push("shareName must be a non-empty SMB share name.");
  } else if (/[\\/]/.test(shareName)) {
    problems.push(`shareName "${shareName}" must be a bare share name, not a path — the guest maps \\\\<host>\\<shareName> as the pipeline drive.`);
  }

  const subtrees = checkEntries(problems, "subtrees", record["subtrees"]);
  const stubDirs = checkEntries(problems, "stubDirs", record["stubDirs"]);
  checkOverlaps(problems, subtrees, stubDirs);

  const redirects = checkRedirects(problems, record["redirects"]);

  if (problems.length > 0) return { problems, manifest: null };

  return {
    problems,
    manifest: {
      version: version as number,
      updatedAt: (updatedAt as string).trim(),
      sourceRoot: (record["sourceRoot"] as string).trim(),
      mirrorRoot: (record["mirrorRoot"] as string).trim(),
      shareName: (shareName as string).trim(),
      subtrees,
      stubDirs,
      redirects
    }
  };
}

function checkRoot(problems: string[], field: string, value: unknown): void {
  if (typeof value !== "string" || value.trim() === "") {
    problems.push(`${field} must be a non-empty absolute path.`);
    return;
  }
  if (!ABSOLUTE_ROOT.test(value.trim())) {
    problems.push(`${field} "${value.trim()}" must be an absolute path (drive or UNC), e.g. "P:\\" or "\\\\studio-fs\\share".`);
  }
}

function checkEntries(problems: string[], field: string, raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) {
    problems.push(`${field} must be an array of source-root-relative paths.`);
    return [];
  }
  const normalized: string[] = [];
  const seen = new Map<string, number>();
  raw.forEach((entry: unknown, index: number) => {
    const label = `${field}[${index}]`;
    if (typeof entry !== "string" || entry.trim() === "") {
      problems.push(`${label} must be a non-empty string.`);
      return;
    }
    const trimmed = entry.trim();
    if (DRIVE_PREFIX.test(trimmed)) {
      problems.push(
        `${label} "${trimmed}" carries a drive letter; entries are relative to sourceRoot — write "Pipeline\\rez\\packages\\internal".`
      );
      return;
    }
    if (trimmed.includes(":")) {
      problems.push(`${label} "${trimmed}" contains ":"; drive letters and NTFS streams are not allowed inside an entry.`);
      return;
    }
    if (/^[\\/]/.test(trimmed)) {
      problems.push(`${label} "${trimmed}" is absolute; entries are relative to sourceRoot.`);
      return;
    }
    const segments = pathSegments(trimmed);
    if (segments.includes("..")) {
      problems.push(`${label} "${trimmed}" escapes the source root; ".." is not allowed in an allowlist entry.`);
      return;
    }
    if (segments.length === 0 || segments.includes(".")) {
      problems.push(`${label} "${trimmed}" must name a directory below sourceRoot.`);
      return;
    }
    const value = segments.join("\\");
    const first = seen.get(entryKey(value));
    if (first !== undefined) {
      problems.push(`${label} "${trimmed}" duplicates ${field}[${first}]; list each entry once.`);
      return;
    }
    seen.set(entryKey(value), index);
    normalized.push(value);
  });
  return normalized;
}

/**
 * Nesting is rejected in both directions: two overlapping robocopy /MIR targets
 * fight over the same directory, and a stub that sits above (or inside) a
 * mirrored subtree is not an empty directory at all.
 */
function checkOverlaps(problems: string[], subtrees: readonly string[], stubDirs: readonly string[]): void {
  subtrees.forEach((outer, outerIndex) => {
    subtrees.forEach((inner, innerIndex) => {
      if (innerIndex <= outerIndex) return;
      if (!nests(outer, inner)) return;
      problems.push(
        `subtrees[${innerIndex}] "${inner}" overlaps subtrees[${outerIndex}] "${outer}"; mirror one or the other — ` +
        "two /MIR targets over the same directory delete each other's files."
      );
    });
  });
  stubDirs.forEach((stub, stubIndex) => {
    subtrees.forEach((subtree, subtreeIndex) => {
      if (!nests(stub, subtree)) return;
      problems.push(
        `stubDirs[${stubIndex}] "${stub}" overlaps subtrees[${subtreeIndex}] "${subtree}"; a stub is an empty directory, ` +
        "it cannot also hold mirrored content."
      );
    });
  });
}

function nests(a: string, b: string): boolean {
  const left = entryKey(a);
  const right = entryKey(b);
  return left === right || left.startsWith(`${right}\\`) || right.startsWith(`${left}\\`);
}

function checkRedirects(problems: string[], raw: unknown): readonly MirrorRedirect[] {
  if (!Array.isArray(raw)) {
    problems.push("redirects must be an array of { env, from, mode } entries.");
    return [];
  }
  const normalized: MirrorRedirect[] = [];
  const seen = new Map<string, number>();
  raw.forEach((entry: unknown, index: number) => {
    const label = `redirects[${index}]`;
    const record = asRecord(entry);
    if (record === null) {
      problems.push(`${label} must be an object with env, from and mode.`);
      return;
    }
    const env = record["env"];
    const from = record["from"];
    const mode = record["mode"];
    let ok = true;
    if (typeof env !== "string" || !ENV_NAME.test(env.trim())) {
      problems.push(`${label}.env must be an environment variable name, e.g. "STUDIO_ASSET_API_ROOT"; got ${describe(env)}.`);
      ok = false;
    }
    if (typeof from !== "string" || from.trim() === "") {
      problems.push(`${label}.from must name the root the variable points at, e.g. "P:\\Projects"; got ${describe(from)}.`);
      ok = false;
    }
    if (mode !== "stub" && mode !== "fixture") {
      problems.push(
        `${label}.mode must be "stub" (fail closed against an empty directory) or "fixture" (per-job composition); got ${describe(mode)}.`
      );
      ok = false;
    }
    if (!ok) return;
    const envName = (env as string).trim();
    const first = seen.get(envName.toLowerCase());
    if (first !== undefined) {
      problems.push(`${label}.env "${envName}" duplicates redirects[${first}].env; one entry per variable.`);
      return;
    }
    seen.set(envName.toLowerCase(), index);
    normalized.push({ env: envName, from: (from as string).trim(), mode: mode as RedirectMode });
  });
  return normalized;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function describe(value: unknown): string {
  if (value === undefined) return "nothing";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
