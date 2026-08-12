/**
 * Unit tests for the provider registry: ride/transport/egress derivations and
 * the display-safety invariant (descriptors carry names and URLs, never
 * secret material).
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  PROVIDER_REGISTRY,
  providerDescriptor,
  providerEgressResources,
  providerTransport
} from "./providerRegistry.js";

test("native providers keep their historical transports and egress", () => {
  assert.equal(providerTransport("codex"), "codex-app-server");
  assert.equal(providerTransport("claude"), "claude-exec-json");
  // Unknown ids keep the historical codex default rather than throwing.
  assert.equal(providerTransport("mystery"), "codex-app-server");
  assert.match(providerEgressResources("codex") ?? "", /api\.openai\.com:443/);
  assert.match(providerEgressResources("claude") ?? "", /api\.anthropic\.com:443/);
});

test("riders follow the CLI they ride and declare their own egress", () => {
  assert.equal(providerDescriptor("openrouter")?.ride, "codex");
  assert.equal(providerTransport("openrouter"), "codex-app-server");
  assert.equal(providerEgressResources("openrouter"), "openrouter.ai:443");

  assert.equal(providerDescriptor("deepseek")?.ride, "claude");
  assert.equal(providerTransport("deepseek"), "claude-exec-json");
  assert.equal(providerEgressResources("deepseek"), "api.deepseek.com:443");
  assert.equal(providerDescriptor("deepseek")?.wire?.baseUrl, "https://api.deepseek.com/anthropic");

  assert.equal(providerTransport("kimi"), "claude-exec-json");
  assert.equal(providerDescriptor("kimi")?.wire?.baseUrl, "https://api.moonshot.ai/anthropic");
});

test("every descriptor is display-safe and structurally complete", () => {
  for (const descriptor of PROVIDER_REGISTRY) {
    assert.ok(descriptor.providerId.length > 0);
    assert.ok(descriptor.displayName.length > 0);
    assert.ok(descriptor.egress.length > 0, `${descriptor.providerId} must declare scoped egress`);
    for (const entry of descriptor.egress) {
      assert.match(entry, /^[a-z0-9.-]+:\d+$/, `${descriptor.providerId} egress entries are host:port`);
    }
    // Auth is either a guided OAuth flow or an API key (or both); never neither.
    assert.ok(
      descriptor.connect.oauth !== undefined || descriptor.connect.apiKey !== undefined,
      `${descriptor.providerId} must be connectable`
    );
    if (descriptor.connect.apiKey !== undefined) {
      assert.match(descriptor.connect.apiKey.keyUrl, /^https:\/\//);
    }
    // Riders must fully describe their wire; natives must not carry one.
    if (descriptor.wire !== undefined) {
      assert.match(descriptor.wire.baseUrl, /^https:\/\//);
      if (descriptor.wire.kind === "openai-compat") {
        assert.ok(descriptor.wire.envKey, `${descriptor.providerId} openai-compat wire needs envKey`);
      }
      // No compiled-in model lists: riders describe LIVE discovery instead.
      assert.ok(descriptor.discovery !== undefined, `${descriptor.providerId} rider needs live model discovery`);
      assert.match(descriptor.discovery.url, /^https:\/\//);
    }
  }
});
