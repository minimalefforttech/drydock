/**
 * Hyper-V control plane (ADR 0022 M3).
 *
 * Host execution is limited to VM lifecycle, checkpoint, and inspection
 * commands. Nothing an agent asks for ever runs here - guest-side work goes
 * through the exec channel in `hyperVRuntimeAdapter.ts`.
 *
 * ## Fixed-literal PowerShell (the `snapshotProcessTree` rule)
 *
 * Every script in this module is a module-scope string constant with ZERO
 * interpolation, invoked as
 * `powershell.exe -NoProfile -NonInteractive -Command <script>`. Parameters -
 * VM names, checkpoint names, prefixes - travel as `DRYDOCK_*` environment
 * variables and are read inside the script as `$env:DRYDOCK_VM_NAME`. A VM named
 * `x'; Remove-VM -Name *` is therefore just a string that fails to compare
 * equal; it can never become script text.
 *
 * Two consequences shape the API:
 * - Listing scripts list EVERY VM/checkpoint and the filtering happens in
 *   TypeScript, so no caller string reaches a `-Name` filter (which would also
 *   expand wildcards).
 * - Where a script must select by name it uses `-eq` against `$env:...` inside
 *   `Where-Object`. That is a runtime string comparison, not script-text
 *   interpolation, and `-eq` (unlike `-like`) has no wildcard semantics.
 *
 * ## Results
 *
 * Read methods (`listVms`, `getVm`, `listCheckpoints`, `counters`) throw on
 * failure with the `CommandResult` detail attached. Mutating methods
 * (`startVm`, `stopVm`, `checkpoint`, `restoreCheckpoint`) RETURN the raw
 * `CommandResult`: the adapter has to hand one back to the runtime port, and
 * cleanup reads exit code plus stderr to tell "already gone" from "genuinely
 * stuck". Swallowing that into an exception would erase the distinction.
 */

import type { CommandResult, CommandRunner } from "@drydock/contracts";

/**
 * Hyper-V VM state, narrowed to what the product acts on. Anything that is not
 * Running or Off keeps its raw value visible (`other(Paused)`, `other(10)`) so a
 * transitional or unexpected state can never be mistaken for a healthy one.
 */
export type HyperVVmState = "running" | "off" | `other(${string})`;

export interface HyperVVmInfo {
  readonly name: string;
  readonly state: HyperVVmState;
  /** Percent of host CPU, when Hyper-V reports it (Off VMs report 0/absent). */
  readonly cpuUsagePercent: number | null;
  readonly memoryAssignedBytes: number | null;
  readonly uptimeMs: number | null;
}

export interface HyperVCheckpointInfo {
  readonly vmName: string;
  readonly name: string;
  /** Hyper-V's creation timestamp as reported; absent when unparseable. */
  readonly createdAt: string | null;
  readonly snapshotType: string | null;
}

/** Prefix-scoped rollup for the fleet view (M7 renders this per adapter kind). */
export interface HyperVCounters {
  readonly total: number;
  readonly running: number;
  readonly off: number;
  readonly other: number;
  readonly memoryAssignedBytes: number;
  readonly cpuUsagePercent: number;
}

export interface HyperVControlOptions {
  readonly powershellPath: string;
  readonly commandRunner: CommandRunner;
  readonly cwd: string;
  /**
   * Base environment for every control call. `DRYDOCK_*` parameters are spread
   * ON TOP of it, because `CommandRunnerOptions.env` REPLACES the child
   * environment rather than extending it - passing only the parameters would
   * strip PATH/SystemRoot and powershell.exe would not start.
   */
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  /** Graceful `Stop-VM` waits for the guest to shut down, so it gets its own budget. */
  readonly stopTimeoutMs?: number;
}

const ENV_VM_NAME = "DRYDOCK_VM_NAME";
const ENV_CHECKPOINT_NAME = "DRYDOCK_CHECKPOINT_NAME";

/** Hyper-V `VMState` enum values the product treats as terminal-and-healthy. */
const VM_STATE_RUNNING = 2;
const VM_STATE_OFF = 3;

// ---------------------------------------------------------------------------
// Fixed-literal scripts. NOTHING below is interpolated - see the module header.
// ---------------------------------------------------------------------------

/**
 * Lists every VM. `Uptime` is projected to milliseconds by a calculated
 * property because a raw TimeSpan crosses `ConvertTo-Json` as a nested object
 * whose shape differs between PowerShell versions.
 */
const LIST_VMS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$vms = @(Get-VM | Select-Object -Property Name,State,CPUUsage,MemoryAssigned,@{Name='UptimeMs';Expression={$_.Uptime.TotalMilliseconds}})",
  "ConvertTo-Json -Compress -Depth 3 -InputObject $vms"
].join("\n");

/** Lists every checkpoint of every VM; the caller filters by VM name. */
const LIST_CHECKPOINTS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$snapshots = @(Get-VM | Get-VMSnapshot | Select-Object -Property VMName,Name,SnapshotType,CreationTime)",
  "ConvertTo-Json -Compress -Depth 3 -InputObject $snapshots"
].join("\n");

/**
 * Resolves exactly one VM by name comparison. Shared prologue for the mutating
 * scripts; a miss reports Hyper-V's own "unable to find a virtual machine"
 * wording so `runtimeCleanupService` recognises an already-detached VM.
 */
const RESOLVE_VM_PROLOGUE = [
  "$ErrorActionPreference = 'Stop'",
  "try {",
  "  $found = @(Get-VM | Where-Object { $_.Name -eq $env:DRYDOCK_VM_NAME })",
  "  if ($found.Count -eq 0) { throw 'Hyper-V was unable to find a virtual machine with the requested name.' }",
  "  if ($found.Count -gt 1) { throw 'More than one virtual machine matched the requested name.' }"
].join("\n");

/**
 * `[Console]::Error` rather than `Write-Error`: with `$ErrorActionPreference`
 * set to Stop, `Write-Error` inside a catch throws again and the explicit exit
 * code is never reached.
 */
const CATCH_EPILOGUE = [
  "  exit 0",
  "} catch {",
  "  [Console]::Error.WriteLine($_.Exception.Message)",
  "  exit 3",
  "}"
].join("\n");

const START_VM_SCRIPT = [
  RESOLVE_VM_PROLOGUE,
  "  Start-VM -VM $found[0] | Out-Null",
  CATCH_EPILOGUE
].join("\n");

/** Graceful shutdown request. Already-Off is a no-op, so detach is idempotent. */
const STOP_VM_SCRIPT = [
  RESOLVE_VM_PROLOGUE,
  "  if ($found[0].State -ne 'Off') { Stop-VM -VM $found[0] -Force | Out-Null }",
  CATCH_EPILOGUE
].join("\n");

/** Hard power off (`force`), used when the guest will not shut down politely. */
const TURN_OFF_VM_SCRIPT = [
  RESOLVE_VM_PROLOGUE,
  "  if ($found[0].State -ne 'Off') { Stop-VM -VM $found[0] -TurnOff -Force | Out-Null }",
  CATCH_EPILOGUE
].join("\n");

const CHECKPOINT_VM_SCRIPT = [
  RESOLVE_VM_PROLOGUE,
  "  Checkpoint-VM -VM $found[0] -SnapshotName $env:DRYDOCK_CHECKPOINT_NAME | Out-Null",
  CATCH_EPILOGUE
].join("\n");

/**
 * Restores a named checkpoint. Hyper-V permits duplicate checkpoint names, and
 * reverting to the wrong one silently changes the guest's security posture, so
 * an ambiguous name is an error rather than a newest-wins guess.
 */
const RESTORE_CHECKPOINT_SCRIPT = [
  RESOLVE_VM_PROLOGUE,
  "  $snap = @(Get-VMSnapshot -VM $found[0] | Where-Object { $_.Name -eq $env:DRYDOCK_CHECKPOINT_NAME })",
  "  if ($snap.Count -eq 0) { throw 'The requested checkpoint was not found on that virtual machine.' }",
  "  if ($snap.Count -gt 1) { throw 'More than one checkpoint on that virtual machine has the requested name.' }",
  "  Restore-VMSnapshot -VMSnapshot $snap[0] -Confirm:$false | Out-Null",
  CATCH_EPILOGUE
].join("\n");

export class HyperVControl {
  private readonly timeoutMs: number;
  private readonly stopTimeoutMs: number;

  constructor(private readonly options: HyperVControlOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 120_000;
  }

  /** Every VM on the host. Callers filter; no name ever reaches the script. */
  async listVms(): Promise<HyperVVmInfo[]> {
    const result = await this.run(LIST_VMS_SCRIPT, {}, this.timeoutMs);
    if (result.exitCode !== 0) {
      throw new Error(`Get-VM failed: ${commandDetail(result)}`);
    }
    return parseJsonRows(result.stdout).map(toVmInfo).filter((vm): vm is HyperVVmInfo => vm !== null);
  }

  /**
   * One VM by exact name, or null. The filter runs here rather than in
   * PowerShell: `Get-VM -Name` expands wildcards, so a name containing `*` would
   * silently widen the query.
   */
  async getVm(name: string): Promise<HyperVVmInfo | null> {
    const vms = await this.listVms();
    return vms.find((vm) => vm.name === name)
      ?? vms.find((vm) => vm.name.toLowerCase() === name.toLowerCase())
      ?? null;
  }

  /** Checkpoints of one VM, newest first; the VM filter is client-side. */
  async listCheckpoints(name: string): Promise<HyperVCheckpointInfo[]> {
    const result = await this.run(LIST_CHECKPOINTS_SCRIPT, {}, this.timeoutMs);
    if (result.exitCode !== 0) {
      throw new Error(`Get-VMSnapshot failed: ${commandDetail(result)}`);
    }
    const lowered = name.toLowerCase();
    return parseJsonRows(result.stdout)
      .map(toCheckpointInfo)
      .filter((entry): entry is HyperVCheckpointInfo => entry !== null && entry.vmName.toLowerCase() === lowered)
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  }

  /** Fleet rollup over VMs whose name starts with the product prefix. */
  async counters(namePrefix: string): Promise<HyperVCounters> {
    const vms = (await this.listVms()).filter((vm) => vm.name.startsWith(namePrefix));
    let running = 0;
    let off = 0;
    let other = 0;
    let memoryAssignedBytes = 0;
    let cpuUsagePercent = 0;
    for (const vm of vms) {
      if (vm.state === "running") running += 1;
      else if (vm.state === "off") off += 1;
      else other += 1;
      memoryAssignedBytes += vm.memoryAssignedBytes ?? 0;
      cpuUsagePercent += vm.cpuUsagePercent ?? 0;
    }
    return { total: vms.length, running, off, other, memoryAssignedBytes, cpuUsagePercent };
  }

  /** Starts a stopped VM; already-running is a successful no-op. */
  startVm(name: string): Promise<CommandResult> {
    return this.run(START_VM_SCRIPT, { [ENV_VM_NAME]: name }, this.timeoutMs);
  }

  /** `turnOff` is the hard power cut; otherwise the guest is asked to shut down. */
  stopVm(name: string, turnOff: boolean): Promise<CommandResult> {
    return this.run(
      turnOff ? TURN_OFF_VM_SCRIPT : STOP_VM_SCRIPT,
      { [ENV_VM_NAME]: name },
      turnOff ? this.timeoutMs : this.stopTimeoutMs
    );
  }

  checkpoint(name: string, checkpointName: string): Promise<CommandResult> {
    assertNonEmpty(checkpointName, "checkpoint name");
    return this.run(
      CHECKPOINT_VM_SCRIPT,
      { [ENV_VM_NAME]: name, [ENV_CHECKPOINT_NAME]: checkpointName },
      this.stopTimeoutMs
    );
  }

  restoreCheckpoint(name: string, checkpointName: string): Promise<CommandResult> {
    assertNonEmpty(checkpointName, "checkpoint name");
    return this.run(
      RESTORE_CHECKPOINT_SCRIPT,
      { [ENV_VM_NAME]: name, [ENV_CHECKPOINT_NAME]: checkpointName },
      this.stopTimeoutMs
    );
  }

  /**
   * The single seam every control call goes through: fixed script text, all
   * parameters as environment variables spread over the base environment.
   */
  private run(script: string, parameters: Readonly<Record<string, string>>, timeoutMs: number): Promise<CommandResult> {
    return this.options.commandRunner.run(
      this.options.powershellPath,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        cwd: this.options.cwd,
        timeoutMs,
        env: { ...(this.options.environment ?? process.env), ...parameters }
      }
    );
  }
}

/** The failure text worth showing a human, in stderr-then-error-then-stdout order. */
export function commandDetail(result: CommandResult): string {
  return (result.stderr || result.error || result.stdout || "no output").trim();
}

/**
 * Normalizes `ConvertTo-Json` output into rows. PowerShell serializes a
 * single-element result as a bare object rather than a one-element array, and
 * an empty result as an empty string, so both shapes read as a row list here.
 */
function parseJsonRows(stdout: string): Record<string, unknown>[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null && !Array.isArray(row));
}

function toVmInfo(row: Record<string, unknown>): HyperVVmInfo | null {
  const name = row["Name"];
  if (typeof name !== "string" || name.length === 0) return null;
  return {
    name,
    state: mapVmState(row["State"]),
    cpuUsagePercent: numberOrNull(row["CPUUsage"]),
    memoryAssignedBytes: numberOrNull(row["MemoryAssigned"]),
    uptimeMs: numberOrNull(row["UptimeMs"]) ?? uptimeFromTimeSpan(row["Uptime"])
  };
}

function toCheckpointInfo(row: Record<string, unknown>): HyperVCheckpointInfo | null {
  const vmName = row["VMName"];
  const name = row["Name"];
  if (typeof vmName !== "string" || typeof name !== "string") return null;
  const created = row["CreationTime"];
  const snapshotType = row["SnapshotType"];
  return {
    vmName,
    name,
    createdAt: typeof created === "string" ? created : null,
    snapshotType: typeof snapshotType === "string"
      ? snapshotType
      : typeof snapshotType === "number" ? String(snapshotType) : null
  };
}

/**
 * Maps Hyper-V's `VMState`. `ConvertTo-Json` emits the enum as a NUMBER on
 * Windows PowerShell 5.1 and (depending on version and `-EnumsAsStrings`) as a
 * STRING on PowerShell 7, so both are accepted. Anything that is not clearly
 * Running or Off keeps its raw value in the mapped string - an unknown state
 * must never read as healthy.
 */
export function mapVmState(raw: unknown): HyperVVmState {
  if (typeof raw === "number") {
    if (raw === VM_STATE_RUNNING) return "running";
    if (raw === VM_STATE_OFF) return "off";
    return `other(${String(raw)})`;
  }
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "running") return "running";
    if (normalized === "off") return "off";
    // Some hosts emit the numeric enum as a string.
    if (normalized === String(VM_STATE_RUNNING)) return "running";
    if (normalized === String(VM_STATE_OFF)) return "off";
    return `other(${raw.trim()})`;
  }
  return "other(unknown)";
}

/** WMI/Hyper-V numbers arrive as number or string (uint64); coerce, else null. */
function numberOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Fallback for hosts that serialize `Uptime` as a nested TimeSpan object. */
function uptimeFromTimeSpan(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  return numberOrNull((value as Record<string, unknown>)["TotalMilliseconds"]);
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`A ${label} is required.`);
  }
}
