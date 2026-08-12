/**
 * Drift-diff tests: covered roots stay quiet, unknown roots become a proposal
 * (edge case F2), and a mirrored subtree nobody references is reported without
 * being called an error.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { allowedRootClasses, diffReferencesAgainstManifest } from "./driftDiff.js";
import type { MirrorManifest } from "./manifest.js";
import type { ReferenceScanResult } from "./referenceScan.js";

const manifest: MirrorManifest = {
  version: 4,
  updatedAt: "2026-08-12T09:00:00.000Z",
  sourceRoot: "P:\\",
  mirrorRoot: "D:\\pkgroot",
  shareName: "pkgroot",
  subtrees: ["Pipeline\\rez\\packages\\internal", "Archive\\retired"],
  stubDirs: ["Projects"],
  redirects: [{ env: "STUDIO_ASSET_API_ROOT", from: "P:\\Projects", mode: "stub" }]
};

const scan: ReferenceScanResult = {
  roots: ["P:\\Pipeline\\rez\\packages\\internal"],
  filesScanned: 12,
  refsFound: 9,
  classes: [
    { root: "Pipeline", count: 6, examples: ["pipe_core\\1.0.0\\package.py"], sampleRefs: ["P:\\Pipeline\\rez"], envVars: [] },
    {
      root: "Projects",
      count: 2,
      examples: ["pipe_asset_api\\1.4.0\\package.py"],
      sampleRefs: ["P:\\Projects"],
      envVars: ["STUDIO_ASSET_API_ROOT"]
    },
    {
      root: "Library",
      count: 1,
      examples: ["pipe_tools\\2.0.0\\package.py"],
      sampleRefs: ["p:\\Library\\luts"],
      envVars: ["STUDIO_LUT_ROOT"]
    }
  ]
};

test("subtrees, stubs and redirect targets all count as covered", () => {
  const allowed = allowedRootClasses(manifest);
  assert.deepEqual([...allowed].sort(), ["archive", "pipeline", "projects"]);

  const drift = diffReferencesAgainstManifest(scan, manifest);
  assert.deepEqual(drift.covered, ["Pipeline", "Projects"]);
});

test("an unknown root surfaces as a proposal with its env var", () => {
  const drift = diffReferencesAgainstManifest(scan, manifest);
  assert.deepEqual(drift.newRoots, [
    {
      root: "Library",
      count: 1,
      examples: ["pipe_tools\\2.0.0\\package.py"],
      envVars: ["STUDIO_LUT_ROOT"]
    }
  ]);
});

test("a mirrored subtree nothing references is reported as stale", () => {
  const drift = diffReferencesAgainstManifest(scan, manifest);
  assert.deepEqual(drift.staleSubtrees, ["Archive\\retired"]);
});

test("nothing referenced means every subtree reads stale and nothing is new", () => {
  const empty: ReferenceScanResult = { roots: [], filesScanned: 0, refsFound: 0, classes: [] };
  const drift = diffReferencesAgainstManifest(empty, manifest);
  assert.deepEqual(drift.covered, []);
  assert.deepEqual(drift.newRoots, []);
  assert.deepEqual(drift.staleSubtrees, ["Pipeline\\rez\\packages\\internal", "Archive\\retired"]);
});
