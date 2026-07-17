import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSessionBriefing,
  extractAccessRequests,
  extractAgentQuestions,
  extractMemoryCandidates,
  MAX_ACCESS_REQUESTS_PER_TEXT,
  stripHostBriefing
} from "./accessRequestProtocol.js";
import { sandboxRuntimePath } from "./mountPolicy.js";

test("extractAccessRequests parses a well-formed fenced block", () => {
  const text = [
    "I need the build output directory.",
    "```access-request",
    '{"path": "D:/proj/build", "mode": "read-only", "reason": "inspect build artifacts"}',
    "```",
    "Waiting for approval."
  ].join("\n");
  assert.deepEqual(extractAccessRequests(text), [
    { path: "D:/proj/build", mode: "read-only", reason: "inspect build artifacts" }
  ]);
});

test("extractAccessRequests handles CRLF, missing reason, and surrounding fences", () => {
  const text = [
    "```ts",
    "const x = 1;",
    "```",
    "```access-request\r",
    '{"path": "/srv/data", "mode": "read-write"}\r',
    "```"
  ].join("\n");
  const requests = extractAccessRequests(text);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.path, "/srv/data");
  assert.equal(requests[0]?.mode, "read-write");
  assert.ok((requests[0]?.reason.length ?? 0) > 0);
});

test("extractAccessRequests drops malformed blocks instead of guessing", () => {
  const cases = [
    "```access-request\nnot json\n```",
    "```access-request\n[]\n```",
    '```access-request\n{"path": "", "mode": "read-only"}\n```',
    '```access-request\n{"path": "/x", "mode": "write"}\n```',
    `\`\`\`access-request\n{"path": "/x", "mode": "read-only", "reason": ${JSON.stringify("r".repeat(5000))}}\n\`\`\``
  ];
  for (const text of cases) {
    assert.deepEqual(extractAccessRequests(text), [], text.slice(0, 60));
  }
});

test("extractAccessRequests caps the number of honored requests", () => {
  const block = '```access-request\n{"path": "/x", "mode": "read-only"}\n```';
  const text = Array.from({ length: MAX_ACCESS_REQUESTS_PER_TEXT + 2 }, () => block).join("\n");
  assert.equal(extractAccessRequests(text).length, MAX_ACCESS_REQUESTS_PER_TEXT);
});

test("buildSessionBriefing states mode, mounts, and the request protocol", () => {
  const briefing = buildSessionBriefing({
    mode: "plan",
    mounts: [{ runtimePath: "/workspace/app", mode: "read-only", hostDisplayPath: "D:/proj/app" }]
  });
  assert.match(briefing, /Mode: PLAN/);
  assert.match(briefing, /\/workspace\/app \(read-only\) = host D:\/proj\/app/);
  assert.match(briefing, /access-request/);
  assert.match(briefing, /\[end host briefing\]/);
});

test("buildSessionBriefing omits the host remap for a direct-mirror mount", () => {
  const host = "C:\\Users\\me\\proj";
  const runtimePath = sandboxRuntimePath(host);
  const briefing = buildSessionBriefing({
    mode: "implementation",
    mounts: [{ runtimePath, mode: "read-write", hostDisplayPath: host }]
  });
  assert.match(briefing, new RegExp(`${runtimePath.replace(/[/]/g, "\\/")} \\(read-write\\)`));
  // The runtime path already encodes the host location, so no "= host ..." noise.
  assert.doesNotMatch(briefing, /= host/);
});

test("stripHostBriefing removes the briefing block but keeps the prompt and plain text", () => {
  const briefing = buildSessionBriefing({ mode: "implementation", mounts: [] });
  const stored = `${briefing}\n\nPlease refactor the login flow.`;
  assert.equal(stripHostBriefing(stored), "Please refactor the login flow.");
  // Text without a briefing is returned unchanged.
  assert.equal(stripHostBriefing("just a follow-up message"), "just a follow-up message");
});

test("extractMemoryCandidates takes bounded plain text and drops empties", () => {
  const text = [
    "Done. One thing worth remembering:",
    "```memory-candidate",
    "asset_api integration tests need the fixture server on port 9021.",
    "```",
    "```memory-candidate",
    "   ",
    "```",
    `\`\`\`memory-candidate\n${"x".repeat(2001)}\n\`\`\``
  ].join("\n");
  assert.deepEqual(extractMemoryCandidates(text), [
    { content: "asset_api integration tests need the fixture server on port 9021." }
  ]);
});

test("extractMemoryCandidates caps the number honored per text", () => {
  const block = "```memory-candidate\nnote\n```";
  const text = Array.from({ length: 5 }, () => block).join("\n");
  assert.equal(extractMemoryCandidates(text).length, 3);
});

test("buildSessionBriefing teaches the memory protocol and lists scoped memory groups", () => {
  const briefing = buildSessionBriefing({
    mode: "implementation",
    mounts: [],
    memoryGroups: [
      { label: "this task", notes: ["Farm submits require the schema migration to run last."] },
      { label: "global", notes: ["Use fixture server port 9021."] }
    ]
  });
  assert.match(briefing, /memory-candidate/);
  assert.match(briefing, /Team memory - this task/);
  assert.match(briefing, /Team memory - global/);
  assert.match(briefing, /- Farm submits require the schema migration to run last\./);
  assert.match(briefing, /- Use fixture server port 9021\./);
});

test("extractMemoryCandidates accepts the structured JSON body with scope and tags", () => {
  const text = [
    "```memory-candidate",
    '{"content": "Alembic exports must use the framerange guard", "scope": "workspace", "tags": ["Python", "maya", "python"]}',
    "```",
    "```memory-candidate",
    '{"scope": "task"}',
    "```"
  ].join("\n");
  // The second block LOOKS like JSON but has no content - dropped, not stored as noise.
  assert.deepEqual(extractMemoryCandidates(text), [
    { content: "Alembic exports must use the framerange guard", scope: "workspace", tags: ["python", "maya"] }
  ]);
});

test("buildSessionBriefing appends the granted note after a restart", () => {
  const briefing = buildSessionBriefing({
    mode: "implementation",
    mounts: [],
    grantedNote: "Access granted: D:/proj/build is mounted at /approved/ar-1 (read-only)."
  });
  assert.match(briefing, /Mounts: none/);
  assert.match(briefing, /Access granted: D:\/proj\/build/);
});

test("extractAgentQuestions parses questions with recommended-first options", () => {
  const text = [
    "I can go either way here.",
    "```question",
    '{"question": "Should retries use exponential backoff?", "options": ["Yes, with jitter", "No, fixed 5s", "yes, with jitter"]}',
    "```",
    "```question",
    '{"question": "  Keep the legacy exporter?  "}',
    "```"
  ].join("\n");
  const questions = extractAgentQuestions(text);
  assert.equal(questions.length, 2);
  // Options dedupe case-insensitively; the first stays the recommendation.
  assert.deepEqual(questions[0], {
    question: "Should retries use exponential backoff?",
    options: ["Yes, with jitter", "No, fixed 5s"]
  });
  assert.deepEqual(questions[1], { question: "Keep the legacy exporter?", options: [] });
});

test("extractAgentQuestions drops malformed blocks and caps volume", () => {
  const bad = ["not json", '{"question": ""}', '{"question": 42}', '{"question": "ok?", "options": "nope"}', JSON.stringify({ question: "x".repeat(600) })];
  const malformed = bad.map((body) => "```question\n" + body + "\n```").join("\n");
  assert.deepEqual(extractAgentQuestions(malformed), []);
  const many = Array.from({ length: 6 }, (_, index) =>
    '```question\n{"question": "q' + String(index) + '?"}\n```'
  ).join("\n");
  assert.equal(extractAgentQuestions(many).length, 4);
});

test("the briefing teaches the question fence", () => {
  const briefing = buildSessionBriefing({ mode: "implementation", mounts: [] });
  assert.ok(briefing.includes("`question`"));
  assert.ok(briefing.includes("your recommended answer first"));
});
