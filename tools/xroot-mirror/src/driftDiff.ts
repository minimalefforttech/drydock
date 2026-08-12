/**
 * Drift between what packages reference and what the manifest allows.
 *
 * Edge case F2: a package that references an `X:` root outside the manifest must
 * raise a proposal, not break in the guest three minutes into a validation run.
 * This diff is the proposal's input — it is informational by construction and
 * never edits the allowlist. Roots reached through a documented redirect count
 * as covered: `X:\Projects` is named by the manifest as a stub or fixture root,
 * so a package that assigns it is expected to fail closed, not to be a surprise.
 *
 * `staleSubtrees` runs the comparison the other way: a mirrored subtree nothing
 * references any more is worth reviewing, but it is never an error — plenty of
 * real subtrees hold data rather than package definitions.
 */

import type { MirrorManifest } from "./manifest.js";
import { entryKey, pathSegments } from "./manifest.js";
import type { ReferenceScanResult } from "./referenceScan.js";
import { rootClassOf } from "./referenceScan.js";

export interface DriftNewRoot {
  /** Top-level root class referenced but not allowed, e.g. `Library`. */
  readonly root: string;
  readonly count: number;
  /** Scanned files that reference it. */
  readonly examples: readonly string[];
  /** Env vars assigned this root; a redirect proposal needs the name. */
  readonly envVars: readonly string[];
}

export interface DriftDiffResult {
  /** Referenced roots the manifest already covers. */
  readonly covered: readonly string[];
  /** Referenced roots the manifest does not cover: the proposal. */
  readonly newRoots: readonly DriftNewRoot[];
  /** Manifest subtrees whose root class never appears in the scan; informational. */
  readonly staleSubtrees: readonly string[];
}

/** Compare a reference scan against the manifest allowlist. */
export function diffReferencesAgainstManifest(
  scan: ReferenceScanResult,
  manifest: MirrorManifest
): DriftDiffResult {
  const allowed = allowedRootClasses(manifest);
  const covered: string[] = [];
  const newRoots: DriftNewRoot[] = [];

  for (const entry of scan.classes) {
    if (allowed.has(entryKey(entry.root))) {
      covered.push(entry.root);
      continue;
    }
    newRoots.push({
      root: entry.root,
      count: entry.count,
      examples: [...entry.examples],
      envVars: [...entry.envVars]
    });
  }

  const seenRoots = new Set(scan.classes.map((entry) => entryKey(entry.root)));
  const staleSubtrees = manifest.subtrees.filter((subtree) => {
    const top = pathSegments(subtree)[0];
    return top !== undefined && !seenRoots.has(entryKey(top));
  });

  return { covered, newRoots, staleSubtrees };
}

/** Root classes the manifest accounts for: subtrees, stubs, and redirect targets. */
export function allowedRootClasses(manifest: MirrorManifest): ReadonlySet<string> {
  const allowed = new Set<string>();
  for (const subtree of manifest.subtrees) addTopSegment(allowed, subtree);
  for (const stub of manifest.stubDirs) addTopSegment(allowed, stub);
  for (const redirect of manifest.redirects) {
    const root = rootClassOf(redirect.from);
    if (root !== null) allowed.add(entryKey(root));
    else addTopSegment(allowed, redirect.from);
  }
  return allowed;
}

function addTopSegment(target: Set<string>, entry: string): void {
  const top = pathSegments(entry)[0];
  if (top !== undefined) target.add(entryKey(top));
}
