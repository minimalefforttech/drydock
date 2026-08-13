/**
 * Hyper-V validation runtime adapter (ADR 0022 M3).
 *
 * The second runtime class: a product-ADOPTED Windows VM that only ever runs
 * validation jobs. Agent prompts never run here - the host ships a changeset
 * snapshot into a per-job folder and executes a validation profile over the
 * exec channel.
 *
 * ## v1 is adopt-only
 *
 * This adapter NEVER creates or destroys a VM. `createRuntime` ADOPTS: it
 * verifies the named VM exists, starts it if it is off, waits for Running, then
 * probes SSH reachability before handing back a handle. `removeRuntime`
 * DETACHES: it stops the VM and leaves it on disk - there is no `Remove-VM` path
 * anywhere in this module. Golden-image/differencing-disk lifecycle is Phase 5;
 * until then a VM the product did not build is a VM the product must not delete.
 *
 * ## Exec channel: one ssh.exe per call, on purpose
 *
 * Windows OpenSSH has NO ControlMaster multiplexing (`spike-report.md` M1a), so
 * every `exec` spawns its own `ssh.exe`. No `ControlMaster`/`ControlPath` option
 * is ever passed - they would be silently ignored on some builds and hard-fail
 * on others. All spawning goes through one private seam (`sshArgs` + the
 * runner call in `exec`), so a multiplexed or PowerShell-Direct transport can
 * replace it after the M1 studio spike without touching callers.
 *
 * ## Host keys and identity
 *
 * `StrictHostKeyChecking=accept-new` PINS the guest's host key on first connect
 * into the PRODUCT-OWNED known-hosts file passed as `knownHostsFile` (never the
 * user's `~/.ssh/known_hosts`). After that first connect a changed key is a hard
 * failure, which is what makes the internal-switch channel worth trusting; the
 * M7 setup wizard primes the file so even the first connect is verified.
 * `BatchMode=yes` guarantees ssh never blocks on an interactive prompt, and
 * `identityFile` - when configured - is a product-owned key, not the user's.
 *
 * ## Guest-side parameters
 *
 * Guest commands are fixed-literal PowerShell too. Parameters travel as STDIN
 * JSON and are read with `[Console]::In.ReadToEnd() | ConvertFrom-Json` - see
 * `guestJsonCommand`, which M4 (job service) and M6 (probes) reuse.
 */

import type {
  CommandResult,
  CommandRunner,
  RuntimeHandle,
  RuntimeInventoryRecord,
  StartRuntimeRequest,
  ValidationRuntimeConnection
} from "@drydock/contracts";
import type { Logger, RuntimeAdapter } from "@drydock/core";
import { commandDetail, HyperVControl } from "./hyperVControl.js";

export interface HyperVRuntimeAdapterOptions {
  readonly sshPath: string;
  readonly powershellPath: string;
  readonly commandRunner: CommandRunner;
  readonly cwd: string;
  readonly logger: Logger;
  /** Where the exec channel dials; one adapter instance per named runtime. */
  readonly connection: ValidationRuntimeConnection;
  /** Product-owned private key. Absent means the agent/default key is used. */
  readonly identityFile?: string;
  /** Product-owned known-hosts file; never the user's `~/.ssh/known_hosts`. */
  readonly knownHostsFile: string;
  /** Budget for the whole adopt sequence: start + Running + SSH reachable. */
  readonly adoptTimeoutMs?: number;
  readonly execDefaultTimeoutMs?: number;
  /** Guest-side root for per-job workspaces; becomes the handle's runtimeCwd. */
  readonly guestJobRoot?: string;
  /** Base environment for host-side control calls (see `HyperVControl`). */
  readonly environment?: NodeJS.ProcessEnv;
  /** Test seams: deterministic adopt polling without real waiting. */
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const DEFAULT_GUEST_JOB_ROOT = "C:\\drydock\\jobs";
const DEFAULT_ADOPT_TIMEOUT_MS = 60_000;
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
/** ConnectTimeout=10 already bounds the dial; this bounds the whole probe. */
const PROBE_TIMEOUT_MS = 15_000;
/** Trivial fixed command: proves the channel, touches nothing in the guest. */
const PROBE_COMMAND: readonly string[] = ["cmd", "/c", "exit", "0"];

/**
 * Guest-side orphan sweep. The job token arrives as STDIN JSON, never as script
 * text. `-like` runs against each fetched `CommandLine` at runtime - the token
 * is compared, not spliced into a WQL filter.
 *
 * The token rides on the job RUN wrapper's OWN command line (the job service
 * appends it as a trailing argv element), but the hung DCC child does NOT carry
 * it - a stuck `mayapy.exe` is a CHILD of the token-carrying `powershell.exe`,
 * with no token on its own command line. So matching the token finds only the
 * root: the script then walks `Win32_Process.ParentProcessId` to collect every
 * descendant of each matched process and `Stop-Process -Force`es the whole
 * de-duplicated set. The sweeping process itself is skipped so a sweep can never
 * kill its own shell, and the `$seen` set makes the walk cycle-safe.
 *
 * `wrapperPid` (optional) roots the walk even after the wrapper is GONE: an
 * aborted exec kills the token-carrying wrapper first, so its orphaned DCC
 * child matches nothing - only the PID the wrapper announced at start still
 * anchors the parent-link walk (T5.1). The recorded PID is walk-only, never
 * killed on its own: if the OS recycled it to an unrelated process, that
 * process is spared (its children are a remote-enough risk to accept, and the
 * sweep runs within the job turn that recorded the PID).
 */
export const SWEEP_GUEST_JOB_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$request = [Console]::In.ReadToEnd() | ConvertFrom-Json",
  "$token = [string]$request.jobToken",
  "$wrapperPid = 0",
  "if ($null -ne $request.wrapperPid) { $wrapperPid = [int]$request.wrapperPid }",
  "$killed = @()",
  "if ($token.Length -gt 0) {",
  "  $all = @(Get-CimInstance Win32_Process)",
  "  $childrenByParent = @{}",
  "  foreach ($proc in $all) {",
  "    $parentId = [int]$proc.ParentProcessId",
  "    if (-not $childrenByParent.ContainsKey($parentId)) { $childrenByParent[$parentId] = @() }",
  "    $childrenByParent[$parentId] += [int]$proc.ProcessId",
  "  }",
  // $seen is the cycle-safe walk set; $targets is what actually gets stopped.
  // Token matches are both. The recorded wrapper PID is WALK-ONLY: its
  // descendants are targets (an orphaned DCC child of a dead wrapper carries
  // no token - this root is the only thing that still finds it), but the PID
  // itself is stopped only when the token confirms it, so a PID the OS
  // recycled to an unrelated process is never killed on the wrapper's word.
  "  $seen = @{}",
  "  $targets = @{}",
  "  $queue = [System.Collections.Queue]::new()",
  "  foreach ($proc in @($all | Where-Object { $_.CommandLine -like ('*' + $token + '*') })) {",
  "    $rootId = [int]$proc.ProcessId",
  "    if (-not $seen.ContainsKey($rootId)) { $seen[$rootId] = $true; $targets[$rootId] = $true; $queue.Enqueue($rootId) }",
  "  }",
  "  if ($wrapperPid -gt 0 -and -not $seen.ContainsKey($wrapperPid)) { $seen[$wrapperPid] = $true; $queue.Enqueue($wrapperPid) }",
  "  while ($queue.Count -gt 0) {",
  "    $current = [int]$queue.Dequeue()",
  "    foreach ($childId in $childrenByParent[$current]) {",
  "      if (-not $seen.ContainsKey($childId)) { $seen[$childId] = $true; $targets[$childId] = $true; $queue.Enqueue($childId) }",
  "    }",
  "  }",
  "  foreach ($target in @($targets.Keys)) {",
  "    if ($target -eq $PID) { continue }",
  "    try { Stop-Process -Id $target -Force -ErrorAction Stop; $killed += $target } catch { }",
  "  }",
  "}",
  "ConvertTo-Json -Compress -InputObject @{ killed = @($killed) }"
].join("\n");

/** Job tokens are product-generated ids; anything else could widen `-like`. */
const SAFE_JOB_TOKEN = /^[A-Za-z0-9._-]+$/;

export class HyperVRuntimeAdapter implements RuntimeAdapter {
  readonly adapter: RuntimeInventoryRecord["adapter"] = "hyperv";
  /** Control plane for lifecycle/checkpoint work M4+ drives through the adapter. */
  readonly control: HyperVControl;
  private readonly guestJobRoot: string;
  private readonly adoptTimeoutMs: number;
  private readonly execDefaultTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly options: HyperVRuntimeAdapterOptions) {
    this.control = new HyperVControl({
      powershellPath: options.powershellPath,
      commandRunner: options.commandRunner,
      cwd: options.cwd,
      ...(options.environment === undefined ? {} : { environment: options.environment })
    });
    this.guestJobRoot = options.guestJobRoot ?? DEFAULT_GUEST_JOB_ROOT;
    this.adoptTimeoutMs = options.adoptTimeoutMs ?? DEFAULT_ADOPT_TIMEOUT_MS;
    this.execDefaultTimeoutMs = options.execDefaultTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * ADOPTS the pre-provisioned VM named `externalName`; it is never created
   * here. Sequence: confirm it exists -> start it if off -> poll until Running
   * -> probe the exec channel -> return the handle. Every failure names what was
   * actually observed, because "adopt failed" with no state is unactionable.
   */
  async createRuntime(request: StartRuntimeRequest, externalName: string): Promise<RuntimeHandle> {
    const deadline = this.now() + this.adoptTimeoutMs;
    let vm = await this.control.getVm(externalName);
    if (vm === null) {
      throw new Error(
        `Hyper-V was unable to find a virtual machine named "${externalName}" to adopt. ` +
        "Validation runtimes are adopted, never created: provision the VM first, then point the runtime at it."
      );
    }
    if (request.template.mounts.length > 0) {
      // Fixtures, never mounts (ADR 0022): declaring mounts on a validation
      // template must not read as "these are mounted in the guest".
      this.options.logger.warn("validation runtime ignores template mounts; fixtures are per-job copies", {
        runtimeId: request.runtimeId,
        externalName,
        declaredMounts: request.template.mounts.length
      });
    }

    if (vm.state !== "running") {
      const started = await this.control.startVm(externalName);
      if (started.exitCode !== 0) {
        throw new Error(`Start-VM failed for "${externalName}": ${commandDetail(started)}`);
      }
    }
    while (vm.state !== "running") {
      if (this.now() >= deadline) {
        throw new Error(
          `"${externalName}" did not reach Running within ${String(this.adoptTimeoutMs)}ms (last observed state: ${vm.state}).`
        );
      }
      await this.sleep(this.pollIntervalMs);
      vm = await this.control.getVm(externalName);
      if (vm === null) {
        throw new Error(`"${externalName}" disappeared from Hyper-V while waiting for it to start.`);
      }
    }

    const handle: RuntimeHandle = {
      runtimeId: request.runtimeId,
      runtimeGenerationId: request.generationId,
      sessionId: request.sessionId,
      adapter: this.adapter,
      externalName,
      workspacePath: request.workspacePath,
      runtimeCwd: this.guestJobRoot,
      mounts: [],
      status: "running"
    };

    let lastProbe: CommandResult | undefined;
    for (;;) {
      lastProbe = await this.exec(handle, PROBE_COMMAND, PROBE_TIMEOUT_MS);
      if (lastProbe.exitCode === 0) {
        this.options.logger.info("validation runtime adopted", {
          runtimeId: request.runtimeId,
          externalName,
          host: this.options.connection.host
        });
        return handle;
      }
      if (this.now() >= deadline) {
        throw new Error(
          `"${externalName}" is Running but its exec channel did not answer within ${String(this.adoptTimeoutMs)}ms ` +
          `(${this.options.connection.user}@${this.options.connection.host}): ${commandDetail(lastProbe)}`
        );
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  /** Asks the guest to shut down; the VM itself is preserved either way. */
  async stopRuntime(handle: RuntimeHandle, reason: string): Promise<CommandResult> {
    this.options.logger.info("validation runtime stopping", {
      runtimeId: handle.runtimeId,
      externalName: handle.externalName,
      reason
    });
    return this.control.stopVm(handle.externalName, false);
  }

  /**
   * DETACH, not delete. The product stops the VM (a hard `-TurnOff` when
   * `force`) and hands back a successful result noting the VM was preserved -
   * `Remove-VM` is never called from anywhere in this adapter. A stop that fails
   * for any reason OTHER than the VM being absent is returned UNCHANGED so
   * cleanup quarantines it: a validation VM that will not stop is exactly the
   * state a human has to see.
   */
  async removeRuntime(handle: RuntimeHandle, force: boolean): Promise<CommandResult> {
    const stop = await this.control.stopVm(handle.externalName, force);
    const absent = isVmAbsent(stop);
    if (stop.exitCode !== 0 && !absent) {
      return stop;
    }
    this.options.logger.info("validation runtime detached", {
      runtimeId: handle.runtimeId,
      externalName: handle.externalName,
      force,
      absent
    });
    return {
      command: stop.command,
      args: stop.args,
      cwd: stop.cwd,
      exitCode: 0,
      signal: null,
      stdout: absent
        ? `detached (VM preserved): "${handle.externalName}" was already absent from Hyper-V; nothing was deleted.`
        : `detached (VM preserved): "${handle.externalName}" was stopped and left on the host; validation runtimes are never deleted by the product.`,
      stderr: "",
      durationMs: stop.durationMs,
      timedOut: false
    };
  }

  /** Product-prefixed VM names for inventory reconciliation. */
  async listExternalRuntimeNames(namePrefix: string): Promise<string[]> {
    const vms = await this.control.listVms();
    // Token-extract rather than trust the whole name, mirroring the docker
    // adapter: a host naming convention that drifts must not silently break
    // reconciliation.
    const pattern = new RegExp(`${escapeRegExp(namePrefix)}-[A-Za-z0-9-]+`, "g");
    const names = new Set<string>();
    for (const vm of vms) {
      for (const match of vm.name.matchAll(pattern)) {
        names.add(match[0]);
      }
    }
    return [...names];
  }

  /**
   * Runs `args` verbatim in the guest over a fresh `ssh.exe`. `input`, `signal`,
   * and `onStdoutLine` pass straight through to the runner, so abort kills the
   * ssh child and streamed lines reach the ADR 0021 watchdog unbuffered.
   *
   * The handle is not used for addressing: one adapter instance serves exactly
   * one named runtime, so the connection is fixed at construction.
   */
  async exec(
    _handle: RuntimeHandle,
    args: readonly string[],
    timeoutMs: number,
    input?: string,
    signal?: AbortSignal,
    onStdoutLine?: (line: string) => void
  ): Promise<CommandResult> {
    return this.options.commandRunner.run(
      this.options.sshPath,
      [...this.sshArgs(), ...args],
      {
        cwd: this.options.cwd,
        timeoutMs: timeoutMs > 0 ? timeoutMs : this.execDefaultTimeoutMs,
        ...(input === undefined ? {} : { input }),
        ...(signal === undefined ? {} : { signal }),
        ...(onStdoutLine === undefined ? {} : { onStdoutLine })
      }
    );
  }

  /**
   * Kills guest processes left behind by one job: every process whose command
   * line carries the job token (matched INSIDE the guest script, never in script
   * text or a WQL filter) PLUS the descendant tree of each - the hung DCC child
   * is a child of the token-carrying wrapper and carries no token itself.
   * Returns the PIDs actually stopped.
   */
  async sweepGuestJob(
    handle: RuntimeHandle,
    jobToken: string,
    timeoutMs: number,
    signal?: AbortSignal,
    wrapperPid?: number
  ): Promise<number[]> {
    if (!SAFE_JOB_TOKEN.test(jobToken)) {
      throw new Error(`Refusing to sweep with job token "${jobToken}": tokens must match ${String(SAFE_JOB_TOKEN)}.`);
    }
    // A malformed PID is dropped rather than shipped: the guest coerces with
    // [int], and a kill-tree root deserves host-side strictness too.
    const root = wrapperPid !== undefined && Number.isInteger(wrapperPid) && wrapperPid > 0 ? wrapperPid : undefined;
    const result = await this.exec(
      handle,
      guestJsonCommand(SWEEP_GUEST_JOB_SCRIPT),
      timeoutMs,
      JSON.stringify({ jobToken, ...(root === undefined ? {} : { wrapperPid: root }) }),
      signal
    );
    if (result.exitCode !== 0) {
      throw new Error(`Guest job sweep failed for "${handle.externalName}": ${commandDetail(result)}`);
    }
    return parseKilledPids(result.stdout);
  }

  /**
   * The single ssh option set. No ControlMaster/ControlPath: Windows OpenSSH has
   * no multiplexing (module header), so a per-exec process is the design, not an
   * oversight. `--` ends option parsing so a guest command starting with `-` is
   * never eaten as an ssh flag.
   */
  private sshArgs(): string[] {
    const { connection, identityFile, knownHostsFile } = this.options;
    return [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", `UserKnownHostsFile=${knownHostsFile}`,
      ...(identityFile === undefined ? [] : ["-i", identityFile]),
      ...(connection.port === undefined ? [] : ["-p", String(connection.port)]),
      `${connection.user}@${connection.host}`,
      "--"
    ];
  }
}

/**
 * Argv for a fixed-literal guest-side PowerShell script. Parameters must NOT be
 * spliced into `script`; they travel as stdin JSON, which the script reads:
 *
 * ```powershell
 * $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
 * $jobRoot = [string]$request.jobRoot
 * ConvertTo-Json -Compress -InputObject @{ ok = $true }
 * ```
 *
 * Pair it with `exec(handle, guestJsonCommand(SCRIPT), timeoutMs, JSON.stringify(params))`
 * and parse the reply with `JSON.parse`. M4 (job service) and M6 (probe suite)
 * both build on this shape - `powershell.exe` here resolves inside the GUEST.
 */
export function guestJsonCommand(fixedScript: string): string[] {
  return ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", fixedScript];
}

/**
 * Hyper-V's specific "the named VM does not exist" phrasings. Deliberately NOT
 * the bare substring `no virtual machine` (which shows up in unrelated errors
 * like "no virtual machine management service permission") and with NO
 * unanchored `.*`, so a still-Running VM whose failure text merely mentions a
 * virtual machine can never satisfy it.
 */
const VM_ABSENT_PATTERN = /unable to find (a )?virtual machine|no virtual machine (was )?found (with|matching)/;

/**
 * True when a stop failed ONLY because the named VM is no longer on this host.
 * Scoped to stderr/error: Hyper-V lists VM names on stdout, so a name appearing
 * there must never read as "gone". A stop that fails because the VM is locked,
 * access is denied, or the name was empty is returned unchanged for a human.
 */
function isVmAbsent(result: CommandResult): boolean {
  const detail = `${result.stderr} ${result.error ?? ""}`.toLowerCase();
  return VM_ABSENT_PATTERN.test(detail);
}

/** Tolerant read of the sweep reply; unreadable output means "nothing killed". */
function parseKilledPids(stdout: string): number[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const killed = (parsed as Record<string, unknown>)["killed"];
  const rows = Array.isArray(killed) ? killed : killed === undefined ? [] : [killed];
  return rows
    .map((value) => (typeof value === "number" ? value : Number(value)))
    .filter((value) => Number.isFinite(value));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
