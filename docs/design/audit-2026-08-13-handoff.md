# Repo audit + fix handoff — 2026-08-13

For a fresh chat. Branch `ADR-22`, working tree **clean**, `npm test` **748/0 fail,
9 skipped** (4 symlink-priv skips + 5 opt-in real-DCC tests). Tip commits:
`285dabb` (session docs, vsix 0.17.0), `b43062d` (identifier scrub + DCC live fire).
No code changed after `b43062d` — the audit below is READ-ONLY so far; **nothing
here is fixed yet.**

Project state (M0–M8, scrub, DCC live-fire, vsix) is in
`docs/design/windows-dcc-runtime/HANDOFF.md`. This doc is the **audit + remaining-fix
plan** that supersedes that file's "Remaining work" section.

## How this audit ran

Six Sonnet subagents swept the repo by slice (A core-validation, B core-misc+storage,
C adapters+tools, D extension-host, E webview-UI, F security-lens). ~30 findings, heavily
overlapping, deduplicated below. Two headline items were **re-verified by hand** (noted
inline). Everything else carries the subagent's CONFIRMED/PLAUSIBLE label — a fresh chat
should re-read each cited site before changing it (an audit finding that misreads control
flow is worth less than none).

Severity: **S1** security/data-loss · **S2** correctness bug · **S3** edge-case · **S4** hygiene.

---

## Tier 1 — confirmed bugs that break real behavior (fix first)

**T1.1 — S2 — Validation sync only applies pure-ADD changesets.** VERIFIED BY HAND
(`git apply` of a modify hunk and a delete hunk into a fresh `git init` repo both fail
`No such file or directory`). `VALIDATION_SYNC_GUEST_SCRIPT`
(`packages/core/src/validationJobService.ts:211-249`) does `git init` on an empty repo then
`git apply` the **incremental** diff `outboundChangesetPatch` produces
(`cloneSyncService.ts` `git diff --binary refs/sync/base HEAD`). Any changeset that edits or
deletes a file that existed at session start — i.e. most real work — fails sync and ends the
job `state:"error"`, never a verdict. My live-fire suite only used `new file mode` patches
(`localDccExec.test.ts` `newFilePatch`), so it never caught this. **This is the most
impactful finding — the feature as shipped validates only brand-new files.**
Fix (needs a design choice): either rewrite host-side so shipped patches are full-content
`new file mode` diffs for every touched path, or seed the guest repo with the base blobs of
touched paths before `git apply`. Add a modify+delete case to the live-fire suite as the
regression. **Re-confirm there's no base-seeding path I missed before ripping in** (trace
`changesetSource` in `compositionRoot.ts:~1106` → `buildOutboundPatches` →
`isolatedRunService.ts:~992`).

**T1.2 — S1 — `purgeRuntimes` FK violation aborts startup reconciliation.** VERIFIED BY HAND
(read the DDL + the delete). `runtime_cleanup_attempts.runtime_id REFERENCES
runtime_instances(runtime_id)` with **no `ON DELETE CASCADE`** (`migrations.ts:52-58`),
`PRAGMA foreign_keys=ON` (`sqliteConnection.ts:23`), and `purgeRuntimes`
(`runtimeInventoryStore.ts:150-159`) deletes `runtime_instances` directly. Cleanup always
inserts a `runtime_cleanup_attempts` row first (`runtimeCleanupService.ts:31`), so any
normally-removed runtime has a child. After 24h + reactivation the `DELETE` throws, aborting
`reconcileOnActivate` (`compositionRoot.ts:1499`) — so the sequenced-after steps
(`inventory-changed`, `orchestrator.restore()`, `validationApp?.restore()`) never run, and
`extension.ts`'s outer catch only logs. Silent on every activation thereafter.
Fix: delete matching `runtime_cleanup_attempts` rows before the parent delete in one
transaction (or add `ON DELETE CASCADE`). The existing `purgeRuntimes` test inserts no child
row, so add one that does.

**T1.3 — S2 — Validation runtime with unverified isolation is reported `"available"` to the
router.** `availabilityForJob` (`validationAppService.ts:297-307`) returns `"available"`
whenever `getQuarantine()===null`. When the VM state query throws (`readVmState`→`"unknown"`)
and the probe exec also throws, `runProbe` swallows to a per-probe `"unknown"`
(`validationProbeService.ts:552-559`) — no breach, no quarantine — so an all-unknown run
(isolation never confirmed once) is indistinguishable from a clean pass, violating ADR 0021's
"unknown is never green." `ensureProbedOnce`'s single-flight guard then pins that for the
6-hour cadence. `availabilityForRow` (the panel ladder) already honors unknown correctly;
`availabilityForJob` does not.
Fix: after `ensureProbedOnce`, require `probes.lastResult(runtimeId)?.greenAt !== undefined`
(or worst-probe==pass) before returning `"available"`; otherwise return `"missing"` so the
job parks honestly.

## Tier 2 — confirmed security hardening

**T2.1 — S2 — Validation receipts get only the `sk-` redactor.** `commandRunner.sanitizeOutput`
(`commandRunner.ts:132-134`) strips only `sk-…`; guest stdout flows into `receipt.summary`/
`failingTest`/`failingAssertion` and is written to sqlite verbatim
(`validationRuntimeStore.insertReceipt`) — the broader `persistenceSanitizer.redactCredentialText`
(PEM, Bearer, `api_key=`, `ghp_`/`github_pat_`, `AKIA…`) is never applied on the receipt path.
A prompt-injected agent whose test prints a token leaks it into stored, UI-rendered, shareable
evidence — directly against the threat model's redact-by-default rule.
Fix: run receipt text through `redactCredentialText` in `finish()` before `insertReceipt`, or
broaden/share the runner's sanitizer.

**T2.2 — S1 — `chat.openFile` opens any absolute path an agent message links, no policy check.**
`openAgentFileRef` (`controlPanelProvider.ts:155-180`, dispatch `:902-905`) calls
`openTextDocument(Uri.file(hostPath))` with no `EffectiveSecurityPolicy` check; the webview
markdown parser (`messageRow.ts:188-225`) makes any `[label](C:\Users\…\.ssh\id_rsa)` clickable,
and the `chat.openFile` gate only bounds length. Indirect injection → agent emits a link to a
secret → user clicks (the designed interaction) → it opens, bypassing every mount/access-request
mechanism; one click of "attach active file" then carries it into the next turn.
Fix: gate `openAgentFileRef` on `securityPolicy.isHostPathAllowed`/sensitive-path check, as
`resolvePolicyOverlayFile` already does.

**T2.3 — S2 — Docker sandbox network-allow policy leaks after a host restart.** The egress
allowlist is tracked only in an in-process `Map` (`dockerSandboxRuntimeAdapter.ts:32,88,102-113`);
`removeRuntime` skips `sbx policy rm network` when the Map is empty, and `RuntimeCleanupService`
rebuilds handles purely from the persisted record (`runtimeCleanupService.ts:55-74`). A runtime
created before a restart is removed with its network-allow policy left active, and there's no
field to rehydrate it from — so nothing can ever clean it up.
Fix: persist the resources string in the inventory record `metadata` at create; read it in
`removeRuntime`/cleanup.

**T2.4 — S2 — Typed-confirm bypass when the user edits the access-card path.** `accessCard.ts:94`
computes `escalated` once from the original request and never re-checks it against the editable
host-path `<input>`. A one-click "Allow" card whose path the user edits to a sensitive location
still sends `send(true)` with no confirm.
Fix: recompute the danger/escalation check when `pathInput.value !== access.displayPath`.

**T2.5 — S2 — Webview `message` listeners don't check `event.origin`/`event.source`.**
(`messaging.ts:76-97`, `panelBridge.ts:95-116`, `planner.ts:103-119`.) The Planner renders
agent-authored HTML in a `sandbox="allow-scripts"` (no `allow-same-origin`) iframe once the user
toggles scripts on; that script keeps a `window.parent` reference and can `postMessage` a forged
`push`/`response` envelope the Planner's own listener will trust (spoof session/plan state).
Fix: reject messages whose `event.source`/`event.origin` isn't the expected host, before touching
`event.data`.

## Tier 3 — confirmed correctness, narrower impact

- **T3.1 — S2 — receipts drop mirror `ok`/`skippedVersions`** (`validationJobService.ts:1221`;
  `readMirrorStatus` computes them, `finish()` discards them). A job that ran against a degraded/torn
  mirror still cites a clean version+timestamp — the exact overclaim `pkgrootMirrorStatus.ts`'s doc
  forbids. Add `mirrorOk`/`mirrorSkippedVersions` to `ValidationReceipt`/`…View` and thread through.
- **T3.2 — S2 — `requeueParked` skips the H8 capability gate after a restart** (`validationJobService.ts:600-609`).
  The gap check runs only `if (held !== undefined)` (in-memory `pending`, lost on restart), so a parked
  job rerouted post-restart onto a runtime lacking a required capability queues anyway. Rehydrate the
  profile via `options.profileFor` when `held` is undefined (same fallback `materialize()` uses).
- **T3.3 — S2 — `turnActive` is a single module flag, not session-keyed** (`chatTab.ts:187`, sites 1222-1227,
  1356-1398). Send on A, switch to B mid-flight → B's composer sticks disabled with a dead Stop button.
  Capture `sessionId` at send and guard every `setTurnActive`/`appendSystemMessage` on it.
- **T3.4 — S2 — `loadDiffStatus` has no staleness guard** (`chatTab.ts:1864-1877`) unlike every sibling
  loader; a slow A response can overwrite B's Changes tray. Capture `sessionId`, bail if it changed after
  the await (mirror `pollRawStream`).
- **T3.5 — S2 — `removeProject` orphans its workspace set** (`projectCatalogService.ts:82-85`,
  `workspaceSetService.ts:109-124`). Removing the last project of a set leaves the set resolving to `[]`
  (zero mounts, no error) instead of being pruned/rejected. Prune the set through `WorkspaceSetService`
  (re-run `validateSet`) or throw on zero-project resolution.
- **T3.6 — S2 — MCP server name uniqueness is check-then-write with no constraint**
  (`mcpRegistryService.ts:86-130`, `renderConfigJson:203-215`; no `UNIQUE(name)` in `migrations.ts:414-425`).
  Two concurrent saves of the same name both insert; `renderConfigJson` keys on name so one silently
  overwrites the other in `.mcp.json`. Add `UNIQUE(name COLLATE NOCASE)`.
- **T3.7 — S3 — `eventStore.listEvents` / `summarizeStoredEvent` unguarded `JSON.parse` + exhaustive
  switch with throwing `assertNever`** (`eventStore.ts:78`, `events.ts:267`). One legacy/corrupt/
  future-shape row throws out of `getChatTimeline`'s `.map()` and fails the whole transcript load. Every
  other JSON-column reader in the package guards its parse; this one doesn't. Degrade-and-continue per row.
- **T3.8 — S3 — non-transactional multi-statement writes** (`workspacePolicyStore.ts:110-146`
  insert/update/replaceMembers; `diffReviewStore.ts:31-43` insertBaseline; lower-impact `mcpServerStore.ts:65-68`
  deleteServer, `diffReviewStore.ts:84-91` deleteBaseline). A crash/FK-throw mid-sequence leaves partial
  state (zero-member set, baseline missing file rows). Wrap each in `BEGIN`/`COMMIT`/`ROLLBACK` like
  `taskChangesetStore.replaceForSubtask` already does.
- **T3.9 — S3 — memory-candidate capture/resolve TOCTOU** (`memoryService.ts:104-143`, `181-201`).
  Fire-and-forget per-turn capture with no lock and no unique index → duplicate pending candidates;
  concurrent `resolve` can double-apply. Add a unique index on normalized content / compare-and-swap on status.
- **T3.10 — S3 — numeric fields accept non-integers / out-of-range** (`configure.ts:1640-1649` warm cap,
  `1437-1441`/`1486-1493` SSH port; `configureFields.ts` `type=number` has no `step`). `3.5` warm cap and
  `22.7`/`99999` port pass the finite/sign check. Use `Number.isInteger` + range (`1..65535` for port).
- **T3.11 — S4 — `railStatus` can attribute a parked/active fallback line to the wrong runtime**
  (`validationAppService.ts:859-911`): `jobs` is scoped by `taskId` across all runtimes the task used, but
  `where` names only the resolved one. Scope the parked/active picks by `resolvedRuntimeId`, or use the job's
  own runtime in the message.

## Tier 4 — defense-in-depth / hygiene (not currently exploitable)

- **T4.1 — S3 — `SAFE_REPO_NAME` accepts `"."`/`".."`** (`validationJobService.ts:399`), and
  `VALIDATION_SYNC_GUEST_SCRIPT` lacks the `GetFullPath`+`StartsWith` re-check its fixture sibling has.
  Found by two agents. **Not reachable today** — the only caller derives `repoName` from `path.basename` of a
  realpath'd dir, which can't be `.`/`..`. Add `!/^\.+$/.test(value)` to the regex and/or the guest boundary
  re-check anyway. (Cheap; do it alongside T1.1 since both touch the sync script.)
- **T4.2 — S3 — `joinUnderRoot` has no traversal guard of its own** (`pkgroot-mirror/syncPlan.ts:87-91`);
  safe only because `checkEntries` upstream rejects `..`. Add the `path.relative`/`startsWith("..")` guard
  `package-vsix.mjs` uses, as defense-in-depth for the security-critical helper.
- **T4.3 — S3 — `diff.openFile` builds a URI from a relative path with no root-containment check**
  (`baselineDiff.ts:59-69`), unlike the write paths that use `resolveInsideRoot`. Not reachable via normal
  UI (paths are host-computed). Route through the same containment check.
- **T4.4 — S3 — production-fixture snapshot stat/read TOCTOU** (`validationAppService.ts:996-1023`): `stat`
  then `mkdir` then `readFile` with no fd pin; on the shared prod drive the bytes hashed/shipped can differ
  from those size-checked. Hold an fd (open+fstat+read) or re-stat immediately before read.
- **T4.5 — S3 — `setup-share.ps1` NTFS hardening doesn't break inheritance** (`:159-170`): adds a Read&Execute
  ACE but never strips broader inherited Allow ACEs the service account matches via `Users`/`Authenticated
  Users`, so effective access may exceed the "read-only, nothing else" the docstring promises. Break
  inheritance + re-add only intended ACEs, or compute+assert effective access.
- **T4.6 — S4 — `localDccExec.test.ts` stall test cleans up the orphaned Blender in `try`, not `finally`**
  (`:566-592`) — my own bug; an assertion failure leaks a 10-min-sleeping process. Move survivor-kill into
  `finally`. (Moot once T5.1 lands and the product sweep reaps it, but fix regardless.)
- **T4.7 — S4 — `jsonRpcClient.stop()` doesn't reject in-flight `pending` requests** (`:174-182`), relying on
  the process `exit` event; an awaiting caller can hang up to the 120s per-request timeout on close. Have
  `stop()` call `rejectAll(...)` directly.
- **T4.8 — S4 — stale comment** at `securityPolicy.ts:105-110` says managed `validationRuntimes` limits are
  unenforced; they are enforced server-side (`validationAppService` `assertImageAllowed`/
  `assertProfileExceptionAllowed`/`topologyPin`/`warmCap`). Update the comment so it doesn't read as a gap.

## Tier 5 — planned this session, NOT started (independent of the audit)

These were queued before the audit and are still to do:

- **T5.1 — wrapper-PID rooted sweep** (closes the orphan-on-abort gap the live fire found).
  `VALIDATION_RUN_GUEST_SCRIPT` emits its own `$PID` as a marker line; the job service captures it **without**
  flipping the startup→inactivity watchdog budget or polluting the receipt tail; `sweepGuestJob` gains an
  optional `wrapperPid`; `SWEEP_GUEST_JOB_SCRIPT` roots the tree walk on token-matches ∪ `wrapperPid` (survives
  wrapper death). Flip the `localDccExec` stall test to assert the orphan is actually reaped by the product sweep.
  `SWEEP_GUEST_JOB_SCRIPT` is already exported from `hyperVRuntimeAdapter.ts`.
- **T5.2 — KV task-override → real table.** `validation_task_overrides` (task_id PK, runtime_id) so
  `deleteRuntime` reassigns like associations, instead of `override.task.<id>` keys dangling
  (`validationRuntimeStore.ts:59`).
- **T5.3 — capture `vmName` once at create/adopt** as a stored `NamedRuntimeConfig` field; `displayName`
  becomes display-only (two derive sites: `compositionRoot.ts:1015` `validationVmName`,
  `validationAppService.ts:361` `vmNameFor`). Today a rename re-points at a differently-named VM.
- **T5.4 — kill-switch accounting.** The deallocation loop (`compositionRoot.ts:1476-1488`) counts only
  `status==="removed"`; `cleanupRuntime` returns `"quarantined"` for an adapter-not-registered runtime (row
  flipped, VM not stopped) and that's silently treated as handled. Count/surface it honestly. Latent
  (docker-only inventory today) but wrong the moment a second kind lands.
- **T5.5 — greenAt at breach.** Probe service replaces `lastResult` before the quarantine callback, so the F5
  banner says "no green probe on record" instead of the last green time. Pass the prior stamp into the callback.
- **T5.6 — dedup** `formatBytes`/`errorMessage` where the bundle boundary allows (host-side: `validationAppService`
  vs `workspaceReviewAppService.formatSizeLabel`; webview `configure.ts`/`codeReview.ts` stay separate — bundle
  boundary, accepted).

## Feature-sized deferrals (documented, NOT for the fix pass)

Recipe auto-trigger; `planWarmSet` application (start/stop VMs to converge on the cap); agents-panel hyperv
counters; durable restart-retry ledger; fixture restart-durability; agent-session fixture byte-copy into a live
sandbox. See `windows-dcc-runtime/implementation-plan.md` §Post-M8 backlog.

## Standing decision for Alex (do NOT execute autonomously)

`origin/ADR-22` tip `f205f76` still carries the pre-scrub studio names in 2 doc files (`origin/main` is clean).
Clearing GitHub needs a history rewrite + force-push, or a squash-merge to main + branch delete. Options are in
`windows-dcc-runtime/HANDOFF.md` §Remaining. The local branch has NOT been pushed.

## Suggested execution order for the fresh chat

1. **T1.1** first (biggest behavior gap; decide fix approach, re-confirm no seeding path) — do **T4.1** in the
   same edit since both touch the sync script.
2. **T1.2** and **T1.3** (both isolated, high value).
3. Tier 2 security batch (T2.1–T2.5).
4. **T5.1** wrapper-PID sweep + the rest of Tier 5.
5. Tier 3 as capacity allows; Tier 4 is opportunistic.
6. After each batch: `npm test`; re-run `DRYDOCK_DCC_ITEST=1 node --test packages/runtime-adapters/dist/localDccExec.test.js`
   for anything touching the exec path; bump vsix (0.17.0 → next) and re-scan for identifiers before packaging;
   update this doc's status.

## Verified-solid (don't re-audit these)

The security lens cleared, by direct read: uniform array-form spawn (zero `shell:true`), fixed-literal PS with
env/stdin-JSON params, the ssh user/host injection regexes (`webviewMessages.ts` + negative tests), fixture
traversal (host `isSafeFixturePath` + guest `GetFullPath` re-check), `mountPolicy.isPathWithin` separator guard,
realpath canonicalization of denied paths (defeats trailing-dot/8.3/symlink tricks), fail-closed backend
composition, `assertPatchSafeForWindowsGuest` symlink/case-collision detection, pkgroot manifest validation, no
SQL injection anywhere, CSP/nonce on all 9 providers, grants-ledger fresh re-hash on every ship.
