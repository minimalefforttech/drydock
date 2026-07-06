/**
 * SQLite-backed agent question store.
 *
 * Questions survive reloads like access requests do: a pending question is a
 * standing "waiting on you" item until answered or dismissed. Options are
 * stored as a JSON array column (display-only strings, parsed defensively).
 */

import type {
  AgentQuestionId,
  AgentQuestionRecord,
  AgentQuestionStatus,
  AgentQuestionStore,
  SessionId
} from "@drydock/contracts";
import type { SqliteConnection } from "./sqliteConnection.js";

export class SqliteAgentQuestionStore implements AgentQuestionStore {
  constructor(private readonly connection: SqliteConnection) {}

  async insertQuestion(record: AgentQuestionRecord): Promise<void> {
    this.connection.database.prepare(`
      INSERT INTO agent_questions (
        question_id, session_id, question, options_json, status, answer, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.questionId,
      record.sessionId,
      record.question,
      JSON.stringify(record.options),
      record.status,
      record.answer ?? null,
      record.createdAt,
      record.resolvedAt ?? null
    );
  }

  async getQuestion(questionId: AgentQuestionId): Promise<AgentQuestionRecord | null> {
    const row = this.connection.database.prepare(`
      SELECT * FROM agent_questions WHERE question_id = ?
    `).get(questionId) as AgentQuestionRow | undefined;
    return row ? mapQuestion(row) : null;
  }

  async listQuestions(status?: AgentQuestionStatus, sessionId?: SessionId): Promise<AgentQuestionRecord[]> {
    const clauses: string[] = [];
    const values: string[] = [];
    if (status !== undefined) {
      clauses.push("status = ?");
      values.push(status);
    }
    if (sessionId !== undefined) {
      clauses.push("session_id = ?");
      values.push(sessionId);
    }
    const rows = this.connection.database.prepare(`
      SELECT * FROM agent_questions
      ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY created_at ASC, rowid ASC
    `).all(...values) as unknown as AgentQuestionRow[];
    return rows.map(mapQuestion);
  }

  async resolveQuestion(questionId: AgentQuestionId, status: "answered" | "dismissed", answer: string | null, resolvedAt: string): Promise<void> {
    this.connection.database.prepare(`
      UPDATE agent_questions
      SET status = ?, answer = ?, resolved_at = ?
      WHERE question_id = ?
    `).run(status, answer, resolvedAt, questionId);
  }
}

interface AgentQuestionRow {
  readonly question_id: string;
  readonly session_id: string;
  readonly question: string;
  readonly options_json: string;
  readonly status: AgentQuestionStatus;
  readonly answer: string | null;
  readonly created_at: string;
  readonly resolved_at: string | null;
}

function mapQuestion(row: AgentQuestionRow): AgentQuestionRecord {
  return {
    questionId: row.question_id as AgentQuestionId,
    sessionId: row.session_id as SessionId,
    question: row.question,
    options: parseOptions(row.options_json),
    status: row.status,
    ...(row.answer === null ? {} : { answer: row.answer }),
    createdAt: row.created_at,
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at })
  };
}

function parseOptions(json: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}
