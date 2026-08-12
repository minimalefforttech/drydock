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
  PlanId,
  RunId,
  SessionId,
  SubtaskId,
  TaskId,
  TranscriptLine,
  TurnTerminalStatus,
  ValidationJobId,
  ValidationJobState,
  ValidationRuntimeId
} from "@drydock/contracts";

export type ProductBusEvent =
  | { readonly kind: "agent-event"; readonly sessionId: SessionId; readonly runId: RunId; readonly sequence: number; readonly event: AgentEvent }
  | { readonly kind: "transcript-line"; readonly sessionId: SessionId; readonly sequence: number; readonly line: TranscriptLine }
  | { readonly kind: "turn-started"; readonly sessionId: SessionId; readonly runId: RunId }
  | { readonly kind: "turn-completed"; readonly sessionId: SessionId; readonly runId: RunId; readonly status: TurnTerminalStatus }
  | { readonly kind: "session-updated"; readonly session: ChatSessionRecord }
  | { readonly kind: "session-deleted"; readonly sessionId: SessionId }
  | { readonly kind: "access-requested"; readonly request: AccessRequestRecord }
  /** A pending access request was approved or denied (any surface). */
  | { readonly kind: "access-resolved"; readonly request: AccessRequestRecord }
  | { readonly kind: "question-asked"; readonly question: AgentQuestionRecord }
  /** A pending agent question was answered or dismissed (any surface). */
  | { readonly kind: "question-resolved"; readonly question: AgentQuestionRecord }
  | { readonly kind: "memory-candidate-added"; readonly candidate: MemoryCandidateRecord }
  | { readonly kind: "preview-available"; readonly preview: import("@drydock/contracts").PreviewSummary }
  | { readonly kind: "inventory-changed" }
  | { readonly kind: "card-entered-done"; readonly taskId: TaskId; readonly subtaskId: SubtaskId }
  | { readonly kind: "board-changed" }
  /** Planner (ADR 0012): a plan, its artifacts, or its annotations changed. */
  | { readonly kind: "planner-changed"; readonly planId: PlanId }
  /** A plan's session booted (new or revived): surfaces auto-open the panel. */
  | { readonly kind: "planner-session-started"; readonly planId: PlanId; readonly sessionId: SessionId }
  /** Active-task spine: the one task every surface follows moved (null = none). */
  | { readonly kind: "active-task-changed"; readonly taskId: TaskId | null }
  /**
   * One stage of a session boot reached (UX overhaul P4). Emitted from the host
   * services that sequence the boot, never from a transport, so the composer's
   * timeline and the rail's reconnect spinner render the same stages whatever
   * the agent CLI does with its stdout.
   */
  | { readonly kind: "boot-progress"; readonly sessionId: SessionId; readonly stage: BootStage }
  /** A validation job moved through its lifecycle (ADR 0022): chips re-render from this. */
  | {
      readonly kind: "validation-job-changed";
      readonly jobId: ValidationJobId;
      readonly state: ValidationJobState;
      readonly sessionId?: SessionId;
      readonly taskId?: TaskId;
      readonly subtaskId?: SubtaskId;
    }
  /** Coarse validation-registry invalidation (ADR 0022): runtimes, associations, or health moved. */
  | { readonly kind: "validation-runtime-changed" }
  /**
   * A must-fail probe PASSED (ADR 0022 F5): security incident, not inconvenience.
   * Carries everything the persistent banner renders; the runtime is already
   * quarantined and its queue blocked by the time this is published.
   */
  | {
      readonly kind: "validation-quarantine";
      readonly runtimeId: ValidationRuntimeId;
      readonly probeId: string;
      readonly detail: string;
      readonly at: string;
    };

/**
 * Boot timeline stages. `mount` and `clone` are the two shapes of the same
 * middle step (live roots mounted vs repositories cloned into the disposable
 * workspace), so exactly one of them is emitted per boot.
 */
export type BootStage = "create" | "mount" | "clone" | "start";

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

/**
 * Emits one session's boot stages, at most once each (UX overhaul P4).
 *
 * Progress reporting is decoration: a boot that fails simply stops emitting,
 * and a missing bus (partial test compositions) reports nothing rather than
 * throwing into the boot path. Repeats are swallowed so a shared seam - the
 * same prepareWorkspace serving start and resume - can report defensively.
 */
export class BootStageReporter {
  private readonly seen = new Set<BootStage>();

  constructor(
    private readonly bus: ProductEventBus | undefined,
    private readonly sessionId: SessionId
  ) {}

  stage(stage: BootStage): void {
    if (this.bus === undefined || this.seen.has(stage)) return;
    this.seen.add(stage);
    try {
      this.bus.publish({ kind: "boot-progress", sessionId: this.sessionId, stage });
    } catch {
      // Best-effort: a broken bus must never fail the boot it is describing.
    }
  }
}
