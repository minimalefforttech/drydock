/**
 * SQLite-backed task FAQ store (ADR 0007): pattern → answer pairs that
 * auto-answer matching agent questions when the task's toggle (and the
 * global config) allow it. Deletion is task-scoped so a stale webview id
 * can never reach across tasks.
 */

import type { TaskFaqRecord, TaskFaqStore, TaskId } from "@drydock/contracts";
import type { SqliteConnection } from "./sqliteConnection.js";

export class SqliteTaskFaqStore implements TaskFaqStore {
  constructor(private readonly connection: SqliteConnection) {}

  async insertFaq(record: TaskFaqRecord): Promise<void> {
    this.connection.database.prepare(`
      INSERT INTO task_faqs (faq_id, task_id, pattern, answer, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(record.faqId, record.taskId, record.pattern, record.answer, record.createdAt);
  }

  async deleteFaq(taskId: TaskId, faqId: string): Promise<number> {
    const result = this.connection.database.prepare(`
      DELETE FROM task_faqs
      WHERE task_id = ? AND faq_id = ?
    `).run(taskId, faqId);
    return Number(result.changes);
  }

  async listForTask(taskId: TaskId): Promise<TaskFaqRecord[]> {
    const rows = this.connection.database.prepare(`
      SELECT *
      FROM task_faqs
      WHERE task_id = ?
      ORDER BY rowid ASC
    `).all(taskId) as unknown as FaqRow[];
    return rows.map(mapFaq);
  }

  async countByTask(): Promise<Map<string, number>> {
    const rows = this.connection.database.prepare(`
      SELECT task_id, COUNT(*) AS count
      FROM task_faqs
      GROUP BY task_id
    `).all() as unknown as { readonly task_id: string; readonly count: number }[];
    return new Map(rows.map((row) => [row.task_id, row.count]));
  }
}

interface FaqRow {
  readonly faq_id: string;
  readonly task_id: string;
  readonly pattern: string;
  readonly answer: string;
  readonly created_at: string;
}

function mapFaq(row: FaqRow): TaskFaqRecord {
  return {
    faqId: row.faq_id,
    taskId: row.task_id as TaskId,
    pattern: row.pattern,
    answer: row.answer,
    createdAt: row.created_at
  };
}
