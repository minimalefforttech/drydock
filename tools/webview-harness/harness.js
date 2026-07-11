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
      providerId: "claude", displayName: "Claude / Anthropic", refreshedAt: iso(1), source: "provider", diagnostics: [], authStatus: "needs-login", loginHint: "sbx run claude (then /login)",
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
      {
        workspaceSetId: "set-1", name: "pipeline", projectNames: ["demo-project", "asset_api"],
        members: [
          { projectId: "p-demo", name: "demo-project", displayPath: "C:\\hitl\\demo-project", readOnly: false },
          { projectId: "p-asset", name: "asset_api", displayPath: "C:\\hitl\\asset_api", readOnly: false }
        ]
      }
    ],
    accessRequests: [
      { accessRequestId: "ar-rw", sessionId: "s-live", displayPath: "D:\\builds\\maya2026", mode: "read-write", reason: "verify compiled plugin load", status: "pending", requestedAt: iso(4) },
      { accessRequestId: "ar-sens", sessionId: "s-live", displayPath: "C:\\hitl\\demo-project\\.env", mode: "read-only", reason: "read runtime config", status: "pending", requestedAt: iso(3), sensitive: true, sensitiveReason: "\".env\" matches a credentials/secrets file pattern" },
      { accessRequestId: "ar-ok", sessionId: "s-live", displayPath: "D:\\shared\\fixtures", mode: "read-only", reason: "test fixtures", status: "approved", requestedAt: iso(90) }
    ]
  };

  // Session-view rows (the working frame; accept removes rows here and in turn).
  const diffChanges = [
    { baselineId: "b-1", rootName: "asset_api", path: "publish_hooks.py", changeKind: "modify", addedLines: 12, removedLines: 3, revertSupported: true },
    { baselineId: "b-1", rootName: "asset_api", path: "exporters/alembic.py", changeKind: "add", addedLines: 40, removedLines: 0, revertSupported: true },
    { baselineId: "b-1", rootName: "asset_api", path: "legacy/exporter_v1.py", changeKind: "delete", addedLines: 0, removedLines: 55, revertSupported: false, reason: "file exceeded the blob cap" }
  ];
  // This Turn: only the most recent edit happened since the last send.
  const diffChangesTurn = [
    { baselineId: "b-turn", rootName: "asset_api", path: "exporters/alembic.py", changeKind: "add", addedLines: 40, removedLines: 0, revertSupported: true }
  ];
  // Full Session: everything since session start, including an already-accepted row.
  const diffChangesFull = [
    ...diffChanges.map((change) => ({ ...change, baselineId: "b-start" })),
    { baselineId: "b-start", rootName: "asset_api", path: "config/defaults.toml", changeKind: "modify", addedLines: 2, removedLines: 2, revertSupported: true, accepted: true }
  ];
  const diffListFor = (view) => view === "turn" ? diffChangesTurn : view === "full-session" ? diffChangesFull : diffChanges;

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

  // Board columns (task board and subtasks): the 6 seeded defaults,
  // sortOrder 0..5 in this order.
  const boardColumns = [
    { columnId: "col-backlog", name: "Backlog", category: "backlog", sortOrder: 0 },
    { columnId: "col-todo", name: "ToDo", category: "pending", sortOrder: 1 },
    { columnId: "col-blocked", name: "Blocked", category: "pending", sortOrder: 2 },
    { columnId: "col-in-progress", name: "In Progress", category: "in-progress", sortOrder: 3 },
    { columnId: "col-review", name: "Review", category: "done", sortOrder: 4 },
    { columnId: "col-finished", name: "Finished", category: "done", sortOrder: 5 }
  ];

  const tasks = [
    {
      taskId: "t-1", title: "Alembic publish support", description: "4 repos: db, api, maya, houdini", state: "in-progress", columnId: "col-in-progress", linkedWorkspaceSetIds: ["set-1"], linkedSessionIds: ["s-live", "s-clone"], createdAt: iso(200), updatedAt: iso(5), lastWorkedAt: iso(2), openReviewCommentCount: 1,
      clonePolicy: { workspaceSetId: "set-1", projectIds: ["p-asset"], dirtyHandling: "carry", workspaceSetProjectCount: 2 },
      subtasks: [
        { subtaskId: "st-1", taskId: "t-1", title: "Patch alembic exporter", description: "exporters/alembic.py", prompt: "Patch exporters/alembic.py to support alembic caches.", autoStart: false, origin: "manual", columnId: "col-in-progress", sortOrder: 0, createdAt: iso(190), updatedAt: iso(5), isBlocked: false, dependsOn: [], isRunning: true, linkedSessionIds: ["s-live"] },
        { subtaskId: "st-2", taskId: "t-1", title: "Update allowlist config", description: "", prompt: "", autoStart: true, origin: "manual", columnId: "col-todo", sortOrder: 1, createdAt: iso(188), updatedAt: iso(188), isBlocked: true, dependsOn: ["st-1"], isRunning: false, linkedSessionIds: [] },
        { subtaskId: "st-3", taskId: "t-1", title: "Review sweep", description: "", origin: "review", autoStart: false, columnId: "col-review", sortOrder: 2, createdAt: iso(100), updatedAt: iso(20), doneAt: iso(20), isBlocked: false, dependsOn: [], isRunning: false, linkedSessionIds: [] }
      ]
    },
    {
      taskId: "t-2", title: "Upgrade farm python to 3.12", state: "todo", columnId: "col-backlog", linkedWorkspaceSetIds: [], linkedSessionIds: [], createdAt: iso(400), updatedAt: iso(400),
      subtasks: [
        { subtaskId: "st-4", taskId: "t-2", title: "Audit farm_submit for py2-only syntax", description: "", prompt: "", autoStart: false, origin: "manual", columnId: "col-backlog", sortOrder: 0, createdAt: iso(400), updatedAt: iso(400), isBlocked: false, dependsOn: [], isRunning: false, linkedSessionIds: [] }
      ]
    },
    // Task-board cast (taskBoard.html): a task sitting in Review (recent doneAt
    // → visible at the default 1-day age filter) with one startable subtask
    // still in flight and one finished ~2 days ago (col-finished, aged doneAt →
    // hides behind the per-column "1 hidden · Show" counter by default).
    {
      taskId: "t-3", title: "Task board rollout", state: "review", columnId: "col-review", doneAt: iso(45), linkedWorkspaceSetIds: ["set-1"], linkedSessionIds: [], createdAt: iso(3200), updatedAt: iso(45),
      clonePolicy: { workspaceSetId: "set-1", projectIds: ["p-demo", "p-asset"], dirtyHandling: "fresh", workspaceSetProjectCount: 2 },
      subtasks: [
        // st-5 depends on the already-finished st-6 (an edge to a done sibling
        // is allowed — instantly satisfied) and wears a failed chip from a
        // cancelled earlier run; drives the board's edge + failed visuals.
        { subtaskId: "st-5", taskId: "t-3", title: "Draft board announcement", description: "", prompt: "Write the internal rollout note for the task board.", autoStart: false, origin: "manual", columnId: "col-in-progress", sortOrder: 0, createdAt: iso(3100), updatedAt: iso(60), isBlocked: false, dependsOn: ["st-6"], isRunning: false, lastFailureAt: iso(55), linkedSessionIds: [] },
        { subtaskId: "st-6", taskId: "t-3", title: "Spike column persistence", description: "", prompt: "", autoStart: false, origin: "manual", columnId: "col-finished", sortOrder: 1, createdAt: iso(3100), updatedAt: iso(2980), doneAt: iso(2980), isBlocked: false, dependsOn: [], isRunning: false, linkedSessionIds: [] }
      ]
    }
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

  /** Recomputes each subtask's isBlocked from dependsOn, mirroring the host. */
  function recomputeBlocked(task) {
    const doneColumns = new Set(boardColumns.filter((c) => c.category === "done").map((c) => c.columnId));
    for (const subtask of task.subtasks) {
      subtask.isBlocked = (subtask.dependsOn ?? []).some((id) => {
        const upstream = task.subtasks.find((s) => s.subtaskId === id);
        return upstream !== undefined && !doneColumns.has(upstream.columnId);
      });
    }
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
    // Deep-copy the payload: the real webview boundary structured-clones every
    // message, so panels must never share object references with the host
    // fixtures (console fixture surgery would otherwise mutate panel state).
    const detached = JSON.parse(JSON.stringify(message));
    setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: detached })), 25);
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
      case "session.summarize": {
        const session = sessions.find((candidate) => candidate.sessionId === payload.sessionId);
        if (!session) return respondError(requestId, "unknown session");
        if (payload.mode === "log") {
          // The real host builds the log from durable events and writes the
          // clipboard itself; the harness records a stand-in the same way.
          window.__harnessClipboard = `# ${session.title}\n\n(harness chat log)\n`;
          harnessLog(`session.summarize log ${String(payload.sessionId)}`);
          return respond(requestId, { type, sessionId: payload.sessionId, mode: "log", accepted: true });
        }
        respond(requestId, { type, sessionId: payload.sessionId, mode: "ai", accepted: true });
        // Simulate the out-of-band model turn finishing a beat later. Seed
        // window.__harnessSummarizeFail = true to exercise the failure push.
        setTimeout(() => {
          if (window.__harnessSummarizeFail) {
            push({ type: "session.summaryReady", sessionId: payload.sessionId, ok: false, error: "harness: simulated summary failure" });
          } else {
            window.__harnessClipboard = `## Overview\n(harness AI summary for ${session.title})\n`;
            push({ type: "session.summaryReady", sessionId: payload.sessionId, ok: true });
          }
          harnessLog(`session.summaryReady ${String(payload.sessionId)}`);
        }, 1200);
        return;
      }
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
      case "diff.status": return respond(requestId, { type, changes: payload.sessionId === "s-live" || payload.sessionId === undefined ? diffListFor(payload.view) : [] });
      case "diff.acceptFile": {
        // Mirror the host: accept clears the row from the session AND turn
        // frames and flips the full-session row to accepted history.
        for (const list of [diffChanges, diffChangesTurn]) {
          const index = list.findIndex((candidate) => candidate.path === payload.path);
          if (index >= 0) list.splice(index, 1);
        }
        const fullRow = diffChangesFull.find((candidate) => candidate.path === payload.path);
        if (fullRow) fullRow.accepted = true;
        return respond(requestId, { type, changes: diffListFor(payload.view) });
      }
      case "diff.revertFile": {
        for (const list of [diffChanges, diffChangesTurn, diffChangesFull]) {
          const index = list.findIndex((candidate) => candidate.path === payload.path);
          if (index >= 0) list.splice(index, 1);
        }
        return respond(requestId, { type, changes: diffListFor(payload.view) });
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
        const task = { taskId: `t-${String(tasks.length + 1)}`, title: payload.title, ...(payload.description ? { description: payload.description } : {}), state: "todo", columnId: "col-backlog", linkedWorkspaceSetIds: [], linkedSessionIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), subtasks: [] };
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
      case "board.state":
        return respond(requestId, { type, board: { columns: boardColumns, tasks } });
      case "board.moveCard": {
        // Mirrors the host: doneAt is stamped when a card enters a
        // done-category column and cleared when it leaves.
        const targetIsDone = boardColumns.find((c) => c.columnId === payload.columnId)?.category === "done";
        if (payload.cardKind === "task") {
          const task = tasks.find((candidate) => candidate.taskId === payload.id);
          if (!task) return respondError(requestId, "unknown task");
          task.columnId = payload.columnId;
          if (targetIsDone) task.doneAt = new Date().toISOString(); else delete task.doneAt;
          task.updatedAt = new Date().toISOString();
          push({ type: "task.updated", task });
        } else {
          const task = tasks.find((candidate) => candidate.subtasks.some((s) => s.subtaskId === payload.id));
          if (!task) return respondError(requestId, "unknown subtask");
          const subtask = task.subtasks.find((s) => s.subtaskId === payload.id);
          subtask.columnId = payload.columnId;
          if (targetIsDone) subtask.doneAt = new Date().toISOString(); else delete subtask.doneAt;
          subtask.updatedAt = new Date().toISOString();
          recomputeBlocked(task);
          push({ type: "task.updated", task });
        }
        harnessLog(`board.moveCard ${String(payload.cardKind)} ${String(payload.id)} -> ${String(payload.columnId)}`);
        return respond(requestId, { type, board: { columns: boardColumns, tasks } });
      }
      case "board.columns.update": {
        // Real reconcile simulation so the settings modal's add / rename /
        // reorder / delete flows are exercisable in the harness. Deletes go
        // first (mirroring boardShared.reconcileColumns): last-of-category is
        // rejected with the service's message; a deleted column's cards move
        // to the nearest remaining same-category column.
        for (const deletedId of payload.deletedColumnIds ?? []) {
          const victim = boardColumns.find((c) => c.columnId === deletedId);
          if (!victim) return respondError(requestId, `Column ${String(deletedId)} was not found.`);
          const siblings = boardColumns.filter((c) => c.category === victim.category && c.columnId !== victim.columnId);
          if (siblings.length === 0) {
            return respondError(requestId, `Cannot delete the last ${String(victim.category)} column; every category needs at least one.`);
          }
          const nearest = siblings.reduce((closest, candidate) => (
            Math.abs(candidate.sortOrder - victim.sortOrder) < Math.abs(closest.sortOrder - victim.sortOrder) ? candidate : closest
          ));
          for (const task of tasks) {
            if (task.columnId === victim.columnId) task.columnId = nearest.columnId;
            for (const subtask of task.subtasks) {
              if (subtask.columnId === victim.columnId) subtask.columnId = nearest.columnId;
            }
          }
          boardColumns.splice(boardColumns.indexOf(victim), 1);
        }
        for (const entry of payload.columns) {
          if (entry.columnId === undefined) {
            boardColumns.push({ columnId: `col-new-${String(boardColumns.length + 1)}`, name: entry.name, category: entry.category, sortOrder: entry.sortOrder });
            continue;
          }
          const existing = boardColumns.find((c) => c.columnId === entry.columnId);
          if (!existing) return respondError(requestId, `Column ${String(entry.columnId)} was not found.`);
          existing.name = entry.name;
          existing.sortOrder = entry.sortOrder;
        }
        boardColumns.sort((a, b) => a.sortOrder - b.sortOrder);
        harnessLog(`board.columns.update columns=${String(payload.columns.length)} deleted=${String((payload.deletedColumnIds ?? []).length)}`);
        return respond(requestId, { type, board: { columns: boardColumns, tasks } });
      }
      case "subtask.create": {
        const task = tasks.find((candidate) => candidate.taskId === payload.taskId);
        if (!task) return respondError(requestId, "unknown task");
        const subtask = {
          subtaskId: `st-${String(now)}-${String(task.subtasks.length + 1)}`,
          taskId: payload.taskId,
          title: payload.title,
          ...(payload.description ? { description: payload.description } : {}),
          ...(payload.prompt ? { prompt: payload.prompt } : {}),
          autoStart: payload.autoStart ?? false,
          origin: "manual",
          columnId: boardColumns.find((c) => c.category === "backlog")?.columnId ?? "col-backlog",
          sortOrder: task.subtasks.length,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          isBlocked: false,
          dependsOn: [],
          isRunning: false,
          linkedSessionIds: []
        };
        task.subtasks.push(subtask);
        task.updatedAt = new Date().toISOString();
        push({ type: "task.updated", task });
        return respond(requestId, { type, task });
      }
      case "subtask.update": {
        const task = tasks.find((candidate) => candidate.subtasks.some((s) => s.subtaskId === payload.subtaskId));
        if (!task) return respondError(requestId, "unknown subtask");
        const subtask = task.subtasks.find((s) => s.subtaskId === payload.subtaskId);
        if (payload.title !== undefined) subtask.title = payload.title;
        if (payload.description !== undefined) { if (payload.description === "") delete subtask.description; else subtask.description = payload.description; }
        if (payload.prompt !== undefined) { if (payload.prompt === "") delete subtask.prompt; else subtask.prompt = payload.prompt; }
        if (payload.autoStart !== undefined) subtask.autoStart = payload.autoStart;
        if (payload.columnId !== undefined) subtask.columnId = payload.columnId;
        subtask.updatedAt = new Date().toISOString();
        task.updatedAt = new Date().toISOString();
        push({ type: "task.updated", task });
        return respond(requestId, { type, task });
      }
      case "subtask.delete": {
        const task = tasks.find((candidate) => candidate.subtasks.some((s) => s.subtaskId === payload.subtaskId));
        if (!task) return respondError(requestId, "unknown subtask");
        task.subtasks = task.subtasks.filter((s) => s.subtaskId !== payload.subtaskId);
        task.updatedAt = new Date().toISOString();
        push({ type: "task.updated", task });
        return respond(requestId, { type, task });
      }
      case "subtask.start": {
        // Mirrors the host: the orchestrator accepts and the board refreshes
        // via board.changed; here the log line is the observable effect.
        harnessLog(`subtask.start ${String(payload.subtaskId)}${payload.force ? " (force)" : ""}`);
        return respond(requestId, { type, accepted: true });
      }
      case "task.start": {
        harnessLog(`task.start ${String(payload.taskId)}`);
        return respond(requestId, { type, accepted: true });
      }
      case "subtask.dependency.add": {
        const task = tasks.find((candidate) => candidate.taskId === payload.taskId);
        const subtask = task?.subtasks.find((s) => s.subtaskId === payload.toSubtaskId);
        if (!task || !subtask) return respondError(requestId, "unknown task or subtask");
        // Cheap cycle probe so the shake/rejection path is exercisable: a
        // direct reverse edge is refused like the real DFS validation.
        const from = task.subtasks.find((s) => s.subtaskId === payload.fromSubtaskId);
        if (!from) return respondError(requestId, "dependency endpoints must share the task");
        if ((from.dependsOn ?? []).includes(payload.toSubtaskId)) {
          return respondError(requestId, "dependency would create a cycle");
        }
        if (!subtask.dependsOn.includes(payload.fromSubtaskId)) subtask.dependsOn.push(payload.fromSubtaskId);
        recomputeBlocked(task);
        push({ type: "task.updated", task });
        harnessLog(`subtask.dependency.add ${String(payload.fromSubtaskId)} -> ${String(payload.toSubtaskId)}`);
        return respond(requestId, { type, task });
      }
      case "subtask.dependency.remove": {
        const task = tasks.find((candidate) => candidate.taskId === payload.taskId);
        const subtask = task?.subtasks.find((s) => s.subtaskId === payload.toSubtaskId);
        if (!task || !subtask) return respondError(requestId, "unknown task or subtask");
        subtask.dependsOn = subtask.dependsOn.filter((id) => id !== payload.fromSubtaskId);
        recomputeBlocked(task);
        push({ type: "task.updated", task });
        harnessLog(`subtask.dependency.remove ${String(payload.fromSubtaskId)} -> ${String(payload.toSubtaskId)}`);
        return respond(requestId, { type, task });
      }
      case "taskBoard.open":
        // The Task Board panel + command exist, so the relay succeeds (in the
        // browser harness there is no editor area to reveal — the log line is
        // the observable effect).
        harnessLog(`taskBoard.open`);
        return respond(requestId, { type, accepted: true });
      case "work.history": return respond(requestId, { type, entries: workHistory });
      case "memory.list": return respond(requestId, { type, candidates: memoryCandidates });
      case "memory.resolve": {
        const candidate = memoryCandidates.find((entry) => entry.memoryCandidateId === payload.memoryCandidateId);
        if (!candidate) return respondError(requestId, "unknown candidate");
        candidate.status = payload.approve ? "approved" : "rejected";
        return respond(requestId, { type, candidate });
      }
      case "memory.open":
        // Log the send so a visual check can assert the Memories "Open" row wiring.
        harnessLog(`memory.open ${String(payload.memoryCandidateId)}`);
        return respond(requestId, { type, accepted: true });
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
      case "planner.open":
        harnessLog(`planner.open${payload.planId ? ` ${String(payload.planId)}` : ""}`);
        return respond(requestId, { type, accepted: true });
      case "planner.plans":
        return respond(requestId, { type, plans: plannerPlans.map(plannerPlanSummary) });
      case "planner.aspects.list":
        return respond(requestId, { type, aspects: plannerAspects });
      case "planner.state": {
        const plan = plannerPlans.find((candidate) => candidate.planId === payload.planId);
        if (!plan) return respondError(requestId, "harness: unknown plan");
        const live = plan.sessionId === "s-live";
        const session = plan.sessionId === null ? null : { ...sessions.find((s) => s.sessionId === plan.sessionId), live };
        return respond(requestId, { type, state: plannerState(plan), session });
      }
      case "planner.create": {
        const plan = {
          planId: `pl-${String(plannerPlans.length + 1)}`,
          title: payload.title ?? payload.brief.split("\n")[0].slice(0, 48),
          brief: payload.brief,
          aspectIds: payload.aspectIds,
          contextRoots: payload.contextRoots,
          notes: payload.notes ?? "",
          status: "draft",
          sessionId: null,
          taskId: payload.taskId ?? null,
          updatedAt: new Date().toISOString()
        };
        plannerPlans.unshift(plan);
        plannerArtifacts[plan.planId] = [];
        plannerAnnotations[plan.planId] = [];
        harnessLog(`planner.create ${plan.planId} aspects=${String(payload.aspectIds.length)} roots=${String(payload.contextRoots.length)} task=${plan.taskId ?? "none"}`);
        respond(requestId, { type, plan: plannerPlanSummary(plan) });
        setTimeout(() => {
          plan.sessionId = "s-live";
          plan.status = "active";
          push({ type: "planner.sessionReady", planId: plan.planId, sessionId: "s-live", ok: true });
        }, 600);
        return;
      }
      case "planner.updateIntake": {
        const plan = plannerPlans.find((candidate) => candidate.planId === payload.planId);
        if (!plan) return respondError(requestId, "harness: unknown plan");
        if (payload.title !== undefined) plan.title = payload.title;
        if (payload.brief !== undefined) plan.brief = payload.brief;
        if (payload.aspectIds !== undefined) plan.aspectIds = payload.aspectIds;
        if (payload.contextRoots !== undefined) plan.contextRoots = payload.contextRoots;
        if (payload.notes !== undefined) plan.notes = payload.notes;
        if (payload.taskId !== undefined) plan.taskId = payload.taskId === "" ? null : payload.taskId;
        plan.updatedAt = new Date().toISOString();
        return respond(requestId, { type, plan: plannerPlanSummary(plan) });
      }
      case "planner.archive": {
        const plan = plannerPlans.find((candidate) => candidate.planId === payload.planId);
        if (!plan) return respondError(requestId, "harness: unknown plan");
        plan.status = payload.archived ? "archived" : (plan.sessionId === null ? "draft" : "active");
        return respond(requestId, { type, plan: plannerPlanSummary(plan) });
      }
      case "planner.startSession": {
        const plan = plannerPlans.find((candidate) => candidate.planId === payload.planId);
        if (!plan) return respondError(requestId, "harness: unknown plan");
        respond(requestId, { type, accepted: true });
        setTimeout(() => {
          plan.sessionId = "s-live";
          plan.status = "active";
          push({ type: "planner.sessionReady", planId: plan.planId, sessionId: "s-live", ok: true });
        }, 600);
        return;
      }
      case "planner.sendTurn": {
        const plan = plannerPlans.find((candidate) => candidate.planId === payload.planId);
        if (!plan) return respondError(requestId, "harness: unknown plan");
        harnessLog(`planner.sendTurn ${plan.planId}: ${String(payload.prompt).slice(0, 60)}`);
        respond(requestId, { type, accepted: true });
        const sessionId = plan.sessionId ?? "s-live";
        push({ type: "chat.turnStarted", sessionId, runId: "run-planner" });
        window.__harness.eventSequence = (window.__harness.eventSequence ?? 10_000) + 10;
        push({ type: "chat.event", sessionId, line: { sequence: window.__harness.eventSequence, eventType: "user.message", summary: payload.prompt, createdAt: new Date().toISOString() } });
        setTimeout(() => {
          const doc = (plannerArtifacts[plan.planId] ?? []).find((artifact) => artifact.kind === "document");
          if (doc) doc.revision += 1;
          push({ type: "chat.turnCompleted", sessionId, runId: "run-planner", status: "completed" });
          push({ type: "planner.changed", planId: plan.planId });
        }, 700);
        return;
      }
      case "planner.annotation.add": {
        const list = plannerAnnotations[payload.planId];
        if (!list) return respondError(requestId, "harness: unknown plan");
        const annotation = {
          annotationId: `plnote-${String(now)}-${String(list.length + 1)}`,
          artifactId: payload.artifactId,
          anchor: payload.anchor,
          body: payload.body,
          status: "open",
          delegatedRev: null,
          createdAt: new Date().toISOString()
        };
        list.push(annotation);
        harnessLog(`planner.annotation.add ${payload.anchor}`);
        return respond(requestId, { type, annotation });
      }
      case "planner.annotation.setStatus": {
        const annotation = findPlannerAnnotation(payload.annotationId);
        if (!annotation) return respondError(requestId, "harness: unknown annotation");
        annotation.status = payload.status;
        if (payload.status === "open") annotation.delegatedRev = null;
        return respond(requestId, { type, annotation });
      }
      case "planner.annotation.remove": {
        for (const planId of Object.keys(plannerAnnotations)) {
          plannerAnnotations[planId] = plannerAnnotations[planId].filter((entry) => entry.annotationId !== payload.annotationId);
        }
        return respond(requestId, { type, removed: true });
      }
      case "planner.artifact.rename": {
        const artifact = findPlannerArtifact(payload.artifactId);
        if (!artifact) return respondError(requestId, "harness: unknown artifact");
        artifact.title = payload.title.trim().length === 0 ? artifact.baseTitle : payload.title.trim();
        return respond(requestId, { type, artifact });
      }
      case "planner.sendInstructions": {
        const list = plannerAnnotations[payload.planId] ?? [];
        let sentCount = 0;
        for (const annotation of list) {
          if (annotation.status !== "open") continue;
          annotation.status = "delegated";
          annotation.delegatedRev = findPlannerArtifact(annotation.artifactId)?.revision ?? null;
          sentCount += 1;
        }
        harnessLog(`planner.sendInstructions sent=${String(sentCount)}`);
        push({ type: "planner.changed", planId: payload.planId });
        return respond(requestId, { type, accepted: true, sentCount });
      }
      case "planner.regenerate":
        harnessLog(`planner.regenerate ${String(payload.planId)} aspect=${String(payload.aspectId ?? "all")}`);
        return respond(requestId, { type, accepted: true });
      case "planner.openArtifact":
        harnessLog(`planner.openArtifact ${String(payload.artifactId)}`);
        return respond(requestId, { type, accepted: true });
      case "planner.setPrototypeScripts": {
        const artifact = findPlannerArtifact(payload.artifactId);
        if (!artifact) return respondError(requestId, "harness: unknown artifact");
        artifact.scriptsEnabled = payload.enabled;
        harnessLog(`planner.setPrototypeScripts ${String(payload.enabled)}`);
        return respond(requestId, { type, artifact });
      }
      case "planner.aspects.save": {
        if (payload.aspect.aspectId !== undefined) {
          const existing = plannerAspects.find((aspect) => aspect.aspectId === payload.aspect.aspectId);
          if (!existing) return respondError(requestId, "harness: unknown aspect");
          existing.label = payload.aspect.label;
          existing.instructions = payload.aspect.instructions;
          existing.expectedArtifacts = payload.aspect.expectedArtifacts;
        } else {
          const slug = payload.aspect.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "aspect";
          plannerAspects.push({
            aspectId: plannerAspects.some((aspect) => aspect.aspectId === slug) ? `${slug}-2` : slug,
            label: payload.aspect.label,
            instructions: payload.aspect.instructions,
            expectedArtifacts: payload.aspect.expectedArtifacts,
            sortOrder: plannerAspects.length,
            archived: false,
            seeded: false
          });
        }
        return respond(requestId, { type, aspects: plannerAspects });
      }
      case "planner.aspects.archive": {
        const aspect = plannerAspects.find((entry) => entry.aspectId === payload.aspectId);
        if (!aspect) return respondError(requestId, "harness: unknown aspect");
        aspect.archived = payload.archived;
        return respond(requestId, { type, aspects: plannerAspects });
      }
      default:
        return respondError(requestId, `harness: unhandled request ${String(type)}`);
    }
  }

  // --- planner fixtures (ADR 0012) --------------------------------------------
  const plannerAspects = [
    { aspectId: "requirements", label: "Requirements & scope", instructions: "State the problem, users, and success criteria.", expectedArtifacts: ["Requirements brief (document)"], sortOrder: 0, archived: false, seeded: true },
    { aspectId: "architecture", label: "System architecture", instructions: "Describe components, boundaries, and decisions.", expectedArtifacts: ["Architecture overview (document)", "Component diagram (mermaid)"], sortOrder: 1, archived: false, seeded: true },
    { aspectId: "ui-ux", label: "UI / UX", instructions: "Screens, flows, states; prefer showing over telling.", expectedArtifacts: ["Screen inventory (document)", "Mockups (images)", "Clickable components (HTML prototype)"], sortOrder: 4, archived: false, seeded: true },
    { aspectId: "testing", label: "Testing & verification", instructions: "Test strategy and what observation proves it works.", expectedArtifacts: ["Test plan (document)"], sortOrder: 5, archived: false, seeded: true },
    { aspectId: "rollout", label: "Migration & rollout", instructions: "Sequencing, flags, rollback.", expectedArtifacts: ["Rollout plan (document)"], sortOrder: 8, archived: true, seeded: true },
    { aspectId: "brand-review", label: "Brand review", instructions: "Check the visuals against the brand book.", expectedArtifacts: ["Brand notes (document)"], sortOrder: 100, archived: false, seeded: false }
  ];
  const PLANNER_DOC = [
    "# Auth Service Revamp",
    "",
    "Replace the legacy cookie stack with an OIDC code flow. Sessions stay server-side;",
    "service-to-service calls move to short-lived tokens.",
    "",
    "## Phases",
    "",
    "- Phase 1 — provider spike and library choice",
    "- Phase 2 — migrate sessions and cut over cookies",
    "- Phase 3 — rollout with kill switch",
    "",
    "## Rollback",
    "",
    "Keep the legacy issuer warm for one release; flags gate every entry point.",
    "",
    "```mermaid",
    "flowchart LR; Browser-->Gateway-->AuthAPI; AuthAPI-->SessionStore",
    "```",
    "",
    "## Open questions",
    "",
    "Token TTLs and the service-account rotation cadence."
  ].join("\n");
  // A wireframe-ish SVG served through <img> (inert: no scripts execute in an
  // image context), so the annotation surface has real geometry to hit.
  const PLANNER_IMAGE = `data:image/svg+xml;utf8,${encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='640' height='400'>" +
    "<rect width='640' height='400' fill='#10131a'/>" +
    "<rect x='16' y='14' width='608' height='30' rx='4' fill='#1c212b'/>" +
    "<rect x='16' y='56' width='140' height='328' rx='4' fill='#181d26'/>" +
    "<rect x='172' y='56' width='220' height='150' rx='4' fill='#181d26'/>" +
    "<rect x='404' y='56' width='220' height='150' rx='4' fill='#181d26'/>" +
    "<rect x='172' y='222' width='452' height='162' rx='4' fill='#181d26'/>" +
    "<path d='M188 180 l40 -40 l36 16 l48 -52 l60 30' stroke='#7d9fbe' fill='none' stroke-width='2'/>" +
    "</svg>"
  )}`;
  const plannerArtifacts = {
    "pl-1": [
      { artifactId: "plart-doc", relPath: "architecture/overview.md", kind: "document", aspectId: "architecture", title: "Auth Service Revamp", baseTitle: "Auth Service Revamp", revision: 3, scriptsEnabled: false, collectedAt: iso(5), content: PLANNER_DOC },
      { artifactId: "plart-diagram", relPath: "architecture/components.mmd", kind: "diagram", aspectId: "architecture", title: "Component Diagram", baseTitle: "Component Diagram", revision: 2, scriptsEnabled: false, collectedAt: iso(5), content: "flowchart LR\n  Browser-->Gateway\n  Gateway-->AuthAPI\n  AuthAPI-->SessionStore" },
      { artifactId: "plart-image", relPath: "ui-ux/dashboard.png", kind: "image", aspectId: "ui-ux", title: "Dashboard Mockup", baseTitle: "Dashboard Mockup", revision: 1, scriptsEnabled: false, collectedAt: iso(20), imageDataUri: PLANNER_IMAGE },
      { artifactId: "plart-proto", relPath: "ui-ux/login-prototype.html", kind: "prototype", aspectId: "ui-ux", title: "Login Prototype", baseTitle: "Login Prototype", revision: 1, scriptsEnabled: false, collectedAt: iso(20), content: "<main style=\"font-family: sans-serif; padding: 24px; max-width: 320px\">\n  <h1>Sign in</h1>\n  <p><input placeholder=\"email\" style=\"width: 100%\"></p>\n  <p><input placeholder=\"password\" type=\"password\" style=\"width: 100%\"></p>\n  <p><button onclick=\"this.textContent='Clicked!'\">Sign in</button></p>\n  <p><a href=\"#\">Forgot password?</a></p>\n</main>" },
      { artifactId: "plart-test", relPath: "testing/test-plan.md", kind: "document", aspectId: "testing", title: "Test Plan", baseTitle: "Test Plan", revision: 1, scriptsEnabled: false, collectedAt: iso(9), content: "# Test Plan\n\n## Unit\n\n- allowlist coverage\n\n## Live\n\n- login flow against the spike provider" }
    ],
    "pl-2": []
  };
  const plannerAnnotations = {
    "pl-1": [
      { annotationId: "plnote-1", artifactId: "plart-doc", anchor: "block:4", body: "Split phase 2: session migration and cookie cutover are separate risks.", status: "open", delegatedRev: null, createdAt: iso(30) },
      { annotationId: "plnote-2", artifactId: "plart-diagram", anchor: "node:Gateway", body: "Gateway should own rate-limiting; add a limiter box.", status: "open", delegatedRev: null, createdAt: iso(25) },
      { annotationId: "plnote-3", artifactId: "plart-doc", anchor: "block:8", body: "Name the kill-switch flag.", status: "delegated", delegatedRev: 2, createdAt: iso(120) },
      { annotationId: "plnote-4", artifactId: "plart-image", anchor: "region:0.05,0.14,0.25,0.8", body: "Move filters into a left rail.", status: "resolved", delegatedRev: 1, createdAt: iso(200) }
    ],
    "pl-2": []
  };
  const plannerPlans = [
    { planId: "pl-1", title: "Auth service revamp", brief: "Replace the legacy cookie stack with OIDC; sessions stay server-side.", aspectIds: ["architecture", "ui-ux", "testing"], contextRoots: ["C:\\hitl\\asset_api\\src"], notes: "Server-side sessions only.", status: "active", sessionId: "s-live", taskId: "t-1", updatedAt: iso(5) },
    { planId: "pl-2", title: "Docs portal spike", brief: "A static docs portal for the pipeline team.", aspectIds: ["requirements"], contextRoots: [], notes: "", status: "archived", sessionId: null, taskId: null, updatedAt: iso(4000) }
  ];
  function plannerPlanSummary(plan) {
    const annotations = plannerAnnotations[plan.planId] ?? [];
    const taskTitle = plan.taskId === null ? undefined : tasks.find((task) => task.taskId === plan.taskId)?.title;
    return {
      ...plan,
      ...(taskTitle === undefined ? {} : { taskTitle }),
      artifactCount: (plannerArtifacts[plan.planId] ?? []).length,
      openAnnotationCount: annotations.filter((annotation) => annotation.status === "open").length
    };
  }
  function plannerState(plan) {
    return {
      plan: plannerPlanSummary(plan),
      artifacts: plannerArtifacts[plan.planId] ?? [],
      annotations: plannerAnnotations[plan.planId] ?? [],
      aspects: plannerAspects
    };
  }
  function findPlannerArtifact(artifactId) {
    for (const planId of Object.keys(plannerArtifacts)) {
      const artifact = plannerArtifacts[planId].find((entry) => entry.artifactId === artifactId);
      if (artifact) return artifact;
    }
    return undefined;
  }
  function findPlannerAnnotation(annotationId) {
    for (const planId of Object.keys(plannerAnnotations)) {
      const annotation = plannerAnnotations[planId].find((entry) => entry.annotationId === annotationId);
      if (annotation) return annotation;
    }
    return undefined;
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
    fixtures: { sessions, catalogs, workspacePolicy, diffChanges, cloneRepos, tasks, boardColumns, memoryCandidates, workHistory, taskReviewProjects, taskReviewSessions, taskReviewComments, planner: { plans: plannerPlans, artifacts: plannerArtifacts, annotations: plannerAnnotations, aspects: plannerAspects }, comments: [
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
      /** Planner: bump the main doc's revision and fire the coarse changed push. */
      plannerChanged(planId = "pl-1") {
        const doc = (window.__harness.fixtures.planner.artifacts[planId] ?? []).find((artifact) => artifact.kind === "document");
        if (doc) doc.revision += 1;
        push({ type: "planner.changed", planId });
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
       * Fires the coarse board.changed push (turn-completed / board mutation
       * simulation) — an open task-board panel refetches board.state. Mutate
       * `__harness.fixtures.tasks`/`boardColumns` first to see a delta land.
       */
      boardChanged() {
        push({ type: "board.changed" });
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
