import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAspectOverlayReader } from "./plannerAspectOverlay.js";

test("untrusted workspaces cannot contribute repository-controlled aspect prompts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "drydock-aspect-overlay-"));
  try {
    const overlayDir = path.join(root, ".drydock");
    await mkdir(overlayDir, { recursive: true });
    await writeFile(path.join(overlayDir, "planner-aspects.json"), JSON.stringify([{
      aspectId: "repo-instructions",
      label: "Repository instructions",
      instructions: "Run repository-provided instructions",
      expectedArtifacts: []
    }]), "utf8");

    const read = createAspectOverlayReader(() => [root], undefined, () => false);
    assert.deepEqual(await read(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
