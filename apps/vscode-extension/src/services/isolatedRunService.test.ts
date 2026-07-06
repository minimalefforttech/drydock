/**
 * Unit tests for provider auth-status parsing.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { parseSbxSecretServices } from "./isolatedRunService.js";

test("sbx secret ls parsing extracts configured service names", () => {
  const stdout = [
    "SCOPE      TYPE      NAME     SECRET",
    "(global)   service   openai   (oauth configured)",
    "(global)   service   Anthropic   (api key configured)",
    "(global)   registry  ghcr.io  (password configured)",
    "my-sandbox service   github   (token configured)"
  ].join("\n");

  const services = parseSbxSecretServices(stdout);

  assert.equal(services.has("openai"), true);
  assert.equal(services.has("anthropic"), true);
  assert.equal(services.has("github"), true);
  assert.equal(services.has("ghcr.io"), false);
});

test("empty or headers-only output yields no services", () => {
  assert.equal(parseSbxSecretServices("SCOPE TYPE NAME SECRET").size, 0);
  assert.equal(parseSbxSecretServices("").size, 0);
});
