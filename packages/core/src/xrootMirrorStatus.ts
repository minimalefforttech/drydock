/**
 * Reads the curated `X:` mirror's state file for receipts.
 *
 * The mirror sync (`tools/xroot-mirror`) drops `.drydock-mirror.json` in the
 * mirror root after every run. Validation receipts cite the manifest version and
 * the sync time so evidence can never claim more than it knows (ADR 0022 edge
 * cases E1/G1): a job that ran against a stale mirror says so, and a job that
 * ran against a mirror with skipped (torn) package versions carries that list.
 *
 * Nothing here throws. An absent, unreadable, or malformed state file returns
 * null, which the UI renders as unknown with a Refresh action rather than
 * inferring green (ADR 0021 honesty rule). This file deliberately duplicates the
 * small state-file shape instead of importing from the tool: core does not
 * depend on tools, and a receipt reader must keep working if the tool is absent.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** File the mirror sync writes into the mirror root. */
export const MIRROR_STATE_FILE_NAME = ".drydock-mirror.json";

export interface MirrorStatus {
  /** Manifest version the mirror was synced from. */
  readonly manifestVersion: number;
  /** ISO timestamp of the last sync attempt. */
  readonly syncedAt: string;
  /** True only when every mirrored subtree reported a successful robocopy run. */
  readonly ok: boolean;
  /** Package versions left out of the mirror because they were mid-publish. */
  readonly skippedVersions: readonly string[];
}

/** Mirror status, or null when it cannot be established. Never throws. */
export async function readMirrorStatus(mirrorRoot: string): Promise<MirrorStatus | null> {
  let text: string;
  try {
    text = await readFile(join(mirrorRoot, MIRROR_STATE_FILE_NAME), "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const manifestVersion = record["manifestVersion"];
  const syncedAt = record["syncedAt"];
  const subtrees = record["subtrees"];
  if (typeof manifestVersion !== "number" || !Number.isFinite(manifestVersion)) return null;
  if (typeof syncedAt !== "string" || syncedAt === "") return null;
  if (!Array.isArray(subtrees)) return null;

  const ok = subtrees.every((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return false;
    return (entry as Record<string, unknown>)["ok"] === true;
  });

  const rawSkipped = record["skippedVersions"];
  const skippedVersions = Array.isArray(rawSkipped)
    ? rawSkipped.filter((value: unknown): value is string => typeof value === "string")
    : [];

  return { manifestVersion, syncedAt, ok, skippedVersions };
}
