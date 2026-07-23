/**
 * Provider registry: the shared description of every AI provider Drydock can
 * run, native or ridden.
 *
 * New providers do not get new transports or new runtime policy. They ride one
 * of the two agent CLIs that already ship in the sandbox images (Codex via
 * OpenAI-compatible endpoints, Claude Code via Anthropic-compatible
 * endpoints), and every entry declares exactly how: which sandbox image hosts
 * it, how sign-in works, how the CLI is pointed at the provider, and which
 * scoped egress the sandbox needs. Registry data is display-safe by
 * construction - it never carries secret material, only names, URLs, and env
 * var NAMES.
 */

import type { AgentModelSummary, AgentTransport } from "./agent.js";

/** Sandbox agent image kinds Docker Sandbox can create (`sbx create <kind>`). */
export type SandboxAgentKind = "codex" | "claude";

/**
 * In-sandbox path holding a runtime-scoped provider token for providers whose
 * key lives in VS Code SecretStorage rather than the Docker Sandbox secret
 * ledger. Written per runtime generation over the exec side-channel (mode
 * 0600, tmpfs); it never touches a workspace mount or host storage.
 */
export const PROVIDER_TOKEN_FILE = "/tmp/.drydock-provider-token";

/** How the riding CLI is pointed at a non-native provider endpoint. */
export interface ProviderWireConfig {
  readonly kind: "openai-compat" | "anthropic-compat";
  readonly baseUrl: string;
  /**
   * openai-compat only: the env var the Codex CLI reads for this provider's
   * key (`model_providers.<id>.env_key`). Inside the sandbox it holds the
   * `proxy-managed` sentinel; the Docker Sandbox proxy injects the real value
   * at the HTTPS layer.
   */
  readonly envKey?: string;
  /**
   * anthropic-compat only: model id substituted into Claude Code's
   * background/fast-model slot so rider endpoints are never asked for
   * Anthropic model ids.
   */
  readonly smallFastModel?: string;
}

/** How a provider is signed in and how its auth status is probed. */
export interface ProviderConnectSpec {
  /**
   * Guided OAuth strategy, when the provider supports OAuth at all:
   * - "sbx-service-oauth": `sbx secret set -g <service> --oauth` runs the
   *   flow on the host (browser + localhost callback both work natively).
   * - "claude-host-token": host `claude setup-token` mints a long-lived
   *   subscription token which is then piped into the Docker Sandbox secret
   *   ledger; falls back to "sandbox-terminal" when no host Claude CLI exists.
   * - "sandbox-terminal": interactive sign-in inside a throwaway sandbox
   *   terminal (the historical Claude path; kept as the fallback).
   */
  readonly oauth?: "sbx-service-oauth" | "claude-host-token" | "sandbox-terminal";
  /** API-key entry, when supported. */
  readonly apiKey?: {
    /**
     * Docker Sandbox built-in service secret backing this key. When present
     * the key goes into the OS keychain via `sbx secret set -g <service>` and
     * the sandbox proxy injects it; Drydock never stores it. When absent the
     * key is stored in VS Code SecretStorage (`vscode-secret:<provider>`) and
     * injected runtime-scoped via PROVIDER_TOKEN_FILE.
     */
    readonly sbxService?: string;
    /** Where the user creates a key; rendered as a link on the connect card. */
    readonly keyUrl: string;
  };
  /**
   * Docker Sandbox service name whose presence in `sbx secret ls` means
   * "authenticated". Providers without one are probed via the VS Code
   * SecretStorage reference instead.
   */
  readonly sbxService?: string;
}

export interface ProviderDescriptor {
  readonly providerId: string;
  readonly displayName: string;
  /** Which sandbox agent image (and therefore which CLI) hosts this provider. */
  readonly ride: SandboxAgentKind;
  readonly connect: ProviderConnectSpec;
  /** Absent for the native providers (the CLI already knows its own service). */
  readonly wire?: ProviderWireConfig;
  /** Scoped egress entries (`host:port`) for `sbx policy allow network`. */
  readonly egress: readonly string[];
  /** Static seed catalog for providers without live model discovery. */
  readonly models: readonly AgentModelSummary[];
  /** Diagnostic shown with the static catalog. */
  readonly catalogDiagnostic?: string;
}

export const CODEX_EGRESS = ["chatgpt.com:443", "ab.chatgpt.com:443", "files.openai.com:443", "api.openai.com:443"] as const;
export const CLAUDE_EGRESS = [
  "api.anthropic.com:443",
  "claude.ai:443",
  "console.anthropic.com:443",
  "statsig.anthropic.com:443",
  "sentry.io:443"
] as const;

export const PROVIDER_REGISTRY: readonly ProviderDescriptor[] = [
  {
    providerId: "codex",
    displayName: "Codex / OpenAI",
    ride: "codex",
    connect: {
      oauth: "sbx-service-oauth",
      apiKey: { sbxService: "openai", keyUrl: "https://platform.openai.com/api-keys" },
      sbxService: "openai"
    },
    egress: CODEX_EGRESS,
    models: []
  },
  {
    providerId: "claude",
    displayName: "Claude / Anthropic",
    ride: "claude",
    connect: {
      oauth: "claude-host-token",
      apiKey: { sbxService: "anthropic", keyUrl: "https://console.anthropic.com/settings/keys" },
      sbxService: "anthropic"
    },
    egress: CLAUDE_EGRESS,
    models: []
  },
  {
    providerId: "openrouter",
    displayName: "OpenRouter",
    ride: "codex",
    connect: {
      apiKey: { sbxService: "openrouter", keyUrl: "https://openrouter.ai/settings/keys" },
      sbxService: "openrouter"
    },
    wire: {
      kind: "openai-compat",
      baseUrl: "https://openrouter.ai/api/v1",
      envKey: "OPENROUTER_API_KEY"
    },
    egress: ["openrouter.ai:443"],
    models: [
      { id: "openrouter/auto", displayName: "Auto (best available)", isDefault: true, hidden: false },
      { id: "anthropic/claude-sonnet-4.5", displayName: "Claude Sonnet 4.5", isDefault: false, hidden: false },
      { id: "deepseek/deepseek-v4", displayName: "DeepSeek V4", isDefault: false, hidden: false },
      { id: "qwen/qwen3-coder", displayName: "Qwen3 Coder", isDefault: false, hidden: false },
      { id: "moonshotai/kimi-k2.7", displayName: "Kimi K2.7", isDefault: false, hidden: false },
      { id: "z-ai/glm-5.2", displayName: "GLM 5.2", isDefault: false, hidden: false }
    ],
    catalogDiagnostic: "Static OpenRouter seed catalog; any openrouter.ai model id can be typed manually."
  },
  {
    providerId: "deepseek",
    displayName: "DeepSeek",
    ride: "claude",
    connect: {
      apiKey: { keyUrl: "https://platform.deepseek.com/api_keys" }
    },
    wire: {
      kind: "anthropic-compat",
      baseUrl: "https://api.deepseek.com/anthropic",
      smallFastModel: "deepseek-chat"
    },
    egress: ["api.deepseek.com:443"],
    models: [
      { id: "deepseek-chat", displayName: "DeepSeek Chat (V4)", isDefault: true, hidden: false },
      { id: "deepseek-reasoner", displayName: "DeepSeek Reasoner", isDefault: false, hidden: false }
    ],
    catalogDiagnostic: "Static DeepSeek catalog (Anthropic-compatible endpoint; see api-docs.deepseek.com)."
  },
  {
    providerId: "kimi",
    displayName: "Kimi / Moonshot",
    ride: "claude",
    connect: {
      apiKey: { keyUrl: "https://platform.moonshot.ai/console/api-keys" }
    },
    wire: {
      kind: "anthropic-compat",
      baseUrl: "https://api.moonshot.ai/anthropic",
      smallFastModel: "kimi-k2.7-code"
    },
    egress: ["api.moonshot.ai:443"],
    models: [
      { id: "kimi-k2.7-code", displayName: "Kimi K2.7 Code", isDefault: true, hidden: false },
      { id: "kimi-k3", displayName: "Kimi K3", isDefault: false, hidden: false }
    ],
    catalogDiagnostic: "Static Kimi catalog (Anthropic-compatible endpoint; see platform.moonshot.ai)."
  }
];

const REGISTRY_BY_ID: ReadonlyMap<string, ProviderDescriptor> = new Map(
  PROVIDER_REGISTRY.map((descriptor) => [descriptor.providerId, descriptor])
);

export function providerDescriptor(providerId: string): ProviderDescriptor | undefined {
  return REGISTRY_BY_ID.get(providerId);
}

export function isRegisteredProvider(providerId: string): boolean {
  return REGISTRY_BY_ID.has(providerId);
}

/** The transport a provider's sessions run on (follows the ride, not the id). */
export function providerTransport(providerId: string): AgentTransport {
  const ride = providerDescriptor(providerId)?.ride ?? (providerId === "claude" ? "claude" : "codex");
  return ride === "claude" ? "claude-exec-json" : "codex-app-server";
}

/** Comma-joined egress list in the `networkResources` advanced-option format. */
export function providerEgressResources(providerId: string): string | undefined {
  const descriptor = providerDescriptor(providerId);
  return descriptor === undefined || descriptor.egress.length === 0 ? undefined : descriptor.egress.join(",");
}

/** The default model id of a descriptor's static catalog, if any. */
export function providerDefaultModel(providerId: string): string | undefined {
  const models = providerDescriptor(providerId)?.models ?? [];
  return (models.find((model) => model.isDefault) ?? models[0])?.id;
}
