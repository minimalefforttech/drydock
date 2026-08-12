/**
 * Boundary validation tests for the Stage 3/4 panel request payloads.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  CONFIG_SETTING_SECTIONS,
  MAX_ID_LENGTH,
  MAX_MODEL_ID_LENGTH,
  MAX_RECENTS_LIMIT,
  PANEL_SURFACES,
  parsePanelRequest,
  WEBVIEW_PROTOCOL_VERSION
} from "./webviewMessages.js";

function wrap(payload: unknown): unknown {
  return { protocolVersion: WEBVIEW_PROTOCOL_VERSION, kind: "request", requestId: "req-1", payload };
}

test("workspace and policy payloads validate their fields", () => {
  assert.ok(parsePanelRequest(wrap({ type: "workspace.state" })));
  assert.ok(parsePanelRequest(wrap({ type: "workspace.registerOpenFolders" })));
  const members = [{ projectId: "project-a", readOnly: false }, { projectId: "project-b", readOnly: true }];
  assert.ok(parsePanelRequest(wrap({ type: "workspace.createSet", name: "Studio", members })));
  assert.equal(parsePanelRequest(wrap({ type: "workspace.createSet", name: "", members })), null);
  // Members are required and must be non-empty and well-formed.
  assert.equal(parsePanelRequest(wrap({ type: "workspace.createSet", name: "Studio" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "workspace.createSet", name: "Studio", members: [] })), null);
  assert.equal(parsePanelRequest(wrap({ type: "workspace.createSet", name: "Studio", members: [{ projectId: "a" }] })), null);
  assert.ok(parsePanelRequest(wrap({ type: "workspace.updateSet", workspaceSetId: "set-1", name: "Solo", members })));
  assert.ok(parsePanelRequest(wrap({ type: "workspace.deleteSet", workspaceSetId: "set-1" })));
  assert.ok(parsePanelRequest(wrap({ type: "workspace.removeProject", projectId: "project-a" })));
  assert.ok(parsePanelRequest(wrap({ type: "workspace.updateProjectPath", projectId: "project-a", path: "C:\\repos\\a" })));

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

test("agents panel payloads validate their fields (ADR 0013)", () => {
  assert.ok(parsePanelRequest(wrap({ type: "agents.open" })));
  const guided = parsePanelRequest(wrap({ type: "agents.open", startGuide: true }));
  assert.deepEqual(guided?.payload, { type: "agents.open", startGuide: true });
  assert.equal(parsePanelRequest(wrap({ type: "agents.open", startGuide: "yes" })), null);
  assert.ok(parsePanelRequest(wrap({ type: "agents.state" })));
  assert.ok(parsePanelRequest(wrap({ type: "agents.openSession", sessionId: "session-1" })));
  const withNode = parsePanelRequest(wrap({ type: "agents.openSession", sessionId: "session-1", nodeId: "node-9" }));
  assert.ok(withNode);
  assert.equal(withNode.payload.type === "agents.openSession" ? withNode.payload.nodeId : undefined, "node-9");
  // sessionId is required and bounded; nodeId when present must be a bounded string.
  assert.equal(parsePanelRequest(wrap({ type: "agents.openSession" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "agents.openSession", sessionId: 5 })), null);
  assert.equal(parsePanelRequest(wrap({ type: "agents.openSession", sessionId: "session-1", nodeId: 7 })), null);
});

test("retired planDocs payloads are rejected at the boundary (ADR 0012)", () => {
  for (const type of ["planDocs.state", "planDocs.open", "planDocs.sendComments"]) {
    assert.equal(parsePanelRequest(wrap({ type, sessionId: "session-1" })), null);
  }
});

test("retired Control Panel payloads are rejected at the boundary (ADR 0020)", () => {
  // The Tasks tab's touch-history popover and the System tab's app-server probe
  // + per-sandbox stats poll retired with the four-tab panel; nothing else ever
  // sent them, so the parse gate must not know these literals any more.
  for (const type of ["work.history", "isolatedRun.probeAppServer", "runtime.stats"]) {
    assert.equal(parsePanelRequest(wrap({ type })), null);
  }
  // Their argument-bearing shapes are rejected too - a retired type is unknown
  // whatever it carries.
  for (const payload of [
    { type: "work.history", workspaceSetId: "set-1" },
    { type: "work.history", projectId: "project-1" },
    { type: "runtime.stats", runtimeIds: ["runtime-1"] }
  ]) {
    assert.equal(parsePanelRequest(wrap(payload)), null);
  }
});

test("planner payloads validate ids, arrays, anchors, and statuses", () => {
  assert.ok(parsePanelRequest(wrap({ type: "planner.open" })));
  assert.ok(parsePanelRequest(wrap({ type: "planner.open", planId: "plan-1" })));
  const guided = parsePanelRequest(wrap({ type: "planner.open", planId: "plan-1", startGuide: true }));
  assert.deepEqual(guided?.payload, { type: "planner.open", planId: "plan-1", startGuide: true });
  assert.equal(parsePanelRequest(wrap({ type: "planner.open", planId: "" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "planner.open", startGuide: 1 })), null);
  assert.ok(parsePanelRequest(wrap({ type: "planner.plans" })));
  assert.ok(parsePanelRequest(wrap({ type: "planner.aspects.list" })));
  assert.ok(parsePanelRequest(wrap({ type: "planner.state", planId: "plan-1" })));
  assert.equal(parsePanelRequest(wrap({ type: "planner.state" })), null);

  // create: brief + the two arrays are required (arrays may be empty).
  assert.ok(parsePanelRequest(wrap({ type: "planner.create", brief: "Build a planner.", aspectIds: ["ui-ux"], contextRoots: [] })));
  const created = parsePanelRequest(wrap({
    type: "planner.create",
    brief: "b",
    aspectIds: [],
    contextRoots: ["C:\\repo"],
    notes: "",
    title: "T",
    model: { providerId: "claude" }
  }));
  assert.ok(created);
  assert.equal(created.payload.type === "planner.create" ? created.payload.title : undefined, "T");
  assert.equal(parsePanelRequest(wrap({ type: "planner.create", brief: "b" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "planner.create", brief: "", aspectIds: [], contextRoots: [] })), null);
  assert.equal(parsePanelRequest(wrap({ type: "planner.create", brief: "b", aspectIds: [42], contextRoots: [] })), null);
  assert.equal(parsePanelRequest(wrap({ type: "planner.create", brief: "b", aspectIds: [], contextRoots: [], model: { providerId: "" } })), null);

  assert.ok(parsePanelRequest(wrap({ type: "planner.create", brief: "b", aspectIds: [], contextRoots: [], taskId: "t-1" })));
  assert.equal(parsePanelRequest(wrap({ type: "planner.create", brief: "b", aspectIds: [], contextRoots: [], taskId: "" })), null);
  assert.ok(parsePanelRequest(wrap({ type: "planner.updateIntake", planId: "plan-1", notes: "" })));
  // taskId admits "" on update: it clears the link back to an orphan plan.
  assert.ok(parsePanelRequest(wrap({ type: "planner.updateIntake", planId: "plan-1", taskId: "" })));
  assert.ok(parsePanelRequest(wrap({ type: "planner.updateIntake", planId: "plan-1", taskId: "t-2" })));
  assert.equal(parsePanelRequest(wrap({ type: "planner.updateIntake", planId: "plan-1", brief: "" })), null);
  assert.ok(parsePanelRequest(wrap({ type: "planner.archive", planId: "plan-1", archived: true })));
  assert.equal(parsePanelRequest(wrap({ type: "planner.archive", planId: "plan-1", archived: "yes" })), null);
  assert.ok(parsePanelRequest(wrap({ type: "planner.startSession", planId: "plan-1" })));
  assert.ok(parsePanelRequest(wrap({ type: "planner.sendTurn", planId: "plan-1", prompt: "go" })));
  assert.equal(parsePanelRequest(wrap({ type: "planner.sendTurn", planId: "plan-1", prompt: "" })), null);

  // Annotations: the anchor must satisfy the grammar, not just the length cap.
  for (const anchor of ["block:3", "node:Gateway", "point:0.5,0.5", "region:0.1,0.1,0.5,0.5"]) {
    assert.ok(parsePanelRequest(wrap({ type: "planner.annotation.add", planId: "p", artifactId: "a", anchor, body: "note" })), anchor);
  }
  assert.equal(parsePanelRequest(wrap({ type: "planner.annotation.add", planId: "p", artifactId: "a", anchor: "line:3", body: "note" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "planner.annotation.add", planId: "p", artifactId: "a", anchor: "block:3", body: "" })), null);
  assert.ok(parsePanelRequest(wrap({ type: "planner.annotation.setStatus", annotationId: "n-1", status: "resolved" })));
  assert.equal(parsePanelRequest(wrap({ type: "planner.annotation.setStatus", annotationId: "n-1", status: "acknowledged" })), null);
  assert.ok(parsePanelRequest(wrap({ type: "planner.annotation.remove", annotationId: "n-1" })));

  // Rename admits the empty string (clears the override); type errors do not pass.
  assert.ok(parsePanelRequest(wrap({ type: "planner.artifact.rename", artifactId: "a", title: "" })));
  assert.equal(parsePanelRequest(wrap({ type: "planner.artifact.rename", artifactId: "a", title: 7 })), null);

  assert.ok(parsePanelRequest(wrap({ type: "planner.sendInstructions", planId: "plan-1" })));
  assert.ok(parsePanelRequest(wrap({ type: "planner.regenerate", planId: "plan-1", aspectId: "ui-ux" })));
  assert.ok(parsePanelRequest(wrap({ type: "planner.regenerate", planId: "plan-1" })));
  assert.ok(parsePanelRequest(wrap({ type: "planner.openArtifact", artifactId: "a" })));
  assert.ok(parsePanelRequest(wrap({ type: "planner.setPrototypeScripts", artifactId: "a", enabled: true })));
  assert.equal(parsePanelRequest(wrap({ type: "planner.setPrototypeScripts", artifactId: "a", enabled: "on" })), null);

  // Aspect saves: slug ids only (they double as plan/<aspectId>/ directories).
  assert.ok(parsePanelRequest(wrap({
    type: "planner.aspects.save",
    aspect: { label: "Brand review", instructions: "Check the brand book.", expectedArtifacts: ["Brand notes (document)"] }
  })));
  assert.ok(parsePanelRequest(wrap({
    type: "planner.aspects.save",
    aspect: { aspectId: "brand-review", label: "Brand review", instructions: "x", expectedArtifacts: [] }
  })));
  assert.equal(parsePanelRequest(wrap({
    type: "planner.aspects.save",
    aspect: { aspectId: "Brand Review", label: "Brand review", instructions: "x", expectedArtifacts: [] }
  })), null);
  assert.equal(parsePanelRequest(wrap({
    type: "planner.aspects.save",
    aspect: { aspectId: "../evil", label: "Brand review", instructions: "x", expectedArtifacts: [] }
  })), null);
  assert.ok(parsePanelRequest(wrap({ type: "planner.aspects.archive", aspectId: "performance", archived: true })));
});

test("provider.login validates its provider id", () => {
  assert.ok(parsePanelRequest(wrap({ type: "provider.login", providerId: "claude" })));
  assert.equal(parsePanelRequest(wrap({ type: "provider.login", providerId: "" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "provider.login" })), null);
});

test("provider.list accepts an optional boolean force flag only", () => {
  assert.ok(parsePanelRequest(wrap({ type: "provider.list" })));
  const forced = parsePanelRequest(wrap({ type: "provider.list", force: true }));
  assert.ok(forced);
  assert.equal(forced.payload.type === "provider.list" ? forced.payload.force : undefined, true);
  assert.equal(parsePanelRequest(wrap({ type: "provider.list", force: "yes" })), null);
});

test("provider secret inputs are bounded, required, and typed", () => {
  const code = parsePanelRequest(wrap({ type: "provider.submitCode", providerId: "claude", code: "ac_123#state" }));
  assert.ok(code);
  assert.equal(code.payload.type === "provider.submitCode" ? code.payload.code : undefined, "ac_123#state");
  assert.equal(parsePanelRequest(wrap({ type: "provider.submitCode", providerId: "claude", code: "" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "provider.submitCode", providerId: "claude" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "provider.submitCode", providerId: "claude", code: "x".repeat(5_000) })), null);

  assert.ok(parsePanelRequest(wrap({ type: "provider.submitApiKey", providerId: "openrouter", apiKey: "or-key" })));
  assert.equal(parsePanelRequest(wrap({ type: "provider.submitApiKey", providerId: "openrouter", apiKey: 42 })), null);
  assert.equal(parsePanelRequest(wrap({ type: "provider.submitApiKey", apiKey: "or-key" })), null);

  assert.ok(parsePanelRequest(wrap({ type: "provider.cancelLogin", providerId: "codex" })));
  assert.equal(parsePanelRequest(wrap({ type: "provider.cancelLogin" })), null);
});

test("clipboard.writeText validates bounded text", () => {
  const parsed = parsePanelRequest(wrap({ type: "clipboard.writeText", text: "copy me" }));
  assert.ok(parsed);
  assert.equal(parsed.payload.type, "clipboard.writeText");
  assert.equal(parsed.payload.type === "clipboard.writeText" ? parsed.payload.text : undefined, "copy me");
  assert.equal(parsePanelRequest(wrap({ type: "clipboard.writeText", text: "" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "clipboard.writeText", text: 42 })), null);
});

test("session.summarize validates its session id and mode", () => {
  for (const mode of ["log", "ai"] as const) {
    const parsed = parsePanelRequest(wrap({ type: "session.summarize", sessionId: "session-1", mode }));
    assert.ok(parsed);
    assert.equal(parsed.payload.type, "session.summarize");
    assert.equal(parsed.payload.type === "session.summarize" ? parsed.payload.mode : undefined, mode);
  }
  assert.equal(parsePanelRequest(wrap({ type: "session.summarize", sessionId: "", mode: "log" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "session.summarize", mode: "log" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "session.summarize", sessionId: "session-1", mode: "haiku" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "session.summarize", sessionId: "session-1" })), null);
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

  const linked = parsePanelRequest(wrap({ type: "chat.start", prompt: "hello", taskId: "task-1" }));
  assert.equal(linked?.payload.type === "chat.start" ? linked.payload.taskId : undefined, "task-1");
  assert.equal(parsePanelRequest(wrap({ type: "chat.start", prompt: "hello", taskId: "" })), null);

  const taskFirst = parsePanelRequest(wrap({
    type: "chat.startSession",
    model: { providerId: "codex", model: "gpt-5.6-sol" },
    taskId: "task-1"
  }));
  assert.equal(taskFirst?.payload.type === "chat.startSession" ? taskFirst.payload.taskId : undefined, "task-1");
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

test("chat model selections preserve a bounded provider-advertised reasoning effort", () => {
  const parsed = parsePanelRequest(wrap({
    type: "chat.sendTurn",
    sessionId: "session-1",
    prompt: "solve it",
    model: { providerId: "codex", model: "gpt-5.6-sol", reasoningEffort: "ultra" }
  }));
  assert.ok(parsed);
  assert.deepEqual(
    parsed.payload.type === "chat.sendTurn" ? parsed.payload.model : undefined,
    { providerId: "codex", model: "gpt-5.6-sol", reasoningEffort: "ultra" }
  );
  assert.equal(parsePanelRequest(wrap({
    type: "chat.sendTurn",
    sessionId: "session-1",
    prompt: "solve it",
    model: { providerId: "codex", reasoningEffort: "x".repeat(MAX_MODEL_ID_LENGTH + 1) }
  })), null);
});

test("chat.reclaim accepts an optional model for a forced provider switch", () => {
  // Bare reclaim (no model) is valid - same-provider takeover.
  const bare = parsePanelRequest(wrap({ type: "chat.reclaim", sessionId: "session-1" }));
  assert.ok(bare);
  assert.equal(bare.payload.type === "chat.reclaim" ? bare.payload.model : "sentinel", undefined);
  // With a well-formed model (the forced-switch case).
  const withModel = parsePanelRequest(wrap({ type: "chat.reclaim", sessionId: "session-1", model: { providerId: "codex" } }));
  assert.ok(withModel);
  assert.deepEqual(withModel.payload.type === "chat.reclaim" ? withModel.payload.model : undefined, { providerId: "codex" });
  // A malformed (non-object) model rejects.
  assert.equal(parsePanelRequest(wrap({ type: "chat.reclaim", sessionId: "session-1", model: "codex" })), null);
  // A missing session id rejects.
  assert.equal(parsePanelRequest(wrap({ type: "chat.reclaim", sessionId: "" })), null);
});

test("ui.confirm requires message and confirmLabel, allows optional detail", () => {
  const ok = parsePanelRequest(wrap({ type: "ui.confirm", message: "Switch?", confirmLabel: "Switch" }));
  assert.ok(ok);
  const withDetail = parsePanelRequest(wrap({ type: "ui.confirm", message: "Switch?", confirmLabel: "Switch", detail: "New container" }));
  assert.ok(withDetail);
  assert.equal(withDetail.payload.type === "ui.confirm" ? withDetail.payload.detail : undefined, "New container");
  assert.equal(parsePanelRequest(wrap({ type: "ui.confirm", confirmLabel: "Switch" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "ui.confirm", message: "Switch?" })), null);
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
  // The view frame is optional and closed to the three known modes.
  assert.deepEqual(
    parsePanelRequest(wrap({ type: "diff.status", sessionId: "session-1", view: "full-session" }))?.payload,
    { type: "diff.status", sessionId: "session-1", view: "full-session" }
  );
  assert.equal(parsePanelRequest(wrap({ type: "diff.status", sessionId: "session-1", view: "git" })), null);
  assert.ok(parsePanelRequest(wrap({ type: "diff.acceptFile", baselineId: "baseline-1", path: "src/a.ts" })));
  assert.deepEqual(
    parsePanelRequest(wrap({ type: "diff.acceptFile", baselineId: "baseline-1", path: "src/a.ts", view: "turn" }))?.payload,
    { type: "diff.acceptFile", baselineId: "baseline-1", path: "src/a.ts", view: "turn" }
  );
  assert.equal(parsePanelRequest(wrap({ type: "diff.revertFile", baselineId: "baseline-1", path: "src/a.ts", view: "nope" })), null);
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

  // subtaskId narrows a SESSION link to one card (the chat rail's "Track as
  // subtask"). It is bounded, link-only, and meaningless without a session.
  const toCard = parsePanelRequest(wrap({
    type: "task.link",
    taskId: "task-1",
    sessionId: "session-1",
    subtaskId: "subtask-1"
  }));
  assert.ok(toCard);
  assert.deepEqual(toCard.payload, {
    type: "task.link",
    taskId: "task-1",
    sessionId: "session-1",
    subtaskId: "subtask-1"
  });
  assert.equal(parsePanelRequest(wrap({
    type: "task.link",
    taskId: "task-1",
    workspaceSetId: "set-1",
    subtaskId: "subtask-1"
  })), null);
  assert.equal(parsePanelRequest(wrap({
    type: "task.link",
    taskId: "task-1",
    sessionId: "session-1",
    subtaskId: ""
  })), null);
  assert.equal(parsePanelRequest(wrap({
    type: "task.unlink",
    taskId: "task-1",
    sessionId: "session-1",
    subtaskId: "subtask-1"
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
  const guided = parsePanelRequest(wrap({ type: "taskReview.open", taskId: "task-1", startGuide: true }));
  assert.deepEqual(guided?.payload, { type: "taskReview.open", taskId: "task-1", startGuide: true });
  assert.equal(parsePanelRequest(wrap({ type: "taskReview.open", taskId: "task-1", startGuide: "yes" })), null);
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

test("memory.open validates a bounded memoryCandidateId", () => {
  assert.ok(parsePanelRequest(wrap({ type: "memory.open", memoryCandidateId: "memory-1" })));
  assert.equal(parsePanelRequest(wrap({ type: "memory.open" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "memory.open", memoryCandidateId: "" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "memory.open", memoryCandidateId: 42 })), null);
  assert.equal(parsePanelRequest(wrap({ type: "memory.open", memoryCandidateId: "x".repeat(201) })), null);
});

test("board.state and taskBoard.open validate the optional guide handoff", () => {
  assert.ok(parsePanelRequest(wrap({ type: "board.state" })));
  assert.ok(parsePanelRequest(wrap({ type: "taskBoard.open" })));
  const guided = parsePanelRequest(wrap({ type: "taskBoard.open", startGuide: true }));
  assert.deepEqual(guided?.payload, { type: "taskBoard.open", startGuide: true });
  assert.equal(parsePanelRequest(wrap({ type: "taskBoard.open", startGuide: "yes" })), null);
});

test("board.moveCard validates cardKind, id, and columnId", () => {
  const task = parsePanelRequest(wrap({ type: "board.moveCard", cardKind: "task", id: "task-1", columnId: "col-todo" }));
  assert.ok(task);
  assert.deepEqual(
    task.payload.type === "board.moveCard" ? task.payload : undefined,
    { type: "board.moveCard", cardKind: "task", id: "task-1", columnId: "col-todo" }
  );
  assert.ok(parsePanelRequest(wrap({ type: "board.moveCard", cardKind: "subtask", id: "subtask-1", columnId: "col-todo" })));
  // An unknown cardKind, missing id, or missing columnId is rejected.
  assert.equal(parsePanelRequest(wrap({ type: "board.moveCard", cardKind: "epic", id: "task-1", columnId: "col-todo" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "board.moveCard", cardKind: "task", columnId: "col-todo" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "board.moveCard", cardKind: "task", id: "task-1" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "board.moveCard", cardKind: "task", id: "", columnId: "col-todo" })), null);
});

test("board.columns.update validates every column entry in the array", () => {
  const parsed = parsePanelRequest(wrap({
    type: "board.columns.update",
    columns: [
      { columnId: "col-backlog", name: "Backlog", category: "backlog", sortOrder: 0 },
      { name: "New Column", category: "pending", sortOrder: 1 }
    ]
  }));
  assert.ok(parsed);
  assert.deepEqual(
    parsed.payload.type === "board.columns.update" ? [...parsed.payload.columns] : undefined,
    [
      { columnId: "col-backlog", name: "Backlog", category: "backlog", sortOrder: 0 },
      { name: "New Column", category: "pending", sortOrder: 1 }
    ]
  );
  // Not an array, an empty name, an unknown category, or a non-numeric sortOrder
  // anywhere in the list rejects the whole request.
  assert.equal(parsePanelRequest(wrap({ type: "board.columns.update", columns: "nope" })), null);
  assert.equal(parsePanelRequest(wrap({
    type: "board.columns.update",
    columns: [{ name: "", category: "backlog", sortOrder: 0 }]
  })), null);
  assert.equal(parsePanelRequest(wrap({
    type: "board.columns.update",
    columns: [{ name: "Weird", category: "someday", sortOrder: 0 }]
  })), null);
  assert.equal(parsePanelRequest(wrap({
    type: "board.columns.update",
    columns: [{ name: "Weird", category: "backlog", sortOrder: "first" }]
  })), null);
});

test("board.columns.update accepts an optional deletedColumnIds array", () => {
  const parsed = parsePanelRequest(wrap({
    type: "board.columns.update",
    columns: [{ columnId: "col-backlog", name: "Backlog", category: "backlog", sortOrder: 0 }],
    deletedColumnIds: ["col-blocked", "col-review"]
  }));
  assert.ok(parsed);
  assert.deepEqual(
    parsed.payload.type === "board.columns.update" ? parsed.payload.deletedColumnIds : undefined,
    ["col-blocked", "col-review"]
  );

  // Absent deletedColumnIds is fine (undefined, not required).
  const withoutDeletes = parsePanelRequest(wrap({
    type: "board.columns.update",
    columns: [{ columnId: "col-backlog", name: "Backlog", category: "backlog", sortOrder: 0 }]
  }));
  assert.ok(withoutDeletes);
  assert.equal(
    withoutDeletes.payload.type === "board.columns.update" ? withoutDeletes.payload.deletedColumnIds : "missing",
    undefined
  );

  // Not an array, or any non-bounded-string entry, rejects the whole request.
  assert.equal(parsePanelRequest(wrap({
    type: "board.columns.update",
    columns: [{ columnId: "col-backlog", name: "Backlog", category: "backlog", sortOrder: 0 }],
    deletedColumnIds: "col-blocked"
  })), null);
  assert.equal(parsePanelRequest(wrap({
    type: "board.columns.update",
    columns: [{ columnId: "col-backlog", name: "Backlog", category: "backlog", sortOrder: 0 }],
    deletedColumnIds: ["col-blocked", ""]
  })), null);
});

test("subtask.create validates taskId, title, and the optional prompt/autoStart fields", () => {
  assert.ok(parsePanelRequest(wrap({ type: "subtask.create", taskId: "task-1", title: "Draft outline" })));
  const full = parsePanelRequest(wrap({
    type: "subtask.create",
    taskId: "task-1",
    title: "Draft outline",
    description: "notes",
    prompt: "Write the outline",
    autoStart: true
  }));
  assert.ok(full);
  assert.deepEqual(
    full.payload.type === "subtask.create" ? full.payload : undefined,
    {
      type: "subtask.create",
      taskId: "task-1",
      title: "Draft outline",
      description: "notes",
      prompt: "Write the outline",
      autoStart: true
    }
  );
  assert.equal(parsePanelRequest(wrap({ type: "subtask.create", taskId: "task-1", title: "" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "subtask.create", title: "Draft outline" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "subtask.create", taskId: "task-1", title: "Draft outline", autoStart: "yes" })), null);
});

test("subtask.update requires at least one field and clears description/prompt with empty string", () => {
  assert.equal(parsePanelRequest(wrap({ type: "subtask.update", subtaskId: "subtask-1" })), null);
  assert.ok(parsePanelRequest(wrap({ type: "subtask.update", subtaskId: "subtask-1", title: "Renamed" })));
  const clearedPrompt = parsePanelRequest(wrap({ type: "subtask.update", subtaskId: "subtask-1", prompt: "" }));
  assert.ok(clearedPrompt);
  assert.equal(clearedPrompt.payload.type === "subtask.update" ? clearedPrompt.payload.prompt : undefined, "");
  const clearedDescription = parsePanelRequest(wrap({ type: "subtask.update", subtaskId: "subtask-1", description: "" }));
  assert.ok(clearedDescription);
  assert.equal(clearedDescription.payload.type === "subtask.update" ? clearedDescription.payload.description : undefined, "");
  assert.ok(parsePanelRequest(wrap({ type: "subtask.update", subtaskId: "subtask-1", autoStart: false })));
  assert.ok(parsePanelRequest(wrap({ type: "subtask.update", subtaskId: "subtask-1", columnId: "col-todo" })));
  assert.equal(parsePanelRequest(wrap({ type: "subtask.update", subtaskId: "subtask-1", autoStart: "true" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "subtask.update", subtaskId: "" , title: "Renamed" })), null);
  // seedMode (ADR 0014): a closed two-value enum, valid alone as the one field.
  const seeded = parsePanelRequest(wrap({ type: "subtask.update", subtaskId: "subtask-1", seedMode: "upstream" }));
  assert.ok(seeded);
  assert.equal(seeded.payload.type === "subtask.update" ? seeded.payload.seedMode : undefined, "upstream");
  assert.ok(parsePanelRequest(wrap({ type: "subtask.update", subtaskId: "subtask-1", seedMode: "local" })));
  assert.equal(parsePanelRequest(wrap({ type: "subtask.update", subtaskId: "subtask-1", seedMode: "remote" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "subtask.update", subtaskId: "subtask-1", seedMode: 1 })), null);
  // verified (ADR 0007): a boolean, valid alone as the one field.
  assert.ok(parsePanelRequest(wrap({ type: "subtask.update", subtaskId: "subtask-1", verified: true })));
  assert.equal(parsePanelRequest(wrap({ type: "subtask.update", subtaskId: "subtask-1", verified: "yes" })), null);
});

test("agents.landSession and task.faq.* validate bounded ids (ADRs 0014/0007)", () => {
  assert.ok(parsePanelRequest(wrap({ type: "agents.landSession", sessionId: "session-1" })));
  assert.equal(parsePanelRequest(wrap({ type: "agents.landSession" })), null);
  assert.ok(parsePanelRequest(wrap({ type: "task.faq.list", taskId: "task-1" })));
  assert.ok(parsePanelRequest(wrap({ type: "task.faq.add", taskId: "task-1", pattern: "branch", answer: "Use feature/x." })));
  assert.equal(parsePanelRequest(wrap({ type: "task.faq.add", taskId: "task-1", pattern: "" , answer: "x" })), null);
  assert.ok(parsePanelRequest(wrap({ type: "task.faq.remove", taskId: "task-1", faqId: "faq-1" })));
  assert.equal(parsePanelRequest(wrap({ type: "task.faq.remove", taskId: "task-1" })), null);
  // task.update accepts the auto-answer toggle alone.
  assert.ok(parsePanelRequest(wrap({ type: "task.update", taskId: "task-1", autoAnswerFaq: true })));
  assert.equal(parsePanelRequest(wrap({ type: "task.update", taskId: "task-1", autoAnswerFaq: "on" })), null);
});

test("recipes.list and task.createFromRecipe validate their payloads (ADR 0007)", () => {
  assert.ok(parsePanelRequest(wrap({ type: "recipes.list" })));
  const created = parsePanelRequest(wrap({ type: "task.createFromRecipe", recipeId: "recipe-1", title: "Shot 042" }));
  assert.ok(created);
  assert.equal(created.payload.type === "task.createFromRecipe" ? created.payload.recipeId : undefined, "recipe-1");
  assert.equal(parsePanelRequest(wrap({ type: "task.createFromRecipe", recipeId: "recipe-1" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "task.createFromRecipe", recipeId: "", title: "x" })), null);
});

test("subtask.delete validates a bounded subtaskId", () => {
  assert.ok(parsePanelRequest(wrap({ type: "subtask.delete", subtaskId: "subtask-1" })));
  assert.equal(parsePanelRequest(wrap({ type: "subtask.delete" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "subtask.delete", subtaskId: "" })), null);
});

test("subtask.dependency.add/remove validate taskId and both subtask ids", () => {
  for (const type of ["subtask.dependency.add", "subtask.dependency.remove"] as const) {
    const parsed = parsePanelRequest(wrap({ type, taskId: "task-1", fromSubtaskId: "sub-a", toSubtaskId: "sub-b" }));
    assert.ok(parsed);
    assert.equal(parsed.payload.type, type);
    assert.deepEqual(
      parsed.payload.type === type ? parsed.payload : undefined,
      { type, taskId: "task-1", fromSubtaskId: "sub-a", toSubtaskId: "sub-b" }
    );
    assert.equal(parsePanelRequest(wrap({ type, fromSubtaskId: "sub-a", toSubtaskId: "sub-b" })), null);
    assert.equal(parsePanelRequest(wrap({ type, taskId: "task-1", toSubtaskId: "sub-b" })), null);
    assert.equal(parsePanelRequest(wrap({ type, taskId: "task-1", fromSubtaskId: "sub-a" })), null);
  }
});

test("subtask.start accepts an optional force flag", () => {
  assert.ok(parsePanelRequest(wrap({ type: "subtask.start", subtaskId: "subtask-1" })));
  const forced = parsePanelRequest(wrap({ type: "subtask.start", subtaskId: "subtask-1", force: true }));
  assert.ok(forced);
  assert.equal(forced.payload.type === "subtask.start" ? forced.payload.force : undefined, true);
  assert.equal(parsePanelRequest(wrap({ type: "subtask.start", subtaskId: "subtask-1", force: "yes" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "subtask.start" })), null);
});

test("task.start validates a bounded taskId", () => {
  assert.ok(parsePanelRequest(wrap({ type: "task.start", taskId: "task-1" })));
  assert.equal(parsePanelRequest(wrap({ type: "task.start" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "task.start", taskId: "" })), null);
});

test("active.get/active.set validate the spine payloads", () => {
  assert.ok(parsePanelRequest(wrap({ type: "active.get" })));
  const set = parsePanelRequest(wrap({ type: "active.set", taskId: "task-1" }));
  assert.ok(set);
  assert.deepEqual(set.payload, { type: "active.set", taskId: "task-1" });
  // Null is the explicit "no active task" value, not a malformed payload.
  const cleared = parsePanelRequest(wrap({ type: "active.set", taskId: null }));
  assert.ok(cleared);
  assert.deepEqual(cleared.payload, { type: "active.set", taskId: null });
  assert.equal(parsePanelRequest(wrap({ type: "active.set" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "active.set", taskId: "" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "active.set", taskId: 7 })), null);
  assert.equal(parsePanelRequest(wrap({ type: "active.set", taskId: "t".repeat(201) })), null);
});

test("session.recents validates its optional limit", () => {
  const bare = parsePanelRequest(wrap({ type: "session.recents" }));
  assert.ok(bare);
  assert.deepEqual(bare.payload, { type: "session.recents" });
  const limited = parsePanelRequest(wrap({ type: "session.recents", limit: 7 }));
  assert.ok(limited);
  assert.deepEqual(limited.payload, { type: "session.recents", limit: 7 });
  assert.ok(parsePanelRequest(wrap({ type: "session.recents", limit: MAX_RECENTS_LIMIT })));
  // Non-integers, zero/negatives, and anything past the cap are malformed.
  assert.equal(parsePanelRequest(wrap({ type: "session.recents", limit: 0 })), null);
  assert.equal(parsePanelRequest(wrap({ type: "session.recents", limit: -1 })), null);
  assert.equal(parsePanelRequest(wrap({ type: "session.recents", limit: 2.5 })), null);
  assert.equal(parsePanelRequest(wrap({ type: "session.recents", limit: MAX_RECENTS_LIMIT + 1 })), null);
  assert.equal(parsePanelRequest(wrap({ type: "session.recents", limit: "7" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "session.recents", limit: null })), null);
});

test("hub.state validates a bounded taskId (UX overhaul P3)", () => {
  const parsed = parsePanelRequest(wrap({ type: "hub.state", taskId: "task-1" }));
  assert.ok(parsed);
  assert.deepEqual(parsed.payload, { type: "hub.state", taskId: "task-1" });
  assert.equal(parsePanelRequest(wrap({ type: "hub.state" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "hub.state", taskId: "" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "hub.state", taskId: null })), null);
  assert.equal(parsePanelRequest(wrap({ type: "hub.state", taskId: 7 })), null);
  assert.equal(parsePanelRequest(wrap({ type: "hub.state", taskId: "t".repeat(201) })), null);
});

test("panel.openSurface accepts only the closed surface enum with bounded ids", () => {
  for (const surface of PANEL_SURFACES) {
    const parsed = parsePanelRequest(wrap({ type: "panel.openSurface", surface }));
    assert.ok(parsed);
    assert.deepEqual(parsed.payload, { type: "panel.openSurface", surface });
  }
  const scoped = parsePanelRequest(wrap({ type: "panel.openSurface", surface: "planner", taskId: "task-1", planId: "plan-1" }));
  assert.ok(scoped);
  assert.deepEqual(scoped.payload, { type: "panel.openSurface", surface: "planner", taskId: "task-1", planId: "plan-1" });
  // The hub is a surface too: a rail row opens it with the task it selected.
  const hub = parsePanelRequest(wrap({ type: "panel.openSurface", surface: "hub", taskId: "task-1" }));
  assert.ok(hub);
  assert.deepEqual(hub.payload, { type: "panel.openSurface", surface: "hub", taskId: "task-1" });
  // A surface is never a command name, and ids stay bounded.
  assert.equal(parsePanelRequest(wrap({ type: "panel.openSurface", surface: "workbench.action.reloadWindow" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "panel.openSurface" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "panel.openSurface", surface: "board", taskId: "" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "panel.openSurface", surface: "board", taskId: 7 })), null);
  assert.equal(parsePanelRequest(wrap({ type: "panel.openSurface", surface: "planner", planId: "p".repeat(201) })), null);
});

// --- Configure panel (UX overhaul P6) ---------------------------------------

test("config.state accepts only the closed scope enum", () => {
  const bare = parsePanelRequest(wrap({ type: "config.state" }));
  assert.ok(bare);
  assert.deepEqual(bare.payload, { type: "config.state" });
  for (const scope of ["global", "project"] as const) {
    const parsed = parsePanelRequest(wrap({ type: "config.state", scope }));
    assert.ok(parsed);
    assert.deepEqual(parsed.payload, { type: "config.state", scope });
  }
  assert.equal(parsePanelRequest(wrap({ type: "config.state", scope: "machine" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.state", scope: null })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.state", scope: 1 })), null);
});

test("config.setSetting bounds its section, key shape, and JSON-safe value", () => {
  for (const section of CONFIG_SETTING_SECTIONS) {
    assert.ok(parsePanelRequest(wrap({ type: "config.setSetting", section, key: "runtime.env", value: {} })));
  }
  // Sections are a closed enum, not a free namespace.
  assert.equal(parsePanelRequest(wrap({ type: "config.setSetting", section: "providers", key: "a", value: true })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.setSetting", section: null, key: "a", value: true })), null);

  // Key shape: dotted identifiers only - no traversal, no path separators.
  assert.ok(parsePanelRequest(wrap({ type: "config.setSetting", section: "security", key: "security.cloneOnly", value: true })));
  assert.equal(parsePanelRequest(wrap({ type: "config.setSetting", section: "security", key: "", value: true })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.setSetting", section: "security", key: "..", value: true })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.setSetting", section: "security", key: "a b", value: true })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.setSetting", section: "security", key: "a/../b", value: true })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.setSetting", section: "security", key: 7, value: true })), null);

  // Accepted value shapes: scalars, string lists, string maps, tag-rule rows.
  const bool = parsePanelRequest(wrap({ type: "config.setSetting", section: "security", key: "security.cloneOnly", value: false }));
  assert.ok(bool);
  assert.deepEqual(bool.payload, { type: "config.setSetting", section: "security", key: "security.cloneOnly", value: false });
  const number = parsePanelRequest(wrap({ type: "config.setSetting", section: "runtime", key: "orchestrator.maxConcurrentRuns", value: 4 }));
  assert.ok(number);
  assert.equal(number.payload.type === "config.setSetting" ? number.payload.value : null, 4);
  const list = parsePanelRequest(wrap({ type: "config.setSetting", section: "runtime", key: "runtime.pathAdditions", value: ["C:\\tools"] }));
  assert.ok(list);
  assert.deepEqual(list.payload.type === "config.setSetting" ? list.payload.value : null, ["C:\\tools"]);
  const map = parsePanelRequest(wrap({ type: "config.setSetting", section: "runtime", key: "runtime.env", value: { REZ_CONFIG: "1" } }));
  assert.ok(map);
  assert.deepEqual(map.payload.type === "config.setSetting" ? map.payload.value : null, { REZ_CONFIG: "1" });
  const rules = parsePanelRequest(wrap({
    type: "config.setSetting",
    section: "memories",
    key: "memory.tagRules",
    value: [{ globs: ["*.usd", "*.usda"], tag: "usd" }]
  }));
  assert.ok(rules);
  assert.deepEqual(
    rules.payload.type === "config.setSetting" ? rules.payload.value : null,
    [{ globs: ["*.usd", "*.usda"], tag: "usd" }]
  );

  // Rejected: null, nested objects, non-string map values, malformed rules, oversize lists.
  assert.equal(parsePanelRequest(wrap({ type: "config.setSetting", section: "runtime", key: "runtime.env", value: null })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.setSetting", section: "runtime", key: "runtime.env", value: { a: { b: 1 } } })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.setSetting", section: "runtime", key: "runtime.env", value: { a: 1 } })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.setSetting", section: "runtime", key: "x", value: Number.NaN })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.setSetting", section: "memories", key: "memory.tagRules", value: [{ globs: [], tag: "usd" }] })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.setSetting", section: "memories", key: "memory.tagRules", value: [{ globs: ["*.usd"] }] })), null);
  assert.equal(
    parsePanelRequest(wrap({ type: "config.setSetting", section: "runtime", key: "runtime.pathAdditions", value: new Array(65).fill("x") })),
    null
  );
  assert.equal(parsePanelRequest(wrap({ type: "config.setSetting", section: "runtime", key: "runtime.env" })), null);
});

test("config MCP writes bound their ids, names, commands, and args", () => {
  const toggled = parsePanelRequest(wrap({ type: "config.mcpToggle", serverId: "mcp-1", enabled: true }));
  assert.ok(toggled);
  assert.deepEqual(toggled.payload, { type: "config.mcpToggle", serverId: "mcp-1", enabled: true });
  assert.equal(parsePanelRequest(wrap({ type: "config.mcpToggle", serverId: "mcp-1", enabled: "yes" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.mcpToggle", serverId: "", enabled: true })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.mcpToggle", enabled: true })), null);

  const added = parsePanelRequest(wrap({ type: "config.mcpAdd", name: "docs", command: "npx", args: ["-y", "docs-mcp"] }));
  assert.ok(added);
  assert.deepEqual(added.payload, { type: "config.mcpAdd", name: "docs", command: "npx", args: ["-y", "docs-mcp"] });
  assert.ok(parsePanelRequest(wrap({ type: "config.mcpAdd", name: "docs", command: "npx", args: [] })));
  assert.equal(parsePanelRequest(wrap({ type: "config.mcpAdd", name: "docs", command: "npx" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.mcpAdd", name: "", command: "npx", args: [] })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.mcpAdd", name: "docs", command: "", args: [] })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.mcpAdd", name: "docs", command: "npx", args: ["", "x"] })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.mcpAdd", name: "docs", command: "npx", args: [7] })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.mcpAdd", name: "docs", command: "npx", args: new Array(33).fill("x") })), null);
});

test("config provider requests bound their provider and model ids", () => {
  const signIn = parsePanelRequest(wrap({ type: "config.provider.signIn", providerId: "claude" }));
  assert.ok(signIn);
  assert.deepEqual(signIn.payload, { type: "config.provider.signIn", providerId: "claude" });
  assert.equal(parsePanelRequest(wrap({ type: "config.provider.signIn", providerId: "" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.provider.signIn", providerId: "p".repeat(MAX_MODEL_ID_LENGTH + 1) })), null);

  const set = parsePanelRequest(wrap({ type: "config.provider.setDefaultModel", providerId: "codex", model: "gpt-5" }));
  assert.ok(set);
  assert.deepEqual(set.payload, { type: "config.provider.setDefaultModel", providerId: "codex", model: "gpt-5" });
  // The empty model clears the stored default back to the registry pick.
  const cleared = parsePanelRequest(wrap({ type: "config.provider.setDefaultModel", providerId: "codex", model: "" }));
  assert.ok(cleared);
  assert.equal(cleared.payload.type === "config.provider.setDefaultModel" ? cleared.payload.model : null, "");
  assert.equal(parsePanelRequest(wrap({ type: "config.provider.setDefaultModel", providerId: "codex" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.provider.setDefaultModel", providerId: "codex", model: 7 })), null);
  assert.equal(
    parsePanelRequest(wrap({ type: "config.provider.setDefaultModel", providerId: "codex", model: "m".repeat(MAX_MODEL_ID_LENGTH + 1) })),
    null
  );
});

// ---------------------------------------------------------------------------
// Validation runtimes (ADR 0022 M7)
// ---------------------------------------------------------------------------

test("validation reads take no arguments and validation ids are bounded", () => {
  assert.ok(parsePanelRequest(wrap({ type: "config.validation.state" })));
  assert.ok(parsePanelRequest(wrap({ type: "validation.railStatus" })));

  for (const type of [
    "config.validation.setDefault",
    "config.validation.runProbes",
    "config.validation.adopt",
    "config.validation.revertReprobe"
  ]) {
    const parsed = parsePanelRequest(wrap({ type, runtimeId: "vruntime-1" }));
    assert.ok(parsed, `${type} accepts a bounded id`);
    assert.deepEqual(parsed.payload, { type, runtimeId: "vruntime-1" });
    assert.equal(parsePanelRequest(wrap({ type, runtimeId: "" })), null);
    assert.equal(parsePanelRequest(wrap({ type })), null);
    assert.equal(parsePanelRequest(wrap({ type, runtimeId: "v".repeat(MAX_ID_LENGTH + 1) })), null);
  }
});

test("createRuntime validates its enum, its capability list, and its exec address", () => {
  const base = {
    type: "config.validation.createRuntime",
    displayName: "cpp-builds",
    image: "win11-msvc",
    lifecycle: "on-demand",
    capabilities: ["msvc", "msvc"],
    policyProfileRef: "validation-standard"
  };
  const parsed = parsePanelRequest(wrap(base));
  assert.ok(parsed);
  assert.deepEqual(parsed.payload, { ...base, capabilities: ["msvc"] }, "duplicate capabilities collapse");

  const connected = parsePanelRequest(wrap({
    ...base,
    profileException: true,
    connection: { host: "10.0.0.5", port: 2222, user: "drydock" }
  }));
  assert.ok(connected);
  assert.deepEqual(
    connected.payload.type === "config.validation.createRuntime" ? connected.payload.connection : null,
    { host: "10.0.0.5", port: 2222, user: "drydock" }
  );

  assert.equal(parsePanelRequest(wrap({ ...base, lifecycle: "always-on" })), null);
  assert.equal(parsePanelRequest(wrap({ ...base, displayName: "" })), null);
  assert.equal(parsePanelRequest(wrap({ ...base, image: "i".repeat(201) })), null);
  assert.equal(parsePanelRequest(wrap({ ...base, capabilities: "msvc" })), null);
  assert.equal(parsePanelRequest(wrap({ ...base, capabilities: [7] })), null);
  assert.equal(parsePanelRequest(wrap({ ...base, capabilities: new Array(33).fill("x") })), null);
  assert.equal(parsePanelRequest(wrap({ ...base, profileException: "yes" })), null);
  assert.equal(parsePanelRequest(wrap({ ...base, connection: { host: "10.0.0.5" } })), null);
  assert.equal(parsePanelRequest(wrap({ ...base, connection: { host: "10.0.0.5", user: "d", port: 0 } })), null);
  assert.equal(parsePanelRequest(wrap({ ...base, connection: { host: "10.0.0.5", user: "d", port: 70_000 } })), null);
  // Creation cannot clear an address it never set.
  assert.equal(parsePanelRequest(wrap({ ...base, connection: null })), null);
});

test("updateRuntime takes a partial edit and only null clears the address", () => {
  const parsed = parsePanelRequest(wrap({
    type: "config.validation.updateRuntime",
    runtimeId: "vruntime-1",
    update: { displayName: "renamed", capabilities: ["maya"], archived: true }
  }));
  assert.ok(parsed);
  assert.deepEqual(
    parsed.payload.type === "config.validation.updateRuntime" ? parsed.payload.update : null,
    { displayName: "renamed", capabilities: ["maya"], archived: true }
  );

  const cleared = parsePanelRequest(wrap({
    type: "config.validation.updateRuntime",
    runtimeId: "vruntime-1",
    update: { connection: null }
  }));
  assert.ok(cleared);
  assert.deepEqual(
    cleared.payload.type === "config.validation.updateRuntime" ? cleared.payload.update : null,
    { connection: null }
  );

  // An empty edit, a junk edit, and a malformed field are all refused.
  assert.equal(parsePanelRequest(wrap({ type: "config.validation.updateRuntime", runtimeId: "vruntime-1", update: {} })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.validation.updateRuntime", runtimeId: "vruntime-1", update: [] })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.validation.updateRuntime", runtimeId: "vruntime-1" })), null);
  assert.equal(
    parsePanelRequest(wrap({ type: "config.validation.updateRuntime", runtimeId: "vruntime-1", update: { lifecycle: "sometimes" } })),
    null
  );
  assert.equal(
    parsePanelRequest(wrap({ type: "config.validation.updateRuntime", runtimeId: "", update: { displayName: "x" } })),
    null
  );
});

test("deleteRuntime carries an optional reassignment target", () => {
  const plain = parsePanelRequest(wrap({ type: "config.validation.deleteRuntime", runtimeId: "vruntime-1" }));
  assert.ok(plain);
  assert.deepEqual(plain.payload, { type: "config.validation.deleteRuntime", runtimeId: "vruntime-1" });
  const reassigned = parsePanelRequest(wrap({
    type: "config.validation.deleteRuntime",
    runtimeId: "vruntime-1",
    reassignTo: "vruntime-2"
  }));
  assert.ok(reassigned);
  assert.deepEqual(reassigned.payload, {
    type: "config.validation.deleteRuntime",
    runtimeId: "vruntime-1",
    reassignTo: "vruntime-2"
  });
  assert.equal(parsePanelRequest(wrap({ type: "config.validation.deleteRuntime", runtimeId: "vruntime-1", reassignTo: "" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.validation.deleteRuntime" })), null);
});

test("registry settings take a preset, a whole-number cap, or an explicit clear", () => {
  const preset = parsePanelRequest(wrap({ type: "config.validation.setSettings", topologyPreset: "per-project" }));
  assert.ok(preset);
  assert.deepEqual(preset.payload, { type: "config.validation.setSettings", topologyPreset: "per-project" });

  const cleared = parsePanelRequest(wrap({ type: "config.validation.setSettings", warmCap: null }));
  assert.ok(cleared);
  assert.deepEqual(cleared.payload, { type: "config.validation.setSettings", warmCap: null });
  assert.ok(parsePanelRequest(wrap({ type: "config.validation.setSettings", warmCap: 0 })));

  assert.equal(parsePanelRequest(wrap({ type: "config.validation.setSettings" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.validation.setSettings", topologyPreset: "many" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.validation.setSettings", warmCap: -1 })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.validation.setSettings", warmCap: 1.5 })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.validation.setSettings", warmCap: 65 })), null);
});

test("association writes bound both ids", () => {
  const set = parsePanelRequest(wrap({
    type: "config.validation.setAssociation",
    projectRootId: "project-a",
    runtimeId: "vruntime-1"
  }));
  assert.ok(set);
  assert.deepEqual(set.payload, {
    type: "config.validation.setAssociation",
    projectRootId: "project-a",
    runtimeId: "vruntime-1"
  });
  assert.equal(parsePanelRequest(wrap({ type: "config.validation.setAssociation", projectRootId: "project-a" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.validation.setAssociation", runtimeId: "vruntime-1" })), null);

  const cleared = parsePanelRequest(wrap({ type: "config.validation.clearAssociation", projectRootId: "project-a" }));
  assert.ok(cleared);
  assert.deepEqual(cleared.payload, { type: "config.validation.clearAssociation", projectRootId: "project-a" });
  assert.equal(parsePanelRequest(wrap({ type: "config.validation.clearAssociation", projectRootId: "" })), null);
});

test("job reads, aborts, requeues, and the manual run bound their ids", () => {
  assert.ok(parsePanelRequest(wrap({ type: "validation.jobs" })));
  const filtered = parsePanelRequest(wrap({ type: "validation.jobs", taskId: "task-1", sessionId: "session-1" }));
  assert.ok(filtered);
  assert.deepEqual(filtered.payload, { type: "validation.jobs", taskId: "task-1", sessionId: "session-1" });
  assert.equal(parsePanelRequest(wrap({ type: "validation.jobs", taskId: "" })), null);

  const aborted = parsePanelRequest(wrap({ type: "validation.abortJob", jobId: "vjob-1" }));
  assert.ok(aborted);
  assert.deepEqual(aborted.payload, { type: "validation.abortJob", jobId: "vjob-1" });
  assert.equal(parsePanelRequest(wrap({ type: "validation.abortJob" })), null);

  const requeued = parsePanelRequest(wrap({
    type: "validation.requeue",
    jobId: "vjob-1",
    rerouteTo: "vruntime-2",
    confirmedDelta: true
  }));
  assert.ok(requeued);
  assert.deepEqual(requeued.payload, {
    type: "validation.requeue",
    jobId: "vjob-1",
    rerouteTo: "vruntime-2",
    confirmedDelta: true
  });
  assert.ok(parsePanelRequest(wrap({ type: "validation.requeue", jobId: "vjob-1" })));
  assert.equal(parsePanelRequest(wrap({ type: "validation.requeue", jobId: "vjob-1", confirmedDelta: "yes" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "validation.requeue", jobId: "vjob-1", rerouteTo: "" })), null);

  const run = parsePanelRequest(wrap({ type: "validation.run", sessionId: "session-1" }));
  assert.ok(run);
  assert.deepEqual(run.payload, { type: "validation.run", sessionId: "session-1" });
  assert.equal(parsePanelRequest(wrap({ type: "validation.run" })), null);
});

test("the task runtime override clears by OMITTING the runtime, never by empty string", () => {
  const set = parsePanelRequest(wrap({ type: "validation.setTaskRuntime", taskId: "task-1", runtimeId: "vruntime-2" }));
  assert.ok(set);
  assert.deepEqual(set.payload, { type: "validation.setTaskRuntime", taskId: "task-1", runtimeId: "vruntime-2" });

  const cleared = parsePanelRequest(wrap({ type: "validation.setTaskRuntime", taskId: "task-1" }));
  assert.ok(cleared);
  assert.deepEqual(cleared.payload, { type: "validation.setTaskRuntime", taskId: "task-1" });

  assert.equal(parsePanelRequest(wrap({ type: "validation.setTaskRuntime", taskId: "task-1", runtimeId: "" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "validation.setTaskRuntime", runtimeId: "vruntime-2" })), null);
});

test("config.openFile bounds its path (the host still re-checks its own allowlist)", () => {
  const parsed = parsePanelRequest(wrap({ type: "config.openFile", path: "C:\\repo\\.drydock\\mcp.json" }));
  assert.ok(parsed);
  assert.deepEqual(parsed.payload, { type: "config.openFile", path: "C:\\repo\\.drydock\\mcp.json" });
  assert.equal(parsePanelRequest(wrap({ type: "config.openFile", path: "" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.openFile" })), null);
  assert.equal(parsePanelRequest(wrap({ type: "config.openFile", path: "p".repeat(1_025) })), null);
});
