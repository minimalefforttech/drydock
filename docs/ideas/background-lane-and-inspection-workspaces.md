# Background Lane and Inspection Workspaces - Plan

## Status

Proposal, 2026-07-24. Elaborated same day with owner direction, twice: first
(task setup form, remote project selection, source/handoff modes, plan-first
approach), then (worker terminology, plain branch names, staged tasks on a
shared branch with handoffs, preferences design). Not yet an accepted
architecture decision. Grounded in: `clone-mode.md`,
`task-board-and-subtasks.md`, `agents-panel.md`, `work-management.md`,
`workflow-scenarios.md`, `threat-model.md`, `studio-security-policy.md`,
`extension-points.md`, `provider-signin-and-registry.md`, ADRs
0002/0004/0007/0008/0011/0012/0013/0014/0015/0016/0019, and the fleet-scale
persona in `multi-agent-task-workflows.md`.

UI prototype: [../design/prototypes/background-lane-and-inspection.html](../design/prototypes/background-lane-and-inspection.html)
(ticket form with stages, board with lanes, plan gate, inspection window,
preferences).

## The ask

Throw a handful of low-priority tickets at background workers while the
human does serious work in another window. Each ticket specifies its shape
up front:

- **Workspace and projects by name** - the current workspace set plus
  additional projects, including projects picked from GitHub/GitLab with a
  sign-in-once picker.
- **Source** - start from the current workspace state (including
  uncommitted changes) or from a fresh clean clone.
- **Working/handoff mode** - patch or branch. A branch is just a branch
  name, typically the ticket key (`PIPE-123`); no product prefix is forced,
  and a name collision auto-suffixes `_1`, `_2`, and so on.
- **Stages** - a task can split into ordered stages (subtasks) that all
  operate on the same branch, each with fresh context, passing a small
  handoff note forward.
- **Approach** - jump in and implement straight away, or plan first and
  present the plan for discussion (the normal Planner loop) before any
  implementation starts.

Workers run autonomously and in parallel on the same repos, then await
feedback. When a task is done, one button jumps into that workspace to see
the changes as if freshly cloned (browse, diff, run tests, open the DCC),
and one gesture jumps back. System configuration for all of it needs a
deliberate preferences design.

## What already covers it (fit map)

| Need | What exists today | Evidence |
|---|---|---|
| Own workspace per worker, same repos, no collisions | Clone mode: real `git clone --local --no-hardlinks` from local HEAD into a disposable per-session workspace under `<stateRoot>/tmp/<id>/workspace/repos/<name>`; git dir split out of the mounted tree | `cloneSyncService.ts:231-307`, `isolatedRunService.ts:1866-1924` |
| "Current state vs fresh" source | Built at the plumbing level: `dirtyHandling: "carry" \| "fresh"` overlays the developer's dirty tracked changes onto the clone, or snapshots clean HEAD | `cloneSyncService.ts:90,228-317` |
| Session modes | `SessionMode = "plan" \| "implementation" \| "clone"`; workspace sets carry a default mode | `packages/contracts/src/workspaces.ts:13` |
| Projects by name | Durable `ProjectRecord` catalog (stable ids, path-is-identity, policy-gated registration) grouped into workspace sets | `projectCatalogService.ts:36-54,96-105` |
| Ordered multi-step work | Subtask DAG + opt-in autoStart cascade; `seedMode: local \| upstream` chains a dependent's clone from upstream changesets | `subtaskOrchestrator.ts:497-544`, ADR 0007/0014 |
| Handoff raw material | Host-built chat digests (trimmed log or sidecar AI summary) already exist for export | ADR 0011 |
| Autonomy bounds | Recipes (per-step prompt, autoStart, seedMode, model, verify); retry-once-then-park; FAQ auto-answers (double-opt-in); `maxConcurrentRuns` + durable FIFO queue | `tasks.ts:262-297`, `subtaskOrchestrator.ts:321-340`, ADR 0015 |
| "Done, awaiting feedback" | Automation moves the card to the first done-category column (Review) and never past it; changeset captured at review entry; inbox + attention stack collect what waits on you | `subtaskOrchestrator.ts:625-629`, ADR 0014, `workTab.ts:1119-1342` |
| Plan-and-discuss loop | Planner: durable plan artifacts, annotate then revise, previewed checklist-to-board materialization | ADR 0012 |
| Feedback loop | Task Review comments become revision turns; landing pulls into the real working tree; human commits through normal git | ADR 0014, `task-review.md` |
| Two windows, one state | Global per-user DB + host heartbeats; foreign sessions are view-only; explicit reclaim | ADR 0008, `chatSessionService.ts:1320-1356` |
| Config surfaces (scattered) | Studio policy (managed caps), VS Code `drydock.*` machine settings, System tab registries (MCP), `.drydock/recipes.json` read-only overlay | `studio-security-policy.md`, `package.json:246-253`, `recipeOverlay.ts`, ADR 0019 |

The execution machinery is built. Missing: the **ticket surface**, the
**remote project picker**, **plain-branch handoff**, **stages with
handoffs**, the **plan gate**, the **priority lane**, the
**jump-in/jump-back gesture**, and a **unified preferences cascade**.

## Gaps

- **X1 - No way to enter a finished workspace.** Clone workspaces are
  process-local and disposable; nothing opens or reveals one. The durable
  artifact is the review-entry changeset, not the folder.
- **X2 - Changesets are not self-contained enough to reconstruct a tree.**
  `task_changesets` stores the `refs/sync/base..HEAD` patch but not the
  commit it was based on; a dependent's patch excludes upstream seed
  content (base is stamped after seeds apply, `cloneSyncService.ts:358-364`).
- **X3 - No priority concept.** The queue is FIFO with manual-starts-first
  (`subtaskOrchestrator.ts:321-340`); no lane, no sub-budget, no preemption.
- **X4 - Landing needs the live clone.** The captured patch is durable but
  the pull path still reads the clone (`clone-mode.md:128-130`).
- **X5 - No task setup surface.** Source exists only as plumbing; handoff,
  stages, and approach do not exist as concepts; nothing is settable per
  task at creation.
- **X6 - Projects are local paths only.** No remote provider, no sign-in,
  no managed clones root, no fetch step anywhere.
- **X7 - No branch handoff.** No `refs/heads` write, branch naming, or
  land-as-branch verb exists anywhere in `packages/`.
- **X8 - No same-branch chain and no handoff channel.** Dependent runs
  chain by re-applying patches onto fresh clones; nothing accumulates work
  on one branch, and context per spawn is rebuilt from scratch (the G13
  token-waste problem) with no compact handoff between steps.
- **X9 - No plan gate.** The cascade predicate knows column/DAG/autoStart
  state only; there is no approval-conditioned edge.
- **X10 - No unified preferences.** Knobs are scattered across VS Code
  settings and per-feature stores; there is no product-defaults surface, no
  documented precedence, and nowhere for the new ticket defaults to live.
- **X11 - Batch intake.** Creating N shaped tasks is N separate ceremonies.

## Design

### D1 - The ticket form (task setup)

One creation surface (board "New task" and recipe materialization share it)
with progressive disclosure. Quick path stays one line: title + recipe. The
form (and `TaskRecipeRecord`, which gains matching defaults) exposes:

- **Title** - free text; a ticket key up front (`PIPE-231 double-submit on
  farm retry`) is the expected habit and feeds the branch default.
- **Projects** - chips pre-filled from the active workspace set; add more
  by typed name (resolves against the catalog) or via the remote picker
  (D2). Mounts still resolve through the normal approval path.
- **Source** - `current` (local HEAD + dirty overlay; existing `carry`),
  `clean` (local HEAD only; existing `fresh`), or `remote <ref>` (host
  fetches the project's origin first; D3).
- **Handoff** - `patch` (default; today's changeset flow) or `branch` with
  a plain name field, default = the leading ticket key from the title when
  present, else the task slug. No forced prefix, no template ceremony. If
  the name already exists, landing auto-suffixes `_1`, `_2`, ... and says
  so on the card (D3).
- **Stages** - an ordered list of stage rows (title + prompt each);
  one-stage tasks are just the degenerate case (D4).
- **Approach** - `implement` or `plan-first` (D5).
- **Lane** - `normal` or `background` (D7).
- Per-stage model routing and verification stay recipe/advanced concerns.

Defaults for every knob come from the preferences cascade (D10); recipes
override preferences; the form overrides recipes. Everything lands on the
task/subtask records at creation; the orchestrator reads stored settings
and never invents one (the ADR 0014 seeding precedent).

### D2 - Remote project picker (GitHub/GitLab, sign in once)

**Provider registry.** A small `repo provider` registry: `github.com`
(built-in), plus user-added GitLab hosts (cloud or self-hosted URL - the
studio-common case). A sibling of the extension-points task-provider seam,
not a reuse of the AI-provider sign-in flow.

**Sign-in.** GitHub via `vscode.authentication.getSession("github",
["repo"])` (built-in provider, OS keychain). GitLab via personal access
token (scopes `read_api`, `read_repository`) stored in
`vscode.SecretStorage` keyed per host, or the GitLab Workflow extension's
session when installed. Tokens are never rendered (ADR 0019 posture),
never written to git config, never enter a sandbox; host-side git uses a
per-invocation credential helper.

**Picker UX.** `+ add project` opens a quick-pick: Catalog (local,
instant), then one section per signed-in provider with search-as-you-type,
recent picks first. A provider you are not signed into shows "Sign in to
search <host>" as its only item.

**What selection does.** Host clones the repo (full clone; sparse/partial
stays deferred) into `drydock.projectsRoot`, default
`<stateRoot>/projects/<host>/<org>/<repo>`, registered through the
existing `ProjectCatalogService.registerProject` path - the studio policy
gate applies unchanged. The record gains `origin` metadata (provider host,
remote path, web URL, default branch). Origin-bearing projects get a
`fetch on task start` toggle (default on); the sandbox never fetches.

### D3 - Source, isolation, and handoff

**Source (where the code starts).** `current` and `clean` map onto the
existing `dirtyHandling` carry/fresh plumbing. `remote <ref>` is one
optional host-side pre-clone fetch step, same code path for picker-added
and long-standing local projects.

**Isolation (where the worker works).** Always a sandboxed disposable
clone, unchanged. Worker-side worktrees stay rejected (ADR 0004): a
worktree shares the real repo's object store, refs, and branch locks -
exactly the coupling `--no-hardlinks` clones sever. What "worktree" is
actually wanted for arrives via branch handoff plus the worktree flavor of
jump-in (D6), both human-only. Background-lane runs force clone isolation
regardless of workspace-set default mode.

**Handoff (how finished work comes back).**
- `patch` - today's flow, unchanged: changeset at review entry, pull into
  the working tree at landing, human commits.
- `branch` - a new landing verb beside the pull: the host runs
  `git fetch <clonePath> HEAD:refs/heads/<name>` into the real repo.
  Object transfer only: no working-tree change, no checkout, no push. The
  name is the user's own (`PIPE-231`), validated with
  `git check-ref-format` semantics; if it exists and is not this task's
  own branch, land as `<name>_1`, `_2`, ... and badge the card with the
  actual name. Deleting a branch is never automated.
- `merge request` (later, out of v1) - push the landed branch and open a
  PR/MR via the D2 credential, per-action confirmed.

Remote-picked projects with no prior local checkout default to
handoff=branch (nothing to patch into; the branch lands in the managed
clone root).

### D4 - Stages: same branch, fresh context, small handoff

A task can split into ordered **stages** - subtasks in a linear chain with
three promises: they accumulate on one branch, each starts with fresh
context, and a small handoff note passes forward.

**Shape.** Stages are ordinary subtasks with `dependsOn` edges plus a
task-level `chain` marker; the general DAG stays for non-staged work.
Authoring: stage rows in the ticket form, or materialized from an approved
plan's checklist (D5). Each stage runs as its own session (already true
today) - no transcript carryover, only: the ticket prompt, the stage
prompt, the handoff note, and the normal briefing (memories, MCP,
provenance-annotated per ADR 0019).

**Same branch (branch-handoff tasks).** The task branch is the chain
medium:

1. Stage 1 clones from the source (local HEAD / remote ref). On
   completion, the host creates `refs/heads/PIPE-231` at the stage clone's
   HEAD (ref-only write, as in D3).
2. Stage N+1's clone is cut from the branch tip
   (`git clone --local -b PIPE-231`), fresh context, handoff injected.
   On completion the host fast-forwards the branch to the new HEAD.
3. The final stage's completion enters Review as usual; the branch holds
   the whole chain and the human lands/merges through normal git.

This makes the chain durable by construction (a reload or reboot between
stages loses nothing - the branch is in the real repo), and it makes
mid-chain human intervention natural: commit a fix-up onto the branch
between stages and the next stage simply clones the newer tip. If the
branch moved while a stage was running (human commit mid-stage), the
fast-forward fails safe: the stage parks with an overlap warning instead
of force-writing. Stage advances are badged on the card ("branch +3
commits"); creating/advancing refs is the only automated write, and only
ever to the task's own branch.

**Same lineage (patch-handoff tasks).** Stages chain exactly as ADR 0014
dependents do today: `seedMode: upstream`, each stage's clone applies the
prior changesets. Handoff notes work identically. Branch mode is the
recommendation for staged tasks (git-native, durable, inspectable); patch
mode remains for repos where a work branch is unwanted.

**The handoff note.** Small and bounded (~2 KB, truncated with a marker):
what was done, decisions and constraints discovered, what remains, files
touched (auto-filled from the changeset), warnings for the next stage.
Produced at stage completion: the worker emits it as a fenced protocol
block (the access-request precedent); if absent, the host builds a digest
with the ADR 0011 machinery (trimmed log or sidecar AI summary). Stored
durably on the stage edge, rendered on the board (hover the edge/chip),
injected into the next stage's briefing as a labeled section, visible in
the context-debug doc with its source. The human can edit it whenever the
chain is paused (plan gate, park, or manual hold); in the background lane
it auto-passes by default.

### D5 - Plan-first approach and the plan gate

`approach: "implement" | "plan-first"` on the ticket/recipe.

**Plan-first shape.** Materialization prepends a planner step: role
`planner`, session mode `plan` (read-only posture), prompt from the
ticket. Its output is a durable Planner artifact (ADR 0012). Downstream
stages carry a `gate: "plan-approval"` flag.

**The gate.** `isEligibleForCascade` gains one clause: a gated subtask is
not eligible until its gate is satisfied. When the plan lands, a new inbox
row appears - "plan ready - discuss" - jumping into the Planner panel.
Discussion is the normal annotate-then-revise loop. Two closing actions:

- **Approve and start** - stamps the gate; the stored stages cascade, each
  briefed with the approved plan reference.
- **Materialize checklist instead** - the plan's checklist becomes the
  stage list via the existing previewed materialization (ADR 0012),
  replacing the pre-wired placeholder stages; inherits the ticket's
  lane/handoff/source.

A fourth human-gate kind in the ADR 0016 family (question, access,
manual-check, plan-approval): same inbox card slot, never silent, and
automation never crosses it.

### D6 - Inspection workspaces (the jump-in button)

**Concept.** A human-only, host-side view of a finished task's tree -
never the sandbox's live clone. Two flavors:

**Branch flavor (real-repo worktree).** For branch-handoff tasks (and all
staged branch tasks): `git worktree add <stateRoot>/tmp/inspect-<id>
<name>` on the real repo. Instant, no copy, disposable with `git worktree
remove` (never deletes the branch). This is the safe home for worktrees:
human-only, host-side, never mounted into any sandbox - ADR 0004 is
untouched.

**Patch flavor (materialized copy).** Built from durable data:

1. Capture additions at review entry: `origin_commit`, `base_commit`, and
   (only when they differ) a second `full_patch` blob
   (`git diff --binary origin_commit..HEAD`). Same 50 MB guard and
   content-addressed dedup as today.
2. Materialize: disposable workspace (`TempWorkspaceStore`, prefix
   `inspect`, owner token); per repo clone at `origin_commit` (detached),
   patch applied and **left uncommitted** - vanilla VS Code git UI shows
   exactly what the worker produced. Rebased-away base falls back to 3-way
   on current HEAD, and says so.
3. Generated `.code-workspace` plus a `.drydock-inspection.json` marker.

**Opening and returning.** Both flavors open via `vscode.openFolder` +
`forceNewWindow: true` (the pattern that keeps the current window's live
backends running; in-window folder swap would reload and kill them). The
extension detects the marker at activation and shows a banner: task/stage
name, flavor, **Return** (closes the window; OS focus falls back),
**Open Task Review** (same global DB; comments become revision turns
dispatched from the owning window), **Clean up** (single confirm).
Everything else is normal VS Code - run the tests, open the scene in Maya
against this exact tree. ADR 0016 manual-check receipts and the Verified
stamp naturally happen here.

**Trust and safety.** The tree is worker-authored content: inspection
windows open **untrusted** (Restricted Mode, never auto-trusted) so a
crafted `.vscode/tasks.json` cannot execute on the host. No sandbox ever
mounts an inspection workspace; edits there are not synced (banner says
so; keep tweaks as review comments or Export Patch).

**Lifecycle.** Kept while its window is open (heartbeat file honored by
the sweep); otherwise TTL (default 7 days, a preference) or offered for
cleanup when the work lands / the card reaches Finished.

**Where the button lives.** `subtask.inspect` wired to: Review-column
cards (primary), the inbox "to land" row, the fleet task-group header, and
the Task Review panel header. Per-subtask/stage scope by default; a
task-level "inspect all" composes leaf changesets 3-way with the landing
dry-run pre-check (staged tasks do not need it - the branch already is
the composition).

### D7 - Background lane (low priority)

**Model.** `lane: "normal" | "background"` on the task, inherited by its
runs, set in the ticket form, editable on the card.

**Queue semantics** (subtaskOrchestrator + one `subtask_holds` column):
manual starts first (unchanged), then normal-lane auto, then
background-lane auto; FIFO within bands; `restore()` preserves order.
Sub-budget `drydock.orchestrator.maxBackgroundRuns` (machine scope,
default 0 = auto: `max(1, floor(slots/2))`); background starts only while
`backgroundRunning < maxBackgroundRuns` and total budget allows. **No
preemption** (ADR 0015 unchanged); a manual start still jumps the queue
for the next free slot.

**Presentation.** Density rules apply: `background` is passive metadata
(chip at `standard`/`full`, hover card at `minimal`). Waiting-on-you and
failed states never hide, whatever the lane. Board gets a lane filter; the
fleet rollup counts background runs separately.

**Autonomy posture.** Background recipes default autoStart on and FAQ
auto-answer on (existing double-opt-in). Access requests are never
auto-answered. Optional hardening: park-and-flag on idle timeout for
background runs (a preference).

### D8 - Durable landing

Landing today reads the live clone; the captured patch already contains
identical bytes (`outboundChangesetPatch`, `cloneSyncService.ts:432`). Add
the fallback: when the clone is gone, apply the stored changeset blob to
the working tree (patch handoff) or synthesize the commit host-side onto
`origin_commit` and advance the branch (branch handoff). Staged branch
tasks rarely need it - the branch itself is durable - but stage-in-flight
crashes recover through it.

### D9 - Batch intake (throw the tickets)

A "queue background tasks" gesture: pick a recipe (which carries
source/handoff/approach/lane/stage defaults), paste one line per ticket
(`PIPE-231 fix double submit | optional prompt`), get N materialized
tasks. Creation and start remain separate acts. Per-line overrides are out
of v1 - a ticket needing its own shape deserves the ticket form.

### D10 - Preferences and the config cascade

The knobs above need homes. Rule of thumb: **facts about the machine go in
VS Code settings; workflow defaults a team might share go in a product
preferences store; per-shape in recipes; per-work-item on the ticket.**

**Layers, lowest precedence first:**

1. **Built-in defaults** - shipped values.
2. **Machine settings** (VS Code `drydock.*`, scope machine) - resource
   and host facts: `stateRoot`, `projectsRoot`, `maxConcurrentRuns`,
   `maxBackgroundRuns`, UI persistents like `ui.cardDetail`. Existing
   pattern, unchanged.
3. **Preferences** (new sqlite-backed store, edited in a System tab
   "Preferences" section) - product workflow defaults: new-ticket defaults
   (lane, source, handoff, approach), handoff notes (auto-generate on/off,
   compact vs digest), FAQ auto-answer global default, background idle
   park timeout, inspection TTL. Team-shareable later as a read-only team
   store row (G15) or a `.drydock/preferences.json` overlay, the exact
   pattern `recipes.json` already uses.
4. **Recipes** - per-shape defaults.
5. **Ticket (task record)** - per-work-item choices.
6. **Stage (subtask record)** - the narrowest (model routing, verify).

**Studio policy sits outside the ladder and caps everything** (clone-only,
allowed roots, network posture) - it can forbid, never grant. Unset at any
layer means inherit from the layer below; the most specific written value
wins. This is the ADR 0019 tri-state cascade mental model applied to
configuration, and it should be documented once, in one ADR, not
per-knob.

**Surfaces.** System tab gains a Preferences section grouped as: New
tickets, Orchestration (machine values shown read-only with a jump to VS
Code settings), Repo providers (hosts, signed-in identity, sign in/out,
projects root), Stage handoffs, Autonomy, Inspection. Every row shows a
provenance chip (`default` / `machine` / `you` / a lock for
policy-forced), and the context-debug doc already has the right shape for
"what is effective and why" at the task level.

## Rejected / non-goals

- **Worker-side worktrees** (ADR 0004 stands; branch handoff + human-only
  inspection worktrees deliver the want).
- **Forced branch prefixes or naming templates.** A branch is the user's
  name, usually a ticket key. Collision handling is boring and automatic
  (`_1`, `_2`), not configurable ceremony.
- **Opening the live clone folder** (sandbox surface, revision turns,
  lifetime coupling).
- **In-window folder swap for jump-in** (reload kills live backends).
- **Auto-push / auto-MR.** Nothing in v1 pushes or publishes; branch
  writes are local refs only.
- **Preemption / pausing running turns** (ADR 0015 unchanged).
- **Sparse/partial clone profiles** (still deferred).
- **Remote execution** (separate roadmap item; D8 is a step it reuses).

## Phases

| Phase | What | Where | Size |
|---|---|---|---|
| 1 | Capture `origin_commit`, `base_commit`, conditional full patch | `migrations.ts`, `taskChangesetStore`, `changesetService`, `cloneSyncService` | S |
| 2 | Inspection materializer (patch flavor) + workspace/marker/trust + open in new window | new `packages/core` module, host service, `tempWorkspaceStore` | M |
| 3 | Inspect buttons + inspection-mode UX (banner, Return, Clean up) | `webviewMessages.ts`, `taskBoard.ts`, `workTab.ts`, `agents.ts`, `controlPanelProvider.ts`, `extension.ts` | M |
| 4 | Ticket form: projects/source/handoff/stages/approach/lane on task + recipe defaults; wire `dirtyHandling` per task | contracts `tasks.ts`, board create flow, `recipeService`, run bridge | M |
| 5 | Branch handoff: land-as-branch verb, name validation, `_N` collision suffix, worktree jump-in flavor | `cloneSyncService`, landing bridge, agents drawer, inspection service | S-M |
| 6 | Stages: chain marker, per-stage branch advance (create/ff/park-on-drift), handoff notes (protocol block + ADR 0011 fallback, storage, briefing injection, edge UI) | `subtaskOrchestrator`, `cloneSyncService`, new handoff store, `subtaskRunBridge`, board views | M-L |
| 7 | Background lane: queue bands, sub-budget config, chips/filter/rollup | `subtaskOrchestrator.ts`, `subtaskHoldStore.ts`, config, board/fleet views | M |
| 8 | Plan gate: approach materialization, gate clause, "plan ready" inbox row, approve/materialize actions | `subtaskOrchestrator.ts`, `recipeService`, planner wiring, `workTab.ts` | M |
| 9 | Preferences: store + cascade resolution + System tab section + provenance chips | new `preferencesService` + store, System tab view, context-debug | S-M |
| 10 | Durable landing fallback (both handoffs) | `cloneSyncService`/landing bridge | S-M |
| 11 | Remote project picker: provider registry, GitHub auth, GitLab PAT/host, search quick-pick, managed root, fetch-on-start, `remote <ref>` source | new provider module, catalog origin metadata, ticket form, SecretStorage | M-L |
| 12 | Batch intake dialog | board view + `recipeService` loop | S |

1-3 deliver the demo moment. 4-6 deliver the ticket-with-stages workflow.
7-9 make the background lane and its configuration real. 10-12 round out
overnight, ecosystem, and bulk. 4-6 can proceed in parallel with 1-3.

## Tests and docs

- node:test per service: capture fields and dedup; materializer (exact
  base, rebased fallback, multi-repo, caps); worktree add/remove; branch
  land (ref-format validation, `_N` suffixing, ff-only advance,
  park-on-drift); stage chain (branch tip cloning, handoff injection,
  bounded truncation, protocol-block parse + digest fallback); queue bands
  and sub-budget; plan-gate eligibility; preferences resolution order and
  policy caps; provider search against mocked REST; TTL sweep.
- Harness scenarios (V70+): ticket form with stages; Review card inspect;
  inspection banner/Return; branch land + worktree open; stage pipeline
  chips with handoff hover; plan-ready row + Planner loop; lane chip and
  filter; Preferences section with provenance chips; remote picker with
  mock provider; batch intake; durable landing with the clone gone.
- Docs: amend ADR 0007 (ticket fields ride recipes; stages as chained
  subtasks; plan-gated edges), ADR 0011 (digest machinery reused for
  handoffs), ADR 0012 (approve-and-start / materialize), ADR 0014 (branch
  handoff, stage branch advance, inspection materialization, durable
  landing), ADR 0015 (lanes, sub-budget), ADR 0016 (plan-approval gate
  kind). New ADRs: **repo providers and managed project roots**
  (credentials, host network, new root), and **configuration cascade**
  (the D10 precedence). Update `clone-mode.md`,
  `task-board-and-subtasks.md`, `agents-panel.md`, `work-management.md`,
  `threat-model.md` (tokens, host fetches, untrusted inspection windows,
  ref-only automated writes to task branches).

## Open questions for the owner

1. Stage branch advance: comfortable with the host auto-advancing the
   task's own branch between stages (ref-only, badged, parks on drift)?
   The conservative alternative - chain via changesets and only surface
   the branch at final land - keeps refs untouched mid-task but loses
   mid-chain human commits and durable-by-construction.
2. Handoff notes: worker-emitted protocol block first with host digest as
   fallback (proposed), or host digest only to start (simpler, less
   informative)? And should the human be able to require "pause for my
   review of each handoff" per task?
3. `maxBackgroundRuns` auto default: `floor(slots/2)` or a flat 1-2?
4. GitLab self-hosted: PAT-first acceptable for v1, adopting the GitLab
   Workflow extension session when present?
5. Plan approval: task creator only, or any human at the shared DB
   (current product stance: one human, many windows)?
6. Remote-picked projects default to handoff=branch - confirm.
7. Inspection TTL default 7 days - confirm as a preference.
8. Preferences team distribution: read-only team store row,
   `.drydock/preferences.json` overlay, or both (recipes precedent says
   both are cheap)?
9. Batch intake: freeform lines in v1, or wait for tracker adapters
   (ShotGrid/Jira/GitHub Issues) and make it an import? Ticket-key titles
   (`PIPE-231 ...`) suggest the adapters are the real destination.

## Decisions (owner, 2026-07-24)

1. **Terminology - workers.** "Juniors" was shorthand; the product says
   workers. No seniority framing in UI copy.
2. **Branch names are plain names.** Default from the ticket key in the
   title (`PIPE-123`); no forced product prefix, no template ceremony.
   Collisions auto-suffix `_1`, `_2`, ... and the card shows the actual
   landed name.
3. **Stages.** A task can split into ordered stages on one branch, fresh
   context per stage, a small handoff note passed between them.
4. **Preferences need a designed home** - D10's cascade (policy caps,
   machine settings, product preferences store in the System tab, recipe,
   ticket, stage) is the proposal on the table.

## Implementation status (2026-07-24, branch `background-lane`)

Landed with node:test coverage; every service change is host-side and
webview-free unless noted:

- **Phase 1** - capture records `origin_commit`, `base_commit`, and a full
  origin..HEAD patch blob when the base tree moved (seeds/syncs); stamped
  via a new `refs/sync/origin` ref at clone init.
- **Phase 4** - ticket data model: `lane`/`handoffMode`/`branchName`/
  `landedBranch`/`approach` on tasks, `stageIndex`/`gate`/`gateSatisfiedAt`
  on subtasks, recipe ticket defaults (`defaults_json`), plus stage-chain
  validation (unique indexes, explicit predecessor edges).
- **Phase 7** - background lane: queue bands (manual, normal auto,
  background auto), durable band restore, `drydock.orchestrator.
  maxBackgroundRuns` (0 = auto: half the slots), sub-budget that caps AUTO
  background runs only - manual starts stay uncapped and uncounted.
- **Phase 5** - `landAsBranch`: ref-only branch landing with
  check-ref-format validation, ff-only advance, `_1`/`_2` suffixing in
  suffix mode, `BRANCH_DRIFTED` refusal in fail mode.
- **Phase 6** - stages: per-stage branch advance at Review entry (parks the
  chain on drift via the capture-hook rejection path), stage N+1 clones the
  task branch tip (`sourceBranch` clone option, fresh-only), ```handoff
  fence parsing (2 KB cap) with capture-derived fallback notes, injection
  into the next stage's first turn.
- **Phases 2-3** - inspection workspaces: copy flavor (clone detached at
  origin, patch applied uncommitted; 3-way fallback when origin is gone)
  and worktree flavor (landed branch; removal never deletes the branch),
  materialized under `<stateRoot>/inspect` (never swept by timers), opened
  `forceNewWindow` and never auto-trusted; marker file + status-bar Return
  in the inspection window. Commands: `Drydock: Inspect Finished Work…`,
  `Drydock: Return from Inspection`.
- **Phase 8** - plan gate: cascade never crosses an unsatisfied gate,
  plan-first materialization prepends an auto-start planner step and gates
  every recipe step, `Drydock: Approve Plan…` satisfies the gate and
  re-fires the cascade.
- **Phase 9** - preferences: sqlite `preferences` store + typed
  `PreferencesService` (new-ticket defaults), wired below recipe defaults
  in the materialization ladder.

Second pass (same day): the webview surfaces landed (ticket controls in
the recipe modal, board lane/stage/gate/branch chips, Inspect and Approve
actions, plan-ready inbox rows, System-tab new-ticket defaults), plus
durable landing (phase 10, live path branch-aware and the stored-changeset
fallback gated on the clone being genuinely gone), the remote picker
(phase 11, hardened clone posture + host-scoped ASKPASS), batch intake
(phase 12, with ignition and ticket-context injection into root prompts),
and the ADR amendments (0007/0011/0012/0014/0015/0016/0019 + new 0020).
A four-way subagent audit (concurrency, security, workflow, data) ran
against the finished branch; every high/blocker finding was fixed (see
the audit summary in the session log).

Third pass (same day) closed the audit's high/medium follow-ups:
branch-aware Landing drawer rows ("on branch <name>" / "Land branch" verbs
plus branch-aware tour copy), drift-park visibility (durable
`branchDriftAt` flag, board chip, inbox row, and a same-column "Retry
land" that re-fires capture + advance), stage authoring in the recipe
modal (a stages textarea that replaces the recipe's steps with a
validated linear chain via `materializeStagedTask`, plan-first aware),
landedBranch staleness healing (inspection clears the badge when the
recorded branch is gone), a board lane filter, an Open Task Review action
in the inspection window, demo fixtures for the new chips/actions, and
teardown of sessions orphaned by a failed start.

Still deferred, all small and low priority:

- **Inspection TTL sweep and a Clean up action** for `<stateRoot>/inspect`
  (workspaces are kept until a human removes them).
- **Preferences provenance chips** and read-only machine/policy rows in
  the System tab section.
- **Harness visual scenarios** for the new surfaces (demo fixtures exist;
  scripted V70+ walkthroughs do not).
- **Handoff-note fallback timing** - in a rare race the capture-derived
  summary can reach the next stage before the worker's own note lands;
  self-heals on the next completion.

## Standing constraints (unchanged)

Tickets, lanes, stages, recipes, and pickers never widen access - mounts
resolve through the approval path, and background tasks queue access
requests like anything else (B1/B4). Automation never moves work past the
first done column; model agreement is never approval; the plan gate is a
human gate; landing into the working tree and committing stay human. The
only automated repo writes are ref-only advances of a task's own branch
between stages - badged, fast-forward-only, parked on drift, never a
delete, never a push. Handoff notes are bounded and logged with
provenance. Git-host tokens live in SecretStorage/keychain, are never
rendered, and never enter a sandbox. Friction goes where blast radius is.
