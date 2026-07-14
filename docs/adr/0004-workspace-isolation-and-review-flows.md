# 0004 - Workspace isolation and review flows

Status: Accepted - 2026-07-06

Refs: `docs/design/clone-mode.md`, `docs/design/task-review.md`, `docs/design/roadmap.md`

## Context

Drydock needs isolated clone work, a review view that cannot accidentally ship
changes, and sane behavior when two VS Code windows open the same state root.

## Decision

Clone mode uses full `git clone --no-hardlinks` copies in the disposable
workspace. Do not use worktrees; their gitdir points back into the live repo.

Sync uses a three-way patch protocol through `refs/sync/base`. Pull brings
clone changes into the developer working tree without committing. Push sends
local commits and dirty edits to the clone. The side receiving conflicts owns
resolving them. Patch size caps apply.

Task Review is read/review UI over existing state. It can collect comments and
open revision turns for the right sessions. It never commits, pushes, or ships.

Review authorship is explicit. User-created comments are stamped `user`;
host-side reviewer and guard flows may stamp `agent-reviewer` or `guard`.
Webviews cannot choose a machine author, and Task Review labels every non-user
comment so a machine finding never reads as the developer's opinion.

Multiple VS Code windows coordinate with `hostInstanceId` and `heartbeatAt`.
A fresh heartbeat from another window makes the session read-only here. Stale
ownership can be adopted when the runtime can be rebound safely.

## Consequences

Clone mode is slower to start, but it is actually isolated. Review can show a
lot because it cannot ship anything. Window races become read-only sessions
instead of two hosts fighting over one runtime. Review provenance remains
visible regardless of which host-side flow produced a comment.
