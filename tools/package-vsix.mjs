/**
 * Packages the VS Code extension as a scoped VSIX.
 *
 * The extension and webview are bundled first (tools/bundle-extension.mjs) so
 * the VSIX never depends on npm workspace links at install time. Only the
 * staged manifest, README, bundled entry points, and the view icon are allowed
 * under the extension payload.
 */

import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpRoot = path.join(root, ".tmp");
const extensionRoot = path.join(root, "apps", "vscode-extension");
const stageRoot = path.join(tmpRoot, "vsix-stage", "vscode-extension");
const outRoot = path.join(tmpRoot, "vsix-output");
const vsceBin = path.join(root, "node_modules", "@vscode", "vsce", "vsce");

const sourceManifest = JSON.parse(
  await readFile(path.join(extensionRoot, "package.json"), "utf8")
);

assertInside(tmpRoot, stageRoot);
assertInside(tmpRoot, outRoot);
await rm(stageRoot, { recursive: true, force: true });
await mkdir(path.join(stageRoot, "dist", "webview"), { recursive: true });
await mkdir(path.join(stageRoot, "media"), { recursive: true });
await mkdir(outRoot, { recursive: true });

await run(process.execPath, [path.join(root, "tools", "bundle-extension.mjs")], root);

const stagedFiles = [
  "dist/extension.js",
  "dist/webview/main.js",
  "dist/webview/main.css",
  "dist/webview/planDocsMermaid.js",
  "dist/webview/taskReview.js",
  "dist/webview/taskReview.css",
  "dist/webview/taskBoard.js",
  "dist/webview/taskBoard.css",
  "dist/webview/planner.js",
  "dist/webview/planner.css",
  "dist/webview/agents.js",
  "dist/webview/agents.css",
  "media/icon.svg"
];
for (const relativePath of stagedFiles) {
  const segments = relativePath.split("/");
  await copyFile(path.join(extensionRoot, ...segments), path.join(stageRoot, ...segments));
}

const stagedManifest = {
  name: sourceManifest.name,
  displayName: sourceManifest.displayName,
  version: sourceManifest.version,
  publisher: sourceManifest.publisher,
  description: sourceManifest.description,
  repository: sourceManifest.repository,
  type: sourceManifest.type,
  main: sourceManifest.main,
  engines: sourceManifest.engines,
  activationEvents: sourceManifest.activationEvents,
  contributes: sourceManifest.contributes,
  files: [
    "README.md",
    "dist/extension.js",
    "dist/webview/main.js",
    "dist/webview/main.css",
    "dist/webview/planDocsMermaid.js",
    "dist/webview/taskReview.js",
    "dist/webview/taskReview.css",
    "dist/webview/taskBoard.js",
    "dist/webview/taskBoard.css",
    "dist/webview/planner.js",
    "dist/webview/planner.css",
    "dist/webview/agents.js",
    "dist/webview/agents.css",
    "media/icon.svg"
  ]
};

await writeFile(
  path.join(stageRoot, "package.json"),
  `${JSON.stringify(stagedManifest, null, 2)}\n`,
  "utf8"
);
await copyFile(path.join(extensionRoot, "README.md"), path.join(stageRoot, "README.md"));

const vsixPath = path.join(outRoot, `${sourceManifest.name}-${sourceManifest.version}.vsix`);
await rm(vsixPath, { force: true });
await run(process.execPath, [vsceBin, "package", "--out", vsixPath], stageRoot);

// VSIX is a zip; use bsdtar (System32 on Windows) rather than whatever GNU
// tar happens to be first on PATH — GNU tar cannot read zip archives.
const tarBin = process.platform === "win32"
  ? path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe")
  : "tar";
const listing = await runCapture(tarBin, ["-tf", vsixPath], root);
assertPackagedFiles(listing.stdout);

console.log(`VSIX created: ${vsixPath}`);

async function run(command, args, cwd) {
  const result = await runCapture(command, args, cwd);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.exitCode !== 0) {
    throw new Error(`${command} failed with exit ${String(result.exitCode)}`);
  }
}

async function runCapture(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

function assertPackagedFiles(stdout) {
  const entries = stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  const required = new Set([
    "[Content_Types].xml",
    "extension.vsixmanifest",
    "extension/package.json",
    "extension/readme.md",
    "extension/dist/extension.js",
    "extension/dist/webview/main.js",
    "extension/dist/webview/main.css",
    "extension/dist/webview/planDocsMermaid.js",
    "extension/dist/webview/taskReview.js",
    "extension/dist/webview/taskReview.css",
    "extension/dist/webview/taskBoard.js",
    "extension/dist/webview/taskBoard.css",
    "extension/dist/webview/planner.js",
    "extension/dist/webview/planner.css",
    "extension/dist/webview/agents.js",
    "extension/dist/webview/agents.css",
    "extension/media/icon.svg"
  ]);
  for (const entry of required) {
    if (!entries.includes(entry)) {
      throw new Error(`VSIX is missing expected entry: ${entry}`);
    }
  }
  const unexpectedEntries = entries.filter((entry) => !required.has(entry));
  if (unexpectedEntries.length > 0) {
    throw new Error(`VSIX has unexpected files: ${unexpectedEntries.join(", ")}`);
  }
}

function assertInside(parent, child) {
  const relative = path.relative(parent, child);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to touch path outside ${parent}: ${child}`);
  }
}
