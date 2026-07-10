# 0010 - Diff view frames

Status: Accepted - 2026-07-10

Refs: `docs/adr/0004-workspace-isolation-and-review-flows.md`, `packages/core/src/sessionDiffService.ts`, `apps/vscode-extension/src/services/workspaceReviewAppService.ts`

## Context

The Changes list diffed each session root against one mutable baseline. Accept
rewrote that baseline in place, so the record of what a session changed was
destroyed as it was reviewed, and resume/reclaim re-baselined the root, so the
list silently reset mid-session. There was also no way to see only what the
last agent turn touched — the most common review question.

## Decision

An implementation session owns up to three baseline frames per root, and the
Changes list toggles between them:

- `session-start` — immutable snapshot taken once when the root is first
  baselined. Backs the **Full Session** view. Never advanced; rows whose
  content already matches the working frame render as accepted history.
- `current-session` — the working frame behind the default **Session** view.
  Accept advances it per file, exactly as before.
- `turn` — recaptured immediately before each user turn is dispatched. Backs
  the **This Turn** view ("changes since I sent the last message").

Accepting a file advances the working AND turn frames together and never
touches `session-start`. Re-baselining on resume/reclaim is additive only: a
root that already has session baselines keeps them.

Turn capture is derived, not walked twice: the fresh turn frame is a row copy
of the newest existing frame with only the files that changed since it
re-snapshotted; a clean diff writes nothing. Blobs are content-addressed and
shared across frames, so copies cost rows, not file content.

Clone sessions keep their sync surface (`refs/sync/base`) — the toggle applies
only to baseline-backed sessions.

## Consequences

Every view answers with rows carrying the frame's own baselineId, so open-diff,
accept, and discard need no per-view plumbing beyond the fan-out on accept, and
the diff editor's left pane is automatically the right frame. Discard is
frame-relative: a This Turn row rolls back to the send moment, a Session row to
the last accepted state.

Each turn dispatch pays one tree walk (mostly stat calls) plus a snapshot-row
copy per root when something changed. Stale turn frames are swept on the next
send, so at most one turn frame per root persists. Sessions from before this
decision have no `session-start` frame; Full Session and This Turn degrade to
the Session view for them.
