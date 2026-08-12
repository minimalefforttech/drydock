# UX overhaul — implementation plan

Direction approved 2026-08-02. Design: `docs/ideas/ux-overhaul-calm-workbench.md`
plus the annotated-mockup artifact linked there. This doc is the engineering
sequence: what gets built, where it hooks in, what it retires, how each phase
is verified. The old Control Panel kept working until the final phase.

**Status: P0–P7 all shipped.** The outcome is recorded in
`docs/adr/0020-calm-workbench-shell.md`; the per-phase notes below record where
the build deviated from this plan. This doc is now build history.

Approved defaults carried from the design's open calls (flag to reverse any):
awaiting-input outranks failed in roll-ups · secondary-sidebar placement is a
one-time best-effort move + hint · dual-run until P7 · per-stage boot events
get added · no subtask toggle in the composer (entry-point linkage +
post-first-turn affordance) · Configure writes machine-scope settings via the
settings API · names stay Task Hub / Agent View / Configure · single-folder
windows reload on workspace switch (prompt not suppressed) · landing drawer
demoted to per-row Land + toolbar overflow · quick chat ships (P4) ·
solo-mode guarantee is a hard rule (nothing hub-exclusive).

## Ground rules (every phase)

- Panel conventions per ADR 0006: vanilla TS, textContent-only, strict CSP,
  versioned messages through the single `parsePanelRequest` gate in
  `packages/contracts/src/webviewMessages.ts`.
- Every new webview bundle: pair in `tools/bundle-extension.mjs` AND the three
  `tools/package-vsix.mjs` lists (stagedFiles, stagedManifest.files,
  assertPackagedFiles).
- Durable state only in SQLite (`packages/storage-sqlite/src/migrations.ts`,
  forward-only `ensureTable`/`ensureColumn`). No globalState/workspaceState.
- Pushes ride the ProductEventBus (`packages/core/src/eventBus.ts`); webviews
  never poll except where today's stats polling already does.
- Each phase ends green: `tsc -b`, full test run, bundle + package-vsix
  strict pass, harness rows for new surfaces, fresh VSIX with a version bump.
- Solo-mode guarantee enforced from P1 on: any affordance added to the hub
  must already exist (or land in the same phase) via rail or chat surfaces.

## P0 — active-task spine (S) — SHIPPED

Shipped as planned.

New `ActiveTaskService` (packages/core): `get() / set(taskId|null) /`
subscribe via bus kind `active-task-changed`. Persistence: new `app_state`
key/value table (migration), key `activeTaskId`, restored on activation.

- Contracts: `active.get` / `active.set {taskId}` requests + an
  `active-task-changed` push translated by every provider that cares.
- Wire in `compositionRoot.ts`; expose on the backend object.
- `panel.showSession` flows in `controlPanelProvider.ts` /
  `agentsPanelProvider.ts` also `set()` the owning task so navigation and the
  spine can't disagree.
- Verify: unit round-trip + survives reload; two subscribers observe one set.

## P1 — left rail (L) — SHIPPED

Shipped as planned.

Three webview views in the existing `drydock` container (native sashes):
`drydock.tasks`, `drydock.recents`, `drydock.workspaces`. One shared bundle
(`rail.js`) mounted per-view via `body[data-view]`; three thin providers
sharing one message bridge (extract the reusable request handling from
`controlPanelProvider.ts` rather than duplicating it).

- Data: reuses existing `task.list` / `session.list` / `workspace.*`
  contracts. New `session.recents {limit}` — server-side dedupe: newest chat
  per task across task+subtask `linkedSessionIds`, ordered by last activity.
- New shared `rollupTaskStatus()` in contracts (awaiting › failed › running ›
  starting/queued › idle › done/offline) — also consumed later by hub and
  board so the dot language can't fork.
- Native chrome: view-title commands (`drydock.rail.newTask`, existing
  `drydock.taskBoard.open`, `drydock.agents.open`; Configure joins at P6) via
  `contributes.menus["view/title"]`; `WebviewView.badge` on Tasks = failed +
  awaiting count from the attention projection.
- Workspace-mismatch toast: normalized set-equality of task set roots vs
  `workspace.workspaceFolders`; `updateWorkspaceFolders` on switch;
  `tasks.dont_ask_workspace` column (migration) + reversal in the task ⋯
  menu; asked once per task per window session.
- Delete guard: workspace set (or root) mounted by a live session disables
  delete with the in-use task named.
- Old Tasks tab untouched.
- Verify: new harness page (cluster pin/unpin, fold, recents dedupe +
  promotion, badge counts, keyboard traversal, narrow width) + live VSIX.

## P2 — chat rail (M) — SHIPPED

Shipped as planned; the extracted chat handler turned out to be the whole
dispatch, so both hosts share `ControlPanelProvider.attachWebview` rather than
a narrower chat-only handler.

New activity-bar container `drydock-chat` + view `drydock.chatRail`, hosting
the shared chat components (`webview-ui/src/chat/*` + the chatTab view glue)
in a new `chatRail.js` bundle. Visual grammar matches the shipped Edit tab
(header row, workspace + raw-stream disclosure rows, files-changed tray,
model + effort selects); additions: faint task-attribution line → hub, the
back-chevron sets the spine.

- Refactor: extract chat message handling from `controlPanelProvider.ts` into
  a shared handler consumed by both the Edit tab (until P7) and the rail
  provider — one implementation, two hosts.
- Placement: on first activation try the internal move-view command into the
  secondary sidebar (try/catch best-effort); `app_state` flag so the hint
  toast shows once. User drag always wins.
- Routing: `panel.showSession` prefers the rail when it exists; Edit tab
  remains a working fallback during dual-run.
- Verify: existing chat harness scenarios re-run against the rail host
  (streaming, fan-out, attention cards, reconnect, provider switch) + live
  VSIX with a real boot.

## P3 — task hub (L) — SHIPPED

Deviation: Planner and Task Review follow the spine by *replacing* their
content in place (shared `panelFollow` helper) rather than re-opening; pin-to-
stay is native tab pinning as planned.

Singleton editor panel `drydock.taskHub` (provider + bundle pair), retargets
on `active-task-changed`; transient back-chip (one step) + `Alt+Left`
keybinding (`contributes.keybindings`).

- Composite `hub.state {taskId}` request assembled server-side from existing
  services: chats (task+subtask linked sessions), subtasks (`boardShared`
  summaries incl. queue/park/verify), plans (`planner.plans` by taskId),
  stats (`chat.runtimeStats` per running session + activity-summary tokens),
  system (per-task runtime rows, mounts line, launch-command disclosure, raw
  stream pointer), attention (questions + access requests filtered by task).
- Pushes: translate `board-changed`, `agents.changed`, question/access
  raised+resolved, `turn-completed`, `active-task-changed`.
- Row actions reuse existing contracts (`chat.*`, `task.update`,
  `subtask.update`, `planner.*`); attention rail deep-links via
  `panel.showSession`.
- Retarget choreography: tab title swap, content slide, back-chip; Planner /
  Task Review panels gain the same follow behavior behind a small shared
  helper (pin-to-stay via native tab pinning).
- Verify: hub harness page (retarget race with the pendingShow pattern,
  attention deep-link, empty / all-done / failed states) + live VSIX.

## P4 — new chat + quick chat (M) — SHIPPED

Deviation: quick chat takes its first prompt through a VS Code `InputBox`
rather than a webview composer - the command has no host to render into before
the session exists. The "Track as subtask" affordance shipped without session
linkage and was completed in P7 (`task.link` gained `subtaskId`).

Composer card inside the hub (component in the hub bundle):

- Prefills + provenance suffixes (task workspace set, last-used model from
  session history, title `<task> · chat <n>`); auto-rename keeps the existing
  first-turn sentinel behavior. Advanced fold: recipe (RecipeService), verify
  mode, env overrides, briefing preview (expose a dry-run of
  `buildSessionBriefing`).
- Boot-stage events: `IsolatedRunService` publishes bus kind `boot-progress`
  `{sessionId, stage: create|mount|clone|start}` at the existing seams
  (sandbox create, prepareWorkspace/clone seed, adapter start); new
  `chat.bootProgress` push. Composer timeline + the rail's reconnect spinner
  consume the same events.
- Queue variant: surface queue position from the ADR 0017 orchestrator queue
  in the session summary.
- Failure states reuse the existing error surfacing + authenticate/retry
  buttons verbatim.
- Plan-first: `planner.create {taskId}` + `drydock.planner.open(planId)`
  (both exist); composer collapses to the receipt row.
- Quick chat (approved): command + keybinding `drydock.quickChat` — creates a
  task titled from the first prompt (existing auto-rename path), starts a
  session with the window's folders as direct roots (no persisted set;
  session mount persistence from 0.3.11 already covers resume), focuses the
  rail. Post-first-turn "Track as subtask" affordance in the rail header
  (creates + links via existing task/subtask contracts).
- Retires nothing yet; workTab create-and-start goes at P7.
- Verify: live cold boot with visible stages, queue simulation, auth-failure
  drill, quick-chat end-to-end, plan-first round-trip.

## P5 — agents clarity (M) — SHIPPED

Deviation: the host-derived one-liner ships as a `sessionLines` array on
`AgentsOverviewState` rather than a field inside each session summary, so the
same projection serves pushed and refetched rows without widening
`ChatSessionSummary`.

Rebuild the Agents panel webview (`agents.ts`) as the flat background-task
list; `agentsPanelProvider.ts` keeps its provider shell.

- Data exists: `buildAgentsOverview` grouping/graft, `AgentActivitySummary`
  (+ root), usage tokens, `chat.rawStream` tail. Add a derived one-line
  `activityLine` (current command / latest output line / pending question)
  into the overview summary; damp client updates to ≥1s, never auto-scroll.
- Ordering: needs-attention pinned, then last activity; done/failed sink
  after ten minutes; filters All · Needs you · Active; group-by-task toggle
  renders the same rows under task headers.
- Expand-in-place: raw-stream tail + child rows + meta; per-row Land wires
  `agents.landSession` (exists); Retry reuses the orchestrator retry/resume
  path; bulk landing drawer moves behind the toolbar overflow.
- Removes: grouped grid, hover cards, chip clusters (`cardDetail` handling in
  this panel simplifies to the flat list; board keeps density as-is).
- Verify: fleet harness rows updated for flat list, attention pinning,
  expand, land; VSIX.

## P6 — configure (L) — SHIPPED (with deferrals)

Deferred out of slice (b): the inline preprompt editor, the skills/recipes
overlay editor, and the memory browser. Providers · MCP · Runtime · Security
shipped in full; preprompts and recipes kept their existing homes. The memory
browser deferral became ADR 0020's known gap and closed 2026-08-02:
Configure › Memories now hosts quick-add, the approval gate and the browser
over the kept `memory.*` contracts (shared projections in `memoryShared.ts`,
harness page `configure.html`). The preprompt editor and the overlay editor
remain open.

Singleton editor panel `drydock.configure` + bundle; command joins the rail
toolbar. Two internal slices, one release: (a) Providers · MCP · Runtime ·
Security, then (b) Agents & Models · Preprompts · Skills & Recipes ·
Memories.

- Providers: `providerConnectService` + catalog auth status + existing login
  commands (`sbx run claude` terminal / `sbx secret set -g openai --oauth`);
  default model per provider stored in `app_state`.
- MCP: existing registry + `.mcp.json` settings import move here from the
  System tab; add read-only `.drydock/mcp.json` project overlay (mirror
  `recipeOverlay.ts` / `plannerAspectOverlay.ts`).
- Preprompts: `drydock.teamInstructionsPath` row + inline editor writing the
  file; briefing preview via the P4 dry-run; detected repo CLAUDE.md /
  AGENTS.md as read-only project rows.
- Skills & Recipes / Memories: recipe + aspect registries and overlays
  (exist); memory tag-rule table edits `drydock.memory.tagRules` via the
  settings API; memory browser reads the scoped memory store.
- Runtime / Security: settings write-through
  (`workspace.getConfiguration().update(…, Global)`) for pathAdditions, env,
  copyEnv, maxConcurrentRuns, inactivity threshold, deniedPaths, clone-only,
  omit-sensitive; rows whose settings require reload show a reload chip
  (most machine-scope security settings do).
- Provenance chips: local (SQLite) · settings (origin named) · project
  (read-only + "edit the file"); project scope = merged list with overridden
  global rows struck beneath.
- Verify: scope-merge units, settings round-trip incl. reload-chip cases,
  needs-login drill, overlay read-only enforcement.

## P7 — retire + polish (M) — SHIPPED

Recorded as ADR 0020. `controlPanelProvider.ts` was neither deleted nor
renamed: it kept the name and shrank to the shared dispatch/push bridge every
host attaches to. `panel.showPlan` retired with the Plan tab that was its only
listener (see ADR 0020 consequences). The System tab's diagnostics feed retired
without a new home; runtimes moved into a collapsed fold at the bottom of the
Agents panel.

- Remove the Control Panel view contribution + `tabs.ts` + the four tab
  views; `controlPanelProvider.ts` shrinks to whatever shared handlers
  haven't already been extracted (target: deleted or renamed to a thin
  bridge). `drydock.panel.open` re-points at the rail; walkthrough, README,
  demo docs updated.
- Migrate any remaining webview persisted state keys; prune dist test
  leftovers when deleting sources (known gotcha).
- Final ADR documenting the overhaul and superseding
  `task-chat-and-agent-visibility`'s sidebar-tab model; design-doc index row
  updates.
- Verify: full suite, packaging assertions, fresh-install walkthrough on a
  clean state root, demo-mode screenshot pass.

## Sequencing

| Phase | Size | Depends on | Parallel with |
|---|---|---|---|
| P0 spine | S | — | — |
| P1 left rail | L | P0 | P2 |
| P2 chat rail | M | P0 (routing) | P1 |
| P3 task hub | L | P0; better after P2 | P5 |
| P4 new chat + quick chat | M | P3 (host), boot events | P5, P6 |
| P5 agents clarity | M | — | P3, P4, P6 |
| P6 configure | L | — | P4, P5 |
| P7 retire | M | all | — |

## Risks

| Risk | Containment |
|---|---|
| Secondary-sidebar move command is internal API | try/catch + one-time hint; drag persists; never retried |
| Single-folder window reloads on workspace switch | prompt states it; suppression can become a setting later |
| Hub retarget races | reuse the pendingShow flush-after-first-response pattern |
| Recents query cost | server-side dedupe over indexed session activity; cap 7 |
| Dual-run double-handling of chat messages | one extracted handler, hosts register; showSession targets rail first |
| Codex app-server buffered/quiet turns vs boot timeline | boot events come from the host service, not the transport — stages render regardless of transport behavior |
| Flat agents list churn at scale | ≥1s coalescing, no auto-scroll, auto-group threshold if needed |
