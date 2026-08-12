/**
 * Validation-routing tests (ADR 0022): the three cascade tiers, the
 * managed/personal association precedence matrix (edge case H6), all four park
 * reasons and the no-fallthrough rule (H1), one-click vs policy-delta reroutes
 * (H2), warm-cap arithmetic including pinned overflow (H4), topology presets
 * (ux-flows F6), and the delete/rename registry guards (H5).
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { asId } from "@drydock/contracts";
import type {
  NamedRuntimeConfig,
  RuntimeAssociation,
  ValidationRegistrySettings,
  ValidationRuntimeAvailability,
  ValidationRuntimeId,
  ValidationRuntimeLifecycle
} from "@drydock/contracts";
import {
  DEFAULT_REAP_AFTER_IDLE_DAYS,
  applyTopologyPreset,
  computePolicyDelta,
  computeReroute,
  planWarmSet,
  resolveValidationRuntime,
  validateDelete,
  validateRename
} from "./validationRoutingService.js";

function rt(input: {
  runtimeId: string;
  displayName?: string;
  image?: string;
  lifecycle?: ValidationRuntimeLifecycle;
  capabilities?: readonly string[];
  policyProfileRef?: string;
  profileException?: boolean;
  archived?: boolean;
  updatedAt?: string;
}): NamedRuntimeConfig {
  return {
    runtimeId: asId<"ValidationRuntimeId">(input.runtimeId),
    displayName: input.displayName ?? input.runtimeId,
    image: input.image ?? "win11-dcc-2026.03",
    lifecycle: input.lifecycle ?? "keep-warm",
    capabilities: input.capabilities ?? ["maya", "houdini"],
    policyProfileRef: input.policyProfileRef ?? "validation_default",
    ...(input.profileException === undefined ? {} : { profileException: input.profileException }),
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-08-01T00:00:00.000Z",
    ...(input.archived === undefined ? {} : { archived: input.archived })
  };
}

function association(input: {
  projectRootId: string;
  runtimeId: string;
  source: "personal" | "managed";
  pinned?: boolean;
}): RuntimeAssociation {
  return {
    projectRootId: asId<"WorkspaceRootId">(input.projectRootId),
    runtimeId: asId<"ValidationRuntimeId">(input.runtimeId),
    source: input.source,
    ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
    updatedAt: "2026-08-12T09:00:00.000Z"
  };
}

/** Availability lookup: anything unnamed is available. */
function availabilityFrom(
  overrides: Readonly<Record<string, ValidationRuntimeAvailability>> = {}
): (runtimeId: ValidationRuntimeId) => ValidationRuntimeAvailability {
  return (runtimeId) => overrides[runtimeId] ?? "available";
}

const DEFAULT_RUNTIME = rt({ runtimeId: "vrt-default", displayName: "default" });
const CPP_RUNTIME = rt({
  runtimeId: "vrt-cpp",
  displayName: "cpp-builds",
  image: "win11-msvc-2026.03",
  capabilities: ["maya", "msvc"],
  policyProfileRef: "cpp_builds"
});
const PIPZONE_RUNTIME = rt({ runtimeId: "vrt-pipzone", displayName: "pipzone" });

const SETTINGS: ValidationRegistrySettings = {
  defaultRuntimeId: asId<"ValidationRuntimeId">("vrt-default"),
  topologyPreset: "default-plus-named"
};

test("the cascade resolves override, then association, then default", () => {
  const runtimes = [DEFAULT_RUNTIME, CPP_RUNTIME, PIPZONE_RUNTIME];
  const associations = [association({ projectRootId: "root-a", runtimeId: "vrt-pipzone", source: "personal" })];

  // Tier 1: an explicit chat/task override outranks everything below it.
  const override = resolveValidationRuntime({
    override: asId<"ValidationRuntimeId">("vrt-cpp"),
    projectRootId: asId<"WorkspaceRootId">("root-a"),
    runtimes,
    associations,
    settings: SETTINGS,
    availability: availabilityFrom()
  });
  assert.deepEqual(override, { kind: "resolved", runtime: CPP_RUNTIME, source: "override" });

  // Tier 2: the project's association.
  const associated = resolveValidationRuntime({
    projectRootId: asId<"WorkspaceRootId">("root-a"),
    runtimes,
    associations,
    settings: SETTINGS,
    availability: availabilityFrom()
  });
  assert.deepEqual(associated, { kind: "resolved", runtime: PIPZONE_RUNTIME, source: "association" });

  // Tier 3: a project with no row simply uses the default - absence is not an error.
  const defaulted = resolveValidationRuntime({
    projectRootId: asId<"WorkspaceRootId">("root-unmapped"),
    runtimes,
    associations,
    settings: SETTINGS,
    availability: availabilityFrom()
  });
  assert.deepEqual(defaulted, { kind: "resolved", runtime: DEFAULT_RUNTIME, source: "default" });

  // No project context at all also lands on the default.
  const noProject = resolveValidationRuntime({
    runtimes,
    associations,
    settings: SETTINGS,
    availability: availabilityFrom()
  });
  assert.equal(noProject.kind === "resolved" ? noProject.source : noProject.kind, "default");
});

test("managed association rows win only when pinned; personal narrowing wins otherwise", () => {
  const runtimes = [DEFAULT_RUNTIME, CPP_RUNTIME, PIPZONE_RUNTIME];
  const resolveWith = (associations: readonly RuntimeAssociation[]): string => {
    const result = resolveValidationRuntime({
      projectRootId: asId<"WorkspaceRootId">("root-a"),
      runtimes,
      associations,
      settings: SETTINGS,
      availability: availabilityFrom()
    });
    return result.kind === "resolved" ? result.runtime.displayName : `park:${result.kind}`;
  };

  const personal = association({ projectRootId: "root-a", runtimeId: "vrt-pipzone", source: "personal" });
  const managedPinned = association({ projectRootId: "root-a", runtimeId: "vrt-cpp", source: "managed", pinned: true });
  const managedLoose = association({ projectRootId: "root-a", runtimeId: "vrt-cpp", source: "managed" });

  // The full precedence matrix (H6): managed authority only when pinned.
  assert.equal(resolveWith([personal]), "pipzone");
  assert.equal(resolveWith([managedLoose]), "cpp-builds");
  assert.equal(resolveWith([managedPinned]), "cpp-builds");
  assert.equal(resolveWith([personal, managedPinned]), "cpp-builds");
  assert.equal(resolveWith([managedPinned, personal]), "cpp-builds");
  assert.equal(resolveWith([personal, managedLoose]), "pipzone");
  assert.equal(resolveWith([managedLoose, personal]), "pipzone");

  // Another project's rows never leak into this one.
  assert.equal(resolveWith([association({ projectRootId: "root-b", runtimeId: "vrt-cpp", source: "personal" })]), "default");
});

test("an unusable target parks with a reason instead of falling through to the next tier", () => {
  const archived = rt({ runtimeId: "vrt-old", displayName: "retired", archived: true });
  const runtimes = [DEFAULT_RUNTIME, CPP_RUNTIME, archived];

  // 1. No default configured and the cascade reaches the default tier.
  const noDefault = resolveValidationRuntime({
    runtimes,
    associations: [],
    settings: { topologyPreset: "single" },
    availability: availabilityFrom()
  });
  assert.equal(noDefault.kind, "park");
  assert.equal(noDefault.kind === "park" ? noDefault.reason : undefined, "no-default-runtime");
  assert.match(noDefault.kind === "park" ? noDefault.detail : "", /Configure/);

  // 2. Archived target - the registry says it is retired.
  const archivedResult = resolveValidationRuntime({
    override: asId<"ValidationRuntimeId">("vrt-old"),
    runtimes,
    associations: [],
    settings: SETTINGS,
    availability: availabilityFrom()
  });
  assert.equal(archivedResult.kind === "park" ? archivedResult.reason : undefined, "runtime-archived");
  assert.match(archivedResult.kind === "park" ? archivedResult.detail : "", /retired/);

  // 3. Dangling association - the detail names the id and the tier.
  const dangling = resolveValidationRuntime({
    projectRootId: asId<"WorkspaceRootId">("root-a"),
    runtimes,
    associations: [association({ projectRootId: "root-a", runtimeId: "vrt-ghost", source: "personal" })],
    settings: SETTINGS,
    availability: availabilityFrom()
  });
  assert.equal(dangling.kind === "park" ? dangling.reason : undefined, "runtime-unavailable");
  assert.match(dangling.kind === "park" ? dangling.detail : "", /vrt-ghost/);
  assert.match(dangling.kind === "park" ? dangling.detail : "", /association/);

  // 4. Registered but the VM is gone from the hypervisor.
  const missing = resolveValidationRuntime({
    runtimes,
    associations: [],
    settings: SETTINGS,
    availability: availabilityFrom({ "vrt-default": "missing" })
  });
  assert.equal(missing.kind === "park" ? missing.reason : undefined, "runtime-unavailable");

  // 5. Quarantined override parks - it does NOT quietly reroute to the healthy
  //    default, because silent rerouting is the whole thing this prevents.
  const quarantined = resolveValidationRuntime({
    override: asId<"ValidationRuntimeId">("vrt-cpp"),
    projectRootId: asId<"WorkspaceRootId">("root-a"),
    runtimes,
    associations: [association({ projectRootId: "root-a", runtimeId: "vrt-default", source: "personal" })],
    settings: SETTINGS,
    availability: availabilityFrom({ "vrt-cpp": "quarantined" })
  });
  assert.equal(quarantined.kind === "park" ? quarantined.reason : undefined, "runtime-quarantined");
  assert.match(quarantined.kind === "park" ? quarantined.detail : "", /cpp-builds/);

  // A broken association likewise parks rather than borrowing the default.
  const brokenAssociation = resolveValidationRuntime({
    projectRootId: asId<"WorkspaceRootId">("root-a"),
    runtimes,
    associations: [association({ projectRootId: "root-a", runtimeId: "vrt-old", source: "personal" })],
    settings: SETTINGS,
    availability: availabilityFrom()
  });
  assert.equal(brokenAssociation.kind, "park");

  // Resolution never invents a confirm - reroutes are a separate user action.
  for (const result of [noDefault, archivedResult, dangling, missing, quarantined, brokenAssociation]) {
    assert.notEqual(result.kind, "needs-confirm");
  }
});

test("a stopped runtime resolves for every lifecycle - booting is honest queue state", () => {
  const onDemand = rt({ runtimeId: "vrt-cpp2", displayName: "cpp-builds", lifecycle: "on-demand" });
  const pinned = rt({ runtimeId: "vrt-pin", displayName: "pinned-one", lifecycle: "pinned" });
  const runtimes = [DEFAULT_RUNTIME, onDemand, pinned];
  const availability = availabilityFrom({ "vrt-cpp2": "stopped", "vrt-pin": "stopped", "vrt-default": "stopped" });

  for (const runtimeId of ["vrt-cpp2", "vrt-pin", "vrt-default"]) {
    const result = resolveValidationRuntime({
      override: asId<"ValidationRuntimeId">(runtimeId),
      runtimes,
      associations: [],
      settings: SETTINGS,
      availability
    });
    assert.equal(result.kind, "resolved");
    assert.equal(result.kind === "resolved" ? result.runtime.runtimeId : "", asId<"ValidationRuntimeId">(runtimeId));
  }
});

test("reroute is one-click only when profile, image, and capabilities all match", () => {
  const twin = rt({ runtimeId: "vrt-twin", displayName: "twin" });
  const capabilityOrderShuffled = rt({ runtimeId: "vrt-shuffled", capabilities: ["houdini", "maya"] });

  // Identical policy (capability ORDER is not policy) - one click.
  assert.deepEqual(computeReroute(DEFAULT_RUNTIME, twin), { kind: "same-profile" });
  assert.deepEqual(computeReroute(DEFAULT_RUNTIME, capabilityOrderShuffled), { kind: "same-profile" });

  // Broadening: default -> cpp-builds gains msvc and loses houdini.
  const widening = computeReroute(DEFAULT_RUNTIME, CPP_RUNTIME);
  assert.equal(widening.kind, "needs-confirm");
  assert.deepEqual(widening.kind === "needs-confirm" ? widening.delta : undefined, {
    profileChanged: true,
    fromProfile: "validation_default",
    toProfile: "cpp_builds",
    imageChanged: true,
    capabilitiesAdded: ["msvc"],
    capabilitiesRemoved: ["houdini"],
    profileException: false
  });

  // Narrowing confirms too: silent narrowing just fails confusingly later.
  const narrowing = computeReroute(CPP_RUNTIME, DEFAULT_RUNTIME);
  assert.equal(narrowing.kind, "needs-confirm");
  assert.deepEqual(narrowing.kind === "needs-confirm" ? narrowing.delta.capabilitiesAdded : [], ["houdini"]);
  assert.deepEqual(narrowing.kind === "needs-confirm" ? narrowing.delta.capabilitiesRemoved : [], ["msvc"]);

  // Same profile ref but a different image is still a confirm.
  const rebuilt = rt({ runtimeId: "vrt-rebuilt", image: "win11-dcc-2026.08" });
  const imageOnly = computeReroute(DEFAULT_RUNTIME, rebuilt);
  assert.equal(imageOnly.kind, "needs-confirm");
  assert.equal(imageOnly.kind === "needs-confirm" ? imageOnly.delta.profileChanged : true, false);
  assert.equal(imageOnly.kind === "needs-confirm" ? imageOnly.delta.imageChanged : false, true);

  // A profile-exception target always confirms, even profile-for-profile (H2).
  const exception = rt({ runtimeId: "vrt-prod", displayName: "production_tester", profileException: true });
  const toException = computeReroute(DEFAULT_RUNTIME, exception);
  assert.equal(toException.kind, "needs-confirm");
  assert.equal(toException.kind === "needs-confirm" ? toException.delta.profileException : false, true);
  assert.equal(toException.kind === "needs-confirm" ? toException.delta.profileChanged : true, false);

  // Leaving an exception runtime for a plain one is an ordinary same-profile move.
  assert.deepEqual(computeReroute(exception, DEFAULT_RUNTIME), { kind: "same-profile" });

  // With no prior runtime there is nothing to claim equivalence with.
  const firstRoute = computeReroute(undefined, DEFAULT_RUNTIME);
  assert.equal(firstRoute.kind, "needs-confirm");
  assert.deepEqual(computePolicyDelta(undefined, DEFAULT_RUNTIME), {
    profileChanged: true,
    toProfile: "validation_default",
    imageChanged: true,
    capabilitiesAdded: ["houdini", "maya"],
    capabilitiesRemoved: [],
    profileException: false
  });
});

test("planWarmSet honours pinned runtimes, fills the cap by recency, and reports pinned overflow", () => {
  const pinned = rt({ runtimeId: "vrt-pin", lifecycle: "pinned", updatedAt: "2026-08-10T00:00:00.000Z" });
  const warmNew = rt({ runtimeId: "vrt-warm-new", lifecycle: "keep-warm", updatedAt: "2026-08-12T00:00:00.000Z" });
  const warmOld = rt({ runtimeId: "vrt-warm-old", lifecycle: "keep-warm", updatedAt: "2026-08-01T00:00:00.000Z" });
  const lazy = rt({ runtimeId: "vrt-lazy", lifecycle: "on-demand" });
  const gone = rt({ runtimeId: "vrt-gone", lifecycle: "keep-warm", archived: true });
  const runtimes = [warmOld, lazy, pinned, warmNew, gone];
  const now = "2026-08-12T12:00:00.000Z";

  // No cap: every pinned and keep-warm runtime is warm; archived ignored.
  const uncapped = planWarmSet(runtimes, { topologyPreset: "default-plus-named" }, now);
  assert.deepEqual(uncapped.warm, [
    asId<"ValidationRuntimeId">("vrt-pin"),
    asId<"ValidationRuntimeId">("vrt-warm-new"),
    asId<"ValidationRuntimeId">("vrt-warm-old")
  ]);
  assert.deepEqual(uncapped.deferred.map((entry) => entry.runtimeId), [asId<"ValidationRuntimeId">("vrt-lazy")]);
  assert.match(uncapped.deferred[0]?.reason ?? "", /on-demand/);
  assert.equal(uncapped.capBreach, undefined);
  assert.equal(uncapped.plannedAt, now);

  // Cap 2: pinned counts against it, so only the newest keep-warm fits.
  const capped = planWarmSet(runtimes, { topologyPreset: "default-plus-named", warmCap: 2 }, now);
  assert.deepEqual(capped.warm, [
    asId<"ValidationRuntimeId">("vrt-pin"),
    asId<"ValidationRuntimeId">("vrt-warm-new")
  ]);
  assert.deepEqual(capped.deferred.map((entry) => entry.runtimeId), [
    asId<"ValidationRuntimeId">("vrt-warm-old"),
    asId<"ValidationRuntimeId">("vrt-lazy")
  ]);
  assert.match(capped.deferred[0]?.reason ?? "", /warm cap 2/);
  assert.equal(capped.capBreach, undefined);

  // Pinned alone exceeds the cap: every pinned runtime stays warm, none is
  // deferred, and the breach is stated rather than silently ignored.
  const pinnedToo = rt({ runtimeId: "vrt-pin-2", lifecycle: "pinned", updatedAt: "2026-08-11T00:00:00.000Z" });
  const breached = planWarmSet([pinned, pinnedToo, warmNew, lazy], { topologyPreset: "default-plus-named", warmCap: 1 }, now);
  assert.deepEqual(breached.warm, [
    asId<"ValidationRuntimeId">("vrt-pin-2"),
    asId<"ValidationRuntimeId">("vrt-pin")
  ]);
  assert.match(breached.capBreach ?? "", /warm cap 1/);
  assert.match(breached.capBreach ?? "", /2 pinned/);
  assert.deepEqual(breached.deferred.map((entry) => entry.runtimeId), [
    asId<"ValidationRuntimeId">("vrt-warm-new"),
    asId<"ValidationRuntimeId">("vrt-lazy")
  ]);
  assert.match(breached.deferred[0]?.reason ?? "", /warm cap 1 reached by pinned runtimes/);

  // Cap 0 keeps nothing warm but still names the cap in every reason.
  const zero = planWarmSet([warmNew, warmOld], { topologyPreset: "single", warmCap: 0 }, now);
  assert.deepEqual(zero.warm, []);
  assert.equal(zero.deferred.length, 2);
  assert.match(zero.deferred[0]?.reason ?? "", /warm cap 0/);
});

test("topology presets seed settings without discarding the default or the warm cap", () => {
  const current: ValidationRegistrySettings = {
    defaultRuntimeId: asId<"ValidationRuntimeId">("vrt-default"),
    topologyPreset: "default-plus-named",
    warmCap: 2,
    autoCreate: { reapAfterIdleDays: 7 }
  };

  // "single" clears the auto-create rule and keeps everything else.
  assert.deepEqual(applyTopologyPreset("single", current), {
    defaultRuntimeId: asId<"ValidationRuntimeId">("vrt-default"),
    topologyPreset: "single",
    warmCap: 2
  });

  // "per-project" arms lazy auto-create with the shipped reap window...
  assert.deepEqual(applyTopologyPreset("per-project", { topologyPreset: "single" }), {
    topologyPreset: "per-project",
    autoCreate: { reapAfterIdleDays: DEFAULT_REAP_AFTER_IDLE_DAYS }
  });
  // ...but never overwrites a rule the studio already tuned.
  assert.deepEqual(applyTopologyPreset("per-project", current).autoCreate, { reapAfterIdleDays: 7 });

  // "default-plus-named" is the model itself: only the preset field moves.
  assert.deepEqual(applyTopologyPreset("default-plus-named", { ...current, topologyPreset: "single" }), current);
});

test("validateDelete guards the default and counts affected projects; rename is display-only", () => {
  const runtimes = [DEFAULT_RUNTIME, CPP_RUNTIME, PIPZONE_RUNTIME];
  const associations = [
    // One project with BOTH rows pointing at cpp-builds counts once.
    association({ projectRootId: "root-a", runtimeId: "vrt-cpp", source: "personal" }),
    association({ projectRootId: "root-a", runtimeId: "vrt-cpp", source: "managed", pinned: true }),
    association({ projectRootId: "root-b", runtimeId: "vrt-cpp", source: "personal" }),
    association({ projectRootId: "root-c", runtimeId: "vrt-pipzone", source: "personal" })
  ];

  // The default is re-pointed, never deleted (H5).
  const isDefault = validateDelete(asId<"ValidationRuntimeId">("vrt-default"), runtimes, associations, SETTINGS);
  assert.equal(isDefault.ok, false);
  assert.equal(isDefault.ok === false ? isDefault.reason : undefined, "is-default");
  assert.match(isDefault.detail, /default runtime/);

  const missing = validateDelete(asId<"ValidationRuntimeId">("vrt-ghost"), runtimes, associations, SETTINGS);
  assert.equal(missing.ok, false);
  assert.equal(missing.ok === false ? missing.reason : undefined, "not-found");

  const withAssociations = validateDelete(asId<"ValidationRuntimeId">("vrt-cpp"), runtimes, associations, SETTINGS);
  assert.equal(withAssociations.ok, true);
  assert.equal(withAssociations.ok === true ? withAssociations.affectedProjects : -1, 2);
  assert.match(withAssociations.detail, /2 projects/);

  const unused = validateDelete(asId<"ValidationRuntimeId">("vrt-cpp"), runtimes, [], SETTINGS);
  assert.equal(unused.ok === true ? unused.affectedProjects : -1, 0);
  assert.match(unused.detail, /no project associations/);

  // A registry with no default configured cannot trip the is-default guard.
  const noDefault = validateDelete(asId<"ValidationRuntimeId">("vrt-default"), runtimes, [], { topologyPreset: "single" });
  assert.equal(noDefault.ok, true);

  // Rename is always allowed for a runtime that exists - identity is the id.
  const rename = validateRename(asId<"ValidationRuntimeId">("vrt-default"), runtimes);
  assert.equal(rename.ok, true);
  assert.match(rename.detail, /display name/);
  const renameGhost = validateRename(asId<"ValidationRuntimeId">("vrt-ghost"), runtimes);
  assert.equal(renameGhost.ok, false);
  assert.equal(renameGhost.ok === false ? renameGhost.reason : undefined, "not-found");
});
