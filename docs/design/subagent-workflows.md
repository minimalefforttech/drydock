# Subagent Workflows

Subagent visibility and the role-session workflows below ship together.
Codex support is REQUIRED in v1; the design uses one common
normalized standard across providers, degrading per provider with honest UI
states rather than silent gaps. The hierarchy view is a `[Log|Agents]` toggle
in Chat. Related: roadmap, the role-based extension points
that let panels contribute `sessionChips`/`sessionMetaSegments`/
`sessionLoudness` per session role, `task-review.md` (role-flow-view
deferral), `threat-model.md` (subagent access rule), `workflow-scenarios.md`
B-series.

## Purpose

When the in-VM agent fans out — **Codex collab agents (`multi_agent` is a
STABLE, ENABLED feature on codex-cli 0.142.4) and Claude Code Task subagents —
the product today is worse than blind: it misattributes and, on codex
app-server, would end the turn early.** Verified against the code and live
streams:

- **Codex app-server (primary transport): a child's `turn/completed` ends the
  product's turn.** `streamEvents` consumes every notification with no
  threadId filter (`codexAppServerTransport.ts:128-147`) and the normalizer
  maps any `turn/completed` → `agent.done`; child threads complete BEFORE the
  parent (probe evidence below), so the first finishing subagent would
  terminate the stream mid-turn. All child items (their commands, file
  changes, messages) are also normalized as the main agent's.
- **Claude exec-json:** sidechain lines are normalized identically to main
  ones (`claudeEventNormalizer.ts:73`), so subagent prose interleaves into the
  main transcript; `parent_tool_use_id` is never read; tool results (including
  the subagent's final report) are dropped at `claudeEventNormalizer.ts:105`.
- **Codex exec-json:** `collab_tool_call` items aren't in the normalizer's
  item map, so spawns/waits/closes are dropped (as is `web_search`).

This milestone makes delegated agent activity **correct, attributed, and
navigable to one common standard, degrading per provider**: collapsible
per-subagent groups in the transcript, an alternate hierarchy lens over the
same feed (depth-N — sub-subagents render when a transport reports them),
live status/counts while collapsed, click-through to each agent's prompt,
feed, result, and (where reported) per-agent token usage.

**Scope:** the visibility layer covers *observability + stream correctness
only*. Product-owned role sessions (orchestrator spawning
researcher/worker/reviewer sessions with narrowed mounts, per-role
cancellation) build on top of it; the visibility layer provides the lineage
model, normalizers, and UI surfaces that role sessions render into. The
deferred "role-based flow view" is superseded by the Agents lens + the
role-session seam, not resurrected as a graph.

## Transport behavior: thread lineage and turn semantics

Verified against real fan-out turns (parallel spawns, a nested spawn attempt,
a web fetch) driven through both codex transports:

**codex app-server** (`app-server --listen stdio://`, initialize →
`thread/start` → `turn/start`): a fan-out turn produces multiple threads —
one main thread plus one per spawned child.
- Every `item/started`/`item/completed` carries **`threadId` + `turnId`**
  (schema-required).
- Parent thread emits `collabAgentToolCall` items: `tool:
  spawnAgent|sendInput|resumeAgent|wait|closeAgent`, `senderThreadId`,
  `receiverThreadIds` (spawn → the new child's thread id), `prompt`, `model`,
  `agentsStates: {threadId → {status: pendingInit|running|interrupted|
  completed|errored|shutdown|notFound, message}}`.
- **Children stream full first-class feeds** on their own threadId:
  `userMessage` (the spawn prompt), `reasoning`, `agentMessage`,
  `fileChange`, `commandExecution` (including per-child command failures,
  reported as `exitCode`/`status`), plus their own
  `turn/started`/`turn/completed` and `thread/status/changed`
  (active/idle). Child threads can complete BEFORE the parent thread.
- **`thread/tokenUsage/updated` per thread** — per-subagent token cost is
  reportable.
- `webSearch` item (query) on the emitting thread covers "loads webpages".
- `subAgentActivity {agentPath: string, agentThreadId, kind:
  started|interacted|interrupted}` exists in the v2 schema but is not
  reliably observed on the current fan-out path (likely gated behind the
  disabled `multi_agent_v2` path) — parse it when present, don't depend on it.
- Nested spawn: a child reports "nested spawning unsupported" today (children
  get no collab tools); `agentPath` being a *path string* in the schema says
  nesting is planned. Design stays depth-N.

**codex exec --json**: `item.started/completed` for `collab_tool_call`
(snake_case: `sender_thread_id`, `receiver_thread_ids`, `agents_states`,
`prompt`) and `web_search`; `turn.completed` with usage. **No per-child
items** — lifecycle-level visibility only (spawn → status → result message
per child).

**claude -p --output-format stream-json**: mapping is spec'd from the
documented stream format (`parent_tool_use_id` on sidechain assistant/user
lines; Task `tool_use` blocks carry `{description, prompt, subagent_type}`).
Verifying this transport live requires an authenticated Claude CLI host —
the standalone CLI's credential store is separate from desktop-app auth, so
this parsing path is validated by capturing a real fixture against an
authenticated CLI (host login, or inside the product's authed runtime)
before it ships.

## Design: lineage on the existing event pipeline, no new storage

Everything derives from the durable event stream; the tree is a projection.

| Concern | Reused machinery |
|---|---|
| Event capture | Normalizers already emit `agent.text/tool_call/command/file_edit` with full `raw` preserved (`claudeEventNormalizer.ts`, `codex*Normalizer.ts`) |
| Persistence & replay | `session_events` (rowid replay order) — new fields ride `payload_json`; old rows stay valid |
| Live + replay to UI | `chat.event` push and `session.timeline` both project through `TranscriptLine` (`events.ts:91`, `controlPanelProvider.ts:136`) — one type extension serves both |
| Transcript rendering | Dev-log transcript + Diagnostics section (`chatTab.ts:909`); `collapsible()` and inline-toggle patterns (`components.ts:74`, grants ledger) |
| Work-tab chips | The documented role-extension points: `sessionChips` / `sessionMetaSegments` / `sessionLoudness` (`workTab.ts:79-132`) — the ⑂ chip is the promised one-entry change |
| Tree computation | ONE pure reducer in contracts, consumed by both the webview (Agents lens) and the host (session-summary decoration) |

### Lineage model (contracts — the common standard)

- `AgentEventBase` gains **`agentPath?: readonly string[]`** — lineage of the
  *emitting* agent. Absent/empty = the session's root agent; `["n1"]` =
  subagent `n1`; `["n1","n2"]` = its child. **Node ids are transport-scoped:
  codex = the child's thread id; claude = the spawning Task `tool_use.id`.**
  One field gives depth-N hierarchy across providers.
- New event types (`summarizeAgentEvent` is exhaustive with `assertNever`,
  so every surface is forced to handle them):
  - **`agent.spawn`** `{ nodeId, label, subagentType?, model?,
    promptPreview? }` — a recognized delegation. `agentPath` = the parent's
    path; the child's path is `[...agentPath, nodeId]`. Codex source:
    `collabAgentToolCall spawnAgent` completion (receivers + prompt + model);
    Claude source: Task `tool_use` (description + subagent_type + prompt).
  - **`agent.node_done`** `{ nodeId, status:
    "completed"|"failed"|"cancelled", resultPreview?, usage? }` — the child
    finished. Codex source: the child's own `turn/completed` (tier full) or
    `wait`/`close` `agentsStates` (tier lifecycle); status `errored`→failed,
    `interrupted`/`shutdown`-before-done→cancelled; usage from the child
    thread's last `tokenUsage` total where seen. Claude source: the Task
    tool_result (`is_error` → failed).
- `agent.tool_call` gains **`toolUseId?: string`**; tool results (parsed for
  the first time on claude) emit a completing `agent.tool_call` with capped
  `output`. Codex webSearch/mcpToolCall/dynamicToolCall items map to
  `agent.tool_call` with attribution (webSearch summary = the query/URL).
- `TranscriptLine` gains `agentPath?`, `nodeId?`, `label?`, `nodeStatus?`,
  `detail?` — carried by `summarizeAgentEvent`/`summarizeStoredEvent` so live
  push and timeline replay stay in lockstep. `detail` holds capped output/
  result previews (the 400-char `summary` clip stays).

### Caps (event volume is the cost of seeing)

`promptPreview` ≤ 500 chars; `resultPreview`/tool `output`/`detail` ≤ 1 KB.
Documented deviation from the raw-preservation norm: events derived from
tool_result/child-output payloads store `raw` with the bulky content field
truncated to the same cap — subagent results can be file-dump sized and
`session_events` must not become a blob store. Everything else keeps full
`raw` as today.

### Capability tiers (honesty is part of the contract)

Per-transport constant in contracts, `subagentReporting`:

| Transport | Tier | Meaning in UI |
|---|---|---|
| `codex-app-server` | **`full`** | Child nodes with live feeds, per-node status/usage/duration |
| `codex-exec-json` | **`lifecycle`** | Child cards with prompt/status/result — body says "this transport reports lifecycle only, no per-agent feed" |
| `claude-exec-json` | **`full`** (pending a captured live fixture) | As app-server, minus per-node usage unless the stream provides it |
| (legacy sessions) | `none` | Root only + "recorded before subagent tracking" |

Never render an "all quiet" tree that is actually blindness — `none`/
`lifecycle` states say so.

### Codex normalizer + transport changes (the correctness core)

- **Thread-aware normalization.** The normalizer context learns the session's
  root thread id and keeps a spawn-edge registry (childThreadId → agentPath),
  fed by `collabAgentToolCall` receivers and — defensively — `subAgentActivity
  {agentThreadId, agentPath}` when it appears. Items on a registered child
  thread get that `agentPath`; items on an *unregistered* foreign thread are
  attributed `["unknown:<id8>"]` rather than dropped or mislabeled.
- **Turn-end fix:** `turn/completed`/`turn/failed` maps to `agent.done` ONLY
  for the session's root thread; for child threads it maps to
  `agent.node_done`. (This is the premature-termination bug fix.)
- Child `thread/status/changed` + `agentsStates` transitions feed node status
  (pendingInit→running→…); the reducer folds them.
- exec-json: `collab_tool_call` items (snake_case fields) → `agent.spawn` /
  `agent.node_done`; `web_search` → `agent.tool_call`.
- The registry lives per connection (children are spawned and closed within
  turns; the session's root thread id is already tracked).

### Tree projection — one reducer, two consumers

`reduceAgentTree(source) → SessionAgentTree` in contracts: nodes `{ nodeId,
parentId, kind: "root"|"native", label, subagentType?, model?, status,
startedAt, endedAt?, counts {toolCalls, commands, fileEdits, errors},
lastActivity?, resultPreview?, usage? }`. Input is a minimal source
projection extractable from either `AgentEvent[]` (host) or
`TranscriptLine[]` (webview), so the logic exists once.

- **Webview (Agents lens):** reduces the selected session's lines — which it
  already holds from `session.timeline` + streamed `chat.event`. No new push
  type, no polling.
- **Host (Work-tab chips):** live sessions keep incremental counters from the
  same reducer; `ChatSessionSummary` gains `agentActivity?: { running:
  number; failed: number }` via the existing summary decoration. This rides
  its own coalesced `session.agentActivity` push (the same pattern as
  `session.attention`) rather than `session.updated`, so a running child does
  not force a record fetch in the hot event path or churn `updatedAt`;
  `ChatSessionSummary` still carries `agentActivity` so reloads hydrate from
  `session.list`. Counters reset on turn start; a child failure keeps the red
  accent until the next turn. Sessions "running elsewhere" stream no
  events into this host; their chip shows nothing — consistent with their
  read-only posture.

Two projections consume the same reducer differently in practice: the
transcript's collapsible groups keep an incremental `AgentGroup` state (needed
for chronological anchoring plus child prose, which the pure reducer doesn't
model), while the Agents lens reduces the structured Diagnostics feed directly
through `reduceAgentTree` — line/event parity between the two is
test-enforced. exec-json terminal dedup is scoped to the normalizer instance's
lifetime, which is safe because thread ids are UUIDs and cross-run collisions
cannot occur.

## UX

**Transcript (Chat tab) — collapsible subagent groups.** An `agent.spawn`
line inserts a group block at its chronological position in the transcript
flow. Header: `⑂ <label> · <model/type chip> · <status> · N calls ·
duration` — collapsed by default, counts/last-activity tick live while
collapsed, status uses the standard loud/quiet status vocabulary (a bold red
`· failed` chip when the child fails; a quiet `✓` on completion; no halo for
benign completion). Expanded body: the child's own
dev-log — its prose blocks (same structural-markdown-as-text renderer), a
compact activity feed (tool/command/web summaries with `detail` behind a
per-line disclosure), the prompt it was given, its result preview, per-node
usage where reported, and *nested groups for its children* (depth-N). Child
prose/lines route by `agentPath` — they no longer interleave into the main
assistant stream (the misattribution fix). Tier `lifecycle` renders the same
header/prompt/result card with an honest no-feed note. The flat Diagnostics
section keeps receiving everything, prefixed `[<label>]`.

**Agents lens — the alternate view (decided: toggle in Chat).** A
`[Log | Agents]` segmented toggle on the transcript region. The Agents lens
renders the tree: one row per node, indent = depth, status dot + label +
model/type chip + counts + last activity + duration (+ tokens where
reported); running nodes reuse the header-pulse treatment. Clicking a node
switches to Log, scrolled to and expanding that node's group.
Capability-tier empty/degraded states per the table above. No graph canvas —
a tree earns its keep at sidebar fan-out sizes; a flow panel stays
deferred.

**Work tab.** `sessionChips` gains `⑂ N` while N subagents are running
(namespaced class, one colour rule — the documented extension pattern); a
failed child renders the chip in the failed accent. `sessionLoudness` is
untouched in v1 — a subagent failure inside a *succeeding* turn does not
flag attention (the parent recovered; the loud header chip in the transcript
is the record). A failed *turn* already goes loud via existing attention
routing.

**Deliberately absent (B4 discipline):** no per-node cancel in v1 — codex
app-server *could* interrupt a child thread, but a safe per-node cancel needs
the parent's `wait` semantics understood (a killed child leaves the parent
waiting); deferred to role-session orchestration work. No approval friction
changes, no new confirms. Visibility + stream correctness only.

## Isolation & threat posture

- Native subagents run **inside the parent's runtime with the parent's
  mounts** (codex collab threads live in the same sandboxed process; claude
  Task subagents in the same CLI). This milestone grants nothing, restarts
  nothing, adds no approval paths — pure observability over an existing
  boundary. Child file edits already flow into the working set/diff baseline
  (same runtime); now they are *attributed*.
- The threat model's Denied Behaviors rule that a subagent must not inherit
  broader access than its parent session (`threat-model.md`, "Denied
  Behaviors") binds **role sessions** (separate sessions/runtimes); nothing to
  enforce here. The visibility layer contributes B1/B2-grade visibility: a reviewer can
  see what each delegated agent was asked, ran, and touched.
- Labels, prompts, previews are **agent-authored text**: textContent-only
  rendering (standing invariant), clipped, never markdown-parsed in headers/
  chips; child prose bodies use the same literal-safe renderer as main prose.
- Event growth bounded by the caps; chip pushes are decoration on the
  coalesced `session.agentActivity` push.

## Product-Owned Role Sessions

Role sessions build on the visibility layer's lineage model:
`parentSessionId` and `spawnedRole` on session records, summaries, and SQLite
(indexed); `spawnRoleChatSession` starts a fresh disposable workspace/runtime
per role, where read roles get every mount read-only plus plan mode and
worker/tester roles inherit the parent's modes. `assertChildMountsWithinParent`
is the threat-model enforcement point: it is checked at spawn AND inside
`expandSessionMounts`, so child mount expansion is refused when the parent
isn't live to vouch for it, and clone-mode parents refuse spawning outright
(the clone lives in the parent's private workspace, which a child session
cannot share). `agentRole` is plumbed all the way to the runtime/connection
layer (previously hardcoded to `"worker"`). The `chat.spawnRole` request and
a `[+ role…]` control on the Agents lens strip let a user request a role
session; it inherits the parent's task link, gets a role chip via the
documented `sessionChips` extension point, and is grafted into the parent's
Agents lens (clicking it opens the child session). Per-role cancel reuses the
existing per-session cancel/end — sessions own their runtimes, so nothing
couples siblings.

## Deferred (recorded, not built)

- Live claude fixture capture: today's claude-transport tests are synthetic,
  pending a captured fixture from an authenticated Claude CLI.
- Agent-driven spawn protocol: spawns are user-driven today; an
  agent-requested spawn needs a B4-graded approval design of its own.
- Per-native-node cancel (a safe per-node interrupt of a codex child thread
  needs the parent's `wait` semantics understood first — a killed child
  leaves the parent waiting).
- Live per-node token ticker (codex `thread/tokenUsage/updated` streams it;
  today's UI shows final usage on node_done only).
- Editor-area flow-graph panel — only if role-session scale outgrows the tree.
- Backfill `agentPath` for old sessions from stored `raw`.
- Codex `multi_agent_v2`/fan-out (`subAgentActivity` streams, nested spawn)
  — parse-ready, re-probe when the feature flips stable.
- Role-based model routing (children currently inherit the parent's model).
- Subagent-failure attention routing (revisit `sessionLoudness` if silent
  child failures inside an otherwise-succeeding turn turn out to get missed).
