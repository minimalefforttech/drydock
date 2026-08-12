/**
 * Robocopy execution for the curated `X:` mirror.
 *
 * The mirror is a security surface (ADR 0022): whatever lands under the mirror
 * root is what the validation guest can see. So the argument list is a fixed
 * constant — only validated paths from the manifest and the sync plan are ever
 * appended, spawning goes through argv arrays with no shell, and the exit code
 * is reported as robocopy actually returns it.
 *
 * Robocopy's exit status is a bitfield, not an errorlevel: 0 nothing to do,
 * 1 files copied, 2 extras removed (that is `/MIR` doing its job), 4 mismatches,
 * 8 copy failures, 16 fatal. Anything below 8 is a successful run; treating
 * 1 or 3 as failure is the classic mistake and would make every real sync red.
 *
 * After a sync the mirror root gets `.drydock-mirror.json`, the state file
 * receipts read for freshness and manifest version (edge cases E1/G1).
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MirrorManifest } from "./manifest.js";
import { messageOf } from "./manifest.js";
import { joinUnderRoot } from "./syncPlan.js";
import type { SyncPlan } from "./syncPlan.js";

/** Robocopy ships with Windows; the path is fixed unless a host says otherwise. */
export const DEFAULT_ROBOCOPY_EXE = "C:\\Windows\\System32\\robocopy.exe";

/** State file the mirror root carries; receipts read it for freshness. */
export const MIRROR_STATE_FILE_NAME = ".drydock-mirror.json";

/**
 * Fixed argument list. `/MIR` mirrors (including deletes), `/FFT` tolerates the
 * SMB timestamp granularity, `/R:2 /W:2` keeps a stalled NAS from hanging a job,
 * the `/N*` flags reduce output to one line per file, `/BYTES` makes those lines
 * parseable, and `/XJ` refuses to follow junctions out of the allowlisted tree.
 */
export const ROBOCOPY_FIXED_ARGS: readonly string[] = [
  "/MIR",
  "/FFT",
  "/R:2",
  "/W:2",
  "/NP",
  "/NDL",
  "/NJH",
  "/NJS",
  "/BYTES",
  "/XJ"
];

export interface RobocopyCommand {
  readonly subtree: string;
  readonly exe: string;
  readonly args: readonly string[];
  readonly source: string;
  readonly destination: string;
}

export interface SubtreeSyncResult {
  readonly subtree: string;
  /** Robocopy's exit code, or -1 when the process could not be started. */
  readonly exitCode: number;
  readonly ok: boolean;
  /** Files copied this run, parsed from the per-file lines. */
  readonly copied?: number;
  /** Extra files deleted from the mirror this run (`/MIR`). */
  readonly removed?: number;
  /** Present only when the run failed; the exit meaning plus robocopy's own words. */
  readonly error?: string;
}

/** Exactly what `.drydock-mirror.json` holds. */
export interface MirrorStateFile {
  readonly manifestVersion: number;
  readonly syncedAt: string;
  readonly subtrees: readonly { readonly subtree: string; readonly ok: boolean; readonly exitCode: number }[];
  readonly skippedVersions: readonly string[];
}

export interface SyncOptions {
  readonly robocopyExe?: string;
  readonly now?: () => Date;
}

export interface MirrorSyncOutcome {
  readonly ok: boolean;
  readonly mirrorRoot: string;
  readonly stateFile: string;
  readonly stubDirs: readonly string[];
  readonly results: readonly SubtreeSyncResult[];
  readonly state: MirrorStateFile;
}

/** 0-7 is a successful robocopy run; 8 and above is failure. */
export function robocopyOk(exitCode: number): boolean {
  return exitCode >= 0 && exitCode < 8;
}

/** Human reading of the exit bitfield, for reports and failure messages. */
export function describeRobocopyExit(exitCode: number): string {
  if (exitCode < 0) return "robocopy did not start";
  if (exitCode === 0) return "no change";
  if (exitCode >= 16) return "fatal error; no files copied";
  const parts: string[] = [];
  if ((exitCode & 1) !== 0) parts.push("files copied");
  if ((exitCode & 2) !== 0) parts.push("extra files removed");
  if ((exitCode & 4) !== 0) parts.push("mismatched files or directories");
  if ((exitCode & 8) !== 0) parts.push("some files could not be copied");
  return parts.length > 0 ? parts.join("; ") : `exit ${String(exitCode)}`;
}

/** The exact commands a sync would run, in order. Used by `sync --dry-run`. */
export function buildRobocopyCommands(
  plan: SyncPlan,
  mirrorRoot: string,
  exe: string = DEFAULT_ROBOCOPY_EXE
): readonly RobocopyCommand[] {
  return plan.entries.map((entry) => {
    const source = joinUnderRoot(plan.sourceRoot, entry.subtree);
    const destination = joinUnderRoot(mirrorRoot, entry.subtree);
    const excludes = entry.excludeDirs.length > 0 ? ["/XD", ...entry.excludeDirs] : [];
    return {
      subtree: entry.subtree,
      exe,
      args: [source, destination, ...ROBOCOPY_FIXED_ARGS, ...excludes],
      source,
      destination
    };
  });
}

/** Run one subtree copy. Never throws: a failed spawn is a result, not an exception. */
export async function runRobocopy(command: RobocopyCommand): Promise<SubtreeSyncResult> {
  const run = await spawnRobocopy(command.exe, command.args);
  const ok = robocopyOk(run.exitCode);
  const records = countRobocopyRecords(run.stdout);
  const failure = ok
    ? undefined
    : [
        `${command.subtree}: ${describeRobocopyExit(run.exitCode)} (exit ${String(run.exitCode)})`,
        run.error ?? "",
        lastMeaningfulLine(run.stderr) || lastMeaningfulLine(run.stdout)
      ]
        .filter((part) => part !== "")
        .join(" — ");
  return {
    subtree: command.subtree,
    exitCode: run.exitCode,
    ok,
    copied: records.copied,
    removed: records.removed,
    ...(failure === undefined ? {} : { error: failure })
  };
}

/**
 * Create the manifest's stub directories as empty directories. `X:\Projects`
 * exists so that a package resolving it fails closed on an empty tree rather
 * than resolving to a path the guest cannot name at all.
 */
export async function ensureStubDirs(mirrorRoot: string, stubDirs: readonly string[]): Promise<readonly string[]> {
  const created: string[] = [];
  for (const stub of stubDirs) {
    const dir = joinUnderRoot(mirrorRoot, stub);
    await mkdir(dir, { recursive: true });
    created.push(dir);
  }
  return created;
}

/** Run the whole plan, create stubs, and write the mirror state file. */
export async function syncMirror(
  manifest: MirrorManifest,
  plan: SyncPlan,
  options: SyncOptions = {}
): Promise<MirrorSyncOutcome> {
  if (plan.sourceRoot !== manifest.sourceRoot) {
    throw new Error(
      `Sync plan was built against ${plan.sourceRoot} but the manifest declares ${manifest.sourceRoot}. ` +
      "Rebuild the plan from this manifest; the mirror must only ever hold what this manifest allows."
    );
  }
  const exe = options.robocopyExe ?? DEFAULT_ROBOCOPY_EXE;
  const now = options.now ?? ((): Date => new Date());

  await mkdir(manifest.mirrorRoot, { recursive: true });

  const results: SubtreeSyncResult[] = [];
  for (const command of buildRobocopyCommands(plan, manifest.mirrorRoot, exe)) {
    results.push(await runRobocopy(command));
  }

  const stubDirs = await ensureStubDirs(manifest.mirrorRoot, manifest.stubDirs);

  const state: MirrorStateFile = {
    manifestVersion: manifest.version,
    syncedAt: now().toISOString(),
    subtrees: results.map((result) => ({ subtree: result.subtree, ok: result.ok, exitCode: result.exitCode })),
    skippedVersions: plan.skippedVersions
  };
  const stateFile = join(manifest.mirrorRoot, MIRROR_STATE_FILE_NAME);
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  return {
    ok: results.every((result) => result.ok),
    mirrorRoot: manifest.mirrorRoot,
    stateFile,
    stubDirs,
    results,
    state
  };
}

interface RobocopyRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

function spawnRobocopy(exe: string, args: readonly string[]): Promise<RobocopyRun> {
  return new Promise<RobocopyRun>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (run: RobocopyRun): void => {
      if (settled) return;
      settled = true;
      resolve(run);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(exe, [...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish({ exitCode: -1, stdout, stderr, error: spawnFailureMessage(exe, messageOf(error)) });
      return;
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error: Error) => {
      finish({ exitCode: -1, stdout, stderr, error: spawnFailureMessage(exe, error.message) });
    });
    child.on("close", (code: number | null) => {
      finish({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

function spawnFailureMessage(exe: string, detail: string): string {
  return `cannot run ${exe}: ${detail}. Robocopy ships with Windows; pass --robocopy <path> if this host keeps it elsewhere.`;
}

/**
 * With `/NDL /NJH /NJS /BYTES` robocopy prints one tab-delimited line per file:
 * `<tag>\t\t<bytes>\t<full path>`, where the tag is `New File`, `Newer`,
 * `Changed`, `*EXTRA File` and friends. `*EXTRA` means the mirror deleted
 * something the source no longer has.
 */
export function countRobocopyRecords(stdout: string): { readonly copied: number; readonly removed: number } {
  let copied = 0;
  let removed = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes("\t")) continue;
    const cells = line.split("\t").map((cell) => cell.trim()).filter((cell) => cell.length > 0);
    const tag = cells[0];
    if (cells.length < 2 || tag === undefined || !/^\*?[A-Za-z]/.test(tag)) continue;
    if (tag.startsWith("*EXTRA")) removed += 1;
    else copied += 1;
  }
  return { copied, removed };
}

function lastMeaningfulLine(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  return lines[lines.length - 1] ?? "";
}
