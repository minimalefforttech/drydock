# Planner

The full planning workspace (ADR 0012): one editor-area panel that replaces
the composer's old [Plan | Develop] switch and the per-session plan-docs
surface. The user says what they're building, picks the angles that matter,
mounts context read-only, and reviews what the agent drafts — documents,
diagrams, images, and clickable HTML prototypes — with click-to-instruct
feedback on every block, node, point, and region.

## The plan entity

A Plan owns: a brief ("what are you building"), selected aspects, read-only
context roots, free-text pre-information, at most one chat session, collected
artifacts, and annotations. Plans are durable rows (`planner_plans`); sessions
are disposable. Creating a plan (or reviving a dormant one) boots a planning
session whose first turn carries a composed briefing: the brief, per-aspect
instructions with expected artifacts, the file conventions, and the
pre-information.

### Aspect registry

Aspects are data, not code (`planner_aspects`): id, label, briefing
instructions, expected artifacts. The migration seeds ten (requirements,
architecture, data model, APIs, UI/UX, testing, security, performance,
rollout, operations); the panel's manager adds, edits, and archives rows, so a
department grows its own angles. A repo may also carry a read-only pack in
`.drydock/planner-aspects.json` — merged at read time, never persisted, and a
stored row wins an id collision. Aspect ids are slugs because they double as
the `plan/<aspectId>/` collection subdirectory.

## Persistence: collect + hydrate

The agent writes only under its workspace `plan/` directory. That workspace is
a host directory bind-mounted into the microVM, so a sandbox crash mid-write
loses nothing. Durability comes from **collection**: after every turn — and on
panel open, which catches turns whose completion the host never saw — the host
reads `plan/` into the store. Text kinds (documents, diagrams, prototypes)
land inline in SQLite; images go through the content-addressed blob store and
keep only their digest. Revisions bump only on content change; deleting a file
never deletes its row; artifact ids, title overrides, and the prototype
scripts flag survive re-collection.

A fresh session for an existing plan is **hydrated**: the store's artifacts
are materialized back into the new workspace `plan/` before the first turn, so
the agent always revises current state. Nothing depends on graceful shutdown.

Collection bounds (skip, never truncate): 40 files per plan, text ≤ 256 KB,
images ≤ 5 MB. Accepted kinds: `.md` document, `.mmd`/`.mermaid` diagram,
`.png/.jpg/.jpeg/.svg/.webp` image, `.html` prototype. Titles resolve
manifest (`plan/manifest.json`) → first markdown H1 → humanized filename; a
user rename overrides permanently.

## The panel

Three columns, sides swappable (⇄), each rail collapsible to an icon strip,
both auto-collapsing under ~900px with fly-out overlays; layout preferences
persist as UI-local webview state.

- **Outputs rail** (left by default): artifacts grouped by aspect with
  friendly titles, kind glyphs, revision badges, "updated" flashes, and
  open-note counts; hover-rename per row. Below a draggable splitter, the
  active document's **heading outline** (click scrolls to the block);
  non-document artifacts list their annotations there instead. Header aspect
  chips filter the tree.
- **Viewer** (center): one `ArtifactProvider` per kind behind a common seam —
  render plus `focusAnchor`. Documents render structural markdown in the
  design-doc language (kicker, tight headings, quiet rules) with hover ✎ on
  every block. Diagrams render through the shared lazy mermaid bundle with
  sanitized SVG adoption; a click on a `g[id]` node anchors `node:<id>`
  (render ids are deterministic per artifact so anchors survive re-renders),
  empty canvas anchors a point. Images and prototypes share a pin/region
  overlay in normalized 0–1 coordinates. Prototypes render in a sandboxed
  `iframe srcdoc` — never `allow-same-origin`; `allow-scripts` only via the
  per-artifact toggle — with Preview (page gets the pointer) and Annotate
  (overlay captures it) modes.
- **Chat rail** (right by default): the plan session's transcript, folded and
  rendered by the same shared chat components as the Chat tab
  (`webview-ui/src/chat/transcriptModel.ts` + `messageRow.ts`), with live
  streaming via forwarded bus events, `session.timeline` backfill, a composer,
  and Stop.

## The instruction loop

Every provider emits annotations through one grammar — `block:<n>`,
`node:<id>`, `point:<x>,<y>`, `region:<x>,<y>,<w>,<h>` — into one store
(`planner_annotations`). States: open → delegated → resolved / reopened, with
wont-fix for parking. "Send instructions" composes every open annotation into
a single revision turn (artifact title, `plan/` path, human anchor, body),
flips them to delegated stamped with the artifact revision they were written
against, and fires the turn detached. When a later collection bumps that
artifact's revision, the delegated card asks "addressed in rev N?" — resolve
or reopen, never auto-closed. Regenerate re-sends the briefing for the whole
plan or one aspect's subdirectory.

## Sessions and modes

A planning session is an ordinary chat session started with the internal
`plan` mode: context roots mount read-only, the workspace stays read-write,
and neither agent adapter changes at all — read-only is container-enforced
(ADR 0001), exactly like role spawns, which remain the mode's other producer.
Slow host work (create, session boot) acks immediately and completes via the
`planner.sessionReady` push (ADR 0011's lesson: sandbox boots outlive the
webview request timeout). The session also appears in the Chat tab; either
surface may drive it.

## Retired

The composer mode switch, its persisted `composerMode`, the Work tab's unused
session-mode select, the plan-docs pill, panel, service, store, and the
`planDocs.*` message family are gone; retired `planDocs.*` requests now fail
the parse boundary. The `plan_docs` table is orphaned-legacy (kept per the
additive migration policy). Chat sessions always run implementation mode.

## Verification

Unit: contract parse accept/reject per message, anchor grammar round-trips,
store reopen durability, collector bounds/revisions/titles/aspects, hydrate →
collect round-trips, briefing and instruction-turn composition, aspect
registry rules. Harness (`tools/webview-harness/planner.html`, rows V52–V56):
landing/intake, tree + splitter + outline, all four providers, layout system,
and the chat rail on the shared components — plus the Chat tab's own rows,
which must not regress. Live checks that need a real window: the crash drill
(kill the sandbox mid-turn; reopen collects everything written), `vscode.open`
artifact jumps, and prototype frames under the real webview CSP.
