/**
 * Reference-scan tests over fixture package definitions.
 *
 * The fixtures spell `X:` the way real package.py files do: escaped backslashes,
 * forward slashes, single and double quotes, and the `FR_ASSET_API_SILEX_ROOT`
 * env assignment the reference scan found on FR-ONYX (upgrade-plan.md, F1).
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { extractEnvAssignments, extractXReferences, rootClassOf, scanReferences } from "./referenceScan.js";
import type { ReferenceClass } from "./referenceScan.js";

const SILEX_PACKAGE = `name = "fr_asset_api"
version = "1.4.0"

def commands():
    env.FR_ASSET_API_SILEX_ROOT = "X:\\\\Projects"
    env.PYTHONPATH.append("X:\\\\Pipeline\\\\rez\\\\packages\\\\internal\\\\fr_asset_api\\\\1.4.0\\\\python")
`;

const TOOLS_PACKAGE = `name = "fr_tools"

def commands():
    env["FR_TOOLS_CONFIG"] = 'X:/Pipeline/rez/configs/rezconfig.py'
    env.FR_SHOW_ROOT = 'X:/Projects/showA'
    # a bare reference in a comment still counts as a reference
    # see x:\\Library\\luts for the LUT set
`;

async function makeFixture(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "drydock-xroot-"));
  const silex = path.join(root, "fr_asset_api", "1.4.0");
  const tools = path.join(root, "fr_tools", "2.0.0");
  await mkdir(silex, { recursive: true });
  await mkdir(tools, { recursive: true });
  await writeFile(path.join(silex, "package.py"), SILEX_PACKAGE, "utf8");
  await writeFile(path.join(tools, "package.py"), TOOLS_PACKAGE, "utf8");
  // Not a package definition: must not be read by default.
  await writeFile(path.join(tools, "notes.txt"), "X:\\Ignored\\me\n", "utf8");
  return { root, cleanup: async (): Promise<void> => rm(root, { recursive: true, force: true }) };
}

function classFor(classes: readonly ReferenceClass[], root: string): ReferenceClass {
  const found = classes.find((entry) => entry.root.toLowerCase() === root.toLowerCase());
  if (found === undefined) throw new Error(`no class for ${root}; got ${classes.map((c) => c.root).join(", ")}`);
  return found;
}

test("scan classifies X: references by top-level root", async () => {
  const fixture = await makeFixture();
  try {
    const scan = await scanReferences(fixture.root);
    assert.equal(scan.filesScanned, 2);
    assert.deepEqual(scan.classes.map((entry) => entry.root).sort(), ["Library", "Pipeline", "Projects"]);

    const pipeline = classFor(scan.classes, "Pipeline");
    assert.equal(pipeline.count, 2);
    assert.equal(pipeline.examples.length, 2);
    assert.ok(pipeline.sampleRefs.some((ref) => ref.includes("rezconfig.py")), pipeline.sampleRefs.join(" | "));

    const projects = classFor(scan.classes, "Projects");
    assert.equal(projects.count, 2);

    // Case-insensitive drive letter, and the class survives `x:` spelling.
    const library = classFor(scan.classes, "Library");
    assert.equal(library.count, 1);
    assert.deepEqual(library.examples, [path.join("fr_tools", "2.0.0", "package.py")]);
  } finally {
    await fixture.cleanup();
  }
});

test("env assignments carry the variable name into the class", async () => {
  const fixture = await makeFixture();
  try {
    const scan = await scanReferences(fixture.root);
    assert.deepEqual(classFor(scan.classes, "Projects").envVars, ["FR_ASSET_API_SILEX_ROOT", "FR_SHOW_ROOT"]);
    assert.deepEqual(classFor(scan.classes, "Pipeline").envVars, ["FR_TOOLS_CONFIG", "PYTHONPATH"]);
    assert.deepEqual(classFor(scan.classes, "Library").envVars, []);
  } finally {
    await fixture.cleanup();
  }
});

test("only the named definition files are read", async () => {
  const fixture = await makeFixture();
  try {
    const defaultScan = await scanReferences(fixture.root);
    assert.equal(defaultScan.classes.some((entry) => entry.root === "Ignored"), false);

    const widened = await scanReferences(fixture.root, { fileNames: ["package.py", "notes.txt"] });
    assert.equal(widened.filesScanned, 3);
    assert.equal(widened.classes.some((entry) => entry.root === "Ignored"), true);
  } finally {
    await fixture.cleanup();
  }
});

test("reference extraction handles both slash styles and quoting", () => {
  assert.deepEqual(extractXReferences('a = "X:\\\\Projects"'), ["X:\\\\Projects"]);
  assert.deepEqual(extractXReferences("a = 'X:/Pipeline/rez'"), ["X:/Pipeline/rez"]);
  assert.deepEqual(extractXReferences("x:\\Library\\luts,"), ["x:\\Library\\luts"]);
  // Trailing separators are trimmed, and a bare drive names no class.
  assert.deepEqual(extractXReferences('"X:\\\\"'), []);
  // Not a drive reference: an identifier that happens to end in x.
  assert.deepEqual(extractXReferences("MAX:/foo"), []);
});

test("env assignment shapes", () => {
  assert.deepEqual(extractEnvAssignments('    env.FOO = "X:\\\\Projects"'), [{ env: "FOO", ref: "X:\\\\Projects" }]);
  assert.deepEqual(extractEnvAssignments("env['BAR'] = 'X:/Pipeline'"), [{ env: "BAR", ref: "X:/Pipeline" }]);
  assert.deepEqual(extractEnvAssignments('env.PATH.append("X:/Pipeline/bin")'), [{ env: "PATH", ref: "X:/Pipeline/bin" }]);
  assert.deepEqual(extractEnvAssignments('env.NOPE = "C:/local"'), []);
});

test("root class of a reference", () => {
  assert.equal(rootClassOf("X:\\\\Projects\\\\showA"), "Projects");
  assert.equal(rootClassOf("x:/Pipeline"), "Pipeline");
  assert.equal(rootClassOf("X:\\"), null);
  assert.equal(rootClassOf("Pipeline"), null);
});
