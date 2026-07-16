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

/** One ordered step of a manual-check question (HITL instructions). */
export interface AgentQuestionStep {
  readonly text: string;
  /** Illustration resolved from the session sandbox at capture time. */
  readonly imageDataUri?: string;
}

/** An agent-supplied illustration; dataUri absent when resolution failed. */
export interface AgentQuestionImage {
  /** Runtime path the agent referenced (display + honesty when unresolved). */
  readonly path: string;
  readonly dataUri?: string;
}

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
  /** ADR 0016: plain question (absent) vs a step-by-step manual check. */
  readonly kind?: "manual-check";
  /** Ordered manual-check steps; present only on kind "manual-check". */
  readonly steps?: readonly AgentQuestionStep[];
  /** Agent-supplied illustrations (sandbox screenshots/renders), capped + resolved at capture. */
  readonly images?: readonly AgentQuestionImage[];
  /** Subtask whose verify gate this check satisfies (answer can stamp Verified). */
  readonly subtaskId?: string;
}

export interface AgentQuestionStore {
  insertQuestion(record: AgentQuestionRecord): Promise<void>;
  getQuestion(questionId: AgentQuestionId): Promise<AgentQuestionRecord | null>;
  /** Oldest-first so the stack presents questions in the order they were asked. */
  listQuestions(status?: AgentQuestionStatus, sessionId?: SessionId): Promise<AgentQuestionRecord[]>;
  resolveQuestion(questionId: AgentQuestionId, status: "answered" | "dismissed", answer: string | null, resolvedAt: string): Promise<void>;
}
