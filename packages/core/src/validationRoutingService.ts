/**
 * Validation-runtime routing (ADR 0022): pure, deterministic resolution of
 * WHERE a validation job runs, plus the registry arithmetic around it.
 *
 * Everything here takes explicit inputs and returns values - no stores, no
 * clock, no I/O - so the routing rules are testable as arithmetic. A binder
 * that reads the ValidationRuntimeStore and calls these functions belongs to
 * the job service (M4), not here.
 *
 * The two invariants this module exists to enforce:
 *
 * 1. NO SILENT REROUTING. The cascade (chat/task override -> project
 *    association -> default) stops at the FIRST tier that names a runtime. If
 *    that runtime is archived, gone, or quarantined the job PARKS with a reason
 *    a human can read; it never slides down to the next tier. Falling through
 *    would either broaden access without consent or narrow it invisibly - both
 *    are threat-model violations (edge case H1).
 * 2. CROSS-PROFILE MOVES ARE EXPLICIT. `resolveValidationRuntime` never returns
 *    `needs-confirm`. Rerouting is a separate, user-initiated question answered
 *    by `computeReroute`, which shows the full policy delta in both directions.
 */

import type {
  NamedRuntimeConfig,
  RuntimeAssociation,
  ValidationPolicyDelta,
  ValidationRegistrySettings,
  ValidationRerouteDecision,
  ValidationRoutingResult,
  ValidationRuntimeAvailability,
  ValidationRuntimeId,
  ValidationTopologyPreset,
  WorkspaceRootId
} from "@drydock/contracts";

/** Days a `per-project` auto-created runtime may idle before it is reaped (H3). */
export const DEFAULT_REAP_AFTER_IDLE_DAYS = 14;

/**
 * Everything resolution needs, handed in explicitly. `availability` is a lookup
 * rather than a map so callers can answer from live inventory without
 * materializing a snapshot.
 */
export interface ValidationRoutingInputs {
  /** Chat/task override - the top cascade tier. */
  readonly override?: ValidationRuntimeId;
  readonly projectRootId?: WorkspaceRootId;
  readonly runtimes: readonly NamedRuntimeConfig[];
  readonly associations: readonly RuntimeAssociation[];
  readonly settings: ValidationRegistrySettings;
  readonly availability: (runtimeId: ValidationRuntimeId) => ValidationRuntimeAvailability;
}

/** Which cascade tier named the runtime - carried into evidence and the UI. */
type CascadeTier = "override" | "association" | "default";

const TIER_LABEL: Readonly<Record<CascadeTier, string>> = {
  override: "the task's runtime override",
  association: "this project's runtime association",
  default: "the default runtime"
};

/** Per-tier repair advice when the tier names a runtime that is not registered. */
const TIER_DANGLING_FIX: Readonly<Record<CascadeTier, string>> = {
  override: "Pick another runtime for this task, or clear the override to use the default.",
  association: "Pick another runtime for this project, or clear the association to use the default.",
  default: "Choose a default in Configure - Validation runtimes."
};

/**
 * Resolves where a job runs (ADR 0022). Returns `resolved` naming the winning
 * tier, or `park` with a reason the UI renders verbatim. Never `needs-confirm`:
 * automatic resolution does not move work across policy profiles.
 */
export function resolveValidationRuntime(inputs: ValidationRoutingInputs): ValidationRoutingResult {
  if (inputs.override !== undefined) {
    return resolveTier(inputs, inputs.override, "override");
  }
  const association = inputs.projectRootId === undefined
    ? undefined
    : pickAssociation(inputs.associations, inputs.projectRootId);
  if (association !== undefined) {
    return resolveTier(inputs, association.runtimeId, "association");
  }
  const defaultRuntimeId = inputs.settings.defaultRuntimeId;
  if (defaultRuntimeId === undefined) {
    return {
      kind: "park",
      reason: "no-default-runtime",
      detail: "No default validation runtime is set. Choose one in Configure - Validation runtimes, then run this again."
    };
  }
  return resolveTier(inputs, defaultRuntimeId, "default");
}

/**
 * Picks between a project's rows (edge case H6). A studio-managed row wins only
 * when it is PINNED; otherwise the user's personal narrowing wins. An unpinned
 * managed row is a studio default, so it applies when the user has none.
 */
export function pickAssociation(
  associations: readonly RuntimeAssociation[],
  projectRootId: WorkspaceRootId
): RuntimeAssociation | undefined {
  const rows = associations.filter((row) => row.projectRootId === projectRootId);
  const managed = rows.find((row) => row.source === "managed");
  const personal = rows.find((row) => row.source === "personal");
  if (managed !== undefined && managed.pinned === true) return managed;
  if (personal !== undefined) return personal;
  return managed;
}

function resolveTier(
  inputs: ValidationRoutingInputs,
  runtimeId: ValidationRuntimeId,
  tier: CascadeTier
): ValidationRoutingResult {
  const runtime = inputs.runtimes.find((candidate) => candidate.runtimeId === runtimeId);
  if (runtime === undefined) {
    return {
      kind: "park",
      reason: "runtime-unavailable",
      detail: `${sentenceCase(TIER_LABEL[tier])} points at "${runtimeId}", which is no longer in the runtime registry. ${TIER_DANGLING_FIX[tier]}`
    };
  }
  if (runtime.archived === true) {
    return {
      kind: "park",
      reason: "runtime-archived",
      detail: `${sentenceCase(TIER_LABEL[tier])} is "${runtime.displayName}", which has been archived. Restore it or route this job to another runtime.`
    };
  }
  const availability = inputs.availability(runtimeId);
  if (availability === "quarantined") {
    return {
      kind: "park",
      reason: "runtime-quarantined",
      detail: `"${runtime.displayName}" is quarantined after a failed isolation check, so its queue is blocked. Review the probe log, or route this job to another runtime.`
    };
  }
  if (availability === "missing") {
    return {
      kind: "park",
      reason: "runtime-unavailable",
      detail: `"${runtime.displayName}" is registered but its VM is gone from Hyper-V. Re-adopt or rebuild it, or route this job to another runtime.`
    };
  }
  // "stopped" resolves for every lifecycle: booting is honest queue state
  // ("starting cpp-builds - ~40 s"), not a failure. The job service owns
  // surfacing that wait.
  return { kind: "resolved", runtime, source: tier };
}

// ---------------------------------------------------------------------------
// Policy deltas and reroutes
// ---------------------------------------------------------------------------

/**
 * The policy difference between two runtimes (ADR 0022), for the reroute
 * confirm. With no `from` runtime everything counts as changed - there is no
 * prior policy to claim equivalence with.
 */
export function computePolicyDelta(
  from: NamedRuntimeConfig | undefined,
  to: NamedRuntimeConfig
): ValidationPolicyDelta {
  const fromCapabilities = new Set(from?.capabilities ?? []);
  const toCapabilities = new Set(to.capabilities);
  return {
    profileChanged: from === undefined || from.policyProfileRef !== to.policyProfileRef,
    ...(from === undefined ? {} : { fromProfile: from.policyProfileRef }),
    toProfile: to.policyProfileRef,
    imageChanged: from === undefined || from.image !== to.image,
    capabilitiesAdded: [...toCapabilities].filter((capability) => !fromCapabilities.has(capability)).sort(),
    capabilitiesRemoved: [...fromCapabilities].filter((capability) => !toCapabilities.has(capability)).sort(),
    profileException: to.profileException === true
  };
}

/**
 * Whether moving work onto `to` is a one-click same-profile reroute (H1). Same
 * profile AND same image AND the same capability set is the only path to
 * one-click; a `profileException` target always confirms, because a standing
 * fixture set is a deliberate exception even when the profile ref matches.
 */
export function computeReroute(
  from: NamedRuntimeConfig | undefined,
  to: NamedRuntimeConfig
): ValidationRerouteDecision {
  const delta = computePolicyDelta(from, to);
  if (delta.profileException) return { kind: "needs-confirm", delta };
  if (from === undefined) return { kind: "needs-confirm", delta };
  if (delta.profileChanged || delta.imageChanged) return { kind: "needs-confirm", delta };
  if (delta.capabilitiesAdded.length > 0 || delta.capabilitiesRemoved.length > 0) {
    return { kind: "needs-confirm", delta };
  }
  return { kind: "same-profile" };
}

// ---------------------------------------------------------------------------
// Warm-set arithmetic
// ---------------------------------------------------------------------------

/** One runtime that will NOT be warm, with the sentence explaining why. */
export interface WarmSetDeferral {
  readonly runtimeId: ValidationRuntimeId;
  readonly reason: string;
}

/**
 * Which runtimes should be running (H4). `deferred` holds only runtimes that
 * will not be warm - pinned runtimes never appear there. When the pinned set
 * alone exceeds the cap they all stay warm and `capBreach` says so, because a
 * cap that cannot be honored must be visible rather than quietly ignored.
 */
export interface WarmSetPlan {
  readonly warm: readonly ValidationRuntimeId[];
  readonly deferred: readonly WarmSetDeferral[];
  /** Set only when pinned runtimes alone exceed the warm cap. */
  readonly capBreach?: string;
  readonly plannedAt: string;
}

/**
 * Plans the warm set (ADR 0022, edge case H4): pinned runtimes are always warm
 * and count against the cap; `keep-warm` runtimes fill whatever budget is left,
 * most recently updated first; `on-demand` runtimes are never warm. Archived
 * runtimes are ignored entirely.
 */
export function planWarmSet(
  runtimes: readonly NamedRuntimeConfig[],
  settings: ValidationRegistrySettings,
  now: string
): WarmSetPlan {
  const active = runtimes.filter((runtime) => runtime.archived !== true);
  const pinned = active.filter((runtime) => runtime.lifecycle === "pinned").sort(byRecency);
  const keepWarm = active.filter((runtime) => runtime.lifecycle === "keep-warm").sort(byRecency);
  const onDemand = active.filter((runtime) => runtime.lifecycle === "on-demand").sort(byRecency);

  const cap = settings.warmCap;
  const warm: ValidationRuntimeId[] = pinned.map((runtime) => runtime.runtimeId);
  const deferred: WarmSetDeferral[] = [];
  let capBreach: string | undefined;

  if (cap === undefined) {
    for (const runtime of keepWarm) warm.push(runtime.runtimeId);
  } else {
    if (pinned.length > cap) {
      capBreach = `warm cap ${cap} is exceeded by ${pinned.length} pinned runtimes - pinned runtimes always stay warm`;
    }
    const budget = Math.max(0, cap - pinned.length);
    keepWarm.forEach((runtime, index) => {
      if (index < budget) {
        warm.push(runtime.runtimeId);
        return;
      }
      deferred.push({
        runtimeId: runtime.runtimeId,
        reason: pinned.length >= cap
          ? `warm cap ${cap} reached by pinned runtimes - starts on demand`
          : `warm cap ${cap} reached - starts on demand`
      });
    });
  }

  for (const runtime of onDemand) {
    deferred.push({ runtimeId: runtime.runtimeId, reason: "on-demand - starts when a job routes to it" });
  }

  return {
    warm,
    deferred,
    ...(capBreach === undefined ? {} : { capBreach }),
    plannedAt: now
  };
}

/** Most recently updated first; ids break ties so plans are reproducible. */
function byRecency(left: NamedRuntimeConfig, right: NamedRuntimeConfig): number {
  if (left.updatedAt !== right.updatedAt) return right.updatedAt.localeCompare(left.updatedAt);
  return left.runtimeId.localeCompare(right.runtimeId);
}

// ---------------------------------------------------------------------------
// Topology presets
// ---------------------------------------------------------------------------

/**
 * Applies a topology preset (ux-flows F6). Presets are STARTING
 * CONFIGURATIONS, not modes: they seed settings and then get out of the way,
 * so nothing here removes a chosen default or warm cap.
 *
 * - `single`: clear the auto-create rule - one default, create nothing.
 * - `default-plus-named`: the model itself; only the preset field moves.
 * - `per-project`: arm lazy auto-create, keeping any existing rule.
 */
export function applyTopologyPreset(
  preset: ValidationTopologyPreset,
  current: ValidationRegistrySettings
): ValidationRegistrySettings {
  const base = {
    ...(current.defaultRuntimeId === undefined ? {} : { defaultRuntimeId: current.defaultRuntimeId }),
    ...(current.warmCap === undefined ? {} : { warmCap: current.warmCap })
  };
  if (preset === "single") {
    return { ...base, topologyPreset: "single" };
  }
  if (preset === "per-project") {
    return {
      ...base,
      topologyPreset: "per-project",
      autoCreate: current.autoCreate ?? { reapAfterIdleDays: DEFAULT_REAP_AFTER_IDLE_DAYS }
    };
  }
  return {
    ...base,
    topologyPreset: "default-plus-named",
    ...(current.autoCreate === undefined ? {} : { autoCreate: current.autoCreate })
  };
}

// ---------------------------------------------------------------------------
// Registry guards
// ---------------------------------------------------------------------------

/**
 * Whether a runtime may be deleted (edge case H5). The default runtime is never
 * deletable - it is re-pointed - because deleting it would dangle every project
 * that falls through to it. `affectedProjects` counts distinct projects whose
 * associations must be reassigned first.
 */
export type ValidationRuntimeDeleteCheck =
  | { readonly ok: true; readonly affectedProjects: number; readonly detail: string }
  | { readonly ok: false; readonly reason: "is-default" | "not-found"; readonly detail: string };

export function validateDelete(
  runtimeId: ValidationRuntimeId,
  runtimes: readonly NamedRuntimeConfig[],
  associations: readonly RuntimeAssociation[],
  settings: ValidationRegistrySettings
): ValidationRuntimeDeleteCheck {
  const runtime = runtimes.find((candidate) => candidate.runtimeId === runtimeId);
  if (runtime === undefined) {
    return {
      ok: false,
      reason: "not-found",
      detail: `"${runtimeId}" is not in the runtime registry - nothing to delete.`
    };
  }
  if (settings.defaultRuntimeId === runtimeId) {
    return {
      ok: false,
      reason: "is-default",
      detail: `"${runtime.displayName}" is the default runtime. Point the default at another runtime first, then delete it.`
    };
  }
  const affectedProjects = new Set(
    associations.filter((row) => row.runtimeId === runtimeId).map((row) => row.projectRootId)
  ).size;
  return {
    ok: true,
    affectedProjects,
    detail: affectedProjects === 0
      ? `"${runtime.displayName}" has no project associations.`
      : `${affectedProjects} project${affectedProjects === 1 ? "" : "s"} currently route${affectedProjects === 1 ? "s" : ""} to "${runtime.displayName}" and must be reassigned.`
  };
}

/**
 * Whether a runtime may be renamed (edge case H5). Renaming is display-only -
 * identity is the id, so associations, jobs, and receipts are untouched. The
 * only failure is renaming something that is not there. Exported for symmetry
 * with `validateDelete` so the UI can treat both actions the same way.
 */
export type ValidationRuntimeRenameCheck =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly reason: "not-found"; readonly detail: string };

export function validateRename(
  runtimeId: ValidationRuntimeId,
  runtimes: readonly NamedRuntimeConfig[]
): ValidationRuntimeRenameCheck {
  const runtime = runtimes.find((candidate) => candidate.runtimeId === runtimeId);
  if (runtime === undefined) {
    return {
      ok: false,
      reason: "not-found",
      detail: `"${runtimeId}" is not in the runtime registry - nothing to rename.`
    };
  }
  return {
    ok: true,
    detail: "Renaming changes the display name only - associations, queued jobs, and past evidence are unaffected."
  };
}

/** Uppercases the first letter of a label so it can open a sentence. */
function sentenceCase(value: string): string {
  return value.length === 0 ? value : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
