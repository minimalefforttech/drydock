/**
 * Host-side project and runtime policy.
 *
 * Personal settings may narrow access. An optional policy at the fixed,
 * administrator-managed OS location is merged on top and can only narrow it
 * further. The resulting snapshot is passed to every entry point that can
 * select a project, widen access, or start networked AI.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { ValidationTopologyPreset } from "@drydock/contracts";
import {
  assertMountAllowed,
  isHostPathAbsolute,
  isNativeHostPathAbsolute,
  isPathWithin,
  normalizeHostPath,
  normalizePathKey,
  pathMatchesCloneOmission,
  type ClonePathOmission
} from "@drydock/core";

export interface UserSecurityPreferences {
  /** Empty means no personal allowlist. */
  readonly allowedProjectRoots: readonly string[];
  readonly cloneOnly: boolean;
  readonly omitSensitiveFiles: boolean;
  /** Exact repo-relative files/folders; descendants are omitted too. */
  readonly omittedRepoPaths: readonly string[];
  readonly networkedAiEnabled: boolean;
}

export interface SecurityPolicySummary {
  readonly managed: boolean;
  readonly label: string;
  readonly cloneOnly: boolean;
  readonly allowedRootCount?: number;
  readonly networkedAiAllowed: boolean;
  readonly omissionsEnabled: boolean;
}

/**
 * Managed limits on ADR 0022 validation runtimes. Studio-only for now: the
 * personal counterpart arrives with the Configure UI, so every field here is
 * currently the whole truth rather than one side of a narrowing.
 */
export interface ValidationRuntimePolicy {
  /** Pins the topology preset; personal preset changes are ignored while pinned. */
  readonly topologyPin?: ValidationTopologyPreset;
  /** Managed ceiling on concurrently warm validation VMs; effective cap = min(personal, managed). */
  readonly warmCap?: number;
  /** Gates creating policy-profile-exception runtimes such as `production_tester`. */
  readonly profileExceptionCreation?: "td-only" | "disabled";
  /** Named runtimes may reference only these images; absent permits any image. */
  readonly imageAllowlist?: readonly string[];
}

interface StudioSecurityPolicyDocument {
  readonly version: 1;
  readonly policyId: string;
  readonly allowedProjectRoots?: readonly string[];
  readonly deniedPaths?: readonly string[];
  readonly cloneOnly?: boolean;
  readonly omitSensitiveFiles?: boolean;
  readonly omittedRepoPaths?: readonly string[];
  /** IT sets this true only on workstations allocated for networked AI. */
  readonly allowNetworkedAiOnThisMachine?: boolean;
  readonly validationRuntimes?: ValidationRuntimePolicy;
}

export interface LoadSecurityPolicyOptions {
  readonly baseDeniedPaths: readonly string[];
  readonly user: UserSecurityPreferences;
  /** Tests and administrative tooling may supply the same fixed path explicitly. */
  readonly studioPolicyPath?: string;
  /** Once managed mode has been observed, a missing policy must not downgrade access. */
  readonly requireStudioPolicy?: boolean;
  /** Optional administrator-owned marker that makes the fixed policy mandatory. */
  readonly studioPolicyRequiredPath?: string;
}

export class EffectiveSecurityPolicy {
  readonly managed: boolean;
  readonly policyId?: string;
  readonly policyFingerprint?: string;
  /** Undefined means unrestricted; an empty array intentionally permits none. */
  readonly allowedProjectRoots?: readonly string[];
  readonly deniedPaths: readonly string[];
  readonly cloneOnly: boolean;
  readonly allowNetworkedAiOnThisMachine: boolean;
  readonly cloneOmission: ClonePathOmission;
  /**
   * Managed validation-runtime limits, present only when the studio policy
   * declares them. Nothing enforces them yet: the registry service reads this
   * surface in M7 to honor the pin, the cap, the creation gate, and the image
   * allowlist. Absent means "no managed limit", not "denied".
   */
  readonly validationRuntimes?: ValidationRuntimePolicy;

  constructor(input: {
    readonly managed: boolean;
    readonly policyId?: string;
    readonly policyFingerprint?: string;
    readonly studioPolicyPath?: string;
    readonly studioPolicyRequiredPath?: string;
    readonly allowedProjectRoots?: readonly string[];
    readonly deniedPaths: readonly string[];
    readonly cloneOnly: boolean;
    readonly allowNetworkedAiOnThisMachine: boolean;
    readonly cloneOmission: ClonePathOmission;
    readonly validationRuntimes?: ValidationRuntimePolicy;
  }) {
    this.managed = input.managed;
    if (input.policyId !== undefined) this.policyId = input.policyId;
    if (input.policyFingerprint !== undefined) this.policyFingerprint = input.policyFingerprint;
    if (input.allowedProjectRoots !== undefined) this.allowedProjectRoots = input.allowedProjectRoots;
    this.deniedPaths = input.deniedPaths;
    this.cloneOnly = input.cloneOnly;
    this.allowNetworkedAiOnThisMachine = input.allowNetworkedAiOnThisMachine;
    this.cloneOmission = input.cloneOmission;
    if (input.validationRuntimes !== undefined) this.validationRuntimes = input.validationRuntimes;
    if (input.studioPolicyPath !== undefined) this.studioPolicyPath = input.studioPolicyPath;
    if (input.studioPolicyRequiredPath !== undefined) this.studioPolicyRequiredPath = input.studioPolicyRequiredPath;
  }

  private readonly studioPolicyPath?: string;
  private readonly studioPolicyRequiredPath?: string;

  /** Fails closed if administrator policy changed after this snapshot was loaded. */
  assertPolicyCurrent(): void {
    // Direct construction remains available to unit tests and embedders. Only
    // policies loaded from the fixed boundary carry freshness paths.
    if (this.studioPolicyPath === undefined || this.studioPolicyRequiredPath === undefined) return;
    const policyExists = existsSync(this.studioPolicyPath);
    const policyRequired = existsSync(this.studioPolicyRequiredPath);
    if (policyExists !== this.managed || (!this.managed && policyRequired)) {
      throw stalePolicyError();
    }
    if (this.managed) {
      try {
        const currentFingerprint = fingerprint(readFileSync(this.studioPolicyPath));
        if (currentFingerprint !== this.policyFingerprint) throw stalePolicyError();
      } catch (error) {
        if (isStalePolicyError(error)) throw error;
        throw stalePolicyError();
      }
    }
  }

  /** Canonicalizes and validates an existing host directory at the final host boundary. */
  assertHostPathAllowed(candidate: string): string {
    this.assertPolicyCurrent();
    const canonical = canonicalExistingDirectory(candidate, "Project/access path");
    this.assertCanonicalHostPathAllowed(canonical);
    return canonical;
  }

  /** Resolves an existing file target before allowing host-side AI prompt input. */
  assertHostFileAllowed(candidate: string): string {
    this.assertPolicyCurrent();
    const canonical = canonicalExistingFile(candidate, "AI input file");
    this.assertCanonicalHostPathAllowed(canonical);
    return canonical;
  }

  private assertCanonicalHostPathAllowed(canonical: string): void {
    // Re-resolve deny aliases at the final boundary. A missing sensitive leaf
    // may appear later, or an administrator-controlled link may have changed
    // since startup; retaining lexical and canonical forms keeps both denied.
    assertMountAllowed(canonical, expandDeniedPaths(this.deniedPaths));
    if (
      this.allowedProjectRoots !== undefined
      && !this.allowedProjectRoots.some((allowed) => isPathWithin(canonical, allowed))
    ) {
      throw new Error(`AI access to ${canonical} is outside the configured project allowlist.`);
    }
  }

  isHostPathAllowed(candidate: string): boolean {
    try {
      this.assertHostPathAllowed(candidate);
      return true;
    } catch {
      return false;
    }
  }

  assertNetworkedAiAllowed(): void {
    this.assertPolicyCurrent();
    if (!this.allowNetworkedAiOnThisMachine) {
      throw new Error("Networked AI is disabled on this machine by the effective security policy. Use a studio-allocated AI workstation.");
    }
  }

  summary(): SecurityPolicySummary {
    const parts = [this.managed ? "Managed" : "Personal policy"];
    if (this.cloneOnly) parts.push("Clone only");
    if (this.allowedProjectRoots !== undefined) {
      parts.push(`${String(this.allowedProjectRoots.length)} allowed root${this.allowedProjectRoots.length === 1 ? "" : "s"}`);
    }
    if (this.cloneOmission.sensitive || this.cloneOmission.paths.length > 0) parts.push("Omissions on");
    const validation = describeValidationRuntimes(this.validationRuntimes);
    if (validation !== undefined) parts.push(validation);
    parts.push(this.allowNetworkedAiOnThisMachine ? "Network approved" : "Network blocked");
    return {
      managed: this.managed,
      label: parts.join(" · "),
      cloneOnly: this.cloneOnly,
      ...(this.allowedProjectRoots === undefined ? {} : { allowedRootCount: this.allowedProjectRoots.length }),
      networkedAiAllowed: this.allowNetworkedAiOnThisMachine,
      omissionsEnabled: this.cloneOmission.sensitive || this.cloneOmission.paths.length > 0
    };
  }
}

/** Loads the fixed studio policy if present, then intersects it with personal restrictions. */
export function loadEffectiveSecurityPolicy(options: LoadSecurityPolicyOptions): EffectiveSecurityPolicy {
  const studioPath = options.studioPolicyPath ?? defaultStudioPolicyPath();
  const requiredPath = options.studioPolicyRequiredPath ?? defaultStudioPolicyRequiredPath();
  const studioResult = existsSync(studioPath) ? readStudioPolicy(studioPath) : undefined;
  if (studioResult === undefined && (options.requireStudioPolicy === true || existsSync(requiredPath))) {
    throw new Error(`The managed security policy is required but missing from ${studioPath}. Restore it and reload the window.`);
  }
  const studio = studioResult?.document;
  const userAllowed = normalizeAllowedRoots(options.user.allowedProjectRoots, "drydock.security.allowedProjectRoots");
  const studioAllowed = studio?.allowedProjectRoots === undefined
    ? undefined
    : normalizeAllowedRoots(studio.allowedProjectRoots, `${studioPath}: allowedProjectRoots`, true);
  const baseDenied = options.baseDeniedPaths.map((value) => {
    if (!isHostPathAbsolute(value)) {
      throw new Error(`Configured denied paths must use absolute paths: ${value}`);
    }
    return normalizeHostPath(value);
  });
  const studioDenied = (studio?.deniedPaths ?? []).map((value) => {
    if (!isHostPathAbsolute(value)) {
      throw new Error(`${studioPath}: deniedPaths must use absolute paths: ${value}`);
    }
    return normalizeHostPath(value);
  });
  const allowedProjectRoots = intersectAllowlists(studioAllowed, userAllowed);
  const omittedRepoPaths = normalizeRepoRelativePaths([
    ...(studio?.omittedRepoPaths ?? []),
    ...options.user.omittedRepoPaths
  ]);
  const omitSensitiveFiles = options.user.omitSensitiveFiles || studio?.omitSensitiveFiles === true;
  const cloneOnly = options.user.cloneOnly || studio?.cloneOnly === true || omitSensitiveFiles || omittedRepoPaths.length > 0;
  // Managed deployments must explicitly allocate the workstation. Omitting
  // the field fails closed; an unmanaged personal policy keeps today's default.
  const studioAllowsNetwork = studio === undefined || studio.allowNetworkedAiOnThisMachine === true;
  const allowNetworkedAiOnThisMachine = options.user.networkedAiEnabled && studioAllowsNetwork;

  return new EffectiveSecurityPolicy({
    managed: studio !== undefined,
    ...(studio === undefined ? {} : { policyId: studio.policyId }),
    ...(studioResult === undefined ? {} : { policyFingerprint: studioResult.fingerprint }),
    studioPolicyPath: studioPath,
    studioPolicyRequiredPath: requiredPath,
    ...(allowedProjectRoots === undefined ? {} : { allowedProjectRoots }),
    deniedPaths: expandDeniedPaths([
      ...baseDenied,
      ...studioDenied
    ]),
    cloneOnly,
    allowNetworkedAiOnThisMachine,
    cloneOmission: { sensitive: omitSensitiveFiles, paths: omittedRepoPaths },
    // Studio-only today. When personal validation settings ship they narrow
    // this the same way every other layer does; they never widen it.
    ...(studio?.validationRuntimes === undefined ? {} : { validationRuntimes: studio.validationRuntimes })
  });
}

export function defaultStudioPolicyPath(
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === "win32") {
    // Deliberately do not consult %ProgramData%: a user can override process
    // environment variables when launching VS Code and redirect the policy.
    return "C:\\ProgramData\\Drydock\\policy.json";
  }
  if (platform === "darwin") {
    return "/Library/Application Support/Drydock/policy.json";
  }
  return "/etc/drydock/policy.json";
}

export function defaultStudioPolicyRequiredPath(
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === "win32") return "C:\\ProgramData\\Drydock\\policy.required";
  if (platform === "darwin") return "/Library/Application Support/Drydock/policy.required";
  return "/etc/drydock/policy.required";
}

/** Only permitted, non-omitted repositories may contribute AI-bound overlays. */
export function filterPolicyOverlayRoots(
  policy: EffectiveSecurityPolicy | undefined,
  roots: readonly string[],
  repoRelativeFile: string
): string[] {
  if (policy === undefined || pathMatchesCloneOmission(repoRelativeFile, policy.cloneOmission)) return [];
  return roots.filter((root) => policy.isHostPathAllowed(root));
}

/** Resolves the real overlay target so links cannot redirect AI input outside policy. */
export function resolvePolicyOverlayFile(
  policy: EffectiveSecurityPolicy | undefined,
  projectRoot: string,
  candidate: string
): string | undefined {
  if (policy === undefined) return undefined;
  try {
    const canonicalRoot = policy.assertHostPathAllowed(projectRoot);
    const canonicalFile = policy.assertHostFileAllowed(candidate);
    if (!isPathWithin(canonicalFile, canonicalRoot)) return undefined;
    const repoRelativeTarget = path.relative(canonicalRoot, canonicalFile).replace(/\\/g, "/");
    if (pathMatchesCloneOmission(repoRelativeTarget, policy.cloneOmission)) return undefined;
    return canonicalFile;
  } catch {
    return undefined;
  }
}

/** Global memories have no project provenance yet, so restricted policies cannot inject them. */
export function blocksGlobalMemoryBriefing(policy: EffectiveSecurityPolicy | undefined): boolean {
  return policy !== undefined && (
    policy.managed
    || policy.allowedProjectRoots !== undefined
    || policy.cloneOmission.sensitive
    || policy.cloneOmission.paths.length > 0
  );
}

function readStudioPolicy(policyPath: string): {
  readonly document: StudioSecurityPolicyDocument;
  readonly fingerprint: string;
} {
  let raw: Buffer;
  let value: unknown;
  try {
    raw = readFileSync(policyPath);
    value = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new Error(`Studio security policy ${policyPath} is unreadable or invalid JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(value) || value["version"] !== 1 || typeof value["policyId"] !== "string" || value["policyId"].trim() === "") {
    throw new Error(`Studio security policy ${policyPath} must contain version 1 and a non-empty policyId.`);
  }
  const knownFields = new Set([
    "version",
    "policyId",
    "allowedProjectRoots",
    "deniedPaths",
    "cloneOnly",
    "omitSensitiveFiles",
    "omittedRepoPaths",
    "allowNetworkedAiOnThisMachine",
    "validationRuntimes"
  ]);
  const unknown = Object.keys(value).filter((field) => !knownFields.has(field));
  if (unknown.length > 0) {
    throw new Error(`Studio security policy ${policyPath} contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
  }
  for (const field of ["allowedProjectRoots", "deniedPaths", "omittedRepoPaths"] as const) {
    const entry = value[field];
    if (entry !== undefined && (!Array.isArray(entry) || !entry.every((item) => typeof item === "string"))) {
      throw new Error(`Studio security policy ${policyPath}: ${field} must be an array of strings.`);
    }
  }
  for (const field of ["cloneOnly", "omitSensitiveFiles", "allowNetworkedAiOnThisMachine"] as const) {
    const entry = value[field];
    if (entry !== undefined && typeof entry !== "boolean") {
      throw new Error(`Studio security policy ${policyPath}: ${field} must be a boolean.`);
    }
  }
  assertValidationRuntimePolicy(value["validationRuntimes"], policyPath);
  return {
    document: value as unknown as StudioSecurityPolicyDocument,
    fingerprint: fingerprint(raw)
  };
}

const TOPOLOGY_PINS: readonly ValidationTopologyPreset[] = ["single", "default-plus-named", "per-project"];
const PROFILE_EXCEPTION_GATES: readonly string[] = ["td-only", "disabled"];

/**
 * Validates the optional `validationRuntimes` object field by field. It is
 * strict inside the object as well: a misspelled limit must fail loudly rather
 * than silently leave a validation runtime unrestricted.
 */
function assertValidationRuntimePolicy(entry: unknown, policyPath: string): void {
  if (entry === undefined) return;
  if (!isRecord(entry)) {
    throw new Error(`Studio security policy ${policyPath}: validationRuntimes must be an object.`);
  }
  const knownFields = new Set(["topologyPin", "warmCap", "profileExceptionCreation", "imageAllowlist"]);
  const unknown = Object.keys(entry).filter((field) => !knownFields.has(field));
  if (unknown.length > 0) {
    throw new Error(`Studio security policy ${policyPath}: validationRuntimes contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
  }
  const topologyPin = entry["topologyPin"];
  if (topologyPin !== undefined && !TOPOLOGY_PINS.includes(topologyPin as ValidationTopologyPreset)) {
    throw new Error(`Studio security policy ${policyPath}: validationRuntimes.topologyPin must be one of ${TOPOLOGY_PINS.join(", ")}.`);
  }
  const warmCap = entry["warmCap"];
  if (warmCap !== undefined && (typeof warmCap !== "number" || !Number.isInteger(warmCap) || warmCap < 0)) {
    throw new Error(`Studio security policy ${policyPath}: validationRuntimes.warmCap must be a non-negative whole number.`);
  }
  const profileExceptionCreation = entry["profileExceptionCreation"];
  if (profileExceptionCreation !== undefined && !PROFILE_EXCEPTION_GATES.includes(profileExceptionCreation as string)) {
    throw new Error(`Studio security policy ${policyPath}: validationRuntimes.profileExceptionCreation must be ${PROFILE_EXCEPTION_GATES.join(" or ")}.`);
  }
  const imageAllowlist = entry["imageAllowlist"];
  if (imageAllowlist !== undefined && (!Array.isArray(imageAllowlist) || !imageAllowlist.every((item) => typeof item === "string"))) {
    throw new Error(`Studio security policy ${policyPath}: validationRuntimes.imageAllowlist must be an array of strings.`);
  }
}

/** One terse glance line; `td-only` is ADR 0022's default, so only a removal is worth a word. */
function describeValidationRuntimes(policy: ValidationRuntimePolicy | undefined): string | undefined {
  if (policy === undefined) return undefined;
  const facts: string[] = [];
  if (policy.topologyPin !== undefined) facts.push("topology pinned");
  if (policy.warmCap !== undefined) facts.push(`warm cap ${String(policy.warmCap)}`);
  if (policy.profileExceptionCreation === "disabled") facts.push("no profile exceptions");
  if (policy.imageAllowlist !== undefined) {
    facts.push(`${String(policy.imageAllowlist.length)} allowed image${policy.imageAllowlist.length === 1 ? "" : "s"}`);
  }
  return facts.length === 0 ? undefined : `Validation: ${facts.join(", ")}`;
}

const STALE_POLICY_MESSAGE = "The managed security policy changed after startup. Reload the window before continuing.";

function fingerprint(value: NodeJS.ArrayBufferView): string {
  return createHash("sha256").update(value).digest("hex");
}

function stalePolicyError(): Error {
  return new Error(STALE_POLICY_MESSAGE);
}

function isStalePolicyError(error: unknown): boolean {
  return error instanceof Error && error.message === STALE_POLICY_MESSAGE;
}

function normalizeAllowedRoots(values: readonly string[], source: string, preserveEmpty = false): readonly string[] | undefined {
  if (values.length === 0) return preserveEmpty ? [] : undefined;
  return minimizeRoots(values.map((value) => canonicalExistingDirectory(value, source)));
}

/** The intersection is the more-specific root whenever two allowed trees overlap. */
function intersectAllowlists(
  first: readonly string[] | undefined,
  second: readonly string[] | undefined
): readonly string[] | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  const intersections: string[] = [];
  for (const left of first) {
    for (const right of second) {
      if (isPathWithin(left, right)) intersections.push(left);
      else if (isPathWithin(right, left)) intersections.push(right);
    }
  }
  return minimizeRoots(intersections);
}

function minimizeRoots(values: readonly string[]): string[] {
  const deduped = dedupeHostPaths(values);
  return deduped.filter((candidate, index) =>
    !deduped.some((other, otherIndex) => otherIndex !== index && isPathWithin(candidate, other))
  );
}

function dedupeHostPaths(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const canonical = canonicalIfExisting(value);
    const key = normalizePathKey(canonical);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(canonical);
  }
  return result;
}

/** Keeps both configured spellings and their current canonical targets. */
function expandDeniedPaths(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    for (const candidate of [normalizeHostPath(value), canonicalIfExisting(value)]) {
      const key = normalizePathKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(candidate);
    }
  }
  return result;
}

function normalizeRepoRelativePaths(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const normalized = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
    if (normalized === "" || path.posix.isAbsolute(normalized) || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`Omitted repo path must be a simple repo-relative file or folder: ${raw}`);
    }
    if (normalized.toLowerCase() === ".git" || normalized.toLowerCase().startsWith(".git/")) {
      throw new Error(`Repository metadata cannot be omitted from a working clone: ${raw}`);
    }
    const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function canonicalExistingDirectory(value: string, source: string): string {
  if (!isHostPathAbsolute(value)) {
    throw new Error(`${source} must use absolute paths: ${value}`);
  }
  const resolved = normalizeHostPath(value);
  if (!isNativeHostPathAbsolute(resolved) || !existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`${source} is not an existing directory: ${resolved}`);
  }
  return realpathSync.native(resolved);
}

function canonicalExistingFile(value: string, source: string): string {
  if (!isHostPathAbsolute(value)) {
    throw new Error(`${source} must use an absolute path: ${value}`);
  }
  const resolved = normalizeHostPath(value);
  if (!isNativeHostPathAbsolute(resolved) || !existsSync(resolved)) {
    throw new Error(`${source} does not exist: ${resolved}`);
  }
  const canonical = realpathSync.native(resolved);
  if (!statSync(canonical).isFile()) {
    throw new Error(`${source} is not a regular file: ${canonical}`);
  }
  return canonical;
}

function canonicalIfExisting(value: string): string {
  const resolved = normalizeHostPath(value);
  if (!isNativeHostPathAbsolute(resolved)) return resolved;
  let existingPrefix = resolved;
  const missingSuffix: string[] = [];
  while (true) {
    try {
      const canonicalPrefix = realpathSync.native(existingPrefix);
      return missingSuffix.length === 0 ? canonicalPrefix : path.join(canonicalPrefix, ...missingSuffix);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return resolved;
      const parent = path.dirname(existingPrefix);
      if (parent === existingPrefix) return resolved;
      missingSuffix.unshift(path.basename(existingPrefix));
      existingPrefix = parent;
    }
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
