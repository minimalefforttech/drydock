/**
 * Bundles the extension host entry and the control panel webview assets into
 * apps/vscode-extension/dist. Used by the F5 pre-launch task and by
 * package-vsix.mjs so the debugged artifact and the shipped artifact are
 * identical.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.join(root, "apps", "vscode-extension");
const distRoot = path.join(extensionRoot, "dist");
const browserOptions = { platform: "browser", format: "iife", target: "es2022" };

await mkdir(path.join(distRoot, "webview"), { recursive: true });

// Extension host bundle: self-contained except the vscode runtime module.
await bundle(
  path.join(extensionRoot, "src", "extension.ts"),
  path.join(distRoot, "extension.js"),
  { platform: "node", format: "esm", target: "node22", external: ["vscode"] }
);

// Task-review panel: browser IIFE + styles - a standalone editor-panel
// entry, contracts bundled in.
await bundle(
  path.join(extensionRoot, "webview-ui", "src", "taskReview.ts"),
  path.join(distRoot, "webview", "taskReview.js"),
  browserOptions
);
await bundle(
  path.join(extensionRoot, "webview-ui", "src", "taskReview.css"),
  path.join(distRoot, "webview", "taskReview.css")
);

// Code-review panel (in-panel PR-style review): browser IIFE + styles - a
// standalone editor-panel entry, contracts bundled in.
await bundle(
  path.join(extensionRoot, "webview-ui", "src", "codeReview.ts"),
  path.join(distRoot, "webview", "codeReview.js"),
  browserOptions
);
await bundle(
  path.join(extensionRoot, "webview-ui", "src", "codeReview.css"),
  path.join(distRoot, "webview", "codeReview.css")
);

// Task-board panel: browser IIFE + styles. Same shape as the plan-docs
// pair - a standalone editor-panel entry, contracts bundled in.
await bundle(
  path.join(extensionRoot, "webview-ui", "src", "taskBoard.ts"),
  path.join(distRoot, "webview", "taskBoard.js"),
  browserOptions
);
await bundle(
  path.join(extensionRoot, "webview-ui", "src", "taskBoard.css"),
  path.join(distRoot, "webview", "taskBoard.css")
);

// Planner panel: browser IIFE + styles. Same shape as the plan-docs pair -
// a standalone editor-panel entry, contracts bundled in.
await bundle(
  path.join(extensionRoot, "webview-ui", "src", "planner.ts"),
  path.join(distRoot, "webview", "planner.js"),
  browserOptions
);
await bundle(
  path.join(extensionRoot, "webview-ui", "src", "planner.css"),
  path.join(distRoot, "webview", "planner.css")
);

// Agents panel (ADR 0013): browser IIFE + styles. Same shape as the other
// standalone editor-panel entries, contracts bundled in.
await bundle(
  path.join(extensionRoot, "webview-ui", "src", "agents.ts"),
  path.join(distRoot, "webview", "agents.js"),
  browserOptions
);
await bundle(
  path.join(extensionRoot, "webview-ui", "src", "agents.css"),
  path.join(distRoot, "webview", "agents.css")
);

// Configure panel: browser IIFE + styles, own config.* dispatch.
await bundle(
  path.join(extensionRoot, "webview-ui", "src", "configure.ts"),
  path.join(distRoot, "webview", "configure.js"),
  browserOptions
);
await bundle(
  path.join(extensionRoot, "webview-ui", "src", "configure.css"),
  path.join(distRoot, "webview", "configure.css")
);

// Task hub (singleton editor panel for the active task): browser IIFE +
// styles, same shape as the other editor-panel pairs.
await bundle(
  path.join(extensionRoot, "webview-ui", "src", "taskHub.ts"),
  path.join(distRoot, "webview", "taskHub.js"),
  browserOptions
);
await bundle(
  path.join(extensionRoot, "webview-ui", "src", "taskHub.css"),
  path.join(distRoot, "webview", "taskHub.css")
);

// Left rail (tasks/recents/workspaces sidebar views): one shared bundle,
// mounted per-view via body[data-view].
await bundle(
  path.join(extensionRoot, "webview-ui", "src", "rail.ts"),
  path.join(distRoot, "webview", "rail.js"),
  browserOptions
);
await bundle(
  path.join(extensionRoot, "webview-ui", "src", "rail.css"),
  path.join(distRoot, "webview", "rail.css")
);

// Chat rail (sidebar chat view): browser IIFE + styles - the standalone host
// for the shared chat components, attached to the control-panel dispatch.
await bundle(
  path.join(extensionRoot, "webview-ui", "src", "chatRail.ts"),
  path.join(distRoot, "webview", "chatRail.js"),
  browserOptions
);
await bundle(
  path.join(extensionRoot, "webview-ui", "src", "chatRail.css"),
  path.join(distRoot, "webview", "chatRail.css")
);

// Mermaid renderer: a separate, minified bundle the plan-docs webview injects
// lazily (nonce via data attribute) only when a document contains a diagram -
// keeping the ~MB parse cost out of every panel open.
await bundle(
  path.join(extensionRoot, "webview-ui", "src", "planDocsMermaid.ts"),
  path.join(distRoot, "webview", "planDocsMermaid.js"),
  { ...browserOptions, minify: true }
);

console.log(`Extension bundled into ${distRoot}`);

async function bundle(entryPoint, outfile, options = {}) {
  await build({
    absWorkingDir: root,
    entryPoints: [entryPoint],
    bundle: true,
    outfile,
    logLevel: "info",
    ...options
  });
}
