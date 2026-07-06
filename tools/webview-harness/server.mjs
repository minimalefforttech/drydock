/**
 * Static server for the webview visual-test harness.
 *
 * Serves the harness shell (index.html + harness.js) plus the REAL bundled
 * webview assets from apps/vscode-extension/dist/webview under /assets/*, so
 * what renders in a browser is byte-identical to what ships in the VSIX. The
 * harness mocks only the host side of the message protocol — never the UI.
 * Run `npm run bundle` in apps/vscode-extension before starting.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const harnessDir = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.resolve(harnessDir, "..", "..", "apps", "vscode-extension", "dist", "webview");
const port = Number(process.env.PORT ?? 8971);

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".map", "application/json; charset=utf-8"]
]);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${String(port)}`);
    let filePath;
    if (url.pathname === "/" || url.pathname === "/index.html") {
      filePath = path.join(harnessDir, "index.html");
    } else if (url.pathname.startsWith("/assets/")) {
      const name = path.basename(url.pathname);
      filePath = path.join(assetsDir, name);
    } else {
      const name = path.basename(url.pathname);
      filePath = path.join(harnessDir, name);
    }
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": CONTENT_TYPES.get(path.extname(filePath)) ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
});

server.listen(port, () => {
  console.log(`webview harness on http://localhost:${String(port)} (assets: ${assetsDir})`);
});
