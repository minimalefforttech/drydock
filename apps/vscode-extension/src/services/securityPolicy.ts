/**
 * Host-side project and runtime policy.
 *
 * Personal settings may narrow access. An optional policy at the fixed,
 * administrator-managed OS location is merged on top and can only narrow it
 * further. The resulting snapshot is passed to every entry point that can
 * select a project, widen access, or start networked AI.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { assertMountAllowed, isPathWithin, normalizePathKey, pathMatchesCloneOmission, type ClonePathOmission } from "@drydock/core";

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
}

export interface LoadSecurityPolicyOptions {
  readonly baseDeniedPaths: readonly string[];
  readonly user: UserSecurityPreferences;
  /** Tests and administrative tooling may supply the same fixed path explicitly. */
  readonly studioPolicyPath?: string;
}

export class EffectiveSecurityPolicy {
  readonly managed: boolean;
  readonly policyId?: string;
  /** Undefined means unrestricted; an empty array intentionally permits none. */
  readonly allowedProjectRoots?: readonly string[];
  readonly deniedPaths: readonly string[];
  readonly cloneOnly: boolean;
  readonly allowNetworkedAiOnThisMachine: boolean;
  readonly cloneOmission: ClonePathOmission;

  constructor(input: {
    readonly managed: boolean;
    readonly policyId?: string;
    readonly allowedProjectRoots?: readonly string[];
    readonly deniedPaths: readonly string[];
    readonly cloneOnly: boolean;
    readonly allowNetworkedAiOnThisMachine: boolean;
    readonly cloneOmission: ClonePathOmission;
  }) {
    this.managed = input.managed;
    if (input.policyId !== undefined) this.policyId = input.policyId;
    if (input.allowedProjectRoots !== undefined) this.allowedProjectRoots = input.allowedProjectRoots;
    this.deniedPaths = input.deniedPaths;
    this.cloneOnly = input.cloneOnly;
    this.allowNetworkedAiOnThisMachine = input.allowNetworkedAiOnThisMachine;
    this.cloneOmission = input.cloneOmission;
  }

  /** Canonicalizes and validates an existing host directory at the final host boundary. */
  assertHostPathAllowed(candidate: string): string {
    const canonical = canonicalExistingDirectory(candidate, "Project/access path");
    this.assertCanonicalHostPathAllowed(canonical);
    return canonical;
  }

  /** Resolves an existing file target before allowing host-side AI prompt input. */
  assertHostFileAllowed(candidate: string): string {
    const canonical = canonicalExistingFile(candidate, "AI input file");
    this.assertCanonicalHostPathAllowed(canonical);
    return canonical;
  }

  private assertCanonicalHostPathAllowed(canonical: string): void {
    assertMountAllowed(canonical, this.deniedPaths);
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
  const studio = existsSync(studioPath) ? readStudioPolicy(studioPath) : undefined;
  const userAllowed = normalizeAllowedRoots(options.user.allowedProjectRoots, "drydock.security.allowedProjectRoots");
  const studioAllowed = studio?.allowedProjectRoots === undefined
    ? undefined
    : normalizeAllowedRoots(studio.allowedProjectRoots, `${studioPath}: allowedProjectRoots`, true);
  const studioDenied = (studio?.deniedPaths ?? []).map((value) => {
    if (!path.isAbsolute(value)) {
      throw new Error(`${studioPath}: deniedPaths must use absolute paths: ${value}`);
    }
    return value;
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
    ...(allowedProjectRoots === undefined ? {} : { allowedProjectRoots }),
    deniedPaths: dedupeHostPaths([
      ...options.baseDeniedPaths,
      ...studioDenied
    ]),
    cloneOnly,
    allowNetworkedAiOnThisMachine,
    cloneOmission: { sensitive: omitSensitiveFiles, paths: omittedRepoPaths }
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

function readStudioPolicy(policyPath: string): StudioSecurityPolicyDocument {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(policyPath, "utf8"));
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
    "allowNetworkedAiOnThisMachine"
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
  return value as unknown as StudioSecurityPolicyDocument;
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
  if (!path.isAbsolute(value)) {
    throw new Error(`${source} must use absolute paths: ${value}`);
  }
  const resolved = path.resolve(value);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`${source} is not an existing directory: ${resolved}`);
  }
  return realpathSync.native(resolved);
}

function canonicalExistingFile(value: string, source: string): string {
  if (!path.isAbsolute(value)) {
    throw new Error(`${source} must use an absolute path: ${value}`);
  }
  const resolved = path.resolve(value);
  if (!existsSync(resolved)) {
    throw new Error(`${source} does not exist: ${resolved}`);
  }
  const canonical = realpathSync.native(resolved);
  if (!statSync(canonical).isFile()) {
    throw new Error(`${source} is not a regular file: ${canonical}`);
  }
  return canonical;
}

function canonicalIfExisting(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
