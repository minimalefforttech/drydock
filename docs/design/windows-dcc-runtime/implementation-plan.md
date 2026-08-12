# Implementation plan — Windows DCC validation runtime

The executable breakdown of [upgrade-plan.md](upgrade-plan.md). Milestones
are ordered, file-anchored, and individually shippable; each ends with
`npm test` green. Start point for the next working session is **M0 + M1a**,
which are unblocked regardless of environment state.

## Ground rules

- Work lands on `ADR-22` (this docset's branch) via the repo's normal PR
  flow; one milestone per PR where practical.
- Tests are `node:test` suites beside sources, like the rest of
  `packages/*`; `npm test` (tsc -b + suite) green is part of every
  milestone's definition of done.
- No new runtime dependencies: the control plane is `powershell.exe` with
  **fixed-literal scripts only** (the `snapshotProcessTree` rule) and
  `ssh.exe` (ships with Windows). Parameters pass as argv/env, never
  interpolated into script text.
- The Phase 1 numbers from `upgrade-plan.md` are a **kill gate**: M2+ may
  start in parallel on cheap items, but nothing past M3 proceeds if the
  spike misses its ceilings.

## Before the next session (user checklist)

1. Elevated: `Add-LocalGroupMember -Group "Hyper-V Administrators" -Member
   "floating-rock\alex.telford"`, then sign out/in. (`Get-VM` must return
   without error.)
2. Storage decision: `C:` has 36 GB free — below the 150 GB floor. Free
   space or add a local volume for VM disk + mirror.
3. Identify the Windows guest image route (ISO/VHDX + license). Needed for
   M1, not for M0/M1a.

## Milestones

| # | Milestone | Size | Depends on |
|---|---|---|---|
| M0 | Prevalidate gates | S | — |
| M1a | Hardware smoke (no guest image) | S | group membership |
| M1 | Full spike + runbook + kill gate | M | M1a, image, storage |
| M2 | Contracts + registry + routing | S–M | — (parallel-safe) |
| M3 | `hyperv` adapter | M | M1 pass, M2 |
| M4 | Validation job service | M | M3 |
| M5 | Mirror + reference scan tooling | M | — (parallel-safe) |
| M6 | Probes + quarantine wiring | S | M3, M5 |
| M7 | UX surfaces | M–L | M4, M6 |
| M8 | Hardening, policy keys, docs | S | all |

### M0 — Prevalidate gates

New module in `tools/prevalidate/src/` reporting: Hyper-V feature states
(CIM `Win32_OptionalFeature`), Hyper-V Administrators membership, local
storage floor (VM disk + mirror volumes), `ssh.exe` presence, license-server
host:port config present. Wire into the existing report/strict-mode flow.
*Done when:* `npm run prevalidate` renders the section with honest
pass/fix-needed rows on the reference machine.

### M1a — Hardware smoke, no guest image required

Fixed scripts under `tools/hyperv-spike/`: create/remove internal switch
(`New-VMSwitch`), create a VM around a blank VHDX, apply
`Add-VMNetworkAdapterExtendedAcl` default-deny set, `Checkpoint-VM` →
`Restore-VMSnapshot` → `Remove-VM`, timing each step. No boot, no OS.
*Done when:* script runs clean as a non-elevated Hyper-V admin and prints
timings; failures map to prevalidate gaps.

### M1 — Full spike + kill gate

Hand-provision the guest per the runbook (Windows + OpenSSH + Maya/Houdini
+ rez bootstrap from `X:\Pipeline\rez\configs`); measure the four numbers
(warm-restore ready time ≤ 20 s; multiplexed-SSH exec ≤ 300 ms;
line-stream latency vs the ADR 0021 watchdog; validation round trip ≤ 2×
local, ceiling 3×). Record results in `spike-report.md`; record the
kill/continue decision as a status note on ADR 0022.

### M2 — Contracts, registry, routing

- `packages/contracts/src/runtime.ts`: add `"hyperv"` to
  `RuntimeAdapterKind` (inventory stores the kind as a string — verify no
  migration needed, expect none).
- New `packages/contracts/src/validationRuntime.ts`: `NamedRuntimeConfig`
  (id, displayName, image, lifecycle `keep-warm|on-demand|pinned`,
  capabilities, policyProfileRef), `RuntimeAssociation`
  (projectRootId → runtimeId, source personal|managed), `ValidationJob`,
  `ValidationReceipt` (changesetRef, runtimeId, profileRef, mirrorVersion,
  fixtureManifestHash, licenseWaitMs, probesGreenAt, superseded).
- `packages/storage-sqlite`: migration + `validationRuntimeStore.ts`
  (follow `appStateStore.ts` shape) with tests.
- `packages/core/src/validationRoutingService.ts`: pure cascade resolution
  (chat/task → association → default), topology presets, warm-cap
  arithmetic, no-silent-reroute results (`resolved | park(reason) |
  needs-confirm(delta)`), fully unit-tested.

### M3 — `hyperv` adapter

- `packages/runtime-adapters/src/hyperVControl.ts`: fixed-literal PS
  wrappers (`Get-VM` by prefix, start/stop, checkpoint/restore, counters).
- `packages/runtime-adapters/src/hyperVRuntimeAdapter.ts`: implements
  `RuntimeAdapter` (`packages/core/src/runtimeAdapter.ts`) + `exec` with
  `onStdoutLine` via `ssh.exe` (ControlMaster multiplexing; abort kills the
  ssh child; guest-side pkill sweep on job end), adopt-existing runtime
  path, `listExternalRuntimeNames` from `Get-VM drydock-*`.
- `commandDiscovery.ts`: `discoverSshCommand()` / powershell discovery,
  same native-exe-only rules.
- Tests with a fake `CommandRunner` mirroring the docker adapter's
  coverage: lifecycle, exec streaming, abort, name-token extraction.

### M4 — Validation job service

`packages/core/src/validationJobService.ts`: serialize jobs through the
run-slot machinery (`packages/work-management/src/subtaskOrchestrator.ts`);
ship changesets with the `cloneSyncService.ts` patch path (reject symlinks/
case collisions at the boundary); compose job env (fixture root, job-scoped
`MAYA_APP_DIR`/`HOUDINI_USER_PREF_DIR`, wrapper-level redirect overrides);
assemble receipts (+ superseded detection on changeset drift); stamp
subtask verification via `packages/work-management/src/taskService.ts`.
License-wait detection pauses the watchdog clock and surfaces as state.

### M5 — Mirror + reference scan

`tools/xroot-mirror/`: manifest schema (subtrees, redirects, version);
robocopy runner with fixed args + torn-package skip (definition-file
check); `package.py` reference scanner producing the X:-root class list;
drift diff against the manifest; host share creation script (single
service account, internal-switch scoped). Core reads freshness/version for
receipts.

### M6 — Probes + quarantine

`packages/core/src/validationProbeService.ts` running the must-fail suite
over adapter exec (read production, write mirror, egress beyond allowlist)
plus the canary resolve; failures set inventory `quarantined`, block that
runtime's queue, and emit the banner event. Scheduled + on-adopt + post-
revert triggers.

### M7 — UX surfaces

Anchored in the calm-workbench code from the refactor: runtimes list +
association editor in `configurePanelProvider.ts` /
`webview-ui/src/configure.ts`; rail dot in `railViewProvider.ts` /
`railShared.ts`; validation chips through the transcript protocol-note
pattern (`packages/contracts/src/webviewMessages.ts` envelope); fixture
card on the existing `packages/core/src/accessRequestProtocol.ts` flow with
the production tier's typed confirm; task-header runtime picker. Every list
follows the ladder's scroll rules. Visual coverage added to
`tools/webview-harness/visual-tests.md`.

### M8 — Hardening + docs

Threat-model validation-runtime section; managed-policy keys (topology
pin, warm cap, profile-exception gate) in `studio-security-policy.md`;
maintenance runbook; flip ADR 0022 to Accepted with the spike numbers.

## Next-session agenda (concrete)

1. `npm run prevalidate` — confirm baseline before changes.
2. Build M0 (prevalidate gates) — pure TypeScript, no environment needs.
3. If group membership is live: run M1a hardware smoke, record timings.
4. If storage decided: start the M1 guest runbook; else begin M2 contracts.
