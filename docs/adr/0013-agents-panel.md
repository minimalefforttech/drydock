# 0013 - Agents panel and fleet presentation

Status: Accepted - 2026-07-11

Refs: `docs/design/agents-panel.md`, 0006 (agent lineage + activity summaries),
0007 (board categories and task recipes), 0008 (session ownership), 0012
(editor-area panel pattern), 0014 (changeset landing), 0015 (queue/park)

## Context

Concurrency outgrew the surfaces that watch it. Subtask auto-start cascades
runs in parallel (0007), role sessions fan out children (0006), and the
Planner boots sessions of its own (0012) — but every visibility surface is
scoped to one thing: the Agents lens to one session, the board to cards, the
attention stack to one paged slot. With five tasks in flight the user's
question is "where is everything up to, and who is blocked on me?" — and the
only answer today is clicking through tasks one by one.

The data to answer it already exists. `ChatSessionSummary` carries liveness,
ownership, role lineage, and compact per-agent activity rows; coalesced
pushes (`session.agentActivity`, `session.attention`) stream the hot signals;
tasks link sessions and sit in board columns.

## Decision

One editor-area **Agents panel** (`drydock.agents`, opened by
`drydock.agents.open`) — a fleet view over all sessions, grouped by task.

- **The session overview is a projection.** It adds no session tables, event
  types, or polling. A host overview service composes `agents.state` from the
  existing session, task, board, question, and access-request services.
  Sessions nest role-session children under parents (`parentSessionId`);
  native subagent rows come from the same `AgentActivitySummary` items the ⑂
  chips use, so the fleet view and task rows cannot disagree. The Landing
  drawer is the explicit exception: it projects the durable changesets from
  0014 and invokes that ADR's existing full-Pull operation.
- **Hybrid data plane.** Structural changes (task/session created, deleted,
  linked; board moves) coarse-invalidate: the webview refetches
  `agents.state`, debounced. Hot signals fold incrementally client-side from
  the existing pushes — `session.agentActivity`, `session.attention`,
  `chat.turnStarted`/`chat.turnCompleted`, `question.asked`/`resolved` —
  so a busy fleet never causes refetch storms and the panel adds zero new
  traffic to the hot event path.
- **Honesty rules carry over.** Rows key liveness off `live`, never stored
  status; sessions running in another window render the 0008 read-only
  posture with no activity feed and no mutating controls; capability tiers
  (`subagentReporting`) keep "no signal" distinct from "all quiet".
- **Act-from-the-fleet is deliberately thin**: click-through navigation
  (session row → the sidebar Edit session via the `panel.showSession` push, following the
  `planner.showPlan` precedent; task header → board/task review) plus the
  existing per-session cancel and the two-click Landing Pull governed by
  0014. Answering questions, approving access, and ending sessions stay on
  their owning surfaces; the panel adds no parallel approval path.
- Filters are view-local: Active / Needs attention / All, plus an idle
  marker driven by the existing `agentIdleThresholdMs`.
- **Quiet by default, detail on demand.** Board cards and fleet rows share
  `minimal | standard | full` detail levels. The per-panel choice persists in
  webview state; `drydock.ui.cardDetail` supplies the default (`minimal`).
  Minimal keeps at most one state chip and one consolidated hover/focus card
  carries the hidden detail. Priorities are surface-specific: board cards use
  verify → running → parked → failed → queued → blocked; fleet rows use
  questions → access → failed turn → failed delegated agent, with running
  already communicated by the dot and duration. Attention states never hide;
  passive seed/model/usage metadata stays in the hover card or higher levels.
- **Usage is honest about scope.** The fleet header sums live root-agent
  tokens for this window; task headers show their live totals at standard and
  full detail. These are token rollups, not monetary cost, and there is no
  durable usage ledger.
- **Starting is visible.** A reclaimed or resumed session with
  `status === "starting"` is active, renders a pulsing hollow dot and a
  "resuming — recreating the runtime and clones" line, and offers no controls
  until boot completes.

## Consequences

- "Where is everything?" becomes one keystroke, and stays correct because
  every row is derived from the same reducers and summaries the sidebar
  already trusts — the panel can drift from reality only if those do.
- The webview holds a folded copy of the overview; a missed push is repaired
  by the next structural refetch rather than accumulating (the same
  self-healing shape as `board.changed`).
- Pending questions and access requests render as row chips across every
  task at once — attention that used to be discoverable only via badges on
  one sidebar slot becomes scannable, without moving where it is answered.
- Density is a presentation policy, not a second data contract. New fleet
  metadata must state where it appears at minimal detail rather than adding
  another always-visible chip.
- A fourth editor-area panel joins board/review/planner with the same CSP and
  `parsePanelRequest` boundary. Landing remains the only operation in this
  panel that writes outside normal session cancellation, and it reuses the
  clone sync path rather than inventing a new apply mechanism.
