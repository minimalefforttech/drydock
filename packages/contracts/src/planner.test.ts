/**
 * Planner contract tests: the anchor grammar and file-kind mapping.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  describePlanAnchor,
  formatPlanAnchor,
  parsePlanAnchor,
  plannerImageMime,
  plannerKindForFile
} from "./planner.js";

test("anchor grammar parses and round-trips every kind", () => {
  assert.deepEqual(parsePlanAnchor("block:3"), { kind: "block", index: 3 });
  assert.deepEqual(parsePlanAnchor("node:Gateway_1"), { kind: "node", nodeId: "Gateway_1" });
  assert.deepEqual(parsePlanAnchor("point:0.5,0.25"), { kind: "point", x: 0.5, y: 0.25 });
  assert.deepEqual(parsePlanAnchor("region:0,0.14,0.25,0.83"), { kind: "region", x: 0, y: 0.14, width: 0.25, height: 0.83 });

  for (const anchor of ["block:12", "node:auth-svc", "point:0.061,0.55", "region:0.06,0.55,0.6,0.16"]) {
    const parsed = parsePlanAnchor(anchor);
    assert.ok(parsed, anchor);
    assert.equal(formatPlanAnchor(parsed), anchor);
    assert.equal(parsePlanAnchor(formatPlanAnchor(parsed)) !== null, true);
  }
});

test("anchor grammar rejects everything outside it", () => {
  for (const bad of [
    "block:0",
    "block:-1",
    "block:1.5",
    "block:",
    "node:",
    "node:has spaces",
    "node:<script>",
    "point:0.5",
    "point:2,0.5",
    "point:0.5,-0.1",
    "region:0.1,0.1,0.5",
    "region:0.1,0.1,0.5,1.5",
    "line:12",
    "block",
    ""
  ]) {
    assert.equal(parsePlanAnchor(bad), null, bad);
  }
});

test("describePlanAnchor renders reviewer-facing text", () => {
  assert.equal(describePlanAnchor("block:3"), "block 3");
  assert.equal(describePlanAnchor("node:Gateway"), "node Gateway");
  assert.equal(describePlanAnchor("point:0.5,0.25"), "point 50%,25%");
  assert.equal(describePlanAnchor("region:0.06,0.55,0.6,0.16"), "region 6%,55% 60%×16%");
  // Unparseable anchors fall back to the raw string rather than throwing.
  assert.equal(describePlanAnchor("weird"), "weird");
});

test("file names map to artifact kinds", () => {
  assert.equal(plannerKindForFile("architecture/overview.md"), "document");
  assert.equal(plannerKindForFile("flow.mmd"), "diagram");
  assert.equal(plannerKindForFile("flow.MERMAID"), "diagram");
  assert.equal(plannerKindForFile("ui/login.html"), "prototype");
  assert.equal(plannerKindForFile("ui/mock.png"), "image");
  assert.equal(plannerKindForFile("ui/mock.webp"), "image");
  assert.equal(plannerKindForFile("notes.txt"), null);
  assert.equal(plannerImageMime("a.svg"), "image/svg+xml");
  assert.equal(plannerImageMime("a.md"), null);
});
