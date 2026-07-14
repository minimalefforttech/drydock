/**
 * Durable chat session contracts.
 *
 * Sessions are first-class backend objects: the panel lists and
 * reopens them, and every agent event belongs to exactly one session. Stores
 * own persistence; ChatSessionService owns lifecycle and policy.
 */

import type { AgentRole, ChatId, RunId, RuntimeId, SessionId } from "./ids.js";
import type { CloneDirtyHandling } from "./tasks.js";
import type { SessionMode } from "./workspaces.js";

export type ChatSessionStatus =
  | "starting"
  | "active"
  | "ended"
  | "failed";

export interface ChatSessionRecord {
  readonly sessionId: SessionId;
  readonly chatId: ChatId;
  /** Display title, derived from the first prompt. */
  readonly title: string;
  /** User-authored summary/notes shown on session cards. */
  readonly description?: string;
  readonly status: ChatSessionStatus;
  readonly providerId: string;
  readonly model?: string;
  /** Transport that ran the session, e.g. "codex-app-server". */
  readonly transport: string;
  /** Session mode recorded at start: drives briefing + clone sync UI. */
  readonly mode?: SessionMode;
  /**
   * Absolute project roots mounted at start. Persisted so a resume/reclaim/reload
   * re-mounts the SAME folders instead of coming up with only the disposable
   * workspace — otherwise a revived session can't touch the project it edited.
   */
  readonly workspaceRoots?: readonly string[];
  /** Subset of workspaceRoots mounted read-only (per-set read-only flags). */
  readonly readOnlyRoots?: readonly string[];
  /** Clone sessions only: the snapshot choice to preserve across resume/reclaim. */
  readonly cloneDirtyHandling?: CloneDirtyHandling;
  readonly runtimeId?: RuntimeId;
  /**
   * Multi-window ownership: which extension-host instance currently
   * runs this session, and when it last proved it. A fresh heartbeat from
   * another instance means "running elsewhere" — never touch its runtime.
   */
  readonly hostInstanceId?: string;
  readonly heartbeatAt?: string;
  /**
   * Product-owned role lineage: set when this session was spawned
   * as a child of another session. A child's mounts are constrained to a
   * subset of its parent's at spawn AND at every later expansion
   * (threat-model: a subagent must never inherit broader access).
   */
  readonly parentSessionId?: SessionId;
  readonly spawnedRole?: AgentRole;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly endedAt?: string;
}

export interface ChatSessionUpdate {
  readonly status?: ChatSessionStatus;
  readonly title?: string;
  /** null clears the description. */
  readonly description?: string | null;
  readonly providerId?: string;
  readonly model?: string | null;
  readonly runtimeId?: RuntimeId;
  /** null clears ownership (session ended or released). */
  readonly hostInstanceId?: string | null;
  readonly heartbeatAt?: string | null;
  readonly updatedAt: string;
  readonly endedAt?: string;
}

export interface ChatSessionStore {
  insertSession(record: ChatSessionRecord): Promise<void>;
  updateSession(sessionId: SessionId, update: ChatSessionUpdate): Promise<void>;
  getSession(sessionId: SessionId): Promise<ChatSessionRecord | null>;
  /** Newest-first by updatedAt. */
  listSessions(limit?: number): Promise<ChatSessionRecord[]>;
  /** Removes the session row; the caller deletes dependent event rows first. */
  deleteSession(sessionId: SessionId): Promise<void>;
}

export type TurnTerminalStatus = "completed" | "failed" | "cancelled";

export interface TurnResult {
  readonly runId: RunId;
  readonly status: TurnTerminalStatus;
  readonly eventCount: number;
}
