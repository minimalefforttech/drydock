/**
 * Validation-runtime webview types (ADR 0022, M7b).
 *
 * Contract types re-exported from @drydock/contracts (the single source of
 * truth since M7a landed), the display names some surfaces adopted for them,
 * and the bridge-boundary request/response/push unions the four bundles cast
 * with (see `validationRequest` in each consumer). Display helpers shared by
 * the validation surfaces live at the bottom - they are not contract mirror.
 */

// ---------------------------------------------------------------------------
// Contract types (re-exported from @drydock/contracts - the single source of
// truth now that M7a has landed; only bridge-boundary unions stay local)
// ---------------------------------------------------------------------------

export type {
  ValidationAssociationRow,
  ValidationConfigState,
  ValidationJobView,
  ValidationProbeLine,
  ValidationProjectRow,
  ValidationRailDot,
  ValidationReceiptView,
  ValidationRuntimeRow
} from "@drydock/contracts";
export type {
  ValidationRuntimeLifecycle as ValidationLifecycle,
  ValidationTopologyPreset,
  ValidationJobState,
  ValidationProbeSummary as ValidationProbes,
  ValidationSettingsSummary as ValidationSettingsView,
  ValidationManagedSummary as ValidationManagedPolicy,
  ValidationQuarantineRow as ValidationQuarantineEntry,
  ValidationRequeueView as ValidationRequeueResult,
  ValidationConnectionInput as ValidationRuntimeConnectionView,
  ValidationPolicyDelta as ValidationPolicyDeltaView,
  ValidationRuntimeUpdateInput as ValidationRuntimeUpdate
} from "@drydock/contracts";

import type {
  ValidationConfigState,
  ValidationConnectionInput,
  ValidationJobState,
  ValidationJobView,
  ValidationRailDot,
  ValidationRequeueView,
  ValidationRuntimeLifecycle,
  ValidationRuntimeRow,
  ValidationRuntimeUpdateInput,
  ValidationTopologyPreset
} from "@drydock/contracts";

/** The row's availability vocabulary, derived so it can never drift. */
export type ValidationAvailability = ValidationRuntimeRow["availability"];
export type ValidationProbeState = NonNullable<ValidationRuntimeRow["probes"]>["state"];

/**
 * The fields `AccessRequestSummary` carries for the fixture card (F3); all
 * three ship in @drydock/contracts now (`sizeLabel` landed with integration).
 */
export interface AccessProductionFields {
  readonly production?: boolean;
  readonly disposition?: "mount" | "snapshot";
  readonly sizeLabel?: string;
}

/** The two fields `hub.state`'s payload gains for the task-header picker (F6). */
export interface HubValidationFields {
  readonly validationRuntimeLabel?: string;
  readonly validationRuntimes?: readonly { readonly runtimeId: string; readonly displayName: string }[];
}

// ---------------------------------------------------------------------------
// Bridge-boundary unions (local: narrowed views of PanelRequest/Response/Push
// payloads; member shapes come from the re-exports above)
// ---------------------------------------------------------------------------

export interface ValidationRuntimeInput {
  readonly displayName: string;
  readonly image: string;
  readonly lifecycle: ValidationRuntimeLifecycle;
  readonly capabilities: readonly string[];
  readonly policyProfileRef: string;
  readonly profileException?: boolean;
  readonly connection?: ValidationConnectionInput;
}

export type ValidationRequest =
  | { readonly type: "config.validation.state" }
  | ({ readonly type: "config.validation.createRuntime" } & ValidationRuntimeInput)
  | { readonly type: "config.validation.updateRuntime"; readonly runtimeId: string; readonly update: ValidationRuntimeUpdateInput }
  | { readonly type: "config.validation.deleteRuntime"; readonly runtimeId: string; readonly reassignTo?: string }
  | { readonly type: "config.validation.setDefault"; readonly runtimeId: string }
  | { readonly type: "config.validation.setSettings"; readonly topologyPreset?: ValidationTopologyPreset; readonly warmCap?: number | null }
  | { readonly type: "config.validation.setAssociation"; readonly projectRootId: string; readonly runtimeId: string }
  | { readonly type: "config.validation.clearAssociation"; readonly projectRootId: string }
  | { readonly type: "config.validation.runProbes"; readonly runtimeId: string }
  | { readonly type: "config.validation.adopt"; readonly runtimeId: string }
  | { readonly type: "config.validation.revertReprobe"; readonly runtimeId: string }
  | { readonly type: "validation.jobs"; readonly taskId?: string; readonly sessionId?: string }
  | { readonly type: "validation.abortJob"; readonly jobId: string }
  | {
      readonly type: "validation.requeue";
      readonly jobId: string;
      readonly rerouteTo?: string;
      /** The user accepted the policy delta the previous call returned. */
      readonly confirmedDelta?: boolean;
    }
  | { readonly type: "validation.setTaskRuntime"; readonly taskId: string; readonly runtimeId?: string }
  | { readonly type: "validation.railStatus" }
  | { readonly type: "validation.run"; readonly sessionId: string };

export type ValidationResponse =
  | { readonly type: "config.validation.state"; readonly state: ValidationConfigState }
  | { readonly type: "config.validation.ack" }
  | { readonly type: "validation.jobs"; readonly jobs: readonly ValidationJobView[] }
  | { readonly type: "validation.requeue"; readonly result: ValidationRequeueView }
  | { readonly type: "validation.railStatus"; readonly dot: ValidationRailDot; readonly line: string }
  | { readonly type: "validation.ack" };

/**
 * What a bridge `request()` resolves to once cast. Mirrors `PanelResponse`'s
 * shape narrowed to the validation payloads; an `ok: true` envelope carrying
 * some other payload type simply fails the caller's `type` check.
 */
export type ValidationResponseEnvelope =
  | { readonly ok: true; readonly payload: ValidationResponse }
  | { readonly ok: false; readonly error: { readonly message: string } };

export type ValidationPush =
  | {
      readonly type: "validation.jobChanged";
      readonly jobId: string;
      readonly state: ValidationJobState;
      readonly taskId?: string;
      readonly sessionId?: string;
    }
  | { readonly type: "validation.changed" }
  | {
      readonly type: "validation.quarantine";
      readonly runtimeId: string;
      readonly displayName: string;
      readonly probeId: string;
      readonly detail: string;
      readonly at: string;
    };

// ---------------------------------------------------------------------------
// Display helpers (NOT part of the mirror - shared by the four surfaces)
// ---------------------------------------------------------------------------

/** `09:12` from an ISO stamp; the raw value when it will not parse. */
export function clockTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return `${String(parsed.getHours()).padStart(2, "0")}:${String(parsed.getMinutes()).padStart(2, "0")}`;
}

/** `0:41` / `12:05` - the running chip's wall clock. */
export function clockSpan(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(total / 60))}:${String(total % 60).padStart(2, "0")}`;
}

/** `1 m 42 s` / `42 s` - the settled duration style F2 writes. */
export function wordSpan(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${String(seconds)} s`;
  return `${String(minutes)} m ${String(seconds).padStart(2, "0")} s`;
}

/** Middle-truncates a long name/path; callers set `title` to the full value. */
export function middleTruncate(value: string, max = 44): string {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

/** Last path segment, tolerant of both separators. */
export function baseName(value: string): string {
  const parts = value.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? value;
}

/** Everything before the last segment, with its trailing separator kept. */
export function dirName(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return cut === -1 ? "" : trimmed.slice(0, cut + 1);
}

/** First 8 characters of a hash/ref - the L2 receipt style. */
export function shortRef(value: string): string {
  return value.length <= 10 ? value : value.slice(0, 8);
}

/**
 * The F5 quarantine sentence, built from the incident and (when known) the last
 * green probe. Unknown green renders as unknown - never as a guess.
 */
export function quarantineSentence(detail: string, at: string, greenAt?: string): string {
  const since = greenAt === undefined
    ? "No jobs have run since it was quarantined, and no green probe is on record."
    : `No jobs ran since the last green probe at ${clockTime(greenAt)}.`;
  return `Validation runtime quarantined — ${detail} at ${clockTime(at)}. Queue blocked. ${since}`;
}
