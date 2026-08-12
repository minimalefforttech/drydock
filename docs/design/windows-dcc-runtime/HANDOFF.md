# ADR-22 implementation handoff

Session handoff, 2026-08-13 (second session). Branch `ADR-22`.
Full suite: **`npm test` → 748 tests, 0 fail, 9 skipped** (4 pre-existing
Windows symlink-privilege skips + 5 opt-in real-DCC tests that skip without
`DRYDOCK_DCC_ITEST=1`).

## What this is

ADR 0022 (`docs/adr/0022-windows-dcc-validation-runtime.md`): a second runtime
class — a pooled Hyper-V Windows VM (adapter kind `hyperv`) that runs
`mayapy`/`hython` auto-validation against the studio's Windows rez packages,
with no host execution and no path to production.
Design docset: `docs/design/windows-dcc-runtime/` (read `README.md` first).

## Status: M0–M8 implemented and reviewed; exec path proven on real DCCs

Commits on `ADR-22` (newest first), all green at each step:

| Commit | What |
|---|---|
| (this session) | Identifier scrub + real-DCC live fire + `-Command` tag-join fix + vsix 0.17.0 + docs |
| `21df44a` | Session handoff document |
| `c9c19b2` | Code-review fixes (2 security, 8 correctness) |
| `16ba4d2` | M8: ADR status note + post-M8 backlog + vsix 0.16.0 |
| `09f47af` | M7: validation UX end to end |
| `34ddc5f` | M4: validation job service, changeset ref, Windows patch boundary |
| `6050edb` | M6: standing must-fail probe suite + quarantine |
| `61f8539` | M8a: threat-model deltas, managed policy keys, runbook |
| `561567a` | M3: hyperv adapter, multi-adapter core services, bus kinds |
| `2a328b0` | M5: package-mirror tooling + mirror status reader |
| `299f4f8` | M0: prevalidate Hyper-V gates |
| `9e3ee02` | M2: contracts, sqlite store, routing cascade |
| `77b6e81` | M1a: Hyper-V hardware smoke scripts + spike report |
| `f205f76` | ADR 0022 proposal + docset (pre-existing; the one commit on origin) |

**vsix**: **0.17.0**, packaged this session from the current tree and scanned
clean of studio identifiers. The 0.16.0 artifact was deleted (it contained
pre-scrub identifier strings — do not distribute any copy of it that exists
elsewhere).

## This session's work

1. **Production-identifier scrub (55 files).** The real server/share
   (`therock`/`Floats`), studio drive letter (`X:`), `xroot` naming family,
   `FR_*`/`fr_*`/`FR-####` studio-initial identifiers, an internal system
   name, a real domain login and a real username are gone from the tree —
   replaced by `\\studio-fs\share`, `P:`, `pkgroot`, `STUDIO_*`, `pipe_*`,
   `TSK-####`, `EXAMPLE\td.user`, `senior.td`. Renames: `tools/xroot-mirror`
   → `tools/pkgroot-mirror` (package `@drydock/pkgroot-mirror`),
   `xrootMirrorStatus.ts` → `pkgrootMirrorStatus.ts`,
   `DRYDOCK_XROOT_MIRROR` → `DRYDOCK_PKGROOT_MIRROR`,
   `xroot-manifest.json` → `pkgroot-manifest.json`. The reference scanner's
   hardcoded `[Xx]:` regex became a configurable drive letter (default `P`,
   CLI `--drive`, `diff` derives it from the manifest sourceRoot). The
   LICENSE copyright line (real studio identity) is kept on purpose. ADR
   0022's Context notes the docset names are anonymized examples.
   **Gate:** repo-wide grep for all of the above returns zero.
2. **Real-DCC live fire** (`packages/runtime-adapters/src/localDccExec.test.ts`,
   opt-in `DRYDOCK_DCC_ITEST=1`): the real `ValidationJobService` pipeline
   with the real guest PowerShell wrappers spawned locally (the exec seam),
   against installed Blender 5.2 and Houdini 20.5 hython (Apprentice).
   Pass / fail / license-wait / stall+sweep / cold+warm serialization: 5/5.
   Numbers and findings in `spike-report.md` §M1-local.
3. **Bug found+fixed by the live fire:** PowerShell `-Command` space-joins
   trailing argv, so the job-id tag made every tagged run wrapper a parse
   error — no tagged guest command had ever executed. Fix: tagged scripts
   end on the constant `VALIDATION_TAG_COMMENT` line; regression pinned in
   the fixed-literal test.
4. **Finding, deferred:** orphan-on-abort sweep gap (token-anchored tree walk
   has no root once the wrapper is dead). Backlog: run-wrapper PID emission;
   M1 must measure sshd channel-close behavior.
5. **Harness re-verify** of V79–V84 surfaces on all four pages
   (configure/index/taskHub/rail) against the scrubbed fixtures — banner,
   revert-reprobe, chips, production fixture card typed-confirm, hub picker,
   rail dot heal all drive correctly.
6. **Docs**: spike-report §M1-local, ADR status note (second code-shaping
   finding), implementation-plan status + backlog entry.

## Environment (reference laptop THINKPAD)

- Hyper-V fully installed; user in `Hyper-V Administrators` (non-elevated
  control plane); `ssh.exe` present; ~875 GB free.
- **Houdini 20.5.445 installed** (hython works headless; Apprentice license;
  set `PYTHONNOUSERSITE=1` — a stray user-site NumPy 2.x otherwise leaks in).
  **Blender 4.4–5.2 installed** (5.2 used by the tests; license-free).
- Still absent (M1 blockers): studio package share route, rez configs, a
  Windows guest image, license-server reachability.

## Where the code lives (anchors)

- Contracts: `packages/contracts/src/validationRuntime.ts`,
  `packages/contracts/src/webviewMessages.ts` (`parseValidationConnection`).
- Core: `validationJobService.ts` (queue, guest scripts, `VALIDATION_TAG_COMMENT`,
  `ValidationExecAdapter` seam), `validationRoutingService.ts`,
  `validationProbeService.ts`, `validationChangesetRef.ts`,
  `pkgrootMirrorStatus.ts`, `cloneSyncService.ts`
  (`assertPatchSafeForWindowsGuest`), `eventBus.ts` (validation bus kinds).
- Runtime adapter: `packages/runtime-adapters/src/hyperVControl.ts`,
  `hyperVRuntimeAdapter.ts` (adopt-only; `SWEEP_GUEST_JOB_SCRIPT` exported),
  `commandDiscovery.ts`, **`localDccExec.test.ts`** (real-DCC opt-in suite).
- Storage: `packages/storage-sqlite/src/validationRuntimeStore.ts`.
- Extension: `validationAppService.ts`, `securityPolicy.ts`,
  `workspaceReviewAppService.ts`, `compositionRoot.ts` (adapter binding
  ~:1019, `validateHostPath` carve-out).
- Webview: `configure.ts`, `views/validationChips.ts`, `views/accessCard.ts`,
  `taskHub.ts`, `views/railViews.ts`, `validationTypes.ts`.
- Tools: `tools/prevalidate/src/hyperv.ts` (env: `DRYDOCK_HYPERV_ROOT`,
  `DRYDOCK_PKGROOT_MIRROR`), `tools/pkgroot-mirror/` (manifest, sync, scan,
  `--drive`), `tools/hyperv-spike/`, `tools/webview-harness/` (V79–V84).

## Remaining work

0. **A full repo audit ran 2026-08-13 (6 subagents).** ~30 findings, triaged, with two
   headline bugs re-verified by hand: validation sync only applies pure-ADD changesets
   (edits/deletes of pre-existing files fail — the feature's biggest gap), and a
   `purgeRuntimes` FK-cascade violation that aborts startup reconciliation. **None fixed
   yet.** Full ranked plan + execution order: `docs/design/audit-2026-08-13-handoff.md`.
   Start there for the fix pass.

1. **Origin history contains the pre-scrub identifiers.** `origin/ADR-22`
   points at `f205f76`, whose tree carries the real server/share names in the
   ADR + upgrade-plan (`origin/main` is clean). The working tree is scrubbed,
   but clearing GitHub needs a branch history rewrite + force-push (or a
   squash-merge to main and branch deletion) — **Alex's call**, prepared
   options in the session summary. Until then, do not push ADR-22 as-is on
   top of the old base if the goal is a clean public history.
2. **M1 studio spike** (unchanged gate): guest image + share + license
   server; measure the four numbers; also measure sshd channel-close process
   reaping (orphan sweep finding).
3. **Deferred backlog** in `implementation-plan.md` §Post-M8 backlog
   (now includes run-wrapper PID emission). Prior session's deferrals —
   KV task-override dangle, vmName-from-displayName, kill-switch accounting,
   recipe auto-trigger, `formatBytes` dedup — unchanged.
4. The prior handoff's "re-call ReportFindings with outcomes" item was
   **dropped**: the originating code-review session is gone and the tool is
   only valid inside an active review; the findings and their fixes are
   documented here and in the git history.

## Working preferences honored

Bulk scrub fanned out to focused subagents; vsix bumped for the new build
(0.16.0 → 0.17.0, code changes); docs terse; memory file
`drydock-adr22-implementation.md` updated.
