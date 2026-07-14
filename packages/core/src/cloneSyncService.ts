/**
 * Clone-mode sync service.
 *
 * Implements the symmetric 3-way patch protocol from
 * `docs/design/clone-mode.md`. All git operations run HOST-side through the
 * injected {@link CommandRunner}, against a git clone that lives inside the
 * session workspace (`<workspace>/repos/<name>`). The developer's real repo is
 * only ever a read-only clone source / fetch remote / working-tree apply
 * target: nothing is pushed anywhere, and the local repo gains no commits.
 *
 * Bookkeeping lives entirely in the clone. `refs/sync/base` always names the
 * last state both sides share; inbound/outbound patches are computed and
 * applied relative to it.
 */

import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CloneFileChange,
  CloneSyncResult,
  CommandResult,
  CommandRunner,
  DiffChangeKind
} from "@drydock/contracts";
import { isPathWithin, sensitivePathMatch } from "./mountPolicy.js";

/** Fixed committer identity for sync commits — never depend on host git config. */
const SYNC_AUTHOR = ["-c", "user.name=clone-sync", "-c", "user.email=clone-sync@localhost"] as const;

/** Default timeout for individual git invocations. */
const GIT_TIMEOUT_MS = 60_000;

/** Refuse to move patches larger than this — a runaway diff should fail loudly. */
const MAX_PATCH_BYTES = 50 * 1024 * 1024;

/** Cap for the bounded conflict-marker scan of a single working-tree file. */
const MARKER_SCAN_MAX_BYTES = 2 * 1024 * 1024;

const CONFLICT_MARKER = "<<<<<<< ";

export interface CloneSyncServiceOptions {
  readonly runner: CommandRunner;
  /** Git executable; defaults to "git" on PATH. */
  readonly gitPath?: string;
  readonly timeoutMs?: number;
}

export interface InitCloneInput {
  readonly localRepoPath: string;
  readonly cloneParentDir: string;
  readonly name: string;
  /** carry overlays tracked/untracked working state; fresh uses current local HEAD only. */
  readonly dirtyHandling?: "carry" | "fresh";
  /** Paths that must never be copied from the developer repo into the clone. */
  readonly omission?: ClonePathOmission;
  /**
   * Upstream changeset patches to 3-way apply into the fresh clone BEFORE the
   * sync base freezes (ADR 0014). Applying pre-base keeps the clone's own
   * outbound delta scoped to work done IN this clone — a dependent's later
   * changeset never re-carries its upstream's content. A conflicting seed
   * throws (honest failed start), naming the seed's label.
   */
  readonly seedPatches?: readonly InitCloneSeedPatch[];
}

/** Small, deliberately non-glob clone filter: a safe preset plus exact path prefixes. */
export interface ClonePathOmission {
  readonly sensitive: boolean;
  readonly paths: readonly string[];
}

/** One upstream patch seeded into a fresh clone at init (ADR 0014). */
export interface InitCloneSeedPatch {
  /** Names the source in conflict errors (e.g. "subtask-x/repo"). */
  readonly label: string;
  readonly patch: string;
}

/** Read-only facts shown before a task starts cloning a repository. */
export interface CloneRepoPreflight {
  readonly localRepoPath: string;
  readonly isGitRepo: boolean;
  readonly branch?: string;
  readonly detached: boolean;
  readonly trackedChanges: number;
  readonly untrackedFiles: number;
  readonly dirty: boolean;
}

export interface InitCloneResult {
  readonly clonePath: string;
  readonly branch: string;
  /** True when the local repo was on a detached HEAD; `branch` is then a commit id. */
  readonly detached: boolean;
}

export class CloneSyncService {
  private readonly runner: CommandRunner;
  private readonly git: string;
  private readonly timeoutMs: number;
  private detectCache: { available: boolean; version?: string } | undefined;

  constructor(options: CloneSyncServiceOptions) {
    this.runner = options.runner;
    this.git = options.gitPath ?? "git";
    this.timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  }

  /** `git --version`, cached for the lifetime of the service. */
  async detectGit(): Promise<{ available: boolean; version?: string }> {
    if (this.detectCache !== undefined) return this.detectCache;
    const result = await this.runner.run(this.git, ["--version"], { cwd: process.cwd(), timeoutMs: this.timeoutMs });
    if (result.exitCode !== 0) {
      this.detectCache = { available: false };
      return this.detectCache;
    }
    const match = /git version (\S+)/.exec(result.stdout.trim());
    const version = match?.[1];
    const detected: { available: boolean; version?: string } =
      version === undefined ? { available: true } : { available: true, version };
    this.detectCache = detected;
    return detected;
  }

  /**
   * Inspect a local repository without fetching, pulling, checking out, or
   * otherwise changing it. A non-repository is reported, not thrown.
   */
  async preflightRepo(localRepoPath: string): Promise<CloneRepoPreflight> {
    const inside = await this.runner.run(this.git, ["rev-parse", "--is-inside-work-tree"], {
      cwd: localRepoPath,
      timeoutMs: this.timeoutMs
    });
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
      return {
        localRepoPath,
        isGitRepo: false,
        detached: false,
        trackedChanges: 0,
        untrackedFiles: 0,
        dirty: false
      };
    }
    const head = await this.gitIn(localRepoPath, ["rev-parse", "--abbrev-ref", "HEAD"], "resolve local HEAD for preflight");
    const detached = head.stdout.trim() === "HEAD";
    const branch = detached
      ? (await this.gitIn(localRepoPath, ["rev-parse", "HEAD"], "resolve detached HEAD for preflight")).stdout.trim()
      : head.stdout.trim();
    const status = await this.gitIn(
      localRepoPath,
      ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      "read local repository status"
    );
    const counts = countPreflightStatus(status.stdout);
    return {
      localRepoPath,
      isGitRepo: true,
      branch,
      detached,
      trackedChanges: counts.trackedChanges,
      untrackedFiles: counts.untrackedFiles,
      dirty: counts.trackedChanges + counts.untrackedFiles > 0
    };
  }

  /**
   * Clone the local repo's current branch into `<cloneParentDir>/<name>`.
   * carry overlays the developer's dirty working state; fresh snapshots only
   * current local HEAD. Neither path fetches or pulls a remote.
   */
  async initClone(input: InitCloneInput): Promise<InitCloneResult> {
    const { localRepoPath, cloneParentDir, name } = input;
    const dirtyHandling = input.dirtyHandling ?? "carry";
    const clonePath = join(cloneParentDir, name);

    // A normal clone copies every reachable object. If an omitted path was ever
    // tracked, deleting it from the checkout would be cosmetic: the agent could
    // recover it from .git. Refuse before copying any objects instead.
    await this.assertOmissionSafeSource(localRepoPath, input.omission);
    for (const seed of input.seedPatches ?? []) {
      assertPathsNotOmitted(parseDiffPaths(seed.patch), input.omission, `upstream changeset ${seed.label}`);
    }

    // The clone target's parent must exist before `git clone` runs there (the
    // command's cwd is `cloneParentDir`, and spawn requires an existing cwd).
    await mkdir(cloneParentDir, { recursive: true });

    // Resolve the branch the developer is on. A detached HEAD has no branch
    // name, so we clone the commit id directly and note the detachment.
    const head = await this.gitIn(localRepoPath, ["rev-parse", "--abbrev-ref", "HEAD"], "resolve local HEAD");
    let branch = head.stdout.trim();
    let detached = false;
    if (branch === "HEAD") {
      detached = true;
      const commit = await this.gitIn(localRepoPath, ["rev-parse", "HEAD"], "resolve detached HEAD commit");
      branch = commit.stdout.trim();
    }

    // --local --no-hardlinks is the security-critical choice: the clone dir is
    // later mounted rw into a container. With hardlinked objects, a container
    // write to a shared object file would reach into the developer's real repo
    // object store. --no-hardlinks forces physical copies so the clone is fully
    // detached from the source repository.
    //
    // `git clone -b` only accepts a branch/tag NAME, never a raw commit id, so
    // a detached HEAD is cloned without -b and then checked out at the commit.
    // With omissions, force Git's normal local transport. `--local` copies the
    // source object directory and can carry unreachable/dangling secret blobs;
    // `--no-local` transfers only objects reachable from advertised refs (all
    // of which the history scan above checked). It still uses the local path and
    // performs no network I/O.
    const cloneIsolationArgs = hasCloneOmissions(input.omission)
      ? ["--no-local"]
      : ["--local", "--no-hardlinks"];
    const cloneArgs = detached
      ? [...SYNC_AUTHOR, "clone", ...cloneIsolationArgs, "--no-checkout", localRepoPath, clonePath]
      : [...SYNC_AUTHOR, "clone", ...cloneIsolationArgs, "-b", branch, localRepoPath, clonePath];
    await this.git0(cloneArgs, cloneParentDir, "clone local repo");
    if (detached) {
      await this.gitIn(clonePath, ["checkout", "--detach", branch], "checkout detached commit in clone");
    }

    if (dirtyHandling === "carry") {
      // Overlay tracked dirty changes: the patch of local working tree vs its HEAD.
      const dirty = await this.diffToFile(localRepoPath, ["diff", "--binary", "HEAD"], "capture local dirty diff");
      try {
        if (dirty.bytes > 0) {
          await this.applyPatchFile(clonePath, dirty.patchFile, ["--binary", "--whitespace=nowarn"], "overlay local dirty diff onto clone");
        }
      } finally {
        await dirty.cleanup();
      }

      // Copy untracked (but not ignored) files verbatim — copy-win, no merge.
      const untracked = await this.gitIn(
        localRepoPath,
        ["ls-files", "-o", "--exclude-standard", "-z"],
        "list local untracked files"
      );
      for (const rel of splitZ(untracked.stdout)) {
        if (pathMatchesCloneOmission(rel, input.omission)) continue;
        await assertSafeUntrackedCopy(localRepoPath, clonePath, rel);
        const src = join(localRepoPath, rel);
        const dest = join(clonePath, rel);
        await copyFileThrough(src, dest);
      }
    }

    // Seed upstream changesets (ADR 0014): strict 3-way apply, one patch at a
    // time so a failure names its source. Runs BEFORE the base freeze so the
    // seeded content becomes part of refs/sync/base — the clone's own outbound
    // delta stays scoped to work done here, never re-carrying upstream output.
    for (const seed of input.seedPatches ?? []) {
      if (seed.patch.length === 0) continue;
      const dir = await mkdtemp(join(tmpdir(), "clone-seed-"));
      const seedFile = join(dir, "seed.diff");
      try {
        await writeFile(seedFile, seed.patch, "utf8");
        await this.applyPatchFile(
          clonePath,
          seedFile,
          ["--binary", "--3way", "--whitespace=nowarn"],
          `seed upstream changeset ${seed.label}`
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    // Freeze the selected snapshot as the sync base. --allow-empty means both
    // clean carry and fresh HEAD still produce a base commit for sync diffs.
    await this.gitIn(clonePath, ["add", "-A"], "stage snapshot in clone");
    await this.gitIn(
      clonePath,
      [...SYNC_AUTHOR, "commit", "--allow-empty", "-m", dirtyHandling === "carry" ? "[sync] local snapshot" : "[sync] fresh local HEAD"],
      "commit snapshot in clone"
    );
    await this.gitIn(clonePath, ["update-ref", "refs/sync/base", "HEAD"], "set refs/sync/base");

    return { clonePath, branch, detached };
  }

  /**
   * Agent-visible changes in the clone relative to `refs/sync/base`. Merges two
   * views: working-tree changes (uncommitted agent edits) and committed-but-
   * unsynced agent commits (base..HEAD). Line stats come from numstat over the
   * same base; conflicted flag from a bounded conflict-marker scan.
   */
  async agentChanges(clonePath: string): Promise<CloneFileChange[]> {
    const base = "refs/sync/base";

    // Committed agent work: base..HEAD name-status.
    const committed = await this.gitIn(
      clonePath,
      ["diff", "--name-status", "-z", base, "HEAD"],
      "diff committed agent changes"
    );
    // Working-tree changes (staged + unstaged + untracked) via porcelain v1.
    const status = await this.gitIn(clonePath, ["status", "--porcelain=v1", "-z"], "read clone working-tree status");

    const changes = new Map<string, { changeKind: DiffChangeKind; conflicted: boolean }>();

    for (const entry of parseNameStatusZ(committed.stdout)) {
      changes.set(entry.path, { changeKind: entry.changeKind, conflicted: false });
    }
    for (const entry of parsePorcelainZ(status.stdout)) {
      // Working-tree view wins for change-kind (it is the newer state).
      changes.set(entry.path, { changeKind: entry.changeKind, conflicted: entry.conflicted });
    }

    // Line stats: numstat of working tree vs base captures both committed and
    // uncommitted deltas in one pass (base -> working tree). Untracked files do
    // NOT appear in `git diff` numstat, so their added-line counts are filled in
    // below by reading the file directly (removed = 0, since they are new).
    const stats = await this.gitIn(clonePath, ["diff", "--numstat", "-z", base], "numstat clone changes vs base");
    const statByPath = parseNumstatZ(stats.stdout);

    const result: CloneFileChange[] = [];
    for (const [path, info] of changes) {
      let stat = statByPath.get(path);
      if (stat === undefined && info.changeKind === "add") {
        const added = await this.countLines(clonePath, path);
        if (added !== null) stat = { added, removed: 0 };
      }
      const conflicted = info.conflicted || (await this.hasConflictMarkers(clonePath, path));
      const change: CloneFileChange = {
        path,
        changeKind: info.changeKind,
        ...(stat && stat.added !== null ? { addedLines: stat.added } : {}),
        ...(stat && stat.removed !== null ? { removedLines: stat.removed } : {}),
        ...(conflicted ? { conflicted: true } : {})
      };
      result.push(change);
    }
    result.sort((a, b) => a.path.localeCompare(b.path));
    return result;
  }

  /**
   * The clone's durable outbound patch (ADR 0014): commit agent progress,
   * then `diff --binary refs/sync/base..HEAD` — byte-for-byte what a full
   * pull would apply, so a captured changeset and a later manual Pull can
   * never disagree. Returns null when there is nothing to capture. Does NOT
   * advance the sync base (capture must not change pull semantics).
   */
  async outboundChangesetPatch(
    clonePath: string,
    omission?: ClonePathOmission
  ): Promise<{ readonly patch: string; readonly fileCount: number; readonly paths: readonly string[] } | null> {
    await this.commitAgentProgress(clonePath, "[sync] agent");
    const prepared = await this.diffToFile(clonePath, ["diff", "--binary", "refs/sync/base", "HEAD"], "build changeset patch");
    try {
      if (prepared.bytes === 0) return null;
      // Git binary hunks are base85 ASCII, so the whole patch file is utf8-safe.
      const patch = await readFile(prepared.patchFile, "utf8");
      // Paths ride along for the landing overlap pre-check (ADR 0014).
      const paths = await this.patchPaths(clonePath, undefined);
      assertPathsNotOmitted(paths, omission, "clone changeset");
      return { patch, fileCount: paths.length, paths };
    } finally {
      await prepared.cleanup();
    }
  }

  /**
   * Inbound — "pull the agent's work into my editor".
   *
   * Commits agent progress if the clone tree is dirty, builds
   * `diff --binary sync/base..HEAD` (optionally scoped to one file), and applies
   * it to the LOCAL working tree with `apply --binary --3way`. No local commits
   * are made. Full pulls advance `sync/base`; per-file pulls do NOT.
   *
   * Per-file rule (see class-level rationale + tests): a per-file pull applies
   * only `<path>` and leaves the base where it is, so the file remains part of
   * the base..HEAD delta. The NEXT full pull re-encounters already-pulled files;
   * `apply --3way` on already-applied content exits non-zero ("patch does not
   * apply"). We tolerate this by: try the whole patch first; on failure fall
   * back to per-file application, and for each file whose LOCAL content already
   * equals the clone's HEAD blob (compared by hash), count it applied and skip.
   * That makes previously per-file-pulled files clean no-ops without spurious
   * failures, while genuinely new files still apply (or conflict) normally.
   */
  async inboundPatch(
    clonePath: string,
    localRepoPath: string,
    opts?: { path?: string; omission?: ClonePathOmission }
  ): Promise<CloneSyncResult> {
    await this.commitAgentProgress(clonePath, "[sync] agent");

    const path = opts?.path;
    const fullPull = path === undefined;
    const diffArgs = ["diff", "--binary", "refs/sync/base", "HEAD", ...(path === undefined ? [] : ["--", path])];
    const patch = await this.diffToFile(clonePath, diffArgs, "build inbound patch");

    let appliedFiles: number;
    let conflictedFiles: readonly string[];
    try {
      if (patch.bytes === 0) {
        return { appliedFiles: 0, conflictedFiles: [], message: "nothing to pull" };
      }

      const touched = await this.patchPaths(clonePath, path);
      assertPathsNotOmitted(touched, opts?.omission, "clone pull");
      // Snapshot marker state BEFORE the first apply attempt. The fallback may
      // observe markers written by that whole-patch attempt, but literal marker
      // text that was already in the developer's file is not proof that this
      // pull transferred anything.
      const conflictMarkersBefore = new Map<string, boolean>();
      for (const touchedPath of touched) {
        conflictMarkersBefore.set(touchedPath, await this.hasConflictMarkers(localRepoPath, touchedPath));
      }
      const applyArgs = ["--binary", "--3way", "--whitespace=nowarn", ...(path === undefined ? [] : [`--include=${path}`])];
      const apply = await this.tryApplyPatchFile(localRepoPath, patch.patchFile, applyArgs);

      if (apply.exitCode === 0) {
        appliedFiles = touched.length;
        const markersAfter = await this.scanConflicts(localRepoPath, touched);
        conflictedFiles = markersAfter.filter((touchedPath) => conflictMarkersBefore.get(touchedPath) !== true);
      } else {
        // A 3-way apply that hits conflicts still writes what it could (with
        // markers) but exits non-zero. It may also fail because some files were
        // already applied by a prior per-file pull. Fall back to per-file.
        const fallback = await this.perFileInboundFallback(clonePath, localRepoPath, touched, conflictMarkersBefore);
        appliedFiles = fallback.appliedFiles;
        conflictedFiles = fallback.conflictedFiles;
      }
    } finally {
      await patch.cleanup();
    }

    // Full pulls advance the base (even with conflicts: the marked content HAS
    // been transferred; the developer resolves locally). Per-file pulls leave
    // the base untouched so the remaining files stay in the delta.
    if (fullPull) {
      await this.gitIn(clonePath, ["update-ref", "refs/sync/base", "HEAD"], "advance refs/sync/base after inbound");
    }

    const message = describeSync("Pulled", appliedFiles, conflictedFiles, fullPull ? undefined : path);
    return {
      appliedFiles,
      conflictedFiles,
      message
    };
  }

  /**
   * Outbound — "push my local edits to the VM".
   *
   * Commit agent progress, fetch the local repo's branch tip (origin = the
   * local repo path set by `git clone`), 3-way apply the committed local delta
   * (`sync/base..FETCH_HEAD`) onto the clone tree, then 3-way apply the local
   * DIRTY delta and copy untracked files (copy-win, skipping identical
   * content). Commit `[sync] local`, advance `sync/base`. Conflicts land as
   * markers in the CLONE — the agent resolves them.
   */
  async outboundSync(
    clonePath: string,
    localRepoPath: string,
    omission?: ClonePathOmission
  ): Promise<CloneSyncResult> {
    await this.commitAgentProgress(clonePath, "[sync] agent");

    // Re-check before every local -> clone sync. This occurs before `fetch`, so
    // newly committed forbidden objects never enter the agent's object store.
    await this.assertOmissionSafeSource(localRepoPath, omission);

    const branch = await this.resolveCloneBranch(clonePath);

    // origin was set to the local repo path at clone time.
    await this.gitIn(clonePath, ["fetch", "origin", branch], "fetch local branch into clone");

    const touched = new Set<string>();
    const conflicted = new Set<string>();

    // Committed local delta: sync/base -> FETCH_HEAD.
    const committedDelta = await this.diffToFile(
      clonePath,
      ["diff", "--binary", "refs/sync/base", "FETCH_HEAD"],
      "build committed local delta"
    );
    try {
      if (committedDelta.bytes > 0) {
        const paths = await patchPathsFromFile(committedDelta.patchFile);
        const apply = await this.tryApplyPatchFile(clonePath, committedDelta.patchFile, ["--binary", "--3way", "--whitespace=nowarn"]);
        for (const p of paths) touched.add(p);
        if (apply.exitCode !== 0) {
          for (const p of await this.scanConflicts(clonePath, paths)) conflicted.add(p);
        }
      }
    } finally {
      await committedDelta.cleanup();
    }

    // Dirty local delta: local working tree vs its HEAD.
    const dirtyDelta = await this.diffToFile(localRepoPath, ["diff", "--binary", "HEAD"], "build local dirty delta");
    try {
      if (dirtyDelta.bytes > 0) {
        const paths = await patchPathsFromFile(dirtyDelta.patchFile);
        const apply = await this.tryApplyPatchFile(clonePath, dirtyDelta.patchFile, ["--binary", "--3way", "--whitespace=nowarn"]);
        for (const p of paths) touched.add(p);
        if (apply.exitCode !== 0) {
          for (const p of await this.scanConflicts(clonePath, paths)) conflicted.add(p);
        }
      }
    } finally {
      await dirtyDelta.cleanup();
    }

    // Untracked local files: copy-win, but skip content that is already
    // byte-identical in the clone so we do not report spurious "applies".
    const untracked = await this.gitIn(
      localRepoPath,
      ["ls-files", "-o", "--exclude-standard", "-z"],
      "list local untracked files (outbound)"
    );
    let untrackedCopied = 0;
    for (const rel of splitZ(untracked.stdout)) {
      if (pathMatchesCloneOmission(rel, omission)) continue;
      await assertSafeUntrackedCopy(localRepoPath, clonePath, rel);
      const src = join(localRepoPath, rel);
      const dest = join(clonePath, rel);
      if (await copyIfDifferent(src, dest)) {
        untrackedCopied += 1;
        touched.add(rel.replace(/\\/g, "/"));
      }
    }

    await this.gitIn(clonePath, ["add", "-A"], "stage outbound result in clone");
    await this.gitIn(
      clonePath,
      [...SYNC_AUTHOR, "commit", "--allow-empty", "-m", "[sync] local"],
      "commit outbound result in clone"
    );
    await this.gitIn(clonePath, ["update-ref", "refs/sync/base", "HEAD"], "advance refs/sync/base after outbound");

    const conflictedFiles = [...conflicted].sort();
    const appliedFiles = touched.size;
    return {
      appliedFiles,
      conflictedFiles,
      untrackedCopied,
      message: describeSync("Pushed", appliedFiles, conflictedFiles, undefined, untrackedCopied)
    };
  }

  /** Fails when an omitted path exists in the index or any reachable history. */
  private async assertOmissionSafeSource(localRepoPath: string, omission?: ClonePathOmission): Promise<void> {
    if (!hasCloneOmissions(omission)) return;
    // Ask Git to emit ONLY matching paths. CommandRunner deliberately caps
    // captured output, so scanning an unfiltered large repository could miss a
    // forbidden path after the cap. A non-empty filtered result is sufficient.
    const pathspecs = gitPathspecsForCloneOmission(omission);
    const tracked = await this.gitIn(
      localRepoPath,
      ["ls-files", "-z", "--", ...pathspecs],
      "scan tracked paths for clone omissions"
    );
    assertPathsNotOmitted(splitZ(tracked.stdout), omission, "tracked project content");
    const history = await this.gitIn(
      localRepoPath,
      ["log", "--all", "--format=", "--name-only", "-z", "--", ...pathspecs],
      "scan repository history for clone omissions"
    );
    const historicalPaths = splitZ(history.stdout)
      .map((entry) => entry.replace(/^[\r\n]+/, ""))
      .filter((entry) => entry.length > 0);
    assertPathsNotOmitted(historicalPaths, omission, "repository history");
  }

  /**
   * Discard one file's agent changes: restore it to its `refs/sync/base`
   * content. Files that did not exist at the base (added since) cannot be
   * checked out from it — those are un-staged and removed from the working tree.
   */
  async discardFile(clonePath: string, path: string): Promise<void> {
    const existsAtBase = await this.gitIn(
      clonePath,
      ["cat-file", "-e", `refs/sync/base:${path}`],
      "probe file at sync base"
    );
    if (existsAtBase.exitCode === 0) {
      await this.gitIn(clonePath, ["checkout", "refs/sync/base", "--", path], `restore ${path} from sync base`);
      return;
    }
    // New-since-base file: drop it from the index (ignore if not tracked) and
    // delete it from the working tree.
    await this.gitIn(clonePath, ["rm", "--cached", "--ignore-unmatch", "--", path], `unstage new file ${path}`);
    await rm(join(clonePath, path), { force: true });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Commit the clone's working tree if it is dirty (keeps the 3-way base honest). */
  private async commitAgentProgress(clonePath: string, message: string): Promise<void> {
    const status = await this.gitIn(clonePath, ["status", "--porcelain=v1", "-z"], "check clone dirtiness");
    if (status.stdout.length === 0) return;
    await this.gitIn(clonePath, ["add", "-A"], "stage agent progress");
    await this.gitIn(clonePath, [...SYNC_AUTHOR, "commit", "-m", message], "commit agent progress");
  }

  private async resolveCloneBranch(clonePath: string): Promise<string> {
    const head = await this.gitIn(clonePath, ["rev-parse", "--abbrev-ref", "HEAD"], "resolve clone branch");
    const name = head.stdout.trim();
    if (name === "HEAD") {
      throw new Error("Clone is on a detached HEAD; outbound sync needs a named branch to fetch.");
    }
    return name;
  }

  /**
   * Per-file inbound fallback for when the whole-patch 3-way apply failed. Emits
   * per-file patches; for each file whose LOCAL content already equals the
   * clone's HEAD blob, count it applied and skip (idempotent per-file pull).
   */
  private async perFileInboundFallback(
    clonePath: string,
    localRepoPath: string,
    paths: readonly string[],
    conflictMarkersBefore: ReadonlyMap<string, boolean>
  ): Promise<{ appliedFiles: number; conflictedFiles: readonly string[] }> {
    let appliedFiles = 0;
    const conflictedFiles: string[] = [];

    for (const path of paths) {
      // If local already matches the clone's HEAD version, it was pulled before
      // — a genuine no-op, so count it and move on without re-applying.
      if (await this.localMatchesCloneHead(clonePath, localRepoPath, path)) {
        appliedFiles += 1;
        continue;
      }
      const filePatch = await this.diffToFile(
        clonePath,
        ["diff", "--binary", "refs/sync/base", "HEAD", "--", path],
        `build inbound patch for ${path}`
      );
      try {
        if (filePatch.bytes === 0) {
          appliedFiles += 1;
          continue;
        }
        const apply = await this.tryApplyPatchFile(
          localRepoPath,
          filePatch.patchFile,
          ["--binary", "--3way", "--whitespace=nowarn", `--include=${path}`]
        );
        // A non-zero 3-way apply is acceptable only when it demonstrably
        // transferred a textual conflict into the working tree. Binary
        // conflicts and other failures leave no markers; counting those as
        // applied would let the full-pull caller advance refs/sync/base and
        // silently discard the still-untransferred agent delta.
        const hasConflictMarkers = await this.hasConflictMarkers(localRepoPath, path);
        const introducedConflictMarkers = hasConflictMarkers && conflictMarkersBefore.get(path) !== true;
        if (apply.exitCode !== 0 && !introducedConflictMarkers) {
          throw gitError(`apply inbound patch for ${path}`, localRepoPath, apply);
        }
        appliedFiles += 1;
        if (introducedConflictMarkers) {
          conflictedFiles.push(path);
        }
      } finally {
        await filePatch.cleanup();
      }
    }
    conflictedFiles.sort();
    return { appliedFiles, conflictedFiles };
  }

  /** True when the local working-tree file byte-equals the clone's HEAD blob. */
  private async localMatchesCloneHead(clonePath: string, localRepoPath: string, path: string): Promise<boolean> {
    const cloneHash = await this.gitIn(clonePath, ["rev-parse", `HEAD:${path}`], `hash clone HEAD:${path}`);
    if (cloneHash.exitCode !== 0) return false;
    // hash-object of the local working-tree file (may not be tracked there).
    const localFile = join(localRepoPath, path);
    const localHash = await this.gitIn(
      localRepoPath,
      ["hash-object", localFile],
      `hash local ${path}`
    );
    if (localHash.exitCode !== 0) return false;
    return cloneHash.stdout.trim() === localHash.stdout.trim();
  }

  /** Paths touched by the base..HEAD diff, optionally scoped to one file. */
  private async patchPaths(clonePath: string, scopedPath: string | undefined): Promise<string[]> {
    const args = ["diff", "--name-only", "-z", "refs/sync/base", "HEAD", ...(scopedPath === undefined ? [] : ["--", scopedPath])];
    const result = await this.gitIn(clonePath, args, "list inbound patch paths");
    return splitZ(result.stdout);
  }

  private async scanConflicts(repoPath: string, paths: readonly string[]): Promise<string[]> {
    const conflicted: string[] = [];
    for (const path of paths) {
      if (await this.hasConflictMarkers(repoPath, path)) conflicted.push(path);
    }
    conflicted.sort();
    return conflicted;
  }

  /**
   * Count lines in a working-tree file for added-line stats on untracked/new
   * files (git diff numstat omits untracked files). Returns null for binary
   * content (embedded NUL) or oversized files, matching git's "-" numstat.
   */
  private async countLines(repoPath: string, path: string): Promise<number | null> {
    try {
      const buf = await readFile(join(repoPath, path));
      if (buf.length > MARKER_SCAN_MAX_BYTES) return null;
      if (buf.includes(0)) return null;
      if (buf.length === 0) return 0;
      const text = buf.toString("utf8");
      const lines = text.split("\n");
      // A trailing newline yields a final empty segment that is not a line.
      return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    } catch {
      return null;
    }
  }

  /** Bounded scan for a leading conflict marker in a working-tree file. */
  private async hasConflictMarkers(repoPath: string, path: string): Promise<boolean> {
    try {
      const buf = await readFile(join(repoPath, path));
      const slice = buf.length > MARKER_SCAN_MAX_BYTES ? buf.subarray(0, MARKER_SCAN_MAX_BYTES) : buf;
      const text = slice.toString("utf8");
      return text.includes(`\n${CONFLICT_MARKER}`) || text.startsWith(CONFLICT_MARKER);
    } catch {
      return false;
    }
  }

  /** Run git in `repoPath`; throw a step-named error on non-zero exit. */
  private async gitIn(repoPath: string, args: readonly string[], step: string): Promise<CommandResult> {
    // rev-parse/cat-file probes are allowed to fail; callers inspect exitCode.
    const nonFatal = args[0] === "rev-parse" || args[0] === "cat-file" || args[0] === "hash-object";
    const result = await this.runner.run(this.git, args, { cwd: repoPath, timeoutMs: this.timeoutMs });
    if (result.exitCode !== 0 && !nonFatal) {
      throw gitError(step, repoPath, result);
    }
    return result;
  }

  /** Run git with an explicit cwd (used for `clone`, whose target does not yet exist). */
  private async git0(args: readonly string[], cwd: string, step: string): Promise<CommandResult> {
    const result = await this.runner.run(this.git, args, { cwd, timeoutMs: this.timeoutMs });
    if (result.exitCode !== 0) {
      throw gitError(step, cwd, result);
    }
    return result;
  }

  /**
   * Generate a diff straight into a temp file via `git diff --output=<file>`.
   *
   * This deliberately avoids stdout: the CommandRunner caps captured output at
   * ~120 KB, so any real patch routed through stdout would be silently
   * truncated and corrupt. Writing to a file lets us both handle large patches
   * and enforce the 50 MB cap on the file's actual size before applying it. The
   * caller MUST call `cleanup()` when done.
   */
  private async diffToFile(repoPath: string, diffArgs: readonly string[], step: string): Promise<PreparedPatch> {
    const dir = await mkdtemp(join(tmpdir(), "clone-sync-"));
    const patchFile = join(dir, "patch.diff");
    const cleanup = async (): Promise<void> => {
      await rm(dir, { recursive: true, force: true });
    };
    try {
      const [verb, ...rest] = diffArgs;
      const result = await this.runner.run(
        this.git,
        [verb ?? "diff", `--output=${patchFile}`, ...rest],
        { cwd: repoPath, timeoutMs: this.timeoutMs }
      );
      if (result.exitCode !== 0) {
        await cleanup();
        throw gitError(step, repoPath, result);
      }
      let bytes = 0;
      try {
        bytes = (await stat(patchFile)).size;
      } catch {
        bytes = 0;
      }
      if (bytes > MAX_PATCH_BYTES) {
        await cleanup();
        throw new Error(
          `Refusing ${step} patch of ${String(bytes)} bytes: exceeds the ${String(MAX_PATCH_BYTES)}-byte clone-sync cap.`
        );
      }
      return { patchFile, bytes, cleanup };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  /** Apply a prepared patch file, throwing on non-zero exit (strict callers). */
  private async applyPatchFile(repoPath: string, patchFile: string, applyFlags: readonly string[], step: string): Promise<void> {
    const result = await this.runApplyFile(repoPath, patchFile, applyFlags);
    if (result.exitCode !== 0) {
      throw gitError(step, repoPath, result);
    }
  }

  /** As {@link applyPatchFile} but returns the result instead of throwing (3-way callers). */
  private async tryApplyPatchFile(repoPath: string, patchFile: string, applyFlags: readonly string[]): Promise<CommandResult> {
    return this.runApplyFile(repoPath, patchFile, applyFlags);
  }

  private async runApplyFile(repoPath: string, patchFile: string, applyFlags: readonly string[]): Promise<CommandResult> {
    // Patch is applied from a file, never stdin — Windows-safe and unbounded.
    return this.runner.run(this.git, ["apply", ...applyFlags, patchFile], {
      cwd: repoPath,
      timeoutMs: this.timeoutMs
    });
  }
}

/** A patch materialized on disk, with its byte size and a cleanup handle. */
interface PreparedPatch {
  readonly patchFile: string;
  readonly bytes: number;
  readonly cleanup: () => Promise<void>;
}

// -----------------------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------------------

function gitError(step: string, repoPath: string, result: CommandResult): Error {
  const detail = result.error ?? (result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`);
  return new Error(`git ${step} failed in ${repoPath}: ${detail}`);
}

/** Split a NUL-delimited git list into non-empty entries. */
function splitZ(value: string): string[] {
  return value.split("\0").filter((entry) => entry.length > 0);
}

function countPreflightStatus(value: string): { trackedChanges: number; untrackedFiles: number } {
  const tokens = value.split("\0");
  let trackedChanges = 0;
  let untrackedFiles = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index];
    if (entry === undefined || entry.length < 3) continue;
    const code = entry.slice(0, 2);
    if (code === "??") untrackedFiles += 1;
    else trackedChanges += 1;
    // Porcelain v1 -z emits the source path as the following token for a
    // rename/copy. It belongs to this same status entry, not another file.
    if (code.includes("R") || code.includes("C")) index += 1;
  }
  return { trackedChanges, untrackedFiles };
}

function mapStatusLetter(letter: string): DiffChangeKind {
  switch (letter) {
    case "A":
      return "add";
    case "D":
      return "delete";
    case "R":
      return "rename";
    case "C":
      return "add";
    default:
      return "modify";
  }
}

/** Parse `git diff --name-status -z` output (base..HEAD, committed changes). */
function parseNameStatusZ(value: string): Array<{ path: string; changeKind: DiffChangeKind }> {
  const tokens = value.split("\0");
  const out: Array<{ path: string; changeKind: DiffChangeKind }> = [];
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i];
    if (status === undefined || status.length === 0) {
      i += 1;
      continue;
    }
    const letter = status[0] ?? "M";
    if (letter === "R" || letter === "C") {
      // rename/copy: status, oldPath, newPath.
      const newPath = tokens[i + 2];
      if (newPath !== undefined) out.push({ path: newPath, changeKind: mapStatusLetter(letter) });
      i += 3;
    } else {
      const path = tokens[i + 1];
      if (path !== undefined) out.push({ path, changeKind: mapStatusLetter(letter) });
      i += 2;
    }
  }
  return out;
}

/** Parse `git status --porcelain=v1 -z` into path + change-kind + conflicted. */
function parsePorcelainZ(value: string): Array<{ path: string; changeKind: DiffChangeKind; conflicted: boolean }> {
  const tokens = value.split("\0");
  const out: Array<{ path: string; changeKind: DiffChangeKind; conflicted: boolean }> = [];
  let i = 0;
  while (i < tokens.length) {
    const entry = tokens[i];
    if (entry === undefined || entry.length < 3) {
      i += 1;
      continue;
    }
    const x = entry[0] ?? " ";
    const y = entry[1] ?? " ";
    const path = entry.slice(3);
    // Rename/copy entries carry a second NUL-delimited token (the source path).
    const isRename = x === "R" || x === "C";
    // Unmerged states (conflict) per porcelain v1: any of these code pairs.
    const conflicted =
      x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
    let changeKind: DiffChangeKind;
    if (isRename) changeKind = "rename";
    else if (x === "A" || y === "A" || x === "?" ) changeKind = "add";
    else if (x === "D" || y === "D") changeKind = "delete";
    else changeKind = "modify";
    out.push({ path, changeKind, conflicted });
    i += isRename ? 2 : 1;
  }
  return out;
}

/** Parse `git diff --numstat -z` into added/removed per path ("-" => binary => null). */
function parseNumstatZ(value: string): Map<string, { added: number | null; removed: number | null }> {
  const map = new Map<string, { added: number | null; removed: number | null }>();
  // -z numstat: "<added>\t<removed>\t\0<path>\0" for renames (old\0new), else
  // "<added>\t<removed>\t<path>\0". Handle both by tokenizing on NUL and \t.
  const tokens = value.split("\0");
  let i = 0;
  while (i < tokens.length) {
    const record = tokens[i];
    if (record === undefined || record.length === 0) {
      i += 1;
      continue;
    }
    const parts = record.split("\t");
    if (parts.length < 3) {
      i += 1;
      continue;
    }
    const added = parts[0] === "-" ? null : Number.parseInt(parts[0] ?? "", 10);
    const removed = parts[1] === "-" ? null : Number.parseInt(parts[1] ?? "", 10);
    const inlinePath = parts[2];
    let path: string | undefined = inlinePath;
    if (inlinePath === "") {
      // Rename: the old and new paths follow as separate NUL tokens.
      path = tokens[i + 2];
      i += 3;
    } else {
      i += 1;
    }
    if (path !== undefined && path.length > 0) {
      map.set(path, {
        added: Number.isNaN(added as number) ? null : added,
        removed: Number.isNaN(removed as number) ? null : removed
      });
    }
  }
  return map;
}

/**
 * Extract touched paths from a diff file. Reads only the first slice of the
 * patch (headers appear before the bulk hunk bodies of large files, but binary
 * blobs can bury later headers — bounded to the same cap used elsewhere; the
 * outbound path set is best-effort for conflict reporting, not correctness).
 */
async function patchPathsFromFile(patchFile: string): Promise<string[]> {
  const buf = await readFile(patchFile);
  const slice = buf.length > MAX_PATCH_BYTES ? buf.subarray(0, MAX_PATCH_BYTES) : buf;
  return parseDiffPaths(slice.toString("utf8"));
}

/** Extract touched target paths from a unified diff's `diff --git` / `+++` lines. */
function parseDiffPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git a/")) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line.trim());
      if (match?.[2] !== undefined) paths.add(stripDiffPrefix(match[2]));
    } else if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim();
      if (raw === "/dev/null") continue;
      paths.add(stripDiffPrefix(raw));
    } else if (line.startsWith("--- ")) {
      const raw = line.slice(4).trim();
      if (raw === "/dev/null") continue;
      paths.add(stripDiffPrefix(raw));
    }
  }
  return [...paths];
}

function stripDiffPrefix(raw: string): string {
  if (raw.startsWith("a/") || raw.startsWith("b/")) return raw.slice(2);
  return raw;
}

/** True when a repo-relative path matches the sensitive preset or an exact prefix. */
export function pathMatchesCloneOmission(candidate: string, omission?: ClonePathOmission): boolean {
  if (!hasCloneOmissions(omission)) return false;
  const normalized = candidate.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (omission.sensitive && sensitivePathMatch(normalized) !== null) return true;
  const candidateKey = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  return omission.paths.some((configured) => {
    const normalizedConfigured = configured.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
    const configuredKey = process.platform === "win32" ? normalizedConfigured.toLowerCase() : normalizedConfigured;
    return candidateKey === configuredKey || candidateKey.startsWith(`${configuredKey}/`);
  });
}

function hasCloneOmissions(omission?: ClonePathOmission): omission is ClonePathOmission {
  return omission !== undefined && (omission.sensitive || omission.paths.length > 0);
}

const SENSITIVE_GIT_GLOBS: readonly string[] = [
  "**/.ssh", "**/.ssh/**", "**/.aws", "**/.aws/**", "**/.gnupg", "**/.gnupg/**",
  "**/.kube", "**/.kube/**", "**/.azure", "**/.azure/**", "**/.docker", "**/.docker/**",
  "**/secrets", "**/secrets/**",
  "**/.env", "**/.env.*", "**/id_rsa*", "**/id_ed25519*", "**/id_ecdsa*",
  "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx",
  "**/credentials", "**/credentials.json", "**/.netrc", "**/.npmrc", "**/.pypirc"
];

/** Git-native filters equivalent to pathMatchesCloneOmission, avoiding unbounded output. */
function gitPathspecsForCloneOmission(omission: ClonePathOmission): string[] {
  return [
    ...omission.paths.map((configured) => `:(top,literal)${configured.replace(/\\/g, "/")}`),
    ...(omission.sensitive ? SENSITIVE_GIT_GLOBS.map((glob) => `:(top,glob,icase)${glob}`) : [])
  ];
}

function assertPathsNotOmitted(
  candidates: readonly string[],
  omission: ClonePathOmission | undefined,
  source: string
): void {
  const blocked = candidates.find((candidate) => pathMatchesCloneOmission(candidate, omission));
  if (blocked !== undefined) {
    throw new Error(
      `Cannot safely omit "${blocked}" from ${source}: it is tracked or transferable through Git. `
      + "Remove it from Git (including reachable history) or remove the omission before starting AI."
    );
  }
}

function describeSync(
  verb: string,
  applied: number,
  conflicted: readonly string[],
  scopedPath: string | undefined,
  untrackedCopied?: number
): string {
  const scope = scopedPath === undefined ? "" : ` ${scopedPath}`;
  const base = `${verb} ${String(applied)} file${applied === 1 ? "" : "s"}${scope}`;
  const parts = [base];
  if (untrackedCopied !== undefined && untrackedCopied > 0) {
    parts.push(`${String(untrackedCopied)} untracked copied`);
  }
  if (conflicted.length > 0) {
    parts.push(`${String(conflicted.length)} conflicted (resolve markers)`);
  }
  return parts.join("; ");
}

async function copyFileThrough(src: string, dest: string): Promise<void> {
  await mkdir(dirnameOf(dest), { recursive: true });
  await copyFile(src, dest);
}

/** Copy `src` to `dest` unless the destination already holds identical bytes. */
async function copyIfDifferent(src: string, dest: string): Promise<boolean> {
  const srcBuf = await readFile(src);
  try {
    const destBuf = await readFile(dest);
    if (srcBuf.equals(destBuf)) return false;
  } catch {
    // dest missing — fall through to copy.
  }
  await mkdir(dirnameOf(dest), { recursive: true });
  await writeFile(dest, srcBuf);
  return true;
}

/**
 * Untracked carry is a host-side copy, so never follow a symlink/junction from
 * either the developer repo or the agent-controlled clone. Git paths are also
 * checked for traversal even though `git ls-files` should only emit relative
 * repository paths. Fresh clone remains the zero-copy alternative.
 */
async function assertSafeUntrackedCopy(sourceRoot: string, destinationRoot: string, relativePath: string): Promise<void> {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized === "" || normalized.startsWith("/") || normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Refusing unsafe untracked path "${relativePath}" during clone carry.`);
  }
  await assertNoSymlinkComponents(sourceRoot, normalized, true);
  await assertNoSymlinkComponents(destinationRoot, normalized, false);
  const [canonicalSourceRoot, canonicalSource] = await Promise.all([
    realpath(sourceRoot),
    realpath(join(sourceRoot, normalized))
  ]);
  if (!isPathWithin(canonicalSource, canonicalSourceRoot)) {
    throw new Error(`Refusing to carry untracked path "${relativePath}": it resolves outside the project.`);
  }
}

async function assertNoSymlinkComponents(root: string, relativePath: string, requireFinalFile: boolean): Promise<void> {
  let current = root;
  const segments = relativePath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index] ?? "");
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(current);
    } catch (error) {
      if (!requireFinalFile && isMissingPathError(error)) return;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(
        `Refusing to carry untracked symbolic link "${relativePath}". Track the link deliberately or use a fresh clone.`
      );
    }
    if (index === segments.length - 1 && requireFinalFile && !info.isFile()) {
      throw new Error(`Refusing to carry non-regular untracked path "${relativePath}".`);
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { readonly code?: unknown }).code === "ENOENT";
}

function dirnameOf(p: string): string {
  const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return idx <= 0 ? p : p.slice(0, idx);
}
