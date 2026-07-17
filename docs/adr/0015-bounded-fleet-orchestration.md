# 0015 - Bounded fleet orchestration

Status: Accepted - 2026-07-12

Refs: `docs/design/task-board-and-subtasks.md`, `docs/design/agents-panel.md`,
0002 (product-owned lifecycle), 0007 (subtask automation), 0008 (ownership),
0013 (fleet presentation)

## Context

Opt-in fan-out can still oversubscribe a workstation, retry forever, forget
queued intent on reload, or block on questions whose task-scoped answer never
changes. Fleet automation needs resource, failure, continuity, and standing-
answer rails without turning access approval into automation.

## Decision

- **Bound concurrent runs.** `drydock.orchestrator.maxConcurrentRuns` is the
  global slot budget. `0` derives a live default from cores and memory, clamped
  to 1-8. At the budget, starts queue instead of overshooting it. Manual starts
  enter at the front (a repeat request promotes); cascade starts append. The
  drain awaits one start at a time under the current budget.
- **Persist held intent.** `subtask_holds` stores at most one queued or parked
  hold per subtask. Enqueue/promote writes through; dequeue, unpark, and success
  delete. After runtime/session reconciliation on activation,
  `orchestrator.restore()` reloads parked state, re-queues held starts in held
  order, then drains. Every restored hold is revalidated against the current
  board; deleted cards, cleared prompts, and other stale intent are logged and
  skipped.
- **Retry once, then park - automatic runs only.** A failed cascade run retries
  once. A second failure parks the subtask, suppresses further cascade, and
  waits for a human Retry. Manual starts clear retry/park state and never
  auto-retry. Cancellation is a human gesture and never retries or parks.
- **Standing task answers are doubly opt-in.** A task may store case-insensitive
  pattern → answer FAQ rows and enable its own auto-answer toggle, behind the
  global `drydock.autoAnswer.questions` switch. A match resolves through the
  same `AgentQuestionService.answer` path as a manual answer and appends a
  `[host]` transcript receipt. Access requests use a separate protocol and are
  never auto-answered: automation may reuse an answer but cannot widen access.
- **Held and booting states stay visible.** Queued and parked are user-facing
  board states under the density rules in 0013. Restored starts may run shortly
  after activation because they represent prior explicit intent, and starting
  sessions remain visible as active while their runtimes and clones rebuild.

## Consequences

- Fan-out is bounded by the machine budget, and a queued card explains why it
  has not started.
- Automatic failure converges after two attempts instead of becoming a retry
  storm or a silent dead end.
- Reloads preserve queued and parked intent, but holds remain bookkeeping rather
  than authority: restore always checks live task/subtask truth before launch.
- Repeated questions can stop blocking an opted-in task while every automatic
  answer remains attributable. No configuration path can apply the same
  behavior to access requests.

