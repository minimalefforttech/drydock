/**
 * Product ID generation helpers.
 *
 * The generator keeps stable prefixes while hiding host paths and prompt text.
 */

import { randomUUID } from "node:crypto";
import type {
  AccessRequestId,
  AgentId,
  AgentQuestionId,
  BaselineId,
  ChatId,
  ColumnId,
  EventId,
  MemoryCandidateId,
  MountId,
  PlanAnnotationId,
  PlanArtifactId,
  PlanId,
  ProjectId,
  ReviewCommentId,
  ReviewSessionId,
  RunId,
  RuntimeGenerationId,
  RuntimeId,
  SessionId,
  SubtaskId,
  TaskId,
  WorkspaceSetId
} from "@drydock/contracts";
import { asId } from "@drydock/contracts";

export interface IdGenerator {
  sessionId(): SessionId;
  chatId(): ChatId;
  runtimeId(): RuntimeId;
  runtimeGenerationId(): RuntimeGenerationId;
  agentId(): AgentId;
  runId(): RunId;
  mountId(): MountId;
  eventId(): EventId;
  projectId(): ProjectId;
  workspaceSetId(): WorkspaceSetId;
  accessRequestId(): AccessRequestId;
  agentQuestionId(): AgentQuestionId;
  baselineId(): BaselineId;
  reviewSessionId(): ReviewSessionId;
  reviewCommentId(): ReviewCommentId;
  taskId(): TaskId;
  memoryCandidateId(): MemoryCandidateId;
  columnId(): ColumnId;
  subtaskId(): SubtaskId;
  planId(): PlanId;
  planArtifactId(): PlanArtifactId;
  planAnnotationId(): PlanAnnotationId;
}

export class RandomIdGenerator implements IdGenerator {
  sessionId(): SessionId {
    return asId<"SessionId">(`session-${shortUuid()}`);
  }

  chatId(): ChatId {
    return asId<"ChatId">(`chat-${shortUuid()}`);
  }

  runtimeId(): RuntimeId {
    return asId<"RuntimeId">(`runtime-${shortUuid()}`);
  }

  runtimeGenerationId(): RuntimeGenerationId {
    return asId<"RuntimeGenerationId">(`generation-${shortUuid()}`);
  }

  agentId(): AgentId {
    return asId<"AgentId">(`agent-${shortUuid()}`);
  }

  runId(): RunId {
    return asId<"RunId">(`run-${shortUuid()}`);
  }

  mountId(): MountId {
    return asId<"MountId">(`mount-${shortUuid()}`);
  }

  eventId(): EventId {
    return asId<"EventId">(`event-${shortUuid()}`);
  }

  projectId(): ProjectId {
    return asId<"ProjectId">(`project-${shortUuid()}`);
  }

  workspaceSetId(): WorkspaceSetId {
    return asId<"WorkspaceSetId">(`workspace-set-${shortUuid()}`);
  }

  accessRequestId(): AccessRequestId {
    return asId<"AccessRequestId">(`access-request-${shortUuid()}`);
  }

  agentQuestionId(): AgentQuestionId {
    return asId<"AgentQuestionId">(`question-${shortUuid()}`);
  }

  baselineId(): BaselineId {
    return asId<"BaselineId">(`baseline-${shortUuid()}`);
  }

  reviewSessionId(): ReviewSessionId {
    return asId<"ReviewSessionId">(`review-${shortUuid()}`);
  }

  reviewCommentId(): ReviewCommentId {
    return asId<"ReviewCommentId">(`comment-${shortUuid()}`);
  }

  taskId(): TaskId {
    return asId<"TaskId">(`task-${shortUuid()}`);
  }

  memoryCandidateId(): MemoryCandidateId {
    return asId<"MemoryCandidateId">(`memory-${shortUuid()}`);
  }

  columnId(): ColumnId {
    return asId<"ColumnId">(`col-${shortUuid()}`);
  }

  subtaskId(): SubtaskId {
    return asId<"SubtaskId">(`subtask-${shortUuid()}`);
  }

  planId(): PlanId {
    return asId<"PlanId">(`plan-${shortUuid()}`);
  }

  planArtifactId(): PlanArtifactId {
    return asId<"PlanArtifactId">(`plart-${shortUuid()}`);
  }

  planAnnotationId(): PlanAnnotationId {
    return asId<"PlanAnnotationId">(`plnote-${shortUuid()}`);
  }
}

/** Returns a lowercase ID fragment safe for runtime names. */
export function idFragment(value: string, length = 8): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").slice(-length).toLowerCase() || shortUuid();
}

function shortUuid(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

