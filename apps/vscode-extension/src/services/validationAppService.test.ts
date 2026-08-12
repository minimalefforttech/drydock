/**
 * Validation application service tests (ADR 0022 M7a).
 *
 * The rules under test are the ones that live NOWHERE else: managed-policy
 * enforcement, the H5 delete guard, the availability ladder (including the
 * probe-before-first-job trigger), durable quarantine, the production-fixture
 * snapshot route, and the rail's one honest line. Everything runs against
 * fakes - the store is a map, the queue and probe suite are ports - because
 * none of these behaviors need a guest, and all of them need to be pinned.
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { asId } from "@drydock/contracts";
import type {
  NamedRuntimeConfig,
  NamedRuntimeUpdate,
  RuntimeAssociation,
  RuntimeAssociationSource,
  TaskId,
  ValidationJob,
  ValidationJobFilter,
  ValidationJobId,
  ValidationJobPatch,
  ValidationJobRequest,
  ValidationQuarantineRecord,
  ValidationReceipt,
  ValidationReceiptId,
  ValidationRegistrySettings,
  ValidationRegistrySettingsUpdate,
  ValidationRuntimeId,
  ValidationRuntimeStore,
  WorkspaceRootId
} from "@drydock/contracts";
import { MemoryLogger, type ProbeRunResult } from "@drydock/core";
import { EffectiveSecurityPolicy, type ValidationRuntimePolicy } from "./securityPolicy.js";
import {
  ValidationAppService,
  fixtureManifestHash,
  type ValidationAppServiceOptions,
  type ValidationJobsPort,
  type ValidationProbesPort
} from "./validationAppService.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class MemoryStore implements ValidationRuntimeStore {
  readonly runtimes: NamedRuntimeConfig[] = [];
  readonly associations: RuntimeAssociation[] = [];
  readonly jobs: ValidationJob[] = [];
  readonly receipts: ValidationReceipt[] = [];
  readonly overrides = new Map<string, ValidationRuntimeId>();
  readonly quarantines = new Map<string, ValidationQuarantineRecord>();
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

  async updateRuntime(runtimeId: ValidationRuntimeId, update: NamedRuntimeUpdate): Promise<void> {
    const index = this.runtimes.findIndex((runtime) => runtime.runtimeId === runtimeId);
    if (index < 0) throw new Error(`no such runtime ${runtimeId}`);
    const current = this.runtimes[index] as NamedRuntimeConfig;
    this.runtimes[index] = {
      ...current,
      ...(update.displayName === undefined ? {} : { displayName: update.displayName }),
      ...(update.image === undefined ? {} : { image: update.image }),
      ...(update.lifecycle === undefined ? {} : { lifecycle: update.lifecycle }),
      ...(update.capabilities === undefined ? {} : { capabilities: update.capabilities }),
      ...(update.policyProfileRef === undefined ? {} : { policyProfileRef: update.policyProfileRef }),
      ...(update.profileException === undefined ? {} : { profileException: update.profileException }),
      ...(update.archived === undefined ? {} : { archived: update.archived }),
      ...(update.connection === undefined || update.connection === null ? {} : { connection: update.connection }),
      updatedAt: update.updatedAt ?? current.updatedAt
    };
  }

  async archiveRuntime(runtimeId: ValidationRuntimeId, archived: boolean, updatedAt: string): Promise<void> {
    await this.updateRuntime(runtimeId, { archived, updatedAt });
  }

  async listAssociations(): Promise<RuntimeAssociation[]> {
    return [...this.associations];
  }

  async getAssociations(projectRootId: WorkspaceRootId): Promise<RuntimeAssociation[]> {
    return this.associations.filter((row) => row.projectRootId === projectRootId);
  }

  async upsertAssociation(record: RuntimeAssociation): Promise<void> {
    const index = this.associations.findIndex(
      (row) => row.projectRootId === record.projectRootId && row.source === record.source
    );
    if (index < 0) this.associations.push(record);
    else this.associations[index] = record;
  }

  async deleteAssociation(projectRootId: WorkspaceRootId, source?: RuntimeAssociationSource): Promise<void> {
    for (let index = this.associations.length - 1; index >= 0; index -= 1) {
      const row = this.associations[index] as RuntimeAssociation;
      if (row.projectRootId !== projectRootId) continue;
      if (source !== undefined && row.source !== source) continue;
      this.associations.splice(index, 1);
    }
  }

  async getSettings(): Promise<ValidationRegistrySettings> {
    return this.settings;
  }

  async setSettings(update: ValidationRegistrySettingsUpdate): Promise<void> {
    const next: Record<string, unknown> = { ...this.settings };
    for (const [key, value] of Object.entries(update)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    this.settings = next as unknown as ValidationRegistrySettings;
  }

  async getTaskOverride(taskId: TaskId): Promise<ValidationRuntimeId | null> {
    return this.overrides.get(String(taskId)) ?? null;
  }

  async setTaskOverride(taskId: TaskId, runtimeId: ValidationRuntimeId | null): Promise<void> {
    if (runtimeId === null) this.overrides.delete(String(taskId));
    else this.overrides.set(String(taskId), runtimeId);
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
    this.jobs[index] = { ...this.jobs[index], ...patch } as ValidationJob;
  }

  async listJobs(filter?: ValidationJobFilter): Promise<ValidationJob[]> {
    return this.jobs.filter((job) =>
      (filter?.taskId === undefined || job.taskId === filter.taskId)
      && (filter?.sessionId === undefined || job.sessionId === filter.sessionId)
      && (filter?.states === undefined || filter.states.includes(job.state)));
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
    throw new Error("not used");
  }
}

class FakeJobs implements ValidationJobsPort {
  readonly enqueued: ValidationJobRequest[] = [];
  readonly aborted: string[] = [];
  restored = 0;
  next: ValidationJob | null = null;

  async enqueue(request: ValidationJobRequest): Promise<ValidationJob | null> {
    this.enqueued.push(request);
    return this.next;
  }

  async abortJob(jobId: ValidationJobId): Promise<ValidationJob | null> {
    this.aborted.push(String(jobId));
    return null;
  }

  async requeueParked(): Promise<never> {
    throw new Error("not used");
  }

  async restore(): Promise<void> {
    this.restored += 1;
  }
}

class FakeProbes implements ValidationProbesPort {
  readonly runs: string[] = [];
  results = new Map<string, ProbeRunResult>();
  /** Fires on every run, so a test can make the suite quarantine mid-ladder. */
  onRun: ((runtime: NamedRuntimeConfig) => Promise<void>) | undefined;

  async runProbes(runtime: NamedRuntimeConfig): Promise<ProbeRunResult> {
    this.runs.push(String(runtime.runtimeId));
    await this.onRun?.(runtime);
    const result: ProbeRunResult = this.results.get(String(runtime.runtimeId)) ?? {
      runtimeId: runtime.runtimeId,
      probes: [
        {
          probeId: "probe.production-read",
          title: "Production is unreachable",
          kind: "must-fail",
          state: "pass",
          detail: "not reachable",
          at: "2026-08-12T09:00:00.000Z"
        }
      ],
      greenAt: "2026-08-12T09:00:00.000Z",
      at: "2026-08-12T09:00:00.000Z"
    };
    this.results.set(String(runtime.runtimeId), result);
    return result;
  }

  lastResult(runtimeId: ValidationRuntimeId): ProbeRunResult | undefined {
    return this.results.get(String(runtimeId));
  }

  probesGreenAt(runtimeId: ValidationRuntimeId): string | undefined {
    return this.results.get(String(runtimeId))?.greenAt;
  }

  shouldRun(): boolean {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const NOW = "2026-08-12T09:30:00.000Z";

function runtime(overrides: Partial<NamedRuntimeConfig> & { readonly displayName: string }): NamedRuntimeConfig {
  return {
    runtimeId: asId<"ValidationRuntimeId">(`vruntime-${overrides.displayName}`),
    image: "win11-maya",
    lifecycle: "keep-warm",
    capabilities: ["maya"],
    policyProfileRef: "validation-standard",
    connection: { host: "10.0.0.5", user: "drydock" },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function policy(validationRuntimes: ValidationRuntimePolicy): EffectiveSecurityPolicy {
  return new EffectiveSecurityPolicy({
    managed: true,
    deniedPaths: [],
    cloneOnly: false,
    allowNetworkedAiOnThisMachine: true,
    cloneOmission: { sensitive: false, paths: [] },
    validationRuntimes
  });
}

function build(overrides: Partial<ValidationAppServiceOptions> = {}): {
  readonly service: ValidationAppService;
  readonly store: MemoryStore;
  readonly jobs: FakeJobs;
  readonly probes: FakeProbes;
} {
  const store = (overrides.store as MemoryStore | undefined) ?? new MemoryStore();
  const jobs = (overrides.jobs as FakeJobs | undefined) ?? new FakeJobs();
  const probes = (overrides.probes as FakeProbes | undefined) ?? new FakeProbes();
  const service = new ValidationAppService({
    logger: new MemoryLogger(),
    clock: { isoNow: () => NOW },
    host: { supported: true, vmState: async () => "running" },
    fixtureStagingRoot: path.join(tmpdir(), "drydock-validation-tests-unused"),
    ids: { validationRuntimeId: () => asId<"ValidationRuntimeId">("vruntime-new") },
    ...overrides,
    // The three collaborators are always the ones this builder handed back, so
    // a test can assert against them whether or not it supplied them.
    store,
    jobs,
    probes
  });
  return { service, store, jobs, probes };
}

// ---------------------------------------------------------------------------
// Managed policy
// ---------------------------------------------------------------------------

test("managed topology pin refuses personal preset writes and reports the pin", async () => {
  const { service, store } = build({ securityPolicy: policy({ topologyPin: "default-plus-named" }) });
  await assert.rejects(
    () => service.setSettings({ topologyPreset: "per-project" }),
    /pins the validation topology to "default-plus-named"/
  );
  // The cap is still writable; only the pinned field is refused.
  await service.setSettings({ warmCap: 3 });
  assert.equal(store.settings.warmCap, 3);
  const state = await service.state();
  assert.equal(state.settings.topologyPreset, "default-plus-named");
  assert.equal(state.managed?.topologyPin, "default-plus-named");
});

test("effective warm cap is min(personal, managed)", async () => {
  const { service, store } = build({ securityPolicy: policy({ warmCap: 2 }) });
  await service.setSettings({ warmCap: 5 });
  assert.equal(store.settings.warmCap, 5, "the personal value is stored verbatim");
  assert.equal((await service.state()).settings.warmCap, 2, "the effective cap is the managed one");
  await service.setSettings({ warmCap: 1 });
  assert.equal((await service.state()).settings.warmCap, 1, "a narrower personal cap wins");
});

test("profile-exception creation is gated and the image allowlist is enforced", async () => {
  const { service } = build({
    securityPolicy: policy({ profileExceptionCreation: "disabled", imageAllowlist: ["win11-maya"] })
  });
  await assert.rejects(
    () => service.createRuntime({
      displayName: "production_tester",
      image: "win11-maya",
      lifecycle: "on-demand",
      capabilities: [],
      policyProfileRef: "validation-production",
      profileException: true
    }),
    /does not allow policy-profile exceptions/
  );
  await assert.rejects(
    () => service.createRuntime({
      displayName: "cpp-builds",
      image: "win11-msvc",
      lifecycle: "on-demand",
      capabilities: ["msvc"],
      policyProfileRef: "validation-standard"
    }),
    /allows "win11-maya" for validation runtimes/
  );
  // The allowed image goes through, and the first runtime becomes the default.
  const created = await service.createRuntime({
    displayName: "default",
    image: "win11-maya",
    lifecycle: "keep-warm",
    capabilities: ["maya"],
    policyProfileRef: "validation-standard"
  });
  const state = await service.state();
  assert.equal(state.runtimes[0]?.isDefault, true);
  assert.equal(state.settings.defaultRuntimeId, String(created.runtimeId));
});

test("an image outside the allowlist cannot be edited in either", async () => {
  const { service, store } = build({ securityPolicy: policy({ imageAllowlist: ["win11-maya"] }) });
  const existing = runtime({ displayName: "default" });
  store.runtimes.push(existing);
  await assert.rejects(
    () => service.updateRuntime(String(existing.runtimeId), { image: "win11-msvc" }),
    /allows "win11-maya" for validation runtimes/
  );
  await service.updateRuntime(String(existing.runtimeId), { displayName: "renamed" });
  assert.equal(store.runtimes[0]?.displayName, "renamed");
});

// ---------------------------------------------------------------------------
// Delete guard (H5)
// ---------------------------------------------------------------------------

test("the default runtime cannot be deleted and associations must be reassigned", async () => {
  const { service, store } = build();
  const fallback = runtime({ displayName: "default" });
  const named = runtime({ displayName: "cpp-builds" });
  store.runtimes.push(fallback, named);
  store.settings = { topologyPreset: "default-plus-named", defaultRuntimeId: fallback.runtimeId };
  store.associations.push({
    projectRootId: asId<"WorkspaceRootId">("project-a"),
    runtimeId: named.runtimeId,
    source: "personal",
    updatedAt: NOW
  });

  await assert.rejects(() => service.deleteRuntime(String(fallback.runtimeId)), /is the default runtime/);
  await assert.rejects(() => service.deleteRuntime(String(named.runtimeId)), /1 project currently routes to/);
  await assert.rejects(
    () => service.deleteRuntime(String(named.runtimeId), String(named.runtimeId)),
    /a different runtime than the one being removed/
  );

  await service.deleteRuntime(String(named.runtimeId), String(fallback.runtimeId));
  assert.equal(store.associations[0]?.runtimeId, fallback.runtimeId, "the association was repointed, never left dangling");
  assert.equal(store.runtimes.find((entry) => entry.runtimeId === named.runtimeId)?.archived, true);
});

// ---------------------------------------------------------------------------
// Task override
// ---------------------------------------------------------------------------

test("the task runtime override round-trips and clears", async () => {
  const { service, store } = build();
  const fallback = runtime({ displayName: "default" });
  const named = runtime({ displayName: "production_tester" });
  store.runtimes.push(fallback, named);
  store.settings = { topologyPreset: "default-plus-named", defaultRuntimeId: fallback.runtimeId };

  await service.setTaskRuntime("task-1", String(named.runtimeId));
  assert.equal(String(await service.getTaskRuntime("task-1")), String(named.runtimeId));
  const resolved = await service.resolvedRuntimeForTask("task-1");
  assert.equal(resolved.runtime?.displayName, "production_tester");
  assert.equal(resolved.differsFromDefault, true, "the header picker shows only when it differs");

  await service.setTaskRuntime("task-1");
  assert.equal(await service.getTaskRuntime("task-1"), null);
  const cleared = await service.resolvedRuntimeForTask("task-1");
  assert.equal(cleared.runtime?.displayName, "default");
  assert.equal(cleared.differsFromDefault, false);

  await assert.rejects(() => service.setTaskRuntime("task-1", "vruntime-ghost"), /not in the validation runtime registry/);
});

// ---------------------------------------------------------------------------
// Availability ladder
// ---------------------------------------------------------------------------

test("availability ladder: quarantine wins, then missing, then stopped, then a first probe", async () => {
  const { service, store, probes } = build({ host: { supported: true, vmState: async () => "running" } });
  const target = runtime({ displayName: "default" });
  store.runtimes.push(target);

  // Quarantine outranks a perfectly healthy VM.
  await store.setQuarantine(target.runtimeId, { probeId: "probe.egress", detail: "breach", at: NOW });
  assert.equal(await service.availabilityForJob(target), "quarantined");
  await store.setQuarantine(target.runtimeId, null);

  // The first job after a restart probes before it reports available.
  assert.equal(probes.runs.length, 0);
  assert.equal(await service.availabilityForJob(target), "available");
  assert.deepEqual(probes.runs, [String(target.runtimeId)]);
  // A second ask reuses the recorded run rather than probing again.
  assert.equal(await service.availabilityForJob(target), "available");
  assert.equal(probes.runs.length, 1);
});

test("a lazy probe that finds a breach blocks the very job that triggered it", async () => {
  const store = new MemoryStore();
  const probes = new FakeProbes();
  const target = runtime({ displayName: "default" });
  store.runtimes.push(target);
  const { service } = build({ store, probes });
  probes.onRun = async (candidate) => {
    await store.setQuarantine(candidate.runtimeId, {
      probeId: "probe.production-read",
      detail: "PRODUCTION READ SUCCEEDED",
      at: NOW
    });
  };
  assert.equal(await service.availabilityForJob(target), "quarantined");
});

test("a VM Hyper-V cannot find is missing; a stopped one is honest queue state", async () => {
  const store = new MemoryStore();
  const target = runtime({ displayName: "default" });
  store.runtimes.push(target);
  const missing = build({ store, host: { supported: true, vmState: async () => null } });
  assert.equal(await missing.service.availabilityForJob(target), "missing");

  const stopped = build({ store: new MemoryStore(), host: { supported: true, vmState: async () => "other" } });
  assert.equal(await stopped.service.availabilityForJob(target), "stopped");
  assert.equal(stopped.probes.runs.length, 0, "a stopped VM is not probed - the adapter boots it first");
});

test("a host that cannot answer renders unknown, never green", async () => {
  const store = new MemoryStore();
  store.runtimes.push(runtime({ displayName: "default" }));
  const { service } = build({ store, host: { supported: false } });
  const state = await service.state();
  assert.equal(state.hostSupported, false);
  assert.equal(state.runtimes[0]?.availability, "unknown");
});

test("runtime rows carry the VM name a TD must provision under", async () => {
  const store = new MemoryStore();
  store.runtimes.push(runtime({ displayName: "C++ Builds (MSVC)" }));
  const { service } = build({ store });
  assert.equal((await service.state()).runtimes[0]?.vmName, "drydock-validation-c-builds-msvc");
});

// ---------------------------------------------------------------------------
// Quarantine persistence
// ---------------------------------------------------------------------------

test("quarantine persists in the registry and only revert-and-reprobe clears it", async () => {
  const { service, store, probes } = build();
  const target = runtime({ displayName: "default" });
  store.runtimes.push(target);

  await service.quarantine(target.runtimeId, "probe.egress", "EGRESS SUCCEEDED: reached nas:445");
  const state = await service.state();
  assert.equal(state.quarantines.length, 1);
  assert.equal(state.quarantines[0]?.displayName, "default");
  assert.equal(state.quarantines[0]?.probeId, "probe.egress");
  assert.equal(state.runtimes[0]?.availability, "quarantined");

  await service.revertAndReprobe(String(target.runtimeId));
  assert.deepEqual(probes.runs, [String(target.runtimeId)], "clearing the flag re-runs the suite immediately");
  assert.equal((await service.state()).quarantines.length, 0);
});

// ---------------------------------------------------------------------------
// Rail status
// ---------------------------------------------------------------------------

test("rail status: no registry, blocked, running, failed, ready", async () => {
  const store = new MemoryStore();
  const probes = new FakeProbes();
  const { service } = build({ store, probes });

  assert.deepEqual(await service.railStatus(), { dot: "none", line: "No validation runtime is set up yet." });

  const target = runtime({ displayName: "default" });
  store.runtimes.push(target);
  store.settings = { topologyPreset: "single", defaultRuntimeId: target.runtimeId };

  // Ready, but nothing has verified isolation yet: the line says exactly that.
  const unverified = await service.railStatus("task-1");
  assert.equal(unverified.dot, "ok");
  assert.match(unverified.line, /isolation not verified yet/);

  probes.results.set(String(target.runtimeId), {
    runtimeId: target.runtimeId,
    probes: [],
    greenAt: "2026-08-12T09:00:00.000Z",
    at: "2026-08-12T09:00:00.000Z"
  });
  const ready = await service.railStatus("task-1");
  assert.equal(ready.dot, "ok");
  assert.match(ready.line, /Validation ready on default · queue 0 · isolation verified /);

  // A running job outranks the ready line.
  store.jobs.push({
    jobId: asId<"ValidationJobId">("vjob-1"),
    sessionId: asId<"SessionId">("session-1"),
    chatId: asId<"ChatId">("chat-1"),
    taskId: asId<"TaskId">("task-1"),
    resolvedRuntimeId: target.runtimeId,
    profileRef: "suite",
    changesetRef: "abc",
    state: "running",
    queuedAt: NOW,
    updatedAt: NOW
  });
  assert.equal((await service.railStatus("task-1")).dot, "running");

  // A parked job outranks everything except a quarantine.
  store.jobs[0] = { ...(store.jobs[0] as ValidationJob), state: "parked", parkedReason: "No exec connection yet." };
  const parked = await service.railStatus("task-1");
  assert.equal(parked.dot, "blocked");
  assert.equal(parked.line, "No exec connection yet.");

  // A completed failing run renders the promoted line (F2).
  const { parkedReason: _parked, ...withoutPark } = store.jobs[0] as ValidationJob;
  store.jobs[0] = { ...withoutPark, state: "completed", completedAt: NOW };
  store.receipts.push({
    receiptId: asId<"ValidationReceiptId">("vreceipt-1"),
    jobId: asId<"ValidationJobId">("vjob-1"),
    runtimeId: target.runtimeId,
    policyProfileRef: "validation-standard",
    changesetRef: "abc",
    licenseWaitMs: 0,
    verdict: "failed",
    failingTest: "test_icon_fallback",
    superseded: false,
    createdAt: NOW
  });
  const failed = await service.railStatus("task-1");
  assert.equal(failed.dot, "failed");
  assert.match(failed.line, /test_icon_fallback/);

  // The quarantine banner beats the failed verdict.
  await store.setQuarantine(target.runtimeId, { probeId: "probe.egress", detail: "EGRESS SUCCEEDED", at: NOW });
  const blocked = await service.railStatus("task-1");
  assert.equal(blocked.dot, "blocked");
  assert.match(blocked.line, /quarantined/);
});

// ---------------------------------------------------------------------------
// Jobs projection + manual run
// ---------------------------------------------------------------------------

test("job views carry the runtime name and the receipt evidence", async () => {
  const { service, store } = build();
  const target = runtime({ displayName: "default" });
  store.runtimes.push(target);
  store.jobs.push({
    jobId: asId<"ValidationJobId">("vjob-1"),
    sessionId: asId<"SessionId">("session-1"),
    chatId: asId<"ChatId">("chat-1"),
    taskId: asId<"TaskId">("task-1"),
    resolvedRuntimeId: target.runtimeId,
    receiptId: asId<"ValidationReceiptId">("vreceipt-1"),
    profileRef: "suite",
    changesetRef: "abc",
    state: "completed",
    queuedAt: NOW,
    completedAt: NOW,
    updatedAt: NOW
  });
  store.receipts.push({
    receiptId: asId<"ValidationReceiptId">("vreceipt-1"),
    jobId: asId<"ValidationJobId">("vjob-1"),
    runtimeId: target.runtimeId,
    policyProfileRef: "validation-standard",
    changesetRef: "abc",
    licenseWaitMs: 1_500,
    verdict: "passed",
    summary: "14 passed in 42s",
    superseded: false,
    createdAt: NOW
  });
  const [view] = await service.listJobs({ taskId: "task-1" });
  assert.equal(view?.runtimeDisplayName, "default");
  assert.equal(view?.receipt?.verdict, "passed");
  assert.equal(view?.receipt?.licenseWaitMs, 1_500);
  assert.equal(view?.receipt?.changesetRef, "abc");
});

test("a manual run without a configured profile names the setting instead of guessing", async () => {
  const { service } = build();
  await assert.rejects(() => service.runForSession("session-1"), /drydock\.validation\.defaultProfile/);
});

test("a manual run carries the task override and the session's staged fixtures", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "drydock-fixtures-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const store = new MemoryStore();
  const named = runtime({ displayName: "production_tester" });
  store.runtimes.push(named);
  const { service, jobs } = build({
    store,
    fixtureStagingRoot: directory,
    defaultProfile: () => ({ profileRef: "studio.smoke", argv: ["mayapy", "-m", "pytest"] }),
    sessionContext: async () => ({ chatId: "chat-1", taskId: "task-1" })
  });
  await service.setTaskRuntime("task-1", String(named.runtimeId));
  // Stands in for an approved grant: the staging directory is per session, and
  // whatever is in it at run time is what ships.
  const sessionDir = path.join(directory, "session-1");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(sessionDir, "hero_rig.ma"), "rig");

  await service.runForSession("session-1");
  const [request] = jobs.enqueued;
  assert.equal(String(request?.requestedRuntimeId), String(named.runtimeId), "the task override rides the request");
  assert.equal(request?.fixtures?.length, 1);
  assert.equal(request?.fixtures?.[0]?.relativePath, "hero_rig.ma");
  assert.equal(Buffer.from(request?.fixtures?.[0]?.contentBase64 ?? "", "base64").toString("utf8"), "rig");
  assert.ok((request?.fixtureManifestHash?.length ?? 0) > 0, "evidence records what was shipped");
});

// ---------------------------------------------------------------------------
// Production fixtures (A1/A2/A3/B1)
// ---------------------------------------------------------------------------

test("a production-tier approval copies the file, records the grant, and mounts nothing", async (t) => {
  const staging = await mkdtemp(path.join(tmpdir(), "drydock-fixtures-"));
  const production = await mkdtemp(path.join(tmpdir(), "drydock-production-"));
  t.after(async () => {
    await rm(staging, { recursive: true, force: true });
    await rm(production, { recursive: true, force: true });
  });
  const source = path.join(production, "hero rig.ma");
  await writeFile(source, "maya ascii");
  const events: { eventCode: string; metadata?: Record<string, unknown> }[] = [];
  const { service } = build({
    fixtureStagingRoot: staging,
    securityPolicy: new EffectiveSecurityPolicy({
      managed: true,
      deniedPaths: [production],
      // Production tier is the STUDIO data denial, not the whole denylist.
      productionDataPaths: [production],
      cloneOnly: false,
      allowNetworkedAiOnThisMachine: true,
      cloneOmission: { sensitive: false, paths: [] }
    }),
    securityEvent: (event) => {
      events.push({ eventCode: event.eventCode, ...(event.metadata === undefined ? {} : { metadata: event.metadata }) });
    }
  });

  assert.equal(service.isProductionPath(source), true);
  assert.equal(service.isProductionPath(path.join(tmpdir(), "elsewhere.ma")), false);

  const grant = await service.grantProductionFixture({ sessionId: "session-1", hostPath: source });
  assert.match(grant.relativePath, /\/hero_rig\.ma$/, "the staged basename never carries the source path");
  assert.equal(grant.bytes, "maya ascii".length);
  assert.equal(typeof grant.contentSha256, "string");
  assert.equal(
    await readFile(path.join(staging, "session-1", ...grant.relativePath.split("/")), "utf8"),
    "maya ascii"
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.eventCode, "fixture.granted");
  assert.equal(events[0]?.metadata?.["expiry"], "session-end");
  assert.equal(events[0]?.metadata?.["path"], source);

  // The manifest hash is over the staged set, so it matches an independent fold.
  const staged = await service.stagedFixtures("session-1");
  assert.equal(grant.manifestHash, fixtureManifestHash(staged));

  // Session-scoped means the copies go when the session does.
  await service.clearSessionFixtures("session-1");
  assert.deepEqual(await readdir(staging), []);
});

test("a folder request is refused with the narrower ask spelled out", async (t) => {
  const staging = await mkdtemp(path.join(tmpdir(), "drydock-fixtures-"));
  const production = await mkdtemp(path.join(tmpdir(), "drydock-production-"));
  t.after(async () => {
    await rm(staging, { recursive: true, force: true });
    await rm(production, { recursive: true, force: true });
  });
  const { service } = build({
    fixtureStagingRoot: staging,
    securityPolicy: new EffectiveSecurityPolicy({
      managed: true,
      deniedPaths: [production],
      productionDataPaths: [production],
      cloneOnly: false,
      allowNetworkedAiOnThisMachine: true,
      cloneOmission: { sensitive: false, paths: [] }
    })
  });
  await assert.rejects(
    () => service.grantProductionFixture({ sessionId: "session-1", hostPath: production }),
    /Ask for the specific file you need/
  );
  await assert.rejects(
    () => service.grantProductionFixture({ sessionId: "session-1", hostPath: path.join(production, "absent.ma") }),
    /could not be read/
  );
});

test("credential and sensitive paths are never production-tier, so keys cannot be snapshotted", async (t) => {
  const staging = await mkdtemp(path.join(tmpdir(), "drydock-fixtures-"));
  const production = await mkdtemp(path.join(tmpdir(), "drydock-production-"));
  t.after(async () => {
    await rm(staging, { recursive: true, force: true });
    await rm(production, { recursive: true, force: true });
  });
  // A managed studio denial covers the production data root only. Credential
  // and secret paths live in the base denylist, which is NOT production-tier.
  const secret = path.join(production, ".ssh", "id_rsa");
  const { service } = build({
    fixtureStagingRoot: staging,
    securityPolicy: new EffectiveSecurityPolicy({
      managed: true,
      deniedPaths: [production],
      productionDataPaths: [production],
      cloneOnly: false,
      allowNetworkedAiOnThisMachine: true,
      cloneOmission: { sensitive: false, paths: [] }
    })
  });
  // Even though the secret sits under a studio-denied root, a sensitive path is
  // never production-tier, so it cannot enter the snapshot flow.
  assert.equal(service.isProductionPath(secret), false);
  await assert.rejects(
    () => service.grantProductionFixture({ sessionId: "session-1", hostPath: secret }),
    /not a production-tier path/
  );
});

test("two grants sharing a basename never overwrite each other", async (t) => {
  const staging = await mkdtemp(path.join(tmpdir(), "drydock-fixtures-"));
  const production = await mkdtemp(path.join(tmpdir(), "drydock-production-"));
  t.after(async () => {
    await rm(staging, { recursive: true, force: true });
    await rm(production, { recursive: true, force: true });
  });
  const shotA = path.join(production, "010", "scene.ma");
  const shotB = path.join(production, "020", "scene.ma");
  await mkdir(path.dirname(shotA), { recursive: true });
  await mkdir(path.dirname(shotB), { recursive: true });
  await writeFile(shotA, "geometry A");
  await writeFile(shotB, "geometry B");
  const { service } = build({
    fixtureStagingRoot: staging,
    securityPolicy: new EffectiveSecurityPolicy({
      managed: true,
      deniedPaths: [production],
      productionDataPaths: [production],
      cloneOnly: false,
      allowNetworkedAiOnThisMachine: true,
      cloneOmission: { sensitive: false, paths: [] }
    })
  });
  const grantA = await service.grantProductionFixture({ sessionId: "session-1", hostPath: shotA });
  const grantB = await service.grantProductionFixture({ sessionId: "session-1", hostPath: shotB });
  assert.notEqual(grantA.relativePath, grantB.relativePath, "distinct sources get distinct staged paths");
  const staged = await service.stagedFixtures("session-1");
  assert.equal(staged.length, 2, "both grants survive; neither overwrote the other");
  const bytes = await Promise.all(
    staged.map((entry) => readFile(path.join(staging, "session-1", ...entry.relativePath.split("/")), "utf8"))
  );
  assert.deepEqual(bytes.sort(), ["geometry A", "geometry B"]);
});

test("the fixture manifest hash is order-independent and content-sensitive", () => {
  const a = fixtureManifestHash([
    { relativePath: "b.ma", bytes: 2, contentSha256: "bbb" },
    { relativePath: "a.ma", bytes: 1, contentSha256: "aaa" }
  ]);
  const b = fixtureManifestHash([
    { relativePath: "a.ma", bytes: 1, contentSha256: "aaa" },
    { relativePath: "b.ma", bytes: 2, contentSha256: "bbb" }
  ]);
  assert.equal(a, b);
  assert.notEqual(a, fixtureManifestHash([
    { relativePath: "a.ma", bytes: 1, contentSha256: "aaa" },
    { relativePath: "b.ma", bytes: 2, contentSha256: "ccc" }
  ]));
});

// ---------------------------------------------------------------------------
// Boot + cadence
// ---------------------------------------------------------------------------

test("restore reloads the queue and arms one cadence timer", async () => {
  let handler: (() => void) | undefined;
  let cleared = 0;
  const store = new MemoryStore();
  // A runtime with no exec address is never scheduled: probing it would only
  // ever report `unknown`, which is noise, not evidence.
  const { connection: _address, ...addressless } = runtime({ displayName: "addressless" });
  store.runtimes.push(
    runtime({ displayName: "warm" }),
    runtime({ displayName: "cold", lifecycle: "on-demand" }),
    addressless
  );
  const { service, jobs, probes } = build({
    store,
    timers: {
      set: (fn) => { handler = fn; return "timer"; },
      clear: () => { cleared += 1; }
    }
  });
  await service.restore();
  assert.equal(jobs.restored, 1);
  assert.ok(handler !== undefined, "the cadence timer is armed behind the restore");

  await service.runScheduledProbes();
  assert.deepEqual(
    probes.runs,
    [String(store.runtimes[0]?.runtimeId)],
    "only addressable keep-warm/pinned runtimes are probed on a schedule"
  );

  service.dispose();
  assert.equal(cleared, 1);
});

// ---------------------------------------------------------------------------
// Associations
// ---------------------------------------------------------------------------

test("a pinned managed association cannot be overwritten or cleared personally", async () => {
  const { service, store } = build();
  const target = runtime({ displayName: "default" });
  store.runtimes.push(target);
  store.associations.push({
    projectRootId: asId<"WorkspaceRootId">("project-a"),
    runtimeId: target.runtimeId,
    source: "managed",
    pinned: true,
    updatedAt: NOW
  });
  await assert.rejects(() => service.setAssociation("project-a", String(target.runtimeId)), /pins this project/);
  await assert.rejects(() => service.clearAssociation("project-a"), /pins this project/);

  await service.setAssociation("project-b", String(target.runtimeId));
  const state = await service.state();
  const row = state.associations.find((entry) => entry.projectRootId === "project-b");
  assert.equal(row?.source, "personal");
  await service.clearAssociation("project-b");
  assert.equal((await service.state()).associations.length, 1);
});
