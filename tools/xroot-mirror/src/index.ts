/**
 * `xroot-mirror` CLI — maintain and inspect the curated `X:` mirror (ADR 0022).
 *
 * Subcommands: `plan` (what a sync would copy and skip), `sync` (do it, then
 * write the state file), `scan` (which `X:` roots packages reference), `diff`
 * (scan vs manifest drift), `status` (mirror freshness). Everything prints JSON
 * on stdout so the extension, a hook, or a human with `jq` all read the same
 * thing; failures print one line on stderr and exit 1.
 *
 * There are no implicit defaults for the manifest path. The manifest is the
 * allowlist that defines what the validation guest can see, so it is always
 * named explicitly.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadManifest, messageOf } from "./manifest.js";
import type { MirrorManifest } from "./manifest.js";
import { buildSyncPlan, joinUnderRoot } from "./syncPlan.js";
import {
  buildRobocopyCommands,
  DEFAULT_ROBOCOPY_EXE,
  MIRROR_STATE_FILE_NAME,
  syncMirror
} from "./robocopyRunner.js";
import { scanReferenceRoots } from "./referenceScan.js";
import type { ReferenceScanResult } from "./referenceScan.js";
import { diffReferencesAgainstManifest } from "./driftDiff.js";

const USAGE = `xroot-mirror — curated X: mirror tooling (ADR 0022)

  plan   --manifest <path>                     what a sync would copy and skip
  sync   --manifest <path> [--dry-run]         run robocopy, write the state file
                           [--robocopy <exe>]
  scan   <dir> [<dir>...] [--files a,b]        X: roots referenced by package definitions
  diff   --manifest <path> [<dir>...]          scan vs manifest drift ("--strict" exits 1 on new roots)
  status --manifest <path> | --mirror-root <path>   mirror freshness

All output is JSON on stdout.`;

const BOOLEAN_FLAGS = new Set(["dry-run", "strict", "help"]);

interface Argv {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}

async function main(): Promise<void> {
  const argv = parseArgv(process.argv.slice(2));
  if (argv.command === "" || argv.command === "help" || argv.flags.has("help")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  switch (argv.command) {
    case "plan":
      await commandPlan(argv);
      return;
    case "sync":
      await commandSync(argv);
      return;
    case "scan":
      await commandScan(argv);
      return;
    case "diff":
      await commandDiff(argv);
      return;
    case "status":
      await commandStatus(argv);
      return;
    default:
      throw new Error(`Unknown command "${argv.command}". Known commands: plan, sync, scan, diff, status.`);
  }
}

async function commandPlan(argv: Argv): Promise<void> {
  const manifest = await loadManifest(requireFlag(argv, "manifest", "plan"));
  const plan = buildSyncPlan(manifest.sourceRoot, manifest.subtrees);
  emit({
    manifestVersion: manifest.version,
    sourceRoot: manifest.sourceRoot,
    mirrorRoot: manifest.mirrorRoot,
    entries: plan.entries,
    skippedVersions: plan.skippedVersions
  });
}

async function commandSync(argv: Argv): Promise<void> {
  const manifest = await loadManifest(requireFlag(argv, "manifest", "sync"));
  const plan = buildSyncPlan(manifest.sourceRoot, manifest.subtrees);
  const exe = stringFlag(argv, "robocopy") ?? DEFAULT_ROBOCOPY_EXE;

  if (argv.flags.get("dry-run") === true) {
    emit({
      dryRun: true,
      manifestVersion: manifest.version,
      mirrorRoot: manifest.mirrorRoot,
      stubDirs: manifest.stubDirs.map((stub) => joinUnderRoot(manifest.mirrorRoot, stub)),
      commands: buildRobocopyCommands(plan, manifest.mirrorRoot, exe),
      skippedVersions: plan.skippedVersions
    });
    return;
  }

  const outcome = await syncMirror(manifest, plan, { robocopyExe: exe });
  emit({
    dryRun: false,
    ok: outcome.ok,
    mirrorRoot: outcome.mirrorRoot,
    stateFile: outcome.stateFile,
    stubDirs: outcome.stubDirs,
    results: outcome.results,
    state: outcome.state
  });
  if (!outcome.ok) {
    const failed = outcome.results.filter((result) => !result.ok);
    process.stderr.write(`${failed.map((result) => result.error ?? result.subtree).join("\n")}\n`);
    process.exitCode = 1;
  }
}

async function commandScan(argv: Argv): Promise<void> {
  if (argv.positionals.length === 0) {
    throw new Error('scan needs at least one directory: xroot-mirror scan "X:\\Pipeline\\rez\\packages\\internal".');
  }
  emit(await runScan(argv, argv.positionals));
}

async function commandDiff(argv: Argv): Promise<void> {
  const manifest = await loadManifest(requireFlag(argv, "manifest", "diff"));
  const dirs = argv.positionals.length > 0
    ? argv.positionals
    : manifest.subtrees.map((subtree) => joinUnderRoot(manifest.sourceRoot, subtree));
  const scan = await runScan(argv, dirs);
  const drift = diffReferencesAgainstManifest(scan, manifest);
  emit({
    manifestVersion: manifest.version,
    scanned: scan.roots,
    filesScanned: scan.filesScanned,
    covered: drift.covered,
    newRoots: drift.newRoots,
    staleSubtrees: drift.staleSubtrees
  });
  if (argv.flags.get("strict") === true && drift.newRoots.length > 0) {
    process.stderr.write(
      `${String(drift.newRoots.length)} X: root(s) referenced but not in manifest version ${String(manifest.version)}: ` +
      `${drift.newRoots.map((entry) => entry.root).join(", ")}. Review and bump the manifest.\n`
    );
    process.exitCode = 1;
  }
}

async function commandStatus(argv: Argv): Promise<void> {
  const mirrorRoot = await resolveMirrorRoot(argv);
  const stateFile = join(mirrorRoot, MIRROR_STATE_FILE_NAME);
  let text: string;
  try {
    text = await readFile(stateFile, "utf8");
  } catch {
    emit({ mirrorRoot, stateFile, present: false, reason: "no state file; the mirror has never been synced from this host" });
    return;
  }
  let state: unknown;
  try {
    state = JSON.parse(text) as unknown;
  } catch (error) {
    emit({ mirrorRoot, stateFile, present: false, reason: `state file is not valid JSON: ${messageOf(error)}` });
    return;
  }
  const record = state as Record<string, unknown>;
  const subtrees = Array.isArray(record["subtrees"]) ? (record["subtrees"] as Record<string, unknown>[]) : [];
  const syncedAt = typeof record["syncedAt"] === "string" ? record["syncedAt"] : null;
  const syncedMs = syncedAt === null ? Number.NaN : Date.parse(syncedAt);
  emit({
    mirrorRoot,
    stateFile,
    present: true,
    manifestVersion: typeof record["manifestVersion"] === "number" ? record["manifestVersion"] : null,
    syncedAt,
    ageMs: Number.isNaN(syncedMs) ? null : Date.now() - syncedMs,
    ok: subtrees.length > 0 ? subtrees.every((entry) => entry["ok"] === true) : null,
    subtrees,
    skippedVersions: Array.isArray(record["skippedVersions"]) ? record["skippedVersions"] : []
  });
}

async function resolveMirrorRoot(argv: Argv): Promise<string> {
  const explicit = stringFlag(argv, "mirror-root");
  if (explicit !== undefined) return explicit;
  const manifestPath = stringFlag(argv, "manifest");
  if (manifestPath === undefined) {
    throw new Error("status needs --mirror-root <path> or --manifest <path>.");
  }
  const manifest: MirrorManifest = await loadManifest(manifestPath);
  return manifest.mirrorRoot;
}

async function runScan(argv: Argv, dirs: readonly string[]): Promise<ReferenceScanResult> {
  const files = stringFlag(argv, "files");
  const fileNames = files === undefined
    ? undefined
    : files.split(",").map((name) => name.trim()).filter((name) => name.length > 0);
  return scanReferenceRoots(dirs, fileNames === undefined ? {} : { fileNames });
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function requireFlag(argv: Argv, name: string, command: string): string {
  const value = stringFlag(argv, name);
  if (value === undefined) {
    throw new Error(`--${name} <path> is required for "${command}"; the manifest is the allowlist and has no default.`);
  }
  return value;
}

function stringFlag(argv: Argv, name: string): string | undefined {
  const value = argv.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function parseArgv(args: readonly string[]): Argv {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  let command = "";
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? "";
    if (!token.startsWith("--")) {
      if (command === "") command = token;
      else positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf("=");
    if (equals !== -1) {
      flags.set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    if (BOOLEAN_FLAGS.has(body)) {
      flags.set(body, true);
      continue;
    }
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(body, true);
      continue;
    }
    flags.set(body, next);
    index += 1;
  }
  return { command, positionals, flags };
}

await main().catch((error: unknown) => {
  process.stderr.write(`${messageOf(error)}\n`);
  process.exitCode = 1;
});
