import assert from "node:assert/strict";
import test from "node:test";
import type { AgentPrompt, JsonValue, RunId } from "@drydock/contracts";
import {
  CodexAppServerTransport,
  requestCodexModelCatalog,
  type CodexAppServerSession
} from "./codexAppServerTransport.js";
import type { LineJsonRpcClient } from "./jsonRpcClient.js";

test("Codex model discovery preserves advertised reasoning effort capabilities", async () => {
  const client = {
    request: async (): Promise<JsonValue> => ({
      data: [{
        id: "gpt-5.6-sol",
        model: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        description: "Detailed and polished",
        isDefault: true,
        hidden: false,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "Balanced" },
          { reasoningEffort: "xhigh", description: "Extra High" }
        ]
      }]
    })
  } as unknown as LineJsonRpcClient;

  const catalog = await requestCodexModelCatalog(client, () => "2026-07-15T00:00:00.000Z");
  assert.deepEqual(catalog.models[0], {
    id: "gpt-5.6-sol",
    displayName: "GPT-5.6-Sol",
    description: "Detailed and polished",
    isDefault: true,
    hidden: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "Balanced" },
      { reasoningEffort: "xhigh", description: "Extra High" }
    ]
  });
});

test("Codex Ultra turns use xhigh plus proactive delegation instructions", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = {
    request: async (method: string, params: unknown): Promise<JsonValue> => {
      requests.push({ method, params });
      return { turn: { id: "turn-1" } };
    }
  } as unknown as LineJsonRpcClient;
  const session = {
    client,
    threadId: "thread-1",
    cwd: "/workspace",
    providerTurnIds: new Map()
  } as unknown as CodexAppServerSession;
  const transport = new CodexAppServerTransport({
    command: "unused",
    argsForRuntime: () => [],
    cwd: "/workspace"
  });
  const prompt: AgentPrompt = {
    text: "Fix the issue",
    metadata: { model: "gpt-5.6-sol", reasoningEffort: "ultra" }
  };

  await transport.sendPrompt(session, prompt, "run-1" as RunId);

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, "turn/start");
  const params = requests[0]?.params as { effort?: string; model?: string; input?: Array<{ text?: string }> };
  assert.equal(params.model, "gpt-5.6-sol");
  assert.equal(params.effort, "xhigh");
  assert.match(params.input?.[0]?.text ?? "", /proactively delegate independent work to subagents/);
  assert.match(params.input?.[0]?.text ?? "", /Fix the issue$/);
});
