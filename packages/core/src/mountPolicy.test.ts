/**
 * Unit tests for mount policy behavior (session modes, denied paths).
 */

import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RandomIdGenerator } from "./ids.js";
import {
  assertChildMountsWithinParent,
  assertMountAllowed,
  assertWorkspaceInsideOwner,
  buildMountPolicy,
  defaultDeniedPaths,
  isFilesystemRoot,
  isPathDenied,
  isPathWithin,
  isSensitivePath,
  normalizePathKey,
  sandboxRuntimePath,
  sensitivePathMatch
} from "./mountPolicy.js";

test("plan mode mounts workspace roots read-only", () => {
  const [mount] = buildMountPolicy({
    mode: "plan",
    workspaceRoots: ["C:\\project"],
    sharedRead: [],
    sharedWrite: [],
    approvedAt: "2026-07-01T00:00:00.000Z",
    approvedBy: "test"
  }, new RandomIdGenerator());

  assert.equal(mount?.mode, "read-only");
  assert.equal(mount?.source, "workspace-root");
});

test("implementation mode mounts disposable workspace read-write", () => {
  const [mount] = buildMountPolicy({
    mode: "implementation",
    workspaceRoots: ["C:\\project"],
    sharedRead: [],
    sharedWrite: [],
    approvedAt: "2026-07-01T00:00:00.000Z",
    approvedBy: "test"
  }, new RandomIdGenerator());

  assert.equal(mount?.mode, "read-write");
});

test("clone mode does not mount live workspace roots", () => {
  const mounts = buildMountPolicy({
    mode: "clone",
    workspaceRoots: ["C:\\project"],
    sharedRead: [],
    sharedWrite: [],
    approvedAt: "2026-07-01T00:00:00.000Z",
    approvedBy: "test"
  }, new RandomIdGenerator());

  assert.equal(mounts.length, 0);
});

test("workspace roots advertise the real sandbox mount path, not a synthetic label", () => {
  const [mount] = buildMountPolicy({
    mode: "implementation",
    workspaceRoots: ["H:\\pipeline\\work\\fr_sceptre"],
    sharedRead: [],
    sharedWrite: [],
    approvedAt: "2026-07-01T00:00:00.000Z",
    approvedBy: "test"
  }, new RandomIdGenerator());
  // The agent is told where sbx actually mounts the folder; the old
  // `/workspace/root-N` fiction sent writes into an unmounted overlay.
  assert.notEqual(mount?.runtimePath, "/workspace/root-1");
  if (process.platform === "win32") {
    assert.equal(mount?.runtimePath, "/h/pipeline/work/fr_sceptre");
  }
});

test("sandboxRuntimePath mirrors a Windows drive path into the container", () => {
  if (process.platform === "win32") {
    assert.equal(sandboxRuntimePath("H:\\pipeline\\work"), "/h/pipeline/work");
    assert.equal(sandboxRuntimePath("C:/proj/app"), "/c/proj/app");
  }
});

test("readOnlyRoots force read-only even in implementation mode", () => {
  const mounts = buildMountPolicy({
    mode: "implementation",
    workspaceRoots: ["C:\\rw", "C:\\ro"],
    readOnlyRoots: ["C:\\ro"], // matched by normalized path key
    sharedRead: [],
    sharedWrite: []
  }, new RandomIdGenerator());
  assert.equal(mounts[0]?.mode, "read-write");
  assert.equal(mounts[1]?.mode, "read-only");
});

test("workspace ownership guard rejects paths outside owner root", async () => {
  const owner = await mkdtemp(path.join(os.tmpdir(), "drydock-owner-"));
  assert.throws(() => assertWorkspaceInsideOwner(path.dirname(owner), owner));
});

test("path keys normalize separators, trailing slashes, and case-insensitive casing", () => {
  assert.equal(normalizePathKey("C:\\Project\\Sub\\", true), normalizePathKey("c:/project/sub", true));
  assert.notEqual(normalizePathKey("/a/B", false), normalizePathKey("/a/b", false));
  assert.equal(isPathWithin("C:\\project\\src\\file.ts", "C:\\PROJECT", true), true);
  assert.equal(isPathWithin("C:\\project-sibling", "C:\\project", true), false);
});

test("denied paths block mounts in both containment directions", () => {
  const denied = ["C:\\work\\secrets"];
  // Direct and nested requests are denied; a parent that would expose the
  // denied path is denied too; siblings are fine.
  assert.equal(isPathDenied("C:\\work\\secrets", denied, true), true);
  assert.equal(isPathDenied("C:\\work\\secrets\\keys", denied, true), true);
  assert.equal(isPathDenied("C:\\work", denied, true), true);
  assert.equal(isPathDenied("C:\\projects", denied, true), false);

  assert.throws(() => buildMountPolicy({
    mode: "implementation",
    workspaceRoots: ["C:\\work\\secrets\\keys"],
    sharedRead: [],
    sharedWrite: [],
    deniedPaths: denied
  }, new RandomIdGenerator()), /denied path/);

  // A non-root parent that would expose the denied path is refused as a denied
  // intersection (a drive root would trip the filesystem-root refusal first —
  // see the dedicated test below).
  assert.throws(() => buildMountPolicy({
    mode: "plan",
    workspaceRoots: [],
    sharedRead: ["C:\\work"],
    sharedWrite: [],
    deniedPaths: denied
  }, new RandomIdGenerator()), /denied path/);
});

test("assertMountAllowed refuses filesystem roots and UNC share roots", () => {
  // Drive / POSIX roots and bare UNC share roots are whole-volume mounts.
  assert.equal(isFilesystemRoot("C:\\"), true);
  assert.equal(isFilesystemRoot(process.platform === "win32" ? "C:\\" : "/"), true);
  assert.equal(isFilesystemRoot("\\\\server\\share"), true);
  assert.equal(isFilesystemRoot("\\\\server\\share\\"), true);
  // A directory inside a volume or a UNC share is fine.
  assert.equal(isFilesystemRoot("C:\\project"), false);
  assert.equal(isFilesystemRoot("\\\\server\\share\\project"), false);

  assert.throws(() => assertMountAllowed("C:\\", []), /Refusing to mount a filesystem root/);
  assert.throws(() => assertMountAllowed("\\\\server\\share", []), /Refusing to mount a filesystem root/);
  // The refusal fires everywhere assertMountAllowed runs, including buildMountPolicy.
  assert.throws(() => buildMountPolicy({
    mode: "implementation",
    workspaceRoots: ["C:\\"],
    sharedRead: [],
    sharedWrite: [],
    deniedPaths: []
  }, new RandomIdGenerator()), /Refusing to mount a filesystem root/);
});

test("defaultDeniedPaths joins the sensitive home config roots", () => {
  const home = process.platform === "win32" ? "C:\\Users\\alex" : "/home/alex";
  const denied = defaultDeniedPaths(home);
  assert.deepEqual(
    denied,
    [".ssh", ".aws", ".gnupg", ".kube", ".azure", ".docker"].map((segment) => path.join(home, segment))
  );
  // Each entry lives under the home dir (join, not raw concatenation).
  assert.ok(denied.every((entry) => entry.startsWith(home)));
});

test("isSensitivePath flags credential dirs and files across separators", () => {
  // Sensitive directory segments, anywhere in the path, either separator.
  assert.equal(isSensitivePath("C:\\Users\\alex\\.ssh\\id_rsa"), true);
  assert.equal(isSensitivePath("/home/alex/.aws/credentials"), true);
  assert.equal(isSensitivePath("C:\\proj\\secrets\\token.txt"), true);
  assert.equal(isSensitivePath("/srv/.GnuPG/keyring"), true); // case-insensitive segment

  // Sensitive basenames.
  assert.equal(isSensitivePath("C:\\proj\\.env"), true);
  assert.equal(isSensitivePath("C:\\proj\\.env.production"), true);
  assert.equal(isSensitivePath("/etc/ssl/server.pem"), true);
  assert.equal(isSensitivePath("C:\\keys\\host.key"), true);
  assert.equal(isSensitivePath("C:\\certs\\bundle.p12"), true);
  assert.equal(isSensitivePath("C:\\certs\\bundle.PFX"), true); // case-insensitive ext
  assert.equal(isSensitivePath("/home/alex/id_ed25519.pub"), true);
  assert.equal(isSensitivePath("/home/alex/.netrc"), true);
  assert.equal(isSensitivePath("/proj/credentials.json"), true);

  // Negatives: ordinary project paths and near-misses.
  assert.equal(isSensitivePath("C:\\project\\src\\index.ts"), false);
  assert.equal(isSensitivePath("/home/alex/notes.md"), false);
  assert.equal(isSensitivePath("C:\\proj\\environment.ts"), false); // not .env
  assert.equal(isSensitivePath("C:\\proj\\keyboard.ts"), false); // not *.key
  assert.equal(isSensitivePath("C:\\proj\\my-secrets-app\\main.ts"), false); // segment is "my-secrets-app", not "secrets"
});

test("sensitivePathMatch names the matched trigger for the approval card", () => {
  // Directory segment wins, verbatim (original casing preserved for display).
  assert.deepEqual(sensitivePathMatch("C:\\Users\\alex\\.ssh\\id_rsa"), { kind: "directory", match: ".ssh" });
  assert.deepEqual(sensitivePathMatch("/srv/.GnuPG/keyring"), { kind: "directory", match: ".GnuPG" });
  // Basename pattern when no directory segment matches.
  assert.deepEqual(sensitivePathMatch("C:\\proj\\.env"), { kind: "file", match: ".env" });
  assert.deepEqual(sensitivePathMatch("/etc/ssl/server.pem"), { kind: "file", match: "server.pem" });
  // Clean paths yield null (isSensitivePath stays the boolean view of this).
  assert.equal(sensitivePathMatch("C:\\project\\src\\index.ts"), null);
});


test("assertChildMountsWithinParent enforces the subset rule for role sessions", () => {
  const ids = new RandomIdGenerator();
  const parent = buildMountPolicy({
    mode: "implementation",
    workspaceRoots: ["C:/proj/app"],
    sharedRead: ["C:/studio/packages"],
    sharedWrite: []
  }, ids);

  // Identical inherit passes; a narrowed subdir passes; ro-under-rw passes.
  assertChildMountsWithinParent(parent, parent);
  const narrowed = [{ ...parent[0]!, hostPath: "C:/proj/app/src", mode: "read-only" as const }];
  assertChildMountsWithinParent(narrowed, parent);

  // A path outside every parent mount is refused.
  assert.throws(
    () => assertChildMountsWithinParent([{ ...parent[0]!, hostPath: "C:/other/repo" }], parent),
    /outside the parent session's access/
  );
  // rw under a parent mount that is only ro is refused.
  assert.throws(
    () => assertChildMountsWithinParent(
      [{ ...parent[1]!, hostPath: "C:/studio/packages/lib", mode: "read-write" as const }],
      parent
    ),
    /read-only/
  );
});
