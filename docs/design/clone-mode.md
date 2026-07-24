# Clone Mode & The Sync Protocol

Related: roadmap, `architecture-implementation-plan.md`, threat model.

## Modes of operation

| Mode | What the VM sees | Where changes land |
|---|---|---|
| Standard (implementation) | live work folders mounted rw | directly on disk |
| Planning session | live folders mounted ro | durable Planner artifacts only |
| **Clone** | a git clone of each repo, inside its disposable workspace - **no live mounts** | a patch the developer pulls into the editor |
| Remote (future, specced below) | a clone on a separate networked machine | the same patch protocol over a transport |

## Clone mode - mechanics

### The load-bearing fact
The session workspace is a host-side temp directory mounted into the VM.
Therefore the clone is **host-accessible**: every git operation (clone,
commit, diff, 3-way apply) runs on the host against
`<workspace>/repos/<name>`. The container needs no git, no credentials, and
no network; it just edits files through its mount. The developer's real repo
is only ever (a) a read-only clone source / fetch remote and (b) a
working-tree apply target - **nothing is ever pushed to any origin**, and the
local repo gains no commits.

### Why full clones, not worktrees
A `git worktree`'s gitdir points back into the primary repo's `.git`
directory - mounting a worktree rw into a VM hands the container a path into
the live repository. Disqualified. Drydock uses `git clone --local
--no-hardlinks`: local clone transport stays fast, while object files are
physically copied so a VM write cannot reach the developer's real object store.

### Snapshot choice and fidelity
Before a manual task/subtask start, Drydock selects a non-empty ordered subset
of the task's sole linked workspace set and preflights each selected repository
without changing it. Preflight reports branch/detached HEAD and tracked versus
untracked dirtiness. The selection and dirty handling are saved as the task's
durable clone policy, so automatic dependency cascades reuse exactly the same
scope without prompting. The chosen dirty handling is also stamped onto each
session row, so resume/reclaim recreates the same snapshot policy instead of
falling back to a dirty overlay.

If a selected repository is dirty, the user chooses one of two snapshots:

- **Carry local changes** clones current local HEAD, then overlays
  `git -C <local> diff --binary HEAD` plus untracked, non-ignored files.
- **Fresh committed checkout** clones the repository's **current local
  committed HEAD** and excludes tracked working changes and untracked files.

"Fresh" never means refresh from a remote: this start path performs no
`fetch`, `pull`, or remote checkout. In both cases `git -C <clone> add -A &&
commit` creates the **sync base**, tracked as `refs/sync/base`.

Every automated subtask gets its own disposable clone workspace and never a
live implementation mount. A task with zero or multiple linked workspace sets,
a missing policy, an empty/stale project selection, or a non-git selected root
fails with an actionable error rather than running against an empty workspace.

### The sync protocol (symmetric 3-way patches through the clone)
All bookkeeping lives in the clone; `refs/sync/base` always names the last
state both sides share.

**Inbound - "pull the agent's work into my editor" (the common gesture):**
1. Commit agent progress in the clone (`add -A; commit "[sync] agent"`).
2. Patch = `git -C clone diff --binary sync/base..HEAD` (optionally filtered
   to one file for per-file pulls).
3. `git -C local apply --binary --3way` - **working tree only**, no commits;
   the developer reviews in the editor / working set and commits on their
   own terms.
4. Advance `sync/base` to HEAD. Conflicts (developer edited the same lines
   since the last sync) surface as standard conflict markers in the LOCAL
   files, reported per file - the developer resolves in-editor, which is
   where a developer wants conflicts.

**Outbound - "push my local edits to the VM":**
1. Commit agent progress (keeps the 3-way base honest).
2. Local committed delta: `git -C clone fetch origin <branch>` (origin = the
   local repo path), `diff --binary sync/base FETCH_HEAD`, apply `--3way` to
   the clone tree. Local dirty delta: `git -C local diff --binary HEAD`,
   apply `--3way`; copy untracked. Commit `"[sync] local"`; advance
   `sync/base`.
3. Conflicts land as markers in the CLONE's files and the next turn's host
   note tells the agent to resolve them - outbound conflicts are the
   *agent's* to fix, inbound conflicts are the *developer's*. Symmetry keeps
   both sides friction-free.

Notes: binary patches via `--binary` throughout; untracked files copy-win
(no merge semantics - documented); multi-root sets clone every **git** root
under `repos/<name>`, and clone mode refuses non-git roots with a clear
error rather than silently mounting them.

### UX - the working set IS the sync surface
Zero new mental models: in a clone session the existing Changes working set
lists the agent's changes in the clone (same glyphs, same `+N −M` stats,
same click-to-open-diff against the sync base). Only the verbs change:
- ✓ per-file → **Pull into editor** (per-file inbound patch)
- ✕ per-file → **Discard in clone** (`checkout sync/base -- <path>`, confirm)
- Header: **Pull all into editor** / **Push local → VM** / conflict rows
  flagged until resolved.
An Edit session started in clone mode exposes the sync verbs instead of live
mount edits; the mounts expandable shows
`clone: <repo>@<branch> · no live mounts`; the session
briefing tells the agent it is on a disposable clone whose changes reach the
developer only through sync.

### Failure honesty
git-not-found on host → clone mode unavailable with an actionable error;
a failed 3-way apply never half-applies (git apply is atomic per invocation;
per-file pulls are one file per invocation); sync ops are disabled while a
turn is running (the agent may be mid-write).

### Chain changesets and landing (ADR 0014)
Dependent subtasks can seed from their upstreams' output without the user
pulling first: Review entry captures each clone's `sync/base..HEAD` patch
durably (blob store + `task_changesets` row, latest capture wins) together
with its repo-relative touched paths, and a
subtask whose stored `seedMode` is `upstream` 3-way applies its upstreams'
unlanded changesets into the fresh clone BEFORE `refs/sync/base` freezes -
so each subtask's own changeset stays scoped to its own work. A full Pull
marks the session's changesets landed (they stop seeding). Conflicting
seeds fail the start loudly; the user chooses the mode (start QuickPick or
the card's ⎘ toggle), automation never invents one.

The Agents panel folds unlanded rows into a Landing drawer. It compares
repo-namespaced path sets to order known-disjoint work before unknown and
overlapping work; this is an advisory overlap signal, not a Git dry run.
Two-click Pull calls the same full clone Pull as the session Changes tray,
and lost-clone or mid-turn refusals stay visible. The durable patch cannot yet
rehydrate a lost clone, so landing still requires that live process-local clone
state.

## Remote mode (future) - specification only

Target: a separate machine with internet access (never production access)
runs the container; the developer's machine keeps the real repos.

The sync protocol is deliberately **transport-independent** - `sync/base`
+ bidirectional `--binary --3way` patches make no assumption that the clone
is local. Remote mode replaces "shared temp directory" with a transport:

1. **Staging bare repo** on the remote machine (`~/agent-staging/<id>.git`),
   created per task/session. The developer's machine pushes sync branches to
   it over SSH; it is the remote clone's `origin`. The REAL origin and its
   credentials never leave the developer's machine.
2. **Outbound**: local host builds the same snapshot commit (committed delta
   + dirty overlay, same clone-mode code path) on a throwaway branch and
   `git push staging sync/local-<n>`; the remote runner fast-forwards its
   clone's `sync/base` and 3-way applies exactly as local clone mode does.
3. **Inbound**: the remote runner commits agent progress and pushes
   `sync/agent-<n>` to the staging repo; the local host fetches it and runs
   the identical `apply --3way` into the working tree. Same conflicts model,
   same UI - the working set does not know or care that the clone is remote.
4. **Security posture**: remote machine gets clones only (no live mounts -
   the clone-mode definition of done extends naturally); network allowlist on
   the remote runner (provider endpoints + the staging repo only); patch
   size caps and denied-path filters applied before anything leaves the
   local machine; SSH host key pinning; the staging repo is disposable with
   the session.
5. **Friction parity**: identical buttons, identical semantics; the only
   added state is transport health (unreachable remote → sync buttons
   disabled with the reason, never a hang).

What remote mode needs that clone mode does not: a runner daemon (or SSH-exec
harness) on the remote machine to own containers there, remote runtime
inventory reconciliation, and heartbeats over the transport. That is
remote-execution territory (see the roadmap); the sync protocol is written
so none of it changes.

## Implementation shape

Clone mode is `clone` in the workspace-selection mode union, with the session
mode persisted and driven through `clone.state`/`pull`/`push`/`discard`
messages. Core sync logic lives in `cloneSyncService`, which runs git plumbing
over the existing `CommandRunner` (init/status/inbound/outbound/per-file/
discard/conflict detection) and is covered by real-temp-git-repo tests. App
wiring covers clone workspace preparation, briefing, guards, and handlers; the
webview adds the mode segment and the sync working set. Browser-harness
fixture coverage exists for the clone working-set UI, alongside the real-repo
git plumbing tests; the full sync protocol (both conflict directions, the
no-commit invariant) still needs guided manual verification against a real VS
Code window.

## Branch handoff, stage chains, and durable landing (2026-07-24)

Plan: `docs/ideas/background-lane-and-inspection-workspaces.md`; decisions in
the ADR 0014 amendment.

- **Origin stamping.** `initClone` records the local commit a clone was cut
  from as `refs/sync/origin` (returned as `originCommit`). Captures carry it
  with `refs/sync/base`, plus a full `origin..HEAD` patch blob when the base
  tree moved past the origin - enough durable data to rebuild the finished
  tree without the live clone.
- **Branch handoff.** `landAsBranch` fetches the clone's HEAD from its
  protected git dir (never inside the mounted tree, so agent writes cannot
  have touched the config consulted) into `refs/heads/<name>` in the local
  repo. Fast-forward-only on existing branches; foreign collisions suffix
  `_1`, `_2` in suffix mode or refuse (`BRANCH_DRIFTED`) in fail mode. No
  checkout, no push, no delete, no working-tree change.
- **Stage chains.** A stage's completion advances the task's own branch
  (fail mode after the first land - drift PARKS the chain instead of
  force-writing); the next stage clones the branch tip via `sourceBranch`,
  which requires `dirtyHandling: "fresh"` (a chain clone means exactly that
  tree). Repos without the branch fall back to the current branch, logged.
  Stage clones never also apply upstream changeset seeds - the branch
  already carries that content.
- **Inspection materialization.** Human-only copies: a fresh clone detached
  at the capture's origin with the patch applied and left uncommitted (so
  vanilla git shows the work), or a real-repo worktree at the landed branch.
  These keep their `.git` on purpose, live under `<stateRoot>/inspect`
  outside any sweep timer, and are never mounted into a sandbox. Windows
  opening them must never be auto-trusted.
- **Durable landing.** When the live clone is gone, Landing falls back to
  the stored changesets: `applyChangesetToLocal` (working-tree 3-way, pull
  semantics) for patch handoff, `landChangesetAsBranch` (temporary detached
  worktree at origin, commit, fast-forward the branch, worktree always
  removed) for branch handoff. Bookkeeping and the human-only pull model
  are unchanged.
