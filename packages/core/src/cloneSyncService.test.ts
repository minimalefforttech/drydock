/**
 * Clone sync service tests.
 *
 * These exercise the real git plumbing end to end: every test builds real git
 * repositories in OS temp directories and drives them through the real
 * SpawnCommandRunner. No mocks — the sync protocol only means anything against
 * actual git behavior (3-way apply, conflict markers, numstat, refs).
 */

import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SpawnCommandRunner } from "./commandRunner.js";
import { CloneSyncService } from "./cloneSyncService.js";

const runner = new SpawnCommandRunner();

/** Minimal git helper for arranging the local repo in tests. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runner.run("git", args, { cwd, timeoutMs: 60_000 });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr || result.stdout || result.error}`);
  }
  return result.stdout;
}

async function writeAll(path: string, content: string): Promise<void> {
  await mkdir(dirOf(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

function dirOf(p: string): string {
  const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return p.slice(0, idx);
}

/** Create a workspace root with an initialized local repo on `main`. */
async function makeLocalRepo(files: Record<string, string>): Promise<{ root: string; localRepoPath: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "clone-sync-test-"));
  const localRepoPath = join(root, "local");
  await mkdir(localRepoPath, { recursive: true });
  await git(localRepoPath, "init", "-b", "main");
  await git(localRepoPath, "config", "user.name", "Dev");
  await git(localRepoPath, "config", "user.email", "dev@localhost");
  for (const [rel, content] of Object.entries(files)) {
    await writeAll(join(localRepoPath, rel), content);
  }
  await git(localRepoPath, "add", "-A");
  await git(localRepoPath, "commit", "-m", "initial");
  const cleanup = async (): Promise<void> => {
    await rm(root, { recursive: true, force: true });
  };
  return { root, localRepoPath, cleanup };
}

function service(): CloneSyncService {
  return new CloneSyncService({ runner });
}

/**
 * Read a file, normalizing CRLF -> LF. Git honors the developer's
 * `core.autocrlf`, so content round-tripped through `git apply` / checkout on
 * Windows may come back with CRLF even though we wrote LF. That normalization
 * is a git-config concern orthogonal to whether the sync protocol moved the
 * right content, so tests compare on normalized line endings.
 */
async function read(path: string): Promise<string> {
  return (await readFile(path, "utf8")).replace(/\r\n/g, "\n");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------

test("detectGit reports availability and a version", async () => {
  const svc = service();
  const first = await svc.detectGit();
  assert.equal(first.available, true);
  assert.match(first.version ?? "", /^\d+\.\d+/);
  // Cached call returns the same object.
  const second = await svc.detectGit();
  assert.equal(second, first);
});

test("initClone snapshots dirty tracked change + untracked file into sync base", async () => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({
    "a.txt": "alpha\n",
    "b.txt": "bravo\n"
  });
  try {
    // Dirty tracked edit + a brand-new untracked file (developer's working state).
    await writeFile(join(localRepoPath, "a.txt"), "alpha modified\n", "utf8");
    await writeFile(join(localRepoPath, "untracked.txt"), "loose\n", "utf8");

    const svc = service();
    const { clonePath, branch, detached } = await svc.initClone({
      localRepoPath,
      cloneParentDir: join(root, "repos"),
      name: "proj"
    });

    assert.equal(branch, "main");
    assert.equal(detached, false);

    // The dirty change and untracked file are present in the clone working tree.
    assert.equal(await read(join(clonePath, "a.txt")), "alpha modified\n");
    assert.equal(await read(join(clonePath, "untracked.txt")), "loose\n");

    // And they are committed AT sync/base (the base is a faithful snapshot).
    const baseTree = await git(clonePath, "diff", "--name-only", "refs/sync/base", "HEAD");
    assert.equal(baseTree.trim(), "", "sync/base should equal HEAD right after init");
    const showA = await git(clonePath, "show", "refs/sync/base:a.txt");
    assert.equal(showA, "alpha modified\n");
    const showUntracked = await git(clonePath, "show", "refs/sync/base:untracked.txt");
    assert.equal(showUntracked, "loose\n");
  } finally {
    await cleanup();
  }
});

test("preflightRepo reports branch and tracked/untracked dirtiness without changing the repo", async () => {
  const { localRepoPath, cleanup } = await makeLocalRepo({ "a.txt": "alpha\n" });
  try {
    await writeFile(join(localRepoPath, "a.txt"), "changed\n", "utf8");
    await writeFile(join(localRepoPath, "loose.txt"), "loose\n", "utf8");
    const before = await git(localRepoPath, "rev-parse", "HEAD");

    const preflight = await service().preflightRepo(localRepoPath);

    assert.equal(preflight.isGitRepo, true);
    assert.equal(preflight.branch, "main");
    assert.equal(preflight.detached, false);
    assert.equal(preflight.trackedChanges, 1);
    assert.equal(preflight.untrackedFiles, 1);
    assert.equal(preflight.dirty, true);
    assert.equal(await git(localRepoPath, "rev-parse", "HEAD"), before);
    assert.equal(await read(join(localRepoPath, "a.txt")), "changed\n");

    await git(localRepoPath, "checkout", "--detach");
    const detached = await service().preflightRepo(localRepoPath);
    assert.equal(detached.detached, true);
    assert.equal(detached.branch, before.trim());
  } finally {
    await cleanup();
  }
});

test("preflightRepo reports a non-git directory without throwing", async () => {
  const root = await mkdtemp(join(tmpdir(), "clone-sync-non-git-"));
  try {
    assert.deepEqual(await service().preflightRepo(root), {
      localRepoPath: root,
      isGitRepo: false,
      detached: false,
      trackedChanges: 0,
      untrackedFiles: 0,
      dirty: false
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initClone fresh uses current committed HEAD and excludes dirty and untracked files", async () => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({ "a.txt": "committed\n" });
  try {
    await writeFile(join(localRepoPath, "a.txt"), "dirty\n", "utf8");
    await writeFile(join(localRepoPath, "loose.txt"), "loose\n", "utf8");

    const { clonePath } = await service().initClone({
      localRepoPath,
      cloneParentDir: join(root, "repos"),
      name: "fresh-proj",
      dirtyHandling: "fresh"
    });

    assert.equal(await read(join(clonePath, "a.txt")), "committed\n");
    assert.equal(await fileExists(join(clonePath, "loose.txt")), false);
    assert.equal((await git(clonePath, "status", "--porcelain")).trim(), "");
    assert.equal((await git(clonePath, "diff", "--name-only", "refs/sync/base", "HEAD")).trim(), "");
  } finally {
    await cleanup();
  }
});

test("initClone notes a detached HEAD by commit id", async () => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({ "a.txt": "alpha\n" });
  try {
    const headSha = (await git(localRepoPath, "rev-parse", "HEAD")).trim();
    await git(localRepoPath, "checkout", "--detach", headSha);

    const svc = service();
    const { branch, detached } = await svc.initClone({
      localRepoPath,
      cloneParentDir: join(root, "repos"),
      name: "proj"
    });
    assert.equal(detached, true);
    assert.equal(branch, headSha);
  } finally {
    await cleanup();
  }
});

test("agentChanges reports change kinds and line stats vs sync base", async () => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({
    "keep.txt": "one\ntwo\nthree\n",
    "gone.txt": "remove me\n"
  });
  try {
    const svc = service();
    const { clonePath } = await svc.initClone({
      localRepoPath,
      cloneParentDir: join(root, "repos"),
      name: "proj"
    });

    // Agent edits keep.txt, deletes gone.txt, adds new.txt (uncommitted).
    await writeFile(join(clonePath, "keep.txt"), "one\ntwo\nthree\nfour\n", "utf8");
    await rm(join(clonePath, "gone.txt"));
    await writeFile(join(clonePath, "new.txt"), "fresh\n", "utf8");

    const changes = await svc.agentChanges(clonePath);
    const byPath = new Map(changes.map((c) => [c.path, c]));

    assert.equal(byPath.get("keep.txt")?.changeKind, "modify");
    assert.equal(byPath.get("keep.txt")?.addedLines, 1);
    assert.equal(byPath.get("keep.txt")?.removedLines, 0);
    assert.equal(byPath.get("gone.txt")?.changeKind, "delete");
    assert.equal(byPath.get("new.txt")?.changeKind, "add");
    assert.equal(byPath.get("new.txt")?.addedLines, 1);
  } finally {
    await cleanup();
  }
});

test("full inbound applies to local working tree without local commits and advances base", async () => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({
    "a.txt": "alpha\n",
    "b.txt": "bravo\n"
  });
  try {
    const svc = service();
    const { clonePath } = await svc.initClone({
      localRepoPath,
      cloneParentDir: join(root, "repos"),
      name: "proj"
    });
    const localHeadBefore = (await git(localRepoPath, "rev-parse", "HEAD")).trim();

    // Agent changes both files in the clone (uncommitted).
    await writeFile(join(clonePath, "a.txt"), "alpha agent\n", "utf8");
    await writeFile(join(clonePath, "b.txt"), "bravo agent\n", "utf8");

    const result = await svc.inboundPatch(clonePath, localRepoPath);
    assert.equal(result.appliedFiles, 2);
    assert.deepEqual(result.conflictedFiles, []);

    // Landed in the LOCAL working tree.
    assert.equal(await read(join(localRepoPath, "a.txt")), "alpha agent\n");
    assert.equal(await read(join(localRepoPath, "b.txt")), "bravo agent\n");

    // No local commits were made; working tree is dirty vs HEAD.
    const localHeadAfter = (await git(localRepoPath, "rev-parse", "HEAD")).trim();
    assert.equal(localHeadAfter, localHeadBefore, "local repo must not gain commits");
    const localStatus = await git(localRepoPath, "status", "--porcelain");
    assert.match(localStatus, /a\.txt/);

    // Base advanced to HEAD -> a follow-up pull finds nothing.
    const again = await svc.inboundPatch(clonePath, localRepoPath);
    assert.equal(again.appliedFiles, 0);
    assert.equal(again.message, "nothing to pull");
  } finally {
    await cleanup();
  }
});

test("inbound conflict: local edit to the same line surfaces markers, is reported, base still advances", async () => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({ "a.txt": "line1\nline2\nline3\n" });
  try {
    const svc = service();
    const { clonePath } = await svc.initClone({
      localRepoPath,
      cloneParentDir: join(root, "repos"),
      name: "proj"
    });

    // Developer commits a divergent edit to line2 after init. `git apply --3way`
    // computes its merge against committed/index blobs (not the dirty working
    // tree), so a conflicting inbound patch only produces markers when the
    // developer's divergence is committed — which is the real "edited the same
    // lines since the last sync" case the design describes.
    await writeFile(join(localRepoPath, "a.txt"), "line1\nDEV EDIT\nline3\n", "utf8");
    await git(localRepoPath, "commit", "-am", "dev edits line2");
    // Agent edits the same line in the clone.
    await writeFile(join(clonePath, "a.txt"), "line1\nAGENT EDIT\nline3\n", "utf8");

    const result = await svc.inboundPatch(clonePath, localRepoPath);
    assert.deepEqual(result.conflictedFiles, ["a.txt"]);

    const localContent = await read(join(localRepoPath, "a.txt"));
    assert.match(localContent, /<<<<<<< /);
    assert.match(localContent, /=======/);
    assert.match(localContent, />>>>>>>/);

    // Base advances despite the conflict (content was transferred with markers).
    const baseDelta = await git(clonePath, "diff", "--name-only", "refs/sync/base", "HEAD");
    assert.equal(baseDelta.trim(), "");
  } finally {
    await cleanup();
  }
});

test("per-file pull leaves base and does not break the following full pull", async () => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({
    "a.txt": "a base\n",
    "b.txt": "b base\n"
  });
  try {
    const svc = service();
    const { clonePath } = await svc.initClone({
      localRepoPath,
      cloneParentDir: join(root, "repos"),
      name: "proj"
    });

    // Agent changes both files.
    await writeFile(join(clonePath, "a.txt"), "a agent\n", "utf8");
    await writeFile(join(clonePath, "b.txt"), "b agent\n", "utf8");

    // Per-file pull of a.txt only.
    const perFile = await svc.inboundPatch(clonePath, localRepoPath, { path: "a.txt" });
    assert.equal(perFile.appliedFiles, 1);
    assert.equal(await read(join(localRepoPath, "a.txt")), "a agent\n");
    // b.txt not pulled yet.
    assert.equal(await read(join(localRepoPath, "b.txt")), "b base\n");

    // Per-file pull must NOT advance the base: base..HEAD still shows both.
    const delta = await git(clonePath, "diff", "--name-only", "refs/sync/base", "HEAD");
    const deltaFiles = delta.trim().split(/\s+/).sort();
    assert.deepEqual(deltaFiles, ["a.txt", "b.txt"]);

    // The following FULL pull re-encounters a.txt (already applied) and b.txt.
    // a.txt is an idempotent no-op (local already equals clone HEAD); b lands.
    const full = await svc.inboundPatch(clonePath, localRepoPath);
    assert.equal(await read(join(localRepoPath, "b.txt")), "b agent\n");
    assert.equal(await read(join(localRepoPath, "a.txt")), "a agent\n");
    assert.deepEqual(full.conflictedFiles, []);
    assert.equal(full.appliedFiles, 2);

    // Now base advanced.
    const after = await git(clonePath, "diff", "--name-only", "refs/sync/base", "HEAD");
    assert.equal(after.trim(), "");
  } finally {
    await cleanup();
  }
});

test("outbound lands local commit + dirty edit in clone; agent's parallel change survives", async () => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({
    "a.txt": "a base\n",
    "b.txt": "b base\n",
    "c.txt": "c base\n"
  });
  try {
    const svc = service();
    const { clonePath } = await svc.initClone({
      localRepoPath,
      cloneParentDir: join(root, "repos"),
      name: "proj"
    });

    // Agent edits c.txt in the clone (a different file — must survive outbound).
    await writeFile(join(clonePath, "c.txt"), "c agent\n", "utf8");

    // Developer commits a change to a.txt and leaves b.txt dirty.
    await writeFile(join(localRepoPath, "a.txt"), "a committed\n", "utf8");
    await git(localRepoPath, "commit", "-am", "local commit on a");
    await writeFile(join(localRepoPath, "b.txt"), "b dirty\n", "utf8");

    const result = await svc.outboundSync(clonePath, localRepoPath);

    // Local edits landed in the clone.
    assert.equal(await read(join(clonePath, "a.txt")), "a committed\n");
    assert.equal(await read(join(clonePath, "b.txt")), "b dirty\n");
    // Agent's parallel change on c.txt survived the outbound sync.
    assert.equal(await read(join(clonePath, "c.txt")), "c agent\n");
    assert.deepEqual(result.conflictedFiles, []);

    // Base advanced to the new clone HEAD.
    const delta = await git(clonePath, "diff", "--name-only", "refs/sync/base", "HEAD");
    assert.equal(delta.trim(), "");
  } finally {
    await cleanup();
  }
});

test("outbound copies untracked local files (skipping identical)", async () => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({ "a.txt": "a\n" });
  try {
    const svc = service();
    const { clonePath } = await svc.initClone({
      localRepoPath,
      cloneParentDir: join(root, "repos"),
      name: "proj"
    });

    await writeFile(join(localRepoPath, "loose.txt"), "brand new\n", "utf8");
    const result = await svc.outboundSync(clonePath, localRepoPath);

    assert.equal(await read(join(clonePath, "loose.txt")), "brand new\n");
    assert.equal(result.untrackedCopied, 1);
  } finally {
    await cleanup();
  }
});

test("outbound conflict: local + agent edit the same line -> markers in clone, reported", async () => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({ "a.txt": "l1\nl2\nl3\n" });
  try {
    const svc = service();
    const { clonePath } = await svc.initClone({
      localRepoPath,
      cloneParentDir: join(root, "repos"),
      name: "proj"
    });

    // Agent edits line2 in the clone.
    await writeFile(join(clonePath, "a.txt"), "l1\nAGENT\nl3\n", "utf8");
    // Developer commits a conflicting edit to line2 locally.
    await writeFile(join(localRepoPath, "a.txt"), "l1\nDEV\nl3\n", "utf8");
    await git(localRepoPath, "commit", "-am", "dev edits line2");

    const result = await svc.outboundSync(clonePath, localRepoPath);
    assert.deepEqual(result.conflictedFiles, ["a.txt"]);

    const cloneContent = await read(join(clonePath, "a.txt"));
    assert.match(cloneContent, /<<<<<<< /);
    assert.match(cloneContent, />>>>>>>/);
  } finally {
    await cleanup();
  }
});

test("discardFile restores sync-base content and removes new-since-base files", async () => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({ "a.txt": "a base\n" });
  try {
    const svc = service();
    const { clonePath } = await svc.initClone({
      localRepoPath,
      cloneParentDir: join(root, "repos"),
      name: "proj"
    });

    // Agent modifies a tracked file and adds a new one.
    await writeFile(join(clonePath, "a.txt"), "a agent\n", "utf8");
    await writeFile(join(clonePath, "added.txt"), "new file\n", "utf8");
    await git(clonePath, "add", "-A");

    // Discard the modification -> restored to base content.
    await svc.discardFile(clonePath, "a.txt");
    assert.equal(await read(join(clonePath, "a.txt")), "a base\n");

    // Discard the new-since-base file -> gone from working tree and index.
    await svc.discardFile(clonePath, "added.txt");
    assert.equal(await fileExists(join(clonePath, "added.txt")), false);
    const status = await git(clonePath, "status", "--porcelain");
    assert.doesNotMatch(status, /added\.txt/);
  } finally {
    await cleanup();
  }
});

test("inbound on a clean clone reports nothing to pull without advancing base", async () => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({ "a.txt": "a\n" });
  try {
    const svc = service();
    const { clonePath } = await svc.initClone({
      localRepoPath,
      cloneParentDir: join(root, "repos"),
      name: "proj"
    });
    const baseBefore = (await git(clonePath, "rev-parse", "refs/sync/base")).trim();

    const result = await svc.inboundPatch(clonePath, localRepoPath);
    assert.equal(result.appliedFiles, 0);
    assert.equal(result.message, "nothing to pull");

    const baseAfter = (await git(clonePath, "rev-parse", "refs/sync/base")).trim();
    assert.equal(baseAfter, baseBefore);
  } finally {
    await cleanup();
  }
});

test("patches larger than the 50 MB cap are refused with a clear message", async () => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({ "a.txt": "a\n" });
  try {
    const svc = service();
    const { clonePath } = await svc.initClone({
      localRepoPath,
      cloneParentDir: join(root, "repos"),
      name: "proj"
    });
    // A > 50 MB agent addition must be refused before any apply is attempted.
    const big = "x".repeat(51 * 1024 * 1024) + "\n";
    await writeFile(join(clonePath, "big.txt"), big, "utf8");
    await assert.rejects(svc.inboundPatch(clonePath, localRepoPath), /exceeds the .*clone-sync cap/);
  } finally {
    await cleanup();
  }
});
