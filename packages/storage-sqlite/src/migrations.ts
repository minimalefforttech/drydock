/**
 * SQLite migrations for the product schema.
 *
 * Tables intentionally mirror the planning docs for inventory, cleanup, event
 * replay, durable chat sessions, workspace policy, and diff review while
 * remaining small enough at this scale. session_events replay order is the
 * implicit rowid (insertion order), which Stage 2 exposes as the durable
 * event sequence.
 */

import { SEEDED_PLAN_ASPECTS } from "@drydock/contracts";
import type { SqliteConnection } from "./sqliteConnection.js";

export function applyMigrations(connection: SqliteConnection): void {
  connection.database.exec(`
    CREATE TABLE IF NOT EXISTS runtime_instances (
      runtime_id TEXT PRIMARY KEY,
      runtime_generation_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      agent_id TEXT,
      agent_role TEXT,
      template_id TEXT NOT NULL,
      adapter TEXT NOT NULL,
      external_name TEXT NOT NULL,
      external_id TEXT,
      workspace_owner_token TEXT,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      stopped_at TEXT,
      removed_at TEXT,
      last_seen_at TEXT,
      last_cleanup_attempt_at TEXT,
      cleanup_failure_count INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_runtime_instances_session
      ON runtime_instances(session_id);

    CREATE TABLE IF NOT EXISTS runtime_cleanup_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runtime_id TEXT NOT NULL,
      attempted_at TEXT NOT NULL,
      failed INTEGER NOT NULL,
      FOREIGN KEY(runtime_id) REFERENCES runtime_instances(runtime_id)
    );

    CREATE TABLE IF NOT EXISTS session_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      run_id TEXT,
      event_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_events_session_created
      ON session_events(session_id, created_at);

    CREATE TABLE IF NOT EXISTS chat_sessions (
      session_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      transport TEXT NOT NULL,
      runtime_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated
      ON chat_sessions(updated_at);
  `);
  ensureColumn(connection, "chat_sessions", "provider_id", "TEXT NOT NULL DEFAULT 'codex'");
  ensureColumn(connection, "chat_sessions", "model", "TEXT");
  // Phase 1 chat-panel redesign: user-authored session notes/summary.
  ensureColumn(connection, "chat_sessions", "description", "TEXT NULL");
  // Multi-window ownership: which extension-host instance runs a session and
  // when it last proved liveness. A fresh heartbeat from a foreign instance
  // marks the session "running elsewhere"; both clear (NULL) when it ends.
  ensureColumn(connection, "chat_sessions", "host_instance_id", "TEXT NULL");
  ensureColumn(connection, "chat_sessions", "heartbeat_at", "TEXT NULL");
  // Clone mode: the session mode recorded at start (plan/implementation/clone).
  // NULL for legacy rows written before this column existed, which the store
  // maps to an absent `mode` (callers default to implementation).
  ensureColumn(connection, "chat_sessions", "mode", "TEXT NULL");
  // Role sessions: spawned-by lineage. NULL = a normal top-level chat.
  ensureColumn(connection, "chat_sessions", "parent_session_id", "TEXT NULL");
  ensureColumn(connection, "chat_sessions", "spawned_role", "TEXT NULL");
  // Original project mount roots (JSON arrays), so resume/reclaim re-mounts the
  // same folders instead of only the disposable workspace.
  ensureColumn(connection, "chat_sessions", "workspace_roots", "TEXT NULL");
  ensureColumn(connection, "chat_sessions", "read_only_roots", "TEXT NULL");
  // Clone snapshot choice is session state as well as task policy: a resumed
  // clone must not silently change from fresh HEAD to a dirty overlay.
  ensureColumn(connection, "chat_sessions", "clone_dirty_handling", "TEXT NULL");
  connection.database.exec(
    "CREATE INDEX IF NOT EXISTS idx_chat_sessions_parent ON chat_sessions(parent_session_id)"
  );

  // Stage 3: workspace policy.
  connection.database.exec(`
    CREATE TABLE IF NOT EXISTS project_records (
      project_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      path_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_sets (
      workspace_set_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_set_projects (
      workspace_set_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (workspace_set_id, project_id),
      FOREIGN KEY(workspace_set_id) REFERENCES workspace_sets(workspace_set_id),
      FOREIGN KEY(project_id) REFERENCES project_records(project_id)
    );

    CREATE TABLE IF NOT EXISTS access_requests (
      access_request_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      host_path TEXT NOT NULL,
      mode TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_access_requests_status
      ON access_requests(status);

    -- Agent questions (attention-stack): pending rows are standing
    -- "waiting on you" items; answers dispatch as host follow-up turns.
    CREATE TABLE IF NOT EXISTS agent_questions (
      question_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      question TEXT NOT NULL,
      options_json TEXT NOT NULL,
      status TEXT NOT NULL,
      answer TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_agent_questions_status
      ON agent_questions(status, session_id);
  `);
  // Per-path read/write intent on a set membership. Legacy rows and any member
  // added before this column existed default to read-write (0).
  ensureColumn(connection, "workspace_set_projects", "read_only", "INTEGER NOT NULL DEFAULT 0");

  // Stage 4: diff baselines and review threads.
  connection.database.exec(`
    CREATE TABLE IF NOT EXISTS diff_baselines (
      baseline_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      session_id TEXT,
      root_path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_diff_baselines_session
      ON diff_baselines(session_id);

    CREATE TABLE IF NOT EXISTS diff_baseline_files (
      baseline_id TEXT NOT NULL,
      path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      captured_at_ms REAL NOT NULL,
      blob_stored INTEGER NOT NULL,
      PRIMARY KEY (baseline_id, path),
      FOREIGN KEY(baseline_id) REFERENCES diff_baselines(baseline_id)
    );

    CREATE TABLE IF NOT EXISTS review_sessions (
      review_session_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      session_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS review_comments (
      comment_id TEXT PRIMARY KEY,
      review_session_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      body TEXT NOT NULL,
      author TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(review_session_id) REFERENCES review_sessions(review_session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_review_comments_session
      ON review_comments(review_session_id);
  `);
  ensureColumn(connection, "review_comments", "intent", "TEXT");
  ensureColumn(connection, "review_comments", "block_id", "TEXT");

  // LEGACY / ORPHANED: the retired Markdown-plan + documentation-review
  // subsystem's stores (planStore, docStore) are deleted and no
  // code reads or writes these tables anymore. The CREATE TABLE blocks are kept
  // per the additive migration policy so historical DBs still open unchanged.
  connection.database.exec(`
    CREATE TABLE IF NOT EXISTS plan_documents (
      plan_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plan_blocks (
      block_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      heading TEXT NOT NULL,
      content TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      order_index INTEGER NOT NULL,
      approval TEXT NOT NULL,
      approved_by TEXT,
      approved_at TEXT,
      revision INTEGER NOT NULL,
      FOREIGN KEY(plan_id) REFERENCES plan_documents(plan_id)
    );

    CREATE INDEX IF NOT EXISTS idx_plan_blocks_plan
      ON plan_blocks(plan_id, order_index);

    CREATE TABLE IF NOT EXISTS plan_run_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id TEXT NOT NULL,
      block_ids_json TEXT NOT NULL,
      run_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      linked_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_plan_run_links_plan
      ON plan_run_links(plan_id);

    CREATE TABLE IF NOT EXISTS doc_registry (
      path_key TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      indexed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS doc_patches (
      doc_patch_id TEXT PRIMARY KEY,
      doc_path TEXT NOT NULL,
      baseline_sha256 TEXT NOT NULL,
      proposal_sha256 TEXT NOT NULL,
      comment_ids_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
  `);

  // Chat-panel redesign (Phase 2): internal work tasks and their links.
  connection.database.exec(`
    CREATE TABLE IF NOT EXISTS work_tasks (
      task_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      clone_workspace_set_id TEXT NULL,
      clone_project_ids_json TEXT NULL,
      clone_dirty_handling TEXT NULL
    );

    CREATE TABLE IF NOT EXISTS work_task_links (
      task_id TEXT NOT NULL,
      workspace_set_id TEXT NULL,
      session_id TEXT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_work_task_links_task
      ON work_task_links(task_id);

    -- COALESCE folds the always-NULL target column to a sentinel so a UNIQUE
    -- index still rejects duplicates (a bare UNIQUE treats NULLs as distinct).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_work_task_links_unique
      ON work_task_links(task_id, COALESCE(workspace_set_id, ''), COALESCE(session_id, ''));
  `);
  // Session-target links may additionally name the subtask they belong to.
  ensureColumn(connection, "work_task_links", "subtask_id", "TEXT NULL");
  // Task-level clone policy is additive and nullable: existing tasks remain
  // valid until a manual start saves an explicit selection.
  ensureColumn(connection, "work_tasks", "clone_workspace_set_id", "TEXT NULL");
  ensureColumn(connection, "work_tasks", "clone_project_ids_json", "TEXT NULL");
  ensureColumn(connection, "work_tasks", "clone_dirty_handling", "TEXT NULL");

  // LEGACY / ORPHANED (ADR 0012): the per-session plan-docs surface is retired
  // — the Planner panel (planner_* tables below) supersedes it and planDocStore
  // is deleted; no code reads or writes this table anymore. The CREATE TABLE is
  // kept per the additive migration policy so historical DBs still open
  // unchanged. (Named plan_docs, not plan_documents — the retired Stage 5
  // subsystem above already claims that name.)
  connection.database.exec(`
    CREATE TABLE IF NOT EXISTS plan_docs (
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      format TEXT NOT NULL,
      content TEXT NOT NULL,
      revision INTEGER NOT NULL,
      collected_at TEXT NOT NULL,
      PRIMARY KEY (session_id, name)
    );
  `);

  // TaskWorkSession records and agent-proposed memory candidates.
  // work_sessions is one (task, session) pairing touched on each turn; the
  // (task_id, session_id) primary key lets INSERT OR REPLACE upsert it.
  connection.database.exec(`
    CREATE TABLE IF NOT EXISTS work_sessions (
      task_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      workspace_set_id TEXT NULL,
      started_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      turn_count INTEGER NOT NULL,
      PRIMARY KEY (task_id, session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_work_sessions_activity
      ON work_sessions(last_activity_at);

    CREATE TABLE IF NOT EXISTS memory_candidates (
      memory_candidate_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_candidates_status
      ON memory_candidates(status);
  `);

  // Task board and subtasks: board columns are global and user-configurable;
  // subtasks are child work items of exactly one task; dependencies are
  // directed edges between two subtasks of the SAME task (never cross-task,
  // never cyclic — enforced by TaskService/SubtaskService, not the schema).
  connection.database.exec(`
    CREATE TABLE IF NOT EXISTS board_columns (
      column_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subtasks (
      subtask_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NULL,
      prompt TEXT NULL,
      origin TEXT NOT NULL,
      auto_start INTEGER NOT NULL DEFAULT 0,
      column_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      done_at TEXT NULL,
      FOREIGN KEY(task_id) REFERENCES work_tasks(task_id)
    );

    CREATE INDEX IF NOT EXISTS idx_subtasks_task
      ON subtasks(task_id);

    -- Both endpoints are always within the same taskId (denormalised guard,
    -- validated by the service layer); PK(from, to) rejects duplicate edges.
    CREATE TABLE IF NOT EXISTS subtask_dependencies (
      task_id TEXT NOT NULL,
      from_subtask_id TEXT NOT NULL,
      to_subtask_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (from_subtask_id, to_subtask_id)
    );

    CREATE INDEX IF NOT EXISTS idx_subtask_dependencies_task
      ON subtask_dependencies(task_id);
  `);
  // Migrations here are idempotent DDL, not a keyed step ledger, so the
  // auto_start column lives in the CREATE TABLE above for fresh DBs AND is
  // ensured here for any DB whose subtasks table predates the flag. A
  // dependent auto-starts only when auto_start is set, all upstreams are
  // done, it has a prompt, and it is not in a backlog-category column;
  // manual start never cascades (explicit Force start override, manual only).
  ensureColumn(connection, "subtasks", "auto_start", "INTEGER NOT NULL DEFAULT 0");
  // Per-subtask dependency-edge colour override (0-7, matching the 8-hue
  // stripe palette); NULL means "use the parent task's stripe hue" (the
  // pre-existing default behaviour), so this column is purely additive.
  ensureColumn(connection, "subtasks", "color_override", "INTEGER NULL");
  // work_tasks.state is replaced by column_id (+ optional done_at); state is
  // kept transitionally (see WorkTaskRecord doc comment) until the board UI
  // lands and the webview stops reading it.
  ensureColumn(connection, "work_tasks", "column_id", "TEXT NULL");
  ensureColumn(connection, "work_tasks", "done_at", "TEXT NULL");
  seedDefaultColumnsAndBackfill(connection);

  // Planner (ADR 0012): first-class plans with collected artifacts, anchored
  // annotations, and the configurable aspect registry. Tables take the
  // planner_ prefix because the plan_* namespace is crowded: plan_documents/
  // plan_blocks are the retired legacy subsystem and plan_docs is the
  // session-scoped surface the planner supersedes.
  connection.database.exec(`
    CREATE TABLE IF NOT EXISTS planner_plans (
      plan_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      brief TEXT NOT NULL,
      aspect_ids_json TEXT NOT NULL,
      context_roots_json TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      session_id TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS planner_artifacts (
      artifact_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      aspect_id TEXT NOT NULL,
      title TEXT NOT NULL,
      title_override TEXT NULL,
      revision INTEGER NOT NULL,
      content TEXT NULL,
      blob_sha256 TEXT NULL,
      byte_size INTEGER NULL,
      mime TEXT NULL,
      scripts_enabled INTEGER NOT NULL DEFAULT 0,
      collected_at TEXT NOT NULL,
      FOREIGN KEY(plan_id) REFERENCES planner_plans(plan_id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_planner_artifacts_path
      ON planner_artifacts(plan_id, rel_path);

    CREATE TABLE IF NOT EXISTS planner_annotations (
      annotation_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      anchor TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      delegated_rev INTEGER NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(plan_id) REFERENCES planner_plans(plan_id)
    );

    CREATE INDEX IF NOT EXISTS idx_planner_annotations_plan
      ON planner_annotations(plan_id);

    CREATE TABLE IF NOT EXISTS planner_aspects (
      aspect_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      instructions TEXT NOT NULL,
      expected_artifacts_json TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      seeded INTEGER NOT NULL DEFAULT 0
    );
  `);
  seedPlannerAspects(connection);
  // Plans belong to tasks (ADR 0006 doctrine extended to planning): additive
  // and nullable — existing rows stay valid as orphan plans.
  ensureColumn(connection, "planner_plans", "task_id", "TEXT NULL");
}

/**
 * Seeds the aspect registry once (empty table only), so user edits to seeded
 * rows — including archiving them — are never overwritten on a later run.
 */
function seedPlannerAspects(connection: SqliteConnection): void {
  const count = connection.database.prepare(`SELECT COUNT(*) AS count FROM planner_aspects`).get() as { readonly count: number };
  if (count.count > 0) {
    return;
  }
  const insert = connection.database.prepare(`
    INSERT INTO planner_aspects (aspect_id, label, instructions, expected_artifacts_json, sort_order, archived, seeded)
    VALUES (?, ?, ?, ?, ?, 0, 1)
  `);
  for (const aspect of SEEDED_PLAN_ASPECTS) {
    insert.run(aspect.aspectId, aspect.label, aspect.instructions, JSON.stringify(aspect.expectedArtifacts), aspect.sortOrder);
  }
}

/**
 * Seeds the six default board columns (once) and backfills work_tasks.column_id
 * from the legacy state for any row that predates the column model. Both steps
 * are idempotent so re-running migrations on an already-migrated DB is a no-op.
 */
function seedDefaultColumnsAndBackfill(connection: SqliteConnection): void {
  const columnCount = connection.database.prepare(`SELECT COUNT(*) AS count FROM board_columns`).get() as { readonly count: number };
  if (columnCount.count === 0) {
    const insertColumn = connection.database.prepare(`
      INSERT INTO board_columns (column_id, name, category, sort_order)
      VALUES (?, ?, ?, ?)
    `);
    for (const column of DEFAULT_BOARD_COLUMNS) {
      insertColumn.run(column.columnId, column.name, column.category, column.sortOrder);
    }
  }

  // Backfill: every work_tasks row without a column_id yet maps from its
  // (legacy) state to the matching default column.
  const backfill = connection.database.prepare(`
    UPDATE work_tasks
    SET column_id = ?
    WHERE state = ? AND column_id IS NULL
  `);
  for (const [state, columnId] of Object.entries(STATE_TO_DEFAULT_COLUMN_ID)) {
    backfill.run(columnId, state);
  }
  // Any row with an unrecognised/missing state still falls back to ToDo so
  // column_id is never left NULL after migration.
  connection.database.prepare(`
    UPDATE work_tasks
    SET column_id = ?
    WHERE column_id IS NULL
  `).run(DEFAULT_COLUMN_ID_TODO);
}

const DEFAULT_COLUMN_ID_BACKLOG = "col-backlog";
const DEFAULT_COLUMN_ID_TODO = "col-todo";
const DEFAULT_COLUMN_ID_BLOCKED = "col-blocked";
const DEFAULT_COLUMN_ID_IN_PROGRESS = "col-in-progress";
const DEFAULT_COLUMN_ID_REVIEW = "col-review";
const DEFAULT_COLUMN_ID_FINISHED = "col-finished";

/** Migration-seeded defaults: Backlog, ToDo, Blocked, In Progress, Review, Finished. */
const DEFAULT_BOARD_COLUMNS: readonly { readonly columnId: string; readonly name: string; readonly category: string; readonly sortOrder: number }[] = [
  { columnId: DEFAULT_COLUMN_ID_BACKLOG, name: "Backlog", category: "backlog", sortOrder: 0 },
  { columnId: DEFAULT_COLUMN_ID_TODO, name: "ToDo", category: "pending", sortOrder: 1 },
  { columnId: DEFAULT_COLUMN_ID_BLOCKED, name: "Blocked", category: "pending", sortOrder: 2 },
  { columnId: DEFAULT_COLUMN_ID_IN_PROGRESS, name: "In Progress", category: "in-progress", sortOrder: 3 },
  { columnId: DEFAULT_COLUMN_ID_REVIEW, name: "Review", category: "done", sortOrder: 4 },
  { columnId: DEFAULT_COLUMN_ID_FINISHED, name: "Finished", category: "done", sortOrder: 5 }
];

/** Legacy WorkTaskState -> seeded default BoardColumnRecord.columnId. */
const STATE_TO_DEFAULT_COLUMN_ID: Readonly<Record<string, string>> = {
  todo: DEFAULT_COLUMN_ID_TODO,
  "in-progress": DEFAULT_COLUMN_ID_IN_PROGRESS,
  blocked: DEFAULT_COLUMN_ID_BLOCKED,
  review: DEFAULT_COLUMN_ID_REVIEW,
  done: DEFAULT_COLUMN_ID_FINISHED
};

function ensureColumn(connection: SqliteConnection, table: string, column: string, definition: string): void {
  const rows = connection.database.prepare(`PRAGMA table_info(${table})`).all() as { readonly name: string }[];
  if (rows.some((row) => row.name === column)) {
    return;
  }
  connection.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
