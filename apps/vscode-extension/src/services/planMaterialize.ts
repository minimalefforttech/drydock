/**
 * Plan → board materialization (ADR 0012): candidate extraction.
 *
 * Candidates are MARKDOWN CHECKBOX ITEMS (`- [ ] title`, `* [x] title`,
 * `1. [ ] title`) across the plan's document artifacts - an explicit,
 * greppable convention rather than heading heuristics, so what the dialog
 * proposes is exactly what the plan literally lists as work. Checked and
 * unchecked items both qualify (the checkbox state belongs to the plan, not
 * the board). Deduped case-insensitively, bounded, capped.
 */

import type { PlanArtifactDetail } from "@drydock/contracts";

const CHECKBOX_LINE = /^\s*(?:[-*+]|\d+[.)])\s*\[[ xX]\]\s+(.+?)\s*$/gm;
const MIN_TITLE = 3;
const MAX_TITLE = 160;
export const MAX_CANDIDATES = 40;

export function extractSubtaskCandidates(artifacts: readonly PlanArtifactDetail[]): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const artifact of artifacts) {
    if (artifact.kind !== "document" || artifact.content === undefined) continue;
    for (const match of artifact.content.matchAll(CHECKBOX_LINE)) {
      const raw = match[1];
      if (raw === undefined) continue;
      // Strip trailing markdown emphasis/links noise conservatively: just
      // collapse inner whitespace; the title otherwise rides verbatim.
      const title = raw.replace(/\s+/g, " ").trim();
      if (title.length < MIN_TITLE || title.length > MAX_TITLE) continue;
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(title);
      if (candidates.length >= MAX_CANDIDATES) return candidates;
    }
  }
  return candidates;
}
