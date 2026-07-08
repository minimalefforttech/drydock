/**
 * withSandboxProvider must rebind the sandbox agent + egress to the new provider
 * while preserving every provider-agnostic field. Reusing the old template on a
 * provider switch is what booted Codex inside the Claude image (init timeout).
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import type { RuntimeTemplate } from "@drydock/contracts";
import {
  CLAUDE_SERVICE_NETWORK_RESOURCES,
  CODEX_SERVICE_NETWORK_RESOURCES,
  withSandboxProvider
} from "./isolatedRunTemplate.js";

const claudeTemplate: RuntimeTemplate = {
  id: "isolated-run-docker-sandbox-claude",
  name: "Isolated Run Docker Sandbox Claude",
  type: "docker-sandbox",
  network: "allowed",
  mounts: [],
  environment: {},
  adapterProviderIds: ["claude"],
  advancedOptions: {
    sandboxAgent: "claude",
    networkResources: CLAUDE_SERVICE_NETWORK_RESOURCES,
    codexNetworkResources: "keep-me"
  }
};

test("withSandboxProvider rebinds agent, egress, and tags to the target provider", () => {
  const codex = withSandboxProvider(claudeTemplate, "codex");
  assert.equal(codex.advancedOptions["sandboxAgent"], "codex");
  assert.equal(codex.advancedOptions["networkResources"], CODEX_SERVICE_NETWORK_RESOURCES);
  assert.deepEqual(codex.adapterProviderIds, ["codex"]);
  assert.equal(codex.id, "isolated-run-docker-sandbox-codex");
  assert.equal(codex.name, "Isolated Run Docker Sandbox Codex");
});

test("withSandboxProvider preserves provider-agnostic fields and does not mutate the source", () => {
  const codex = withSandboxProvider(claudeTemplate, "codex");
  // Unrelated advancedOptions carry through.
  assert.equal(codex.advancedOptions["codexNetworkResources"], "keep-me");
  // Mounts/type/network untouched.
  assert.equal(codex.mounts, claudeTemplate.mounts);
  assert.equal(codex.type, "docker-sandbox");
  assert.equal(codex.network, "allowed");
  // Source template is left intact.
  assert.equal(claudeTemplate.advancedOptions["sandboxAgent"], "claude");
  assert.equal(claudeTemplate.advancedOptions["networkResources"], CLAUDE_SERVICE_NETWORK_RESOURCES);
});
