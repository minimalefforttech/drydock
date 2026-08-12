/**
 * Workspace-mismatch decision tests (UX overhaul, P1): normalized set
 * equality, the per-task opt-out, and ask-once-per-window-session.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { sameRootSet, shouldPromptWorkspaceSwitch } from "./workspaceMismatch.js";

const BASE = {
  taskId: "task-1",
  askedTaskIds: new Set<string>()
};

test("sameRootSet ignores order, duplicates, separators, and trailing slashes", () => {
  assert.equal(sameRootSet(["/repos/api", "/repos/web"], ["/repos/web", "/repos/api"]), true);
  assert.equal(sameRootSet(["/repos/api", "/repos/api"], ["/repos/api"]), true);
  assert.equal(sameRootSet(["/repos/api/"], ["/repos/api"]), true);
  assert.equal(sameRootSet(["/repos/api"], ["/repos/api", "/repos/web"]), false);
  assert.equal(sameRootSet([], []), true);
});

test("no linked set means no prompt", () => {
  assert.deepEqual(
    shouldPromptWorkspaceSwitch({ ...BASE, setRoots: [], windowRoots: ["/repos/api"] }),
    { prompt: false, reason: "no-set" }
  );
});

test("matching folders never prompt", () => {
  assert.deepEqual(
    shouldPromptWorkspaceSwitch({ ...BASE, setRoots: ["/repos/api", "/repos/web"], windowRoots: ["/repos/web", "/repos/api"] }),
    { prompt: false, reason: "match" }
  );
});

test("a different folder set prompts", () => {
  assert.deepEqual(
    shouldPromptWorkspaceSwitch({ ...BASE, setRoots: ["/repos/api"], windowRoots: ["/repos/web"] }),
    { prompt: true }
  );
  // A superset of the window's folders is still a mismatch.
  assert.deepEqual(
    shouldPromptWorkspaceSwitch({ ...BASE, setRoots: ["/repos/api", "/repos/web"], windowRoots: ["/repos/api"] }),
    { prompt: true }
  );
});

test("the per-task opt-out silences the prompt for good", () => {
  assert.deepEqual(
    shouldPromptWorkspaceSwitch({ ...BASE, setRoots: ["/repos/api"], windowRoots: ["/repos/web"], dontAsk: true }),
    { prompt: false, reason: "opted-out" }
  );
});

test("a task is asked at most once per window session", () => {
  const input = { ...BASE, setRoots: ["/repos/api"], windowRoots: ["/repos/web"] };
  assert.deepEqual(shouldPromptWorkspaceSwitch(input), { prompt: true });
  assert.deepEqual(
    shouldPromptWorkspaceSwitch({ ...input, askedTaskIds: new Set(["task-1"]) }),
    { prompt: false, reason: "already-asked" }
  );
  // Another task in the same window still gets its own ask.
  assert.deepEqual(
    shouldPromptWorkspaceSwitch({ ...input, taskId: "task-2", askedTaskIds: new Set(["task-1"]) }),
    { prompt: true }
  );
});
