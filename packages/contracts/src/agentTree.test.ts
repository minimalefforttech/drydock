/**
 * Reducer + projection tests for the subagent lineage contracts (see docs/adr/0002-product-owned-orchestration.md). The
 * codex scenario mirrors the 2026-07-05 live probe (two children, one real
 * failure); the parity test guarantees the webview lens (lines) and the host
 * counters (events) see the same tree.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import type { AgentEvent } from "./events.js";
import { summarizeAgentEvent } from "./events.js";
import { asId } from "./ids.js";
import {
  reduceAgentTree,
  ROOT_AGENT_NODE_ID,
  subagentReportingForTransport,
  treeSourceFromEvent,
  treeSourceFromLine
} from "./agentTree.js";

let sequence = 0;
function event(partial: Record<string, unknown>): AgentEvent {
  sequence += 1;
  return {
    id: asId<"EventId">(`event-${String(sequence)}`),
    sessionId: asId<"SessionId">("session-1"),
    runId: asId<"RunId">("run-1"),
    agentRole: "worker",
    createdAt: `2026-07-05T10:00:${String(sequence).padStart(2, "0")}.000Z`,
    ...partial
  } as unknown as AgentEvent;
}

/** The probe shape: spawn scribe + lister, scribe edits a file, lister's command fails. */
function probeEvents(): AgentEvent[] {
  return [
    event({ type: "agent.text", text: "Fanning out.", final: true }),
    event({ type: "agent.spawn", nodeId: "t-scribe", label: "scribe", model: "gpt-5.5", promptPreview: "write a haiku" }),
    event({ type: "agent.spawn", nodeId: "t-lister", label: "lister", model: "gpt-5.5" }),
    event({ type: "agent.text", text: "Writing haiku.", final: true, agentPath: ["t-scribe"] }),
    event({ type: "agent.file_edit", path: "haiku.txt", changeKind: "add", agentPath: ["t-scribe"] }),
    event({ type: "agent.command", command: ["pwsh", "-Command", "ls"], status: "started", agentPath: ["t-lister"] }),
    event({ type: "agent.command", command: ["pwsh", "-Command", "ls"], status: "failed", exitCode: -1, agentPath: ["t-lister"] }),
    event({ type: "agent.tool_call", toolName: "web_search", status: "started", toolUseId: "ws-1" }),
    event({ type: "agent.node_done", nodeId: "t-scribe", status: "completed", resultPreview: "nested spawning unsupported", usage: { totalTokens: 28192 } }),
    event({ type: "agent.node_done", nodeId: "t-lister", status: "failed", resultPreview: "sandbox process failed" }),
    event({ type: "agent.done", status: "completed", usage: { totalTokens: 74219 } })
  ];
}

test("reduceAgentTree builds the probe-shaped tree from events", () => {
  const tree = reduceAgentTree(probeEvents().map(treeSourceFromEvent));
  assert.equal(tree.nodes.length, 3);

  const [root, scribe, lister] = tree.nodes;
  assert.ok(root && scribe && lister);

  assert.equal(root.nodeId, ROOT_AGENT_NODE_ID);
  assert.equal(root.kind, "root");
  assert.equal(root.status, "completed");
  assert.equal(root.counts.toolCalls, 1); // web_search, counted once on "started"
  assert.deepEqual(root.usage, { totalTokens: 74219 });

  assert.equal(scribe.parentId, ROOT_AGENT_NODE_ID);
  assert.equal(scribe.label, "scribe");
  assert.equal(scribe.model, "gpt-5.5");
  assert.equal(scribe.status, "completed");
  assert.equal(scribe.counts.fileEdits, 1);
  assert.equal(scribe.promptPreview, "write a haiku");
  assert.equal(scribe.resultPreview, "nested spawning unsupported");
  assert.deepEqual(scribe.usage, { totalTokens: 28192 });
  assert.ok(scribe.endedAt);

  assert.equal(lister.status, "failed");
  assert.equal(lister.counts.commands, 1); // started+failed pair counts once
  assert.equal(lister.resultPreview, "sandbox process failed");
  assert.equal(lister.lastCommand, "ls");
  assert.equal(lister.lastActivityAt, "2026-07-05T10:00:10.000Z");
});

test("line-derived and event-derived trees agree (lens/host parity)", () => {
  const events = probeEvents();
  const fromEvents = reduceAgentTree(events.map(treeSourceFromEvent));
  const fromLines = reduceAgentTree(events.map((entry) => treeSourceFromLine(summarizeAgentEvent(entry))));

  assert.equal(fromLines.nodes.length, fromEvents.nodes.length);
  for (let index = 0; index < fromEvents.nodes.length; index += 1) {
    const expected = fromEvents.nodes[index];
    const actual = fromLines.nodes[index];
    assert.ok(expected && actual);
    assert.equal(actual.nodeId, expected.nodeId);
    assert.equal(actual.parentId, expected.parentId);
    assert.equal(actual.status, expected.status);
    assert.deepEqual(actual.counts, expected.counts);
    assert.equal(actual.resultPreview, expected.resultPreview);
    assert.deepEqual(actual.usage, expected.usage);
    // Labels differ only where lines can't carry them (none today).
    assert.equal(actual.label, expected.label);
  }
});

test("depth-N paths synthesize unseen ancestors instead of dropping", () => {
  const tree = reduceAgentTree([
    event({ type: "agent.tool_call", toolName: "Grep", status: "started", agentPath: ["outer", "inner"] })
  ].map(treeSourceFromEvent));

  assert.deepEqual(tree.nodes.map((node) => node.nodeId), [ROOT_AGENT_NODE_ID, "outer", "inner"]);
  const outer = tree.nodes[1];
  const inner = tree.nodes[2];
  assert.ok(outer && inner);
  assert.equal(outer.parentId, ROOT_AGENT_NODE_ID);
  assert.equal(inner.parentId, "outer");
  assert.equal(inner.counts.toolCalls, 1);
  assert.equal(inner.lastCommand, "Grep");
  // Synthesized nodes get a placeholder label from the id tail.
  assert.ok(outer.label.includes("outer"));
});

test("command names unwrap common shell launchers", () => {
  const tree = reduceAgentTree([
    event({ type: "agent.spawn", nodeId: "shell", label: "shell" }),
    event({ type: "agent.command", command: ["bash", "-lc", "grep -R TODO ."], status: "started", agentPath: ["shell"] }),
    event({ type: "agent.command", command: ["pwsh", "-Command", "npm test"], status: "started", agentPath: ["shell"] }),
    event({ type: "agent.command", command: ["cmd.exe", "/c", "dir"], status: "started", agentPath: ["shell"] })
  ].map(treeSourceFromEvent));

  const shell = tree.nodes.find((node) => node.nodeId === "shell");
  assert.equal(shell?.counts.commands, 3);
  assert.equal(shell?.lastCommand, "dir");
});

test("terminal node status never downgrades; root end marks stragglers unknown", () => {
  const tree = reduceAgentTree([
    event({ type: "agent.spawn", nodeId: "a", label: "a" }),
    event({ type: "agent.spawn", nodeId: "b", label: "b" }),
    event({ type: "agent.node_done", nodeId: "a", status: "failed" }),
    event({ type: "agent.node_done", nodeId: "a", status: "completed" }), // late duplicate must not downgrade
    event({ type: "agent.done", status: "completed" })
  ].map(treeSourceFromEvent));

  const a = tree.nodes.find((node) => node.nodeId === "a");
  const b = tree.nodes.find((node) => node.nodeId === "b");
  assert.equal(a?.status, "failed");
  // b never reported terminal and the stream is over: honesty over guessing.
  assert.equal(b?.status, "unknown");
});

test("a live turn keeps unspawned-but-active nodes running", () => {
  const tree = reduceAgentTree([
    event({ type: "agent.spawn", nodeId: "a", label: "a" }),
    event({ type: "agent.text", text: "working", final: true, agentPath: ["a"] })
  ].map(treeSourceFromEvent));
  assert.equal(tree.nodes.find((node) => node.nodeId === "a")?.status, "running");
  assert.equal(tree.nodes.find((node) => node.nodeId === ROOT_AGENT_NODE_ID)?.status, "running");
});

test("user messages don't count as agent activity", () => {
  const tree = reduceAgentTree([
    treeSourceFromLine({ eventType: "user.message", createdAt: "2026-07-05T10:00:00.000Z", summary: "do the thing" }),
    treeSourceFromEvent(event({ type: "agent.text", text: "on it", final: true }))
  ]);
  const root = tree.nodes[0];
  assert.equal(root?.lastActivity, "on it");
});

test("transport capability tiers match the probe record", () => {
  assert.equal(subagentReportingForTransport("codex-app-server"), "full");
  assert.equal(subagentReportingForTransport("codex-exec-json"), "lifecycle");
  assert.equal(subagentReportingForTransport("claude-exec-json"), "full");
  assert.equal(subagentReportingForTransport("something-else"), "none");
});

test("summarizeAgentEvent carries lineage and structured statuses", () => {
  const spawn = summarizeAgentEvent(event({
    type: "agent.spawn", nodeId: "n1", label: "scribe", subagentType: "general", promptPreview: "write"
  }));
  assert.equal(spawn.eventType, "agent.spawn");
  assert.equal(spawn.nodeId, "n1");
  assert.equal(spawn.label, "scribe");
  assert.equal(spawn.subagentType, "general");
  assert.equal(spawn.nodeStatus, "running");
  assert.equal(spawn.detail, "write");
  assert.ok(spawn.summary.includes("scribe"));

  const done = summarizeAgentEvent(event({
    type: "agent.node_done", nodeId: "n1", status: "failed", resultPreview: "boom", agentPath: [], usage: { totalTokens: 5 }
  }));
  assert.equal(done.nodeId, "n1");
  assert.equal(done.nodeStatus, "failed");
  assert.equal(done.detail, "boom");
  assert.deepEqual(done.usage, { totalTokens: 5 });

  const child = summarizeAgentEvent(event({
    type: "agent.command", command: ["ls"], status: "started", agentPath: ["n1"]
  }));
  assert.deepEqual(child.agentPath, ["n1"]);
  assert.equal(child.toolStatus, "started");
  assert.equal(child.commandName, "ls");
});
