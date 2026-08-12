/**
 * Validation job service tests (ADR 0022 M4).
 *
 * Everything runs against fakes - an in-memory store, a scripted exec adapter, a
 * counting clock, and manual timers - because the behaviors that matter here are
 * ORDERING and HONESTY rules, not guest mechanics: per-runtime serialization,
 * park-never-degrade routing (H1/H8), the Windows patch boundary (D3), license
 * waits that are not hangs (E4), stall/cap watchdogs, receipt assembly with
 * supersession (D2), abort, reroute confirmation (H1/H2), and restart recovery
 * (E7).
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { asId } from "@drydock/contracts";
import type {
  CommandResult,
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
import { ProductEventBus } from "./eventBus.js";
import { MemoryLogger } from "./logger.js";
import {
  parseValidationFailure,
  summarizeRun,
  ValidationJobService,
  VALIDATION_CLEANUP_GUEST_SCRIPT,
  VALIDATION_FIXTURE_GUEST_SCRIPT,
  VALIDATION_RUN_GUEST_SCRIPT,
  VALIDATION_SYNC_GUEST_SCRIPT,
  validationGuestCommand,
  type ValidationChangeset,
  type ValidationExecAdapter,
  type ValidationJobServiceOptions,
  type ValidationTimers
} from "./validationJobService.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class MemoryValidationStore implements ValidationRuntimeStore {
  readonly runtimes: NamedRuntimeConfig[] = [];
  readonly associations: RuntimeAssociation[] = [];
  readonly jobs: ValidationJob[] = [];
  readonly receipts: ValidationReceipt[] = [];
  settings: ValidationRegistrySettings = { topologyPreset: "single" };

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

  // M7's KV additions: the job service never reads either, so the fake keeps
  // them as plain maps rather than pretending to durability it does not need.
  readonly taskOverrides = new Map<string, ValidationRuntimeId>();
  readonly quarantines = new Map<string, ValidationQuarantineRecord>();

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
    if (!this.jobs.some((job) => job.jobId === record.jobId)) {
      throw new Error("receipt inserted before its job row (FK)");
    }
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

interface RunHooks {
  emit(line: string): void;
  readonly signal?: AbortSignal | undefined;
}

interface AdapterScript {
  ensureRunning?: () => Promise<void>;
  sync?: (input: SyncInput) => Partial<CommandResult>;
  fixtures?: (input: FixtureInput) => Partial<CommandResult>;
  run?: (hooks: RunHooks) => Promise<Partial<CommandResult>>;
}

interface SyncInput {
  readonly jobRoot: string;
  readonly jobId: string;
  readonly patches: readonly { readonly repoName: string; readonly patchBase64: string }[];
}

interface RunInput {
  readonly env: Record<string, string>;
  readonly argv: readonly string[];
  readonly cwd: string;
}

interface FixtureInput {
  readonly jobRoot: string;
  readonly jobId: string;
  readonly fixtures: readonly { readonly relativePath: string; readonly contentBase64: string }[];
}

class FakeAdapter implements ValidationExecAdapter {
  readonly kinds: string[] = [];
  readonly swept: string[] = [];
  ensureRunningCalls = 0;
  syncInput: SyncInput | undefined;
  fixtureInput: FixtureInput | undefined;
  runInput: RunInput | undefined;
  runArgs: readonly string[] | undefined;
  cleanupInput: { jobRoot: string; keepJobId: string } | undefined;

  constructor(private readonly script: AdapterScript = {}) {}

  async ensureRunning(): Promise<void> {
    this.ensureRunningCalls += 1;
    await this.script.ensureRunning?.();
  }

  exec = async (
    args: readonly string[],
    timeoutMs: number,
    rawInput?: string,
    signal?: AbortSignal,
    onStdoutLine?: (line: string) => void
  ): Promise<CommandResult> => {
    const script = args[4] ?? "";
    const input = rawInput === undefined ? undefined : (JSON.parse(rawInput) as unknown);
    if (script === VALIDATION_CLEANUP_GUEST_SCRIPT) {
      this.kinds.push("cleanup");
      this.cleanupInput = input as { jobRoot: string; keepJobId: string };
      return commandResult({ stdout: '{"removed":[]}' });
    }
    if (script === VALIDATION_SYNC_GUEST_SCRIPT) {
      this.kinds.push("sync");
      this.syncInput = input as SyncInput;
      return commandResult(this.script.sync?.(this.syncInput) ?? { stdout: '{"ok":true,"applied":[],"failures":[]}' });
    }
    if (script === VALIDATION_FIXTURE_GUEST_SCRIPT) {
      this.kinds.push("fixtures");
      this.fixtureInput = input as FixtureInput;
      return commandResult(this.script.fixtures?.(this.fixtureInput) ?? { stdout: '{"ok":true,"written":[],"failures":[]}' });
    }
    if (script === VALIDATION_RUN_GUEST_SCRIPT) {
      this.kinds.push("run");
      this.runInput = input as RunInput;
      this.runArgs = args;
      assert.ok(timeoutMs > 0, "the run exec must carry the hard turn cap");
      const emit = (line: string): void => { onStdoutLine?.(line); };
      const hooks: RunHooks = { emit, signal };
      return commandResult(await (this.script.run?.(hooks) ?? Promise.resolve({ exitCode: 0 })));
    }
    this.kinds.push("other");
    return commandResult({});
  };

  async sweepGuestJob(jobToken: string): Promise<number[]> {
    this.swept.push(jobToken);
    return [4242];
  }
}

class FakeTimerBank implements ValidationTimers {
  private nextToken = 1;
  private readonly pending = new Map<number, { handler: () => void; ms: number }>();

  set(handler: () => void, ms: number): unknown {
    const token = this.nextToken;
    this.nextToken += 1;
    this.pending.set(token, { handler, ms });
    return token;
  }

  clear(token: unknown): void {
    this.pending.delete(token as number);
  }

  get armed(): number {
    return this.pending.size;
  }

  /** The budgets (ms) of every currently-armed timer, newest last. */
  get budgets(): number[] {
    return [...this.pending.values()].map((entry) => entry.ms);
  }

  fireAll(): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) entry.handler();
  }

  /** Fire only timers whose budget has elapsed by `elapsedMs` - as if that much
   * wall time passed with the others still counting down. */
  fireElapsed(elapsedMs: number): void {
    const due = [...this.pending.entries()].filter(([, entry]) => entry.ms <= elapsedMs);
    for (const [token] of due) this.pending.delete(token);
    for (const [, entry] of due) entry.handler();
  }
}

function commandResult(overrides: Partial<CommandResult>): CommandResult {
  return {
    command: "ssh.exe",
    args: [],
    cwd: "C:\\drydock",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 5,
    timedOut: false,
    ...overrides
  };
}

/** Yields to the event loop until `predicate` holds; the pipeline is detached. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Lets any pending pipeline work land, so "still only one" means something. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }
}

/** A promise with its resolver exposed - a controllable gate for interleaving. */
function deferred(): { readonly promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Resolves when the run is aborted - how a real exec ends on cancellation. */
async function untilAborted(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return;
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => { resolve(); }, { once: true });
  });
}

function runtimeConfig(input: {
  runtimeId: string;
  displayName?: string;
  capabilities?: readonly string[];
  policyProfileRef?: string;
  image?: string;
  profileException?: boolean;
  archived?: boolean;
}): NamedRuntimeConfig {
  return {
    runtimeId: asId<"ValidationRuntimeId">(input.runtimeId),
    displayName: input.displayName ?? input.runtimeId,
    image: input.image ?? "win11-dcc-2026.03",
    lifecycle: "keep-warm",
    capabilities: input.capabilities ?? ["maya", "houdini"],
    policyProfileRef: input.policyProfileRef ?? "validation_default",
    connection: { host: "10.10.0.4", user: "drydock" },
    ...(input.profileException === undefined ? {} : { profileException: input.profileException }),
    ...(input.archived === undefined ? {} : { archived: input.archived }),
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z"
  };
}

function profile(overrides: Partial<ValidationProfile> = {}): ValidationProfile {
  return {
    profileRef: "tool_smoke",
    argv: ["mayapy", "-m", "pytest", "tests"],
    ...overrides
  };
}

function request(overrides: Partial<ValidationJobRequest> = {}): ValidationJobRequest {
  return {
    sessionId: asId<"SessionId">("session-1"),
    chatId: asId<"ChatId">("chat-1"),
    taskId: asId<"TaskId">("task-1"),
    profile: profile(),
    ...overrides
  };
}

interface Harness {
  readonly service: ValidationJobService;
  readonly store: MemoryValidationStore;
  readonly adapters: Map<string, FakeAdapter>;
  readonly timers: FakeTimerBank;
  readonly logger: MemoryLogger;
  readonly states: string[];
  readonly changesetCalls: number[];
  advance(ms: number): void;
}

function harness(input: {
  runtimes?: readonly NamedRuntimeConfig[];
  defaultRuntimeId?: string;
  adapters?: Record<string, FakeAdapter>;
  adapterFor?: (runtime: NamedRuntimeConfig) => ValidationExecAdapter | null;
  changeset?: (call: number) => ValidationChangeset | null;
  store?: MemoryValidationStore;
  overrides?: Partial<ValidationJobServiceOptions>;
} = {}): Harness {
  const store = input.store ?? new MemoryValidationStore();
  for (const runtime of input.runtimes ?? [runtimeConfig({ runtimeId: "default" })]) {
    store.runtimes.push(runtime);
  }
  store.settings = {
    topologyPreset: "single",
    ...(input.defaultRuntimeId === undefined
      ? { defaultRuntimeId: asId<"ValidationRuntimeId">("default") }
      : input.defaultRuntimeId === ""
        ? {}
        : { defaultRuntimeId: asId<"ValidationRuntimeId">(input.defaultRuntimeId) })
  };

  const adapters = new Map<string, FakeAdapter>(Object.entries(input.adapters ?? { default: new FakeAdapter() }));
  const timers = new FakeTimerBank();
  const logger = new MemoryLogger();
  const bus = new ProductEventBus();
  const states: string[] = [];
  bus.subscribe((event) => {
    if (event.kind === "validation-job-changed") states.push(event.state);
  });

  let tick = 0;
  let monotonic = 0;
  const changesetCalls: number[] = [];
  let ids = 0;

  const service = new ValidationJobService({
    store,
    clock: {
      isoNow: () => {
        tick += 1;
        return new Date(Date.UTC(2026, 7, 12, 9, 0, tick)).toISOString();
      }
    },
    logger,
    bus,
    runtimeAvailability: async () => "available",
    adapterFor: input.adapterFor ?? ((runtime) => adapters.get(runtime.runtimeId) ?? null),
    changesetSource: async () => {
      changesetCalls.push(changesetCalls.length);
      const produced = input.changeset?.(changesetCalls.length - 1);
      if (input.changeset !== undefined) return produced ?? null;
      return { changesetRef: "sha-changeset-1", patches: [{ repoName: "pipeline", patch: PLAIN_PATCH }] };
    },
    timers,
    monotonicNow: () => monotonic,
    ids: {
      validationJobId: () => {
        ids += 1;
        return asId<"ValidationJobId">(`vjob-${String(ids)}`);
      },
      validationReceiptId: () => {
        ids += 1;
        return asId<"ValidationReceiptId">(`vreceipt-${String(ids)}`);
      }
    },
    ...input.overrides
  });

  return {
    service,
    store,
    adapters,
    timers,
    logger,
    states,
    changesetCalls,
    advance: (ms: number) => { monotonic += ms; }
  };
}

const PLAIN_PATCH = [
  "diff --git a/src/loader.py b/src/loader.py",
  "index 1111111..2222222 100644",
  "--- a/src/loader.py",
  "+++ b/src/loader.py",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  ""
].join("\n");

// ---------------------------------------------------------------------------
// Enqueue + routing (behaviors 1, 10)
// ---------------------------------------------------------------------------

test("a resolved job queues, runs, and lands a passing receipt", async () => {
  const bench = harness();
  const job = await bench.service.enqueue(request());
  assert.ok(job);
  await bench.service.whenIdle();

  const finished = await bench.store.getJob(job.jobId);
  assert.equal(finished?.state, "completed");
  assert.equal(finished?.resolvedRuntimeId, "default");
  assert.equal(finished?.queuePosition, undefined);
  assert.ok(finished?.completedAt);

  // The run wrapper carries the job id on its command line (a trailing argv
  // element, never spliced into script text) so sweepGuestJob can find and reap
  // it - an env-only token is invisible to Win32_Process.
  const ran = bench.adapters.get("default");
  assert.equal(ran?.runArgs?.[4], VALIDATION_RUN_GUEST_SCRIPT);
  assert.ok(ran?.runArgs?.includes(job.jobId), "the job id tags the wrapper process");

  const receipt = await bench.store.getReceiptByJob(job.jobId);
  assert.equal(receipt?.verdict, "passed");
  assert.equal(receipt?.changesetRef, "sha-changeset-1");
  assert.equal(receipt?.runtimeId, "default");
  assert.equal(receipt?.policyProfileRef, "validation_default");
  assert.equal(receipt?.licenseWaitMs, 0);
  assert.equal(receipt?.superseded, false);
  // Never invented: no mirror root, no probe provider, no fixture hash.
  assert.equal(receipt?.mirrorVersion, undefined);
  assert.equal(receipt?.probesGreenAt, undefined);
  assert.equal(receipt?.fixtureManifestHash, undefined);

  // Every transition published; the pipeline order is the ADR's order.
  assert.deepEqual(bench.states, ["queued", "starting", "syncing", "running", "completed"]);
  assert.deepEqual(bench.adapters.get("default")?.kinds, ["cleanup", "sync", "run"]);
});

test("nothing to validate creates no job at all", async () => {
  const bench = harness({ changeset: () => null });
  assert.equal(await bench.service.enqueue(request()), null);
  assert.equal(bench.store.jobs.length, 0);
});

test("a routing miss parks the job with the router's sentence verbatim", async () => {
  const bench = harness({ defaultRuntimeId: "" });
  const job = await bench.service.enqueue(request());
  assert.equal(job?.state, "parked");
  assert.match(job?.parkedReason ?? "", /No default validation runtime is set/);
  assert.equal(job?.resolvedRuntimeId, undefined);
  await bench.service.whenIdle();
  assert.equal(bench.adapters.get("default")?.ensureRunningCalls, 0);
});

test("a capability the runtime lacks parks at queue time and names the runtime that has it (H8)", async () => {
  const bench = harness({
    runtimes: [
      runtimeConfig({ runtimeId: "default", displayName: "default", capabilities: ["maya"] }),
      runtimeConfig({ runtimeId: "cpp-builds", displayName: "cpp-builds", capabilities: ["maya", "msvc"] })
    ]
  });
  const job = await bench.service.enqueue(request({
    profile: profile({ profileRef: "cpp_smoke", requiredCapabilities: ["msvc"] })
  }));
  assert.equal(job?.state, "parked");
  assert.match(job?.parkedReason ?? "", /cpp_smoke needs msvc, which "default" does not have\./);
  assert.match(job?.parkedReason ?? "", /Route this job to "cpp-builds"\?/);
  // Parked, not started: the point of the gate is that nothing boots.
  await bench.service.whenIdle();
  assert.equal(bench.adapters.get("default")?.ensureRunningCalls, 0);
});

test("a capability no runtime has says so instead of suggesting a reroute", async () => {
  const bench = harness();
  const job = await bench.service.enqueue(request({
    profile: profile({ profileRef: "gpu_suite", requiredCapabilities: ["karma-xpu"] })
  }));
  assert.match(job?.parkedReason ?? "", /No other runtime in the registry has it either/);
});

test("a project association routes the job, not the default", async () => {
  const bench = harness({
    runtimes: [runtimeConfig({ runtimeId: "default" }), runtimeConfig({ runtimeId: "pipzone" })],
    adapters: { default: new FakeAdapter(), pipzone: new FakeAdapter() }
  });
  bench.store.associations.push({
    projectRootId: asId<"WorkspaceRootId">("root-a"),
    runtimeId: asId<"ValidationRuntimeId">("pipzone"),
    source: "personal",
    updatedAt: "2026-08-01T00:00:00.000Z"
  });
  const job = await bench.service.enqueue(request({ projectRootId: asId<"WorkspaceRootId">("root-a") }));
  await bench.service.whenIdle();
  assert.equal((await bench.store.getJob(job?.jobId ?? asId<"ValidationJobId">("x")))?.resolvedRuntimeId, "pipzone");
  assert.equal(bench.adapters.get("pipzone")?.ensureRunningCalls, 1);
  assert.equal(bench.adapters.get("default")?.ensureRunningCalls, 0);
});

test("a quarantine raised while a job waits blocks the rest of that runtime's queue (E5)", async () => {
  const gates: (() => void)[] = [];
  const adapter = new FakeAdapter({
    run: async () => new Promise<Partial<CommandResult>>((resolve) => {
      gates.push(() => { resolve({ exitCode: 0 }); });
    })
  });
  let availability: "available" | "quarantined" = "available";
  const bench = harness({
    adapters: { default: adapter },
    overrides: { runtimeAvailability: async () => availability }
  });

  const head = await bench.service.enqueue(request());
  const follower = await bench.service.enqueue(request());
  assert.ok(head && follower);
  await until(() => gates.length === 1, "the head job to reach its run");

  // The probe suite quarantines the runtime mid-queue.
  availability = "quarantined";
  gates[0]?.();
  await bench.service.whenIdle();

  assert.equal((await bench.store.getJob(head.jobId))?.state, "completed");
  const blocked = await bench.store.getJob(follower.jobId);
  assert.equal(blocked?.state, "parked");
  assert.match(blocked?.parkedReason ?? "", /quarantined after a failed isolation check/);
  assert.equal(adapter.ensureRunningCalls, 1, "no job may reach a quarantined runtime");
});

test("a runtime with no usable adapter parks instead of failing mysteriously", async () => {
  const bench = harness({ adapterFor: () => null });
  const job = await bench.service.enqueue(request());
  await bench.service.whenIdle();
  const parked = await bench.store.getJob(job?.jobId ?? asId<"ValidationJobId">("x"));
  assert.equal(parked?.state, "parked");
  assert.match(parked?.parkedReason ?? "", /has no exec connection/);
});

test("a runtime archived while a job waits in its queue parks the job in the pipeline (H1)", async () => {
  const gates: (() => void)[] = [];
  const adapter = new FakeAdapter({
    run: async () => new Promise<Partial<CommandResult>>((resolve) => {
      gates.push(() => { resolve({ exitCode: 0 }); });
    })
  });
  const bench = harness({ adapters: { default: adapter } });

  const head = await bench.service.enqueue(request());
  const follower = await bench.service.enqueue(request());
  assert.ok(head && follower);
  await until(() => gates.length === 1, "the head job to reach its run");

  // The runtime is archived AFTER both jobs were enqueued and routed: the
  // follower is already `queued` on it, so only a pipeline-time re-check parks it.
  const runtime = bench.store.runtimes.find((entry) => entry.runtimeId === "default");
  assert.ok(runtime);
  (runtime as { archived?: boolean }).archived = true;

  gates[0]?.(); // the head (already running) finishes, freeing the runtime for the follower
  await bench.service.whenIdle();

  assert.equal((await bench.store.getJob(head.jobId))?.state, "completed");
  const parked = await bench.store.getJob(follower.jobId);
  assert.equal(parked?.state, "parked");
  assert.match(parked?.parkedReason ?? "", /was archived and no longer runs new validation jobs/);
  // The follower never ran: only the head ever reached its run exec.
  assert.equal(adapter.kinds.filter((kind) => kind === "run").length, 1);
});

// ---------------------------------------------------------------------------
// Serialization (behavior 2)
// ---------------------------------------------------------------------------

test("two jobs on one runtime serialize FIFO with a stamped queue position", async () => {
  const gates: (() => void)[] = [];
  const adapter = new FakeAdapter({
    run: async () => new Promise<Partial<CommandResult>>((resolve) => {
      gates.push(() => { resolve({ exitCode: 0 }); });
    })
  });
  const bench = harness({ adapters: { default: adapter } });

  const first = await bench.service.enqueue(request());
  const second = await bench.service.enqueue(request());
  assert.ok(first && second);

  // Only the head is executing; the follower waits with position 1.
  await until(() => gates.length === 1, "the head job to reach its run");
  await settle();
  assert.equal(gates.length, 1, "the second job must not start while the first holds the runtime");
  assert.equal((await bench.store.getJob(second.jobId))?.state, "queued");
  assert.equal((await bench.store.getJob(second.jobId))?.queuePosition, 1);

  gates[0]?.();
  await until(() => gates.length === 2, "the follower to start once the head finished");
  gates[1]?.();
  await bench.service.whenIdle();

  assert.equal((await bench.store.getJob(first.jobId))?.state, "completed");
  assert.equal((await bench.store.getJob(second.jobId))?.state, "completed");
  assert.equal(adapter.kinds.filter((kind) => kind === "run").length, 2);
});

test("jobs on different runtimes run concurrently", async () => {
  const gates: (() => void)[] = [];
  const makeAdapter = (): FakeAdapter => new FakeAdapter({
    run: async () => new Promise<Partial<CommandResult>>((resolve) => {
      gates.push(() => { resolve({ exitCode: 0 }); });
    })
  });
  const left = makeAdapter();
  const right = makeAdapter();
  const bench = harness({
    runtimes: [runtimeConfig({ runtimeId: "default" }), runtimeConfig({ runtimeId: "cpp-builds" })],
    adapters: { default: left, "cpp-builds": right }
  });

  await bench.service.enqueue(request());
  await bench.service.enqueue(request({ requestedRuntimeId: asId<"ValidationRuntimeId">("cpp-builds") }));

  // Both are mid-run at the same moment - neither gate has been released.
  await until(
    () => left.kinds.includes("run") && right.kinds.includes("run"),
    "both runtimes to be running at once"
  );
  for (const gate of [...gates]) gate();
  await bench.service.whenIdle();
  assert.equal(bench.store.receipts.length, 2);
});

test("a job that becomes runnable mid-drain is launched by the trailing-edge pass", async () => {
  // The bug this guards: a drain pass reads the queue and sees the runtime busy;
  // the running job then finishes DURING an await inside that same pass, firing
  // drain() again. A plain single-flight drain would just await-and-return, and
  // the freed runtime's next job would sit `queued` until an unrelated
  // completion. The trailing-edge flag forces one more pass instead.
  const runGates: Array<(value: Partial<CommandResult>) => void> = [];
  const adapter = new FakeAdapter({
    run: async () => new Promise<Partial<CommandResult>>((resolve) => { runGates.push(resolve); })
  });

  const reachedPositionWrite = deferred();
  const releasePositionWrite = deferred();
  let gatedOnce = false;

  // A store that holds the FIRST follower queue-position write, freezing a drain
  // pass mid-await so the head job can complete (and re-fire drain) inside it.
  class GatedStore extends MemoryValidationStore {
    override async updateJobState(jobId: ValidationJobId, patch: ValidationJobPatch): Promise<void> {
      if (patch.queuePosition === 1 && !gatedOnce) {
        gatedOnce = true;
        reachedPositionWrite.resolve();
        await releasePositionWrite.promise;
      }
      await super.updateJobState(jobId, patch);
    }
  }

  const store = new GatedStore();
  const bench = harness({ adapters: { default: adapter }, store });

  const head = await bench.service.enqueue(request());
  assert.ok(head);
  await until(() => runGates.length === 1, "the head job to reach its run");

  // Enqueueing the follower opens a drain pass; its queue-position write blocks
  // inside the gated store, so that pass is now active and awaiting.
  const enqueueFollower = bench.service.enqueue(request());
  await reachedPositionWrite.promise;

  // The head completes WHILE that pass is frozen: its `finally` fires drain(),
  // which must set the trailing-edge flag rather than merely await the pass.
  runGates[0]?.({ exitCode: 0 });
  await until(
    () => bench.store.jobs.find((entry) => entry.jobId === head.jobId)?.state === "completed",
    "the head job to complete while the drain pass is held"
  );
  await settle();

  // Release the held write; the pass ends and the trailing pass must launch the
  // follower onto the now-idle runtime, with no further enqueue from us.
  releasePositionWrite.resolve();

  const follower = await enqueueFollower;
  assert.ok(follower);
  await until(() => runGates.length === 2, "the follower to be launched by the trailing-edge pass");
  runGates[1]?.({ exitCode: 0 });
  await bench.service.whenIdle();

  assert.equal((await bench.store.getJob(head.jobId))?.state, "completed");
  assert.equal((await bench.store.getJob(follower.jobId))?.state, "completed");
  assert.equal(adapter.kinds.filter((kind) => kind === "run").length, 2);
});

// ---------------------------------------------------------------------------
// Sync + the Windows boundary (behavior 3)
// ---------------------------------------------------------------------------

test("the guest receives the job layout, the patch bytes, and a job-scoped environment", async () => {
  const adapter = new FakeAdapter();
  const bench = harness({ adapters: { default: adapter } });
  const job = await bench.service.enqueue(request({
    profile: profile({ env: { REZ_CONFIG_FILE: "X:\\Pipeline\\rez\\configs\\studio.py" } })
  }));
  await bench.service.whenIdle();
  assert.ok(job);

  assert.deepEqual(adapter.cleanupInput, { jobRoot: "C:\\drydock\\jobs", keepJobId: job.jobId });
  assert.equal(adapter.syncInput?.jobId, job.jobId);
  assert.equal(adapter.syncInput?.patches.length, 1);
  assert.equal(
    Buffer.from(adapter.syncInput?.patches[0]?.patchBase64 ?? "", "base64").toString("utf8"),
    PLAIN_PATCH
  );

  const env = adapter.runInput?.env ?? {};
  const jobDir = `C:\\drydock\\jobs\\${job.jobId}`;
  assert.equal(env["MAYA_APP_DIR"], `${jobDir}\\prefs\\maya`);
  assert.equal(env["HOUDINI_USER_PREF_DIR"], `${jobDir}\\prefs\\houdini`);
  assert.equal(env["DRYDOCK_FIXTURE_ROOT"], `${jobDir}\\fixtures`);
  assert.equal(env["DRYDOCK_JOB_TOKEN"], job.jobId);
  assert.equal(env["REZ_CONFIG_FILE"], "X:\\Pipeline\\rez\\configs\\studio.py");
  // One repo means the profile runs inside it.
  assert.equal(adapter.runInput?.cwd, `${jobDir}\\ws\\pipeline`);
  assert.deepEqual(adapter.runInput?.argv, ["mayapy", "-m", "pytest", "tests"]);
});

test("a profile cannot redirect the job-scoped prefs at a shared directory", async () => {
  const adapter = new FakeAdapter();
  const bench = harness({ adapters: { default: adapter } });
  const job = await bench.service.enqueue(request({
    profile: profile({ env: { MAYA_APP_DIR: "C:\\shared\\maya", "bad name": "x" } })
  }));
  await bench.service.whenIdle();
  assert.equal(adapter.runInput?.env["MAYA_APP_DIR"], `C:\\drydock\\jobs\\${job?.jobId ?? ""}\\prefs\\maya`);
  assert.equal(adapter.runInput?.env["bad name"], undefined);
});

test("a symlink in the changeset fails at the boundary, before anything runs (D3)", async () => {
  const adapter = new FakeAdapter();
  const bench = harness({
    adapters: { default: adapter },
    changeset: () => ({
      changesetRef: "sha-symlink",
      patches: [{ repoName: "pipeline", patch: "diff --git a/docs/latest b/docs/latest\nnew file mode 120000\n" }]
    })
  });
  const job = await bench.service.enqueue(request());
  await bench.service.whenIdle();
  assert.ok(job);

  assert.equal((await bench.store.getJob(job.jobId))?.state, "failed");
  const receipt = await bench.store.getReceiptByJob(job.jobId);
  assert.equal(receipt?.verdict, "error");
  assert.match(receipt?.summary ?? "", /"docs\/latest" is a symbolic link/);
  // The suite never started.
  assert.ok(!adapter.kinds.includes("run"));
});

test("a patch that does not apply in the guest is infrastructure error, not a test failure", async () => {
  const adapter = new FakeAdapter({
    sync: () => ({
      exitCode: 1,
      stdout: JSON.stringify({
        ok: false,
        applied: [],
        failures: [{ repoName: "pipeline", detail: "error: patch failed: src/loader.py:1" }]
      })
    })
  });
  const bench = harness({ adapters: { default: adapter } });
  const job = await bench.service.enqueue(request());
  await bench.service.whenIdle();
  assert.ok(job);

  assert.equal((await bench.store.getJob(job.jobId))?.state, "failed");
  const receipt = await bench.store.getReceiptByJob(job.jobId);
  assert.equal(receipt?.verdict, "error");
  assert.match(receipt?.summary ?? "", /did not apply in "default": pipeline: error: patch failed/);
  assert.ok(!adapter.kinds.includes("run"));
});

test("a runtime that will not come up fails the job with the reason it gave", async () => {
  const adapter = new FakeAdapter({
    ensureRunning: () => Promise.reject(new Error('"default" is Running but its exec channel did not answer'))
  });
  const bench = harness({ adapters: { default: adapter } });
  const job = await bench.service.enqueue(request());
  await bench.service.whenIdle();
  const receipt = await bench.store.getReceiptByJob(job?.jobId ?? asId<"ValidationJobId">("x"));
  assert.equal(receipt?.verdict, "error");
  assert.match(receipt?.summary ?? "", /did not come up: "default" is Running but its exec channel did not answer/);
});

// ---------------------------------------------------------------------------
// License wait + watchdogs (behaviors 4, 5)
// ---------------------------------------------------------------------------

test("a license wait is its own state, pauses the stall watchdog, and lands on the receipt (E4)", async () => {
  const timers = new FakeTimerBank();
  let armedDuringWait = -1;
  const adapter = new FakeAdapter({
    run: async ({ emit }) => {
      emit("[maya] Waiting for license from flexlm...");
      armedDuringWait = timers.armed;
      benchRef.advance(7_000);
      emit("[maya] license obtained");
      emit("collected 14 items");
      return { exitCode: 0 };
    }
  });
  const bench = harness({ adapters: { default: adapter }, overrides: { timers } });
  const benchRef = bench;

  const job = await bench.service.enqueue(request());
  await bench.service.whenIdle();
  assert.ok(job);

  assert.equal(armedDuringWait, 0, "the watchdog must be disarmed while a license wait is the state");
  assert.ok(bench.states.includes("license-wait"));
  assert.equal(bench.states.filter((state) => state === "running").length, 2, "state returns to running when output resumes");
  const receipt = await bench.store.getReceiptByJob(job.jobId);
  assert.equal(receipt?.licenseWaitMs, 7_000);
  assert.equal(receipt?.verdict, "passed");
  assert.equal((await bench.store.getJob(job.jobId))?.licenseWaitMs, 7_000);
});

test("a profile's own license wording counts as a license wait", async () => {
  const timers = new FakeTimerBank();
  const adapter = new FakeAdapter({
    run: async ({ emit }) => {
      emit("hqueue: all Houdini Engine seats are in use, holding");
      emit("resumed");
      return { exitCode: 0 };
    }
  });
  const bench = harness({ adapters: { default: adapter }, overrides: { timers } });
  await bench.service.enqueue(request({
    profile: profile({ licenseWaitPatterns: ["seats are in use", "([" ] })
  }));
  await bench.service.whenIdle();
  assert.ok(bench.states.includes("license-wait"));
  // The malformed pattern is logged, never fatal.
  assert.ok(bench.logger.entries.some((entry) => entry.message === "license-wait pattern ignored"));
});

test("silence past the inactivity budget aborts, sweeps, and reads as hung (not as a verdict)", async () => {
  const timers = new FakeTimerBank();
  const adapter = new FakeAdapter({
    run: async ({ emit, signal }) => {
      emit("collected 14 items"); // first line: the tight inactivity budget now governs
      timers.fireElapsed(90_000); // 90 s of mid-run silence elapses
      await untilAborted(signal);
      return { exitCode: null, signal: "SIGTERM" };
    }
  });
  const bench = harness({
    adapters: { default: adapter },
    overrides: { timers, inactivityTimeoutMs: 90_000, startupTimeoutMs: 600_000 }
  });
  const job = await bench.service.enqueue(request());
  await bench.service.whenIdle();
  assert.ok(job);

  assert.equal((await bench.store.getJob(job.jobId))?.state, "failed");
  const receipt = await bench.store.getReceiptByJob(job.jobId);
  assert.equal(receipt?.verdict, "error");
  assert.match(receipt?.summary ?? "", /No output for 90 s - treat this run as hung/);
  assert.deepEqual(adapter.swept, [job.jobId]);
});

test("a cold DCC start within the startup budget is not treated as a stall (E4)", async () => {
  const timers = new FakeTimerBank();
  let budgetBeforeFirstLine = -1;
  let budgetAfterFirstLine = -1;
  const adapter = new FakeAdapter({
    run: async ({ emit }) => {
      // Before any output the watchdog carries the larger STARTUP budget, so the
      // inactivity budget elapsing during a cold start must NOT abort the run.
      budgetBeforeFirstLine = timers.budgets[0] ?? -1;
      timers.fireElapsed(120_000);
      emit("collected 14 items");
      budgetAfterFirstLine = timers.budgets[0] ?? -1;
      return { exitCode: 0 };
    }
  });
  const bench = harness({
    adapters: { default: adapter },
    overrides: { timers, inactivityTimeoutMs: 120_000, startupTimeoutMs: 600_000 }
  });
  const job = await bench.service.enqueue(request());
  await bench.service.whenIdle();
  assert.ok(job);

  assert.equal(budgetBeforeFirstLine, 600_000, "the startup budget governs before the first line");
  assert.equal(budgetAfterFirstLine, 120_000, "the first line hands over to the tight inactivity budget");
  assert.equal((await bench.store.getJob(job.jobId))?.state, "completed");
  assert.equal((await bench.store.getReceiptByJob(job.jobId))?.verdict, "passed");
});

test("a guest that never emits a line is stopped by the startup budget and reads as not launching", async () => {
  const timers = new FakeTimerBank();
  const adapter = new FakeAdapter({
    run: async ({ signal }) => {
      timers.fireElapsed(600_000); // the startup budget elapses with no output at all
      await untilAborted(signal);
      return { exitCode: null, signal: "SIGTERM" };
    }
  });
  const bench = harness({
    adapters: { default: adapter },
    overrides: { timers, inactivityTimeoutMs: 120_000, startupTimeoutMs: 600_000 }
  });
  const job = await bench.service.enqueue(request());
  await bench.service.whenIdle();
  assert.ok(job);

  assert.equal((await bench.store.getJob(job.jobId))?.state, "failed");
  const receipt = await bench.store.getReceiptByJob(job.jobId);
  assert.equal(receipt?.verdict, "error");
  assert.match(receipt?.summary ?? "", /No output for 600 s after start - treat this run as not launching/);
  assert.deepEqual(adapter.swept, [job.jobId]);
});

test("the hard turn cap stops a run that is still producing output", async () => {
  const adapter = new FakeAdapter({
    run: async ({ emit }) => {
      emit("still going");
      return { exitCode: null, timedOut: true };
    }
  });
  const bench = harness({
    adapters: { default: adapter },
    overrides: { jobTurnTimeoutMs: 1_800_000 }
  });
  const job = await bench.service.enqueue(request());
  await bench.service.whenIdle();
  const receipt = await bench.store.getReceiptByJob(job?.jobId ?? asId<"ValidationJobId">("x"));
  assert.equal(receipt?.verdict, "error");
  assert.match(receipt?.summary ?? "", /passed its 30-minute cap and was stopped/);
  assert.deepEqual(adapter.swept, [job?.jobId]);
});

// ---------------------------------------------------------------------------
// Receipts (behavior 6)
// ---------------------------------------------------------------------------

test("a failing suite completes the job and puts the failing test on the receipt", async () => {
  const adapter = new FakeAdapter({
    run: async ({ emit }) => {
      emit("collected 14 items");
      emit("=================================== FAILURES ===================================");
      emit("FAILED tests/test_icons.py::test_icon_fallback - AssertionError: expected default set");
      emit("========================= 1 failed, 13 passed in 2.10s =========================");
      return { exitCode: 1 };
    }
  });
  const bench = harness({ adapters: { default: adapter } });
  const job = await bench.service.enqueue(request());
  await bench.service.whenIdle();
  assert.ok(job);

  // `completed` = it ran to a verdict; the RECEIPT says the tests failed.
  assert.equal((await bench.store.getJob(job.jobId))?.state, "completed");
  const receipt = await bench.store.getReceiptByJob(job.jobId);
  assert.equal(receipt?.verdict, "failed");
  assert.equal(receipt?.failingTest, "tests/test_icons.py::test_icon_fallback");
  assert.equal(receipt?.failingAssertion, "AssertionError: expected default set");
  assert.equal(receipt?.summary, "1 failed, 13 passed in 2.10s");
});

test("receipts carry mirror freshness, probe greenness, and the fixture hash when they are known", async () => {
  const mirrorRoot = await mkdtemp(join(tmpdir(), "validation-mirror-"));
  try {
    await writeFile(
      join(mirrorRoot, ".drydock-mirror.json"),
      JSON.stringify({
        manifestVersion: 7,
        syncedAt: "2026-08-12T08:30:00.000Z",
        subtrees: [{ ok: true }],
        skippedVersions: []
      }),
      "utf8"
    );
    const bench = harness({
      overrides: {
        mirrorRoot: () => mirrorRoot,
        probesGreenAt: () => "2026-08-12T09:00:00.000Z"
      }
    });
    const job = await bench.service.enqueue(request({ fixtureManifestHash: "fixture-abc" }));
    await bench.service.whenIdle();
    const receipt = await bench.store.getReceiptByJob(job?.jobId ?? asId<"ValidationJobId">("x"));
    assert.equal(receipt?.mirrorVersion, 7);
    assert.equal(receipt?.mirrorFreshnessAt, "2026-08-12T08:30:00.000Z");
    assert.equal(receipt?.probesGreenAt, "2026-08-12T09:00:00.000Z");
    assert.equal(receipt?.fixtureManifestHash, "fixture-abc");
  } finally {
    await rm(mirrorRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Approved fixtures (A1/A6): copies, shipped after the changeset
// ---------------------------------------------------------------------------

test("approved fixtures ship after the patches, as their own exec, before the run", async () => {
  const adapter = new FakeAdapter();
  const bench = harness({ adapters: { default: adapter } });
  const job = await bench.service.enqueue(request({
    fixtures: [
      { relativePath: "hero_rig.ma", contentBase64: Buffer.from("maya ascii", "utf8").toString("base64") },
      { relativePath: "sets/shotA.json", contentBase64: Buffer.from("{}", "utf8").toString("base64") }
    ],
    fixtureManifestHash: "fixture-abc"
  }));
  await bench.service.whenIdle();
  assert.ok(job);

  // Order is the contract: workspace, then fixtures, then the suite.
  assert.deepEqual(adapter.kinds, ["cleanup", "sync", "fixtures", "run"]);
  assert.equal(adapter.fixtureInput?.jobId, job.jobId);
  assert.equal(adapter.fixtureInput?.jobRoot, "C:\\drydock\\jobs");
  assert.deepEqual(
    adapter.fixtureInput?.fixtures.map((entry) => entry.relativePath),
    ["hero_rig.ma", "sets/shotA.json"]
  );
  assert.equal(
    Buffer.from(adapter.fixtureInput?.fixtures[0]?.contentBase64 ?? "", "base64").toString("utf8"),
    "maya ascii"
  );
  // The manifest hash rides onto the receipt so evidence records what it saw.
  assert.equal((await bench.store.getReceiptByJob(job.jobId))?.fixtureManifestHash, "fixture-abc");
});

test("a job with no fixtures never runs the fixture exec at all", async () => {
  const adapter = new FakeAdapter();
  const bench = harness({ adapters: { default: adapter } });
  await bench.service.enqueue(request());
  await bench.service.whenIdle();
  assert.deepEqual(adapter.kinds, ["cleanup", "sync", "run"]);
  assert.equal(adapter.fixtureInput, undefined);
});

test("a fixture path that leaves the fixture directory is refused before the guest sees it", async () => {
  const adapter = new FakeAdapter();
  const bench = harness({ adapters: { default: adapter } });
  const job = await bench.service.enqueue(request({
    fixtures: [{ relativePath: "../../windows/system32/evil.dll", contentBase64: "AA==" }]
  }));
  await bench.service.whenIdle();
  assert.ok(job);
  assert.deepEqual(adapter.kinds, ["cleanup", "sync"], "nothing was written and nothing ran");
  // Infrastructure error, not a test verdict: the suite never expressed one.
  assert.equal((await bench.store.getJob(job.jobId))?.state, "failed");
  const receipt = await bench.store.getReceiptByJob(job.jobId);
  assert.equal(receipt?.verdict, "error");
  assert.match(receipt?.summary ?? "", /fixture paths must stay inside the job's fixture directory/);
});

test("fixtures that do not land fail the job instead of running the suite without them", async () => {
  const adapter = new FakeAdapter({
    fixtures: () => ({
      exitCode: 1,
      stdout: '{"ok":false,"written":[],"failures":[{"relativePath":"hero_rig.ma","detail":"access denied"}]}'
    })
  });
  const bench = harness({ adapters: { default: adapter } });
  const job = await bench.service.enqueue(request({
    fixtures: [{ relativePath: "hero_rig.ma", contentBase64: "AA==" }]
  }));
  await bench.service.whenIdle();
  assert.ok(job);
  assert.deepEqual(adapter.kinds, ["cleanup", "sync", "fixtures"]);
  const receipt = await bench.store.getReceiptByJob(job.jobId);
  assert.equal(receipt?.verdict, "error");
  assert.match(receipt?.summary ?? "", /approved fixtures did not land in "default": hero_rig\.ma: access denied/);
});

test("evidence whose working set moved on is marked superseded (D2)", async () => {
  const bench = harness({
    changeset: (call) => ({
      changesetRef: call === 0 ? "sha-a" : "sha-b",
      patches: [{ repoName: "pipeline", patch: PLAIN_PATCH }]
    })
  });
  const job = await bench.service.enqueue(request());
  await bench.service.whenIdle();
  const receipt = await bench.store.getReceiptByJob(job?.jobId ?? asId<"ValidationJobId">("x"));
  assert.equal(receipt?.changesetRef, "sha-a", "evidence binds to the snapshot it ran");
  assert.equal(receipt?.superseded, true);
  assert.ok(receipt?.supersededAt);
});

// ---------------------------------------------------------------------------
// Abort (behavior 7)
// ---------------------------------------------------------------------------

test("aborting a running job sweeps the guest and leaves no evidence", async () => {
  const adapter = new FakeAdapter({
    run: async ({ emit, signal }) => {
      emit("running tests");
      await untilAborted(signal);
      return { exitCode: null, signal: "SIGTERM" };
    }
  });
  const bench = harness({ adapters: { default: adapter } });
  const job = await bench.service.enqueue(request());
  assert.ok(job);
  await until(() => adapter.kinds.includes("run"), "the suite to be running");

  const aborted = await bench.service.abortJob(job.jobId);
  assert.equal(aborted?.state, "aborted");
  assert.deepEqual(adapter.swept, [job.jobId]);
  assert.equal(await bench.store.getReceiptByJob(job.jobId), null);
  await bench.service.whenIdle();
});

test("aborting a queued job never starts it, and frees the runtime for the next one", async () => {
  const gates: (() => void)[] = [];
  const adapter = new FakeAdapter({
    run: async () => new Promise<Partial<CommandResult>>((resolve) => {
      gates.push(() => { resolve({ exitCode: 0 }); });
    })
  });
  const bench = harness({ adapters: { default: adapter } });
  const head = await bench.service.enqueue(request());
  const waiting = await bench.service.enqueue(request());
  assert.ok(head && waiting);
  await until(() => gates.length === 1, "the head job to reach its run");

  const aborted = await bench.service.abortJob(waiting.jobId);
  assert.equal(aborted?.state, "aborted");
  assert.equal(gates.length, 1);

  for (const gate of [...gates]) gate();
  await bench.service.whenIdle();
  assert.equal(gates.length, 1, "an aborted queued job never starts, even once the runtime frees up");
});

// ---------------------------------------------------------------------------
// Requeue + reroute (behavior 8)
// ---------------------------------------------------------------------------

test("rerouting across policy profiles returns the delta and writes nothing until it is confirmed (H1/H2)", async () => {
  const bench = harness({
    runtimes: [
      runtimeConfig({ runtimeId: "default", displayName: "default" }),
      runtimeConfig({
        runtimeId: "production_tester",
        displayName: "production_tester",
        policyProfileRef: "production_fixtures",
        capabilities: ["maya", "houdini", "production-fixtures"],
        profileException: true
      })
    ],
    adapters: { default: new FakeAdapter(), production_tester: new FakeAdapter() },
    adapterFor: (runtime) => (runtime.runtimeId === "default" ? null : new FakeAdapter())
  });

  const job = await bench.service.enqueue(request());
  await bench.service.whenIdle();
  assert.ok(job);
  assert.equal((await bench.store.getJob(job.jobId))?.state, "parked");

  const decision = await bench.service.requeueParked(job.jobId, {
    rerouteTo: asId<"ValidationRuntimeId">("production_tester")
  });
  assert.equal(decision.kind, "needs-confirm");
  if (decision.kind === "needs-confirm") {
    assert.equal(decision.to.displayName, "production_tester");
    assert.equal(decision.delta.profileException, true);
    assert.equal(decision.delta.profileChanged, true);
    assert.deepEqual(decision.delta.capabilitiesAdded, ["production-fixtures"]);
  }
  // Nothing moved: the job is still parked on its original runtime.
  const untouched = await bench.store.getJob(job.jobId);
  assert.equal(untouched?.state, "parked");
  assert.equal(untouched?.resolvedRuntimeId, "default");

  const confirmed = await bench.service.requeueParked(job.jobId, {
    rerouteTo: asId<"ValidationRuntimeId">("production_tester"),
    confirmedDelta: true
  });
  assert.equal(confirmed.kind, "queued");
  await bench.service.whenIdle();
  const moved = await bench.store.getJob(job.jobId);
  assert.equal(moved?.resolvedRuntimeId, "production_tester");
  assert.equal(moved?.parkedReason, undefined);
});

test("requeueing onto the same runtime is one step and clears the park reason", async () => {
  let usable = false;
  const adapter = new FakeAdapter();
  const bench = harness({
    adapterFor: () => (usable ? adapter : null)
  });
  const job = await bench.service.enqueue(request());
  await bench.service.whenIdle();
  assert.ok(job);
  assert.equal((await bench.store.getJob(job.jobId))?.state, "parked");

  usable = true;
  const result = await bench.service.requeueParked(job.jobId);
  assert.equal(result.kind, "queued");
  await bench.service.whenIdle();
  const finished = await bench.store.getJob(job.jobId);
  assert.equal(finished?.state, "completed");
  assert.equal(finished?.parkedReason, undefined);
});

test("a reroute onto a runtime that also lacks the capability stays parked with the new reason (H8)", async () => {
  const bench = harness({
    runtimes: [
      runtimeConfig({ runtimeId: "default", displayName: "default", capabilities: ["maya"] }),
      runtimeConfig({ runtimeId: "pipzone", displayName: "pipzone", capabilities: ["houdini"] }),
      runtimeConfig({ runtimeId: "cpp-builds", displayName: "cpp-builds", capabilities: ["maya", "msvc"] })
    ],
    adapters: { default: new FakeAdapter(), pipzone: new FakeAdapter(), "cpp-builds": new FakeAdapter() }
  });
  const job = await bench.service.enqueue(request({
    profile: profile({ profileRef: "cpp_smoke", requiredCapabilities: ["msvc"] })
  }));
  assert.ok(job);

  const wrong = await bench.service.requeueParked(job.jobId, {
    rerouteTo: asId<"ValidationRuntimeId">("pipzone"),
    confirmedDelta: true
  });
  assert.equal(wrong.kind, "parked");
  if (wrong.kind === "parked") assert.match(wrong.reason, /cpp_smoke needs msvc, which "pipzone" does not have/);
  assert.equal((await bench.store.getJob(job.jobId))?.state, "parked");

  const right = await bench.service.requeueParked(job.jobId, {
    rerouteTo: asId<"ValidationRuntimeId">("cpp-builds"),
    confirmedDelta: true
  });
  assert.equal(right.kind, "queued");
  await bench.service.whenIdle();
  assert.equal((await bench.store.getJob(job.jobId))?.state, "completed");
});

test("rerouting onto an archived runtime stays parked with the archived reason (H1)", async () => {
  const bench = harness({
    runtimes: [
      runtimeConfig({ runtimeId: "default", displayName: "default" }),
      runtimeConfig({ runtimeId: "old-farm", displayName: "old-farm", archived: true })
    ],
    adapters: { default: new FakeAdapter(), "old-farm": new FakeAdapter() },
    // No adapter for default: the job parks first, giving us a parked job to requeue.
    adapterFor: (runtime) => (runtime.runtimeId === "default" ? null : new FakeAdapter())
  });
  const job = await bench.service.enqueue(request());
  await bench.service.whenIdle();
  assert.ok(job);
  assert.equal((await bench.store.getJob(job.jobId))?.state, "parked");

  const result = await bench.service.requeueParked(job.jobId, {
    rerouteTo: asId<"ValidationRuntimeId">("old-farm"),
    confirmedDelta: true
  });
  assert.equal(result.kind, "parked");
  if (result.kind === "parked") {
    assert.match(result.reason, /"old-farm" was archived and no longer runs new validation jobs/);
  }
  // The job stayed put - nothing was queued onto the decommissioned runtime.
  const still = await bench.store.getJob(job.jobId);
  assert.equal(still?.state, "parked");
  assert.equal(still?.resolvedRuntimeId, "default");
});

test("requeueing a job that is not parked is refused", async () => {
  const bench = harness();
  const job = await bench.service.enqueue(request());
  await bench.service.whenIdle();
  await assert.rejects(
    bench.service.requeueParked(job?.jobId ?? asId<"ValidationJobId">("x")),
    /is completed, not parked/
  );
});

// ---------------------------------------------------------------------------
// Restart recovery (behavior 9)
// ---------------------------------------------------------------------------

test("a job interrupted mid-run is requeued once and re-ships its workspace (E7)", async () => {
  const adapter = new FakeAdapter();
  const bench = harness({ adapters: { default: adapter }, overrides: { profileFor: async () => profile() } });
  bench.store.jobs.push({
    jobId: asId<"ValidationJobId">("vjob-interrupted"),
    sessionId: asId<"SessionId">("session-1"),
    chatId: asId<"ChatId">("chat-1"),
    resolvedRuntimeId: asId<"ValidationRuntimeId">("default"),
    profileRef: "tool_smoke",
    changesetRef: "sha-changeset-1",
    state: "running",
    queuedAt: "2026-08-12T08:00:00.000Z",
    startedAt: "2026-08-12T08:00:05.000Z",
    updatedAt: "2026-08-12T08:00:05.000Z"
  });

  await bench.service.restore();
  await bench.service.whenIdle();

  const recovered = await bench.store.getJob(asId<"ValidationJobId">("vjob-interrupted"));
  assert.equal(recovered?.state, "completed");
  assert.deepEqual(adapter.kinds, ["cleanup", "sync", "run"]);

  // A second interruption of the same job parks it rather than looping.
  await bench.store.updateJobState(asId<"ValidationJobId">("vjob-interrupted"), {
    state: "running",
    updatedAt: "2026-08-12T09:00:00.000Z"
  });
  await bench.service.restore();
  await bench.service.whenIdle();
  const parked = await bench.store.getJob(asId<"ValidationJobId">("vjob-interrupted"));
  assert.equal(parked?.state, "parked");
  assert.match(parked?.parkedReason ?? "", /interrupted by a host restart twice/);
});

test("an interrupted job whose profile is gone parks instead of guessing", async () => {
  const bench = harness();
  bench.store.jobs.push({
    jobId: asId<"ValidationJobId">("vjob-orphan"),
    sessionId: asId<"SessionId">("session-1"),
    chatId: asId<"ChatId">("chat-1"),
    resolvedRuntimeId: asId<"ValidationRuntimeId">("default"),
    profileRef: "retired_suite",
    changesetRef: "sha-changeset-1",
    state: "syncing",
    queuedAt: "2026-08-12T08:00:00.000Z",
    updatedAt: "2026-08-12T08:00:05.000Z"
  });
  await bench.service.restore();
  await bench.service.whenIdle();
  const parked = await bench.store.getJob(asId<"ValidationJobId">("vjob-orphan"));
  assert.equal(parked?.state, "parked");
  assert.match(parked?.parkedReason ?? "", /"retired_suite" is no longer available/);
  assert.equal(bench.store.receipts.length, 0, "an interrupted run leaves no evidence");
});

test("an interrupted job whose work moved on parks rather than validating a different snapshot", async () => {
  const bench = harness({
    overrides: { profileFor: async () => profile() },
    changeset: () => ({ changesetRef: "sha-moved-on", patches: [{ repoName: "pipeline", patch: PLAIN_PATCH }] })
  });
  bench.store.jobs.push({
    jobId: asId<"ValidationJobId">("vjob-drifted"),
    sessionId: asId<"SessionId">("session-1"),
    chatId: asId<"ChatId">("chat-1"),
    resolvedRuntimeId: asId<"ValidationRuntimeId">("default"),
    profileRef: "tool_smoke",
    changesetRef: "sha-original",
    state: "license-wait",
    queuedAt: "2026-08-12T08:00:00.000Z",
    updatedAt: "2026-08-12T08:00:05.000Z"
  });
  await bench.service.restore();
  await bench.service.whenIdle();
  const parked = await bench.store.getJob(asId<"ValidationJobId">("vjob-drifted"));
  assert.equal(parked?.state, "parked");
  assert.match(parked?.parkedReason ?? "", /its snapshot no longer exists/);
});

// ---------------------------------------------------------------------------
// Guards and pure helpers
// ---------------------------------------------------------------------------

test("a profile with no command is refused before a job row exists", async () => {
  const bench = harness();
  await assert.rejects(
    bench.service.enqueue(request({ profile: { profileRef: "empty", argv: [] } })),
    /declares no command to run/
  );
  assert.equal(bench.store.jobs.length, 0);
});

test("a repository name that is not a plain segment never reaches the guest", async () => {
  const adapter = new FakeAdapter();
  const bench = harness({
    adapters: { default: adapter },
    changeset: () => ({ changesetRef: "sha-evil", patches: [{ repoName: "..\\..\\windows", patch: PLAIN_PATCH }] })
  });
  const job = await bench.service.enqueue(request());
  await bench.service.whenIdle();
  const receipt = await bench.store.getReceiptByJob(job?.jobId ?? asId<"ValidationJobId">("x"));
  assert.equal(receipt?.verdict, "error");
  assert.match(receipt?.summary ?? "", /Refusing to ship repository/);
  assert.ok(!adapter.kinds.includes("sync"));
});

test("guest commands are fixed-literal PowerShell with parameters on stdin", () => {
  const argv = validationGuestCommand(VALIDATION_RUN_GUEST_SCRIPT);
  assert.deepEqual(argv.slice(0, 4), ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"]);
  for (const script of [VALIDATION_RUN_GUEST_SCRIPT, VALIDATION_SYNC_GUEST_SCRIPT, VALIDATION_CLEANUP_GUEST_SCRIPT]) {
    assert.match(script, /\[Console\]::In\.ReadToEnd\(\) \| ConvertFrom-Json/);
  }
  // D4: the guest validates the changeset's bytes, not a translation of them.
  assert.match(VALIDATION_SYNC_GUEST_SCRIPT, /config core\.autocrlf false/);
  assert.match(VALIDATION_SYNC_GUEST_SCRIPT, /apply --binary --whitespace=nowarn/);
});

test("failure parsing reads pytest and unittest, and invents nothing otherwise", () => {
  const pytest = parseValidationFailure(
    "FAILED tests/test_icons.py::test_icon_fallback - AssertionError: expected default set"
  );
  assert.equal(pytest.failingTest, "tests/test_icons.py::test_icon_fallback");
  assert.equal(pytest.failingAssertion, "AssertionError: expected default set");

  const unittest = parseValidationFailure([
    "FAIL: test_icon_fallback (tests.test_icons.IconTests)",
    "----------------------------------------------------------------------",
    "Traceback (most recent call last):",
    "  File \"tests/test_icons.py\", line 12, in test_icon_fallback",
    "    self.assertEqual(icon, default)",
    "AssertionError: 'missing' != 'default'"
  ].join("\n"));
  assert.equal(unittest.failingTest, "tests.test_icons.IconTests.test_icon_fallback");
  assert.equal(unittest.failingAssertion, "AssertionError: 'missing' != 'default'");

  assert.deepEqual(parseValidationFailure("mayapy crashed, no idea why"), {});
});

test("run summaries prefer the suite's own tally line", () => {
  assert.equal(summarizeRun("========================= 1 failed, 13 passed in 2.10s ========================="), "1 failed, 13 passed in 2.10s");
  assert.equal(summarizeRun("Ran 14 tests in 2.100s\n\nOK\n"), "OK");
  assert.equal(summarizeRun("no tally here"), undefined);
});
