# Planner

The plan review workspace (ADR 0012, reshaped by ADR 0020): one editor-area
panel where the user reviews what the planning agent drafts - documents,
diagrams, images, and clickable HTML prototypes - with click-to-instruct
feedback on every block, node, point, and region. Since the calm workbench
retired the sidebar Plan tab, plans are born from the Task Hub's composer,
their overview lives on the hub's Plans card, and the planning conversation
continues in the chat rail; the panel owns everything in between - files,
outline, viewer, and the notes queue.

## The plan entity

A Plan owns: a brief ("what are you building"), selected aspects, read-only
context roots, free-text pre-information, at most one chat session, collected
artifacts, and annotations. Plans are durable rows (`planner_plans`); sessions
are disposable. Creating a plan (or reviving a dormant one) boots a planning
session whose first turn carries a composed briefing: the brief, per-aspect
instructions with expected artifacts, the file conventions, and the
pre-information.

Plans, like edits, generally belong to tasks (`task_id`, nullable). The one
interactive create surface is the Task Hub composer's **Plan first** branch,
and it needs no task picker: the hub is already a task's hub, so the plan
arrives owned by that task. Orphan plans survive at the protocol level -
`planner.create` takes `taskId?`, and `planner.updateIntake` takes `taskId?`
where `""` clears the link back to an orphan - but no shipping surface sends
an ownerless create today. The owning task's title renders as a chip beside
the plan title and in the hub's plan rows, and on every session boot - new or
reclaim - the plan's session is linked to the task (`work_task_links`,
idempotent), so the task's chats dropdown, board chips, and touch history see
planning sessions like any other.

### Aspect registry

Aspects are data, not code (`planner_aspects`): id, label, briefing
instructions, expected artifacts. The migration seeds ten (requirements,
architecture, data model, APIs, UI/UX, testing, security, performance,
rollout, operations). A repo may also carry a read-only pack in
`.drydock/planner-aspects.json` - merged at read time, never persisted, and a
stored row wins an id collision. Aspect ids are slugs because they double as
the `plan/<aspectId>/` collection subdirectory. The panel consumes the
registry - grouping the outputs tree, filtering, and naming regenerate
targets - and Configure lists it read-only, but the add/edit/archive manager
retired with the intake surfaces and has no home yet (see Retired). Plans
created through Plan first start with no aspects until a protocol caller
assigns some.

## Persistence: collect + hydrate

The agent writes only under its workspace `plan/` directory. That workspace is
a host directory bind-mounted into the microVM, so a sandbox crash mid-write
loses nothing. Durability comes from **collection**: after every completed
turn on the plan's session - whichever surface sent it - and on panel open,
which catches turns whose completion the host never saw, the host reads
`plan/` into the store. Text kinds (documents, diagrams, prototypes) land
inline in SQLite; images go through the content-addressed blob store and
keep only their digest. Revisions bump only on content change; deleting a file
never deletes its row; artifact ids, title overrides, and the prototype
scripts flag survive re-collection.

Every planner-driven boot - a fresh session or a reclaim of a dormant one -
is **hydrated**: the store's artifacts are materialized back into the
workspace `plan/` before the first turn, so the agent always revises current
state. A failed hydration ends the half-booted session rather than letting
the agent revise blind, and the next boot re-hydrates instead of fast-pathing
onto the damaged one. Nothing depends on graceful shutdown.

Collection bounds (skip, never truncate): 40 files per plan, text ≤ 256 KB,
images ≤ 5 MB. Accepted kinds: `.md` document, `.mmd`/`.mermaid` diagram,
`.png/.jpg/.jpeg/.svg/.webp` image, `.html` prototype. Titles resolve
manifest (`plan/manifest.json`) → first markdown H1 → humanized filename; a
user rename overrides permanently.

## The panel

Three editor-area regions: a collapsible outputs rail, the artifact viewer,
and a collapsible notes queue. At narrow editor widths (under ~1080px) both
rails auto-collapse to strips - the outputs strip shows the present kind
glyphs, the notes strip an ✎ with the open count - and a strip click flies
the rail out as an overlay; layout preferences persist as UI-local webview
state.

- **Outputs rail** (left): artifacts grouped by aspect with friendly titles,
  kind glyphs, revision badges, "updated" flashes, and open-note counts;
  hover-rename per row. Below a draggable splitter, the active document's
  **heading outline** (click scrolls to the block); non-document artifacts
  list their annotations there instead. A footer counts the plan's `:ro`
  context mounts.
- **Viewer**: one `ArtifactProvider` per kind behind a common seam - render
  plus `focusAnchor`. Documents render structural markdown in the design-doc
  language (kicker, tight headings, quiet rules) with hover ✎ on every block.
  Diagrams render through the shared lazy mermaid bundle with sanitized SVG
  adoption; a click on a `g[id]` node anchors `node:<id>` (render ids are
  deterministic per artifact so anchors survive re-renders), empty canvas
  anchors a point. Images and prototypes share a pin/region overlay in
  normalized 0-1 coordinates. Prototypes render in a sandboxed `iframe
  srcdoc` - never `allow-same-origin`; `allow-scripts` only via the
  per-artifact toggle - with Preview (page gets the pointer) and Annotate
  (overlay captures it) modes.
- **Notes queue** (right): every annotation on the plan, grouped by file with
  per-file open counts and each state visible, plus the footer's **Send
  notes** button (see the instruction loop).

The header carries the plan title, the owning-task chip, aspect filter chips
(filter the tree and jump the viewer to that aspect's lead artifact), a
compact session status (starting / no session / agent working / live /
offline - send to reconnect, driven by the turn and session pushes forwarded
for the plan's session), ⟳ Regenerate (whole plan or one aspect), and ⇪ To
board….

The panel boots onto its persisted plan, falling back to the newest-updated
non-archived one; there is no in-panel plan browser. Selection arrives from
outside as the `planner.showPlan` push: the provider queues a requested plan
until the webview's first `planner.plans` fetch proves the document is
listening, then delivers it - the mechanism behind the
`planner-session-started` auto-open, the hub's plan rows, and the guide
handoff. An open, unpinned panel also follows the active-task spine: on
`active-task-changed` it retargets to the new task's most recent plan; a
pinned tab opts out, a task with no plans keeps the current one, and any
failure leaves the panel exactly as it was.

## The instruction loop

Every provider emits annotations through one grammar - `block:<n>`,
`node:<id>`, `point:<x>,<y>`, `region:<x>,<y>,<w>,<h>` - into one store
(`planner_annotations`). States: open → delegated → resolved / reopened, with
wont-fix for parking. **Send notes** composes every open annotation into a
single revision turn (artifact title, `plan/` path, human anchor, body),
flips them to delegated stamped with the artifact revision they were written
against, and fires the turn detached. When a later collection bumps that
artifact's revision, the delegated card asks "addressed in rev N?" - resolve
or reopen, never auto-closed. Regenerate re-sends the briefing for the whole
plan or one aspect's subdirectory.

## Materializing plan work on the board

`To board…` closes the mechanical gap between a reviewed plan and execution
without asking a model to invent a DAG. The host scans document artifacts for
literal Markdown checkbox items (`- [ ]`, `* [x]`, and numbered checkbox
forms), keeps titles between 3 and 160 characters, deduplicates them
case-insensitively, and caps the preview at 40. Checked and unchecked source
items are both candidates because the checkbox syntax marks work, not current
completion.

The preview starts with every candidate selected and names the plan's owning
task. The user may remove items before confirming. An orphan plan cannot
materialize until it is assigned to a task. Confirmation creates backlog
subtasks with plan-sourced prompts, `autoStart` off, and no invented dependency
edges; recipes remain the pre-wired creation path. Re-running can propose an
item already materialized, so the preview is currently the duplicate guard.

## Creating and continuing plans

The Task Hub is the front door (ADR 0020). Its new-chat composer carries a
**Plan first** branch: the typed prompt becomes the brief (the optional title
rides along), `planner.create` lands the plan on the hub's task, the host
boots the planning session detached, and the card collapses to a receipt -
"Plan created - continue in Planner" - while the panel auto-opens on the new
plan. The composer hands over a draft, not an intake: aspects and context
roots stay empty rather than pretending the composer made those choices.

The hub's **Plans card** is the overview: one row per plan with a doc count,
an open-note count when notes wait, and the updated age. A row opens the
Planner on that plan; the card's "Planner ↗" and the blank state's "Draft a
plan" raise the panel. The card refetches on the debounced `planner.changed`
push, so a collection cascade costs one refresh.

The conversation is the plan's session itself - an ordinary chat session
named for the plan and linked to the owning task, so it surfaces in the chat
rail, the hub's Chats card, and the Agents fleet like any session. Turns
continue from the chat rail as plain `chat.sendTurn` sends; host-composed
turns - the briefing, note batches, regenerations - collapse behind the
shared transcript's host-briefing disclosure, so the visible thread leads
with the user's own words. A completed turn triggers collection no matter
which surface sent it.

Plan-targeted panel opens ride the `drydock.planner.open` command's optional
planId; sibling panels relay it as `planner.open`, and `panel.openSurface`
maps its planner entry to the same command. The old `panel.showPlan` push
retired with its only listener - the panel announces selection to itself with
`planner.showPlan`.

## Sessions and modes

A planning session is an ordinary chat session started with the internal
`plan` mode: context roots mount read-only, the workspace stays read-write,
and neither agent adapter changes at all - read-only is container-enforced
(ADR 0001). Plan mode has three producers: planner session boots, role
spawns, and the hub composer's Read-only access choice for plain chats; the
new-chat composers never create a plan's session themselves - one is only
born from a plan. Slow host work (create, session boot) acks immediately and
completes via the `planner.sessionReady` push (ADR 0011's lesson: sandbox
boots outlive the webview request timeout). Planner-driven sends - notes,
regeneration - revive a dormant session automatically, hydrating first;
sends from the chat rail revive it like any other chat.

## Retired

Two layers. ADR 0012 retired the composer's [Plan | Develop] switch, its
persisted `composerMode`, the retired Work tab's unused session-mode select,
and the plan-docs pill, panel, service, store, and `planDocs.*` message
family - retired `planDocs.*` requests fail the parse boundary, and the
`plan_docs` table is orphaned-legacy (kept per the additive migration
policy).

ADR 0020 retired the sidebar Plan tab itself - the create composer, the
recent-plans history, and the plan transcript - in favor of the hub composer,
the Plans card, and the chat rail. `panel.showPlan` went with its only
listener. `planner.sendTurn`, `planner.startSession`, `planner.archive`,
`planner.updateIntake`, and `planner.aspects.save`/`.archive` stay in the
contracts and the hosts still answer them, but no shipping webview sends
them: intake editing (title, brief, aspects, context roots, task
reassignment), archiving, and the aspect manager have no UI home today, and
the panel's empty-state and help copy still name the deleted tab. Like ADR
0020's memory gap, this is tracked rather than accepted.

## Verification

Unit: contract parse accept/reject per message, anchor grammar round-trips,
store reopen durability, collector bounds/revisions/titles/aspects, hydrate →
collect round-trips, briefing and instruction-turn composition, aspect
registry rules, and literal-checklist materialization. Harness
(`tools/webview-harness/planner.html`): the plan view's tree + splitter +
outline, all four providers, the notes queue and send flow, the responsive
rails, and the plan → board overlay; the chat-side transcript rows ride the
chat rail's page. The Task Hub's composer and Plans card have no harness page
yet - guided manual verification in a real window - which also covers the
crash drill (kill the sandbox mid-turn; reopen collects everything written),
`vscode.open` artifact jumps, and prototype frames under the real webview
CSP.
