/**
 * Standing isolation probes for validation runtimes (ADR 0022, M6).
 *
 * The docset's enforcement doctrine is that the test is always "what happens
 * when agent-generated code tries", never "what the prompt says"
 * (`security-and-mounts.md`). These probes ARE that test, run on a cadence: the
 * guest attempts the three forbidden things (read real production, write the
 * read-only package mirror, connect past the egress allowlist) and one required
 * thing (resolve the studio validation toolsets). A must-fail probe that
 * SUCCEEDS is an isolation breach - quarantine, blocked queue, persistent
 * banner (edge case E5, ux-flows F5) - not a toast.
 *
 * Three rules shape every line here:
 *
 * 1. UNKNOWN IS NEVER GREEN (edge case G2, ADR 0021). A probe whose reply we
 *    cannot read - no exec channel, unconfigured settings, a crashed guest
 *    script, a timeout - reports `unknown`, never `pass`. A broken channel is
 *    not evidence that the guest refused anything.
 * 2. THE GUEST SCRIPTS ARE FIXED LITERALS. Parameters travel as stdin JSON and
 *    are read with `[Console]::In.ReadToEnd() | ConvertFrom-Json` (the M3
 *    `guestJsonCommand` idiom, duplicated here because core must not depend on
 *    `@drydock/runtime-adapters`). Nothing is ever interpolated into script
 *    text - a probe that could be talked into running something else would be
 *    the very hole it exists to find.
 * 3. DETAILS ARE STUDIO VOCABULARY. Every probe's `detail` is one honest
 *    sentence about paths and hosts the TD recognises, never adapter internals
 *    (ux-flows communication spec).
 *
 * Scope: this module runs the suite and raises the incident. It owns no
 * triggers and no storage. M7 wires the schedule, the on-adopt and post-revert
 * runs, the config source, and binds `quarantine` to the inventory + queue
 * block; `probesGreenAt` is in-memory on purpose, so after a host restart
 * receipts omit it and the UI renders unknown rather than inheriting a green
 * from a process that is gone.
 */

import type { CommandResult, NamedRuntimeConfig, ValidationRuntimeId } from "@drydock/contracts";
import type { Clock } from "./clock.js";
import type { ProductEventBus } from "./eventBus.js";
import type { Logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Exec surface
// ---------------------------------------------------------------------------

/**
 * The adapter's exec channel, structurally. Core never imports the Hyper-V
 * adapter, so callers hand in a function already bound to one runtime handle -
 * exactly `RuntimeAdapter.exec` with the handle applied.
 */
export type ValidationProbeExec = (
  args: readonly string[],
  timeoutMs: number,
  input?: string,
  signal?: AbortSignal,
  onStdoutLine?: (line: string) => void
) => Promise<CommandResult>;

/**
 * Resolves the exec channel for one runtime. `null` means the product cannot
 * reach the guest at all right now (host is not Windows, the runtime has no
 * connection, the VM is off) - every probe then reports `unknown`, because
 * "could not ask" is not "was refused".
 */
export type ValidationProbeExecResolver = (runtime: NamedRuntimeConfig) => ValidationProbeExec | null;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** One address the validation runtime must NOT be able to reach. */
export interface ValidationProbeEndpoint {
  readonly host: string;
  readonly port: number;
}

/**
 * What the probes attempt (ADR 0022 `security-and-mounts.md` §Probes). These
 * are the REAL locations, not stubs: reading `X:\Projects` inside the curated
 * namespace proves nothing, so `productionUncPath` is the production UNC path
 * itself and `disallowedEgress` includes the NAS.
 */
export interface ValidationProbeConfig {
  /** The real production location, e.g. `\\therock\Floats\Projects`. */
  readonly productionUncPath: string;
  /** Root of the read-only package mirror as the guest maps it, e.g. `X:\`. */
  readonly mirrorDriveRoot: string;
  /** Addresses outside the allowlist; at minimum the NAS. Empty = unconfigured. */
  readonly disallowedEgress: readonly ValidationProbeEndpoint[];
  /**
   * The studio's rez canary argv, e.g.
   * `["rez", "env", "fr_core", "--", "python", "-c", "print('ok')"]`. Absent
   * means the canary is not configured and the probe reports `unknown`.
   */
  readonly toolsetResolveArgv?: readonly string[];
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** A probe either asserts something must be refused, or must work. */
export type ValidationProbeKind = "must-fail" | "must-succeed";

/**
 * What one probe observed (ADR 0022):
 *
 * - `pass` - the invariant holds. A must-fail probe was REFUSED (the good
 *   outcome; the detail says what was refused) or a must-succeed probe worked.
 * - `breach` - a must-fail probe SUCCEEDED. Security incident: quarantine,
 *   blocked queue, banner.
 * - `fail` - a must-succeed probe did not work. Jobs are blocked by a broken
 *   canary, but nothing escaped: this is not an incident.
 * - `unknown` - the product could not establish the answer. Never renders green
 *   (edge case G2).
 */
export type ValidationProbeState = "pass" | "breach" | "fail" | "unknown";

/** One probe's outcome in one run. */
export interface ProbeResult {
  readonly probeId: string;
  readonly title: string;
  readonly kind: ValidationProbeKind;
  readonly state: ValidationProbeState;
  /** One honest sentence in studio vocabulary; the UI renders it verbatim. */
  readonly detail: string;
  readonly at: string;
}

/**
 * One full pass of the suite. `greenAt` is set ONLY when every probe passed -
 * it is the stamp receipts cite as `probesGreenAt`, so a run with any unknown
 * in it deliberately produces no stamp.
 */
export interface ProbeRunResult {
  readonly runtimeId: ValidationRuntimeId;
  readonly probes: readonly ProbeResult[];
  readonly greenAt?: string;
  /** The FIRST must-fail probe that succeeded, if any; drives the F5 banner. */
  readonly breach?: { readonly probeId: string; readonly detail: string };
  readonly at: string;
}

// ---------------------------------------------------------------------------
// Probe definitions
// ---------------------------------------------------------------------------

/** Argv (and optional stdin JSON) for one probe attempt. */
export interface ValidationProbeInvocation {
  readonly args: readonly string[];
  readonly input?: string;
  /** Minimum budget this probe needs; the service uses the larger of the two. */
  readonly timeoutMs?: number;
}

/** Why a probe could not be attempted; rendered after "Not checked: ". */
export interface ValidationProbeUnavailable {
  readonly notConfigured: string;
}

/** A probe's reading of the guest's reply. */
export interface ValidationProbeVerdict {
  readonly state: ValidationProbeState;
  readonly detail: string;
}

/** One probe, as data: what to run, and how to read what came back. */
export interface ValidationProbeDefinition {
  readonly probeId: string;
  readonly title: string;
  readonly kind: ValidationProbeKind;
  buildExec(config: ValidationProbeConfig): ValidationProbeInvocation | ValidationProbeUnavailable;
  interpret(result: CommandResult, config: ValidationProbeConfig): ValidationProbeVerdict;
}

const DEFAULT_PROBE_TIMEOUT_MS = 20_000;
/** Per-endpoint dial budget inside the guest; the suite must not hang on it. */
const EGRESS_CONNECT_TIMEOUT_MS = 3_000;
/** Fixed name for the mirror write attempt: predictable to spot and to clean. */
const MIRROR_PROBE_FILE_NAME = ".drydock-probe-write-check.tmp";
/** Longest guest error text carried into a one-line detail. */
const DETAIL_LIMIT = 160;

/**
 * Argv for a fixed-literal guest PowerShell script (the M3 idiom, kept local:
 * core does not depend on `@drydock/runtime-adapters`). `powershell.exe` here
 * resolves INSIDE the guest; parameters travel as stdin JSON, never as text.
 */
function guestJsonCommand(fixedScript: string): readonly string[] {
  return ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", fixedScript];
}

/**
 * Attempts to read the REAL production location. `Test-Path` and
 * `Get-ChildItem` are asked separately because they fail for different
 * reasons: production must be unrouted and unnamed, so even a path that merely
 * RESOLVES is a finding, not just one that lists.
 */
export const PRODUCTION_READ_GUEST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$request = [Console]::In.ReadToEnd() | ConvertFrom-Json",
  "$path = [string]$request.path",
  "$exists = $false",
  "$listed = $false",
  "$entries = 0",
  "$err = ''",
  "try { $exists = [bool](Test-Path -LiteralPath $path) } catch { $err = $_.Exception.Message }",
  "try {",
  "  $items = @(Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop)",
  "  $listed = $true",
  "  $entries = $items.Count",
  "} catch { if ([string]::IsNullOrEmpty($err)) { $err = $_.Exception.Message } }",
  "ConvertTo-Json -Compress -InputObject @{ path = $path; exists = $exists; listed = $listed; entries = $entries; error = $err }"
].join("\n");

/**
 * Attempts to create (and then remove) a file on the read-only package mirror.
 * The removal is best effort and reported: a probe that leaves litter on a
 * share it was not supposed to write to must say so.
 */
export const MIRROR_WRITE_GUEST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$request = [Console]::In.ReadToEnd() | ConvertFrom-Json",
  "$root = [string]$request.root",
  "$target = Join-Path -Path $root -ChildPath ([string]$request.fileName)",
  "$wrote = $false",
  "$removed = $false",
  "$err = ''",
  "try { Set-Content -LiteralPath $target -Value 'drydock isolation probe' -ErrorAction Stop; $wrote = $true } catch { $err = $_.Exception.Message }",
  "if ($wrote) { try { Remove-Item -LiteralPath $target -Force -ErrorAction Stop; $removed = $true } catch { } }",
  "ConvertTo-Json -Compress -InputObject @{ target = $target; wrote = $wrote; removed = $removed; error = $err }"
].join("\n");

/**
 * Dials every blocked endpoint in one pass. The endpoint list arrives as stdin
 * JSON and is iterated at runtime - hosts and ports are never spliced into the
 * script. `$address` rather than `$host`: `$host` is a read-only PowerShell
 * automatic variable and assigning to it would fail the whole script.
 */
export const EGRESS_GUEST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$request = [Console]::In.ReadToEnd() | ConvertFrom-Json",
  "$timeoutMs = [int]$request.timeoutMs",
  "$results = @()",
  "foreach ($endpoint in @($request.endpoints)) {",
  "  $address = [string]$endpoint.address",
  "  $port = [int]$endpoint.port",
  "  $connected = $false",
  "  $err = ''",
  "  $client = $null",
  "  try {",
  "    $client = New-Object System.Net.Sockets.TcpClient",
  "    $async = $client.BeginConnect($address, $port, $null, $null)",
  "    if ($async.AsyncWaitHandle.WaitOne($timeoutMs, $false)) { $client.EndConnect($async); $connected = [bool]$client.Connected }",
  "    else { $err = 'connect timed out' }",
  "  } catch { $err = $_.Exception.Message }",
  "  if ($null -ne $client) { $client.Close() }",
  "  $results += @{ address = $address; port = $port; connected = $connected; error = $err }",
  "}",
  "ConvertTo-Json -Compress -Depth 4 -InputObject @{ endpoints = @($results) }"
].join("\n");

/** Reads production. Any successful listing - or even a resolving path - is a breach. */
const PRODUCTION_READ_PROBE: ValidationProbeDefinition = {
  probeId: "probe.production-read",
  title: "Production is unreachable",
  kind: "must-fail",
  buildExec(config) {
    if (config.productionUncPath.trim() === "") {
      return { notConfigured: "no production path is configured to check against." };
    }
    return {
      args: guestJsonCommand(PRODUCTION_READ_GUEST_SCRIPT),
      input: JSON.stringify({ path: config.productionUncPath })
    };
  },
  interpret(result, config) {
    const reply = parseGuestJson(result);
    if (reply === null) return unknownVerdict(result);
    const path = asString(reply["path"]) ?? config.productionUncPath;
    if (reply["listed"] === true) {
      const entries = asNumber(reply["entries"]) ?? 0;
      return {
        state: "breach",
        detail: `PRODUCTION READ SUCCEEDED: listed ${entries} ${entries === 1 ? "entry" : "entries"} under ${path}.`
      };
    }
    if (reply["exists"] === true) {
      return {
        state: "breach",
        detail: `PRODUCTION IS VISIBLE: ${path} resolves from the validation runtime even though listing it was refused.`
      };
    }
    return {
      state: "pass",
      detail: `${path} is not reachable from the validation runtime (${guestReason(reply, "listing refused")}).`
    };
  }
};

/** Writes to the mirror. A successful write means the read-only share is not. */
const MIRROR_WRITE_PROBE: ValidationProbeDefinition = {
  probeId: "probe.mirror-write",
  title: "Package mirror is read-only",
  kind: "must-fail",
  buildExec(config) {
    if (config.mirrorDriveRoot.trim() === "") {
      return { notConfigured: "no package mirror root is configured to check against." };
    }
    return {
      args: guestJsonCommand(MIRROR_WRITE_GUEST_SCRIPT),
      input: JSON.stringify({ root: config.mirrorDriveRoot, fileName: MIRROR_PROBE_FILE_NAME })
    };
  },
  interpret(result, config) {
    const reply = parseGuestJson(result);
    if (reply === null) return unknownVerdict(result);
    const target = asString(reply["target"]) ?? `${config.mirrorDriveRoot}${MIRROR_PROBE_FILE_NAME}`;
    if (reply["wrote"] === true) {
      const litter = reply["removed"] === true ? "" : " and could not remove it again";
      return {
        state: "breach",
        detail: `MIRROR WRITE SUCCEEDED: created ${target} on the read-only package mirror${litter}.`
      };
    }
    return {
      state: "pass",
      detail: `${config.mirrorDriveRoot} refuses writes from the validation runtime (${guestReason(reply, "write refused")}).`
    };
  }
};

/** Dials the blocked endpoints. One connection is one hole in the port ACLs. */
const EGRESS_PROBE: ValidationProbeDefinition = {
  probeId: "probe.egress",
  title: "No egress beyond the allowlist",
  kind: "must-fail",
  buildExec(config) {
    if (config.disallowedEgress.length === 0) {
      return { notConfigured: "no blocked endpoints are configured for this workstation." };
    }
    return {
      args: guestJsonCommand(EGRESS_GUEST_SCRIPT),
      input: JSON.stringify({
        timeoutMs: EGRESS_CONNECT_TIMEOUT_MS,
        endpoints: config.disallowedEgress.map((endpoint) => ({ address: endpoint.host, port: endpoint.port }))
      }),
      // One dial after another in the guest, so the budget grows with the list.
      timeoutMs: config.disallowedEgress.length * EGRESS_CONNECT_TIMEOUT_MS + 5_000
    };
  },
  interpret(result, config) {
    const reply = parseGuestJson(result);
    if (reply === null) return unknownVerdict(result);
    const rows = asRecordArray(reply["endpoints"]);
    if (rows.length === 0) {
      return { state: "unknown", detail: "Not checked: the guest reported no endpoint results." };
    }
    const connected = rows.find((row) => row["connected"] === true);
    if (connected !== undefined) {
      const address = asString(connected["address"]) ?? "an endpoint";
      const port = asNumber(connected["port"]);
      const target = port === undefined ? address : `${address}:${port}`;
      return {
        state: "breach",
        detail: `EGRESS SUCCEEDED: the validation runtime connected to ${target}, which is outside the allowlist.`
      };
    }
    const count = config.disallowedEgress.length;
    return {
      state: "pass",
      detail: `No connection to ${count} blocked ${count === 1 ? "endpoint" : "endpoints"} (${formatEndpoints(config.disallowedEgress)}).`
    };
  }
};

/**
 * The studio rez canary. Exit 0 is the pass; the argv comes from config so the
 * studio owns what "the standard toolsets" means.
 *
 * TODO (M1 runbook): `security-and-mounts.md` also wants every path in the
 * resolved environment to exist guest-side. The intended convention is that the
 * canary prints `DRYDOCK_PATHCHECK:<path>` lines and the host verifies each one;
 * absence of such lines stays a pass on exit 0. It is deliberately NOT
 * implemented here - the canary's real output shape is a Phase 1 spike
 * observation, and a convention the product cannot verify would be theatre.
 */
const TOOLSET_RESOLVE_PROBE: ValidationProbeDefinition = {
  probeId: "probe.toolset-resolve",
  title: "Validation toolsets resolve",
  kind: "must-succeed",
  buildExec(config) {
    const argv = config.toolsetResolveArgv;
    if (argv === undefined || argv.length === 0) {
      return { notConfigured: "no validation toolset canary is configured for this runtime." };
    }
    return { args: argv };
  },
  interpret(result, _config) {
    if (result.exitCode === 0) {
      return { state: "pass", detail: "The validation toolset canary resolved and ran cleanly (exit 0)." };
    }
    if (result.timedOut) {
      return {
        state: "fail",
        detail: `The validation toolset canary did not finish within ${result.durationMs} ms.`
      };
    }
    if (result.exitCode === null) {
      return { state: "unknown", detail: `Not checked: ${unreadableReason(result)}.` };
    }
    const tail = outputTail(result);
    return {
      state: "fail",
      detail: tail === ""
        ? `The validation toolset canary failed (exit ${result.exitCode}) with no output.`
        : `The validation toolset canary failed (exit ${result.exitCode}): ${tail}`
    };
  }
};

/**
 * The suite, in run order (`security-and-mounts.md` §Probes). Order is part of
 * the contract: the isolation checks run before the canary so a breach is found
 * even when the toolset is broken.
 */
export const VALIDATION_PROBES: readonly ValidationProbeDefinition[] = [
  PRODUCTION_READ_PROBE,
  MIRROR_WRITE_PROBE,
  EGRESS_PROBE,
  TOOLSET_RESOLVE_PROBE
];

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ValidationProbeServiceOptions {
  /** Only `isoNow` is used, so tests hand in a fixed stamp. */
  readonly clock: Pick<Clock, "isoNow">;
  readonly logger: Logger;
  readonly bus?: ProductEventBus;
  readonly execFor: ValidationProbeExecResolver;
  /** Probe settings, or undefined when the workstation has none yet. */
  readonly config: () => ValidationProbeConfig | undefined;
  /**
   * Applies the incident: marks the runtime quarantined and blocks its queue.
   * Injected because core owns neither inventory nor the queue - M7 binds it to
   * `RuntimeCleanupService` in `quarantine-only` mode plus the queue block.
   */
  readonly quarantine?: (runtimeId: ValidationRuntimeId, probeId: string, detail: string) => Promise<void>;
  readonly probeTimeoutMs?: number;
}

/**
 * Runs the standing probe suite and raises the incident when a must-fail probe
 * succeeds. Triggers belong to the caller (M7: on adopt, on schedule, before
 * the first job after a revert); this service just answers "what happens when
 * agent-generated code tries" whenever it is asked.
 */
export class ValidationProbeService {
  private readonly lastResults = new Map<ValidationRuntimeId, ProbeRunResult>();
  private readonly probeTimeoutMs: number;

  constructor(private readonly options: ValidationProbeServiceOptions) {
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  }

  /**
   * Runs every probe, in order, one at a time. The suite always runs to the end
   * even after a breach: the incident log should show the whole picture, and a
   * runtime that fails one isolation check may well fail another.
   */
  async runProbes(runtime: NamedRuntimeConfig): Promise<ProbeRunResult> {
    const config = this.options.config();
    const exec = this.options.execFor(runtime);
    const probes: ProbeResult[] = [];
    for (const definition of VALIDATION_PROBES) {
      probes.push(await this.runProbe(definition, runtime, config, exec));
    }

    const at = this.options.clock.isoNow();
    const breach = probes.find((probe) => probe.state === "breach");
    const green = probes.every((probe) => probe.state === "pass");
    const result: ProbeRunResult = {
      runtimeId: runtime.runtimeId,
      probes,
      ...(green ? { greenAt: at } : {}),
      ...(breach === undefined ? {} : { breach: { probeId: breach.probeId, detail: breach.detail } }),
      at
    };
    // Recorded before the incident so anything reacting to the bus event reads
    // the breach run, never the last green one.
    this.lastResults.set(runtime.runtimeId, result);
    if (breach !== undefined) await this.raiseIncident(runtime, breach, at);
    return result;
  }

  /** The most recent run for a runtime, or undefined if it has never run here. */
  lastResult(runtimeId: ValidationRuntimeId): ProbeRunResult | undefined {
    return this.lastResults.get(runtimeId);
  }

  /**
   * The stamp receipts cite (`ValidationReceipt.probesGreenAt`). Only the LATEST
   * run can serve it: once a run comes back with a breach - or with an unknown -
   * the previous green is history, and evidence must not keep quoting it. In
   * memory only, so a restarted host reports undefined until the next run and
   * the UI renders unknown (edge case G2, deliberate).
   */
  probesGreenAt(runtimeId: ValidationRuntimeId): string | undefined {
    return this.lastResults.get(runtimeId)?.greenAt;
  }

  /**
   * Cadence arithmetic for the scheduled trigger: true when the runtime has
   * never been probed in this process, or when its last run is at least
   * `cadenceMs` old. An unreadable stamp also returns true - probing again is
   * cheap, and a stale unknown is not.
   */
  shouldRun(runtimeId: ValidationRuntimeId, cadenceMs: number, now: string = this.options.clock.isoNow()): boolean {
    const last = this.lastResults.get(runtimeId);
    if (last === undefined) return true;
    const lastMs = Date.parse(last.at);
    const nowMs = Date.parse(now);
    if (!Number.isFinite(lastMs) || !Number.isFinite(nowMs)) return true;
    return nowMs - lastMs >= cadenceMs;
  }

  private async runProbe(
    definition: ValidationProbeDefinition,
    runtime: NamedRuntimeConfig,
    config: ValidationProbeConfig | undefined,
    exec: ValidationProbeExec | null
  ): Promise<ProbeResult> {
    if (config === undefined) {
      return this.probeResult(definition, "unknown", "Not checked: validation probe settings are not configured for this workstation.");
    }
    if (exec === null) {
      return this.probeResult(
        definition,
        "unknown",
        `Not checked: ${runtime.displayName} has no exec channel from this host right now.`
      );
    }

    const invocation = definition.buildExec(config);
    if ("notConfigured" in invocation) {
      return this.probeResult(definition, "unknown", `Not checked: ${invocation.notConfigured}`);
    }

    const timeoutMs = Math.max(this.probeTimeoutMs, invocation.timeoutMs ?? 0);
    let result: CommandResult;
    try {
      result = await exec(invocation.args, timeoutMs, invocation.input);
    } catch (error) {
      // A channel that threw proves nothing about the guest's behaviour.
      return this.probeResult(definition, "unknown", `Not checked: the exec channel failed (${clip(messageOf(error))}).`);
    }
    const verdict = definition.interpret(result, config);
    return this.probeResult(definition, verdict.state, verdict.detail);
  }

  private probeResult(definition: ValidationProbeDefinition, state: ValidationProbeState, detail: string): ProbeResult {
    return {
      probeId: definition.probeId,
      title: definition.title,
      kind: definition.kind,
      state,
      detail,
      at: this.options.clock.isoNow()
    };
  }

  /**
   * Quarantine first, then announce - the bus event's contract is that the
   * runtime is already blocked when the banner appears. If quarantining throws
   * we log it and still publish: hiding a breach because a write failed would
   * be the worse failure by far.
   */
  private async raiseIncident(runtime: NamedRuntimeConfig, breach: ProbeResult, at: string): Promise<void> {
    this.options.logger.error("Validation runtime quarantined: a must-fail isolation probe succeeded", {
      runtimeId: runtime.runtimeId,
      probeId: breach.probeId,
      detail: breach.detail
    });
    if (this.options.quarantine !== undefined) {
      try {
        await this.options.quarantine(runtime.runtimeId, breach.probeId, breach.detail);
      } catch (error) {
        this.options.logger.error("Quarantining the validation runtime failed; the incident is reported anyway", {
          runtimeId: runtime.runtimeId,
          probeId: breach.probeId,
          error: messageOf(error)
        });
      }
    }
    this.options.bus?.publish({
      kind: "validation-quarantine",
      runtimeId: runtime.runtimeId,
      probeId: breach.probeId,
      detail: breach.detail,
      at
    });
    this.options.bus?.publish({ kind: "validation-runtime-changed" });
  }
}

// ---------------------------------------------------------------------------
// Reply reading
// ---------------------------------------------------------------------------

/**
 * The guest's JSON reply, or null when there is nothing readable. Parsing is
 * attempted regardless of exit code - a script that reported honestly and then
 * exited badly still told us something - but garbage never becomes a verdict.
 */
function parseGuestJson(result: CommandResult): Record<string, unknown> | null {
  const trimmed = result.stdout.trim();
  if (trimmed === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/** The unknown verdict for an unreadable reply - never a pass (edge case G2). */
function unknownVerdict(result: CommandResult): ValidationProbeVerdict {
  return { state: "unknown", detail: `Not checked: ${unreadableReason(result)}.` };
}

/** One short reason a guest check could not be read. */
function unreadableReason(result: CommandResult): string {
  if (result.timedOut) return `the guest check did not answer within ${result.durationMs} ms`;
  const code = result.exitCode === null ? "no exit code" : `exit ${result.exitCode}`;
  const tail = outputTail(result);
  return tail === ""
    ? `the guest check returned ${code} and no readable reply`
    : `the guest check returned ${code}: ${tail}`;
}

/** The guest's own error text, or a fallback phrase, clipped to one line. */
function guestReason(reply: Record<string, unknown>, fallback: string): string {
  const error = asString(reply["error"]);
  if (error === undefined || error.trim() === "") return fallback;
  return `${fallback}: ${clip(collapse(error))}`;
}

/** Last non-empty output line - stderr first, since that is where errors land. */
function outputTail(result: CommandResult): string {
  const sources = [result.stderr, result.stdout, result.error ?? ""];
  for (const source of sources) {
    const lines = source.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
    const last = lines[lines.length - 1];
    if (last !== undefined) return clip(last);
  }
  return "";
}

function formatEndpoints(endpoints: readonly ValidationProbeEndpoint[]): string {
  const shown = endpoints.slice(0, 3).map((endpoint) => `${endpoint.host}:${endpoint.port}`);
  const rest = endpoints.length - shown.length;
  return rest > 0 ? `${shown.join(", ")}, +${rest} more` : shown.join(", ");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Rows from a guest array. Windows PowerShell's `ConvertTo-Json` renders a
 * one-element array as a bare object, so a single row is accepted too.
 */
function asRecordArray(value: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return rows.filter(
    (row: unknown): row is Record<string, unknown> => typeof row === "object" && row !== null && !Array.isArray(row)
  );
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clip(value: string): string {
  return value.length <= DETAIL_LIMIT ? value : `${value.slice(0, DETAIL_LIMIT - 1)}…`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
