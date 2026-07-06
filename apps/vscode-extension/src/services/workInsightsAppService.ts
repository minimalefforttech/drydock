/**
 * Work-insights application facade.
 *
 * The panel's touch-history view: "who worked this workspace, through which
 * chat, when". Joins durable work sessions to task titles and chat-session
 * titles, scoped by a workspace set or a project (resolved to the sets that
 * contain it). No `vscode` imports belong here.
 */

import {
  asId,
  type SessionId,
  type WorkHistoryEntry,
  type WorkSessionRecord,
  type WorkSessionStore,
  type WorkspaceSetId
} from "@drydock/contracts";
import type { ChatSessionService } from "@drydock/core";
import type { TaskService, WorkspaceSetService } from "@drydock/work-management";

/** Newest touch-history rows returned per query; keeps the view scannable. */
export const WORK_HISTORY_LIMIT = 20;

export interface WorkInsightsAppServiceOptions {
  readonly workSessions: WorkSessionStore;
  readonly tasks: TaskService;
  readonly chatService: ChatSessionService;
  readonly workspaceSets: WorkspaceSetService;
}

/** Exactly one scope per query, mirroring the frozen work.history contract. */
export type WorkHistoryFilter = { readonly workspaceSetId: string } | { readonly projectId: string };

export class WorkInsightsAppService {
  constructor(private readonly options: WorkInsightsAppServiceOptions) {}

  /**
   * Touch-history entries for a scope, newest activity first, capped at
   * WORK_HISTORY_LIMIT. A workspaceSetId scope queries that set directly; a
   * projectId scope resolves to every set that contains the project, then
   * unions their work sessions (deduped on the (task, session) key). Task and
   * chat-session titles are joined from single listTasks()/listSessions()
   * passes; a work session whose chat session is gone falls back to its id
   * prefix so history survives session deletion.
   */
  async history(filter: WorkHistoryFilter): Promise<WorkHistoryEntry[]> {
    const records = await this.resolveRecords(filter);
    if (records.length === 0) {
      return [];
    }
    const [tasks, sessions] = await Promise.all([
      this.options.tasks.listTasks(),
      this.options.chatService.listSessions()
    ]);
    const taskTitles = new Map(tasks.map((task) => [task.taskId as string, task.title]));
    const sessionTitles = new Map(sessions.map((session) => [session.sessionId as string, session.title]));

    return records
      .slice()
      .sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0))
      .slice(0, WORK_HISTORY_LIMIT)
      .map((record) => {
        const taskTitle = taskTitles.get(record.taskId);
        return {
          taskId: record.taskId,
          ...(taskTitle === undefined ? {} : { taskTitle }),
          sessionId: record.sessionId,
          sessionTitle: sessionTitles.get(record.sessionId) ?? sessionIdPrefix(record.sessionId),
          lastActivityAt: record.lastActivityAt,
          turnCount: record.turnCount
        };
      });
  }

  /**
   * Work sessions in scope. A workspaceSetId scope is a single filtered store
   * query; a projectId scope unions the sessions of every set that contains the
   * project, deduped on the (task, session) key so an overlapping-set project
   * is not double-counted.
   */
  private async resolveRecords(filter: WorkHistoryFilter): Promise<WorkSessionRecord[]> {
    if ("workspaceSetId" in filter) {
      return this.options.workSessions.listWorkSessions({ workspaceSetId: asId<"WorkspaceSetId">(filter.workspaceSetId) });
    }
    const containingSetIds = await this.setsContainingProject(filter.projectId);
    const byKey = new Map<string, WorkSessionRecord>();
    for (const workspaceSetId of containingSetIds) {
      for (const record of await this.options.workSessions.listWorkSessions({ workspaceSetId })) {
        byKey.set(`${record.taskId} ${record.sessionId}`, record);
      }
    }
    return [...byKey.values()];
  }

  /** Workspace sets whose membership includes the project. */
  private async setsContainingProject(projectId: string): Promise<WorkspaceSetId[]> {
    const sets = await this.options.workspaceSets.listWorkspaceSets();
    return sets
      .filter((set) => set.projectIds.some((candidate) => candidate === projectId))
      .map((set) => set.workspaceSetId);
  }
}

/** Short, display-safe stand-in title for a work session whose chat is gone. */
function sessionIdPrefix(sessionId: SessionId): string {
  return String(sessionId).slice(0, 12);
}
