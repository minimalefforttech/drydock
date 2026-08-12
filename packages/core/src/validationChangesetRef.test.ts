/**
 * Changeset-ref tests (ADR 0022): the three properties evidence depends on -
 * order independence, distinctness on any change, and a deterministic empty
 * case.
 */

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import test from "node:test";
import { computeChangesetRef } from "./validationChangesetRef.js";

const a = { repoName: "pipeline", patchSha256: "aaaa1111" };
const b = { repoName: "tools", patchSha256: "bbbb2222" };
const c = { repoName: "shaders", patchSha256: "cccc3333" };

test("the ref does not depend on the order repositories are listed in", () => {
  const forward = computeChangesetRef([a, b, c]);
  assert.equal(computeChangesetRef([c, b, a]), forward);
  assert.equal(computeChangesetRef([b, a, c]), forward);
});

test("changing any repo's patch, name, or membership changes the ref", () => {
  const base = computeChangesetRef([a, b]);
  assert.notEqual(computeChangesetRef([a, { ...b, patchSha256: "bbbb2223" }]), base);
  assert.notEqual(computeChangesetRef([a, { ...b, repoName: "tools2" }]), base);
  assert.notEqual(computeChangesetRef([a]), base);
  assert.notEqual(computeChangesetRef([a, b, c]), base);
});

test("the same parts always hash to the same 64-char hex ref", () => {
  const first = computeChangesetRef([a, b]);
  assert.equal(computeChangesetRef([{ ...a }, { ...b }]), first);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test("an empty changeset is the sha256 of the empty string, not an error", () => {
  const empty = createHash("sha256").update("", "utf8").digest("hex");
  assert.equal(computeChangesetRef([]), empty);
});

test("a single repo whose patch changed supersedes its own earlier ref", () => {
  // The D2 supersession check is exactly this comparison.
  const before = computeChangesetRef([a]);
  const after = computeChangesetRef([{ ...a, patchSha256: "aaaa1112" }]);
  assert.notEqual(after, before);
});
