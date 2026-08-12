/**
 * Reference-scan tests over fixture package definitions.
 *
 * The fixtures spell `P:` — the default pipeline drive — the way real
 * package.py files do: escaped backslashes, forward slashes, single and double
 * quotes, and the `STUDIO_ASSET_API_ROOT` env assignment the reference scan
 * found on STUDIO-ONYX (upgrade-plan.md, F1).
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { extractDriveReferences, extractEnvAssignments, rootClassOf, scanReferences } from "./referenceScan.js";
import type { ReferenceClass } from "./referenceScan.js";

const ASSET_API_PACKAGE = `name = "pipe_asset_api"
version = "1.4.0"

def commands():
    env.STUDIO_ASSET_API_ROOT = "P:\\\\Projects"
    env.PYTHONPATH.append("P:\\\\Pipeline\\\\rez\\\\packages\\\\internal\\\\pipe_asset_api\\\\1.4.0\\\\python")
`;

const TOOLS_PACKAGE = `name = "pipe_tools"

def commands():
    env["STUDIO_TOOLS_CONFIG"] = 'P:/Pipeline/rez/configs/rezconfig.py'
    env.STUDIO_SHOW_ROOT = 'P:/Projects/showA'
    # a bare reference in a comment still counts as a reference
    # see p:\\Library\\luts for the LUT set
`;

async function makeFixture(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "drydock-pkgroot-"));
  const assetApi = path.join(root, "pipe_asset_api", "1.4.0");
  const tools = path.join(root, "pipe_tools", "2.0.0");
  await mkdir(assetApi, { recursive: true });
  await mkdir(tools, { recursive: true });
  await writeFile(path.join(assetApi, "package.py"), ASSET_API_PACKAGE, "utf8");
  await writeFile(path.join(tools, "package.py"), TOOLS_PACKAGE, "utf8");
  // Not a package definition: must not be read by default.
  await writeFile(path.join(tools, "notes.txt"), "P:\\Ignored\\me\n", "utf8");
  return { root, cleanup: async (): Promise<void> => rm(root, { recursive: true, force: true }) };
}

function classFor(classes: readonly ReferenceClass[], root: string): ReferenceClass {
  const found = classes.find((entry) => entry.root.toLowerCase() === root.toLowerCase());
  if (found === undefined) throw new Error(`no class for ${root}; got ${classes.map((c) => c.root).join(", ")}`);
  return found;
}

test("scan classifies P: references by top-level root", async () => {
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

    // Case-insensitive drive letter, and the class survives `p:` spelling.
    const library = classFor(scan.classes, "Library");
    assert.equal(library.count, 1);
    assert.deepEqual(library.examples, [path.join("pipe_tools", "2.0.0", "package.py")]);
  } finally {
    await fixture.cleanup();
  }
});

test("env assignments carry the variable name into the class", async () => {
  const fixture = await makeFixture();
  try {
    const scan = await scanReferences(fixture.root);
    assert.deepEqual(classFor(scan.classes, "Projects").envVars, ["STUDIO_ASSET_API_ROOT", "STUDIO_SHOW_ROOT"]);
    assert.deepEqual(classFor(scan.classes, "Pipeline").envVars, ["PYTHONPATH", "STUDIO_TOOLS_CONFIG"]);
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
  assert.deepEqual(extractDriveReferences('a = "P:\\\\Projects"'), ["P:\\\\Projects"]);
  assert.deepEqual(extractDriveReferences("a = 'P:/Pipeline/rez'"), ["P:/Pipeline/rez"]);
  assert.deepEqual(extractDriveReferences("p:\\Library\\luts,"), ["p:\\Library\\luts"]);
  // Trailing separators are trimmed, and a bare drive names no class.
  assert.deepEqual(extractDriveReferences('"P:\\\\"'), []);
  // Not a drive reference: an identifier that happens to end in p.
  assert.deepEqual(extractDriveReferences("MAP:/foo"), []);
  // The drive letter is configurable: the default ignores other letters, but an
  // explicit driveLetter option matches them instead.
  assert.deepEqual(extractDriveReferences("Q:\\Pipeline\\rez"), []);
  assert.deepEqual(extractDriveReferences("Q:\\Pipeline\\rez", "Q"), ["Q:\\Pipeline\\rez"]);
});

test("env assignment shapes", () => {
  assert.deepEqual(extractEnvAssignments('    env.FOO = "P:\\\\Projects"'), [{ env: "FOO", ref: "P:\\\\Projects" }]);
  assert.deepEqual(extractEnvAssignments("env['BAR'] = 'P:/Pipeline'"), [{ env: "BAR", ref: "P:/Pipeline" }]);
  assert.deepEqual(extractEnvAssignments('env.PATH.append("P:/Pipeline/bin")'), [{ env: "PATH", ref: "P:/Pipeline/bin" }]);
  assert.deepEqual(extractEnvAssignments('env.NOPE = "C:/local"'), []);
});

test("root class of a reference", () => {
  assert.equal(rootClassOf("P:\\\\Projects\\\\showA"), "Projects");
  assert.equal(rootClassOf("p:/Pipeline"), "Pipeline");
  assert.equal(rootClassOf("P:\\"), null);
  assert.equal(rootClassOf("Pipeline"), null);
});
