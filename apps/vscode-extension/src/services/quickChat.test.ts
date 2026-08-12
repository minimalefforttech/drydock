import assert from "node:assert/strict";
import { test } from "node:test";
import { quickChatTaskTitle, resolveQuickChatModel } from "./quickChatShared.js";

test("quickChatTaskTitle takes the first non-empty line, collapsed and capped", () => {
  assert.equal(quickChatTaskTitle("Fix the signup validation regression"), "Fix the signup validation regression");
  assert.equal(quickChatTaskTitle("\n\n  spaced   out\ttitle  \nsecond line"), "spaced out title");
  const long = "x".repeat(80);
  const titled = quickChatTaskTitle(long);
  assert.ok(titled.endsWith("…"));
  assert.ok(titled.length <= 49);
  assert.equal(quickChatTaskTitle("   \n  "), "Quick chat");
});

test("resolveQuickChatModel prefers a stored model whose provider still exists", () => {
  const catalogs = [
    { providerId: "claude", models: [{ id: "sonnet", isDefault: true, hidden: false }] },
    { providerId: "codex", models: [{ id: "gpt", isDefault: true, hidden: false }] }
  ] as const;
  assert.deepEqual(
    resolveQuickChatModel(JSON.stringify({ providerId: "codex", model: "gpt" }), catalogs),
    { providerId: "codex", model: "gpt" }
  );
});

test("resolveQuickChatModel falls back to the catalog on unknown provider or corrupt row", () => {
  const catalogs = [
    {
      providerId: "claude",
      models: [
        { id: "hidden-one", isDefault: false, hidden: true },
        { id: "sonnet", isDefault: true, hidden: false },
        { id: "haiku", isDefault: false, hidden: false }
      ]
    }
  ] as const;
  assert.deepEqual(resolveQuickChatModel(JSON.stringify({ providerId: "gone" }), catalogs), {
    providerId: "claude",
    model: "sonnet"
  });
  assert.deepEqual(resolveQuickChatModel("{not json", catalogs), { providerId: "claude", model: "sonnet" });
  assert.equal(resolveQuickChatModel(null, []), undefined);
});
