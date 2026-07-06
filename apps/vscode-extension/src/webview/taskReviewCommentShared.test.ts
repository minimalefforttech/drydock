/**
 * Unit tests for the pure Task Review comment helpers.
 *
 * These lock the anchor convention (must mirror countFileComments) and the
 * stored↔range line conversion, including the clamping and start>end
 * normalization the gutter integration relies on.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  anchorMatchesFile,
  commentAnchor,
  GUTTER_VISIBLE_STATUSES,
  rangeToStoredLines,
  storedLinesToRange
} from "./taskReviewCommentShared.js";

test("commentAnchor builds the qualified <repo>:<path> form", () => {
  assert.equal(commentAnchor("core", "src/index.ts"), "core:src/index.ts");
});

test("anchorMatchesFile matches the qualified form", () => {
  assert.equal(anchorMatchesFile("core:src/index.ts", "core", "src/index.ts"), true);
});

test("anchorMatchesFile matches the legacy plain relative path", () => {
  assert.equal(anchorMatchesFile("src/index.ts", "core", "src/index.ts"), true);
});

test("anchorMatchesFile rejects a non-matching anchor", () => {
  assert.equal(anchorMatchesFile("core:src/other.ts", "core", "src/index.ts"), false);
  // A same-path anchor qualified by a different repo must not match.
  assert.equal(anchorMatchesFile("web:src/index.ts", "core", "src/index.ts"), false);
});

test("storedLinesToRange converts 1-based inclusive to 0-based indices", () => {
  assert.deepEqual(storedLinesToRange(1, 3), { startLine0: 0, endLine0: 2 });
  assert.deepEqual(storedLinesToRange(10, 10), { startLine0: 9, endLine0: 9 });
});

test("storedLinesToRange clamps zero and negative stored values at 0", () => {
  assert.deepEqual(storedLinesToRange(0, 0), { startLine0: 0, endLine0: 0 });
  assert.deepEqual(storedLinesToRange(-5, -1), { startLine0: 0, endLine0: 0 });
});

test("rangeToStoredLines converts 0-based indices to 1-based inclusive", () => {
  assert.deepEqual(rangeToStoredLines(0, 2), { startLine: 1, endLine: 3 });
  assert.deepEqual(rangeToStoredLines(9, 9), { startLine: 10, endLine: 10 });
});

test("rangeToStoredLines normalizes a reversed (start>end) selection", () => {
  assert.deepEqual(rangeToStoredLines(4, 1), { startLine: 2, endLine: 5 });
});

test("GUTTER_VISIBLE_STATUSES excludes terminal resolved and wont-fix", () => {
  assert.deepEqual([...GUTTER_VISIBLE_STATUSES], ["open", "acknowledged", "delegated", "blocked"]);
  assert.equal(GUTTER_VISIBLE_STATUSES.includes("resolved"), false);
  assert.equal(GUTTER_VISIBLE_STATUSES.includes("wont-fix"), false);
});
