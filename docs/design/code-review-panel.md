# Code Review Panel (in-panel PR-style review)

Related: `task-review.md` (v1 navigator + native editors — the surface this
evolves), `clone-mode.md`, `work-management.md`, roadmap.
Visual prototype: [`prototypes/code-review-panel.html`](prototypes/code-review-panel.html)
(the pre-implementation exploration; the shipped panel supersedes it — notably
commenting is selection-driven now, not the prototype's "add another range"
button). Implementation: `webview-ui/src/codeReview.ts` + `codeReview.css`,
`src/webview/codeReviewPanelProvider.ts`, `src/services/codeReviewAppService.ts`;
harness page `tools/webview-harness/codeReview.html` (check V72).

## Purpose

The developer is the lead; the agents are the team. When the team's work is
ready, the lead reviews it the way they review any teammate's work: one
scrollable pull-request-style surface — every changed file in order, inline
diffs, click a line (or select several ranges) to leave a comment, and the
comments go back to the owning agent as revision instructions. Agents revise,
the diff refreshes, repeat, then the developer commits and PRs as usual.

Task Review v1 (`task-review.md`) proved the loop but reviews happen in
scattered native diff editors with a separate comment dock. This panel is the
**alternative in-panel surface**: GitHub/GitLab-style continuous review,
optimized for reading a whole task's worth of small-to-medium diffs in one
sitting. Native per-file diff editors remain one click away for deep work.

**Never commits or pushes — PR stays the release gate** (unchanged from v1).

## Design: same data spine as v1, new projection depth

Everything reuses the v1 machinery; the only genuinely new host capability is
serving *diff content* (hunks, image bytes, byte sizes) to the webview instead
of only per-file stats.

| Concern | Reused machinery | New |
|---|---|---|
| Task → sessions → files | `TaskService` links; `WorkspaceReviewAppService.diffStatus` → `SessionDiffService` baselines | — |
| Diff content | Baseline blobs (`BlobStore`, sha256) + live tree | `codeReview.fileDiff` projection: hunk rows computed host-side (Myers, shared with line stats) |
| Uncommitted scope | `DiffScope` already includes `workspace`; clone-mode's git helpers | Thin `GitStatusDiffProvider`: `git status --porcelain -z` + `git diff HEAD` per project root |
| Comments | `CodeReviewService` records (`startLine`/`endLine` ranges exist today), statuses, `<repo>:<path>` anchors, authorship badges | Optional `anchors[]` (multi-range note) + optional `side` (old/new), additive columns |
| Submit → revision loop | `composeReviewCommentTurn` + per-session dispatch, resume-then-send, skip semantics | Quoted diff excerpt (±3 rows) appended per anchor |
| Refresh push | `taskReview.updated` on turn start/complete | Debounced FS/git watcher for the uncommitted scope (300 ms, like `board.changed`) |
| Panel shape | Editor-area `WebviewPanel`, strict CSP, textContent-only rendering | — |

## Scopes

A header seg — `[All uncommitted | Task | Session]` — switches what the panel
diffs; all three render through the same tree + file-card pipeline.

- **Task** (default): the union of the task's linked sessions'
  `current-session` baselines — exactly v1's file set, grouped by repo. Every
  file knows its owning session, so comments route precisely.
- **Session**: the primary session's changes only (the most recently linked
  session with changed files) — the "review just this teammate" lens.
- **All uncommitted**: `git` working tree + index vs `HEAD` for every project
  root open in this window. Untracked files render as adds. This is the "what
  would I be committing" lens — it includes hand edits the developer made
  alongside the agents. Files here have no per-session owner, so comments
  route to the task's **primary session**; the Send button's tooltip names
  the target so routing is never a surprise.

Files present in both scopes carry the same `<repo>:<path>` anchor, so a
comment written in one scope is visible in the other.

## Contracts

Requests (webview → host through `parsePanelRequest`, as always):

- `codeReview.open {taskId}` — open/reveal the task's panel (relayed through
  the `drydock.codeReview.open` command).
- `codeReview.state {taskId, scope}` → `{state: CodeReviewPanelState}` —
  projects + per-file summaries, **no content**.
- `codeReview.fileDiff {taskId, scope, repo, path, baselineId?,
  ignoreWhitespace?}` → `{repo, path, diff: ReviewFileDiff}` — one file's
  renderable diff, fetched lazily as cards approach the viewport
  (`baselineId` rides along from the state so the host never recomputes it).
- `codeReview.addNote {taskId, scope, body, anchors: [{repo, path,
  startLine, endLine, sessionId?}]}` → `{comments}` — one note, one or more
  ranges; the host stores one comment record per anchor on the anchor's
  owning session (falling back to the primary session).
- `codeReview.setCommentStatus {commentId, status}` — reuse of v1 semantics.
- Submit reuses `taskReview.submit {taskId}` verbatim — v1 semantics
  (delegate on dispatch only, resume ended sessions, skip
  elsewhere/unresumable with honest errors).
- `codeReview.sendOne {commentId}` — the teammate-fast path (dispatch one note
  immediately without batching): deferred, see below.

Push (host → webview, panel-scoped): `codeReview.updated {taskId?}` on linked
turn start/completion, session deletion, and (uncommitted scope) debounced
git/FS change.

Projections (display-safe; optional fields spread in only when set):

```ts
CodeReviewFile {
  repo, path: string;
  changeKind: DiffChangeKind;         // add | modify | delete | rename
  oldPath?: string;
  addedLines?, removedLines?: number; // absent for binary/oversized
  contentKind: "text" | "image" | "binary" | "oversized";
  bytesBefore?, bytesAfter?: number;  // image + binary rows
  commentCount: number;
  sessionId?, sessionTitle?: string;  // task scope: owning session
  clone?, conflicted?: boolean;
  largeDiff?: boolean;                // collapse-by-default hint (host rule)
}
CodeReviewTreeNode {                   // sidebar folder hierarchy, compressed
  label: string;                       // "src/exporters" — single-child chains joined
  files: CodeReviewFile[];
  children: CodeReviewTreeNode[];
}
CodeReviewProject { name: string; tree: CodeReviewTreeNode; fileCount: number;
                    addedLines: number; removedLines: number }
CodeReviewState {
  taskId?, title: string;
  scope: "task" | "uncommitted";
  projects: CodeReviewProject[];
  openCommentCount: number;
  primarySession?: TaskReviewSessionRef; // uncommitted-scope routing target
  revisionInFlight?: number;
  notes?: string[];                      // degraded-fetch honesty lines
}

ReviewFileDiff =
  | { kind: "text"; hunks: ReviewHunk[]; truncated?: boolean }
  | { kind: "image"; beforeDataUri?, afterDataUri?: string;
      bytesBefore?, bytesAfter?: number }   // data URIs capped ~1.5 MB each;
                                            // over cap → byte fallback + note
  | { kind: "binary"; bytesBefore?, bytesAfter?: number }
  | { kind: "oversized"; reason: string }   // blob cap etc. — open in editor
ReviewHunk { oldStart, oldLines, newStart, newLines: number;
             rows: ReviewRow[] }
ReviewRow  { kind: "context" | "add" | "del"; oldNo?, newNo?: number;
             text: string }                 // rendered via textContent ONLY
```

Whitespace hiding is a **host-side recompute** (`ignoreWhitespace` on
`fileDiff`), so raw file pairs never cross the boundary; a file whose diff
empties under it renders as a quiet collapsed "Only whitespace changes" row.
Side-by-side is a pure webview render mode over the same hunk rows — no
refetch, no second contract.

## UX

Two columns: **navigator sidebar** (left, resizable) + **review scroll**
(right). Header: task title, scope seg `[Task changes | All uncommitted]`,
options (`Hide whitespace` checkbox, `[Unified | Split]` seg), open-comment
count, `Send N comments to M agents` (primary), revision-in-flight status, ↻.

### Sidebar (navigator)

- One section per project (repo name + `+A −D` totals + file count), then a
  folder hierarchy with **single-child chains compressed** GitHub-style
  (`src/exporters/` as one row, not two). Folders collapse; deep paths
  middle-truncate.
- File rows: change glyph (`±`/`+`/`−`/`→`), `+N −M` stat colors, `💬 N`
  badge, `clone`/`⚠` markers, viewed marker (✓ viewed / ◑ has open comments —
  v1's opened-state vocabulary), and a dim `large` tag on collapse-by-default
  files.
- Click scrolls the review pane to that file card; **scroll-spy** highlights
  the row whose card currently tops the viewport, so the sidebar always says
  "you are here".
- Footer totals: `12 files · +214 −78 · 2 projects`.

### Review scroll (the PR read)

- File cards render **in navigator order** in one continuous scroll — read
  top to bottom, or jump via the sidebar. Each card has a **sticky header**:
  path (click = copy), change chip, `+N −M`, owning-session chip (task
  scope), `Viewed` toggle, `Open in editor` (the native `diff.openFile`
  escape hatch), collapse chevron.
- **Expanded by default**, except: `largeDiff` files (host rule:
  `added+removed > 400` or total rows > 800), generated/lock files
  (`package-lock.json`, `*.min.*`, `dist/`, lockfile heuristics). Collapsed
  cards show one line — `Large diff (+812 −540) — click to expand` — and
  expanding lazily fetches content.
- Text diffs: unified rows (`old │ new │ text`) or split view; hunk separators
  carry `⋯ expand 20 lines` up/down affordances (context expansion via
  `fileDiff.expand`). Per-file row cap ~5 000 with an honest
  `truncated — open in editor for the rest` tail row.
- **Images**: before/after thumbnails side by side with byte sizes under
  each (`24.1 KB → 31.6 KB`); missing side (add/delete) renders one
  thumbnail. Over the data-URI cap → byte-size fallback row + note.
- **Binaries**: one quiet row — `Binary file · 12.4 KB → 13.1 KB (+0.7 KB)`.
- Renames with no content change: header-only card (`old → new`).

### Commenting (the teammate loop) — selection-driven

- **Select code, get the box**: selecting diff rows (click-drag) shows the
  comment box on mouseup, inserted directly under the LAST selected row. The
  selected rows stay highlighted while the note is pending.
- **Multiple sections**: every further selection — same file or another —
  adds a range to the same pending note and the box moves to the newest
  selection. Ranges render as chips (`api:src/publish.py:41-58 ✕`); ✕ drops
  one range. One body, many anchors: the "same fix in three places" comment.
- Composer actions: **Comment** (stores the note via `codeReview.addNote` —
  one comment record per anchor — then hides the box and clears highlights)
  and **Dismiss** (clears everything). `Esc` also dismisses. There is no
  separate "add another range" affordance — selection IS the affordance.
- Existing threads render **inline under their anchored rows**: author badge
  (`user` plain, `agent`/`guard` purple — v1 authorship rules), status
  select (open/acknowledged/delegated/resolved/wont-fix/blocked), delegated
  entries dim with `delegated · rev N`. The navigator 💬 badges and the header
  count stay live. `n`/`p` (and header arrows) jump between open threads.
- On submit/sendOne, the composed turn quotes the anchored diff excerpt
  (±3 rows per anchor) under the `- <repo>:<path>:<start[-end]> — <body>`
  line, so the agent sees exactly what the lead saw. Comments on old-side
  (deleted) rows anchor the old line number with `side: "old"`.

### Keyboard

`j`/`k` next/prev file · `n`/`p` next/prev open thread · `v` toggle viewed ·
`c` comment at the focused row · `x` collapse/expand card · `Esc` close
composer. (Matches GitHub muscle memory where it does not fight VS Code.)

### Persistence

Per panel via `getState`/`setState`: scope, whitespace, unified/split,
sidebar width, viewed-file set (per task+scope), collapsed-card overrides.
Viewed markers remain webview-local (v1's lean decision stands until an
explicit review decision earns persistence).

## Performance

- `codeReview.state` is cheap (stats only). Hunk content is **fetched per
  file, lazily**, as cards approach the viewport (IntersectionObserver with a
  one-screen lookahead; placeholder cards sized from row counts so the
  scrollbar does not jump).
- Off-screen cards beyond ~2 screens swap their row DOM back to placeholders
  (virtualization at file-card granularity — row-level virtualization is not
  needed at the 5 000-row cap).
- Whitespace/scope flips invalidate the per-file cache; refetch is
  per-visible-card, not global.

## Isolation & threat posture

Unchanged from v1 in kind: the panel reads projections and writes comments /
turn prompts through the same guarded paths. New surface area is *content*
crossing the boundary — hunk text and image bytes — which is data the
developer's own editor already displays; it flows host → webview only,
rendered exclusively via `textContent`/`<img src="data:...">` under the strict
CSP (no remote fetch, no inline script). Blob reads stay behind the blob cap;
git invocation is status/diff only (no network transports honored, matching
clone-mode's git posture). The submit loop still reaches only sessions the
task links.

## What happens to v1

The Tasks-tab **Review** button opens this panel. The v1 navigator+dock panel
retires once this ships its first cut; the native-editor path survives as each
card's `Open in editor`, and the VS Code comment-gutter controller keeps
working for people who prefer editor-side review (both write the same comment
store, so the surfaces stay consistent).

## Deferred (recorded, not built)

- `codeReview.sendOne` — single-note immediate dispatch from the composer.
- Sidebar entry point: the Tasks-tab Review button still opens v1; this panel
  opens via `drydock.codeReview.open` (command palette) or the
  `codeReview.open` relay until the switch flips.
- Baseline-scope image *before* thumbnails (needs blob byte access; the after
  side and byte sizes render today, and the uncommitted scope renders both).
- Hunk context expansion ("expand 20 lines") — a future additive `expand`
  input on `codeReview.fileDiff`.
- Intraline (word-level) diff highlights — needs per-row range computation;
  additive to `ReviewRow` later.
- Syntax highlighting — requires an offline highlighter under the strict CSP;
  evaluate a vendored tokenizer once the panel proves itself.
- Per-comment routing picker in uncommitted scope (v1 rule: primary session).
- Clone-file native hunks (rides the `refs/sync/base` content provider
  fast-follow from v1).
- Comment draft persistence across panel reloads.
- Explicit per-file approve/request-changes decision (same deferral as v1).
