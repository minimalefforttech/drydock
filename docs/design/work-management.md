# Work Management, Workspaces, Tasks, And Day Planning

## Purpose

The extension must not treat the current VS Code workspace as the source of truth. Users will switch project sets, isolate task changes in different workspaces, and keep tasks that may or may not exist in Jira, Asana, GitHub, or another provider.

Product state lives in configured state stores. VS Code workspace folders are only the active projection of a selected workspace set.

## Core Concepts

- `Project`: a repository or folder that can be mounted, cloned, indexed, or activated.
- `WorkspaceSet`: a named set of projects used together for a body of work. This is product-owned and not the same thing as a VS Code `.code-workspace` file.
- `WorkspaceProjection`: the currently active VS Code folders derived from a workspace set.
- `Task`: work item from the internal task tracker or an external provider.
- `Subtask`: a scoped child work item. Review-origin work uses
  `origin: "review"`; there is no separate mini-task record type. See
  `task-board-and-subtasks.md`.
- `TaskWorkspaceLink`: relation between a task and one or more workspace sets or projects.
- `TaskWorkSession`: a durable record that a task was worked on in a workspace set during a time range.
- `DayPlan`: a dated plan that schedules tasks, multi-day spans, notes, pushes, and interruptions.

## Configuration

Config declares one or more state paths. At least one local writable primary store is required.

```json
{
  "stateStores": [
    {
      "id": "personal",
      "path": "~/.drydock/state",
      "role": "primary",
      "scope": "personal",
      "writable": true
    },
    {
      "id": "team",
      "path": "D:/team/drydock-shared",
      "role": "shared",
      "scope": "team",
      "writable": false
    }
  ],
  "artifactStores": [
    {
      "id": "artifacts",
      "path": "~/.drydock/artifacts",
      "writable": true
    }
  ],
  "sharedPaths": [
    {
      "id": "studio-python",
      "path": "D:/studio/python-packages",
      "access": "read-only",
      "purpose": "studio-python-packages",
      "overridable": true
    },
    {
      "id": "shared-libs",
      "path": "D:/studio/shared-libs",
      "access": "read-write",
      "purpose": "approved-shared-libraries",
      "overridable": true
    }
  ],
  "logging": {
    "defaultMode": "redacted",
    "expandedLogging": false,
    "expandedMetrics": false,
    "retentionClass": "standard",
    "piiPolicy": "redact"
  },
  "packaging": {
    "channel": "vsix",
    "incrementVersionOnPackage": true,
    "publishToMarketplace": false
  },
  "sourceControl": {
    "allowDeveloperBranches": true,
    "crossBoundaryBranchPrefix": "agent-transfer/"
  },
  "naming": {
    "displayNameRef": "product.displayName",
    "avoidHardcodedProductName": true
  },
  "defaultTaskProvider": "internal"
}
```

Store rules:

- The primary local store contains the authoritative internal task registry, workspace catalog, work sessions, day plans, event metadata, and provider sync cursors.
- Shared stores can contribute project catalogs, workspace templates, memory, and task references, but local traceability must still work offline.
- Raw secrets are never stored in state paths. Store secret references only.
- Agents do not receive state-store mounts by default.
- A state path can be moved or swapped without losing task identity if the store ID and database IDs remain stable.
- State stores are backed by SQLite plus file artifacts unless a provider declares another storage adapter.
- Shared path config applies by default unless a workspace set, task, or runtime template overrides it. Shared read paths are read-only, and shared write paths are writable only when explicitly configured.
- Logging is redacted by default. Expanded logs or metrics are opt-in config because prompts, tickets, paths, and tool output may contain PII.
- Packaging is VSIX-only for now, and every installable VSIX increments the extension version.
- Product naming should be referenced from a small config surface so a later rename does not require broad code or docs churn.
- Developer-selected branches are allowed for local work; Git refs used to send code or patches across a network boundary use generated temporary branch names.

## Workspace Sets

Users can create workspace sets that contain a curated group of projects.

```ts
interface WorkspaceSet {
  id: WorkspaceSetId;
  name: string;
  description?: string;
  projectIds: ProjectId[];
  defaultMode: "plan" | "implementation" | "clone";
  tags: string[];
  createdAt: string;
  updatedAt: string;
}
```

Workspace rules:

- Workspace sets may include multiple unrelated folders and repositories.
- Workspace sets can overlap. The same project can belong to many workspace sets.
- Activating a workspace set updates the VS Code projection and runtime mount policy.
- Switching workspace sets checkpoints active task diffs, records work-session time, and restarts only runtimes whose mount policy changed.
- Workspace root mount access follows the active agent role and session mode.
- Clone mode workspaces use disposable clones/worktrees and never mount live project roots.

## Task And Workspace Interaction

Tasks are separate from workspace sets. A task can relate to one or more workspace sets and one or more projects.

Chats belong to tasks in the primary UI. A task can link one or more chat
sessions, and each linked chat inherits task context such as workspace set,
notes, changed files, questions, plans, and work-session provenance.
Unlinked chats are allowed only as transitional cleanup state; they should be
linked to a task or deleted before they become durable work records.

```ts
interface TaskWorkspaceLink {
  taskId: TaskId;
  workspaceSetId?: WorkspaceSetId;
  projectId?: ProjectId;
  reason: "primary" | "secondary" | "related" | "historical" | "suspected-impact";
  createdAt: string;
}
```

When a user works on a task:

1. Select or create the task in the internal provider or an external synced provider.
2. Select one or more workspace sets or projects for the task.
3. Activate the task in a workspace set.
4. The extension applies the VS Code workspace projection.
5. The orchestrator starts runtimes with mount policies derived from the active task, workspace set, and mode.
6. The diff service creates or restores per-task/per-workspace baselines.
7. Work sessions record start, stop, workspace switches, runtime generations, file changes, plans, subtasks, tests, notes, and last-worked timestamps.

Review-driven subtasks:

- A review-origin subtask belongs to a parent task and links back to one or
  more review threads.
- Review-origin subtasks are used for scoped follow-up work, such as "apply
  this review comment across similar files" or "update docs to reflect this
  new expectation."
- They inherit the workspace set, review scope, and runtime policy of the
  parent work unless explicitly narrowed.
- Resolving one updates the linked review threads and parent task activity.

Task update fields:

- `updatedAt`: any task metadata changed.
- `lastWorkedAt`: user or agent performed work against the task.
- `lastWorkspaceSetId`: most recent workspace set used for the task.
- `lastRunId`: most recent agent run linked to the task.
- `lastDiffCheckpointId`: most recent diff checkpoint linked to the task.

## Task Work Sessions

`TaskWorkSession` records when a task was worked on and where the work happened.

```ts
interface TaskWorkSession {
  id: TaskWorkSessionId;
  taskId: TaskId;
  workspaceSetId: WorkspaceSetId;
  projectIds: ProjectId[];
  mode: "plan" | "implementation" | "clone";
  startedAt: string;
  endedAt?: string;
  lastActivityAt: string;
  runtimeGenerationIds: RuntimeGenerationId[];
  runIds: RunId[];
  diffCheckpointIds: string[];
  planIds: PlanId[];
  reviewThreadIds: string[];
  subtaskIds: SubtaskId[];
  testRunIds: string[];
  noteIds: string[];
}
```

Work-session rules:

- Starting, resuming, switching, pausing, or stopping task work writes a session event.
- Agent activity updates `lastActivityAt` and the task's `lastWorkedAt`.
- Review comments, subtask delegation, and review-thread resolution update
  `lastActivityAt` and keep provenance on the work session.
- Human notes update `updatedAt`; notes attached to actual work update `lastWorkedAt` too.
- Switching workspace sets closes or pauses the active work session and opens a new one for the same task.
- A task can have concurrent work sessions only if each session has a distinct workspace set or clone workspace.

## Workspace Switching

Workspace switching must be a backend operation, not a UI-only folder change.

For the common case — replacing or appending a target's folders into the current window — activation applies live via `vscode.workspace.updateWorkspaceFolders`, adding and removing folders in place without a reload. A reload is only needed when the switch crosses the 1-root/many-root boundary in an untitled (no `.code-workspace` file) window; that case writes a temporary `.code-workspace` and opens it, optionally in a new window, so the current window's sessions keep running.

The fuller checkpoint flow below is the fallback path for switches that also change runtime mount policy (a different workspace set, not just a folder add/remove within the current one):

1. Pause new agent prompts for the affected task.
2. Snapshot current diffs and serialize per-file baselines.
3. Record a work-session event with `fromWorkspaceSetId` and `toWorkspaceSetId`.
4. Stop or restart runtimes whose mounts are no longer valid.
5. Apply the new VS Code workspace projection.
6. Start or rebind runtimes for the new workspace set.
7. Restore task context, plan links, memory refs, and relevant diff checkpoints.
8. Resume allowed agents or ask for confirmation if conflicts exist.

Sibling tasks and unrelated agents are not interrupted unless they share a runtime or mount policy that changed.

## Day Planner

The day planner is a local planning layer over tasks. It is not a replacement for Jira, Asana, or GitHub scheduling fields.

```ts
interface DayPlan {
  id: DayPlanId;
  date: string;
  timezone: string;
  items: DayPlanItem[];
  notes: DayNote[];
  createdAt: string;
  updatedAt: string;
}

interface DayPlanItem {
  id: DayPlanItemId;
  taskId?: TaskId;
  title: string;
  startDate: string;
  endDate: string;
  allocation: "focus" | "review" | "meeting" | "admin" | "blocked" | "buffer";
  status: "planned" | "active" | "done" | "pushed" | "cancelled";
  pushedFrom?: string;
  pushedTo?: string;
  pushReason?: string;
  noteIds: string[];
}
```

Planner rules:

- Tasks can be mapped to a day or a multi-day span.
- Pushing a task creates a push record instead of overwriting history.
- Day notes can attach to a date, task, workspace set, or work session.
- Notes should capture unexpected load such as meetings, incidents, support, waiting on review, or other interruptions.
- Planner changes update task metadata only when the task schedule or work state changes, not when a private day note changes.
- External calendar integration is a future provider, not part of the core Stage 0 gate.

## Stage 0 Validation Additions

Stage 0 must validate:

- `docs/design/work-management.md` exists and describes state stores, workspace sets, task-workspace links, work sessions, workspace switching, and day planning.
- `schemas/work-management.schema.json` parses as JSON.
- `schemas/examples/work-management-config.json` declares one or more state stores with a writable primary store, configured shared paths, redacted logging defaults, VSIX-only packaging, and source-control branch policy.
- Example workspace sets contain multiple projects.
- Example tasks link to multiple workspace sets or projects.
- Example task work sessions record `startedAt`, `lastActivityAt`, and task/workspace IDs.
- Example task work sessions can link review thread IDs and subtask IDs when
  review-driven work is represented.
- Example day plans include multi-day task mapping, a pushed task, and notes for unexpected interruptions.
- No state-store config stores raw secrets.
- Expanded logging or metrics must be explicitly enabled and must declare retention and PII handling.

## References

- SQLite WAL: <https://www.sqlite.org/wal.html>
- SQLite transactions: <https://www.sqlite.org/lang_transaction.html>
- VS Code workspace API: <https://code.visualstudio.com/api/references/vscode-api#workspace>
- VS Code multi-root workspaces: <https://code.visualstudio.com/docs/editor/multi-root-workspaces>

