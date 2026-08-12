/**
 * Validation job service (ADR 0022 M4): the queue that turns "validate this
 * work" into durable evidence.
 *
 * One job = one changeset, shipped into ONE validation runtime, run under one
 * profile, ending in a receipt. Everything the service does is in service of two
 * promises the ADR makes:
 *
 * - **Evidence binds to a snapshot, not to the live tree.** The changeset ref is
 *   computed at enqueue and copied onto the receipt; if the agent keeps editing,
 *   the receipt is marked `superseded` rather than quietly overclaiming (D2).
 * - **Nothing degrades silently.** Routing parks with a sentence a human can
 *   read (H1); a missing capability parks at QUEUE time naming a runtime that
 *   has it (H8); a license wait is a state, not a hang (E4); a stalled run is
 *   aborted and swept rather than left to look busy.
 *
 * ## Serialization
 *
 * Jobs serialize PER RUNTIME, mirroring `SubtaskOrchestrator`'s invariants: the
 * claim on a runtime is taken synchronously (before any await) so two concurrent
 * drains can never both start work on the same VM; the drain itself is
 * single-flight; queued jobs are FIFO by `queuedAt`. Jobs on DIFFERENT runtimes
 * run concurrently. This queue is entirely separate from the agent fleet's
 * run-slot budget (ADR 0015) - validating never costs an agent a slot.
 *
 * ## Guest job workspace layout
 *
 * ```
 * <guestJobRoot>\<jobId>\ws\<repoName>   one git repo per changeset repository
 * <guestJobRoot>\<jobId>\fixtures        per-job snapshot copies (A1/A6)
 * <guestJobRoot>\<jobId>\prefs\maya      MAYA_APP_DIR
 * <guestJobRoot>\<jobId>\prefs\houdini   HOUDINI_USER_PREF_DIR
 * <guestJobRoot>\<jobId>\out             DRYDOCK_OUTPUT_ROOT
 * <guestJobRoot>\<jobId>\patches         the shipped patch files
 * ```
 *
 * The job token is the job id: it is stamped into `DRYDOCK_JOB_TOKEN` so the
 * adapter's guest sweep can find every process this job left behind. Working
 * directory for the profile is the single repository when the changeset has
 * exactly one, and the `ws` root otherwise. Job dirs from OTHER jobs are removed
 * before a job starts - tidiness only; the real isolation boundary is the
 * checkpoint revert cadence (hygiene by revert, ADR 0022).
 *
 * ## What is deliberately NOT durable
 *
 * The profile itself is not stored on the job row - the job stores `profileRef`
 * and the service rehydrates through `profileFor` (profiles belong to recipes,
 * which are durable). A job interrupted by a host restart whose profile cannot
 * be rehydrated parks instead of guessing (E7). Receipt-less runs leave no
 * evidence at all, which is the point: an interrupted run must not look verified.
 */

import type {
  CommandResult,
  NamedRuntimeConfig,
  ValidationJob,
  ValidationJobId,
  ValidationJobPatch,
  ValidationJobRequest,
  ValidationPolicyDelta,
  ValidationProfile,
  ValidationReceipt,
  ValidationReceiptId,
  ValidationRuntimeAvailability,
  ValidationRuntimeId,
  ValidationRuntimeStore,
  ValidationVerdict
} from "@drydock/contracts";
import { asId } from "@drydock/contracts";
import { randomUUID } from "node:crypto";
import { assertPatchSafeForWindowsGuest } from "./cloneSyncService.js";
import type { ProductEventBus } from "./eventBus.js";
import type { Logger } from "./logger.js";
import { computeReroute, pickAssociation, resolveValidationRuntime } from "./validationRoutingService.js";
import { readMirrorStatus } from "./xrootMirrorStatus.js";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * The adapter's exec channel, structurally - `RuntimeAdapter.exec` with the
 * handle already applied. Deliberately the same shape as `ValidationProbeExec`
 * (M6) so one host-side binder serves the job queue and the probe suite.
 */
export type ValidationJobExec = (
  args: readonly string[],
  timeoutMs: number,
  input?: string,
  signal?: AbortSignal,
  onStdoutLine?: (line: string) => void
) => Promise<CommandResult>;

/**
 * The exec channel this service needs, expressed STRUCTURALLY so core never
 * imports `@drydock/runtime-adapters` (the dependency runs the other way).
 *
 * One instance addresses exactly ONE named runtime - the Hyper-V adapter fixes
 * its connection at construction for the same reason - so nothing here takes a
 * runtime handle. `adapterFor` in the options is where a host binds a real
 * adapter: it owns the `RuntimeHandle` from `createRuntime` and closes over it.
 */
export interface ValidationExecAdapter {
  /** Adopt/boot the VM this adapter is bound to. On-demand boot IS queue state. */
  ensureRunning(): Promise<void>;
  readonly exec: ValidationJobExec;
  /** Kills guest processes whose command line carries the job token. */
  sweepGuestJob(jobToken: string, timeoutMs: number, signal?: AbortSignal): Promise<number[]>;
}

/** One repository's contribution to the shipped changeset. */
export interface ValidationChangesetPatch {
  /** Directory name under `ws`; must be a plain name (no separators, no `..`). */
  readonly repoName: string;
  /** Unified diff, as `CloneSyncService.outboundChangesetPatch` produces it. */
  readonly patch: string;
}

/** What the host can currently ship for a request (null = nothing to validate). */
export interface ValidationChangeset {
  readonly changesetRef: string;
  readonly patches: readonly ValidationChangesetPatch[];
}

/** Injectable timers so the stall watchdog is testable without real waiting. */
export interface ValidationTimers {
  set(handler: () => void, ms: number): unknown;
  clear(token: unknown): void;
}

export interface ValidationJobIdGenerator {
  validationJobId(): ValidationJobId;
  validationReceiptId(): ValidationReceiptId;
}

export interface ValidationJobServiceOptions {
  readonly store: ValidationRuntimeStore;
  readonly clock: { isoNow(): string };
  readonly logger: Logger;
  readonly bus?: ProductEventBus;
  /** Live availability for ONE runtime; only the routed candidate is probed. */
  readonly runtimeAvailability: (runtime: NamedRuntimeConfig) => Promise<ValidationRuntimeAvailability>;
  /** `null` = this runtime cannot execute right now (no connection, or off-win32). */
  readonly adapterFor: (runtime: NamedRuntimeConfig) => ValidationExecAdapter | null;
  /** The snapshot to validate; `null` means there is nothing to validate at all. */
  readonly changesetSource: (request: ValidationJobRequest) => Promise<ValidationChangeset | null>;
  /** Rehydrates a profile for a job restored after a host restart (E7). */
  readonly profileFor?: (profileRef: string) => Promise<ValidationProfile | null>;
  /** Mirror root for receipt freshness stamps (G1); absent leaves them absent. */
  readonly mirrorRoot?: () => string | undefined;
  /** Last green probe run for a runtime (M6 supplies this); absent stays absent. */
  readonly probesGreenAt?: (runtimeId: ValidationRuntimeId) => string | undefined;
  readonly guestJobRoot?: string;
  /** Hard cap on one job's guest execution. Default 30 minutes. */
  readonly jobTurnTimeoutMs?: number;
  /** Silence that counts as a hang. Default 120 s. PAUSED during license waits. */
  readonly inactivityTimeoutMs?: number;
  /**
   * First-output budget for a cold DCC start, used until the first stdout line
   * arrives and then handed over to `inactivityTimeoutMs`. Default 10 minutes,
   * clamped so it never exceeds `jobTurnTimeoutMs`.
   */
  readonly startupTimeoutMs?: number;
  readonly ids?: ValidationJobIdGenerator;
  readonly timers?: ValidationTimers;
  /** Monotonic-ish milliseconds for license-wait arithmetic. Default `Date.now`. */
  readonly monotonicNow?: () => number;
}

/** Result of asking a parked job to run again, possibly somewhere else. */
export type ValidationRequeueResult =
  | { readonly kind: "queued"; readonly job: ValidationJob }
  | {
      readonly kind: "needs-confirm";
      readonly from?: NamedRuntimeConfig;
      readonly to: NamedRuntimeConfig;
      readonly delta: ValidationPolicyDelta;
    }
  /** Still parked, with a NEW reason: the chosen target does not work either. */
  | { readonly kind: "parked"; readonly job: ValidationJob; readonly reason: string };

// ---------------------------------------------------------------------------
// Guest scripts (fixed literals; parameters travel as STDIN JSON)
// ---------------------------------------------------------------------------

/**
 * Argv for a fixed-literal guest PowerShell script. Deliberately identical to
 * `guestJsonCommand` in `@drydock/runtime-adapters` - core cannot import that
 * package (adapters depend on core, not the other way round), and duplicating
 * five tokens beats inverting the dependency.
 *
 * `tag` values (when given) are appended as trailing argv elements - NOT spliced
 * into the script text - so they appear on the guest process's CommandLine where
 * `sweepGuestJob` can find it (Win32_Process exposes no environment block, so an
 * env-only token is invisible to a sweep). The wrapper ignores them; they exist
 * only to label the process.
 */
export function validationGuestCommand(fixedScript: string, ...tags: readonly string[]): string[] {
  return ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", fixedScript, ...tags];
}

/**
 * Builds the job workspace and applies the changeset (D3/D4).
 *
 * Patches arrive BASE64 inside the stdin JSON and are written with
 * `WriteAllBytes`, so the guest validates the changeset's exact bytes - no
 * shell quoting, no script splicing, and no line-ending translation anywhere on
 * the path. `core.autocrlf=false` pins the same rule on git's side (D4), and
 * `core.longpaths` heads off the classic deep-rez-tree failure (F7).
 */
export const VALIDATION_SYNC_GUEST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$request = [Console]::In.ReadToEnd() | ConvertFrom-Json",
  "$jobRoot = [string]$request.jobRoot",
  "$jobId = [string]$request.jobId",
  "$jobDir = Join-Path $jobRoot $jobId",
  "foreach ($leaf in @('ws', 'fixtures', 'out', 'patches', 'prefs\\maya', 'prefs\\houdini')) {",
  "  New-Item -ItemType Directory -Force -Path (Join-Path $jobDir $leaf) | Out-Null",
  "}",
  "if ($null -eq (Get-Command git -ErrorAction SilentlyContinue)) {",
  "  ConvertTo-Json -Compress -Depth 4 -InputObject @{ ok = $false; applied = @(); failures = @(@{ repoName = ''; detail = 'git is not installed in the validation runtime' }) }",
  "  exit 2",
  "}",
  "$ws = Join-Path $jobDir 'ws'",
  "$patchDir = Join-Path $jobDir 'patches'",
  "$applied = @()",
  "$failures = @()",
  "$index = 0",
  "$ErrorActionPreference = 'Continue'",
  "foreach ($entry in @($request.patches)) {",
  "  $index = $index + 1",
  "  $repo = [string]$entry.repoName",
  "  $repoDir = Join-Path $ws $repo",
  "  New-Item -ItemType Directory -Force -Path $repoDir | Out-Null",
  "  $patchFile = Join-Path $patchDir ([string]$index + '.patch')",
  "  [System.IO.File]::WriteAllBytes($patchFile, [System.Convert]::FromBase64String([string]$entry.patchBase64))",
  "  if (-not (Test-Path -LiteralPath (Join-Path $repoDir '.git'))) {",
  "    & git -C $repoDir init --quiet 2>&1 | Out-Null",
  "  }",
  "  & git -C $repoDir config core.autocrlf false 2>&1 | Out-Null",
  "  & git -C $repoDir config core.safecrlf false 2>&1 | Out-Null",
  "  & git -C $repoDir config core.longpaths true 2>&1 | Out-Null",
  "  $out = & git -C $repoDir apply --binary --whitespace=nowarn $patchFile 2>&1",
  "  if ($LASTEXITCODE -eq 0) { $applied += $repo }",
  "  else { $failures += @{ repoName = $repo; detail = (($out | Out-String).Trim()) } }",
  "}",
  "ConvertTo-Json -Compress -Depth 4 -InputObject @{ ok = ($failures.Count -eq 0); applied = @($applied); failures = @($failures) }",
  "if ($failures.Count -gt 0) { exit 1 }"
].join("\n");

/**
 * Writes the job's approved fixture files (stdin JSON `{ jobRoot, jobId,
 * fixtures: [{ relativePath, contentBase64 }] }`).
 *
 * Separate from the sync script on purpose: fixtures are approved studio
 * CONTENT (A1/A6), patches are the changeset, and a job that fails to receive
 * its fixtures must not read as a changeset that would not apply. Paths are
 * rebuilt segment by segment inside the guest and re-checked against the job's
 * own fixture root, so nothing a manifest says can write outside it. Bytes are
 * written with `WriteAllBytes` - a `.ma` file must arrive unchanged.
 */
export const VALIDATION_FIXTURE_GUEST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$request = [Console]::In.ReadToEnd() | ConvertFrom-Json",
  "$jobRoot = [string]$request.jobRoot",
  "$jobId = [string]$request.jobId",
  "$fixtureRoot = Join-Path (Join-Path $jobRoot $jobId) 'fixtures'",
  "New-Item -ItemType Directory -Force -Path $fixtureRoot | Out-Null",
  "$root = [System.IO.Path]::GetFullPath($fixtureRoot)",
  "$written = @()",
  "$failures = @()",
  "foreach ($entry in @($request.fixtures)) {",
  "  $relative = [string]$entry.relativePath",
  "  $target = $root",
  "  $bad = $false",
  "  foreach ($segment in $relative.Split('/')) {",
  "    if ($segment -eq '' -or $segment -eq '.' -or $segment -eq '..') { $bad = $true; break }",
  "    $target = Join-Path $target $segment",
  "  }",
  "  $full = ''",
  "  if (-not $bad) { $full = [System.IO.Path]::GetFullPath($target) }",
  "  if ($bad -or -not $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {",
  "    $failures += @{ relativePath = $relative; detail = 'the fixture path leaves the job fixture directory' }",
  "    continue",
  "  }",
  "  try {",
  "    New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($full)) | Out-Null",
  "    [System.IO.File]::WriteAllBytes($full, [System.Convert]::FromBase64String([string]$entry.contentBase64))",
  "    $written += $relative",
  "  } catch { $failures += @{ relativePath = $relative; detail = $_.Exception.Message } }",
  "}",
  "ConvertTo-Json -Compress -Depth 4 -InputObject @{ ok = ($failures.Count -eq 0); written = @($written); failures = @($failures) }",
  "if ($failures.Count -gt 0) { exit 1 }"
].join("\n");

/**
 * Runs the validation profile (stdin JSON `{ env, argv, cwd }`).
 *
 * `argv` is spawned as a PROCESS, never a shell string, so nothing in a profile
 * can be re-parsed as script. stderr is merged into stdout because the license
 * messages this product must recognise (E4) are written to stderr by every DCC
 * that writes them at all, and the stall watchdog only sees stdout lines. The
 * child's exit code is the script's exit code: verdict arithmetic happens on the
 * host, from a number the guest did not editorialize.
 */
export const VALIDATION_RUN_GUEST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$request = [Console]::In.ReadToEnd() | ConvertFrom-Json",
  "if ($null -ne $request.env) {",
  "  foreach ($pair in $request.env.PSObject.Properties) {",
  "    Set-Item -LiteralPath ('Env:' + $pair.Name) -Value ([string]$pair.Value)",
  "  }",
  "}",
  "$argv = @(@($request.argv) | ForEach-Object { [string]$_ })",
  "if ($argv.Count -eq 0) { [Console]::Out.WriteLine('drydock: this validation profile declares no command to run'); exit 64 }",
  "$cwd = [string]$request.cwd",
  "if ($cwd.Length -gt 0) { Set-Location -LiteralPath $cwd }",
  "$exe = $argv[0]",
  "$rest = @()",
  "if ($argv.Count -gt 1) { $rest = $argv[1..($argv.Count - 1)] }",
  "if ($null -eq (Get-Command $exe -ErrorAction SilentlyContinue)) {",
  "  [Console]::Out.WriteLine('drydock: ' + $exe + ' was not found in this validation runtime')",
  "  exit 127",
  "}",
  "$ErrorActionPreference = 'Continue'",
  "& $exe @rest 2>&1 | ForEach-Object { [Console]::Out.WriteLine([string]$_); [Console]::Out.Flush() }",
  "if ($null -eq $LASTEXITCODE) { exit 0 }",
  "exit $LASTEXITCODE"
].join("\n");

/**
 * Removes every job directory except the one about to run (stdin JSON
 * `{ jobRoot, keepJobId }`). Tidiness, not isolation: the isolation boundary is
 * the checkpoint revert cadence, so every failure here is logged and ignored.
 */
export const VALIDATION_CLEANUP_GUEST_SCRIPT = [
  "$ErrorActionPreference = 'Continue'",
  "$request = [Console]::In.ReadToEnd() | ConvertFrom-Json",
  "$jobRoot = [string]$request.jobRoot",
  "$keep = [string]$request.keepJobId",
  "$removed = @()",
  "if ((Test-Path -LiteralPath $jobRoot) -and $keep.Length -gt 0) {",
  "  foreach ($dir in @(Get-ChildItem -LiteralPath $jobRoot -Directory -ErrorAction SilentlyContinue)) {",
  "    if ($dir.Name -eq $keep) { continue }",
  "    try { Remove-Item -LiteralPath $dir.FullName -Recurse -Force -ErrorAction Stop; $removed += $dir.Name } catch { }",
  "  }",
  "}",
  "ConvertTo-Json -Compress -InputObject @{ removed = @($removed) }"
].join("\n");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_GUEST_JOB_ROOT = "C:\\drydock\\jobs";
const DEFAULT_JOB_TURN_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 120_000;
/**
 * First-output budget for a cold DCC start. `mayapy`/`hython` can take minutes to
 * emit their first line (ssh dial + guest PowerShell start + DCC warm-up), so the
 * tight inactivity budget must NOT govern until output has actually been seen.
 * Clamped to the hard turn cap in the constructor - a genuinely stuck startup is
 * still bounded.
 */
const DEFAULT_STARTUP_TIMEOUT_MS = 600_000;
const GUEST_SETUP_TIMEOUT_MS = 300_000;
const GUEST_CLEANUP_TIMEOUT_MS = 60_000;
const GUEST_SWEEP_TIMEOUT_MS = 30_000;
/** Output kept for verdict parsing and the receipt summary (L2 tail, not L3 logs). */
const OUTPUT_TAIL_LINES = 200;
const SUMMARY_MAX_CHARS = 600;

/**
 * License waits every DCC produces. Profiles ADD to this set rather than
 * replacing it, because "the most common studio failure must never read as the
 * tool is broken" (E4) should not depend on each recipe remembering to say so.
 */
const DEFAULT_LICENSE_WAIT_PATTERNS: readonly string[] = [
  "waiting for.*licen[cs]e",
  "licen[cs]e.*(queue|unavailable|checkout|not obtained)"
];

/** Job dirs and sweep tokens are ids; anything else could widen a guest match. */
const SAFE_JOB_TOKEN = /^[A-Za-z0-9._-]+$/;
/** Repo names become a directory under `ws`: one plain segment, nothing else. */
const SAFE_REPO_NAME = /^[A-Za-z0-9._-]+$/;
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** States a host restart can leave behind mid-flight (E7). */
const INTERRUPTED_STATES = ["starting", "syncing", "resolving", "running", "license-wait"] as const;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ValidationJobService {
  /** At most one job executes per runtime; claimed SYNCHRONOUSLY before any await. */
  private readonly busyRuntimes = new Set<ValidationRuntimeId>();
  /** Jobs claimed out of the queue but not yet moved off `queued` in the store. */
  private readonly claimedJobs = new Set<ValidationJobId>();
  private readonly inFlight = new Map<ValidationJobId, InFlightJob>();
  /**
   * Enqueue-time material (patches are not durable), held until the job reaches
   * a terminal state - NOT until it first runs. A parked job is the one most
   * likely to be requeued ("route to cpp-builds?"), and it should not need a
   * profile rehydrate to answer that click. Only a host restart loses it.
   */
  private readonly pending = new Map<ValidationJobId, JobMaterial>();
  /** Jobs already requeued once after an interruption (E7: requeue-once, then park). */
  private readonly restartRetried = new Set<ValidationJobId>();
  /** The active drain loop (single-flight), or undefined when the queue is idle. */
  private drainPromise: Promise<void> | undefined;
  /** Set while a drain loop runs to force one more `drainQueue` pass (trailing edge). */
  private drainAgain = false;
  /** Serializes state writes fired from streaming callbacks so order is stable. */
  private stateWrites: Promise<void> = Promise.resolve();

  private readonly guestJobRoot: string;
  private readonly jobTurnTimeoutMs: number;
  private readonly inactivityTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly timers: ValidationTimers;
  private readonly monotonicNow: () => number;
  private readonly ids: ValidationJobIdGenerator;

  constructor(private readonly options: ValidationJobServiceOptions) {
    this.guestJobRoot = options.guestJobRoot ?? DEFAULT_GUEST_JOB_ROOT;
    this.jobTurnTimeoutMs = options.jobTurnTimeoutMs ?? DEFAULT_JOB_TURN_TIMEOUT_MS;
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
    // The hard turn cap still bounds a genuinely stuck startup, so the first-output
    // budget is never allowed to exceed it.
    this.startupTimeoutMs = Math.min(
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      this.jobTurnTimeoutMs
    );
    this.timers = options.timers ?? SYSTEM_TIMERS;
    this.monotonicNow = options.monotonicNow ?? (() => Date.now());
    this.ids = options.ids ?? DEFAULT_IDS;
  }

  // -------------------------------------------------------------------------
  // Enqueue
  // -------------------------------------------------------------------------

  /**
   * Routes and queues one validation job.
   *
   * Returns `null` when there is nothing to validate - no changeset means no
   * snapshot to bind evidence to, and a job that can only ever say "nothing
   * happened" is noise, not honesty. Everything else produces a row: `parked`
   * with a readable reason (routing miss H1, or a capability the runtime does
   * not have H8), or `queued` with its position.
   */
  async enqueue(request: ValidationJobRequest): Promise<ValidationJob | null> {
    assertRunnableProfile(request.profile);

    const changeset = await this.options.changesetSource(request);
    if (changeset === null) {
      this.options.logger.info("validation skipped: nothing to validate", {
        sessionId: request.sessionId,
        profileRef: request.profile.profileRef
      });
      return null;
    }

    const routed = await this.route(request.requestedRuntimeId, request.projectRootId);
    const jobId = this.ids.validationJobId();
    if (!SAFE_JOB_TOKEN.test(jobId)) {
      throw new Error(`Refusing to queue validation job "${jobId}": job ids must match ${String(SAFE_JOB_TOKEN)}.`);
    }
    const now = this.options.clock.isoNow();

    const parkedReason = routed.kind === "park"
      ? routed.detail
      : capabilityGap(request.profile, routed.runtime, routed.runtimes);

    const job: ValidationJob = {
      jobId,
      sessionId: request.sessionId,
      chatId: request.chatId,
      ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
      ...(request.subtaskId === undefined ? {} : { subtaskId: request.subtaskId }),
      ...(request.agentId === undefined ? {} : { agentId: request.agentId }),
      ...(request.projectRootId === undefined ? {} : { projectRootId: request.projectRootId }),
      ...(request.requestedRuntimeId === undefined ? {} : { requestedRuntimeId: request.requestedRuntimeId }),
      ...(routed.kind === "resolved" ? { resolvedRuntimeId: routed.runtime.runtimeId } : {}),
      profileRef: request.profile.profileRef,
      changesetRef: changeset.changesetRef,
      state: parkedReason === undefined ? "queued" : "parked",
      ...(parkedReason === undefined ? {} : { parkedReason }),
      queuedAt: now,
      updatedAt: now
    };
    await this.options.store.insertJob(job);
    this.pending.set(jobId, { request, changeset });
    this.publish(job);

    if (parkedReason !== undefined) {
      this.options.logger.info("validation job parked at queue time", { jobId, reason: parkedReason });
      return job;
    }

    await this.drain();
    return (await this.options.store.getJob(jobId)) ?? job;
  }

  // -------------------------------------------------------------------------
  // Abort / requeue / restore
  // -------------------------------------------------------------------------

  /**
   * Stops a job wherever it is. An in-flight job's exec is aborted and its guest
   * processes swept by token; a queued job simply becomes `aborted`. No receipt
   * is written either way - an aborted run produced no evidence.
   */
  async abortJob(jobId: ValidationJobId): Promise<ValidationJob | null> {
    const job = await this.options.store.getJob(jobId);
    if (job === null) return null;
    const live = this.inFlight.get(jobId);
    if (live !== undefined) {
      live.abortedByUser = true;
      live.controller.abort();
      await live.promise;
      return await this.options.store.getJob(jobId);
    }
    if (job.state === "completed" || job.state === "aborted" || job.state === "failed") return job;
    this.pending.delete(jobId);
    const updated = await this.transition(jobId, { state: "aborted", queuePosition: null, completedAt: this.options.clock.isoNow() });
    await this.drain();
    return updated;
  }

  /**
   * Puts a parked job back in the queue, optionally on a different runtime.
   *
   * A reroute NEVER happens silently (H1/H2): when `computeReroute` says the
   * move crosses a policy profile, an image, a capability set, or targets a
   * TD-gated exception runtime, this returns the delta for the caller to render
   * and does not write. Call again with `confirmedDelta: true` to go ahead.
   */
  async requeueParked(
    jobId: ValidationJobId,
    opts: { readonly rerouteTo?: ValidationRuntimeId; readonly confirmedDelta?: boolean } = {}
  ): Promise<ValidationRequeueResult> {
    const job = await this.options.store.getJob(jobId);
    if (job === null) throw new Error(`Validation job "${jobId}" was not found.`);
    if (job.state !== "parked") {
      throw new Error(`Validation job "${jobId}" is ${job.state}, not parked - there is nothing to requeue.`);
    }

    let targetId = opts.rerouteTo ?? job.resolvedRuntimeId;
    if (targetId === undefined) {
      // Parked before any tier resolved (no default set): re-run the cascade so
      // "Run on default instead" works once a default exists.
      const rerouted = await this.route(job.requestedRuntimeId, job.projectRootId);
      if (rerouted.kind === "park") {
        return { kind: "parked", job: await this.parkAndRead(jobId, rerouted.detail), reason: rerouted.detail };
      }
      targetId = rerouted.runtime.runtimeId;
    }

    const to = await this.options.store.getRuntime(targetId);
    if (to === null) throw new Error(`"${targetId}" is no longer in the runtime registry.`);
    // H1's "archived parks" rule again: getRuntime returns archived rows, so a
    // reroute onto a decommissioned runtime must be refused here rather than
    // queued to fail (or, worse, run) on a VM that takes no new jobs.
    if (to.archived === true) {
      const reason = `"${to.displayName}" was archived and no longer runs new validation jobs. Route this job to another runtime.`;
      return { kind: "parked", job: await this.parkAndRead(jobId, reason), reason };
    }
    const from = job.resolvedRuntimeId === undefined || job.resolvedRuntimeId === targetId
      ? null
      : await this.options.store.getRuntime(job.resolvedRuntimeId);

    if (opts.rerouteTo !== undefined && opts.rerouteTo !== job.resolvedRuntimeId) {
      const decision = computeReroute(from ?? undefined, to);
      if (decision.kind === "needs-confirm" && opts.confirmedDelta !== true) {
        return {
          kind: "needs-confirm",
          ...(from === null ? {} : { from }),
          to,
          delta: decision.delta
        };
      }
    }

    // H8 again: a reroute must not move a job onto a runtime that lacks what the
    // profile needs. Catching it here keeps "route to cpp-builds?" a one-click
    // answer rather than a slow red five minutes later.
    const held = this.pending.get(jobId);
    if (held !== undefined) {
      const gap = capabilityGap(held.request.profile, to, await this.options.store.listRuntimes(true));
      if (gap !== undefined) {
        return { kind: "parked", job: await this.parkAndRead(jobId, gap), reason: gap };
      }
    }

    const updated = await this.transition(jobId, {
      state: "queued",
      resolvedRuntimeId: to.runtimeId,
      parkedReason: null,
      queuePosition: null,
      startedAt: null
    });
    await this.drain();
    return { kind: "queued", job: (await this.options.store.getJob(jobId)) ?? updated };
  }

  /**
   * Boot recovery (E7). Jobs the host left mid-flight are requeued ONCE - their
   * workspace is re-shipped from scratch - and parked on a second interruption.
   * Nothing is inherited from the interrupted run: no receipt was written, so no
   * evidence exists to discard.
   */
  async restore(): Promise<void> {
    const interrupted = await this.options.store.listJobs({ states: [...INTERRUPTED_STATES] });
    for (const job of interrupted) {
      if (this.restartRetried.has(job.jobId)) {
        await this.transition(job.jobId, {
          state: "parked",
          parkedReason: "This job was interrupted by a host restart twice. Run validation again when the runtime is settled.",
          queuePosition: null
        });
        continue;
      }
      this.restartRetried.add(job.jobId);
      await this.transition(job.jobId, { state: "queued", queuePosition: null, startedAt: null });
    }
    if (interrupted.length > 0) {
      this.options.logger.info("validation jobs recovered after restart", { requeued: interrupted.length });
    }
    await this.drain();
  }

  /**
   * Resolves once no job is executing and no drain is pending. Test and shutdown
   * seam - the product never needs to wait for the queue.
   */
  async whenIdle(): Promise<void> {
    for (let guard = 0; guard < 10_000; guard += 1) {
      await this.drainPromise;
      await this.stateWrites;
      const live = [...this.inFlight.values()].map((entry) => entry.promise);
      if (live.length === 0 && this.drainPromise === undefined) return;
      await Promise.allSettled(live);
    }
    this.options.logger.error("validation queue did not settle", { inFlight: this.inFlight.size });
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  /**
   * Runs the cascade against live registry state. Availability is only ever
   * probed for the ONE runtime a tier names: the tier choice is mirrored here to
   * decide what to probe, but every decision (dangling, archived, quarantined,
   * missing, no-default) still comes from `resolveValidationRuntime`.
   */
  private async route(
    override: ValidationRuntimeId | undefined,
    projectRootId: ValidationJob["projectRootId"]
  ): Promise<RouteOutcome> {
    const [runtimes, associations, settings] = await Promise.all([
      this.options.store.listRuntimes(true),
      this.options.store.listAssociations(),
      this.options.store.getSettings()
    ]);
    const candidateId = override
      ?? (projectRootId === undefined ? undefined : pickAssociation(associations, projectRootId)?.runtimeId)
      ?? settings.defaultRuntimeId;
    const candidate = candidateId === undefined
      ? undefined
      : runtimes.find((runtime) => runtime.runtimeId === candidateId);
    const availability = new Map<ValidationRuntimeId, ValidationRuntimeAvailability>();
    if (candidate !== undefined) {
      availability.set(candidate.runtimeId, await this.options.runtimeAvailability(candidate));
    }
    const result = resolveValidationRuntime({
      ...(override === undefined ? {} : { override }),
      ...(projectRootId === undefined ? {} : { projectRootId }),
      runtimes,
      associations,
      settings,
      availability: (runtimeId) => availability.get(runtimeId) ?? "missing"
    });
    if (result.kind === "resolved") return { kind: "resolved", runtime: result.runtime, runtimes };
    if (result.kind === "park") return { kind: "park", detail: result.detail };
    // resolveValidationRuntime never returns needs-confirm; keep the union total.
    return { kind: "park", detail: "This job could not be routed to a validation runtime." };
  }

  // -------------------------------------------------------------------------
  // Drain
  // -------------------------------------------------------------------------

  /**
   * Single-flight WITH a trailing edge.
   *
   * A `drainQueue` pass reads `listQueuedJobs` once and claims per-runtime work
   * synchronously. But the running job on a runtime can finish DURING an `await`
   * inside that pass - freeing the runtime after the pass already decided it was
   * busy. A plain single-flight drain would then leave the next job `queued` on
   * an idle runtime until some unrelated completion happened to drain again.
   *
   * So a drain requested while one is active does not merely await it: it sets
   * `drainAgain`, and the active loop runs one more pass after the current one
   * settles. This is NOT what `SubtaskOrchestrator` does (it loops over shared
   * mutable state); the trailing flag is what gives this queue the same "no job
   * is stranded" guarantee.
   */
  private drain(): Promise<void> {
    if (this.drainPromise !== undefined) {
      this.drainAgain = true;
      return this.drainPromise;
    }
    const loop = (async (): Promise<void> => {
      try {
        do {
          this.drainAgain = false;
          await this.drainQueue();
        } while (this.drainAgain);
      } finally {
        this.drainPromise = undefined;
      }
    })();
    this.drainPromise = loop;
    return loop;
  }

  private async drainQueue(): Promise<void> {
    const queued = (await this.options.store.listQueuedJobs()).filter((job) => !this.claimedJobs.has(job.jobId));
    const byRuntime = new Map<ValidationRuntimeId, ValidationJob[]>();
    for (const job of queued) {
      if (job.resolvedRuntimeId === undefined) {
        await this.park(job.jobId, "This job has no resolved validation runtime. Route it to a runtime to run it.");
        continue;
      }
      const bucket = byRuntime.get(job.resolvedRuntimeId) ?? [];
      bucket.push(job);
      byRuntime.set(job.resolvedRuntimeId, bucket);
    }

    for (const [runtimeId, jobs] of byRuntime) {
      let waiting = jobs;
      if (!this.busyRuntimes.has(runtimeId)) {
        const head = jobs[0];
        if (head !== undefined) {
          // Claim synchronously - before any await - so a concurrent drain can
          // never start a second job on this runtime.
          this.busyRuntimes.add(runtimeId);
          this.claimedJobs.add(head.jobId);
          this.launch(head, runtimeId);
          waiting = jobs.slice(1);
        }
      }
      for (const [index, job] of waiting.entries()) {
        const position = index + 1;
        if (job.queuePosition === position) continue;
        await this.transition(job.jobId, { queuePosition: position });
      }
    }
  }

  /** Starts a job's pipeline detached; the runtime claim releases in `finally`. */
  private launch(job: ValidationJob, runtimeId: ValidationRuntimeId): void {
    const controller = new AbortController();
    const entry: InFlightJob = { controller, promise: Promise.resolve(), abortedByUser: false };
    entry.promise = this.runPipeline(job, entry)
      .catch((error: unknown) => {
        this.options.logger.error("validation job pipeline crashed", {
          jobId: job.jobId,
          error: errorMessage(error)
        });
      })
      .finally(() => {
        this.busyRuntimes.delete(runtimeId);
        this.claimedJobs.delete(job.jobId);
        this.inFlight.delete(job.jobId);
        void this.drain().catch((error: unknown) => {
          this.options.logger.error("validation queue drain failed", { error: errorMessage(error) });
        });
      });
    this.inFlight.set(job.jobId, entry);
  }

  // -------------------------------------------------------------------------
  // Pipeline
  // -------------------------------------------------------------------------

  private async runPipeline(queuedJob: ValidationJob, entry: InFlightJob): Promise<void> {
    const jobId = queuedJob.jobId;
    const runtimeId = queuedJob.resolvedRuntimeId;
    if (runtimeId === undefined) return;

    const runtime = await this.options.store.getRuntime(runtimeId);
    if (runtime === null) {
      await this.park(jobId, `"${runtimeId}" is no longer in the runtime registry. Route this job to another runtime.`);
      return;
    }
    // A runtime archived while this job sat in the queue no longer takes new jobs
    // (H1). getRuntime returns archived rows, so this is re-checked here and not
    // just at enqueue - otherwise a queued job would run on a decommissioned VM.
    if (runtime.archived === true) {
      await this.park(
        jobId,
        `"${runtime.displayName}" was archived and no longer runs new validation jobs. Route this job to another runtime.`
      );
      return;
    }
    const adapter = this.options.adapterFor(runtime);
    if (adapter === null) {
      await this.park(
        jobId,
        `"${runtime.displayName}" cannot be reached from this host yet - it has no exec connection. Finish its setup in Configure - Validation runtimes.`
      );
      return;
    }

    // Availability is re-read here, not just at enqueue: a quarantine raised
    // while this job sat in the queue must BLOCK the queue (E5/F5), and a VM
    // that vanished meanwhile must not be dialled. `stopped` runs - booting an
    // on-demand runtime is honest queue state, not a failure.
    const availability = await this.options.runtimeAvailability(runtime);
    if (availability === "quarantined") {
      await this.park(
        jobId,
        `"${runtime.displayName}" is quarantined after a failed isolation check, so its queue is blocked. Review the probe log, or route this job to another runtime.`
      );
      return;
    }
    if (availability === "missing") {
      await this.park(
        jobId,
        `"${runtime.displayName}" is registered but its VM is gone from Hyper-V. Re-adopt or rebuild it, or route this job to another runtime.`
      );
      return;
    }

    const material = await this.materialize(queuedJob);
    if ("parkedReason" in material) {
      await this.park(jobId, material.parkedReason);
      return;
    }

    const job = await this.transition(jobId, {
      state: "starting",
      queuePosition: null,
      startedAt: this.options.clock.isoNow()
    });

    const context: RunContext = { job, runtime, adapter, material, entry, licenseWaitMs: 0 };

    try {
      await adapter.ensureRunning();
    } catch (error) {
      await this.finish(context, "error", `"${runtime.displayName}" did not come up: ${errorMessage(error)}`);
      return;
    }
    if (entry.controller.signal.aborted) {
      await this.markAborted(context);
      return;
    }

    await this.cleanupOtherJobs(context);

    await this.transition(jobId, { state: "syncing" });
    const syncFailure = await this.syncWorkspace(context);
    if (syncFailure !== undefined) {
      if (entry.abortedByUser) {
        await this.markAborted(context);
        return;
      }
      await this.finish(context, "error", syncFailure);
      return;
    }

    await this.transition(jobId, { state: "running" });
    await this.runProfile(context);
  }

  /**
   * Recovers everything a run needs that the job row does not carry. The normal
   * path finds it in memory from `enqueue`; a job requeued after a host restart
   * rehydrates the profile from its `profileRef` and re-queries the changeset -
   * and parks if the working set has moved on, because the receipt would
   * otherwise claim a snapshot that was never run (D2).
   */
  private async materialize(job: ValidationJob): Promise<JobMaterial | { readonly parkedReason: string }> {
    const held = this.pending.get(job.jobId);
    if (held !== undefined) return held;

    const profile = await this.options.profileFor?.(job.profileRef) ?? null;
    if (profile === null) {
      return {
        parkedReason: `This job was interrupted by a host restart and its validation profile "${job.profileRef}" is no longer available. Run validation again.`
      };
    }
    const request: ValidationJobRequest = {
      sessionId: job.sessionId,
      chatId: job.chatId,
      ...(job.taskId === undefined ? {} : { taskId: job.taskId }),
      ...(job.subtaskId === undefined ? {} : { subtaskId: job.subtaskId }),
      ...(job.agentId === undefined ? {} : { agentId: job.agentId }),
      ...(job.projectRootId === undefined ? {} : { projectRootId: job.projectRootId }),
      ...(job.requestedRuntimeId === undefined ? {} : { requestedRuntimeId: job.requestedRuntimeId }),
      profile
    };
    const changeset = await this.options.changesetSource(request);
    if (changeset === null || changeset.changesetRef !== job.changesetRef) {
      return {
        parkedReason: "The work changed while this job was interrupted, so its snapshot no longer exists. Run validation again to bind evidence to the current changeset."
      };
    }
    return { request, changeset };
  }

  /** Best effort, log-only: hygiene is the revert cadence, this is just tidiness. */
  private async cleanupOtherJobs(context: RunContext): Promise<void> {
    try {
      await context.adapter.exec(
        validationGuestCommand(VALIDATION_CLEANUP_GUEST_SCRIPT),
        GUEST_CLEANUP_TIMEOUT_MS,
        JSON.stringify({ jobRoot: this.guestJobRoot, keepJobId: context.job.jobId }),
        context.entry.controller.signal
      );
    } catch (error) {
      this.options.logger.warn("validation guest cleanup skipped", {
        jobId: context.job.jobId,
        error: errorMessage(error)
      });
    }
  }

  /** Ships and applies the changeset. Returns an error sentence, or undefined. */
  private async syncWorkspace(context: RunContext): Promise<string | undefined> {
    const patches = context.material.changeset.patches;
    try {
      for (const entry of patches) {
        if (!SAFE_REPO_NAME.test(entry.repoName)) {
          throw new Error(`Refusing to ship repository "${entry.repoName}": names must match ${String(SAFE_REPO_NAME)}.`);
        }
        assertPatchSafeForWindowsGuest(entry.patch);
      }
    } catch (error) {
      return errorMessage(error);
    }

    let result: CommandResult;
    try {
      result = await context.adapter.exec(
        validationGuestCommand(VALIDATION_SYNC_GUEST_SCRIPT),
        GUEST_SETUP_TIMEOUT_MS,
        JSON.stringify({
          jobRoot: this.guestJobRoot,
          jobId: context.job.jobId,
          patches: patches.map((entry) => ({
            repoName: entry.repoName,
            patchBase64: Buffer.from(entry.patch, "utf8").toString("base64")
          }))
        }),
        context.entry.controller.signal
      );
    } catch (error) {
      return `The changeset could not be shipped to "${context.runtime.displayName}": ${errorMessage(error)}`;
    }
    if (result.exitCode !== 0) {
      const detail = parseSyncFailure(result);
      return `The changeset did not apply in "${context.runtime.displayName}": ${detail}`;
    }
    return this.shipFixtures(context);
  }

  /**
   * Ships the approved fixture copies AFTER the changeset, in their own exec.
   *
   * A job whose fixtures cannot be delivered must not run: the suite would then
   * fail for a reason that has nothing to do with the code, and the receipt
   * would record a verdict about the wrong thing. So this returns an error
   * sentence like every other setup step, and the job ends as infrastructure
   * error rather than a test failure.
   */
  private async shipFixtures(context: RunContext): Promise<string | undefined> {
    const fixtures = context.material.request.fixtures ?? [];
    if (fixtures.length === 0) return undefined;
    for (const fixture of fixtures) {
      if (!isSafeFixturePath(fixture.relativePath)) {
        return `Refusing to ship fixture "${fixture.relativePath}": fixture paths must stay inside the job's fixture directory.`;
      }
    }
    let result: CommandResult;
    try {
      result = await context.adapter.exec(
        validationGuestCommand(VALIDATION_FIXTURE_GUEST_SCRIPT),
        GUEST_SETUP_TIMEOUT_MS,
        JSON.stringify({
          jobRoot: this.guestJobRoot,
          jobId: context.job.jobId,
          fixtures: fixtures.map((fixture) => ({
            relativePath: fixture.relativePath,
            contentBase64: fixture.contentBase64
          }))
        }),
        context.entry.controller.signal
      );
    } catch (error) {
      return `The approved fixtures could not be copied into "${context.runtime.displayName}": ${errorMessage(error)}`;
    }
    if (result.exitCode === 0) return undefined;
    return `The approved fixtures did not land in "${context.runtime.displayName}": ${parseFixtureFailure(result)}`;
  }

  /** Runs the profile with the license-wait and stall watchdogs attached (E4). */
  private async runProfile(context: RunContext): Promise<void> {
    const { entry } = context;
    const jobId = context.job.jobId;
    const patterns = compileLicensePatterns(
      context.material.request.profile.licenseWaitPatterns,
      this.options.logger
    );
    const tail: string[] = [];
    let licenseWaitSince: number | undefined;
    let watchdog: unknown;
    let stalledForMs: number | undefined;
    // Until the first line of output, the watchdog uses the larger STARTUP budget:
    // a cold DCC start (ssh dial + guest PowerShell + mayapy/hython warm-up) must
    // not be read as a hang (E4). The first line flips it to the tight inactivity
    // budget, and `stalledDuringStartup` lets the receipt say which one tripped.
    let firstLineSeen = false;
    let stalledDuringStartup = false;

    const armWatchdog = (): void => {
      if (watchdog !== undefined) this.timers.clear(watchdog);
      const budget = firstLineSeen ? this.inactivityTimeoutMs : this.startupTimeoutMs;
      const duringStartup = !firstLineSeen;
      watchdog = this.timers.set(() => {
        stalledForMs = budget;
        stalledDuringStartup = duringStartup;
        entry.controller.abort();
      }, budget);
    };
    const disarmWatchdog = (): void => {
      if (watchdog === undefined) return;
      this.timers.clear(watchdog);
      watchdog = undefined;
    };

    const onStdoutLine = (line: string): void => {
      const at = this.monotonicNow();
      tail.push(line);
      if (tail.length > OUTPUT_TAIL_LINES) tail.shift();
      // Any output at all means the process launched, so from here the tight
      // inactivity budget governs - including the re-arm after a license wait.
      firstLineSeen = true;

      if (licenseWaitSince !== undefined) {
        // Output resumed: the wait is over and its duration is evidence.
        context.licenseWaitMs += Math.max(0, at - licenseWaitSince);
        licenseWaitSince = undefined;
        this.queueTransition(jobId, { state: "running" });
      }
      if (patterns.some((pattern) => pattern.test(line))) {
        licenseWaitSince = at;
        disarmWatchdog();
        this.queueTransition(jobId, { state: "license-wait" });
        return;
      }
      armWatchdog();
    };

    armWatchdog();
    let result: CommandResult;
    try {
      result = await context.adapter.exec(
        // Tag the wrapper process with the job id so sweepGuestJob (which matches
        // CommandLine and tree-walks) can find and reap it and its DCC children.
        validationGuestCommand(VALIDATION_RUN_GUEST_SCRIPT, jobId),
        this.jobTurnTimeoutMs,
        JSON.stringify({
          env: this.composeEnv(context),
          argv: [...context.material.request.profile.argv],
          cwd: this.workingDirectory(context)
        }),
        entry.controller.signal,
        onStdoutLine
      );
    } catch (error) {
      disarmWatchdog();
      await this.stateWrites;
      await this.sweep(context);
      if (entry.abortedByUser) {
        await this.markAborted(context);
        return;
      }
      await this.finish(context, "error", `The validation run could not be completed: ${errorMessage(error)}`);
      return;
    } finally {
      disarmWatchdog();
    }
    if (licenseWaitSince !== undefined) {
      context.licenseWaitMs += Math.max(0, this.monotonicNow() - licenseWaitSince);
    }
    await this.stateWrites;

    if (entry.abortedByUser) {
      await this.sweep(context);
      await this.markAborted(context);
      return;
    }
    if (stalledForMs !== undefined) {
      await this.sweep(context);
      const message = stalledDuringStartup
        ? `No output for ${formatSeconds(stalledForMs)} after start - treat this run as not launching. The guest processes were stopped.`
        : `No output for ${formatSeconds(stalledForMs)} - treat this run as hung. The guest processes were stopped.`;
      await this.finish(context, "error", message, tail);
      return;
    }
    if (result.timedOut) {
      await this.sweep(context);
      await this.finish(
        context,
        "error",
        `This run passed its ${formatMinutes(this.jobTurnTimeoutMs)} cap and was stopped.`,
        tail
      );
      return;
    }

    const output = tail.join("\n");
    if (result.exitCode === 0) {
      await this.finish(context, "passed", summarizeRun(output) ?? "Validation passed.", tail);
      return;
    }
    await this.finish(
      context,
      "failed",
      summarizeRun(output) ?? `The validation profile exited with code ${String(result.exitCode ?? -1)}.`,
      tail
    );
  }

  /**
   * Job-scoped guest environment. Profile vars go in FIRST so the job-scoped
   * ones win: a profile must never be able to point `MAYA_APP_DIR` at a shared
   * directory and poison the next job's prefs.
   */
  private composeEnv(context: RunContext): Record<string, string> {
    const jobDir = this.jobDir(context.job.jobId);
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(context.material.request.profile.env ?? {})) {
      if (!SAFE_ENV_NAME.test(name)) {
        this.options.logger.warn("validation profile env var skipped", { jobId: context.job.jobId, name });
        continue;
      }
      env[name] = value;
    }
    env["MAYA_APP_DIR"] = `${jobDir}\\prefs\\maya`;
    env["HOUDINI_USER_PREF_DIR"] = `${jobDir}\\prefs\\houdini`;
    env["DRYDOCK_FIXTURE_ROOT"] = `${jobDir}\\fixtures`;
    env["DRYDOCK_OUTPUT_ROOT"] = `${jobDir}\\out`;
    env["DRYDOCK_JOB_TOKEN"] = context.job.jobId;
    return env;
  }

  /** One repo means the profile runs inside it; several means the `ws` root. */
  private workingDirectory(context: RunContext): string {
    const ws = `${this.jobDir(context.job.jobId)}\\ws`;
    const patches = context.material.changeset.patches;
    const only = patches.length === 1 ? patches[0] : undefined;
    return only === undefined ? ws : `${ws}\\${only.repoName}`;
  }

  private jobDir(jobId: ValidationJobId): string {
    return `${this.guestJobRoot}\\${jobId}`;
  }

  private async sweep(context: RunContext): Promise<void> {
    try {
      const killed = await context.adapter.sweepGuestJob(context.job.jobId, GUEST_SWEEP_TIMEOUT_MS);
      if (killed.length > 0) {
        this.options.logger.info("validation guest processes swept", { jobId: context.job.jobId, killed: killed.length });
      }
    } catch (error) {
      this.options.logger.warn("validation guest sweep failed", {
        jobId: context.job.jobId,
        error: errorMessage(error)
      });
    }
  }

  // -------------------------------------------------------------------------
  // Receipts
  // -------------------------------------------------------------------------

  /**
   * Writes the receipt and closes the job. `passed`/`failed` complete the job -
   * the RECEIPT holds the verdict - while `error` marks the job itself failed,
   * because infrastructure trouble is not a test result.
   */
  private async finish(
    context: RunContext,
    verdict: ValidationVerdict,
    summary: string,
    tail?: readonly string[]
  ): Promise<void> {
    const now = this.options.clock.isoNow();
    const receiptId = this.ids.validationReceiptId();
    const hints = verdict === "failed" && tail !== undefined
      ? parseValidationFailure(tail.join("\n"))
      : {};
    const mirror = await this.readMirror();
    const probesGreenAt = this.options.probesGreenAt?.(context.runtime.runtimeId);
    const superseded = await this.isSuperseded(context);

    const receipt: ValidationReceipt = {
      receiptId,
      jobId: context.job.jobId,
      runtimeId: context.runtime.runtimeId,
      policyProfileRef: context.runtime.policyProfileRef,
      changesetRef: context.job.changesetRef,
      ...(mirror === null ? {} : { mirrorVersion: mirror.manifestVersion, mirrorFreshnessAt: mirror.syncedAt }),
      ...(context.material.request.fixtureManifestHash === undefined
        ? {}
        : { fixtureManifestHash: context.material.request.fixtureManifestHash }),
      licenseWaitMs: context.licenseWaitMs,
      ...(probesGreenAt === undefined ? {} : { probesGreenAt }),
      verdict,
      summary: truncate(summary, SUMMARY_MAX_CHARS),
      ...(hints.failingTest === undefined ? {} : { failingTest: hints.failingTest }),
      ...(hints.failingAssertion === undefined ? {} : { failingAssertion: hints.failingAssertion }),
      superseded,
      ...(superseded ? { supersededAt: now } : {}),
      createdAt: now
    };
    await this.options.store.insertReceipt(receipt);
    this.pending.delete(context.job.jobId);
    await this.transition(context.job.jobId, {
      state: verdict === "error" ? "failed" : "completed",
      receiptId,
      completedAt: now,
      queuePosition: null,
      ...(context.licenseWaitMs > 0 ? { licenseWaitMs: context.licenseWaitMs } : {})
    });
  }

  private async markAborted(context: RunContext): Promise<void> {
    this.pending.delete(context.job.jobId);
    await this.transition(context.job.jobId, {
      state: "aborted",
      completedAt: this.options.clock.isoNow(),
      queuePosition: null
    });
  }

  private async readMirror(): Promise<Awaited<ReturnType<typeof readMirrorStatus>>> {
    const root = this.options.mirrorRoot?.();
    if (root === undefined || root === "") return null;
    return readMirrorStatus(root);
  }

  /** D2: evidence whose working set moved on says so rather than overclaiming. */
  private async isSuperseded(context: RunContext): Promise<boolean> {
    try {
      const current = await this.options.changesetSource(context.material.request);
      if (current === null) return false;
      return current.changesetRef !== context.job.changesetRef;
    } catch (error) {
      this.options.logger.warn("supersession check failed", {
        jobId: context.job.jobId,
        error: errorMessage(error)
      });
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // State plumbing
  // -------------------------------------------------------------------------

  /** Every transition stamps `updatedAt`, re-reads the row, and publishes it. */
  private async transition(jobId: ValidationJobId, patch: Omit<ValidationJobPatch, "updatedAt">): Promise<ValidationJob> {
    await this.options.store.updateJobState(jobId, { ...patch, updatedAt: this.options.clock.isoNow() });
    const updated = await this.options.store.getJob(jobId);
    if (updated === null) {
      throw new Error(`Validation job "${jobId}" disappeared while it was being updated.`);
    }
    this.publish(updated);
    return updated;
  }

  /** Transition from a streaming callback: chained so writes stay ordered. */
  private queueTransition(jobId: ValidationJobId, patch: Omit<ValidationJobPatch, "updatedAt">): void {
    this.stateWrites = this.stateWrites
      .then(async () => {
        await this.transition(jobId, patch);
      })
      .catch((error: unknown) => {
        this.options.logger.warn("validation state write failed", { jobId, error: errorMessage(error) });
      });
  }

  private async park(jobId: ValidationJobId, reason: string): Promise<void> {
    await this.parkAndRead(jobId, reason);
  }

  private async parkAndRead(jobId: ValidationJobId, reason: string): Promise<ValidationJob> {
    const parked = await this.transition(jobId, { state: "parked", parkedReason: reason, queuePosition: null });
    this.options.logger.info("validation job parked", { jobId, reason });
    return parked;
  }

  private publish(job: ValidationJob): void {
    this.options.bus?.publish({
      kind: "validation-job-changed",
      jobId: job.jobId,
      state: job.state,
      sessionId: job.sessionId,
      ...(job.taskId === undefined ? {} : { taskId: job.taskId }),
      ...(job.subtaskId === undefined ? {} : { subtaskId: job.subtaskId })
    });
  }
}

// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

interface JobMaterial {
  readonly request: ValidationJobRequest;
  readonly changeset: ValidationChangeset;
}

interface InFlightJob {
  readonly controller: AbortController;
  promise: Promise<void>;
  /** Distinguishes a user abort from a watchdog abort on the same signal. */
  abortedByUser: boolean;
}

interface RunContext {
  readonly job: ValidationJob;
  readonly runtime: NamedRuntimeConfig;
  readonly adapter: ValidationExecAdapter;
  readonly material: JobMaterial;
  readonly entry: InFlightJob;
  licenseWaitMs: number;
}

type RouteOutcome =
  | { readonly kind: "resolved"; readonly runtime: NamedRuntimeConfig; readonly runtimes: readonly NamedRuntimeConfig[] }
  | { readonly kind: "park"; readonly detail: string };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The H8 capability gate, run at QUEUE time. Returns the park sentence when the
 * profile needs something the resolved runtime does not declare, naming the
 * registry runtimes that DO have it - "route to cpp-builds?" is the whole point
 * of having a routing layer.
 */
export function capabilityGap(
  profile: ValidationProfile,
  runtime: NamedRuntimeConfig,
  registry: readonly NamedRuntimeConfig[]
): string | undefined {
  const required = profile.requiredCapabilities ?? [];
  if (required.length === 0) return undefined;
  const have = new Set(runtime.capabilities);
  const missing = required.filter((capability) => !have.has(capability));
  if (missing.length === 0) return undefined;

  const alternatives = registry
    .filter((candidate) =>
      candidate.runtimeId !== runtime.runtimeId
      && candidate.archived !== true
      && missing.every((capability) => candidate.capabilities.includes(capability)))
    .map((candidate) => `"${candidate.displayName}"`);
  const need = `${profile.profileRef} needs ${joinWords(missing)}, which "${runtime.displayName}" does not have.`;
  return alternatives.length === 0
    ? `${need} No other runtime in the registry has ${missing.length === 1 ? "it" : "them"} either - add ${missing.length === 1 ? "it" : "them"} to a runtime's capabilities, then run validation again.`
    : `${need} Route this job to ${joinWords(alternatives)}?`;
}

/** Pytest/unittest failure hints for the one promoted L1 line (ux-flows F2). */
export interface ValidationFailureHint {
  readonly failingTest?: string;
  readonly failingAssertion?: string;
}

/**
 * Best-effort failure extraction from the output tail. Deliberately small: two
 * shapes (pytest short summary, unittest result header) cover the studio's
 * suites, and anything unrecognised leaves the fields ABSENT rather than
 * guessing - an invented failing test is worse than none.
 */
export function parseValidationFailure(output: string): ValidationFailureHint {
  const pytest = /^FAILED\s+(\S+)(?:\s+-\s+(.*))?$/m.exec(output);
  if (pytest?.[1] !== undefined) {
    const assertion = pytest[2]?.trim();
    return {
      failingTest: pytest[1],
      ...(assertion === undefined || assertion === "" ? {} : { failingAssertion: assertion })
    };
  }
  const unittest = /^(?:FAIL|ERROR):\s+(\S+)\s+\(([^)]+)\)/m.exec(output);
  if (unittest?.[1] !== undefined) {
    const context = unittest[2] ?? "";
    const failingTest = context === "" ? unittest[1] : `${context}.${unittest[1]}`;
    const assertion = /^([A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception|Failure)):[ \t]*(.*)$/m.exec(output);
    return {
      failingTest,
      ...(assertion === null ? {} : { failingAssertion: `${assertion[1] ?? ""}: ${(assertion[2] ?? "").trim()}`.trim() })
    };
  }
  return {};
}

/** Pytest/unittest one-line tallies (`3 failed, 11 passed in 2.10s`). */
export function summarizeRun(output: string): string | undefined {
  const banners = [...output.matchAll(/^=+\s*(.*?(?:failed|passed|error|no tests ran).*?)\s*=+$/gim)];
  const last = banners[banners.length - 1]?.[1]?.trim();
  if (last !== undefined && last !== "") return last;
  const unittest = /^(OK|FAILED)\s*(\([^)]*\))?\s*$/m.exec(output);
  if (unittest !== null) return `${unittest[1] === "OK" ? "OK" : "FAILED"}${unittest[2] === undefined ? "" : ` ${unittest[2]}`}`;
  return undefined;
}

/** Compiles license-wait patterns; a bad regex is logged, never fatal. */
function compileLicensePatterns(extra: readonly string[] | undefined, logger: Logger): RegExp[] {
  const compiled: RegExp[] = [];
  for (const source of [...DEFAULT_LICENSE_WAIT_PATTERNS, ...(extra ?? [])]) {
    try {
      compiled.push(new RegExp(source, "i"));
    } catch (error) {
      logger.warn("license-wait pattern ignored", { source, error: errorMessage(error) });
    }
  }
  return compiled;
}

function assertRunnableProfile(profile: ValidationProfile): void {
  if (profile.profileRef.trim() === "") {
    throw new Error("A validation profile needs a profileRef so its evidence can be attributed.");
  }
  if (profile.argv.length === 0 || (profile.argv[0] ?? "").trim() === "") {
    throw new Error(`Validation profile "${profile.profileRef}" declares no command to run.`);
  }
}

/** Reads the guest sync reply; unparseable output falls back to the raw tail. */
function parseSyncFailure(result: CommandResult): string {
  const trimmed = result.stdout.trim();
  if (trimmed !== "") {
    try {
      const parsed = JSON.parse(trimmed) as { readonly failures?: unknown };
      // PowerShell's ConvertTo-Json collapses one-element arrays on some hosts,
      // so accept either shape rather than losing the reason to a type error.
      const raw = parsed.failures;
      const failures = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]) as readonly {
        repoName?: string;
        detail?: string;
      }[];
      const rendered = failures
        .map((failure) => {
          const repo = failure.repoName === undefined || failure.repoName === "" ? "the changeset" : failure.repoName;
          return `${repo}: ${truncate((failure.detail ?? "").trim(), 400)}`;
        })
        .filter((line) => line.trim() !== "");
      if (rendered.length > 0) return rendered.join("; ");
    } catch {
      // Fall through to the raw tail below.
    }
  }
  const raw = `${result.stderr.trim()} ${trimmed}`.trim();
  return truncate(raw === "" ? `the guest exited with code ${String(result.exitCode ?? -1)}` : raw, 400);
}

/**
 * Host-side fixture-path gate, mirroring the guest script's own check. Relative,
 * forward-slashed, no traversal, no drive letters: a manifest is data, and data
 * never chooses where the product writes.
 */
function isSafeFixturePath(relativePath: string): boolean {
  if (relativePath.length === 0 || relativePath.length > 400) return false;
  if (relativePath.includes("\\") || relativePath.includes(":")) return false;
  if (relativePath.startsWith("/")) return false;
  const segments = relativePath.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== ".."
    // Control bytes and Windows-illegal characters: a fixture name is a
    // file name, not an opportunity to express a stream or a wildcard.
    && !/[\u0000-\u001f<>"|?*]/.test(segment));
}

/** Reads the fixture script's reply; unparseable output falls back to the tail. */
function parseFixtureFailure(result: CommandResult): string {
  const trimmed = result.stdout.trim();
  if (trimmed !== "") {
    try {
      const parsed = JSON.parse(trimmed) as { readonly failures?: unknown };
      const raw = parsed.failures;
      const failures = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]) as readonly {
        relativePath?: string;
        detail?: string;
      }[];
      const rendered = failures
        .map((failure) => `${failure.relativePath ?? "a fixture"}: ${truncate((failure.detail ?? "").trim(), 200)}`)
        .filter((line) => line.trim() !== "");
      if (rendered.length > 0) return rendered.join("; ");
    } catch {
      // Fall through to the raw tail below.
    }
  }
  const raw = `${result.stderr.trim()} ${trimmed}`.trim();
  return truncate(raw === "" ? `the guest exited with code ${String(result.exitCode ?? -1)}` : raw, 400);
}

function joinWords(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0] ?? ""} or ${values[1] ?? ""}`;
  return `${values.slice(0, -1).join(", ")}, or ${values[values.length - 1] ?? ""}`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}\u2026`;
}

function formatSeconds(ms: number): string {
  return `${String(Math.round(ms / 1000))} s`;
}

function formatMinutes(ms: number): string {
  const minutes = ms / 60_000;
  return minutes >= 1 ? `${String(Math.round(minutes))}-minute` : `${String(Math.round(ms / 1000))}-second`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SYSTEM_TIMERS: ValidationTimers = {
  set(handler: () => void, ms: number): unknown {
    const token = setTimeout(handler, ms);
    if (typeof token === "object" && token !== null && "unref" in token) {
      (token as { unref(): void }).unref();
    }
    return token;
  },
  clear(token: unknown): void {
    clearTimeout(token as ReturnType<typeof setTimeout>);
  }
};

const DEFAULT_IDS: ValidationJobIdGenerator = {
  validationJobId: () => asId<"ValidationJobId">(`vjob-${shortId()}`),
  validationReceiptId: () => asId<"ValidationReceiptId">(`vreceipt-${shortId()}`)
};

function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}
