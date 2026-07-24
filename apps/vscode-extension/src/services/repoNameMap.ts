/**
 * Clone repo-name derivation, shared by every consumer of captured
 * changesets (prepareClones stashes live clones, inspection materializes
 * copies, durable landing synthesizes commits). Names are the repo basename,
 * deduped in root order with `-2`, `-3`, ... suffixes - capture rows carry
 * these names, so every consumer MUST derive them identically.
 */

import path from "node:path";

export interface RepoPreflightPort {
  preflightRepo(root: string): Promise<{ readonly localRepoPath: string }>;
}

/** Ordered roots -> (clone name -> canonical local repo path). */
export async function repoRootsByCloneName(
  cloneSync: RepoPreflightPort,
  roots: readonly string[]
): Promise<Map<string, string>> {
  const byName = new Map<string, string>();
  const usedNames = new Set<string>();
  for (const root of roots) {
    const preflight = await cloneSync.preflightRepo(root);
    const baseName = path.basename(preflight.localRepoPath) || "repo";
    let name = baseName;
    let suffix = 2;
    while (usedNames.has(name.toLowerCase())) {
      name = `${baseName}-${String(suffix)}`;
      suffix += 1;
    }
    usedNames.add(name.toLowerCase());
    byName.set(name, preflight.localRepoPath);
  }
  return byName;
}
