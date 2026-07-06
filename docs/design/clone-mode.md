# Clone Mode & The Sync Protocol

Related: roadmap, `architecture-implementation-plan.md`, threat model.

## Modes of operation

| Mode | What the VM sees | Where changes land |
|---|---|---|
| Standard (implementation) | live work folders mounted rw | directly on disk |
| Plan | live folders mounted ro | plan documents only |
| **Clone** | a git clone of each repo, inside its disposable workspace — **no live mounts** | a patch the developer pulls into the editor |
| Remote (future, specced below) | a clone on a separate networked machine | the same patch protocol over a transport |

## Clone mode — mechanics

### The load-bearing fact
The session workspace is a host-side temp directory mounted into the VM.
Therefore the clone is **host-accessible**: every git operation (clone,
commit, diff, 3-way apply) runs on the host against
`<workspace>/repos/<name>`. The container needs no git, no credentials, and
no network; it just edits files through its mount. The developer's real repo
is only ever (a) a read-only clone source / fetch remote and (b) a
working-tree apply target — **nothing is ever pushed to any origin**, and the
local repo gains no commits.

### Why full clones, not worktrees
A `git worktree`'s gitdir points back into the primary repo's `.git`
directory — mounting a worktree rw into a VM hands the container a path into
the live repository. Disqualified. `git clone --local` from a local path is
cheap (hardlinked objects where the filesystem allows) and fully detached.

### Snapshot fidelity
"Clone the current branch" must mean *what the developer sees*, not just
HEAD: after cloning `-b <branch>`, the local dirty state is overlaid —
`git -C <local> diff --binary HEAD` applied to the clone, plus untracked
files (`ls-files -o --exclude-standard`, honoring .gitignore) copied in.
Then `git -C <clone> add -A && commit` creates the **sync base**, tracked as
ref `refs/sync/base`. The VM starts from a faithful snapshot.

### The sync protocol (symmetric 3-way patches through the clone)
All bookkeeping lives in the clone; `refs/sync/base` always names the last
state both sides share.

**Inbound — "pull the agent's work into my editor" (the common gesture):**
1. Commit agent progress in the clone (`add -A; commit "[sync] agent"`).
2. Patch = `git -C clone diff --binary sync/base..HEAD` (optionally filtered
   to one file for per-file pulls).
3. `git -C local apply --binary --3way` — **working tree only**, no commits;
   the developer reviews in the editor / working set and commits on their
   own terms.
4. Advance `sync/base` to HEAD. Conflicts (developer edited the same lines
   since the last sync) surface as standard conflict markers in the LOCAL
   files, reported per file — the developer resolves in-editor, which is
   where a developer wants conflicts.

**Outbound — "push my local edits to the VM":**
1. Commit agent progress (keeps the 3-way base honest).
2. Local committed delta: `git -C clone fetch origin <branch>` (origin = the
   local repo path), `diff --binary sync/base FETCH_HEAD`, apply `--3way` to
   the clone tree. Local dirty delta: `git -C local diff --binary HEAD`,
   apply `--3way`; copy untracked. Commit `"[sync] local"`; advance
   `sync/base`.
3. Conflicts land as markers in the CLONE's files and the next turn's host
   note tells the agent to resolve them — outbound conflicts are the
   *agent's* to fix, inbound conflicts are the *developer's*. Symmetry keeps
   both sides friction-free.

Notes: binary patches via `--binary` throughout; untracked files copy-win
(no merge semantics — documented); multi-root sets clone every **git** root
under `repos/<name>`, and clone mode refuses non-git roots with a clear
error rather than silently mounting them.

### UX — the working set IS the sync surface
Zero new mental models: in a clone session the existing Changes working set
lists the agent's changes in the clone (same glyphs, same `+N −M` stats,
same click-to-open-diff against the sync base). Only the verbs change:
- ✓ per-file → **Pull into editor** (per-file inbound patch)
- ✕ per-file → **Discard in clone** (`checkout sync/base -- <path>`, confirm)
- Header: **Pull all into editor** / **Push local → VM** / conflict rows
  flagged until resolved.
The composer mode control becomes **[Chat | Plan | Clone]**; the mounts
expandable shows `clone: <repo>@<branch> · no live mounts`; the session
briefing tells the agent it is on a disposable clone whose changes reach the
developer only through sync.

### Failure honesty
git-not-found on host → clone mode unavailable with an actionable error;
a failed 3-way apply never half-applies (git apply is atomic per invocation;
per-file pulls are one file per invocation); sync ops are disabled while a
turn is running (the agent may be mid-write).

## Remote mode (future) — specification only

Target: a separate machine with internet access (never production access)
runs the container; the developer's machine keeps the real repos.

The sync protocol is deliberately **transport-independent** — `sync/base`
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
   same UI — the working set does not know or care that the clone is remote.
4. **Security posture**: remote machine gets clones only (no live mounts —
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
