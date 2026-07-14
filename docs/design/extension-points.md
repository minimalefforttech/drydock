# Extension Points And Task Integration Plan

## Purpose

The original product scope includes more than isolated code execution. It needs a task-aware engineering control plane with replaceable providers for task systems, AI agents, runtimes, memory, testing, and panels.

This document fills the Stage 0 gap: all pluggable systems must be schema-bound before implementation begins. Core product state must use canonical schemas, while Jira, Asana, GitHub, Claude, Codex, custom agents, custom task stores, and custom UI panels map into those schemas through adapters.

## Missing Product Areas From The Original Scope

These areas need explicit planning and validation beyond code execution:

- Internal task tracking as the required/default task system, not just code diffs or external issue links.
- External task provider adapters for Jira, Asana, GitHub Issues, and custom systems.
- Project activation from tasks, including multiple workspace folders and related-project history.
- Product-owned workspace sets that can be switched independently of the current VS Code workspace.
- Task work sessions that record when a task was worked on, in which workspace set, and with which runtime/diff/test artifacts.
- A day planner for mapping tasks to days, pushing tasks, tracking multi-day work, and recording notes for unexpected interruptions.
- Prompt history, run history, plans, changed files, tests, and memory linked
  back to tasks.
- Schema-bound extension points for task providers, agent providers, runtime adapters, panel providers, memory providers, and test providers.
- Provider auth, token references, OAuth/API-token configuration, and no raw secret persistence.
- Model profile declarations for role suitability, cost class, context budget, network needs, auth refs, and output schemas.
- Provider sync, webhook/polling events, conflict resolution, rate limits, retries, and offline cache behavior.
- Custom panels that extend the visual control surface without bypassing backend security.
- Custom AI agents that emit the same normalized event model as Codex.
- Versioned manifests so the extension can reject incompatible adapters early.

## Canonical Task Model

Every task provider maps provider-specific objects into `TaskRecord`.

```ts
interface TaskRecord {
  id: TaskId;
  providerId: ProviderId;
  externalId?: string;
  externalUrl?: string;
  title: string;
  description?: string;
  status: string;
  statusCategory: "backlog" | "ready" | "active" | "blocked" | "review" | "done" | "cancelled";
  priority?: string;
  assigneeRefs: string[];
  projectRefs: ProjectRef[];
  folderAllocations: FolderAllocation[];
  workspaceRootIds: WorkspaceRootId[];
  relatedTaskIds: TaskId[];
  promptHistoryRefs: string[];
  runIds: RunId[];
  planIds: PlanId[];
  changedFileRefs: string[];
  testRunIds: string[];
  memoryRefs: string[];
  labels: string[];
  updatedAt: string;
  syncState: "local-only" | "synced" | "dirty" | "conflicted" | "remote-deleted";
}
```

Task rules:

- The internal task registry is the source of truth for local traceability.
- External systems own their remote fields, but they do not own local run history, sandbox history, or file diff baselines.
- Task activation can bring multiple project folders into the workspace policy.
- Tasks can link to one or more product-owned workspace sets; VS Code's current workspace is only the active projection.
- Task work sessions track `lastWorkedAt`, workspace switches, run IDs, diff checkpoints, and notes.
- Day planning is local-first and can schedule tasks across days without requiring an external task provider.
- Related tasks are detected by shared workspace roots, project refs, changed file paths, linked external issue keys, and prompt history.
- Prompt history and agent decisions are local artifacts unless explicitly exported.

## Task Provider API

All task integrations implement `TaskProvider`.

```ts
interface TaskProvider {
  providerId: ProviderId;
  detect(): Promise<ProviderDetectionResult>;
  validateAuth(context: ProviderAuthContext): Promise<AuthValidationResult>;
  discoverProjects(request: ProjectDiscoveryRequest): Promise<ProjectRef[]>;
  listTasks(request: TaskListRequest): Promise<TaskRecord[]>;
  getTask(ref: ExternalTaskRef): Promise<TaskRecord>;
  createTask(request: TaskCreateRequest): Promise<TaskRecord>;
  updateTask(taskId: TaskId, patch: TaskPatch): Promise<TaskRecord>;
  commentTask(taskId: TaskId, comment: TaskComment): Promise<TaskCommentResult>;
  transitionTask(taskId: TaskId, transition: TaskTransition): Promise<TaskRecord>;
  attachArtifact(taskId: TaskId, artifact: TaskArtifactRef): Promise<void>;
  syncEvents(cursor?: SyncCursor): AsyncIterable<TaskProviderEvent>;
  mapToCanonicalTask(input: unknown): Promise<TaskRecord>;
}
```

Provider events must normalize:

- Remote task created, updated, deleted, assigned, labeled, commented, transitioned, linked, or unlinked.
- Local task activated, deactivated, associated with a folder, linked to a run,
  linked to a plan, linked to a memory item, or linked to a changed file.
- Sync conflict detected, resolved locally, resolved remotely, or left blocked for user decision.

## Required Task Providers

### InternalTaskProvider

The internal provider is required first and remains available even when no external task system is configured. It stores local tasks, project allocations, prompt history refs, run refs, plan refs, changed-file refs, memory refs, test refs, and related-task edges in the local event store.

The internal provider is the canonical local task system. Jira, Asana, GitHub, and custom task providers sync into and out of this model; they do not replace local traceability.

Validation:

- Create tasks with multiple project folders.
- Activate/deactivate tasks and update workspace policy input.
- Link prompts, plans, runs, changed files, memory, automated tests, and HITL
  requests.
- Detect related tasks by shared folder and changed file refs.
- Work without network, credentials, or external APIs.

### JiraTaskProvider

Jira support maps Jira issues, projects, statuses, transitions, comments, links, and webhooks into the canonical task model. It must use Atlassian's Jira Cloud REST APIs, including issue and search endpoints, comments, transitions, and webhook capabilities.

Validation:

- Static schema mapping from Jira issue JSON to `TaskRecord`.
- Credentialed live probe only when `PREVALIDATE_JIRA_BASE_URL`, `PREVALIDATE_JIRA_EMAIL`, and `PREVALIDATE_JIRA_API_TOKEN` or an OAuth secret ref are configured.
- Live probe should validate auth, project discovery, issue read, issue search, comments, transitions discovery, and webhook or polling capability.
- No live Jira mutation runs unless a dedicated test project/key is configured.

### AsanaTaskProvider

Asana support maps workspaces, projects, tasks, sections, task stories/comments, custom fields, and webhooks into the canonical task model.

Validation:

- Static schema mapping from Asana task JSON to `TaskRecord`.
- Credentialed live probe only when `PREVALIDATE_ASANA_TOKEN` and a workspace or project GID are configured.
- Live probe should validate auth, workspace/project discovery, task read, task search/list, stories/comments, and webhook or polling capability.
- Mutation probes require an explicit test project GID.

### GitHubIssuesTaskProvider

GitHub support maps repositories, issues, labels, assignees, milestones, comments, issue links, pull requests, and webhooks into the canonical task model.

Validation:

- Static schema mapping from GitHub issue JSON to `TaskRecord`.
- Credentialed live probe only when `PREVALIDATE_GITHUB_TOKEN` and `PREVALIDATE_GITHUB_REPO` are configured.
- Live probe should validate repo access, issue list/read, comments, labels, and webhook or polling capability.
- Mutation probes require a dedicated test repository or issue label.

### CustomTaskProvider

Custom task systems can be local SQLite, local files, HTTP APIs, or enterprise connectors.

Validation:

- Provider manifests must declare schema version, operations, auth mode, rate-limit behavior, sync mode, and canonical mapping.
- HTTP providers must declare OpenAPI or JSON Schema refs for request and response payloads.
- Local providers must declare storage path policy and backup/export behavior.

## Schema-Bound Extension Manifest

All pluggable systems use a manifest validated against `schemas/extension-manifest.schema.json`.

```ts
interface ExtensionManifest {
  schemaVersion: "drydock.extension.v1";
  id: string;
  displayName: string;
  version: string;
  kind:
    | "task-provider"
    | "agent-provider"
    | "runtime-adapter"
    | "panel-provider"
    | "memory-provider"
    | "test-provider"
    | "multi-provider";
  extensionPoints: ExtensionPointContribution[];
  auth?: ExtensionAuthDeclaration;
  capabilities: Record<string, unknown>;
  api?: ExtensionApiDeclaration;
}
```

Supported extension points:

- `task-provider`: imports, syncs, creates, comments, transitions, and links tasks.
- `agent-provider`: starts AI sessions and emits normalized agent events.
- `runtime-adapter`: creates isolated runtimes and reports lifecycle/cleanup state.
- `panel-provider`: contributes visual panels using declared message schemas.
- `memory-provider`: proposes, stores, searches, and exports reviewed memory records.
- `test-provider`: runs automated tests or HITL verification workflows.
- `diff-provider`: optional future provider for non-filesystem diff sources.
- `plan-provider`: optional future provider for external planning systems.

Rules:

- Extension manifests are data, not executable code.
- Executable provider code must be loaded only from trusted extension packages and must still operate through the product service APIs.
- Manifests cannot request host command execution by agents.
- Manifests cannot declare raw secret values.
- All provider events are normalized before they reach panels.
- Panel providers can request views, commands, and event subscriptions, but cannot directly access secrets, runtime processes, or host filesystem paths.

## Agent Provider Extension Point

Custom AI agents must implement the same normalized event model as Codex.

Required capabilities:

- Auth validation.
- Session start/stop.
- Prompt send.
- Event stream.
- Cancellation.
- Model profile declaration for supported roles and context budgets.
- File event reporting or snapshot compatibility.
- Tool/command event reporting.
- Error reporting.

Optional capabilities:

- Native subagents.
- Plan comments.
- Token usage.
- Structured tool schemas.
- MCP support.
- Literal ACP support.

Validation:

- Static manifest validation.
- Mock event stream round-trip with text, command, file create, file modify, file delete, error, cancellation, and completion events.
- Model profile validation for role suitability, cost class, network requirement, auth refs, and output schema support.
- Optional live provider probe only when provider credentials and command paths are configured.

## Runtime Adapter Extension Point

Runtime adapters must expose lifecycle and cleanup APIs equivalent to Docker Sandbox and Docker fallback adapters.

Required capabilities:

- Create runtime.
- Execute command inside runtime.
- Mount read-only and read-write paths.
- Stop runtime.
- Force remove runtime.
- List/reconcile runtimes.
- Report cleanup state.
- Preserve auth refs across restart.

Validation:

- Static manifest validation.
- Mock lifecycle with start count, stop count, force cleanup count, quarantine, and reset-required state.
- Optional live probe only when the adapter is explicitly enabled.

## Panel Provider Extension Point

Panel providers can extend the UI after the backend event and command schemas are stable.

Panel declarations include:

- Panel ID, title, icon, and placement.
- Message schema from panel to extension.
- Event subscriptions from extension to panel.
- Allowed commands.
- Required feature flags.

Validation:

- Panel message schema round-trip.
- Command authorization checks.
- No direct secret or filesystem access.
- Rendering implementation deferred until VS Code stages.

## Memory And Test Provider Extension Points

Memory providers must only store reviewed memory records unless explicitly configured as a private local draft store.

Test providers must normalize:

- Automated command results.
- Test artifacts.
- Browser/manual/HITL instructions.
- Expected choices.
- Freeform notes.
- Verification status.

Validation:

- Reviewed memory candidate approval/rejection round-trip.
- Automated test result round-trip.
- HITL request/result round-trip.
- Provider manifests checked for declared artifact storage policy.

## Stage 0 Validation Additions

Stage 0 must validate:

- `docs/extension-points.md` exists and names the missing non-code product areas.
- `docs/work-management.md` exists and defines state stores, workspace sets, task work sessions, workspace switching, and the day planner.
- Extension manifest schemas parse as JSON.
- Example manifests for internal, Jira, Asana, GitHub, and custom multi-provider extensions conform to required manifest fields.
- The internal task provider is present, default, local/offline capable, and requires no auth.
- Work-management schema examples prove one or more state paths, an offline default task provider, multiple workspace sets, task/workspace links, work-session timestamps, and day planner pushes/notes.
- Task provider examples declare required operations and map to `TaskRecord`.
- Agent, runtime, panel, memory, and test extension points are represented.
- No example manifest stores raw credentials.
- Optional live external API probes are gated by environment variables and skipped cleanly when credentials are absent.

## Credentialed Live Probe Policy

External APIs are not required for a clean Stage 0 gate unless credentials are configured. When credentials exist, probes must be read-only by default.

Suggested environment variables:

- Jira: `PREVALIDATE_JIRA_BASE_URL`, `PREVALIDATE_JIRA_EMAIL`, `PREVALIDATE_JIRA_API_TOKEN`, optional `PREVALIDATE_JIRA_TEST_PROJECT_KEY`
- Asana: `PREVALIDATE_ASANA_TOKEN`, optional `PREVALIDATE_ASANA_WORKSPACE_GID`, optional `PREVALIDATE_ASANA_TEST_PROJECT_GID`
- GitHub: `PREVALIDATE_GITHUB_TOKEN`, optional `PREVALIDATE_GITHUB_REPO`, optional `PREVALIDATE_GITHUB_TEST_LABEL`

Mutation probes require explicit test target variables and must create reversible test data.

## References

- JSON Schema: <https://json-schema.org/>
- OpenAPI Specification: <https://spec.openapis.org/oas/latest.html>
- Jira Cloud REST API v3: <https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/>
- Jira issues API: <https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/>
- Jira webhooks: <https://developer.atlassian.com/cloud/jira/platform/webhooks/>
- Asana REST API reference: <https://developers.asana.com/reference/rest-api-reference>
- Asana tasks API: <https://developers.asana.com/reference/tasks>
- Asana projects API: <https://developers.asana.com/reference/projects>
- Asana webhooks API: <https://developers.asana.com/reference/webhooks>
- GitHub Issues REST API: <https://docs.github.com/en/rest/issues/issues>
- GitHub issue comments API: <https://docs.github.com/en/rest/issues/comments>
- GitHub webhooks: <https://docs.github.com/en/webhooks>
- VS Code Extension API: <https://code.visualstudio.com/api/references/vscode-api>
- VS Code Webview API: <https://code.visualstudio.com/api/extension-guides/webview>

