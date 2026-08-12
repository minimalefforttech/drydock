# Maintenance runbook — Windows DCC validation runtime

TD tasks for the pooled validation VM (ADR 0022). Design and rationale live in
[security-and-mounts.md](security-and-mounts.md), [ux-flows.md](ux-flows.md),
and [edge-cases.md](edge-cases.md); this file is only the ordered steps. Where
a UI is not built yet, the step names the environment variable or CLI that is
authoritative today.

## Provision the guest

1. Create a Gen 2 VM named `drydock-validation-<name>` — `drydock-validation-default`
   for the default runtime. Inventory reconciles on that prefix, so the name is
   not cosmetic. Rename in the product instead of in Hyper-V (edge case H5).
2. Attach **only** the internal switch (`drydock-internal`). No Default Switch,
   no external adapter, no gateway, no DNS. Give the guest a static address on
   the internal subnet; the host vNIC is its only route.
3. Apply the default-deny extended port ACL set plus the allows — host
   internal address and license server `IP:ports`, nothing else. ACLs survive
   `Restore-VMSnapshot` ([spike-report.md](spike-report.md)), so the revert
   cadence cannot silently drop the network posture.
4. Install in the guest: Windows + OpenSSH **server**, git, the DCC installs
   (Maya/Houdini), then bootstrap rez from `X:\Pipeline\rez\configs`.
5. Map the mirror as `X:` from `\\<host-internal>\xroot` using the reader
   account created by `setup-share.ps1` (`cmdkey /add:<host-internal>
   /user:<host>\drydock-xroot /pass:`). The password prints once.
6. Guest hygiene: enable Win32 long paths (F7); `git config --system
   core.autocrlf false` (D4); run jobs as a dedicated non-admin account that
   holds no provider credentials.
7. Adopt it: Configure → Validation runtimes → Adopt (M7). Adopt records the
   connection (host, user, port), pins the guest key into the **product-owned**
   known-hosts file, and installs the product-owned key — `hyperv_known_hosts`
   and `hyperv_ed25519` in the extension state directory, never the user's
   `~/.ssh`. A changed guest key after adopt is a hard failure, not a prompt.

## First mirror sync

The manifest is the allowlist; nothing is mirrored that it does not name. Its
schema (subtrees, stub dirs, redirects, version) is in
`tools/xroot-mirror/src/manifest.ts`.

1. Elevated, once per host:
   `pwsh -File tools/xroot-mirror/scripts/setup-share.ps1 -MirrorRoot D:\xroot`
   (`-WhatIf` first). Creates the single-purpose reader account, read-only NTFS
   + share, caching off, access-based enumeration on, and an inbound 445 allow
   scoped to the internal switch.
2. `node tools/xroot-mirror/dist/index.js plan --manifest <path>` — read what
   would be copied and which half-written package versions are skipped (E2).
3. `... sync --manifest <path>` — robocopy the subtrees, create the stub dirs,
   write the state file. `--dry-run` prints the exact commands instead.
4. `... status --manifest <path>` — freshness and manifest version; this is
   what receipts stamp (G1).
5. Standing: `... diff --manifest <path> --strict` at package-release time.
   A newly referenced `X:` root is a manifest proposal to review, never a
   silent addition (F2).

## Clean baseline

- Run the probe suite first. A baseline is only clean if the must-fail probes
  failed and the canary resolve succeeded (`security-and-mounts.md` §Probes).
- With probes green, take the checkpoint: `drydock-clean-<yyyy-mm-dd>`. That
  checkpoint is the revert target for this image generation.
- Revert cadence is policy, not taste: revert on the configured cadence and
  after any job that touched a quarantine condition. Re-run probes before the
  first job after **any** revert; evidence records the revert generation, so a
  skipped probe run shows up as an unknown, not a green.
- Keep one clean checkpoint per image generation. Delete superseded ones so a
  revert cannot land on a pre-patch guest.

## Update image (E6)

Deliberate and attributable, in this order:

1. Pause the queue (global, attributed — B3). Let the running job finish.
2. Checkpoint the current state so the patch is reversible.
3. Patch: Windows updates, DCC upgrades, rez config refresh, mirror remap
   changes.
4. Re-probe. Any must-fail success stops the update here — see below.
5. Take the new clean baseline checkpoint; remove the superseded one.
6. Resume the queue. Evidence issued from here records the new image
   generation, so before/after results stay comparable.

## Incident response (F5)

A must-fail probe that passed is an isolation breach: the runtime goes
`quarantined`, its queue blocks, and a persistent banner owns the truth until
resolved. It never auto-dismisses and is never a toast.

1. Read the probe log — which check passed, against what path or address, at
   what time. That is the incident record.
2. Choose one: **revert & re-probe** (restore the last clean checkpoint; the
   runtime returns to service only when the full suite is green again), or
   **remove** the runtime (associations reassign; the default cannot be
   deleted, only re-pointed — H5).
3. Treat evidence issued between the last green probe and the quarantine as
   flagged: re-verify those subtasks rather than trusting their receipts.
4. Sessions are unaffected — agent runtimes have no route to the VM. Do not
   restart sessions as part of this.

Same ladder for a dead exec channel or corrupt checkpoint (E3): retry →
quarantine → revert-to-clean or rebuild; queued jobs park with the reason.

## Storage and license server

- `DRYDOCK_HYPERV_ROOT` (VM disk) and `DRYDOCK_XROOT_MIRROR` (mirror root) must
  be **local** volumes — never the studio share. The combined floor is 150 GB;
  `npm run prevalidate` reports the measurement as `hyperv.storage`.
- `DRYDOCK_LICENSE_SERVER=host:port[,host:port]` is the license configuration
  today; the Configure UI for it arrives with M7. The vNIC allowlist derives
  from this list, so changing it means re-applying the port ACLs on every
  validation VM.
- License waits are a first-class state, not a hang: chronic waiting is a seat
  problem to escalate, not a runtime to quarantine (E4).
- `npm run prevalidate` also reports `hyperv.features`, `hyperv.admin`,
  `hyperv.ssh`, and `hyperv.license-server`. Its artifacts carry
  identity-bearing environment detail and stay gitignored local diagnostics
  (`docs/design/threat-model.md` §Data And Audit Assumptions).
