/**
 * Mock extension host for the webview visual-test harness.
 *
 * Loads BEFORE the real bundled webview entry (chatRail.js, agents.js, …) and provides acquireVsCodeApi plus a
 * fixture-backed message host speaking the exact envelope protocol
 * (protocolVersion 1, request/response/push). Fixtures are deterministic
 * dummy data - no real backend, no docker, no network. Drive scripted flows
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
        ],
        // Root item (ADR 0013): the fleet keys its pulse/activity line/Stop off
        // this; the sidebar ⑂ chip ignores it (counts stay children-only).
        root: { nodeId: "root", label: "agent", status: "running", startedAt: iso(14), lastActivityAt: iso(1), lastActivity: "wiring exporter registry", lastCommand: "Edit", toolUses: 96, tokens: 412000 }
      },
      createdAt: iso(180),
      updatedAt: iso(2)
    },
    { sessionId: "s-waiting", title: "Refactor farm submit retries", status: "active", providerId: "claude", model: "claude-opus-4-8", createdAt: iso(240), updatedAt: iso(35) },
    { sessionId: "s-ended", title: "Investigate USD 24 upgrade", status: "ended", providerId: "codex", model: "gpt-5.4", createdAt: iso(2000), updatedAt: iso(1900) },
    { sessionId: "s-failed", title: "Docs generation spike", status: "failed", providerId: "codex", model: "gpt-5.5", createdAt: iso(500), updatedAt: iso(480) },
    { sessionId: "s-elsewhere", title: "Nightly test triage (window 2)", status: "active", providerId: "claude", model: "claude-opus-4-8", runningElsewhere: true, createdAt: iso(120), updatedAt: iso(8) },
    { sessionId: "s-resuming", title: "Reclaimed: shader cache warmup", status: "starting", providerId: "codex", model: "gpt-5.5", createdAt: iso(300), updatedAt: iso(1) },
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
        {
          id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", isDefault: false, hidden: false,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast, well-scoped work" },
            { reasoningEffort: "medium", description: "Balanced reasoning" },
            { reasoningEffort: "high", description: "Deeper reasoning" },
            { reasoningEffort: "xhigh", description: "Extra High reasoning" }
          ]
        },
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
      // ADR 0022 F3: a production-tier path cannot be mounted at all, so the
      // card becomes the three-line fixture decision (snapshot + typed
      // confirm). `sizeLabel` is webview-only for now - F3's line 2 wants a
      // size and AccessRequestSummary has no field for one yet.
      { accessRequestId: "ar-prod", sessionId: "s-live", displayPath: "P:\\Projects\\ShowA\\rigs\\hero_rig.ma", mode: "read-only", reason: "reproduce the skin-weights bug against the hero rig", status: "pending", requestedAt: iso(2), production: true, disposition: "snapshot", sizeLabel: "48 MB" },
      { accessRequestId: "ar-ok", sessionId: "s-live", displayPath: "D:\\shared\\fixtures", mode: "read-only", reason: "test fixtures", status: "approved", requestedAt: iso(90) },
      // An already-approved snapshot: the mounts list says "production
      // snapshot · session-scoped" instead of "granted", because a copy is
      // not a mount (F3's provenance chip).
      { accessRequestId: "ar-snap-ok", sessionId: "s-live", displayPath: "P:\\Projects\\ShowA\\rigs\\hero_shirt.ma", mode: "read-only", reason: "earlier fixture snapshot", status: "approved", requestedAt: iso(120), production: true, disposition: "snapshot" }
    ],
    security: {
      managed: false,
      label: "Harness personal policy",
      cloneOnly: false,
      networkedAiAllowed: true,
      omissionsEnabled: false
    }
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

  /** Landing drawer rows (ADR 0014): one disjoint, one overlapping pair member, one path-less legacy capture. */
  const harnessLanding = [
    { taskId: "t-1", taskTitle: "Alembic publish support", subtaskId: "st-3", subtaskTitle: "Review sweep", sessionId: "s-clone", repos: [{ repoName: "asset_api", fileCount: 4 }], capturedAt: iso(30), overlapsWith: [] },
    { taskId: "t-3", taskTitle: "Task board rollout", subtaskId: "st-6", subtaskTitle: "Spike column persistence", sessionId: "s-ended", repos: [{ repoName: "asset_api", fileCount: 2 }, { repoName: "tools", fileCount: 1 }], capturedAt: iso(2980), overlapsWith: ["st-9"] },
    { taskId: "t-2", taskTitle: "Py3 farm audit", subtaskId: "st-9", subtaskTitle: "Legacy capture", sessionId: "s-failed", repos: [{ repoName: "asset_api", fileCount: 3 }], capturedAt: iso(4000), overlapsWith: ["st-6"], overlapUnknown: true }
  ];

  /** Task FAQ entries (ADR 0007) - t-1's fixture count matches its faqCount. */
  const harnessFaqs = [
    { faqId: "faq-1", taskId: "t-1", pattern: "which branch", answer: "Work on feature/alembic-publish; never touch main directly.", createdAt: iso(100) },
    { faqId: "faq-2", taskId: "t-1", pattern: "test framework", answer: "pytest with the studio fixtures package.", createdAt: iso(90) }
  ];

  /** Task recipes (ADRs 0007/0002): one seeded, one repo overlay (with a model profile). */
  const harnessRecipes = [
    {
      recipeId: "recipe-implement-verify", name: "Implement + verify",
      description: "One implementer, then a verifier that builds on its output.",
      source: "seeded", archived: false, createdAt: iso(9000), updatedAt: iso(9000),
      subtasks: [
        { key: "implement", title: "Implement", prompt: "Implement \"{title}\".", autoStart: false, dependsOnKeys: [] },
        { key: "verify", title: "Verify", prompt: "Verify \"{title}\".", autoStart: true, seedMode: "upstream", dependsOnKeys: ["implement"] }
      ]
    },
    {
      recipeId: "overlay:vfx-shot-pipeline", name: "VFX shot pipeline",
      description: "Research the shot setup, implement, then run the render test.",
      source: "overlay", archived: false, createdAt: iso(9000), updatedAt: iso(9000),
      subtasks: [
        { key: "research", title: "Research", prompt: "Research \"{title}\".", autoStart: false, dependsOnKeys: [] },
        { key: "implement", title: "Implement", prompt: "Implement \"{title}\".", autoStart: true, seedMode: "upstream", dependsOnKeys: ["research"], model: { providerId: "claude", model: "claude-fable-5" } },
        { key: "render-test", title: "Render test", prompt: "Run the render test for \"{title}\".", autoStart: true, seedMode: "upstream", dependsOnKeys: ["implement"] }
      ]
    }
  ];

  const tasks = [
    {
      taskId: "t-1", title: "Alembic publish support", description: "4 repos: db, api, maya, houdini", state: "in-progress", columnId: "col-in-progress", linkedWorkspaceSetIds: ["set-1"], linkedSessionIds: ["s-live", "s-clone"], createdAt: iso(200), updatedAt: iso(5), lastWorkedAt: iso(2), openReviewCommentCount: 1, faqCount: 2, autoAnswerFaq: true,
      clonePolicy: { workspaceSetId: "set-1", projectIds: ["p-asset"], dirtyHandling: "carry", workspaceSetProjectCount: 2 },
      subtasks: [
        { subtaskId: "st-1", taskId: "t-1", title: "Patch alembic exporter", description: "exporters/alembic.py", prompt: "Patch exporters/alembic.py to support alembic caches.", autoStart: false, origin: "manual", columnId: "col-in-progress", sortOrder: 0, createdAt: iso(190), updatedAt: iso(5), isBlocked: false, dependsOn: [], isRunning: true, linkedSessionIds: ["s-live"], model: { providerId: "claude", model: "claude-fable-5" } },
        { subtaskId: "st-2", taskId: "t-1", title: "Update allowlist config", description: "", prompt: "", autoStart: true, origin: "manual", columnId: "col-todo", sortOrder: 1, createdAt: iso(188), updatedAt: iso(188), isBlocked: true, dependsOn: ["st-1"], isRunning: false, linkedSessionIds: [], seedMode: "upstream" },
        { subtaskId: "st-3", taskId: "t-1", title: "Review sweep", description: "", origin: "review", autoStart: false, columnId: "col-review", sortOrder: 2, createdAt: iso(100), updatedAt: iso(20), doneAt: iso(20), isBlocked: false, dependsOn: [], isRunning: false, linkedSessionIds: [], verifyUnmet: true }
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
        // is allowed - instantly satisfied) and wears a failed chip from a
        // cancelled earlier run; drives the board's edge + failed visuals.
        { subtaskId: "st-5", taskId: "t-3", title: "Draft board announcement", description: "", prompt: "Write the internal rollout note for the task board.", autoStart: false, origin: "manual", columnId: "col-in-progress", sortOrder: 0, createdAt: iso(3100), updatedAt: iso(60), isBlocked: false, dependsOn: ["st-6"], isRunning: false, lastFailureAt: iso(55), isParked: true, linkedSessionIds: [] },
        { subtaskId: "st-7", taskId: "t-3", title: "Cross-post to wiki", description: "", prompt: "Mirror the rollout note onto the wiki.", autoStart: true, origin: "manual", columnId: "col-todo", sortOrder: 2, createdAt: iso(3100), updatedAt: iso(30), isBlocked: false, dependsOn: [], isRunning: false, isQueued: true, linkedSessionIds: [] },
        { subtaskId: "st-6", taskId: "t-3", title: "Spike column persistence", description: "", prompt: "", autoStart: false, origin: "manual", columnId: "col-finished", sortOrder: 1, createdAt: iso(3100), updatedAt: iso(2980), doneAt: iso(2980), isBlocked: false, dependsOn: [], isRunning: false, linkedSessionIds: [], hasUnlandedChangeset: true }
      ]
    }
  ];

  // Attention-stack questions: two pending on s-live (stacks with the two
  // pending access requests → pager shows 4), one answered (hidden).
  const agentQuestions = [
    { questionId: "q-1", sessionId: "s-live", question: "Should the alembic exporter keep legacy 1.x sidecar files?", options: ["Drop them - 2.x readers are everywhere", "Keep writing both for one release"], status: "pending", createdAt: iso(6) },
    { questionId: "q-2", sessionId: "s-live", question: "Name the new config section?", options: [], status: "pending", createdAt: iso(5) },
    {
      questionId: "q-3", sessionId: "s-live", kind: "manual-check", subtaskId: "st-3",
      question: "Does the exported alembic load correctly in Maya with the new framerange guard?",
      options: ["Loads correctly - matches the render", "Loads but framerange is wrong", "Fails to load"],
      images: [
        { path: "/workspace/renders/compare.png", dataUri: "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="72"><rect width="120" height="72" fill="#2b4a6f"/><circle cx="36" cy="36" r="18" fill="#3794ff"/><text x="66" y="42" fill="#fff" font-size="12">render</text></svg>') },
        { path: "/workspace/renders/missing.png" }
      ],
      steps: [
        { text: "Open Maya 2026 with the studio env (menu: Pipeline → Dev Shell)." },
        { text: "File → Import → /workspace/exports/publish_test.abc", imageDataUri: "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#333"/><text x="8" y="24" fill="#ccc" font-size="10">File / Import...</text></svg>') },
        { text: "Scrub frames 1001-1050 and compare against the attached render." }
      ],
      status: "pending", createdAt: iso(4)
    },
    { questionId: "q-0", sessionId: "s-live", question: "Already answered?", options: [], status: "answered", answer: "yes", createdAt: iso(50) }
  ];

  const memoryCandidates = [
    { memoryCandidateId: "m-1", sessionId: "s-live", content: "asset_api integration tests need the fixture server on port 9021.", status: "pending", createdAt: iso(10), scope: "workspace", scopeLabel: "asset_api", tags: ["python"], origin: "agent" },
    { memoryCandidateId: "m-2", sessionId: "s-ended", content: "USD builds must pin MaterialX 1.39.", status: "approved", createdAt: iso(1500), scope: "global", tags: ["usd"], origin: "agent" },
    { memoryCandidateId: "m-3", sessionId: "user", content: "Prefer pytest over unittest here.", status: "approved", createdAt: iso(300), scope: "workspace", scopeLabel: "asset_api", tags: ["python"], origin: "user" }
  ];
  const detectedTags = ["python", "pip", "maya"];
  let memorySerial = 3;

  // --- MCP registry fixture ------------------------------------------------
  const mcpServers = [
    { serverId: "mcp-1", name: "asset-db", command: "npx", args: ["-y", "@studio/asset-mcp"], envKeys: ["ASSET_DB_TOKEN"], enabledByDefault: true, sensitive: false, source: "registry" },
    { serverId: "mcp-2", name: "shotgrid", command: "uvx", args: ["shotgrid-mcp"], envKeys: [], enabledByDefault: false, sensitive: true, notes: "Production tracking - writes are real.", source: "registry" },
    { serverId: "mcp-settings-docs", name: "docs", command: "node", args: ["docs-server.mjs"], envKeys: [], enabledByDefault: true, sensitive: false, source: "settings" }
  ];
  const mcpOverrides = [
    { scope: "workspace-set", refId: "set-1", serverId: "mcp-1", state: "on" }
  ];
  let mcpSerial = 2;

  // --- Configure fixture (UX overhaul P6; Memories re-homed per ADR 0020) ---
  // One mutable ConfigState worth of rows: config.setSetting writes back so
  // value round-trips and the saved note are observable without a real host.
  const configDefaultModels = { codex: "gpt-5.5" };
  const configSettings = [
    { key: "runtime.pathAdditions", section: "runtime", label: "Extra folders on PATH", detail: "Prepended when Drydock runs sbx and the agent CLIs.", kind: "string-list", value: ["C:\\tools\\ffmpeg\\bin"], requiresReload: true, provenance: "settings" },
    { key: "runtime.env", section: "runtime", label: "Extra environment variables", detail: "Passed to Drydock's runtime tools. Do not put secrets here.", kind: "string-map", value: { REZ_CONFIG_FILE: "C:\\rez\\config.py" }, requiresReload: true, provenance: "settings" },
    { key: "orchestrator.maxConcurrentRuns", section: "runtime", label: "Agents running at once", detail: "Further starts wait in a visible queue; Auto derives from this machine.", kind: "number", value: 0, requiresReload: false, min: 0, max: 64, provenance: "settings" },
    { key: "deniedPaths", section: "security", label: "Folders the agent can never reach", detail: "Excluded from mounts, snapshots, and diffs.", kind: "string-list", value: ["C:\\finance"], requiresReload: true, provenance: "settings" },
    { key: "security.cloneOnly", section: "security", label: "Always work in a private clone", detail: "Agents get a copy of the repository instead of your live folder.", kind: "boolean", value: false, requiresReload: true, provenance: "settings" },
    { key: "memory.tagRules", section: "memories", label: "Extra file patterns that tag a project", detail: "Tags are detected per mounted folder and decide which tagged team memories a briefing carries. These extend the built-in table below.", kind: "tag-rules", value: [{ globs: ["*.usd", "*.usda"], tag: "usd" }], requiresReload: true, provenance: "settings" },
    { key: "teamInstructionsPath", section: "preprompts", label: "Studio standing instructions", detail: "A markdown file appended to every session briefing, capped at 8 KB.", kind: "string", value: "C:\\studio\\drydock-instructions.md", requiresReload: true, provenance: "settings" }
  ];
  const configTagRules = [
    { globs: ["*.py", "pyproject.toml"], tag: "python", provenance: "local" },
    { globs: ["package.py"], tag: "rez", provenance: "local" },
    { globs: ["*.ma", "*.mb"], tag: "maya", provenance: "local" },
    { globs: ["*.usd", "*.usda"], tag: "usd", provenance: "settings" }
  ];
  const configState = (scope) => ({
    scope: scope === "project" ? "project" : "global",
    projectLabel: "demo-project",
    availability: { available: true, sbxDisplayPath: "C:\\tools\\sbx\\sbx.exe" },
    providers: catalogs.map((catalog) => ({
      providerId: catalog.providerId,
      label: catalog.displayName,
      authStatus: catalog.authStatus,
      authKind: "oauth",
      ...(catalog.loginHint === undefined ? {} : { loginHint: catalog.loginHint }),
      models: catalog.models.filter((model) => !model.hidden).map((model) => ({ id: model.id, displayName: model.displayName })),
      ...(configDefaultModels[catalog.providerId] === undefined ? {} : { defaultModel: configDefaultModels[catalog.providerId] }),
      usedByRecentChats: catalog.providerId === "codex" ? 4 : 1
    })),
    mcp: mcpServers.map((server) => ({
      serverId: server.serverId,
      name: server.name,
      provenance: server.source === "settings" ? "settings" : "local",
      enabled: server.enabledByDefault,
      transport: "stdio",
      command: server.command,
      args: server.args,
      sensitive: server.sensitive,
      ...(server.source === "settings" ? { filePath: "C:\\studio\\mcp.json" } : {})
    })),
    recipes: [
      { recipeId: "rc-1", name: "Bug fix with repro", description: "Repro test first, fix second, verify third.", stepCount: 3, provenance: "local" }
    ],
    aspects: [
      { aspectId: "asp-1", label: "Test plan", expectedArtifacts: ["test-plan.md"], provenance: "local" }
    ],
    tagRules: configTagRules,
    preprompts: [
      { label: "Studio standing instructions", path: "C:\\studio\\drydock-instructions.md", provenance: "settings", exists: true, bytes: 2048 }
    ],
    settings: configSettings,
    editablePaths: ["C:\\studio\\mcp.json", "C:\\studio\\drydock-instructions.md"],
    validation: validationState()
  });

  // --- validation runtimes fixture (ADR 0022 M7) ---------------------------
  // Three runtimes: the warm default with a queue, a quarantined
  // profile-exception runtime (drives the F5 banner + the ⚠ badge), and a
  // stopped on-demand one. Mutations below mutate THESE objects, so a
  // set-default / archive / association edit round-trips without a real host.
  const validationRuntimes = [
    {
      runtimeId: "vr-default", displayName: "default", image: "win-dcc-2026.03", lifecycle: "keep-warm",
      capabilities: ["maya", "python"], policyProfileRef: "validation.default", isDefault: true,
      vmName: "drydock-validation-default", connectionHost: "172.30.4.11", availability: "available", queueDepth: 1,
      probes: {
        state: "pass", at: iso(30), greenAt: iso(30), lines: [
          { probeId: "no-egress", title: "no network egress", state: "pass", detail: "curl to 1.1.1.1 refused after 2s" },
          { probeId: "pkgroot-absent", title: "P:\\Projects not mounted", state: "pass", detail: "path absent in guest" },
          { probeId: "mirror-readable", title: "mirror readable", state: "pass", detail: "\\\\host-mirror\\rez v214 listed 41 packages" }
        ]
      }
    },
    {
      runtimeId: "vr-prod", displayName: "production_tester", image: "win-dcc-2026.03-showa", lifecycle: "keep-warm",
      capabilities: ["maya", "fixtures:ShowA_approved"], policyProfileRef: "validation.production", profileException: true,
      isDefault: false, vmName: "drydock-validation-production-tester", connectionHost: "172.30.4.12",
      availability: "quarantined", queueDepth: 0,
      probes: {
        state: "breach", at: iso(12), greenAt: iso(240), lines: [
          { probeId: "prod-isolation", title: "must-fail: read P:\\Projects", state: "breach", detail: "read SUCCEEDED - the guest reached a production path" },
          { probeId: "no-egress", title: "no network egress", state: "pass", detail: "curl to 1.1.1.1 refused after 2s" }
        ]
      }
    },
    {
      runtimeId: "vr-cpp", displayName: "cpp-builds", image: "win-msvc-2026.01", lifecycle: "on-demand",
      capabilities: ["msvc"], policyProfileRef: "validation.default", isDefault: false,
      vmName: "drydock-validation-cpp-builds", availability: "stopped", queueDepth: 0
    }
  ];
  // One personal row and one studio-pinned row (H6): the pinned one renders
  // locked with its policy source instead of a select.
  const validationAssociations = [
    { projectRootId: "p-asset", projectLabel: "asset_api", runtimeId: "vr-cpp", source: "personal" },
    { projectRootId: "p-edu", projectLabel: "Education", runtimeId: "vr-default", source: "managed", pinned: true }
  ];
  const validationProjects = [
    { projectRootId: "p-demo", label: "demo-project" },
    { projectRootId: "p-asset", label: "asset_api" },
    { projectRootId: "p-edu", label: "Education" }
  ];
  const validationSettings = { defaultRuntimeId: "vr-default", topologyPreset: "default-plus-named", warmCap: 2 };
  const validationManaged = {
    topologyPin: "default-plus-named",
    warmCap: 3,
    profileExceptionCreation: "allowed",
    imageAllowlist: ["win-dcc-2026.03", "win-dcc-2026.03-showa", "win-msvc-2026.01"]
  };
  // Mutated IN PLACE (never reassigned) so `__harness.fixtures.validation.
  // quarantines` stays a live handle for console-driven scenarios.
  const validationQuarantines = [
    { runtimeId: "vr-prod", displayName: "production_tester", probeId: "prod-isolation", detail: "production isolation check failed", at: iso(12) }
  ];
  let validationRuntimeSerial = 3;
  // Flip `hostSupported` from the console (then push validation.changed) to see
  // the off-Windows line: one calm sentence and nothing else.
  const validationFlags = { hostSupported: true };
  function validationState() {
    return {
      hostSupported: validationFlags.hostSupported,
      runtimes: validationRuntimes,
      associations: validationAssociations,
      projects: validationProjects,
      settings: validationSettings,
      managed: validationManaged,
      quarantines: validationQuarantines
    };
  }

  // Jobs covering every chip state F2 names. The newest terminal job is the
  // superseded pass (so the `· edited since ↻` suffix renders on boot);
  // `scenario.validationJobProgress()` steps vj-step to a FAILED receipt,
  // which then becomes the newest terminal and shows the promoted line.
  const validationJobs = [
    { jobId: "vj-run", state: "running", profileRef: "tool_smoke", runtimeDisplayName: "default", queuedAt: iso(3), startedAt: iso(1), sessionId: "s-live", taskId: "t-1", subtaskId: "st-1" },
    { jobId: "vj-queued", state: "queued", profileRef: "tool_smoke", queuePosition: 2, runtimeDisplayName: "default", queuedAt: iso(2), sessionId: "s-live", taskId: "t-1" },
    { jobId: "vj-license", state: "license-wait", profileRef: "maya_regression", runtimeDisplayName: "default", queuePosition: 2, licenseWaitMs: 125_000, queuedAt: iso(5), startedAt: iso(4), sessionId: "s-live", taskId: "t-1" },
    { jobId: "vj-parked", state: "parked", profileRef: "cpp_plugin_build", runtimeDisplayName: "cpp-builds", parkedReason: "cpp-builds is offline - nothing has run for this job", queuedAt: iso(7), sessionId: "s-live", taskId: "t-1" },
    {
      jobId: "vj-passed", state: "completed", profileRef: "tool_smoke", runtimeDisplayName: "default", queuedAt: iso(20), startedAt: iso(19), completedAt: iso(17),
      sessionId: "s-live", taskId: "t-1", subtaskId: "st-1",
      receipt: {
        verdict: "passed", summary: "Ran 14 tests in 89.2s - OK", changesetRef: "a3f21c9d4e7b18",
        mirrorVersion: 214, mirrorFreshnessAt: iso(21), probesGreenAt: iso(30), licenseWaitMs: 0,
        superseded: true, fixtureManifestHash: "9c41e2ab77d0"
      }
    },
    { jobId: "vj-step", state: "queued", profileRef: "tool_smoke", queuePosition: 3, runtimeDisplayName: "default", queuedAt: iso(1), sessionId: "s-live", taskId: "t-1" }
  ];

  /** Drops one runtime's quarantine in place (keeps the exposed handle live). */
  function removeQuarantine(runtimeId) {
    for (let index = validationQuarantines.length - 1; index >= 0; index -= 1) {
      if (validationQuarantines[index].runtimeId === runtimeId) validationQuarantines.splice(index, 1);
    }
  }

  /** The rail's L0 derives from the same fixtures the panels read. */
  function validationRailStatus() {
    if (validationQuarantines.length > 0) {
      return { dot: "blocked", line: "Validation blocked - production_tester is quarantined; its queue is stopped." };
    }
    if (validationJobs.some((job) => job.state === "running" || job.state === "syncing" || job.state === "starting")) {
      return { dot: "running", line: "Validating on default - queue 1 - isolation verified 09:00" };
    }
    if (validationJobs.some((job) => job.state === "completed" && job.receipt && job.receipt.verdict !== "passed")) {
      return { dot: "failed", line: "Last validation failed - test_icon_fallback" };
    }
    return { dot: "ok", line: "Validation ready - queue 0 - isolation verified 09:00" };
  }

  /** Notifies every open panel that the registry (or its health) moved. */
  function pushValidationChanged() {
    push({ type: "validation.changed" });
    push({ type: "config.changed" });
  }

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

  // Sandbox preview fixtures (ADR 0017): one live preview on s-live.
  let previewFixtures = [
    { previewId: "pv-s-live-8080", sessionId: "s-live", title: "Publish settings mockup (qt-dark)", containerPort: 8080, path: "/", url: "http://127.0.0.1:39181/", status: "up", createdAt: iso(3) }
  ];

  const taskReviewNotes = [
    "Clone session \"Clone helper\" is not live in this window - its changes are not listed."
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

  // --- code-review fixture (in-panel PR-style review) ----------------------
  // Scope-shaped projections for codeReview.state plus per-file hunk content
  // for codeReview.fileDiff. Comment counts join from taskReviewComments by
  // the `<repo>:<path>` anchor, so notes added here show up in both panels.
  const CR_IMG_BEFORE = "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><rect width="72" height="72" rx="10" fill="#444"/><circle cx="36" cy="36" r="18" fill="#888"/></svg>');
  const CR_IMG_AFTER = "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><rect width="72" height="72" rx="10" fill="#2b4a6f"/><circle cx="36" cy="36" r="18" fill="#3794ff"/><path d="M28 36l6 6 12-12" stroke="#fff" stroke-width="3" fill="none"/></svg>');

  function crOpenCount(repo, path) {
    let count = 0;
    for (const sessionId of Object.keys(taskReviewComments)) {
      for (const comment of taskReviewComments[sessionId]) {
        if (comment.status === "open" && comment.filePath === `${repo}:${path}`) count += 1;
      }
    }
    return count;
  }

  function crFile(base) {
    return { contentKind: "text", ...base, commentCount: crOpenCount(base.repo, base.path) };
  }

  function computeCodeReviewState(scope) {
    const s = (sessionId, sessionTitle) => (scope === "uncommitted" ? {} : { sessionId, sessionTitle });
    const assetApi = [
      crFile({ repo: "asset_api", path: "src/publish_hooks.py", changeKind: "modify", addedLines: 18, removedLines: 4, baselineId: "trb-1", ...s("s-live", "Rename sweep") }),
      crFile({ repo: "asset_api", path: "src/exporters/alembic.py", changeKind: "modify", addedLines: 9, removedLines: 2, baselineId: "trb-2", ...s("s-live", "Rename sweep") }),
      crFile({ repo: "asset_api", path: "assets/icon_publish.png", changeKind: "modify", contentKind: "image", bytesBefore: 24_678, bytesAfter: 32_358, ...s("s-live", "Rename sweep") }),
      crFile({ repo: "asset_api", path: "assets/data/thumbs.bin", changeKind: "modify", contentKind: "binary", bytesBefore: 12_698, bytesAfter: 13_415, ...s("s-live", "Rename sweep") }),
      crFile({ repo: "asset_api", path: "package-lock.json", changeKind: "modify", addedLines: 178, removedLines: 64, largeDiff: true, baselineId: "trb-5", ...s("s-live", "Rename sweep") })
    ];
    const farmSubmit = [
      crFile({ repo: "farm_submit", path: "submit.py", changeKind: "modify", addedLines: 9, removedLines: 2, baselineId: "trb-4", ...s("s-live", "Rename sweep") }),
      ...(scope === "session" ? [] : [crFile({ repo: "farm_submit", path: "queue.py", changeKind: "modify", addedLines: 5, removedLines: 1, clone: true, conflicted: true, ...s("s-clone", "Clone helper") })]),
      crFile({ repo: "farm_submit", path: "vendor/generated_api.py", changeKind: "modify", addedLines: 812, removedLines: 540, largeDiff: true, baselineId: "trb-6", ...s("s-live", "Rename sweep") })
    ];
    // The uncommitted scope adds a hand-edited untracked file no session owns.
    const uncommittedExtra = scope === "uncommitted"
      ? [crFile({ repo: "asset_api", path: "notes/review_notes.md", changeKind: "add", addedLines: 12, removedLines: 0 })]
      : [];
    const state = computeTaskReviewState();
    return {
      taskId: "t-1",
      title: state.title,
      scope,
      projects: [
        { name: "asset_api", files: [...assetApi, ...uncommittedExtra] },
        { name: "farm_submit", files: farmSubmit }
      ],
      openCommentCount: state.openCommentCount,
      primarySession: taskReviewSessions[0],
      notes: scope === "uncommitted" ? ["farm_submit: worktree also has 1 change from outside this task."] : state.notes
    };
  }

  const CR_WS_HUNK = {
    oldStart: 70, oldLines: 4, newStart: 75, newLines: 4,
    rows: [
      { kind: "context", oldNo: 70, newNo: 75, text: "def emit_event(kind, asset_id):" },
      { kind: "del", oldNo: 71, text: "    payload = {'kind': kind,  'id': asset_id}" },
      { kind: "add", newNo: 76, text: "    payload = {'kind': kind, 'id': asset_id}" },
      { kind: "context", oldNo: 72, newNo: 77, text: "    bus.emit(payload)" }
    ]
  };

  function computeCodeReviewDiff(repo, filePath, ignoreWhitespace) {
    const key = `${repo}:${filePath}`;
    if (key === "asset_api:src/publish_hooks.py") {
      const hunks = [
        {
          oldStart: 38, oldLines: 6, newStart: 38, newLines: 7,
          rows: [
            { kind: "context", oldNo: 40, newNo: 40, text: "" },
            { kind: "context", oldNo: 41, newNo: 41, text: "def publish_asset(asset, registry):" },
            { kind: "del", oldNo: 42, text: "    result = registry.push(asset)" },
            { kind: "add", newNo: 42, text: "    validated = validate_asset(asset, strict=True)" },
            { kind: "add", newNo: 43, text: "    result = registry.push(validated)" },
            { kind: "context", oldNo: 43, newNo: 44, text: "    if result.ok:" },
            { kind: "context", oldNo: 44, newNo: 45, text: "        emit_event('publish', asset.id)" }
          ]
        },
        {
          oldStart: 96, oldLines: 1, newStart: 101, newLines: 6,
          rows: [
            { kind: "context", oldNo: 96, newNo: 101, text: "" },
            { kind: "add", newNo: 102, text: "def validate_asset(asset, strict=False):" },
            { kind: "add", newNo: 103, text: "    problems = run_checks(asset, PUBLISH_CHECKS)" },
            { kind: "add", newNo: 104, text: "    if problems and strict:" },
            { kind: "add", newNo: 105, text: "        raise PublishError(problems)" },
            { kind: "add", newNo: 106, text: "    return asset" }
          ]
        },
        ...(ignoreWhitespace ? [] : [CR_WS_HUNK])
      ];
      return { kind: "text", hunks };
    }
    if (key === "asset_api:src/exporters/alembic.py") {
      return {
        kind: "text",
        hunks: [{
          oldStart: 54, oldLines: 3, newStart: 54, newLines: 4,
          rows: [
            { kind: "context", oldNo: 54, newNo: 54, text: "class AlembicExporter:" },
            { kind: "context", oldNo: 55, newNo: 55, text: "    def export(self, node, path):" },
            { kind: "del", oldNo: 56, text: "        cmds.AbcExport(j=job(node, path))" },
            { kind: "add", newNo: 56, text: "        with framerange_guard(node):" },
            { kind: "add", newNo: 57, text: "            cmds.AbcExport(j=job(node, path))" }
          ]
        }]
      };
    }
    if (key === "asset_api:assets/icon_publish.png") {
      return { kind: "image", beforeDataUri: CR_IMG_BEFORE, afterDataUri: CR_IMG_AFTER, bytesBefore: 24_678, bytesAfter: 32_358 };
    }
    if (key === "asset_api:assets/data/thumbs.bin") {
      return { kind: "binary", bytesBefore: 12_698, bytesAfter: 13_415 };
    }
    if (key === "farm_submit:queue.py") {
      return {
        kind: "text",
        hunks: [{
          oldStart: 12, oldLines: 2, newStart: 12, newLines: 2,
          rows: [
            { kind: "context", oldNo: 12, newNo: 12, text: "def submit(job):" },
            { kind: "del", oldNo: 13, text: "    return farm.submit(job, retries=0)" },
            { kind: "add", newNo: 13, text: "    return farm.submit(job, retries=RETRY_POLICY.max)" }
          ]
        }]
      };
    }
    if (key === "asset_api:notes/review_notes.md") {
      return {
        kind: "text",
        hunks: [{
          oldStart: 1, oldLines: 0, newStart: 1, newLines: 3,
          rows: [
            { kind: "add", newNo: 1, text: "# Review notes" },
            { kind: "add", newNo: 2, text: "" },
            { kind: "add", newNo: 3, text: "- confirm UDIM fallback with lookdev" }
          ]
        }]
      };
    }
    // Large fixtures (package-lock.json / generated_api.py / submit.py fallback):
    // synthesize rows so expand-on-demand has something honest to show.
    const rows = [];
    for (let i = 1; i <= 24; i += 1) {
      rows.push({ kind: i % 3 === 0 ? "add" : i % 7 === 0 ? "del" : "context", ...(i % 3 === 0 ? { newNo: i } : i % 7 === 0 ? { oldNo: i } : { oldNo: i, newNo: i }), text: `    line ${String(i)} of ${filePath}` });
    }
    return { kind: "text", hunks: [{ oldStart: 1, oldLines: 20, newStart: 1, newLines: 20, rows }], truncated: filePath.includes("generated") };
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
      case "chat.cancelTurn":
        harnessLog(`chat.cancelTurn ${String(payload.sessionId)}`);
        return respond(requestId, { type, accepted: true });
      case "chat.spawnRole": {
        const parent = sessions.find((candidate) => candidate.sessionId === payload.sessionId);
        if (!parent) return respondError(requestId, "unknown session");
        const child = {
          sessionId: `s-role-${payload.role}-${String(sessions.length)}`,
          title: `${payload.role} - ${parent.title}`,
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
      case "provider.login": return respond(requestId, { type, providerId: payload.providerId, launched: "sbx secret set -g openai --oauth", mode: "terminal" });
      case "provider.submitCode": return respond(requestId, { type, providerId: payload.providerId, accepted: true });
      case "provider.submitApiKey": return respond(requestId, { type, providerId: payload.providerId, authStatus: "authenticated" });
      case "provider.cancelLogin": return respond(requestId, { type, providerId: payload.providerId, cancelled: false });
      case "isolatedRun.listRuntimes": return respond(requestId, { type, runtimes });
      case "isolatedRun.stopRuntime": return respond(requestId, { type, runtimeId: payload.runtimeId, status: "removed", diagnostics: [] });
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
        if (payload.autoAnswerFaq !== undefined) {
          task.autoAnswerFaq = payload.autoAnswerFaq;
          harnessLog(`task.update ${String(payload.taskId)} autoAnswerFaq=${String(payload.autoAnswerFaq)}`);
        }
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
      case "recipes.list": {
        harnessLog("recipes.list");
        return respond(requestId, { type, recipes: harnessRecipes });
      }
      case "task.faq.list": {
        harnessLog(`task.faq.list ${String(payload.taskId)}`);
        return respond(requestId, { type, faqs: harnessFaqs.filter((faq) => faq.taskId === payload.taskId) });
      }
      case "task.faq.add": {
        harnessLog(`task.faq.add ${String(payload.taskId)} pattern=${String(payload.pattern)}`);
        harnessFaqs.push({ faqId: `faq-${String(harnessFaqs.length + 1)}`, taskId: payload.taskId, pattern: payload.pattern, answer: payload.answer, createdAt: new Date().toISOString() });
        const owner = tasks.find((candidate) => candidate.taskId === payload.taskId);
        if (owner) owner.faqCount = harnessFaqs.filter((faq) => faq.taskId === payload.taskId).length;
        return respond(requestId, { type, faqs: harnessFaqs.filter((faq) => faq.taskId === payload.taskId) });
      }
      case "task.faq.remove": {
        harnessLog(`task.faq.remove ${String(payload.taskId)} ${String(payload.faqId)}`);
        const index = harnessFaqs.findIndex((faq) => faq.taskId === payload.taskId && faq.faqId === payload.faqId);
        if (index >= 0) harnessFaqs.splice(index, 1);
        const owner = tasks.find((candidate) => candidate.taskId === payload.taskId);
        if (owner) owner.faqCount = harnessFaqs.filter((faq) => faq.taskId === payload.taskId).length;
        return respond(requestId, { type, faqs: harnessFaqs.filter((faq) => faq.taskId === payload.taskId) });
      }
      case "task.createFromRecipe": {
        const recipe = harnessRecipes.find((candidate) => candidate.recipeId === payload.recipeId);
        if (!recipe) return respondError(requestId, "unknown recipe");
        harnessLog(`task.createFromRecipe ${String(payload.recipeId)} title=${String(payload.title)}`);
        const stamp = new Date().toISOString();
        const taskId = `t-recipe-${String(tasks.length + 1)}`;
        const idByKey = new Map();
        const subtasks = recipe.subtasks.map((step, index) => {
          const subtaskId = `${taskId}-st-${String(index + 1)}`;
          idByKey.set(step.key, subtaskId);
          return {
            subtaskId,
            taskId,
            title: step.title,
            ...(step.prompt ? { prompt: step.prompt.replaceAll("{title}", payload.title) } : {}),
            autoStart: step.autoStart === true,
            origin: "manual",
            columnId: boardColumns.find((c) => c.category === "backlog")?.columnId ?? "col-backlog",
            sortOrder: index,
            createdAt: stamp,
            updatedAt: stamp,
            isBlocked: false,
            dependsOn: [],
            isRunning: false,
            linkedSessionIds: [],
            ...(step.seedMode ? { seedMode: step.seedMode } : {}),
            ...(step.model ? { model: step.model } : {})
          };
        });
        for (const step of recipe.subtasks) {
          const to = subtasks.find((s) => s.subtaskId === idByKey.get(step.key));
          for (const fromKey of step.dependsOnKeys ?? []) {
            const fromId = idByKey.get(fromKey);
            if (to && fromId) to.dependsOn.push(fromId);
          }
        }
        const task = {
          taskId,
          title: payload.title,
          description: `Created from recipe "${recipe.name}".`,
          state: "todo",
          columnId: boardColumns.find((c) => c.category === "backlog")?.columnId ?? "col-backlog",
          linkedWorkspaceSetIds: [],
          linkedSessionIds: [],
          createdAt: stamp,
          updatedAt: stamp,
          subtasks
        };
        tasks.push(task);
        recomputeBlocked(task);
        push({ type: "board.changed" });
        return respond(requestId, { type, task });
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
        if (payload.seedMode !== undefined) subtask.seedMode = payload.seedMode; // ADR 0014
        if (payload.verified !== undefined) { // ADR 0007
          harnessLog(`subtask.update ${String(payload.subtaskId)} verified=${String(payload.verified)}`);
          if (payload.verified) delete subtask.verifyUnmet; else subtask.verifyUnmet = true;
        }
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
      case "agents.state": {
        // Fleet snapshot (agents.html, UX overhaul P5): assembled from the same
        // session/task/question/access fixtures the sidebar uses, mirroring
        // the host's grouping - task links plus a grafted role child under
        // s-live; every unlinked session lands in the orphan drawer. The flat
        // list reads `sessionLines` (one activity/result line per session, plus
        // the landable flag) exactly as the host derives them.
        const fleetLive = new Set(["s-live", "s-waiting", "s-clone"]);
        const decorate = (session) => ({ ...session, live: fleetLive.has(session.sessionId) });
        const roleChild = {
          sessionId: "s-role-reviewer", title: "a11y reviewer", status: "active", providerId: "codex", model: "gpt-5.5",
          transport: "codex-app-server", parentSessionId: "s-live", spawnedRole: "reviewer", live: true,
          createdAt: iso(20), updatedAt: iso(1),
          agentActivity: { running: 0, failed: 0, root: { nodeId: "root", label: "agent", status: "running", startedAt: iso(20), lastActivityAt: iso(1), lastActivity: "reading src/tour badges", lastCommand: "Read", toolUses: 12 } }
        };
        const bySession = new Map(sessions.map((session) => [session.sessionId, session]));
        const grouped = new Set();
        const groups = [];
        for (const task of tasks) {
          const members = task.linkedSessionIds
            .filter((sessionId) => bySession.has(sessionId))
            .map((sessionId) => { grouped.add(sessionId); return decorate(bySession.get(sessionId)); });
          if (task.taskId === "t-1") members.push(roleChild);
          if (members.length === 0) continue;
          const column = boardColumns.find((candidate) => candidate.columnId === task.columnId);
          groups.push({ task, ...(column ? { columnName: column.name, columnCategory: column.category } : {}), sessions: members });
        }
        const orphanSessions = sessions.filter((session) => !grouped.has(session.sessionId)).map(decorate);
        const pendingQuestions = agentQuestions.filter((question) => question.status === "pending");
        const pendingAccess = workspacePolicy.accessRequests.filter((request_) => request_.status === "pending");
        // Same order as the host's fleetActivityLine: question → posture →
        // command → output → stored phrase; result lines price the changeset.
        const sessionLines = [...groups.flatMap((group) => group.sessions), ...orphanSessions].map((session) => {
          const question = pendingQuestions.find((entry) => entry.sessionId === session.sessionId);
          const root = session.agentActivity?.root;
          const changes = harnessLanding.filter((item) => item.sessionId === session.sessionId)
            .flatMap((item) => item.repos);
          const files = changes.reduce((sum, repo) => sum + repo.fileCount, 0);
          const repos = new Set(changes.map((repo) => repo.repoName)).size;
          const activityLine = question ? `? ${question.question}`
            : pendingAccess.some((entry) => entry.sessionId === session.sessionId) ? "? waiting on a workspace access decision"
            : session.runningElsewhere ? "running in another window - view only"
            : session.status === "starting" ? "resuming - recreating the runtime and clones"
            : root?.lastCommand ? `$ ${root.lastCommand}`
            : root?.lastActivity ? root.lastActivity
            : session.description ? session.description
            : session.status === "failed" ? "the last turn failed"
            : session.status === "ended" ? undefined
            : session.live ? "no activity this turn yet" : "not running - open the chat to resume";
          const settled = session.status === "ended" || session.status === "failed";
          const resultLine = !settled ? undefined
            : files > 0 ? `${files} file${files === 1 ? "" : "s"} changed${repos > 1 ? ` across ${repos} repos` : ""} - not landed`
            : root?.lastActivity ?? (session.status === "failed" ? "the last turn failed" : "ended with nothing reported");
          return {
            sessionId: session.sessionId,
            ...(activityLine === undefined ? {} : { activityLine }),
            ...(resultLine === undefined ? {} : { resultLine }),
            ...(files > 0 ? { landable: true } : {})
          };
        });
        return respond(requestId, { type, state: {
          generatedAt: new Date().toISOString(),
          groups,
          orphanSessions,
          questions: pendingQuestions,
          accessRequests: pendingAccess,
          agentIdleThresholdMs: 5 * 60_000,
          ...(harnessLanding.length === 0 ? {} : { landing: harnessLanding }),
          sessionLines
        } });
      }
      case "agents.landSession": {
        harnessLog(`agents.landSession ${String(payload.sessionId)}`);
        const index = harnessLanding.findIndex((item) => item.sessionId === payload.sessionId);
        if (index >= 0) harnessLanding.splice(index, 1);
        setTimeout(() => push({ type: "agents.changed" }), 150);
        return respond(requestId, { type, message: "Pulled 4 files" });
      }
      case "agents.openSession":
        harnessLog(`agents.openSession ${String(payload.sessionId)}${payload.nodeId ? ` node=${String(payload.nodeId)}` : ""}`);
        return respond(requestId, { type, accepted: true });
      case "chat.rawStream": {
        // Expand-in-place (agents.html) + the chat tab's raw-stream disclosure:
        // a deterministic captured stream, newest last. s-ended captured none.
        harnessLog(`chat.rawStream ${String(payload.sessionId)}`);
        const captured = payload.sessionId === "s-ended" ? "" : [
          "{\"type\":\"session.configured\",\"model\":\"gpt-5.5\"}",
          "{\"type\":\"agent.text\",\"text\":\"Reading publish_hooks.py\"}",
          "{\"type\":\"agent.command\",\"command\":[\"grep\",\"-R\",\"ALLOWED\",\"src\"],\"status\":\"started\"}",
          "{\"type\":\"agent.command\",\"status\":\"completed\",\"exitCode\":0}",
          "{\"type\":\"agent.file_edit\",\"path\":\"exporters/alembic.py\",\"changeKind\":\"modify\"}",
          "{\"type\":\"agent.text\",\"text\":\"wiring exporter registry\"}"
        ].join("\n");
        return respond(requestId, { type, text: captured, lastChunkAt: iso(1) });
      }
      case "runtime.openTerminal":
        // Real host: a VS Code terminal into the session's container. In the
        // browser there is no terminal - the log line is the observable effect.
        harnessLog(`runtime.openTerminal ${String(payload.sessionId)}`);
        return respond(requestId, { type, accepted: true });
      case "agents.open":
        harnessLog("agents.open");
        return respond(requestId, { type, accepted: true });
      case "taskBoard.open":
        // The Task Board panel + command exist, so the relay succeeds (in the
        // browser harness there is no editor area to reveal - the log line is
        // the observable effect).
        harnessLog(`taskBoard.open`);
        return respond(requestId, { type, accepted: true });
      case "memory.list": return respond(requestId, { type, candidates: memoryCandidates, detectedTags });
      case "memory.resolve": {
        const candidate = memoryCandidates.find((entry) => entry.memoryCandidateId === payload.memoryCandidateId);
        if (!candidate) return respondError(requestId, "unknown candidate");
        if (payload.approve && payload.edits) {
          harnessLog(`memory.resolve edits scope=${String(payload.edits.scope)} tags=${(payload.edits.tags ?? []).join(",")}`);
          if (payload.edits.content) candidate.content = payload.edits.content;
          if (payload.edits.scope) candidate.scope = payload.edits.scope;
          if (payload.edits.tags) candidate.tags = payload.edits.tags;
        }
        candidate.status = payload.approve ? "approved" : "rejected";
        return respond(requestId, { type, candidate });
      }
      case "memory.add": {
        memorySerial += 1;
        const candidate = {
          memoryCandidateId: `m-${memorySerial}`,
          sessionId: "user",
          content: payload.content,
          status: "approved",
          createdAt: new Date().toISOString(),
          scope: payload.scope,
          ...(payload.scope === "workspace" ? { scopeLabel: "asset_api" } : {}),
          ...(payload.scope === "task" ? { scopeLabel: "Alembic publish support" } : {}),
          tags: payload.tags ?? [],
          origin: "user"
        };
        memoryCandidates.unshift(candidate);
        harnessLog(`memory.add scope=${payload.scope} tags=${(payload.tags ?? []).join(",")}`);
        return respond(requestId, { type, candidate });
      }
      case "memory.delete": {
        const index = memoryCandidates.findIndex((entry) => entry.memoryCandidateId === payload.memoryCandidateId);
        if (index !== -1) memoryCandidates.splice(index, 1);
        harnessLog(`memory.delete ${String(payload.memoryCandidateId)}`);
        return respond(requestId, { type, memoryCandidateId: payload.memoryCandidateId });
      }
      case "memory.open":
        // Log the send so a visual check can assert the Memories "Open" row wiring.
        harnessLog(`memory.open ${String(payload.memoryCandidateId)}`);
        return respond(requestId, { type, accepted: true });
      case "config.state":
        return respond(requestId, { type, state: configState(payload.scope) });
      case "config.setSetting": {
        const setting = configSettings.find((entry) => entry.key === payload.key);
        if (!setting) return respondError(requestId, `unknown setting ${String(payload.key)}`);
        setting.value = payload.value;
        harnessLog(`config.setSetting ${String(payload.key)}`);
        return respond(requestId, { type, ok: true });
      }
      case "config.mcpToggle": {
        const server = mcpServers.find((entry) => entry.serverId === payload.serverId);
        if (!server) return respondError(requestId, "unknown server");
        server.enabledByDefault = payload.enabled;
        harnessLog(`config.mcpToggle ${String(payload.serverId)} ${payload.enabled ? "on" : "off"}`);
        return respond(requestId, { type, servers: configState("global").mcp });
      }
      case "config.mcpAdd": {
        mcpSerial += 1;
        mcpServers.push({
          serverId: `mcp-${String(mcpSerial + 1)}`, name: payload.name, command: payload.command,
          args: payload.args, envKeys: [], enabledByDefault: true, sensitive: false, source: "registry"
        });
        harnessLog(`config.mcpAdd ${payload.name}`);
        return respond(requestId, { type, servers: configState("global").mcp });
      }
      case "config.provider.signIn":
        harnessLog(`config.provider.signIn ${String(payload.providerId)}`);
        return respond(requestId, { type, providerId: payload.providerId, launched: "sbx run claude", mode: "terminal" });
      case "config.provider.setDefaultModel": {
        if (payload.model === "") delete configDefaultModels[payload.providerId];
        else configDefaultModels[payload.providerId] = payload.model;
        harnessLog(`config.provider.setDefaultModel ${String(payload.providerId)} ${String(payload.model)}`);
        return respond(requestId, { type, providerId: payload.providerId, model: payload.model });
      }
      case "config.openFile":
        harnessLog(`config.openFile ${String(payload.path)}`);
        return respond(requestId, { type, opened: true });
      case "mcp.list": return respond(requestId, { type, servers: mcpServers, overrides: mcpOverrides });
      case "mcp.save": {
        const draft = payload.server;
        const existing = draft.serverId ? mcpServers.find((entry) => entry.serverId === draft.serverId) : undefined;
        if (existing) {
          Object.assign(existing, {
            name: draft.name, command: draft.command, args: draft.args,
            enabledByDefault: draft.enabledByDefault, sensitive: draft.sensitive,
            ...(draft.notes === undefined ? {} : { notes: draft.notes }),
            ...(draft.env === undefined ? {} : { envKeys: Object.keys(draft.env) })
          });
        } else {
          mcpSerial += 1;
          mcpServers.push({
            serverId: `mcp-${String(mcpSerial + 1)}`, name: draft.name, command: draft.command, args: draft.args,
            envKeys: Object.keys(draft.env ?? {}), enabledByDefault: draft.enabledByDefault,
            sensitive: draft.sensitive, ...(draft.notes === undefined ? {} : { notes: draft.notes }), source: "registry"
          });
        }
        harnessLog(`mcp.save ${draft.name}`);
        return respond(requestId, { type, servers: mcpServers });
      }
      case "mcp.delete": {
        const index = mcpServers.findIndex((entry) => entry.serverId === payload.serverId);
        if (index !== -1) mcpServers.splice(index, 1);
        harnessLog(`mcp.delete ${String(payload.serverId)}`);
        return respond(requestId, { type, servers: mcpServers });
      }
      case "mcp.setOverride": {
        const index = mcpOverrides.findIndex((entry) =>
          entry.scope === payload.scope && entry.refId === payload.refId && entry.serverId === payload.serverId);
        if (payload.state === "inherit") {
          if (index !== -1) mcpOverrides.splice(index, 1);
        } else if (index === -1) {
          mcpOverrides.push({ scope: payload.scope, refId: payload.refId, serverId: payload.serverId, state: payload.state });
        } else {
          mcpOverrides[index].state = payload.state;
        }
        harnessLog(`mcp.setOverride ${payload.scope}/${payload.refId} ${payload.serverId}=${payload.state}`);
        return respond(requestId, { type, overrides: mcpOverrides });
      }
      case "chat.contextDebug":
        harnessLog(`chat.contextDebug ${String(payload.sessionId)}`);
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
      case "preview.list":
        harnessLog(`preview.list ${String(payload.sessionId)}`);
        return respond(requestId, { type, previews: previewFixtures.filter((p) => p.sessionId === payload.sessionId) });
      case "terminal.attach":
        harnessLog(`terminal.attach ${String(payload.sessionId)}`);
        return respond(requestId, { type, accepted: true });
      case "preview.open":
        harnessLog(`preview.open ${String(payload.previewId)}${payload.external ? " external" : ""}`);
        return respond(requestId, { type, accepted: true });
      case "preview.stop": {
        const stopped = previewFixtures.find((p) => p.previewId === payload.previewId);
        previewFixtures = previewFixtures.filter((p) => p.previewId !== payload.previewId);
        harnessLog(`preview.stop ${String(payload.previewId)}`);
        return respond(requestId, { type, previews: previewFixtures.filter((p) => p.sessionId === (stopped ? stopped.sessionId : "")) });
      }
      case "chat.uploadAttachment": {
        const bytes = Math.ceil((payload.dataBase64.length * 3) / 4);
        harnessLog(`chat.uploadAttachment ${String(payload.sessionId)} ${String(payload.name)} ${String(bytes)}B`);
        return respond(requestId, {
          type,
          runtimePath: `/workspace/attachments/${String(payload.name)}`,
          name: payload.name,
          bytes
        });
      }
      case "clone.exportPatch": {
        harnessLog(`clone.exportPatch ${String(payload.sessionId)}${payload.repo ? ` ${String(payload.repo)}` : ""}`);
        return respond(requestId, {
          type,
          savedPaths: ["C:\\exports\\asset_api-2026-07-16.patch"],
          message: "Exported 1 patch file: C:\\exports\\asset_api-2026-07-16.patch"
        });
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
      case "codeReview.open":
        harnessLog(`codeReview.open ${String(payload.taskId)}`);
        return respond(requestId, { type, accepted: true });
      case "codeReview.state":
        return respond(requestId, { type, state: computeCodeReviewState(payload.scope) });
      case "codeReview.fileDiff":
        return respond(requestId, {
          type,
          repo: payload.repo,
          path: payload.path,
          diff: computeCodeReviewDiff(payload.repo, payload.path, payload.ignoreWhitespace === true)
        });
      case "codeReview.addNote": {
        const created = [];
        for (const anchor of payload.anchors) {
          const owner = anchor.sessionId && taskReviewComments[anchor.sessionId] ? anchor.sessionId : "s-live";
          const comment = {
            commentId: `crc-${String(Date.now())}-${String(created.length)}`,
            filePath: `${anchor.repo}:${anchor.path}`,
            startLine: anchor.startLine,
            endLine: anchor.endLine,
            body: payload.body,
            author: "user",
            status: "open",
            createdAt: new Date().toISOString()
          };
          taskReviewComments[owner].push(comment);
          created.push(comment);
        }
        harnessLog(`codeReview.addNote anchors=${String(payload.anchors.length)} scope=${String(payload.scope)}`);
        return respond(requestId, { type, comments: created });
      }
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
      case "planner.subtaskCandidates": {
        const docs = (plannerArtifacts[payload.planId] ?? []).filter((artifact) => artifact.kind === "document" && typeof artifact.content === "string");
        const candidates = [];
        for (const doc of docs) {
          for (const match of doc.content.matchAll(/^\s*(?:[-*+]|\d+[.)])\s*\[[ xX]\]\s+(.+?)\s*$/gm)) {
            if (!candidates.includes(match[1])) candidates.push(match[1]);
          }
        }
        const plan = plannerPlans.find((candidate) => candidate.planId === payload.planId);
        const owner = tasks.find((candidate) => candidate.taskId === plan?.taskId);
        harnessLog(`planner.subtaskCandidates ${String(payload.planId)} n=${String(candidates.length)}`);
        return respond(requestId, {
          type,
          candidates,
          ...(owner ? { taskId: owner.taskId, taskTitle: owner.title } : {})
        });
      }
      case "planner.materializeSubtasks": {
        const plan = plannerPlans.find((candidate) => candidate.planId === payload.planId);
        const owner = tasks.find((candidate) => candidate.taskId === plan?.taskId);
        if (!owner) return respondError(requestId, "This plan has no owning task - pick one in the plan intake first.");
        harnessLog(`planner.materializeSubtasks ${String(payload.planId)} n=${String(payload.titles.length)}`);
        const stamp = new Date().toISOString();
        for (const title of payload.titles) {
          owner.subtasks.push({
            subtaskId: `st-plan-${String(owner.subtasks.length + 1)}`, taskId: owner.taskId, title,
            prompt: `From the plan: ${title}`, autoStart: false, origin: "manual",
            columnId: "col-backlog", sortOrder: owner.subtasks.length, createdAt: stamp, updatedAt: stamp,
            isBlocked: false, dependsOn: [], isRunning: false, linkedSessionIds: []
          });
        }
        push({ type: "board.changed" });
        return respond(requestId, { type, createdCount: payload.titles.length, taskId: owner.taskId });
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
      // --- Task Hub (UX overhaul P3 + ADR 0022 F6) -----------------------
      case "active.get":
        return respond(requestId, { type, activeTaskId });
      case "active.set":
        activeTaskId = payload.taskId ?? null;
        harnessLog(`active.set ${String(activeTaskId)}`);
        push({ type: "activeTask", activeTaskId });
        return respond(requestId, { type, activeTaskId });
      case "hub.state": {
        const state = hubState(payload.taskId);
        if (!state) return respondError(requestId, `harness: unknown task ${String(payload.taskId)}`);
        return respond(requestId, { type, state });
      }
      case "panel.openSurface":
        harnessLog(`panel.openSurface ${String(payload.surface)}${payload.taskId ? ` ${String(payload.taskId)}` : ""}`);
        return respond(requestId, { type, accepted: true });
      case "ui.confirm":
        harnessLog(`ui.confirm ${String(payload.message)}`);
        return respond(requestId, { type, confirmed: true });

      // --- validation runtimes: the TD registry (ADR 0022 M7) ------------
      case "config.validation.state":
        return respond(requestId, { type, state: validationState() });
      case "config.validation.createRuntime": {
        validationRuntimeSerial += 1;
        const slug = String(payload.displayName).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        validationRuntimes.push({
          runtimeId: `vr-${String(validationRuntimeSerial)}`,
          displayName: payload.displayName,
          image: payload.image,
          lifecycle: payload.lifecycle,
          capabilities: payload.capabilities ?? [],
          policyProfileRef: payload.policyProfileRef,
          ...(payload.profileException ? { profileException: true } : {}),
          isDefault: false,
          vmName: `drydock-validation-${slug}`,
          ...(payload.connection ? { connectionHost: payload.connection.host } : {}),
          availability: "stopped",
          queueDepth: 0
        });
        harnessLog(`config.validation.createRuntime ${String(payload.displayName)}${payload.profileException ? " (profile exception)" : ""}`);
        pushValidationChanged();
        return respond(requestId, { type: "config.validation.ack" });
      }
      case "config.validation.updateRuntime": {
        const runtime = validationRuntimes.find((entry) => entry.runtimeId === payload.runtimeId);
        if (!runtime) return respondError(requestId, "harness: unknown runtime");
        Object.assign(runtime, payload.update);
        if (payload.update.connection === null) delete runtime.connectionHost;
        else if (payload.update.connection) runtime.connectionHost = payload.update.connection.host;
        harnessLog(`config.validation.updateRuntime ${String(payload.runtimeId)} ${Object.keys(payload.update).join(",")}`);
        pushValidationChanged();
        return respond(requestId, { type: "config.validation.ack" });
      }
      case "config.validation.deleteRuntime": {
        const index = validationRuntimes.findIndex((entry) => entry.runtimeId === payload.runtimeId);
        if (index === -1) return respondError(requestId, "harness: unknown runtime");
        validationRuntimes.splice(index, 1);
        // H5: associations never dangle - they land on the named target (or
        // fall back to the default, which is what an absent reassignTo means).
        for (let i = validationAssociations.length - 1; i >= 0; i -= 1) {
          if (validationAssociations[i].runtimeId !== payload.runtimeId) continue;
          if (payload.reassignTo) validationAssociations[i].runtimeId = payload.reassignTo;
          else validationAssociations.splice(i, 1);
        }
        removeQuarantine(payload.runtimeId);
        harnessLog(`config.validation.deleteRuntime ${String(payload.runtimeId)}${payload.reassignTo ? ` → ${String(payload.reassignTo)}` : " → default"}`);
        pushValidationChanged();
        return respond(requestId, { type: "config.validation.ack" });
      }
      case "config.validation.setDefault": {
        const runtime = validationRuntimes.find((entry) => entry.runtimeId === payload.runtimeId);
        if (!runtime) return respondError(requestId, "harness: unknown runtime");
        for (const entry of validationRuntimes) entry.isDefault = entry.runtimeId === payload.runtimeId;
        validationSettings.defaultRuntimeId = payload.runtimeId;
        harnessLog(`config.validation.setDefault ${String(payload.runtimeId)}`);
        pushValidationChanged();
        return respond(requestId, { type: "config.validation.ack" });
      }
      case "config.validation.setSettings": {
        if (payload.topologyPreset !== undefined) validationSettings.topologyPreset = payload.topologyPreset;
        if (payload.warmCap === null) delete validationSettings.warmCap;
        else if (payload.warmCap !== undefined) validationSettings.warmCap = payload.warmCap;
        harnessLog(`config.validation.setSettings ${JSON.stringify({ topologyPreset: payload.topologyPreset, warmCap: payload.warmCap })}`);
        pushValidationChanged();
        return respond(requestId, { type: "config.validation.ack" });
      }
      case "config.validation.setAssociation": {
        const existing = validationAssociations.find((entry) => entry.projectRootId === payload.projectRootId);
        const project = validationProjects.find((entry) => entry.projectRootId === payload.projectRootId);
        if (existing) existing.runtimeId = payload.runtimeId;
        else {
          validationAssociations.push({
            projectRootId: payload.projectRootId,
            projectLabel: project ? project.label : payload.projectRootId,
            runtimeId: payload.runtimeId,
            source: "personal"
          });
        }
        harnessLog(`config.validation.setAssociation ${String(payload.projectRootId)} → ${String(payload.runtimeId)}`);
        pushValidationChanged();
        return respond(requestId, { type: "config.validation.ack" });
      }
      case "config.validation.clearAssociation": {
        const index = validationAssociations.findIndex((entry) => entry.projectRootId === payload.projectRootId);
        if (index !== -1) validationAssociations.splice(index, 1);
        harnessLog(`config.validation.clearAssociation ${String(payload.projectRootId)}`);
        pushValidationChanged();
        return respond(requestId, { type: "config.validation.ack" });
      }
      case "config.validation.runProbes": {
        const runtime = validationRuntimes.find((entry) => entry.runtimeId === payload.runtimeId);
        if (!runtime) return respondError(requestId, "harness: unknown runtime");
        harnessLog(`config.validation.runProbes ${String(payload.runtimeId)}`);
        pushValidationChanged();
        return respond(requestId, { type: "config.validation.ack" });
      }
      case "config.validation.adopt":
        harnessLog(`config.validation.adopt ${String(payload.runtimeId)}`);
        pushValidationChanged();
        return respond(requestId, { type: "config.validation.ack" });
      case "config.validation.revertReprobe": {
        const runtime = validationRuntimes.find((entry) => entry.runtimeId === payload.runtimeId);
        if (!runtime) return respondError(requestId, "harness: unknown runtime");
        // The quarantine clears only because the re-probe passed - that is the
        // whole point of the button.
        const at = new Date().toISOString();
        runtime.availability = "available";
        runtime.probes = {
          state: "pass", at, greenAt: at,
          lines: (runtime.probes ? runtime.probes.lines : []).map((line) => ({
            ...line,
            state: "pass",
            detail: line.probeId === "prod-isolation" ? "read refused after revert to clean baseline" : line.detail
          }))
        };
        removeQuarantine(payload.runtimeId);
        harnessLog(`config.validation.revertReprobe ${String(payload.runtimeId)}`);
        pushValidationChanged();
        return respond(requestId, { type: "config.validation.ack" });
      }

      // --- validation jobs: what developers actually touch ---------------
      case "validation.jobs": {
        const jobs = validationJobs.filter((job) => {
          if (payload.sessionId && job.sessionId !== payload.sessionId) return false;
          if (payload.taskId && job.taskId !== payload.taskId) return false;
          return true;
        });
        return respond(requestId, { type, jobs });
      }
      case "validation.abortJob": {
        const job = validationJobs.find((entry) => entry.jobId === payload.jobId);
        if (!job) return respondError(requestId, "harness: unknown job");
        job.state = "aborted";
        job.completedAt = new Date().toISOString();
        harnessLog(`validation.abortJob ${String(payload.jobId)}`);
        push({ type: "validation.jobChanged", jobId: job.jobId, state: job.state, sessionId: job.sessionId, taskId: job.taskId });
        return respond(requestId, { type: "validation.ack" });
      }
      case "validation.requeue": {
        const job = validationJobs.find((entry) => entry.jobId === payload.jobId);
        if (!job) return respondError(requestId, "harness: unknown job");
        harnessLog(`validation.requeue ${String(payload.jobId)} → ${String(payload.rerouteTo ?? "default")}${payload.confirmedDelta ? " (confirmed)" : ""}`);
        if (!payload.confirmedDelta) {
          // Cross-profile in BOTH directions needs the delta confirm (H1/H2).
          return respond(requestId, {
            type, result: {
              kind: "needs-confirm",
              toRuntimeId: "vr-default",
              toDisplayName: "default",
              delta: {
                profileChanged: true,
                fromProfile: "validation.production",
                toProfile: "validation.default",
                imageChanged: true,
                capabilitiesAdded: ["python"],
                capabilitiesRemoved: ["fixtures:ShowA_approved"],
                profileException: false
              }
            }
          });
        }
        job.state = "queued";
        job.queuePosition = 1;
        job.runtimeDisplayName = "default";
        delete job.parkedReason;
        push({ type: "validation.jobChanged", jobId: job.jobId, state: job.state, sessionId: job.sessionId, taskId: job.taskId });
        return respond(requestId, { type, result: { kind: "queued" } });
      }
      case "validation.setTaskRuntime": {
        hubValidationRuntimeId = payload.runtimeId ?? "vr-default";
        harnessLog(`validation.setTaskRuntime ${String(payload.taskId)} → ${String(payload.runtimeId ?? "default")}`);
        pushValidationChanged();
        return respond(requestId, { type: "validation.ack" });
      }
      case "validation.railStatus":
        return respond(requestId, { type, ...validationRailStatus() });
      case "validation.run": {
        const job = {
          jobId: `vj-manual-${String(validationJobs.length + 1)}`, state: "queued", queuePosition: 1,
          runtimeDisplayName: "default", queuedAt: new Date().toISOString(), sessionId: payload.sessionId, taskId: "t-1"
        };
        validationJobs.push(job);
        harnessLog(`validation.run ${String(payload.sessionId)}`);
        push({ type: "validation.jobChanged", jobId: job.jobId, state: job.state, sessionId: job.sessionId, taskId: job.taskId });
        return respond(requestId, { type: "validation.ack" });
      }

      default:
        return respondError(requestId, `harness: unhandled request ${String(type)}`);
    }
  }

  // --- Task Hub fixture (UX overhaul P3 + ADR 0022 F6) ---------------------
  // The hub reads ONE composite; everything below is derived from the same
  // session/task/runtime fixtures the other pages use, so the pages agree.
  let activeTaskId = "t-1";
  /** The task's validation override; the label shows only when ≠ the default. */
  let hubValidationRuntimeId = "vr-prod";
  function hubState(taskId) {
    const task = tasks.find((entry) => entry.taskId === taskId);
    if (!task) return undefined;
    const linked = new Set(task.linkedSessionIds);
    for (const subtask of task.subtasks) {
      for (const sessionId of subtask.linkedSessionIds) linked.add(sessionId);
    }
    const chats = sessions.filter((session) => linked.has(session.sessionId)).map((session) => ({
      sessionId: session.sessionId,
      title: session.title,
      taskId: task.taskId,
      taskTitle: task.title,
      status: session.status,
      live: session.status === "active",
      ...(session.runningElsewhere ? { runningElsewhere: true } : {}),
      needsAttention: agentQuestions.some((question) => question.sessionId === session.sessionId && question.status === "pending"),
      lastActivityAt: session.updatedAt,
      providerId: session.providerId,
      ...(session.model === undefined ? {} : { model: session.model })
    }));
    const runtime = validationRuntimes.find((entry) => entry.runtimeId === hubValidationRuntimeId);
    const routesToDefault = runtime === undefined || runtime.isDefault === true;
    return {
      task,
      chats,
      subtasks: task.subtasks,
      plans: plannerPlans.filter((plan) => plan.taskId === task.taskId).map(plannerPlanSummary),
      attention: agentQuestions
        .filter((question) => question.status === "pending" && linked.has(question.sessionId))
        .map((question) => ({ kind: "question", sessionId: question.sessionId, headline: question.question })),
      stats: { runtimeCount: runtimes.length, cpuPercent: 18.4, memBytes: 9_878_000_000, tokens: 412_000 },
      system: {
        runtimes,
        mounts: ["rw C:\\hitl\\asset_api", "ro C:\\hitl\\demo-project"],
        launchCommand: "sbx create --image drydock/agent:gen1 --mount C:\\hitl\\asset_api"
      },
      workspaceName: "pipeline",
      ...(routesToDefault ? {} : { validationRuntimeLabel: runtime.displayName }),
      validationRuntimes: validationRuntimes
        .filter((entry) => entry.archived !== true)
        .map((entry) => ({ runtimeId: entry.runtimeId, displayName: entry.displayName })),
      generatedAt: new Date().toISOString()
    };
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
    "- Phase 1 - provider spike and library choice",
    "- Phase 2 - migrate sessions and cut over cookies",
    "- Phase 3 - rollout with kill switch",
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
      { artifactId: "plart-test", relPath: "testing/test-plan.md", kind: "document", aspectId: "testing", title: "Test Plan", baseTitle: "Test Plan", revision: 1, scriptsEnabled: false, collectedAt: iso(9), content: "# Test Plan\n\n## Unit\n\n- [ ] Cover the allowlist edge cases\n- [ ] Port the session-store fixtures\n\n## Live\n\n- [x] Login flow against the spike provider" }
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
    fixtures: { sessions, catalogs, workspacePolicy, diffChanges, cloneRepos, tasks, boardColumns, memoryCandidates, taskReviewProjects, taskReviewSessions, taskReviewComments, planner: { plans: plannerPlans, artifacts: plannerArtifacts, annotations: plannerAnnotations, aspects: plannerAspects }, validation: { flags: validationFlags, runtimes: validationRuntimes, associations: validationAssociations, projects: validationProjects, settings: validationSettings, managed: validationManaged, quarantines: validationQuarantines, jobs: validationJobs }, comments: [
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
        push({ type: "chat.event", sessionId, line: { sequence: base + 2, eventType: "agent.text", summary: "Working on it - ", createdAt: new Date().toISOString(), final: false } });
        setTimeout(() => {
          push({ type: "chat.event", sessionId, line: { sequence: base + 3, eventType: "agent.text", summary: "Working on it - done.\n\n- item one\n- item two", createdAt: new Date().toISOString(), final: true } });
          push({ type: "chat.turnCompleted", sessionId, runId: "run-x", status: "completed" });
        }, 400);
      },
      /** Fires the attention push for the waiting session (badge/marker test). */
      attention(sessionId, reasons) {
        push({ type: "session.attention", sessionId, reasons });
      },
      /** Agents panel: live activity tick on s-live (durations/counters move). */
      agentsTick() {
        push({ type: "session.agentActivity", sessionId: "s-live", activity: {
          running: 2, failed: 0,
          agents: [
            { nodeId: "task-audit", label: "Audit publish hooks", status: "running", startedAt: iso(13), lastActivityAt: new Date().toISOString(), lastActivity: "grep allowlist_v2", lastCommand: "grep", toolUses: 31, tokens: 261000 },
            { nodeId: "task-exporter", label: "Patch alembic exporter", status: "running", startedAt: iso(3), lastActivityAt: new Date().toISOString(), lastActivity: "edit exporters/alembic.py", lastCommand: "Edit", toolUses: 55, tokens: 61200 }
          ],
          root: { nodeId: "root", label: "agent", status: "running", startedAt: iso(14), lastActivityAt: new Date().toISOString(), lastActivity: "running exporter tests", lastCommand: "pytest", toolUses: 99, tokens: 415000 }
        } });
      },
      /** Agents panel: end s-live's turn ("completed" | "failed" | "cancelled"). */
      agentsTurnCompleted(status = "completed") {
        push({ type: "chat.turnCompleted", sessionId: "s-live", runId: "run-x", status });
      },
      /** Agents panel: coarse structural invalidation (webview refetches agents.state). */
      agentsChanged() {
        push({ type: "agents.changed" });
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
       * scribe completes and lister FAILS - mirroring the 2026-07-05 codex
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
        // Activity pushes mirror the real host's agentActivitySummaryOfTree:
        // full agents rows + the root item, never bare counts (the fleet's
        // subagent rows and pulse read them; the sidebar chip reads counts).
        const fanRoot = (activity) => ({ nodeId: "root", label: "agent", status: "running", startedAt: at(), lastActivityAt: at(), lastActivity: activity, lastCommand: "spawn", toolUses: 2 });
        const scribe = (status, extra) => ({ nodeId: "t-scribe", label: "scribe", status, startedAt: at(), lastActivityAt: at(), lastActivity: "writing haiku.txt", toolUses: 2, ...extra });
        const lister = (status, extra) => ({ nodeId: "t-lister", label: "lister", status, startedAt: at(), lastActivityAt: at(), lastActivity: "ls", lastCommand: "ls", toolUses: 1, ...extra });
        push({ type: "session.agentActivity", sessionId, activity: { running: 2, failed: 0, agents: [scribe("running"), lister("running")], root: fanRoot("delegating to two subagents") } });
        setTimeout(() => {
          line(5, { eventType: "agent.text", summary: "Writing the haiku now.", agentPath: ["t-scribe"] });
          line(6, { eventType: "agent.file_edit", summary: "add haiku.txt", filePath: "haiku.txt", fileChangeKind: "add", agentPath: ["t-scribe"] });
          line(7, { eventType: "agent.command", summary: "pwsh -Command ls [started]", toolStatus: "started", commandName: "ls", agentPath: ["t-lister"] });
          line(8, { eventType: "agent.command", summary: "pwsh -Command ls [failed exit -1]", toolStatus: "failed", commandName: "ls", detail: "CreateProcess failed: the sandbox refused pwsh.", agentPath: ["t-lister"] });
        }, 300);
        setTimeout(() => {
          line(9, { eventType: "agent.spawn", summary: "spawned counter", nodeId: "t-counter", label: "counter", subagentType: "general-purpose", nodeStatus: "running", agentPath: ["t-scribe"], detail: "Count the words in haiku.txt." });
          push({ type: "session.agentActivity", sessionId, activity: { running: 3, failed: 0, agents: [
            scribe("running"),
            lister("running"),
            { nodeId: "t-counter", parentNodeId: "t-scribe", label: "counter", status: "running", startedAt: at(), lastActivityAt: at(), lastActivity: "counting words", toolUses: 0 }
          ], root: fanRoot("waiting on subagents") } });
          line(10, { eventType: "agent.text", summary: "12 words.", agentPath: ["t-scribe", "t-counter"] });
          line(11, { eventType: "agent.node_done", summary: "subagent completed: 12 words.", nodeId: "t-counter", nodeStatus: "completed", detail: "12 words.", agentPath: ["t-scribe"] });
        }, 700);
        setTimeout(() => {
          line(12, { eventType: "agent.node_done", summary: "subagent completed: haiku written", nodeId: "t-scribe", nodeStatus: "completed", detail: "haiku written", usage: { totalTokens: 28192 } });
          line(13, { eventType: "agent.node_done", summary: "subagent failed: sandbox process failed", nodeId: "t-lister", nodeStatus: "failed", detail: "lister: unable to list directory; sandbox process failed." });
          push({ type: "session.agentActivity", sessionId, activity: { running: 0, failed: 1, agents: [
            scribe("completed", { endedAt: at(), tokens: 28192 }),
            lister("failed", { endedAt: at() }),
            { nodeId: "t-counter", parentNodeId: "t-scribe", label: "counter", status: "completed", startedAt: at(), endedAt: at(), lastActivity: "12 words.", toolUses: 0 }
          ], root: fanRoot("scribe finished; lister failed") } });
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
      /**
       * ADR 0022 F5: a must-fail isolation probe SUCCEEDED. Fires the incident
       * push every surface listens to (hub banner mounts; Configure refetches
       * and grows the banner + the amber nav dot).
       */
      validationQuarantine(runtimeId = "vr-prod") {
        const runtime = validationRuntimes.find((entry) => entry.runtimeId === runtimeId);
        const at = new Date().toISOString();
        const entry = {
          runtimeId,
          displayName: runtime ? runtime.displayName : runtimeId,
          probeId: "prod-isolation",
          detail: "production isolation check failed",
          at
        };
        if (runtime) {
          runtime.availability = "quarantined";
          runtime.probes = {
            state: "breach", at,
            ...(runtime.probes && runtime.probes.greenAt ? { greenAt: runtime.probes.greenAt } : {}),
            lines: [
              { probeId: "prod-isolation", title: "must-fail: read P:\\Projects", state: "breach", detail: "read SUCCEEDED - the guest reached a production path" }
            ]
          };
        }
        if (!validationQuarantines.some((existing) => existing.runtimeId === runtimeId)) validationQuarantines.push(entry);
        push({ type: "validation.quarantine", ...entry });
        pushValidationChanged();
        harnessLog(`scenario.validationQuarantine ${runtimeId}`);
      },
      /**
       * Steps `vj-step` queued → running → completed (a FAILED receipt, so the
       * chip's one promoted line - failing test + assertion - renders). Each
       * step pushes validation.jobChanged; nothing polls.
       */
      validationJobProgress(jobId = "vj-step") {
        const job = validationJobs.find((entry) => entry.jobId === jobId);
        if (!job) return;
        const bump = (state, extra = {}) => {
          job.state = state;
          Object.assign(job, extra);
          push({ type: "validation.jobChanged", jobId: job.jobId, state, sessionId: job.sessionId, taskId: job.taskId });
          harnessLog(`scenario.validationJobProgress ${jobId} → ${state}`);
        };
        delete job.queuePosition;
        bump("running", { startedAt: new Date().toISOString() });
        setTimeout(() => {
          bump("completed", {
            completedAt: new Date().toISOString(),
            receipt: {
              verdict: "failed",
              summary: "1 of 14 failed",
              failingTest: "test_icon_fallback",
              failingAssertion: "AssertionError: expected default set",
              changesetRef: "b71c04ee29aa31",
              mirrorVersion: 214,
              mirrorFreshnessAt: iso(2),
              probesGreenAt: iso(30),
              licenseWaitMs: 0,
              superseded: false,
              fixtureManifestHash: "9c41e2ab77d0"
            }
          });
        }, 1_200);
      },
      /** Fires the task-review refetch push for a task (turn-boundary simulation). */
      taskReviewUpdated(taskId) {
        push({ type: "taskReview.updated", taskId });
      },
      /**
       * Fires the coarse board.changed push (turn-completed / board mutation
       * simulation) - an open task-board panel refetches board.state. Mutate
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
