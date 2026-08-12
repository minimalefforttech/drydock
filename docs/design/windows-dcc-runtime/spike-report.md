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

## M1 — full spike (kill gate) — **partially unblocked**

Status 2026-08-12: not runnable on this machine (no studio share route, no
DCC installs, no rez configs, no license server). The four kill-gate numbers
(warm-restore ≤ 20 s; multiplexed-SSH exec ≤ 300 ms; line-stream latency vs
the ADR 0021 watchdog; validation round trip ≤ 2× local, ceiling 3×) must be
measured on a studio workstation per `upgrade-plan.md` Phase 1 before
anything past M3 is *deployed* — code for M2–M8 may land behind the gate.

Update 2026-08-13: the reference laptop now has **Houdini 20.5.445**
(hython, Apprentice license) and **Blender 4.4–5.2** installed, which
unblocks everything below the hypervisor — see the next section. Still
studio-bound: the guest image, the package share + rez configs, the license
server, and therefore the four VM-transport numbers themselves.

## M1-local — real-DCC exec through the shipped pipeline (2026-08-13)

Ran on THINKPAD via `packages/runtime-adapters/src/localDccExec.test.ts`
(opt-in: `DRYDOCK_DCC_ITEST=1`): the REAL `ValidationJobService` pipeline —
cleanup → `git apply` sync → run → receipt, all four fixed-literal guest
PowerShell wrappers, stdin-JSON parameters, watchdogs, sweep — with the exec
seam bound to local `powershell.exe` instead of `ssh.exe`, against real DCC
binaries. 5/5 green.

| scenario | binary | result | round trip |
|---|---|---|---:|
| pass (cube + out-file via `DRYDOCK_OUTPUT_ROOT`) | Blender 5.2.0 | receipt `passed` | 2,964 ms |
| failing assertion | Blender 5.2.0 | receipt `failed`, job completed | ~2,800 ms |
| license-wait pause (E4) | Blender 5.2.0 | `license-wait` state; 6 s silence survived a 4 s inactivity budget; `licenseWaitMs` ≈ 6,000 | 8,880 ms |
| stall → watchdog → sweep | Blender 5.2.0 | receipt `error` (`No output for 4 s…`), swept | 7,983 ms |
| node-graph validation, cold + warm, serialized | hython 20.5.445 | both `passed` | 5,327 / 5,402 ms |

The hython/Blender round trips are the **local baseline** the M1
round-trip-ratio ceiling (≤ 2× local, 3× kill) divides against.

Two product findings, both invisible to the fake-adapter suite:

1. **`-Command` tag join (FIXED).** PowerShell joins every argv element after
   `-Command` into the one script string with spaces, so the job-id tag from
   `validationGuestCommand(script, jobId)` landed on `exit $LASTEXITCODE` and
   turned every tagged run wrapper into a parse error — no tagged guest
   command had ever actually executed. Fixed by terminating tagged scripts
   with the constant `VALIDATION_TAG_COMMENT` line for the join to land on;
   the token stays argv-borne and still reaches `Win32_Process.CommandLine`.
2. **Orphan-on-abort sweep gap (OPEN, backlog).** On abort the local runner
   kills the token-carrying wrapper before `sweepGuestJob` runs, so the
   token-anchored parent-tree walk finds no root and the hung DCC child
   survives as an orphan (measured: sweep killed 0, 1 Blender survived; the
   test reaps it via a command-line fallback). Over ssh the wrapper's fate on
   channel close is sshd's call — M1 must measure it, and the durable fix is
   the run wrapper emitting its own PID so the sweep can root the walk
   without a live wrapper.
