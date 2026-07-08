/**
 * Docker Sandbox runtime templates.
 *
 * The isolated-run template always mounts the disposable workspace. Workspace
 * sets can add project roots whose mode follows the session mode: plan mode
 * mounts read-only, implementation mode read-write. Scoped provider service
 * egress is granted through adapter-owned policy commands; the sandbox agent
 * kind follows the selected provider.
 */

import type { RuntimeTemplate, SessionMode } from "@drydock/contracts";
import type { IdGenerator } from "./ids.js";
import { buildMountPolicy } from "./mountPolicy.js";

export const CODEX_SERVICE_NETWORK_RESOURCES = "chatgpt.com:443,ab.chatgpt.com:443,files.openai.com:443,api.openai.com:443";
export const CLAUDE_SERVICE_NETWORK_RESOURCES = "api.anthropic.com:443,claude.ai:443,console.anthropic.com:443,statsig.anthropic.com:443,sentry.io:443";

export type SandboxProvider = "codex" | "claude";

const PROVIDER_NETWORK_RESOURCES: Readonly<Record<SandboxProvider, string>> = {
  codex: CODEX_SERVICE_NETWORK_RESOURCES,
  claude: CLAUDE_SERVICE_NETWORK_RESOURCES
};

/**
 * Returns a copy of a template rebound to a different sandbox provider — swaps
 * the sandbox agent image, the scoped egress allowlist, and the provider tags,
 * keeping every provider-agnostic field (mounts, workspace, mode) intact. Used
 * when a live session switches provider: the new agent must run in ITS OWN
 * sandbox (e.g. Codex can't run inside the Claude image), so reusing the old
 * template is what left `codex app-server` hanging on initialize.
 */
export function withSandboxProvider(template: RuntimeTemplate, provider: SandboxProvider): RuntimeTemplate {
  return {
    ...template,
    id: `isolated-run-docker-sandbox-${provider}`,
    name: `Isolated Run Docker Sandbox ${provider === "codex" ? "Codex" : "Claude"}`,
    adapterProviderIds: [provider],
    advancedOptions: {
      ...template.advancedOptions,
      sandboxAgent: provider,
      networkResources: PROVIDER_NETWORK_RESOURCES[provider]
    }
  };
}

export function buildIsolatedRunTemplate(input: {
  readonly workspacePath: string;
  readonly ids: IdGenerator;
  readonly approvedAt: string;
  /** Sandbox agent provider; defaults to codex. */
  readonly provider?: SandboxProvider;
  /** Real project roots mounted alongside the disposable workspace. */
  readonly projectRoots?: readonly string[];
  /** Subset of projectRoots that must mount read-only even in implementation mode. */
  readonly readOnlyRoots?: readonly string[];
  /** Session mode governing project-root write access. Defaults to implementation. */
  readonly sessionMode?: SessionMode;
  readonly deniedPaths?: readonly string[];
}): RuntimeTemplate {
  const projectRoots = input.projectRoots ?? [];
  const sessionMode = input.sessionMode ?? "implementation";
  const provider: SandboxProvider = input.provider ?? "codex";
  return {
    id: `isolated-run-docker-sandbox-${provider}`,
    name: `Isolated Run Docker Sandbox ${provider === "codex" ? "Codex" : "Claude"}`,
    type: "docker-sandbox",
    network: "allowed",
    mounts: [
      // The disposable workspace is always writable: it is the agent's cwd and
      // is product-owned, so plan mode restrictions never apply to it.
      ...buildMountPolicy({
        mode: "implementation",
        workspaceRoots: [input.workspacePath],
        sharedRead: [],
        sharedWrite: [],
        approvedBy: "isolated-run",
        approvedAt: input.approvedAt
      }, input.ids),
      ...buildMountPolicy({
        mode: sessionMode,
        workspaceRoots: projectRoots,
        ...(input.readOnlyRoots === undefined ? {} : { readOnlyRoots: input.readOnlyRoots }),
        sharedRead: [],
        sharedWrite: [],
        ...(input.deniedPaths === undefined ? {} : { deniedPaths: input.deniedPaths }),
        approvedBy: "workspace-set",
        approvedAt: input.approvedAt
      }, input.ids)
    ],
    environment: {},
    adapterProviderIds: [provider],
    advancedOptions: {
      sandboxAgent: provider,
      networkResources: PROVIDER_NETWORK_RESOURCES[provider]
    }
  };
}
