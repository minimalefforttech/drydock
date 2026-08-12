/**
 * Clone sync service tests.
 *
 * These exercise the real git plumbing end to end: every test builds real git
 * repositories in OS temp directories and drives them through the real
 * SpawnCommandRunner. No mocks - the sync protocol only means anything against
 * actual git behavior (3-way apply, conflict markers, numstat, refs).
 */

import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SpawnCommandRunner } from "./commandRunner.js";
import { assertPatchSafeForWindowsGuest, CloneSyncService } from "./cloneSyncService.js";

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

test("protected clone metadata stays outside the mounted worktree and sync remains functional", async () => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({ "a.txt": "alpha\n" });
  try {
    const svc = service();
    const metadataParent = join(root, "host-git");
    const { clonePath } = await svc.initClone({
      localRepoPath,
      cloneParentDir: join(root, "repos"),
      gitMetadataParentDir: metadataParent,
      name: "proj"
    });

    assert.equal(await fileExists(join(clonePath, ".git", "config")), false);
    assert.equal(await fileExists(join(metadataParent, "proj.git", "HEAD")), true);

    // An agent-authored lookalike must not redirect host Git away from the
    // separately held metadata/worktree pair.
    await mkdir(join(clonePath, ".git"), { recursive: true });
    await writeFile(join(clonePath, ".git", "config"), "[core]\n\tworktree = ../outside\n", "utf8");
    await writeFile(join(clonePath, "a.txt"), "agent\n", "utf8");
    assert.deepEqual((await svc.agentChanges(clonePath)).map((change) => change.path), ["a.txt"]);

    await svc.inboundPatch(clonePath, localRepoPath);
    assert.equal(await read(join(localRepoPath, "a.txt")), "agent\n");
    await git(localRepoPath, "add", "a.txt");
    await git(localRepoPath, "commit", "-m", "accept agent change");
    await writeFile(join(localRepoPath, "a.txt"), "developer\n", "utf8");
    await git(localRepoPath, "commit", "-am", "developer change");

    await svc.outboundSync(clonePath, localRepoPath);
    assert.equal(await read(join(clonePath, "a.txt")), "developer\n");
  } finally {
    await cleanup();
  }
});

test("initClone does not execute a configured checkout smudge filter", async () => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({
    ".gitattributes": "payload.bin filter=drydock-test diff=drydock-test\n",
    "payload.bin": "unfiltered payload\n"
  });
  try {
    const globalConfig = join(root, "untrusted-global.gitconfig");
    const filterScript = join(root, "smudge-filter.mjs");
    const marker = join(root, "smudge-ran.txt");
    await writeFile(filterScript, [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync(process.argv[2], "executed", "utf8");',
      "process.stdin.pipe(process.stdout);"
    ].join("\n"), "utf8");
    const command = [process.execPath, filterScript, marker]
      .map((value) => `"${value.replace(/\\/g, "/").replace(/"/g, '\\"')}"`)
      .join(" ");
    await git(root, "config", "--file", globalConfig, "filter.drydock-test.smudge", command);
    await git(root, "config", "--file", globalConfig, "filter.drydock-test.required", "true");

    const configuredRunner = new SpawnCommandRunner({
      ...process.env,
      GIT_CONFIG_GLOBAL: globalConfig
    });
    const svc = new CloneSyncService({ runner: configuredRunner });
    const { clonePath } = await svc.initClone({
      localRepoPath,
      cloneParentDir: join(root, "repos"),
      name: "proj"
    });

    assert.equal(await fileExists(marker), false);
    assert.equal(await read(join(clonePath, "payload.bin")), "unfiltered payload\n");

    // In legacy/in-process use the clone may still expose .git. A filter added
    // there must fail closed before Git can execute it.
    await git(clonePath, "config", "filter.drydock-test.smudge", command);
    await git(clonePath, "config", "filter.drydock-test.required", "true");
    await rm(join(clonePath, "payload.bin"));
    await assert.rejects(svc.discardFile(clonePath, "payload.bin"), /repository-local content filters are not allowed/);
    assert.equal(await fileExists(marker), false);
    await git(clonePath, "config", "--unset-all", "filter.drydock-test.smudge");
    await git(clonePath, "config", "--unset-all", "filter.drydock-test.required");
    await writeFile(join(clonePath, "payload.bin"), "unfiltered payload\n", "utf8");

    await git(clonePath, "config", "diff.drydock-test.textconv", command);
    await writeFile(join(clonePath, "payload.bin"), "agent change\n", "utf8");
    assert.equal((await svc.agentChanges(clonePath))[0]?.path, "payload.bin");
    assert.equal(await fileExists(marker), false);
  } finally {
    await cleanup();
  }
});

test("repository-local merge commands are rejected before a 3-way apply", async () => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({ "a.txt": "alpha\n" });
  try {
    const svc = service();
    const { clonePath } = await svc.initClone({
      localRepoPath,
      cloneParentDir: join(root, "repos"),
      name: "proj"
    });
    const marker = join(root, "merge-driver-ran.txt");
    const command = `node -e \"require('fs').writeFileSync('${marker.replace(/\\/g, "/")}', 'executed')\"`;
    await git(clonePath, "config", "merge.drydock-test.driver", command);
    await writeFile(join(clonePath, "a.txt"), "agent\n", "utf8");

    await assert.rejects(svc.inboundPatch(clonePath, localRepoPath), /repository-local merge commands are not allowed/);
    assert.equal(await fileExists(marker), false);
  } finally {
    await cleanup();
  }
});

test("clone omissions skip matching untracked environment and local-config files", async () => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({ "app.txt": "safe\n" });
  try {
    await writeAll(join(localRepoPath, ".env"), "TOKEN=secret\n");
    await writeAll(join(localRepoPath, "config", "local", "settings.json"), "{\"secret\":true}\n");
    const omission = { sensitive: true, paths: ["config/local"] } as const;
    const svc = service();
    const { clonePath } = await svc.initClone({
      localRepoPath,
      cloneParentDir: join(root, "repos"),
      name: "proj",
      omission
    });

    assert.equal(await fileExists(join(clonePath, ".env")), false);
    assert.equal(await fileExists(join(clonePath, "config", "local", "settings.json")), false);
    assert.equal(await read(join(clonePath, "app.txt")), "safe\n");

    await writeAll(join(localRepoPath, "config", "local", "later.json"), "{}\n");
    await svc.outboundSync(clonePath, localRepoPath, omission);
    assert.equal(await fileExists(join(clonePath, "config", "local", "later.json")), false);
  } finally {
    await cleanup();
  }
});

test("clone carry refuses an untracked symlink instead of copying its target bytes", async (t) => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({ "app.txt": "safe\n" });
  try {
    const outside = join(root, "outside.env");
    const link = join(localRepoPath, "linked.txt");
    await writeFile(outside, "TOKEN=outside\n", "utf8");
    try {
      await symlink(outside, link, "file");
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error
        && ((error as { readonly code?: unknown }).code === "EPERM" || (error as { readonly code?: unknown }).code === "EACCES")) {
        t.skip("This Windows account cannot create symbolic links.");
        return;
      }
      throw error;
    }
    await assert.rejects(
      service().initClone({ localRepoPath, cloneParentDir: join(root, "repos"), name: "proj" }),
      /Refusing to carry untracked symbolic link/
    );
  } finally {
    await cleanup();
  }
});

test("clone omissions refuse currently tracked sensitive content", async () => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({ ".env": "TOKEN=secret\n" });
  try {
    await assert.rejects(
      service().initClone({
        localRepoPath,
        cloneParentDir: join(root, "repos"),
        name: "proj",
        omission: { sensitive: true, paths: [] }
      }),
      /Cannot safely omit .*\.env.*tracked project content/
    );
  } finally {
    await cleanup();
  }
});

test("clone omissions refuse tracked descendants of an exact omitted folder", async () => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({
    "config/local/settings.json": "{\"secret\":true}\n",
    "app.txt": "safe\n"
  });
  try {
    await assert.rejects(
      service().initClone({
        localRepoPath,
        cloneParentDir: join(root, "repos"),
        name: "proj",
        omission: { sensitive: false, paths: ["config/local"] }
      }),
      /config\/local\/settings\.json.*tracked project content/
    );
  } finally {
    await cleanup();
  }
});

test("clone omissions refuse sensitive content retained only in Git history", async () => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({ ".env": "TOKEN=secret\n", "app.txt": "safe\n" });
  try {
    await git(localRepoPath, "rm", ".env");
    await git(localRepoPath, "commit", "-m", "remove env");
    await assert.rejects(
      service().initClone({
        localRepoPath,
        cloneParentDir: join(root, "repos"),
        name: "proj",
        omission: { sensitive: true, paths: [] }
      }),
      /Cannot safely omit .*\.env.*repository history/
    );
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

test("agentChanges does not follow an untracked symlink for stats or conflict markers", async (t) => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({ "app.txt": "safe\n" });
  try {
    const svc = service();
    const { clonePath } = await svc.initClone({
      localRepoPath,
      cloneParentDir: join(root, "repos"),
      name: "proj"
    });
    const outside = join(root, "outside.txt");
    await writeFile(outside, "<<<<<<< outside\nsecret\n", "utf8");
    try {
      await symlink(outside, join(clonePath, "linked.txt"), "file");
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error
        && ((error as { readonly code?: unknown }).code === "EPERM" || (error as { readonly code?: unknown }).code === "EACCES")) {
        t.skip("This Windows account cannot create symbolic links.");
        return;
      }
      throw error;
    }

    const linked = (await svc.agentChanges(clonePath)).find((change) => change.path === "linked.txt");
    assert.equal(linked?.changeKind, "add");
    assert.equal(linked?.addedLines, undefined);
    assert.equal(linked?.conflicted, undefined);
  } finally {
    await cleanup();
  }
});

test("agentChanges does not follow an intermediate directory link for marker scans", async (t) => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({ "nested/file.txt": "base\n" });
  try {
    const svc = service();
    const { clonePath } = await svc.initClone({
      localRepoPath,
      cloneParentDir: join(root, "repos"),
      name: "proj"
    });
    const outsideDir = join(root, "outside");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "file.txt"), "<<<<<<< outside\nsecret\n", "utf8");
    await rm(join(clonePath, "nested"), { recursive: true });
    try {
      await symlink(outsideDir, join(clonePath, "nested"), "junction");
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error
        && ((error as { readonly code?: unknown }).code === "EPERM" || (error as { readonly code?: unknown }).code === "EACCES")) {
        t.skip("This account cannot create directory links.");
        return;
      }
      throw error;
    }

    const tracked = (await svc.agentChanges(clonePath)).find((change) => change.path === "nested/file.txt");
    assert.notEqual(tracked, undefined);
    assert.equal(tracked?.conflicted, undefined);
  } finally {
    await cleanup();
  }
});

test("inbound comparison refuses a local directory link even when its target matches clone HEAD", async (t) => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({ "nested/a.txt": "base\n" });
  try {
    const svc = service();
    const { clonePath } = await svc.initClone({
      localRepoPath,
      cloneParentDir: join(root, "repos"),
      name: "proj"
    });
    await writeFile(join(clonePath, "nested", "a.txt"), "agent\n", "utf8");
    const baseBefore = (await git(clonePath, "rev-parse", "refs/sync/base")).trim();
    const outsideDir = join(root, "outside");
    const outside = join(outsideDir, "a.txt");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(outside, "agent\n", "utf8");
    await rm(join(localRepoPath, "nested"), { recursive: true });
    try {
      await symlink(outsideDir, join(localRepoPath, "nested"), "junction");
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error
        && ((error as { readonly code?: unknown }).code === "EPERM" || (error as { readonly code?: unknown }).code === "EACCES")) {
        t.skip("This account cannot create directory links.");
        return;
      }
      throw error;
    }

    await assert.rejects(svc.inboundPatch(clonePath, localRepoPath), /apply inbound patch for nested\/a\.txt/);
    assert.equal(await read(outside), "agent\n");
    assert.equal((await git(clonePath, "rev-parse", "refs/sync/base")).trim(), baseBefore);
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
    // developer's divergence is committed - which is the real "edited the same
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

test("binary inbound conflict fails without advancing the sync base", async () => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({
    "asset.bin": "base\0payload"
  });
  try {
    const svc = service();
    const { clonePath } = await svc.initClone({
      localRepoPath,
      cloneParentDir: join(root, "repos"),
      name: "proj"
    });
    const baseBefore = (await git(clonePath, "rev-parse", "refs/sync/base")).trim();

    // Both sides replace the same binary blob after the shared base. Git's
    // 3-way apply reports a conflict but cannot leave textual markers. The
    // fallback must therefore fail honestly instead of counting the file and
    // advancing away the agent's still-untransferred delta.
    await writeFile(join(localRepoPath, "asset.bin"), Buffer.from("local\0version"));
    await git(localRepoPath, "add", "asset.bin");
    await git(localRepoPath, "commit", "-m", "local binary divergence");
    await writeFile(join(clonePath, "asset.bin"), Buffer.from("agent\0version"));

    await assert.rejects(
      svc.inboundPatch(clonePath, localRepoPath),
      /apply inbound patch for asset\.bin/
    );

    const baseAfter = (await git(clonePath, "rev-parse", "refs/sync/base")).trim();
    assert.equal(baseAfter, baseBefore, "failed full pull must preserve refs/sync/base");
    const remaining = await git(clonePath, "diff", "--name-only", "refs/sync/base", "HEAD");
    assert.equal(remaining.trim(), "asset.bin", "agent binary delta must remain available for retry");
  } finally {
    await cleanup();
  }
});

test("pre-existing marker text does not prove a failed binary pull transferred", async () => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({
    "asset.bin": "base\0payload"
  });
  try {
    const svc = service();
    const { clonePath } = await svc.initClone({
      localRepoPath,
      cloneParentDir: join(root, "repos"),
      name: "proj"
    });
    const baseBefore = (await git(clonePath, "rev-parse", "refs/sync/base")).trim();

    // This binary starts with marker-like text before the pull. A failed apply
    // must not mistake that pre-existing content for a newly transferred text
    // conflict and advance the clone's base.
    await writeFile(join(localRepoPath, "asset.bin"), Buffer.from("<<<<<<< literal\0local"));
    await git(localRepoPath, "add", "asset.bin");
    await git(localRepoPath, "commit", "-m", "local binary with literal marker");
    await writeFile(join(clonePath, "asset.bin"), Buffer.from("agent\0version"));

    await assert.rejects(
      svc.inboundPatch(clonePath, localRepoPath),
      /apply inbound patch for asset\.bin/
    );
    assert.equal(
      (await git(clonePath, "rev-parse", "refs/sync/base")).trim(),
      baseBefore,
      "pre-existing marker text must not permit a failed full pull to advance the base"
    );
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

    // Agent edits c.txt in the clone (a different file - must survive outbound).
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

test("outbound fetch cannot be rewritten to a network transport by clone config", async () => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({ "a.txt": "alpha\n" });
  try {
    const svc = service();
    const { clonePath } = await svc.initClone({
      localRepoPath,
      cloneParentDir: join(root, "repos"),
      name: "proj"
    });
    await git(clonePath, "config", "url.ssh://invalid/.insteadOf", localRepoPath);

    await assert.rejects(
      svc.outboundSync(clonePath, localRepoPath),
      /transport 'ssh' not allowed/
    );
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

test("scoped pull and discard reject paths outside the clone", async () => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({ "a.txt": "alpha\n" });
  try {
    const svc = service();
    const { clonePath } = await svc.initClone({ localRepoPath, cloneParentDir: join(root, "repos"), name: "proj" });
    const outside = join(root, "outside.txt");
    await writeFile(outside, "keep\n", "utf8");

    await assert.rejects(svc.discardFile(clonePath, "../../outside.txt"), /unsafe clone discard path/);
    await assert.rejects(svc.discardFile(clonePath, outside), /unsafe clone discard path/);
    await assert.rejects(svc.inboundPatch(clonePath, localRepoPath, { path: "../outside.txt" }), /unsafe clone pull path/);
    assert.equal(await read(outside), "keep\n");
  } finally {
    await cleanup();
  }
});

test("discard refuses an intermediate symlink instead of deleting its target", async (t) => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({ "a.txt": "alpha\n" });
  try {
    const svc = service();
    const { clonePath } = await svc.initClone({ localRepoPath, cloneParentDir: join(root, "repos"), name: "proj" });
    const outsideDir = join(root, "outside");
    const victim = join(outsideDir, "victim.txt");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(victim, "keep\n", "utf8");
    try {
      await symlink(outsideDir, join(clonePath, "link"), "junction");
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error
        && ((error as { readonly code?: unknown }).code === "EPERM" || (error as { readonly code?: unknown }).code === "EACCES")) {
        t.skip("This account cannot create directory links.");
        return;
      }
      throw error;
    }

    await assert.rejects(svc.discardFile(clonePath, "link/victim.txt"), /symbolic link/);
    assert.equal(await read(victim), "keep\n");
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

// --- Chain changesets (ADR 0014) ---------------------------------------------

test("outboundChangesetPatch captures agent work as the exact pull delta, null when clean", async () => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({ "a.txt": "alpha\n" });
  try {
    const svc = service();
    const { clonePath } = await svc.initClone({
      localRepoPath,
      cloneParentDir: join(root, "repos"),
      name: "proj"
    });

    // A pristine clone has no outbound delta.
    assert.equal(await svc.outboundChangesetPatch(clonePath), null);

    // Agent work: one tracked edit (uncommitted) + one new file.
    await writeFile(join(clonePath, "a.txt"), "alpha agent\n", "utf8");
    await writeAll(join(clonePath, "new.txt"), "fresh\n");

    const captured = await svc.outboundChangesetPatch(clonePath);
    assert.ok(captured);
    assert.equal(captured.fileCount, 2);
    assert.match(captured.patch, /a\.txt/);
    assert.match(captured.patch, /new\.txt/);

    // Idempotent: capturing again returns the same delta (base did not move).
    const again = await svc.outboundChangesetPatch(clonePath);
    assert.equal(again?.fileCount, 2);
  } finally {
    await cleanup();
  }
});

test("initClone seedPatches land upstream output inside the sync base", async () => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({ "a.txt": "alpha\n" });
  try {
    const svc = service();
    // Upstream run: clone, agent writes output, capture its changeset.
    const upstream = await svc.initClone({
      localRepoPath,
      cloneParentDir: join(root, "repos-up"),
      name: "proj"
    });
    await writeAll(join(upstream.clonePath, "generated.txt"), "upstream output\n");
    const captured = await svc.outboundChangesetPatch(upstream.clonePath);
    assert.ok(captured);

    // Dependent run: fresh clone seeded with the upstream changeset.
    const dependent = await svc.initClone({
      localRepoPath,
      cloneParentDir: join(root, "repos-dep"),
      name: "proj",
      seedPatches: [{ label: "sub-up/proj", patch: captured.patch }]
    });

    // The upstream output is present…
    assert.equal(await read(join(dependent.clonePath, "generated.txt")), "upstream output\n");
    // …and sits INSIDE refs/sync/base: the dependent's own outbound delta is
    // empty, so its later changeset never re-carries upstream content.
    assert.deepEqual(await svc.agentChanges(dependent.clonePath), []);
    assert.equal(await svc.outboundChangesetPatch(dependent.clonePath), null);
  } finally {
    await cleanup();
  }
});

test("a conflicting seed patch fails clone init loudly, naming its source", async () => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({ "f.txt": "base line\n" });
  try {
    const svc = service();
    // Upstream changes f.txt from the original base…
    const upstream = await svc.initClone({
      localRepoPath,
      cloneParentDir: join(root, "repos-up"),
      name: "proj"
    });
    await writeFile(join(upstream.clonePath, "f.txt"), "upstream version\n", "utf8");
    const captured = await svc.outboundChangesetPatch(upstream.clonePath);
    assert.ok(captured);

    // …and the developer's local repo then diverges on the same line.
    await writeFile(join(localRepoPath, "f.txt"), "local divergent\n", "utf8");
    await git(localRepoPath, "add", "-A");
    await git(localRepoPath, "commit", "-m", "local divergence");

    await assert.rejects(
      svc.initClone({
        localRepoPath,
        cloneParentDir: join(root, "repos-dep"),
        name: "proj",
        seedPatches: [{ label: "sub-up/proj", patch: captured.patch }]
      }),
      /seed upstream changeset sub-up\/proj/
    );
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Windows-guest patch boundary (ADR 0022, edge cases D3/D4)
// ---------------------------------------------------------------------------

test("a plain changeset passes the Windows-guest boundary untouched", () => {
  const patch = [
    "diff --git a/src/loader.py b/src/loader.py",
    "index 1111111..2222222 100644",
    "--- a/src/loader.py",
    "+++ b/src/loader.py",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    ""
  ].join("\n");
  assert.doesNotThrow(() => { assertPatchSafeForWindowsGuest(patch); });
});

test("a new symbolic link is rejected by name", () => {
  const patch = [
    "diff --git a/docs/latest b/docs/latest",
    "new file mode 120000",
    "index 0000000..3333333",
    "--- /dev/null",
    "+++ b/docs/latest",
    "@@ -0,0 +1 @@",
    "+docs/v2",
    "\ No newline at end of file",
    ""
  ].join("\n");
  assert.throws(() => { assertPatchSafeForWindowsGuest(patch); }, (error: Error) => {
    assert.match(error.message, /"docs\/latest" is a symbolic link/);
    assert.match(error.message, /cannot be validated on a Windows runtime/);
    return true;
  });
});

test("deleted, converted, and retargeted symlinks are all caught", () => {
  const deleted = [
    "diff --git a/docs/gone b/docs/gone",
    "deleted file mode 120000",
    ""
  ].join("\n");
  const converted = [
    "diff --git a/docs/converted b/docs/converted",
    "old mode 100644",
    "new mode 120000",
    ""
  ].join("\n");
  const retargeted = [
    "diff --git a/docs/moved b/docs/moved",
    "index 1111111..2222222 120000",
    "--- a/docs/moved",
    "+++ b/docs/moved",
    ""
  ].join("\n");
  assert.throws(() => { assertPatchSafeForWindowsGuest(deleted); }, /"docs\/gone" is a symbolic link/);
  assert.throws(() => { assertPatchSafeForWindowsGuest(converted); }, /"docs\/converted" is a symbolic link/);
  assert.throws(() => { assertPatchSafeForWindowsGuest(retargeted); }, /"docs\/moved" is a symbolic link/);
});

test("paths that differ only by capitalization are rejected together", () => {
  const patch = [
    "diff --git a/src/Icons.py b/src/Icons.py",
    "index 1111111..2222222 100644",
    "--- a/src/Icons.py",
    "+++ b/src/Icons.py",
    "diff --git a/src/icons.py b/src/icons.py",
    "index 3333333..4444444 100644",
    "--- a/src/icons.py",
    "+++ b/src/icons.py",
    ""
  ].join("\n");
  assert.throws(() => { assertPatchSafeForWindowsGuest(patch); }, (error: Error) => {
    assert.match(error.message, /"src\/Icons\.py" and "src\/icons\.py" differ only by capitalization/);
    return true;
  });
});

test("a case-only rename with an edit is one file, not a collision", () => {
  // The shape git ACTUALLY emits for a rename-with-content-change: `--- a/<old>`
  // and `+++ b/<new>` carry both spellings, but only the destination (`+++`)
  // exists on NTFS after apply. Bucketing the union of both spellings (the old
  // bug) refused this legitimate single-file rename.
  const patch = [
    "diff --git a/src/icons.py b/src/Icons.py",
    "similarity index 88%",
    "rename from src/icons.py",
    "rename to src/Icons.py",
    "index 1111111..2222222 100644",
    "--- a/src/icons.py",
    "+++ b/src/Icons.py",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    ""
  ].join("\n");
  assert.doesNotThrow(() => { assertPatchSafeForWindowsGuest(patch); });
});

test("deleting a file and adding its case-variant is not a collision - only one is a destination", () => {
  // `Bar.py` is deleted (`+++ /dev/null`, `deleted file mode`) so it lands
  // nowhere on the guest; `bar.py` is added. The two never coexist on NTFS, so
  // this must be accepted even though their lowercase spellings match.
  const patch = [
    "diff --git a/Bar.py b/Bar.py",
    "deleted file mode 100644",
    "index 1111111..0000000",
    "--- a/Bar.py",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-gone",
    "diff --git a/bar.py b/bar.py",
    "new file mode 100644",
    "index 0000000..2222222",
    "--- /dev/null",
    "+++ b/bar.py",
    "@@ -0,0 +1 @@",
    "+fresh",
    ""
  ].join("\n");
  assert.doesNotThrow(() => { assertPatchSafeForWindowsGuest(patch); });
});

test("two genuinely distinct files differing only by case are still refused, listing both", () => {
  // Each has its own `diff --git` + `+++` line, so both are destinations that
  // would collapse into one file on NTFS - the real collision the guard exists
  // to catch, which the destination-only rework must NOT weaken.
  const patch = [
    "diff --git a/pkg/Foo.py b/pkg/Foo.py",
    "index 1111111..2222222 100644",
    "--- a/pkg/Foo.py",
    "+++ b/pkg/Foo.py",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "diff --git a/pkg/foo.py b/pkg/foo.py",
    "index 3333333..4444444 100644",
    "--- a/pkg/foo.py",
    "+++ b/pkg/foo.py",
    "@@ -1 +1 @@",
    "-c",
    "+d",
    ""
  ].join("\n");
  assert.throws(() => { assertPatchSafeForWindowsGuest(patch); }, (error: Error) => {
    assert.match(error.message, /"pkg\/Foo\.py" and "pkg\/foo\.py" differ only by capitalization/);
    return true;
  });
});

test("every offender is listed in one message, not just the first", () => {
  const patch = [
    "diff --git a/link b/link",
    "new file mode 120000",
    "diff --git a/other b/other",
    "new file mode 120000",
    "diff --git a/src/A.py b/src/A.py",
    "index 1111111..2222222 100644",
    "diff --git a/src/a.py b/src/a.py",
    "index 3333333..4444444 100644",
    ""
  ].join("\n");
  assert.throws(() => { assertPatchSafeForWindowsGuest(patch); }, (error: Error) => {
    const lines = error.message.split("\n").filter((line) => line.startsWith("  - "));
    assert.equal(lines.length, 3);
    assert.match(error.message, /"link" is a symbolic link/);
    assert.match(error.message, /"other" is a symbolic link/);
    assert.match(error.message, /differ only by capitalization/);
    // Studio vocabulary: the denial names the way forward (G3).
    assert.match(error.message, /Rework the changeset so it applies on Windows/);
    return true;
  });
});

test("a real cross-platform changeset with a symlink fails the boundary it would fail in the guest", async (t) => {
  const { root, localRepoPath, cleanup } = await makeLocalRepo({ "keep.txt": "base\n" });
  try {
    const svc = service();
    const clone = await svc.initClone({ localRepoPath, cloneParentDir: join(root, "repos"), name: "proj" });
    await writeAll(join(clone.clonePath, "real.txt"), "content\n");
    try {
      await symlink(join(clone.clonePath, "real.txt"), join(clone.clonePath, "alias.txt"), "file");
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error
        && ((error as { readonly code?: unknown }).code === "EPERM" || (error as { readonly code?: unknown }).code === "EACCES")) {
        t.skip("This Windows account cannot create symbolic links.");
        return;
      }
      throw error;
    }
    const captured = await svc.outboundChangesetPatch(clone.clonePath);
    assert.ok(captured);
    assert.throws(() => { assertPatchSafeForWindowsGuest(captured.patch); }, /is a symbolic link/);
  } finally {
    await cleanup();
  }
});
