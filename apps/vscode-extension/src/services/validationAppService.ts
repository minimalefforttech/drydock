/**
 * Validation-runtime application service (ADR 0022 M7a).
 *
 * The host-side seam between the panels and the four landed pieces: the
 * registry store, `ValidationJobService`, `ValidationProbeService`, and the
 * Hyper-V adapter. Panels never touch those directly - they ask this service,
 * which owns the rules that are neither pure routing nor pure storage:
 *
 * - **Managed policy is enforced HERE.** `EffectiveSecurityPolicy.validationRuntimes`
 *   pins the topology, caps warm VMs, gates profile-exception creation, and
 *   restricts images. Every refusal names the policy in one sentence a TD can
 *   act on (ux-flows communication spec).
 * - **Nothing dangles.** Deleting a runtime with associations requires naming
 *   where they go (edge case H5); the default cannot be deleted at all.
 * - **Quarantine is durable.** A breach found at 09:12 must still block the
 *   queue after a window reload, so the flag lives in the registry KV, not in a
 *   process (edge case E5). Only an explicit revert-and-reprobe clears it.
 * - **Unknown is never green** (ADR 0021, edge case G2). A runtime whose VM we
 *   cannot ask about reports `unknown`, and the rail's line says what was
 *   actually verified rather than implying a check that never ran.
 *
 * ## VM naming
 *
 * A validation runtime is ADOPTED, never created (M3). The Hyper-V VM it adopts
 * is named `drydock-validation-<display-name-slug>` - the convention the
 * maintenance runbook already tells TDs to provision under. `vmNameFor` is the
 * one place that convention lives, and every runtime row carries the resulting
 * name so the panel can show a TD exactly what to call the VM.
 *
 * KNOWN COUPLING (open for M8b): because the name is DERIVED from the display
 * name, renaming a runtime re-points it at a differently-named VM, which then
 * reads as `missing` until the VM is renamed to match. That is narrower than
 * edge case H5's promise that renaming is display-only - identity really is the
 * id, and associations, jobs, and receipts are all unaffected - but the adopted
 * VM is currently found by name. The fix is a durable `vmName` captured at adopt
 * time rather than derived; until then the row shows the expected name so the
 * mismatch is visible rather than mysterious.
 *
 * ## Fixtures are copies, never mounts
 *
 * Approving access to a production-tier path does NOT add a mount (edge cases
 * A1/B1): the file is copied host-side into `<stateRoot>/state/fixtures/<sessionId>/`,
 * a `fixture.granted` security event records the grant, and the copy ships into
 * the job's own fixture directory, which is wiped with the job. The staging
 * directory is dropped when the session ends, which is what "session-scoped"
 * means in the approval card's copy.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  asId,
  type NamedRuntimeConfig,
  type NamedRuntimeUpdate,
  type RuntimeAssociation,
  type SessionId,
  type ValidationConfigState,
  type ValidationJob,
  type ValidationJobId,
  type ValidationJobRequest,
  type ValidationJobView,
  type ValidationProbeLine,
  type ValidationProfile,
  type ValidationQuarantineRecord,
  type ValidationRailDot,
  type ValidationRegistrySettings,
  type ValidationRequeueView,
  type ValidationRuntimeAvailability,
  type ValidationRuntimeId,
  type ValidationRuntimeLifecycle,
  type ValidationRuntimeRow,
  type ValidationRuntimeStore,
  type ValidationTopologyPreset
} from "@drydock/contracts";
import {
  pickAssociation,
  validateDelete,
  type Logger,
  type ProbeRunResult,
  type ProductEventBus,
  type ValidationRequeueResult
} from "@drydock/core";
import type { EffectiveSecurityPolicy } from "./securityPolicy.js";

/** Default probe cadence: four times a day is enough for a standing invariant. */
const DEFAULT_PROBE_CADENCE_MS = 6 * 60 * 60 * 1000;
/** One fixture may not exceed this; bigger asks get the "narrow it" message (A2). */
const MAX_FIXTURE_BYTES = 2 * 1024 * 1024 * 1024;
/** Above this we record the grant without a content hash rather than stalling. */
const FIXTURE_HASH_BUDGET_BYTES = 256 * 1024 * 1024;
/** Job states that mean work is happening right now (drives the rail's ▶). */
const ACTIVE_JOB_STATES = new Set(["queued", "starting", "syncing", "resolving", "running", "license-wait"]);

/** Host capabilities this service needs to actually reach a validation runtime. */
export interface ValidationHostPorts {
  /** False off Windows or when ssh/powershell discovery failed. */
  readonly supported: boolean;
  /**
   * The VM's state by name, or `null` when Hyper-V does not have it.
   * `undefined` (the port itself absent) means we cannot ask at all, which
   * renders as `unknown` - never as a guess.
   */
  readonly vmState?: (vmName: string) => Promise<"running" | "other" | null>;
}

/** One project the association editor can route (the catalog's own rows). */
export interface ValidationProjectRef {
  readonly projectRootId: string;
  readonly label: string;
}

/** What a session contributes to a job request; `null` = no such session. */
export interface ValidationSessionContext {
  readonly chatId: string;
  readonly taskId?: string;
  readonly subtaskId?: string;
  readonly projectRootId?: string;
}

/** The append-only security ledger, structurally (composition binds the store). */
export type ValidationSecurityEvent = (event: {
  readonly eventCode: string;
  readonly outcome: "succeeded" | "failed" | "allowed" | "denied";
  readonly sessionId?: SessionId;
  readonly metadata?: Record<string, unknown>;
}) => void;

/** Injectable interval so the cadence timer is testable without real waiting. */
export interface ValidationIntervalTimers {
  set(handler: () => void, ms: number): unknown;
  clear(token: unknown): void;
}

/**
 * The queue, structurally - `ValidationJobService` satisfies it. Expressed as a
 * port so this service's rules (managed policy, the delete guard, the rail) are
 * testable without standing up a guest exec channel.
 */
export interface ValidationJobsPort {
  enqueue(request: ValidationJobRequest): Promise<ValidationJob | null>;
  abortJob(jobId: ValidationJobId): Promise<ValidationJob | null>;
  requeueParked(
    jobId: ValidationJobId,
    opts?: { readonly rerouteTo?: ValidationRuntimeId; readonly confirmedDelta?: boolean }
  ): Promise<ValidationRequeueResult>;
  restore(): Promise<void>;
}

/** The probe suite, structurally - `ValidationProbeService` satisfies it. */
export interface ValidationProbesPort {
  runProbes(runtime: NamedRuntimeConfig): Promise<ProbeRunResult>;
  lastResult(runtimeId: ValidationRuntimeId): ProbeRunResult | undefined;
  probesGreenAt(runtimeId: ValidationRuntimeId): string | undefined;
  shouldRun(runtimeId: ValidationRuntimeId, cadenceMs: number, now?: string): boolean;
}

export interface ValidationAppServiceOptions {
  readonly logger: Logger;
  readonly clock: { isoNow(): string };
  readonly store: ValidationRuntimeStore;
  readonly jobs: ValidationJobsPort;
  readonly probes: ValidationProbesPort;
  readonly bus?: ProductEventBus;
  readonly host: ValidationHostPorts;
  /** Activation-time policy snapshot; absent means no managed limits. */
  readonly securityPolicy?: EffectiveSecurityPolicy;
  /** Projects offered by the association editor. */
  readonly projects?: () => Promise<readonly ValidationProjectRef[]>;
  /** The task's project, for the association tier of the cascade. */
  readonly taskProjectRootId?: (taskId: string) => Promise<string | undefined>;
  /** The personal `drydock.validation.defaultProfile` setting, parsed. */
  readonly defaultProfile?: () => ValidationProfile | undefined;
  readonly sessionContext?: (sessionId: string) => Promise<ValidationSessionContext | null>;
  /** `<stateRoot>/state/fixtures` - the host-side staging root for snapshots. */
  readonly fixtureStagingRoot: string;
  readonly securityEvent?: ValidationSecurityEvent;
  readonly ids?: { validationRuntimeId(): ValidationRuntimeId };
  readonly probeCadenceMs?: number;
  readonly timers?: ValidationIntervalTimers;
}

/** One staged fixture file, as `stagedFixtures` reports it. */
export interface StagedFixture {
  readonly relativePath: string;
  readonly bytes: number;
  readonly contentSha256?: string;
}

/** What a production-tier approval actually produced (the provenance chip). */
export interface ProductionFixtureGrant {
  readonly relativePath: string;
  readonly bytes: number;
  readonly contentSha256?: string;
  /** Hash over the whole staged set, as the receipt records it. */
  readonly manifestHash: string;
}

export class ValidationAppService {
  /** In-flight lazy probe per runtime, so one job burst runs one suite. */
  private readonly probingOnce = new Map<string, Promise<void>>();
  private cadenceTimer: unknown;
  private readonly subscriptions: (() => void)[] = [];

  constructor(private readonly options: ValidationAppServiceOptions) {
    // Fixtures expire with the session (edge case B2): when a session goes, so
    // does its staging directory. Failures are logged - a leftover copy is a
    // hygiene problem, not a reason to fail session deletion.
    const unsubscribe = options.bus?.subscribe((event) => {
      if (event.kind !== "session-deleted") return;
      void this.clearSessionFixtures(event.sessionId).catch((error: unknown) => {
        options.logger.warn("validation fixture cleanup failed", {
          sessionId: event.sessionId,
          error: messageOf(error)
        });
      });
    });
    if (unsubscribe !== undefined) this.subscriptions.push(unsubscribe);
  }

  dispose(): void {
    if (this.cadenceTimer !== undefined) {
      (this.options.timers ?? SYSTEM_INTERVALS).clear(this.cadenceTimer);
      this.cadenceTimer = undefined;
    }
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions.length = 0;
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  /**
   * Reloads the queue after activation and arms the probe cadence. Called once
   * the rest of the world has reconciled, so restored jobs start against a
   * settled registry.
   */
  async restore(): Promise<void> {
    await this.options.jobs.restore();
    this.startProbeCadence();
  }

  /** Arms the scheduled probe trigger (M6's "scheduled" case). Idempotent. */
  startProbeCadence(): void {
    if (this.cadenceTimer !== undefined || !this.options.host.supported) return;
    const cadenceMs = this.options.probeCadenceMs ?? DEFAULT_PROBE_CADENCE_MS;
    if (cadenceMs <= 0) return;
    const timers = this.options.timers ?? SYSTEM_INTERVALS;
    this.cadenceTimer = timers.set(() => {
      void this.runScheduledProbes().catch((error: unknown) => {
        this.options.logger.warn("scheduled validation probes failed", { error: messageOf(error) });
      });
    }, cadenceMs);
  }

  /**
   * One cadence tick: probes the runtimes that are supposed to be up
   * (`keep-warm`/`pinned`, with an exec address) and whose last run is older
   * than the cadence. On-demand runtimes are probed when a job wakes them, not
   * on a clock - starting a VM to prove it is isolated would be the tail wagging
   * the dog.
   */
  async runScheduledProbes(): Promise<void> {
    const cadenceMs = this.options.probeCadenceMs ?? DEFAULT_PROBE_CADENCE_MS;
    const now = this.options.clock.isoNow();
    for (const runtime of await this.options.store.listRuntimes(false)) {
      if (runtime.connection === undefined) continue;
      if (runtime.lifecycle !== "keep-warm" && runtime.lifecycle !== "pinned") continue;
      if (!this.options.probes.shouldRun(runtime.runtimeId, cadenceMs, now)) continue;
      try {
        await this.options.probes.runProbes(runtime);
      } catch (error) {
        this.options.logger.warn("validation probe run failed", {
          runtimeId: runtime.runtimeId,
          error: messageOf(error)
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Availability
  // -------------------------------------------------------------------------

  /**
   * The availability the JOB service routes on. The ladder is deliberate:
   * quarantine outranks everything (a blocked queue is the point), a VM Hyper-V
   * cannot find is `missing` (the one availability that parks), an off VM is
   * `stopped` (honest queue state - the adapter boots it), and `available` is
   * only reported after the probe suite has run at least once in this process.
   *
   * That last step is the "probe before the first job after a restart" trigger:
   * `probesGreenAt` is in-memory by design, so a fresh host has no evidence that
   * the guest is still isolated until it asks.
   */
  async availabilityForJob(runtime: NamedRuntimeConfig): Promise<ValidationRuntimeAvailability> {
    const quarantined = await this.options.store.getQuarantine(runtime.runtimeId);
    if (quarantined !== null) return "quarantined";
    const vm = await this.readVmState(runtime);
    if (vm === "missing") return "missing";
    if (vm === "stopped") return "stopped";
    await this.ensureProbedOnce(runtime);
    // The lazy probe may have just raised an incident; re-read rather than
    // reporting the state we sampled before asking.
    return (await this.options.store.getQuarantine(runtime.runtimeId)) === null ? "available" : "quarantined";
  }

  /** The cheap ladder the panel renders: no probes, no VM boots, no guessing. */
  private async availabilityForRow(runtime: NamedRuntimeConfig): Promise<ValidationRuntimeRow["availability"]> {
    if ((await this.options.store.getQuarantine(runtime.runtimeId)) !== null) return "quarantined";
    const vm = await this.readVmState(runtime);
    return vm === "unknown" ? "unknown" : vm;
  }

  private async readVmState(runtime: NamedRuntimeConfig): Promise<"missing" | "stopped" | "available" | "unknown"> {
    const query = this.options.host.vmState;
    if (!this.options.host.supported || query === undefined) return "unknown";
    try {
      const state = await query(this.vmNameFor(runtime));
      if (state === null) return "missing";
      return state === "running" ? "available" : "stopped";
    } catch (error) {
      this.options.logger.warn("validation runtime state query failed", {
        runtimeId: runtime.runtimeId,
        error: messageOf(error)
      });
      return "unknown";
    }
  }

  /** Single-flight per runtime; a failure is logged and never blocks a job. */
  private async ensureProbedOnce(runtime: NamedRuntimeConfig): Promise<void> {
    if (this.options.probes.lastResult(runtime.runtimeId) !== undefined) return;
    const key = String(runtime.runtimeId);
    const running = this.probingOnce.get(key);
    if (running !== undefined) {
      await running;
      return;
    }
    const attempt = this.options.probes.runProbes(runtime)
      .then(() => undefined)
      .catch((error: unknown) => {
        this.options.logger.warn("first-job validation probe failed", {
          runtimeId: runtime.runtimeId,
          error: messageOf(error)
        });
      })
      .finally(() => {
        this.probingOnce.delete(key);
      });
    this.probingOnce.set(key, attempt);
    await attempt;
  }

  /**
   * The Hyper-V VM name for a runtime: `drydock-validation-<slug>`. Documented
   * in the maintenance runbook and surfaced on every row, so provisioning a VM
   * is "name it this" rather than "guess what the product will look for".
   */
  vmNameFor(runtime: Pick<NamedRuntimeConfig, "displayName">): string {
    const slug = runtime.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return `drydock-validation-${slug === "" ? "runtime" : slug}`;
  }

  // -------------------------------------------------------------------------
  // Registry reads
  // -------------------------------------------------------------------------

  /** Everything the Configure panel's Validation section renders, in one read. */
  async state(): Promise<ValidationConfigState> {
    const [runtimes, associations, stored, jobs, projects] = await Promise.all([
      this.options.store.listRuntimes(true),
      this.options.store.listAssociations(),
      this.options.store.getSettings(),
      this.options.store.listJobs({ states: ["queued", "starting", "syncing", "resolving", "running", "license-wait"] }),
      this.options.projects?.() ?? Promise.resolve([])
    ]);
    const managed = this.options.securityPolicy?.validationRuntimes;
    const queueDepth = new Map<string, number>();
    for (const job of jobs) {
      if (job.resolvedRuntimeId === undefined) continue;
      queueDepth.set(String(job.resolvedRuntimeId), (queueDepth.get(String(job.resolvedRuntimeId)) ?? 0) + 1);
    }
    const rows: ValidationRuntimeRow[] = [];
    const quarantines: ValidationQuarantineRow[] = [];
    for (const runtime of runtimes) {
      const quarantine = await this.options.store.getQuarantine(runtime.runtimeId);
      if (quarantine !== null) {
        quarantines.push({
          runtimeId: String(runtime.runtimeId),
          displayName: runtime.displayName,
          probeId: quarantine.probeId,
          detail: quarantine.detail,
          at: quarantine.at
        });
      }
      const probes = this.probeSummary(runtime.runtimeId);
      rows.push({
        runtimeId: String(runtime.runtimeId),
        displayName: runtime.displayName,
        image: runtime.image,
        lifecycle: runtime.lifecycle,
        capabilities: [...runtime.capabilities],
        policyProfileRef: runtime.policyProfileRef,
        ...(runtime.profileException === true ? { profileException: true } : {}),
        ...(runtime.archived === true ? { archived: true } : {}),
        isDefault: stored.defaultRuntimeId === runtime.runtimeId,
        vmName: this.vmNameFor(runtime),
        ...(runtime.connection === undefined ? {} : { connectionHost: runtime.connection.host }),
        availability: await this.availabilityForRow(runtime),
        queueDepth: queueDepth.get(String(runtime.runtimeId)) ?? 0,
        ...(probes === undefined ? {} : { probes })
      });
    }
    const labels = new Map(projects.map((project) => [project.projectRootId, project.label]));
    const effective = this.effectiveSettings(stored);
    return {
      hostSupported: this.options.host.supported,
      runtimes: rows,
      associations: associations.map((row) => ({
        projectRootId: String(row.projectRootId),
        projectLabel: labels.get(String(row.projectRootId)) ?? String(row.projectRootId),
        runtimeId: String(row.runtimeId),
        source: row.source,
        ...(row.pinned === true ? { pinned: true } : {})
      })),
      projects: projects.map((project) => ({ projectRootId: project.projectRootId, label: project.label })),
      settings: {
        ...(effective.defaultRuntimeId === undefined ? {} : { defaultRuntimeId: String(effective.defaultRuntimeId) }),
        topologyPreset: effective.topologyPreset,
        ...(effective.warmCap === undefined ? {} : { warmCap: effective.warmCap }),
        // The input edits the PERSONAL cap; the effective value alone would
        // read as a broken control whenever a lower studio cap applies.
        ...(stored.warmCap === undefined ? {} : { personalWarmCap: stored.warmCap })
      },
      ...(managed === undefined ? {} : {
        managed: {
          ...(managed.topologyPin === undefined ? {} : { topologyPin: managed.topologyPin }),
          ...(managed.warmCap === undefined ? {} : { warmCap: managed.warmCap }),
          ...(managed.profileExceptionCreation === undefined
            ? {}
            : { profileExceptionCreation: managed.profileExceptionCreation }),
          ...(managed.imageAllowlist === undefined ? {} : { imageAllowlist: [...managed.imageAllowlist] })
        }
      }),
      quarantines
    };
  }

  /**
   * Stored settings narrowed by managed policy: a pin replaces the preset, and
   * the warm cap is `min(personal, managed)` - personal narrowing, managed
   * authority, exactly like every other policy layer.
   */
  effectiveSettings(stored: ValidationRegistrySettings): ValidationRegistrySettings {
    const managed = this.options.securityPolicy?.validationRuntimes;
    if (managed === undefined) return stored;
    const warmCap = managed.warmCap === undefined
      ? stored.warmCap
      : stored.warmCap === undefined
        ? managed.warmCap
        : Math.min(stored.warmCap, managed.warmCap);
    return {
      ...stored,
      ...(managed.topologyPin === undefined ? {} : { topologyPreset: managed.topologyPin }),
      ...(warmCap === undefined ? {} : { warmCap })
    };
  }

  private probeSummary(runtimeId: ValidationRuntimeId): ValidationRuntimeRow["probes"] {
    const last = this.options.probes.lastResult(runtimeId);
    if (last === undefined) return undefined;
    return {
      state: worstProbeState(last),
      at: last.at,
      ...(last.greenAt === undefined ? {} : { greenAt: last.greenAt }),
      lines: last.probes.map((probe): ValidationProbeLine => ({
        probeId: probe.probeId,
        title: probe.title,
        state: probe.state,
        detail: probe.detail
      }))
    };
  }

  // -------------------------------------------------------------------------
  // Registry writes (managed policy is enforced here)
  // -------------------------------------------------------------------------

  async createRuntime(input: {
    readonly displayName: string;
    readonly image: string;
    readonly lifecycle: ValidationRuntimeLifecycle;
    readonly capabilities: readonly string[];
    readonly policyProfileRef: string;
    readonly profileException?: boolean;
    readonly connection?: { readonly host: string; readonly port?: number; readonly user: string };
  }): Promise<NamedRuntimeConfig> {
    this.assertImageAllowed(input.image);
    if (input.profileException === true) this.assertProfileExceptionAllowed();
    const now = this.options.clock.isoNow();
    const runtimeId = (this.options.ids ?? DEFAULT_IDS).validationRuntimeId();
    const record: NamedRuntimeConfig = {
      runtimeId,
      displayName: input.displayName,
      image: input.image,
      lifecycle: input.lifecycle,
      capabilities: [...input.capabilities],
      policyProfileRef: input.policyProfileRef,
      ...(input.connection === undefined ? {} : { connection: input.connection }),
      ...(input.profileException === true ? { profileException: true } : {}),
      createdAt: now,
      updatedAt: now
    };
    await this.options.store.insertRuntime(record);
    // The first runtime becomes the default: a registry with runtimes and no
    // default parks every job, which is a trap rather than a choice.
    const settings = await this.options.store.getSettings();
    if (settings.defaultRuntimeId === undefined) {
      await this.options.store.setSettings({ defaultRuntimeId: runtimeId }, now);
    }
    this.announce();
    return record;
  }

  async updateRuntime(runtimeId: string, update: {
    readonly displayName?: string;
    readonly image?: string;
    readonly lifecycle?: ValidationRuntimeLifecycle;
    readonly capabilities?: readonly string[];
    readonly policyProfileRef?: string;
    readonly profileException?: boolean;
    readonly archived?: boolean;
    readonly connection?: { readonly host: string; readonly port?: number; readonly user: string } | null;
  }): Promise<void> {
    const id = asId<"ValidationRuntimeId">(runtimeId);
    const existing = await this.options.store.getRuntime(id);
    if (existing === null) throw new Error(`"${runtimeId}" is not in the validation runtime registry.`);
    if (update.image !== undefined) this.assertImageAllowed(update.image);
    if (update.profileException === true && existing.profileException !== true) this.assertProfileExceptionAllowed();
    const patch: NamedRuntimeUpdate = {
      ...(update.displayName === undefined ? {} : { displayName: update.displayName }),
      ...(update.image === undefined ? {} : { image: update.image }),
      ...(update.lifecycle === undefined ? {} : { lifecycle: update.lifecycle }),
      ...(update.capabilities === undefined ? {} : { capabilities: [...update.capabilities] }),
      ...(update.policyProfileRef === undefined ? {} : { policyProfileRef: update.policyProfileRef }),
      ...(update.profileException === undefined ? {} : { profileException: update.profileException }),
      ...(update.archived === undefined ? {} : { archived: update.archived }),
      ...(update.connection === undefined ? {} : { connection: update.connection }),
      updatedAt: this.options.clock.isoNow()
    };
    await this.options.store.updateRuntime(id, patch);
    this.announce();
  }

  /**
   * Removes a runtime from routing (edge case H5). Two guards, both loud:
   * the default cannot be removed at all, and a runtime other projects route to
   * needs a reassignment target so no association is left dangling.
   *
   * "Delete" archives: evidence and receipts keep referring to the runtime that
   * actually ran them, so the row must survive even when it stops resolving.
   */
  async deleteRuntime(runtimeId: string, reassignTo?: string): Promise<void> {
    const id = asId<"ValidationRuntimeId">(runtimeId);
    const [runtimes, associations, settings] = await Promise.all([
      this.options.store.listRuntimes(true),
      this.options.store.listAssociations(),
      this.options.store.getSettings()
    ]);
    const check = validateDelete(id, runtimes, associations, settings);
    if (!check.ok) throw new Error(check.detail);
    const affected = associations.filter((row) => row.runtimeId === id);
    if (affected.length > 0) {
      if (reassignTo === undefined) {
        throw new Error(`${check.detail} Choose the runtime they should use, then remove this one.`);
      }
      const target = await this.options.store.getRuntime(asId<"ValidationRuntimeId">(reassignTo));
      if (target === null) throw new Error(`"${reassignTo}" is not in the validation runtime registry.`);
      if (target.runtimeId === id) throw new Error("Reassign the affected projects to a different runtime than the one being removed.");
      const now = this.options.clock.isoNow();
      for (const row of affected) {
        await this.options.store.upsertAssociation({ ...row, runtimeId: target.runtimeId, updatedAt: now });
      }
    }
    await this.options.store.archiveRuntime(id, true, this.options.clock.isoNow());
    this.announce();
  }

  async setDefault(runtimeId: string): Promise<void> {
    const id = asId<"ValidationRuntimeId">(runtimeId);
    const runtime = await this.options.store.getRuntime(id);
    if (runtime === null) throw new Error(`"${runtimeId}" is not in the validation runtime registry.`);
    if (runtime.archived === true) {
      throw new Error(`"${runtime.displayName}" is archived, so it cannot be the default runtime. Restore it first.`);
    }
    await this.options.store.setSettings({ defaultRuntimeId: id }, this.options.clock.isoNow());
    this.announce();
  }

  async setSettings(update: { readonly topologyPreset?: ValidationTopologyPreset; readonly warmCap?: number | null }): Promise<void> {
    const managed = this.options.securityPolicy?.validationRuntimes;
    if (update.topologyPreset !== undefined && managed?.topologyPin !== undefined) {
      throw new Error(
        `Studio policy pins the validation topology to "${managed.topologyPin}", so it cannot be changed on this workstation.`
      );
    }
    await this.options.store.setSettings(
      {
        ...(update.topologyPreset === undefined ? {} : { topologyPreset: update.topologyPreset }),
        ...(update.warmCap === undefined ? {} : { warmCap: update.warmCap })
      },
      this.options.clock.isoNow()
    );
    this.announce();
  }

  /** Personal associations only; managed rows arrive with policy (edge case H6). */
  async setAssociation(projectRootId: string, runtimeId: string): Promise<void> {
    const id = asId<"ValidationRuntimeId">(runtimeId);
    const runtime = await this.options.store.getRuntime(id);
    if (runtime === null) throw new Error(`"${runtimeId}" is not in the validation runtime registry.`);
    const project = asId<"WorkspaceRootId">(projectRootId);
    const rows = await this.options.store.getAssociations(project);
    const pinned = rows.find((row) => row.source === "managed" && row.pinned === true);
    if (pinned !== undefined) {
      throw new Error("Studio policy pins this project's validation runtime, so it cannot be changed here.");
    }
    const record: RuntimeAssociation = {
      projectRootId: project,
      runtimeId: id,
      source: "personal",
      updatedAt: this.options.clock.isoNow()
    };
    await this.options.store.upsertAssociation(record);
    this.announce();
  }

  async clearAssociation(projectRootId: string): Promise<void> {
    const project = asId<"WorkspaceRootId">(projectRootId);
    const rows = await this.options.store.getAssociations(project);
    const pinned = rows.find((row) => row.source === "managed" && row.pinned === true);
    if (pinned !== undefined) {
      throw new Error("Studio policy pins this project's validation runtime, so it cannot be cleared here.");
    }
    await this.options.store.deleteAssociation(project, "personal");
    this.announce();
  }

  private assertImageAllowed(image: string): void {
    const allowlist = this.options.securityPolicy?.validationRuntimes?.imageAllowlist;
    if (allowlist === undefined || allowlist.includes(image)) return;
    const listed = allowlist.length === 0 ? "no images" : allowlist.map((entry) => `"${entry}"`).join(", ");
    throw new Error(`Studio policy allows ${listed} for validation runtimes, so "${image}" cannot be used here.`);
  }

  private assertProfileExceptionAllowed(): void {
    const gate = this.options.securityPolicy?.validationRuntimes?.profileExceptionCreation;
    if (gate !== "disabled") return;
    throw new Error("Studio policy does not allow policy-profile exceptions to be created on this workstation.");
  }

  // -------------------------------------------------------------------------
  // Probes + quarantine
  // -------------------------------------------------------------------------

  async runProbes(runtimeId: string): Promise<ProbeRunResult> {
    const runtime = await this.requireRuntime(runtimeId);
    const result = await this.options.probes.runProbes(runtime);
    this.announce();
    return result;
  }

  /**
   * The probe service's incident hook: writes the durable flag BEFORE the
   * banner event fires, so a UI reacting to the event always finds a blocked
   * queue rather than one that is about to be blocked.
   */
  async quarantine(runtimeId: ValidationRuntimeId, probeId: string, detail: string): Promise<void> {
    const at = this.options.clock.isoNow();
    const payload: ValidationQuarantineRecord = { probeId, detail, at };
    await this.options.store.setQuarantine(runtimeId, payload, at);
  }

  /**
   * F5's "revert & re-probe" action. v1 clears the quarantine flag and runs the
   * suite again; reverting the guest to its clean checkpoint is still a runbook
   * step a TD performs, so the button copy must say exactly that rather than
   * implying the product rebuilt anything.
   */
  async revertAndReprobe(runtimeId: string): Promise<ProbeRunResult> {
    const runtime = await this.requireRuntime(runtimeId);
    await this.options.store.setQuarantine(runtime.runtimeId, null, this.options.clock.isoNow());
    const result = await this.options.probes.runProbes(runtime);
    this.announce();
    return result;
  }

  /**
   * Adopts the runtime's VM now rather than at first job: the TD's "bring it
   * up" action. Probes run straight after, because an adoption is exactly the
   * moment to re-establish that the guest is still isolated (M6 on-adopt
   * trigger).
   */
  async adopt(runtimeId: string): Promise<ProbeRunResult> {
    const runtime = await this.requireRuntime(runtimeId);
    if (runtime.connection === undefined) {
      throw new Error(
        `"${runtime.displayName}" has no exec address yet, so it cannot be brought up. Add its host and user first.`
      );
    }
    if (!this.options.host.supported) {
      throw new Error("Validation runtimes need a Windows host with Hyper-V; this machine cannot bring one up.");
    }
    const result = await this.options.probes.runProbes(runtime);
    this.announce();
    return result;
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  async listJobs(filter: { readonly taskId?: string; readonly sessionId?: string }): Promise<readonly ValidationJobView[]> {
    const jobs = await this.options.store.listJobs({
      ...(filter.taskId === undefined ? {} : { taskId: asId<"TaskId">(filter.taskId) }),
      ...(filter.sessionId === undefined ? {} : { sessionId: asId<"SessionId">(filter.sessionId) })
    });
    const names = new Map(
      (await this.options.store.listRuntimes(true)).map((runtime) => [String(runtime.runtimeId), runtime.displayName])
    );
    const views: ValidationJobView[] = [];
    for (const job of jobs) {
      const receipt = job.receiptId === undefined ? null : await this.options.store.getReceiptByJob(job.jobId);
      const displayName = job.resolvedRuntimeId === undefined ? undefined : names.get(String(job.resolvedRuntimeId));
      views.push({
        jobId: String(job.jobId),
        state: job.state,
        profileRef: job.profileRef,
        ...(displayName === undefined ? {} : { runtimeDisplayName: displayName }),
        ...(job.queuePosition === undefined ? {} : { queuePosition: job.queuePosition }),
        ...(job.parkedReason === undefined ? {} : { parkedReason: job.parkedReason }),
        ...(job.licenseWaitMs === undefined ? {} : { licenseWaitMs: job.licenseWaitMs }),
        queuedAt: job.queuedAt,
        ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
        ...(job.completedAt === undefined ? {} : { completedAt: job.completedAt }),
        sessionId: String(job.sessionId),
        ...(job.taskId === undefined ? {} : { taskId: String(job.taskId) }),
        ...(job.subtaskId === undefined ? {} : { subtaskId: String(job.subtaskId) }),
        ...(receipt === null ? {} : {
          receipt: {
            verdict: receipt.verdict,
            ...(receipt.summary === undefined ? {} : { summary: receipt.summary }),
            ...(receipt.failingTest === undefined ? {} : { failingTest: receipt.failingTest }),
            ...(receipt.failingAssertion === undefined ? {} : { failingAssertion: receipt.failingAssertion }),
            changesetRef: receipt.changesetRef,
            ...(receipt.mirrorVersion === undefined ? {} : { mirrorVersion: receipt.mirrorVersion }),
            ...(receipt.mirrorFreshnessAt === undefined ? {} : { mirrorFreshnessAt: receipt.mirrorFreshnessAt }),
            ...(receipt.probesGreenAt === undefined ? {} : { probesGreenAt: receipt.probesGreenAt }),
            licenseWaitMs: receipt.licenseWaitMs,
            superseded: receipt.superseded,
            ...(receipt.fixtureManifestHash === undefined ? {} : { fixtureManifestHash: receipt.fixtureManifestHash })
          }
        })
      });
    }
    return views;
  }

  async abortJob(jobId: string): Promise<void> {
    await this.options.jobs.abortJob(asId<"ValidationJobId">(jobId));
  }

  /** H1/H2: a cross-profile reroute answers with the delta instead of writing. */
  async requeue(jobId: string, opts: { readonly rerouteTo?: string; readonly confirmedDelta?: boolean }): Promise<ValidationRequeueView> {
    const result = await this.options.jobs.requeueParked(asId<"ValidationJobId">(jobId), {
      ...(opts.rerouteTo === undefined ? {} : { rerouteTo: asId<"ValidationRuntimeId">(opts.rerouteTo) }),
      ...(opts.confirmedDelta === undefined ? {} : { confirmedDelta: opts.confirmedDelta })
    });
    if (result.kind === "queued") return { kind: "queued" };
    if (result.kind === "parked") return { kind: "parked", reason: result.reason };
    return {
      kind: "needs-confirm",
      delta: result.delta,
      toRuntimeId: String(result.to.runtimeId),
      toDisplayName: result.to.displayName
    };
  }

  /** The task-header picker (F6). An absent runtimeId returns to the cascade. */
  async setTaskRuntime(taskId: string, runtimeId?: string): Promise<void> {
    const id = asId<"TaskId">(taskId);
    if (runtimeId === undefined) {
      await this.options.store.setTaskOverride(id, null, this.options.clock.isoNow());
      this.announce();
      return;
    }
    const runtime = await this.options.store.getRuntime(asId<"ValidationRuntimeId">(runtimeId));
    if (runtime === null) throw new Error(`"${runtimeId}" is not in the validation runtime registry.`);
    if (runtime.archived === true) {
      throw new Error(`"${runtime.displayName}" is archived, so new jobs cannot be routed to it.`);
    }
    await this.options.store.setTaskOverride(id, runtime.runtimeId, this.options.clock.isoNow());
    this.announce();
  }

  getTaskRuntime(taskId: string): Promise<ValidationRuntimeId | null> {
    return this.options.store.getTaskOverride(asId<"TaskId">(taskId));
  }

  /**
   * The runtime a task's next job would use, and whether that differs from the
   * default (F6: the header picker is visible only when it does).
   */
  async resolvedRuntimeForTask(taskId?: string): Promise<{
    readonly runtime?: NamedRuntimeConfig;
    readonly differsFromDefault: boolean;
  }> {
    const [runtimes, settings] = await Promise.all([
      this.options.store.listRuntimes(false),
      this.options.store.getSettings()
    ]);
    const byId = new Map(runtimes.map((runtime) => [String(runtime.runtimeId), runtime]));
    let chosen: NamedRuntimeConfig | undefined;
    if (taskId !== undefined) {
      const override = await this.options.store.getTaskOverride(asId<"TaskId">(taskId));
      if (override !== null) chosen = byId.get(String(override));
      if (chosen === undefined) {
        const projectRootId = await this.options.taskProjectRootId?.(taskId);
        if (projectRootId !== undefined) {
          const associations = await this.options.store.listAssociations();
          const row = pickAssociation(associations, asId<"WorkspaceRootId">(projectRootId));
          if (row !== undefined) chosen = byId.get(String(row.runtimeId));
        }
      }
    }
    const fallback = settings.defaultRuntimeId === undefined ? undefined : byId.get(String(settings.defaultRuntimeId));
    const runtime = chosen ?? fallback;
    return {
      ...(runtime === undefined ? {} : { runtime }),
      differsFromDefault: runtime !== undefined && fallback !== undefined && runtime.runtimeId !== fallback.runtimeId
    };
  }

  /** Every runtime the task-header picker may offer. */
  async pickerRuntimes(): Promise<readonly { readonly runtimeId: string; readonly displayName: string }[]> {
    return (await this.options.store.listRuntimes(false))
      .map((runtime) => ({ runtimeId: String(runtime.runtimeId), displayName: runtime.displayName }));
  }

  /**
   * The rail's L0 dot plus its one-line hover (ux-flows F4). Precedence:
   * nothing configured, then blocked (quarantine or a parked job), then running,
   * then the last verdict, then ready. The LINE carries the honesty the
   * five-value dot cannot: "isolation not verified yet" is never dressed up as
   * a verified green.
   */
  async railStatus(taskId?: string): Promise<{ readonly dot: ValidationRailDot; readonly line: string }> {
    const runtimes = await this.options.store.listRuntimes(false);
    if (runtimes.length === 0) {
      return {
        dot: "none",
        line: this.options.host.supported
          ? "No validation runtime is set up yet."
          : "Validation runtimes need a Windows host with Hyper-V."
      };
    }
    const resolved = await this.resolvedRuntimeForTask(taskId);
    const runtime = resolved.runtime;
    const jobs = taskId === undefined
      ? []
      : await this.options.store.listJobs({ taskId: asId<"TaskId">(taskId) });
    const queued = jobs.filter((job) => job.state === "queued").length;
    const parked = jobs.find((job) => job.state === "parked");
    const active = jobs.filter((job) => ACTIVE_JOB_STATES.has(job.state));
    const quarantine = runtime === undefined ? null : await this.options.store.getQuarantine(runtime.runtimeId);
    const where = runtime === undefined ? "" : ` on ${runtime.displayName}`;

    if (quarantine !== null && runtime !== undefined) {
      return {
        dot: "blocked",
        line: `${runtime.displayName} is quarantined — ${quarantine.detail}`
      };
    }
    if (parked !== undefined) {
      return { dot: "blocked", line: parked.parkedReason ?? `A validation job is parked${where}.` };
    }
    if (runtime === undefined) {
      return { dot: "blocked", line: "No default validation runtime is set, so jobs have nowhere to run." };
    }
    if (active.length > 0) {
      const ahead = Math.max(0, active.length - 1);
      return {
        dot: "running",
        line: `Validating${where}${ahead === 0 ? "" : ` · ${String(ahead)} queued behind`}`
      };
    }
    const newest = jobs
      .filter((job) => job.completedAt !== undefined)
      .sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? ""))
      .pop();
    const receipt = newest === undefined ? null : await this.options.store.getReceiptByJob(newest.jobId);
    const greenAt = this.options.probes.probesGreenAt(runtime.runtimeId);
    const isolation = greenAt === undefined ? "isolation not verified yet" : `isolation verified ${clockTime(greenAt)}`;
    if (receipt !== null && receipt.verdict !== "passed") {
      const detail = receipt.failingTest ?? receipt.summary ?? "the run did not pass";
      return { dot: "failed", line: `Last validation${where} failed — ${detail}` };
    }
    return { dot: "ok", line: `Validation ready${where} · queue ${String(queued)} · ${isolation}` };
  }

  /**
   * The palette/manual trigger: validate what this session has right now.
   *
   * The profile comes from the personal `drydock.validation.defaultProfile`
   * setting. With none configured the command says so and names the setting -
   * running an invented suite would produce evidence about nothing.
   */
  async runForSession(sessionId: string): Promise<{ readonly jobId?: string; readonly message: string }> {
    const profile = this.options.defaultProfile?.();
    if (profile === undefined) {
      throw new Error(
        "Configure a validation profile first: set drydock.validation.defaultProfile to the suite this studio runs (profileRef plus the command to run)."
      );
    }
    const context = await this.options.sessionContext?.(sessionId) ?? null;
    if (context === null) throw new Error(`Chat session ${sessionId} was not found, so there is nothing to validate.`);
    const fixtures = await this.stagedFixturePayloads(sessionId);
    const request: ValidationJobRequest = {
      sessionId: asId<"SessionId">(sessionId),
      chatId: asId<"ChatId">(context.chatId),
      ...(context.taskId === undefined ? {} : { taskId: asId<"TaskId">(context.taskId) }),
      ...(context.subtaskId === undefined ? {} : { subtaskId: asId<"SubtaskId">(context.subtaskId) }),
      ...(context.projectRootId === undefined ? {} : { projectRootId: asId<"WorkspaceRootId">(context.projectRootId) }),
      ...(context.taskId === undefined
        ? {}
        : await this.overrideFor(context.taskId)),
      profile,
      ...(fixtures.payloads.length === 0
        ? {}
        : { fixtures: fixtures.payloads, fixtureManifestHash: fixtures.manifestHash })
    };
    const job = await this.options.jobs.enqueue(request);
    if (job === null) {
      return { message: "There are no changes to validate in this chat yet." };
    }
    return {
      jobId: String(job.jobId),
      message: job.state === "parked"
        ? job.parkedReason ?? "The validation job parked before it could run."
        : "Validation queued."
    };
  }

  private async overrideFor(taskId: string): Promise<{ readonly requestedRuntimeId?: ValidationRuntimeId }> {
    const override = await this.options.store.getTaskOverride(asId<"TaskId">(taskId));
    return override === null ? {} : { requestedRuntimeId: override };
  }

  // -------------------------------------------------------------------------
  // Production-tier fixtures (edge cases A1/A2/A3/B1)
  // -------------------------------------------------------------------------

  /**
   * True when a host path is a production-tier location: exactly the paths the
   * effective policy forbids mounting. Approving one of these takes the
   * snapshot route, so the approval card must say `snapshot`, not `mount`.
   */
  isProductionPath(hostPath: string): boolean {
    const policy = this.options.securityPolicy;
    if (policy === undefined) return false;
    return isDeniedHostPath(hostPath, policy.deniedPaths);
  }

  /**
   * Approves a production-tier file as a session-scoped SNAPSHOT: copy it into
   * the session's staging directory, record the grant, and hand back the
   * provenance the card renders. No mount is created, here or anywhere else.
   *
   * Folders are refused in v1 with the narrower ask spelled out (A2/A3) - a
   * grant must be auditable as concrete files, and "the folder" is not that.
   */
  async grantProductionFixture(input: {
    readonly sessionId: string;
    readonly hostPath: string;
  }): Promise<ProductionFixtureGrant> {
    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await stat(input.hostPath);
    } catch {
      throw new Error(`${input.hostPath} could not be read, so there is nothing to snapshot.`);
    }
    if (stats.isDirectory()) {
      throw new Error(
        `${input.hostPath} is a folder. Ask for the specific file you need instead - Drydock copies approved files one by one so every grant is auditable.`
      );
    }
    if (!stats.isFile()) {
      throw new Error(`${input.hostPath} is not a regular file, so it cannot be snapshotted.`);
    }
    if (stats.size > MAX_FIXTURE_BYTES) {
      throw new Error(
        `${input.hostPath} is ${formatBytes(stats.size)}, over the ${formatBytes(MAX_FIXTURE_BYTES)} snapshot limit. Narrow the request to the specific file or frame range you need.`
      );
    }
    const directory = this.sessionFixtureDir(input.sessionId);
    await mkdir(directory, { recursive: true });
    const relativePath = safeFixtureName(input.hostPath);
    const content = await readFile(input.hostPath);
    await writeFile(path.join(directory, relativePath), content);
    const contentSha256 = stats.size <= FIXTURE_HASH_BUDGET_BYTES
      ? createHash("sha256").update(content).digest("hex")
      : undefined;
    this.options.securityEvent?.({
      eventCode: "fixture.granted",
      outcome: "allowed",
      sessionId: asId<"SessionId">(input.sessionId),
      metadata: {
        path: input.hostPath,
        sizeBytes: stats.size,
        relativePath,
        ...(contentSha256 === undefined ? {} : { contentSha256 }),
        // Grants are session-scoped by default (edge case B2); the staging
        // directory is removed when the session ends.
        expiry: "session-end"
      }
    });
    const staged = await this.stagedFixtures(input.sessionId);
    return {
      relativePath,
      bytes: stats.size,
      ...(contentSha256 === undefined ? {} : { contentSha256 }),
      manifestHash: fixtureManifestHash(staged)
    };
  }

  /** Everything staged for a session, with per-file hashes for the manifest. */
  async stagedFixtures(sessionId: string): Promise<readonly StagedFixture[]> {
    const directory = this.sessionFixtureDir(sessionId);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      return [];
    }
    const staged: StagedFixture[] = [];
    for (const name of names.sort()) {
      const full = path.join(directory, name);
      try {
        const stats = await stat(full);
        if (!stats.isFile()) continue;
        const content = await readFile(full);
        staged.push({
          relativePath: name,
          bytes: stats.size,
          ...(stats.size <= FIXTURE_HASH_BUDGET_BYTES
            ? { contentSha256: createHash("sha256").update(content).digest("hex") }
            : {})
        });
      } catch (error) {
        this.options.logger.warn("staged fixture unreadable; skipped", { relativePath: name, error: messageOf(error) });
      }
    }
    return staged;
  }

  /** The staged set as job payloads plus the hash the receipt records. */
  private async stagedFixturePayloads(sessionId: string): Promise<{
    readonly payloads: readonly { readonly relativePath: string; readonly contentBase64: string }[];
    readonly manifestHash: string;
  }> {
    const staged = await this.stagedFixtures(sessionId);
    const directory = this.sessionFixtureDir(sessionId);
    const payloads: { relativePath: string; contentBase64: string }[] = [];
    for (const entry of staged) {
      try {
        const content = await readFile(path.join(directory, entry.relativePath));
        payloads.push({ relativePath: entry.relativePath, contentBase64: content.toString("base64") });
      } catch (error) {
        this.options.logger.warn("staged fixture could not be shipped", {
          relativePath: entry.relativePath,
          error: messageOf(error)
        });
      }
    }
    return { payloads, manifestHash: fixtureManifestHash(staged) };
  }

  /** Session-scoped means session-scoped: the copies go when the session does. */
  async clearSessionFixtures(sessionId: string): Promise<void> {
    await rm(this.sessionFixtureDir(sessionId), { recursive: true, force: true });
  }

  private sessionFixtureDir(sessionId: string): string {
    // Session ids are product-generated, but this path is built from one, so it
    // is reduced to a single safe segment before it becomes a directory.
    const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
    return path.join(this.options.fixtureStagingRoot, safe === "" ? "session" : safe);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * A runtime's display name for a push that carries only an id. Falls back to
   * the id: a banner naming an id is still actionable, a banner that failed to
   * render is not.
   */
  async displayNameFor(runtimeId: ValidationRuntimeId | string): Promise<string> {
    try {
      const runtime = await this.options.store.getRuntime(asId<"ValidationRuntimeId">(String(runtimeId)));
      return runtime?.displayName ?? String(runtimeId);
    } catch {
      return String(runtimeId);
    }
  }

  private async requireRuntime(runtimeId: string): Promise<NamedRuntimeConfig> {
    const runtime = await this.options.store.getRuntime(asId<"ValidationRuntimeId">(runtimeId));
    if (runtime === null) throw new Error(`"${runtimeId}" is not in the validation runtime registry.`);
    return runtime;
  }

  /** Coarse invalidation; every validation surface refetches off this. */
  private announce(): void {
    this.options.bus?.publish({ kind: "validation-runtime-changed" });
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Local alias so the state assembly can push into the readonly array shape. */
type ValidationQuarantineRow = ValidationConfigState["quarantines"][number];

/**
 * The manifest hash evidence records: sha256 over the SORTED
 * `(relativePath, contentSha256)` pairs, so it is independent of directory
 * order. A file too large to hash contributes its size instead, which still
 * changes the manifest when the file does without pretending we hashed it.
 */
export function fixtureManifestHash(staged: readonly StagedFixture[]): string {
  const lines = staged
    .map((entry) => `${entry.relativePath}\n${entry.contentSha256 ?? `size:${String(entry.bytes)}`}`)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return createHash("sha256").update(lines.join("\n\n"), "utf8").digest("hex");
}

/** One safe file name for a staged copy; the source path never steers writes. */
function safeFixtureName(hostPath: string): string {
  const base = hostPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "fixture";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "fixture" : cleaned.slice(0, 120);
}

/**
 * Case-insensitive containment against the policy's denied roots. Deliberately
 * local: `isPathDenied` in core is the mount gate's spelling, and this is a
 * classification question about a FILE, which may sit under a denied root.
 */
function isDeniedHostPath(candidate: string, deniedPaths: readonly string[]): boolean {
  const normalized = normalizeForCompare(candidate);
  return deniedPaths.some((denied) => {
    const root = normalizeForCompare(denied);
    if (root === "") return false;
    return normalized === root || normalized.startsWith(`${root}/`);
  });
}

function normalizeForCompare(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** The suite's headline state: breach outranks fail outranks unknown. */
function worstProbeState(result: ProbeRunResult): "pass" | "breach" | "fail" | "unknown" {
  if (result.probes.some((probe) => probe.state === "breach")) return "breach";
  if (result.probes.some((probe) => probe.state === "fail")) return "fail";
  if (result.probes.some((probe) => probe.state === "unknown")) return "unknown";
  return result.probes.length === 0 ? "unknown" : "pass";
}

/** `HH:MM` for the rail's one line; an unparseable stamp renders verbatim. */
function clockTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  const date = new Date(parsed);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${String(bytes)} bytes`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SYSTEM_INTERVALS: ValidationIntervalTimers = {
  set(handler: () => void, ms: number): unknown {
    const token = setInterval(handler, ms);
    if (typeof token === "object" && token !== null && "unref" in token) {
      (token as { unref(): void }).unref();
    }
    return token;
  },
  clear(token: unknown): void {
    clearInterval(token as ReturnType<typeof setInterval>);
  }
};

const DEFAULT_IDS = {
  validationRuntimeId: (): ValidationRuntimeId =>
    asId<"ValidationRuntimeId">(`vruntime-${createHash("sha256").update(`${String(Date.now())}-${String(Math.random())}`).digest("hex").slice(0, 12)}`)
};
