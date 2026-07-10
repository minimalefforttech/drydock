# Task Board And Subtasks

## Purpose

Tasks currently carry a flat five-value state and link whole chat sessions. That is too coarse for multi-step work: there is no way to break a task into orderable pieces, no way to express "start B when A finishes", and no surface that shows work in flight across tasks.

This doc specifies subtasks, dependency-driven auto-start, and the Task Board editor panel, plus two small Work-tab changes shipped alongside (see Sidebar Changes). The durable decisions live in ADR [0007](../adr/0007-task-board-subtasks-and-auto-start.md).

## Core Concepts

- `Subtask`: child work item of exactly one task. Always title + optional description; optionally a `prompt` (which makes it startable); optionally linked chat sessions.
- `SubtaskDependency`: directed edge between two subtasks of the same task. Never crosses tasks, never cycles.
- `BoardColumn`: named column in one of four fixed categories: `backlog`, `pending`, `in-progress`, `done`. Global, ordered, user-configurable.
- Category semantics — not column names — drive all automation.
- `MiniTask` from `work-management.md` folds into `Subtask`: review-created mini tasks become subtasks with `origin: "review"`. Amend that doc when this lands.

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
- Dependent evaluation: a downstream subtask auto-starts iff its `autoStart` flag is set (per-subtask opt-in, default false), all of its upstreams are done, it has a prompt, it is not already running or done, and it is not in a `backlog`-category column. All eligible dependents are dispatched together; actual concurrency follows the run-slot policy (see Open Questions).
- A dependent without a prompt cannot auto-start; when its upstreams finish it just unblocks (badge clears, toast).
- `failed` / `cancelled` runs leave the card in place with a failed badge and do not trigger dependents. Restart is manual.
- Starting a card never starts its dependencies. Manual start is disabled while any upstream is unfinished; an explicit Force start override exists for that case (manual only — automation never forces). Starting a task starts its ready subtasks (dependencies done, prompt present, not in backlog) after a count confirmation; any cascade beyond that happens through per-subtask `autoStart` flags.
- Manual drags always win. Dragging a card into a `done` column counts as finishing and runs dependent evaluation; dragging it out clears `doneAt` but never cancels dependents already started.
- Nothing ever moves into a Finished column automatically — Review → Finished is a human drag.

## Task Board Panel

- New editor-area webview panel `drydock.taskBoard`, single instance, opened via `drydock.taskBoard.open` and from the Work tab. Clones the plan-docs panel host pattern with the task-review panel's strict CSP (no `unsafe-inline`); new esbuild bundle pair `taskBoard.ts` / `taskBoard.css` in `tools/bundle-extension.mjs`. Vanilla TS, `textContent`-only rendering.
- Tasks and subtasks are independent cards; both drag freely between columns. Task cards show workspace-set chips, a concise clone/isolation chip (`clone · all 3` or `clone · 2/3 · carry`), and subtask progress; subtask cards show a parent-task colour stripe, input/output dots, prompt/chat glyphs, an auto-start indicator, and the computed blocked badge.
- Dependency edges render on an SVG overlay tinted by parent task, shown for the hovered/selected card by default with a show-all toolbar mode. Click an edge to select; a midpoint handle deletes. Esc cancels an in-flight connection drag; a drop that would create a cycle is rejected with feedback and nothing is written.
- Toolbar: workspace-set filter, task focus filter, age dropdown ("hide finished older than N days", default 1), connections mode, column settings, new task.
- The age filter hides `done`-category cards whose `doneAt` is older than the selected age behind a per-column "N hidden" affordance, so old finished work stays reachable.

## Sidebar Changes (Work Tab)

- Rename the drawer "Chats needing a task" to "Orphaned Chats" (label and live-count string in `workTab.ts`).
- Memory keeps pending-candidate cards (approve/reject) and gains a Memories list of approved entries. Clicking one opens a read-only virtual document (`drydock-memory:` scheme via a `TextDocumentContentProvider`, same pattern as the baseline content provider) showing content, status, dates, and a source-session link. New `memory.open` request; a later iteration adds revoke (approved → rejected).
- Task cards gain a subtask checklist with computed status pills, an add-subtask input, a column pill replacing the state `<select>`, the same clone/isolation chip as the Task Board, and "Open on board" entry points.

## Protocol Additions

- Requests: `board.state`, `board.moveCard`, `board.columns.update`, `subtask.create` / `subtask.update` / `subtask.delete`, `subtask.dependency.add` / `subtask.dependency.remove`, `subtask.start {mode}`, `task.start {mode}`, `memory.open`.
- Pushes: one coarse `board.changed` (the panel re-fetches `board.state`, mirroring `planDocs.updated`); the existing `chat.turnCompleted` push keeps driving live run badges.
- Every new inbound message passes the single validation gate (`parsePanelRequest`) per ADR-0006.

## Storage And Migration

- New tables in the primary store: `board_columns`, `subtasks`, `subtask_dependencies`; `work_task_links` gains a nullable `subtask_id`; `work_tasks.state` becomes `column_id` with the seeded defaults. Nullable clone-policy columns are additive for existing task rows. Forward-only migration in `packages/storage-sqlite/src/migrations.ts`.
- Column config is product state in the store — identical wherever the board opens. The board's toolbar settings (age filter, task focus, connections mode) currently persist per panel via webview state; promoting them to product state is a noted later item.

## Open Questions

- **Integration gap for code-dependent chains:** isolation prevents sibling
  agents from stepping on one another, but a completed clone run does not yet
  merge its change set into a task-level integration workspace. A dependent
  clone therefore starts from the task's local source, not automatically from
  its upstream agent's output. Until durable change sets + an integration
  workspace land, keep `autoStart` off for chains whose prompts require upstream
  code; review/pull the upstream result, then start the dependent manually.
- Age filter vs Review: "hide if complete" includes Review (a `done` column). Specified as hide-with-counter in every `done` column so unreviewed work cannot silently vanish; the alternative is exempting Review entirely.
- Review counts as done for dependencies, so dependents fire before a human has reviewed the upstream. Pulling a card back out of `done` does not cancel runs already started.
- Parallel starts vs the single-flight run slot — resolved during implementation: the `runInFlight` guard covers only the legacy prompt-run/probe surface (`isolatedRunService.startPromptRun`). Chat-backed subtask runs go through `ChatSessionService`, which supports many concurrent sessions (serialization is one active turn per session), so auto-started dependents genuinely run in parallel and no slot widening is needed.
- Should failed runs optionally auto-park in a `pending` column after N failures instead of staying put?
