/**
 * The changeset hash validation evidence binds to (ADR 0022).
 *
 * Receipts must answer "what exactly did this green mean?", and the answer has
 * to survive the agent continuing to edit while the job runs (edge case D2). The
 * changeset service already stores a per-repo `patchSha256`, but a task's work
 * spans repositories and no AGGREGATE hash existed - so this module defines one.
 *
 * The digest is over the SORTED `(repoName, patchSha256)` tuples, which makes it
 * independent of the order repositories happen to be listed in and stable across
 * hosts. Two jobs whose repos and patches match produce the same ref; any change
 * to any repo's patch produces a different one. That is the whole contract:
 * supersession detection (D2) is a string comparison against it.
 *
 * Repo names are filesystem directory names (that is what the changeset service
 * records), so the newline separators are unambiguous in practice; this is a
 * content-identity hash for evidence, not a signature over untrusted input.
 *
 * `node:crypto` only - no dependency, no I/O, no clock.
 */

import { createHash } from "node:crypto";

/** One repository's contribution to a changeset: its name and its patch digest. */
export interface ChangesetRefPart {
  readonly repoName: string;
  /** sha256 hex of the repository's patch text, as `TaskChangesetRecord` stores it. */
  readonly patchSha256: string;
}

/**
 * Aggregate changeset hash for a set of per-repo patches (ADR 0022).
 *
 * Order-independent: parts are sorted by `repoName\npatchSha256` before hashing.
 * An EMPTY part list hashes the empty string rather than throwing - a job with
 * nothing to validate still needs a deterministic ref so callers never have to
 * special-case the value on the way in.
 */
export function computeChangesetRef(parts: readonly ChangesetRefPart[]): string {
  const tuples = parts
    .map((part) => `${part.repoName}\n${part.patchSha256}`)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return createHash("sha256").update(tuples.join("\n\n"), "utf8").digest("hex");
}
