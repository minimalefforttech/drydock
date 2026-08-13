/**
 * Client-side mirror of packages/core/src/mountPolicy.ts's sensitive-path
 * matcher (T2.4 audit fix).
 *
 * accessCard.ts needs to re-classify the EDITED host-path input live, without
 * a host round-trip, so an edited path gets the same sensitive-path/typed-
 * confirm treatment a fresh request for that path would get. The webview
 * bundle cannot import @drydock/core - webview-ui/tsconfig.json's project
 * references list only @drydock/contracts, and nothing else in this bundle
 * pulls in host-only packages - so this is a deliberate, pure, dependency-free
 * copy. Keep the segment/pattern lists in sync with mountPolicy.ts's
 * SENSITIVE_SEGMENTS / SENSITIVE_BASENAME_PATTERNS, and the reason wording in
 * sync with workspaceReviewAppService.ts's toAccessRequestSummary (what
 * actually stamps `sensitive`/`sensitiveReason` on the ORIGINAL request).
 *
 * No unit test lives here on purpose: this project compiles with
 * `"types": []` (browser purity - no node test runner), so the patterns'
 * automated coverage is core's mountPolicy.test.ts on the source lists, and
 * the edited-path behavior is harness row V85 in
 * tools/webview-harness/visual-tests.md.
 */

/** Path segments that mark a directory as credential/secret-bearing. */
const SENSITIVE_SEGMENTS: readonly string[] = [".ssh", ".aws", ".gnupg", ".kube", ".azure", ".docker", "secrets"];

/**
 * Basename patterns that flag a sensitive file. Each is tested case-insensitively
 * against the path's basename; `*`/`.` behave as literal glob/extension anchors.
 */
const SENSITIVE_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env$/i,
  /^\.env\..+$/i,
  /^id_rsa.*$/i,
  /^id_ed25519.*$/i,
  /^id_ecdsa.*$/i,
  /^.+\.pem$/i,
  /^.+\.key$/i,
  /^.+\.p12$/i,
  /^.+\.pfx$/i,
  /^credentials$/i,
  /^credentials\.json$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i
];

/** What flagged a path as sensitive: the matched segment or basename, verbatim. */
export interface SensitivePathMatch {
  readonly kind: "directory" | "file";
  readonly match: string;
}

/**
 * The credential/secret trigger for a candidate path, or null when none: the
 * first path segment matching a sensitive directory name (case-insensitive),
 * else a basename matching a sensitive-file pattern. Pure and separator-
 * agnostic - accepts Windows or POSIX separators.
 */
export function sensitivePathMatch(candidatePath: string): SensitivePathMatch | null {
  const segments = candidatePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
  const directory = segments.find((segment) => SENSITIVE_SEGMENTS.includes(segment.toLowerCase()));
  if (directory !== undefined) {
    return { kind: "directory", match: directory };
  }
  const basename = segments[segments.length - 1];
  if (basename === undefined) {
    return null;
  }
  return SENSITIVE_BASENAME_PATTERNS.some((pattern) => pattern.test(basename))
    ? { kind: "file", match: basename }
    : null;
}

/** True when a candidate path names a credential/secret directory or file. */
export function isSensitivePath(candidatePath: string): boolean {
  return sensitivePathMatch(candidatePath) !== null;
}

/**
 * Same wording workspaceReviewAppService.ts's toAccessRequestSummary uses for
 * `sensitiveReason`, so a client-recomputed escalation reads identically to a
 * fresh server-issued one.
 */
export function sensitiveReasonFor(match: SensitivePathMatch): string {
  return match.kind === "directory"
    ? `"${match.match}" is a credential/secret directory`
    : `"${match.match}" matches a credentials/secrets file pattern`;
}
