/**
 * Unit tests for the glob→tag rule table: default+user merge validation,
 * extension-census fast path, literal names, wildcards, and tag stacking.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { DEFAULT_TAG_RULES, matchTags, mergeTagRules, type WorkspaceScan } from "./tagRules.js";

function scan(names: string[], extensions: string[]): WorkspaceScan {
  return { names: new Set(names), extensions: new Set(extensions) };
}

test("matchTags stacks multiple tags when multiple globs hit", () => {
  // A rez-packaged Maya Python repo yields rez + python + maya (+pip).
  const tags = matchTags(
    scan(["package.py", "pyproject.toml", "rig_utils.py", "hero.ma"], [".py", ".ma", ".toml"]),
    DEFAULT_TAG_RULES
  );
  assert.ok(tags.includes("rez"));
  assert.ok(tags.includes("pip"));
  assert.ok(tags.includes("python"));
  assert.ok(tags.includes("maya"));
  assert.ok(!tags.includes("node"));
});

test("matchTags handles pure-extension globs via the census and wildcards via names", () => {
  const rules = [
    { globs: ["*.usd"], tag: "usd" },
    { globs: ["SCons*"], tag: "scons" }
  ];
  assert.deepEqual(matchTags(scan(["sconstruct"], [".usd"]), rules), ["usd", "scons"]);
  assert.deepEqual(matchTags(scan(["makefile"], [".txt"]), rules), []);
});

test("mergeTagRules appends valid user rules and drops malformed entries", () => {
  const merged = mergeTagRules([
    { globs: ["*.usda"], tag: "USD" },              // tag lowercased
    { globs: [], tag: "empty" },                     // no globs -> dropped
    { globs: ["x"], tag: "" },                       // no tag -> dropped
    { globs: ["*.hda"], tag: "bad tag!" },           // invalid chars -> dropped
    "not an object"
  ]);
  assert.equal(merged.length, DEFAULT_TAG_RULES.length + 1);
  assert.deepEqual(merged[merged.length - 1], { globs: ["*.usda"], tag: "usd" });
  // Non-array input keeps the defaults untouched.
  assert.equal(mergeTagRules(undefined).length, DEFAULT_TAG_RULES.length);
});
