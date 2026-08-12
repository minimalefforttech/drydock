# ADR-22 implementation handoff

Session handoff, 2026-08-13. Branch `ADR-22`, working tree **clean**, everything committed.
Full suite: **`npm test` → 743 tests, 0 fail, 4 skipped** (the 4 skips are pre-existing
Windows symlink-privilege skips in the git/changeset suites, unrelated to this work).

## What this is

ADR 0022 (`docs/adr/0022-windows-dcc-validation-runtime.md`): a second runtime class — a
pooled Hyper-V Windows VM (adapter kind `hyperv`) that runs `mayapy`/`hython` auto-validation
against the studio's Windows rez packages, with no host execution and no path to production.
Design docset: `docs/design/windows-dcc-runtime/` (read `README.md` first).

## Status: M0–M8 all implemented, committed, and reviewed

Commits on `ADR-22` (newest first), all green at each step:

| Commit | Milestone |
|---|---|
| `c9c19b2` | Code-review fixes (2 security, 8 correctness) — see below |
| `16ba4d2` | M8: ADR status note + post-M8 backlog + vsix 0.16.0 |
| `09f47af` | M7: validation UX end to end (Configure section, chips, fixture card, hub picker, rail dot, harness) |
| `34ddc5f` | M4: validation job service, changeset ref, Windows patch boundary |
| `6050edb` | M6: standing must-fail probe suite + quarantine |
| `61f8539` | M8a: threat-model deltas, managed validationRuntimes policy keys, runbook |
| `561567a` | M3: hyperv adapter, multi-adapter core services, bus kinds |
| `2a328b0` | M5: xroot-mirror tooling + mirror status reader |
| `299f4f8` | M0: prevalidate Hyper-V gates |
| `9e3ee02` | M2: contracts, sqlite store, routing cascade |
| `77b6e81` | M1a: Hyper-V hardware smoke scripts + spike report |
| `f205f76` | ADR 0022 proposal + docset (pre-existing) |

**vsix**: version bumped to **0.16.0**; last packaged at `16ba4d2`. **The review fixes in
`c9c19b2` changed host/core/contracts code, so the vsix should be repackaged** (`npm run
package:vsix`) before handing a build to test — this was NOT yet re-done.

## Environment (this machine — personal laptop THINKPAD, not the work machine)

- Hyper-V fully installed; user IS in `Hyper-V Administrators` (control plane runs non-elevated);
  `ssh.exe` present; ~875 GB free on C:. **No `X:` drive, no Maya/Houdini, no license server.**
- Consequence: **M1a hardware smoke ran for real and PASSED** (6.2 s control-plane round trip;
  extended ACLs survive checkpoint restore — `docs/design/windows-dcc-runtime/spike-report.md`).
  **The M1 full kill-gate spike is environment-blocked** (needs a studio workstation) and is the
  gate for flipping the ADR to Accepted. Product code M2–M8 lands behind that gate per the plan.
- One M1a finding shapes the code: **Windows OpenSSH has no ControlMaster multiplexing**, so the
  adapter's exec is one `ssh.exe` per call behind a swappable transport seam.

## Where the code lives (anchors)

- Contracts: `packages/contracts/src/validationRuntime.ts` (registry/job/receipt/routing types),
  `packages/contracts/src/webviewMessages.ts` (the `config.validation.*` / `validation.*` schema,
  `parseValidationConnection`).
- Core: `validationRoutingService.ts` (pure cascade), `validationJobService.ts` (per-runtime
  serialized queue), `validationProbeService.ts` (must-fail probes), `validationChangesetRef.ts`,
  `xrootMirrorStatus.ts`, `cloneSyncService.ts` (`assertPatchSafeForWindowsGuest`), `eventBus.ts`
  (validation bus kinds). Multi-adapter registry in `runtimeLifecycleService`/`runtimeCleanupService`/`runtimeReconcileService`.
- Runtime adapter: `packages/runtime-adapters/src/hyperVControl.ts` + `hyperVRuntimeAdapter.ts`
  (adopt-only — **no `Remove-VM` path exists**, test-asserted) + `commandDiscovery.ts`.
- Storage: `packages/storage-sqlite/src/validationRuntimeStore.ts` + migration block.
- Extension: `apps/vscode-extension/src/services/validationAppService.ts` (registry CRUD + managed
  policy + fixtures + availability + rail), `securityPolicy.ts` (`isProductionPath`,
  `validationRuntimes` keys), `workspaceReviewAppService.ts` (production fixture approve path),
  `compositionRoot.ts` (wiring; the `validateHostPath` production carve-out).
- Webview: `webview-ui/src/configure.ts` (Validation runtimes section), `views/validationChips.ts`,
  `views/accessCard.ts` (production fixture card), `taskHub.ts` (picker + banner), `views/railViews.ts`
  (DCC dot), `validationTypes.ts` (re-exports contracts).
- Tools: `tools/prevalidate/src/hyperv.ts` (M0 gates), `tools/xroot-mirror/` (M5), `tools/hyperv-spike/`
  (M1a), `tools/webview-harness/` (configure.html + taskHub.html + rail.html pages, `harness.js`
  validation fixtures, `visual-tests.md` V79–V84).

## Code review (high effort, 8 angles) — 10 findings, ALL FIXED in `c9c19b2`

Two security + eight correctness, each with tests. Verify pass confirmed all 10.

1. **[SECURITY] Production carve-out exposed credentials.** `isProductionPath` was keyed on the
   whole mount denylist, which includes credential defaults (`~/.ssh`, `~/.aws`, …), so those were
   snapshottable through the fixture flow, bypassing `assertHostPathAllowed` / `assertMountAllowed` /
   `assertSessionCanWiden`. **Fix:** production tier = STUDIO-managed data denials only
   (`EffectiveSecurityPolicy.productionDataPaths` from `studioDenied`, excluding sensitive paths);
   carve-out re-runs `assertPolicyCurrent()`; `grantProductionFixture` re-asserts at the copy.
2. **[SECURITY] ssh argv injection → host RCE.** `parseValidationConnection` didn't charset-check
   `host`/`user`, which reach `user@host` before `--` in `sshArgs()`. **Fix:** anchored regexes
   forbidding a leading hyphen + shell metacharacters.
3. **Guest sweep was a no-op.** Token lived only in env (invisible to `Win32_Process`). **Fix:**
   run wrapper tagged with the job id on its command line (`validationGuestCommand(script, jobId)`)
   + sweep tree-walks descendants (adapter half).
4. **Stall watchdog armed before exec** → cold DCC start tripped 120 s. **Fix:** separate startup budget.
5. **`drain()` had no trailing-edge re-run** → job stranded queued on an idle runtime. **Fix:** `drainAgain` loop.
6. **`runPipeline`/`requeueParked` didn't re-check `archived`** → job ran on a decommissioned runtime. **Fix:** park.
7. **`isVmAbsent`/`isAlreadyGone` too broad** → a still-running VM could be reaped. **Fix:** tightened to exact
   "VM not found" wording (stderr/error only) + empty-name guard in `hyperVControl`.
8. **Case-collision check false-flagged a real rename** (`parseDiffPaths` harvested both `---`/`+++`
   spellings). **Fix:** key on destination-tree paths only.
9. **Fixture staging basename collision** → second grant overwrote the first, receipt hash diverged.
   **Fix:** namespace staged files by a source-path hash subdir.
10. **Synchronous `statSync` on production paths** on the hub-refresh hot path → main-thread hang on a
    disconnected share. **Fix:** size read only for PENDING cards, never bulk history.

## Remaining work (what the next session should pick up)

1. **Re-report finding outcomes** to the code-review UI: call `ReportFindings` again with the same 10
   findings, each `outcome: "fixed"` (this was interrupted before it ran). The finding list/order is in
   the transcript; all 10 are fixed.
2. **Repackage the vsix** (`npm run package:vsix`) — 0.16.0 host code changed in `c9c19b2` after the
   last package.
3. **Harness re-verification of the UX** after the fixture-flow change: the four pages
   (`configure.html`, `index.html`, `taskHub.html`, `rail.html`) were screenshot-verified at M7
   (`09f47af`) and looked clean; the `c9c19b2` fixes were host/core-side (staged-path layout, size
   gating) and shouldn't change rendering, but a quick re-drive of the production fixture card +
   validation chips is worth doing to be safe. Server: `tools/webview-harness/server.mjs` (port 8971)
   after `cd apps/vscode-extension && npm run bundle`.
4. **Deferred backlog** (real but not fixed — logged in `implementation-plan.md` §Post-M8 backlog and
   below; none block the M1 gate):
   - **Review finding 6 (routing cascade dup)** — `resolvedRuntimeForTask` reimplements the cascade
     without the park guards. **Decided: no change.** It already excludes archived via
     `listRuntimes(false)`, `railStatus` surfaces the chosen runtime's quarantine cheaply, and routing
     it through `resolveValidationRuntime` would add an availability probe per row (the perf issue
     another finding warns about).
   - **KV task-override dangle** — task overrides ride `validation_settings` as `override.task.<id>`
     keys, so `deleteRuntime` can't reassign them; a deleted runtime leaves overrides pointing at it
     (they fall through to default in the display path, but a job enqueue would park until the user
     re-picks). Proper fix: a `validation_task_overrides` table (task_id PK, runtime_id) so delete
     reassigns like associations.
   - **vmName from mutable displayName** — the Hyper-V VM name is slugged from `displayName` in two
     places (`compositionRoot` `validationVmName`, `validationAppService` `vmNameFor`), so a rename
     re-points at a differently-named VM and jobs fail at adopt. Proper fix: capture `vmName` once at
     create/adopt as a stored `NamedRuntimeConfig` field; `displayName` becomes display-only.
   - **Networked-AI kill-switch accounting** — the deallocation loop in `compositionRoot` counts only
     `status === "removed"`; the adapter-not-registered branch returns `quarantined` (row flipped, VM
     not stopped) and is silently treated as handled. **Latent** (docker-only inventory today), but the
     kill switch would report success without acting once a second kind reaches that inventory.
   - Recipe auto-trigger (nothing enqueues validation from ADR 0007 subtask recipes yet), agent-session
     fixture byte-copy (snapshot ships to jobs, not into a live agent sandbox), `greenAt` at breach for
     the F5 banner, `planWarmSet` application (cap enforced arithmetically, nothing starts/stops VMs),
     Agents-panel hyperv counters, durable restart-retry ledger, fixture restart-durability.
   - Minor dedup: `formatBytes` exists in 3 spots (`validationAppService`, `workspaceReviewAppService`
     `formatSizeLabel`, `configure.ts`); `validationGuestCommand`/`errorMessage` duplicated intra-core.

## Working preferences honored this session

Alex is usage-limit conscious — bulk work was fanned out to focused Opus subagents. vsix version is
bumped for every test build (0.15.0 → 0.16.0). Docs/summaries terse. Memory file
`drydock-adr22-implementation.md` is current.
