/**
 * Boundary validation tests for the Stage 3/4 panel request payloads.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { parsePanelRequest, WEBVIEW_PROTOCOL_VERSION } from "./webviewMessages.js";

function wrap(payload: unknown): unknown {
  return { protocolVersion: WEBVIEW_PROTOCOL_VERSION, kind: "request", requestId: "req-1", payload };
}

test("workspace and policy payloads validate their fields", () => {
  assert.ok(parsePanelRequest(wrap({ type: "workspace.state" })));
  assert.ok(parsePanelRequest(wrap({ type: "workspace.registerOpenFolders" })));
  assert.ok(parsePanelRequest(wrap({ type: "workspace.createSet", name: "Studio" })));
  assert.equal(parsePanelRequest(wrap({ type: "workspace.createSet", name: "" })), null);

  assert.ok(parsePanelRequest(wrap({
    type: "policy.requestAccess",
    sessionId: "session-1",
    hostPath: "C:\\shared",
    mode: "read-only",
    reason: "why"
  })));
  assert.equal(parsePanelRequest(wrap({
    type: "policy.requestAccess",
    sessionId: "session-1",
    hostPath: "C:\\shared",
    mode: "read-write-everything",
    reason: "why"
  })), null);
  assert.ok(parsePanelRequest(wrap({ type: "policy.resolveAccess", accessRequestId: "request-1", approve: true })));
  assert.equal(parsePanelRequest(wrap({ type: "policy.resolveAccess", accessRequestId: "request-1", approve: "yes" })), null);

  // An optional editedHostPath rides along on approval and is bounds-checked.
  const edited = parsePanelRequest(wrap({
    type: "policy.resolveAccess",
    accessRequestId: "request-1",
    approve: true,
    editedHostPath: "C:\\shared\\other"
  }));
  assert.ok(edited);
  assert.equal(
    edited.payload.type === "policy.resolveAccess" ? edited.payload.editedHostPath : undefined,
    "C:\\shared\\other"
  );
  assert.equal(parsePanelRequest(wrap({
    type: "policy.resolveAccess",
    accessRequestId: "request-1",
    approve: false,
    editedHostPath: 42
  })), null);
});

test("planDocs payloads validate their session id", () => {
  for (const type of ["planDocs.state", "planDocs.open", "planDocs.sendComments"] as const) {
    const parsed = parsePanelRequest(wrap({ type, sessionId: "session-1" }));
    assert.ok(parsed);
    assert.equal(parsed.payload.type, type);
    assert.equal(parsed.payload.type === type ? parsed.payload.sessionId : undefined, "session-1");
    // A missing or empty session id is rejected at the boundary.
    assert.equal(parsePanelRequest(wrap({ type })), null);
    assert.equal(parsePanelRequest(wrap({ type, sessionId: "" })), null);
  }
});

test("provider.login validates its provider id", () => {
  assert.ok(parsePanelRequest(wrap({ type: "provider.login", providerId: "claude" })));
  assert.equal(parsePanelRequest(wrap({ type: "provider.login", providerId: "" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "provider.login" })), null);
});

test("clone.state and clone.push validate their session id", () => {
  for (const type of ["clone.state", "clone.push"] as const) {
    const parsed = parsePanelRequest(wrap({ type, sessionId: "session-1" }));
    assert.ok(parsed);
    assert.equal(parsed.payload.type, type);
    assert.equal(parsed.payload.type === type ? parsed.payload.sessionId : undefined, "session-1");
    assert.equal(parsePanelRequest(wrap({ type })), null);
    assert.equal(parsePanelRequest(wrap({ type, sessionId: "" })), null);
  }
});

test("clone.pull enforces the repo+path XOR rule", () => {
  // A full pull names neither repo nor path.
  const full = parsePanelRequest(wrap({ type: "clone.pull", sessionId: "session-1" }));
  assert.ok(full);
  assert.equal(full.payload.type === "clone.pull" ? full.payload.repo : "sentinel", undefined);
  assert.equal(full.payload.type === "clone.pull" ? full.payload.path : "sentinel", undefined);

  // A per-file pull names BOTH repo and path.
  const perFile = parsePanelRequest(wrap({ type: "clone.pull", sessionId: "session-1", repo: "asset_api", path: "a/b.py" }));
  assert.ok(perFile);
  assert.equal(perFile.payload.type === "clone.pull" ? perFile.payload.repo : undefined, "asset_api");
  assert.equal(perFile.payload.type === "clone.pull" ? perFile.payload.path : undefined, "a/b.py");

  // Naming only one of repo/path violates the XOR rule → rejected.
  assert.equal(parsePanelRequest(wrap({ type: "clone.pull", sessionId: "session-1", repo: "asset_api" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "clone.pull", sessionId: "session-1", path: "a/b.py" })), null);
  // A missing/empty session id is still rejected.
  assert.equal(parsePanelRequest(wrap({ type: "clone.pull" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "clone.pull", sessionId: "" })), null);
});

test("clone.discard requires session id, repo, and path", () => {
  const parsed = parsePanelRequest(wrap({ type: "clone.discard", sessionId: "session-1", repo: "asset_api", path: "a/b.py" }));
  assert.ok(parsed);
  assert.equal(parsed.payload.type, "clone.discard");
  if (parsed.payload.type === "clone.discard") {
    assert.equal(parsed.payload.repo, "asset_api");
    assert.equal(parsed.payload.path, "a/b.py");
  }
  // Any missing field is rejected.
  assert.equal(parsePanelRequest(wrap({ type: "clone.discard", sessionId: "session-1", repo: "asset_api" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "clone.discard", sessionId: "session-1", path: "a/b.py" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "clone.discard", repo: "asset_api", path: "a/b.py" })), null);
});

test("chat.start carries an optional validated workspace selection", () => {
  const parsed = parsePanelRequest(wrap({
    type: "chat.start",
    prompt: "hello",
    workspace: { workspaceSetId: "set-1", mode: "plan" }
  }));
  assert.ok(parsed);
  assert.deepEqual(
    parsed.payload.type === "chat.start" ? parsed.payload.workspace : undefined,
    { workspaceSetId: "set-1", mode: "plan" }
  );
  // Clone is a valid mode; a garbage mode still rejects.
  assert.ok(parsePanelRequest(wrap({
    type: "chat.start",
    prompt: "hello",
    workspace: { workspaceSetId: "set-1", mode: "clone" }
  })));
  assert.equal(parsePanelRequest(wrap({
    type: "chat.start",
    prompt: "hello",
    workspace: { workspaceSetId: "set-1", mode: "detached" }
  })), null);
});

test("chat.resumeSession validates the session id, optional model, and workspace union", () => {
  // Bare resume: session id only, model and workspace both optional.
  const bare = parsePanelRequest(wrap({ type: "chat.resumeSession", sessionId: "session-1" }));
  assert.ok(bare);
  assert.equal(bare.payload.type, "chat.resumeSession");
  assert.equal(bare.payload.type === "chat.resumeSession" ? bare.payload.sessionId : undefined, "session-1");

  // A missing or empty session id is rejected at the boundary.
  assert.equal(parsePanelRequest(wrap({ type: "chat.resumeSession" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "chat.resumeSession", sessionId: "" })), null);

  // An optional model rides along and is bounds-checked; a bad model shape rejects.
  const withModel = parsePanelRequest(wrap({
    type: "chat.resumeSession",
    sessionId: "session-1",
    model: { providerId: "claude", model: "claude-opus-4-8" }
  }));
  assert.ok(withModel);
  assert.deepEqual(
    withModel.payload.type === "chat.resumeSession" ? withModel.payload.model : undefined,
    { providerId: "claude", model: "claude-opus-4-8" }
  );
  // A model object without a providerId is malformed.
  assert.equal(parsePanelRequest(wrap({ type: "chat.resumeSession", sessionId: "session-1", model: { model: "gpt-5" } })), null);
  // A non-object model is malformed.
  assert.equal(parsePanelRequest(wrap({ type: "chat.resumeSession", sessionId: "session-1", model: "claude" })), null);

  // The workspace auto/set union is accepted; a bad mode rejects on either branch.
  const auto = parsePanelRequest(wrap({
    type: "chat.resumeSession",
    sessionId: "session-1",
    workspace: { auto: true, mode: "implementation" }
  }));
  assert.ok(auto);
  assert.deepEqual(
    auto.payload.type === "chat.resumeSession" ? auto.payload.workspace : undefined,
    { auto: true, mode: "implementation" }
  );
  const set = parsePanelRequest(wrap({
    type: "chat.resumeSession",
    sessionId: "session-1",
    workspace: { workspaceSetId: "set-1", mode: "plan" }
  }));
  assert.ok(set);
  assert.deepEqual(
    set.payload.type === "chat.resumeSession" ? set.payload.workspace : undefined,
    { workspaceSetId: "set-1", mode: "plan" }
  );
  // Clone is a valid mode; a garbage mode still rejects.
  assert.ok(parsePanelRequest(wrap({
    type: "chat.resumeSession",
    sessionId: "session-1",
    workspace: { auto: true, mode: "clone" }
  })));
  assert.equal(parsePanelRequest(wrap({
    type: "chat.resumeSession",
    sessionId: "session-1",
    workspace: { auto: true, mode: "detached" }
  })), null);
});

test("session rename/setDescription/delete validate ids and bounds", () => {
  assert.ok(parsePanelRequest(wrap({ type: "session.rename", sessionId: "session-1", title: "Renamed" })));
  assert.equal(parsePanelRequest(wrap({ type: "session.rename", sessionId: "session-1", title: "" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "session.rename", sessionId: "session-1", title: "x".repeat(201) })), null);
  assert.equal(parsePanelRequest(wrap({ type: "session.rename", sessionId: "", title: "Renamed" })), null);

  // Empty description is allowed and clears the note; oversized bodies are rejected.
  const cleared = parsePanelRequest(wrap({ type: "session.setDescription", sessionId: "session-1", description: "" }));
  assert.ok(cleared);
  assert.deepEqual(
    cleared.payload.type === "session.setDescription" ? cleared.payload.description : undefined,
    ""
  );
  assert.ok(parsePanelRequest(wrap({ type: "session.setDescription", sessionId: "session-1", description: "a note" })));
  assert.equal(parsePanelRequest(wrap({ type: "session.setDescription", sessionId: "session-1", description: "x".repeat(4001) })), null);
  assert.equal(parsePanelRequest(wrap({ type: "session.setDescription", sessionId: "session-1", description: 5 })), null);

  assert.ok(parsePanelRequest(wrap({ type: "session.delete", sessionId: "session-1" })));
  assert.equal(parsePanelRequest(wrap({ type: "session.delete", sessionId: "" })), null);
});

test("isolatedRun.listRuntimes accepts an optional boolean includeRemoved", () => {
  assert.ok(parsePanelRequest(wrap({ type: "isolatedRun.listRuntimes" })));
  const withFlag = parsePanelRequest(wrap({ type: "isolatedRun.listRuntimes", includeRemoved: true }));
  assert.ok(withFlag);
  assert.equal(
    withFlag.payload.type === "isolatedRun.listRuntimes" ? withFlag.payload.includeRemoved : undefined,
    true
  );
  assert.equal(parsePanelRequest(wrap({ type: "isolatedRun.listRuntimes", includeRemoved: "yes" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "isolatedRun.listRuntimes", includeRemoved: 1 })), null);
});

test("workspace selection accepts the auto/set union and rejects mixed or bad shapes", () => {
  const auto = parsePanelRequest(wrap({ type: "chat.start", prompt: "hi", workspace: { auto: true, mode: "implementation" } }));
  assert.ok(auto);
  assert.deepEqual(
    auto.payload.type === "chat.start" ? auto.payload.workspace : undefined,
    { auto: true, mode: "implementation" }
  );

  const set = parsePanelRequest(wrap({ type: "chat.start", prompt: "hi", workspace: { workspaceSetId: "set-1", mode: "plan" } }));
  assert.ok(set);
  assert.deepEqual(
    set.payload.type === "chat.start" ? set.payload.workspace : undefined,
    { workspaceSetId: "set-1", mode: "plan" }
  );

  // auto must not also carry a workspaceSetId.
  assert.equal(parsePanelRequest(wrap({
    type: "chat.start",
    prompt: "hi",
    workspace: { auto: true, workspaceSetId: "set-1", mode: "plan" }
  })), null);
  // Clone is valid on either branch; bad modes are rejected on either branch.
  assert.ok(parsePanelRequest(wrap({ type: "chat.start", prompt: "hi", workspace: { auto: true, mode: "clone" } })));
  assert.ok(parsePanelRequest(wrap({ type: "chat.start", prompt: "hi", workspace: { workspaceSetId: "set-1", mode: "clone" } })));
  assert.equal(parsePanelRequest(wrap({ type: "chat.start", prompt: "hi", workspace: { auto: true, mode: "detached" } })), null);
  assert.equal(parsePanelRequest(wrap({ type: "chat.start", prompt: "hi", workspace: { workspaceSetId: "set-1", mode: "detached" } })), null);
  // The set branch still requires a non-empty workspaceSetId.
  assert.equal(parsePanelRequest(wrap({ type: "chat.start", prompt: "hi", workspace: { mode: "plan" } })), null);
});

test("diff and review payloads validate ids, paths, and line ranges", () => {
  assert.ok(parsePanelRequest(wrap({ type: "diff.status" })));
  assert.ok(parsePanelRequest(wrap({ type: "diff.status", sessionId: "session-1" })));
  assert.ok(parsePanelRequest(wrap({ type: "diff.acceptFile", baselineId: "baseline-1", path: "src/a.ts" })));
  assert.equal(parsePanelRequest(wrap({ type: "diff.revertFile", baselineId: "baseline-1", path: "" })), null);
  assert.ok(parsePanelRequest(wrap({ type: "diff.openFile", baselineId: "baseline-1", path: "src/a.ts" })));
  assert.equal(parsePanelRequest(wrap({ type: "diff.openFile", baselineId: "baseline-1" })), null);
  assert.ok(parsePanelRequest(wrap({ type: "diff.snapshotWorkspace", workspaceSetId: "set-1" })));

  assert.ok(parsePanelRequest(wrap({
    type: "review.addComment",
    filePath: "src/a.ts",
    startLine: 3,
    endLine: 5,
    body: "check this"
  })));
  assert.equal(parsePanelRequest(wrap({
    type: "review.addComment",
    filePath: "src/a.ts",
    startLine: 5,
    endLine: 3,
    body: "inverted range"
  })), null);
  assert.equal(parsePanelRequest(wrap({
    type: "review.addComment",
    filePath: "src/a.ts",
    startLine: 0,
    endLine: 3,
    body: "zero line"
  })), null);
  assert.ok(parsePanelRequest(wrap({ type: "review.setCommentStatus", commentId: "comment-1", status: "wont-fix" })));
  assert.equal(parsePanelRequest(wrap({ type: "review.setCommentStatus", commentId: "comment-1", status: "deleted" })), null);
});

test("task payloads validate titles, updates, link targets, and open-in-new-window", () => {
  // create: title is bounded and required; description is optional.
  assert.ok(parsePanelRequest(wrap({ type: "task.create", title: "Wire panel" })));
  assert.ok(parsePanelRequest(wrap({ type: "task.create", title: "Wire panel", description: "notes" })));
  assert.equal(parsePanelRequest(wrap({ type: "task.create", title: "" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "task.create", title: "x".repeat(201) })), null);
  assert.equal(parsePanelRequest(wrap({ type: "task.create" })), null);

  // update: at least one field, valid state, and "" clears the description.
  assert.equal(parsePanelRequest(wrap({ type: "task.update", taskId: "task-1" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "task.update", taskId: "task-1", state: "shipped" })), null);
  assert.ok(parsePanelRequest(wrap({ type: "task.update", taskId: "task-1", state: "in-progress" })));
  const cleared = parsePanelRequest(wrap({ type: "task.update", taskId: "task-1", description: "" }));
  assert.ok(cleared);
  assert.deepEqual(
    cleared.payload.type === "task.update" ? cleared.payload.description : undefined,
    ""
  );

  // link/unlink: exactly one target. Both set and neither set both reject.
  assert.ok(parsePanelRequest(wrap({ type: "task.link", taskId: "task-1", workspaceSetId: "set-1" })));
  assert.ok(parsePanelRequest(wrap({ type: "task.unlink", taskId: "task-1", sessionId: "session-1" })));
  assert.equal(parsePanelRequest(wrap({ type: "task.link", taskId: "task-1" })), null);
  assert.equal(parsePanelRequest(wrap({
    type: "task.link",
    taskId: "task-1",
    workspaceSetId: "set-1",
    sessionId: "session-1"
  })), null);

  // openInNewWindow needs a non-empty workspace set id.
  assert.ok(parsePanelRequest(wrap({ type: "workspace.openInNewWindow", workspaceSetId: "set-1" })));
  assert.equal(parsePanelRequest(wrap({ type: "workspace.openInNewWindow", workspaceSetId: "" })), null);
});

test("workspace.activate accepts exactly one of taskId / workspaceSetId", () => {
  // Exactly one activation source: taskId XOR workspaceSetId.
  const byTask = parsePanelRequest(wrap({ type: "workspace.activate", taskId: "task-1" }));
  assert.ok(byTask);
  assert.deepEqual(
    byTask.payload.type === "workspace.activate" ? byTask.payload.taskId : undefined,
    "task-1"
  );
  const bySet = parsePanelRequest(wrap({ type: "workspace.activate", workspaceSetId: "set-1" }));
  assert.ok(bySet);
  assert.deepEqual(
    bySet.payload.type === "workspace.activate" ? bySet.payload.workspaceSetId : undefined,
    "set-1"
  );
  // Neither source, both sources, and an empty id are all rejected.
  assert.equal(parsePanelRequest(wrap({ type: "workspace.activate" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "workspace.activate", taskId: "task-1", workspaceSetId: "set-1" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "workspace.activate", taskId: "" })), null);
});

test("work.history requires exactly one scope", () => {
  // Exactly one of workspaceSetId / projectId.
  const bySet = parsePanelRequest(wrap({ type: "work.history", workspaceSetId: "set-1" }));
  assert.ok(bySet);
  assert.deepEqual(
    bySet.payload.type === "work.history" ? bySet.payload.workspaceSetId : undefined,
    "set-1"
  );
  const byProject = parsePanelRequest(wrap({ type: "work.history", projectId: "project-1" }));
  assert.ok(byProject);
  assert.deepEqual(
    byProject.payload.type === "work.history" ? byProject.payload.projectId : undefined,
    "project-1"
  );

  // Neither scope and both scopes both reject.
  assert.equal(parsePanelRequest(wrap({ type: "work.history" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "work.history", workspaceSetId: "set-1", projectId: "project-1" })), null);
  // A present-but-empty id is rejected on either branch.
  assert.equal(parsePanelRequest(wrap({ type: "work.history", workspaceSetId: "" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "work.history", projectId: "" })), null);
});

test("taskReview payloads validate their task id", () => {
  for (const type of ["taskReview.open", "taskReview.state", "taskReview.submit"] as const) {
    const parsed = parsePanelRequest(wrap({ type, taskId: "task-1" }));
    assert.ok(parsed);
    assert.equal(parsed.payload.type, type);
    assert.equal(parsed.payload.type === type ? parsed.payload.taskId : undefined, "task-1");
    // A missing, empty, or non-string task id is rejected at the boundary.
    assert.equal(parsePanelRequest(wrap({ type })), null);
    assert.equal(parsePanelRequest(wrap({ type, taskId: "" })), null);
    assert.equal(parsePanelRequest(wrap({ type, taskId: 42 })), null);
    assert.equal(parsePanelRequest(wrap({ type, taskId: "x".repeat(201) })), null);
  }
});

test("memory.list and memory.resolve validate their fields", () => {
  assert.ok(parsePanelRequest(wrap({ type: "memory.list" })));

  // resolve: bounded id and a boolean approve, both required.
  assert.ok(parsePanelRequest(wrap({ type: "memory.resolve", memoryCandidateId: "memory-1", approve: true })));
  assert.ok(parsePanelRequest(wrap({ type: "memory.resolve", memoryCandidateId: "memory-1", approve: false })));
  assert.equal(parsePanelRequest(wrap({ type: "memory.resolve", memoryCandidateId: "memory-1", approve: "yes" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "memory.resolve", memoryCandidateId: "memory-1" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "memory.resolve", memoryCandidateId: "", approve: true })), null);
  assert.equal(parsePanelRequest(wrap({ type: "memory.resolve", approve: true })), null);
});
