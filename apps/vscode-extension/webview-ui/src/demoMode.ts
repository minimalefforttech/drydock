/**
 * In-memory guide data for Drydock webviews.
 *
 * Demo mode is deliberately implemented on the webview side. Requests are
 * answered before they can reach the extension host, so trying the guide can
 * never read or mutate a real project, start an agent, or contact a runtime.
 * Navigation requests are the only exception: they may ask VS Code to reveal
 * another Drydock panel, whose guide immediately enables its own demo state.
 */

import {
  WEBVIEW_PROTOCOL_VERSION,
  type PanelRequestPayload,
  type PanelResponse
} from "@drydock/contracts";

const DEMO_BLOCKED = "Demo data does not access files, contact AI, or start runtimes. Switch to Live data to run this action.";
const NAVIGATION_REQUESTS = new Set<PanelRequestPayload["type"]>([
  "taskBoard.open",
  "agents.open",
  "planner.open",
  "taskReview.open",
  "codeReview.open",
  "agents.openSession",
  // UX overhaul P3: opening a surface is navigation, never demo data.
  "panel.openSurface"
]);

type Refresh = () => void | Promise<void>;
type DemoRecord = Record<string, any>;

interface DemoPlanState {
  plan: DemoRecord;
  artifacts: DemoRecord[];
  annotations: DemoRecord[];
  aspects: DemoRecord[];
}

interface DemoReviewState extends DemoRecord {
  sessions: DemoRecord[];
  projects: Array<{ name: string; files: DemoRecord[] }>;
}

interface DemoFixtures {
  now: string;
  columns: DemoRecord[];
  tasks: DemoRecord[];
  sessions: DemoRecord[];
  questions: DemoRecord[];
  workspace: DemoRecord;
  catalogs: DemoRecord[];
  plans: DemoRecord[];
  aspects: DemoRecord[];
  planStates: Record<string, DemoPlanState>;
  review: DemoReviewState;
  comments: DemoRecord[];
  landing: DemoRecord[];
  timelines: Record<string, DemoRecord[]>;
  diff: DemoRecord[];
  cloneRepos: DemoRecord[];
  runtimes: DemoRecord[];
  runtimeStats: DemoRecord[];
  recipes: DemoRecord[];
  faqs: Record<string, DemoRecord[]>;
}

export interface DemoModeController {
  readonly helpMode: {
    isDemo(): boolean;
    setDemo(enabled: boolean): Promise<void>;
  };
  isDemo(): boolean;
  setDemo(enabled: boolean): Promise<void>;
  reset(): Promise<void>;
}

// Demo activation is scoped to guide start. Every new webview starts on Live
// data; after the guide, its fixtures remain available for interaction until
// the user switches back through the compact Data menu or closes the webview.
let demoEnabled = false;
let refreshCurrent: Refresh | null = null;
let banner: HTMLElement | null = null;
let serial = 100;
let fixtures: DemoFixtures = createFixtures();

function button(label: string, className = ""): HTMLButtonElement {
  const value = document.createElement("button");
  value.type = "button";
  value.className = `dd-demo-action ${className}`.trim();
  value.textContent = label;
  return value;
}

function renderBanner(): void {
  banner?.remove();
  banner = null;
  if (!demoEnabled) return;

  const root = document.createElement("aside");
  root.className = "dd-demo-banner";
  root.setAttribute("role", "status");
  const copy = document.createElement("span");
  copy.className = "dd-demo-copy";
  copy.textContent = "Demo data · Changes stay in this panel. Files, AI, and runtimes are disconnected.";
  const menu = document.createElement("details");
  menu.className = "dd-demo-menu";
  const summary = document.createElement("summary");
  summary.textContent = "Data";
  summary.title = "Demo data options";
  const options = document.createElement("div");
  options.className = "dd-demo-menu-options";
  const reset = button("Reset demo", "quiet");
  reset.addEventListener("click", () => {
    menu.open = false;
    void resetDemoData();
  });
  const live = button("Use live data");
  live.addEventListener("click", () => void setDemoMode(false));
  options.append(reset, live);
  menu.append(summary, options);
  root.append(copy, menu);
  document.body.append(root);
  banner = root;
}

export function isDemoMode(): boolean {
  return demoEnabled;
}

export async function setDemoMode(enabled: boolean): Promise<void> {
  const changed = demoEnabled !== enabled;
  demoEnabled = enabled;
  if (enabled && changed) fixtures = createFixtures();
  renderBanner();
  await refreshCurrent?.();
}

export async function resetDemoData(): Promise<void> {
  fixtures = createFixtures();
  renderBanner();
  await refreshCurrent?.();
}

export function createDemoModeController(refresh: Refresh): DemoModeController {
  refreshCurrent = refresh;
  window.setTimeout(renderBanner, 0);
  return {
    helpMode: {
      isDemo: isDemoMode,
      setDemo: setDemoMode
    },
    isDemo: isDemoMode,
    setDemo: setDemoMode,
    reset: resetDemoData
  };
}

function ok(requestId: string, payload: unknown): PanelResponse {
  return { protocolVersion: WEBVIEW_PROTOCOL_VERSION, kind: "response", requestId, ok: true, payload } as PanelResponse;
}

/**
 * Demo mutations mirror the host's push channel (window message with the same
 * envelope), so surfaces that re-render on push behave exactly as with Live
 * data - e.g. an answered question clears from the attention stack.
 */
function push(payload: Record<string, unknown>): void {
  window.postMessage({ protocolVersion: WEBVIEW_PROTOCOL_VERSION, kind: "push", payload }, "*");
}

function accepted(requestId: string, type: "taskBoard.open" | "agents.open" | "planner.open" | "agents.openSession"): PanelResponse {
  return ok(requestId, { type, accepted: true });
}

function error(requestId: string, message = DEMO_BLOCKED): PanelResponse {
  return {
    protocolVersion: WEBVIEW_PROTOCOL_VERSION,
    kind: "response",
    requestId,
    ok: false,
    error: { message, code: "DEMO_MODE" }
  };
}

/**
 * Returns a response when Demo mode owns the request, or null when the request
 * should continue to the extension host (Live mode and panel navigation).
 */
export function demoResponse(payload: PanelRequestPayload, requestId: string): PanelResponse | null {
  if (!demoEnabled || NAVIGATION_REQUESTS.has(payload.type)) return null;

  switch (payload.type) {
    case "panel.init":
      return ok(requestId, {
        type: "panel.init",
        state: {
          availability: { available: true, sbxDisplayPath: "Demo mode · no runtime" },
          runtimes: fixtures.runtimes,
          providerCatalogs: fixtures.catalogs,
          stateRootDisplayPath: "Demo data (memory only)",
          openFolderNames: ["drydock-demo", "component-library"],
          agentIdleThresholdMs: 300_000,
          codeBlockWordWrap: true
        }
      });
    case "session.list":
      return ok(requestId, { type: "session.list", sessions: fixtures.sessions });
    case "session.timeline":
      return ok(requestId, {
        type: "session.timeline",
        sessionId: payload.sessionId,
        lines: fixtures.timelines[payload.sessionId] ?? []
      });
    case "session.rename": {
      const session = updateSession(payload.sessionId, { title: payload.title });
      return session === undefined ? error(requestId, "Demo session not found.") : ok(requestId, { type: "session.rename", session });
    }
    case "session.setDescription": {
      const session = updateSession(payload.sessionId, { description: payload.description });
      return session === undefined ? error(requestId, "Demo session not found.") : ok(requestId, { type: "session.setDescription", session });
    }
    case "session.delete":
      fixtures.sessions = fixtures.sessions.filter((session) => session.sessionId !== payload.sessionId);
      return ok(requestId, { type: "session.delete", sessionId: payload.sessionId });
    case "session.summarize":
      return ok(requestId, { type: "session.summarize", sessionId: payload.sessionId, mode: payload.mode, accepted: true });
    case "question.list":
      return ok(requestId, { type: "question.list", questions: fixtures.questions.filter((item) => item.status === "pending") });
    case "question.answer": {
      const question = updateQuestion(payload.questionId, { status: "answered", answer: payload.answer });
      if (question === undefined) return error(requestId, "Demo question not found.");
      push({ type: "question.resolved", question });
      return ok(requestId, { type: "question.answer", question, dispatched: false });
    }
    case "question.dismiss": {
      const question = updateQuestion(payload.questionId, { status: "dismissed" });
      if (question === undefined) return error(requestId, "Demo question not found.");
      push({ type: "question.resolved", question });
      return ok(requestId, { type: "question.dismiss", question });
    }
    case "provider.list":
      return ok(requestId, { type: "provider.list", providerCatalogs: fixtures.catalogs });
    case "provider.login":
      return ok(requestId, { type: "provider.login", providerId: payload.providerId, launched: "demo sign-in", mode: "terminal" });
    case "provider.submitCode":
      return ok(requestId, { type: "provider.submitCode", providerId: payload.providerId, accepted: true });
    case "provider.submitApiKey":
      return ok(requestId, { type: "provider.submitApiKey", providerId: payload.providerId, authStatus: "authenticated" });
    case "provider.cancelLogin":
      return ok(requestId, { type: "provider.cancelLogin", providerId: payload.providerId, cancelled: false });
    case "task.list":
      return ok(requestId, { type: "task.list", tasks: fixtures.tasks });
    case "task.create": {
      const task = createTask(payload.title, payload.description);
      fixtures.tasks = [task, ...fixtures.tasks];
      return ok(requestId, { type: "task.create", task });
    }
    case "task.update": {
      const task = updateTask(payload.taskId, payload);
      return task === undefined ? error(requestId, "Demo task not found.") : ok(requestId, { type: "task.update", task });
    }
    case "task.delete":
      fixtures.tasks = fixtures.tasks.filter((task) => task.taskId !== payload.taskId);
      return ok(requestId, { type: "task.delete", taskId: payload.taskId });
    case "task.link":
    case "task.unlink": {
      // A subtask-narrowed session link (the rail's "Track as subtask") moves
      // the chat onto that card, so the demo shows the same shape as Live.
      const linked = payload.type === "task.link" && payload.subtaskId !== undefined && payload.sessionId !== undefined
        ? linkSessionToSubtask(payload.taskId, payload.subtaskId, payload.sessionId)
        : fixtures.tasks.find((item) => item.taskId === payload.taskId);
      return linked === undefined ? error(requestId, "Demo task not found.") : ok(requestId, { type: payload.type, task: linked });
    }
    case "board.state":
      return ok(requestId, { type: "board.state", board: boardState() });
    case "board.moveCard":
      moveCard(payload.cardKind, payload.id, payload.columnId);
      return ok(requestId, { type: "board.moveCard", board: boardState() });
    case "board.columns.update":
      fixtures.columns = payload.columns.map((column, index) => ({
        columnId: column.columnId ?? `demo-column-${String(++serial)}`,
        name: column.name,
        category: column.category,
        sortOrder: index
      }));
      return ok(requestId, { type: "board.columns.update", board: boardState() });
    case "subtask.create": {
      const task = addSubtask(payload.taskId, payload.title, payload.description, payload.prompt, payload.autoStart);
      return task === undefined ? error(requestId, "Demo task not found.") : ok(requestId, { type: "subtask.create", task });
    }
    case "subtask.update": {
      const task = updateSubtask(payload.subtaskId, payload);
      return task === undefined ? error(requestId, "Demo subtask not found.") : ok(requestId, { type: "subtask.update", task });
    }
    case "subtask.delete": {
      const task = deleteSubtask(payload.subtaskId);
      return task === undefined ? error(requestId, "Demo subtask not found.") : ok(requestId, { type: "subtask.delete", task });
    }
    case "subtask.dependency.add": {
      const task = updateDependency(payload.taskId, payload.fromSubtaskId, payload.toSubtaskId, true);
      return task === undefined ? error(requestId, "Demo subtask not found.") : ok(requestId, { type: "subtask.dependency.add", task });
    }
    case "subtask.dependency.remove": {
      const task = updateDependency(payload.taskId, payload.fromSubtaskId, payload.toSubtaskId, false);
      return task === undefined ? error(requestId, "Demo subtask not found.") : ok(requestId, { type: "subtask.dependency.remove", task });
    }
    case "recipes.list":
      return ok(requestId, { type: "recipes.list", recipes: fixtures.recipes });
    case "task.createFromRecipe": {
      const task = createTask(payload.title, "Created from the demo workflow recipe.");
      task.subtasks = [demoSubtask(task.taskId, "Confirm the change boundary", "col-ready", 0), demoSubtask(task.taskId, "Implement and review", "col-backlog", 1)];
      fixtures.tasks = [task, ...fixtures.tasks];
      return ok(requestId, { type: "task.createFromRecipe", task });
    }
    case "task.faq.list":
      return ok(requestId, { type: "task.faq.list", faqs: fixtures.faqs[payload.taskId] ?? [] });
    case "task.faq.add": {
      const faqs = fixtures.faqs[payload.taskId] ?? [];
      const next = { faqId: `demo-faq-${String(++serial)}`, taskId: payload.taskId, pattern: payload.pattern, answer: payload.answer, createdAt: fixtures.now };
      fixtures.faqs[payload.taskId] = [...faqs, next];
      return ok(requestId, { type: "task.faq.add", faqs: fixtures.faqs[payload.taskId] });
    }
    case "task.faq.remove":
      fixtures.faqs[payload.taskId] = (fixtures.faqs[payload.taskId] ?? []).filter((faq) => faq.faqId !== payload.faqId);
      return ok(requestId, { type: "task.faq.remove", faqs: fixtures.faqs[payload.taskId] });
    case "workspace.state":
      return ok(requestId, { type: "workspace.state", state: fixtures.workspace });
    case "policy.resolveAccess": {
      const accessRequest = fixtures.workspace.accessRequests.find((item: DemoRecord) => item.accessRequestId === payload.accessRequestId);
      if (accessRequest === undefined) return error(requestId, "Demo access request not found.");
      accessRequest.status = payload.approve ? "approved" : "denied";
      return ok(requestId, { type: "policy.resolveAccess", accessRequest });
    }
    case "memory.list":
      return ok(requestId, { type: "memory.list", candidates: [], detectedTags: ["typescript", "node"] });
    case "mcp.list":
      return ok(requestId, { type: "mcp.list", servers: [], overrides: [] });
    case "mcp.setOverride":
      return ok(requestId, { type: "mcp.setOverride", overrides: [] });
    case "diff.status":
      return ok(requestId, { type: "diff.status", changes: fixtures.diff });
    case "diff.openFile":
      return ok(requestId, { type: "diff.openFile", accepted: true });
    case "review.state":
      return ok(requestId, {
        type: "review.state",
        reviewSessionId: payload.sessionId ?? null,
        comments: fixtures.comments.filter((comment) => payload.sessionId === undefined || comment.sessionId === payload.sessionId)
      });
    case "review.addComment": {
      const comment = {
        commentId: `demo-comment-${String(++serial)}`,
        sessionId: payload.sessionId ?? fixtures.sessions[0]?.sessionId ?? "demo-session-build",
        filePath: payload.filePath,
        startLine: payload.startLine,
        endLine: payload.endLine,
        body: payload.body,
        author: "You",
        status: "open",
        createdAt: new Date().toISOString()
      };
      fixtures.comments = [...fixtures.comments, comment];
      syncReviewCounts();
      return ok(requestId, { type: "review.addComment", comment });
    }
    case "review.setCommentStatus": {
      const comment = updateComment(payload.commentId, payload.status);
      return comment === undefined ? error(requestId, "Demo comment not found.") : ok(requestId, { type: "review.setCommentStatus", comment });
    }
    case "taskReview.state":
      return ok(requestId, { type: "taskReview.state", state: fixtures.review });
    // The Code Review panel has no demo fixtures yet; data requests are blocked
    // in Demo mode (the panel itself is reachable via the navigation set above).
    case "codeReview.state":
    case "codeReview.fileDiff":
    case "codeReview.addNote":
    case "clone.exportPatch":
    case "chat.uploadAttachment":
    case "preview.open":
    case "preview.stop":
    case "terminal.attach":
      return error(requestId);
    case "preview.list":
      return ok(requestId, { type: "preview.list", previews: [] });
    case "taskReview.submit": {
      const open = fixtures.comments.filter((comment) => comment.status === "open");
      const sessionIds = [...new Set(open.map((comment) => comment.sessionId))];
      fixtures.comments = fixtures.comments.map((comment) => comment.status === "open" ? { ...comment, status: "delegated" } : comment);
      syncReviewCounts();
      return ok(requestId, {
        type: "taskReview.submit",
        dispatched: open.length,
        sessions: sessionIds.length,
        sentSessions: fixtures.review.sessions.filter((session) => sessionIds.includes(session.sessionId)),
        errors: []
      });
    }
    case "agents.state":
      return ok(requestId, { type: "agents.state", state: agentsState() });
    case "planner.plans":
      return ok(requestId, { type: "planner.plans", plans: fixtures.plans });
    case "planner.aspects.list":
      return ok(requestId, { type: "planner.aspects.list", aspects: fixtures.aspects });
    case "planner.state": {
      const state = fixtures.planStates[payload.planId] ?? Object.values(fixtures.planStates)[0];
      if (state === undefined) return error(requestId, "Demo plan not found.");
      const session = fixtures.sessions.find((item) => item.sessionId === state.plan.sessionId) ?? null;
      return ok(requestId, { type: "planner.state", state, session });
    }
    case "planner.updateIntake": {
      const plan = updatePlan(payload.planId, payload);
      return plan === undefined ? error(requestId, "Demo plan not found.") : ok(requestId, { type: "planner.updateIntake", plan });
    }
    case "planner.archive": {
      const plan = updatePlan(payload.planId, { status: payload.archived ? "archived" : "active" });
      return plan === undefined ? error(requestId, "Demo plan not found.") : ok(requestId, { type: "planner.archive", plan });
    }
    case "planner.annotation.add": {
      const state = fixtures.planStates[payload.planId];
      if (state === undefined) return error(requestId, "Demo plan not found.");
      const annotation = { annotationId: `demo-annotation-${String(++serial)}`, artifactId: payload.artifactId, anchor: payload.anchor, body: payload.body, status: "open", delegatedRev: null, createdAt: new Date().toISOString() };
      state.annotations = [...state.annotations, annotation];
      updatePlanCounts(payload.planId);
      return ok(requestId, { type: "planner.annotation.add", annotation });
    }
    case "planner.annotation.setStatus": {
      const annotation = updateAnnotation(payload.annotationId, payload.status);
      return annotation === undefined ? error(requestId, "Demo annotation not found.") : ok(requestId, { type: "planner.annotation.setStatus", annotation });
    }
    case "planner.annotation.remove":
      for (const state of Object.values(fixtures.planStates)) state.annotations = state.annotations.filter((item) => item.annotationId !== payload.annotationId);
      for (const plan of fixtures.plans) updatePlanCounts(plan.planId);
      return ok(requestId, { type: "planner.annotation.remove", removed: true });
    case "planner.artifact.rename": {
      const artifact = renameArtifact(payload.artifactId, payload.title);
      return artifact === undefined ? error(requestId, "Demo artifact not found.") : ok(requestId, { type: "planner.artifact.rename", artifact });
    }
    case "planner.subtaskCandidates":
      return ok(requestId, { type: "planner.subtaskCandidates", candidates: ["Add guided demo fixtures", "Verify every panel tour", "Package a test build"], taskId: fixtures.tasks[0]?.taskId, taskTitle: fixtures.tasks[0]?.title });
    case "planner.materializeSubtasks": {
      const plan = fixtures.plans.find((item) => item.planId === payload.planId);
      if (plan?.taskId === null || plan?.taskId === undefined) return error(requestId, "Link the demo plan to a task first.");
      for (const title of payload.titles) addSubtask(plan.taskId, title);
      return ok(requestId, { type: "planner.materializeSubtasks", createdCount: payload.titles.length, taskId: plan.taskId });
    }
    case "planner.setPrototypeScripts": {
      const artifact = setArtifactScripts(payload.artifactId, payload.enabled);
      return artifact === undefined ? error(requestId, "Demo artifact not found.") : ok(requestId, { type: "planner.setPrototypeScripts", artifact });
    }
    case "planner.aspects.save": {
      const existing = payload.aspect.aspectId === undefined ? undefined : fixtures.aspects.find((item) => item.aspectId === payload.aspect.aspectId);
      const aspect = existing === undefined
        ? { ...payload.aspect, aspectId: `demo-aspect-${String(++serial)}`, sortOrder: fixtures.aspects.length, archived: false, seeded: false }
        : { ...existing, ...payload.aspect };
      fixtures.aspects = existing === undefined ? [...fixtures.aspects, aspect] : fixtures.aspects.map((item) => item.aspectId === aspect.aspectId ? aspect : item);
      return ok(requestId, { type: "planner.aspects.save", aspects: fixtures.aspects });
    }
    case "planner.aspects.archive":
      fixtures.aspects = fixtures.aspects.map((aspect) => aspect.aspectId === payload.aspectId ? { ...aspect, archived: payload.archived } : aspect);
      return ok(requestId, { type: "planner.aspects.archive", aspects: fixtures.aspects });
    case "ui.confirm":
      return ok(requestId, { type: "ui.confirm", confirmed: true });
    case "clipboard.writeText":
      return ok(requestId, { type: "clipboard.writeText", accepted: true });
    case "isolatedRun.listRuntimes":
      return ok(requestId, { type: "isolatedRun.listRuntimes", runtimes: fixtures.runtimes });
    case "chat.rawStream":
      return ok(requestId, { type: "chat.rawStream", text: "Demo stream is disconnected.", lastChunkAt: fixtures.now });
    case "chat.runtimeStats":
      return ok(requestId, { type: "chat.runtimeStats", stats: fixtures.runtimeStats[0] ?? null });
    case "clone.state":
      return ok(requestId, { type: "clone.state", sessionId: payload.sessionId, repos: fixtures.cloneRepos });
    case "chat.openFile":
    case "workspace.openInNewWindow":
    case "workspace.activate":
    case "workspace.registerOpenFolders":
    case "workspace.createSet":
    case "workspace.updateSet":
    case "workspace.deleteSet":
    case "workspace.removeProject":
    case "workspace.updateProjectPath":
    case "policy.requestAccess":
    case "diff.snapshotWorkspace":
    case "diff.acceptFile":
    case "diff.revertFile":
    case "memory.resolve":
    case "memory.open":
    case "memory.add":
    case "memory.delete":
    case "mcp.save":
    case "mcp.delete":
    case "chat.contextDebug":
    case "runtime.sbxLogin":
    case "runtime.openTerminal":
    case "runtime.reconcile":
    case "isolatedRun.stopRuntime":
    case "chat.start":
    case "chat.startSession":
    case "chat.sendTurn":
    case "chat.restartBackend":
    case "chat.resumeSession":
    case "chat.reclaim":
    case "chat.cancelTurn":
    case "chat.poke":
    case "chat.endSession":
    case "chat.spawnRole":
    case "subtask.start":
    case "task.start":
    case "agents.landSession":
    case "planner.create":
    case "planner.startSession":
    case "planner.sendTurn":
    case "planner.sendInstructions":
    case "planner.regenerate":
    case "planner.openArtifact":
    case "clone.pull":
    case "clone.push":
    case "clone.discard":
    // The active-task spine is host state; demo mode has no fixture for it yet.
    case "active.get":
    case "active.set":
    // Left-rail recents (UX overhaul P1): placeholder so the exhaustive switch
    // compiles; the rail's own demo fixture replaces this.
    case "session.recents":
    // Task Hub (UX overhaul P3): the hub's composite read has no fixture yet;
    // panel.openSurface never reaches here (it is navigation, listed above).
    case "hub.state":
    case "panel.openSurface":
    // Configure (UX overhaul P6): every row is real machine configuration -
    // providers, MCP definitions, settings write-through. Demo mode has no
    // fixture on purpose; a guide must never appear to change a real setting.
    case "config.state":
    case "config.setSetting":
    case "config.mcpToggle":
    case "config.mcpAdd":
    case "config.provider.signIn":
    case "config.provider.setDefaultModel":
    case "config.openFile":
    // Validation runtimes (ADR 0022): the registry is real machine
    // configuration and the job queue is real evidence - Demo mode fabricates
    // neither. The surfaces degrade quietly (no chips, no rail dot) on error.
    case "config.validation.state":
    case "config.validation.createRuntime":
    case "config.validation.updateRuntime":
    case "config.validation.deleteRuntime":
    case "config.validation.setDefault":
    case "config.validation.setSettings":
    case "config.validation.setAssociation":
    case "config.validation.clearAssociation":
    case "config.validation.runProbes":
    case "config.validation.adopt":
    case "config.validation.revertReprobe":
    case "validation.jobs":
    case "validation.abortJob":
    case "validation.requeue":
    case "validation.setTaskRuntime":
    case "validation.railStatus":
    case "validation.run":
      return error(requestId);
    case "taskBoard.open":
    case "agents.open":
    case "planner.open":
    case "agents.openSession":
      return accepted(requestId, payload.type);
    case "taskReview.open":
      return ok(requestId, { type: "taskReview.open", accepted: true });
    case "codeReview.open":
      return ok(requestId, { type: "codeReview.open", accepted: true });
  }
}

function boardState(): DemoRecord {
  return { columns: fixtures.columns, tasks: fixtures.tasks };
}

function agentsState(): DemoRecord {
  const taskSessions = (taskId: string) => fixtures.sessions.filter((session) => fixtures.tasks.find((task) => task.taskId === taskId)?.linkedSessionIds.includes(session.sessionId));
  return {
    generatedAt: fixtures.now,
    groups: fixtures.tasks.slice(0, 3).map((task) => ({
      task,
      columnName: fixtures.columns.find((column) => column.columnId === task.columnId)?.name,
      columnCategory: fixtures.columns.find((column) => column.columnId === task.columnId)?.category,
      sessions: taskSessions(task.taskId)
    })),
    orphanSessions: fixtures.sessions.filter((session) => !fixtures.tasks.some((task) => task.linkedSessionIds.includes(session.sessionId))),
    questions: fixtures.questions.filter((question) => question.status === "pending"),
    accessRequests: fixtures.workspace.accessRequests.filter((request: DemoRecord) => request.status === "pending"),
    agentIdleThresholdMs: 300_000,
    landing: fixtures.landing
  };
}

function createTask(title: string, description?: string): DemoRecord {
  const id = `demo-task-${String(++serial)}`;
  return {
    taskId: id,
    title,
    ...(description === undefined ? {} : { description }),
    state: "todo",
    columnId: "col-backlog",
    linkedWorkspaceSetIds: ["set-drydock"],
    linkedSessionIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    subtasks: [] as ReturnType<typeof demoSubtask>[]
  };
}

function demoSubtask(taskId: string, title: string, columnId: string, sortOrder: number, extras: Record<string, unknown> = {}): DemoRecord {
  return {
    subtaskId: `demo-subtask-${String(++serial)}`,
    taskId,
    title,
    description: "Demo work item. Move it, edit it, or connect it to another subtask.",
    prompt: `Implement ${title.toLowerCase()}.`,
    autoStart: false,
    origin: "manual",
    columnId,
    sortOrder,
    createdAt: "2026-07-15T01:15:00.000Z",
    updatedAt: "2026-07-15T01:15:00.000Z",
    isBlocked: false,
    dependsOn: [] as string[],
    isRunning: false,
    linkedSessionIds: [] as string[],
    ...extras
  };
}

function updateTask(taskId: string, change: Record<string, unknown>) {
  let result: (typeof fixtures.tasks)[number] | undefined;
  fixtures.tasks = fixtures.tasks.map((task) => {
    if (task.taskId !== taskId) return task;
    result = { ...task, ...change, type: undefined, taskId, updatedAt: new Date().toISOString() };
    delete (result as { type?: unknown }).type;
    return result;
  });
  return result;
}

function updateSession(sessionId: string, change: Record<string, unknown>) {
  let result: (typeof fixtures.sessions)[number] | undefined;
  fixtures.sessions = fixtures.sessions.map((session) => {
    if (session.sessionId !== sessionId) return session;
    result = { ...session, ...change, updatedAt: new Date().toISOString() };
    return result;
  });
  return result;
}

function updateQuestion(questionId: string, change: Record<string, unknown>) {
  let result: (typeof fixtures.questions)[number] | undefined;
  fixtures.questions = fixtures.questions.map((question) => {
    if (question.questionId !== questionId) return question;
    result = { ...question, ...change } as (typeof fixtures.questions)[number];
    return result;
  });
  return result;
}

function addSubtask(taskId: string, title: string, description?: string, prompt?: string, autoStart?: boolean) {
  let result: (typeof fixtures.tasks)[number] | undefined;
  fixtures.tasks = fixtures.tasks.map((task) => {
    if (task.taskId !== taskId) return task;
    const subtask = demoSubtask(taskId, title, "col-backlog", task.subtasks.length, {
      ...(description === undefined ? {} : { description }),
      ...(prompt === undefined ? {} : { prompt }),
      ...(autoStart === undefined ? {} : { autoStart })
    });
    result = { ...task, subtasks: [...task.subtasks, subtask], updatedAt: new Date().toISOString() };
    return result;
  });
  return result;
}

/** Moves a session link onto one card (idempotent, like the real store's INSERT OR IGNORE). */
function linkSessionToSubtask(taskId: string, subtaskId: string, sessionId: string) {
  let result: (typeof fixtures.tasks)[number] | undefined;
  fixtures.tasks = fixtures.tasks.map((task) => {
    if (task.taskId !== taskId) return task;
    result = {
      ...task,
      updatedAt: new Date().toISOString(),
      subtasks: task.subtasks.map((subtask: DemoRecord) => subtask.subtaskId !== subtaskId
        || (subtask["linkedSessionIds"] as string[]).includes(sessionId)
        ? subtask
        : { ...subtask, linkedSessionIds: [...(subtask["linkedSessionIds"] as string[]), sessionId] })
    };
    return result;
  });
  return result;
}

function updateSubtask(subtaskId: string, change: Record<string, unknown>) {
  let result: (typeof fixtures.tasks)[number] | undefined;
  fixtures.tasks = fixtures.tasks.map((task) => {
    if (!task.subtasks.some((subtask: DemoRecord) => subtask.subtaskId === subtaskId)) return task;
    const clean = { ...change };
    delete clean["type"];
    delete clean["subtaskId"];
    result = {
      ...task,
      updatedAt: new Date().toISOString(),
      subtasks: task.subtasks.map((subtask: DemoRecord) => subtask.subtaskId === subtaskId
        ? { ...subtask, ...clean, updatedAt: new Date().toISOString(), ...(change["verified"] === true ? { verifyUnmet: false, verifiedAt: new Date().toISOString() } : {}) }
        : subtask)
    };
    return result;
  });
  return result;
}

function deleteSubtask(subtaskId: string) {
  let result: (typeof fixtures.tasks)[number] | undefined;
  fixtures.tasks = fixtures.tasks.map((task) => {
    if (!task.subtasks.some((subtask: DemoRecord) => subtask.subtaskId === subtaskId)) return task;
    result = { ...task, subtasks: task.subtasks.filter((subtask: DemoRecord) => subtask.subtaskId !== subtaskId) };
    return result;
  });
  return result;
}

function updateDependency(taskId: string, fromId: string, toId: string, add: boolean) {
  const task = fixtures.tasks.find((item) => item.taskId === taskId);
  if (task === undefined || !task.subtasks.some((item: DemoRecord) => item.subtaskId === fromId) || !task.subtasks.some((item: DemoRecord) => item.subtaskId === toId)) return undefined;
  return updateSubtask(toId, {
    dependsOn: add
      ? [...new Set([...(task.subtasks.find((item: DemoRecord) => item.subtaskId === toId)?.dependsOn ?? []), fromId])]
      : (task.subtasks.find((item: DemoRecord) => item.subtaskId === toId)?.dependsOn ?? []).filter((id: string) => id !== fromId),
    isBlocked: add
  });
}

function moveCard(kind: "task" | "subtask", id: string, columnId: string): void {
  if (kind === "task") {
    const state = columnId === "col-review" ? "review" : columnId === "col-done" ? "done" : columnId === "col-active" ? "in-progress" : "todo";
    updateTask(id, { columnId, state });
  } else {
    updateSubtask(id, { columnId });
  }
}

function updateComment(commentId: string, status: string) {
  let result: (typeof fixtures.comments)[number] | undefined;
  fixtures.comments = fixtures.comments.map((comment) => {
    if (comment.commentId !== commentId) return comment;
    result = { ...comment, status } as (typeof fixtures.comments)[number];
    return result;
  });
  syncReviewCounts();
  return result;
}

function syncReviewCounts(): void {
  const open = fixtures.comments.filter((comment) => comment.status === "open");
  fixtures.review = {
    ...fixtures.review,
    openCommentCount: open.length,
    projects: fixtures.review.projects.map((project) => ({
      ...project,
      files: project.files.map((file) => ({
        ...file,
        commentCount: open.filter((comment) => comment.sessionId === file.sessionId && (comment.filePath === `${file.repo}:${file.path}` || comment.filePath === file.path)).length
      }))
    }))
  };
}

function updatePlan(planId: string, change: Record<string, unknown>) {
  let result: (typeof fixtures.plans)[number] | undefined;
  const clean = { ...change };
  delete clean["type"];
  delete clean["planId"];
  fixtures.plans = fixtures.plans.map((plan) => {
    if (plan.planId !== planId) return plan;
    result = { ...plan, ...clean, updatedAt: new Date().toISOString() } as (typeof fixtures.plans)[number];
    return result;
  });
  if (result !== undefined && fixtures.planStates[planId] !== undefined) fixtures.planStates[planId].plan = result;
  return result;
}

function updatePlanCounts(planId: string): void {
  const state = fixtures.planStates[planId];
  if (state === undefined) return;
  updatePlan(planId, {
    artifactCount: state.artifacts.length,
    openAnnotationCount: state.annotations.filter((item) => item.status === "open").length
  });
}

function updateAnnotation(annotationId: string, status: string) {
  for (const state of Object.values(fixtures.planStates)) {
    const existing = state.annotations.find((item) => item.annotationId === annotationId);
    if (existing === undefined) continue;
    const annotation = { ...existing, status } as typeof existing;
    state.annotations = state.annotations.map((item) => item.annotationId === annotationId ? annotation : item);
    updatePlanCounts(state.plan.planId);
    return annotation;
  }
  return undefined;
}

function renameArtifact(artifactId: string, title: string) {
  for (const state of Object.values(fixtures.planStates)) {
    const existing = state.artifacts.find((item) => item.artifactId === artifactId);
    if (existing === undefined) continue;
    const artifact = { ...existing, title };
    state.artifacts = state.artifacts.map((item) => item.artifactId === artifactId ? artifact : item);
    return artifact;
  }
  return undefined;
}

function setArtifactScripts(artifactId: string, enabled: boolean) {
  for (const state of Object.values(fixtures.planStates)) {
    const existing = state.artifacts.find((item) => item.artifactId === artifactId);
    if (existing === undefined) continue;
    const artifact = { ...existing, scriptsEnabled: enabled };
    state.artifacts = state.artifacts.map((item) => item.artifactId === artifactId ? artifact : item);
    return artifact;
  }
  return undefined;
}

function createFixtures(): DemoFixtures {
  const now = "2026-07-15T01:15:00.000Z";
  const columns = [
    { columnId: "col-backlog", name: "Backlog", category: "backlog", sortOrder: 0 },
    { columnId: "col-ready", name: "Ready", category: "pending", sortOrder: 1 },
    { columnId: "col-active", name: "In progress", category: "in-progress", sortOrder: 2 },
    { columnId: "col-review", name: "Review", category: "done", sortOrder: 3 },
    { columnId: "col-done", name: "Done", category: "done", sortOrder: 4 }
  ];
  const onboardingSubtasks = [
    { ...demoSubtask("demo-task-onboarding", "Build guided demo data", "col-active", 0), subtaskId: "demo-subtask-components", isRunning: true, linkedSessionIds: ["demo-session-build"], hasUnlandedChangeset: true },
    { ...demoSubtask("demo-task-onboarding", "Exercise every panel guide", "col-ready", 1), subtaskId: "demo-subtask-browser", isBlocked: true, dependsOn: ["demo-subtask-components"], autoStart: true },
    { ...demoSubtask("demo-task-onboarding", "Review keyboard and focus behavior", "col-review", 2), subtaskId: "demo-subtask-a11y", origin: "review", dependsOn: ["demo-subtask-components"], verifyUnmet: true, linkedSessionIds: ["demo-session-review"] }
  ];
  const tasks = [
    {
      taskId: "demo-task-onboarding",
      title: "Add guided onboarding to Drydock",
      description: "Interactive instructions, local demo data, and panel-to-panel handoffs.",
      state: "in-progress",
      columnId: "col-active",
      linkedWorkspaceSetIds: ["set-drydock"],
      linkedSessionIds: ["demo-session-build", "demo-session-review"],
      createdAt: now,
      updatedAt: now,
      lastWorkedAt: now,
      openReviewCommentCount: 2,
      faqCount: 2,
      autoAnswerFaq: true,
      clonePolicy: { workspaceSetId: "set-drydock", projectIds: ["project-drydock"], dirtyHandling: "fresh", workspaceSetProjectCount: 2 },
      subtasks: onboardingSubtasks
    },
    {
      taskId: "demo-task-auth",
      title: "Replace the token refresh path",
      description: "Move refresh handling into the shared client and cover failure recovery.",
      state: "review",
      columnId: "col-review",
      linkedWorkspaceSetIds: ["set-platform"],
      linkedSessionIds: ["demo-session-auth"],
      createdAt: now,
      updatedAt: now,
      lastWorkedAt: now,
      openReviewCommentCount: 1,
      subtasks: [
        { ...demoSubtask("demo-task-auth", "Extract token storage", "col-done", 0), subtaskId: "demo-subtask-token", doneAt: now, verifiedAt: now },
        { ...demoSubtask("demo-task-auth", "Handle expired refresh tokens", "col-review", 1), subtaskId: "demo-subtask-expired", dependsOn: ["demo-subtask-token"], linkedSessionIds: ["demo-session-auth"] }
      ]
    },
    {
      taskId: "demo-task-telemetry",
      title: "Add queue saturation telemetry",
      description: "Expose waiting work and slot pressure in the operator view.",
      state: "todo",
      columnId: "col-ready",
      linkedWorkspaceSetIds: ["set-platform"],
      linkedSessionIds: ["demo-session-telemetry"],
      createdAt: now,
      updatedAt: now,
      subtasks: [
        { ...demoSubtask("demo-task-telemetry", "Define queue metrics", "col-ready", 0), subtaskId: "demo-subtask-metrics", isQueued: true, linkedSessionIds: ["demo-session-telemetry"] },
        { ...demoSubtask("demo-task-telemetry", "Add dashboard cards", "col-backlog", 1), subtaskId: "demo-subtask-dashboard", dependsOn: ["demo-subtask-metrics"], isBlocked: true }
      ]
    }
  ];
  const rootActivity = {
    running: 1,
    failed: 0,
    root: { nodeId: "root", label: "Implementation agent", status: "running", startedAt: now, lastActivityAt: now, lastActivity: "Updating the guided tour", lastCommand: "npm test", toolUses: 12, tokens: 18_420 },
    agents: [
      { nodeId: "demo-agent-tests", parentNodeId: "root", label: "Test review", status: "running", startedAt: now, lastActivityAt: now, lastActivity: "Checking Task Board interactions", toolUses: 5, tokens: 4_200 },
      { nodeId: "demo-agent-copy", parentNodeId: "root", label: "Instruction pass", status: "completed", startedAt: now, endedAt: now, lastActivityAt: now, lastActivity: "Rewrote guide copy", toolUses: 3, tokens: 2_100 }
    ]
  };
  const sessions = [
    { sessionId: "demo-session-build", title: "Onboarding implementation", description: "Build the guide and demo-state controls.", status: "active", providerId: "codex", model: "gpt-5.5", live: true, mode: "clone", transport: "app-server", agentActivity: rootActivity, createdAt: now, updatedAt: now },
    { sessionId: "demo-session-review", title: "Accessibility review", description: "Check focus, contrast, and reduced motion.", status: "active", providerId: "codex", model: "gpt-5.4", live: false, transport: "app-server", createdAt: now, updatedAt: now },
    { sessionId: "demo-session-auth", title: "Token refresh implementation", description: "Update client refresh handling and tests.", status: "completed", providerId: "claude", model: "sonnet-4", live: false, transport: "cli", createdAt: now, updatedAt: now },
    { sessionId: "demo-session-telemetry", title: "Queue metrics design", description: "Define measurements and operator states.", status: "failed", providerId: "codex", model: "gpt-5.4", live: false, transport: "app-server", agentActivity: { running: 0, failed: 1, root: { nodeId: "root", label: "Planning agent", status: "failed", startedAt: now, endedAt: now, lastActivityAt: now, lastActivity: "Tests reported a missing fixture", toolUses: 7 } }, createdAt: now, updatedAt: now },
    { sessionId: "demo-session-orphan", title: "Dependency spike", description: "An unlinked exploratory session.", status: "idle", providerId: "codex", model: "gpt-5.4-mini", live: false, transport: "app-server", createdAt: now, updatedAt: now }
  ];
  const questions = [
    { questionId: "demo-question-scope", sessionId: "demo-session-build", question: "Should Demo mode reset each time a guide starts?", options: ["Yes, start from predictable fixtures", "Keep the previous demo changes"], status: "pending", createdAt: now },
    { questionId: "demo-question-copy", sessionId: "demo-session-review", question: "Which panel should the completed guide offer first?", options: ["Task Board", "Planner", "Agents", "Task Review"], status: "pending", createdAt: now },
    { questionId: "demo-question-verify", sessionId: "demo-session-review", question: "Manual check - I run in a container without a display, so I cannot drive the editor UI myself. Please verify in VS Code:\n1. Open the Task Board panel\n2. Press ? and choose Start guided tour\n3. Tab through every control in the first step\nDid the focus ring stay visible on each control?", options: ["Yes - focus visible throughout", "No - focus was lost on the data menu", "Blocked - the tour did not start"], status: "pending", createdAt: now }
  ];
  const workspace = {
    projects: [
      { projectId: "project-drydock", name: "drydock-demo", displayPath: "Demo workspace / drydock", kind: "git" },
      { projectId: "project-components", name: "component-library", displayPath: "Demo workspace / component-library", kind: "git" }
    ],
    workspaceSets: [
      { workspaceSetId: "set-drydock", name: "Drydock product", projectNames: ["drydock-demo", "component-library"], members: [
        { projectId: "project-drydock", name: "drydock-demo", displayPath: "Demo workspace / drydock", readOnly: false },
        { projectId: "project-components", name: "component-library", displayPath: "Demo workspace / component-library", readOnly: true }
      ] },
      { workspaceSetId: "set-platform", name: "Platform services", projectNames: ["api", "dashboard"], members: [
        { projectId: "project-api", name: "api", displayPath: "Demo workspace / api", readOnly: false },
        { projectId: "project-dashboard", name: "dashboard", displayPath: "Demo workspace / dashboard", readOnly: false }
      ] }
    ],
    accessRequests: [
      { accessRequestId: "demo-access-1", sessionId: "demo-session-build", displayPath: "Demo workspace / component-library", mode: "read-only", reason: "Inspect the shared focus-ring tokens.", status: "pending", requestedAt: now }
    ],
    security: { managed: false, label: "Demo policy · no host access", cloneOnly: true, networkedAiAllowed: false, omissionsEnabled: true }
  };
  const catalogs = [
    { providerId: "codex", displayName: "Codex / OpenAI", models: [{ id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", isDefault: true, hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }, { reasoningEffort: "xhigh", description: "Extra High" }] }, { id: "gpt-5.6-luna", displayName: "GPT-5.6-Luna", isDefault: false, hidden: false }], refreshedAt: now, source: "provider", diagnostics: ["Demo fixture catalog."] },
    { providerId: "claude", displayName: "Claude / Anthropic", models: [{ id: "claude-fable-5", displayName: "Claude Fable 5", isDefault: true, hidden: false }, { id: "claude-sonnet-5", displayName: "Claude Sonnet 5", isDefault: false, hidden: false }], refreshedAt: now, source: "cache", diagnostics: ["Demo fixture catalog (cached example)."] }
  ];
  const plans = [
    { planId: "demo-plan-onboarding", title: "Guided onboarding implementation", brief: "Add instructions that developers can follow across every Drydock surface.", aspectIds: ["ux", "accessibility", "testing"], contextRoots: ["apps/vscode-extension/webview-ui"], notes: "Use the existing VS Code visual language and keep demo effects local.", status: "active", sessionId: "demo-session-build", taskId: "demo-task-onboarding", taskTitle: "Add guided onboarding to Drydock", artifactCount: 4, openAnnotationCount: 2, updatedAt: now },
    { planId: "demo-plan-telemetry", title: "Queue saturation telemetry", brief: "Define metrics and operator states before implementation.", aspectIds: ["architecture", "operations"], contextRoots: ["packages/core", "apps/vscode-extension"], notes: "Keep metric labels stable across adapters.", status: "draft", sessionId: null, taskId: "demo-task-telemetry", taskTitle: "Add queue saturation telemetry", artifactCount: 2, openAnnotationCount: 0, updatedAt: now }
  ];
  const aspects = [
    { aspectId: "ux", label: "UX", instructions: "Describe the sequence, state changes, and recovery paths.", expectedArtifacts: ["User flow", "Interaction notes"], sortOrder: 0, archived: false, seeded: true },
    { aspectId: "accessibility", label: "Accessibility", instructions: "Cover keyboard, focus, contrast, and reduced motion.", expectedArtifacts: ["Accessibility checklist"], sortOrder: 1, archived: false, seeded: true },
    { aspectId: "testing", label: "Testing", instructions: "Specify functional and visual checks for every panel.", expectedArtifacts: ["Test plan"], sortOrder: 2, archived: false, seeded: true },
    { aspectId: "operations", label: "Operations", instructions: "Define metrics, logs, and alert behavior.", expectedArtifacts: ["Operations notes"], sortOrder: 3, archived: false, seeded: true }
  ];
  const onboardingState = {
    plan: plans[0]!,
    artifacts: [
      { artifactId: "demo-artifact-flow", relPath: "ux/guide-flow.md", kind: "document", aspectId: "ux", title: "Guide flow", revision: 3, scriptsEnabled: false, collectedAt: now, content: "# Guide flow\n\n- Start in Tasks with populated demo data\n- Mark each tab transition explicitly\n- Continue into a full editor-panel guide\n- Return to the workflow chooser when a guide ends" },
      { artifactId: "demo-artifact-proto", relPath: "ux/tour-callout.html", kind: "prototype", aspectId: "ux", title: "Tour callout prototype", revision: 1, scriptsEnabled: false, collectedAt: now, content: "<body style=\"margin:0; font-family:'Segoe UI',sans-serif; background:#1b1b1b; color:#d4d4d4; padding:28px\">\n<div style=\"max-width:360px; border:1px solid #2f81f7; border-radius:8px; background:#252526; padding:16px; box-shadow:0 8px 24px rgba(0,0,0,.4)\">\n  <div style=\"font-size:11px; letter-spacing:.12em; color:#569cd6; font-weight:600\">QUICK TOUR &middot; 3 OF 22</div>\n  <h1 style=\"font-size:16px; margin:10px 0 6px\">Review items that need a response</h1>\n  <p style=\"font-size:13px; color:#9d9d9d; margin:0 0 14px\">The attention summary counts access requests, questions, and failed chats. Expand it to answer one item at a time.</p>\n  <div style=\"display:flex; gap:8px; justify-content:flex-end\">\n    <button style=\"background:#3a3d41; color:#ccc; border:none; padding:5px 14px; border-radius:4px\">Back</button>\n    <button style=\"background:#0e639c; color:#fff; border:none; padding:5px 14px; border-radius:4px\" onclick=\"this.textContent='Clicked!'\">Next</button>\n  </div>\n</div>\n</body>" },
      { artifactId: "demo-artifact-a11y", relPath: "accessibility/checklist.md", kind: "document", aspectId: "accessibility", title: "Accessibility checklist", revision: 2, scriptsEnabled: false, collectedAt: now, content: "# Accessibility\n\n- Keep keyboard focus visible\n- Announce the active data mode\n- Respect reduced motion and forced colours\n- Keep the highlighted target operable" },
      { artifactId: "demo-artifact-tests", relPath: "testing/browser-matrix.md", kind: "document", aspectId: "testing", title: "Browser test matrix", revision: 1, scriptsEnabled: false, collectedAt: now, content: "# Browser checks\n\n- Sidebar: 16 steps\n- Task Board: populated cards and dependencies\n- Agents: grouped sessions and attention\n- Planner: landing and plan detail\n- Task Review: files, comments, and dispatch" }
    ],
    annotations: [
      { annotationId: "demo-annotation-tab", artifactId: "demo-artifact-flow", anchor: "Mark each tab transition explicitly", body: "Highlight only the destination tab before explaining its contents.", status: "open", delegatedRev: null, createdAt: now },
      { annotationId: "demo-annotation-data", artifactId: "demo-artifact-tests", anchor: "Task Board", body: "Use enough cards to make filters, movement, and dependencies visible.", status: "open", delegatedRev: null, createdAt: now }
    ],
    aspects
  };
  const telemetryState = {
    plan: plans[1]!,
    artifacts: [
      { artifactId: "demo-artifact-metrics", relPath: "operations/metrics.md", kind: "document", aspectId: "operations", title: "Queue metrics", revision: 1, scriptsEnabled: false, collectedAt: now, content: "# Metrics\n\n- waiting_work_total\n- active_slots\n- oldest_wait_seconds\n- parked_work_total" },
      { artifactId: "demo-artifact-states", relPath: "ux/operator-states.md", kind: "document", aspectId: "ux", title: "Operator states", revision: 1, scriptsEnabled: false, collectedAt: now, content: "# Operator states\n\nShow healthy, constrained, saturated, and recovering states with a direct path to waiting work." }
    ],
    annotations: [],
    aspects
  };
  const review = {
    taskId: "demo-task-onboarding",
    title: "Review · Add guided onboarding to Drydock",
    sessions: sessions.slice(0, 2).map((session) => ({ sessionId: session.sessionId, sessionTitle: session.title })),
    projects: [
      { name: "drydock-demo", files: [
        { sessionId: "demo-session-build", sessionTitle: "Onboarding implementation", baselineId: "demo-base-build", repo: "drydock-demo", path: "apps/vscode-extension/webview-ui/src/help.ts", changeKind: "modify", addedLines: 146, removedLines: 18, commentCount: 1 },
        { sessionId: "demo-session-build", sessionTitle: "Onboarding implementation", baselineId: "demo-base-build", repo: "drydock-demo", path: "apps/vscode-extension/webview-ui/src/demoMode.ts", changeKind: "add", addedLines: 420, removedLines: 0, commentCount: 1 },
        { sessionId: "demo-session-review", sessionTitle: "Accessibility review", baselineId: "demo-base-review", repo: "drydock-demo", path: "apps/vscode-extension/webview-ui/src/help.css", changeKind: "modify", addedLines: 74, removedLines: 4, commentCount: 0 }
      ] },
      { name: "component-library", files: [
        { sessionId: "demo-session-review", sessionTitle: "Accessibility review", repo: "component-library", path: "src/focus-ring.css", changeKind: "modify", addedLines: 8, removedLines: 2, commentCount: 0, clone: true }
      ] }
    ],
    openCommentCount: 2,
    notes: ["Demo file rows do not open local files. Comment and status changes remain interactive."]
  };
  const comments = [
    { commentId: "demo-comment-welcome", sessionId: "demo-session-build", filePath: "drydock-demo:apps/vscode-extension/webview-ui/src/help.ts", startLine: 214, endLine: 214, body: "Keep the first-visit invitation non-blocking and instruction-led.", author: "Reviewer", status: "open", createdAt: now },
    { commentId: "demo-comment-reset", sessionId: "demo-session-build", filePath: "drydock-demo:apps/vscode-extension/webview-ui/src/demoMode.ts", startLine: 88, endLine: 96, body: "Reset the fixture before every new guided run so the screenshots are reproducible.", author: "Reviewer", status: "open", createdAt: now },
    { commentId: "demo-comment-motion", sessionId: "demo-session-review", filePath: "drydock-demo:apps/vscode-extension/webview-ui/src/help.css", startLine: 412, endLine: 420, body: "Reduced-motion mode should remove the callout transition.", author: "Reviewer", status: "resolved", createdAt: now }
  ];
  return {
    now,
    columns,
    tasks,
    sessions,
    questions,
    workspace,
    catalogs,
    plans,
    aspects,
    planStates: { "demo-plan-onboarding": onboardingState, "demo-plan-telemetry": telemetryState },
    review,
    comments,
    landing: [
      { taskId: "demo-task-onboarding", taskTitle: "Add guided onboarding to Drydock", subtaskId: "demo-subtask-components", subtaskTitle: "Build guided demo data", sessionId: "demo-session-build", repos: [{ repoName: "drydock-demo", fileCount: 9 }, { repoName: "component-library", fileCount: 2 }], capturedAt: now, overlapsWith: [] },
      { taskId: "demo-task-auth", taskTitle: "Replace the token refresh path", subtaskId: "demo-subtask-expired", subtaskTitle: "Handle expired refresh tokens", sessionId: "demo-session-auth", repos: [{ repoName: "api", fileCount: 6 }], capturedAt: now, overlapsWith: ["demo-session-build"] }
    ],
    timelines: {
      "demo-session-build": [
        { sequence: 1, eventType: "user.message", createdAt: now, summary: "Add a local Demo mode for the guided tour." },
        { sequence: 2, eventType: "agent.text", createdAt: now, summary: "I will keep demo requests inside the webview and leave navigation as the only host action.", final: true },
        { sequence: 3, eventType: "agent.file_edit", createdAt: now, summary: "Updated the shared guide controller.", filePath: "apps/vscode-extension/webview-ui/src/help.ts", fileChangeKind: "modify" },
        { sequence: 4, eventType: "agent.command", createdAt: now, summary: "npm test completed", commandName: "npm", toolStatus: "completed" }
      ],
      "demo-session-review": [
        { sequence: 1, eventType: "user.message", createdAt: now, summary: "Review the tour for keyboard and screen-reader behavior." },
        { sequence: 2, eventType: "agent.text", createdAt: now, summary: "The mode switch remains keyboard reachable inside the tour callout.", final: true },
        { sequence: 3, eventType: "agent.command", createdAt: now, summary: "axe-core static scan completed", commandName: "npx", toolStatus: "completed" },
        { sequence: 4, eventType: "agent.text", createdAt: now, summary: "Static checks pass, but I cannot reach the editor UI from this container, so one check needs your hands.\n\n1. Open the Task Board panel\n2. Press `?` and choose **Start guided tour**\n3. Tab through every control in the first step\n\nAnswer the open question with the result and I will either fix the focus order or stamp the subtask verified.", final: true }
      ]
    },
    diff: [
      { baselineId: "demo-base-build", rootName: "drydock-demo", path: "apps/vscode-extension/webview-ui/src/help.ts", changeKind: "modify", addedLines: 146, removedLines: 18, revertSupported: false, reason: "Demo data" },
      { baselineId: "demo-base-build", rootName: "drydock-demo", path: "apps/vscode-extension/webview-ui/src/demoMode.ts", changeKind: "add", addedLines: 420, removedLines: 0, revertSupported: false, reason: "Demo data" }
    ],
    cloneRepos: [{ name: "drydock-demo", branch: "drydock/demo-guide", files: [{ path: "apps/vscode-extension/webview-ui/src/help.ts", changeKind: "modify", addedLines: 146, removedLines: 18 }] }],
    runtimes: [{ runtimeId: "demo-runtime", externalName: "drydock-demo-onboarding", status: "running (demo)", startedAt: now, agentRole: "implementation" }],
    runtimeStats: [{ runtimeId: "demo-runtime", available: true, cpuPercent: 12.4, memBytes: 356_515_840, ioReadBytesPerSec: 24_576, ioWriteBytesPerSec: 8_192, loadAvg1: 0.42, threads: 18 }],
    recipes: [{ recipeId: "demo-recipe-feature", name: "Feature implementation", description: "Plan, implement, verify, and review a contained feature.", source: "seeded", archived: false, createdAt: now, updatedAt: now, subtasks: [{ title: "Confirm the change boundary", description: "Identify affected projects and tests.", prompt: "Confirm the requested change boundary.", autoStart: false, verify: false }, { title: "Implement and verify", description: "Make the change and run the relevant checks.", prompt: "Implement the change and run its checks.", autoStart: false, verify: true }] }],
    faqs: {
      "demo-task-onboarding": [
        { faqId: "demo-faq-files", taskId: "demo-task-onboarding", pattern: "Can Demo mode open files?", answer: "No. Demo mode keeps file, AI, and runtime actions disconnected.", createdAt: now },
        { faqId: "demo-faq-reset", taskId: "demo-task-onboarding", pattern: "How do I restore the sample data?", answer: "Use Reset demo in the Demo data banner.", createdAt: now }
      ]
    }
  };
}
