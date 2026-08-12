/**
 * Reference scanner: which `X:` roots do package definitions actually name?
 *
 * The curated namespace only works if the allowlist covers what packages ask
 * for. ADR 0022 makes that a standing scan rather than a one-off: every
 * `package.py` under the mirrored repos is read as raw text and every `X:\...`
 * string is classified by its top-level root (`Pipeline`, `Projects`, ...).
 * Drift between that class list and the manifest surfaces as a proposal
 * (edge case F2), and env assignments carry the variable name so a redirect
 * proposal can say `FR_ASSET_API_SILEX_ROOT -> X:\Projects` (F1).
 *
 * The regex is conservative on purpose: package definitions are Python, so a
 * reference may be single- or double-quoted, escaped (`X:\\Projects`), forward-
 * slashed, joined, or built inside an f-string. Matching the drive prefix in raw
 * text over-collects slightly and under-collects almost never, which is the
 * right bias for an allowlist review.
 */

import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, relative } from "node:path";

/** Files read by default; a rez filesystem repo keeps definitions in these. */
export const DEFAULT_SCAN_FILE_NAMES: readonly string[] = ["package.py"];

const EXAMPLE_LIMIT = 3;

/** `X:` (any case) followed by a separator, not preceded by an identifier char. */
const X_REFERENCE = /(?<![A-Za-z0-9_])[Xx]:[\\/][^"'`\s,;:*?<>|)\]}\r\n]*/g;

/** `env.NAME = "X:\..."`, `env["NAME"] = ...`, `env.NAME.append("X:/...")`. */
const ENV_ASSIGNMENT =
  /\benv(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\])\s*(?:=|\.(?:set|append|prepend)\s*\(\s*)\s*[rRfFbBuU]?["']([^"'\r\n]*)["']/g;

export interface ReferenceClass {
  /** Top-level root under `X:`, e.g. `Pipeline` or `Projects`. */
  readonly root: string;
  /** How many references fell into this class. */
  readonly count: number;
  /** First few scanned files that referenced it, relative to their scan root. */
  readonly examples: readonly string[];
  /** First few distinct matched strings, spelled as the package spells them. */
  readonly sampleRefs: readonly string[];
  /** Environment variables assigned a reference in this class. */
  readonly envVars: readonly string[];
}

export interface ReferenceScanResult {
  /** Directories that were walked. */
  readonly roots: readonly string[];
  readonly filesScanned: number;
  readonly refsFound: number;
  /** Ordered by count, descending, then root name. */
  readonly classes: readonly ReferenceClass[];
}

export interface ScanOptions {
  /** File names to read; defaults to `package.py`. Compared case-insensitively. */
  readonly fileNames?: readonly string[];
}

/** Walk one directory tree. */
export async function scanReferences(dir: string, options: ScanOptions = {}): Promise<ReferenceScanResult> {
  return scanReferenceRoots([dir], options);
}

/** Walk several directory trees into one class list (one per manifest subtree). */
export async function scanReferenceRoots(dirs: readonly string[], options: ScanOptions = {}): Promise<ReferenceScanResult> {
  const wanted = new Set((options.fileNames ?? DEFAULT_SCAN_FILE_NAMES).map((name) => name.toLowerCase()));
  const collector = new ClassCollector();
  let filesScanned = 0;

  for (const dir of dirs) {
    for (const file of await walk(dir, wanted)) {
      filesScanned += 1;
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      const displayPath = relative(dir, file) || file;
      for (const ref of extractXReferences(text)) collector.addReference(ref, displayPath);
      for (const assignment of extractEnvAssignments(text)) collector.addEnvVar(assignment.env, assignment.ref);
    }
  }

  return { roots: [...dirs], filesScanned, refsFound: collector.total, classes: collector.classes() };
}

/** Every `X:`-rooted string in raw text, in order of appearance. */
export function extractXReferences(text: string): readonly string[] {
  const found: string[] = [];
  for (const match of text.matchAll(X_REFERENCE)) {
    const value = match[0].replace(/[\\/]+$/, "");
    if (rootClassOf(value) === null) continue;
    found.push(value);
  }
  return found;
}

/** Env assignments whose value contains an `X:` reference. */
export function extractEnvAssignments(text: string): readonly { readonly env: string; readonly ref: string }[] {
  const found: { env: string; ref: string }[] = [];
  for (const match of text.matchAll(ENV_ASSIGNMENT)) {
    const name = match[1] ?? match[2];
    const literal = match[3];
    if (name === undefined || literal === undefined) continue;
    const refs = extractXReferences(literal);
    const first = refs[0];
    if (first === undefined) continue;
    found.push({ env: name, ref: first });
  }
  return found;
}

/** Top-level root class of an `X:` reference, or null when it names no class. */
export function rootClassOf(ref: string): string | null {
  const match = /^[A-Za-z]:[\\/]+(.*)$/.exec(ref);
  if (match === null) return null;
  const rest = match[1] ?? "";
  const segment = rest.split(/[\\/]+/).find((part) => part.length > 0);
  return segment === undefined ? null : segment;
}

class ClassCollector {
  total = 0;
  private readonly byKey = new Map<
    string,
    { root: string; count: number; examples: string[]; sampleRefs: string[]; envVars: string[] }
  >();

  addReference(ref: string, file: string): void {
    const root = rootClassOf(ref);
    if (root === null) return;
    const entry = this.entryFor(root);
    entry.count += 1;
    this.total += 1;
    if (entry.examples.length < EXAMPLE_LIMIT && !entry.examples.includes(file)) entry.examples.push(file);
    if (entry.sampleRefs.length < EXAMPLE_LIMIT && !entry.sampleRefs.includes(ref)) entry.sampleRefs.push(ref);
  }

  addEnvVar(env: string, ref: string): void {
    const root = rootClassOf(ref);
    if (root === null) return;
    const entry = this.entryFor(root);
    if (!entry.envVars.includes(env)) entry.envVars.push(env);
  }

  classes(): readonly ReferenceClass[] {
    return [...this.byKey.values()]
      .map((entry) => ({
        root: entry.root,
        count: entry.count,
        examples: [...entry.examples],
        sampleRefs: [...entry.sampleRefs],
        envVars: [...entry.envVars].sort((a, b) => a.localeCompare(b))
      }))
      .sort((a, b) => (b.count - a.count) || a.root.localeCompare(b.root));
  }

  /** Windows paths are case-insensitive; the first spelling seen is the label. */
  private entryFor(root: string): { root: string; count: number; examples: string[]; sampleRefs: string[]; envVars: string[] } {
    const key = root.toLowerCase();
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;
    const created = { root, count: 0, examples: [] as string[], sampleRefs: [] as string[], envVars: [] as string[] };
    this.byKey.set(key, created);
    return created;
  }
}

async function walk(dir: string, wanted: ReadonlySet<string>): Promise<readonly string[]> {
  const files: string[] = [];
  const pending: string[] = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = join(current, entry.name);
      // Symlinks and junctions report as neither, so the walk stays inside the tree.
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile() && wanted.has(entry.name.toLowerCase())) files.push(child);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}
