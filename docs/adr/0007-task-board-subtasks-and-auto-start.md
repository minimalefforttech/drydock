# 0007 - Task board and bounded subtask workflows

Status: Accepted - 2026-07-07

Refs: `docs/design/task-board-and-subtasks.md`, `docs/design/work-management.md`,
0013 (fleet presentation), 0015 (bounded orchestration),
`packages/contracts/src/tasks.ts`,
`packages/work-management/src/subtaskOrchestrator.ts`,
`packages/contracts/src/webviewMessages.ts`

## Context

Tasks carried a flat five-value state and linked whole chat sessions. Multi-step
work had no way to break into orderable pieces, no way to express "start B when
A finishes", and no surface showing work in flight across tasks. Automation
over agent runs is easy to get wrong in both directions: too eager and runs
start behind the user's back or race each other; too timid and the user
hand-cranks every step of a chain they already described.

## Decision

Subtasks are the only child work item. A subtask belongs to exactly one task,
optionally carries a prompt (which makes it startable), and review-driven mini
tasks are subtasks with `origin: "review"` rather than a separate record type.

Board columns are user-defined names inside four fixed categories - backlog,
pending, in-progress, done - and only the category drives behaviour. Every
category keeps at least one column; the first done-category column is the
automation target. Renaming or adding columns can never change semantics.

Dependencies are directed edges between subtasks of the same task: never
across tasks, never cyclic, validated in the service and made visible in the
UI (cards outside the parent task grey out during a connection drag). Blocked
is computed from unfinished upstreams and never stored.

Automation is opt-in and bounded. A dependent auto-starts only when its own
`autoStart` flag is set, all of its upstreams are done, it has a prompt, and
it is not in a backlog-category column. Manual start never starts
dependencies and is refused while any upstream is unfinished; Force start is
a manual-only override that automation never uses. Nothing automated ever
moves work past the first done column - Review to Finished is a human action.

Orchestration is event-driven through the product bus (`turn-completed`,
`card-entered-done`), per 0002's product-owned model: the product, not a
provider, owns run lifecycle, and concurrent chat sessions carry parallel
starts. Manual drags always win over automation and are never reverted.

Recipes are data templates that create a task, ordered subtasks, their DAG,
and per-subtask defaults such as prompt, auto-start, clone seed, model, and
human verification. Materialization never starts work. The registry combines
seeded product rows with read-only `.drydock/recipes.json` workspace overlays.
Repository overlays are ignored until VS Code trusts the workspace; recipes
cannot carry ambient access, and starting still goes through the normal clone
and approval paths.

A subtask or recipe step may require human verification. While it is in a
done-category column without a `verifiedAt` stamp, every board density level
shows an unmet `verify` state and offers a human `Verified` action. This is an
honest requirement marker, not automated test machinery: it does not let an
agent verify itself and does not move work past Review.

## Consequences

Migrations map the legacy task states onto seeded default columns; column
edits are cosmetic by construction. A finishing run can fan out new runs, so
surfaces refresh off one coarse `board-changed` push instead of fine-grained
deltas. Auto-start fires when an upstream reaches Review - before a human has
reviewed it - and pulling a card back out of done does not cancel dependents
already started. Live run projections may reset with the host; queued and
parked intent is durable and restored under 0015. Recipes make repeated fleet
shapes cheap without collapsing creation, start, review, and verification into
one implicit action.

## Amendment - 2026-07-24 (ticket shape, stages, gated edges)

Tasks now carry a ticket shape settable at creation and editable later:
queue lane, handoff mode (patch | branch) with a plain user-owned branch
name, and approach (implement | plan-first). Recipes carry matching
defaults (below the ticket, above product preferences in the config
ladder) and may declare stage steps: 1-based `stageIndex` values must be
unique and every stage after the first must explicitly depend on its
predecessor - validation rejects implied chains. The cascade predicate
gains one clause: a subtask carrying an unsatisfied human gate (ADR 0016)
is never auto-start eligible. Batch intake (`Drydock: Queue Background
Tickets…`) materializes one background ticket per pasted line; creation
and start remain separate acts.
