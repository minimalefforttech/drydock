/**
 * Mock extension host for the webview visual-test harness.
 *
 * Loads BEFORE the real bundled main.js and provides acquireVsCodeApi plus a
 * fixture-backed message host speaking the exact envelope protocol
 * (protocolVersion 1, request/response/push). Fixtures are deterministic
 * dummy data — no real backend, no docker, no network. Drive scripted flows
 * from the console or preview_eval via window.__harness.
 */

(function bootstrapHarness() {
  const PROTOCOL = 1;
  let pushSequence = 0;
  let webviewState;

  // --- fixtures ---------------------------------------------------------------
  const now = Date.now();
  const iso = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();

  const sessions = [
    {
      sessionId: "s-live",
      title: "Add alembic support to asset_api",
      description: "root cause traced to publish hooks",
      status: "active",
      providerId: "codex",
      model: "gpt-5.5",
      transport: "codex-app-server",
      agentActivity: {
        running: 2,
        failed: 0,
        agents: [
          { nodeId: "task-audit", label: "Audit publish hooks", status: "running", startedAt: iso(13), lastActivityAt: iso(6), lastActivity: "grep allowlist", lastCommand: "grep", toolUses: 29, tokens: 257000 },
          { nodeId: "task-exporter", label: "Patch alembic exporter", status: "running", startedAt: iso(3), lastActivityAt: iso(1), lastActivity: "edit exporters/alembic.py", lastCommand: "Edit", toolUses: 52, tokens: 59900 }
        ]
      },
      createdAt: iso(180),
      updatedAt: iso(2)
    },
    { sessionId: "s-waiting", title: "Refactor farm submit retries", status: "active", providerId: "claude", model: "claude-opus-4-8", createdAt: iso(240), updatedAt: iso(35) },
    { sessionId: "s-ended", title: "Investigate USD 24 upgrade", status: "ended", providerId: "codex", model: "gpt-5.4", createdAt: iso(2000), updatedAt: iso(1900) },
    { sessionId: "s-failed", title: "Docs generation spike", status: "failed", providerId: "codex", model: "gpt-5.5", createdAt: iso(500), updatedAt: iso(480) },
    { sessionId: "s-elsewhere", title: "Nightly test triage (window 2)", status: "active", providerId: "claude", model: "claude-opus-4-8", runningElsewhere: true, createdAt: iso(120), updatedAt: iso(8) },
    { sessionId: "s-clone", title: "Clone: rewire asset_api publish", status: "active", providerId: "codex", model: "gpt-5.5", mode: "clone", createdAt: iso(90), updatedAt: iso(4) }
  ];

  const timelineText = [
    "## Findings",
    "",
    "The publish hook rejects `.abc` because the extension allowlist in `publish_hooks.py` predates alembic.",
    "",
    "- `productiondb` schema already supports the type",
    "- only the allowlist and the two DCC exporters need changes",
    "",
    "```python",
    "ALLOWED = {\"usd\", \"ma\", \"hip\", \"abc\"}  # added abc",
    "```",
    "",
    "```mermaid",
    "flowchart LR; DCC-->Exporter-->PublishHook-->ProductionDB",
    "```"
  ].join("\n");

  const timelines = {
    "s-live": [
      { sequence: 1, eventType: "user.message", summary: "Why does publishing alembic caches fail?", createdAt: iso(60) },
      { sequence: 2, eventType: "agent.text", summary: timelineText, createdAt: iso(58), final: true },
      { sequence: 3, eventType: "agent.spawn", summary: "spawned Audit publish hooks", nodeId: "task-audit", label: "Audit publish hooks", subagentType: "general-purpose", model: "gpt-5.5", nodeStatus: "running", detail: "Audit publish hooks and summarize the allowlist path.", createdAt: iso(13) },
      { sequence: 4, eventType: "agent.command", summary: "grep allowlist [started]", toolStatus: "started", commandName: "grep", agentPath: ["task-audit"], createdAt: iso(6) },
      { sequence: 5, eventType: "agent.spawn", summary: "spawned Patch alembic exporter", nodeId: "task-exporter", label: "Patch alembic exporter", subagentType: "general-purpose", model: "gpt-5.5", nodeStatus: "running", detail: "Patch exporters/alembic.py and report changed files.", createdAt: iso(3) },
      { sequence: 6, eventType: "agent.tool_call", summary: "Edit started", toolStatus: "started", commandName: "Edit", agentPath: ["task-exporter"], createdAt: iso(1) }
    ],
    "s-ended": [
      { sequence: 1, eventType: "user.message", summary: "Assess a USD 24.x upgrade.", createdAt: iso(1950) },
      { sequence: 2, eventType: "agent.text", summary: "USD 24 requires a Houdini rebuild; details in the plan docs.", createdAt: iso(1940), final: true }
    ]
  };

  const catalogs = [
    {
      providerId: "codex", displayName: "Codex / OpenAI", refreshedAt: iso(1), source: "provider", diagnostics: [], authStatus: "authenticated",
      models: [
        { id: "gpt-5.5", displayName: "GPT-5.5", isDefault: true, hidden: false },
        { id: "gpt-5.4", displayName: "GPT-5.4", isDefault: false, hidden: false }
      ]
    },
    {
      providerId: "claude", displayName: "Claude / Anthropic", refreshedAt: iso(1), source: "provider", diagnostics: [], authStatus: "needs-login", loginHint: "sbx secret set -g anthropic --oauth",
      models: [
        { id: "claude-opus-4-8", displayName: "Claude Opus 4.8", isDefault: true, hidden: false },
        { id: "claude-fable-5", displayName: "Claude Fable 5", isDefault: false, hidden: false }
      ]
    }
  ];

  const workspacePolicy = {
    projects: [
      { projectId: "p-demo", name: "demo-project", displayPath: "C:\\hitl\\demo-project", kind: "git" },
      { projectId: "p-asset", name: "asset_api", displayPath: "C:\\hitl\\asset_api", kind: "git" }
    ],
    workspaceSets: [
      { workspaceSetId: "set-1", name: "pipeline", projectNames: ["demo-project", "asset_api"] }
    ],
    accessRequests: [
      { accessRequestId: "ar-rw", sessionId: "s-live", displayPath: "D:\\builds\\maya2026", mode: "read-write", reason: "verify compiled plugin load", status: "pending", requestedAt: iso(4) },
      { accessRequestId: "ar-sens", sessionId: "s-live", displayPath: "C:\\hitl\\demo-project\\.env", mode: "read-only", reason: "read runtime config", status: "pending", requestedAt: iso(3), sensitive: true, sensitiveReason: "\".env\" matches a credentials/secrets file pattern" },
      { accessRequestId: "ar-ok", sessionId: "s-live", displayPath: "D:\\shared\\fixtures", mode: "read-only", reason: "test fixtures", status: "approved", requestedAt: iso(90) }
    ]
  };

  const diffChanges = [
    { baselineId: "b-1", rootName: "asset_api", path: "publish_hooks.py", changeKind: "modify", addedLines: 12, removedLines: 3, revertSupported: true },
    { baselineId: "b-1", rootName: "asset_api", path: "exporters/alembic.py", changeKind: "add", addedLines: 40, removedLines: 0, revertSupported: true },
    { baselineId: "b-1", rootName: "asset_api", path: "legacy/exporter_v1.py", changeKind: "delete", addedLines: 0, removedLines: 55, revertSupported: false, reason: "file exceeded the blob cap" }
  ];

  // Clone-mode sync state: one repo, two changed files, one conflicted.
  // Mutated in place by the clone.pull/push/discard mock handlers below.
  const cloneRepos = [
    {
      name: "asset_api", branch: "main", files: [
        { path: "publish_hooks.py", changeKind: "modify", addedLines: 12, removedLines: 3 },
        { path: "exporters/alembic.py", changeKind: "add", addedLines: 40, removedLines: 0, conflicted: true }
      ]
    }
  ];

  const tasks = [
    { taskId: "t-1", title: "Alembic publish support", description: "4 repos: db, api, maya, houdini", state: "in-progress", linkedWorkspaceSetIds: ["set-1"], linkedSessionIds: ["s-live", "s-clone"], createdAt: iso(200), updatedAt: iso(5), lastWorkedAt: iso(2), openReviewCommentCount: 1 },
    { taskId: "t-2", title: "Upgrade farm python to 3.12", state: "todo", linkedWorkspaceSetIds: [], linkedSessionIds: [], createdAt: iso(400), updatedAt: iso(400) }
  ];

  // Attention-stack questions: two pending on s-live (stacks with the two
  // pending access requests → pager shows 4), one answered (hidden).
  const agentQuestions = [
    { questionId: "q-1", sessionId: "s-live", question: "Should the alembic exporter keep legacy 1.x sidecar files?", options: ["Drop them — 2.x readers are everywhere", "Keep writing both for one release"], status: "pending", createdAt: iso(6) },
    { questionId: "q-2", sessionId: "s-live", question: "Name the new config section?", options: [], status: "pending", createdAt: iso(5) },
    { questionId: "q-0", sessionId: "s-live", question: "Already answered?", options: [], status: "answered", answer: "yes", createdAt: iso(50) }
  ];

  const memoryCandidates = [
    { memoryCandidateId: "m-1", sessionId: "s-live", content: "asset_api integration tests need the fixture server on port 9021.", status: "pending", createdAt: iso(10) },
    { memoryCandidateId: "m-2", sessionId: "s-ended", content: "USD builds must pin MaterialX 1.39.", status: "approved", createdAt: iso(1500) }
  ];

  const workHistory = [
    { taskId: "t-1", taskTitle: "Alembic publish support", sessionId: "s-live", sessionTitle: "Add alembic support to asset_api", lastActivityAt: iso(2), turnCount: 7 },
    { sessionId: "s-ended", sessionTitle: "Investigate USD 24 upgrade", lastActivityAt: iso(1900), turnCount: 3 }
  ];

  const planDocs = {
    "s-ended": [
      { name: "usd-upgrade.md", format: "markdown", revision: 2, collectedAt: iso(1900), content: "# USD 24 upgrade\n\nScope and risks.\n\n```mermaid\nflowchart TD; usd_core-->houdini\n```" }
    ]
  };

  const runtimes = [
    { runtimeId: "r-1", externalName: "drydock-slive-gen1-worker", status: "running", startedAt: iso(60) }
  ];

  // --- task-review fixture -----------------------------------------------
  // A mutable projection for task "t-1": two linked sessions across two projects.
  // Per-session comment lists are the source of truth for open counts and the
  // dock; taskReview.state recomputes openCommentCount from them on every call.
  const taskReviewSessions = [
    { sessionId: "s-live", sessionTitle: "Rename sweep" },
    { sessionId: "s-clone", sessionTitle: "Clone helper" }
  ];

  const taskReviewProjects = [
    {
      name: "asset_api",
      files: [
        { sessionId: "s-live", sessionTitle: "Rename sweep", baselineId: "trb-1", repo: "asset_api", path: "src/publish_hooks.py", changeKind: "modify", addedLines: 18, removedLines: 4, commentCount: 1 },
        { sessionId: "s-live", sessionTitle: "Rename sweep", baselineId: "trb-2", repo: "asset_api", path: "src/exporters/alembic.py", changeKind: "modify", addedLines: 33, removedLines: 7, commentCount: 0 },
        { sessionId: "s-live", sessionTitle: "Rename sweep", baselineId: "trb-3", repo: "asset_api", path: "src/exporters/usd.py", changeKind: "add", addedLines: 52, removedLines: 0, commentCount: 0 }
      ]
    },
    {
      name: "farm_submit",
      files: [
        { sessionId: "s-live", sessionTitle: "Rename sweep", baselineId: "trb-4", repo: "farm_submit", path: "submit.py", changeKind: "modify", addedLines: 9, removedLines: 2, commentCount: 0 },
        { sessionId: "s-clone", sessionTitle: "Clone helper", repo: "farm_submit", path: "queue.py", changeKind: "modify", addedLines: 5, removedLines: 1, commentCount: 0, clone: true, conflicted: true }
      ]
    }
  ];

  // Per-session task-review comment lists (non-plan anchors). Mutated by the
  // task-review review.* and taskReview.submit handlers.
  const taskReviewComments = {
    "s-live": [
      { commentId: "trc-1", filePath: "asset_api:src/publish_hooks.py", startLine: 12, endLine: 12, body: "Gate the allowlist behind config before shipping.", author: "user", status: "open", createdAt: iso(20) },
      { commentId: "trc-2", filePath: "farm_submit:submit.py", startLine: 3, endLine: 3, body: "Retry backoff should be exponential here.", author: "user", status: "delegated", createdAt: iso(18) }
    ],
    "s-clone": []
  };

  const taskReviewNotes = [
    "Clone session \"Clone helper\" is not live in this window — its changes are not listed."
  ];

  /** True when a session id names a task-review session. */
  function isTaskReviewSession(sessionId) {
    return taskReviewSessions.some((s) => s.sessionId === sessionId);
  }

  /** True when a comment id belongs to a task-review session's list. */
  function taskReviewSessionForComment(commentId) {
    for (const sessionId of Object.keys(taskReviewComments)) {
      if (taskReviewComments[sessionId].some((c) => c.commentId === commentId)) return sessionId;
    }
    return undefined;
  }

  /** Recomputes openCommentCount (open, non-plan) from the mutable comment lists. */
  function computeTaskReviewState() {
    let openCommentCount = 0;
    for (const sessionId of Object.keys(taskReviewComments)) {
      for (const comment of taskReviewComments[sessionId]) {
        if (comment.status === "open" && !comment.filePath.startsWith("plan:")) openCommentCount += 1;
      }
    }
    return {
      taskId: "t-1",
      title: "Alembic publish support",
      sessions: taskReviewSessions,
      projects: taskReviewProjects,
      openCommentCount,
      notes: taskReviewNotes
    };
  }

  /** Appends a line to the harness log (console + a queryable buffer for tests). */
  function harnessLog(line) {
    (window.__harness.log ??= []).push(line);
    console.log(`[harness] ${line}`);
  }

  // --- protocol plumbing --------------------------------------------------------
  function respond(requestId, payload) {
    dispatch({ protocolVersion: PROTOCOL, kind: "response", requestId, ok: true, payload });
  }
  function respondError(requestId, message) {
    dispatch({ protocolVersion: PROTOCOL, kind: "response", requestId, ok: false, error: { message } });
  }
  function push(payload) {
    pushSequence += 1;
    dispatch({ protocolVersion: PROTOCOL, kind: "push", sequence: pushSequence, payload });
  }
  function dispatch(message) {
    setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: message })), 25);
  }

  function summaryOfTask(task) { return task; }

  function handle(request) {
    const { requestId, payload } = request;
    const type = payload.type;
    switch (type) {
      case "panel.init":
        return respond(requestId, {
          type, state: {
            availability: { available: true, sbxDisplayPath: "C:\\tools\\sbx\\sbx.exe" },
            runtimes, providerCatalogs: catalogs,
            stateRootDisplayPath: "C:\\Users\\demo\\.drydock-hitl",
            openFolderNames: ["demo-project", "asset_api"],
            agentIdleThresholdMs: 300000,
            codeBlockWordWrap: true
          }
        });
      case "clipboard.writeText":
        window.__harnessClipboard = payload.text;
        return respond(requestId, { type, accepted: true });
      case "session.list": return respond(requestId, { type, sessions });
      case "session.timeline": {
        const lines = (timelines[payload.sessionId] ?? []).filter((line) => line.sequence >= (payload.fromSequence ?? 0));
        return respond(requestId, { type, sessionId: payload.sessionId, lines });
      }
      case "session.rename": {
        const session = sessions.find((candidate) => candidate.sessionId === payload.sessionId);
        if (!session) return respondError(requestId, "unknown session");
        session.title = payload.title; session.updatedAt = new Date().toISOString();
        return respond(requestId, { type, session });
      }
      case "session.setDescription": {
        const session = sessions.find((candidate) => candidate.sessionId === payload.sessionId);
        if (!session) return respondError(requestId, "unknown session");
        if (payload.description === "") delete session.description; else session.description = payload.description;
        return respond(requestId, { type, session });
      }
      case "session.delete": {
        const index = sessions.findIndex((candidate) => candidate.sessionId === payload.sessionId);
        if (index >= 0) sessions.splice(index, 1);
        push({ type: "session.deleted", sessionId: payload.sessionId });
        return respond(requestId, { type, sessionId: payload.sessionId });
      }
      case "chat.resumeSession": {
        const session = sessions.find((candidate) => candidate.sessionId === payload.sessionId);
        if (!session) return respondError(requestId, "unknown session");
        session.status = "active"; session.updatedAt = new Date().toISOString();
        return respond(requestId, { type, session, providerCatalogs: catalogs });
      }
      case "chat.startSession": {
        const session = { sessionId: `s-new-${String(sessions.length)}`, title: "New chat", status: "active", providerId: payload.model.providerId, model: payload.model.model, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        sessions.unshift(session);
        return respond(requestId, { type, session, providerCatalogs: catalogs });
      }
      case "chat.sendTurn": {
        respond(requestId, { type, accepted: true });
        return window.__harness.scenario.streamTurn(payload.sessionId, payload.prompt);
      }
      case "chat.start": {
        const session = { sessionId: "s-new-start", title: payload.prompt.slice(0, 40), status: "active", providerId: payload.model?.providerId ?? "codex", model: payload.model?.model, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        sessions.unshift(session);
        respond(requestId, { type, session });
        return window.__harness.scenario.streamTurn(session.sessionId, payload.prompt);
      }
      case "chat.restartBackend": {
        const session = sessions.find((candidate) => candidate.sessionId === payload.sessionId);
        if (!session) return respondError(requestId, "unknown session");
        harnessLog(`chat.restartBackend ${payload.sessionId} ${payload.model.providerId}${payload.model.model ? `/${payload.model.model}` : ""}`);
        session.providerId = payload.model.providerId; session.model = payload.model.model;
        return respond(requestId, { type, session, providerCatalogs: catalogs });
      }
      case "chat.cancelTurn": return respond(requestId, { type, accepted: true });
      case "chat.spawnRole": {
        const parent = sessions.find((candidate) => candidate.sessionId === payload.sessionId);
        if (!parent) return respondError(requestId, "unknown session");
        const child = {
          sessionId: `s-role-${payload.role}-${String(sessions.length)}`,
          title: `${payload.role} — ${parent.title}`,
          status: "active",
          providerId: parent.providerId,
          model: parent.model,
          transport: parent.transport ?? "codex-app-server",
          parentSessionId: parent.sessionId,
          spawnedRole: payload.role,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        sessions.unshift(child);
        push({ type: "session.updated", session: child });
        return respond(requestId, { type, session: child });
      }
      case "chat.endSession": {
        const session = sessions.find((candidate) => candidate.sessionId === payload.sessionId);
        if (!session) return respondError(requestId, "unknown session");
        session.status = "ended";
        return respond(requestId, { type, session });
      }
      case "question.list": return respond(requestId, { type, questions: agentQuestions.filter((q) => q.status === "pending") });
      case "question.answer": {
        const question = agentQuestions.find((q) => q.questionId === payload.questionId);
        if (!question || question.status !== "pending") return respondError(requestId, "unknown or resolved question");
        question.status = "answered"; question.answer = payload.answer;
        push({ type: "question.resolved", question });
        harnessLog(`question.answer ${payload.questionId}: ${payload.answer}`);
        return respond(requestId, { type, question, dispatched: true });
      }
      case "question.dismiss": {
        const question = agentQuestions.find((q) => q.questionId === payload.questionId);
        if (!question || question.status !== "pending") return respondError(requestId, "unknown or resolved question");
        question.status = "dismissed";
        push({ type: "question.resolved", question });
        return respond(requestId, { type, question });
      }
      case "provider.list": return respond(requestId, { type, providerCatalogs: catalogs });
      case "provider.login": return respond(requestId, { type, providerId: payload.providerId, launched: "sbx secret set -g anthropic --oauth" });
      case "isolatedRun.listRuntimes": return respond(requestId, { type, runtimes });
      case "isolatedRun.stopRuntime": return respond(requestId, { type, runtimeId: payload.runtimeId, status: "removed", diagnostics: [] });
      case "isolatedRun.probeAppServer": return respond(requestId, { type, accepted: true });
      case "workspace.state": return respond(requestId, { type, state: workspacePolicy });
      case "workspace.registerOpenFolders": return respond(requestId, { type, projects: workspacePolicy.projects });
      case "workspace.createSet": return respondError(requestId, "harness: not implemented");
      case "workspace.openInNewWindow": return respond(requestId, { type, accepted: true });
      case "workspace.activate": return respond(requestId, { type, result: { outcome: "appended", added: 1, removed: 0 } });
      case "policy.resolveAccess": {
        const access = workspacePolicy.accessRequests.find((candidate) => candidate.accessRequestId === payload.accessRequestId);
        if (!access) return respondError(requestId, "unknown request");
        access.status = payload.approve ? "approved" : "denied";
        if (payload.editedHostPath) access.displayPath = payload.editedHostPath;
        return respond(requestId, { type, accessRequest: access });
      }
      case "diff.status": return respond(requestId, { type, changes: payload.sessionId === "s-live" || payload.sessionId === undefined ? diffChanges : [] });
      case "diff.acceptFile": {
        const index = diffChanges.findIndex((candidate) => candidate.path === payload.path);
        if (index >= 0) diffChanges.splice(index, 1);
        return respond(requestId, { type, changes: diffChanges });
      }
      case "diff.revertFile": {
        const index = diffChanges.findIndex((candidate) => candidate.path === payload.path);
        if (index >= 0) diffChanges.splice(index, 1);
        return respond(requestId, { type, changes: diffChanges });
      }
      case "diff.openFile":
        // Log the send so the task-review visual check (V27) can assert it.
        harnessLog(`diff.openFile ${String(payload.baselineId)} ${String(payload.path)}`);
        return respond(requestId, { type, accepted: true });
      case "diff.snapshotWorkspace": return respond(requestId, { type, baselineIds: ["b-ws"] });
      case "review.state": {
        // Task-review panel names a session: serve that session's task-review
        // list. Otherwise keep the legacy fixtures.comments response for older
        // harness cases that still call review.state without a task-review scope.
        if (payload.sessionId !== undefined && isTaskReviewSession(payload.sessionId)) {
          return respond(requestId, { type, reviewSessionId: `rv-${String(payload.sessionId)}`, comments: taskReviewComments[payload.sessionId] ?? [] });
        }
        return respond(requestId, { type, reviewSessionId: "rv-1", comments: window.__harness.fixtures.comments });
      }
      case "review.addComment": {
        // Route to the task-review list when the named session owns one.
        if (payload.sessionId !== undefined && isTaskReviewSession(payload.sessionId)) {
          const list = taskReviewComments[payload.sessionId] ?? (taskReviewComments[payload.sessionId] = []);
          const comment = { commentId: `trc-${String(now)}-${String(list.length + 1)}`, filePath: payload.filePath, startLine: payload.startLine, endLine: payload.endLine, body: payload.body, author: "user", status: "open", createdAt: new Date().toISOString() };
          list.push(comment);
          // Reflect the new open comment in the matching projection file's badge.
          for (const project of taskReviewProjects) {
            for (const file of project.files) {
              if (`${file.repo}:${file.path}` === payload.filePath) file.commentCount += 1;
            }
          }
          harnessLog(`review.addComment ${String(payload.sessionId)} ${String(payload.filePath)}`);
          return respond(requestId, { type, comment });
        }
        const comment = { commentId: `c-${String(window.__harness.fixtures.comments.length + 1)}`, filePath: payload.filePath, startLine: payload.startLine, endLine: payload.endLine, body: payload.body, author: "user", status: "open", createdAt: new Date().toISOString() };
        window.__harness.fixtures.comments.push(comment);
        return respond(requestId, { type, comment });
      }
      case "review.setCommentStatus": {
        const trSession = taskReviewSessionForComment(payload.commentId);
        if (trSession !== undefined) {
          const comment = taskReviewComments[trSession].find((candidate) => candidate.commentId === payload.commentId);
          comment.status = payload.status;
          return respond(requestId, { type, comment });
        }
        const comment = window.__harness.fixtures.comments.find((candidate) => candidate.commentId === payload.commentId);
        if (!comment) return respondError(requestId, "unknown comment");
        comment.status = payload.status;
        return respond(requestId, { type, comment });
      }
      case "task.list": return respond(requestId, { type, tasks });
      case "task.create": {
        const task = { taskId: `t-${String(tasks.length + 1)}`, title: payload.title, ...(payload.description ? { description: payload.description } : {}), state: "todo", linkedWorkspaceSetIds: [], linkedSessionIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        tasks.unshift(task);
        return respond(requestId, { type, task: summaryOfTask(task) });
      }
      case "task.update": {
        const task = tasks.find((candidate) => candidate.taskId === payload.taskId);
        if (!task) return respondError(requestId, "unknown task");
        if (payload.title !== undefined) task.title = payload.title;
        if (payload.state !== undefined) task.state = payload.state;
        if (payload.description !== undefined) { if (payload.description === "") delete task.description; else task.description = payload.description; }
        task.updatedAt = new Date().toISOString();
        push({ type: "task.updated", task });
        return respond(requestId, { type, task });
      }
      case "task.delete": {
        const index = tasks.findIndex((candidate) => candidate.taskId === payload.taskId);
        if (index >= 0) tasks.splice(index, 1);
        push({ type: "task.deleted", taskId: payload.taskId });
        return respond(requestId, { type, taskId: payload.taskId });
      }
      case "task.link": case "task.unlink": {
        const task = tasks.find((candidate) => candidate.taskId === payload.taskId);
        if (!task) return respondError(requestId, "unknown task");
        const add = type === "task.link";
        if (payload.workspaceSetId) {
          task.linkedWorkspaceSetIds = add
            ? [...new Set([...task.linkedWorkspaceSetIds, payload.workspaceSetId])]
            : task.linkedWorkspaceSetIds.filter((id) => id !== payload.workspaceSetId);
        }
        if (payload.sessionId) {
          task.linkedSessionIds = add
            ? [...new Set([...task.linkedSessionIds, payload.sessionId])]
            : task.linkedSessionIds.filter((id) => id !== payload.sessionId);
        }
        push({ type: "task.updated", task });
        return respond(requestId, { type, task });
      }
      case "work.history": return respond(requestId, { type, entries: workHistory });
      case "memory.list": return respond(requestId, { type, candidates: memoryCandidates });
      case "memory.resolve": {
        const candidate = memoryCandidates.find((entry) => entry.memoryCandidateId === payload.memoryCandidateId);
        if (!candidate) return respondError(requestId, "unknown candidate");
        candidate.status = payload.approve ? "approved" : "rejected";
        return respond(requestId, { type, candidate });
      }
      case "planDocs.state": return respond(requestId, { type, sessionId: payload.sessionId, docs: planDocs[payload.sessionId] ?? [] });
      case "planDocs.open": return respond(requestId, { type, accepted: true });
      case "planDocs.sendComments": return respond(requestId, { type, accepted: true, sentCount: 0 });
      case "clone.state":
        return respond(requestId, { type, sessionId: payload.sessionId, repos: cloneRepos });
      case "clone.pull": {
        // Per-file pull removes just that file; a full pull clears every repo.
        let applied = 0;
        const conflicted = [];
        for (const repo of cloneRepos) {
          if (payload.repo !== undefined && repo.name !== payload.repo) continue;
          const before = repo.files.length;
          for (const file of repo.files) { if (file.conflicted) conflicted.push(file.path); }
          repo.files = payload.path !== undefined ? repo.files.filter((f) => f.path !== payload.path) : [];
          applied += before - repo.files.length;
        }
        return respond(requestId, { type, result: { appliedFiles: applied, conflictedFiles: conflicted, message: `Pulled ${String(applied)} file(s) into editor` } });
      }
      case "clone.push": {
        return respond(requestId, { type, result: { appliedFiles: 2, conflictedFiles: [], untrackedCopied: 1, message: "Pushed 2 file(s) to VM; 1 untracked copied" } });
      }
      case "clone.discard": {
        const repo = cloneRepos.find((r) => r.name === payload.repo);
        if (repo) repo.files = repo.files.filter((f) => f.path !== payload.path);
        return respond(requestId, { type, repos: cloneRepos });
      }
      case "taskReview.state":
        return respond(requestId, { type, state: computeTaskReviewState() });
      case "taskReview.submit": {
        // Flip every open non-plan task-review comment to "delegated"; report the
        // count flipped and how many sessions received any.
        let dispatched = 0;
        const touchedSessions = new Set();
        for (const sessionId of Object.keys(taskReviewComments)) {
          for (const comment of taskReviewComments[sessionId]) {
            if (comment.status === "open" && !comment.filePath.startsWith("plan:")) {
              comment.status = "delegated";
              dispatched += 1;
              touchedSessions.add(sessionId);
            }
          }
        }
        // Refs for the sessions that had ≥1 open comment flipped (R2). Omit the
        // field entirely when nothing flipped, so the client falls back to the
        // count-only line.
        const sentSessions = taskReviewSessions.filter((s) => touchedSessions.has(s.sessionId));
        harnessLog(`taskReview.submit dispatched=${String(dispatched)} sessions=${String(touchedSessions.size)}`);
        return respond(requestId, {
          type,
          dispatched,
          sessions: touchedSessions.size,
          ...(sentSessions.length > 0 ? { sentSessions } : {})
        });
      }
      case "taskReview.open":
        harnessLog(`taskReview.open ${String(payload.taskId)}`);
        return respond(requestId, { type, accepted: true });
      default:
        return respondError(requestId, `harness: unhandled request ${String(type)}`);
    }
  }

  window.acquireVsCodeApi = function acquireVsCodeApi() {
    return {
      postMessage(message) {
        if (message && message.kind === "request") handle(message);
      },
      getState() { return webviewState; },
      setState(next) { webviewState = next; }
    };
  };

  window.__harness = {
    fixtures: { sessions, catalogs, workspacePolicy, diffChanges, cloneRepos, tasks, memoryCandidates, workHistory, taskReviewProjects, taskReviewSessions, taskReviewComments, comments: [
      { commentId: "c-1", filePath: "publish_hooks.py", startLine: 12, endLine: 14, body: "Guard the allowlist behind config.", author: "user", status: "open", createdAt: iso(30) }
    ] },
    log: [],
    push,
    scenario: {
      /** Simulates a streamed turn on a session: started → text chunks → completed. */
      streamTurn(sessionId, userSummary = "(from harness)") {
        // Sequences must always rise past anything already replayed (the panel
        // dedupes on lastSequence), so draw from a high monotonic counter.
        window.__harness.eventSequence = (window.__harness.eventSequence ?? 10_000) + 10;
        const base = window.__harness.eventSequence;
        push({ type: "chat.turnStarted", sessionId, runId: "run-x" });
        push({ type: "chat.event", sessionId, line: { sequence: base + 1, eventType: "user.message", summary: userSummary, createdAt: new Date().toISOString() } });
        push({ type: "chat.event", sessionId, line: { sequence: base + 2, eventType: "agent.text", summary: "Working on it — ", createdAt: new Date().toISOString(), final: false } });
        setTimeout(() => {
          push({ type: "chat.event", sessionId, line: { sequence: base + 3, eventType: "agent.text", summary: "Working on it — done.\n\n- item one\n- item two", createdAt: new Date().toISOString(), final: true } });
          push({ type: "chat.turnCompleted", sessionId, runId: "run-x", status: "completed" });
        }, 400);
      },
      /** Fires the attention push for the waiting session (badge/marker test). */
      attention(sessionId, reasons) {
        push({ type: "session.attention", sessionId, reasons });
      },
      /**
       * Subagent fan-out (V31/V32): streams a turn where the agent spawns two
       * subagents (scribe + lister), scribe nests a grandchild (counter),
       * scribe completes and lister FAILS — mirroring the 2026-07-05 codex
       * probe. Lines carry agentPath/nodeId/label/nodeStatus/toolStatus/detail
       * exactly as summarizeAgentEvent emits them.
       */
      fanOut(sessionId) {
        window.__harness.eventSequence = (window.__harness.eventSequence ?? 10_000) + 100;
        const base = window.__harness.eventSequence;
        const at = () => new Date().toISOString();
        const line = (offset, fields) => push({ type: "chat.event", sessionId, line: { sequence: base + offset, createdAt: at(), ...fields } });
        push({ type: "chat.turnStarted", sessionId, runId: "run-fan" });
        line(1, { eventType: "user.message", summary: "fan out: write a haiku and list the dir (from harness)" });
        line(2, { eventType: "agent.text", summary: "Delegating to two subagents.", final: true });
        line(3, { eventType: "agent.spawn", summary: "spawned scribe", nodeId: "t-scribe", label: "scribe", subagentType: "general-purpose", model: "gpt-5.5", nodeStatus: "running", detail: "Write a 3-line haiku about rain to haiku.txt, then spawn a counter to count its words." });
        line(4, { eventType: "agent.spawn", summary: "spawned lister", nodeId: "t-lister", label: "lister", subagentType: "general-purpose", model: "gpt-5.5", nodeStatus: "running", detail: "List the working directory and report the file count." });
        push({ type: "session.agentActivity", sessionId, activity: { running: 2, failed: 0 } });
        setTimeout(() => {
          line(5, { eventType: "agent.text", summary: "Writing the haiku now.", agentPath: ["t-scribe"] });
          line(6, { eventType: "agent.file_edit", summary: "add haiku.txt", filePath: "haiku.txt", fileChangeKind: "add", agentPath: ["t-scribe"] });
          line(7, { eventType: "agent.command", summary: "pwsh -Command ls [started]", toolStatus: "started", commandName: "ls", agentPath: ["t-lister"] });
          line(8, { eventType: "agent.command", summary: "pwsh -Command ls [failed exit -1]", toolStatus: "failed", commandName: "ls", detail: "CreateProcess failed: the sandbox refused pwsh.", agentPath: ["t-lister"] });
        }, 300);
        setTimeout(() => {
          line(9, { eventType: "agent.spawn", summary: "spawned counter", nodeId: "t-counter", label: "counter", subagentType: "general-purpose", nodeStatus: "running", agentPath: ["t-scribe"], detail: "Count the words in haiku.txt." });
          push({ type: "session.agentActivity", sessionId, activity: { running: 3, failed: 0 } });
          line(10, { eventType: "agent.text", summary: "12 words.", agentPath: ["t-scribe", "t-counter"] });
          line(11, { eventType: "agent.node_done", summary: "subagent completed: 12 words.", nodeId: "t-counter", nodeStatus: "completed", detail: "12 words.", agentPath: ["t-scribe"] });
        }, 700);
        setTimeout(() => {
          line(12, { eventType: "agent.node_done", summary: "subagent completed: haiku written", nodeId: "t-scribe", nodeStatus: "completed", detail: "haiku written", usage: { totalTokens: 28192 } });
          line(13, { eventType: "agent.node_done", summary: "subagent failed: sandbox process failed", nodeId: "t-lister", nodeStatus: "failed", detail: "lister: unable to list directory; sandbox process failed." });
          push({ type: "session.agentActivity", sessionId, activity: { running: 0, failed: 1 } });
          line(14, { eventType: "agent.text", summary: "Scribe finished; lister's sandbox died. DONE.", final: true });
          line(15, { eventType: "agent.done", summary: "done: completed", nodeStatus: "completed", usage: { totalTokens: 74219 } });
          push({ type: "chat.turnCompleted", sessionId, runId: "run-fan", status: "completed" });
        }, 1100);
      },
      /** Streams a new pending agent question into the panel (attention stack). */
      askQuestion(sessionId, question, options) {
        const summary = {
          questionId: `q-${String(agentQuestions.length + 1)}`,
          sessionId: sessionId ?? "s-live",
          question: question ?? "Prefer tabs or spaces for the generated config?",
          options: options ?? ["Spaces (repo convention)", "Tabs"],
          status: "pending",
          createdAt: new Date().toISOString()
        };
        agentQuestions.push(summary);
        push({ type: "question.asked", question: summary });
        push({ type: "session.attention", sessionId: summary.sessionId, reasons: ["question"] });
        return summary.questionId;
      },
      /** Streams a new pending access request into the panel. */
      accessRequest(summary) {
        workspacePolicy.accessRequests.push(summary);
        push({ type: "policy.accessRequested", accessRequest: summary });
      },
      memoryCandidate(candidate) {
        memoryCandidates.unshift(candidate);
        push({ type: "memory.candidateAdded", candidate });
      },
      /** Fires the task-review refetch push for a task (turn-boundary simulation). */
      taskReviewUpdated(taskId) {
        push({ type: "taskReview.updated", taskId });
      },
      /**
       * Simulates an agent revision so R11's meaningful-refetch announcement is
       * demonstrable: resolves the delegated `trc-2` comment, grows
       * `src/publish_hooks.py`'s addedLines 18→24, THEN pushes taskReview.updated
       * for t-1. The panel diffs the refetched state against its prior snapshot,
       * flashes the changed publish_hooks row, and shows `updated · just now`.
       * (A plain taskReviewUpdated("t-1") with no fixture mutation stays silent.)
       */
      agentRevised() {
        const comment = taskReviewComments["s-live"].find((c) => c.commentId === "trc-2");
        if (comment) comment.status = "resolved";
        for (const project of taskReviewProjects) {
          for (const file of project.files) {
            if (file.repo === "asset_api" && file.path === "src/publish_hooks.py") file.addedLines = 24;
          }
        }
        harnessLog("scenario.agentRevised: trc-2 resolved, publish_hooks +18→+24");
        push({ type: "taskReview.updated", taskId: "t-1" });
      }
    }
  };
})();
