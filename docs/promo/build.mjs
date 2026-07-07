/* Promo GIF builder.
 *
 * For each scene: render K deterministic keyframes by reloading
 * src/<scene>.html?f=<i>&K=<K> in headless Chrome (2x device scale for crisp
 * text), one PNG per frame, then encode a looping GIF with ffmpeg using a
 * per-clip generated palette. Deterministic in, deterministic out.
 *
 *   node docs/promo/build.mjs            # build every scene with a source file
 *   node docs/promo/build.mjs drag cascade
 *
 * Requires: system Chrome (or set CHROME=/path), ffmpeg on PATH.
 */
import { spawn } from "node:child_process";
import { mkdir, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, "src");
const outDir = here;
const framesRoot = path.join(here, ".frames");

const CHROME = process.env.CHROME || (
  process.platform === "win32"
    ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    : "google-chrome"
);
const CONCURRENCY = 4;

// name → capture spec. width/height are the scene's canonical stage size.
const SCENES = {
  drag:    { w: 960, h: 540, k: 40, fps: 16 },
  depend:  { w: 960, h: 540, k: 46, fps: 16 },
  cascade: { w: 960, h: 540, k: 52, fps: 16 },
  unblock: { w: 820, h: 470, k: 40, fps: 16 },
  memory:  { w: 900, h: 520, k: 42, fps: 15 }
};

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { windowsHide: true });
    let err = "";
    c.stderr.on("data", (d) => { err += d; });
    c.on("error", reject);
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exit ${code}: ${err.slice(-400)}`))));
  });
}

async function captureFrame(scene, spec, i, worker) {
  const url = `file:///${path.join(srcDir, `${scene}.html`).replace(/\\/g, "/")}?f=${i}&K=${spec.k}`;
  const out = path.join(framesRoot, scene, `f${String(i).padStart(3, "0")}.png`);
  await run(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--force-device-scale-factor=2",
    `--window-size=${spec.w},${spec.h}`,
    `--user-data-dir=${path.join(os.tmpdir(), `promo-c${worker}`)}`,
    "--no-first-run", "--no-default-browser-check",
    "--virtual-time-budget=900",
    `--screenshot=${out}`,
    url
  ]);
}

async function buildScene(scene) {
  const spec = SCENES[scene];
  if (!spec) throw new Error(`unknown scene ${scene}`);
  if (!existsSync(path.join(srcDir, `${scene}.html`))) {
    console.log(`skip ${scene} (no src/${scene}.html)`);
    return;
  }
  const fdir = path.join(framesRoot, scene);
  await rm(fdir, { recursive: true, force: true });
  await mkdir(fdir, { recursive: true });

  // Capture K frames with a small worker pool.
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async (_, w) => {
    for (;;) {
      const i = next++;
      if (i >= spec.k) break;
      await captureFrame(scene, spec, i, w);
    }
  }));

  const frames = (await readdir(fdir)).filter((f) => f.endsWith(".png"));
  if (frames.length !== spec.k) throw new Error(`${scene}: expected ${spec.k} frames, got ${frames.length}`);

  const gif = path.join(outDir, `${scene}.gif`);
  await run("ffmpeg", [
    "-y", "-framerate", String(spec.fps),
    "-i", path.join(fdir, "f%03d.png"),
    "-vf", `scale=${spec.w}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`,
    "-loop", "0", gif
  ]);
  const sz = (await stat(gif)).size;
  console.log(`✓ ${scene}.gif  ${spec.w}×${spec.h}  ${spec.k}f@${spec.fps}fps  ${(sz / 1024).toFixed(0)} KB`);
}

const requested = process.argv.slice(2);
const scenes = requested.length ? requested : Object.keys(SCENES);
await mkdir(framesRoot, { recursive: true });
for (const s of scenes) await buildScene(s);
console.log("done");
