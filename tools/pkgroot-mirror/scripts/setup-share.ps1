<#
.SYNOPSIS
  Publish the curated package mirror ("pkgroot") read-only to the validation VM.

.DESCRIPTION
  TD action. Run from an ELEVATED PowerShell on the host that owns the mirror.

  Implements the host half of the curated namespace in ADR 0022 /
  docs/design/windows-dcc-runtime/security-and-mounts.md:

    1. a single-purpose local service account, member of no group (so it holds
       no "allow log on locally" right) and holding no password the guest's
       users know;
    2. NTFS read + execute for that account on the mirror root, and nothing
       else — `rez release` into the pipeline drive must fail by construction,
       not by policy;
    3. an SMB share with -ReadAccess for that account only, caching off (the
       guest must never serve stale package definitions from a client cache)
       and access-based enumeration on (unreadable content is unnamed, not
       merely denied);
    4. an inbound 445 allow scoped to the internal switch interface.

  Re-runnable: every step asserts the desired state and repairs it. -WhatIf
  reports what would change without touching anything. The run ends with a
  verification block printing the resulting account, ACLs, share access and
  firewall state as JSON.

  The account password is generated here and printed ONCE at creation. Store it
  in the guest with `cmdkey /add:<host> /user:<host>\<account> /pass:` at
  provisioning time; this script never persists it. Re-run with -ResetPassword
  to roll it.

.NOTES
  Related: tools/pkgroot-mirror (manifest, sync, drift scan),
  tools/hyperv-spike/m1a-hardware-smoke.ps1 (internal switch).

.EXAMPLE
  pwsh -File tools/pkgroot-mirror/scripts/setup-share.ps1 -MirrorRoot D:\pkgroot -WhatIf

.EXAMPLE
  pwsh -File tools/pkgroot-mirror/scripts/setup-share.ps1 -MirrorRoot D:\pkgroot
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  # Local directory holding the mirrored subtrees (the robocopy destination).
  [Parameter(Mandatory = $true)]
  [string]$MirrorRoot,
  # Share name the guest maps as the pipeline drive  ->  \\<host-internal>\<ShareName>
  [string]$ShareName = "pkgroot",
  # Local account the guest authenticates as. Nothing else uses it.
  [string]$ServiceAccountName = "drydock-pkgroot",
  # Host vNIC of the Hyper-V internal switch; the only interface 445 is served on.
  [string]$InternalSwitchAlias = "vEthernet (drydock-internal)",
  # Roll the service account password and print the new one.
  [switch]$ResetPassword
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$firewallRuleName = "drydock-pkgroot-smb"
$firewallRuleDisplayName = "Drydock pkgroot SMB (internal switch only)"
$accountDescription = "Drydock validation runtime: read-only reader for the curated package mirror."
$accountIdentity = "$env:COMPUTERNAME\$ServiceAccountName"
$notes = [System.Collections.Generic.List[string]]::new()

function Test-Elevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function New-ServicePassword {
  # Not a secret the user types: it is generated, printed once, and stored by
  # the guest in Credential Manager. Get-Random over a fixed set keeps this
  # script dependency-free.
  $characters = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789#%+=?@".ToCharArray()
  return (-join (1..28 | ForEach-Object { $characters | Get-Random }))
}

function Get-LocalGroupsForAccount {
  param([string]$Identity)
  $found = @()
  foreach ($group in @(Get-LocalGroup -ErrorAction SilentlyContinue)) {
    try {
      $members = @(Get-LocalGroupMember -Group $group -ErrorAction Stop)
    } catch {
      continue
    }
    if ($members | Where-Object { $_.Name -eq $Identity }) { $found += $group.Name }
  }
  return $found
}

function Resolve-IdentitySid {
  # ACL identities compare unreliably by name (locale-dependent display names,
  # e.g. "BUILTIN\Administrators"); a SID is the only locale-independent key.
  # An ACE's IdentityReference is usually an NTAccount, but an orphaned SID
  # (deleted account) comes back as a bare SID string - try both, and treat a
  # truly unresolvable identity as "not on the keep list" (fail closed: prune
  # it) rather than accidentally preserving it.
  param([string]$IdentityValue)
  try {
    return ([System.Security.Principal.NTAccount]$IdentityValue).Translate([System.Security.Principal.SecurityIdentifier]).Value
  } catch {
    try {
      return (New-Object System.Security.Principal.SecurityIdentifier($IdentityValue)).Value
    } catch {
      return $null
    }
  }
}

if (-not (Test-Elevated)) {
  throw "setup-share.ps1 must run from an elevated PowerShell: it creates a local account, edits NTFS ACLs, publishes an SMB share and adds a firewall rule."
}

# ---------------------------------------------------------------- mirror root
if (-not (Test-Path -LiteralPath $MirrorRoot)) {
  if ($PSCmdlet.ShouldProcess($MirrorRoot, "Create mirror root directory")) {
    New-Item -ItemType Directory -Force -Path $MirrorRoot | Out-Null
  } else {
    $notes.Add("mirror root does not exist yet")
  }
}

# ------------------------------------------------------------- service account
$account = Get-LocalUser -Name $ServiceAccountName -ErrorAction SilentlyContinue
if ($null -eq $account) {
  if ($PSCmdlet.ShouldProcess($accountIdentity, "Create local service account (no group membership)")) {
    $plain = New-ServicePassword
    $secure = ConvertTo-SecureString -String $plain -AsPlainText -Force
    New-LocalUser -Name $ServiceAccountName -Password $secure -FullName "Drydock pkgroot reader" `
      -Description $accountDescription -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires | Out-Null
    # New-LocalUser joins no group. An account in no group holds no "Allow log
    # on locally" right, which is how this account stays non-interactive
    # without editing local security policy.
    Write-Host ""
    Write-Host "Service account created: $accountIdentity" -ForegroundColor Green
    Write-Host "Password (shown once, not stored by this script):" -ForegroundColor Yellow
    Write-Host "  $plain"
    Write-Host "Store it in the guest: cmdkey /add:<host-internal> /user:$accountIdentity /pass:" -ForegroundColor Yellow
    Write-Host ""
    $account = Get-LocalUser -Name $ServiceAccountName
  } else {
    $notes.Add("service account would be created")
  }
} elseif ($ResetPassword) {
  if ($PSCmdlet.ShouldProcess($accountIdentity, "Reset service account password")) {
    $plain = New-ServicePassword
    $secure = ConvertTo-SecureString -String $plain -AsPlainText -Force
    Set-LocalUser -Name $ServiceAccountName -Password $secure -Description $accountDescription
    Write-Host ""
    Write-Host "Password rolled for ${accountIdentity} (shown once):" -ForegroundColor Yellow
    Write-Host "  $plain"
    Write-Host "Update the guest with cmdkey before the next validation job." -ForegroundColor Yellow
    Write-Host ""
  }
} else {
  $notes.Add("service account already exists; password left unchanged (use -ResetPassword to roll it)")
}

if ($null -ne $account -and -not $account.Enabled) {
  if ($PSCmdlet.ShouldProcess($accountIdentity, "Enable service account")) {
    Enable-LocalUser -Name $ServiceAccountName
  }
}

$accountGroups = @()
if ($null -ne $account) {
  $accountGroups = @(Get-LocalGroupsForAccount -Identity $accountIdentity)
  if ($accountGroups.Count -gt 0) {
    $notes.Add("service account is a member of: $($accountGroups -join ', ') — a share reader should belong to no group")
  }
}

# --------------------------------------------------------------------- NTFS
if (Test-Path -LiteralPath $MirrorRoot) {
  if ($PSCmdlet.ShouldProcess($MirrorRoot, "Break inheritance, strip broader inherited Allow ACEs, and grant $accountIdentity read + execute only")) {
    $acl = Get-Acl -LiteralPath $MirrorRoot
    # Adding our own ACE was never enough on its own: NTFS unions every Allow
    # ACE that matches the caller, so an inherited "Users"/"Authenticated
    # Users" Allow from the parent directory still applied regardless of what
    # we granted $accountIdentity here - the exact gap between this script's
    # "read + execute, and nothing else" promise and its effective access.
    # Break inheritance by COPYING first (nothing disappears silently), then
    # prune every copied rule down to the handful of identities a read-only
    # mirror root is allowed to name.
    $acl.SetAccessRuleProtection($true, $true)
    $keepSids = @(
      "S-1-5-18",     # NT AUTHORITY\SYSTEM
      "S-1-5-32-544", # BUILTIN\Administrators
      "S-1-3-0"       # CREATOR OWNER - default ACL template for new children only
    ) + @(Resolve-IdentitySid -IdentityValue $accountIdentity)
    foreach ($rule in @($acl.Access)) {
      $sid = Resolve-IdentitySid -IdentityValue $rule.IdentityReference.Value
      if ($null -eq $sid -or $keepSids -notcontains $sid) {
        $acl.RemoveAccessRule($rule) | Out-Null
      }
    }
    foreach ($rule in @($acl.Access | Where-Object { $_.IdentityReference.Value -eq $accountIdentity })) {
      $acl.RemoveAccessRule($rule) | Out-Null
    }
    $readRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $accountIdentity, "ReadAndExecute", "ContainerInherit, ObjectInherit", "None", "Allow")
    $acl.AddAccessRule($readRule)
    Set-Acl -LiteralPath $MirrorRoot -AclObject $acl
  }
}

# -------------------------------------------------------------------- share
$share = Get-SmbShare -Name $ShareName -ErrorAction SilentlyContinue
if ($null -eq $share) {
  if ($PSCmdlet.ShouldProcess("\\$env:COMPUTERNAME\$ShareName", "Create read-only SMB share of $MirrorRoot")) {
    New-SmbShare -Name $ShareName -Path $MirrorRoot -ReadAccess $accountIdentity `
      -CachingMode None -FolderEnumerationMode AccessBased `
      -Description "Drydock curated package mirror (read-only)" | Out-Null
    $share = Get-SmbShare -Name $ShareName
  } else {
    $notes.Add("share would be created")
  }
} else {
  if ($share.Path -ne $MirrorRoot) {
    throw "Share '$ShareName' already points at $($share.Path), not $MirrorRoot. Remove it or pass -ShareName; this script will not repoint an existing share."
  }
  if ($PSCmdlet.ShouldProcess("\\$env:COMPUTERNAME\$ShareName", "Assert caching off, access-based enumeration on, read access for $accountIdentity")) {
    Set-SmbShare -Name $ShareName -CachingMode None -FolderEnumerationMode AccessBased -Force | Out-Null
    Grant-SmbShareAccess -Name $ShareName -AccountName $accountIdentity -AccessRight Read -Force | Out-Null
  }
}

if ($null -ne $share) {
  $everyone = @(Get-SmbShareAccess -Name $ShareName -ErrorAction SilentlyContinue | Where-Object { $_.AccountName -eq "Everyone" })
  if ($everyone.Count -gt 0) {
    if ($PSCmdlet.ShouldProcess("\\$env:COMPUTERNAME\$ShareName", "Revoke Everyone")) {
      Revoke-SmbShareAccess -Name $ShareName -AccountName "Everyone" -Force | Out-Null
    }
  }
}

# ----------------------------------------------------------------- firewall
$adapter = Get-NetAdapter -Name $InternalSwitchAlias -ErrorAction SilentlyContinue
if ($null -eq $adapter) {
  $notes.Add("interface '$InternalSwitchAlias' not found — create the Hyper-V internal switch first; until then the rule matches nothing and SMB stays closed on that path")
}

$firewallRule = Get-NetFirewallRule -Name $firewallRuleName -ErrorAction SilentlyContinue
if ($null -eq $firewallRule) {
  if ($PSCmdlet.ShouldProcess($firewallRuleName, "Create inbound TCP 445 allow scoped to $InternalSwitchAlias")) {
    New-NetFirewallRule -Name $firewallRuleName -DisplayName $firewallRuleDisplayName `
      -Description "Serves the curated package mirror to the validation runtime only." `
      -Direction Inbound -Action Allow -Protocol TCP -LocalPort 445 `
      -InterfaceAlias $InternalSwitchAlias -Profile Any -Enabled True | Out-Null
    $firewallRule = Get-NetFirewallRule -Name $firewallRuleName
  } else {
    $notes.Add("firewall rule would be created")
  }
} else {
  if ($PSCmdlet.ShouldProcess($firewallRuleName, "Assert inbound TCP 445 allow scoped to $InternalSwitchAlias")) {
    Set-NetFirewallRule -Name $firewallRuleName -DisplayName $firewallRuleDisplayName `
      -Direction Inbound -Action Allow -Protocol TCP -LocalPort 445 `
      -InterfaceAlias $InternalSwitchAlias -Profile Any -Enabled True | Out-Null
  }
}

# Our rule allows; it cannot restrict. Any other enabled inbound 445 allow keeps
# the mirror reachable from other networks, so name them instead of implying the
# share is sealed.
$otherPort445 = @()
try {
  $otherPort445 = @(
    Get-NetFirewallPortFilter -ErrorAction Stop |
      Where-Object { $_.Protocol -eq "TCP" -and $_.LocalPort -contains "445" } |
      ForEach-Object { Get-NetFirewallRule -AssociatedNetFirewallPortFilter $_ -ErrorAction SilentlyContinue } |
      Where-Object { $_.Enabled -eq "True" -and $_.Direction -eq "Inbound" -and $_.Action -eq "Allow" -and $_.Name -ne $firewallRuleName } |
      ForEach-Object { $_.DisplayName } |
      Sort-Object -Unique
  )
} catch {
  $notes.Add("could not enumerate other 445 rules: $($_.Exception.Message)")
}
if ($otherPort445.Count -gt 0) {
  $notes.Add("other enabled inbound 445 allow rules exist ($($otherPort445.Count)); the mirror is reachable wherever they apply")
}

# -------------------------------------------------------------- verification
$verifyAccount = Get-LocalUser -Name $ServiceAccountName -ErrorAction SilentlyContinue
$verifyShare = Get-SmbShare -Name $ShareName -ErrorAction SilentlyContinue
$verifyShareAccess = @()
if ($null -ne $verifyShare) {
  $verifyShareAccess = @(Get-SmbShareAccess -Name $ShareName -ErrorAction SilentlyContinue |
    ForEach-Object { [pscustomobject]@{ account = $_.AccountName; type = "$($_.AccessControlType)"; right = "$($_.AccessRight)" } })
}
$verifyNtfs = @()
if (Test-Path -LiteralPath $MirrorRoot) {
  $verifyNtfs = @((Get-Acl -LiteralPath $MirrorRoot).Access |
    ForEach-Object { [pscustomobject]@{ identity = $_.IdentityReference.Value; rights = "$($_.FileSystemRights)"; type = "$($_.AccessControlType)"; inherited = $_.IsInherited } })
}
$verifyFirewall = $null
$verifyRule = Get-NetFirewallRule -Name $firewallRuleName -ErrorAction SilentlyContinue
if ($null -ne $verifyRule) {
  $interfaces = @(Get-NetFirewallInterfaceFilter -AssociatedNetFirewallRule $verifyRule -ErrorAction SilentlyContinue | ForEach-Object { $_.InterfaceAlias })
  $verifyFirewall = [pscustomobject]@{
    name = $verifyRule.Name
    displayName = $verifyRule.DisplayName
    enabled = "$($verifyRule.Enabled)"
    direction = "$($verifyRule.Direction)"
    action = "$($verifyRule.Action)"
    interfaceAlias = $interfaces
  }
}

[pscustomobject]@{
  script = "setup-share"
  at = (Get-Date).ToString("o")
  host = $env:COMPUTERNAME
  whatIf = [bool]$WhatIfPreference
  mirrorRoot = $MirrorRoot
  account = [pscustomobject]@{
    identity = $accountIdentity
    exists = ($null -ne $verifyAccount)
    enabled = $(if ($null -ne $verifyAccount) { [bool]$verifyAccount.Enabled } else { $false })
    groups = $accountGroups
  }
  ntfs = $verifyNtfs
  share = $(if ($null -ne $verifyShare) {
    [pscustomobject]@{
      name = $verifyShare.Name
      path = $verifyShare.Path
      cachingMode = "$($verifyShare.CachingMode)"
      folderEnumerationMode = "$($verifyShare.FolderEnumerationMode)"
    }
  } else { $null })
  shareAccess = $verifyShareAccess
  firewall = $verifyFirewall
  internalSwitchPresent = ($null -ne $adapter)
  otherInbound445Rules = $otherPort445
  notes = @($notes)
} | ConvertTo-Json -Depth 5
