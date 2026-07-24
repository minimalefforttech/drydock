# 0014 - Changeset chaining and landing

Status: Accepted - 2026-07-12

Refs: `docs/design/clone-mode.md`, `docs/design/agents-panel.md`, 0004
(clone/review boundary), 0007 (subtask DAG), 0010 (clone sync frames), 0013
(fleet presentation)

## Context

A dependent subtask normally clones the developer's local HEAD, not its
upstream's unlanded output. That breaks worker → tester chains unless the user
pulls every upstream first. Once chains do carry output, finished changesets
also need one honest convergence surface that warns about likely overlap
without applying anything automatically.

The user retains the pull model: Drydock may carry an upstream patch into a
dependent clone only when that subtask has been configured to do so, and only
the user pulls work into the real working tree.

## Decision

- **Capture at Review entry.** Before dependents are evaluated, moving a
  subtask into any done-category column captures each live clone repository's
  `refs/sync/base..HEAD` outbound patch after committing agent progress. Patch
  text lives in the content-addressed blob store; `task_changesets` stores one
  row per subtask/repository. A new capture replaces the prior set, and a clean
  rerun clears stale rows. If clone state is gone, capture skips loudly rather
  than reusing stale output.
- **Capture touched paths.** Each row stores repo-relative touched paths when
  available. Older or incomplete rows remain valid but have unknown overlap;
  unknown is never treated as disjoint.
- **User-selected seeding.** A dependent stores `seedMode: local | upstream`
  (unset means local). `upstream` applies its upstream subtasks' unlanded
  changesets with Git 3-way apply before the new clone's sync base freezes, so
  the dependent's own future patch does not re-carry upstream work. A conflict
  fails the start and names its source. No upstream patch is a clean no-op.
  Manual start asks when a dependent has no saved choice; auto-start and bulk
  start read the stored choice and never invent one.
- **Landing uses the existing full Pull.** A session- or repo-scoped full Pull
  applies through the clone sync protocol and marks the matching changeset rows
  landed. Landed rows stop seeding because their content now rides local HEAD.
  Per-file pulls do not mark a row landed because they do not advance the full
  sync base.
- **Fleet landing is a convergence view.** The Agents panel groups unlanded
  rows into one item per subtask. Repo-namespaced path-set intersection marks
  known overlap; rows sort known-disjoint → unknown → overlapping, oldest
  first within a class. The two-click Pull invokes the same full clone Pull as
  the session Changes tray. Mid-turn or lost-clone refusals surface verbatim.
  The path comparison is advisory, not a Git dry run; 3-way apply remains the
  correctness check.

## Consequences

- A dependent can consume explicitly selected, still-unreviewed upstream work
  without any automated write to the developer's repository. The board shows
  the selected seed and whether output remains unlanded.
- Landing upstream then downstream applies each subtask's own delta once: seed
  patches are part of the dependent's sync base, not its outbound delta.
- Persistence adds `subtasks.seed_mode`, `task_changesets`, touched-path
  metadata, and blob reuse through additive migrations.
- Clone process state is still not durable. Resume re-clones from local HEAD
  without replaying seeds, and Landing needs the live clone even though the
  captured patch is durable. The UI must report that limitation rather than
  pretending a disposable workspace survived.


## Amendment - 2026-07-24 (branch handoff, stages, inspection, durable landing)

The background-lane plan (docs/ideas/background-lane-and-inspection-workspaces.md)
extends this decision's changeset machinery with four consumers:

- **Capture self-containment.** Review-entry rows now also record the clone's
  `origin_commit` (stamped as `refs/sync/origin` at init) and `base_commit`,
  plus a full `origin..HEAD` patch blob when the base tree moved past the
  origin (seeds or mid-flight syncs). Older rows stay valid with the fields
  absent.
- **Branch handoff.** Tasks may set `handoffMode: branch` with a plain,
  user-owned branch name (typically the ticket key). Landing then runs
  `git fetch <cloneGitDir> HEAD:refs/heads/<name>` in the local repo:
  ref-only, fast-forward-only on existing branches, `_1`/`_2` auto-suffix on
  foreign collisions, never a checkout, never a push, never a delete.
- **Stage chains.** Stage subtasks (1-based `stageIndex`) advance the task's
  own branch at Review entry (first land may suffix; later stages are
  fast-forward-only and PARK the chain on drift via the capture-hook
  rejection path). The next stage clones the branch tip (`sourceBranch`,
  fresh-only). These per-stage ref advances are the one automated repo
  write this amendment introduces - badged, scoped to the task's own
  branch, and never crossing into the working tree.
- **Inspection and durable landing.** Captured changesets are sufficient to
  rebuild a finished tree without the live clone: inspection workspaces
  (human-only copies or branch worktrees) and the Landing fallback (apply
  the stored patch to the working tree, or synthesize the landed commit in
  a temporary detached worktree) both read only durable rows and blobs.
  Landing bookkeeping and the human-only pull model are unchanged.
