/**
 * Workspace tag rules (docs/design/mcp-and-memory.md).
 *
 * A tag rule maps simple globs to a tag: `package.py` → rez, `*.py` → python,
 * `*.h`/`*.hh` → cpp. Rules are first-class config — the shipped defaults
 * below are extended (never replaced) by user rules from settings — and
 * multiple tags apply when multiple globs match. Detection is one bounded,
 * cached scan per mounted root at mount time: top levels plus an extension
 * census, never a deep walk. Tags select which scoped memories a session
 * briefing carries, and render as chips so it is visible why a memory did or
 * did not load.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface TagRule {
  /** Basename globs (`package.py`, `*.py`); matched case-insensitively. */
  readonly globs: readonly string[];
  readonly tag: string;
}

export const DEFAULT_TAG_RULES: readonly TagRule[] = [
  { globs: ["package.py"], tag: "rez" },
  { globs: ["pyproject.toml", "requirements.txt"], tag: "pip" },
  { globs: ["package.json"], tag: "node" },
  { globs: ["*.py"], tag: "python" },
  { globs: ["*.h", "*.hh", "*.hpp", "*.cpp", "*.cc"], tag: "cpp" },
  { globs: ["*.uproject"], tag: "unreal" },
  { globs: ["*.ma", "*.mb"], tag: "maya" },
  { globs: ["*.hip", "*.hiplc", "*.hipnc"], tag: "houdini" },
  { globs: ["*.usd", "*.usda", "*.usdc"], tag: "usd" },
  { globs: ["*.ts", "*.tsx"], tag: "typescript" },
  { globs: ["*.rs", "Cargo.toml"], tag: "rust" },
  { globs: ["*.go", "go.mod"], tag: "go" },
  { globs: ["*.cs", "*.csproj"], tag: "csharp" }
];

const MAX_USER_RULES = 200;
const MAX_GLOB_LENGTH = 64;
const MAX_TAG_LENGTH = 32;

/**
 * Parses user rules from settings (drydock.memory.tagRules) and appends them
 * to the shipped defaults. Malformed entries are dropped, never guessed at.
 */
export function mergeTagRules(userRules: unknown): readonly TagRule[] {
  const merged: TagRule[] = [...DEFAULT_TAG_RULES];
  if (!Array.isArray(userRules)) return merged;
  for (const candidate of userRules.slice(0, MAX_USER_RULES)) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const record = candidate as Record<string, unknown>;
    const tag = typeof record["tag"] === "string" ? record["tag"].trim().toLowerCase() : "";
    if (tag.length === 0 || tag.length > MAX_TAG_LENGTH || !/^[a-z0-9][a-z0-9_.-]*$/.test(tag)) continue;
    const rawGlobs = record["globs"];
    const globs = (Array.isArray(rawGlobs) ? rawGlobs : [])
      .filter((glob): glob is string => typeof glob === "string")
      .map((glob) => glob.trim())
      .filter((glob) => glob.length > 0 && glob.length <= MAX_GLOB_LENGTH);
    if (globs.length === 0) continue;
    merged.push({ globs, tag });
  }
  return merged;
}

/** What one bounded root scan observed: lowercased basenames + extensions. */
export interface WorkspaceScan {
  readonly names: ReadonlySet<string>;
  /** Extensions include the dot, lowercased (".py"). */
  readonly extensions: ReadonlySet<string>;
}

/** Matches every rule against a scan; a rule tags when ANY of its globs hits. */
export function matchTags(scan: WorkspaceScan, rules: readonly TagRule[]): string[] {
  const tags = new Set<string>();
  for (const rule of rules) {
    if (tags.has(rule.tag)) continue;
    for (const glob of rule.globs) {
      if (globHits(glob.toLowerCase(), scan)) {
        tags.add(rule.tag);
        break;
      }
    }
  }
  return [...tags];
}

function globHits(glob: string, scan: WorkspaceScan): boolean {
  // Fast path: a pure `*.ext` glob is an extension-census lookup.
  const extensionOnly = /^\*(\.[a-z0-9]+)$/.exec(glob);
  if (extensionOnly !== null) {
    return scan.extensions.has(extensionOnly[1] ?? "");
  }
  // Literal basename (no wildcards): set lookup.
  if (!glob.includes("*") && !glob.includes("?")) {
    return scan.names.has(glob);
  }
  const pattern = new RegExp(`^${glob.split("").map((char) => {
    if (char === "*") return "[^/\\\\]*";
    if (char === "?") return "[^/\\\\]";
    return char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }).join("")}$`);
  for (const name of scan.names) {
    if (pattern.test(name)) return true;
  }
  return false;
}

const SKIPPED_DIRECTORIES = new Set([
  "node_modules", ".git", "__pycache__", ".venv", "venv", ".mypy_cache",
  ".pytest_cache", ".ruff_cache", ".tox", "dist", "out", "build", ".next", "target"
]);
const SCAN_MAX_DEPTH = 3;
const SCAN_MAX_ENTRIES = 4_000;

/**
 * Bounded scan of one root: breadth-first to SCAN_MAX_DEPTH, capped at
 * SCAN_MAX_ENTRIES total directory entries, junk directories skipped. Fast by
 * construction — this runs at mount time on the host, so it must never crawl
 * a monorepo's node_modules or an asset library.
 */
export async function scanRoot(rootPath: string): Promise<WorkspaceScan> {
  const names = new Set<string>();
  const extensions = new Set<string>();
  let budget = SCAN_MAX_ENTRIES;
  let frontier: string[] = [rootPath];
  for (let depth = 0; depth < SCAN_MAX_DEPTH && frontier.length > 0 && budget > 0; depth += 1) {
    const next: string[] = [];
    for (const directory of frontier) {
      if (budget <= 0) break;
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (budget <= 0) break;
        budget -= 1;
        const lower = entry.name.toLowerCase();
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(lower) && !lower.startsWith(".")) {
            next.push(path.join(directory, entry.name));
          }
          continue;
        }
        names.add(lower);
        const extension = path.extname(lower);
        if (extension.length > 1) extensions.add(extension);
      }
    }
    frontier = next;
  }
  return { names, extensions };
}

/** Scans every root and unions the matched tags, sorted for stable display. */
export async function detectWorkspaceTags(roots: readonly string[], rules: readonly TagRule[]): Promise<string[]> {
  const tags = new Set<string>();
  for (const root of roots) {
    const scan = await scanRoot(root);
    for (const tag of matchTags(scan, rules)) tags.add(tag);
  }
  return [...tags].sort();
}
