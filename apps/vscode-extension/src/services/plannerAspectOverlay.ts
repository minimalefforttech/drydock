/**
 * Repo aspect packs (ADR 0012, open call 4): a department checks
 * `.drydock/planner-aspects.json` into a repo and every teammate's planner
 * offers those aspects read-only, beside (never instead of) the SQLite
 * registry. The file is an array of aspects:
 *
 *   [{ "aspectId": "brand-review", "label": "Brand review",
 *      "instructions": "…", "expectedArtifacts": ["Brand notes (document)"] }]
 *
 * Anything malformed is skipped quietly - an overlay must never break the
 * panel. Ids are slugs (they double as plan/<aspectId>/ directories); a SQLite
 * row with the same id wins the merge (enforced by PlannerAppService).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PlanAspectRecord } from "@drydock/contracts";

const OVERLAY_RELATIVE_PATH = [".drydock", "planner-aspects.json"];
const ASPECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OVERLAY_SORT_BASE = 100;

/**
 * Builds the overlay reader PlannerAppService consumes. `roots` is re-read on
 * every call so workspace-folder changes take effect without a reload.
 */
export function createAspectOverlayReader(
  roots: () => readonly string[],
  resolveFile: (root: string, filePath: string) => string | undefined = (_root, filePath) => filePath,
  isWorkspaceTrusted: () => boolean = () => true
): () => Promise<readonly PlanAspectRecord[]> {
  return async () => {
    // Aspect instructions become agent prompts. Treat them as executable
    // repository content, matching the recipe-overlay trust boundary.
    if (!isWorkspaceTrusted()) return [];
    const merged: PlanAspectRecord[] = [];
    const seen = new Set<string>();
    for (const root of roots()) {
      const filePath = resolveFile(root, path.join(root, ...OVERLAY_RELATIVE_PATH));
      if (filePath === undefined) continue;
      for (const aspect of await readOverlayFile(filePath)) {
        if (!seen.has(aspect.aspectId)) {
          seen.add(aspect.aspectId);
          merged.push(aspect);
        }
      }
    }
    return merged;
  };
}

async function readOverlayFile(filePath: string): Promise<PlanAspectRecord[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const aspects: PlanAspectRecord[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const aspectId = record["aspectId"];
    const label = record["label"];
    const instructions = record["instructions"];
    if (typeof aspectId !== "string" || !ASPECT_ID_RE.test(aspectId)) continue;
    if (typeof label !== "string" || label.length === 0 || label.length > 200) continue;
    if (typeof instructions !== "string" || instructions.length === 0 || instructions.length > 20_000) continue;
    const rawExpected = record["expectedArtifacts"];
    const expectedArtifacts = Array.isArray(rawExpected)
      ? rawExpected.filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 200).slice(0, 20)
      : [];
    aspects.push({
      aspectId,
      label,
      instructions,
      expectedArtifacts,
      sortOrder: OVERLAY_SORT_BASE + aspects.length,
      archived: false,
      seeded: false
    });
  }
  return aspects;
}
