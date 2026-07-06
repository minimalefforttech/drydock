/**
 * Agent question contracts.
 *
 * Agents cannot block on user input mid-turn (exec transports run a turn to
 * completion), so questions follow the access-request pattern: the agent
 * emits a `question` fenced block in its final text, the host parses it into
 * a pending record, the panel stacks it for the user, and the answer returns
 * to the agent as a host-authored follow-up turn.
 */

import type { AgentQuestionId, SessionId } from "./ids.js";

export type AgentQuestionStatus = "pending" | "answered" | "dismissed";

export interface AgentQuestionRecord {
  readonly questionId: AgentQuestionId;
  readonly sessionId: SessionId;
  readonly question: string;
  /** Agent-suggested answers, first = the agent's recommendation. May be empty. */
  readonly options: readonly string[];
  readonly status: AgentQuestionStatus;
  /** The user's answer (an option verbatim or free text) once answered. */
  readonly answer?: string;
  readonly createdAt: string;
  readonly resolvedAt?: string;
}

export interface AgentQuestionStore {
  insertQuestion(record: AgentQuestionRecord): Promise<void>;
  getQuestion(questionId: AgentQuestionId): Promise<AgentQuestionRecord | null>;
  /** Oldest-first so the stack presents questions in the order they were asked. */
  listQuestions(status?: AgentQuestionStatus, sessionId?: SessionId): Promise<AgentQuestionRecord[]>;
  resolveQuestion(questionId: AgentQuestionId, status: "answered" | "dismissed", answer: string | null, resolvedAt: string): Promise<void>;
}
