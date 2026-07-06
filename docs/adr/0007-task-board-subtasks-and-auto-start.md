# 0007 - Task board, subtasks, and auto-start

Status: Accepted - 2026-07-07

Refs: `docs/design/task-board-and-subtasks.md`, `docs/design/work-management.md`, `packages/contracts/src/tasks.ts`, `packages/work-management/src/subtaskOrchestrator.ts`, `packages/contracts/src/webviewMessages.ts`

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

Board columns are user-defined names inside four fixed categories — backlog,
pending, in-progress, done — and only the category drives behaviour. Every
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
moves work past the first done column — Review to Finished is a human action.

Orchestration is event-driven through the product bus (`turn-completed`,
`card-entered-done`), per 0002's product-owned model: the product, not a
provider, owns run lifecycle, and concurrent chat sessions carry parallel
starts. Manual drags always win over automation and are never reverted.

## Consequences

Migrations map the legacy task states onto seeded default columns; column
edits are cosmetic by construction. A finishing run can fan out new runs, so
surfaces refresh off one coarse `board-changed` push instead of fine-grained
deltas. Auto-start fires when an upstream reaches Review — before a human has
reviewed it — and pulling a card back out of done does not cancel dependents
already started. In-memory run projections (`isRunning`, `lastFailureAt`)
reset with the host; durable truth stays in the store and session links.
