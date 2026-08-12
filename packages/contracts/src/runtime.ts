/**
 * Runtime isolation and inventory contracts.
 *
 * These shapes describe the durable lifecycle ledger for every sandbox the
 * product starts or adopts.
 */

import type {
  AgentId,
  AgentRole,
  ChatId,
  MountId,
  RuntimeGenerationId,
  RuntimeId,
  SessionId,
  WorkspaceRootId
} from "./ids.js";
import type { JsonObject } from "./json.js";

/**
 * `hyperv` is the validation-runtime class (ADR 0022): a product-adopted
 * Windows VM that only ever runs validation jobs, never agent sessions.
 */
export type RuntimeAdapterKind = "docker-sandbox" | "docker" | "wsl" | "hyperv" | "custom";

export type RuntimeStatus =
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "removing"
  | "removed"
  | "quarantined"
  | "reset-required"
  | "lost";

export interface MountPolicy {
  readonly mountId: MountId;
  readonly hostPath: string;
  readonly runtimePath: string;
  readonly mode: "read-only" | "read-write";
  readonly source: "workspace-root" | "shared-read" | "shared-write" | "clone" | "temporary";
  readonly approvedBy?: string;
  readonly approvedAt?: string;
}

export interface RuntimeTemplate {
  readonly id: string;
  readonly name?: string;
  readonly type: RuntimeAdapterKind;
  readonly image?: string;
  readonly cpuLimit?: number;
  readonly memoryMb?: number;
  readonly network: "disabled" | "allowed" | "future-remote-only";
  readonly mounts: readonly MountPolicy[];
  readonly environment: Readonly<Record<string, string>>;
  readonly adapterProviderIds: readonly string[];
  readonly advancedOptions: JsonObject;
}

export interface RuntimeInventoryRecord {
  readonly runtimeId: RuntimeId;
  readonly runtimeGenerationId: RuntimeGenerationId;
  readonly sessionId: SessionId;
  readonly chatId: ChatId;
  readonly agentId?: AgentId;
  readonly agentRole?: AgentRole;
  readonly templateId: string;
  readonly adapter: RuntimeAdapterKind;
  readonly externalName: string;
  readonly externalId?: string;
  readonly workspaceOwnerToken?: string;
  readonly status: RuntimeStatus;
  readonly startedAt: string;
  readonly stoppedAt?: string;
  readonly removedAt?: string;
  readonly lastSeenAt?: string;
  readonly lastCleanupAttemptAt?: string;
  readonly cleanupFailureCount: number;
  readonly metadata: JsonObject;
}

export interface RuntimeInventoryAdapterCounters {
  readonly starts: number;
  readonly stops: number;
  readonly removeAttempts: number;
  readonly removeFailures: number;
  readonly forceCleanups: number;
  readonly quarantined: number;
  readonly resetRequired: number;
}

export interface RuntimeInventoryRoleCounters {
  readonly starts: number;
  readonly active: number;
  readonly stopped: number;
}

export interface RuntimeInventoryCounters {
  readonly runtimeStartsTotal: number;
  readonly runtimeStopsTotal: number;
  readonly runtimeRemoveAttemptsTotal: number;
  readonly runtimeRemoveFailuresTotal: number;
  readonly runtimeForceCleanupTotal: number;
  readonly runtimeQuarantinedTotal: number;
  readonly runtimeResetRequiredTotal: number;
  readonly activeCount: number;
  readonly stoppedCount: number;
  readonly orphanedCount: number;
  readonly failedCleanupCount: number;
  readonly byAdapter: Readonly<Record<string, RuntimeInventoryAdapterCounters>>;
  readonly byAgentRole: Readonly<Record<string, RuntimeInventoryRoleCounters>>;
  readonly lastReconciledAt?: string;
}

export interface RuntimeHandle {
  readonly runtimeId: RuntimeId;
  readonly runtimeGenerationId: RuntimeGenerationId;
  readonly sessionId: SessionId;
  readonly adapter: RuntimeAdapterKind;
  readonly externalName: string;
  readonly workspacePath: string;
  readonly runtimeCwd?: string;
  readonly mounts: readonly MountPolicy[];
  readonly status: "running";
}

export interface StartRuntimeRequest {
  readonly sessionId: SessionId;
  readonly chatId: ChatId;
  readonly agentId?: AgentId;
  readonly agentRole: AgentRole;
  readonly template: RuntimeTemplate;
  readonly workspacePath: string;
  readonly workspaceOwnerToken?: string;
  readonly generationId: RuntimeGenerationId;
  readonly runtimeId: RuntimeId;
}

export interface StopRuntimeRequest {
  readonly runtimeId: RuntimeId;
  readonly reason: string;
}

export interface RuntimeCheckpoint {
  readonly runtimeId: RuntimeId;
  readonly runtimeGenerationId: RuntimeGenerationId;
  readonly artifactRef: string;
  readonly createdAt: string;
  readonly reason: string;
}

export interface RestartRuntimeRequest {
  readonly runtimeId: RuntimeId;
  readonly nextGenerationId: RuntimeGenerationId;
  readonly addedMounts: readonly MountPolicy[];
  readonly reason: string;
}

export interface RestoreRuntimeCheckpointRequest {
  readonly checkpoint: RuntimeCheckpoint;
  readonly workspaceRoots: readonly WorkspaceRootId[];
}

export type CleanupMode = "graceful" | "force-remove" | "quarantine-only";

export interface CleanupResult {
  readonly runtimeId: RuntimeId;
  readonly status: "removed" | "quarantined" | "failed";
  readonly mode: CleanupMode;
  readonly diagnostics: readonly string[];
}

export interface RuntimeInventoryReconcileResult {
  readonly reconciledAt: string;
  readonly externalOnly: readonly string[];
  readonly missingExternal: readonly RuntimeId[];
  /**
   * Rows this pass could not judge, because no adapter is registered for their
   * kind or that adapter's listing failed (ADR 0022 M3). They are left
   * UNTOUCHED: "we could not look" is not evidence the runtime is gone, and
   * marking it lost on absence of evidence is exactly the silent degradation
   * the honesty rules forbid.
   */
  readonly unresolvedAdapters?: readonly RuntimeId[];
}
