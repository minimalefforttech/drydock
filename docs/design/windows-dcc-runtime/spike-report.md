# Spike report — ADR 0022 Phase 1

## M1a — hardware smoke (no guest image)

Ran 2026-08-12 on THINKPAD (personal laptop; Hyper-V fully installed,
`vmms` running, user a member of Hyper-V Administrators, **not elevated**).
Script: [`tools/hyperv-spike/m1a-hardware-smoke.ps1`](../../../tools/hyperv-spike/m1a-hardware-smoke.ps1).

| step | ms |
|---|---:|
| preflight: Get-VM | 254.0 |
| New-VMSwitch (internal) | 1,190.7 |
| New-VHD (blank 1 GB dynamic) | 1,100.8 |
| New-VM (Gen 2, 512 MB) | 1,930.6 |
| Extended ACLs: default-deny + 3 allows | 187.4 |
| Checkpoint-VM | 467.1 |
| Restore-VMSnapshot | 144.8 |
| verify ACLs survive restore | 9.7 |
| Remove-VMSnapshot (merged) | 90.9 |
| Remove-VM | 510.0 |
| Remove-VMSwitch | 284.2 |
| **total (with cleanup)** | **6,190.6** |

Findings:

- The **whole control plane runs without elevation** for a Hyper-V
  Administrators member: switch, VHD, VM, extended port ACLs,
  checkpoint/restore, removal. No UAC prompt anywhere.
- `Add-VMNetworkAdapterExtendedAcl` default-deny + allow set applies to a
  stopped VM and **persists across `Restore-VMSnapshot`** — the revert
  cadence cannot silently drop the network posture.
- Checkpoint → restore of the (off) VM is 467 ms + 145 ms. This is the
  config-only floor; the M1 warm-restore number (running guest, ≤ 20 s
  target) remains to be measured.
- Snapshot merge after `Remove-VMSnapshot` settles in < 100 ms for a blank
  disk; the M1 measurement must repeat this with a real OS disk.

## M1 — full spike (kill gate) — **environment-blocked**

Status 2026-08-12: not runnable on this machine. The reference laptop has no
`X:` (`\\therock\Floats`) route, no Maya/Houdini installs, no rez configs,
and no license-server reachability. The four kill-gate numbers
(warm-restore ≤ 20 s; multiplexed-SSH exec ≤ 300 ms; line-stream latency vs
the ADR 0021 watchdog; validation round trip ≤ 2× local, ceiling 3×) must be
measured on a studio workstation per `upgrade-plan.md` Phase 1 before
anything past M3 is *deployed* — code for M2–M8 may land behind the gate.
