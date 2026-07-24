/**
 * Remote project picker plumbing (background-lane plan D2): search
 * GitHub/GitLab, clone the pick HOST-SIDE into the managed projects root,
 * and hand back what the catalog needs. The sandbox is never involved and
 * never sees a token.
 *
 * Token handling: tokens arrive per call from the extension layer (VS Code's
 * GitHub auth session or a SecretStorage-held GitLab PAT), are passed to git
 * through a GIT_ASKPASS helper script written 0600 into a temp dir and
 * deleted immediately after the clone - never on the command line, never in
 * git config, never rendered anywhere (ADR 0019 posture).
 */

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CommandRunner, ProjectOrigin } from "@drydock/contracts";
import type { Logger } from "@drydock/core";

export interface RemoteRepoHit {
  /** Provider-side path ("org/repo"). */
  readonly remotePath: string;
  readonly description?: string;
  readonly httpsUrl: string;
  readonly webUrl?: string;
  readonly defaultBranch?: string;
  readonly isPrivate: boolean;
}

/** Narrow fetch port so tests can run against canned JSON. */
export type JsonFetch = (url: string, headers: Record<string, string>) => Promise<unknown>;

export const defaultJsonFetch: JsonFetch = async (url, headers) => {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`${new URL(url).host} returned ${String(response.status)} ${response.statusText}`);
  }
  return response.json();
};

/** GitHub repository search (host-side REST; token optional for public search). */
export async function searchGitHub(query: string, token: string | undefined, fetchJson: JsonFetch = defaultJsonFetch): Promise<RemoteRepoHit[]> {
  const url = `https://api.github.com/search/repositories?per_page=20&q=${encodeURIComponent(query)}`;
  const payload = await fetchJson(url, {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "drydock",
    ...(token === undefined ? {} : { Authorization: `Bearer ${token}` })
  });
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item): RemoteRepoHit[] => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    if (typeof record["full_name"] !== "string" || typeof record["clone_url"] !== "string") return [];
    return [{
      remotePath: record["full_name"],
      httpsUrl: record["clone_url"],
      ...(typeof record["description"] === "string" && record["description"].length > 0 ? { description: record["description"] } : {}),
      ...(typeof record["html_url"] === "string" ? { webUrl: record["html_url"] } : {}),
      ...(typeof record["default_branch"] === "string" ? { defaultBranch: record["default_branch"] } : {}),
      isPrivate: record["private"] === true
    }];
  });
}

/** GitLab project search on any host (cloud or self-hosted), membership-scoped. */
export async function searchGitLab(host: string, query: string, token: string, fetchJson: JsonFetch = defaultJsonFetch): Promise<RemoteRepoHit[]> {
  const url = `https://${host}/api/v4/projects?per_page=20&membership=true&search=${encodeURIComponent(query)}`;
  const payload = await fetchJson(url, { "PRIVATE-TOKEN": token, "User-Agent": "drydock" });
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((item): RemoteRepoHit[] => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    if (typeof record["path_with_namespace"] !== "string" || typeof record["http_url_to_repo"] !== "string") return [];
    return [{
      remotePath: record["path_with_namespace"],
      httpsUrl: record["http_url_to_repo"],
      ...(typeof record["description"] === "string" && record["description"].length > 0 ? { description: record["description"] } : {}),
      ...(typeof record["web_url"] === "string" ? { webUrl: record["web_url"] } : {}),
      ...(typeof record["default_branch"] === "string" ? { defaultBranch: record["default_branch"] } : {}),
      isPrivate: record["visibility"] !== "public"
    }];
  });
}

/** Destination inside the managed projects root: <root>/<host>/<org>/<repo>. */
export function remoteCloneDestination(projectsRoot: string, host: string, remotePath: string): string {
  const safeSegments = remotePath.split("/").map((segment) => segment.replace(/[^A-Za-z0-9._-]/g, "_"));
  if (safeSegments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Remote path "${remotePath}" cannot map onto a safe folder name.`);
  }
  return path.join(projectsRoot, host.replace(/[^A-Za-z0-9._-]/g, "_"), ...safeSegments);
}

export interface CloneRemoteInput {
  readonly runner: CommandRunner;
  readonly logger: Logger;
  readonly httpsUrl: string;
  readonly destination: string;
  /** Absent clones anonymously (public repos). */
  readonly token?: string;
  /** GitHub tokens authenticate as x-access-token; GitLab PATs as oauth2. */
  readonly usernameForToken?: string;
  /**
   * The ONLY host the ASKPASS helper will answer for. A repo-shipped
   * `.lfsconfig`/submodule pointing anywhere else gets an empty answer, so
   * the token cannot be lured to an attacker endpoint (security audit F1).
   */
  readonly tokenHost?: string;
}

/**
 * Host-side clone of a remote pick. The token (when present) reaches git
 * only through a GIT_ASKPASS helper: a 0600 temp script echoing username or
 * password per prompt, removed in `finally`. Nothing token-shaped touches
 * argv, git config, or the clone's own directory.
 */
export async function cloneRemoteProject(input: CloneRemoteInput): Promise<void> {
  await mkdir(path.dirname(input.destination), { recursive: true });
  const parsed = new URL(input.httpsUrl);
  if (parsed.protocol !== "https:") {
    throw new Error(`Remote clones are https-only; refusing ${parsed.protocol}//.`);
  }
  let askpassDir: string | undefined;
  // Hardened posture (security audit F1), mirroring cloneSyncService: strip
  // every inherited GIT_* (no ambient tracing that could print auth headers,
  // no config overrides), ignore system config, and keep LFS/submodules from
  // fetching ANYTHING during checkout - a repo-shipped .lfsconfig or
  // .gitmodules must not initiate authenticated requests to arbitrary hosts.
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith("GIT_")) env[key] = value;
  }
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["GIT_CONFIG_NOSYSTEM"] = "1";
  env["GIT_LFS_SKIP_SMUDGE"] = "1";
  const hardening = [
    "-c", "filter.lfs.smudge=",
    "-c", "filter.lfs.process=",
    "-c", "filter.lfs.required=false",
    "-c", "submodule.recurse=false",
    "-c", "credential.helper="
  ];
  try {
    if (input.token !== undefined) {
      askpassDir = await mkdtemp(path.join(os.tmpdir(), "drydock-askpass-"));
      const isWindows = process.platform === "win32";
      const script = path.join(askpassDir, isWindows ? "askpass.cmd" : "askpass.sh");
      // Git invokes ASKPASS once per prompt with the prompt text as arg 1;
      // the script answers from env, never argv - and ONLY for the intended
      // host: any other host's prompt gets an empty answer.
      if (isWindows) {
        const cmdBody = [
          "@echo off",
          "echo %1 | findstr /i /c:\"%DRYDOCK_GIT_HOST%\" >nul",
          "if not %errorlevel%==0 (echo. & exit /b 0)",
          "echo %1 | findstr /i \"sername\" >nul",
          "if %errorlevel%==0 (echo %DRYDOCK_GIT_USERNAME%) else (echo %DRYDOCK_GIT_TOKEN%)",
          ""
        ].join("\r\n");
        await writeFile(script, cmdBody, { encoding: "utf8" });
      } else {
        const shBody = [
          "#!/bin/sh",
          "case \"$1\" in *\"$DRYDOCK_GIT_HOST\"*) ;; *) echo \"\"; exit 0;; esac",
          "case \"$1\" in *sername*) echo \"$DRYDOCK_GIT_USERNAME\";; *) echo \"$DRYDOCK_GIT_TOKEN\";; esac",
          ""
        ].join("\n");
        await writeFile(script, shBody, { encoding: "utf8", mode: 0o600 });
        await chmod(script, 0o700);
      }
      env["GIT_ASKPASS"] = script;
      env["DRYDOCK_GIT_USERNAME"] = input.usernameForToken ?? "x-access-token";
      env["DRYDOCK_GIT_TOKEN"] = input.token;
      env["DRYDOCK_GIT_HOST"] = input.tokenHost ?? parsed.host;
    }
    const result = await input.runner.run(
      "git",
      [...hardening, "clone", "--no-recurse-submodules", "--", input.httpsUrl, input.destination],
      {
        cwd: path.dirname(input.destination),
        timeoutMs: 10 * 60_000,
        env
      }
    );
    if (result.exitCode !== 0) {
      throw new Error(`git clone failed: ${(result.stderr || result.stdout || "unknown error").slice(0, 400)}`);
    }
  } finally {
    if (askpassDir !== undefined) {
      await rm(askpassDir, { recursive: true, force: true });
    }
  }
}

/** Catalog origin metadata for a landed remote pick. */
export function originFor(provider: "github" | "gitlab", host: string, hit: RemoteRepoHit): ProjectOrigin {
  return {
    provider,
    host,
    remotePath: hit.remotePath,
    ...(hit.webUrl === undefined ? {} : { webUrl: hit.webUrl }),
    ...(hit.defaultBranch === undefined ? {} : { defaultBranch: hit.defaultBranch })
  };
}
