/**
 * Agent adapter contracts.
 *
 * Prompt-bearing methods require an isolated runtime connection. Implementers
 * must not fall back to host-side model turns.
 */

import type { ProductError } from "./errors.js";
import type { AgentEvent } from "./events.js";
import type { AgentId, AgentRole, ProviderId, RunId, SecretRef, SessionId } from "./ids.js";
import type { JsonObject } from "./json.js";
import type { RuntimeHandle } from "./runtime.js";

export interface AdapterDetectionResult {
  readonly available: boolean;
  readonly version?: string;
  readonly diagnostics: readonly string[];
}

export interface AuthValidationResult {
  readonly status: "authenticated" | "missing" | "unknown";
  readonly secretRefs: readonly SecretRef[];
  readonly diagnostics: readonly string[];
}

export interface AdapterAuthContext {
  readonly target: "host-inert" | "runtime";
  readonly runtime?: RuntimeHandle;
}

export interface AgentCapabilities {
  readonly providerId: ProviderId;
  readonly supportsExecJson: boolean;
  readonly supportsAppServer: boolean;
  readonly supportsCancel: boolean;
  readonly eventFamilies: readonly string[];
}

export interface AgentModelSummary {
  /** Stable picker value sent back to the provider when starting a turn. */
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly isDefault: boolean;
  readonly hidden: boolean;
}

/** Inertly detected sign-in state for a provider's isolated backend. */
export type ProviderAuthStatus = "authenticated" | "needs-login" | "unknown";

export interface AgentModelCatalog {
  readonly providerId: string;
  readonly displayName: string;
  readonly models: readonly AgentModelSummary[];
  readonly refreshedAt: string;
  readonly source: "provider" | "fallback";
  readonly diagnostics: readonly string[];
  readonly authStatus?: ProviderAuthStatus;
  /** Display-safe command the user can run to sign the provider in. */
  readonly loginHint?: string;
}

export interface AgentContextMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export type AgentTransport = "codex-exec-json" | "codex-app-server" | "claude-exec-json";

export interface StartAgentProtocolRequest {
  readonly sessionId: SessionId;
  readonly agentId: AgentId;
  readonly agentRole: AgentRole;
  readonly runtime: RuntimeHandle;
  readonly transport: AgentTransport;
}

export interface AgentConnection {
  readonly providerId: ProviderId;
  readonly connectionId: string;
  readonly sessionId: SessionId;
  readonly agentId: AgentId;
  readonly agentRole: AgentRole;
  readonly runtime: RuntimeHandle;
  readonly transport: string;
}

export interface AgentPrompt {
  readonly text: string;
  readonly cwd?: string;
  readonly metadata?: JsonObject;
}

export interface AgentAdapter {
  readonly providerId: ProviderId;
  detect(): Promise<AdapterDetectionResult>;
  validateAuth(context: AdapterAuthContext): Promise<AuthValidationResult>;
  startProtocol(request: StartAgentProtocolRequest): Promise<AgentConnection>;
  listModels(connection: AgentConnection): Promise<AgentModelCatalog>;
  restoreContext(connection: AgentConnection, messages: readonly AgentContextMessage[]): Promise<void>;
  sendPrompt(connection: AgentConnection, prompt: AgentPrompt): Promise<RunId>;
  streamEvents(connection: AgentConnection, runId: RunId): AsyncIterable<AgentEvent>;
  cancel(connection: AgentConnection, runId: RunId): Promise<void>;
  stop(connection: AgentConnection, reason: string): Promise<void>;
  summarizeCapabilities(): Promise<AgentCapabilities>;
}

export interface AppServerProbeResult {
  readonly status: "pass" | "blocked";
  readonly threadId?: string;
  readonly turnId?: string;
  readonly diagnostics: readonly string[];
  readonly error?: ProductError;
}
