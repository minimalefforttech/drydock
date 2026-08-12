# hyperv-spike — ADR 0022 Phase 1 spike scripts

Standalone, fixed-literal PowerShell scripts for the ADR 0022 spike
milestones. Nothing here ships in the product; the product control plane in
`packages/runtime-adapters` reuses the same cmdlet sequences.

## M1a — hardware smoke (no guest image)

```
pwsh -File tools/hyperv-spike/m1a-hardware-smoke.ps1
```

Creates and removes the full resource set (internal switch, blank VHDX,
Gen 2 VM, extended-ACL default-deny set, checkpoint/restore), timing each
step. The VM never boots — this proves a **non-elevated Hyper-V
Administrators member** can drive the whole control plane, and how fast.

- `-CleanupOnly` sweeps any `drydock-spike-*` leftovers.
- `-Json` emits the timing table as JSON.
- Everything it creates is prefixed `drydock-spike-` and torn down in
  `finally`, even on failure.

Failures map to `npm run prevalidate` gates: missing cmdlets → Hyper-V
PowerShell module; access denied → Hyper-V Administrators membership (or
pending re-logon); vmms connection errors → Hyper-V services.

Results are recorded in
[`docs/design/windows-dcc-runtime/spike-report.md`](../../docs/design/windows-dcc-runtime/spike-report.md).

## M1 — full spike (guest image required)

Blocked on a studio-adjacent environment: Windows guest image + license,
Maya/Houdini installs, rez bootstrap from `X:\Pipeline\rez\configs`, and
license-server reachability. The four kill-gate numbers and the runbook live
in `docs/design/windows-dcc-runtime/upgrade-plan.md` (Phase 1). Not runnable
on a machine without the studio share.
