/**
 * Candidate extraction tests (ADR 0012): checkbox items only, across
 * document artifacts, deduped, bounded, capped - nothing inferred from
 * headings or prose.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import type { PlanArtifactDetail } from "@drydock/contracts";
import { extractSubtaskCandidates, MAX_CANDIDATES } from "./planMaterialize.js";

function doc(artifactId: string, content: string, kind: PlanArtifactDetail["kind"] = "document"): PlanArtifactDetail {
  return {
    artifactId,
    relPath: `${artifactId}.md`,
    kind,
    aspectId: "architecture",
    title: artifactId,
    revision: 1,
    scriptsEnabled: false,
    collectedAt: "2026-07-12T00:00:00.000Z",
    content
  };
}

test("extracts checkbox items across documents, skipping prose, headings, and non-documents", () => {
  const candidates = extractSubtaskCandidates([
    doc("plan", [
      "# Plan",
      "Some prose that is not work.",
      "- [ ] Wire the exporter",
      "* [x] Update the allowlist   config", // checked counts; whitespace collapses
      "1. [ ] Ship the docs",
      "- a plain bullet is NOT a candidate",
      "## Tasks are not candidates either",
      "- [ ] ok" // 2 chars - below the minimum
    ].join("\n")),
    doc("diagram", "- [ ] not scanned - diagrams are not documents", "diagram"),
    doc("dupes", "- [ ] Wire the exporter\n- [ ] WIRE THE EXPORTER") // case-insensitive dedupe
  ]);
  assert.deepEqual(candidates, ["Wire the exporter", "Update the allowlist config", "Ship the docs"]);
});

test("caps the candidate list and tolerates missing content", () => {
  const many = Array.from({ length: MAX_CANDIDATES + 10 }, (_, index) => `- [ ] Item number ${String(index + 1)}`).join("\n");
  const capped = extractSubtaskCandidates([doc("many", many)]);
  assert.equal(capped.length, MAX_CANDIDATES);

  const { content: _ignored, ...noContent } = doc("empty", "");
  assert.deepEqual(extractSubtaskCandidates([noContent as PlanArtifactDetail]), []);
});
