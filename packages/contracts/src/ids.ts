/**
 * Opaque product identity types.
 *
 * IDs are serialized as strings at boundaries, but branded in TypeScript so
 * unrelated persistent records cannot be mixed accidentally.
 */

export type Brand<T, TBrand extends string> = T & { readonly __brand: TBrand };

export type RuntimeId = Brand<string, "RuntimeId">;
export type RuntimeGenerationId = Brand<string, "RuntimeGenerationId">;
export type SessionId = Brand<string, "SessionId">;
export type ChatId = Brand<string, "ChatId">;
export type RunId = Brand<string, "RunId">;
export type AgentId = Brand<string, "AgentId">;
export type TaskId = Brand<string, "TaskId">;
export type ProviderId = Brand<string, "ProviderId">;
export type ModelProfileId = Brand<string, "ModelProfileId">;
export type SecretRef = Brand<string, "SecretRef">;
export type WorkspaceRootId = Brand<string, "WorkspaceRootId">;
export type MountId = Brand<string, "MountId">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type EventId = Brand<string, "EventId">;
export type ProjectId = Brand<string, "ProjectId">;
export type WorkspaceSetId = Brand<string, "WorkspaceSetId">;
export type AccessRequestId = Brand<string, "AccessRequestId">;
export type AgentQuestionId = Brand<string, "AgentQuestionId">;
export type MemoryCandidateId = Brand<string, "MemoryCandidateId">;
export type BaselineId = Brand<string, "BaselineId">;
export type ReviewSessionId = Brand<string, "ReviewSessionId">;
export type ReviewCommentId = Brand<string, "ReviewCommentId">;
export type ColumnId = Brand<string, "ColumnId">;
export type SubtaskId = Brand<string, "SubtaskId">;
export type PlanId = Brand<string, "PlanId">;
export type PlanArtifactId = Brand<string, "PlanArtifactId">;
export type PlanAnnotationId = Brand<string, "PlanAnnotationId">;

export type AgentRole = "researcher" | "planner" | "worker" | "tester" | "reviewer" | "memory-extractor";

/** Casts a persisted string into an opaque ID after a trusted boundary validated it. */
export function asId<T extends string>(value: string): Brand<string, T> {
  return value as Brand<string, T>;
}

