/**
 * Unit tests for the chat export builders: dialogue trimming (host briefing,
 * reasoning, commands, non-final text), files-touched labels (shortest unique
 * suffix, project prefixes, net annotations), and the summary prompt
 * (fixed structure + middle elision on oversized logs).
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { asId, type ChatSessionRecord, type StoredEvent } from "@drydock/contracts";
import { HOST_BRIEFING_END, HOST_BRIEFING_START } from "./accessRequestProtocol.js";
import { buildChatLog, buildSummaryPrompt, SUMMARY_TRANSCRIPT_MAX } from "./chatExport.js";
import { sandboxRuntimePath } from "./mountPolicy.js";

let eventCounter = 0;

function session(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
  return {
    sessionId: asId<"SessionId">("session-export"),
    chatId: asId<"ChatId">("chat-export"),
    title: "Fix the login flow",
    status: "active",
    providerId: "codex",
    transport: "codex-exec-json",
    createdAt: "2026-07-10T09:30:00.000Z",
    updatedAt: "2026-07-10T10:00:00.000Z",
    ...overrides
  };
}

function stored(eventType: string, payload: Record<string, unknown>): StoredEvent {
  eventCounter += 1;
  return {
    id: asId<"EventId">(`event-${String(eventCounter)}`),
    sessionId: asId<"SessionId">("session-export"),
    eventType,
    createdAt: "2026-07-10T09:31:00.000Z",
    payload: payload as StoredEvent["payload"]
  };
}

function fileEdit(path: string, changeKind = "update"): StoredEvent {
  return stored("agent.file_edit", { path, changeKind });
}

test("chat log keeps the dialogue, strips the host briefing, and drops agent chatter", () => {
  const events: StoredEvent[] = [
    stored("user.message", {
      text: `${HOST_BRIEFING_START}\nmounts and rules\n${HOST_BRIEFING_END}\nPlease fix the login flow.`
    }),
    stored("agent.reasoning", { text: "secret scratch thinking", final: true }),
    stored("agent.command", { command: ["bash", "-lc", "npm test"], status: "completed", exitCode: 0 }),
    stored("agent.tool_call", { toolName: "read_file", status: "completed", output: "tool output" }),
    stored("agent.text", { text: "partial stream chunk", final: false }),
    stored("agent.text", { text: "Done. I fixed it.", final: true }),
    stored("user.message", { text: `${HOST_BRIEFING_START}\nre-briefed after restart\n${HOST_BRIEFING_END}` }),
    stored("user.message", { text: "thanks" })
  ];

  const log = buildChatLog(session({ model: "gpt-5" }), events);

  assert.equal(log, [
    "# Fix the login flow",
    "",
    "2026-07-10 · codex · gpt-5",
    "",
    "## Conversation",
    "",
    "User:",
    "Please fix the login flow.",
    "",
    "Assistant:",
    "Done. I fixed it.",
    "",
    "User:",
    "thanks",
    ""
  ].join("\n"));
});

test("empty transcripts still produce a well-formed log", () => {
  const log = buildChatLog(session(), []);
  assert.match(log, /## Conversation\n\n\(no messages\)/);
  assert.doesNotMatch(log, /## Files touched/);
});

test("files touched dedupe to shortest unique suffixes with net annotations", () => {
  const root = "/home/dev/app";
  const prefix = sandboxRuntimePath(root);
  const events: StoredEvent[] = [
    fileEdit(`${prefix}/README.md`, "add"),
    fileEdit(`${prefix}/README.md`, "update"),
    fileEdit(`${prefix}/src/auth/login.ts`),
    fileEdit(`${prefix}/src/auth/login.ts`),
    fileEdit(`${prefix}/src/other/login.ts`),
    fileEdit(`${prefix}/src/legacy.ts`, "update"),
    fileEdit(`${prefix}/src/legacy.ts`, "delete"),
    fileEdit(`${prefix}/src/moved.ts`, "rename")
  ];

  const log = buildChatLog(session({ workspaceRoots: [root] }), events);

  const filesSection = log.slice(log.indexOf("## Files touched"));
  assert.equal(filesSection, [
    "## Files touched",
    "",
    "- README.md (new)",
    "- auth/login.ts",
    "- legacy.ts (deleted)",
    "- moved.ts (renamed)",
    "- other/login.ts",
    ""
  ].join("\n"));
});

test("multi-project sessions prefix labels with the project name and list projects", () => {
  const roots = ["/home/dev/app", "/home/dev/lib"];
  const events: StoredEvent[] = [
    fileEdit(`${sandboxRuntimePath(roots[0]!)}/src/index.ts`),
    fileEdit(`${sandboxRuntimePath(roots[1]!)}/src/index.ts`)
  ];

  const log = buildChatLog(session({ workspaceRoots: roots }), events);

  assert.match(log, /^Projects: app, lib$/m);
  assert.match(log, /^- app\/index\.ts$/m);
  assert.match(log, /^- lib\/index\.ts$/m);
});

test("clone repos and scratch workspace files resolve without workspace roots", () => {
  const events: StoredEvent[] = [
    fileEdit("/workspace/repos/tools/src/build.mjs"),
    fileEdit("/workspace/notes.md", "add")
  ];

  const log = buildChatLog(session(), events);

  // A single project means no prefixes and no Projects: line.
  assert.doesNotMatch(log, /^Projects:/m);
  assert.match(log, /^- build\.mjs$/m);
  assert.match(log, /^- notes\.md \(new\)$/m);
});

test("summary prompt embeds the log inside the fixed structure", () => {
  const log = buildChatLog(session(), [stored("user.message", { text: "hello" })]);
  const prompt = buildSummaryPrompt(log);

  for (const heading of ["## Overview", "## What was done", "## Key decisions", "## Files touched", "## Open items"]) {
    assert.ok(prompt.includes(heading), `missing ${heading}`);
  }
  assert.ok(prompt.includes(log));
  assert.match(prompt, /--- transcript start ---/);
  assert.match(prompt, /Respond with only the summary markdown\.$/);
});

test("summary prompt elides the middle of an oversized log", () => {
  const opening = "OPENING-MARKER ";
  const closing = " CLOSING-MARKER";
  const log = `${opening}${"x".repeat(SUMMARY_TRANSCRIPT_MAX * 2)}${closing}`;
  const prompt = buildSummaryPrompt(log);

  assert.ok(prompt.includes("characters elided"));
  assert.ok(prompt.includes(opening));
  assert.ok(prompt.includes(closing));
  assert.ok(prompt.length < log.length);
});
