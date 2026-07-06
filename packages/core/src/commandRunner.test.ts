/**
 * Unit tests for structured command execution behavior.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { SpawnCommandRunner } from "./commandRunner.js";

test("SpawnCommandRunner observes complete stdout lines", async () => {
  const runner = new SpawnCommandRunner();
  const lines: string[] = [];
  const result = await runner.run(process.execPath, ["-e", "console.log('alpha'); console.log('beta');"], {
    cwd: process.cwd(),
    timeoutMs: 10_000,
    onStdoutLine: (line) => lines.push(line)
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(lines, ["alpha", "beta"]);
});

test("SpawnCommandRunner aborts a running child process", async () => {
  const runner = new SpawnCommandRunner();
  const controller = new AbortController();
  const running = runner.run(process.execPath, ["-e", "setTimeout(() => {}, 10000);"], {
    cwd: process.cwd(),
    timeoutMs: 20_000,
    signal: controller.signal
  });
  controller.abort();
  const result = await running;

  assert.equal(result.timedOut, false);
  assert.equal(result.error, "Aborted");
});
