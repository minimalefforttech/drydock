/**
 * Filesystem-aware host-path identity.
 *
 * Windows can expose the same directory through a mapped drive and a UNC path.
 * Lexical normalization cannot equate those spellings, while realpath can. The
 * UI uses this key only for identity/comparison; it keeps the original spelling
 * when opening a folder so VS Code does not unexpectedly switch a mapped drive
 * to a UNC URI that its own UNC security gate may reject.
 */

import { realpathSync } from "node:fs";
import { normalizeHostPath, normalizePathKey } from "./mountPolicy.js";

/** Canonical comparison key when the path exists; lexical key otherwise. */
export function hostPathIdentityKey(value: string): string {
  const normalized = normalizeHostPath(value);
  try {
    return normalizePathKey(realpathSync.native(normalized));
  } catch {
    return normalizePathKey(normalized);
  }
}
