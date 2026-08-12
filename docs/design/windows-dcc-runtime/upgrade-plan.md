# Upgrade plan — Windows DCC validation runtime

Scope: deliver ADR 0022 end to end: `hyperv` adapter, named validation
runtimes, curated `P:` mirror, fixture flow, probes, and the UX in
`ux-flows.md`. The milestone-level, file-anchored breakdown lives in
[implementation-plan.md](implementation-plan.md).

## Shape of the change

Nothing structural moves. The runtime contract
(`packages/contracts/src/runtime.ts`) and adapter port
(`packages/core/src/runtimeAdapter.ts`) already fit; the inventory already
models adopted runtimes, generations, quarantine, and reconciliation. The
work is one new adapter package, one job service, policy tooling, and UI.

| Workstream | Where it lands | Size |
|---|---|---|
| `hyperv` adapter (adopt, exec via SSH, checkpoint, telemetry) | `packages/runtime-adapters` | M |
| Validation job service (queue on run slots, changeset ship, evidence) | `packages/core` + extension services | M |
| Runtime registry + routing cascade (named runtimes, associations, topology presets, warm caps) | `packages/core` + extension services | S–M |
| Mirror + curated `P:` tooling (sync, manifest, redirect map) | new `tools/pkgroot-mirror` | M |
| Probe suite (negative tests, scheduled + on-adopt) | `tools/prevalidate` + adapter | S |
| Setup wizard + health/maintenance UI + fixture cards | extension + webview | M–L |
| Docs: threat model deltas, runbook | `docs/` | S |

## Phases and gates

**Phase 0 — Decide.** ADR 0022 accepted; threat-model deltas drafted;
prevalidate gains gates: Hyper-V feature state, Hyper-V Administrators
membership, local VHDX/mirror storage volume, license-server reachability.
*Exit:* prevalidate reports pass/fix-needed on two reference workstations.

**Phase 1 — Manual spike (kill/continue gate).** Hand-provision the VM
(Windows guest + OpenSSH + Maya/Houdini + rez bootstrap). Build the first
mirror by hand. Measure the four numbers the design rests on:

1. Session-ready time from a warm checkpoint — target ≤ 20 s.
2. Per-exec latency over multiplexed SSH — target ≤ 300 ms.
3. Line-streaming latency under a running `hython` loop — must not trip the
   ADR 0021 stall watchdog.
4. Validation round trip (queue → sync → resolve → `mayapy` suite → evidence)
   vs the same suite run locally — target ≤ 2× local, hard ceiling 3×.

*Exit:* spike report with real numbers. Miss the ceiling → stop and revisit.

**Phase 2 — Adapter + job service.** `"hyperv"` joins `RuntimeAdapterKind`.
Adapter implements the six-method port plus `exec(+onStdoutLine)`; adopts the
pre-provisioned VM; `Get-VM` prefix reconciliation; `Checkpoint-VM`-backed
revert; `Get-VM` counters for the Agents panel (replacing the containerd
state reader for this kind); control plane via fixed-literal PowerShell
scripts only (same rule as the existing process snapshotter). Job service
queues on ADR 0015 run slots, ships changeset snapshots, streams output,
stamps evidence with changeset hash + mirror freshness + fixture manifest +
runtime id/profile. The runtime registry (named runtimes, default,
association cascade, lifecycle policies) lands here as data + resolution
logic; its UI lands in Phase 4.
*Exit:* lifecycle/reconcile suites green against a live VM; a real subtask
verification runs end to end.

**Phase 3 — Policy layer (security review gate).** Port ACLs default-deny
(+ host internal IP, + license IP:ports); mirror sync with manifest;
`P:\Projects` and UNC equivalents in drydock denied paths; probe suite wired
to quarantine; fixture copy path with grants-ledger entries and expiry.
*Exit:* security review sign-off; probes green for one week of daily use.

**Phase 4 — Seamless UX.** Setup wizard with auto-fix buttons (group
membership via elevated helper, storage pick, VM import, mirror roots
auto-proposed from the `rez_config*.py` scan, first probe run). Runtimes
list + association editor + task-level runtime picker (F4/F6 in
`ux-flows.md`). Fixture approval cards. Validation chips in chat. *Exit:* a
developer with no prior context sets up in ≤ 15 min and runs a validation
without reading docs; switching projects re-routes jobs with zero clicks.

**Phase 5 — Later.** Pool size > 1; golden VHDX + differencing disks for
disposable per-session VMs; GPU-P for GPU-dependent tests; pointing the same
adapter at a central Hyper-V host (aligns with the remote-execution roadmap);
Codex-side parity for anything Claude-first.

## Kill criteria / open questions

- Windows guest licensing route (volume/KMS) unconfirmed — procurement item.
- Autodesk/SideFX license seat consumption and EULA position for VM batch
  use — pipeline TD to confirm; render-farm precedent suggests fine.
- Local disk on workstations: reference machine has 36 GB free on `C:` —
  mirror + VHDX need a storage decision (Phase 0 gate reports it).
- If Phase 1 misses the 3× round-trip ceiling, the concept fails the
  seamless-or-bypassed constraint and stops.

## Reference environment findings (STUDIO-ONYX, 2026-08-12)

Hyper-V fully enabled (all features installed, `vmms` running, module,
`hvc.exe`, `ssh.exe` present); Hyper-V Administrators group empty — one-time
membership + re-logon required; 32 GB RAM (one 8–16 GB validation VM
comfortable beside sbx); `P:` = `\\studio-fs\share` with `Pipeline` and
`Projects` as sibling folders; rez repo at `P:\Pipeline\rez\packages`
(`internal`/`external`/`staging`/`user\${USERNAME}`); studio rezconfig
already enables local package caching (`cache_packages_path` on `C:`);
multiple packages hardcode `env.STUDIO_ASSET_API_ROOT = "P:\Projects"` —
handled by the stub/fixture design in `security-and-mounts.md`.
