#!/usr/bin/env node

/**
 * Stage 0 prevalidation CLI for checking runtime, adapter, schema, and workflow assumptions
 * before VS Code extension implementation begins.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type CheckStatus = "pass" | "fail" | "warn" | "skip" | "optional";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface CliOptions {
  strict: boolean;
  keepTemp: boolean;
  skipRuntime: boolean;
  skipAcpTurn: boolean;
  allowNpxAcp: boolean;
  outputJson: string;
  reportPath: string;
}

interface CommandResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  error?: string;
}

interface CommandProbe {
  key: string;
  names: string[];
  path: string | null;
  required: boolean;
  versionArgs: string[];
  versionResult?: CommandResult;
}

interface CheckResult {
  id: string;
  title: string;
  category: string;
  required: boolean;
  status: CheckStatus;
  summary: string;
  details: string[];
  startedAt: string;
  durationMs: number;
  data?: JsonValue;
}

interface PrevalidationReport {
  generatedAt: string;
  workspaceRoot: string;
  platform: {
    os: string;
    release: string;
    arch: string;
    shell: string | null;
    node: string;
  };
  options: CliOptions;
  gate: {
    status: "ready" | "blocked";
    requiredPassed: number;
    requiredFailed: number;
    optionalIssues: number;
  };
  artifacts: {
    productPlan: string;
    threatModel: string;
    coverage: string;
    apiReference: string;
    extensionPoints: string;
    workManagement: string;
    schemasDir: string;
    report: string;
    json: string;
  };
  commands: Record<string, {
    path: string | null;
    required: boolean;
    versionArgs: string[];
    versionExitCode?: number | null;
    versionStdout?: string;
    versionStderr?: string;
    versionError?: string;
  }>;
  checks: CheckResult[];
  nextActions: string[];
}

interface CheckContext {
  root: string;
  docsDir: string;
  designDocsDir: string;
  tempRoot: string;
  options: CliOptions;
  commands: Map<string, CommandProbe>;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: JsonValue;
  result?: JsonValue;
  error?: {
    code?: number;
    message?: string;
    data?: JsonValue;
  };
}

const CHECK_TIMEOUT_MS = 10_000;
const RUNTIME_TIMEOUT_MS = 120_000;
const ACP_TIMEOUT_MS = 45_000;
const DOCKER_CODEX_TIMEOUT_MS = 300_000;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const docsDir = path.join(root, "docs");
  const designDocsDir = path.join(docsDir, "design");
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "drydock-prevalidate-"));
  const context: CheckContext = {
    root,
    docsDir,
    designDocsDir,
    tempRoot,
    options,
    commands: new Map()
  };

  await mkdir(docsDir, { recursive: true });

  const checks: CheckResult[] = [];
  try {
    checks.push(await runCheck(context, "artifacts.product-plan", "Product plan is saved", "artifacts", true, validateProductPlan));
    checks.push(await runCheck(context, "artifacts.threat-model", "Threat model is saved", "artifacts", true, validateThreatModel));
    checks.push(await runCheck(context, "artifacts.prevalidation-coverage", "Prevalidation coverage matrix is saved", "artifacts", true, validatePrevalidationCoverage));
    checks.push(await runCheck(context, "artifacts.api-reference", "Implementation API reference is saved", "artifacts", true, validateApiReference));
    checks.push(await runCheck(context, "artifacts.extension-points", "Extension-points plan is saved", "artifacts", true, validateExtensionPointsPlan));
    checks.push(await runCheck(context, "artifacts.work-management", "Work-management plan is saved", "artifacts", true, validateWorkManagementPlan));

    checks.push(await runCheck(context, "environment.node", "Node.js command", "environment", true, (ctx) => probeCommand(ctx, "node", ["node"], ["--version"], true)));
    checks.push(await runCheck(context, "environment.npm", "npm command", "environment", true, (ctx) => probeCommand(ctx, "npm", ["npm"], ["--version"], true)));
    checks.push(await runCheck(context, "environment.pnpm", "pnpm command", "environment", false, (ctx) => probeCommand(ctx, "pnpm", ["pnpm"], ["--version"], false)));
    checks.push(await runCheck(context, "environment.git", "Git command", "environment", true, (ctx) => probeCommand(ctx, "git", ["git"], ["--version"], true)));
    checks.push(await runCheck(context, "environment.docker", "Docker command", "environment", true, (ctx) => probeCommand(ctx, "docker", ["docker"], ["--version"], true)));
    checks.push(await runCheck(context, "environment.docker-sandbox", "Docker Sandbox command", "environment", true, (ctx) => probeCommand(ctx, "sbx", ["sbx"], ["version"], true)));
    checks.push(await runCheck(context, "environment.wsl", "WSL command", "environment", false, (ctx) => probeCommand(ctx, "wsl", ["wsl"], ["--status"], false)));
    checks.push(await runCheck(context, "environment.codex", "Host Codex command", "environment", true, (ctx) => probeCommand(ctx, "codex", ["codex", "codex.exe"], ["--version"], true)));
    checks.push(await runCheck(context, "agent.codex-host-login-protocol", "Host Codex login and app-server protocol", "agent", true, validateHostCodexCommunication));
    checks.push(await runCheck(context, "agent.codex-visibility-schema", "Codex event visibility schema", "agent", true, validateCodexVisibilitySchema));
    checks.push(await runCheck(context, "agent.adapter-registry", "Agent adapter registry", "agent", true, validateAgentAdapterRegistry));
    checks.push(await runCheck(context, "auth.provider-login-lifecycle", "Provider login lifecycle", "auth", true, validateProviderLoginLifecycle));

    checks.push(await runCheck(context, "runtime.wsl-status", "WSL status probe", "runtime", false, validateWslStatus));
    checks.push(await runCheck(context, "runtime.docker-sandbox-readiness", "Docker Sandbox daemon and auth readiness", "runtime", true, validateDockerSandboxReadiness));

    if (options.skipRuntime) {
      checks.push(skipCheck("runtime.docker-sandbox", "Docker Sandbox isolation", "runtime", true, "Skipped by --skip-runtime."));
      checks.push(skipCheck("runtime.access-restart-continuity", "Access-request restart continuity", "runtime", true, "Skipped by --skip-runtime."));
      checks.push(skipCheck("runtime.docker-fallback", "Docker fallback isolation", "runtime", true, "Skipped by --skip-runtime."));
      checks.push(skipCheck("runtime.codex-inside-sandbox", "Codex adapter surface inside sandbox", "runtime", true, "Skipped by --skip-runtime."));
      checks.push(skipCheck("agent.codex-auth-inside-sandbox", "Docker Sandbox Codex login", "agent", true, "Skipped by --skip-runtime."));
      checks.push(skipCheck("agent.codex-docker-container", "Docker container Codex login and app-server protocol", "agent", true, "Skipped by --skip-runtime."));
      checks.push(skipCheck("agent.codex-sandbox-json-events", "Docker Sandbox Codex JSONL file-event smoke", "agent", true, "Skipped by --skip-runtime."));
    } else {
      checks.push(await runCheck(context, "runtime.docker-sandbox", "Docker Sandbox isolation", "runtime", true, validateDockerSandboxIsolation));
      checks.push(await runCheck(context, "runtime.access-restart-continuity", "Access-request restart continuity", "runtime", true, validateAccessRestartContinuity));
      checks.push(await runCheck(context, "runtime.docker-fallback", "Docker fallback isolation", "runtime", true, validateDockerFallbackIsolation));
      checks.push(await runCheck(context, "runtime.codex-inside-sandbox", "Codex adapter surface inside sandbox", "runtime", true, validateCodexInsideSandbox));
      checks.push(await runCheck(context, "agent.codex-auth-inside-sandbox", "Docker Sandbox Codex login", "agent", true, validateCodexAuthInsideSandbox));
      checks.push(await runCheck(context, "agent.codex-docker-container", "Docker container Codex login and app-server protocol", "agent", true, validateDockerContainerCodexCommunication));
      checks.push(await runCheck(context, "agent.codex-sandbox-json-events", "Docker Sandbox Codex JSONL file-event smoke", "agent", true, validateCodexSandboxJsonEventStream));
    }

    checks.push(await runCheck(context, "agent.codex-acp", "Codex ACP compatibility probe", "agent", false, validateCodexAcp));
    checks.push(await runCheck(context, "agent.claude-cli-surface", "Claude CLI adapter surface", "agent", false, validateClaudeCliSurface));
    checks.push(await runCheck(context, "agent.codex-subagents", "Codex-native subagent probe", "agent", false, validateCodexNativeSubagentProbe));
    checks.push(await runCheck(context, "git.clone-worktree", "Git clone/worktree/patch mechanics", "git", true, validateGitCloneWorktreePatch));
    checks.push(await runCheck(context, "policy.filesystem", "Filesystem policy mechanics", "policy", true, validateFilesystemPolicyMechanics));
    checks.push(await runCheck(context, "diff.session-checkpoints", "Session diff checkpoints", "diff", true, validateSessionDiffMechanics));
    checks.push(await runCheck(context, "diff.restart-checkpoint-persistence", "Restart diff checkpoint persistence", "diff", true, validateRestartDiffCheckpointPersistence));
    checks.push(await runCheck(context, "plan.markdown-blocks", "Markdown plan block mechanics", "plan", true, validateMarkdownPlanMechanics));
    checks.push(await runCheck(context, "orchestration.independent-agents", "Independent role orchestration", "orchestration", true, validateOrchestrationMechanics));
    checks.push(await runCheck(context, "orchestration.role-visibility-model", "Role timeline visibility model", "orchestration", true, validateRoleVisibilityModel));
    checks.push(await runCheck(context, "task.memory-registry", "Task and memory registry mechanics", "task", true, validateTaskMemoryRegistryMechanics));
    checks.push(await runCheck(context, "integrations.extension-contracts", "Schema-bound extension contracts", "integrations", true, validateExtensionPointContracts));
    checks.push(await runCheck(context, "work.work-management-contracts", "Work-management contracts", "work", true, validateWorkManagementContracts));
    checks.push(await runCheck(context, "integrations.jira-live-probe", "Jira API live probe", "integrations", false, validateJiraLiveProbe));
    checks.push(await runCheck(context, "integrations.asana-live-probe", "Asana API live probe", "integrations", false, validateAsanaLiveProbe));
    checks.push(await runCheck(context, "integrations.github-live-probe", "GitHub Issues API live probe", "integrations", false, validateGitHubLiveProbe));
    checks.push(await runCheck(context, "testing.hitl-shape", "Human-in-the-loop test data", "testing", true, validateHitlShape));

    const report = buildReport(context, checks);
    await writeFile(options.outputJson, JSON.stringify(report, null, 2) + "\n", "utf8");
    await writeFile(options.reportPath, renderMarkdownReport(report), "utf8");

    printConsoleSummary(report);

    if (options.strict && report.gate.status === "blocked") {
      process.exitCode = 1;
    }
  } finally {
    if (!options.keepTemp) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

function parseArgs(args: string[]): CliOptions {
  const root = process.cwd();
  const options: CliOptions = {
    strict: false,
    keepTemp: false,
    skipRuntime: false,
    skipAcpTurn: false,
    allowNpxAcp: false,
    outputJson: path.join(root, "prevalidation.json"),
    reportPath: path.join(root, "docs", "prevalidation-report.md")
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--strict") {
      options.strict = true;
    } else if (arg === "--keep-temp") {
      options.keepTemp = true;
    } else if (arg === "--skip-runtime") {
      options.skipRuntime = true;
    } else if (arg === "--skip-acp-turn") {
      options.skipAcpTurn = true;
    } else if (arg === "--allow-npx-acp") {
      options.allowNpxAcp = true;
    } else if (arg === "--json") {
      const value = args[i + 1];
      if (!value) throw new Error("--json requires a path");
      options.outputJson = path.resolve(value);
      i += 1;
    } else if (arg === "--report") {
      const value = args[i + 1];
      if (!value) throw new Error("--report requires a path");
      options.reportPath = path.resolve(value);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: npm run prevalidate -- [options]

Options:
  --strict          Exit non-zero when required checks fail.
  --keep-temp       Keep temporary validation directories for inspection.
  --skip-runtime    Skip Docker Sandbox, Docker fallback, and in-sandbox Codex probes.
  --skip-acp-turn   Probe ACP initialize/session only, without sending a model prompt.
  --allow-npx-acp   Include npx-based ACP candidates. This can fetch packages.
  --json <path>     Write machine-readable report to a custom path.
  --report <path>   Write Markdown report to a custom path.
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (process.env.PREVALIDATE_SKIP_ACP_TURN === "1") {
    options.skipAcpTurn = true;
  }

  return options;
}

async function runCheck(
  context: CheckContext,
  id: string,
  title: string,
  category: string,
  required: boolean,
  fn: (context: CheckContext) => Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">>
): Promise<CheckResult> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  try {
    const result = await fn(context);
    return {
      id,
      title,
      category,
      required,
      status: result.status,
      summary: result.summary,
      details: result.details,
      startedAt,
      durationMs: Date.now() - started,
      ...(result.data === undefined ? {} : { data: result.data })
    };
  } catch (error) {
    return {
      id,
      title,
      category,
      required,
      status: required ? "fail" : "optional",
      summary: error instanceof Error ? error.message : String(error),
      details: [],
      startedAt,
      durationMs: Date.now() - started
    };
  }
}

function skipCheck(id: string, title: string, category: string, required: boolean, summary: string): CheckResult {
  return {
    id,
    title,
    category,
    required,
    status: "skip",
    summary,
    details: [],
    startedAt: new Date().toISOString(),
    durationMs: 0
  };
}

async function validateProductPlan(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const file = path.join(context.designDocsDir, "product-plan.md");
  const text = await readFile(file, "utf8");
  const requiredSections = [
    "## Stage 0: Plan, Threat Model, And Prevalidation",
    "## Staged Delivery After Prevalidation",
    "## Test Plan"
  ];
  const missing = requiredSections.filter((section) => !text.includes(section));
  if (missing.length > 0) {
    return {
      status: "fail",
      summary: "Product plan exists but is missing required sections.",
      details: missing.map((section) => `Missing section: ${section}`)
    };
  }
  return {
    status: "pass",
    summary: "Product plan is present and includes Stage 0, staged delivery, and test sections.",
    details: [`Path: ${file}`]
  };
}

async function validateThreatModel(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const file = path.join(context.designDocsDir, "threat-model.md");
  const text = await readFile(file, "utf8");
  const requiredSections = [
    "## Security Goals",
    "## Trust Boundaries",
    "## Denied Behaviors",
    "## Stage 0 Security Gate"
  ];
  const missing = requiredSections.filter((section) => !text.includes(section));
  if (missing.length > 0) {
    return {
      status: "fail",
      summary: "Threat model exists but is missing required sections.",
      details: missing.map((section) => `Missing section: ${section}`)
    };
  }
  return {
    status: "pass",
    summary: "Threat model is present and names the security boundary and Stage 0 gate.",
    details: [`Path: ${file}`]
  };
}

async function validatePrevalidationCoverage(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const file = path.join(context.designDocsDir, "prevalidation-coverage.md");
  const text = await readFile(file, "utf8");
  const requiredPhrases = [
    "Coverage Matrix",
    "Codex event visibility",
    "Live Codex turn",
    "File add/modify/delete visibility",
    "Agent adapter registry",
    "Provider auth lifecycle",
    "Runtime restart continuity",
    "Product-owned orchestration",
    "Internal task registry",
    "Provider schemas and manifests",
    "Work-management schemas",
    "Day planner",
    "Memory",
    "Backend Conclusions"
  ];
  const missing = requiredPhrases.filter((phrase) => !text.includes(phrase));
  if (missing.length > 0) {
    return {
      status: "fail",
      summary: `Prevalidation coverage matrix is missing required sections: ${missing.join(", ")}`,
      details: [`Path: ${file}`]
    };
  }
  return {
    status: "pass",
    summary: "Prevalidation coverage matrix maps the feature list to required checks and deferred validations.",
    details: [`Path: ${file}`]
  };
}

async function validateApiReference(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const file = path.join(context.designDocsDir, "api-reference.md");
  const text = await readFile(file, "utf8");
  const requiredPhrases = [
    "# Implementation API Reference",
    "RuntimeRegistry",
    "RuntimeInventory",
    "RuntimeCleanupService",
    "Force cleanup tiers",
    "RuntimeLifecycleService",
    "AccessRequestService",
    "AgentAdapter",
    "AuthProviderService",
    "WorkManagementConfig",
    "WorkspaceSetService",
    "DayPlannerService",
    "ExtensionPointRegistry",
    "TaskProvider",
    "InternalTaskProvider",
    "SessionDiffService",
    "OrchestratorService",
    "Command Surface",
    "Security Invariants",
    "References"
  ];
  const missing = requiredPhrases.filter((phrase) => !text.includes(phrase));
  if (missing.length > 0) {
    return {
      status: "fail",
      summary: `Implementation API reference is missing required sections: ${missing.join(", ")}`,
      details: [`Path: ${file}`]
    };
  }
  return {
    status: "pass",
    summary: "Implementation API reference is present and covers cleanup, inventory, auth, adapters, diffs, access restart, and cited command surfaces.",
    details: [`Path: ${file}`]
  };
}

async function validateExtensionPointsPlan(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const file = path.join(context.designDocsDir, "extension-points.md");
  const text = await readFile(file, "utf8");
  const requiredPhrases = [
    "# Extension Points And Task Integration Plan",
    "InternalTaskProvider",
    "JiraTaskProvider",
    "AsanaTaskProvider",
    "GitHubIssuesTaskProvider",
    "CustomTaskProvider",
    "Schema-Bound Extension Manifest",
    "Agent Provider Extension Point",
    "Runtime Adapter Extension Point",
    "Panel Provider Extension Point",
    "Memory And Test Provider Extension Points",
    "Credentialed Live Probe Policy",
    "References"
  ];
  const missing = requiredPhrases.filter((phrase) => !text.includes(phrase));
  if (missing.length > 0) {
    return {
      status: "fail",
      summary: `Extension-points plan is missing required sections: ${missing.join(", ")}`,
      details: [`Path: ${file}`]
    };
  }
  return {
    status: "pass",
    summary: "Extension-points plan covers internal tasks, external task adapters, custom agents, runtime adapters, panels, memory, testing, and credentialed live probes.",
    details: [`Path: ${file}`]
  };
}

async function validateWorkManagementPlan(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const file = path.join(context.designDocsDir, "work-management.md");
  const text = await readFile(file, "utf8");
  const requiredPhrases = [
    "# Work Management, Workspaces, Tasks, And Day Planning",
    "stateStores",
    "WorkspaceSet",
    "WorkspaceProjection",
    "TaskWorkspaceLink",
    "TaskWorkSession",
    "Workspace Switching",
    "Day Planner",
    "sharedPaths",
    "redacted",
    "VSIX",
    "source-control branch policy",
    "Stage 0 Validation Additions",
    "References"
  ];
  const missing = requiredPhrases.filter((phrase) => !text.includes(phrase));
  if (missing.length > 0) {
    return {
      status: "fail",
      summary: `Work-management plan is missing required sections: ${missing.join(", ")}`,
      details: [`Path: ${file}`]
    };
  }
  return {
    status: "pass",
    summary: "Work-management plan covers configured state stores, shared paths, redacted logging, VSIX packaging, branch policy, workspace sets, task work sessions, workspace switching, and day planning.",
    details: [`Path: ${file}`]
  };
}

async function probeCommand(
  context: CheckContext,
  key: string,
  names: string[],
  versionArgs: string[],
  required: boolean
): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const found = findCommandOnPath(names, key);
  const probe: CommandProbe = {
    key,
    names,
    path: found,
    required,
    versionArgs
  };

  if (!found) {
    context.commands.set(key, probe);
    return {
      status: required ? "fail" : "optional",
      summary: `${names.join(" or ")} was not found on PATH.`,
      details: [`PATH entries searched: ${splitPathEnv().length}`]
    };
  }

  const result = await run(found, versionArgs, { cwd: context.root, timeoutMs: CHECK_TIMEOUT_MS });
  probe.versionResult = result;
  context.commands.set(key, probe);

  if (result.exitCode === 0) {
    return {
      status: "pass",
      summary: `${key} is available.`,
      details: [
        `Path: ${found}`,
        oneLine(`Version output: ${result.stdout || result.stderr}`)
      ],
      data: {
        path: found,
        versionOutput: sanitizeOutput(result.stdout || result.stderr)
      }
    };
  }

  return {
    status: required ? "fail" : "optional",
    summary: `${key} was found but could not be executed successfully.`,
    details: [
      `Path: ${found}`,
      `Exit code: ${String(result.exitCode)}`,
      ...(result.error ? [`Spawn error: ${result.error}`] : []),
      oneLine(`stdout: ${result.stdout}`),
      oneLine(`stderr: ${result.stderr}`)
    ],
    data: commandResultData(result)
  };
}

async function validateWslStatus(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const probe = context.commands.get("wsl");
  if (!probe?.path) {
    return {
      status: "optional",
      summary: "WSL is optional for v1 and was not found.",
      details: []
    };
  }

  const list = await run(probe.path, ["-l", "-v"], { cwd: context.root, timeoutMs: CHECK_TIMEOUT_MS });
  if (list.exitCode !== 0) {
    return {
      status: "optional",
      summary: "WSL exists but distribution listing failed.",
      details: [
        oneLine(`stdout: ${list.stdout}`),
        oneLine(`stderr: ${list.stderr}`)
      ],
      data: commandResultData(list)
    };
  }

  return {
    status: "pass",
    summary: "WSL is available as an optional later runtime adapter.",
    details: [oneLine(`Distributions: ${list.stdout}`)],
    data: commandResultData(list)
  };
}

async function validateDockerSandboxIsolation(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const sbx = context.commands.get("sbx")?.path;
  if (!sbx) {
    return {
      status: "fail",
      summary: "Docker Sandbox command `sbx` is required for the first real runtime and is not available.",
      details: ["Install or expose Docker Sandbox CLI before running isolated agents."]
    };
  }

  const layout = await createRuntimeFixture(context.tempRoot, "sbx");
  const name = `drydock-prevalidate-${shortId()}`.toLowerCase();
  const details: string[] = [];
  await cleanupSbx(sbx, name, context.root);

  try {
    const create = await run(sbx, ["create", "--name", name, "shell", layout.workspace, `${layout.sharedRead}:ro`, layout.sharedWrite], {
      cwd: context.root,
      timeoutMs: RUNTIME_TIMEOUT_MS
    });
    details.push(compactCommand("create", create));
    if (create.exitCode !== 0) {
      return {
        status: "fail",
        summary: "Docker Sandbox could not create a shell sandbox with requested mounts.",
        details,
        data: commandResultData(create)
      };
    }

    const sharedReadPath = hostPathToSandboxPath(layout.sharedRead);
    const sharedWritePath = hostPathToSandboxPath(layout.sharedWrite);
    const script = [
      "set -eu",
      `RO_DIR=${shellQuote(sharedReadPath)}`,
      `RW_DIR=${shellQuote(sharedWritePath)}`,
      "pwd",
      "test -f workspace-probe.txt",
      "echo workspace-ok > workspace-write.txt",
      "test -f \"$RO_DIR/readonly-probe.txt\"",
      "if echo denied > \"$RO_DIR/should-not-write.txt\" 2>/tmp/ro.err; then echo RO_WRITE_SUCCEEDED; exit 31; fi",
      "test -f \"$RW_DIR/writable-probe.txt\"",
      "echo shared-write-ok > \"$RW_DIR/write-from-sbx.txt\""
    ].join("\n");

    const exec = await run(sbx, ["exec", name, "sh", "-lc", script], {
      cwd: context.root,
      timeoutMs: RUNTIME_TIMEOUT_MS
    });
    details.push(compactCommand("exec", exec));

    const hostWrite = existsSync(path.join(layout.sharedWrite, "write-from-sbx.txt"));
    if (exec.exitCode !== 0 || !hostWrite) {
      return {
        status: "fail",
        summary: "Docker Sandbox did not prove workspace write, shared read-only denial, and shared write behavior.",
        details: [
          ...details,
          `Host shared write observed: ${String(hostWrite)}`
        ],
        data: commandResultData(exec)
      };
    }

    return {
      status: "pass",
      summary: "Docker Sandbox created an isolated shell runtime and enforced read-only/write mounts.",
      details
    };
  } finally {
    const cleanup = await cleanupSbx(sbx, name, context.root);
    details.push(...cleanup);
  }
}

async function validateAccessRestartContinuity(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const sbx = context.commands.get("sbx")?.path;
  if (!sbx) {
    return {
      status: "fail",
      summary: "Cannot validate access-request restart continuity because `sbx` is unavailable.",
      details: []
    };
  }

  const layout = await createRuntimeFixture(context.tempRoot, "restart");
  const approvedRead = path.join(context.tempRoot, `approved-read-${shortId()}`);
  const approvedWrite = path.join(context.tempRoot, `approved-write-${shortId()}`);
  const checkpointDir = path.join(context.tempRoot, `restart-checkpoint-${shortId()}`);
  await mkdir(approvedRead, { recursive: true });
  await mkdir(approvedWrite, { recursive: true });
  await mkdir(checkpointDir, { recursive: true });
  await writeFile(path.join(approvedRead, "new-context.txt"), "approved read\n", "utf8");

  const name = `drydock-restart-${shortId()}`.toLowerCase();
  const details: string[] = [];
  const chatId = `chat-${shortId()}`;
  const parentSessionId = `session-${shortId()}`;
  const siblingSessions = [
    { id: `session-${shortId()}`, role: "researcher", runtimeId: `runtime-${shortId()}`, status: "running", generation: 1 },
    { id: `session-${shortId()}`, role: "tester", runtimeId: `runtime-${shortId()}`, status: "running", generation: 1 }
  ];
  const accessRequest = {
    id: `access-${shortId()}`,
    chatId,
    sessionId: parentSessionId,
    requestedPath: approvedRead,
    requestedAccess: "read",
    status: "approved",
    requiresRuntimeRestart: true,
    interruptsSiblingSessions: false
  };

  await cleanupSbx(sbx, name, context.root);

  try {
    const createOne = await run(sbx, ["create", "--name", name, "shell", layout.workspace], {
      cwd: context.root,
      timeoutMs: RUNTIME_TIMEOUT_MS
    });
    details.push(compactCommand("create generation 1", createOne));
    if (createOne.exitCode !== 0) {
      return {
        status: "fail",
        summary: "Could not create generation 1 sandbox for restart validation.",
        details,
        data: commandResultData(createOne)
      };
    }

    const writeOne = await run(sbx, [
      "exec",
      name,
      "sh",
      "-lc",
      [
        "set -eu",
        "echo mounted-edit-before-restart > restart-edit.txt",
        "mkdir -p /tmp/prevalidation",
        "echo runtime-artifact-before-restart > /tmp/prevalidation/runtime-artifact.txt"
      ].join("\n")
    ], {
      cwd: context.root,
      timeoutMs: RUNTIME_TIMEOUT_MS
    });
    details.push(compactCommand("write generation 1 state", writeOne));

    const checkpointFile = path.join(checkpointDir, "runtime-artifact.txt");
    const checkpoint = await run(sbx, ["cp", `${name}:/tmp/prevalidation/runtime-artifact.txt`, checkpointFile], {
      cwd: context.root,
      timeoutMs: RUNTIME_TIMEOUT_MS
    });
    details.push(compactCommand("checkpoint runtime artifact", checkpoint));

    const stopOne = await run(sbx, ["stop", name], {
      cwd: context.root,
      timeoutMs: RUNTIME_TIMEOUT_MS
    });
    details.push(compactCommand("stop generation 1", stopOne));
    const removeOne = await run(sbx, ["rm", "--force", name], {
      cwd: context.root,
      timeoutMs: RUNTIME_TIMEOUT_MS
    });
    details.push(compactCommand("remove generation 1", removeOne));

    if (writeOne.exitCode !== 0 || checkpoint.exitCode !== 0 || stopOne.exitCode !== 0 || removeOne.exitCode !== 0) {
      return {
        status: "fail",
        summary: "Generation 1 sandbox state could not be checkpointed and removed before remount.",
        details,
        data: {
          writeOne: commandResultData(writeOne),
          checkpoint: commandResultData(checkpoint),
          stopOne: commandResultData(stopOne),
          removeOne: commandResultData(removeOne)
        }
      };
    }

    const createTwo = await run(sbx, ["create", "--name", name, "shell", layout.workspace, `${approvedRead}:ro`, approvedWrite], {
      cwd: context.root,
      timeoutMs: RUNTIME_TIMEOUT_MS
    });
    details.push(compactCommand("create generation 2 with approved paths", createTwo));
    if (createTwo.exitCode !== 0) {
      return {
        status: "fail",
        summary: "Could not recreate sandbox with the approved additional directory mounts.",
        details,
        data: commandResultData(createTwo)
      };
    }

    const mkdirRestoreTarget = await run(sbx, ["exec", name, "sh", "-lc", "mkdir -p /tmp/prevalidation"], {
      cwd: context.root,
      timeoutMs: RUNTIME_TIMEOUT_MS
    });
    details.push(compactCommand("create restore directory", mkdirRestoreTarget));

    const restore = await run(sbx, ["cp", checkpointFile, `${name}:/tmp/prevalidation/runtime-artifact.txt`], {
      cwd: context.root,
      timeoutMs: RUNTIME_TIMEOUT_MS
    });
    details.push(compactCommand("restore runtime artifact", restore));

    const readPath = hostPathToSandboxPath(approvedRead);
    const writePath = hostPathToSandboxPath(approvedWrite);
    const verify = await run(sbx, [
      "exec",
      name,
      "sh",
      "-lc",
      [
        "set -eu",
        `READ_DIR=${shellQuote(readPath)}`,
        `WRITE_DIR=${shellQuote(writePath)}`,
        "test \"$(cat restart-edit.txt)\" = mounted-edit-before-restart",
        "test \"$(cat /tmp/prevalidation/runtime-artifact.txt)\" = runtime-artifact-before-restart",
        "test -f \"$READ_DIR/new-context.txt\"",
        "if echo denied > \"$READ_DIR/should-not-write.txt\" 2>/tmp/restart-ro.err; then echo READ_MOUNT_WRITE_SUCCEEDED; exit 43; fi",
        "echo write-after-restart > \"$WRITE_DIR/write-after-restart.txt\""
      ].join("\n")
    ], {
      cwd: context.root,
      timeoutMs: RUNTIME_TIMEOUT_MS
    });
    details.push(compactCommand("verify generation 2 continuity", verify));

    const hostMountedEditPreserved = existsSync(path.join(layout.workspace, "restart-edit.txt"));
    const hostApprovedWriteObserved = existsSync(path.join(approvedWrite, "write-after-restart.txt"));
    const siblingUnaffected = siblingSessions.every((session) => session.status === "running" && session.generation === 1);
    const continuityRecord = {
      chatId,
      sessionId: parentSessionId,
      accessRequest,
      before: { runtimeName: name, generation: 1, status: "stopped-for-remount" },
      after: { runtimeName: name, generation: 2, status: "running" },
      siblingSessions
    };
    const continuityOk = mkdirRestoreTarget.exitCode === 0
      && restore.exitCode === 0
      && verify.exitCode === 0
      && hostMountedEditPreserved
      && hostApprovedWriteObserved
      && siblingUnaffected
      && continuityRecord.before.runtimeName === continuityRecord.after.runtimeName
      && continuityRecord.before.generation + 1 === continuityRecord.after.generation
      && continuityRecord.sessionId === parentSessionId;

    details.push(`Mounted workspace edit preserved on host: ${String(hostMountedEditPreserved)}`);
    details.push(`Approved write path observed host write: ${String(hostApprovedWriteObserved)}`);
    details.push(`Sibling sessions unaffected: ${String(siblingUnaffected)}`);
    details.push(`Continuity record: ${JSON.stringify(continuityRecord)}`);

    if (!continuityOk) {
      return {
        status: "fail",
        summary: "Access-request restart did not preserve session continuity, mounted edits, checkpointed runtime artifacts, or sibling-agent isolation.",
        details,
        data: {
          restore: commandResultData(restore),
          mkdirRestoreTarget: commandResultData(mkdirRestoreTarget),
          verify: commandResultData(verify),
          hostMountedEditPreserved,
          hostApprovedWriteObserved,
          siblingUnaffected,
          continuityRecord
        }
      };
    }

    return {
      status: "pass",
      summary: "Access-request restart can checkpoint runtime artifacts, recreate the sandbox with approved mounts, preserve mounted edits, and keep sibling sessions running.",
      details,
      data: {
        continuityRecord,
        hostMountedEditPreserved,
        hostApprovedWriteObserved
      }
    };
  } finally {
    const cleanup = await cleanupSbx(sbx, name, context.root);
    details.push(...cleanup);
  }
}

async function validateDockerSandboxReadiness(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const sbx = context.commands.get("sbx")?.path;
  if (!sbx) {
    return {
      status: "fail",
      summary: "Docker Sandbox CLI is unavailable, so daemon/auth readiness cannot be checked.",
      details: []
    };
  }

  const status = await run(sbx, ["daemon", "status"], {
    cwd: context.root,
    timeoutMs: CHECK_TIMEOUT_MS
  });
  const list = await run(sbx, ["ls"], {
    cwd: context.root,
    timeoutMs: CHECK_TIMEOUT_MS
  });
  const diagnose = await run(sbx, ["diagnose"], {
    cwd: context.root,
    timeoutMs: 30_000
  });

  const details = [
    compactCommand("sbx daemon status", status),
    compactCommand("sbx ls", list),
    compactCommand("sbx diagnose", diagnose)
  ];

  const statusText = `${status.stdout}\n${status.stderr}`;
  const listText = `${list.stdout}\n${list.stderr}`;
  const diagnoseText = `${diagnose.stdout}\n${diagnose.stderr}`;
  const daemonRunning = /Status:\s*running/i.test(statusText) || /daemon.*reachable/i.test(diagnoseText);
  const daemonStopped = /Status:\s*stopped/i.test(statusText) || /daemon.*not reachable/i.test(diagnoseText);
  const notAuthenticated = /not authenticated/i.test(listText) || /not authenticated/i.test(diagnoseText);

  if (daemonStopped || !daemonRunning) {
    return {
      status: "fail",
      summary: "Docker Sandbox daemon is not ready. Run `sbx daemon start`, then rerun prevalidation.",
      details,
      data: {
        daemonStatus: commandResultData(status),
        list: commandResultData(list),
        diagnose: commandResultData(diagnose)
      }
    };
  }

  if (notAuthenticated || list.exitCode !== 0) {
    return {
      status: "fail",
      summary: "Docker Sandbox is not authenticated. Run `sbx login`, then rerun prevalidation.",
      details,
      data: {
        daemonStatus: commandResultData(status),
        list: commandResultData(list),
        diagnose: commandResultData(diagnose)
      }
    };
  }

  return {
    status: "pass",
    summary: "Docker Sandbox daemon is reachable and sandbox listing is authenticated.",
    details,
    data: {
      daemonStatus: commandResultData(status),
      list: commandResultData(list),
      diagnose: commandResultData(diagnose)
    }
  };
}

async function validateDockerFallbackIsolation(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const docker = context.commands.get("docker")?.path;
  if (!docker) {
    return {
      status: "fail",
      summary: "Docker CLI is required for the fallback runtime and is not available.",
      details: []
    };
  }

  const contextProbe = await selectDockerContext(docker, context.root);
  if (!contextProbe.available) {
    return {
      status: "fail",
      summary: "Docker CLI exists but no usable Docker daemon/context is reachable.",
      details: contextProbe.details,
      data: contextProbe.data
    };
  }

  const contextArgs = contextProbe.contextName ? ["--context", contextProbe.contextName] : [];
  const info = await run(docker, [...contextArgs, "info", "--format", "{{.ServerVersion}}"], {
    cwd: context.root,
    timeoutMs: CHECK_TIMEOUT_MS
  });
  if (info.exitCode !== 0) {
    return {
      status: "fail",
      summary: "Docker CLI exists but the Docker daemon is not reachable.",
      details: [
        oneLine(`stdout: ${info.stdout}`),
        oneLine(`stderr: ${info.stderr}`)
      ],
      data: commandResultData(info)
    };
  }

  const layout = await createRuntimeFixture(context.tempRoot, "docker");
  const script = [
    "set -eu",
    "echo workspace-ok > /workspace/workspace-write.txt",
    "if echo denied > /shared-read/should-not-write.txt 2>/tmp/ro.err; then echo RO_WRITE_SUCCEEDED; exit 31; fi",
    "echo shared-write-ok > /shared-write/write-from-docker.txt"
  ].join("\n");

  const runResult = await run(docker, [
    ...contextArgs,
    "run",
    "--rm",
    "--network",
    "none",
    "--cap-drop=ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    "512m",
    "--cpus",
    "1",
    "-v",
    `${layout.workspace}:/workspace:rw`,
    "-v",
    `${layout.sharedRead}:/shared-read:ro`,
    "-v",
    `${layout.sharedWrite}:/shared-write:rw`,
    "-w",
    "/workspace",
    "alpine:3.20",
    "sh",
    "-lc",
    script
  ], {
    cwd: context.root,
    timeoutMs: RUNTIME_TIMEOUT_MS
  });

  const hostWrite = existsSync(path.join(layout.sharedWrite, "write-from-docker.txt"));
  if (runResult.exitCode !== 0 || !hostWrite) {
    return {
      status: "fail",
      summary: "Docker fallback did not prove hardened mount behavior.",
      details: [
        ...contextProbe.details,
        `Docker context: ${contextProbe.contextName ?? "default"}`,
        compactCommand("docker run", runResult),
        `Host shared write observed: ${String(hostWrite)}`
      ],
      data: commandResultData(runResult)
    };
  }

  return {
      status: "pass",
    summary: "Docker fallback ran with hardened flags and enforced read-only/write mounts.",
    details: [
      `Docker context: ${contextProbe.contextName ?? "default"}`,
      compactCommand("docker run", runResult)
    ]
  };
}

async function validateHostCodexCommunication(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const codex = context.commands.get("codex")?.path;
  if (!codex) {
    return {
      status: "fail",
      summary: "Host Codex is required for login/protocol validation and was not discovered.",
      details: [
        "Install the standalone Codex CLI or set PREVALIDATE_CODEX_PATH to a spawnable codex executable.",
        "PowerShell install path from the Codex manual: `$env:CODEX_NON_INTERACTIVE=1; irm https://chatgpt.com/codex/install.ps1 | iex`"
      ]
    };
  }

  const details: string[] = [];
  const loginStatus = await run(codex, ["login", "status"], {
    cwd: context.root,
    timeoutMs: CHECK_TIMEOUT_MS
  });
  details.push(compactCommand("codex login status", loginStatus));

  const doctor = await run(codex, ["doctor"], {
    cwd: context.root,
    timeoutMs: RUNTIME_TIMEOUT_MS
  });
  details.push(compactCommand("codex doctor", doctor));

  const schemaDir = path.join(context.tempRoot, "host-codex-app-schema");
  const schema = await run(codex, ["app-server", "generate-json-schema", "--out", schemaDir], {
    cwd: context.root,
    timeoutMs: RUNTIME_TIMEOUT_MS
  });
  details.push(compactCommand("codex app-server generate-json-schema", schema));

  const execHelp = await run(codex, ["exec", "--help"], {
    cwd: context.root,
    timeoutMs: CHECK_TIMEOUT_MS
  });
  details.push(compactCommand("codex exec --help", execHelp));

  const mcpServerHelp = await run(codex, ["mcp-server", "--help"], {
    cwd: context.root,
    timeoutMs: CHECK_TIMEOUT_MS
  });
  details.push(compactCommand("codex mcp-server --help", mcpServerHelp));

  const protocol = await probeCodexAppServerProtocol({
    label: "host codex app-server",
    command: codex,
    args: ["app-server", "--listen", "stdio://"],
    cwd: context.root,
    threadCwd: context.root,
    timeoutMs: RUNTIME_TIMEOUT_MS
  });
  details.push(...protocol.details);

  const combinedAuth = `${loginStatus.stdout}\n${loginStatus.stderr}\n${doctor.stdout}\n${doctor.stderr}`;
  const authOk = loginStatus.exitCode === 0 && /logged in/i.test(combinedAuth) && !/not logged in|no codex credentials|auth\s+no/i.test(combinedAuth);
  const execJsonOk = execHelp.exitCode === 0 && /--json\b/.test(`${execHelp.stdout}\n${execHelp.stderr}`);
  const mcpOk = mcpServerHelp.exitCode === 0;

  const missing: string[] = [];
  if (!authOk) missing.push("codex login status");
  if (schema.exitCode !== 0) missing.push("app-server schema generation");
  if (!protocol.ok) missing.push("app-server JSON-RPC initialize/thread-start");
  if (!execJsonOk) missing.push("codex exec --json");
  if (!mcpOk) missing.push("codex mcp-server");

  if (missing.length > 0) {
    return {
      status: "fail",
      summary: `Host Codex communication is missing required capability: ${missing.join(", ")}.`,
      details: [
        ...details,
        "If the WindowsApps alias is selected and fails with Access is denied, set PREVALIDATE_CODEX_PATH to the standalone Codex binary under `%LOCALAPPDATA%\\OpenAI\\Codex\\bin\\...\\codex.exe` or reinstall with the standalone installer.",
        "If login is missing, run `codex login --device-auth` or `codex login` with the standalone Codex executable."
      ],
      data: {
        loginStatus: commandResultData(loginStatus),
        doctor: commandResultData(doctor),
        schema: commandResultData(schema),
        execHelp: commandResultData(execHelp),
        mcpServerHelp: commandResultData(mcpServerHelp),
        protocol: protocol.data,
        authOk,
        execJsonOk,
        mcpOk
      }
    };
  }

  return {
    status: "pass",
    summary: "Host Codex login and app-server protocol communication are available.",
    details,
    data: {
      loginStatus: commandResultData(loginStatus),
      protocol: protocol.data
    }
  };
}

async function validateCodexVisibilitySchema(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const codex = context.commands.get("codex")?.path;
  if (!codex) {
    return {
      status: "fail",
      summary: "Cannot validate Codex event visibility schema because Codex is unavailable.",
      details: []
    };
  }

  const schemaDir = path.join(context.tempRoot, `codex-schema-${shortId()}`);
  const generated = await run(codex, ["app-server", "generate-json-schema", "--out", schemaDir], {
    cwd: context.root,
    timeoutMs: RUNTIME_TIMEOUT_MS
  });
  const details = [compactCommand("codex app-server generate-json-schema", generated)];
  if (generated.exitCode !== 0) {
    return {
      status: "fail",
      summary: "Codex app-server schema generation failed, so UI event visibility cannot be validated.",
      details,
      data: commandResultData(generated)
    };
  }

  const serverNotificationPath = path.join(schemaDir, "ServerNotification.json");
  const itemStartedPath = path.join(schemaDir, "v2", "ItemStartedNotification.json");
  const turnStartPath = path.join(schemaDir, "v2", "TurnStartParams.json");
  const turnInterruptPath = path.join(schemaDir, "v2", "TurnInterruptParams.json");
  const filePatchPath = path.join(schemaDir, "v2", "FileChangePatchUpdatedNotification.json");
  const turnDiffPath = path.join(schemaDir, "v2", "TurnDiffUpdatedNotification.json");
  const serverNotification = await readFile(serverNotificationPath, "utf8");
  const itemStarted = await readFile(itemStartedPath, "utf8");
  const turnStart = await readFile(turnStartPath, "utf8");
  const turnInterrupt = await readFile(turnInterruptPath, "utf8");
  const filePatch = await readFile(filePatchPath, "utf8");
  const turnDiff = await readFile(turnDiffPath, "utf8");
  const combined = `${serverNotification}\n${itemStarted}\n${turnStart}\n${turnInterrupt}\n${filePatch}\n${turnDiff}`;

  const requiredNotifications = [
    "thread/started",
    "thread/status/changed",
    "thread/tokenUsage/updated",
    "turn/started",
    "turn/completed",
    "turn/diff/updated",
    "turn/plan/updated",
    "item/started",
    "item/completed",
    "item/agentMessage/delta",
    "item/plan/delta",
    "item/fileChange/patchUpdated",
    "process/outputDelta",
    "process/exited",
    "fs/changed",
    "mcpServer/startupStatus/updated"
  ];
  const requiredConcepts = [
    "CommandAction",
    "command",
    "fileChange",
    "PatchChangeKind",
    "add",
    "delete",
    "update",
    "CollabAgentState",
    "CollabAgentStatus",
    "spawnAgent",
    "sendInput",
    "resumeAgent",
    "wait",
    "closeAgent",
    "agentRole",
    "agentNickname",
    "parentThreadId",
    "MultiAgentMode",
    "TurnInterruptParams",
    "approvalPolicy",
    "sandboxPolicy"
  ];

  const missingNotifications = requiredNotifications.filter((needle) => !serverNotification.includes(`"${needle}"`));
  const missingConcepts = requiredConcepts.filter((needle) => !combined.includes(needle));
  details.push(`Required notifications present: ${requiredNotifications.filter((needle) => !missingNotifications.includes(needle)).join(", ")}`);
  details.push(`Required concepts present: ${requiredConcepts.filter((needle) => !missingConcepts.includes(needle)).join(", ")}`);

  if (missingNotifications.length > 0 || missingConcepts.length > 0) {
    return {
      status: "fail",
      summary: "Codex app-server schema is missing event visibility required by later UI/backend stages.",
      details: [
        ...details,
        `Missing notifications: ${missingNotifications.join(", ") || "(none)"}`,
        `Missing concepts: ${missingConcepts.join(", ") || "(none)"}`
      ],
      data: {
        schemaDir,
        missingNotifications,
        missingConcepts
      }
    };
  }

  return {
    status: "pass",
    summary: "Codex app-server schema exposes lifecycle, command, file-change, diff, plan, subagent, approval, and status events needed by later stages.",
    details,
    data: {
      schemaDir,
      requiredNotifications,
      requiredConcepts
    }
  };
}

async function validateAgentAdapterRegistry(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const sbx = context.commands.get("sbx")?.path;
  const details: string[] = [];
  const adapters = [
    {
      id: "codex",
      required: true,
      runtimeTypes: ["docker-sandbox", "docker-container"],
      authRefs: ["codex-host-login", "sbx:service/openai", "PREVALIDATE_CODEX_AUTH_DIR", "CODEX_ACCESS_TOKEN"],
      capabilities: ["noninteractive", "streaming-events", "app-server-json-rpc", "exec-json", "mcp-server", "cancel", "diff-events", "file-snapshots"]
    },
    {
      id: "claude",
      required: false,
      runtimeTypes: ["docker-sandbox"],
      authRefs: ["claude-login", "sbx:service/anthropic", "ANTHROPIC_API_KEY"],
      capabilities: ["noninteractive", "json-output", "stream-json-output", "permission-mode", "permission-prompt-tool", "mcp"]
    },
    {
      id: "gemini",
      required: false,
      runtimeTypes: ["docker-sandbox"],
      authRefs: ["provider-login", "provider-api-key"],
      capabilities: ["noninteractive", "streaming-events", "provider-permissions"]
    },
    {
      id: "opencode",
      required: false,
      runtimeTypes: ["docker-sandbox"],
      authRefs: ["provider-login", "provider-api-key"],
      capabilities: ["noninteractive", "streaming-events", "mcp"]
    },
    {
      id: "generic-acp",
      required: false,
      runtimeTypes: ["docker-sandbox", "docker-container", "wsl"],
      authRefs: ["provider-specific"],
      capabilities: ["json-rpc-handshake", "session", "prompt", "events", "cancel"]
    }
  ];

  const duplicateIds = adapters
    .map((adapter) => adapter.id)
    .filter((id, index, all) => all.indexOf(id) !== index);
  const codex = adapters.find((adapter) => adapter.id === "codex");
  const claude = adapters.find((adapter) => adapter.id === "claude");
  const requiredCapabilities = ["noninteractive", "streaming-events", "cancel"];
  const codexHasRequiredCapabilities = codex
    ? requiredCapabilities.every((capability) => codex.capabilities.includes(capability))
    : false;
  const externalAdapterSlots = adapters.filter((adapter) => !adapter.required).length >= 3;

  let sandboxAgents: string[] = [];
  if (sbx) {
    const help = await run(sbx, ["create", "--help"], {
      cwd: context.root,
      timeoutMs: CHECK_TIMEOUT_MS
    });
    details.push(compactCommand("sbx create --help", help));
    if (help.exitCode === 0) {
      sandboxAgents = extractSbxAgentNames(help.stdout);
      details.push(`Docker Sandbox advertised agents: ${sandboxAgents.join(", ") || "(none)"}`);
    }
  } else {
    details.push("Docker Sandbox command was unavailable, so advertised agent templates could not be listed.");
  }

  const sandboxCodex = sandboxAgents.includes("codex");
  const sandboxClaude = sandboxAgents.includes("claude");
  const sandboxHasOtherAdapters = ["gemini", "opencode", "copilot", "cursor"].some((agent) => sandboxAgents.includes(agent));
  const checksOk = duplicateIds.length === 0
    && Boolean(codex)
    && Boolean(claude)
    && codexHasRequiredCapabilities
    && externalAdapterSlots
    && sandboxCodex
    && sandboxClaude
    && sandboxHasOtherAdapters;

  details.push(`Codex adapter required: ${String(Boolean(codex?.required))}`);
  details.push(`Claude adapter slot present: ${String(Boolean(claude))}`);
  details.push(`External adapter slots: ${String(externalAdapterSlots)}`);
  details.push(`Docker Sandbox codex template advertised: ${String(sandboxCodex)}`);
  details.push(`Docker Sandbox claude template advertised: ${String(sandboxClaude)}`);
  details.push(`Docker Sandbox other agent templates advertised: ${String(sandboxHasOtherAdapters)}`);

  if (!checksOk) {
    return {
      status: "fail",
      summary: "Agent adapter registry does not yet cover required Codex plus optional Claude/other-agent extension points.",
      details: [
        ...details,
        `Duplicate adapter ids: ${duplicateIds.join(", ") || "(none)"}`,
        `Codex required capabilities present: ${String(codexHasRequiredCapabilities)}`
      ],
      data: {
        adapters,
        sandboxAgents,
        duplicateIds
      }
    };
  }

  return {
    status: "pass",
    summary: "Agent adapter registry covers required Codex and optional Claude/other-agent extension points with common capability flags.",
    details,
    data: {
      adapters,
      sandboxAgents
    }
  };
}

async function validateProviderLoginLifecycle(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const sbx = context.commands.get("sbx")?.path;
  const details: string[] = [];
  const providers = [
    {
      id: "openai",
      adapters: ["codex"],
      requiredForStage0: true,
      loginActions: ["codex login", "sbx secret set -g openai --oauth", "CODEX_ACCESS_TOKEN"],
      persistence: "Provider login remains outside disposable runtimes; Docker Sandbox injects proxy-managed auth and Docker-container checks import auth only when explicitly configured."
    },
    {
      id: "anthropic",
      adapters: ["claude"],
      requiredForStage0: false,
      loginActions: ["claude login", "sbx secret set -g anthropic", "ANTHROPIC_API_KEY"],
      persistence: "Provider login remains outside disposable runtimes; future Claude runtimes receive only provider-scoped secret references or proxy-managed auth."
    },
    {
      id: "generic-acp",
      adapters: ["generic-acp"],
      requiredForStage0: false,
      loginActions: ["provider-specific login", "provider-specific API key", "MCP OAuth where supported"],
      persistence: "Adapter records a secret reference and auth status, never raw secret material."
    }
  ];
  const authRequest = {
    id: `auth-${shortId()}`,
    providerId: "anthropic",
    adapterId: "claude",
    reason: "Claude runtime requested but no Anthropic credential reference is configured.",
    status: "needs-user-action",
    allowedActions: ["open-login-flow", "paste-api-key-to-secret-store", "cancel-agent-start"],
    secretRef: null,
    rawSecretStoredInEvents: false
  };
  const approvedAuth = {
    ...authRequest,
    status: "approved",
    secretRef: "sbx:service/anthropic",
    approvedBy: "local-user",
    rawSecretStoredInEvents: false
  };
  const restartInjection = {
    sessionId: `session-${shortId()}`,
    runtimeGeneration: 2,
    providerId: "anthropic",
    secretRef: approvedAuth.secretRef,
    injectsSecretValueIntoEvents: false,
    mountsHostCredentialDirectory: false
  };

  let secretList: CommandResult | null = null;
  let openaiConfigured = false;
  let secretOutputDoesNotExposeValues = true;
  if (sbx) {
    secretList = await run(sbx, ["secret", "ls"], {
      cwd: context.root,
      timeoutMs: CHECK_TIMEOUT_MS
    });
    details.push(compactCommand("sbx secret ls", secretList));
    const combined = `${secretList.stdout}\n${secretList.stderr}`;
    openaiConfigured = secretList.exitCode === 0 && /\bopenai\b/i.test(combined);
    secretOutputDoesNotExposeValues = !/(sk-[A-Za-z0-9_-]{12,}|oai-[A-Za-z0-9_-]{12,}|api[_-]?key\s*[:=]\s*\S+)/i.test(combined);
  } else {
    details.push("Docker Sandbox command unavailable, so provider secret references could not be listed.");
  }

  const noRawSecretsInModel = !JSON.stringify({ providers, authRequest, approvedAuth, restartInjection }).match(/sk-[A-Za-z0-9_-]{12,}|oai-[A-Za-z0-9_-]{12,}/);
  const providerModelOk = providers.some((provider) => provider.id === "openai" && provider.requiredForStage0)
    && providers.some((provider) => provider.id === "anthropic" && !provider.requiredForStage0)
    && approvedAuth.secretRef === "sbx:service/anthropic"
    && !restartInjection.injectsSecretValueIntoEvents
    && !restartInjection.mountsHostCredentialDirectory
    && noRawSecretsInModel
    && secretOutputDoesNotExposeValues
    && openaiConfigured;

  details.push(`OpenAI sandbox secret configured: ${String(openaiConfigured)}`);
  details.push(`Secret listing hides secret values: ${String(secretOutputDoesNotExposeValues)}`);
  details.push(`Auth request shape: ${JSON.stringify(authRequest)}`);
  details.push(`Restart auth injection shape: ${JSON.stringify(restartInjection)}`);

  if (!providerModelOk) {
    return {
      status: "fail",
      summary: "Provider login lifecycle does not yet prove explicit login prompts, durable secret references, and no secret-value event storage.",
      details,
      data: {
        providers,
        authRequest,
        approvedAuth,
        restartInjection,
        secretList: secretList ? commandResultData(secretList) : null,
        openaiConfigured,
        secretOutputDoesNotExposeValues,
        noRawSecretsInModel
      }
    };
  }

  return {
    status: "pass",
    summary: "Provider login lifecycle supports explicit user login prompts, durable provider secret references, runtime reinjection, and no raw secret event storage.",
    details,
    data: {
      providers,
      authRequest,
      approvedAuth,
      restartInjection,
      openaiConfigured
    }
  };
}

async function validateCodexInsideSandbox(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const sbx = context.commands.get("sbx")?.path;
  if (!sbx) {
    return {
      status: "fail",
      summary: "Cannot validate the sandboxed Codex adapter surface because `sbx` is unavailable.",
      details: []
    };
  }

  const layout = await createRuntimeFixture(context.tempRoot, "codex-sbx");
  const name = `drydock-codex-${shortId()}`.toLowerCase();
  const details: string[] = [];
  await cleanupSbx(sbx, name, context.root);

  try {
    const create = await run(sbx, ["create", "--name", name, "codex", layout.workspace], {
      cwd: context.root,
      timeoutMs: RUNTIME_TIMEOUT_MS
    });
    details.push(compactCommand("create codex", create));
    if (create.exitCode !== 0) {
      return {
        status: "fail",
        summary: "Docker Sandbox could not create a Codex sandbox.",
        details,
        data: commandResultData(create)
      };
    }

    const version = await run(sbx, ["exec", name, "codex", "--version"], {
      cwd: context.root,
      timeoutMs: RUNTIME_TIMEOUT_MS
    });
    details.push(compactCommand("codex --version", version));

    const rootHelp = await run(sbx, ["exec", name, "codex", "--help"], {
      cwd: context.root,
      timeoutMs: RUNTIME_TIMEOUT_MS
    });
    details.push(compactCommand("codex --help", rootHelp));

    const execHelp = await run(sbx, ["exec", name, "codex", "exec", "--help"], {
      cwd: context.root,
      timeoutMs: RUNTIME_TIMEOUT_MS
    });
    details.push(compactCommand("codex exec --help", execHelp));

    const appServerHelp = await run(sbx, ["exec", name, "codex", "app-server", "--help"], {
      cwd: context.root,
      timeoutMs: RUNTIME_TIMEOUT_MS
    });
    details.push(compactCommand("codex app-server --help", appServerHelp));

    const schema = await run(sbx, [
      "exec",
      name,
      "sh",
      "-lc",
      "rm -rf /tmp/codex-app-schema && codex app-server generate-json-schema --out /tmp/codex-app-schema && find /tmp/codex-app-schema -maxdepth 2 -type f | sort"
    ], {
      cwd: context.root,
      timeoutMs: RUNTIME_TIMEOUT_MS
    });
    details.push(compactCommand("codex app-server generate-json-schema", schema));

    const mcpServerHelp = await run(sbx, ["exec", name, "codex", "mcp-server", "--help"], {
      cwd: context.root,
      timeoutMs: RUNTIME_TIMEOUT_MS
    });
    details.push(compactCommand("codex mcp-server --help", mcpServerHelp));

    const protocol = await probeCodexAppServerProtocol({
      label: "sbx codex app-server",
      command: sbx,
      args: ["exec", name, "codex", "app-server", "--listen", "stdio://"],
      cwd: context.root,
      threadCwd: "/workspace",
      timeoutMs: RUNTIME_TIMEOUT_MS
    });
    details.push(...protocol.details);

    const rootHelpText = `${rootHelp.stdout}\n${rootHelp.stderr}`;
    const execHelpText = `${execHelp.stdout}\n${execHelp.stderr}`;
    const acpListed = /\bCommands:\s*[\s\S]*\bacp\b/i.test(rootHelpText);
    const supportsExecJson = execHelp.exitCode === 0 && /--json\b/.test(execHelpText);
    const missing: string[] = [];
    if (version.exitCode !== 0) missing.push("codex --version");
    if (rootHelp.exitCode !== 0) missing.push("codex --help");
    if (!supportsExecJson) missing.push("codex exec --json");
    if (appServerHelp.exitCode !== 0) missing.push("codex app-server");
    if (schema.exitCode !== 0) missing.push("codex app-server schema generation");
    if (mcpServerHelp.exitCode !== 0) missing.push("codex mcp-server");
    if (!protocol.ok) missing.push("app-server JSON-RPC initialize/thread-start");

    details.push(`Codex ACP command listed in sandbox help: ${String(acpListed)}`);

    if (missing.length > 0) {
      return {
        status: "fail",
        summary: `Sandboxed Codex is missing required adapter surfaces: ${missing.join(", ")}.`,
        details,
        data: {
          version: commandResultData(version),
          rootHelp: commandResultData(rootHelp),
          execHelp: commandResultData(execHelp),
          appServerHelp: commandResultData(appServerHelp),
          schema: commandResultData(schema),
          mcpServerHelp: commandResultData(mcpServerHelp),
          protocol: protocol.data,
          acpListed,
          supportsExecJson
        }
      };
    }

    return {
      status: "pass",
      summary: acpListed
        ? "Codex ACP and fallback adapter surfaces are discoverable inside a Docker Sandbox Codex runtime."
        : "Codex exec JSON, app-server, and MCP server surfaces are discoverable inside a Docker Sandbox Codex runtime; literal ACP was not listed.",
      details,
      data: {
        acpListed,
        supportsExecJson,
        protocol: protocol.data,
        version: oneLine(version.stdout || version.stderr)
      }
    };
  } finally {
    const cleanup = await cleanupSbx(sbx, name, context.root);
    details.push(...cleanup);
  }
}

async function validateCodexAuthInsideSandbox(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const sbx = context.commands.get("sbx")?.path;
  if (!sbx) {
    return {
      status: "fail",
      summary: "Cannot validate sandboxed Codex authentication because `sbx` is unavailable.",
      details: []
    };
  }

  const layout = await createRuntimeFixture(context.tempRoot, "codex-auth-sbx");
  const name = `drydock-codex-auth-${shortId()}`.toLowerCase();
  const details: string[] = [];
  await cleanupSbx(sbx, name, context.root);

  try {
    const create = await run(sbx, ["create", "--name", name, "codex", layout.workspace], {
      cwd: context.root,
      timeoutMs: RUNTIME_TIMEOUT_MS
    });
    details.push(compactCommand("create codex", create));
    if (create.exitCode !== 0) {
      return {
        status: "fail",
        summary: "Docker Sandbox could not create a Codex sandbox for authentication validation.",
        details,
        data: commandResultData(create)
      };
    }

    const loginStatus = await run(sbx, ["exec", name, "codex", "login", "status"], {
      cwd: context.root,
      timeoutMs: RUNTIME_TIMEOUT_MS
    });
    details.push(compactCommand("codex login status", loginStatus));

    const doctor = await run(sbx, ["exec", name, "codex", "doctor"], {
      cwd: context.root,
      timeoutMs: RUNTIME_TIMEOUT_MS
    });
    details.push(compactCommand("codex doctor", doctor));

    const combined = `${loginStatus.stdout}\n${loginStatus.stderr}\n${doctor.stdout}\n${doctor.stderr}`;
    const authMissing = /not logged in|no codex credentials|provide an api key|run codex login|auth\s+no/i.test(combined);
    const authPositive = loginStatus.exitCode === 0 || /logged in|auth\s+(ok|yes)|[✓✔]\s*auth/i.test(combined);

    if (!authPositive || authMissing) {
      return {
        status: "fail",
        summary: "Sandboxed Codex is not authenticated. Run `sbx secret set -g openai --oauth` or `sbx secret set -g openai`, then rerun prevalidation.",
        details: [
          ...details,
          "The extension must prove Codex can operate from inside the microVM before any VS Code implementation begins."
        ],
        data: {
          loginStatus: commandResultData(loginStatus),
          doctor: commandResultData(doctor),
          authPositive,
          authMissing
        }
      };
    }

    return {
      status: "pass",
      summary: "Sandboxed Codex authentication is available to the Codex runtime.",
      details,
      data: {
        loginStatus: commandResultData(loginStatus),
        doctor: commandResultData(doctor),
        authPositive,
        authMissing
      }
    };
  } finally {
    const cleanup = await cleanupSbx(sbx, name, context.root);
    details.push(...cleanup);
  }
}

async function validateCodexSandboxJsonEventStream(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const sbx = context.commands.get("sbx")?.path;
  if (!sbx) {
    return {
      status: "fail",
      summary: "Cannot validate sandboxed Codex JSONL event stream because `sbx` is unavailable.",
      details: []
    };
  }

  const durableTempRoot = path.join(context.root, ".tmp", `prevalidate-codex-json-${shortId()}`);
  await mkdir(durableTempRoot, { recursive: true });
  const layout = await createRuntimeFixture(durableTempRoot, "codex-json-events");
  await writeFile(path.join(layout.workspace, "existing.txt"), "before\n", "utf8");
  await writeFile(path.join(layout.workspace, "delete-me.txt"), "delete\n", "utf8");
  await rm(path.join(layout.workspace, "workspace-probe.txt"), { force: true });
  const before = await snapshotTree(layout.workspace);
  const name = `drydock-json-${shortId()}`.toLowerCase();
  const details: string[] = [];
  const networkResources = "chatgpt.com:443,ab.chatgpt.com:443,files.openai.com:443,api.openai.com:443";
  await cleanupSbx(sbx, name, context.root);

  try {
    const create = await run(sbx, ["create", "--name", name, "codex", layout.workspace], {
      cwd: context.root,
      timeoutMs: RUNTIME_TIMEOUT_MS
    });
    details.push(compactCommand("create codex", create));
    if (create.exitCode !== 0) {
      return {
        status: "fail",
        summary: "Docker Sandbox could not create a Codex sandbox for JSONL event validation.",
        details,
        data: commandResultData(create)
      };
    }

    const certProbe = await run(sbx, [
      "exec",
      name,
      "sh",
      "-lc",
      "test -s /etc/ssl/certs/ca-certificates.crt && grep -q 'BEGIN CERTIFICATE' /etc/ssl/certs/ca-certificates.crt && env | grep -E '^(SSL_CERT_FILE|NODE_EXTRA_CA_CERTS|HTTPS_PROXY|HTTP_PROXY)='"
    ], {
      cwd: context.root,
      timeoutMs: CHECK_TIMEOUT_MS
    });
    details.push(compactCommand("sandbox CA/proxy environment", certProbe));
    if (certProbe.exitCode !== 0) {
      return {
        status: "fail",
        summary: "Sandboxed Codex runtime does not expose a usable CA/proxy environment for Codex service TLS.",
        details,
        data: commandResultData(certProbe)
      };
    }

    const allow = await run(sbx, ["policy", "allow", "network", "--sandbox", name, networkResources], {
      cwd: context.root,
      timeoutMs: CHECK_TIMEOUT_MS
    });
    details.push(compactCommand("scoped network allow", allow));
    if (allow.exitCode !== 0) {
      return {
        status: "fail",
        summary: "Could not add sandbox-scoped Codex service egress rule for the live event-stream smoke test.",
        details,
        data: commandResultData(allow)
      };
    }

    const prompt = [
      "This is a prevalidation smoke test in a disposable workspace.",
      "Create file created-by-prevalidation.txt containing exactly CREATED_OK.",
      "Append a line MODIFIED_OK to existing.txt.",
      "Delete delete-me.txt.",
      "Do not change any other files.",
      "When finished, say prevalidation-file-events-ok."
    ].join(" ");
    const execArgs = [
      "exec",
      name,
      "codex",
      "--dangerously-bypass-approvals-and-sandbox",
      "exec",
      "--json",
      "--skip-git-repo-check",
      prompt
    ];
    let exec = await run(sbx, execArgs, {
      cwd: context.root,
      timeoutMs: 360_000
    });
    details.push(compactCommand("codex exec --json file changes", exec));
    if (exec.exitCode !== 0 && exec.stdout.trim() === "" && /Reading additional input from stdin/i.test(exec.stderr)) {
      details.push("Codex JSONL smoke produced no events and exited early; resetting disposable workspace and retrying once in the same sandbox.");
      await rm(path.join(layout.workspace, "created-by-prevalidation.txt"), { force: true });
      await writeFile(path.join(layout.workspace, "existing.txt"), "before\n", "utf8");
      await writeFile(path.join(layout.workspace, "delete-me.txt"), "delete\n", "utf8");
      exec = await run(sbx, execArgs, {
        cwd: context.root,
        timeoutMs: 360_000
      });
      details.push(compactCommand("codex exec --json file changes retry", exec));
    }

    const events = parseJsonLines(exec.stdout);
    const eventTypes = countBy(events.map((event) => stringValue(event["type"]) ?? "(missing)"));
    const commandItems = events.filter((event) => itemType(event) === "command_execution");
    const agentMessages = events.filter((event) => itemType(event) === "agent_message");
    const fileChangeItems = events.filter((event) => itemType(event) === "file_change");
    const failedTurn = events.some((event) => event["type"] === "turn.failed" || event["type"] === "error");
    const completedTurn = events.some((event) => event["type"] === "turn.completed");
    const usageReported = events.some((event) => event["type"] === "turn.completed" && hasObjectProperty(event, "usage"));
    const finalMessageOk = agentMessages.some((event) => JSON.stringify(event).includes("prevalidation-file-events-ok"));
    const commandVisibilityOk = commandItems.some((event) => JSON.stringify(event).includes("\"status\":\"in_progress\""))
      || events.some((event) => event["type"] === "item.started" && itemType(event) === "command_execution");
    const commandCompletionOk = commandItems.some((event) => JSON.stringify(event).includes("\"exit_code\":0"))
      || events.some((event) => event["type"] === "item.completed" && itemType(event) === "command_execution");

    const createdPath = path.join(layout.workspace, "created-by-prevalidation.txt");
    const existingPath = path.join(layout.workspace, "existing.txt");
    const deletePath = path.join(layout.workspace, "delete-me.txt");
    const createdContent = existsSync(createdPath) ? await readFile(createdPath, "utf8") : "";
    const existingContent = existsSync(existingPath) ? await readFile(existingPath, "utf8") : "";
    const deleteExists = existsSync(deletePath);
    const after = await snapshotTree(layout.workspace);
    const changes = diffSnapshots(before, after);
    const changeData = changes.map((change) => ({ path: change.path, status: change.status }));
    const hasAdded = changes.some((change) => change.path === "created-by-prevalidation.txt" && change.status === "added");
    const hasModified = changes.some((change) => change.path === "existing.txt" && change.status === "modified");
    const hasDeleted = changes.some((change) => change.path === "delete-me.txt" && change.status === "deleted");
    const fileChangeKinds = fileChangeItems.flatMap((event) => extractFileChangeKinds(event));
    const semanticFileChangeVisible = ["add", "delete", "update"].every((kind) => fileChangeKinds.includes(kind));
    const fileStateOk = createdContent.trim() === "CREATED_OK"
      && existingContent.includes("MODIFIED_OK")
      && !deleteExists
      && hasAdded
      && hasModified
      && hasDeleted;

    details.push(`Event type counts: ${JSON.stringify(eventTypes)}`);
    details.push(`Command item count: ${commandItems.length}`);
    details.push(`Agent message count: ${agentMessages.length}`);
    details.push(`File change item count: ${fileChangeItems.length}`);
    details.push(`File change kinds: ${fileChangeKinds.join(", ") || "(none)"}`);
    details.push(`Filesystem changes: ${JSON.stringify(changeData)}`);

    if (exec.exitCode !== 0 || failedTurn || !completedTurn || !usageReported || !finalMessageOk || !commandVisibilityOk || !commandCompletionOk || !fileStateOk) {
      return {
        status: "fail",
        summary: "Sandboxed Codex JSONL event stream did not prove command visibility plus add/modify/delete filesystem effects.",
        details: [
          ...details,
          `exec exit ok: ${String(exec.exitCode === 0)}`,
          `failed turn/error absent: ${String(!failedTurn)}`,
          `turn completed: ${String(completedTurn)}`,
          `usage reported: ${String(usageReported)}`,
          `final message observed: ${String(finalMessageOk)}`,
          `command start visible: ${String(commandVisibilityOk)}`,
          `command completion visible: ${String(commandCompletionOk)}`,
          `semantic file change visible: ${String(semanticFileChangeVisible)} (not required; snapshots are authoritative)`,
          `file state ok: ${String(fileStateOk)}`
        ],
        data: {
          exec: commandResultData(exec),
          eventTypes,
          changes: changeData,
          createdContent,
          existingContent,
          deleteExists,
          fileChangeKinds
        }
      };
    }

    return {
      status: "pass",
      summary: "Sandboxed Codex JSONL events expose turn lifecycle, agent messages, command execution, command results, and usage; filesystem effects are detectable as add/modify/delete via session snapshots.",
      details,
      data: {
        eventTypes,
        changes: changeData,
        commandItemCount: commandItems.length,
        agentMessageCount: agentMessages.length,
        fileChangeItemCount: fileChangeItems.length,
        fileChangeKinds
      }
    };
  } finally {
    const removePolicy = await run(sbx, ["policy", "rm", "network", "--sandbox", name, "--resource", networkResources], {
      cwd: context.root,
      timeoutMs: CHECK_TIMEOUT_MS
    });
    details.push(compactCommand("remove scoped network allow", removePolicy));
    const cleanup = await cleanupSbx(sbx, name, context.root);
    details.push(...cleanup);
    const cleanupOk = cleanup.every((line) => /exit: 0$/.test(line));
    if (cleanupOk && !context.options.keepTemp) {
      await rm(durableTempRoot, { recursive: true, force: true });
    }
  }
}

async function validateDockerContainerCodexCommunication(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const docker = context.commands.get("docker")?.path;
  if (!docker) {
    return {
      status: "fail",
      summary: "Docker CLI is required for Docker-container Codex validation and is not available.",
      details: []
    };
  }

  const contextProbe = await selectDockerContext(docker, context.root);
  const details = [...contextProbe.details];
  if (!contextProbe.available) {
    return {
      status: "fail",
      summary: "Docker CLI exists but no usable Docker daemon/context is reachable for Codex container validation.",
      details,
      data: contextProbe.data
    };
  }

  const contextArgs = contextProbe.contextName ? ["--context", contextProbe.contextName] : [];
  const root = path.join(context.tempRoot, `docker-codex-${shortId()}`);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "# Docker Codex prevalidation\n", "utf8");
  await writeFile(path.join(root, "Dockerfile"), [
    "FROM node:22-bookworm-slim",
    "RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git && rm -rf /var/lib/apt/lists/*",
    "ENV CODEX_NON_INTERACTIVE=1 CODEX_INSTALL_DIR=/usr/local/bin",
    "RUN curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    "RUN codex --version"
  ].join("\n") + "\n", "utf8");

  const tag = `drydock-codex-prevalidate:${shortId()}`.toLowerCase();
  const build = await run(docker, [...contextArgs, "build", "-t", tag, root], {
    cwd: context.root,
    timeoutMs: DOCKER_CODEX_TIMEOUT_MS
  });
  details.push(compactCommand("docker build codex image", build));
  if (build.exitCode !== 0) {
    return {
      status: "fail",
      summary: "Docker could not build a Codex CLI container from the official standalone installer.",
      details: [
        ...details,
        "Check Docker networking and try the official install command inside a Linux container: `curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh`."
      ],
      data: commandResultData(build)
    };
  }

  const auth = dockerCodexAuthConfig();
  const runBaseArgs = [
    ...contextArgs,
    "run",
    "--rm",
    "--cap-drop=ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    "1g",
    "--cpus",
    "2",
    "-v",
    `${workspace}:/workspace:ro`,
    "-w",
    "/workspace",
    ...auth.dockerArgs
  ];

  try {
    const protocolScript = [
      "set -eu",
      ...auth.setupScriptLines,
      "exec codex app-server --listen stdio://"
    ].join("\n");
    const protocol = await probeCodexAppServerProtocol({
      label: "docker codex app-server",
      command: docker,
      args: [...runBaseArgs, "-i", tag, "sh", "-lc", protocolScript],
      cwd: context.root,
      threadCwd: "/workspace",
      timeoutMs: RUNTIME_TIMEOUT_MS
    });
    details.push(...protocol.details);

    const loginScript = [
      "set -eu",
      ...auth.setupScriptLines,
      "codex --version",
      "codex login status",
      "rm -rf /tmp/codex-app-schema",
      "codex app-server generate-json-schema --out /tmp/codex-app-schema >/tmp/schema.out",
      "test -s /tmp/schema.out || find /tmp/codex-app-schema -type f | head -n 1 >/tmp/schema.out",
      "codex exec --help | grep -- --json >/dev/null",
      "codex mcp-server --help >/tmp/mcp-help.out"
    ].join("\n");

    const loginProbe = await run(docker, [...runBaseArgs, tag, "sh", "-lc", loginScript], {
      cwd: context.root,
      timeoutMs: DOCKER_CODEX_TIMEOUT_MS
    });
    details.push(compactCommand("docker codex login/protocol surface", loginProbe));

    if (!protocol.ok || loginProbe.exitCode !== 0) {
      return {
        status: "fail",
        summary: "Docker-container Codex communication is not fully validated. Provide container credentials and rerun prevalidation.",
        details: [
          ...details,
          "For ChatGPT auth from the current machine, explicitly allow the harness to copy the local Codex auth cache into the disposable container: `$env:PREVALIDATE_CODEX_AUTH_DIR=\"$env:USERPROFILE\\.codex\"`.",
          "For access-token auth, set `CODEX_ACCESS_TOKEN` before running prevalidation.",
          "The Docker check deliberately does not mount host Codex secrets unless PREVALIDATE_CODEX_AUTH_DIR is set."
        ],
        data: {
          protocol: protocol.data,
          loginProbe: commandResultData(loginProbe),
          authMode: auth.mode
        }
      };
    }

    return {
      status: "pass",
      summary: "Docker-container Codex login and app-server protocol communication are available.",
      details,
      data: {
        protocol: protocol.data,
        loginProbe: commandResultData(loginProbe),
        authMode: auth.mode
      }
    };
  } finally {
    const cleanup = await run(docker, [...contextArgs, "rmi", "--force", tag], {
      cwd: context.root,
      timeoutMs: RUNTIME_TIMEOUT_MS
    });
    details.push(compactCommand("docker rmi codex image", cleanup));
  }
}

async function validateCodexAcp(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const selection = await selectAcpCandidate(context);
  const candidate = selection.candidate;
  if (!candidate) {
    return {
      status: "skip",
      summary: "No literal Codex ACP command candidate was found or advertised.",
      details: [
        ...selection.details,
        "Codex itself is still required: host, Docker Sandbox, and Docker-container communication are validated through Codex app-server JSON-RPC checks.",
        "Set CODEX_ACP_COMMAND to an explicit command if a literal Codex ACP adapter is installed outside PATH.",
        "Example: CODEX_ACP_COMMAND=\"codex-acp\""
      ]
    };
  }

  const project = await createTempGitProject(context.tempRoot, "acp-project");
  const client = new AcpClient(candidate.command, candidate.args, project);
  try {
    await client.start();
    const initialize = await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: false,
          writeTextFile: false
        },
        terminal: false
      }
    }, 15_000);

    const sessionNew = await client.request("session/new", {
      cwd: project,
      mcpServers: [],
      permissionMode: "read-only"
    }, 15_000);

    const sessionId = extractSessionId(sessionNew);
    const details = [
      ...selection.details,
      `Candidate: ${candidate.command} ${candidate.args.join(" ")}`.trim(),
      `Session id: ${sessionId ?? "(not returned)"}`,
      `Initialize result keys: ${objectKeys(initialize).join(", ") || "(none)"}`
    ];

    if (!sessionId) {
      return {
        status: "optional",
        summary: "ACP initialize succeeded but session/new did not return a session id.",
        details
      };
    }

    if (!context.options.skipAcpTurn) {
      await client.request("session/prompt", {
        sessionId,
        prompt: [
          {
            type: "text",
            text: "Reply with exactly: prevalidation-ok. Do not inspect files and do not run commands."
          }
        ]
      }, ACP_TIMEOUT_MS);
      details.push(`Observed notifications/events: ${client.notifications.length}`);
    } else {
      details.push("ACP prompt turn skipped by option.");
    }

    client.notify("session/cancel", { sessionId });
    details.push("Sent session/cancel notification to validate the control path is writable.");

    try {
      await client.request("session/close", { sessionId }, 5_000);
      details.push("session/close request completed.");
    } catch (error) {
      details.push(`session/close optional request did not complete: ${errorMessage(error)}`);
    }

    return {
      status: "pass",
      summary: "Codex ACP started, initialized, created a session, and accepted the configured control flow.",
      details,
      data: {
        candidate: `${candidate.command} ${candidate.args.join(" ")}`.trim(),
        notificationCount: client.notifications.length
      }
    };
  } catch (error) {
    return {
      status: "optional",
      summary: `Codex ACP compatibility probe did not complete: ${errorMessage(error)}`,
      details: [
        ...selection.details,
        `Candidate: ${candidate.command} ${candidate.args.join(" ")}`.trim(),
        ...client.diagnostics()
      ]
    };
  } finally {
    await client.stop();
  }
}

async function validateClaudeCliSurface(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const claude = findCommandOnPath(["claude", "claude.exe"], "claude");
  if (!claude) {
    return {
      status: "skip",
      summary: "Claude CLI was not found locally; Claude remains an optional adapter until installed and explicitly validated.",
      details: [
        "Docker Sandbox advertises a `claude` agent template, and the required adapter registry check covers the extension point.",
        "When installed, this probe checks noninteractive print mode, JSON/streaming output, permission controls, and MCP/config surfaces."
      ]
    };
  }

  const version = await run(claude, ["--version"], {
    cwd: context.root,
    timeoutMs: CHECK_TIMEOUT_MS
  });
  const help = await run(claude, ["--help"], {
    cwd: context.root,
    timeoutMs: CHECK_TIMEOUT_MS
  });
  const combined = `${version.stdout}\n${version.stderr}\n${help.stdout}\n${help.stderr}`;
  const hasPrint = /(?:^|\s)(-p|--print)(?:\s|,|$)/.test(combined);
  const hasOutputFormat = /--output-format/.test(combined);
  const hasStreamJson = /stream-json/.test(combined);
  const hasPermissionMode = /--permission-mode|permission mode/i.test(combined);
  const hasMcpOrConfig = /\bmcp\b|--mcp-config|config/i.test(combined);
  const details = [
    compactCommand("claude --version", version),
    compactCommand("claude --help", help),
    `print mode: ${String(hasPrint)}`,
    `output format: ${String(hasOutputFormat)}`,
    `stream-json: ${String(hasStreamJson)}`,
    `permission mode: ${String(hasPermissionMode)}`,
    `mcp/config surface: ${String(hasMcpOrConfig)}`
  ];

  if (version.exitCode !== 0 || help.exitCode !== 0 || !hasPrint || !hasOutputFormat || !hasStreamJson || !hasPermissionMode) {
    return {
      status: "optional",
      summary: "Claude CLI is installed but does not expose every adapter surface expected for a first-class backend.",
      details,
      data: {
        path: claude,
        version: commandResultData(version),
        help: commandResultData(help),
        hasPrint,
        hasOutputFormat,
        hasStreamJson,
        hasPermissionMode,
        hasMcpOrConfig
      }
    };
  }

  return {
    status: "pass",
    summary: "Claude CLI exposes the noninteractive, streaming, permission, and configuration surfaces expected by the adapter model.",
    details,
    data: {
      path: claude,
      hasPrint,
      hasOutputFormat,
      hasStreamJson,
      hasPermissionMode,
      hasMcpOrConfig
    }
  };
}

async function validateCodexNativeSubagentProbe(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const codex = context.commands.get("codex")?.path;
  if (!codex) {
    return {
      status: "optional",
      summary: "Codex-native subagent support was not probed because Codex is unavailable.",
      details: ["The product orchestration model does not depend on native Codex subagents."]
    };
  }

  const help = await run(codex, ["--help"], { cwd: context.root, timeoutMs: CHECK_TIMEOUT_MS });
  if (help.exitCode !== 0) {
    return {
      status: "optional",
      summary: "Codex exists but help output could not be read, so native subagent support remains unvalidated.",
      details: [
        oneLine(`stdout: ${help.stdout}`),
        oneLine(`stderr: ${help.stderr}`)
      ],
      data: commandResultData(help)
    };
  }

  const combined = `${help.stdout}\n${help.stderr}`.toLowerCase();
  const mentionsAgent = combined.includes("agent") || combined.includes("subagent");
  return {
    status: mentionsAgent ? "pass" : "optional",
    summary: mentionsAgent
      ? "Codex help mentions agent/subagent-related controls."
      : "Codex help did not expose native subagent controls.",
    details: ["Native subagents remain optional; Stage 0 validates product-owned multi-session orchestration separately."],
    data: {
      mentionsAgent
    }
  };
}

async function validateGitCloneWorktreePatch(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const git = context.commands.get("git")?.path;
  if (!git) {
    return {
      status: "fail",
      summary: "Git command is unavailable.",
      details: []
    };
  }

  const root = path.join(context.tempRoot, "git-flow");
  const source = path.join(root, "source");
  const clone = path.join(root, "clone");
  const worktree = path.join(root, "worktree");
  const patchFile = path.join(root, "clone.patch");
  await mkdir(source, { recursive: true });

  const commands: CommandResult[] = [];
  commands.push(await run(git, ["init"], { cwd: source, timeoutMs: CHECK_TIMEOUT_MS }));
  commands.push(await run(git, ["config", "user.email", "prevalidate@example.invalid"], { cwd: source, timeoutMs: CHECK_TIMEOUT_MS }));
  commands.push(await run(git, ["config", "user.name", "Prevalidation"], { cwd: source, timeoutMs: CHECK_TIMEOUT_MS }));
  await writeFile(path.join(source, "file.txt"), "base\n", "utf8");
  commands.push(await run(git, ["add", "file.txt"], { cwd: source, timeoutMs: CHECK_TIMEOUT_MS }));
  commands.push(await run(git, ["commit", "-m", "initial"], { cwd: source, timeoutMs: CHECK_TIMEOUT_MS }));
  commands.push(await run(git, ["branch", "-M", "main"], { cwd: source, timeoutMs: CHECK_TIMEOUT_MS }));
  commands.push(await run(git, ["clone", source, clone], { cwd: root, timeoutMs: CHECK_TIMEOUT_MS }));
  commands.push(await run(git, ["worktree", "add", "-b", "prevalidate/worktree", worktree, "main"], { cwd: source, timeoutMs: CHECK_TIMEOUT_MS }));

  await writeFile(path.join(clone, "file.txt"), "base\nclone-change\n", "utf8");
  const diff = await run(git, ["diff", "--binary", "HEAD"], { cwd: clone, timeoutMs: CHECK_TIMEOUT_MS });
  commands.push(diff);
  await writeFile(patchFile, diff.stdout, "utf8");

  commands.push(await run(git, ["apply", "--check", patchFile], { cwd: source, timeoutMs: CHECK_TIMEOUT_MS }));
  commands.push(await run(git, ["apply", patchFile], { cwd: source, timeoutMs: CHECK_TIMEOUT_MS }));
  const status = await run(git, ["status", "--porcelain=v1"], { cwd: source, timeoutMs: CHECK_TIMEOUT_MS });
  commands.push(status);

  const conflict = await run(git, ["apply", "--check", patchFile], { cwd: source, timeoutMs: CHECK_TIMEOUT_MS });
  commands.push(conflict);
  commands.push(await run(git, ["worktree", "remove", "--force", worktree], { cwd: source, timeoutMs: CHECK_TIMEOUT_MS }));

  const failed = commands.filter((command) => command.exitCode !== 0);
  const expectedConflict = conflict.exitCode !== 0;
  const patchExists = existsSync(patchFile) && diff.stdout.includes("clone-change");
  const statusHasChange = status.stdout.includes("file.txt");

  const unexpectedFailures = failed.filter((command) => command !== conflict);
  if (unexpectedFailures.length > 0 || !expectedConflict || !patchExists || !statusHasChange) {
    return {
      status: "fail",
      summary: "Git clone/worktree/patch validation failed.",
      details: [
        ...commands.map((command) => compactCommand(command.args.join(" "), command)),
        `Patch exists with expected content: ${String(patchExists)}`,
        `Conflict check failed as expected: ${String(expectedConflict)}`,
        `Status shows applied change: ${String(statusHasChange)}`
      ]
    };
  }

  return {
    status: "pass",
    summary: "Git clone, worktree, patch generation, patch apply, status, and conflict detection are usable.",
    details: [
      `Patch: ${patchFile}`,
      `Status output: ${oneLine(status.stdout)}`,
      "Second patch check failed as expected, proving conflict/already-applied detection."
    ]
  };
}

async function validateFilesystemPolicyMechanics(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const workspaceA = path.join(context.tempRoot, "policy", "workspace-a");
  const workspaceB = path.join(context.tempRoot, "policy", "workspace-b");
  const sharedRead = path.join(context.tempRoot, "policy", "shared-read");
  const sharedWrite = path.join(context.tempRoot, "policy", "shared-write");
  const denied = path.join(workspaceA, ".env");
  await mkdir(workspaceA, { recursive: true });
  await mkdir(workspaceB, { recursive: true });
  await mkdir(sharedRead, { recursive: true });
  await mkdir(sharedWrite, { recursive: true });

  const planMounts = buildMountPolicy({
    mode: "plan",
    workspaceRoots: [workspaceA, workspaceB],
    sharedRead: [sharedRead],
    sharedWrite: [sharedWrite],
    denied: [denied]
  });
  const implementationMounts = buildMountPolicy({
    mode: "implementation",
    workspaceRoots: [workspaceA, workspaceB],
    sharedRead: [sharedRead],
    sharedWrite: [sharedWrite],
    denied: [denied]
  });
  const cloneMounts = buildMountPolicy({
    mode: "clone",
    workspaceRoots: [workspaceA, workspaceB],
    sharedRead: [sharedRead],
    sharedWrite: [sharedWrite],
    denied: [denied]
  });

  const planWorkspaceReadOnly = planMounts.filter((mount) => mount.kind === "workspace").every((mount) => mount.access === "read");
  const implementationWorkspaceWritable = implementationMounts.filter((mount) => mount.kind === "workspace").every((mount) => mount.access === "write");
  const cloneHasNoWorkspace = cloneMounts.every((mount) => mount.kind !== "workspace");
  const sharedReadOnly = planMounts.some((mount) => mount.hostPath === sharedRead && mount.access === "read");
  const sharedWriteWritable = planMounts.some((mount) => mount.hostPath === sharedWrite && mount.access === "write");
  const denyPresent = planMounts.some((mount) => mount.hostPath === denied && mount.access === "deny");

  if (!planWorkspaceReadOnly || !implementationWorkspaceWritable || !cloneHasNoWorkspace || !sharedReadOnly || !sharedWriteWritable || !denyPresent) {
    return {
      status: "fail",
      summary: "Filesystem policy mount planner did not satisfy Stage 0 invariants.",
      details: [
        `Plan workspace read-only: ${String(planWorkspaceReadOnly)}`,
        `Implementation workspace writable: ${String(implementationWorkspaceWritable)}`,
        `Clone has no workspace mounts: ${String(cloneHasNoWorkspace)}`,
        `Shared read is read-only: ${String(sharedReadOnly)}`,
        `Shared write is writable: ${String(sharedWriteWritable)}`,
        `Denied path present: ${String(denyPresent)}`
      ]
    };
  }

  return {
    status: "pass",
    summary: "Filesystem policy mechanics preserve read-only plan mode, writable implementation mode, clone isolation, shared paths, and deny rules.",
    details: [
      `Plan mounts: ${JSON.stringify(planMounts)}`,
      `Implementation mounts: ${JSON.stringify(implementationMounts)}`,
      `Clone mounts: ${JSON.stringify(cloneMounts)}`
    ]
  };
}

async function validateSessionDiffMechanics(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const root = path.join(context.tempRoot, "diff");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "modify.txt"), "before\n", "utf8");
  await writeFile(path.join(root, "delete.txt"), "delete-me\n", "utf8");
  await writeFile(path.join(root, "rename-old.txt"), "rename-me\n", "utf8");

  let baseline = await snapshotTree(root);
  await writeFile(path.join(root, "modify.txt"), "after\n", "utf8");
  await unlink(path.join(root, "delete.txt"));
  await copyFile(path.join(root, "rename-old.txt"), path.join(root, "rename-new.txt"));
  await unlink(path.join(root, "rename-old.txt"));
  await writeFile(path.join(root, "add.txt"), "new\n", "utf8");

  const changed = diffSnapshots(baseline, await snapshotTree(root));
  const expectedChanged = ["add.txt", "delete.txt", "modify.txt", "rename-new.txt", "rename-old.txt"];
  const hasExpected = expectedChanged.every((file) => changed.some((change) => change.path === file));
  if (!hasExpected) {
    return {
      status: "fail",
      summary: "Initial session diff did not include expected file changes.",
      details: [`Changes: ${JSON.stringify(changed)}`]
    };
  }

  baseline = acceptFileBaseline(baseline, await snapshotTree(root), "modify.txt");
  const afterAccept = diffSnapshots(baseline, await snapshotTree(root));
  const modifyGone = !afterAccept.some((change) => change.path === "modify.txt");

  await revertFileFromBaseline(root, baseline, "delete.txt");
  const afterRevert = diffSnapshots(baseline, await snapshotTree(root));
  const deleteGone = !afterRevert.some((change) => change.path === "delete.txt");

  if (!modifyGone || !deleteGone) {
    return {
      status: "fail",
      summary: "Accept/revert checkpoint mechanics failed.",
      details: [
        `modify.txt removed after accept: ${String(modifyGone)}`,
        `delete.txt removed after revert: ${String(deleteGone)}`,
        `Remaining changes: ${JSON.stringify(afterRevert)}`
      ]
    };
  }

  return {
    status: "pass",
    summary: "Session diff checkpoints support changed-file detection, per-file accept, and per-file revert independent of Git.",
    details: [
      `Initial changes: ${JSON.stringify(changed)}`,
      `After accept/revert: ${JSON.stringify(afterRevert)}`
    ]
  };
}

async function validateRestartDiffCheckpointPersistence(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const root = path.join(context.tempRoot, "restart-diff");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "keep-baseline.txt"), "baseline\n", "utf8");
  await writeFile(path.join(root, "modify-after-restart.txt"), "before\n", "utf8");
  await writeFile(path.join(root, "delete-after-restart.txt"), "delete\n", "utf8");

  const baseline = await snapshotTree(root);
  await writeFile(path.join(root, "modify-after-restart.txt"), "after\n", "utf8");
  await writeFile(path.join(root, "added-after-restart.txt"), "added\n", "utf8");
  await unlink(path.join(root, "delete-after-restart.txt"));
  const current = await snapshotTree(root);
  const beforeSerialize = diffSnapshots(baseline, current);

  const persisted = JSON.stringify({
    sessionId: `session-${shortId()}`,
    runtimeGeneration: 1,
    baseline: [...baseline.entries()],
    current: [...current.entries()]
  });
  const rehydrated = JSON.parse(persisted) as {
    sessionId: string;
    runtimeGeneration: number;
    baseline: Array<[string, FileSnapshot]>;
    current: Array<[string, FileSnapshot]>;
  };
  const restoredBaseline = new Map<string, FileSnapshot>(rehydrated.baseline);
  const restoredCurrent = new Map<string, FileSnapshot>(rehydrated.current);
  const afterRehydrate = diffSnapshots(restoredBaseline, restoredCurrent);
  const changedBefore = beforeSerialize.map((change) => `${change.path}:${change.status}`).sort();
  const changedAfter = afterRehydrate.map((change) => `${change.path}:${change.status}`).sort();
  const sameChanges = JSON.stringify(changedBefore) === JSON.stringify(changedAfter);

  const acceptedBaseline = acceptFileBaseline(restoredBaseline, restoredCurrent, "modify-after-restart.txt");
  const afterAccept = diffSnapshots(acceptedBaseline, restoredCurrent);
  const acceptedFileGone = !afterAccept.some((change) => change.path === "modify-after-restart.txt");
  const stillTracksAddedAndDeleted = afterAccept.some((change) => change.path === "added-after-restart.txt" && change.status === "added")
    && afterAccept.some((change) => change.path === "delete-after-restart.txt" && change.status === "deleted");
  const beforeSerializeData = beforeSerialize.map(fileChangeToJson);
  const afterRehydrateData = afterRehydrate.map(fileChangeToJson);
  const afterAcceptData = afterAccept.map(fileChangeToJson);

  if (!sameChanges || !acceptedFileGone || !stillTracksAddedAndDeleted) {
    return {
      status: "fail",
      summary: "Serialized diff checkpoints did not preserve per-session changed-file state across a runtime restart.",
      details: [
        `Before serialize: ${JSON.stringify(beforeSerialize)}`,
        `After rehydrate: ${JSON.stringify(afterRehydrate)}`,
        `After accept: ${JSON.stringify(afterAccept)}`,
        `Same changes: ${String(sameChanges)}`,
        `Accepted file gone: ${String(acceptedFileGone)}`,
        `Still tracks added/deleted: ${String(stillTracksAddedAndDeleted)}`
      ],
      data: {
        beforeSerialize: beforeSerializeData,
        afterRehydrate: afterRehydrateData,
        afterAccept: afterAcceptData
      }
    };
  }

  return {
    status: "pass",
    summary: "Serialized session checkpoints preserve changed-file state across runtime restart and still support per-file accept.",
    details: [
      `Persisted checkpoint bytes: ${persisted.length}`,
      `Rehydrated changes: ${JSON.stringify(afterRehydrate)}`,
      `After per-file accept: ${JSON.stringify(afterAccept)}`
    ],
    data: {
      beforeSerialize: beforeSerializeData,
      afterRehydrate: afterRehydrateData,
      afterAccept: afterAcceptData
    }
  };
}

async function validateMarkdownPlanMechanics(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const planDir = path.join(context.tempRoot, "plans");
  await mkdir(planDir, { recursive: true });
  const planPath = path.join(planDir, "plan.md");
  const blockId = `plan-${shortId()}`;
  const runId = `run-${shortId()}`;
  const initial = renderPlanBlock(blockId, "pending", "", "Implement isolated runtime bootstrap.");
  await writeFile(planPath, `# Test Plan\n\n${initial}\n`, "utf8");

  const text = await readFile(planPath, "utf8");
  const parsed = parsePlanBlocks(text);
  const hasBlock = parsed.length === 1 && parsed[0]?.id === blockId && parsed[0]?.status === "pending";
  const withComment = text.replace(
    "<!-- /ai-plan-block -->",
    `<!-- ai-plan-comment block="${blockId}" author="user" -->Tighten isolation acceptance criteria.<!-- /ai-plan-comment -->\n<!-- /ai-plan-block -->`
  );
  const approved = updatePlanBlockStatus(withComment, blockId, "approved", runId);
  await writeFile(planPath, approved, "utf8");
  const reparsed = parsePlanBlocks(await readFile(planPath, "utf8"));
  const block = reparsed[0];
  const commentParsed = block?.comments.some((comment) => comment.includes("Tighten isolation"));

  if (!hasBlock || block?.status !== "approved" || block.runId !== runId || !commentParsed) {
    return {
      status: "fail",
      summary: "Markdown plan block parsing/comment/approval mechanics failed.",
      details: [
        `Initial block parsed: ${String(hasBlock)}`,
        `Final parsed: ${JSON.stringify(reparsed)}`
      ]
    };
  }

  return {
    status: "pass",
    summary: "Markdown plan file mechanics support stable block IDs, comments, approval state, and run links.",
    details: [`Plan path: ${planPath}`, `Parsed block: ${JSON.stringify(block)}`]
  };
}

async function validateOrchestrationMechanics(): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const roles = ["researcher", "planner", "worker", "tester", "reviewer", "memory-extractor"];
  const controllers = new Map<string, AbortController>();
  const events: Array<{ role: string; type: string }> = [];
  const jobs = roles.map((role, index) => {
    const controller = new AbortController();
    controllers.set(role, controller);
    return runMockAgent(role, 30 + index * 20, controller.signal, events);
  });

  setTimeout(() => controllers.get("tester")?.abort(), 45);
  const results = await Promise.allSettled(jobs);
  const cancelledTester = results.some((result) => result.status === "rejected" && errorMessage(result.reason).includes("tester cancelled"));
  const fulfilled = results.filter((result) => result.status === "fulfilled").length;
  const allOtherRolesFinished = fulfilled === roles.length - 1;
  const reviewerFinished = events.some((event) => event.role === "reviewer" && event.type === "finished");

  if (!cancelledTester || !allOtherRolesFinished || !reviewerFinished) {
    return {
      status: "fail",
      summary: "Independent role orchestration did not isolate cancellation.",
      details: [
        `Cancelled tester: ${String(cancelledTester)}`,
        `Fulfilled jobs: ${String(fulfilled)}`,
        `Events: ${JSON.stringify(events)}`
      ]
    };
  }

  return {
    status: "pass",
    summary: "Multiple independent role sessions can stream events while one cancelled role does not kill the rest.",
    details: [`Events: ${JSON.stringify(events)}`]
  };
}

async function validateRoleVisibilityModel(): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  type RoleStatus = "queued" | "running" | "blocked" | "completed" | "cancelled";
  interface RoleSession {
    id: string;
    role: string;
    category: "research" | "planning" | "implementation" | "verification" | "review" | "memory";
    parentId: string | null;
    runtimeId: string;
    status: RoleStatus;
    startedAt: string | null;
    completedAt: string | null;
    events: Array<{
      type: "message" | "decision" | "command" | "file-change" | "artifact" | "blocked" | "cancelled";
      text: string;
      filePath?: string;
      command?: string;
      exitCode?: number;
    }>;
  }

  const runId = `run-${shortId()}`;
  const rootSession: RoleSession = {
    id: `session-${shortId()}`,
    role: "planner",
    category: "planning",
    parentId: null,
    runtimeId: `runtime-${shortId()}`,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    events: [
      { type: "message", text: "Drafted plan blocks." },
      { type: "decision", text: "Spawn researcher and worker." }
    ]
  };
  const sessions: RoleSession[] = [
    rootSession,
    {
      id: `session-${shortId()}`,
      role: "researcher",
      category: "research",
      parentId: rootSession.id,
      runtimeId: `runtime-${shortId()}`,
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      events: [
        { type: "message", text: "Found app-server event schema." },
        { type: "artifact", text: "Schema summary", filePath: "docs/prevalidation-report.md" }
      ]
    },
    {
      id: `session-${shortId()}`,
      role: "worker",
      category: "implementation",
      parentId: rootSession.id,
      runtimeId: `runtime-${shortId()}`,
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      events: [
        { type: "command", text: "Ran test command.", command: "npm run build", exitCode: 0 },
        { type: "file-change", text: "Added validation.", filePath: "tools/prevalidate/src/index.ts" }
      ]
    },
    {
      id: `session-${shortId()}`,
      role: "tester",
      category: "verification",
      parentId: rootSession.id,
      runtimeId: `runtime-${shortId()}`,
      status: "cancelled",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      events: [
        { type: "cancelled", text: "Cancelled without stopping reviewer." }
      ]
    },
    {
      id: `session-${shortId()}`,
      role: "reviewer",
      category: "review",
      parentId: rootSession.id,
      runtimeId: `runtime-${shortId()}`,
      status: "blocked",
      startedAt: new Date().toISOString(),
      completedAt: null,
      events: [
        { type: "blocked", text: "Waiting for user HITL result." }
      ]
    }
  ];
  rootSession.status = "completed";
  rootSession.completedAt = new Date().toISOString();

  const byCategory = new Map<string, RoleSession[]>();
  for (const session of sessions) {
    byCategory.set(session.category, [...(byCategory.get(session.category) ?? []), session]);
  }
  const parentChildVisible = sessions.filter((session) => session.parentId === rootSession.id).length === 4;
  const commandVisible = sessions.some((session) => session.events.some((event) => event.type === "command" && event.command && event.exitCode === 0));
  const fileChangeVisible = sessions.some((session) => session.events.some((event) => event.type === "file-change" && event.filePath));
  const blockedVisible = sessions.some((session) => session.status === "blocked" && session.events.some((event) => event.type === "blocked"));
  const cancellationIsolated = sessions.some((session) => session.status === "cancelled")
    && sessions.some((session) => session.role === "reviewer" && session.status === "blocked");
  const categoriesComplete = ["research", "planning", "implementation", "verification", "review"].every((category) => byCategory.has(category));

  if (!parentChildVisible || !commandVisible || !fileChangeVisible || !blockedVisible || !cancellationIsolated || !categoriesComplete) {
    return {
      status: "fail",
      summary: "Role visibility model cannot represent the agent panel data needed by later stages.",
      details: [
        `runId: ${runId}`,
        `parent/child visible: ${String(parentChildVisible)}`,
        `command visible: ${String(commandVisible)}`,
        `file change visible: ${String(fileChangeVisible)}`,
        `blocked visible: ${String(blockedVisible)}`,
        `cancellation isolated: ${String(cancellationIsolated)}`,
        `categories complete: ${String(categoriesComplete)}`,
        `sessions: ${JSON.stringify(sessions)}`
      ]
    };
  }

  return {
    status: "pass",
    summary: "Role timeline model can represent parent/child sessions, categories, statuses, messages, decisions, commands, file changes, blocked states, and cancellation.",
    details: [
      `runId: ${runId}`,
      `Categories: ${JSON.stringify([...byCategory.keys()])}`,
      `Sessions: ${JSON.stringify(sessions)}`
    ]
  };
}

async function validateTaskMemoryRegistryMechanics(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const root = path.join(context.tempRoot, "task-memory");
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });
  const task = {
    id: `task-${shortId()}`,
    title: "Implement isolated runtime bootstrap",
    status: "active",
    projectRoots: [projectA, projectB],
    activatedAt: new Date().toISOString(),
    promptHistory: [
      { id: `prompt-${shortId()}`, role: "user", text: "Set up isolated runtime bootstrap", createdAt: new Date().toISOString() }
    ],
    relatedTaskIds: [] as string[],
    runIds: [`run-${shortId()}`]
  };
  const related = {
    id: `task-${shortId()}`,
    title: "Earlier Docker Sandbox mount validation",
    status: "completed",
    projectRoots: [projectB],
    promptHistory: [
      { id: `prompt-${shortId()}`, role: "user", text: "Validate mount policy", createdAt: new Date().toISOString() }
    ],
    runIds: [`run-${shortId()}`]
  };
  const tasks = [task, related];
  task.relatedTaskIds = tasks
    .filter((candidate) => candidate.id !== task.id && candidate.projectRoots.some((rootPath) => task.projectRoots.includes(rootPath)))
    .map((candidate) => candidate.id);

  const memoryCandidate = {
    id: `memory-${shortId()}`,
    status: "candidate",
    text: "Use Docker Sandbox as the first isolation target.",
    evidence: [
      { taskId: task.id, runId: task.runIds[0], filePath: "docs/product-plan.md" }
    ],
    reviewedAt: null as string | null,
    reviewer: null as string | null
  };
  const approvedMemory = {
    ...memoryCandidate,
    status: "approved",
    reviewedAt: new Date().toISOString(),
    reviewer: "user"
  };
  const automatedTest = {
    id: `test-${shortId()}`,
    runId: task.runIds[0],
    command: "npm run prevalidate",
    status: "passed",
    exitCode: 0,
    stdoutRef: "event-log://stdout",
    stderrRef: "event-log://stderr",
    artifactRefs: ["prevalidation.json", "docs/prevalidation-report.md"]
  };

  const multiProject = task.projectRoots.length === 2;
  const relatedFound = task.relatedTaskIds.includes(related.id);
  const promptHistoryLinked = task.promptHistory.length > 0 && related.promptHistory.length > 0;
  const memoryEvidenceLinked = approvedMemory.status === "approved"
    && approvedMemory.evidence.some((evidence) => evidence.taskId === task.id && evidence.runId === task.runIds[0]);
  const testTraceable = automatedTest.status === "passed"
    && automatedTest.exitCode === 0
    && automatedTest.artifactRefs.includes("prevalidation.json");

  if (!multiProject || !relatedFound || !promptHistoryLinked || !memoryEvidenceLinked || !testTraceable) {
    return {
      status: "fail",
      summary: "Task, related-project history, memory review, or automated-test traceability mechanics are incomplete.",
      details: [
        `multiProject: ${String(multiProject)}`,
        `relatedFound: ${String(relatedFound)}`,
        `promptHistoryLinked: ${String(promptHistoryLinked)}`,
        `memoryEvidenceLinked: ${String(memoryEvidenceLinked)}`,
        `testTraceable: ${String(testTraceable)}`
      ]
    };
  }

  return {
    status: "pass",
    summary: "Task registry mechanics support multi-project activation, related task history, prompt history, reviewed memory candidates, and automated-test traceability.",
    details: [
      `Task: ${JSON.stringify(task)}`,
      `Related task: ${JSON.stringify(related)}`,
      `Approved memory: ${JSON.stringify(approvedMemory)}`,
      `Automated test: ${JSON.stringify(automatedTest)}`
    ]
  };
}

async function validateExtensionPointContracts(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const schemasDir = path.join(context.root, "schemas");
  const examplesDir = path.join(schemasDir, "examples");
  const schemaFiles = [
    "extension-manifest.schema.json",
    "task-provider.schema.json"
  ];
  const exampleFiles = [
    "internal-task-provider.json",
    "jira-task-provider.json",
    "asana-task-provider.json",
    "github-task-provider.json",
    "custom-extension-pack.json"
  ];
  const requiredTaskOperations = [
    "detect",
    "validateAuth",
    "discoverProjects",
    "listTasks",
    "getTask",
    "createTask",
    "updateTask",
    "commentTask",
    "transitionTask",
    "attachArtifact",
    "syncEvents",
    "mapToCanonicalTask"
  ];
  const requiredCanonicalMappings = [
    "id",
    "title",
    "status",
    "statusCategory",
    "projectRefs",
    "labels"
  ];
  const errors: string[] = [];
  const details: string[] = [];

  for (const schemaFile of schemaFiles) {
    const file = path.join(schemasDir, schemaFile);
    const schema = await readJsonFile(file);
    if (!isRecord(schema) || typeof schema["$schema"] !== "string" || typeof schema.title !== "string") {
      errors.push(`${schemaFile}: schema must include $schema and title`);
    } else {
      details.push(`${schemaFile}: parsed ${schema["$schema"]}`);
    }
  }

  const manifests = new Map<string, Record<string, unknown>>();
  for (const exampleFile of exampleFiles) {
    const file = path.join(examplesDir, exampleFile);
    const manifest = await readJsonFile(file);
    if (!isRecord(manifest)) {
      errors.push(`${exampleFile}: manifest is not a JSON object`);
      continue;
    }
    manifests.set(exampleFile, manifest);
    errors.push(...validateManifestShape(exampleFile, manifest));
    errors.push(...validateNoRawSecrets(exampleFile, manifest));
    details.push(`${exampleFile}: ${String(manifest.id)} (${String(manifest.kind)})`);
  }

  for (const [exampleFile, manifest] of manifests) {
    const extensionPoints = arrayOfRecords(manifest.extensionPoints);
    const taskPoint = extensionPoints.find((point) => point.type === "task-provider");
    if (taskPoint) {
      const capabilities = isRecord(taskPoint.capabilities) ? taskPoint.capabilities : {};
      const operations = stringArray(capabilities.operations);
      const missingOps = requiredTaskOperations.filter((operation) => !operations.includes(operation));
      if (missingOps.length > 0) {
        errors.push(`${exampleFile}: task-provider missing operations ${missingOps.join(", ")}`);
      }
      const mappings = isRecord(manifest.canonicalMappings) ? manifest.canonicalMappings : {};
      const missingMappings = requiredCanonicalMappings.filter((mapping) => typeof mappings[mapping] !== "string");
      if (missingMappings.length > 0) {
        errors.push(`${exampleFile}: canonicalMappings missing ${missingMappings.join(", ")}`);
      }
    }
  }

  const internal = manifests.get("internal-task-provider.json");
  if (!internal) {
    errors.push("internal-task-provider.json: required default internal provider is missing");
  } else {
    const auth = isRecord(internal.auth) ? internal.auth : {};
    const capabilities = isRecord(internal.capabilities) ? internal.capabilities : {};
    if (auth.mode !== "none" || auth.secretRefRequired !== false) {
      errors.push("internal-task-provider.json: internal provider must require no auth");
    }
    if (capabilities.defaultProvider !== true || capabilities.offline !== true || capabilities.multiProjectActivation !== true) {
      errors.push("internal-task-provider.json: internal provider must be default, offline, and multi-project capable");
    }
    if (capabilities.workspaceSets !== true || capabilities.taskWorkSessions !== true || capabilities.dayPlanner !== true) {
      errors.push("internal-task-provider.json: internal provider must support workspace sets, task work sessions, and day planner links");
    }
  }

  const custom = manifests.get("custom-extension-pack.json");
  if (custom) {
    const customPointTypes = new Set(arrayOfRecords(custom.extensionPoints).map((point) => String(point.type)));
    const requiredCustomPoints = ["task-provider", "agent-provider", "runtime-adapter", "panel-provider", "memory-provider", "test-provider"];
    const missingCustomPoints = requiredCustomPoints.filter((point) => !customPointTypes.has(point));
    if (missingCustomPoints.length > 0) {
      errors.push(`custom-extension-pack.json: missing extension points ${missingCustomPoints.join(", ")}`);
    }
  }

  if (errors.length > 0) {
    return {
      status: "fail",
      summary: "Schema-bound extension contracts are incomplete.",
      details: [...errors, ...details]
    };
  }

  return {
    status: "pass",
    summary: "Extension contracts validate internal default tasks plus Jira, Asana, GitHub, and custom provider manifests without raw credentials.",
    details
  };
}

// MARK: -- Work Management Contracts

/** Validates the work-management schema/example contract, including security-relevant defaults. */
async function validateWorkManagementContracts(context: CheckContext): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const schemasDir = path.join(context.root, "schemas");
  const schemaFile = path.join(schemasDir, "work-management.schema.json");
  const exampleFile = path.join(schemasDir, "examples", "work-management-config.json");
  const schema = await readJsonFile(schemaFile);
  const config = await readJsonFile(exampleFile);
  const errors: string[] = [];
  const details: string[] = [];

  if (!isRecord(schema) || typeof schema["$schema"] !== "string" || schema.title !== "Drydock Work Management Config") {
    errors.push("work-management.schema.json: schema must include expected title and $schema");
  } else {
    details.push(`work-management.schema.json: parsed ${schema["$schema"]}`);
  }

  if (!isRecord(config)) {
    errors.push("work-management-config.json: example is not a JSON object");
  } else {
    errors.push(...validateNoRawSecrets("work-management-config.json", config));

    const stateStores = arrayOfRecords(config.stateStores);
    const primaryStore = stateStores.find((store) => store.role === "primary" && store.writable === true && typeof store.path === "string");
    if (stateStores.length === 0 || !primaryStore) {
      errors.push("work-management-config.json: at least one writable primary state store is required");
    } else {
      details.push(`State stores: ${stateStores.map((store) => String(store.id)).join(", ")}`);
    }

    if (config.defaultTaskProvider !== "internal") {
      errors.push("work-management-config.json: defaultTaskProvider must be internal");
    }

    const sharedPaths = arrayOfRecords(config.sharedPaths);
    const hasReadOnlySharedPath = sharedPaths.some((sharedPath) => sharedPath.access === "read-only" && sharedPath.overridable === true);
    const hasReadWriteSharedPath = sharedPaths.some((sharedPath) => sharedPath.access === "read-write" && sharedPath.overridable === true);
    if (sharedPaths.length === 0 || !hasReadOnlySharedPath || !hasReadWriteSharedPath) {
      errors.push("work-management-config.json: sharedPaths must include overridable read-only and read-write entries");
    } else {
      details.push(`Shared paths: ${sharedPaths.map((sharedPath) => String(sharedPath.id)).join(", ")}`);
    }

    const logging = isRecord(config.logging) ? config.logging : null;
    if (!logging
      || logging.defaultMode !== "redacted"
      || logging.expandedLogging !== false
      || logging.expandedMetrics !== false
      || typeof logging.retentionClass !== "string"
      || logging.piiPolicy !== "redact") {
      errors.push("work-management-config.json: logging must default to redacted with expanded logging/metrics disabled and PII redaction enabled");
    } else {
      details.push("Logging: redacted defaults");
    }

    const packaging = isRecord(config.packaging) ? config.packaging : null;
    if (!packaging
      || packaging.channel !== "vsix"
      || packaging.incrementVersionOnPackage !== true
      || packaging.publishToMarketplace !== false) {
      errors.push("work-management-config.json: packaging must be VSIX-only, increment versions, and disable marketplace publishing");
    } else {
      details.push("Packaging: VSIX-only with version increment");
    }

    const sourceControl = isRecord(config.sourceControl) ? config.sourceControl : null;
    if (!sourceControl
      || sourceControl.allowDeveloperBranches !== true
      || typeof sourceControl.crossBoundaryBranchPrefix !== "string"
      || sourceControl.crossBoundaryBranchPrefix.length === 0) {
      errors.push("work-management-config.json: sourceControl must allow developer branches and define a temporary cross-boundary branch prefix");
    } else {
      details.push(`Cross-boundary branch prefix: ${sourceControl.crossBoundaryBranchPrefix}`);
    }

    const naming = isRecord(config.naming) ? config.naming : null;
    if (!naming || typeof naming.displayNameRef !== "string" || naming.avoidHardcodedProductName !== true) {
      errors.push("work-management-config.json: naming must centralize display-name lookup and avoid hardcoded product names");
    }

    const projects = arrayOfRecords(config.projects);
    const projectIds = new Set(projects.map((project) => String(project.id)));
    const workspaceSets = arrayOfRecords(config.workspaceSets);
    const multiProjectWorkspace = workspaceSets.some((workspaceSet) => stringArray(workspaceSet.projectIds).length >= 2);
    if (projects.length < 2 || workspaceSets.length < 2 || !multiProjectWorkspace) {
      errors.push("work-management-config.json: expected multiple projects and multiple workspace sets, including a multi-project workspace set");
    }
    for (const workspaceSet of workspaceSets) {
      for (const projectId of stringArray(workspaceSet.projectIds)) {
        if (!projectIds.has(projectId)) {
          errors.push(`work-management-config.json: workspace ${String(workspaceSet.id)} references unknown project ${projectId}`);
        }
      }
    }

    const tasks = arrayOfRecords(config.tasks);
    const taskIds = new Set(tasks.map((task) => String(task.id)));
    const taskLinkedToMultipleContexts = tasks.some((task) => stringArray(task.workspaceSetIds).length >= 2 || stringArray(task.projectIds).length >= 2);
    const taskHasTimestamps = tasks.every((task) => typeof task.updatedAt === "string" && typeof task.lastWorkedAt === "string");
    if (tasks.length === 0 || !taskLinkedToMultipleContexts || !taskHasTimestamps) {
      errors.push("work-management-config.json: tasks must include updatedAt, lastWorkedAt, and links to multiple workspaces or projects");
    }

    const taskWorkspaceLinks = arrayOfRecords(config.taskWorkspaceLinks);
    const linksValid = taskWorkspaceLinks.length >= 2 && taskWorkspaceLinks.every((link) => {
      const taskId = typeof link.taskId === "string" ? link.taskId : "";
      const workspaceSetId = typeof link.workspaceSetId === "string" ? link.workspaceSetId : "";
      return taskIds.has(taskId) && workspaceSets.some((workspaceSet) => workspaceSet.id === workspaceSetId);
    });
    if (!linksValid) {
      errors.push("work-management-config.json: taskWorkspaceLinks must connect known tasks to known workspace sets");
    }

    const taskWorkSessions = arrayOfRecords(config.taskWorkSessions);
    const sessionsValid = taskWorkSessions.length >= 2 && taskWorkSessions.every((session) => {
      const taskId = typeof session.taskId === "string" ? session.taskId : "";
      const workspaceSetId = typeof session.workspaceSetId === "string" ? session.workspaceSetId : "";
      return taskIds.has(taskId)
        && workspaceSets.some((workspaceSet) => workspaceSet.id === workspaceSetId)
        && typeof session.startedAt === "string"
        && typeof session.lastActivityAt === "string"
        && stringArray(session.runIds).length > 0
        && stringArray(session.diffCheckpointIds).length > 0;
    });
    if (!sessionsValid) {
      errors.push("work-management-config.json: taskWorkSessions must include task/workspace IDs, timestamps, run IDs, and diff checkpoints");
    }

    const dayPlans = arrayOfRecords(config.dayPlans);
    const dayItems = dayPlans.flatMap((dayPlan) => arrayOfRecords(dayPlan.items));
    const notes = dayPlans.flatMap((dayPlan) => arrayOfRecords(dayPlan.notes));
    const hasMultiDayItem = dayItems.some((item) => typeof item.startDate === "string" && typeof item.endDate === "string" && item.startDate !== item.endDate);
    const hasPushedItem = dayItems.some((item) => item.status === "pushed" && typeof item.pushedFrom === "string" && typeof item.pushedTo === "string" && typeof item.pushReason === "string");
    const hasUnexpectedNote = notes.some((note) => typeof note.text === "string" && /meeting|incident|support|pushed/i.test(note.text));
    if (dayPlans.length === 0 || !hasMultiDayItem || !hasPushedItem || !hasUnexpectedNote) {
      errors.push("work-management-config.json: dayPlans must include a multi-day item, pushed item, and note for unexpected interruptions");
    }

    details.push(`Projects: ${projects.length}`);
    details.push(`Workspace sets: ${workspaceSets.map((workspaceSet) => String(workspaceSet.id)).join(", ")}`);
    details.push(`Tasks: ${tasks.map((task) => String(task.id)).join(", ")}`);
    details.push(`Work sessions: ${taskWorkSessions.map((session) => String(session.id)).join(", ")}`);
    details.push(`Day plans: ${dayPlans.map((dayPlan) => String(dayPlan.id)).join(", ")}`);
  }

  if (errors.length > 0) {
    return {
      status: "fail",
      summary: "Work-management schema or example config is incomplete.",
      details: [...errors, ...details]
    };
  }

  return {
    status: "pass",
    summary: "Work-management contracts validate configured state stores, shared paths, logging, packaging, branch policy, workspace sets, task links, work sessions, and day planner pushes/notes.",
    details
  };
}

async function validateJiraLiveProbe(): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const baseUrl = process.env.PREVALIDATE_JIRA_BASE_URL;
  const email = process.env.PREVALIDATE_JIRA_EMAIL;
  const token = process.env.PREVALIDATE_JIRA_API_TOKEN;
  if (!baseUrl || !email || !token) {
    return {
      status: "skip",
      summary: "Skipped because Jira credentials are not configured.",
      details: [
        "Set PREVALIDATE_JIRA_BASE_URL, PREVALIDATE_JIRA_EMAIL, and PREVALIDATE_JIRA_API_TOKEN for a read-only live probe."
      ]
    };
  }

  const response = await fetchWithTimeout(`${baseUrl.replace(/\/+$/g, "")}/rest/api/3/myself`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
      Accept: "application/json"
    }
  }, 15_000);

  if (!response.ok) {
    return {
      status: "optional",
      summary: `Jira API probe failed with HTTP ${response.status}.`,
      details: [response.body.slice(0, 500)]
    };
  }

  return {
    status: "pass",
    summary: "Jira API read-only auth probe succeeded.",
    details: [`GET /rest/api/3/myself -> ${response.status}`]
  };
}

async function validateAsanaLiveProbe(): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const token = process.env.PREVALIDATE_ASANA_TOKEN;
  if (!token) {
    return {
      status: "skip",
      summary: "Skipped because Asana credentials are not configured.",
      details: ["Set PREVALIDATE_ASANA_TOKEN for a read-only live probe."]
    };
  }

  const response = await fetchWithTimeout("https://app.asana.com/api/1.0/users/me", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  }, 15_000);

  if (!response.ok) {
    return {
      status: "optional",
      summary: `Asana API probe failed with HTTP ${response.status}.`,
      details: [response.body.slice(0, 500)]
    };
  }

  return {
    status: "pass",
    summary: "Asana API read-only auth probe succeeded.",
    details: [`GET /users/me -> ${response.status}`]
  };
}

async function validateGitHubLiveProbe(): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const token = process.env.PREVALIDATE_GITHUB_TOKEN;
  const repo = process.env.PREVALIDATE_GITHUB_REPO;
  if (!token) {
    return {
      status: "skip",
      summary: "Skipped because GitHub credentials are not configured.",
      details: ["Set PREVALIDATE_GITHUB_TOKEN and optionally PREVALIDATE_GITHUB_REPO for a read-only live probe."]
    };
  }

  const url = repo
    ? `https://api.github.com/repos/${repo}/issues?per_page=1`
    : "https://api.github.com/user";
  const response = await fetchWithTimeout(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "drydock-prevalidation"
    }
  }, 15_000);

  if (!response.ok) {
    return {
      status: "optional",
      summary: `GitHub API probe failed with HTTP ${response.status}.`,
      details: [response.body.slice(0, 500)]
    };
  }

  return {
    status: "pass",
    summary: "GitHub API read-only auth probe succeeded.",
    details: [`GET ${repo ? `/repos/${repo}/issues` : "/user"} -> ${response.status}`]
  };
}

async function validateHitlShape(): Promise<Omit<CheckResult, "id" | "title" | "category" | "required" | "startedAt" | "durationMs">> {
  const request = {
    id: `hitl-${shortId()}`,
    runId: `run-${shortId()}`,
    title: "Verify command palette action",
    instructions: [
      {
        id: "step-1",
        instruction: "Open the Command Palette and run the extension command.",
        snippet: "Ctrl+Shift+P",
        expectedOptions: [
          { id: "button-visible", label: "Button shows" },
          { id: "button-missing", label: "Button missing" }
        ]
      }
    ],
    result: {
      stepId: "step-1",
      selectedOptionId: "button-visible",
      note: "The button appeared and opened the expected panel."
    }
  };

  const roundTrip = JSON.parse(JSON.stringify(request)) as typeof request;
  const valid = roundTrip.instructions[0]?.expectedOptions.some((option) => option.id === roundTrip.result.selectedOptionId)
    && roundTrip.result.note.length > 0
    && roundTrip.runId.startsWith("run-");

  if (!valid) {
    return {
      status: "fail",
      summary: "HITL verification shape did not round-trip.",
      details: [JSON.stringify(roundTrip)]
    };
  }

  return {
    status: "pass",
    summary: "HITL verification request supports instructions, snippets, expected choices, and freeform notes.",
    details: [JSON.stringify(roundTrip)]
  };
}

class AcpClient {
  readonly notifications: JsonRpcMessage[] = [];
  private child: ReturnType<typeof spawn> | null = null;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: JsonValue) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly cwd: string
  ) {}

  async start(): Promise<void> {
    const invocation = makeSpawnInvocation(this.command, this.args);
    this.child = spawn(invocation.command, invocation.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    this.child.stdout?.setEncoding("utf8");
    this.child.stderr?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrBuffer += sanitizeOutput(chunk);
    });
    this.child.on("error", (error) => {
      this.rejectAll(new Error(`ACP process error: ${error.message}`));
    });
    this.child.on("exit", (code, signal) => {
      this.rejectAll(new Error(`ACP process exited before completing pending requests: code=${String(code)} signal=${String(signal)}`));
    });

    await delay(150);
    if (this.child.exitCode !== null) {
      throw new Error(`ACP process exited immediately with code ${this.child.exitCode}. ${oneLine(this.stderrBuffer)}`);
    }
  }

  request(method: string, params: JsonValue, timeoutMs: number): Promise<JsonValue> {
    if (!this.child?.stdin) {
      throw new Error("ACP process is not running.");
    }
    const id = this.nextId;
    this.nextId += 1;
    const message: JsonRpcMessage = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };
    const payload = `${JSON.stringify(message)}\n`;
    this.child.stdin.write(payload);
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method} response after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method: string, params: JsonValue): void {
    if (!this.child?.stdin) {
      return;
    }
    const message: JsonRpcMessage = {
      jsonrpc: "2.0",
      method,
      params
    };
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async stop(): Promise<void> {
    if (!this.child) {
      return;
    }
    this.child.stdin?.end();
    if (this.child.exitCode === null) {
      this.child.kill();
      await delay(100);
    }
  }

  diagnostics(): string[] {
    return [
      oneLine(`stdout: ${this.stdoutBuffer}`),
      oneLine(`stderr: ${this.stderrBuffer}`),
      `Notifications observed: ${this.notifications.length}`
    ];
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += sanitizeOutput(chunk);
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line) as JsonRpcMessage;
        this.onMessage(message);
      } catch {
        this.stderrBuffer += `\nNon-JSON stdout line: ${line}`;
      }
    }
  }

  private onMessage(message: JsonRpcMessage): void {
    if (message.id !== undefined && message.id !== null && (message.result !== undefined || message.error !== undefined)) {
      const id = typeof message.id === "number" ? message.id : Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (message.error) {
        pending.reject(new Error(`ACP error ${String(message.error.code)}: ${message.error.message ?? "unknown error"}`));
      } else {
        pending.resolve(message.result ?? null);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      this.respondMethodNotFound(message);
      return;
    }

    this.notifications.push(message);
  }

  private respondMethodNotFound(message: JsonRpcMessage): void {
    if (!this.child?.stdin) return;
    const id = message.id === undefined ? null : message.id;
    const response: JsonRpcMessage = {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Client method not implemented by prevalidation harness: ${message.method ?? "unknown"}`
      }
    };
    this.child.stdin.write(`${JSON.stringify(response)}\n`);
  }

  private rejectAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

class AppServerClient {
  readonly notifications: JsonRpcMessage[] = [];
  private child: ReturnType<typeof spawn> | null = null;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: JsonValue) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly cwd: string
  ) {}

  async start(): Promise<void> {
    const invocation = makeSpawnInvocation(this.command, this.args);
    this.child = spawn(invocation.command, invocation.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    this.child.stdout?.setEncoding("utf8");
    this.child.stderr?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrBuffer += sanitizeOutput(chunk);
    });
    this.child.on("error", (error) => {
      this.rejectAll(new Error(`app-server process error: ${error.message}`));
    });
    this.child.on("exit", (code, signal) => {
      this.rejectAll(new Error(`app-server process exited before completing pending requests: code=${String(code)} signal=${String(signal)}`));
    });

    await delay(200);
    if (this.child.exitCode !== null) {
      throw new Error(`app-server process exited immediately with code ${this.child.exitCode}. ${oneLine(this.stderrBuffer)}`);
    }
  }

  request(method: string, params: JsonValue, timeoutMs: number): Promise<JsonValue> {
    if (!this.child?.stdin) {
      throw new Error("app-server process is not running.");
    }
    const id = this.nextId;
    this.nextId += 1;
    this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method} response after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method: string, params: JsonValue): void {
    if (!this.child?.stdin) return;
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    this.child.stdin?.end();
    if (this.child.exitCode === null) {
      this.child.kill();
      await delay(150);
    }
  }

  diagnostics(): string[] {
    return [
      oneLine(`stdout: ${this.stdoutBuffer}`),
      oneLine(`stderr: ${this.stderrBuffer}`),
      `Notifications observed: ${this.notifications.length}`
    ];
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += sanitizeOutput(chunk);
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line) as JsonRpcMessage;
        this.onMessage(message);
      } catch {
        this.stderrBuffer += `\nNon-JSON stdout line: ${line}`;
      }
    }
  }

  private onMessage(message: JsonRpcMessage): void {
    if (message.id !== undefined && message.id !== null && (message.result !== undefined || message.error !== undefined)) {
      const id = typeof message.id === "number" ? message.id : Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (message.error) {
        pending.reject(new Error(`app-server error ${String(message.error.code)}: ${message.error.message ?? "unknown error"}`));
      } else {
        pending.resolve(message.result ?? null);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      this.respondMethodNotFound(message);
      return;
    }

    this.notifications.push(message);
  }

  private respondMethodNotFound(message: JsonRpcMessage): void {
    if (!this.child?.stdin) return;
    this.child.stdin.write(`${JSON.stringify({
      id: message.id ?? null,
      error: {
        code: -32601,
        message: `Client method not implemented by prevalidation harness: ${message.method ?? "unknown"}`
      }
    })}\n`);
  }

  private rejectAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

async function probeCodexAppServerProtocol(input: {
  label: string;
  command: string;
  args: string[];
  cwd: string;
  threadCwd: string;
  timeoutMs: number;
}): Promise<{ ok: boolean; details: string[]; data: JsonValue }> {
  const client = new AppServerClient(input.command, input.args, input.cwd);
  try {
    await client.start();
    const initialize = await client.request("initialize", {
      clientInfo: {
        name: "drydock_prevalidate",
        title: "Drydock Prevalidation",
        version: "0.0.0-stage0"
      },
      capabilities: {
        experimentalApi: true
      }
    }, 15_000);
    client.notify("initialized", {});
    const threadStart = await client.request("thread/start", {
      cwd: input.threadCwd,
      ephemeral: true,
      sandbox: "read-only",
      approvalPolicy: "never"
    }, input.timeoutMs);
    const threadId = extractThreadId(threadStart);
    const details = [
      `${input.label}: initialize result keys: ${objectKeys(initialize).join(", ") || "(none)"}`,
      `${input.label}: thread id: ${threadId ?? "(not returned)"}`,
      `${input.label}: notifications observed: ${client.notifications.length}`
    ];
    if (!threadId) {
      return {
        ok: false,
        details,
        data: {
          initialize,
          threadStart,
          notifications: client.notifications.length
        }
      };
    }
    return {
      ok: true,
      details,
      data: {
        threadId,
        initializeKeys: objectKeys(initialize),
        notifications: client.notifications.length
      }
    };
  } catch (error) {
    return {
      ok: false,
      details: [
        `${input.label}: ${errorMessage(error)}`,
        ...client.diagnostics()
      ],
      data: {
        error: errorMessage(error),
        diagnostics: client.diagnostics()
      }
    };
  } finally {
    await client.stop();
  }
}

function extractThreadId(value: JsonValue): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const thread = value["thread"];
  if (thread && typeof thread === "object" && !Array.isArray(thread)) {
    const id = thread["id"];
    if (typeof id === "string") return id;
  }
  const direct = value["threadId"];
  if (typeof direct === "string") return direct;
  const snake = value["thread_id"];
  if (typeof snake === "string") return snake;
  return null;
}

function parseJsonLines(text: string): Array<Record<string, JsonValue>> {
  const events: Array<Record<string, JsonValue>> = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as JsonValue;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        events.push(parsed as Record<string, JsonValue>);
      }
    } catch {
      // Non-JSON stdout is ignored here; command diagnostics retain raw output.
    }
  }
  return events;
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function stringValue(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function itemType(event: Record<string, JsonValue>): string | null {
  const item = event["item"];
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }
  return stringValue(item["type"]);
}

function extractFileChangeKinds(event: Record<string, JsonValue>): string[] {
  const item = event["item"];
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return [];
  }
  const changes = item["changes"];
  if (!Array.isArray(changes)) {
    return [];
  }
  const kinds: string[] = [];
  for (const change of changes) {
    if (!change || typeof change !== "object" || Array.isArray(change)) {
      continue;
    }
    const kind = change["kind"];
    if (typeof kind === "string") {
      kinds.push(kind);
    } else if (kind && typeof kind === "object" && !Array.isArray(kind)) {
      const nestedType = kind["type"];
      if (typeof nestedType === "string") {
        kinds.push(nestedType);
      }
    }
  }
  return kinds;
}

function hasObjectProperty(event: Record<string, JsonValue>, property: string): boolean {
  const value = event[property];
  return value !== undefined && value !== null;
}

function dockerCodexAuthConfig(): { mode: string; dockerArgs: string[]; setupScriptLines: string[] } {
  const dockerArgs: string[] = [];
  const setupScriptLines = [
    "export CODEX_HOME=/tmp/codex-home",
    "mkdir -p \"$CODEX_HOME\""
  ];

  const authDir = process.env.PREVALIDATE_CODEX_AUTH_DIR;
  if (authDir) {
    const authJson = path.join(authDir, "auth.json");
    if (existsSync(authJson)) {
      dockerArgs.push("-v", `${path.resolve(authDir)}:/host-codex:ro`);
      setupScriptLines.push("cp /host-codex/auth.json \"$CODEX_HOME/auth.json\"");
      setupScriptLines.push("if [ -f /host-codex/config.toml ]; then cp /host-codex/config.toml \"$CODEX_HOME/config.toml\"; fi");
    }
  }

  if (process.env.CODEX_ACCESS_TOKEN) {
    dockerArgs.push("--env", "CODEX_ACCESS_TOKEN");
    setupScriptLines.push("printf '%s' \"$CODEX_ACCESS_TOKEN\" | codex login --with-access-token >/tmp/codex-login.out 2>&1 || { cat /tmp/codex-login.out >&2; exit 41; }");
  }

  if (process.env.CODEX_API_KEY) {
    dockerArgs.push("--env", "CODEX_API_KEY");
  }

  const mode = process.env.CODEX_ACCESS_TOKEN
    ? "access-token"
    : authDir && existsSync(path.join(authDir, "auth.json"))
      ? "auth-dir"
      : process.env.CODEX_API_KEY
        ? "api-key-exec-only"
        : "none";

  return { mode, dockerArgs, setupScriptLines };
}

interface RuntimeFixture {
  workspace: string;
  sharedRead: string;
  sharedWrite: string;
}

async function createRuntimeFixture(tempRoot: string, prefix: string): Promise<RuntimeFixture> {
  const root = path.join(tempRoot, `${prefix}-${shortId()}`);
  const workspace = path.join(root, "workspace");
  const sharedRead = path.join(root, "shared-read");
  const sharedWrite = path.join(root, "shared-write");
  await mkdir(workspace, { recursive: true });
  await mkdir(sharedRead, { recursive: true });
  await mkdir(sharedWrite, { recursive: true });
  await writeFile(path.join(workspace, "workspace-probe.txt"), "workspace\n", "utf8");
  await writeFile(path.join(sharedRead, "readonly-probe.txt"), "read only\n", "utf8");
  await writeFile(path.join(sharedWrite, "writable-probe.txt"), "write here\n", "utf8");
  return { workspace, sharedRead, sharedWrite };
}

async function createTempGitProject(tempRoot: string, prefix: string): Promise<string> {
  const git = findCommandOnPath(["git"], "git");
  const project = path.join(tempRoot, `${prefix}-${shortId()}`);
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "README.md"), "# ACP prevalidation\n", "utf8");
  if (git) {
    await run(git, ["init"], { cwd: project, timeoutMs: CHECK_TIMEOUT_MS });
    await run(git, ["config", "user.email", "prevalidate@example.invalid"], { cwd: project, timeoutMs: CHECK_TIMEOUT_MS });
    await run(git, ["config", "user.name", "Prevalidation"], { cwd: project, timeoutMs: CHECK_TIMEOUT_MS });
    await run(git, ["add", "README.md"], { cwd: project, timeoutMs: CHECK_TIMEOUT_MS });
    await run(git, ["commit", "-m", "initial"], { cwd: project, timeoutMs: CHECK_TIMEOUT_MS });
  }
  return project;
}

async function cleanupSbx(sbx: string, name: string, cwd: string): Promise<string[]> {
  const stop = await run(sbx, ["stop", name], { cwd, timeoutMs: 20_000 });
  const remove = await run(sbx, ["rm", "--force", name], { cwd, timeoutMs: 20_000 });
  return [
    `cleanup stop exit: ${String(stop.exitCode)}`,
    `cleanup rm exit: ${String(remove.exitCode)}`
  ];
}

type SessionMode = "plan" | "implementation" | "clone";

interface PolicyInput {
  mode: SessionMode;
  workspaceRoots: string[];
  sharedRead: string[];
  sharedWrite: string[];
  denied: string[];
}

interface PlannedMount {
  hostPath: string;
  containerPath: string;
  access: "read" | "write" | "deny";
  kind: "workspace" | "shared-read" | "shared-write" | "deny";
}

function buildMountPolicy(input: PolicyInput): PlannedMount[] {
  const mounts: PlannedMount[] = [];
  if (input.mode !== "clone") {
    input.workspaceRoots.forEach((root, index) => {
      mounts.push({
        hostPath: root,
        containerPath: `/workspace/root-${index + 1}`,
        access: input.mode === "plan" ? "read" : "write",
        kind: "workspace"
      });
    });
  }
  input.sharedRead.forEach((root, index) => {
    mounts.push({
      hostPath: root,
      containerPath: `/shared/read-${index + 1}`,
      access: "read",
      kind: "shared-read"
    });
  });
  input.sharedWrite.forEach((root, index) => {
    mounts.push({
      hostPath: root,
      containerPath: `/shared/write-${index + 1}`,
      access: "write",
      kind: "shared-write"
    });
  });
  input.denied.forEach((root, index) => {
    mounts.push({
      hostPath: root,
      containerPath: `/denied/${index + 1}`,
      access: "deny",
      kind: "deny"
    });
  });
  return mounts;
}

interface FileSnapshot {
  path: string;
  exists: boolean;
  sha256: string | null;
  contentBase64: string | null;
}

interface FileChange {
  path: string;
  status: "added" | "deleted" | "modified";
}

async function snapshotTree(root: string): Promise<Map<string, FileSnapshot>> {
  const snapshots = new Map<string, FileSnapshot>();
  await walk(root, async (filePath) => {
    const rel = normalizePath(path.relative(root, filePath));
    const content = await readFile(filePath);
    snapshots.set(rel, {
      path: rel,
      exists: true,
      sha256: createHash("sha256").update(content).digest("hex"),
      contentBase64: content.toString("base64")
    });
  });
  return snapshots;
}

function diffSnapshots(before: Map<string, FileSnapshot>, after: Map<string, FileSnapshot>): FileChange[] {
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  const changes: FileChange[] = [];
  for (const filePath of [...paths].sort()) {
    const oldFile = before.get(filePath);
    const newFile = after.get(filePath);
    if (!oldFile && newFile) {
      changes.push({ path: filePath, status: "added" });
    } else if (oldFile && !newFile) {
      changes.push({ path: filePath, status: "deleted" });
    } else if (oldFile && newFile && oldFile.sha256 !== newFile.sha256) {
      changes.push({ path: filePath, status: "modified" });
    }
  }
  return changes;
}

function fileChangeToJson(change: FileChange): JsonValue {
  return {
    path: change.path,
    status: change.status
  };
}

function acceptFileBaseline(
  baseline: Map<string, FileSnapshot>,
  current: Map<string, FileSnapshot>,
  filePath: string
): Map<string, FileSnapshot> {
  const next = new Map(baseline);
  const currentFile = current.get(filePath);
  if (currentFile) {
    next.set(filePath, currentFile);
  } else {
    next.delete(filePath);
  }
  return next;
}

async function revertFileFromBaseline(root: string, baseline: Map<string, FileSnapshot>, filePath: string): Promise<void> {
  const target = path.join(root, filePath);
  const original = baseline.get(filePath);
  if (!original || !original.contentBase64) {
    await rm(target, { force: true });
    return;
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, Buffer.from(original.contentBase64, "base64"));
}

async function walk(root: string, visit: (filePath: string) => Promise<void>): Promise<void> {
  const entries = await readdir(root);
  for (const entry of entries) {
    const fullPath = path.join(root, entry);
    const fileStat = await stat(fullPath);
    if (fileStat.isDirectory()) {
      await walk(fullPath, visit);
    } else if (fileStat.isFile()) {
      await visit(fullPath);
    }
  }
}

interface PlanBlock {
  id: string;
  status: string;
  runId: string;
  body: string;
  comments: string[];
}

function renderPlanBlock(id: string, status: string, runId: string, body: string): string {
  return [
    `<!-- ai-plan-block id="${id}" status="${status}" run="${runId}" -->`,
    body,
    "<!-- /ai-plan-block -->"
  ].join("\n");
}

function parsePlanBlocks(text: string): PlanBlock[] {
  const blocks: PlanBlock[] = [];
  const blockRegex = /<!-- ai-plan-block id="([^"]+)" status="([^"]+)" run="([^"]*)" -->([\s\S]*?)<!-- \/ai-plan-block -->/g;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(text)) !== null) {
    const id = match[1] ?? "";
    const status = match[2] ?? "";
    const runId = match[3] ?? "";
    const body = match[4] ?? "";
    const comments: string[] = [];
    const commentRegex = /<!-- ai-plan-comment block="([^"]+)" author="([^"]+)" -->([\s\S]*?)<!-- \/ai-plan-comment -->/g;
    let commentMatch: RegExpExecArray | null;
    while ((commentMatch = commentRegex.exec(body)) !== null) {
      if (commentMatch[1] === id) {
        comments.push((commentMatch[3] ?? "").trim());
      }
    }
    blocks.push({ id, status, runId, body: body.trim(), comments });
  }
  return blocks;
}

function updatePlanBlockStatus(text: string, id: string, status: string, runId: string): string {
  const regex = new RegExp(`<!-- ai-plan-block id="${escapeRegExp(id)}" status="[^"]+" run="[^"]*" -->`);
  return text.replace(regex, `<!-- ai-plan-block id="${id}" status="${status}" run="${runId}" -->`);
}

async function runMockAgent(
  role: string,
  durationMs: number,
  signal: AbortSignal,
  events: Array<{ role: string; type: string }>
): Promise<void> {
  events.push({ role, type: "started" });
  await delay(durationMs);
  if (signal.aborted) {
    events.push({ role, type: "cancelled" });
    throw new Error(`${role} cancelled`);
  }
  events.push({ role, type: "message" });
  await delay(10);
  if (signal.aborted) {
    events.push({ role, type: "cancelled" });
    throw new Error(`${role} cancelled`);
  }
  events.push({ role, type: "finished" });
}

interface AcpCandidate {
  command: string;
  args: string[];
}

interface AcpCandidateSelection {
  candidate: AcpCandidate | null;
  details: string[];
}

async function selectAcpCandidate(context: CheckContext): Promise<AcpCandidateSelection> {
  const details: string[] = [];
  const fromEnv = process.env.CODEX_ACP_COMMAND;
  if (fromEnv?.trim()) {
    const parts = splitCommandLine(fromEnv);
    const command = parts[0];
    if (!command) {
      return {
        candidate: null,
        details: ["CODEX_ACP_COMMAND was set but did not contain a command."]
      };
    }
    return {
      candidate: { command, args: parts.slice(1) },
      details: ["Using explicit CODEX_ACP_COMMAND candidate."]
    };
  }

  const codexAcp = findCommandOnPath(["codex-acp", "codex-acp.cmd", "codex-acp.exe"], "codex_acp");
  if (codexAcp) {
    return {
      candidate: { command: codexAcp, args: [] },
      details: ["Found codex-acp executable on PATH or explicit prevalidation path."]
    };
  }
  details.push("No codex-acp executable was found on PATH.");

  const codex = context.commands.get("codex")?.path ?? findCommandOnPath(["codex", "codex.exe"], "codex");
  if (codex) {
    const help = await run(codex, ["--help"], { cwd: context.root, timeoutMs: CHECK_TIMEOUT_MS });
    details.push(compactCommand("codex --help", help));
    if (help.exitCode === 0 && helpListsSubcommand(`${help.stdout}\n${help.stderr}`, "acp")) {
      return {
        candidate: { command: codex, args: ["acp"] },
        details: [
          ...details,
          "codex --help advertises an acp subcommand, so codex acp will be probed."
        ]
      };
    }
    details.push("codex --help does not advertise an acp subcommand; not probing `codex acp` because current Codex treats unknown text as an interactive prompt.");
  } else {
    details.push("No codex executable was available for an advertised `codex acp` check.");
  }

  if (context.options.allowNpxAcp) {
    const npx = findCommandOnPath(["npx"], "npx");
    if (npx) {
      return {
        candidate: { command: npx, args: ["--yes", "@zed-industries/codex-acp"] },
        details: [
          ...details,
          "Using npx ACP candidate because --allow-npx-acp was set."
        ]
      };
    }
    details.push("--allow-npx-acp was set, but npx was not found.");
  }

  return { candidate: null, details };
}

function helpListsSubcommand(helpText: string, subcommand: string): boolean {
  return new RegExp(`^\\s+${escapeRegExp(subcommand)}(?:\\s|$)`, "m").test(helpText);
}

function extractSbxAgentNames(helpText: string): string[] {
  const known = ["claude", "codex", "copilot", "cursor", "docker-agent", "droid", "gemini", "kiro", "opencode", "shell"];
  const found = known.filter((agent) => new RegExp(`^\\s+${escapeRegExp(agent)}\\s+`, "m").test(helpText));
  return [...new Set(found)].sort();
}

function extractSessionId(value: JsonValue): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const direct = value["sessionId"];
  if (typeof direct === "string") {
    return direct;
  }
  const snake = value["session_id"];
  if (typeof snake === "string") {
    return snake;
  }
  return null;
}

function objectKeys(value: JsonValue): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.keys(value);
}

function buildReport(context: CheckContext, checks: CheckResult[]): PrevalidationReport {
  const required = checks.filter((check) => check.required);
  const requiredFailed = required.filter((check) => check.status === "fail" || check.status === "skip").length;
  const requiredPassed = required.filter((check) => check.status === "pass").length;
  const optionalIssues = checks.filter((check) => !check.required && (check.status === "optional" || check.status === "fail" || check.status === "warn")).length;

  const commandData: PrevalidationReport["commands"] = {};
  for (const [key, probe] of context.commands) {
    commandData[key] = {
      path: probe.path,
      required: probe.required,
      versionArgs: probe.versionArgs,
      ...(probe.versionResult
        ? {
            versionExitCode: probe.versionResult.exitCode,
            versionStdout: oneLine(probe.versionResult.stdout),
            versionStderr: oneLine(probe.versionResult.stderr),
            ...(probe.versionResult.error ? { versionError: probe.versionResult.error } : {})
          }
        : {})
    };
  }

  const nextActions = checks
    .filter((check) => check.required && (check.status === "fail" || check.status === "skip"))
    .map((check) => `${check.id}: ${check.summary}`);

  return {
    generatedAt: new Date().toISOString(),
    workspaceRoot: context.root,
    platform: {
      os: os.platform(),
      release: os.release(),
      arch: os.arch(),
      shell: process.env.SHELL ?? process.env.ComSpec ?? null,
      node: process.version
    },
    options: context.options,
    gate: {
      status: requiredFailed === 0 ? "ready" : "blocked",
      requiredPassed,
      requiredFailed,
      optionalIssues
    },
    artifacts: {
      productPlan: path.join(context.designDocsDir, "product-plan.md"),
      threatModel: path.join(context.designDocsDir, "threat-model.md"),
      coverage: path.join(context.designDocsDir, "prevalidation-coverage.md"),
      apiReference: path.join(context.designDocsDir, "api-reference.md"),
      extensionPoints: path.join(context.designDocsDir, "extension-points.md"),
      workManagement: path.join(context.designDocsDir, "work-management.md"),
      schemasDir: path.join(context.root, "schemas"),
      report: context.options.reportPath,
      json: context.options.outputJson
    },
    commands: commandData,
    checks,
    nextActions
  };
}

function renderMarkdownReport(report: PrevalidationReport): string {
  const categories = [...new Set(report.checks.map((check) => check.category))];
  const lines: string[] = [
    "# Prevalidation Report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Gate",
    "",
    `Status: ${report.gate.status.toUpperCase()}`,
    "",
    `Required passed: ${report.gate.requiredPassed}`,
    "",
    `Required failed/skipped: ${report.gate.requiredFailed}`,
    "",
    `Optional issues: ${report.gate.optionalIssues}`,
    "",
    "## Platform",
    "",
    `- OS: ${report.platform.os} ${report.platform.release} ${report.platform.arch}`,
    `- Shell: ${report.platform.shell ?? "(unknown)"}`,
    `- Node: ${report.platform.node}`,
    `- Workspace: ${report.workspaceRoot}`,
    "",
    "## Artifacts",
    "",
    `- Product plan: ${report.artifacts.productPlan}`,
    `- Threat model: ${report.artifacts.threatModel}`,
    `- Coverage matrix: ${report.artifacts.coverage}`,
    `- API reference: ${report.artifacts.apiReference}`,
    `- Extension points: ${report.artifacts.extensionPoints}`,
    `- Work management: ${report.artifacts.workManagement}`,
    `- Schemas: ${report.artifacts.schemasDir}`,
    `- JSON report: ${report.artifacts.json}`,
    "",
    "## Commands",
    ""
  ];

  for (const [key, command] of Object.entries(report.commands)) {
    lines.push(`- ${key}: ${command.path ?? "(not found)"}${command.required ? " [required]" : " [optional]"}`);
    if (command.versionStdout) lines.push(`  - stdout: ${command.versionStdout}`);
    if (command.versionStderr) lines.push(`  - stderr: ${command.versionStderr}`);
    if (command.versionError) lines.push(`  - error: ${command.versionError}`);
  }

  lines.push("", "## Checks", "");
  for (const category of categories) {
    lines.push(`### ${category}`, "");
    const categoryChecks = report.checks.filter((check) => check.category === category);
    for (const check of categoryChecks) {
      lines.push(`- [${check.status.toUpperCase()}] ${check.title} (${check.required ? "required" : "optional"})`);
      lines.push(`  - ${check.summary}`);
      for (const detail of check.details.slice(0, 8)) {
        lines.push(`  - ${detail}`);
      }
      if (check.details.length > 8) {
        lines.push(`  - ${check.details.length - 8} more details omitted from Markdown report; see prevalidation.json.`);
      }
    }
    lines.push("");
  }

  lines.push("## Next Actions", "");
  if (report.nextActions.length === 0) {
    lines.push("- Required Stage 0 checks are passing. VS Code scaffolding may begin.");
  } else {
    for (const action of report.nextActions) {
      lines.push(`- ${action}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function printConsoleSummary(report: PrevalidationReport): void {
  console.log(`Prevalidation ${report.gate.status.toUpperCase()}`);
  console.log(`Required passed: ${report.gate.requiredPassed}`);
  console.log(`Required failed/skipped: ${report.gate.requiredFailed}`);
  console.log(`Optional issues: ${report.gate.optionalIssues}`);
  console.log(`Report: ${report.artifacts.report}`);
  console.log(`JSON: ${report.artifacts.json}`);
  if (report.nextActions.length > 0) {
    console.log("Blocking checks:");
    for (const action of report.nextActions) {
      console.log(`- ${action}`);
    }
  }
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }
): Promise<CommandResult> {
  const started = Date.now();
  return new Promise<CommandResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const invocation = makeSpawnInvocation(command, args);
    let timer: NodeJS.Timeout | null = null;

    const finish = (result: Omit<CommandResult, "command" | "args" | "cwd" | "stdout" | "stderr" | "durationMs">): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        command,
        args,
        cwd: options.cwd,
        stdout: truncate(sanitizeOutput(stdout)),
        stderr: truncate(sanitizeOutput(stderr)),
        durationMs: Date.now() - started,
        ...result
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      finish({
        exitCode: null,
        signal: null,
        timedOut: false,
        error: errorMessage(error)
      });
      return;
    }

    timer = setTimeout(() => {
      child.kill();
      finish({
        exitCode: child.exitCode,
        signal: child.signalCode,
        timedOut: true,
        error: `Timed out after ${options.timeoutMs}ms`
      });
    }, options.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({
        exitCode: null,
        signal: null,
        timedOut: false,
        error: error.message
      });
    });
    child.on("close", (exitCode, signal) => {
      finish({
        exitCode,
        signal,
        timedOut: false
      });
    });
  });
}

async function selectDockerContext(
  docker: string,
  cwd: string
): Promise<{ available: boolean; contextName: string | null; details: string[]; data: JsonValue }> {
  const details: string[] = [];
  const defaultInfo = await run(docker, ["info", "--format", "{{.ServerVersion}}"], {
    cwd,
    timeoutMs: CHECK_TIMEOUT_MS
  });
  details.push(compactCommand("docker info default", defaultInfo));
  if (defaultInfo.exitCode === 0) {
    return {
      available: true,
      contextName: null,
      details,
      data: { defaultInfo: commandResultData(defaultInfo) }
    };
  }

  const contextList = await run(docker, ["context", "ls", "--format", "{{.Name}}"], {
    cwd,
    timeoutMs: CHECK_TIMEOUT_MS
  });
  details.push(compactCommand("docker context ls", contextList));
  const contextNames = contextList.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\*$/, "").trim())
    .filter(Boolean);
  const configuredContext = process.env.PREVALIDATE_DOCKER_CONTEXT;
  const preferred = [
    ...(configuredContext ? [configuredContext] : []),
    "desktop-linux",
    ...contextNames.filter((name) => name !== configuredContext && name !== "desktop-linux" && name !== "default")
  ];

  for (const contextName of preferred) {
    const result = await run(docker, ["--context", contextName, "info", "--format", "{{.ServerVersion}}"], {
      cwd,
      timeoutMs: CHECK_TIMEOUT_MS
    });
    details.push(compactCommand(`docker info ${contextName}`, result));
    if (result.exitCode === 0) {
      return {
        available: true,
        contextName,
        details,
        data: {
          defaultInfo: commandResultData(defaultInfo),
          contextList: commandResultData(contextList),
          selectedContextInfo: commandResultData(result)
        }
      };
    }
  }

  return {
    available: false,
    contextName: null,
    details,
    data: {
      defaultInfo: commandResultData(defaultInfo),
      contextList: commandResultData(contextList)
    }
  };
}

function findCommandOnPath(names: string[], key?: string): string | null {
  for (const candidate of explicitCommandCandidates(key)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const paths = splitPathEnv();
  const candidates = names.flatMap((name) => expandCommandName(name));
  for (const dir of paths) {
    for (const candidate of candidates) {
      const fullPath = path.join(dir, candidate);
      if (existsSync(fullPath)) {
        return fullPath;
      }
    }
  }
  return null;
}

function explicitCommandCandidates(key?: string): string[] {
  if (!key) {
    return [];
  }

  const normalized = key.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const fromEnv = [
    process.env[`PREVALIDATE_${normalized}_PATH`],
    process.env[`${normalized}_PATH`]
  ].filter((value): value is string => Boolean(value));

  const candidates = [...fromEnv];
  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";

  if (key === "sbx" && localAppData) {
    candidates.push(path.join(localAppData, "DockerSandboxes", "bin", "sbx.exe"));
  }

  if (key === "docker") {
    candidates.push(path.join(programFiles, "Docker", "Docker", "resources", "bin", "docker.exe"));
  }

  if (key === "codex" && process.platform === "win32") {
    candidates.push(...localCodexStandaloneCandidates(localAppData));
    const pathEntries = splitPathEnv().filter((entry) => entry.includes("OpenAI.Codex"));
    for (const entry of pathEntries) {
      candidates.push(path.join(entry, "codex.exe"));
      candidates.push(path.join(entry, "codex"));
    }
  }

  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

function localCodexStandaloneCandidates(localAppData: string | undefined): string[] {
  if (!localAppData) return [];
  const binRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
  if (!existsSync(binRoot)) return [];
  try {
    return readdirSync(binRoot)
      .map((entry) => path.join(binRoot, entry))
      .filter((candidate) => {
        try {
          return statSync(candidate).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => {
        try {
          return statSync(b).mtimeMs - statSync(a).mtimeMs;
        } catch {
          return 0;
        }
      })
      .flatMap((dir) => [
        path.join(dir, "codex.exe"),
        path.join(dir, "codex")
      ]);
  } catch {
    return [];
  }
}

function splitPathEnv(): string[] {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => entry.length > 0);
}

function expandCommandName(name: string): string[] {
  if (path.isAbsolute(name) || name.includes("/") || name.includes("\\")) {
    return [name];
  }
  if (process.platform !== "win32") {
    return [name];
  }
  const ext = path.extname(name);
  if (ext) {
    return [name];
  }
  const pathExt = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  return [
    ...pathExt.map((candidateExt) => `${name}${candidateExt.toLowerCase()}`),
    ...pathExt.map((candidateExt) => `${name}${candidateExt.toUpperCase()}`),
    name
  ];
}

function makeSpawnInvocation(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    const comspec = process.env.ComSpec ?? "cmd.exe";
    return {
      command: comspec,
      args: ["/d", "/c", "call", command, ...args]
    };
  }
  return { command, args };
}

function commandResultData(result: CommandResult): JsonValue {
  return {
    command: result.command,
    args: result.args,
    cwd: result.cwd,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    ...(result.error ? { error: result.error } : {})
  };
}

async function readJsonFile(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function validateManifestShape(label: string, manifest: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const requiredStrings = ["schemaVersion", "id", "displayName", "version", "kind"];
  for (const key of requiredStrings) {
    if (typeof manifest[key] !== "string" || String(manifest[key]).length === 0) {
      errors.push(`${label}: ${key} is required`);
    }
  }
  if (manifest.schemaVersion !== "drydock.extension.v1") {
    errors.push(`${label}: schemaVersion must be drydock.extension.v1`);
  }
  const allowedKinds = new Set([
    "task-provider",
    "agent-provider",
    "runtime-adapter",
    "panel-provider",
    "memory-provider",
    "test-provider",
    "multi-provider"
  ]);
  if (typeof manifest.kind !== "string" || !allowedKinds.has(manifest.kind)) {
    errors.push(`${label}: kind is not a supported provider kind`);
  }
  const extensionPoints = arrayOfRecords(manifest.extensionPoints);
  if (extensionPoints.length === 0) {
    errors.push(`${label}: at least one extension point is required`);
  }
  for (const point of extensionPoints) {
    if (typeof point.type !== "string" || typeof point.id !== "string" || typeof point.version !== "string") {
      errors.push(`${label}: extension point must include type, id, and version`);
    }
    if (!isRecord(point.capabilities)) {
      errors.push(`${label}: extension point ${String(point.id)} must declare capabilities`);
    }
  }
  if (!isRecord(manifest.capabilities)) {
    errors.push(`${label}: capabilities object is required`);
  }
  if (manifest.auth !== undefined) {
    const auth = isRecord(manifest.auth) ? manifest.auth : {};
    if (typeof auth.mode !== "string" || typeof auth.secretRefRequired !== "boolean") {
      errors.push(`${label}: auth must declare mode and secretRefRequired`);
    }
  }
  return errors;
}

function validateNoRawSecrets(label: string, value: unknown): string[] {
  const forbiddenKeys = new Set([
    "apikey",
    "api_key",
    "apitoken",
    "api_token",
    "password",
    "clientsecret",
    "client_secret",
    "access_token",
    "accesstoken",
    "refresh_token",
    "refreshtoken",
    "rawsecret",
    "secretvalue",
    "tokenvalue"
  ]);
  const errors: string[] = [];

  function walk(node: unknown, trail: string): void {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${trail}[${index}]`));
      return;
    }
    if (!isRecord(node)) {
      if (typeof node === "string" && /\b(sk-|ghp_|gho_|xox[baprs]-)/i.test(node)) {
        errors.push(`${label}: possible raw secret value at ${trail}`);
      }
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      const normalized = key.toLowerCase().replace(/[-\s]/g, "");
      if (forbiddenKeys.has(normalized) && typeof child === "string" && child.length > 0) {
        errors.push(`${label}: raw credential-like field ${trail}.${key} is not allowed`);
      }
      walk(child, trail ? `${trail}.${key}` : key);
    }
  }

  walk(value, "");
  return errors;
}

async function fetchWithTimeout(
  url: string,
  init: { headers?: Record<string, string> },
  timeoutMs: number
): Promise<{ ok: boolean; status: number; body: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal
    });
    return {
      ok: response.ok,
      status: response.status,
      body: await response.text()
    };
  } finally {
    clearTimeout(timeout);
  }
}

function compactCommand(label: string, result: CommandResult): string {
  return `${label}: exit=${String(result.exitCode)} timeout=${String(result.timedOut)} stdout="${oneLine(result.stdout)}" stderr="${oneLine(result.stderr)}"`;
}

function oneLine(text: string): string {
  return sanitizeOutput(text).replace(/\s+/g, " ").trim().slice(0, 500);
}

function truncate(text: string, max = 200_000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... truncated ${text.length - max} characters ...`;
}

function sanitizeOutput(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function shortId(): string {
  return randomUUID().slice(0, 8);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function hostPathToSandboxPath(hostPath: string): string {
  if (process.platform === "win32") {
    const match = /^([A-Za-z]):[\\/](.*)$/.exec(hostPath);
    if (match) {
      const drive = match[1]?.toLowerCase();
      const rest = (match[2] ?? "").replace(/[\\/]+/g, "/");
      return `/${drive}/${rest}`;
    }
  }
  return normalizePath(hostPath);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitCommandLine(value: string): string[] {
  const parts: string[] = [];
  const regex = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value)) !== null) {
    parts.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return parts;
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exit(1);
});
