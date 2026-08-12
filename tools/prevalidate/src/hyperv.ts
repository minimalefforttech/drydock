/**
 * ADR 0022 (Windows DCC validation runtime) Stage 0 environment gates.
 *
 * These checks report whether this workstation could host a Hyper-V validation
 * runtime: Hyper-V feature state, Hyper-V Administrators membership, local
 * storage headroom for the VM disk and the curated package mirror, the native
 * `ssh.exe` exec channel, and DCC license-server configuration. They are
 * registered as optional checks while ADR 0022 is Proposed, so a workstation
 * without Hyper-V reports fix-needed rows without blocking the Stage 0 gate.
 *
 * Every PowerShell script here is a fixed literal with zero interpolation (the
 * `snapshotProcessTree` rule). Parameters travel as environment variables and
 * are read inside the script as `$env:NAME`.
 */

import { existsSync } from "node:fs";
import path from "node:path";

import type { CheckContext, CheckResult, CommandProbe, CommandResult, JsonValue } from "./index.js";

type CheckOutcome = Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">;

/**
 * Process helpers owned by the prevalidate CLI. They are injected so this
 * module stays a leaf import with no cycle back into the CLI entry point.
 */
export interface HyperVCheckDeps {
  run: (
    command: string,
    args: string[],
    options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }
  ) => Promise<CommandResult>;
  findCommandOnPath: (names: string[], key?: string) => string | null;
  commandResultData: (result: CommandResult) => JsonValue;
  oneLine: (text: string) => string;
  timeoutMs: number;
}

const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-Command"];

/** Features the `hyperv` adapter needs: hypervisor, integration services, and the PowerShell module. */
const REQUIRED_FEATURES = [
  "Microsoft-Hyper-V",
  "Microsoft-Hyper-V-Hypervisor",
  "Microsoft-Hyper-V-Services",
  "Microsoft-Hyper-V-Management-PowerShell"
];

const HYPERV_ADMINISTRATORS_SID = "S-1-5-32-578";
const ADMINISTRATORS_SID = "S-1-5-32-544";

/** Combined floor for the VM disk plus the curated package mirror (upgrade-plan Phase 0). */
const STORAGE_FLOOR_BYTES = 150 * 1024 ** 3;

const LICENSE_ENDPOINT_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]*):([0-9]{1,5})$/;

const HYPERV_FEATURE_SCRIPT = [
  "$features = @(Get-CimInstance Win32_OptionalFeature -Filter \"Name LIKE 'Microsoft-Hyper-V%'\" | Select-Object Name,InstallState)",
  "$vmms = Get-Service -Name vmms -ErrorAction SilentlyContinue",
  "$status = ''",
  "if ($vmms) { $status = [string]$vmms.Status }",
  "[pscustomobject]@{ features = $features; vmmsStatus = $status } | ConvertTo-Json -Compress -Depth 4"
].join("\n");

const HYPERV_IDENTITY_SCRIPT = [
  "$identity = [Security.Principal.WindowsIdentity]::GetCurrent()",
  "$groups = @($identity.Groups | ForEach-Object { $_.Value })",
  "[pscustomobject]@{ name = $identity.Name; groups = $groups } | ConvertTo-Json -Compress -Depth 3"
].join("\n");

const HYPERV_STORAGE_SCRIPT = [
  "$rows = @()",
  "foreach ($candidate in @($env:DRYDOCK_PREVALIDATE_PATH_A, $env:DRYDOCK_PREVALIDATE_PATH_B)) {",
  "  $root = ''",
  "  $free = -1",
  "  $total = -1",
  "  $failure = ''",
  "  if ($candidate) {",
  "    try {",
  "      $root = [System.IO.Path]::GetPathRoot($candidate)",
  "      $drive = [System.IO.DriveInfo]::new($root)",
  "      $free = [int64]$drive.AvailableFreeSpace",
  "      $total = [int64]$drive.TotalSize",
  "    } catch { $failure = [string]$_.Exception.Message }",
  "  }",
  "  $rows += [pscustomobject]@{ path = $candidate; root = $root; freeBytes = $free; totalBytes = $total; error = $failure }",
  "}",
  "ConvertTo-Json -InputObject @($rows) -Compress -Depth 3"
].join("\n");

// MARK: -- Checks

/**
 * Hyper-V optional-feature install state plus the `vmms` service state, read in
 * one CIM call. Warns with the enable command when a required feature is off.
 */
export async function checkHyperVFeatures(context: CheckContext, deps: HyperVCheckDeps): Promise<CheckOutcome> {
  const unsupported = windowsOnlyOutcome("Hyper-V feature state");
  if (unsupported) return unsupported;

  const powershell = resolvePowerShell(context, deps);
  if (!powershell) return missingPowerShellOutcome("Hyper-V feature state");

  const result = await deps.run(powershell, [...POWERSHELL_ARGS, HYPERV_FEATURE_SCRIPT], {
    cwd: context.root,
    timeoutMs: deps.timeoutMs
  });
  const parsed = parseJsonRecord(result.stdout);
  if (!parsed) {
    return scriptFailureOutcome(
      "Hyper-V feature state could not be read from Win32_OptionalFeature, so this workstation's Hyper-V readiness is unknown; run the query by hand in PowerShell to see why it failed.",
      powershell,
      result,
      deps
    );
  }

  const states = new Map<string, number>();
  for (const row of asArray(parsed["features"])) {
    const record = asRecord(row);
    const name = asString(record?.["Name"]);
    const state = asNumber(record?.["InstallState"]);
    if (name !== null && state !== null) states.set(name, state);
  }
  const vmmsStatus = asString(parsed["vmmsStatus"]) ?? "";
  const missing = REQUIRED_FEATURES.filter((name) => states.get(name) !== 1);

  const details = [
    `PowerShell: ${powershell}`,
    ...REQUIRED_FEATURES.map((name) => `${name}: ${describeInstallState(states.get(name))}`),
    `vmms service: ${vmmsStatus.length > 0 ? vmmsStatus : "(not reported)"}`
  ];
  const data: JsonValue = {
    features: Object.fromEntries([...states].map(([name, state]) => [name, state])),
    vmmsStatus,
    missing
  };

  if (missing.length > 0) {
    return {
      status: "warn",
      summary: `Hyper-V is missing required feature(s) ${missing.join(", ")}; enable them from an elevated PowerShell with \`Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All\` and reboot before adopting a validation runtime.`,
      details,
      data
    };
  }

  if (vmmsStatus !== "Running") {
    return {
      status: "warn",
      summary: `Hyper-V features are installed but the Hyper-V Virtual Machine Management service reports "${vmmsStatus || "not found"}"; start it from an elevated PowerShell with \`Start-Service vmms\` so \`Get-VM\` and the hyperv adapter can reach the hypervisor.`,
      details,
      data
    };
  }

  return {
    status: "pass",
    summary: "Hyper-V is fully installed (hypervisor, services, and the management PowerShell module) and the vmms service is running.",
    details,
    data
  };
}

/**
 * Hyper-V Administrators membership for the current logon token. Membership is
 * only effective after a new logon, so a stale token honestly reports as a fix.
 */
export async function checkHyperVAdmin(context: CheckContext, deps: HyperVCheckDeps): Promise<CheckOutcome> {
  const unsupported = windowsOnlyOutcome("Hyper-V Administrators membership");
  if (unsupported) return unsupported;

  const powershell = resolvePowerShell(context, deps);
  if (!powershell) return missingPowerShellOutcome("Hyper-V Administrators membership");

  const result = await deps.run(powershell, [...POWERSHELL_ARGS, HYPERV_IDENTITY_SCRIPT], {
    cwd: context.root,
    timeoutMs: deps.timeoutMs
  });
  const parsed = parseJsonRecord(result.stdout);
  if (!parsed) {
    return scriptFailureOutcome(
      "Hyper-V Administrators membership could not be read from the current Windows identity, so runtime adoption may fail with an access-denied error; run the identity query by hand in PowerShell to see why it failed.",
      powershell,
      result,
      deps
    );
  }

  const identityName = asString(parsed["name"]) ?? currentAccountName();
  const groups = asArray(parsed["groups"])
    .map((value) => asString(value))
    .filter((value): value is string => value !== null);
  const inHyperVAdmins = groups.includes(HYPERV_ADMINISTRATORS_SID);
  const inAdministrators = groups.includes(ADMINISTRATORS_SID);

  const details = [
    `Identity: ${identityName}`,
    `Hyper-V Administrators (${HYPERV_ADMINISTRATORS_SID}): ${inHyperVAdmins ? "present" : "absent"}`,
    `Administrators (${ADMINISTRATORS_SID}): ${inAdministrators ? "present" : "absent"}`,
    `Group SIDs in token: ${groups.length}`
  ];
  // Only the two SIDs the gate reasons about are recorded. The rest of the
  // token's group list is identifying and never needs to reach the report.
  const data: JsonValue = { identity: identityName, inHyperVAdmins, inAdministrators, groupCount: groups.length };

  if (inHyperVAdmins) {
    return {
      status: "pass",
      summary: `${identityName} holds Hyper-V Administrators (${HYPERV_ADMINISTRATORS_SID}) in the current logon token, so Hyper-V control runs without elevation.`,
      details,
      data
    };
  }

  if (inAdministrators) {
    return {
      status: "pass",
      summary: `${identityName} reaches Hyper-V through the Administrators group (${ADMINISTRATORS_SID}) only, so every Hyper-V call must run elevated; add the account to Hyper-V Administrators to control validation runtimes unelevated.`,
      details,
      data
    };
  }

  return {
    status: "warn",
    summary: `${identityName} is in neither Hyper-V Administrators nor Administrators, so \`Get-VM\` and the hyperv adapter will fail with access denied; from an elevated PowerShell run \`Add-LocalGroupMember -Group "Hyper-V Administrators" -Member "${identityName}"\`, then sign out and back in so the new group lands in the logon token.`,
    details,
    data
  };
}

/**
 * Free space on the volumes that would hold the validation VM disk and the
 * curated package mirror, measured against the 150 GB combined floor.
 */
export async function checkHyperVStorage(context: CheckContext, deps: HyperVCheckDeps): Promise<CheckOutcome> {
  const unsupported = windowsOnlyOutcome("validation runtime storage");
  if (unsupported) return unsupported;

  const powershell = resolvePowerShell(context, deps);
  if (!powershell) return missingPowerShellOutcome("validation runtime storage");

  const stateRoot = path.join(process.env.ProgramData ?? "C:\\ProgramData", "Drydock");
  const vmRoot = process.env.DRYDOCK_HYPERV_ROOT?.trim() || path.join(stateRoot, "hyperv");
  const mirrorRoot = process.env.DRYDOCK_PKGROOT_MIRROR?.trim() || path.join(stateRoot, "pkgroot");

  const result = await deps.run(powershell, [...POWERSHELL_ARGS, HYPERV_STORAGE_SCRIPT], {
    cwd: context.root,
    timeoutMs: deps.timeoutMs,
    env: {
      ...process.env,
      DRYDOCK_PREVALIDATE_PATH_A: vmRoot,
      DRYDOCK_PREVALIDATE_PATH_B: mirrorRoot
    }
  });

  const rows = parseJsonArray(result.stdout).map((row) => asRecord(row));
  const labels = ["VM disk root (DRYDOCK_HYPERV_ROOT)", "Curated package-mirror root (DRYDOCK_PKGROOT_MIRROR)"];
  const planned = [vmRoot, mirrorRoot];
  const volumes = new Map<string, number>();
  const details: string[] = [];
  const failures: string[] = [];

  for (const [index, label] of labels.entries()) {
    const requested = planned[index] ?? "";
    const record = rows[index];
    const volume = asString(record?.["root"]) ?? "";
    const freeBytes = asNumber(record?.["freeBytes"]) ?? -1;
    const totalBytes = asNumber(record?.["totalBytes"]) ?? -1;
    const failure = asString(record?.["error"]) ?? "";
    if (volume.length === 0 || freeBytes < 0) {
      failures.push(requested);
      details.push(`${label}: ${requested} - volume not resolved${failure.length > 0 ? `: ${deps.oneLine(failure)}` : ""}`);
      continue;
    }
    volumes.set(volume, freeBytes);
    details.push(`${label}: ${requested} on volume ${volume} with ${formatGigabytes(freeBytes)} free of ${formatGigabytes(totalBytes)}`);
  }

  const freeAcrossVolumes = [...volumes.values()].reduce((total, value) => total + value, 0);
  details.push(`Distinct volumes: ${volumes.size}; combined free: ${formatGigabytes(freeAcrossVolumes)}; floor: ${formatGigabytes(STORAGE_FLOOR_BYTES)}`);
  const data: JsonValue = {
    vmRoot,
    mirrorRoot,
    volumes: Object.fromEntries([...volumes].map(([volume, free]) => [volume, free])),
    freeBytes: freeAcrossVolumes,
    floorBytes: STORAGE_FLOOR_BYTES,
    command: deps.commandResultData(result)
  };

  if (failures.length > 0) {
    return {
      status: "warn",
      summary: `Free space could not be measured for ${failures.join(" and ")}, so the storage floor is unproven; point DRYDOCK_HYPERV_ROOT and DRYDOCK_PKGROOT_MIRROR at local volumes, because the VM disk and the curated package mirror cannot live on a network path.`,
      details,
      data
    };
  }

  if (freeAcrossVolumes < STORAGE_FLOOR_BYTES) {
    return {
      status: "warn",
      summary: `Planned VM disk and mirror roots have ${formatGigabytes(freeAcrossVolumes)} free, below the ${formatGigabytes(STORAGE_FLOOR_BYTES)} floor; free space on ${[...volumes.keys()].join(" and ") || "the target volume"} or set DRYDOCK_HYPERV_ROOT and DRYDOCK_PKGROOT_MIRROR to a volume with more headroom.`,
      details,
      data
    };
  }

  return {
    status: "pass",
    summary: `Planned VM disk and mirror roots have ${formatGigabytes(freeAcrossVolumes)} free across ${volumes.size} volume(s), above the ${formatGigabytes(STORAGE_FLOOR_BYTES)} floor.`,
    details,
    data
  };
}

/**
 * Native `ssh.exe` for the star-topology exec channel. Only the Windows OpenSSH
 * executable counts; shim scripts on PATH are reported as a fix, not a pass.
 */
export async function checkHyperVSsh(context: CheckContext, deps: HyperVCheckDeps): Promise<CheckOutcome> {
  const unsupported = windowsOnlyOutcome("the validation runtime exec channel");
  if (unsupported) return unsupported;

  const resolution = resolveSshCommand(deps);
  if (!resolution.path) {
    registerCommandProbe(context, { key: "ssh", names: ["ssh"], path: null, required: false, versionArgs: ["-V"] });
    return {
      status: "warn",
      summary: "The OpenSSH client `ssh.exe` was not found, so the validation runtime has no exec channel; install it from an elevated PowerShell with `Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0`, or set PREVALIDATE_SSH_PATH to a native ssh.exe.",
      details: [`Preferred location: ${preferredSshPath()}`],
      data: { path: null, source: resolution.source }
    };
  }

  if (!/\.exe$/i.test(resolution.path)) {
    registerCommandProbe(context, { key: "ssh", names: ["ssh"], path: resolution.path, required: false, versionArgs: ["-V"] });
    return {
      status: "warn",
      summary: `ssh resolved to ${resolution.path}, which is not a native .exe; the hyperv exec channel spawns ssh directly, so point PREVALIDATE_SSH_PATH at ${preferredSshPath()} instead of a shim script.`,
      details: [`Path: ${resolution.path}`, `Source: ${resolution.source}`],
      data: { path: resolution.path, source: resolution.source }
    };
  }

  const version = await deps.run(resolution.path, ["-V"], { cwd: context.root, timeoutMs: deps.timeoutMs });
  registerCommandProbe(context, {
    key: "ssh",
    names: ["ssh"],
    path: resolution.path,
    required: false,
    versionArgs: ["-V"],
    versionResult: version
  });

  // `ssh -V` writes its banner to stderr, so stdout alone is not a liveness signal.
  const banner = deps.oneLine(version.stderr || version.stdout);
  const details = [
    `Path: ${resolution.path}`,
    `Source: ${resolution.source}`,
    `Version output: ${banner || "(none)"}`,
    `Exit code: ${String(version.exitCode)}`
  ];

  if (banner.length === 0) {
    return {
      status: "warn",
      summary: `${resolution.path} was found but \`ssh -V\` printed no version banner, so the exec channel client cannot be verified; run \`ssh -V\` by hand to see why it failed.`,
      details,
      data: deps.commandResultData(version)
    };
  }

  return {
    status: "pass",
    summary: `Native ssh.exe is available for the validation runtime exec channel (${banner}).`,
    details,
    data: deps.commandResultData(version)
  };
}

/**
 * DCC license-server configuration shape. Stage 0 gates configuration presence
 * only; the studio license service is not reachable from every workstation.
 */
export async function checkHyperVLicenseServer(_context: CheckContext, _deps: HyperVCheckDeps): Promise<CheckOutcome> {
  const raw = process.env.DRYDOCK_LICENSE_SERVER?.trim() ?? "";
  if (raw.length === 0) {
    return {
      status: "optional",
      summary: "No DCC license server is configured, so validation jobs would stall waiting for a license; set DRYDOCK_LICENSE_SERVER to host:port (comma-separated for several servers) until the Configure UI for this setting ships in M7.",
      details: [
        "Environment variable: DRYDOCK_LICENSE_SERVER",
        "Expected format: host:port[,host:port]",
        "Stage 0 gates configuration presence only; reachability is proven from the validation runtime in M1."
      ],
      data: { configured: false, endpoints: [] }
    };
  }

  const entries = raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  const invalid = entries.filter((entry) => !isLicenseEndpoint(entry));
  const details = [
    "Environment variable: DRYDOCK_LICENSE_SERVER",
    `Endpoints: ${entries.join(", ")}`,
    "Stage 0 gates configuration presence only; reachability is proven from the validation runtime in M1."
  ];
  const data: JsonValue = { configured: true, endpoints: entries, invalid };

  if (entries.length === 0 || invalid.length > 0) {
    const problem = invalid.length === 0
      ? "lists no endpoint"
      : invalid.length === 1
        ? `entry ${invalid.join("")} does not parse`
        : `entries ${invalid.join(", ")} do not parse`;
    return {
      status: "warn",
      summary: `DRYDOCK_LICENSE_SERVER is set but ${problem}; use host:port with commas between servers, for example lic01.studio.local:2700,lic01.studio.local:2701.`,
      details,
      data
    };
  }

  return {
    status: "pass",
    summary: `DCC license server configuration names ${entries.length} endpoint(s) in host:port form (${entries.join(", ")}); the vNIC allowlist for the validation runtime is derived from this list.`,
    details,
    data
  };
}

// MARK: -- Helpers

/** Hyper-V is a Windows feature; every other platform reports as not applicable. */
function windowsOnlyOutcome(subject: string): CheckOutcome | null {
  if (process.platform === "win32") return null;
  return {
    status: "optional",
    summary: `Hyper-V validation runtimes need a Windows host, so ${subject} was not checked on ${process.platform}.`,
    details: [`Platform: ${process.platform}`]
  };
}

function missingPowerShellOutcome(subject: string): CheckOutcome {
  return {
    status: "warn",
    summary: `powershell.exe was not found, so ${subject} could not be read; add it to PATH or set PREVALIDATE_POWERSHELL_PATH, because the hyperv control plane runs every command through it.`,
    details: ["Expected location: %SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"]
  };
}

function scriptFailureOutcome(
  summary: string,
  powershell: string,
  result: CommandResult,
  deps: HyperVCheckDeps
): CheckOutcome {
  return {
    status: "warn",
    summary,
    details: [
      `PowerShell: ${powershell}`,
      `Exit code: ${String(result.exitCode)}`,
      `Timed out: ${String(result.timedOut)}`,
      `stdout: ${deps.oneLine(result.stdout)}`,
      `stderr: ${deps.oneLine(result.stderr)}`
    ],
    data: deps.commandResultData(result)
  };
}

/** Reads the cached powershell probe, discovering and caching it on first use. */
function resolvePowerShell(context: CheckContext, deps: HyperVCheckDeps): string | null {
  const cached = context.commands.get("powershell");
  if (cached) return cached.path;
  const found = deps.findCommandOnPath(["powershell"], "powershell");
  registerCommandProbe(context, { key: "powershell", names: ["powershell"], path: found, required: false, versionArgs: [] });
  return found;
}

function registerCommandProbe(context: CheckContext, probe: CommandProbe): void {
  context.commands.set(probe.key, probe);
}

/**
 * Env override wins, then the Windows OpenSSH client, then PATH. PATH order can
 * surface a bundled ssh (Git, WSL shims) that the exec channel should not use.
 */
function resolveSshCommand(deps: HyperVCheckDeps): { path: string | null; source: string } {
  const found = deps.findCommandOnPath(["ssh"], "ssh");
  const override = process.env.PREVALIDATE_SSH_PATH ?? process.env.SSH_PATH ?? null;
  if (found && override && path.resolve(found) === path.resolve(override)) {
    return { path: found, source: "PREVALIDATE_SSH_PATH override" };
  }
  const preferred = preferredSshPath();
  if (existsSync(preferred)) {
    return { path: preferred, source: "Windows OpenSSH client" };
  }
  return { path: found, source: found ? "PATH" : "not found" };
}

function preferredSshPath(): string {
  return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", "ssh.exe");
}

function currentAccountName(): string {
  const domain = process.env.USERDOMAIN ?? process.env.COMPUTERNAME ?? "";
  const user = process.env.USERNAME ?? "";
  return domain.length > 0 ? `${domain}\\${user}` : user;
}

/** Win32_OptionalFeature InstallState: 1 enabled, 2 disabled, 3 absent, 4 unknown. */
function describeInstallState(state: number | undefined): string {
  if (state === 1) return "installed";
  if (state === 2) return "disabled - enable it";
  if (state === 3) return "absent from this Windows edition";
  if (state === 4) return "state unknown";
  if (state === undefined) return "not reported by Win32_OptionalFeature";
  return `install state ${state}`;
}

function isLicenseEndpoint(entry: string): boolean {
  const match = LICENSE_ENDPOINT_PATTERN.exec(entry);
  if (!match) return false;
  const port = Number(match[2]);
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function formatGigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function parseJsonArray(text: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  try {
    return asArray(JSON.parse(trimmed));
  } catch {
    return [];
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** PowerShell collapses single-element pipelines to a scalar, so scalars widen to arrays. */
function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
