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

