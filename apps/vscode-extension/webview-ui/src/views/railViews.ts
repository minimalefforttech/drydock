/**
 * The three left-rail views (UX overhaul, P1): Tasks, Recents, Workspaces.
 *
 * One bundle, mounted per view via `body[data-view]`. The rail's job is to
 * orient, not to operate: a 9px status dot is its only colour, amber means
 * "needs you", red means failed, running is quiet, done fades. Every row is a
 * task-shaped thing you can click to move the active-task spine.
 *
 * Data comes from existing contracts (task.list / session.list / question.list
 * / workspace.state / session.recents / active.*) and heals off pushes -
 * nothing polls.
 *
 * SECURITY: every dynamic string (task/chat/folder titles, question text,
 * error messages) is written with textContent - NEVER innerHTML, no
 * DOM-from-string. The rail's strict CSP has no 'unsafe-inline' for styles, so
 * status/depth styling is by CLASS only, never a style attribute.
 */

import {
  rollupTaskStatus,
  sessionRollupStatus,
  subtaskRollupStatus,
  type AgentQuestionSummary,
  type ChatSessionSummary,
  type PanelRequestPayload,
  type RecentChatSummary,
  type TaskRollupStatus,
  type WorkspacePolicyState,
  type WorkspaceSetSummary,
  type WorkTaskSummary
} from "@drydock/contracts";
import { onPush, request, vscode } from "../railMessaging.js";
import type { ValidationRailDot, ValidationRequest, ValidationResponseEnvelope } from "../validationTypes.js";

export type RailView = "tasks" | "recents" | "workspaces";

export interface RailMount {
  readonly root: HTMLElement;
  /** Subscribes to pushes and runs the first load. */
  start(): void;
}

/** Attention cluster cap: more than four "needs you" rows is a list, not a cluster. */
const CLUSTER_CAP = 4;
/** A task with no activity in this long sinks into the Earlier fold. */
const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_DEBOUNCE_MS = 150;

// ---------------------------------------------------------------------------
// Tiny DOM helpers (self-contained: the rail bundle imports no panel modules)
// ---------------------------------------------------------------------------

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function dot(status: TaskRollupStatus): HTMLElement {
  return el("span", `dot dot-${status}`);
}

function iconButton(label: string, title: string, className: string): HTMLButtonElement {
  const node = document.createElement("button");
  node.className = className;
  node.textContent = label;
  node.title = title;
  node.setAttribute("aria-label", title);
  return node;
}

/** Rows are buttons in spirit: click, Enter and Space all activate. */
function activatable(node: HTMLElement, run: () => void): void {
  node.tabIndex = 0;
  node.setAttribute("role", "button");
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    run();
  });
  node.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    // Inner buttons (twisty, hover actions, inputs) own their own keys; only
    // the row itself activates the row.
    if (event.target !== node) return;
    event.preventDefault();
    event.stopPropagation();
    run();
  });
}

// ---------------------------------------------------------------------------
// Persisted (webview-local) view state
// ---------------------------------------------------------------------------

interface RailPersistedState {
  readonly expandedTaskIds?: readonly string[];
  readonly expandedSetIds?: readonly string[];
  readonly earlierOpen?: boolean;
}

function restoreState(): RailPersistedState {
  const stored: unknown = vscode.getState();
  if (typeof stored !== "object" || stored === null) return {};
  return stored as RailPersistedState;
}

// ---------------------------------------------------------------------------
// Shared request helpers
// ---------------------------------------------------------------------------

async function fetchTasks(): Promise<readonly WorkTaskSummary[]> {
  const response = await request({ type: "task.list" });
  return response.ok && response.payload.type === "task.list" ? response.payload.tasks : [];
}

async function fetchSessions(): Promise<readonly ChatSessionSummary[]> {
  const response = await request({ type: "session.list" });
  return response.ok && response.payload.type === "session.list" ? response.payload.sessions : [];
}

async function fetchQuestions(): Promise<readonly AgentQuestionSummary[]> {
  const response = await request({ type: "question.list" });
  return response.ok && response.payload.type === "question.list" ? response.payload.questions : [];
}

async function fetchWorkspaceState(): Promise<WorkspacePolicyState | null> {
  const response = await request({ type: "workspace.state" });
  return response.ok && response.payload.type === "workspace.state" ? response.payload.state : null;
}

async function fetchActiveTaskId(): Promise<string | null> {
  const response = await request({ type: "active.get" });
  return response.ok && response.payload.type === "active.get" ? response.payload.activeTaskId : null;
}

/**
 * The validation kinds are not in `PanelRequestPayload` until M7a lands; the
 * cast lives here and everything downstream is typed against the mirror.
 */
function validationRequest(payload: ValidationRequest): Promise<ValidationResponseEnvelope> {
  return request(payload as unknown as PanelRequestPayload) as unknown as Promise<ValidationResponseEnvelope>;
}

/**
 * The developer's ENTIRE validation surface (ux-flows F4): one L0 dot whose
 * hover says one line. A host without validation answers nothing, and the dot
 * stays absent rather than inventing a state.
 */
async function fetchValidationRail(): Promise<{ readonly dot: ValidationRailDot; readonly line: string }> {
  const response = await validationRequest({ type: "validation.railStatus" });
  if (response.ok && response.payload.type === "validation.railStatus") {
    return { dot: response.payload.dot, line: response.payload.line };
  }
  return { dot: "none", line: "" };
}

/** Rail dots speak the task roll-up vocabulary; validation maps into it. */
const VALIDATION_DOT_STATUS: Record<Exclude<ValidationRailDot, "none">, TaskRollupStatus> = {
  ok: "done",
  running: "running",
  failed: "failed",
  blocked: "awaiting"
};

/** Moves the spine. Everything else (hub, chat rail, panels) follows the push. */
function setActiveTask(taskId: string): void {
  void request({ type: "active.set", taskId });
  // active.set is a no-op when unchanged, so the pair never double-pushes.
  void request({ type: "panel.openSurface", surface: "hub", taskId });
}

/** Navigates whichever chat surface is listening (Edit tab today, chat rail from P2). */
function openChat(sessionId: string): void {
  void request({ type: "agents.openSession", sessionId });
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export function createRailView(view: RailView): RailMount {
  if (view === "recents") return createRecentsView();
  if (view === "workspaces") return createWorkspacesView();
  return createTasksView();
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** One task's derived rail state: dot, why it needs you, where it works. */
interface TaskRow {
  readonly task: WorkTaskSummary;
  readonly status: TaskRollupStatus;
  readonly needsYou: boolean;
  /** One dim line: the pending question, or the failure. */
  readonly reason?: string;
  readonly workspaceName?: string;
  /** Newest linked chat, for the hover "chat" action. */
  readonly newestSessionId?: string;
  readonly lastActivityAt: string;
}

function createTasksView(): RailMount {
  const root = el("div", "rail rail-tasks");
  const persisted = restoreState();
  const expanded = new Set<string>(persisted.expandedTaskIds ?? []);
  let earlierOpen = persisted.earlierOpen === true;

  let tasks: readonly WorkTaskSummary[] = [];
  let sessions: readonly ChatSessionSummary[] = [];
  let questions: readonly AgentQuestionSummary[] = [];
  let sets: readonly WorkspaceSetSummary[] = [];
  let activeTaskId: string | null = null;
  const turnActive = new Set<string>();
  /** Validation's L0: the dot follows the CURRENT task's resolved runtime. */
  let validationDot: ValidationRailDot = "none";
  let validationLine = "";

  function persist(): void {
    vscode.setState({ expandedTaskIds: [...expanded], earlierOpen, expandedSetIds: persisted.expandedSetIds ?? [] });
  }

  function buildRows(): TaskRow[] {
    const sessionById = new Map(sessions.map((session) => [session.sessionId, session]));
    const attention = new Set(questions.map((question) => question.sessionId));
    const setNameById = new Map(sets.map((set) => [set.workspaceSetId, set.name]));
    return tasks.map((task) => {
      const linked = new Set<string>(task.linkedSessionIds);
      for (const subtask of task.subtasks) {
        for (const sessionId of subtask.linkedSessionIds) linked.add(sessionId);
      }
      const linkedSessions = [...linked]
        .map((sessionId) => sessionById.get(sessionId))
        .filter((session): session is ChatSessionSummary => session !== undefined)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      const statuses: TaskRollupStatus[] = [
        ...linkedSessions.map((session) => sessionRollupStatus({
          status: session.status,
          ...(session.live === undefined ? {} : { live: session.live }),
          ...(session.runningElsewhere === undefined ? {} : { runningElsewhere: session.runningElsewhere }),
          needsAttention: attention.has(session.sessionId),
          turnActive: turnActive.has(session.sessionId)
        })),
        ...task.subtasks.map((subtask) => subtaskRollupStatus(subtask))
      ];
      const status = rollupTaskStatus(statuses);
      const question = questions.find((candidate) => linked.has(candidate.sessionId));
      const failed = linkedSessions.find((session) => session.status === "failed");
      const reason = question !== undefined
        ? question.question
        : (failed === undefined ? undefined : `${failed.title} failed`);
      const setId = task.linkedWorkspaceSetIds[0];
      const workspaceName = setId === undefined ? undefined : setNameById.get(setId);
      const newest = linkedSessions[0];
      return {
        task,
        status,
        needsYou: status === "awaiting" || status === "failed",
        ...(reason === undefined ? {} : { reason }),
        ...(workspaceName === undefined ? {} : { workspaceName }),
        ...(newest === undefined ? {} : { newestSessionId: newest.sessionId }),
        lastActivityAt: task.lastWorkedAt ?? task.updatedAt
      };
    });
  }

  /** Done or long-untouched work folds away; anything live never does. */
  function isEarlier(row: TaskRow, now: number): boolean {
    if (row.needsYou || row.status === "running" || row.status === "starting" || row.status === "queued") return false;
    if (row.task.doneAt !== undefined) return true;
    const last = Date.parse(row.lastActivityAt);
    return Number.isFinite(last) && now - last > STALE_MS;
  }

  function taskRowNode(row: TaskRow, inCluster: boolean): HTMLElement {
    const node = el("div", "rail-row");
    if (row.task.taskId === activeTaskId) node.classList.add("active");
    if (inCluster) node.classList.add(row.status === "failed" ? "failed" : "attention");

    const main = el("div", "rail-row-main");
    if (row.task.subtasks.length > 0) {
      const open = expanded.has(row.task.taskId);
      const twisty = iconButton(open ? "▾" : "▸", open ? "Collapse subtasks" : "Expand subtasks", "rail-twisty");
      twisty.addEventListener("click", (event) => {
        event.stopPropagation();
        if (open) expanded.delete(row.task.taskId);
        else expanded.add(row.task.taskId);
        persist();
        render();
      });
      main.append(twisty);
    } else {
      main.append(el("span", "rail-twisty-spacer"));
    }
    main.append(dot(row.status));
    main.append(el("span", "rail-title", row.task.title));
    if (row.workspaceName !== undefined) main.append(el("span", "rail-meta", row.workspaceName));
    if (row.newestSessionId !== undefined) {
      const sessionId = row.newestSessionId;
      const chat = iconButton("chat", "Open the newest chat", "rail-action");
      chat.addEventListener("click", (event) => {
        event.stopPropagation();
        setActiveTask(row.task.taskId);
        openChat(sessionId);
      });
      main.append(chat);
    }
    activatable(main, () => setActiveTask(row.task.taskId));
    node.append(main);

    if (inCluster && row.reason !== undefined) node.append(el("div", "rail-reason", row.reason));

    if (expanded.has(row.task.taskId) && row.task.subtasks.length > 0) {
      const children = el("div", "rail-children");
      for (const subtask of row.task.subtasks) {
        const child = el("div", "rail-child");
        child.append(dot(subtaskRollupStatus(subtask)));
        child.append(el("span", "rail-title", subtask.title));
        const childSessionId = subtask.linkedSessionIds[subtask.linkedSessionIds.length - 1];
        if (childSessionId !== undefined) {
          const chat = iconButton("chat", "Open this subtask's chat", "rail-action");
          chat.addEventListener("click", (event) => {
            event.stopPropagation();
            setActiveTask(row.task.taskId);
            openChat(childSessionId);
          });
          child.append(chat);
        }
        activatable(child, () => setActiveTask(row.task.taskId));
        children.append(child);
      }
      node.append(children);
    }
    return node;
  }

  function render(): void {
    const rows = buildRows();
    const now = Date.now();
    // A row moves between sections; it is never drawn twice.
    const cluster = rows.filter((row) => row.needsYou);
    const rest = rows.filter((row) => !row.needsYou);
    const earlier = rest.filter((row) => isEarlier(row, now));
    const recent = rest.filter((row) => !isEarlier(row, now))
      .sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1));

    const children: HTMLElement[] = [];
    // L0 ambient: a word's worth of state, and the one line lives in the
    // hover. `none` renders nothing at all - no validation, no furniture.
    if (validationDot !== "none") {
      const strip = el("div", "rail-status");
      strip.append(el("span", `dot dot-${VALIDATION_DOT_STATUS[validationDot]}`));
      strip.append(el("span", "rail-status-label", "DCC"));
      strip.title = validationLine;
      children.push(strip);
    }
    if (cluster.length > 0) {
      const section = el("section", "rail-cluster");
      section.append(el("div", "rail-section-label", "Needs you"));
      for (const row of cluster.slice(0, CLUSTER_CAP)) section.append(taskRowNode(row, true));
      if (cluster.length > CLUSTER_CAP) {
        section.append(el("div", "rail-more", `+${String(cluster.length - CLUSTER_CAP)} more waiting`));
      }
      children.push(section);
    }
    if (recent.length > 0) {
      const section = el("section", "rail-list");
      for (const row of recent) section.append(taskRowNode(row, false));
      children.push(section);
    }
    if (earlier.length > 0) {
      const fold = document.createElement("details");
      fold.className = "rail-earlier";
      fold.open = earlierOpen;
      fold.addEventListener("toggle", () => {
        earlierOpen = fold.open;
        persist();
      });
      const summary = document.createElement("summary");
      summary.textContent = `Earlier (${String(earlier.length)})`;
      fold.append(summary);
      const body = el("div", "rail-list");
      for (const row of earlier
        .slice()
        .sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1))) {
        body.append(taskRowNode(row, false));
      }
      fold.append(body);
      children.push(fold);
    }
    if (children.length === 0) {
      children.push(el("p", "rail-empty", "No tasks yet. Use New task above to start one."));
    }
    root.replaceChildren(...children);
  }

  let refreshTimer: number | undefined;
  function scheduleRefresh(): void {
    if (refreshTimer !== undefined) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = undefined;
      void refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  async function refresh(): Promise<void> {
    const [nextTasks, nextSessions, nextQuestions, workspace, active, rail] = await Promise.all([
      fetchTasks(),
      fetchSessions(),
      fetchQuestions(),
      fetchWorkspaceState(),
      fetchActiveTaskId(),
      fetchValidationRail()
    ]);
    tasks = nextTasks;
    sessions = nextSessions;
    questions = nextQuestions;
    sets = workspace?.workspaceSets ?? [];
    activeTaskId = active;
    validationDot = rail.dot;
    validationLine = rail.line;
    render();
  }

  return {
    root,
    start(): void {
      onPush("activeTask", (payload) => {
        activeTaskId = payload.activeTaskId;
        render();
      });
      onPush("chat.turnStarted", (payload) => {
        turnActive.add(payload.sessionId);
        render();
      });
      onPush("chat.turnCompleted", (payload) => {
        turnActive.delete(payload.sessionId);
        scheduleRefresh();
      });
      onPush("session.updated", scheduleRefresh);
      onPush("session.deleted", scheduleRefresh);
      onPush("session.attention", scheduleRefresh);
      onPush("question.asked", scheduleRefresh);
      onPush("question.resolved", scheduleRefresh);
      onPush("task.updated", scheduleRefresh);
      onPush("task.deleted", scheduleRefresh);
      onPush("board.changed", scheduleRefresh);
      // Validation heals off the same debounced refresh as everything else -
      // the dot is derived state, and nothing here polls.
      onValidationPush("validation.jobChanged", scheduleRefresh);
      onValidationPush("validation.changed", scheduleRefresh);
      void refresh();
    }
  };
}

/** Push kinds land in `PanelPushPayload` with M7a; the cast is confined here. */
function onValidationPush(type: "validation.jobChanged" | "validation.changed", handler: () => void): void {
  onPush(type as never, handler as never);
}

// ---------------------------------------------------------------------------
// Recents
// ---------------------------------------------------------------------------

function createRecentsView(): RailMount {
  const root = el("div", "rail rail-recents");
  let recents: readonly RecentChatSummary[] = [];
  let activeTaskId: string | null = null;
  const turnActive = new Set<string>();

  function render(): void {
    const children: HTMLElement[] = [];
    // Needs-you rows pin to the top; the rest stay newest-first from the host.
    const ordered = [...recents].sort((a, b) => {
      const pinned = Number(b.needsAttention === true) - Number(a.needsAttention === true);
      if (pinned !== 0) return pinned;
      return a.lastActivityAt < b.lastActivityAt ? 1 : -1;
    });
    if (ordered.length === 0) {
      children.push(el("p", "rail-empty", "No chats yet."));
    } else {
      const list = el("section", "rail-list");
      for (const row of ordered) {
        const node = el("div", "rail-row");
        if (row.taskId === activeTaskId) node.classList.add("active");
        if (row.needsAttention === true) node.classList.add("attention");
        const main = el("div", "rail-row-main");
        main.append(dot(sessionRollupStatus({
          status: row.status,
          ...(row.live === undefined ? {} : { live: row.live }),
          ...(row.runningElsewhere === undefined ? {} : { runningElsewhere: row.runningElsewhere }),
          ...(row.needsAttention === undefined ? {} : { needsAttention: row.needsAttention }),
          turnActive: turnActive.has(row.sessionId)
        })));
        main.append(el("span", "rail-title", row.title));
        main.append(el("span", "rail-meta", row.taskTitle));
        activatable(main, () => {
          setActiveTask(row.taskId);
          openChat(row.sessionId);
        });
        node.append(main);
        list.append(node);
      }
      children.push(list);
    }
    const footer = el("div", "rail-footer");
    const all = iconButton("All chats ↗", "Open the Agents view", "rail-link");
    all.addEventListener("click", () => {
      void request({ type: "agents.open" });
    });
    footer.append(all);
    children.push(footer);
    root.replaceChildren(...children);
  }

  let refreshTimer: number | undefined;
  function scheduleRefresh(): void {
    if (refreshTimer !== undefined) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = undefined;
      void refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  async function refresh(): Promise<void> {
    const [response, active] = await Promise.all([
      request({ type: "session.recents" }),
      fetchActiveTaskId()
    ]);
    if (response.ok && response.payload.type === "session.recents") recents = response.payload.recents;
    activeTaskId = active;
    render();
  }

  return {
    root,
    start(): void {
      onPush("activeTask", (payload) => {
        activeTaskId = payload.activeTaskId;
        render();
      });
      onPush("chat.turnStarted", (payload) => {
        turnActive.add(payload.sessionId);
        render();
      });
      onPush("chat.turnCompleted", (payload) => {
        turnActive.delete(payload.sessionId);
        scheduleRefresh();
      });
      onPush("session.updated", scheduleRefresh);
      onPush("session.deleted", scheduleRefresh);
      onPush("session.attention", scheduleRefresh);
      onPush("question.asked", scheduleRefresh);
      onPush("question.resolved", scheduleRefresh);
      onPush("task.updated", scheduleRefresh);
      onPush("board.changed", scheduleRefresh);
      void refresh();
    }
  };
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

function createWorkspacesView(): RailMount {
  const root = el("div", "rail rail-workspaces");
  const persisted = restoreState();
  const expanded = new Set<string>(persisted.expandedSetIds ?? []);
  /** Sets the host refused to delete, with its reason: delete stays disabled. */
  const blocked = new Map<string, string>();
  let state: WorkspacePolicyState | null = null;
  let tasks: readonly WorkTaskSummary[] = [];
  let sessions: readonly ChatSessionSummary[] = [];
  let renaming: string | null = null;
  let notice = "";

  function persist(): void {
    vscode.setState({
      expandedSetIds: [...expanded],
      expandedTaskIds: persisted.expandedTaskIds ?? [],
      earlierOpen: persisted.earlierOpen === true
    });
  }

  /** Sets carrying a live chat (via their tasks): the in-use marker + delete guard hint. */
  function inUseSetIds(): Set<string> {
    const live = new Set(sessions
      .filter((session) => session.live === true || session.runningElsewhere === true)
      .map((session) => session.sessionId));
    const ids = new Set<string>();
    for (const task of tasks) {
      const linked = new Set<string>(task.linkedSessionIds);
      for (const subtask of task.subtasks) {
        for (const sessionId of subtask.linkedSessionIds) linked.add(sessionId);
      }
      if (![...linked].some((sessionId) => live.has(sessionId))) continue;
      for (const setId of task.linkedWorkspaceSetIds) ids.add(setId);
    }
    return ids;
  }

  function saveSet(set: WorkspaceSetSummary, name: string): void {
    const members = set.members.map((member) => ({ projectId: member.projectId, readOnly: member.readOnly }));
    void request({ type: "workspace.updateSet", workspaceSetId: set.workspaceSetId, name, members }).then((response) => {
      if (!response.ok) {
        notice = response.error.message;
        render();
        return;
      }
      if (response.payload.type === "workspace.updateSet") state = response.payload.state;
      renaming = null;
      notice = "";
      render();
    });
  }

  function toggleReadOnly(set: WorkspaceSetSummary, projectId: string): void {
    const members = set.members.map((member) => ({
      projectId: member.projectId,
      readOnly: member.projectId === projectId ? !member.readOnly : member.readOnly
    }));
    void request({ type: "workspace.updateSet", workspaceSetId: set.workspaceSetId, name: set.name, members })
      .then((response) => {
        if (!response.ok) {
          notice = response.error.message;
          render();
          return;
        }
        if (response.payload.type === "workspace.updateSet") state = response.payload.state;
        notice = "";
        render();
      });
  }

  function deleteSet(set: WorkspaceSetSummary): void {
    void request({ type: "workspace.deleteSet", workspaceSetId: set.workspaceSetId }).then((response) => {
      if (!response.ok) {
        // The host owns the guard; a refusal disables this row's delete and
        // says which task is standing in the way.
        blocked.set(set.workspaceSetId, response.error.message);
        notice = response.error.message;
        render();
        return;
      }
      if (response.payload.type === "workspace.deleteSet") state = response.payload.state;
      blocked.delete(set.workspaceSetId);
      notice = "";
      render();
    });
  }

  function addOpenFolders(name: string): void {
    void request({ type: "workspace.registerOpenFolders" }).then((response) => {
      if (!response.ok || response.payload.type !== "workspace.registerOpenFolders") {
        notice = response.ok ? "Unexpected response." : response.error.message;
        render();
        return;
      }
      const members = response.payload.projects.map((project) => ({ projectId: project.projectId, readOnly: false }));
      if (members.length === 0) {
        notice = "No local folders are open in this window.";
        render();
        return;
      }
      void request({ type: "workspace.createSet", name, members }).then((created) => {
        if (!created.ok) {
          notice = created.error.message;
          render();
          return;
        }
        if (created.payload.type === "workspace.createSet") state = created.payload.state;
        notice = "";
        render();
      });
    });
  }

  function setNode(set: WorkspaceSetSummary, inUse: boolean): HTMLElement {
    const node = el("div", "rail-row rail-set");
    const main = el("div", "rail-row-main");
    const open = expanded.has(set.workspaceSetId);
    const twisty = iconButton(open ? "▾" : "▸", open ? "Collapse folders" : "Expand folders", "rail-twisty");
    twisty.addEventListener("click", (event) => {
      event.stopPropagation();
      if (open) expanded.delete(set.workspaceSetId);
      else expanded.add(set.workspaceSetId);
      persist();
      render();
    });
    main.append(twisty);

    if (renaming === set.workspaceSetId) {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "rail-input";
      input.value = set.name;
      input.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter" && input.value.trim() !== "") saveSet(set, input.value.trim());
        if (event.key === "Escape") {
          renaming = null;
          render();
        }
      });
      main.append(input);
      window.setTimeout(() => input.focus(), 0);
    } else {
      main.append(el("span", "rail-title", set.name));
    }

    const count = set.members.length;
    main.append(el("span", "rail-meta", `${String(count)} folder${count === 1 ? "" : "s"}`));
    if (state?.security?.cloneOnly === true) main.append(el("span", "rail-chip", "clone-only"));
    if (inUse) main.append(el("span", "rail-chip in-use", "in use"));

    const rename = iconButton("edit", "Rename this workspace set", "rail-action");
    rename.addEventListener("click", (event) => {
      event.stopPropagation();
      renaming = renaming === set.workspaceSetId ? null : set.workspaceSetId;
      render();
    });
    main.append(rename);

    const remove = iconButton("delete", "Delete this workspace set", "rail-action");
    const guard = blocked.get(set.workspaceSetId);
    if (guard !== undefined || inUse) {
      remove.disabled = true;
      remove.title = guard ?? "A live chat is mounted on this workspace set.";
    }
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteSet(set);
    });
    main.append(remove);
    node.append(main);

    if (open) {
      const members = el("div", "rail-children");
      for (const member of set.members) {
        const row = el("div", "rail-child");
        row.append(el("span", "rail-title", member.name));
        const tag = iconButton(member.readOnly ? "RO" : "RW", member.readOnly ? "Read-only - make writable" : "Writable - make read-only", "rail-tag");
        tag.addEventListener("click", (event) => {
          event.stopPropagation();
          toggleReadOnly(set, member.projectId);
        });
        row.append(tag);
        row.append(el("span", "rail-meta path", member.displayPath));
        members.append(row);
      }
      node.append(members);
    }
    if (guard !== undefined) node.append(el("div", "rail-reason", guard));
    return node;
  }

  function render(): void {
    const children: HTMLElement[] = [];
    const inUse = inUseSetIds();
    const workspaceSets = state?.workspaceSets ?? [];
    if (workspaceSets.length === 0) {
      children.push(el("p", "rail-empty", "No workspace sets yet."));
    } else {
      const list = el("section", "rail-list");
      for (const set of workspaceSets) list.append(setNode(set, inUse.has(set.workspaceSetId)));
      children.push(list);
    }

    const adder = el("div", "rail-adder");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "rail-input";
    input.placeholder = "New set from open folders";
    const add = iconButton("add", "Register this window's folders as a new set", "rail-action");
    const submit = (): void => {
      const name = input.value.trim();
      if (name === "") {
        notice = "Give the set a name.";
        render();
        return;
      }
      addOpenFolders(name);
    };
    add.addEventListener("click", submit);
    input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter") submit();
    });
    adder.append(input, add);
    children.push(adder);

    if (notice !== "") children.push(el("p", "rail-notice", notice));
    root.replaceChildren(...children);
  }

  let refreshTimer: number | undefined;
  function scheduleRefresh(): void {
    if (refreshTimer !== undefined) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = undefined;
      void refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  async function refresh(): Promise<void> {
    const [workspace, nextTasks, nextSessions] = await Promise.all([
      fetchWorkspaceState(),
      fetchTasks(),
      fetchSessions()
    ]);
    state = workspace;
    tasks = nextTasks;
    sessions = nextSessions;
    render();
  }

  return {
    root,
    start(): void {
      onPush("session.updated", scheduleRefresh);
      onPush("session.deleted", scheduleRefresh);
      onPush("task.updated", scheduleRefresh);
      onPush("task.deleted", scheduleRefresh);
      onPush("board.changed", scheduleRefresh);
      onPush("workspace.folders", scheduleRefresh);
      void refresh();
    }
  };
}
