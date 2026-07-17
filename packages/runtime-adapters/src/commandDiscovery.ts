/**
 * Local command discovery for runtime control tools.
 *
 * Discovery prefers known standalone installs before PATH aliases that may be
 * unspawnable on Windows. Only native executables are eligible: batch shims
 * (.cmd/.bat) are skipped because the command runner refuses them - cmd.exe
 * argument parsing is not injection-safe for untrusted argv.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function discoverDockerSandboxCommand(environment: NodeJS.ProcessEnv = process.env): string | null {
  return findCommand(["sbx", "sbx.exe"], "SBX_PATH", [
    path.join(os.homedir(), "AppData", "Local", "DockerSandboxes", "bin", "sbx.exe")
  ], environment);
}

export function discoverStandaloneCodexCommand(environment: NodeJS.ProcessEnv = process.env): string | null {
  const localAppData = environment["LOCALAPPDATA"];
  const candidates: string[] = [];
  if (localAppData) {
    candidates.push(...discoverCodexBins(path.join(localAppData, "OpenAI", "Codex", "bin")));
  }
  return findCommand(["codex", "codex.exe"], "CODEX_PATH", candidates, environment);
}

export function findCommand(
  names: readonly string[],
  envKey: string,
  preferred: readonly string[] = [],
  environment: NodeJS.ProcessEnv = process.env
): string | null {
  const override = environment[envKey];
  if (override && existsSync(override)) {
    return override;
  }
  for (const candidate of preferred) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const pathEntries = (environment["PATH"] ?? "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? safeWindowsExtensions(environment["PATHEXT"])
    : [""];
  for (const entry of pathEntries) {
    for (const name of names) {
      const hasExtension = path.extname(name).length > 0;
      const probes = hasExtension ? [path.join(entry, name)] : extensions.map((ext) => path.join(entry, `${name}${ext.toLowerCase()}`));
      for (const probe of probes) {
        if (existsSync(probe)) {
          return probe;
        }
      }
    }
  }
  return null;
}

function safeWindowsExtensions(pathext: string | undefined): string[] {
  const configured = (pathext ?? ".EXE;.COM")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean);
  const safe = configured.filter((extension) => extension === ".exe" || extension === ".com");
  return safe.length > 0 ? safe : [".exe"];
}

function discoverCodexBins(root: string): string[] {
  try {
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const fullPath = path.join(root, entry.name, "codex.exe");
        const stat = existsSync(fullPath) ? statSync(fullPath) : null;
        return { fullPath, mtimeMs: stat?.mtimeMs ?? 0 };
      })
      .filter((entry) => entry.mtimeMs > 0)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((entry) => entry.fullPath);
  } catch {
    return [];
  }
}
