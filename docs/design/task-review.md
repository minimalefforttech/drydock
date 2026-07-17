# Cross-Project Task Review

Related: roadmap, `workflow-scenarios.md` (scenario #1), `clone-mode.md`.

## Purpose

An engineer runs a task spanning N repos, worked by one or more AI chats.
Before committing/PRing each repo they open ONE **Task Review** surface and see
every changed file across all the task's projects, review each in the real
editor, add comments, and **Send N comments to M sessions** - the comments go back to
the owning session(s) as revision turns. Agents revise; changes reappear;
repeat; then the developer does their normal git commit + PR.

PR still remains the proper review before release, but this surface lets a
developer review multi-project changes before pushing. The win is cognitive:
one review surface instead of jumping between per-session chats and windows.

**Task Review NEVER commits or pushes - PR stays the release gate.** Its scope
is cross-project review; fleet roles and session status live in the Agents
panel, while plan export remains separate work.

## Design: a VIEW over existing state, not new storage

Everything aggregates what already exists; no new tables.

| Concern | Reused machinery |
|---|---|
| Task → sessions link | `TaskService` links (`work_task_links`), `WorkTaskSummary.linkedSessionIds` |
| Changed files (baseline sessions) | `WorkspaceReviewAppService.diffStatus(sessionId)` → `SessionDiffService.listBaselines`/`computeDiff` (Myers line stats, per-root grouping via `rootName`) |
| Changed files (clone sessions) | `IsolatedRunService.cloneState(sessionId)` → `CloneRepoState` per repo |
| Diff viewing | `diff.openFile {baselineId, path}` → `vscode.diff` baseline↔current via `baselineContentProvider` (`drydock-baseline` scheme) |
| Comments | `CodeReviewService` via `WorkspaceReviewAppService.reviewState/addComment/setCommentStatus` - per-session `current-session` review scope, statuses open/acknowledged/delegated/resolved/wont-fix/blocked |
| Submit → revision loop | Core `composeReviewCommentTurn`, dispatching one guarded revision turn per owning session |
| Panel shape | Editor-area `WebviewPanel` per task with strict CSP - no Mermaid here, so no `unsafe-inline` deviation |

### Comment anchor convention

Task-review comments are stored in the OWNING session's review scope with the
file path qualified by project: `<repo>:<path>` (repo = the baseline root's
basename, matching `DiffFileSummary.rootName` / `CloneRepoState.name`). This
mirrors plan-docs' `plan:<doc>` convention and keeps cross-repo anchors
unambiguous inside one session's comment list. Legacy plain-path comments
(from the Changes → Comments form) remain valid: per-file comment counts match
either the qualified or the plain form, and Submit sends every open non-`plan:`
comment regardless of form. Known cosmetic limit: a plain-path comment in a
multi-root session badges same-named files in each root; the comment itself is
sent once.

### Authorship

Review comments preserve who produced the finding: `user`, `agent-reviewer`,
or `guard`. Webview comment creation always yields `user`; only trusted
host-side reviewer/guard flows may choose a machine author. The dock labels
non-user comments with an `agent` or `guard` badge, so automated findings are
never visually attributed to the developer.

### "Opened" state (v1 decision)

Lean: no new persistence. The webview tracks per-file "diff opened" in
panel-session state and distinguishes unopened, opened with comments, and
opened with no open comments. These markers do not imply approval. An explicit
per-file review decision is deferred until it earns its keep.

### Clone sessions (v1 scope)

Baseline-backed implementation sessions integrate fully (native diff +
gutter comments). Clone-mode sessions list their agent-changed files with a
`clone` marker; clicking deep-links to that session's clone working set
(sync/pull happens there, per `clone-mode.md`). Full native-diff+comment for
clone files needs a clone-base content provider over `refs/sync/base` - a
noted fast-follow, not built yet. A clone session that is not live in this
window cannot report its file list (`sessionClones` is process state); the
review surfaces that as a note rather than silently showing nothing.

## Contracts

Requests (webview → host, through `parsePanelRequest` like everything else):

- `taskReview.open {taskId}` - host action: open (or reveal) the task's review
  panel. Sent by the control panel's Tasks tab; responds `{accepted: true}`.
- `taskReview.state {taskId}` → `{state: TaskReviewState}` - the aggregated
  projection below.
- `taskReview.submit {taskId}` → `{dispatched, sessions, errors?}` -
  `dispatched` = comments delegated, `sessions` = sessions that received a
  revision turn, `errors` = display strings for sessions that could not
  receive one (their comments stay `open`).

Push (host → webview, panel-scoped): `taskReview.updated {taskId}` - fired
when a linked session starts or completes a turn (and on session deletion), so
an open panel refetches state. Content never rides the push.

Projections (display-safe, house rules: optional fields spread in only when
set):

```ts
TaskReviewFile {
  sessionId, sessionTitle: string;
  baselineId?: string;          // absent on clone files
  repo: string;                 // project display name (root basename)
  path: string;                 // root-relative, forward slashes
  changeKind: DiffChangeKind;   // add | modify | delete | rename
  addedLines?, removedLines?: number;
  commentCount: number;         // open comments anchored to this file
  conflicted?: boolean;         // clone file with unresolved sync markers
  clone?: boolean;              // review via the owning session's sync UI
}
TaskReviewProject { name: string; files: TaskReviewFile[] }
TaskReviewSessionRef { sessionId, sessionTitle: string }
TaskReviewState {
  taskId, title: string;
  sessions: TaskReviewSessionRef[];     // every resolvable linked session, in
                                        // link order - including zero-file ones,
                                        // so the dock can read their comments
  projects: TaskReviewProject[];        // grouped by repo across sessions
  openCommentCount: number;             // everything Submit would send
  revisionInFlight?: number;            // linked sessions running a turn
  notes?: string[];                     // degraded-fetch honesty lines
}
```

## Submit semantics

For each linked session with ≥1 open non-`plan:` comment:

1. Compose the revision turn with `composeReviewCommentTurn` (core): open
   comments as `- <repo>:<path>:<line[-range]> - <body>` under a `[host]`
   header; composing flips them to `delegated`.
2. Live session: guard no-active-turn, then `sendChatTurn` detached through
   the standard session path.
3. Ended/failed session: resume first via the existing
   `resumeChatSession` path with an auto workspace context (open folders,
   session's stored mode), then send. Sessions running elsewhere (fresh
   foreign heartbeat) or unresumable (no matching folders open) are skipped:
   their comments stay `open` and the response carries an error line.
4. Comments are delegated per-session only when that session's turn actually
   dispatches - a skipped session's comments must not silently vanish from
   the next submit.

The revision-in-flight indicator derives from `hasActiveChatTurn` across
linked sessions at state-computation time; `taskReview.updated` on turn
start/completion keeps it honest without polling.

## UX

The panel is a **navigator + dock; review happens in native editors**.

- Left: projects → changed files (change glyph, `+N −M`, comment-count badge,
  clone/conflict markers, opened indicator).
- Right/bottom: comment dock - all open threads for the task grouped by file,
  click-to-jump to the file's diff.
- Header: task title, "Send N comments to M sessions", revision-in-flight
  status, refresh.
- Clicking a file: baseline-backed → `vscode.diff` (Beside) via the existing
  `diff.openFile` flow. Clone rows are informational in v1 (clone chip,
  conflict marker, stats, owning-session tooltip naming where to pull/discard);
  the click-through deep-link to the owning session's sync working set rides
  the clone-diff fast-follow - there is no cross-panel "select session" push
  contract today, and inventing one for a marker row is not worth the churn.
- Commenting: native `vscode.comments.createCommentController` threads in the
  diff editor gutter, two-way synced to the review store with the
  `<repo>:<path>` anchor. This is an editor-only surface that requires guided
  manual verification against the real VS Code comment gutter rather than the
  browser test harness. The dock also allows adding/resolving comments directly
  (webview path) so the loop works even without gutter interaction.
- Opened from a **Review** button on Tasks-tab task cards.

## Isolation & threat posture

Nothing here widens agent reach: the panel reads projections and writes
comments/turn prompts through existing guarded paths (`parsePanelRequest`
boundary, per-session review scopes, `sendChatTurn` guards). No mounts, no
runtime handles, no host paths beyond display strings cross the boundary. The
submit loop can only send text to sessions the task already links. Webview
rendering stays textContent-only with the strict control-panel CSP.

## Deferred (recorded, not built)

- Clone-base content provider (`refs/sync/base`) for native clone-file diffs.
- Explicit per-file "mark reviewed" persistence.
- Plan-doc export to repo (backlog).
