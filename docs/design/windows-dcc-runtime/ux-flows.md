# UX flows — setup, daily use, maintenance, communication

Mockups referenced here live in `images/`. They are wireframes of the calm-
workbench surfaces (ADR 0020): left rail · chat rail · editor-area panels.
Each mockup shows the **collapsed default** and, beside it, the
**on-request expansion** — the default is what users live with.

## Personas

- **TD (owner):** sets up workstations, owns the mirror manifest and the VM
  image, answers incident banners.
- **Developer (daily):** writes tools in a session, wants validation to
  happen without thinking about it, occasionally needs a production file.

## Principles — seamless or bypassed

The bypass is always available: `mayapy` in a terminal. The product wins by
being *less* effort, never by prohibition. Budgets we design against:

1. **Zero added clicks on the happy path.** Auto-validation runs from the
   subtask recipe (ADR 0007); results arrive as one-line chips. No modal
   ever interrupts a turn for infra.
2. **Approvals only when risk changes.** New fixture, new mount, first
   production-tier grant: one card. Repeat runs, same scope: zero prompts.
3. **Setup ≤ 15 minutes, wizard-guided, with fix-it buttons.**
4. **Round trip ≤ 2× local**, or developers route around it (Phase 1 gate).
5. **Same paths everywhere.** Errors speak studio paths, never adapter
   internals.
6. **One fact per glance; everything else on request** — the disclosure
   ladder below is the law for every surface in this docset.

## The disclosure ladder

| Level | Surface | Budget | Content rule |
|---|---|---|---|
| L0 ambient | rail/status dot, chip color | a word | state only: running / ok / failed / blocked |
| L1 glance | one-line chip or row | ≤ 1 line | the single fact that changes what you do next |
| L2 evidence | expand a chip/row in place | one screen | output tail, receipt metadata, probe lines |
| L3 audit | report page, ledger, logs | unbounded | everything, timestamped, exportable |

Rules:

- Default render is L0/L1 only. L2 opens per item (chevron/click) and
  closes with its item; nothing remembers itself open.
- **Failure promotes exactly one level, once**: a failed run's L1 line
  carries the failing test + assertion (not the log); a quarantine promotes
  to a banner. Nothing else self-promotes, nothing reaches for a modal.
- Metadata (hashes, ledger ids, versions, approvers) is hover/L2 content —
  it exists for review-time and audit-time, so it never spends glance-time
  pixels.
- Actions live behind the surface they act on: chip actions inside the L2
  expansion, panel actions in a `⋯` menu; destructive ones state their
  consequences at invoke time, not ambiently.
- Green says one word. Verified-green detail ("what exactly passed, when")
  is L2. Red gets the extra line, because red is when a decision is needed.

**Overflow and scrolling** (lists grow — runtimes, queues, associations,
probe logs — and projects switch often):

- Every list (runtime registry, queue, association table, fixture sets)
  scrolls inside its own region with a visible scrollbar affordance; the
  panel itself never grows unbounded and never scrolls horizontally.
- L2 expansions cap at roughly 40% of the panel height and scroll
  internally; expanding one row must never push its siblings off-screen.
- Mono output (test logs, probe logs) wraps never — it scrolls
  horizontally *inside its own block* only.
- Long names/paths middle-truncate with full value on hover; counts
  (`+ 12 more`) link to the L3 list rather than rendering everything.

## F1 — First-run setup (TD) — `images/setup-wizard.svg`

Entry: Configure panel → Runtimes → "Set up Windows validation runtime".

One list, five rows, **each row is one line**. Rows the wizard can satisfy
itself run automatically and collapse to `✓ label`. Only a row that needs
the TD expands — showing the minimal control and nothing else (the storage
pick shows two eligible volumes; the group-membership fix is one elevated
button + a sign-out note). Auto-detected values (mirror roots and the
`STUDIO_ASSET_API_ROOT` redirect from the rezconfig scan) arrive
pre-filled with an edit affordance, not as forms. Finish state is a single
line — "Runtime ready · probes green 14:32" — plus Done.

The wizard's explanation text ("what is a clean baseline", storage rules,
what Remove tears down) lives behind `ⓘ` on each row, present when wanted,
absent when not.

## F2 — Daily auto-validation (Developer) — `images/validation-run.svg`

Entry: none. The chip is the entire default experience:

- Running: `▶ Validating tool_smoke · 0:41 · test_loader_no_network_touch ▸`
- Passed: `✓ Validation passed · 1 m 42 s ▸`
- Failed: `✕ 1 of 14 failed · test_icon_fallback — AssertionError: expected
  default set ▸` (the one promoted line: the failing test + assertion)
- Edited after the run: the passed line gains a suffix `· edited since ↻`
  — a word and a re-run affordance, not a card.

Expanding (L2) reveals: streamed output tail, then the receipt rows —
changeset, mirror version + freshness, fixtures manifest, license wait,
image/probe generation — and `Open report` (L3) / `Re-run`. License waits
surface in the L1 line only while they are the current state ("waiting for
Maya license · 2 ahead"), because that is the fact that explains the wall
clock.

Manual entry points (subtask card, palette) feed the same queue and produce
the same chip — manual-first workflows are first-class.

## F3 — Fixture from a prohibited location — `images/fixture-approval.svg`

Trigger A (user): drag `P:\Projects\...\hero.ma` into chat, or composer
paperclip → picker. Trigger B (agent): access request. One card either way,
**three lines tall**:

1. `Production file → snapshot` + tier badge
2. `hero_rig.ma · 48 MB · P:\Projects\ShowA\rigs\`
3. typed-confirm field + `Approve snapshot` / `Deny`

That is the whole card. The friction budget is spent on exactly one thing —
the typed confirmation that marks production tier (ADR 0001). The
mechanics (copied at approval, hash recorded, expires with session, wiped
between jobs, destination path) sit behind `ⓘ how snapshots work`, and
folder requests swap line 2 for `N files · total size ▸` with the list at
L2 and `Narrow…` as the primary action. Non-production files are a
one-line, one-click variant of the same card.

After approval, provenance is a one-line chip
(`hero_rig.ma · production snapshot · session-scoped`); ledger id, hash,
approver, and expiry are its hover/L2 detail. Deny is one click and the
denial message names the alternative path.

## F4 — Runtimes & health (TD) — `images/runtime-health.svg`

**Developers never visit this panel.** Their entire surface is an L0 rail
dot (`DCC ✓ / ▶ / ✕`) whose hover popover says one line:
`Validation ready · queue 0 · isolation verified 09:00` — the dot reflects
whichever runtime the *current task* routes to.

The TD panel is a **scrollable list of named runtimes**, one line each:

- `default — running · 9.2/16 GB · queue 1 ▸`
- `cpp-builds — on-demand (stopped) · MSVC image ▸`
- `production_tester — running · fixture set ShowA_approved ⚠ badge ▸`
- `pipzone — keep-warm · idle 2 h ▸`

Expanding a runtime row reveals its three concern lines (Runtime /
Isolation / Mirror as before), its associations (`3 projects ▸`), lifecycle
policy, and the `⋯` actions. The shared mirror is one row at the top, not
repeated per runtime. Policy-profile exceptions (like `production_tester`)
carry a permanent badge — the one ambient security marker in the list.
Queues render only when non-empty; diagnostics are L3.

## F5 — Incident: a must-fail probe passed

The one deliberate exception to calm: a full-width persistent banner on the
task hub and configure panel. "Validation runtime quarantined — production
isolation check failed at 09:12. Queue blocked. No jobs ran since the last
green probe at 08:00." Actions: probe log · revert & re-probe · remove.
Never auto-dismisses; evidence issued between last-green and quarantine is
flagged. Sessions are unaffected.

## F6 — Where validation runs: routing & topology — `images/runtime-routing.svg`

One model serves every studio preference: **named runtimes + association
cascade + one default**. Resolution per job: chat/task override →
project/workspace association → default. Topology presets are starting
configurations, not modes:

- *Single VM for everything* → just use the default; create nothing.
- *Default + named* (the sponsoring use case) → create `cpp-builds`,
  `pipzone`, `production_tester`…; associate projects with them.
- *One per project* → enable the auto-create rule (new project ⇒ on-demand
  runtime from a template, reaped after N idle days).

UX surfaces, in ladder order:

- **L1, task header:** `runs on production_tester ▾` — a quiet picker
  visible only when the task's runtime differs from the default. The
  validation chip's L2 always records which runtime produced the evidence.
- **L2, association editor** (Configure → Validation runtimes): a
  scrollable two-column table `project → runtime`, prefilled by the
  cascade; a project with no row simply uses the default. Creating a named
  runtime = name + image + lifecycle + (TD-gated) policy profile.
- **Switching projects costs nothing:** association resolves at job time;
  the default stays warm; an `on-demand` target that must boot first shows
  `starting cpp-builds · ~40 s` as honest queue state, not a spinner.
- **No silent rerouting:** if the resolved runtime is unavailable, the job
  parks with the reason and a `Run on default instead` action that opens a
  confirm showing the **policy delta** (fixtures, capabilities, image).
  Same-profile reroutes are one click; cross-profile reroutes require the
  delta confirm in both directions.
- Studio managed policy can pin topology, cap concurrent warm VMs, and
  restrict who may create policy-profile exceptions.

## Communication spec

- **L0/L1 chips** never block input and never carry metadata.
- **Toasts** (attention stack): approval needed, job parked, license wait
  past threshold. One line + one action.
- **Banners**: quarantine, mirror unsyncable, VM unreachable — states that
  own the truth until resolved.
- **Message style:** what + why + one action, studio vocabulary:
  "hero_test failed: P:\Projects is not available in validation runs —
  attach the file as a fixture (button)". Never
  "EACCES on \\\\host-internal\\pkgroot\\Projects".
- **Never invent green** (ADR 0021): unverifiable states render unknown
  with Refresh — as one calm line, like everything else.
