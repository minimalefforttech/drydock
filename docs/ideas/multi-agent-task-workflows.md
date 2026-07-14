# Multi-Agent Task Workflows — Investigation

## Status

Investigation, 2026-07-11. Not an accepted architecture decision or an
implementation commitment. Grounded in: `workflow-scenarios.md`,
`clone-mode.md`, `task-board-and-subtasks.md`, `subagent-workflows.md`,
`work-management.md`, `extension-points.md`, `threat-model.md`, ADRs
0002/0004/0007/0012/0013/0014/0015, and the fleet-scale persona below.

This is preserved as the historical gap analysis that led to the consolidated
decisions. The ADR index and focused design documents describe current
behavior.

## The persona: a pipeline developer at fleet scale

The user this investigation designs for is a VFX pipeline or games tools
developer — the person the fixtures already describe (asset_api, Maya/Houdini
exporters, farm submit, productiondb):

- **Many small repos, one ecosystem.** 10–40 packages: core libraries, DCC
  plugins, farm tools, schemas, deploy configs. A change routinely spans 2–4
  of them (the `alembic publish` fixture touches db + api + two DCCs). Games
  variant: one enormous engine/content monorepo instead — same juggling,
  different clone economics.
- **Interrupt-driven.** Show-critical artist-blocking bugs preempt planned
  work daily. Realistic concurrent load: one or two hotfixes, one feature,
  one investigation ("move to USD 24?"), a review backlog, docs debt.
- **The same repos needed by many tasks at once.** You cannot hand-manage
  five checkouts of `asset_api` for five concurrent concerns. Historically
  this forces serialization; clone workflows exist precisely to break it.
- **A verification wall.** Unit tests run anywhere, but *real* verification
  needs Maya/Houdini (licensed, GUI), the farm, or production-shaped data —
  places an agent cannot go alone. Human-in-the-loop checks are not a
  fallback; they are the normal final step. (Games: engine builds and
  playtests are the same wall.)
- **Tribal context.** Which show pins which package, why the farm submitter
  special-cases Nuke, where the fixture server runs. Rediscovering this per
  session is the single largest token waste (see
  `cross-project-knowledge-atlas.md`).
- **Work arrives as tickets** (ShotGrid/ftrack in VFX, Jira elsewhere), not
  as chat prompts.

### The day they want (target loop)

1. **Triage (morning).** Open the fleet: what finished overnight, what
   failed, who is waiting on me. Answer questions, approve/deny access, then
   land finished work.
2. **Fan-out.** Pick today's lineup from the board/tracker. Each task starts
   with a *shape*, not a blank chat: a hotfix is a worker+tester pair on a
   narrow clone; an investigation is a researcher over wide read-only
   mounts; a cross-repo change is a plan that becomes a subtask DAG with
   workers per repo and a tester downstream.
3. **Converge (midday/afternoon windows).** Batch-review finished clones —
   an agent pre-screens, the human reviews what matters, pulls into the
   working tree, runs the DCC/HITL verification, commits and PRs through
   normal git.
4. **Overnight.** Long soaks and big refactors keep running away from the
   keyboard; the morning starts at step 1.

## Where Drydock already fits (honest fit map)

| Persona need | What exists today | Verdict |
|---|---|---|
| Many agents, one workspace, no collisions | Clone mode: full local clones (never worktrees), symmetric 3-way sync, per-subtask disposable clone workspaces, no-push invariant | **Solved at the mechanics level** — this is the differentiator |
| Parallel task execution | Concurrent sessions (one runtime each), subtask DAG + per-subtask `autoStart` cascade, event-driven orchestration (ADR 0007), product-owned lifecycle (ADR 0002) | Skeleton exists |
| Agent teams (researcher/worker/tester/reviewer) | Role sessions with mount-subset enforcement at spawn and expansion; native subagent visibility, depth-N | Primitive exists, **user-spawned and hand-assembled** |
| "Where is everything / who needs me?" | Agents panel (ADR 0013), attention stack, board chips, multi-window ownership (ADR 0008) | Strong after ADR 0013 |
| Plan-before-build | Planner (ADR 0012): durable plans, aspects, annotate→revise loop | Strong; not yet connected to execution |
| Review at task scope | Task Review: cross-repo diff aggregation → comments → revision turns; never commits | Strong per task; no cross-task flow |
| Safety while scaling | Threat model invariants; risk-tiered approvals; B4 friction rule | The discipline to preserve as automation grows |

The base layer — isolation, clone sync, roles, boards, visibility — is the
hard part, and it is built. What is missing is almost entirely the layer that
turns primitives into **workflows**: shape at fan-out, flow between agents,
policy while running, and batch ergonomics at convergence.

## Gap analysis (by fleet lifecycle)

### A. Fan-out — starting many things well

- **G1 — No task recipes.** Every task is hand-assembled: workspace, mode,
  roles, models, subtasks, verification expectations. The persona's task
  kinds are extremely stereotyped (hotfix / investigation / cross-repo
  change / upgrade soak / docs pass). Recipes should be **data, not code**
  (the planner-aspect precedent): a named shape that pre-fills subtasks +
  dependency edges, role plan (e.g. worker→tester), session modes, model
  profile per role, context packs, and the verification requirement for
  Review. Recipes must never carry ambient access — mounts still resolve
  through the normal workspace-set + approval path (B4).
- **G2 — No per-role model routing.** Children inherit the parent's model
  (explicitly deferred in `subagent-workflows.md`); the threat model already
  specs model profiles (cost class, context budget, role suitability,
  audit-recorded routing). Fleet economics demand cheap researchers/testers
  and expensive workers. This is the highest-leverage *specced-but-unbuilt*
  item.
- **G3 — Plan → board bridge missing.** The Planner produces documents; a
  human transcribes them into subtasks by hand. "Materialize this plan as a
  subtask DAG" (titles, prompts, dependencies, autoStart flags proposed from
  the plan's structure; human edits then confirms) closes the
  thinking→execution seam with no new concepts.
- **G4 — No agent-proposed decomposition.** An orchestrator-shaped role that
  *proposes* the DAG (never starts it — a B4-graded confirm applies) would
  make fan-out one gesture for novel work, not just recipe work.

### B. Running — the unattended middle

- **G5 — The chain integration gap** (already documented as the top open
  question in `task-board-and-subtasks.md`): a dependent subtask's clone
  snapshots the developer's **local HEAD**, not its upstream's output. So
  worker→tester→fixer — *the* core multi-agent pattern — does not compose:
  the tester tests code that isn't there. Candidate directions, in rough
  order of preference:
  1. **Durable changesets**: on subtask completion, persist the clone's
     `sync/base..HEAD` binary patch as a task-scoped changeset row; a
     dependent's clone start applies upstream changesets (3-way, existing
     plumbing) after snapshotting local HEAD. Pull-into-editor semantics are
     unchanged; landing still happens once, by the human.
  2. **Task integration clone**: one long-lived clone per task that
     accumulates pulled subtask changesets and seeds dependents. Heavier
     state, but gives the human a single "task result" to review.
  3. Chaining clones directly (dependent clones from upstream's clone) —
     rejected tentatively: couples workspace lifetimes to DAG shape.
  A related wrinkle to resolve with it: Review counts as done, so dependents
  fire **before** human review; with changeset flow this becomes explicit
  ("dependent consumed an unreviewed changeset") and should be visible on
  the board/fleet rather than silent.
- **G6 — No concurrency or resource budget.** Auto-cascade dispatches every
  eligible dependent; each is a microVM on a workstation that also runs
  DCCs. Need a global run-slot budget (config), a visible queue (fleet
  panel), and simple priorities (hotfix recipe preempts soak recipe).
- **G7 — No failure/stall policy.** Failed runs sit with a badge (manual
  restart, open question notes auto-park); idle detection exists for display
  only. Overnight fleets need per-recipe policy: retry-once on transient
  failure, park after N failures, park-and-flag on idle timeout, always via
  the attention stack — never silent.
- **G8 — No overlap radar.** Two concurrent clones of the same repo can both
  edit `publish_hooks.py`; the second pull conflicts, surprising the human.
  All data exists (per-session diff baselines + clone file lists): warn at
  spawn ("task B is already changing 2 files in asset_api") and decorate
  pull buttons ("conflicts likely with task A's pending changes").
- **G9 — No away-from-keyboard continuity.** A window reload kills live
  backends (runtime re-attach is a known gap); remote mode is spec-only.
  The overnight scenario currently means "leave VS Code open and hope."
  Sequencing: (1) reload re-attach — the sandbox and clone both survive, the
  process attachment doesn't; (2) clone-only remote execution per the
  existing spec (staging bare repo over SSH). Clone mode was designed so
  remote adds no new sync semantics — that design bet should be cashed.

### C. Converge — finishing many things well

- **G10 — No landing queue.** N finished clones today mean N separate
  open-task→review→pull-all→resolve→commit ceremonies. A cross-task landing
  flow (from the fleet/board): ordered list of Review-column tasks, dry-run
  apply per task to pre-check conflicts against the current working tree,
  suggest a disjoint-first order, one "pull into editor" gesture per task,
  then the human commits through normal git. The no-commit/no-push invariant
  is untouched — this is ergonomics over the existing sync verbs.
- **G11 — Reviewer pre-screen not wired.** The reviewer role and the review
  comment→revision loop both exist, but nothing connects "card entered
  Review" to "spawn reviewer on the diff, file comments for the human."
  Recipe-driven (per G1), read-only mounts, output lands in the existing
  Task Review surface. The human stays the only gate that can move work to
  Finished — model agreement is never approval (threat model).
- **G12 — Verification gates unbuilt.** `workflow-scenarios.md` B2 already
  calls for the "no passing test run" marker; `extension-points.md` specs
  test providers including **HITL instructions** — exactly the DCC/farm
  wall. Attach verification requirements to recipes ("Review requires: unit
  suite green in-sandbox + HITL: export .abc from Maya scene X"), render
  state on cards/fleet rows, and let a tester role satisfy the automated
  part.

### D. Knowledge, teams, and the outside world

- **G13 — Context per spawn is rebuilt, not compounded.** Researchers
  produce transcripts and plans that die in SQLite (plan export to repo docs
  is a known gap). Connect: researcher/planner outputs → knowledge packs
  (`cross-project-knowledge-atlas.md`), recipes inject atlas shortlists into
  briefings, review flags new public APIs missing from packs. The atlas idea
  is the right shape; the multi-agent angle just gives it producers and
  consumers.
- **G14 — External trackers.** Specced (Jira/Asana/GitHub); for the VFX
  persona the actual system of record is often **ShotGrid (Flow) or ftrack**
  — worth naming as adapter candidates in the extension-points list. Correct
  sequencing: after the execution loop closes (a synced ticket that fans out
  into a broken chain helps nobody).
- **G15 — Team-shared configuration.** `work-management.md` already specs
  read-only team-scope state stores. Recipes, model profiles, aspect packs,
  HITL checklists, and denylists are exactly what a studio wants shared.
  Design recipes/profiles as store-resident data from day one so team
  distribution is a store row, not a feature.

## How this positions against the field

Cloud-delegation products (Codex cloud tasks, Copilot agents, Cursor
background agents) make *fan-out* trivially easy — click, get a PR — but
assume repo-in-the-cloud, per-task VMs far from DCCs, and PR-shaped
convergence. The studio persona cannot ship repos to a vendor cloud, needs
local DCC/farm adjacency, and lands work through a working tree, not a PR
bot. Drydock's bet — local-first isolation, mount policy, clone sync,
product-owned orchestration — is the right one for this user. The lesson to
*take* from those products is ergonomic, not architectural: one gesture from
ticket to running shaped work, and one gesture from finished work to landed
diff. That is precisely G1/G3 and G10.

## Recommended order (no commitment, sized by leverage)

| Priority | Theme | Gaps | Why first |
|---|---|---|---|
| 1 | **Close the chain** — durable changesets between dependent subtasks | G5 | Without it, "multi-agent" means parallel independent tasks; with it, worker→tester→fixer composes and every recipe below gets teeth |
| 2 | **Recipes + model profiles** — task shapes as data; per-role routing; tester/reviewer auto-spawn hooks | G1, G2, G11, G4-lite | Turns fan-out into one gesture; encodes the studio's stereotyped work kinds; controls fleet cost |
| 3 | **Fleet policy rails** — run-slot budget + queue, failure/idle policy, overlap radar | G6, G7, G8 | Cheap, host-side, and required before anyone trusts overnight autonomy |
| 4 | **Landing flow** — cross-task landing queue with conflict pre-check; verification markers | G10, G12 | Convergence is the human bottleneck; this is where fleet hours are actually spent |
| 5 | **Plan → subtasks materialization** | G3 | Connects the Planner investment to execution |
| 6 | **Continuity** — runtime re-attach on reload, then clone-only remote execution | G9 | Overnight/away autonomy; remote spec already written against the same sync protocol |
| 7 | **Ecosystem** — atlas producers/consumers, ShotGrid/ftrack/Jira adapters, team stores | G13, G14, G15 | Multipliers once the loop closes |

Standing constraints for all of it: recipes and automation may **narrow**
but never widen access without the human approval path (B1/B4); questions
may get standing default answers, access requests never; model agreement is
never approval; nothing automated moves work past the first done column.

## Open questions for the owner

1. Chain integration: changesets-at-start (1) vs task integration clone (2)?
   (1) is less state and reuses the sync plumbing; (2) gives a single
   task-level review target. They can compose ((1) first, (2) later).
2. Should a recipe be allowed to *auto-answer* agent questions from a
   standing FAQ (task-scoped, human-authored)? Cheap autonomy win, but it is
   the first step onto the "agent talks to itself" slope — propose yes, with
   the FAQ visible on the task and every auto-answer logged to the
   transcript.
3. Run-slot budget: per-host config only, or per-recipe weights (soak=cheap
   slot, hotfix=priority slot)?
4. For the games-monorepo variant: is clone cost (full clone of a huge repo
   per subtask) worth a `--filter`/sparse-checkout clone profile on the
   clone policy? (VFX many-small-repos doesn't need it; a monorepo does.)
5. Does the fleet need per-task token/cost rollups before recipes land
   (usage data already flows per node), or alongside them?

## Decisions (owner, 2026-07-11)

1. **Chain mechanism — user-controlled seeding.** Durable changesets exist,
   but *applying* upstream output into a dependent is the user's choice,
   mirroring the pull model ("they get to choose when to apply changes back
   anyway"). Concretely: a per-subtask **seed** setting (`local HEAD` vs
   `+ upstream changesets`), visible on the card/edge, editable in the start
   flow; auto-start reads the stored setting and never invents one. No task
   integration clone for now.
2. **FAQ auto-answer — yes, configurable.** Global default off/on in config,
   per-task toggle, FAQ visible on the task, every auto-answer logged into
   the transcript and counted on fleet rows. Access requests are never
   auto-answered.
3. **Budget — config with machine-derived default.** A `maxConcurrentRuns`
   setting whose default is computed from machine spec (cores/RAM) and shown
   as `auto (N)`; a visible queue when the budget is exceeded.
4. **Sparse/partial clones for monorepos — deferred.**
5. **Cost visibility — alongside recipes/model profiles** (priority 2):
   per-task rollups plus a fleet total, from the usage data already flowing.
6. **Density (2026-07-12)** — the features must not turn cards into chip
   soup. Quiet by default, detail on demand, configurable: a
   `minimal | standard | full` Detail control on the board and fleet
   toolbars (per-panel persisted, global default
   `drydock.ui.cardDetail: "minimal"`), a **one-chip rule** at minimal with
   the priority order waiting-on-you → failed/parked → overlap → queued →
   running, and ONE consolidated hover card per card/row for everything
   hidden (never per-chip tooltips). Waiting/failed states never hide;
   passive metadata (recipe, seed, cost, verify-passed) never shows by
   default.

## Implementation outcome

The work was implemented in several increments, but those increments do not
need one ADR each. The durable decisions are consolidated by responsibility:

- Fleet presentation, density, attention priority, live token totals, and
  honest starting/resuming state are owned by ADR 0013.
- Review-entry changesets, explicit dependent-run seeding, overlap advice,
  and the Landing flow are owned by ADR 0014.
- Machine-derived run slots, durable queue/park state, retry-once behavior,
  and double-opt-in FAQ answers are owned by ADR 0015.
- Data-driven recipes and human-verification requirements are amendments to
  ADR 0007; per-subtask model routing is an amendment to ADR 0002.
- Checklist-to-board materialization is an amendment to ADR 0012, and
  reviewer/guard authorship is an amendment to ADR 0004.

Harness scenarios V62–V69 remain implementation evidence for the individual
increments. They do not imply eight separate architecture decisions. Remote
execution and full live-runtime reattachment remain outside these decisions.
