# Day-in-the-Life Workflow Scenarios & Adversarial Cases

Purpose: (1) a manual test matrix grounded in how an engineer running many
concurrent projects actually uses the tool; (2) an honest audit of where the
system adds friction that matters vs. where a careless or reckless user can
still hurt themselves. Related: `threat-model.md`.

## Part A — Ten normal-workflow scenarios

1. **Morning hotfix interrupt.** Create task "farm submit hotfix", link the
   open `farm_submit` folder, start an implementation chat (auto-mount, rw).
   Drag-drop the submission log into the composer (lands as a mounted path),
   paste the traceback. Agent needs the deploy config outside the workspace →
   emits an access request; the card shows a wrong guessed path, she edits it,
   Allow. Backend restarts, conversation auto-continues, bug found. Working set
   shows `submit_hooks.py +12 −3` plus a speculative refactor she didn't ask
   for — she opens the diff, accepts the fix, discards the refactor (confirm).
   Notes "root cause: migration ran before code deploy", marks done.

2. **Background refactor while reviewing a PR.** Kicks off a rename across
   `asset_api` + `asset_api_maya`, leaves the panel to review a PR. 20 min
   later: is it done, failed, or waiting on me? A first-class "waiting on
   user" signal — beyond the activity-bar badge's access-request count — is
   the gap that matters most here; a hidden-panel toast is the intended fix.

3. **Plan-only investigation.** "Move to USD 24.x?" Plan-mode chat over
   read-only mounts; asks for a migration assessment + dependency diagram. Plan
   docs land in the panel; opens the review, clicks the `usd_core` node in the
   mermaid diagram, comments "pinned by the Houdini build here", sends comments,
   gets a revision. Read-only is the point — no accidental code change.
   Plan docs live in SQLite; exporting them to repo `docs/` is a known gap.

4. **Two tasks in flight, one head.** Task A (coverage in `asset_api`) and B
   (docs in `pipeline_docs`) each get a chat on different workspaces, both
   running. Flips between them from the Work rows; writes a note on each
   capturing his mindset before lunch. Concurrent sessions hold their own
   runtime/working-set/transcript; unselected rows can't show "running a turn"
   vs "idle live" since the pulse is only computed for the selected session.

5. **Onboarding a new hire.** Read-only Plan chat: "explain DCC export → farm
   publish, with a diagram." Renames the session "publish pipeline explainer",
   notes "good onboarding doc — keep"; the new hire re-opens and replays it.
   Transcripts, rename, and notes are durable; the same doc-export gap as #3
   applies.

6. **The build dir nobody mounts.** Agent needs `D:\builds\maya2026\` to verify
   plugin load — not in any workspace and shouldn't be by default. Requests
   read-only; she allows. Meanwhile she hits ↗ on task B's workspace chip → new
   VS Code window, this window's chats keep running. Reloading this window,
   though, kills its live backends until runtime re-attach lands.

7. **Escalating the model mid-fight.** Cheap model circles a threading bug for
   three turns. Switches to the top-tier model — backend restarts, transcript
   intact, context replayed — fixed in one turn. Flips provider for a second
   opinion on the same conversation; checks Diagnostics for what's actually
   running and mounted. Replay is lossy: prose only, no tool-call history.

8. **Resuming a week-blocked task.** `productiondb` schema task went "blocked"
   waiting on another team. A week later: opens the task, reads her notes, opens
   the linked session — transcript replays but the backend was reconciled away.
   Starts a fresh chat on the same workspace/task, points it at the old plan
   doc. Continuing an ended session with a fresh backend plus context replay
   is a manual dance today, though the underlying machinery (event store +
   restoreContext) exists.

9. **The agent asks for something it shouldn't get.** Misled by a hardcoded
   path, the agent requests rw on the studio production share (under
   `deniedPaths`). Approval refuses with a denied-path error; she denies and
   redirects to a local fixture. History stays visible — the threat model
   earning its keep.

10. **Five o'clock board hygiene.** Deletes two dead experiment chats (hover →
    confirm), updates task states, checks System tab (no stray runtimes —
    purge worked), leaves one long-test session running overnight. Badge
    clear. That overnight session survives until the window reloads.

### Project touch-history (from the "hover a folder" ask)
When a task links a project, hovering it should show "recently changed by task
X (3 files, yesterday)". The data exists (task links + diff baselines +
sessions); it's a join + a hover card away — high value, low cost.

## Part B — Bad-actor & careless-user cases

The isolation invariant (micro-VM, mount policy, denied paths, no default
network) is strong against the *agent* escaping. The softer boundary is the
*human* — a distracted or reckless developer is the realistic threat to
production data, because approvals are where sandbox reach expands. Priority
order: agent escape / destructive host writes outrank everything; friction
belongs on the human approval steps that widen blast radius, and nowhere else
(friction on safe, reversible actions just trains people to click through).

### B1. The blind approver (approves every access request without reading)
Someone slamming Allow on every access card is the highest-leverage careless
path — each approval mounts a host directory into a writable runtime.
- **What holds today:** every approved rw path is re-validated against
  `deniedPaths` at approval time (`AccessRequestService.prepareApproval` →
  `assertMountAllowed`), *including after a path edit* — so production shares in
  the denylist are refused no matter how fast he clicks. Requests are capped at
  3 per agent turn (`MAX_ACCESS_REQUESTS_PER_TEXT`) and deduped, so a
  compromised/confused agent can't flood the card queue. Approvals mount, they
  don't execute — the agent still has to *do* something with the mount, which
  shows up in the working set.
- **What does NOT hold — build these:**
  - *Denylist is opt-in.* Anything not in `deniedPaths` is approvable. Blind
    Allow on a rw request for a real repo root is fully granted. **Mitigation:
    default-deny sensitive roots** (home config dirs, `.ssh`, `.aws`, network
    shares, drive roots) shipped as defaults, not left to config.
  - *No approval friction that scales with blast radius.* A read-only mount of
    a fixture dir and a read-write mount of a whole drive get the identical
    one-click card. **Mitigation: risk-tiered approval** — rw and
    broad/parent-of-home paths require typing the last path segment to confirm
    (the way `discardAll` already forces a second deliberate act), while a
    read-only mount of an already-open sibling folder stays one click.
  - *No standing record of what was granted.* **Mitigation: a per-task
    "granted access" ledger** visible in the Tasks tab, so a reviewer sees the
    task touched `\\studio\prod` even if the approver didn't notice.

### B2. The vibe coder (accepts everything, reads nothing, ships)
Runs turn after turn, hits **Accept all** without opening a diff, never enters
plan mode, treats the working set as a "make it green" button.
- **What holds today:** work happens in a disposable micro-VM over mounted
  copies — a bad run is contained, not sprayed across the host. Accept only
  *resets the diff baseline*; the real changes are on disk in the workspace and
  still go through the developer's normal Git commit/PR — this tool is not a
  path to `main` that bypasses review. Discard is blob-backed true rollback, so
  "undo the last three turns" is real, not best-effort. **Discard all** is
  inline-confirm (two deliberate clicks); chat delete is inline-confirm.
- **What does NOT hold — build these:**
  - ***Accept all* has no confirmation** while *Discard all* does — backwards.
    Accepting blindly is the silent-risk action (it advances the baseline so the
    next diff hides what you skipped); discard is recoverable. **Mitigation:
    make Accept all the higher-friction one** (confirm, or "N files, M with no
    diff opened — accept anyway?"), and surface an *unreviewed* marker on files
    whose diff was never opened.
  - *Nothing nudges toward plan-first on large changes.* A 40-file blast gets
    the same flow as a one-liner. **Mitigation: soft gate** — when a single
    turn's working set crosses a threshold (files or lines), suggest (don't
    force) dropping into plan/review before Accept all.
  - *Plan-gating exists but is unused on the happy path.* `assertPlanApproved`
    already blocks implementation turns when a governing plan isn't approved
    (Stage 5) — the vibe path simply never attaches a plan. **Mitigation:
    per-workspace policy** to *require* an approved plan for implementation
    chats on designated repos (the ones that matter), turning an opt-in guard
    into an opt-out one where it counts.
  - *No test/verification gate before Accept.* **Mitigation:** optional
    "changes with no passing test run" badge so green-chasing is at least
    visible.

### B3. The exfiltration-by-approval path (data leaves, not code)
The subtle one: the agent doesn't escape, but a careless approver mounts a
secrets/credentials directory read-only "just to let it look", and the agent's
provider round-trip carries that content off the machine.
- **What holds today:** network is `none` by default and `provider-scoped`
  when enabled (allowlist), so the only egress is the model provider itself —
  no arbitrary exfil channel. Denylisted paths can't be mounted at all.
- **What does NOT hold — build these:**
  - *Read-only is not "safe".* B1's mitigations apply — **default-deny
    credential dirs** matters more for read than write here, because the risk is
    *reading* secrets into a prompt, not writing. Flag read-only approvals of
    known-sensitive patterns (`.env`, `id_rsa`, `*.pem`, `credentials`) with a
    louder card even inside an allowed parent.
  - *No content-side tripwire.* **Mitigation (later):** a secret-scanner pass on
    newly-mounted content that warns before the first turn that can see it.

### B4. Approval fatigue as a designed-in risk
The meta-point behind B1–B3: if the tool asks for a click on everything, people
stop reading everything — and the one approval that mattered gets the same
reflex as the fifty that didn't. **The design rule (record it):** every
confirmation must correlate with real, hard-to-reverse blast radius. Safe,
reversible, contained actions stay one click (accept a small diff you can
discard, open a diff, switch model). Actions that widen host reach or are
destructive off the baseline get proportional friction (rw mount of a broad
path, Accept-all of unreviewed files, delete). We currently have this
*inverted* in two places (Discard-all guarded but Accept-all not; delete
guarded but rw-approval not) — fixing that inversion is the cheapest security
win available.
