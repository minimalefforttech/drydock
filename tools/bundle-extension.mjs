/**
 * Bundles the extension host entry and the control panel webview assets into
 * apps/vscode-extension/dist. Used by the F5 pre-launch task and by
 * package-vsix.mjs so the debugged artifact and the shipped artifact are
 * identical.
 */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.join(root, "apps", "vscode-extension");
const distRoot = path.join(extensionRoot, "dist");
const esbuildBin = path.join(root, "node_modules", "esbuild", "bin", "esbuild");

await mkdir(path.join(distRoot, "webview"), { recursive: true });

// Extension host bundle: self-contained except the vscode runtime module.
await esbuild([
  path.join(extensionRoot, "src", "extension.ts"),
  "--bundle",
  "--platform=node",
  "--format=esm",
  "--target=node22",
  "--external:vscode",
  `--outfile=${path.join(distRoot, "extension.js")}`
]);

// Webview script: browser IIFE, contracts bundled in.
await esbuild([
  path.join(extensionRoot, "webview-ui", "src", "main.ts"),
  "--bundle",
  "--platform=browser",
  "--format=iife",
  "--target=es2022",
  `--outfile=${path.join(distRoot, "webview", "main.js")}`
]);

// Webview styles.
await esbuild([
  path.join(extensionRoot, "webview-ui", "src", "styles.css"),
  "--bundle",
  `--outfile=${path.join(distRoot, "webview", "main.css")}`
]);

// Task-review panel: browser IIFE + styles — a standalone editor-panel
// entry, contracts bundled in.
await esbuild([
  path.join(extensionRoot, "webview-ui", "src", "taskReview.ts"),
  "--bundle",
  "--platform=browser",
  "--format=iife",
  "--target=es2022",
  `--outfile=${path.join(distRoot, "webview", "taskReview.js")}`
]);
await esbuild([
  path.join(extensionRoot, "webview-ui", "src", "taskReview.css"),
  "--bundle",
  `--outfile=${path.join(distRoot, "webview", "taskReview.css")}`
]);

// Task-board panel: browser IIFE + styles. Same shape as the plan-docs
// pair — a standalone editor-panel entry, contracts bundled in.
await esbuild([
  path.join(extensionRoot, "webview-ui", "src", "taskBoard.ts"),
  "--bundle",
  "--platform=browser",
  "--format=iife",
  "--target=es2022",
  `--outfile=${path.join(distRoot, "webview", "taskBoard.js")}`
]);
await esbuild([
  path.join(extensionRoot, "webview-ui", "src", "taskBoard.css"),
  "--bundle",
  `--outfile=${path.join(distRoot, "webview", "taskBoard.css")}`
]);

// Planner panel: browser IIFE + styles. Same shape as the plan-docs pair —
// a standalone editor-panel entry, contracts bundled in.
await esbuild([
  path.join(extensionRoot, "webview-ui", "src", "planner.ts"),
  "--bundle",
  "--platform=browser",
  "--format=iife",
  "--target=es2022",
  `--outfile=${path.join(distRoot, "webview", "planner.js")}`
]);
await esbuild([
  path.join(extensionRoot, "webview-ui", "src", "planner.css"),
  "--bundle",
  `--outfile=${path.join(distRoot, "webview", "planner.css")}`
]);

// Agents panel (ADR 0013): browser IIFE + styles. Same shape as the other
// standalone editor-panel entries, contracts bundled in.
await esbuild([
  path.join(extensionRoot, "webview-ui", "src", "agents.ts"),
  "--bundle",
  "--platform=browser",
  "--format=iife",
  "--target=es2022",
  `--outfile=${path.join(distRoot, "webview", "agents.js")}`
]);
await esbuild([
  path.join(extensionRoot, "webview-ui", "src", "agents.css"),
  "--bundle",
  `--outfile=${path.join(distRoot, "webview", "agents.css")}`
]);

// Mermaid renderer: a separate, minified bundle the plan-docs webview injects
// lazily (nonce via data attribute) only when a document contains a diagram —
// keeping the ~MB parse cost out of every panel open.
await esbuild([
  path.join(extensionRoot, "webview-ui", "src", "planDocsMermaid.ts"),
  "--bundle",
  "--platform=browser",
  "--format=iife",
  "--target=es2022",
  "--minify",
  `--outfile=${path.join(distRoot, "webview", "planDocsMermaid.js")}`
]);

console.log(`Extension bundled into ${distRoot}`);

async function esbuild(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [esbuildBin, ...args], { cwd: root, windowsHide: true, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) resolve(undefined);
      else reject(new Error(`esbuild failed with exit ${String(exitCode)}`));
    });
  });
}
