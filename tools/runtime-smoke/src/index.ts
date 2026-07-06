#!/usr/bin/env node

/**
 * Runtime integration smoke CLI.
 *
 * Runs one Codex prompt inside one Docker Sandbox runtime, records normalized
 * events to SQLite, proves replay after reopening storage, and cleans up.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CodexAdapter, CodexAppServerTransport } from "@drydock/agent-adapters";
import { TempWorkspaceStore } from "@drydock/artifacts";
import {
  buildIsolatedRunTemplate,
  ConsoleLogger,
  RandomIdGenerator,
  RuntimeCleanupService,
  RuntimeLifecycleService,
  SpawnCommandRunner,
  IsolatedRunWorkflow,
  SystemClock
} from "@drydock/core";
import { discoverDockerSandboxCommand, discoverStandaloneCodexCommand, DockerSandboxRuntimeAdapter } from "@drydock/runtime-adapters";
import {
  applyMigrations,
  SqliteConnection,
  SqliteEventStore,
  SqliteRuntimeInventoryStore
} from "@drydock/storage-sqlite";

interface SmokeOptions {
  readonly prompt: string;
  readonly keepRuntime: boolean;
  readonly appServerTurn: boolean;
  readonly skipAppServer: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const sbxPath = discoverDockerSandboxCommand();
  if (!sbxPath) {
    throw new Error("Docker Sandbox `sbx` was not found. Runtime smoke cannot run.");
  }

  const smokeRoot = path.join(root, ".tmp", "runtime-smoke");
  await mkdir(smokeRoot, { recursive: true });
  const dbPath = path.join(smokeRoot, "smoke.sqlite");
  const logger = new ConsoleLogger();
  const ids = new RandomIdGenerator();
  const clock = new SystemClock();
  const commandRunner = new SpawnCommandRunner();
  const connection = new SqliteConnection(dbPath);
  applyMigrations(connection);
  const inventory = new SqliteRuntimeInventoryStore(connection);
  const eventStore = new SqliteEventStore(connection);
  const runtimeAdapter = new DockerSandboxRuntimeAdapter({
    sbxPath,
    commandRunner,
    cwd: root,
    logger
  });
  const lifecycle = new RuntimeLifecycleService({ clock, inventory, runtimeAdapter, logger });
  const cleanup = new RuntimeCleanupService({ clock, inventory, runtimeAdapter, logger });
  const hostCodexPath = discoverStandaloneCodexCommand();
  const agent = new CodexAdapter({
    ids,
    clock,
    logger,
    runtimeExecutor: runtimeAdapter,
    commandRunner,
    ...(hostCodexPath === null ? {} : { hostCodexPath })
  });
  const workflow = new IsolatedRunWorkflow({ ids, logger, lifecycle, cleanup, agentAdapter: agent, eventStore });
  const workspaceStore = new TempWorkspaceStore(path.join(smokeRoot, "workspaces"));
  const workspace = await workspaceStore.createWorkspace("run");
  await writeFile(path.join(workspace.workspacePath, "README.md"), "# Runtime smoke workspace\n", "utf8");
  const template = buildIsolatedRunTemplate({
    workspacePath: workspace.workspacePath,
    ids,
    approvedAt: clock.isoNow()
  });

  const result = await workflow.runOnePrompt({
    prompt: options.prompt,
    workspacePath: workspace.workspacePath,
    template,
    keepRuntime: true
  });

  let appServerStatus = "skipped";
  let appServerDiagnostics: readonly string[] = [];
  let appServerError: string | undefined;
  if (!options.skipAppServer) {
    const appServer = new CodexAppServerTransport({
      command: sbxPath,
      argsForRuntime: (runtime) => ["exec", runtime.externalName],
      cwd: root
    });
    const appServerProbe = await appServer.probe(
      result.runtime,
      options.appServerTurn ? "Reply exactly app-server-ok." : undefined
    );
    appServerStatus = appServerProbe.status;
    appServerDiagnostics = appServerProbe.diagnostics;
    appServerError = appServerProbe.error?.message;
  }

  let cleanupStatus: "removed" | "kept" | "failed" = "kept";
  let cleanupDiagnostics: readonly string[] = [];
  if (!options.keepRuntime) {
    const cleanupResult = await cleanup.cleanupRuntime(result.runtime.runtimeId, "graceful");
    cleanupStatus = cleanupResult.status === "removed" ? "removed" : "failed";
    cleanupDiagnostics = cleanupResult.diagnostics;
  }

  const persistedBeforeClose = await eventStore.listEvents(result.sessionId);
  connection.close();
  const reopened = new SqliteConnection(dbPath);
  applyMigrations(reopened);
  const replayed = await new SqliteEventStore(reopened).listEvents(result.sessionId);
  const replayOk = replayed.length === persistedBeforeClose.length && replayed.length > 0;
  reopened.close();

  const report = {
    generatedAt: clock.isoNow(),
    sessionId: result.sessionId,
    runtimeName: result.runtime.externalName,
    workspacePath: workspace.workspacePath,
    eventCount: result.events.length,
    persistedEventCount: replayed.length,
    replayOk,
    cleanupStatus,
    cleanupDiagnostics,
    appServerStatus,
    ...(appServerError === undefined ? {} : { appServerError }),
    appServerDiagnostics
  };
  const reportPath = path.join(smokeRoot, "runtime-smoke-report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));

  const appServerBlockedWithDiagnostics = appServerStatus === "blocked" && appServerDiagnostics.length > 0;
  if (!replayOk || cleanupStatus === "failed" || (appServerStatus === "blocked" && !appServerBlockedWithDiagnostics)) {
    process.exitCode = 1;
  }
}

function parseArgs(args: readonly string[]): SmokeOptions {
  let prompt = "Create smoke-result.txt containing exactly DRYDOCK_SMOKE_OK, then say smoke-ok.";
  let keepRuntime = false;
  let appServerTurn = false;
  let skipAppServer = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--prompt") {
      const value = args[index + 1];
      if (!value) throw new Error("--prompt requires a value.");
      prompt = value;
      index += 1;
    } else if (arg === "--keep-runtime") {
      keepRuntime = true;
    } else if (arg === "--app-server-turn") {
      appServerTurn = true;
    } else if (arg === "--skip-app-server") {
      skipAppServer = true;
    } else if (arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg ?? ""}`);
    }
  }
  return { prompt, keepRuntime, appServerTurn, skipAppServer };
}

function printHelp(): void {
  console.log(`
Usage: npm run smoke -- [options]

Options:
  --prompt <text>       Prompt to run inside the sandboxed Codex runtime.
  --app-server-turn     Also send a tiny prompt through Codex app-server.
  --skip-app-server     Skip app-server initialization/session probe.
  --keep-runtime        Leave the sandbox running for manual inspection.
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
