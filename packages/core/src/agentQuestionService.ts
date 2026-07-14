/**
 * Agent question lifecycle.
 *
 * Mirrors AccessRequestService: records are created from parsed protocol
 * blocks, resolved exactly once (answer or dismiss), and listed for the
 * panel's attention stack. Answer DISPATCH (the host-authored follow-up turn)
 * stays with the caller — this service owns state, not conversation.
 */

import type {
  AgentQuestionId,
  AgentQuestionRecord,
  AgentQuestionStatus,
  AgentQuestionStore,
  SessionId
} from "@drydock/contracts";
import type { Clock } from "./clock.js";
import type { ProductEventBus } from "./eventBus.js";
import type { IdGenerator } from "./ids.js";
import type { ParsedAgentQuestion } from "./accessRequestProtocol.js";

const MAX_ANSWER_LENGTH = 4_000;

export interface AgentQuestionServiceOptions {
  readonly store: AgentQuestionStore;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  /** When present, resolutions are announced as `question-resolved` so every surface's pending set stays live. */
  readonly bus?: ProductEventBus;
}

export class AgentQuestionService {
  constructor(private readonly options: AgentQuestionServiceOptions) {}

  /**
   * Turns parsed question blocks into pending records, deduplicating against
   * the session's still-pending questions by normalized text so a re-emitting
   * agent does not stack identical prompts. Returns only the newly created.
   */
  async captureFromParsed(sessionId: SessionId, parsed: readonly ParsedAgentQuestion[]): Promise<AgentQuestionRecord[]> {
    if (parsed.length === 0) return [];
    const pending = await this.options.store.listQuestions("pending", sessionId);
    const seen = new Set(pending.map((record) => normalizeQuestion(record.question)));
    const created: AgentQuestionRecord[] = [];
    for (const candidate of parsed) {
      const key = normalizeQuestion(candidate.question);
      if (seen.has(key)) continue;
      seen.add(key);
      const record: AgentQuestionRecord = {
        questionId: this.options.ids.agentQuestionId(),
        sessionId,
        question: candidate.question,
        options: candidate.options,
        status: "pending",
        createdAt: this.options.clock.isoNow()
      };
      await this.options.store.insertQuestion(record);
      created.push(record);
    }
    return created;
  }

  listQuestions(status?: AgentQuestionStatus, sessionId?: SessionId): Promise<AgentQuestionRecord[]> {
    return this.options.store.listQuestions(status, sessionId);
  }

  async answer(questionId: AgentQuestionId, answer: string): Promise<AgentQuestionRecord> {
    const trimmed = answer.trim();
    if (trimmed.length === 0) {
      throw new Error("An answer cannot be empty.");
    }
    if (trimmed.length > MAX_ANSWER_LENGTH) {
      throw new Error(`An answer is capped at ${String(MAX_ANSWER_LENGTH)} characters.`);
    }
    const pending = await this.requiredPending(questionId);
    const resolvedAt = this.options.clock.isoNow();
    await this.options.store.resolveQuestion(questionId, "answered", trimmed, resolvedAt);
    const resolved: AgentQuestionRecord = { ...pending, status: "answered", answer: trimmed, resolvedAt };
    this.options.bus?.publish({ kind: "question-resolved", question: resolved });
    return resolved;
  }

  async dismiss(questionId: AgentQuestionId): Promise<AgentQuestionRecord> {
    const pending = await this.requiredPending(questionId);
    const resolvedAt = this.options.clock.isoNow();
    await this.options.store.resolveQuestion(questionId, "dismissed", null, resolvedAt);
    const resolved: AgentQuestionRecord = { ...pending, status: "dismissed", resolvedAt };
    this.options.bus?.publish({ kind: "question-resolved", question: resolved });
    return resolved;
  }

  private async requiredPending(questionId: AgentQuestionId): Promise<AgentQuestionRecord> {
    const record = await this.options.store.getQuestion(questionId);
    if (record === null) {
      throw new Error(`Agent question ${questionId} was not found.`);
    }
    if (record.status !== "pending") {
      throw new Error(`Agent question ${questionId} is already ${record.status}.`);
    }
    return record;
  }
}

function normalizeQuestion(question: string): string {
  return question.trim().toLowerCase().replace(/\s+/g, " ");
}
