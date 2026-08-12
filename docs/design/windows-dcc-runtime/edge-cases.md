# Edge-case catalog

Format: **Scenario → Behavior (decided) → Why.** Items marked *Open* need a
call before Phase 3 exits. "VM" = the pooled validation runtime.

## A. Prohibited content

**A1. AI must analyze a file that lives in `X:\Projects`.**
→ Fixture flow (`security-and-mounts.md`): user drag/pick or agent request →
risk-tiered card (typed confirm for production) → snapshot copy into session
uploads or job fixture root → grants-ledger entry with hash + expiry →
provenance chip. Never a mount, never ambient.
Why: the explicit-approval + snapshot model keeps "no production access" true
while still answering the real need.

**A2. The needed "file" is a 40 GB cache/sequence.**
→ The card shows size before approval and offers narrowing (frame range,
single file, metadata listing) as the primary action; oversize approval is
typed-confirm with a configurable ceiling.
Why: giant copies are where snapshot discipline dies; make the narrow path
the easy path.

**A3. Agent asks for a whole production folder.**
→ Folder requests preview file count + total size; approval enumerates an
explicit file list into the ledger (not "the folder"); very large listings
paginate the preview.
Why: grants must be auditable as concrete items, not open-ended scopes.

**A4. Recurring fixtures ("we always test against ShowA's hero rig").**
→ Named fixture sets: a TD-curated, reviewable bundle with its own expiry
and re-approval on content-hash change. Sessions reference the set; the
ledger records set version.
Why: prevents weekly re-approval fatigue without creating standing mounts.

**A5. Agent output claims to need to *write* to production.**
→ No product path exists; the card kind cannot be requested. The agent gets
a protocol error naming the review flow; the chat renders the collapsed
note.
Why: write-back is a policy invariant, not a bigger approval.

**A6. Fixture content itself is sensitive (client footage).**
→ Fixture cards carry the same sensitive-tier treatment as mounts
(ADR 0001); fixture roots are wiped between jobs; evidence stores the
manifest hash, never content.
Why: copies inherit the classification of their source.

## B. Access & identity

**B1. User drags a file the *host* user can read but policy denies (e.g.
`X:\Projects` via drag instead of picker).**
→ Same card as A1 — drag is a trigger, not an approval bypass. Denied paths
config cannot be dragged past.
Why: one gate, many doors.

**B2. Grant expiry mid-session.**
→ Fixtures expire with the session by default; longer grants show remaining
time on the provenance chip and re-prompt on reuse after expiry.
Why: temporary means temporary, visibly.

**B3. Two windows, one VM.**
→ Ownership follows ADR 0008: the queue is product-global, jobs carry the
submitting window/session; the health view is read-only from non-owning
windows except queue-pause, which is global with attribution.
Why: shared infrastructure needs one truth, not per-window state.

## C. Subagents & delegation

**C1. Subagent requests validation.**
→ Allowed iff the parent session has validation capability; the job runs
under the parent's task with the child's agent id stamped in evidence.
Why: children never exceed parents (ADR 0001), and receipts must attribute.

**C2. Subagent requests a fixture the parent lacks.**
→ Request escalates to the parent session's approval surface (Lead's inbox
pattern, ADR 0016); approval grants parent + child subset simultaneously.
Why: preserves the subset invariant without dead-ending the child.

**C3. Parallel subagents each queue jobs.**
→ Jobs serialize on run slots (ADR 0015) with per-task fairness; the chip
shows queue position. Parking follows retry-once-then-park.
Why: one VM is a deliberate bottleneck; make waiting legible instead of
pretending concurrency.

## D. Mixed runtimes

**D1. Linux session + Windows validation in one task.**
→ Star topology only: snapshots through the host, no cross-runtime mounts,
no cross-runtime network. Evidence binds changeset hash.
Why: two enforcement domains must not blur.

**D2. Agent keeps editing while a job runs.**
→ Job completes against its snapshot; receipt marked `superseded` when the
working set moved on; recipes may auto-requeue once.
Why: honest-status rule (ADR 0021) extends to evidence.

**D3. Patch from Linux clone contains case-colliding paths or symlinks.**
→ Apply step fails closed with the offending paths listed; symlinks in
changesets are rejected for VM jobs.
Why: Windows guest semantics differ; fail at the boundary, not mid-test.

**D4. Line endings.**
→ VM git pins `core.autocrlf=false`; profiles that need CRLF declare it.
Why: validation must test the changeset's bytes, not a translation.

## E. Operations

**E1. Mirror is stale or NAS is offline at job start.**
→ Sync-before-job with a freshness stamp; if sync fails, policy toggle:
run-with-last-good (default, warning chip + stamped staleness) or block.
Why: NAS outages shouldn't silently produce misleading results — or
needlessly stop local iteration.

**E2. Mirror sync catches a package mid-publish.**
→ Sync uses the manifest scan's package-version granularity and skips
half-written versions (definition-file check, matching the studio's
`check_package_definition_files` setting); skipped versions are listed in
the sync report.
Why: torn packages produce confusing, non-reproducible failures.

**E3. VM unreachable / SSH dead / checkpoint corrupt.**
→ Standard cleanup ladder: retry → quarantine → one-click "revert to clean"
or "rebuild from image"; queued jobs park with reason.
Why: reuse the existing inventory lifecycle instead of new states.

**E4. License seats exhausted (mayapy checkout fails or waits).**
→ License wait is detected and shown distinctly from a hang ("waiting for
Maya license, 3 ahead"); watchdog clock pauses during known license waits;
threshold toast if chronic.
Why: the most common studio failure must never read as "the tool is broken".

**E5. Probe must-fail passes (isolation breach).**
→ Quarantine + block + persistent banner + flag evidence since last green
(F5 in `ux-flows.md`).
Why: incident, not inconvenience.

**E6. Windows updates / DCC upgrades in the guest.**
→ TD action "Update image": pause queue, snapshot, patch, re-probe, new
clean baseline; evidence records image generation.
Why: image drift must be deliberate and attributable.

**E7. Host reboots mid-job.**
→ Job is idempotent-restartable: workspace is re-shipped, evidence for the
interrupted run is discarded, requeue-once then park.
Why: matches the existing crash-consistency posture of runtime inventory.

## F. Packages & environment

**F1. Package hardcodes `X:\Projects` (e.g. `FR_ASSET_API_SILEX_ROOT`).**
→ Fail-closed by default (path absent/stub); per-job fixture composition
seeds exact relative paths when granted; optional wrapper-level env
override for explicit redirection. No package edits required.
Why: found in the reference scan; the namespace design absorbs it.

**F2. Package references an X: root outside the manifest (new class).**
→ Release-time scan diffs references vs manifest and raises a proposal;
in-guest canary resolve asserts every env path exists.
Why: the allowlist must evolve by review, not by breakage.

**F3. Developer's work depends on their local dev packages
(`C:\Users\<them>\rez_pkgs_dev`).**
→ The job spec may include declared local package payloads (size-capped,
copied like fixtures) OR the changeset builds them from source in the job
workspace. Evidence flags non-released dependencies prominently.
Why: this is the daily iteration loop — if it doesn't work, developers
bypass; if it's invisible, green receipts overclaim.

**F4. `user\${USERNAME}` packages_path in the guest.**
→ Resolves to the agent account's (empty) repo by design; user packages
reach jobs only via F3.
Why: another identity's ambient packages would make results
irreproducible.

**F5. Test code tries `pip install` / network fetch.**
→ Fails (no egress). The failure message says why and points at the rez
external repo path or an approved wheel fixture.
Why: reproducibility and the no-egress invariant beat convenience here —
but the error must teach, not stonewall.

**F6. Rez package cache poisoning across jobs.**
→ Accepted residual: serialized jobs, revert cadence resets cache, evidence
records revert generation; optional strict mode wipes cache per job at a
measured time cost.
Why: bounded risk, honest bookkeeping (see residual risks).

**F7. Long paths / deep rez trees.**
→ Guest enables Win32 long paths; job workspaces live near drive root.
Why: cheap prevention for a classic Windows failure.

**F8. GPU-dependent tests (playblast, Karma XPU).**
→ Out of scope v1; validation profiles declare capabilities and the chip
says "profile cannot run GPU tests on this runtime" instead of failing
cryptically. GPU-P is Phase 5.
Why: honest capability beats mysterious red.

## G. Honesty & comms

**G1. Evidence older than the mirror it ran against.**
→ Receipts carry mirror manifest version + freshness; the subtask view
shows both.

**G2. Everything unknown renders as unknown.**
→ Health, probe, license states show explicit unknown + Refresh when the
product cannot verify (ADR 0021 rule), never inferred green.

**G3. Every denial teaches the sanctioned path.**
→ Each blocked action's message names the flow that exists for the need
(fixture card, rez external repo, review land) with a button when possible.
Why: bypass culture starts where denials are dead ends.

## H. Routing & multiple runtimes

**H1. A job resolves to an offline / deleted runtime.**
→ Park with reason + `Run on default instead` action. Same-profile reroute
is one click; cross-profile opens the policy-delta confirm. Never silent.
Why: threat-model fallback rule — rerouting must not broaden access, and
narrowing silently just fails confusingly.

**H2. Routing *to* a broader-profile runtime (e.g. `production_tester`).**
→ Always the delta confirm; TDs may restrict which projects/users can
target profile-exception runtimes; every receipt shows the runtime badge.
Why: a standing fixture set is a deliberate exception, not a shortcut.

**H3. Per-project auto-create storms (user opens ten projects).**
→ Runtimes are created lazily on *first job*, not project open; `on-demand`
lifecycle; reaped after N idle days (association survives reaping — next
job recreates from template).
Why: topology presets must not translate clicks into VMs.

**H4. Warm-VM count exceeds the RAM budget.**
→ Managed-policy cap on concurrent warm runtimes; excess starts queue
behind `starting <name> · ~40 s` boot states; the runtimes list says which
cap bit and why.
Why: honest queueing beats thrashing 32 GB workstations.

**H5. Rename / delete a named runtime that has associations.**
→ Rename is display-only (identity is an id; associations, evidence, and
receipts are unaffected). Delete requires choosing reassignment (default or
another runtime) with the affected-project count shown; the default runtime
cannot be deleted, only re-pointed.
Why: routing tables must never dangle silently.

**H6. Personal vs studio association conflicts.**
→ Associations are personal settings by default; managed policy may ship
studio associations and pin them. Pinned rows render locked with the
policy source; evidence always records the runtime that actually ran.
Why: same layering as the rest of studio policy — personal narrowing,
managed authority.

**H7. Project switch / task switch while a job is running.**
→ Running jobs keep their runtime and changeset; routing affects new jobs
only. The rail dot follows the *current task's* resolved runtime.
Why: switching projects regularly is the norm; it must never yank work.

**H8. Recipe needs a capability the resolved runtime lacks (C++ job →
default without MSVC).**
→ Profiles declare capabilities; recipes declare requirements; the mismatch
is caught at queue time with `route to cpp-builds?` — not five minutes into
a failing build.
Why: the routing layer exists precisely to make these mismatches cheap.
