/**
 * Live-fire validation exec against REAL locally-installed DCCs (opt-in).
 *
 * The M1 spike is blocked on studio hardware, but everything below the
 * hypervisor is measurable on any Windows machine with a DCC installed: these
 * tests run the REAL `ValidationJobService` pipeline (cleanup → sync via
 * `git apply` → run → receipt) with a `ValidationExecAdapter` whose exec spawns
 * the guest PowerShell wrappers LOCALLY instead of through `ssh.exe`. Same
 * fixed-literal scripts, same stdin-JSON parameter path, same watchdogs — the
 * only fake is the transport, which is exactly the seam the adapter reserves.
 *
 * Opt-in because a real hython/blender boot costs seconds-to-minutes and CI has
 * no DCCs: set `DRYDOCK_DCC_ITEST=1` to enable. Discovery prefers
 * `DRYDOCK_BLENDER_PATH` / `DRYDOCK_HYTHON_PATH`, then the newest install under
 * the vendors' default Program Files locations. Round-trip timings print as
 * `[dcc-timing]` lines — the local baseline the M1 round-trip ratio compares
 * against.
 */

import { strict as assert } from "node:assert";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { asId } from "@drydock/contracts";
import type {
  NamedRuntimeConfig,
  RuntimeAssociation,
  ValidationJob,
  ValidationJobFilter,
  ValidationJobId,
  ValidationJobPatch,
  ValidationJobRequest,
  ValidationProfile,
  ValidationQuarantineRecord,
  ValidationReceipt,
  ValidationReceiptId,
  ValidationRegistrySettings,
  ValidationRegistrySettingsUpdate,
  ValidationRuntimeId,
  ValidationRuntimeStore,
  TaskId,
  WorkspaceRootId
} from "@drydock/contracts";
import {
  MemoryLogger,
  ProductEventBus,
  SpawnCommandRunner,
  ValidationJobService,
  VALIDATION_CLEANUP_GUEST_SCRIPT,
  VALIDATION_RUN_GUEST_SCRIPT,
  VALIDATION_SYNC_GUEST_SCRIPT,
  VALIDATION_TAG_COMMENT,
  type ValidationChangeset,
  type ValidationExecAdapter,
  type ValidationJobExec
} from "@drydock/core";
import { guestJsonCommand, SWEEP_GUEST_JOB_SCRIPT } from "./hyperVRuntimeAdapter.js";

// ---------------------------------------------------------------------------
// Opt-in gate + DCC discovery
// ---------------------------------------------------------------------------

const ENABLED = process.env["DRYDOCK_DCC_ITEST"] === "1";
const DISABLED_REASON = "set DRYDOCK_DCC_ITEST=1 to run real-DCC validation exec tests";

/** Newest matching install, e.g. "Blender 5.2" beats "Blender 4.4". */
function newestInstall(baseDir: string, dirPattern: RegExp, relativeExe: string): string | null {
  let names: string[];
  try {
    names = readdirSync(baseDir);
  } catch {
    return null;
  }
  const candidates = names
    .filter((name) => dirPattern.test(name))
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  for (const name of candidates) {
    const exe = join(baseDir, name, relativeExe);
    if (existsSync(exe)) return exe;
  }
  return null;
}

function discoverBlender(): string | null {
  const override = process.env["DRYDOCK_BLENDER_PATH"]?.trim();
  if (override !== undefined && override !== "" && existsSync(override)) return override;
  return newestInstall("C:\\Program Files\\Blender Foundation", /^Blender \d/, "blender.exe");
}

function discoverHython(): string | null {
  const override = process.env["DRYDOCK_HYTHON_PATH"]?.trim();
  if (override !== undefined && override !== "" && existsSync(override)) return override;
  return newestInstall(
    "C:\\Program Files\\Side Effects Software",
    /^Houdini \d/,
    "bin\\hython.exe"
  );
}

const BLENDER = ENABLED ? discoverBlender() : null;
const HYTHON = ENABLED ? discoverHython() : null;

function skipUnless(exe: string | null, label: string): string | false {
  if (!ENABLED) return DISABLED_REASON;
  if (exe === null) return `no ${label} install found`;
  return false;
}

// ---------------------------------------------------------------------------
// Local transport: the real guest wrappers, spawned on this host
// ---------------------------------------------------------------------------

class LocalExecAdapter implements ValidationExecAdapter {
  readonly kinds: string[] = [];
  readonly sweeps: string[] = [];
  readonly sweptPids: number[] = [];
  private readonly runner = new SpawnCommandRunner();

  constructor(private readonly hostCwd: string) {}

  async ensureRunning(): Promise<void> {}

  exec: ValidationJobExec = async (args, timeoutMs, input, signal, onStdoutLine) => {
    const script = args[4] ?? "";
    if (script === VALIDATION_CLEANUP_GUEST_SCRIPT) this.kinds.push("cleanup");
    else if (script === VALIDATION_SYNC_GUEST_SCRIPT) this.kinds.push("sync");
    else if (script === `${VALIDATION_RUN_GUEST_SCRIPT}\n${VALIDATION_TAG_COMMENT}`) this.kinds.push("run");
    return this.runner.run(args[0] ?? "", args.slice(1), {
      cwd: this.hostCwd,
      timeoutMs,
      ...(input === undefined ? {} : { input }),
      ...(signal === undefined ? {} : { signal }),
      ...(onStdoutLine === undefined ? {} : { onStdoutLine })
    });
  };

  /** The adapter's own guest sweep script, run locally instead of over ssh. */
  async sweepGuestJob(jobToken: string, timeoutMs: number, signal?: AbortSignal): Promise<number[]> {
    this.sweeps.push(jobToken);
    const result = await this.exec(
      guestJsonCommand(SWEEP_GUEST_JOB_SCRIPT),
      timeoutMs,
      JSON.stringify({ jobToken }),
      signal
    );
    if (result.exitCode !== 0) {
      throw new Error(`local sweep failed (${String(result.exitCode)}): ${result.stderr || result.error || ""}`);
    }
    const parsed = JSON.parse(result.stdout.trim()) as { killed?: unknown };
    const killed = Array.isArray(parsed.killed)
      ? parsed.killed.filter((pid): pid is number => typeof pid === "number")
      : [];
    this.sweptPids.push(...killed);
    return killed;
  }
}

// ---------------------------------------------------------------------------
// Minimal in-memory store (the job service's storage port, verbatim semantics)
// ---------------------------------------------------------------------------

class MemoryValidationStore implements ValidationRuntimeStore {
  readonly runtimes: NamedRuntimeConfig[] = [];
  readonly associations: RuntimeAssociation[] = [];
  readonly jobs: ValidationJob[] = [];
  readonly receipts: ValidationReceipt[] = [];
  settings: ValidationRegistrySettings = { topologyPreset: "single" };
  readonly taskOverrides = new Map<string, ValidationRuntimeId>();
  readonly quarantines = new Map<string, ValidationQuarantineRecord>();

  async listRuntimes(includeArchived = false): Promise<NamedRuntimeConfig[]> {
    return this.runtimes.filter((runtime) => includeArchived || runtime.archived !== true);
  }

  async getRuntime(runtimeId: ValidationRuntimeId): Promise<NamedRuntimeConfig | null> {
    return this.runtimes.find((runtime) => runtime.runtimeId === runtimeId) ?? null;
  }

  async insertRuntime(record: NamedRuntimeConfig): Promise<void> {
    this.runtimes.push(record);
  }

  async updateRuntime(): Promise<void> {
    throw new Error("not used");
  }

  async archiveRuntime(): Promise<void> {
    throw new Error("not used");
  }

  async listAssociations(): Promise<RuntimeAssociation[]> {
    return [...this.associations];
  }

  async getAssociations(projectRootId: WorkspaceRootId): Promise<RuntimeAssociation[]> {
    return this.associations.filter((row) => row.projectRootId === projectRootId);
  }

  async upsertAssociation(record: RuntimeAssociation): Promise<void> {
    this.associations.push(record);
  }

  async deleteAssociation(): Promise<void> {
    throw new Error("not used");
  }

  async getSettings(): Promise<ValidationRegistrySettings> {
    return this.settings;
  }

  async setSettings(update: ValidationRegistrySettingsUpdate): Promise<void> {
    this.settings = { ...this.settings, ...update } as ValidationRegistrySettings;
  }

  async getTaskOverride(taskId: TaskId): Promise<ValidationRuntimeId | null> {
    return this.taskOverrides.get(String(taskId)) ?? null;
  }

  async setTaskOverride(taskId: TaskId, runtimeId: ValidationRuntimeId | null): Promise<void> {
    if (runtimeId === null) this.taskOverrides.delete(String(taskId));
    else this.taskOverrides.set(String(taskId), runtimeId);
  }

  async getQuarantine(runtimeId: ValidationRuntimeId): Promise<ValidationQuarantineRecord | null> {
    return this.quarantines.get(String(runtimeId)) ?? null;
  }

  async setQuarantine(runtimeId: ValidationRuntimeId, payload: ValidationQuarantineRecord | null): Promise<void> {
    if (payload === null) this.quarantines.delete(String(runtimeId));
    else this.quarantines.set(String(runtimeId), payload);
  }

  async insertJob(record: ValidationJob): Promise<void> {
    this.jobs.push(record);
  }

  async getJob(jobId: ValidationJobId): Promise<ValidationJob | null> {
    return this.jobs.find((job) => job.jobId === jobId) ?? null;
  }

  async updateJobState(jobId: ValidationJobId, patch: ValidationJobPatch): Promise<void> {
    const index = this.jobs.findIndex((job) => job.jobId === jobId);
    if (index < 0) throw new Error(`no such job ${jobId}`);
    const current = { ...this.jobs[index] } as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete current[key];
      else if (value !== undefined) current[key] = value;
    }
    this.jobs[index] = current as unknown as ValidationJob;
  }

  async listJobs(filter?: ValidationJobFilter): Promise<ValidationJob[]> {
    return this.jobs.filter((job) => {
      if (filter?.taskId !== undefined && job.taskId !== filter.taskId) return false;
      if (filter?.sessionId !== undefined && job.sessionId !== filter.sessionId) return false;
      if (filter?.states !== undefined && !filter.states.includes(job.state)) return false;
      return true;
    });
  }

  async listQueuedJobs(): Promise<ValidationJob[]> {
    return this.jobs.filter((job) => job.state === "queued");
  }

  async insertReceipt(record: ValidationReceipt): Promise<void> {
    this.receipts.push(record);
  }

  async getReceipt(receiptId: ValidationReceiptId): Promise<ValidationReceipt | null> {
    return this.receipts.find((receipt) => receipt.receiptId === receiptId) ?? null;
  }

  async getReceiptByJob(jobId: ValidationJobId): Promise<ValidationReceipt | null> {
    return this.receipts.find((receipt) => receipt.jobId === jobId) ?? null;
  }

  async markReceiptSuperseded(): Promise<void> {
    throw new Error("not used");
  }

  async listReceiptsByTask(): Promise<ValidationReceipt[]> {
    return [...this.receipts];
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const RUN_STAMP = Date.now().toString(36);
let jobCounter = 0;

interface LocalHarness {
  readonly service: ValidationJobService;
  readonly store: MemoryValidationStore;
  readonly adapter: LocalExecAdapter;
  readonly states: string[];
  readonly jobRoot: string;
  dispose(): Promise<void>;
}

async function localHarness(input: {
  changeset: ValidationChangeset;
  inactivityTimeoutMs?: number;
  startupTimeoutMs?: number;
}): Promise<LocalHarness> {
  const jobRoot = await mkdtemp(join(tmpdir(), "drydock-dcc-"));
  const store = new MemoryValidationStore();
  store.runtimes.push({
    runtimeId: asId<"ValidationRuntimeId">("local-dcc"),
    displayName: "local-dcc",
    image: "host-local",
    lifecycle: "keep-warm",
    capabilities: ["blender", "houdini"],
    policyProfileRef: "validation_default",
    connection: { host: "127.0.0.1", user: "local" },
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z"
  });
  store.settings = {
    topologyPreset: "single",
    defaultRuntimeId: asId<"ValidationRuntimeId">("local-dcc")
  };

  const adapter = new LocalExecAdapter(jobRoot);
  const bus = new ProductEventBus();
  const states: string[] = [];
  bus.subscribe((event) => {
    if (event.kind === "validation-job-changed") states.push(event.state);
  });

  const service = new ValidationJobService({
    store,
    clock: { isoNow: () => new Date().toISOString() },
    logger: new MemoryLogger(),
    bus,
    runtimeAvailability: async () => "available",
    adapterFor: () => adapter,
    changesetSource: async () => input.changeset,
    guestJobRoot: jobRoot,
    ...(input.inactivityTimeoutMs === undefined ? {} : { inactivityTimeoutMs: input.inactivityTimeoutMs }),
    ...(input.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: input.startupTimeoutMs }),
    ids: {
      validationJobId: () => {
        jobCounter += 1;
        return asId<"ValidationJobId">(`vjob-${RUN_STAMP}-${String(jobCounter)}`);
      },
      validationReceiptId: () => {
        jobCounter += 1;
        return asId<"ValidationReceiptId">(`vreceipt-${RUN_STAMP}-${String(jobCounter)}`);
      }
    }
  });

  return {
    service,
    store,
    adapter,
    states,
    jobRoot,
    dispose: async () => {
      await rm(jobRoot, { recursive: true, force: true });
    }
  };
}

function request(profile: ValidationProfile): ValidationJobRequest {
  return {
    sessionId: asId<"SessionId">("session-dcc"),
    chatId: asId<"ChatId">("chat-dcc"),
    taskId: asId<"TaskId">("task-dcc"),
    profile
  };
}

/** A new-file unified diff `git apply` accepts in a freshly-init'd repo. */
function newFilePatch(fileName: string, lines: readonly string[]): string {
  return [
    `diff --git a/${fileName} b/${fileName}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${fileName}`,
    `@@ -0,0 +1,${String(lines.length)} @@`,
    ...lines.map((line) => `+${line}`),
    ""
  ].join("\n");
}

function changesetOf(ref: string, fileName: string, lines: readonly string[]): ValidationChangeset {
  return { changesetRef: ref, patches: [{ repoName: "pipeline", patch: newFilePatch(fileName, lines) }] };
}

async function runToCompletion(bench: LocalHarness, profile: ValidationProfile): Promise<{
  job: ValidationJob;
  receipt: ValidationReceipt | null;
  roundTripMs: number;
}> {
  const started = Date.now();
  const queued = await bench.service.enqueue(request(profile));
  assert.ok(queued, "the changeset must produce a job");
  await bench.service.whenIdle();
  const roundTripMs = Date.now() - started;
  const job = await bench.store.getJob(queued.jobId);
  assert.ok(job, "job row must survive the run");
  const receipt = await bench.store.getReceiptByJob(queued.jobId);
  return { job, receipt, roundTripMs };
}

/** PIDs of live processes whose command line carries `marker` (never this one). */
async function livePidsByCommandLine(marker: string): Promise<number[]> {
  const runner = new SpawnCommandRunner();
  const script = [
    "$marker = [Console]::In.ReadToEnd().Trim()",
    "$hits = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like ('*' + $marker + '*') -and $_.ProcessId -ne $PID })",
    "ConvertTo-Json -Compress -InputObject @{ pids = @($hits | ForEach-Object { [int]$_.ProcessId }) }"
  ].join("\n");
  const result = await runner.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    cwd: tmpdir(),
    timeoutMs: 30_000,
    input: marker
  });
  if (result.exitCode !== 0) return [];
  try {
    const parsed = JSON.parse(result.stdout.trim()) as { pids?: unknown };
    return Array.isArray(parsed.pids) ? parsed.pids.filter((pid): pid is number => typeof pid === "number") : [];
  } catch {
    return [];
  }
}

async function stopPids(pids: readonly number[]): Promise<void> {
  if (pids.length === 0) return;
  const runner = new SpawnCommandRunner();
  const script = [
    "$request = [Console]::In.ReadToEnd() | ConvertFrom-Json",
    "foreach ($pid_ in @($request.pids)) { try { Stop-Process -Id ([int]$pid_) -Force -ErrorAction Stop } catch { } }",
    "ConvertTo-Json -Compress -InputObject @{ ok = $true }"
  ].join("\n");
  await runner.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    cwd: tmpdir(),
    timeoutMs: 30_000,
    input: JSON.stringify({ pids })
  });
}

// ---------------------------------------------------------------------------
// Blender (license-free) — pass, fail, license-wait pause, stall + sweep
// ---------------------------------------------------------------------------

test("blender: a real headless run lands a passing receipt and writes the job out dir", {
  skip: skipUnless(BLENDER, "Blender"),
  timeout: 300_000
}, async () => {
  const bench = await localHarness({
    changeset: changesetOf(`sha-blender-pass-${RUN_STAMP}`, "mesh_check.py", [
      "import bpy",
      "import os",
      "bpy.ops.mesh.primitive_cube_add(size=2.0)",
      "obj = bpy.context.active_object",
      "count = len(obj.data.vertices)",
      'print("drydock-dcc: cube has %d vertices" % count, flush=True)',
      'out_path = os.path.join(os.environ["DRYDOCK_OUTPUT_ROOT"], "blender-pass.txt")',
      'with open(out_path, "w", encoding="utf8") as handle:',
      '    handle.write("verts=%d\\n" % count)',
      "assert count == 8",
      'print("drydock-dcc: PASS", flush=True)'
    ])
  });
  try {
    const { job, receipt, roundTripMs } = await runToCompletion(bench, {
      profileRef: "blender_mesh_smoke",
      argv: [BLENDER ?? "", "--background", "--factory-startup", "--python-exit-code", "1", "--python", "mesh_check.py"]
    });

    console.log(`[dcc-timing] blender pass round trip: ${String(roundTripMs)} ms`);
    assert.equal(job.state, "completed");
    assert.equal(receipt?.verdict, "passed");
    assert.equal(receipt?.changesetRef, `sha-blender-pass-${RUN_STAMP}`);
    assert.equal(receipt?.superseded, false);
    assert.equal(receipt?.licenseWaitMs, 0);
    assert.deepEqual(bench.adapter.kinds, ["cleanup", "sync", "run"]);
    assert.equal(bench.adapter.sweeps.length, 0, "a clean pass must not sweep");
    assert.deepEqual(bench.states, ["queued", "starting", "syncing", "running", "completed"]);

    // The guest env pointed DRYDOCK_OUTPUT_ROOT at the job's out dir for real.
    const outFile = join(bench.jobRoot, job.jobId, "out", "blender-pass.txt");
    assert.equal((await readFile(outFile, "utf8")).trim(), "verts=8");
  } finally {
    await bench.dispose();
  }
});

test("blender: a failing assertion lands a failed receipt, not an error", {
  skip: skipUnless(BLENDER, "Blender"),
  timeout: 300_000
}, async () => {
  const bench = await localHarness({
    changeset: changesetOf(`sha-blender-fail-${RUN_STAMP}`, "mesh_check.py", [
      "import bpy",
      'print("drydock-dcc: checking topology", flush=True)',
      "count = 9",
      'assert count == 8, "expected 8 vertices, saw 9"'
    ])
  });
  try {
    const { job, receipt } = await runToCompletion(bench, {
      profileRef: "blender_mesh_smoke",
      argv: [BLENDER ?? "", "--background", "--factory-startup", "--python-exit-code", "1", "--python", "mesh_check.py"]
    });
    assert.equal(job.state, "completed", "a red test is a completed job with a failed receipt");
    assert.equal(receipt?.verdict, "failed");
  } finally {
    await bench.dispose();
  }
});

test("blender: a license-wait line pauses the inactivity watchdog for real (E4)", {
  skip: skipUnless(BLENDER, "Blender"),
  timeout: 300_000
}, async () => {
  const bench = await localHarness({
    // Inactivity far below the scripted 6 s silence: only the license-wait
    // pause can carry this run to green.
    inactivityTimeoutMs: 4_000,
    changeset: changesetOf(`sha-blender-license-${RUN_STAMP}`, "license_probe.py", [
      "import time",
      'print("drydock-dcc: waiting for license server queue", flush=True)',
      "time.sleep(6)",
      'print("drydock-dcc: license checkout complete", flush=True)',
      'print("drydock-dcc: PASS", flush=True)'
    ])
  });
  try {
    const { job, receipt } = await runToCompletion(bench, {
      profileRef: "blender_license_probe",
      argv: [BLENDER ?? "", "--background", "--factory-startup", "--python-exit-code", "1", "--python", "license_probe.py"]
    });
    assert.equal(job.state, "completed");
    assert.equal(receipt?.verdict, "passed");
    assert.ok(bench.states.includes("license-wait"), "the wait must surface as job state");
    assert.ok(
      (receipt?.licenseWaitMs ?? 0) >= 4_000,
      `licenseWaitMs must cover the scripted wait; saw ${String(receipt?.licenseWaitMs)}`
    );
  } finally {
    await bench.dispose();
  }
});

test("blender: a hung DCC trips the stall watchdog; the guest sweep reaps what it can see", {
  skip: skipUnless(BLENDER, "Blender"),
  timeout: 300_000
}, async () => {
  const marker = `stall_scene_${RUN_STAMP}.py`;
  const bench = await localHarness({
    inactivityTimeoutMs: 4_000,
    startupTimeoutMs: 120_000,
    changeset: changesetOf(`sha-blender-stall-${RUN_STAMP}`, marker, [
      "import time",
      'print("drydock-dcc: started", flush=True)',
      "time.sleep(600)"
    ])
  });
  try {
    const { job, receipt } = await runToCompletion(bench, {
      profileRef: "blender_stall_probe",
      argv: [BLENDER ?? "", "--background", "--factory-startup", "--python-exit-code", "1", "--python", marker]
    });

    assert.equal(job.state, "failed", "infrastructure trouble is not a test result");
    assert.equal(receipt?.verdict, "error");
    assert.match(receipt?.summary ?? "", /No output for/);
    assert.equal(bench.adapter.sweeps.length, 1, "a stall must sweep the guest job");

    // Ground truth for the M1 runbook: locally, aborting the exec kills the
    // token-carrying wrapper BEFORE the sweep runs, so the token-anchored
    // parent walk may find nothing and the DCC child survives as an orphan.
    // Over ssh the wrapper's fate depends on sshd's channel-close behavior —
    // this line records what actually happened on this transport.
    const survivors = await livePidsByCommandLine(marker);
    console.log(
      `[dcc-sweep] token sweep killed ${String(bench.adapter.sweptPids.length)} pid(s); ` +
      `${String(survivors.length)} orphaned DCC process(es) survived the sweep`
    );
    await stopPids(survivors);
    const afterCleanup = await livePidsByCommandLine(marker);
    assert.equal(afterCleanup.length, 0, "no stall process may outlive the test");
  } finally {
    await bench.dispose();
  }
});

// ---------------------------------------------------------------------------
// Houdini (hython) — the studio-named interpreter, cold and warm
// ---------------------------------------------------------------------------

test("hython: real node-graph validation passes cold and warm through the same queue", {
  skip: skipUnless(HYTHON, "Houdini/hython"),
  timeout: 600_000
}, async () => {
  const bench = await localHarness({
    changeset: changesetOf(`sha-hython-pass-${RUN_STAMP}`, "validate_hou.py", [
      "import hou",
      'geo = hou.node("/obj").createNode("geo", node_name="drydock_probe")',
      'box = geo.createNode("box")',
      'box.parm("scale").set(2.5)',
      "bbox = box.geometry().boundingBox()",
      "size = bbox.sizevec()",
      'print("drydock-dcc: box bbox size %.3f" % size[0], flush=True)',
      'assert abs(size[0] - 2.5) < 1e-3, "bbox %s != 2.5" % size[0]',
      'print("drydock-dcc: houdini %s license %s" % (hou.applicationVersionString(), hou.licenseCategory().name()), flush=True)',
      'print("drydock-dcc: PASS", flush=True)'
    ])
  });
  const profile: ValidationProfile = {
    profileRef: "hython_node_smoke",
    argv: [HYTHON ?? "", "validate_hou.py"],
    // The stray user-site NumPy on this machine must not leak into hython, and
    // the job pipeline is exactly where per-job env hygiene belongs.
    env: { PYTHONNOUSERSITE: "1", PYTHONPATH: "." }
  };
  try {
    const cold = await runToCompletion(bench, profile);
    console.log(`[dcc-timing] hython cold round trip: ${String(cold.roundTripMs)} ms`);
    assert.equal(cold.job.state, "completed");
    assert.equal(cold.receipt?.verdict, "passed", `summary: ${cold.receipt?.summary ?? "<none>"}`);
    assert.equal(cold.receipt?.changesetRef, `sha-hython-pass-${RUN_STAMP}`);

    const warm = await runToCompletion(bench, profile);
    console.log(`[dcc-timing] hython warm round trip: ${String(warm.roundTripMs)} ms`);
    assert.equal(warm.receipt?.verdict, "passed");

    assert.deepEqual(
      bench.adapter.kinds,
      ["cleanup", "sync", "run", "cleanup", "sync", "run"],
      "two jobs serialized through one runtime queue"
    );
    assert.equal(bench.adapter.sweeps.length, 0);
  } finally {
    await bench.dispose();
  }
});
