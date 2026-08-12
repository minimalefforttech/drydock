/** `.drydock/mcp.json` overlay diagnostics and validation tests (UX overhaul P6). */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryLogger } from "@drydock/core";
import { createMcpProjectOverlayReader, type McpProjectServer } from "./mcpProjectOverlay.js";

async function withOverlay(
  contents: string,
  run: (read: () => Promise<readonly McpProjectServer[]>, logger: MemoryLogger, root: string) => Promise<void>,
  isWorkspaceTrusted: () => boolean = () => true
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "drydock-mcp-overlay-"));
  try {
    await mkdir(path.join(root, ".drydock"), { recursive: true });
    await writeFile(path.join(root, ".drydock", "mcp.json"), contents, "utf8");
    const logger = new MemoryLogger();
    await run(createMcpProjectOverlayReader(() => [root], logger, isWorkspaceTrusted), logger, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("untrusted workspaces cannot contribute repository-controlled MCP commands", async () => {
  await withOverlay(JSON.stringify({
    mcpServers: { evil: { command: "curl", args: ["http://example.test"] } }
  }), async (read, logger) => {
    assert.deepEqual(await read(), []);
    assert.deepEqual(logger.entries, []);
  }, () => false);
});

test("valid project servers parse read-only with overlay ids and no env values", async () => {
  await withOverlay(JSON.stringify({
    mcpServers: {
      "Studio Docs": {
        command: "npx",
        args: ["-y", "docs-mcp"],
        env: { DOCS_ROOT: "./docs", DOCS_TOKEN: "super-secret" }
      }
    }
  }), async (read, logger, root) => {
    const rows = await read();
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.ok(row);
    assert.equal(row.serverId, "overlay:studio-docs");
    assert.equal(row.name, "Studio Docs");
    assert.equal(row.command, "npx");
    assert.deepEqual(row.args, ["-y", "docs-mcp"]);
    // Key names only: an env VALUE must never leave the host through this reader.
    assert.deepEqual(row.envKeys, ["DOCS_ROOT", "DOCS_TOKEN"]);
    assert.equal(JSON.stringify(row).includes("super-secret"), false);
    assert.equal(row.filePath, path.join(root, ".drydock", "mcp.json"));
    assert.deepEqual(logger.entries, []);
  });
});

test("a missing overlay file is silent; malformed JSON and a bad root are diagnosed", async () => {
  const emptyRoot = await mkdtemp(path.join(os.tmpdir(), "drydock-mcp-none-"));
  try {
    const logger = new MemoryLogger();
    assert.deepEqual(await createMcpProjectOverlayReader(() => [emptyRoot], logger, () => true)(), []);
    assert.deepEqual(logger.entries, []);
  } finally {
    await rm(emptyRoot, { recursive: true, force: true });
  }

  await withOverlay("{broken", async (read, logger) => {
    assert.deepEqual(await read(), []);
    assert.equal(logger.entries[0]?.message, "mcp overlay JSON could not be parsed");
    assert.equal(typeof logger.entries[0]?.data?.["filePath"], "string");
  });

  await withOverlay(JSON.stringify([{ command: "npx" }]), async (read, logger) => {
    assert.deepEqual(await read(), []);
    assert.equal(logger.entries[0]?.message, "mcp overlay root must be an object with mcpServers");
  });

  await withOverlay(JSON.stringify({ servers: {} }), async (read, logger) => {
    assert.deepEqual(await read(), []);
    assert.equal(logger.entries[0]?.message, "mcp overlay root must be an object with mcpServers");
  });
});

test("an invalid entry is skipped as a whole while its siblings still load", async () => {
  await withOverlay(JSON.stringify({
    mcpServers: {
      good: { command: "npx", args: ["-y", "good-mcp"] },
      missingCommand: { args: ["-y"] },
      badArgs: { command: "npx", args: ["-y", 42] },
      badEnv: { command: "npx", env: { KEY: 7 } }
    }
  }), async (read, logger) => {
    const rows = await read();
    assert.deepEqual(rows.map((row) => row.name), ["good"]);
    const skipped = logger.entries.filter((entry) => entry.message === "invalid mcp overlay entry skipped");
    assert.equal(skipped.length, 3);
    assert.match(JSON.stringify(skipped.map((entry) => entry.data?.["issues"])), /command must be a non-empty string/);
    assert.match(JSON.stringify(skipped.map((entry) => entry.data?.["issues"])), /args must contain only strings/);
    assert.match(JSON.stringify(skipped.map((entry) => entry.data?.["issues"])), /env values must be strings/);
  });
});

test("the first folder wins a duplicate name and the collision is diagnosed", async () => {
  const rootA = await mkdtemp(path.join(os.tmpdir(), "drydock-mcp-a-"));
  const rootB = await mkdtemp(path.join(os.tmpdir(), "drydock-mcp-b-"));
  try {
    for (const [root, command] of [[rootA, "first"], [rootB, "second"]] as const) {
      await mkdir(path.join(root, ".drydock"), { recursive: true });
      await writeFile(
        path.join(root, ".drydock", "mcp.json"),
        JSON.stringify({ mcpServers: { docs: { command } } }),
        "utf8"
      );
    }
    const logger = new MemoryLogger();
    const rows = await createMcpProjectOverlayReader(() => [rootA, rootB], logger, () => true)();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.command, "first");
    assert.ok(logger.entries.some((entry) => entry.message === "duplicate mcp overlay server ignored"));
  } finally {
    await Promise.all([
      rm(rootA, { recursive: true, force: true }),
      rm(rootB, { recursive: true, force: true })
    ]);
  }
});
