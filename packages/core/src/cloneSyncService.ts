/**
 * Clone-mode sync service.
 *
 * Implements the symmetric 3-way patch protocol from
 * `docs/design/clone-mode.md`. All git operations run HOST-side through the
 * injected {@link CommandRunner}. The working tree lives inside the session
 * workspace (`<workspace>/repos/<name>`); production keeps its Git metadata in
 * a host-only sibling directory. The developer's real repo is only ever a
 * clone source / fetch source / working-tree apply target: nothing is pushed
 * anywhere, and the local repo gains no commits.
 *
 * `refs/sync/base` always names the last state both sides share;
 * inbound/outbound patches are computed and applied relative to it.
 */

import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CloneFileChange,
  CloneSyncResult,
  CommandResult,
  CommandRunner,
  DiffChangeKind
} from "@drydock/contracts";
import { isPathWithin, normalizePathKey, sensitivePathMatch } from "./mountPolicy.js";

/** Fixed committer identity for sync commits - never depend on host git config. */
const SYNC_AUTHOR = ["-c", "user.name=clone-sync", "-c", "user.email=clone-sync@localhost"] as const;

/** Default timeout for individual git invocations. */
const GIT_TIMEOUT_MS = 60_000;

/** Refuse to move patches larger than this - a runaway diff should fail loudly. */
const MAX_PATCH_BYTES = 50 * 1024 * 1024;

/** Cap for the bounded conflict-marker scan of a single working-tree file. */
const MARKER_SCAN_MAX_BYTES = 2 * 1024 * 1024;

const CONFLICT_MARKER = "<<<<<<< ";
const GIT_NULL_PATH = process.platform === "win32" ? "NUL" : devNull;

/**
 * Host Git runs with hooks, credential helpers, fsmonitor processes, and LFS
 * checkout filters disabled. Repository data may be untrusted; it must not be
 * able to turn a clone or sync into host command execution or an implicit
 * network request.
 */
const SAFE_GIT_CONFIG = [
  "-c", "core.alternateRefsCommand=",
  "-c", `core.attributesFile=${GIT_NULL_PATH}`,
  "-c", `core.excludesFile=${GIT_NULL_PATH}`,
  "-c", `core.hooksPath=${GIT_NULL_PATH}`,
  "-c", "core.fsmonitor=false",
  "-c", "commit.gpgSign=false",
  "-c", "credential.helper=",
  "-c", "diff.external=",
  "-c", "filter.lfs.required=false",
  "-c", "filter.lfs.process=",
  "-c", "filter.lfs.smudge=",
  "-c", "gc.auto=0",
  "-c", "interactive.diffFilter=",
  "-c", "maintenance.auto=false",
  "-c", "protocol.allow=never",
  "-c", "protocol.file.allow=always",
  "-c", "tag.gpgSign=false"
] as const;
const FILTER_SENSITIVE_GIT_COMMANDS = new Set(["add", "apply", "checkout", "diff", "hash-object", "status"]);

export interface CloneSyncServiceOptions {
  readonly runner: CommandRunner;
  /** Git executable; defaults to "git" on PATH. */
  readonly gitPath?: string;
  /** Private environment used as the base for hardened Git subprocesses. */
  readonly environment?: NodeJS.ProcessEnv;
  /** Re-authorizes a selected source repository at each host Git boundary. */
  readonly authorizeHostPath?: (candidate: string) => string;
  /** Private parent for temporary patch files; defaults to the OS temp dir. */
  readonly temporaryDirectory?: string;
  readonly timeoutMs?: number;
}

export interface InitCloneInput {
  readonly localRepoPath: string;
  readonly cloneParentDir: string;
  /** Host-only metadata directory outside the workspace mounted into the agent. */
  readonly gitMetadataParentDir?: string;
  readonly name: string;
  /** carry overlays tracked/untracked working state; fresh uses current local HEAD only. */
  readonly dirtyHandling?: "carry" | "fresh";
  /** Paths that must never be copied from the developer repo into the clone. */
  readonly omission?: ClonePathOmission;
  /**
   * Upstream changeset patches to 3-way apply into the fresh clone BEFORE the
   * sync base freezes (ADR 0014). Applying pre-base keeps the clone's own
   * outbound delta scoped to work done IN this clone - a dependent's later
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

interface GitRepositoryLocation {
  readonly gitDir: string;
  readonly workTree: string;
}

export class CloneSyncService {
  private readonly runner: CommandRunner;
  private readonly git: string;
  private readonly timeoutMs: number;
  private readonly gitEnvironment: NodeJS.ProcessEnv;
  private readonly protectedCloneRepositories = new Map<string, GitRepositoryLocation>();
  private readonly sourceRepositories = new Map<string, GitRepositoryLocation>();
  private readonly authorizeHostPath?: (candidate: string) => string;
  private readonly temporaryDirectory: string;
  private detectCache: { available: boolean; version?: string } | undefined;

  constructor(options: CloneSyncServiceOptions) {
    this.runner = options.runner;
    this.git = options.gitPath ?? "git";
    this.timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
    this.gitEnvironment = safeGitEnvironment(options.environment ?? process.env);
    if (options.authorizeHostPath !== undefined) this.authorizeHostPath = options.authorizeHostPath;
    this.temporaryDirectory = options.temporaryDirectory ?? tmpdir();
  }

  /** `git --version`, cached for the lifetime of the service. */
  async detectGit(): Promise<{ available: boolean; version?: string }> {
    if (this.detectCache !== undefined) return this.detectCache;
    const result = await this.runGit(["--version"], process.cwd());
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
    const authorizedPath = this.authorizeHostPath?.(localRepoPath) ?? await realpath(localRepoPath);
    const gitDir = await this.resolveContainedGitDirectory(authorizedPath);
    if (gitDir === null) {
      return {
        localRepoPath: authorizedPath,
        isGitRepo: false,
        detached: false,
        trackedChanges: 0,
        untrackedFiles: 0,
        dirty: false
      };
    }
    this.sourceRepositories.set(normalizePathKey(authorizedPath), { gitDir, workTree: authorizedPath });
    const inside = await this.runGit(["rev-parse", "--is-inside-work-tree"], authorizedPath);
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
      return {
        localRepoPath: authorizedPath,
        isGitRepo: false,
        detached: false,
        trackedChanges: 0,
        untrackedFiles: 0,
        dirty: false
      };
    }
    const head = await this.gitIn(authorizedPath, ["rev-parse", "--abbrev-ref", "HEAD"], "resolve local HEAD for preflight");
    const detached = head.stdout.trim() === "HEAD";
    const branch = detached
      ? (await this.gitIn(authorizedPath, ["rev-parse", "HEAD"], "resolve detached HEAD for preflight")).stdout.trim()
      : head.stdout.trim();
    const status = await this.gitIn(
      authorizedPath,
      ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      "read local repository status"
    );
    const counts = countPreflightStatus(status.stdout);
    return {
      localRepoPath: authorizedPath,
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
    const { cloneParentDir, name } = input;
    const localRepoPath = this.authorizeHostPath?.(input.localRepoPath) ?? await realpath(input.localRepoPath);
    if (!this.sourceRepositories.has(normalizePathKey(localRepoPath))) {
      const gitDir = await this.resolveContainedGitDirectory(localRepoPath);
      if (gitDir === null) throw new Error(`Clone source is not a supported Git worktree: ${localRepoPath}`);
      this.sourceRepositories.set(normalizePathKey(localRepoPath), { gitDir, workTree: localRepoPath });
    }
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
    const gitDir = input.gitMetadataParentDir === undefined
      ? undefined
      : join(input.gitMetadataParentDir, `${name}.git`);
    if (input.gitMetadataParentDir !== undefined) {
      await mkdir(input.gitMetadataParentDir, { recursive: true });
    }
    const separateGitDir = gitDir === undefined ? [] : [`--separate-git-dir=${gitDir}`];
    const cloneArgs = detached
      ? [...SYNC_AUTHOR, "clone", ...cloneIsolationArgs, ...separateGitDir, "--no-checkout", localRepoPath, clonePath]
      : [...SYNC_AUTHOR, "clone", ...cloneIsolationArgs, ...separateGitDir, "-b", branch, localRepoPath, clonePath];
    const cloneSource = await this.assertSourceRepositoryCurrent(localRepoPath);
    await this.localFilterOverrides(localRepoPath, cloneSource);
    await this.git0(cloneArgs, cloneParentDir, "clone local repo");
    const cloneRepository = {
      gitDir: await realpath(gitDir ?? join(clonePath, ".git")),
      workTree: await realpath(clonePath)
    };
    this.protectedCloneRepositories.set(normalizePathKey(clonePath), cloneRepository);
    if (gitDir !== undefined) {
      // The pointer would expose host layout and is agent-writable. Host Git
      // uses the protected explicit git-dir below, so the mounted snapshot
      // deliberately contains working files only.
      await rm(join(clonePath, ".git"), { force: true });
    }
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

      // Copy untracked (but not ignored) files verbatim - copy-win, no merge.
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
    // seeded content becomes part of refs/sync/base - the clone's own outbound
    // delta stays scoped to work done here, never re-carrying upstream output.
    for (const seed of input.seedPatches ?? []) {
      if (seed.patch.length === 0) continue;
      const dir = await mkdtemp(join(this.temporaryDirectory, "clone-seed-"));
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
   * then `diff --binary refs/sync/base..HEAD` - byte-for-byte what a full
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
   * Inbound - "pull the agent's work into my editor".
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

    const scopedPath = opts?.path === undefined ? undefined : assertRepoRelativePath(opts.path, "clone pull path");
    const fullPull = scopedPath === undefined;
    const diffArgs = ["diff", "--binary", "refs/sync/base", "HEAD", ...(scopedPath === undefined ? [] : ["--", scopedPath])];
    const patch = await this.diffToFile(clonePath, diffArgs, "build inbound patch");

    let appliedFiles: number;
    let conflictedFiles: readonly string[];
    try {
      if (patch.bytes === 0) {
        return { appliedFiles: 0, conflictedFiles: [], message: "nothing to pull" };
      }

      const touched = await this.patchPaths(clonePath, scopedPath);
      assertPathsNotOmitted(touched, opts?.omission, "clone pull");
      // Snapshot marker state BEFORE the first apply attempt. The fallback may
      // observe markers written by that whole-patch attempt, but literal marker
      // text that was already in the developer's file is not proof that this
      // pull transferred anything.
      const conflictMarkersBefore = new Map<string, boolean>();
      for (const touchedPath of touched) {
        conflictMarkersBefore.set(touchedPath, await this.hasConflictMarkers(localRepoPath, touchedPath));
      }
      const applyArgs = ["--binary", "--3way", "--whitespace=nowarn", ...(scopedPath === undefined ? [] : [`--include=${scopedPath}`])];
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

    const message = describeSync("Pulled", appliedFiles, conflictedFiles, fullPull ? undefined : scopedPath);
    return {
      appliedFiles,
      conflictedFiles,
      message
    };
  }

  /**
   * Outbound - "push my local edits to the VM".
   *
   * Commit agent progress, fetch the local repo's branch tip from the explicit
   * host path, 3-way apply the committed local delta
   * (`sync/base..FETCH_HEAD`) onto the clone tree, then 3-way apply the local
   * DIRTY delta and copy untracked files (copy-win, skipping identical
   * content). Commit `[sync] local`, advance `sync/base`. Conflicts land as
   * markers in the CLONE - the agent resolves them.
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

    // Never trust the clone's mutable `origin`: an agent can edit .git/config.
    // Fetching the validated host path directly keeps this operation local.
    const fetchSource = await this.assertSourceRepositoryCurrent(localRepoPath);
    await this.localFilterOverrides(localRepoPath, fetchSource);
    await this.gitIn(clonePath, ["fetch", "--no-tags", localRepoPath, branch], "fetch local branch into clone");

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
   * checked out from it - those are un-staged and removed from the working tree.
   */
  async discardFile(clonePath: string, path: string): Promise<void> {
    const safePath = assertRepoRelativePath(path, "clone discard path");
    const existsAtBase = await this.gitIn(
      clonePath,
      ["cat-file", "-e", `refs/sync/base:${safePath}`],
      "probe file at sync base"
    );
    if (existsAtBase.exitCode === 0) {
      await this.gitIn(clonePath, ["checkout", "refs/sync/base", "--", safePath], `restore ${safePath} from sync base`);
      return;
    }
    // New-since-base file: drop it from the index (ignore if not tracked) and
    // delete it from the working tree.
    await assertNoSymlinkComponents(clonePath, safePath, false);
    await this.gitIn(clonePath, ["rm", "--cached", "--ignore-unmatch", "--", safePath], `unstage new file ${safePath}`);
    await rm(join(clonePath, safePath), { force: true });
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
      // - a genuine no-op, so count it and move on without re-applying.
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
    const localFile = await resolveContainedRegularFile(localRepoPath, path, "local comparison path");
    if (localFile === null) return false;
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
      const file = await resolveContainedRegularFile(repoPath, path, "line-count path");
      if (file === null) return null;
      const buf = await readFile(file);
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
      const file = await resolveContainedRegularFile(repoPath, path, "conflict-marker path");
      if (file === null) return false;
      const buf = await readFile(file);
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
    const result = await this.runGit(args, repoPath);
    if (result.exitCode !== 0 && !nonFatal) {
      throw gitError(step, repoPath, result);
    }
    return result;
  }

  /** Run git with an explicit cwd (used for `clone`, whose target does not yet exist). */
  private async git0(args: readonly string[], cwd: string, step: string): Promise<CommandResult> {
    const result = await this.runGit(args, cwd);
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
    const dir = await mkdtemp(join(this.temporaryDirectory, "clone-sync-"));
    const patchFile = join(dir, "patch.diff");
    const cleanup = async (): Promise<void> => {
      await rm(dir, { recursive: true, force: true });
    };
    try {
      const [verb, ...rest] = diffArgs;
      const result = await this.runGit([verb ?? "diff", `--output=${patchFile}`, ...rest], repoPath);
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
    // Patch is applied from a file, never stdin - Windows-safe and unbounded.
    return this.runGit(["apply", ...applyFlags, patchFile], repoPath);
  }

  private async runGit(args: readonly string[], cwd: string): Promise<CommandResult> {
    const command = gitCommand(args);
    const cwdKey = normalizePathKey(cwd);
    const sourceRepository = this.sourceRepositories.get(cwdKey);
    if (sourceRepository !== undefined) {
      await this.assertSourceRepositoryCurrent(sourceRepository.workTree);
    }
    const protectedRepository = this.protectedCloneRepositories.get(cwdKey);
    if (protectedRepository !== undefined) {
      await this.assertRepositoryPathsCurrent(protectedRepository, "protected clone");
    }
    const repository = protectedRepository ?? sourceRepository;
    const repositoryArgs = repository === undefined ? [] : this.repositoryArguments(repository);
    const filterOverrides = repository !== undefined && FILTER_SENSITIVE_GIT_COMMANDS.has(command.name)
      ? await this.localFilterOverrides(cwd, repository)
      : [];
    const commandArgs = command.name === "diff"
      ? [...args.slice(0, command.index + 1), "--no-ext-diff", "--no-textconv", ...args.slice(command.index + 1)]
      : [...args];
    return this.runner.run(this.git, [...SAFE_GIT_CONFIG, ...repositoryArgs, ...filterOverrides, ...commandArgs], {
      cwd,
      timeoutMs: this.timeoutMs,
      env: this.gitEnvironment
    });
  }

  /** Neutralize repository-local clean/smudge processes for commands that may invoke them. */
  private async localFilterOverrides(repoPath: string, repository: GitRepositoryLocation): Promise<string[]> {
    const configPath = join(repository.gitDir, "config");
    try {
      const info = await lstat(configPath);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`Refusing host Git in ${repoPath}: repository config is not a regular file.`);
      }
      const canonical = await realpath(configPath);
      if (!isPathWithin(canonical, repository.gitDir)) {
        throw new Error(`Refusing host Git in ${repoPath}: repository config is outside its protected metadata directory.`);
      }
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error
        && (error as { readonly code?: unknown }).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const result = await this.runner.run(
      this.git,
      [...SAFE_GIT_CONFIG, "config", "--file", configPath, "--no-includes", "--name-only", "--null", "--list"],
      { cwd: repoPath, timeoutMs: this.timeoutMs, env: this.gitEnvironment }
    );
    if (result.exitCode === 1) return [];
    if (result.exitCode !== 0) throw gitError("inspect local Git configuration", repoPath, result);
    if (result.stdout.includes("[truncated ")) {
      throw new Error(`Refusing host Git in ${repoPath}: local Git configuration is too large to verify safely.`);
    }

    const drivers = new Set<string>();
    for (const key of splitZ(result.stdout)) {
      if (/^include(?:if\..+)?\.path$/i.test(key)) {
        throw new Error(`Refusing host Git in ${repoPath}: repository-local config includes are not allowed.`);
      }
      if (/^merge\..+\.driver$/i.test(key)) {
        throw new Error(`Refusing host Git in ${repoPath}: repository-local merge commands are not allowed.`);
      }
      const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/i.exec(key);
      if (match?.[1]) drivers.add(match[1]);
    }
    const executableDrivers = [...drivers].filter((driver) => driver.toLowerCase() !== "lfs");
    if (executableDrivers.length > 0) {
      throw new Error(
        `Refusing host Git in ${repoPath}: repository-local content filters are not allowed (${executableDrivers.join(", ")}).`
      );
    }
    return [...drivers].flatMap((driver) => [
      "-c", `filter.${driver}.required=false`,
      "-c", `filter.${driver}.clean=`,
      "-c", `filter.${driver}.smudge=`,
      "-c", `filter.${driver}.process=`
    ]);
  }

  private async assertSourceRepositoryCurrent(repoPath: string): Promise<GitRepositoryLocation> {
    const repository = this.sourceRepositories.get(normalizePathKey(repoPath));
    if (repository === undefined) {
      throw new Error("The source repository is no longer the approved project. Re-select it before continuing.");
    }
    const current = this.authorizeHostPath?.(repository.workTree) ?? await realpath(repository.workTree);
    if (normalizePathKey(current) !== normalizePathKey(repository.workTree)) {
      throw new Error("The source repository path changed after approval. Re-select it before continuing.");
    }
    await this.assertRepositoryPathsCurrent(repository, "source repository");
    return repository;
  }

  private repositoryArguments(repository: GitRepositoryLocation): string[] {
    return [
      `--git-dir=${repository.gitDir}`,
      `--work-tree=${repository.workTree}`,
      "-c", "core.bare=false",
      "-c", `core.worktree=${repository.workTree}`
    ];
  }

  private async assertRepositoryPathsCurrent(repository: GitRepositoryLocation, label: string): Promise<void> {
    const workTreeInfo = await lstat(repository.workTree);
    if (!workTreeInfo.isDirectory() || workTreeInfo.isSymbolicLink()) {
      throw new Error(`The ${label} path changed after approval. Recreate the session before continuing.`);
    }
    const gitDirInfo = await lstat(repository.gitDir);
    if (!gitDirInfo.isDirectory() || gitDirInfo.isSymbolicLink()) {
      throw new Error(`The ${label} Git metadata changed after approval. Recreate the session before continuing.`);
    }
    const [currentWorkTree, currentGitDir] = await Promise.all([
      realpath(repository.workTree),
      realpath(repository.gitDir)
    ]);
    if (normalizePathKey(currentWorkTree) !== normalizePathKey(repository.workTree)
      || normalizePathKey(currentGitDir) !== normalizePathKey(repository.gitDir)) {
      throw new Error(`The ${label} target changed after approval. Recreate the session before continuing.`);
    }
  }

  private async resolveContainedGitDirectory(workTree: string): Promise<string | null> {
    const candidate = join(workTree, ".git");
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(candidate);
    } catch {
      return null;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Secure clone mode does not support linked or redirected Git metadata: ${candidate}`);
    }
    const canonical = await realpath(candidate);
    if (!isPathWithin(canonical, workTree)) {
      throw new Error(`Git metadata is outside the approved project root: ${canonical}`);
    }
    return canonical;
  }
}

/** A patch materialized on disk, with its byte size and a cleanup handle. */
interface PreparedPatch {
  readonly patchFile: string;
  readonly bytes: number;
  readonly cleanup: () => Promise<void>;
}

/**
 * Start from the extension host environment, but discard inherited GIT_*
 * controls before adding a small deterministic set. In particular this keeps
 * user/system filter configuration and credential prompts out of host sync.
 */
function safeGitEnvironment(baseEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnvironment)) {
    if (!key.toUpperCase().startsWith("GIT_")) environment[key] = value;
  }
  environment["GIT_CONFIG_GLOBAL"] = GIT_NULL_PATH;
  environment["GIT_CONFIG_SYSTEM"] = GIT_NULL_PATH;
  environment["GIT_CONFIG_NOSYSTEM"] = "1";
  environment["GIT_ATTR_NOSYSTEM"] = "1";
  environment["GIT_LFS_SKIP_SMUDGE"] = "1";
  environment["GIT_TERMINAL_PROMPT"] = "0";
  environment["GCM_INTERACTIVE"] = "Never";
  return environment;
}

/** Find the git subcommand after any global options supplied by callers. */
function gitCommand(args: readonly string[]): { readonly name: string; readonly index: number } {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-c") {
      index += 1;
      continue;
    }
    if (arg?.startsWith("-")) continue;
    return { name: arg ?? "", index };
  }
  return { name: "", index: -1 };
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
 * blobs can bury later headers - bounded to the same cap used elsewhere; the
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
    // dest missing - fall through to copy.
  }
  await mkdir(dirnameOf(dest), { recursive: true });
  await writeFile(dest, srcBuf);
  return true;
}

/** Normalizes and confines any UI/API supplied path to one repository. */
function assertRepoRelativePath(value: string, label: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (normalized === ""
    || normalized.includes("\0")
    || normalized.startsWith("/")
    || /^[A-Za-z]:/.test(normalized)
    || normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Refusing unsafe ${label} "${value}".`);
  }
  return normalized;
}

/**
 * Untracked carry is a host-side copy, so never follow a symlink/junction from
 * either the developer repo or the agent-controlled clone. Git paths are also
 * checked for traversal even though `git ls-files` should only emit relative
 * repository paths. Fresh clone remains the zero-copy alternative.
 */
async function assertSafeUntrackedCopy(sourceRoot: string, destinationRoot: string, relativePath: string): Promise<void> {
  const normalized = assertRepoRelativePath(relativePath, "untracked path during clone carry");
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

/**
 * Resolve a Git-reported path only when every existing component is a real
 * directory/file and the final target is a regular file inside the repository.
 * Missing, linked, redirected, and non-regular targets are deliberately
 * treated as unreadable; callers can omit advisory stats or fall back to the
 * normal patch path without touching the link target.
 */
async function resolveContainedRegularFile(root: string, relativePath: string, label: string): Promise<string | null> {
  const normalized = assertRepoRelativePath(relativePath, label);
  try {
    await assertNoSymlinkComponents(root, normalized, true);
    const [canonicalRoot, canonicalFile] = await Promise.all([
      realpath(root),
      realpath(join(root, normalized))
    ]);
    return isPathWithin(canonicalFile, canonicalRoot) ? canonicalFile : null;
  } catch {
    return null;
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
