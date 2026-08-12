<#
.SYNOPSIS
  M1a hardware smoke for ADR 0022 — Hyper-V control-plane timings, no guest OS.

.DESCRIPTION
  Creates and tears down the full Hyper-V resource set the validation runtime
  needs, timing each step:

    1. New-VMSwitch (internal)
    2. New-VHD (blank dynamic VHDX)
    3. New-VM (Gen 2, around the blank VHDX, on the internal switch)
    4. Add-VMNetworkAdapterExtendedAcl default-deny set + allow rules
    5. Checkpoint-VM -> Restore-VMSnapshot
    6. Remove-VMSnapshot / Remove-VM / Remove-VMSwitch / delete VHDX

  The VM is never started: this validates that a non-elevated member of
  Hyper-V Administrators can drive the whole control plane, and how fast.
  Script text is fixed-literal (ADR 0022 ground rule); all variation enters
  through the param block.

.NOTES
  Failure mapping (prevalidate gates in tools/prevalidate):
    - CmdletNotFound            -> Hyper-V PowerShell module not installed
    - "not authorized"/access   -> Hyper-V Administrators membership missing
                                   or sign-out/in pending
    - vmms connection errors    -> Hyper-V Services feature off / vmms stopped

.EXAMPLE
  pwsh -File tools/hyperv-spike/m1a-hardware-smoke.ps1
  pwsh -File tools/hyperv-spike/m1a-hardware-smoke.ps1 -CleanupOnly
#>
[CmdletBinding()]
param(
  # Root for spike artifacts (VHDX). vmms runs as SYSTEM; keep this on a
  # local volume readable by SYSTEM. Default matches the Hyper-V public dir.
  [string]$WorkRoot = (Join-Path $env:PUBLIC "Documents\drydock-hyperv-spike"),
  # Placeholder for the host's internal-switch address (the only outbound
  # allow besides license ports in the real design).
  [string]$HostInternalIp = "192.168.240.1",
  # Placeholder license server endpoint (IP only; ACLs are per-address).
  [string]$LicenseServerIp = "192.168.240.2",
  # Remove any drydock-spike-* leftovers and exit.
  [switch]$CleanupOnly,
  # Emit the timing table as JSON on stdout (for tooling).
  [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$prefix = "drydock-spike"
$token = ([guid]::NewGuid().ToString("N")).Substring(0, 8)
$switchName = "$prefix-switch-$token"
$vmName = "$prefix-vm-$token"
$vhdPath = Join-Path $WorkRoot "$vmName.vhdx"
$checkpointName = "$prefix-clean-baseline"

$steps = [System.Collections.Generic.List[object]]::new()

function Invoke-Step {
  param([string]$Name, [scriptblock]$Body)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $status = "ok"
  $detail = ""
  try {
    $detail = & $Body
    if ($null -eq $detail) { $detail = "" }
    $detail = [string]$detail
  } catch {
    $status = "failed"
    $detail = $_.Exception.Message
    $sw.Stop()
    $steps.Add([pscustomobject]@{ step = $Name; ms = [math]::Round($sw.Elapsed.TotalMilliseconds, 1); status = $status; detail = $detail })
    throw
  }
  $sw.Stop()
  $steps.Add([pscustomobject]@{ step = $Name; ms = [math]::Round($sw.Elapsed.TotalMilliseconds, 1); status = $status; detail = $detail })
}

function Remove-SpikeLeftovers {
  param([string]$OnlyToken)
  $vmPattern = if ($OnlyToken) { "$prefix-vm-$OnlyToken" } else { "$prefix-vm-*" }
  $swPattern = if ($OnlyToken) { "$prefix-switch-$OnlyToken" } else { "$prefix-switch-*" }
  foreach ($vm in @(Get-VM -Name $vmPattern -ErrorAction SilentlyContinue)) {
    if ($vm.State -ne "Off") { Stop-VM -VM $vm -TurnOff -Force -ErrorAction SilentlyContinue }
    foreach ($snap in @(Get-VMSnapshot -VM $vm -ErrorAction SilentlyContinue)) {
      Remove-VMSnapshot -VMSnapshot $snap -Confirm:$false -ErrorAction SilentlyContinue
    }
    $disks = @(Get-VMHardDiskDrive -VM $vm -ErrorAction SilentlyContinue)
    Remove-VM -VM $vm -Force -Confirm:$false -ErrorAction SilentlyContinue
    foreach ($disk in $disks) {
      if ($disk.Path -and (Test-Path -LiteralPath $disk.Path)) {
        Remove-Item -LiteralPath $disk.Path -Force -ErrorAction SilentlyContinue
      }
    }
  }
  foreach ($sw in @(Get-VMSwitch -Name $swPattern -ErrorAction SilentlyContinue)) {
    Remove-VMSwitch -VMSwitch $sw -Force -Confirm:$false -ErrorAction SilentlyContinue
  }
  if (-not $OnlyToken -and (Test-Path -LiteralPath $WorkRoot)) {
    Remove-Item -LiteralPath $WorkRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if ($CleanupOnly) {
  Remove-SpikeLeftovers
  Write-Host "Removed all $prefix-* leftovers."
  return
}

$failed = $false
try {
  Invoke-Step "preflight: Get-VM" {
    $vms = @(Get-VM)
    "vmms reachable; existing VMs: $($vms.Count)"
  }

  Invoke-Step "prepare work root" {
    New-Item -ItemType Directory -Force -Path $WorkRoot | Out-Null
    $WorkRoot
  }

  Invoke-Step "New-VMSwitch (internal)" {
    New-VMSwitch -Name $switchName -SwitchType Internal | Out-Null
    $switchName
  }

  Invoke-Step "New-VHD (blank 1 GB dynamic)" {
    New-VHD -Path $vhdPath -SizeBytes 1GB -Dynamic | Out-Null
    $vhdPath
  }

  Invoke-Step "New-VM (Gen 2, 512 MB)" {
    New-VM -Name $vmName -Generation 2 -MemoryStartupBytes 512MB -VHDPath $vhdPath -SwitchName $switchName | Out-Null
    Set-VM -Name $vmName -CheckpointType Standard -AutomaticCheckpointsEnabled $false
    $vmName
  }

  Invoke-Step "Extended ACLs: default-deny + allows" {
    # Default-deny both directions at the lowest weight, then explicit
    # allows above it: host internal address (both directions) and license
    # server outbound. Mirrors the ADR 0022 vNIC posture.
    Add-VMNetworkAdapterExtendedAcl -VMName $vmName -Action Deny -Direction Inbound -Weight 1
    Add-VMNetworkAdapterExtendedAcl -VMName $vmName -Action Deny -Direction Outbound -Weight 1
    Add-VMNetworkAdapterExtendedAcl -VMName $vmName -Action Allow -Direction Inbound -RemoteIPAddress $HostInternalIp -Weight 100
    Add-VMNetworkAdapterExtendedAcl -VMName $vmName -Action Allow -Direction Outbound -RemoteIPAddress $HostInternalIp -Weight 101
    Add-VMNetworkAdapterExtendedAcl -VMName $vmName -Action Allow -Direction Outbound -RemoteIPAddress $LicenseServerIp -Weight 102
    $acls = @(Get-VMNetworkAdapterExtendedAcl -VMName $vmName)
    if ($acls.Count -ne 5) { throw "expected 5 extended ACL entries, found $($acls.Count)" }
    "5 ACL entries verified"
  }

  Invoke-Step "Checkpoint-VM" {
    Checkpoint-VM -Name $vmName -SnapshotName $checkpointName
    $checkpointName
  }

  Invoke-Step "Restore-VMSnapshot" {
    Restore-VMSnapshot -VMName $vmName -Name $checkpointName -Confirm:$false
    "restored $checkpointName"
  }

  Invoke-Step "verify ACLs survive restore" {
    $acls = @(Get-VMNetworkAdapterExtendedAcl -VMName $vmName)
    if ($acls.Count -ne 5) { throw "expected 5 extended ACL entries after restore, found $($acls.Count)" }
    "5 ACL entries intact"
  }

  Invoke-Step "Remove-VMSnapshot" {
    Remove-VMSnapshot -VMName $vmName -Name $checkpointName -Confirm:$false
    # Snapshot deletion merges asynchronously; wait for it to settle so
    # Remove-VM below is clean.
    $deadline = (Get-Date).AddSeconds(60)
    while (@(Get-VMSnapshot -VMName $vmName -ErrorAction SilentlyContinue).Count -gt 0) {
      if ((Get-Date) -gt $deadline) { throw "snapshot merge did not settle within 60 s" }
      Start-Sleep -Milliseconds 200
    }
    "merged"
  }

  Invoke-Step "Remove-VM" {
    Remove-VM -Name $vmName -Force -Confirm:$false
    $vmName
  }

  Invoke-Step "Remove-VMSwitch" {
    Remove-VMSwitch -Name $switchName -Force -Confirm:$false
    $switchName
  }

  Invoke-Step "delete VHDX + work root" {
    Remove-Item -LiteralPath $vhdPath -Force -ErrorAction SilentlyContinue
    if ((Get-ChildItem -LiteralPath $WorkRoot -ErrorAction SilentlyContinue | Measure-Object).Count -eq 0) {
      Remove-Item -LiteralPath $WorkRoot -Force -ErrorAction SilentlyContinue
    }
    "clean"
  }
} catch {
  $failed = $true
  Write-Host ""
  Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Sweeping $token leftovers..." -ForegroundColor Yellow
  Remove-SpikeLeftovers -OnlyToken $token
} finally {
  $total = [math]::Round(($steps | Measure-Object -Property ms -Sum).Sum, 1)
  if ($Json) {
    [pscustomobject]@{
      spike = "m1a-hardware-smoke"
      at = (Get-Date).ToString("o")
      host = $env:COMPUTERNAME
      elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
      ok = -not $failed
      totalMs = $total
      steps = $steps
    } | ConvertTo-Json -Depth 4
  } else {
    Write-Host ""
    Write-Host ("{0,-38} {1,10}  {2}" -f "step", "ms", "detail")
    Write-Host ("-" * 78)
    foreach ($s in $steps) {
      $mark = if ($s.status -eq "ok") { " " } else { "!" }
      Write-Host ("{0}{1,-37} {2,10:n1}  {3}" -f $mark, $s.step, $s.ms, $s.detail)
    }
    Write-Host ("-" * 78)
    Write-Host ("{0,-38} {1,10:n1}" -f "total", $total)
    Write-Host ""
    if ($failed) { Write-Host "Result: FAILED (leftovers swept)" -ForegroundColor Red }
    else { Write-Host "Result: OK — control plane fully drivable without elevation" -ForegroundColor Green }
  }
}
if ($failed) { exit 1 }
