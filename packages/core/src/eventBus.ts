/**
 * Synchronous in-process product event bus.
 *
 * Services publish session, turn, agent-event, and inventory changes here so
 * UI surfaces can react without polling stores. Dispatch is synchronous and
 * each handler is isolated: one throwing subscriber never affects the rest.
 */

import type {
  AgentQuestionRecord,
  AccessRequestRecord,
  AgentEvent,
  ChatSessionRecord,
  MemoryCandidateRecord,
  PlanDocRecord,
  RunId,
  SessionId,
  SubtaskId,
  TaskId,
  TranscriptLine,
  TurnTerminalStatus
} from "@drydock/contracts";

export type ProductBusEvent =
  | { readonly kind: "agent-event"; readonly sessionId: SessionId; readonly runId: RunId; readonly sequence: number; readonly event: AgentEvent }
  | { readonly kind: "transcript-line"; readonly sessionId: SessionId; readonly sequence: number; readonly line: TranscriptLine }
  | { readonly kind: "turn-started"; readonly sessionId: SessionId; readonly runId: RunId }
  | { readonly kind: "turn-completed"; readonly sessionId: SessionId; readonly runId: RunId; readonly status: TurnTerminalStatus }
  | { readonly kind: "session-updated"; readonly session: ChatSessionRecord }
  | { readonly kind: "session-deleted"; readonly sessionId: SessionId }
  | { readonly kind: "access-requested"; readonly request: AccessRequestRecord }
  | { readonly kind: "question-asked"; readonly question: AgentQuestionRecord }
  | { readonly kind: "memory-candidate-added"; readonly candidate: MemoryCandidateRecord }
  | { readonly kind: "plan-docs-updated"; readonly sessionId: SessionId; readonly docs: readonly PlanDocRecord[] }
  | { readonly kind: "inventory-changed" }
  | { readonly kind: "card-entered-done"; readonly taskId: TaskId; readonly subtaskId: SubtaskId }
  | { readonly kind: "board-changed" };

export type ProductBusHandler = (event: ProductBusEvent) => void;

export class ProductEventBus {
  private readonly handlers = new Set<ProductBusHandler>();

  subscribe(handler: ProductBusHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  publish(event: ProductBusEvent): void {
    for (const handler of [...this.handlers]) {
      try {
        handler(event);
      } catch {
        // Subscribers are isolated; a throwing handler must not affect others.
      }
    }
  }
}
