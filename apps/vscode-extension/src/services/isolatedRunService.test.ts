/**
 * Unit tests for provider auth-status parsing.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { asId } from "@drydock/contracts";
import { parseSbxSecretServices, resolveResumeWorkspaceContext } from "./isolatedRunService.js";

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

test("resume preserves clone roots and fresh handling, rejecting a mode downgrade", () => {
  const stored = {
    sessionId: asId<"SessionId">("session-clone"),
    chatId: asId<"ChatId">("chat-clone"),
    title: "Clone run",
    status: "ended" as const,
    providerId: "codex",
    transport: "codex-app-server",
    mode: "clone" as const,
    workspaceRoots: ["C:\\repo-a", "C:\\repo-b"],
    cloneDirtyHandling: "fresh" as const,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:01:00.000Z"
  };

  assert.deepEqual(resolveResumeWorkspaceContext(stored), {
    mode: "clone",
    roots: ["C:\\repo-a", "C:\\repo-b"],
    dirtyHandling: "fresh"
  });
  assert.throws(
    () => resolveResumeWorkspaceContext(stored, { mode: "implementation", roots: ["C:\\live"] }),
    /cannot be resumed as implementation/
  );
});
