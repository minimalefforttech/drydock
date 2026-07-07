/* Real-UI promo recorder.
 *
 * Captures the ACTUAL bundled control panel (rendered by the webview harness
 * with its mock host) running scripted workflows, composed into a landscape
 * frame with a caption (src/wrap.html), and encodes a looping GIF.
 *
 * Per scene: navigate to the wrapper, set its caption, then run a timeline of
 * steps (each drives the real panel via window.P inside the iframe) while
 * grabbing frames at a fixed cadence with CDP Page.captureScreenshot. Real
 * time in, real time out — this is genuine product footage, not a mock.
 *
 *   node docs/promo/record.mjs                 # all scenes
 *   node docs/promo/record.mjs session approvals
 *
 * Requires system Chrome (or CHROME=/path) and ffmpeg on PATH.
 */
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const harnessDir = path.join(repoRoot, "tools", "webview-harness");
const wrapSrc = path.join(here, "src", "wrap.html");
const wrapDest = path.join(harnessDir, "_promo_wrap.html");
const framesRoot = path.join(here, ".frames");
const CHROME = process.env.CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const HARNESS_PORT = 8972, CDP_PORT = 9224, W = 1160, H = 720;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Scene timelines. `js` runs in the wrapper's top frame; window.P drives
//     the real panel inside the iframe. `at` is ms from scene start. -----------
const SCENES = {
  session: {
    fps: 11, seconds: 12, panel: "index",
    caption: {
      kicker: "Contained sessions", label: "Drydock — Control Panel",
      title: "Coding agents, safely contained",
      desc: "Every chat runs in its own disposable runtime — Claude Code or Codex — that only touches what you approve.",
      points: [
        "Plan (read-only) or Develop (read-write), per turn",
        "Switch model or provider mid-session",
        "Restart the backend without losing the thread"
      ]
    },
    steps: [
      { at: 150, js: "P.selectSession('Add alembic support'); P.tab('Chat')" },
      // Panel auto-scrolls to the bottom on select (a strong opening frame:
      // approval card + open question), then we glide up through the whole
      // session — changes, subagent tree, diagram, code, the conversation.
      { at: 1600, js: "P.panScroll('.chat-scroll', 0, 9000)" }
    ]
  },

  approvals: {
    fps: 12, seconds: 10, panel: "index",
    caption: {
      kicker: "Blast-radius approvals", label: "Drydock — Control Panel",
      title: "You approve every path",
      desc: "Agents start default-denied. When one needs a file or a host path it asks — risk spelled out — and nothing happens until you allow it.",
      points: [
        "Risk-tiered cards; typed confirm for sensitive roots",
        "Credential roots denied by default",
        "A per-session ledger of what you granted"
      ]
    },
    steps: [
      { at: 150, js: "P.selectSession('Add alembic support'); P.tab('Chat')" },
      // Auto-scrolls to the pending 'Agent requests access' card. Allow it,
      // the pager advances to the next request; allow that too.
      { at: 2600, js: "P.clickText('button', 'Allow')" },
      { at: 5200, js: "P.clickText('button', 'Allow')" },
      { at: 7200, js: "P.panScroll('.chat-scroll', 0, 2400)" }
    ]
  },

  subagents: {
    fps: 12, seconds: 12, panel: "index",
    caption: {
      kicker: "Subagent fan-out", label: "Drydock — Control Panel",
      title: "Delegate, and watch every child",
      desc: "Native fan-outs render as a live hierarchy — each child agent's files, tools, tokens, and status, including the ones that fail.",
      points: [
        "Researcher / worker / tester / reviewer roles",
        "Child mounts are always a subset of the parent's",
        "Per-agent files, tools, and token usage"
      ]
    },
    steps: [
      { at: 150, js: "P.selectSession('Add alembic support'); P.tab('Chat')" },
      // Fire a live fan-out: the agent spawns two subagents, one nests a
      // grandchild, one fails — all streaming into the transcript. Then glide
      // up through the resulting hierarchy.
      { at: 900, js: "P.scenario.fanOut('s-live')" },
      { at: 3400, js: "P.panScroll('.chat-scroll', 0, 7600)" }
    ]
  }
};

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { windowsHide: true, ...opts });
    let err = "";
    c.stderr?.on("data", (d) => { err += d; });
    c.on("error", reject);
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exit ${code}: ${err.slice(-300)}`))));
  });
}

async function cdpConnect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(150);
  }
  throw new Error("no CDP page target");
}

const scenes = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENES);

await copyFile(wrapSrc, wrapDest);
await mkdir(framesRoot, { recursive: true });
const harness = spawn(process.execPath, [path.join(harnessDir, "server.mjs")], {
  windowsHide: true, env: { ...process.env, PORT: String(HARNESS_PORT) }
});
await sleep(700);
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  `--remote-debugging-port=${CDP_PORT}`, `--window-size=${W},${H}`,
  "--force-device-scale-factor=2",
  `--user-data-dir=${path.join(os.tmpdir(), "promo-rec-profile")}`,
  "--no-first-run", "--no-default-browser-check", "about:blank"
], { windowsHide: true });

let ws, msgId = 0;
const pending = new Map();
const cmd = (method, params = {}) => {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res) => pending.set(id, res));
};
const evaluate = (expression) => cmd("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });

try {
  const url = await cdpConnect();
  ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  await cmd("Page.enable");
  await cmd("Runtime.enable");

  for (const name of scenes) {
    const scene = SCENES[name];
    if (!scene) { console.log(`skip ${name} (no timeline)`); continue; }
    const fdir = path.join(framesRoot, name);
    await rm(fdir, { recursive: true, force: true });
    await mkdir(fdir, { recursive: true });

    await cmd("Page.navigate", { url: `http://localhost:${HARNESS_PORT}/_promo_wrap.html?panel=${scene.panel}` });
    // Wait for the panel iframe to boot.
    for (let i = 0; i < 40; i++) { const r = await evaluate("!!window.__panelReady"); if (r?.result?.value) break; await sleep(150); }
    await sleep(1600);
    await evaluate(`window.setCaption(${JSON.stringify(scene.caption)})`);
    await sleep(200);

    const interval = 1000 / scene.fps, total = Math.round(scene.fps * scene.seconds);
    const steps = [...scene.steps].sort((a, b) => a.at - b.at);
    let fired = 0;
    const t0 = Date.now();
    for (let i = 0; i < total; i++) {
      const elapsed = Date.now() - t0;
      while (fired < steps.length && steps[fired].at <= elapsed) { await evaluate(steps[fired].js); fired++; }
      const shot = await cmd("Page.captureScreenshot", { format: "jpeg", quality: 84 });
      await writeFile(path.join(fdir, `f${String(i).padStart(4, "0")}.jpg`), Buffer.from(shot.data, "base64"));
      const waitMs = (i + 1) * interval - (Date.now() - t0);
      if (waitMs > 0) await sleep(waitMs);
    }
    while (fired < steps.length) { await evaluate(steps[fired].js); fired++; }

    const gif = path.join(here, `core-${name}.gif`);
    await run("ffmpeg", [
      "-y", "-framerate", String(scene.fps), "-i", path.join(fdir, "f%04d.jpg"),
      "-vf", `scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5`,
      "-loop", "0", gif
    ]);
    const kb = Math.round((await import("node:fs")).statSync(gif).size / 1024);
    console.log(`✓ core-${name}.gif  ${W}×${H}  ${total}f@${scene.fps}fps  ${kb} KB`);
  }
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  harness.kill();
  if (existsSync(wrapDest)) await rm(wrapDest, { force: true });
}
console.log("done");
