# Agents Panel

The fleet view (ADR 0013): one editor-area panel showing every agent across
every task - what each is doing right now, its delegated subagents, and who is
blocked on the user. It is the surface for the many-tasks-in-flight moment
that the board (cards), the Agents lens (one session), and the attention slot
(one card) each answer only partially.

Related: `task-chat-and-agent-visibility.md` (lineage + activity summaries),
`task-board-and-subtasks.md` (categories, auto-start), `subagent-workflows.md`
(capability tiers), ADR 0008 (ownership), ADR 0014 (changeset landing), and
ADR 0015 (durable queue/park policy).

> **Presentation superseded by the UX overhaul's P5 clarity pass**
> (`ux-overhaul-implementation.md`, `../ideas/ux-overhaul-calm-workbench.md`).
> The panel is now a FLAT recent-first list - one 2-line row per session (dot ·
> title · owning task · elapsed, then one live mono activity line), pinned rows
> for anything waiting on a person, expand-in-place for the raw-stream tail /
> subagent children / meta, per-row `Land changes`, filters
> `All · Needs you · Active`, and an opt-in group-by-task toggle. The grouped
> grid, hover cards, chip clusters, orphan drawer, bulk Landing drawer and the
> panel's density levels (ADR 0013) are retired; the board keeps density as-is.
> Everything below still describes the DATA plane accurately - only the
> "Structure", "Row anatomy" and "Density and usage" sections describe the
> retired presentation.

## What the panel answers

- Which tasks have live work right now, and how much?
- What is each agent doing at this moment (last tool/command, last activity)?
- Which delegated agents exist under each session, and are any failing?
- Who is waiting on me (questions, access requests, failed turns)?
- What is running in another window, and what merely looks active but is idle?
- How many live tokens are represented in this window?
- Which captured clone outputs are ready to land, and which touch overlapping
  paths?

## Structure

A single scrollable scan list, grouped by task. No graph canvas, no columns -
rows earn their keep at fleet sizes (the same call as the Agents lens).

1. **Header strip** - live rollup (`N running · N waiting on you · N idle`),
   where waiting includes session questions/access/failures and task subtasks
   awaiting human verification,
   plus the live fleet token total, `[Active | Needs attention | All]`, a
   `Min | Std | Full` detail control, and text filtering over task/session
   titles.
2. **Task groups** - one collapsible group per task that has linked sessions,
   ordered: groups needing attention first, then by running count, then by
   `lastWorkedAt`. The group header carries the task title, its board column
   chip (name + category accent), rollup counts, and open actions (board,
   task review).
3. **Session rows** - one row per root session under its task. Role-session
   children indent under their parent (`parentSessionId`), depth-N.
4. **Subagent rows** - native delegated agents indent under their session
   row, derived from `AgentActivitySummary.agents` (`parentNodeId` gives
   depth). The same items feed the sidebar ⑂ chips, so the two surfaces
   cannot disagree.
5. **Orphan drawer** - sessions with no task link collapse into a trailing
   `Sessions without a task` drawer, consistent with the sidebar's cleanup
   drawer: present, not competing with tasks.
6. **Landing drawer** - unlanded changesets grouped one item per subtask,
   ordered by overlap confidence and age. It is the one mutating fleet
   exception: two-click Pull reuses the full clone-sync operation from ADR
   0014.

## Row anatomy

Session row: status dot → title → chips → activity → right meta.

- **Status dot** keys off `live` (authoritative), never stored status: pulsing
  while a turn runs, steady when live-idle, hollow when ended, halved when
  running elsewhere. `starting` is the boot exception: a pulsing hollow dot
  plus "resuming - recreating the runtime and clones". `failed` uses the
  standard loud accent.
- **Chips**: provider/model, mode (planning/implementation/clone), role (for spawned
  children), ⑂ N while subagents run, and attention chips - `? question`,
  `⚠ access`, `✗ failed turn` - in the loud vocabulary.
- **Activity line**: the root agent's `lastCommand` + clipped `lastActivity`
  while live; the session description otherwise. Idle state (`idle 12m`)
  appears when `lastActivityAt` exceeds `agentIdleThresholdMs`.
- **Right meta**: running duration (live ticker), token usage where reported,
  tool-use count, and Stop (cancel turn) for locally-owned live sessions.

Subagent row: indented status dot, label, type/model chip, last activity,
tool count, tokens where reported, duration. Lifecycle-tier transports render
their honest "lifecycle only, no feed" note; `none` renders "no subagent
signal for this transport" rather than an all-quiet tree.

Running-elsewhere rows show the owning-host note and no activity feed or
controls (0008 posture) - the fleet view never invites a second window to
fight over a runtime.

## Density and usage

Board cards and fleet rows share the three-level policy in ADR 0013. The
chosen level is panel-local webview state over the
`drydock.ui.cardDetail = minimal` default.

- **Minimal:** title/dot and at most one state chip. Fleet priority is
  questions → access → failed turn → failed delegated agent; a live-running
  row needs no chip because its dot and duration already say so.
- **Standard:** the normal provider/mode/role/activity chips and per-task
  token totals.
- **Full:** passive metadata such as tool counts is also inline.
- At minimal and standard, one consolidated hover/focus card carries hidden
  metadata. There are no per-chip tooltip stacks.

The toolbar's `Σ` and task totals sum live root-agent token reports in this
window. They are token usage, not price estimates, and reset with the live
projection because no durable usage ledger exists.

## Data plane

Composed host-side, folded client-side:

- `agents.state` (new request) returns `AgentsOverviewState`: task groups
  (task summary + board column name/category + sessions), orphan sessions,
  pending questions, pending access requests, unlanded changeset landing
  items, and `agentIdleThresholdMs`.
  Task summaries carry `verifyUnmet` on their subtasks, so the fleet rollup,
  task ordering, and Needs attention filter use the same verification state as
  the Task Board.
  Sessions arrive as plain `ChatSessionSummary` - the shape already carries
  liveness, ownership, lineage, and `agentActivity`. The activity summary
  gains an optional `root` item (the session's own agent this turn) so fleet
  rows know pulse/last-command/tokens on boot; the sidebar ⑂ chip ignores it.
  P5 adds `sessionLines` to that state: one `activityLine` / `resultLine` /
  `landable` per session, derived by `fleetActivityLine` and `fleetResultLine`
  in contracts. The webview calls the SAME functions when an activity push
  lands mid-turn, so a pushed row and a refetched row cannot disagree.
- Structural bus events collapse into ONE debounced coarse push,
  `agents.changed`, and the webview refetches - the board's self-healing
  shape. The panel host subscribes to `board-changed` (which task
  create/update/delete/link/unlink now also publish), `turn-completed`,
  `question-asked`/`question-resolved`, and
  `access-requested`/`access-resolved` (the two `-resolved` kinds are new bus
  events published at the question/access services' resolution choke points,
  so chips clear no matter which surface answered).
- Hot pushes fold in place with no refetch: `session.agentActivity` replaces
  a session's agent rows (folded by the panel host from bus agent-events
  through the same `agentActivitySummaryOfTree` projection the sidebar chips
  use), `chat.turnStarted`/`chat.turnCompleted` flip running state,
  `session.updated`/`session.deleted` swap or drop one row - an update for an
  unknown session schedules the coarse refetch instead (membership changed).
- Durations and idle labels tick locally from timestamps; nothing polls the
  host for time to pass.

## Interactions

- Row click → the sidebar control panel opens that session in Edit
  (`agents.openSession` request; the host focuses the sidebar and emits the
  `panel.showSession` push, the `planner.showPlan` pattern). Subagent row
  click → same navigation, landing on the Agents lens.
- Question/access chips → the same navigation; answering stays in the
  sidebar's attention stack. The panel adds no new approval surface.
- Task header actions → open the task board (`taskBoard.open`) or task
  review (`taskReview.open`).
- Stop on a session row → the existing `chat.cancelTurn`. No bulk actions,
  no end/delete from the fleet in v1.
- Landing Pull → `agents.landSession`; confirmation is local to the row and
  the host calls the same full clone Pull as the session Changes tray. Applying
  stored patches through a second mechanism is deliberately out of scope.

## Honest states

| State | Rendering |
|---|---|
| Live, turn running | Pulsing dot, activity line, ticker |
| Live, idle past threshold | Steady dot + `idle Nm` label |
| Starting/resuming | Pulsing hollow dot, explicit rebuilding line, active filter, no controls |
| Running elsewhere (0008) | Halved dot, owning-host note, no controls |
| Ended/failed | Hollow dot / loud failed accent, no ticker |
| Transport tier `lifecycle` | Child cards, "no per-agent feed" note |
| Transport tier `none` | "No subagent signal", never an empty-quiet tree |
| Stored-active but not live | Rendered as not live (reload killed backend) |

## Runtimes fold (ADR 0020)

A collapsed `Runtimes` section sits below the fleet, at the very bottom of the
panel: the container inventory the retired System tab used to own. One line per
non-removed runtime - name (mono) · state · uptime - with `Stop` revealed only
on hover or keyboard focus and armed by a first click, plus `Clean up stale`
(`runtime.reconcile`). When the sandbox tooling refuses to answer, the fold
shows the error and a `Sign in to Docker Sandbox` button (`runtime.sbxLogin`).

It is a fold, not a dashboard: closed by default, it issues no request at all
until it is opened, and it never polls - it refetches on open and after its own
actions. Per-sandbox CPU/memory/IO sampling did **not** come with it
(`runtime.stats` retired); the chat's own per-session stats bar
(`chat.runtimeStats`) is unchanged. The four requests are answered by
`agentsPanelProvider.ts`, which is its own dispatcher.

## Non-goals (v1)

Bulk stop/start, acting on another window's sessions, per-native-node cancel
(deferred in `subagent-workflows.md`), a graph/timeline canvas, answering
questions, approving access, ending sessions, and arbitrary mutations. Session
rows observe/navigate/cancel; Landing's existing full Pull is the sole
convergence exception.

## Visual-test coverage

The webview harness `agents` page pins: flat rows with attention-first
ordering; loud/quiet accents; subagent indentation and tier notes;
running-elsewhere posture; filter behavior; live token scope;
starting/resuming; per-row landing; the Runtimes fold (V77); and empty states
(no tasks, no live work).
