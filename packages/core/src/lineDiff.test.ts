/**
 * Unit tests for countLineChanges: identical, pure insert/delete, modify,
 * mixed, CRLF/LF equivalence, empty-file edges, and the oversized fallback.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { countLineChanges } from "./lineDiff.js";

test("identical content reports no changes", () => {
  assert.deepEqual(countLineChanges("a\nb\nc", "a\nb\nc"), { added: 0, removed: 0 });
});

test("pure insertion counts only added lines", () => {
  assert.deepEqual(countLineChanges("a\nb", "a\nx\ny\nb"), { added: 2, removed: 0 });
});

test("pure deletion counts only removed lines", () => {
  assert.deepEqual(countLineChanges("a\nb\nc\nd", "a\nd"), { added: 0, removed: 2 });
});

test("a modified line is one add and one remove", () => {
  assert.deepEqual(countLineChanges("a\nb\nc", "a\nB\nc"), { added: 1, removed: 1 });
});

test("mixed insert, delete, and modify", () => {
  // b removed, c modified to C, e inserted after d.
  assert.deepEqual(countLineChanges("a\nb\nc\nd", "a\nC\nd\ne"), { added: 2, removed: 2 });
});

test("CRLF and LF encodings of the same content diff as unchanged", () => {
  assert.deepEqual(countLineChanges("a\r\nb\r\nc", "a\nb\nc"), { added: 0, removed: 0 });
});

test("only line-ending change on a modified line is not double-counted", () => {
  // Same lines, one truly changed; ending style differs but that must not add churn.
  assert.deepEqual(countLineChanges("a\r\nb\r\nc", "a\nB\nc"), { added: 1, removed: 1 });
});

test("empty file to content: the lone empty line is replaced", () => {
  // "" splits to [""] (one empty line), "x\ny" to ["x","y"]: the LCS is empty,
  // so the empty line is a delete and both content lines are inserts.
  assert.deepEqual(countLineChanges("", "x\ny"), { added: 2, removed: 1 });
});

test("content to empty file: content lines deleted, one empty line inserted", () => {
  assert.deepEqual(countLineChanges("x\ny", ""), { added: 1, removed: 2 });
});

test("two empty files report no changes", () => {
  assert.deepEqual(countLineChanges("", ""), { added: 0, removed: 0 });
});

test("reordering counts real churn, not a length delta", () => {
  // Same three lines reversed: a naive length delta would say 0; a real diff
  // sees the moved lines as edits.
  const result = countLineChanges("a\nb\nc", "c\nb\na");
  assert.equal(result.added, 2);
  assert.equal(result.removed, 2);
});

test("oversized input falls back to net-delta approximation", () => {
  // 20_001 lines on the after side trips the cap; the fallback reports only the
  // net surplus (2 more lines) as added, ignoring intra-file churn.
  const before = Array.from({ length: 20_001 }, (_unused, index) => `L${String(index)}`).join("\n");
  const after = Array.from({ length: 20_003 }, (_unused, index) => `changed${String(index)}`).join("\n");
  assert.deepEqual(countLineChanges(before, after), { added: 2, removed: 0 });
});

test("edit-distance cap falls back to net delta on near-total rewrites", () => {
  // Two same-length, fully dissimilar files exceed MAX_EDIT_DISTANCE (5k):
  // the exact search bails and the net-delta approximation reports zero
  // forced churn for equal lengths rather than stalling the host.
  const before = Array.from({ length: 6000 }, (_, i) => `left-${String(i)}`).join("\n");
  const after = Array.from({ length: 6000 }, (_, i) => `right-${String(i)}`).join("\n");
  assert.deepEqual(countLineChanges(before, after), { added: 0, removed: 0 });
  // Unequal lengths still report the surplus.
  const afterLonger = `${after}\nextra-1\nextra-2`;
  assert.deepEqual(countLineChanges(before, afterLonger), { added: 2, removed: 0 });
});
