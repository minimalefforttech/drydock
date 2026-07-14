# Task Board And Subtasks

## Purpose

Tasks once carried a flat five-value state and linked whole chat sessions. The
board replaces that model with orderable subtasks, dependency-driven work, and
a fleet-scale view of work in flight.

This doc specifies subtasks, recipes, dependency-driven auto-start, bounded
orchestration, human-verification requirements, and the Task Board editor
panel. Durable decisions live in ADR [0007](../adr/0007-task-board-subtasks-and-auto-start.md), with resource/failure continuity in
[0015](../adr/0015-bounded-fleet-orchestration.md).

## Core Concepts

- `Subtask`: child work item of exactly one task. Always title + optional description; optionally a `prompt` (which makes it startable); optionally linked chat sessions.
- `SubtaskDependency`: directed edge between two subtasks of the same task. Never crosses tasks, never cycles.
- `BoardColumn`: named column in one of four fixed categories: `backlog`, `pending`, `in-progress`, `done`. Global, ordered, user-configurable.
- Category semantics — not column names — drive all automation.
- The legacy `MiniTask` concept folds into `Subtask`: review-created work uses
  `origin: "review"`, not a separate record type.
- `TaskRecipeRecord`: an ordered, key-addressed subtask/DAG template. It creates
  product records but never starts them.

## Column Model

```ts
export const COLUMN_CATEGORIES = ["backlog", "pending", "in-progress", "done"] as const;
export type ColumnCategory = (typeof COLUMN_CATEGORIES)[number];

export interface BoardColumnRecord {
  readonly columnId: ColumnId;
  readonly name: string;               // "Review" — cosmetic, user-editable
  readonly category: ColumnCategory;   // drives every behaviour rule
  readonly sortOrder: number;
}
```

Column rules:

- Migration seeds the defaults: Backlog (`backlog`), ToDo (`pending`), Blocked (`pending`), In Progress (`in-progress`), Review (`done`), Finished (`done`).
- Columns can be added, renamed, re-ordered, and deleted within their category. Every category keeps at least one column. Deleting a column moves its cards to the nearest column of the same category.
- `WorkTaskRecord.state` is replaced by `columnId` (+ optional `doneAt`). Migration maps `todo→ToDo`, `in-progress→In Progress`, `blocked→Blocked`, `review→Review`, `done→Finished`.
- The first `done`-category column is the automation target ("Review" by default).
- `doneAt` is stamped when a card enters a `done` column and cleared when it leaves.

## Subtasks And Dependencies

```ts
export interface SubtaskRecord {
  readonly subtaskId: SubtaskId;
  readonly taskId: TaskId;             // owning task — dependencies never leave it
  readonly title: string;
  readonly description?: string;
  readonly prompt?: string;            // present ⇒ startable
  readonly origin: "manual" | "review";
  readonly autoStart: boolean;         // opt-in cascade: start when dependencies finish (default false)
  readonly columnId: ColumnId;
  readonly sortOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly doneAt?: string;
  readonly seedMode?: "local" | "upstream";
  readonly model?: { providerId: string; model?: string };
  readonly verifyMode?: "hitl";
  readonly verifiedAt?: string;
}

export interface SubtaskDependencyRecord {
  readonly taskId: TaskId;             // denormalised guard: both endpoints in this task
  readonly fromSubtaskId: SubtaskId;   // upstream  (output dot)
  readonly toSubtaskId: SubtaskId;     // downstream (input dot)
  readonly createdAt: string;
}
```

Dependency rules:

- Both endpoints of an edge must share `taskId`. The service validates same-parent, no self-edge, no duplicate, and acyclicity on insert; the board UI enforces the same boundary by greying out and de-dotting every card outside the parent task during a connection drag.
- Blocked is computed, never stored: a card is blocked while any upstream subtask is not in a `done`-category column. The blocked badge renders wherever the card sits; the default "Blocked" column is just a manual parking spot.
- Linking to an already-done sibling is allowed — the dependency is satisfied on creation and only documents order.
- Deleting a subtask deletes its edges. Deleting a task cascades subtasks and edges (same pattern as the existing link cascade in `workTaskStore`).
- Sessions link to subtasks by adding an optional `subtaskId` to session-target `WorkTaskLinkRecord`s.

## Orchestration

- Starting a subtask with a prompt spawns a chat session linked to the parent task and the subtask, sends the prompt as the first turn, and moves the card to the first `in-progress` column. Subtask automation always uses clone mode: one independent disposable clone workspace per subtask, never live implementation mounts.
- A durable `TaskClonePolicy` selects exactly one linked workspace set, a non-empty ordered subset of its project IDs, and dirty handling (`carry` or `fresh`). Manual starts in either task surface use native VS Code UI to choose projects (saved selection, otherwise all by default), preflight the repos, prompt when any is dirty, then save the policy. Auto-cascades do not prompt; they re-read and revalidate the saved policy.
- `carry` includes current tracked and untracked local changes. `fresh` means the current **local committed HEAD** only; task start does not fetch or pull a remote. Zero/multiple linked sets and missing, empty, or stale policies fail actionably rather than falling back to an empty workspace.
- Completion is event-driven: on the product bus `turn-completed` with status `completed` for a session linked to a subtask, the card moves to the first `done` column (Review), `doneAt` is stamped, and dependents are evaluated. No polling.
- Dependent evaluation: a downstream subtask auto-starts iff its `autoStart` flag is set (per-subtask opt-in, default false), all of its upstreams are done, it has a prompt, it is not already running or done, and it is not in a `backlog`-category column. All eligible dependents are offered together; actual starts follow the slot budget and durable queue in ADR 0015.
- A dependent without a prompt cannot auto-start; when its upstreams finish it just unblocks (badge clears, toast).
- A cancelled or manually-started failed run stays a human concern and never
  auto-retries. A failed cascade run retries once, then parks durably; a manual
  Retry clears that policy state. Parked dependents do not cascade.
- Starting a card never starts its dependencies. Manual start is disabled while any upstream is unfinished; an explicit Force start override exists for that case (manual only — automation never forces). Starting a task starts its ready subtasks (dependencies done, prompt present, not in backlog) after a count confirmation; any cascade beyond that happens through per-subtask `autoStart` flags.
- Manual drags always win. Dragging a card into a `done` column counts as finishing and runs dependent evaluation; dragging it out clears `doneAt` but never cancels dependents already started.
- Nothing ever moves into a Finished column automatically — Review → Finished is a human drag.

### Recipes and standing task policy

- `＋ Recipe…` previews a seeded or read-only workspace recipe, asks for the
  task title, then creates the task, subtasks, defaults, and DAG. It never
  starts a session. `.drydock/recipes.json` overlays merge at read time only
  for a trusted VS Code workspace and cannot be edited or archived from the app.
- Recipe steps may set prompt, auto-start, clone seed, provider/model, and
  human-verification requirements. These are workflow defaults, not grants;
  normal clone selection, mount policy, and approval rules still apply.
- Task FAQ entries are case-insensitive pattern → answer rows. Effective
  auto-answer requires both the task toggle and the global setting. Answers
  use the normal question-resolution path and leave a host-authored transcript
  receipt. Access requests never use this mechanism.

### Human verification

`verifyMode: "hitl"` is unmet when a subtask sits in a done-category column
without `verifiedAt`. The board shows `verify` at every density level and a
human action stamps it. This is a visible requirement, not a test runner and
not agent self-approval; Review → Finished remains a human move.

## Task Board Panel

- Editor-area webview panel `drydock.taskBoard`, single instance, opened via `drydock.taskBoard.open` and from the Tasks tab. It follows the other editor panels' strict CSP and validated-message shape. Vanilla TS, `textContent`-only rendering.
- Tasks and subtasks are independent cards; both drag freely between columns. Task cards show workspace-set and clone/isolation context plus progress; subtask cards show parent colour, dependency dots, prompt/chat state, and computed workflow state.
- A per-panel `minimal | standard | full` Detail control follows ADR 0013.
  Minimal keeps the title and at most one state chip (verify → running →
  parked → failed → queued → blocked); one hover/focus card carries the rest.
  Standard restores active workflow chips; full adds passive configuration and
  dates. `drydock.ui.cardDetail` provides the default.
- Dependency edges render on an SVG overlay tinted by parent task, shown for the hovered/selected card by default with a show-all toolbar mode. Click an edge to select; a midpoint handle deletes. Esc cancels an in-flight connection drag; a drop that would create a cycle is rejected with feedback and nothing is written.
- Toolbar: workspace-set filter, task focus filter, age dropdown ("hide finished older than N days", default 1), connections mode, detail, column settings, new task, and recipe creation.
- The age filter hides `done`-category cards whose `doneAt` is older than the selected age behind a per-column "N hidden" affordance, so old finished work stays reachable.

## Sidebar Changes (Tasks Tab)

- Rename the drawer "Chats needing a task" to "Orphaned Chats" (label and live-count string in `workTab.ts`).
- Memory keeps pending-candidate cards (approve/reject) and gains a Memories list of approved entries. Clicking one opens a read-only virtual document (`drydock-memory:` scheme via a `TextDocumentContentProvider`, same pattern as the baseline content provider) showing content, status, dates, and a source-session link. New `memory.open` request; a later iteration adds revoke (approved → rejected).
- Task cards gain a subtask checklist with computed status pills, an add-subtask input, a column pill replacing the state `<select>`, the same clone/isolation chip as the Task Board, and "Open on board" entry points.

## Protocol Additions

- Requests include `board.state`, card/column mutations, subtask CRUD and
  dependencies, subtask/task starts, recipe list/materialization, task FAQ
  management, and human verification updates.
- Pushes: one coarse `board.changed` (the panel re-fetches `board.state`, mirroring `planDocs.updated`); the existing `chat.turnCompleted` push keeps driving live run badges.
- Every new inbound message passes the single validation gate (`parsePanelRequest`) per ADR-0006.

## Storage And Migration

- Primary-store additions include `board_columns`, `subtasks`,
  `subtask_dependencies`, `task_recipes`, `task_faqs`, and `subtask_holds`;
  `work_task_links` gains nullable `subtask_id`; task/subtask rows carry the
  additive clone, seed, model, verification, and FAQ-toggle fields. Changeset
  storage is described in ADR 0014. Migrations remain forward-only.
- Column config is product state in the store — identical wherever the board opens. The board's toolbar settings (age filter, task focus, connections mode) currently persist per panel via webview state; promoting them to product state is a noted later item.

## Known Boundaries

- Code-dependent chains use the user-selected durable changeset seeding in ADR
  0014. There is no task integration clone, and automation never chooses
  upstream seeding on the user's behalf.
- Age filter vs Review: "hide if complete" includes Review (a `done` column). Specified as hide-with-counter in every `done` column so unreviewed work cannot silently vanish; the alternative is exempting Review entirely.
- Review counts as done for dependencies, so dependents fire before a human has reviewed the upstream. Pulling a card back out of `done` does not cancel runs already started.
- Human verification is metadata only: it does not yet execute tests or block a
  dependent from using an upstream that has reached Review.
- Clone workspace state is process-local. Resume recreates a clone from local
  HEAD without replaying prior seeds; the durable queue survives, not the
  disposable workspace.
