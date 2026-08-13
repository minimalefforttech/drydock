/**
 * Coordinates task-FAQ answers with the chat turn lifecycle.
 *
 * A question may be detected while its originating turn is still active. We
 * therefore queue the matching answer, dispatch it only once the session is
 * idle, and resolve the durable question only after that host turn succeeds.
 */

import type {
  AgentQuestionId,
  AgentQuestionRecord,
  AgentQuestionStatus,
  SessionId,
  TaskFaqStore,
  TurnResult,
  WorkTaskStore
} from "@drydock/contracts";
import { errorMessage, type Logger, type ProductEventBus } from "@drydock/core";

interface QuestionPort {
  listQuestions(status?: AgentQuestionStatus, sessionId?: SessionId): Promise<AgentQuestionRecord[]>;
  answer(questionId: AgentQuestionId, answer: string): Promise<AgentQuestionRecord>;
}

interface SessionPort {
  isChatSessionLive(sessionId: string): boolean;
  hasActiveChatTurn(sessionId: string): boolean;
  sendChatTurn(sessionId: string, prompt: string): Promise<TurnResult>;
}

export interface TaskFaqAutoAnswerOptions {
  readonly bus: ProductEventBus;
  readonly tasks: Pick<WorkTaskStore, "listLinks" | "getTask">;
  readonly faqs: Pick<TaskFaqStore, "listForTask">;
  readonly questions: QuestionPort;
  readonly sessions: SessionPort;
  readonly logger: Logger;
  readonly enabled: () => boolean;
}

interface PendingFaqAnswer {
  readonly question: AgentQuestionRecord;
  readonly answer: string;
  readonly taskId: string;
  readonly faqId: string;
}

export class TaskFaqAutoAnswerCoordinator {
  private readonly pendingBySession = new Map<string, PendingFaqAnswer[]>();
  private readonly queuedQuestionIds = new Set<string>();
  private readonly dispatchingSessions = new Set<string>();
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(private readonly options: TaskFaqAutoAnswerOptions) {
    this.unsubscribe = options.bus.subscribe((event) => {
      if (event.kind === "question-asked") {
        void this.enqueue(event.question).catch((error: unknown) => {
          this.options.logger.warn("task FAQ auto-answer matching failed", {
            sessionId: event.question.sessionId,
            error: errorMessage(error)
          });
        });
      } else if (event.kind === "turn-completed") {
        void this.drain(event.sessionId);
      } else if (event.kind === "session-deleted") {
        this.dropQueue(event.sessionId);
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    for (const sessionId of this.pendingBySession.keys()) this.dropQueue(sessionId);
  }

  private async enqueue(question: AgentQuestionRecord): Promise<void> {
    if (this.disposed || !this.options.enabled() || this.queuedQuestionIds.has(question.questionId)) return;
    this.queuedQuestionIds.add(question.questionId);
    let retained = false;
    try {
      const links = await this.options.tasks.listLinks();
      const taskIds = [...new Set(
        links.filter((link) => link.sessionId === question.sessionId).map((link) => link.taskId)
      )];
      for (const taskId of taskIds) {
        const task = await this.options.tasks.getTask(taskId);
        if (task === null || task.autoAnswerFaq !== true) continue;
        const match = (await this.options.faqs.listForTask(taskId))
          .find((faq) => taskFaqPatternMatches(question.question, faq.pattern));
        if (match === undefined) continue;
        if (!this.options.sessions.isChatSessionLive(question.sessionId)) return;
        const queue = this.pendingBySession.get(question.sessionId) ?? [];
        queue.push({ question, answer: match.answer, taskId, faqId: match.faqId });
        this.pendingBySession.set(question.sessionId, queue);
        retained = true;
        void this.drain(question.sessionId);
        return;
      }
    } finally {
      if (!retained) this.queuedQuestionIds.delete(question.questionId);
    }
  }

  private async drain(sessionId: string): Promise<void> {
    if (this.disposed || this.dispatchingSessions.has(sessionId) || this.options.sessions.hasActiveChatTurn(sessionId)) return;
    if (!this.options.enabled()) {
      this.dropQueue(sessionId);
      return;
    }
    const queue = this.pendingBySession.get(sessionId);
    if (queue === undefined || queue.length === 0) return;
    if (!this.options.sessions.isChatSessionLive(sessionId)) {
      this.dropQueue(sessionId);
      this.options.logger.warn("task FAQ auto-answer left pending because the session is no longer live", { sessionId });
      return;
    }

    this.dispatchingSessions.add(sessionId);
    const pending = queue.shift();
    if (queue.length === 0) this.pendingBySession.delete(sessionId);
    try {
      if (pending === undefined) return;
      const stillPending = await this.options.questions.listQuestions("pending", pending.question.sessionId);
      if (!stillPending.some((candidate) => candidate.questionId === pending.question.questionId)) return;

      const result = await this.options.sessions.sendChatTurn(
        sessionId,
        `[host] Auto-answered from the task FAQ.\nQ: ${pending.question.question}\nA: ${pending.answer}\nContinue with this answer.`
      );
      if (result.status !== "completed") {
        this.options.logger.warn("task FAQ auto-answer turn did not complete", {
          sessionId,
          questionId: pending.question.questionId,
          status: result.status
        });
        return;
      }
      if (this.disposed) return;
      await this.options.questions.answer(pending.question.questionId, pending.answer);
      this.options.logger.info("task FAQ auto-answered a question", {
        taskId: pending.taskId,
        sessionId,
        questionId: pending.question.questionId,
        faqId: pending.faqId
      });
    } catch (error) {
      // Dispatch failures leave the durable question pending for manual action.
      this.options.logger.warn("task FAQ auto-answer dispatch failed", { sessionId, error: errorMessage(error) });
    } finally {
      if (pending !== undefined) this.queuedQuestionIds.delete(pending.question.questionId);
      this.dispatchingSessions.delete(sessionId);
      if ((this.pendingBySession.get(sessionId)?.length ?? 0) > 0) void this.drain(sessionId);
    }
  }

  private dropQueue(sessionId: string): void {
    for (const pending of this.pendingBySession.get(sessionId) ?? []) {
      this.queuedQuestionIds.delete(pending.question.questionId);
    }
    this.pendingBySession.delete(sessionId);
  }
}

/** Case-insensitive phrase matching with token boundaries ("yes" won't match "yesterday"). */
export function taskFaqPatternMatches(question: string, pattern: string): boolean {
  const haystack = question.toLocaleLowerCase();
  const needle = pattern.trim().toLocaleLowerCase();
  if (needle.length === 0) return false;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return false;
    const before = index === 0 ? undefined : haystack[index - 1];
    const afterIndex = index + needle.length;
    const after = afterIndex === haystack.length ? undefined : haystack[afterIndex];
    if (!isWordCharacter(before) && !isWordCharacter(after)) return true;
    from = index + 1;
  }
  return false;
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}_]/u.test(value);
}

