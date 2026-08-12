/**
 * Validation-runtime contracts (ADR 0022).
 *
 * A validation runtime is the second runtime class: a product-adopted Windows
 * VM (adapter kind `hyperv`) that only ever runs validation jobs. Runtimes form
 * a NAMED REGISTRY WITH ONE DEFAULT, routed per job by the association cascade
 * (chat/task override -> project association -> default). Named runtimes carry
 * their own image, capabilities, policy profile, and lifecycle, so the common
 * studio topologies ("one VM", "default + named", "one per project") are
 * presets over a single model rather than separate modes.
 *
 * Two rules shape every type here:
 * - Routing never degrades silently. An unusable target PARKS with a reason the
 *   UI can render verbatim; it never falls through to the next cascade tier.
 * - Cross-profile rerouting is always an explicit user action showing the
 *   policy delta (threat-model rule: fallback must not broaden access, and
 *   silent narrowing just fails confusingly).
 *
 * Records are all-readonly with ISO-8601 string timestamps; stores take every
 * timestamp as a parameter so services own the clock.
 */

import type {
  AgentId,
  ChatId,
  SessionId,
  SubtaskId,
  TaskId,
  ValidationJobId,
  ValidationReceiptId,
  ValidationRuntimeId,
  WorkspaceRootId
} from "./ids.js";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * How a validation runtime spends its idle time (ADR 0022). `keep-warm` runs
 * until the warm cap says otherwise, `on-demand` boots per job and reports the
 * boot as honest queue state, `pinned` is the user's "always up" declaration.
 */
export type ValidationRuntimeLifecycle = "keep-warm" | "on-demand" | "pinned";

/**
 * Topology presets (ADR 0022, ux-flows F6) are STARTING CONFIGURATIONS, not
 * modes: `single` = just the default, `default-plus-named` = the model itself,
 * `per-project` = the lazy auto-create association rule.
 */
export type ValidationTopologyPreset = "single" | "default-plus-named" | "per-project";

/**
 * How the host reaches one validation runtime's guest OS (ADR 0022 M3). This is
 * connection DATA, not a live channel: the `hyperv` adapter opens one `ssh.exe`
 * process per exec because Windows OpenSSH has no ControlMaster multiplexing
 * (`spike-report.md`), so nothing here is held open between calls.
 *
 * `host` is the guest's address on the internal switch, `user` the guest
 * account the exec channel authenticates as, and `port` is present only when the
 * guest does not listen on 22. Credentials never live here - the adapter is
 * configured with a product-owned identity file and known-hosts path.
 */
export interface ValidationRuntimeConnection {
  readonly host: string;
  readonly port?: number;
  readonly user: string;
}

/**
 * One named validation runtime (ADR 0022). Identity is `runtimeId` - renaming
 * is display-only, so associations, jobs, and receipts survive it (edge case
 * H5). `capabilities` are the profile's declared abilities (`msvc`, `maya`,
 * `houdini`, ...) that recipes match their requirements against (H8).
 */
export interface NamedRuntimeConfig {
  readonly runtimeId: ValidationRuntimeId;
  readonly displayName: string;
  readonly image: string;
  readonly lifecycle: ValidationRuntimeLifecycle;
  readonly capabilities: readonly string[];
  readonly policyProfileRef: string;
  /**
   * Where the exec channel connects for this runtime (M3). Absent until the
   * setup wizard (M7) records it; a runtime with no connection can be listed and
   * routed to but cannot execute, so the job service parks rather than guessing
   * an address.
   */
  readonly connection?: ValidationRuntimeConnection;
  /**
   * Marks a TD-gated broad profile such as `production_tester` (a standing
   * fixture set is a deliberate exception, not a shortcut). Carries a permanent
   * badge in the UI and always forces the policy-delta confirm on reroute (H2).
   */
  readonly profileException?: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Archived runtimes stay referenced by evidence but never resolve for new jobs. */
  readonly archived?: boolean;
}

/** Partial runtime edit; `runtimeId` is the key and is never mutable. */
export interface NamedRuntimeUpdate {
  readonly displayName?: string;
  readonly image?: string;
  readonly lifecycle?: ValidationRuntimeLifecycle;
  readonly capabilities?: readonly string[];
  readonly policyProfileRef?: string;
  /** `null` clears the connection (the runtime becomes unreachable, not deleted). */
  readonly connection?: ValidationRuntimeConnection | null;
  readonly profileException?: boolean;
  readonly archived?: boolean;
  readonly updatedAt?: string;
}

/**
 * Where an association row came from (H6): `personal` rows are the user's own
 * narrowing; `managed` rows ship from studio policy and, when `pinned`, out-
 * rank the personal row for that project.
 */
export type RuntimeAssociationSource = "personal" | "managed";

/**
 * A project -> runtime association (ADR 0022). Rows are keyed by
 * (projectRootId, source), so one project may carry both a personal row and a
 * managed row; `resolveValidationRuntime` picks between them. A project with no
 * row simply uses the default - absence is not an error.
 */
export interface RuntimeAssociation {
  readonly projectRootId: WorkspaceRootId;
  readonly runtimeId: ValidationRuntimeId;
  readonly source: RuntimeAssociationSource;
  /** Managed rows only: locks the row so personal narrowing cannot override it. */
  readonly pinned?: boolean;
  readonly updatedAt: string;
}

/**
 * The `per-project` preset's lazy auto-create rule (edge case H3): runtimes are
 * created on FIRST JOB, never on project open, and reaped after idle days. The
 * association survives reaping - the next job recreates from the template.
 */
export interface ValidationAutoCreateRule {
  readonly templateRuntimeId?: ValidationRuntimeId;
  readonly reapAfterIdleDays: number;
}

/**
 * Registry-wide settings (ADR 0022). Absent `defaultRuntimeId` means the
 * cascade's last tier parks instead of guessing; absent `warmCap` means
 * unlimited warm runtimes (edge case H4).
 */
export interface ValidationRegistrySettings {
  readonly defaultRuntimeId?: ValidationRuntimeId;
  readonly topologyPreset: ValidationTopologyPreset;
  readonly warmCap?: number;
  readonly autoCreate?: ValidationAutoCreateRule;
}

/** Partial settings write; `null` clears a key rather than leaving it unset. */
export interface ValidationRegistrySettingsUpdate {
  readonly defaultRuntimeId?: ValidationRuntimeId | null;
  readonly topologyPreset?: ValidationTopologyPreset;
  readonly warmCap?: number | null;
  readonly autoCreate?: ValidationAutoCreateRule | null;
}

/**
 * A live quarantine (edge case E5). Durable because the incident outlives the
 * process that found it: the banner, the blocked queue, and the flagged
 * evidence all key off this record until a TD explicitly clears it.
 */
export interface ValidationQuarantineRecord {
  /** The must-fail probe that succeeded. */
  readonly probeId: string;
  /** The probe's own sentence, in studio vocabulary; rendered verbatim. */
  readonly detail: string;
  readonly at: string;
}

/**
 * What the product can currently observe about a runtime (ADR 0022). `missing`
 * means an adopted VM is gone from the hypervisor - the only availability that
 * parks; `stopped` is honest queue state (the job service surfaces the boot).
 * Unknown never renders as green (ADR 0021 honesty rule).
 */
export type ValidationRuntimeAvailability = "available" | "stopped" | "quarantined" | "missing";

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/**
 * Validation job lifecycle (ADR 0022). `completed` means the job ran to a
 * verdict - the RECEIPT says whether tests passed. `failed` is infrastructure
 * error (VM unreachable, patch would not apply), never a test failure.
 * `license-wait` is deliberately distinct from a hang (edge case E4).
 */
export type ValidationJobState =
  | "queued"
  | "starting"
  | "syncing"
  | "resolving"
  | "running"
  | "license-wait"
  | "completed"
  | "parked"
  | "aborted"
  | "failed";

/**
 * What a validation job actually RUNS in the guest (ADR 0022 M4). A profile is
 * the studio's validation suite expressed as an argv the guest wrapper executes
 * verbatim - never a shell string, because the wrapper receives it as JSON and
 * spawns it as a process (fixed-literal guest scripts, `snapshotProcessTree`
 * rule).
 *
 * `requiredCapabilities` are matched against the resolved runtime's declared
 * capabilities AT QUEUE TIME (edge case H8), so a C++ suite routed at a runtime
 * without MSVC is caught in a second with `route to cpp-builds?` rather than
 * five minutes into a failing build.
 */
export interface ValidationProfile {
  /** Stable id of the suite; copied onto the job and rendered in evidence. */
  readonly profileRef: string;
  /** Executable + arguments, run as-is in the job workspace. */
  readonly argv: readonly string[];
  /** Extra guest environment; the job service adds its own job-scoped vars. */
  readonly env?: Readonly<Record<string, string>>;
  /** Runtime capabilities this suite needs (`msvc`, `maya`, ...) - H8 gate. */
  readonly requiredCapabilities?: readonly string[];
  /**
   * Regex SOURCE strings (matched case-insensitively) marking a line as a
   * license wait rather than a hang (edge case E4). A match pauses the
   * inactivity watchdog and shows `license-wait` as state; the job's hard turn
   * cap still applies. The job service adds a default pattern set, so profiles
   * only declare their DCC's peculiar wording.
   */
  readonly licenseWaitPatterns?: readonly string[];
}

/**
 * What a caller hands the job service to get work validated (ADR 0022 M4).
 * Everything the cascade needs to route (`requestedRuntimeId`, `projectRootId`)
 * plus everything evidence needs to attribute (session/chat/task/subtask/agent).
 *
 * `requestedRuntimeId` is the chat/task OVERRIDE tier - absent means "resolve
 * normally", never "use the default". A subagent's request carries the parent's
 * `taskId` with the child's `agentId` (edge case C1).
 */
export interface ValidationJobRequest {
  readonly sessionId: SessionId;
  readonly chatId: ChatId;
  readonly taskId?: TaskId;
  readonly subtaskId?: SubtaskId;
  readonly agentId?: AgentId;
  readonly projectRootId?: WorkspaceRootId;
  readonly requestedRuntimeId?: ValidationRuntimeId;
  readonly profile: ValidationProfile;
  /** Hash of the per-job fixture set (A6); copied onto the receipt verbatim. */
  readonly fixtureManifestHash?: string;
  /**
   * Approved fixture files shipped into this job's `fixtures` directory
   * (A1/A6). Content travels BASE64 because these are studio assets, not text,
   * and the guest writes the exact bytes. The host stages the copies at
   * approval time; the job service only carries them across, wipes with the
   * job dir, and never mounts anything.
   */
  readonly fixtures?: readonly ValidationFixturePayload[];
}

/** One approved fixture file, ready to ship into a job's fixture root. */
export interface ValidationFixturePayload {
  /** Path under the job's `fixtures` dir; forward slashes, no `..`, no root. */
  readonly relativePath: string;
  readonly contentBase64: string;
}

/**
 * One validation job (ADR 0022). `requestedRuntimeId` is what the caller asked
 * for; `resolvedRuntimeId` is what the cascade actually chose - both are kept
 * so evidence can attribute honestly. Subagent jobs run under the parent's task
 * with the child's `agentId` stamped (edge case C1).
 */
export interface ValidationJob {
  readonly jobId: ValidationJobId;
  readonly sessionId: SessionId;
  readonly chatId: ChatId;
  readonly taskId?: TaskId;
  readonly subtaskId?: SubtaskId;
  readonly agentId?: AgentId;
  readonly projectRootId?: WorkspaceRootId;
  readonly requestedRuntimeId?: ValidationRuntimeId;
  readonly resolvedRuntimeId?: ValidationRuntimeId;
  readonly profileRef: string;
  /** The snapshot this job validates - evidence binds to it, not to the live tree. */
  readonly changesetRef: string;
  readonly state: ValidationJobState;
  /** Human-readable park reason the UI renders verbatim (studio vocabulary). */
  readonly parkedReason?: string;
  readonly queuePosition?: number;
  readonly licenseWaitMs?: number;
  readonly receiptId?: ValidationReceiptId;
  readonly queuedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly updatedAt: string;
}

/** State transition patch; `updatedAt` is required so every write is stamped. */
export interface ValidationJobPatch {
  readonly state?: ValidationJobState;
  readonly parkedReason?: string | null;
  readonly queuePosition?: number | null;
  readonly licenseWaitMs?: number | null;
  readonly receiptId?: ValidationReceiptId | null;
  readonly resolvedRuntimeId?: ValidationRuntimeId | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  readonly updatedAt: string;
}

/** Job list filter; omitted fields do not constrain, `states` is an OR set. */
export interface ValidationJobFilter {
  readonly taskId?: TaskId;
  readonly sessionId?: SessionId;
  readonly states?: readonly ValidationJobState[];
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/** What a completed validation job concluded (ADR 0022). */
export type ValidationVerdict = "passed" | "failed" | "error";

/**
 * Durable validation evidence (ADR 0022). Everything needed to answer "what
 * exactly did this green mean?" travels with the verdict: which runtime and
 * policy profile ran it, which changeset it bound to, how fresh the package
 * mirror was (G1), whether probes were green, and which image/revert generation
 * the guest was on (E6, F6). `superseded` marks evidence whose working set has
 * moved on (D2) - honest status extends to evidence.
 */
export interface ValidationReceipt {
  readonly receiptId: ValidationReceiptId;
  readonly jobId: ValidationJobId;
  readonly runtimeId: ValidationRuntimeId;
  readonly policyProfileRef: string;
  readonly changesetRef: string;
  readonly mirrorVersion?: number;
  readonly mirrorFreshnessAt?: string;
  readonly fixtureManifestHash?: string;
  readonly licenseWaitMs: number;
  readonly probesGreenAt?: string;
  readonly imageGeneration?: number;
  readonly revertGeneration?: number;
  readonly verdict: ValidationVerdict;
  readonly summary?: string;
  readonly failingTest?: string;
  readonly failingAssertion?: string;
  readonly superseded: boolean;
  /** When supersession was recorded; absent while the evidence is still current. */
  readonly supersededAt?: string;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Routing results
// ---------------------------------------------------------------------------

/**
 * Why a job parked instead of running (ADR 0022, edge case H1). Every reason
 * ships with a `detail` sentence in studio vocabulary - never adapter
 * internals - and the UI offers `Run on default instead`.
 */
export type ValidationParkReason =
  | "no-default-runtime"
  | "runtime-archived"
  | "runtime-unavailable"
  | "runtime-quarantined";

/**
 * The policy difference between two runtimes (ADR 0022). Rendered verbatim in
 * the reroute confirm - in BOTH directions, because broadening access needs
 * consent and narrowing it silently just fails confusingly.
 */
export interface ValidationPolicyDelta {
  readonly profileChanged: boolean;
  readonly fromProfile?: string;
  readonly toProfile: string;
  readonly imageChanged: boolean;
  readonly capabilitiesAdded: readonly string[];
  readonly capabilitiesRemoved: readonly string[];
  /** Target is a TD-gated broad profile: always confirm, even profile-for-profile. */
  readonly profileException: boolean;
}

/**
 * The outcome of resolving where a job runs (ADR 0022). `resolved` names the
 * cascade tier that won so evidence and UI can say why; `park` never falls
 * through to another tier; `needs-confirm` is only ever produced by an explicit
 * reroute request, never by automatic resolution.
 */
export type ValidationRoutingResult =
  | {
      readonly kind: "resolved";
      readonly runtime: NamedRuntimeConfig;
      readonly source: "override" | "association" | "default";
    }
  | {
      readonly kind: "park";
      readonly reason: ValidationParkReason;
      readonly detail: string;
    }
  | {
      readonly kind: "needs-confirm";
      readonly from?: NamedRuntimeConfig;
      readonly to: NamedRuntimeConfig;
      readonly delta: ValidationPolicyDelta;
    };

/**
 * Whether moving a job from one runtime to another is a one-click same-profile
 * reroute or needs the policy-delta confirm (ADR 0022, edge case H1).
 */
export type ValidationRerouteDecision =
  | { readonly kind: "same-profile" }
  | { readonly kind: "needs-confirm"; readonly delta: ValidationPolicyDelta };

// ---------------------------------------------------------------------------
// Store port
// ---------------------------------------------------------------------------

/**
 * Durable home for the ADR 0022 registry, association table, job queue, and
 * evidence receipts. The registry starts EMPTY - the setup wizard creates the
 * default runtime, nothing is seeded. Every timestamp is a parameter so the
 * service owns the clock and tests stay deterministic.
 */
export interface ValidationRuntimeStore {
  /** Ordered by displayName; archived excluded unless includeArchived. */
  listRuntimes(includeArchived?: boolean): Promise<NamedRuntimeConfig[]>;
  getRuntime(runtimeId: ValidationRuntimeId): Promise<NamedRuntimeConfig | null>;
  insertRuntime(record: NamedRuntimeConfig): Promise<void>;
  updateRuntime(runtimeId: ValidationRuntimeId, update: NamedRuntimeUpdate): Promise<void>;
  /** Archive/unarchive; deletion goes through the reassignment guard (H5). */
  archiveRuntime(runtimeId: ValidationRuntimeId, archived: boolean, updatedAt: string): Promise<void>;

  /** Every association row, both sources, ordered by project then source. */
  listAssociations(): Promise<RuntimeAssociation[]>;
  /** Zero, one, or two rows (one personal + one managed) for a project. */
  getAssociations(projectRootId: WorkspaceRootId): Promise<RuntimeAssociation[]>;
  /** Upserts on (projectRootId, source) - a managed row never clobbers a personal one. */
  upsertAssociation(record: RuntimeAssociation): Promise<void>;
  /** Omitting `source` clears every row for the project. */
  deleteAssociation(projectRootId: WorkspaceRootId, source?: RuntimeAssociationSource): Promise<void>;

  /** Missing/malformed keys fall back to `{ topologyPreset: "single" }`. */
  getSettings(): Promise<ValidationRegistrySettings>;
  setSettings(update: ValidationRegistrySettingsUpdate, updatedAt: string): Promise<void>;

  /**
   * The task-level runtime override (the cascade's first tier, ux-flows F6).
   * Stored in the same key/value table under `override.task.<taskId>`, because
   * it is one small durable preference per task rather than a table's worth of
   * structure. `null` means the task follows the cascade.
   */
  getTaskOverride(taskId: TaskId): Promise<ValidationRuntimeId | null>;
  setTaskOverride(taskId: TaskId, runtimeId: ValidationRuntimeId | null, updatedAt: string): Promise<void>;

  /**
   * The durable quarantine flag (edge case E5, ux-flows F5) under
   * `quarantine.<runtimeId>`. It must survive a host restart: an isolation
   * breach that a window reload could clear would be a breach the product
   * forgot. `null` clears it - only an explicit revert-and-reprobe does that.
   */
  getQuarantine(runtimeId: ValidationRuntimeId): Promise<ValidationQuarantineRecord | null>;
  setQuarantine(
    runtimeId: ValidationRuntimeId,
    payload: ValidationQuarantineRecord | null,
    updatedAt: string
  ): Promise<void>;

  insertJob(record: ValidationJob): Promise<void>;
  getJob(jobId: ValidationJobId): Promise<ValidationJob | null>;
  updateJobState(jobId: ValidationJobId, patch: ValidationJobPatch): Promise<void>;
  /** Oldest first (queuedAt, then insertion order); an empty filter lists all. */
  listJobs(filter?: ValidationJobFilter): Promise<ValidationJob[]>;
  /** The `queued` backlog in service order. */
  listQueuedJobs(): Promise<ValidationJob[]>;

  insertReceipt(record: ValidationReceipt): Promise<void>;
  getReceipt(receiptId: ValidationReceiptId): Promise<ValidationReceipt | null>;
  getReceiptByJob(jobId: ValidationJobId): Promise<ValidationReceipt | null>;
  /** Marks evidence stale after changeset drift (D2); stamps when it happened. */
  markReceiptSuperseded(receiptId: ValidationReceiptId, updatedAt: string): Promise<void>;
  /** Every receipt produced by that task's jobs, newest first. */
  listReceiptsByTask(taskId: TaskId): Promise<ValidationReceipt[]>;
}
