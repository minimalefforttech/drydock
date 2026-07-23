/**
 * Unit tests for the guided connect flows: URL scraping and browser opening,
 * paste-back code relay, token capture into the sbx secret ledger, API key
 * routing, and secret hygiene in progress events.
 */

import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ProviderConnectService, type ProviderAuthProgress } from "./providerConnectService.js";

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = {
    written: [] as string[],
    ended: false,
    write(chunk: string): boolean {
      this.written.push(chunk);
      return true;
    },
    end(): void {
      this.ended = true;
    }
  };
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

interface SpawnRecord {
  readonly command: string;
  readonly args: readonly string[];
  readonly child: FakeChild;
}

function makeHarness(options?: { hostClaudePath?: string; authStatus?: "authenticated" | "needs-login" }) {
  const spawns: SpawnRecord[] = [];
  const progress: ProviderAuthProgress[] = [];
  const opened: string[] = [];
  const stored = new Map<string, string>();
  const service = new ProviderConnectService({
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    sbxPath: "sbx.exe",
    ...(options?.hostClaudePath === undefined ? {} : { hostClaudePath: options.hostClaudePath }),
    environment: {},
    providerSecrets: {
      has: async (id) => stored.has(id),
      get: async (id) => stored.get(id),
      set: async (id, value) => {
        stored.set(id, value);
      },
      delete: async (id) => {
        stored.delete(id);
      }
    },
    assertInteractiveSetupAllowed: () => undefined,
    openExternal: (url) => {
      opened.push(url);
    },
    refreshAuthStatus: async () => options?.authStatus ?? "authenticated",
    onProgress: (event) => progress.push(event),
    spawnProcess: ((command: string, args: readonly string[]) => {
      const child = new FakeChild();
      spawns.push({ command, args, child });
      return child;
    }) as never,
    browserOpenDelayMs: 1,
    flowTimeoutMs: 5_000
  });
  return { service, spawns, progress, opened, stored };
}

test("codex guided flow: URL is surfaced and opened, exit verifies to connected", async () => {
  const { service, spawns, progress, opened } = makeHarness();

  const begun = service.begin("codex");
  assert.equal(begun.mode, "guided");
  assert.deepEqual(spawns[0]?.args, ["secret", "set", "-g", "openai", "--oauth"]);

  spawns[0]?.child.stdout.emit("data", Buffer.from("Open https://auth.openai.com/authorize?x=1 to continue\n"));
  await delay(10);
  assert.equal(opened[0], "https://auth.openai.com/authorize?x=1");
  assert.ok(progress.some((event) => event.phase === "browser-opened" && event.detail?.includes("auth.openai.com")));

  spawns[0]?.child.emit("close", 0);
  await delay(10);
  assert.deepEqual(progress.map((event) => event.phase).slice(-2), ["verifying", "connected"]);
});

test("claude guided flow: paste-back code relays to stdin, token lands in sbx secret set, never in progress", async () => {
  const { service, spawns, progress } = makeHarness({ hostClaudePath: "claude.exe" });

  const begun = service.begin("claude");
  assert.equal(begun.mode, "guided");
  assert.equal(spawns[0]?.command, "claude.exe");
  assert.deepEqual(spawns[0]?.args, ["setup-token"]);

  spawns[0]?.child.stdout.emit("data", Buffer.from("Visit https://claude.ai/oauth/authorize?code=1\nPaste code here if prompted:\n"));
  await delay(5);
  assert.ok(progress.some((event) => event.phase === "awaiting-code"));

  assert.equal(service.submitCode("claude", "ac_1234567890#state"), true);
  assert.equal(spawns[0]?.child.stdin.written[0], "ac_1234567890#state\n");

  const token = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz123456";
  spawns[0]?.child.stdout.emit("data", Buffer.from(`Your token: ${token}\n`));
  spawns[0]?.child.emit("close", 0);
  await delay(10);

  // The token was piped into `sbx secret set -g anthropic` over stdin.
  assert.deepEqual(spawns[1]?.args, ["secret", "set", "-g", "anthropic"]);
  spawns[1]?.child.emit("close", 0);
  await delay(10);
  assert.equal(spawns[1]?.child.stdin.written[0], token);
  assert.equal(spawns[1]?.child.stdin.ended, true);
  assert.equal(progress.map((event) => event.phase).at(-1), "connected");
  // Secret hygiene: no progress detail ever carries the token.
  for (const event of progress) {
    assert.doesNotMatch(event.detail ?? "", /sk-ant/);
  }
});

test("claude without a host CLI falls back to the terminal flow", () => {
  const { service, spawns } = makeHarness();
  const begun = service.begin("claude");
  assert.equal(begun.mode, "terminal");
  assert.equal(spawns.length, 0);
});

test("api keys route to the sbx service secret or VS Code SecretStorage by descriptor", async () => {
  const { service, spawns, stored } = makeHarness();

  const openrouterStatus = service.submitApiKey("openrouter", " or-key-123 ");
  await delay(5);
  assert.deepEqual(spawns[0]?.args, ["secret", "set", "-g", "openrouter"]);
  spawns[0]?.child.emit("close", 0);
  assert.equal(await openrouterStatus, "authenticated");
  assert.equal(spawns[0]?.child.stdin.written[0], "or-key-123");
  assert.equal(stored.has("openrouter"), false);

  assert.equal(await service.submitApiKey("deepseek", "ds-key-456"), "authenticated");
  assert.equal(stored.get("deepseek"), "ds-key-456");
  assert.equal(spawns.length, 1);
});

test("a failing guided flow reports a scrubbed failure and cancel kills the child", async () => {
  const { service, spawns, progress } = makeHarness();

  service.begin("codex");
  spawns[0]?.child.stderr.emit("data", Buffer.from("fatal: token sk-live-abcdefghij was rejected\n"));
  spawns[0]?.child.emit("close", 1);
  await delay(5);
  const failure = progress.find((event) => event.phase === "failed");
  assert.ok(failure);
  assert.doesNotMatch(failure.detail ?? "", /sk-live/);
  assert.match(failure.detail ?? "", /\[redacted\]/);

  service.begin("codex");
  const second = spawns[1]?.child;
  assert.ok(second);
  assert.equal(service.cancel("codex"), true);
  assert.equal(second.killed, true);
});
