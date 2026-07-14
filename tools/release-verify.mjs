/**
 * Repeatable, traceable local/CI release gate. Run through `npm run release:verify` so
 * this script can invoke the same npm installation without a shell.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env["npm_execpath"];
if (!npmCli) {
  throw new Error("Run this check with `npm run release:verify`.");
}

const startingCommit = await currentCommit();
await assertCleanTracked("before verification");

await runNpm(["ci"]);
await runNpm(["run", "build", "--silent"]);
await runNpm(["test", "--silent"]);
await runNpm(["audit", "--audit-level=high"]);
const sbomPath = path.join(root, ".tmp", "release", "sbom.cdx.json");
await mkdir(path.dirname(sbomPath), { recursive: true });
await writeFile(
  sbomPath,
  await capture(process.execPath, [npmCli, "sbom", "--sbom-format", "cyclonedx"]),
  "utf8"
);
await runNpm(["run", "package:vsix", "--silent"]);

if (await currentCommit() !== startingCommit) {
  throw new Error("The checked-out revision changed during release verification.");
}
await assertCleanTracked("after verification");

const rootManifest = await readJson(path.join(root, "package.json"));
const extensionManifest = await readJson(path.join(root, "apps", "vscode-extension", "package.json"));
const artifactName = `${requiredString(extensionManifest, "name")}-${requiredString(extensionManifest, "version")}.vsix`;
const artifactPath = path.join(root, ".tmp", "vsix-output", artifactName);
const artifactStat = await stat(artifactPath);
const artifactHash = createHash("sha256").update(await readFile(artifactPath)).digest("hex");
const sbomStat = await stat(sbomPath);
const sbomHash = createHash("sha256").update(await readFile(sbomPath)).digest("hex");
const lockfileHash = createHash("sha256").update(await readFile(path.join(root, "package-lock.json"))).digest("hex");

const releaseManifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: {
    commit: startingCommit,
    cleanWorktree: true,
    packageLockSha256: lockfileHash
  },
  package: {
    name: requiredString(rootManifest, "name"),
    version: requiredString(rootManifest, "version"),
    extensionName: requiredString(extensionManifest, "name"),
    extensionVersion: requiredString(extensionManifest, "version")
  },
  artifact: {
    file: `.tmp/vsix-output/${artifactName}`,
    bytes: artifactStat.size,
    sha256: artifactHash
  },
  sbom: {
    file: ".tmp/release/sbom.cdx.json",
    format: "CycloneDX JSON",
    scope: "build dependencies",
    bytes: sbomStat.size,
    sha256: sbomHash
  },
  tools: {
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    npm: (await capture(process.execPath, [npmCli, "--version"])).trim(),
    git: (await capture("git", ["--version"])).trim(),
    typescript: await installedPackageVersion("typescript"),
    vsce: await installedPackageVersion("@vscode/vsce")
  },
  checks: [
    "npm ci",
    "npm run build --silent",
    "npm test --silent",
    "npm audit --audit-level=high",
    "npm sbom --sbom-format cyclonedx",
    "npm run package:vsix --silent"
  ]
};

const manifestPath = path.join(root, ".tmp", "release", "release-manifest.json");
await mkdir(path.dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`, "utf8");

console.log(`Release verified at ${startingCommit.slice(0, 12)}.`);
console.log(`VSIX SHA-256: ${artifactHash}`);
console.log(`Manifest: ${manifestPath}`);

async function currentCommit() {
  return (await capture("git", ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
}

async function assertCleanTracked(stage) {
  const status = await capture("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.trim() !== "") {
    throw new Error(`Release verification requires a completely clean worktree (${stage}).`);
  }
}

async function runNpm(args) {
  await run(process.execPath, [npmCli, ...args]);
}

async function run(command, args) {
  console.log(`> ${displayCommand(command, args)}`);
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", windowsHide: true });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) resolve();
      else reject(new Error(`${path.basename(command)} failed with exit ${String(exitCode)}`));
    });
  });
}

async function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) resolve(stdout);
      else reject(new Error(`${path.basename(command)} failed with exit ${String(exitCode)}: ${stderr.trim()}`));
    });
  });
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function installedPackageVersion(packageName) {
  const packagePath = path.join(root, "node_modules", ...packageName.split("/"), "package.json");
  return requiredString(await readJson(packagePath), "version");
}

function requiredString(value, field) {
  const entry = value?.[field];
  if (typeof entry !== "string" || entry.length === 0) {
    throw new Error(`Expected ${field} to be a non-empty string.`);
  }
  return entry;
}

function displayCommand(command, args) {
  if (command === process.execPath && args[0] === npmCli) return `npm ${args.slice(1).join(" ")}`;
  return `${path.basename(command)} ${args.join(" ")}`;
}
