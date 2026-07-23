# Implementation API Reference

> Design-reference status: this began as the Stage 0 contract and retains
> forward-looking provider shapes. Current ADRs and exported TypeScript
> interfaces under `packages/contracts` are authoritative for implemented
> behavior and exact wire/storage fields.

## Purpose

This document records the intended product-facing service boundaries, durable
state, command surfaces, lifecycle rules, and cleanup model.

The extension treats runtime isolation, auth continuity, diff preservation,
task traceability, and cleanup accounting as backend capabilities before UI
depends on them. Names here are architectural vocabulary, not a substitute for
the implemented TypeScript contracts.

## Source Alignment

The runtime and agent APIs are aligned with these public specifications and vendor references:

- Docker Sandboxes and `sbx`: [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/), [Docker `sbx` CLI reference](https://docs.docker.com/reference/cli/sbx/), [Docker `sbx reset`](https://docs.docker.com/reference/cli/sbx/reset/)
- Docker fallback: [Docker CLI reference](https://docs.docker.com/reference/cli/docker/)
- Agent Client Protocol: [ACP introduction](https://agentclientprotocol.com/get-started/introduction), [ACP v1 schema](https://agentclientprotocol.com/protocol/v1/schema)
- Codex: [Codex app server](https://developers.openai.com/codex/app-server/), [Codex CLI reference](https://developers.openai.com/codex/cli/reference/), [Codex authentication](https://developers.openai.com/codex/auth/), [Codex sandboxing](https://developers.openai.com/codex/concepts/sandboxing/), [Codex subagents](https://developers.openai.com/codex/subagents/)
- Claude Code: [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-reference)
- Git clone mode: [git-worktree](https://git-scm.com/docs/git-worktree), [git-diff](https://git-scm.com/docs/git-diff), [git-apply](https://git-scm.com/docs/git-apply)
- VS Code: [VS Code API](https://code.visualstudio.com/api/references/vscode-api), [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview), [VS Code Tree View API](https://code.visualstudio.com/api/extension-guides/tree-view)
- Storage: [SQLite WAL](https://www.sqlite.org/wal.html), [SQLite transactions](https://www.sqlite.org/lang_transaction.html)

## Identity Types

All persistent records use opaque string IDs. IDs must be stable across process restarts and must not expose absolute host paths or secrets.

```ts
type RuntimeId = string;
type RuntimeGenerationId = string;
type SessionId = string;
type ChatId = string;
type RunId = string;
type AgentId = string;
type AgentRole = "researcher" | "planner" | "worker" | "tester" | "reviewer" | "memory-extractor";
type TaskId = string;
type ProviderId = "codex" | "claude" | "generic-acp" | string;
type ModelProfileId = string;
type SecurityEvaluationId = string;
type DocumentId = string;
type ReviewSessionId = string;
type ReviewThreadId = string;
type ReviewCommentId = string;
type SubtaskId = string;
type SecretRef = string;
type StateStoreId = string;
type ProjectId = string;
type WorkspaceSetId = string;
type WorkspaceRootId = string;
type MountId = string;
type PlanId = string;
type TaskWorkSessionId = string;
type DayPlanId = string;
type DayPlanItemId = string;
```

## Runtime Registry

`RuntimeRegistry` stores runtime templates that can be selected per chat/session.

```ts
interface RuntimeTemplate {
  id: string;
  name?: string;
  type: "docker-sandbox" | "docker" | "wsl" | "custom";
  image?: string;
  cpuLimit?: number;
  memoryMb?: number;
  network: "disabled" | "allowed" | "future-remote-only";
  mounts: MountPolicy[];
  environment: Record<string, string>;
  adapterProviderIds: ProviderId[];
  advancedOptions: Record<string, unknown>;
}
```

Rules:

- Docker Sandbox is the first required runtime for real product execution.
- Docker is a hardened local fallback only when Docker Sandbox is unavailable.
- WSL is recorded as an optional capability for later stages.
- Custom adapters are extension-provided and cannot bypass mount, auth, event, or cleanup policies.

## Runtime Inventory

`RuntimeInventory` is the authoritative ledger of every sandbox/container/runtime the extension starts or adopts. This service exists specifically so the product can answer "how many runtimes did we start?" and "what cleanup state are they in?"

```ts
interface RuntimeInventoryRecord {
  runtimeId: RuntimeId;
  runtimeGenerationId: RuntimeGenerationId;
  sessionId: SessionId;
  chatId: ChatId;
  agentId?: AgentId;
  agentRole?: AgentRole;
  templateId: string;
  adapter: "docker-sandbox" | "docker" | "wsl" | "custom";
  externalName: string;
  externalId?: string;
  workspaceOwnerToken?: string;
  status:
    | "starting"
    | "running"
    | "stopping"
    | "stopped"
    | "removing"
    | "removed"
    | "quarantined"
    | "reset-required"
    | "lost";
  startedAt: string;
  stoppedAt?: string;
  removedAt?: string;
  lastSeenAt?: string;
  lastCleanupAttemptAt?: string;
  cleanupFailureCount: number;
  metadata: Record<string, unknown>;
}

interface RuntimeInventoryCounters {
  runtimeStartsTotal: number;
  runtimeStopsTotal: number;
  runtimeRemoveAttemptsTotal: number;
  runtimeRemoveFailuresTotal: number;
  runtimeForceCleanupTotal: number;
  runtimeQuarantinedTotal: number;
  runtimeResetRequiredTotal: number;
  activeCount: number;
  stoppedCount: number;
  orphanedCount: number;
  failedCleanupCount: number;
  byAdapter: Record<string, RuntimeInventoryAdapterCounters>;
  byAgentRole: Record<string, RuntimeInventoryRoleCounters>;
  lastReconciledAt?: string;
}
```

Inventory rules:

- A runtime must be recorded before its external create command is executed.
- Runtime names must include a product prefix, session ID fragment, generation ID fragment, and role fragment.
- Reconciliation compares database inventory to external sources such as `sbx ls` and `docker ps -a`.
- Orphan categories are `external-only`, `db-only`, `missing-workspace`, `stale-stopped`, and `name-collision`.
- Cleanup must never delete workspace files unless the path is a product-owned temporary workspace and the ownership token matches.

## Runtime Cleanup Service

`RuntimeCleanupService` owns graceful cleanup, forced cleanup, orphan reconciliation, quarantine, and destructive reset escalation.

```ts
interface RuntimeCleanupService {
  reconcileInventory(): Promise<RuntimeInventoryReconcileResult>;
  cleanupRuntime(runtimeId: RuntimeId, mode: CleanupMode): Promise<CleanupResult>;
  cleanupSession(sessionId: SessionId, options: CleanupSessionOptions): Promise<CleanupResult[]>;
  forceCleanup(filter: CleanupFilter, policy: ForceCleanupPolicy): Promise<ForceCleanupResult>;
  quarantineRuntime(runtimeId: RuntimeId, reason: string): Promise<void>;
  getCounters(): Promise<RuntimeInventoryCounters>;
}

type CleanupMode = "graceful" | "force-remove" | "quarantine-only";

interface ForceCleanupPolicy {
  allowedAdapters: Array<"docker-sandbox" | "docker" | "wsl" | "custom">;
  maxAgeMs?: number;
  includeRunning: boolean;
  includeStopped: boolean;
  requireNamePrefix: string;
  allowDestructiveReset: false;
}
```

Cleanup states:

1. `requested`
2. `stopping`
3. `stopped`
4. `removing`
5. `removed`
6. `quarantined`
7. `reset-required`

Force cleanup tiers:

1. Graceful stop through the adapter.
2. Force remove by external name or ID, such as `sbx rm --force <name>` or `docker rm --force <id>`.
3. Quarantine the runtime, detach it from product session reuse, and keep the record visible in diagnostics.
4. Mark `reset-required`. An operator may then run a destructive scoped reset, such as `sbx reset --preserve-secrets --force`, only after explicit confirmation. The product must not silently run destructive reset commands.

Required cleanup accounting:

- Count every start, stop, remove attempt, force cleanup, quarantine, failed cleanup, and reset-required event.
- Counters must be emitted by runtime adapter and by agent role.
- Cleanup attempts must be event-sourced so the visual panel can explain what happened and why a runtime remains.
- Stale stopped runtimes should be removable without interrupting active chats.

## Runtime Lifecycle Service

`RuntimeLifecycleService` starts, stops, checkpoints, restarts, and relinks runtimes without losing chat continuity.

```ts
interface RuntimeLifecycleService {
  startRuntime(request: StartRuntimeRequest): Promise<RuntimeHandle>;
  stopRuntime(runtimeId: RuntimeId, reason: string): Promise<void>;
  restartRuntimeWithMounts(request: RestartRuntimeRequest): Promise<RuntimeHandle>;
  checkpointRuntime(runtimeId: RuntimeId, reason: string): Promise<RuntimeCheckpoint>;
  restoreRuntimeCheckpoint(request: RestoreRuntimeCheckpointRequest): Promise<RuntimeHandle>;
}
```

Restart rules:

- Adding a folder is an access change, not a permission elevation.
- An approved access change creates a new `RuntimeGenerationId`.
- The old generation is checkpointed, stopped, and cleaned after the new generation is healthy.
- Chat/session IDs remain stable while runtime generation IDs change.
- File baselines, plan state, task state, and event history live outside the runtime and survive restarts.
- Running subagents must either be migrated to new generations or cancelled with explicit restart events. The orchestrator decides by role and current operation.

Subagent restart behavior:

- Researcher and reviewer sessions can usually be cancelled and respawned.
- Worker and tester sessions must checkpoint diff state before restart.
- A restart request that affects shared mounts must notify all sessions using the old mount policy.
- The UI must show which agents were paused, cancelled, respawned, or left untouched.

## Mount Policy And Access Requests

The product enforces filesystem policy through runtime mounts, not prompt text.

```ts
interface MountPolicy {
  mountId: MountId;
  hostPath: string;
  runtimePath: string;
  mode: "read-only" | "read-write";
  source: "workspace-root" | "shared-read" | "shared-write" | "clone" | "temporary";
  approvedBy?: string;
  approvedAt?: string;
}

interface AccessRequestService {
  requestDirectoryAccess(request: DirectoryAccessRequest): Promise<AccessRequest>;
  approveAccessRequest(id: string, approval: AccessApproval): Promise<RestartPlan>;
  denyAccessRequest(id: string, reason: string): Promise<void>;
}
```

Access rules:

- Configured shared paths are applied by default unless a workspace set, task, or runtime template explicitly overrides them.
- Workspace root access derives from the active agent role and session mode.
- Plan, researcher, and reviewer contexts mount workspace roots read-only.
- Implementation and tester contexts may mount approved workspace roots writable.
- Clone mode never mounts live workspace roots.
- Shared read paths, such as studio Python/package roots, are always read-only.
- Shared write paths, such as approved shared libraries, are writable only when explicitly configured.
- Denied paths must be checked both before runtime creation and during snapshot/diff operations.
- No code or agent process runs on the host to bypass denied paths.

## Agent Adapter API

All provider integrations implement `AgentAdapter`. Product orchestration must not depend on one provider's hidden subagent implementation.

```ts
interface AgentAdapter {
  providerId: ProviderId;
  detect(): Promise<AdapterDetectionResult>;
  validateAuth(context: AdapterAuthContext): Promise<AuthValidationResult>;
  startProtocol(request: StartAgentProtocolRequest): Promise<AgentConnection>;
  sendPrompt(connection: AgentConnection, prompt: AgentPrompt): Promise<RunId>;
  streamEvents(connection: AgentConnection, runId: RunId): AsyncIterable<AgentEvent>;
  cancel(connection: AgentConnection, runId: RunId): Promise<void>;
  stop(connection: AgentConnection, reason: string): Promise<void>;
  summarizeCapabilities(): Promise<AgentCapabilities>;
}
```

Adapter isolation rule:

- `detect`, `validateAuth`, and `summarizeCapabilities` may perform inert host-side checks such as version discovery, login status, generated schema discovery, and capability probing.
- `startProtocol`, `sendPrompt`, `streamEvents`, `cancel`, and `stop` must operate against an isolated runtime context. They must not start a host-side AI prompt, chat turn, agent session, provider tool call, or model-output stream.
- Adapter implementations should make the runtime context explicit in `StartAgentProtocolRequest` and should fail with `RUNTIME_CREATE_FAILED`, `ADAPTER_UNAVAILABLE`, or `PROTOCOL_UNAVAILABLE` rather than falling back to host execution.
- Capability summaries must describe only wired product behavior. A successful protocol probe does not become `supportsAppServer`, `supportsCancel`, or similar advertised capability until the adapter can start it through the normal orchestration path and tests cover it.

Required adapters:

- `CodexAdapter` is required for v1. It validates Codex login and supports app-server JSON-RPC and command-driven event streams inside isolated runtimes where available. Host Codex checks are limited to inert detection, auth status, and schema/capability discovery. Literal ACP-compatible support is required only if the installed Codex surface exposes it; otherwise the adapter must map the available Codex protocol to the product event model.
- `GenericAcpAdapter` is optional until an installed ACP server is validated. It follows the public ACP schema for handshake, session creation, prompt send, event stream, cancellation, and error reporting.
- `ClaudeAdapter` is optional for Stage 0 and becomes a later provider once local auth and command surfaces are validated. The adapter should use Claude Code's documented CLI surfaces inside isolated runtimes, including stream JSON output where available.

Agent event model:

```ts
type AgentEvent =
  | AgentTextEvent
  | AgentToolCallEvent
  | AgentFileEditEvent
  | AgentFileCreateEvent
  | AgentFileDeleteEvent
  | AgentCommandEvent
  | AgentPlanEvent
  | AgentErrorEvent
  | AgentDoneEvent;
```

File visibility requirement:

- The backend must emit normalized file events for create, modify, delete, rename, and chmod-like metadata changes when available.
- If an agent protocol does not emit complete file events, `SessionDiffService` must detect changes through snapshots and produce synthetic file events.
- UI work must depend on normalized product events, not raw provider-specific stream fragments.

## Model Routing API

`ModelRouterService` chooses a provider/model profile for a role. It optimizes for capability, cost, context size, and configured policy, but it does not own permissions.

```ts
interface ModelProfile {
  id: ModelProfileId;
  displayName: string;
  providerId: ProviderId;
  modelAlias: string;
  roleTypes: AgentRole[];
  costClass: "low" | "medium" | "high";
  contextBudget: "small" | "medium" | "large";
  networkRequirement: "none" | "provider-scoped" | "test-egress";
  authRefs: SecretRef[];
  outputSchemas: string[];
  localOnly?: boolean;
}

interface ModelRoutingRequest {
  sessionId: SessionId;
  taskId?: TaskId;
  agentRole: AgentRole;
  riskLevel: "low" | "medium" | "high";
  requiredCapabilities: string[];
  preferredProfileId?: ModelProfileId;
  maxCostClass?: "low" | "medium" | "high";
}

interface ModelRoutingDecision {
  id: string;
  selectedProfileId: ModelProfileId;
  providerId: ProviderId;
  modelAlias: string;
  reason: string;
  contextBudget: ModelProfile["contextBudget"];
  estimatedCostClass: ModelProfile["costClass"];
  requiresAuthRefs: SecretRef[];
}

interface ModelRouterService {
  listProfiles(): Promise<ModelProfile[]>;
  route(request: ModelRoutingRequest): Promise<ModelRoutingDecision>;
  recordOutcome(decisionId: string, outcome: "completed" | "failed" | "escalated" | "cancelled"): Promise<void>;
}
```

Default profile intent:

- `main-worker`: high-capability coding model, initially Codex.
- `test-review`: lower-cost tester/reviewer model, such as a Sonnet-style profile.
- `design-flow`: design/product workflow model, such as a Gemini-style profile.
- `local-guard`: no-network local guard for prompt-injection, command, and input checks.
- `workspace-mapper`: cheap/local model for classifying projects and task/workspace links.

Routing rules:

- Profiles are configured aliases. Product code must not bake in a single model name such as `codex-5.5`.
- Routing decisions are stored with the run and event stream.
- Routing failure pauses or degrades only the affected role.
- Routing cannot add mounts, enable network, expose secrets, or change approval
  policy.

## Security Evaluation API

`SecurityEvaluationService` runs lightweight checks over untrusted inputs and proposed actions.

```ts
interface SecurityEvaluationRequest {
  sessionId: SessionId;
  runId?: RunId;
  source:
    | "user-prompt"
    | "repo-file"
    | "ticket"
    | "tool-output"
    | "model-output"
    | "command"
    | "package-script"
    | "memory-candidate"
    | "workspace-map";
  text?: string;
  command?: string[];
  fileRefs?: string[];
  proposedAction?: string;
}

interface SecurityEvaluationResult {
  id: SecurityEvaluationId;
  decision: "allow" | "warn" | "needs-approval" | "deny";
  reasons: string[];
  matchedRules: string[];
  modelProfileId?: ModelProfileId;
  redactedTextRef?: string;
}

interface SecurityEvaluationService {
  evaluate(request: SecurityEvaluationRequest): Promise<SecurityEvaluationResult>;
}
```

Evaluation rules:

- Guard checks can combine deterministic rules, secret scanning, deny-path checks, and a local guard model.
- Guard checks may block, warn, or request user approval.
- Guard checks cannot grant new access. Access still flows through
  `AccessRequestService`, mount policy, and network policy.
- A denied guard result is stored as evidence, not as a prompt for another model to override.

## Auth Provider Service

`AuthProviderService` handles provider login state and secret references.

```ts
interface AuthProviderService {
  requestLogin(providerId: ProviderId, reason: string): Promise<AuthRequest>;
  validateLogin(providerId: ProviderId, target: AuthTarget): Promise<AuthValidationResult>;
  resolveSecretRef(secretRef: SecretRef, target: AuthTarget): Promise<ResolvedSecretMount>;
  injectRuntimeAuth(runtimeId: RuntimeId, refs: SecretRef[]): Promise<void>;
  revokeSessionAuth(sessionId: SessionId, providerId: ProviderId): Promise<void>;
}
```

Auth rules:

- The extension stores secret references, not raw secrets.
- Host login and sandbox login are validated separately.
- Docker Sandbox secrets should use sandbox-managed secret mechanisms where available.
- Auth must survive runtime restarts by replaying secret refs into the new runtime generation.
- If auth is missing inside a runtime, the agent session pauses and emits `AUTH_REQUIRED`; it must not fall back to host execution.
- Suggested secret refs include `sbx:service/openai`, `sbx:service/anthropic`, and `vscode-secret:<provider>`.

Implemented surfaces (see `docs/design/provider-signin-and-registry.md`):

- The provider registry (`@drydock/contracts` `PROVIDER_REGISTRY`) describes every provider: which agent CLI it rides, its connect spec (guided OAuth and/or API key), wire config, scoped egress, and seed model catalog. Ridden providers reuse the existing transports; adding a provider never adds policy.
- `ProviderConnectService` runs guided sign-in on the HOST (auth handshakes are user setup, not agent work): it spawns the login process with piped stdio, opens the scraped URL in the browser, relays an optional paste-back code from the webview, pipes captured tokens/API keys into `sbx secret set -g <service>` stdin (or VS Code SecretStorage for providers without a sandbox service), and re-probes auth status on completion.
- `ChatSessionService.prepareRuntime` replays provider wiring into every fresh runtime generation: codex riders get `$HOME/.codex/config.toml` (sentinel env key; the sandbox proxy injects the real value), claude riders get a runtime-scoped token file under `/tmp` (mode 0600) resolved from `vscode-secret:<provider>` at boot.
- Webview messages: `provider.list {force?}` (force always re-probes auth; only catalog fetches are TTL-throttled), `provider.login` (responds `mode: "guided" | "terminal"`; terminal logins are auto-detected via polling + terminal-close), `provider.submitCode`, `provider.submitApiKey` (both write-only, bounded by `MAX_SECRET_INPUT_LENGTH`, never echoed), `provider.cancelLogin`, and the `provider.authProgress` push (`launched | browser-opened | awaiting-code | verifying | connected | failed`, details scrubbed against token shapes).

## Session Diff Service

`SessionDiffService` tracks per-session file changes independent of Git.

```ts
interface SessionDiffService {
  createBaseline(sessionId: SessionId, roots: WorkspaceRootId[]): Promise<DiffCheckpoint>;
  snapshotCurrent(sessionId: SessionId): Promise<DiffSnapshot>;
  listChangedFiles(sessionId: SessionId): Promise<ChangedFile[]>;
  getFileDiff(sessionId: SessionId, path: string): Promise<FileDiff>;
  acceptFile(sessionId: SessionId, path: string): Promise<DiffCheckpoint>;
  acceptAll(sessionId: SessionId): Promise<DiffCheckpoint>;
  revertFile(sessionId: SessionId, path: string): Promise<RevertResult>;
  serializeCheckpoint(sessionId: SessionId): Promise<SerializedDiffCheckpoint>;
  restoreCheckpoint(checkpoint: SerializedDiffCheckpoint): Promise<void>;
}
```

Diff rules:

- Baselines are per session and per file, not Git state.
- Accepting a file resets that file's baseline only.
- Reverting a file restores it to the session baseline and requires confirmation in the UI.
- Removed files disappear from the changed-file strip only after accept or revert resolves them.
- Checkpoints must survive runtime restart and extension host restart.

## Planner Service

The Planner service owns durable, optionally task-linked plans over disposable
read-only planning sessions. It collects artifacts from the planning workspace,
hydrates them into a replacement session, and stores annotations independently
of session lifetime.

```ts
interface PlannerService {
  createPlan(taskId: TaskId | undefined, request: PlanCreateRequest): Promise<PlanSummary>;
  updateIntake(planId: PlanId, request: PlanIntakeUpdate): Promise<PlanSummary>;
  collect(planId: PlanId): Promise<PlanArtifact[]>;
  hydrate(planId: PlanId, sessionId: SessionId): Promise<void>;
  addAnnotation(planId: PlanId, request: PlanAnnotationCreate): Promise<PlanAnnotation>;
  materializeSubtasks(planId: PlanId, titles: string[]): Promise<Subtask[]>;
}
```

Planner rules:

- Planning is a separate Plan/Planner surface, not an Edit-composer mode or an
  implementation approval gate.
- Context roots are read-only by runtime mount policy; the plan workspace is a
  disposable writing surface whose collected artifacts are durable.
- Documents, diagrams, images, and sandboxed prototypes share one annotation
  lifecycle.
- Board materialization proposes only literal document checkbox items and
  creates backlog subtasks after preview; it never starts work or invents DAG
  edges.

## Documentation Review Service

`DocumentationReviewService` makes Markdown planning artifacts discoverable and commentable.

```ts
interface DocumentRecord {
  id: DocumentId;
  path: string;
  title?: string;
  kind: "plan" | "adr" | "runbook" | "architecture" | "api-reference" | "work-management" | "other";
  workspaceSetId?: WorkspaceSetId;
  taskId?: TaskId;
  updatedAt: string;
}

interface ReviewLineRange {
  path: string;
  startLine: number;
  endLine: number;
  blockId?: string;
}

interface ReviewComment {
  id: ReviewCommentId;
  threadId: ReviewThreadId;
  author: "user" | "agent-reviewer" | "guard";
  body: string;
  range: ReviewLineRange;
  createdAt: string;
}

interface DocReviewIntent {
  kind:
    | "new-expectation"
    | "correction"
    | "clarification"
    | "open-question"
    | "accepted-convention"
    | "follow-up-task"
    | "out-of-scope";
  summary: string;
  confidence: "low" | "medium" | "high";
}

interface DocumentationReviewService {
  discoverDocuments(request: DocumentDiscoveryRequest): Promise<DocumentRecord[]>;
  startDocReview(documentIds: DocumentId[]): Promise<ReviewSession>;
  addComment(request: ReviewCommentCreate): Promise<ReviewComment>;
  preprocessComment(commentId: ReviewCommentId): Promise<DocReviewIntent>;
  proposeDocPatch(threadId: ReviewThreadId): Promise<DocPatchProposal>;
  resolveThread(threadId: ReviewThreadId, resolution: ReviewResolution): Promise<void>;
}
```

Doc review rules:

- Markdown files in `docs/` are discovered by default; additional doc roots are configured per workspace set.
- Comments attach to file path and line range, with optional block IDs for stable Markdown regions.
- The event store is authoritative for review comments. Inline Markdown markers are optional helpers.
- Comment preprocessing adds intent to the prompt context as file, line range, comment, and normalized intent.
- Proposed doc updates cite the review thread that caused them.

## Code Review Service

`CodeReviewService` treats AI changes like normal code review against session, workspace, clone patch, or branch scope.

```ts
type ReviewScope = "current-session" | "workspace" | "clone-patch" | "branch";
type ReviewThreadStatus = "open" | "acknowledged" | "delegated" | "resolved" | "wont-fix" | "blocked";

interface ReviewSession {
  id: ReviewSessionId;
  taskId?: TaskId;
  scope: ReviewScope | "documentation";
  baseRef?: string;
  headRef?: string;
  status: "open" | "completed" | "cancelled";
  createdAt: string;
}

interface ReviewThread {
  id: ReviewThreadId;
  sessionId: ReviewSessionId;
  range: ReviewLineRange;
  status: ReviewThreadStatus;
  severity: "note" | "minor" | "major" | "blocking";
  intent?: string;
  subtaskId?: SubtaskId;
}

interface Subtask {
  id: SubtaskId;
  parentTaskId: TaskId;
  origin: "review";
  title: string;
  reviewThreadIds: ReviewThreadId[];
  assignedRole: AgentRole;
  status: "proposed" | "accepted" | "running" | "review" | "done" | "blocked";
  runtimePolicyRef: string;
}

interface CodeReviewService {
  startReview(request: StartCodeReviewRequest): Promise<ReviewSession>;
  addComment(request: ReviewCommentCreate): Promise<ReviewComment>;
  classifyThreads(sessionId: ReviewSessionId): Promise<ReviewThread[]>;
  proposeSubtasks(sessionId: ReviewSessionId): Promise<Subtask[]>;
  delegateSubtask(subtaskId: SubtaskId): Promise<AgentSession>;
  resolveThread(threadId: ReviewThreadId, resolution: ReviewResolution): Promise<void>;
}
```

Code review rules:

- Human comments, agent reviewer findings, guard findings, and test findings share the same review-thread model.
- Repeated feedback can be grouped into review-origin subtasks by normalized intent, file area, risk, and likely owner. There is no separate MiniTask persistence model.
- Review-origin subtasks inherit the original review scope's runtime policy; delegation cannot broaden mounts, network, tools, or secrets.
- Review threads close only after a follow-up diff is reviewed, or the thread is explicitly marked `wont-fix`.

## Orchestrator Service

`OrchestratorService` controls multiple sessions and runtimes explicitly.

```ts
interface OrchestratorService {
  spawnAgent(request: SpawnAgentRequest): Promise<AgentSession>;
  cancelAgent(agentId: AgentId, reason: string): Promise<void>;
  cancelRun(runId: RunId, reason: string): Promise<void>;
  getFlow(sessionId: SessionId): Promise<AgentFlowGraph>;
  streamAgentEvents(sessionId: SessionId): AsyncIterable<AgentEvent>;
}
```

Orchestration rules:

- Product subagents are independent controlled sessions/runtimes.
- Provider-native subagents are optional acceleration, never the only control model.
- Cancelling one agent must not kill unrelated agents.
- Every agent event must include `sessionId`, `agentId`, `agentRole`, `runtimeId`, `runtimeGenerationId`, and `runId` when available.
- The visual panel reads the event store and flow graph, not transient process output.

## Task, Memory, And Testing Services

`WorkManagementConfigService` owns state-store configuration. The current VS Code workspace is not the source of truth; it is the active projection of product-owned workspace sets.

```ts
interface WorkManagementConfig {
  stateStores: StateStoreConfig[];
  artifactStores: ArtifactStoreConfig[];
  sharedPaths?: SharedPathConfig[];
  logging?: LoggingConfig;
  packaging?: PackagingConfig;
  sourceControl?: SourceControlConfig;
  naming?: NamingConfig;
  defaultTaskProvider: ProviderId;
}

interface StateStoreConfig {
  id: StateStoreId;
  path: string;
  role: "primary" | "shared" | "archive";
  scope: "personal" | "team" | "portable";
  writable: boolean;
}

interface SharedPathConfig {
  id: string;
  path: string;
  access: "read-only" | "read-write";
  purpose: "studio-python-packages" | "approved-shared-libraries" | string;
  overridable: boolean;
}

interface LoggingConfig {
  defaultMode: "redacted";
  expandedLogging: boolean;
  expandedMetrics: boolean;
  retentionClass: "short" | "standard" | "long";
  piiPolicy: "redact" | "allow-expanded";
}

interface PackagingConfig {
  channel: "vsix";
  incrementVersionOnPackage: true;
  publishToMarketplace: false;
}

interface SourceControlConfig {
  allowDeveloperBranches: boolean;
  crossBoundaryBranchPrefix: string;
}

interface NamingConfig {
  displayNameRef: string;
  avoidHardcodedProductName: true;
}

interface WorkManagementConfigService {
  loadConfig(): Promise<WorkManagementConfig>;
  validateStores(config: WorkManagementConfig): Promise<StateStoreValidationResult>;
  resolveStore(id: StateStoreId): Promise<StateStoreHandle>;
}
```

State-store rules:

- At least one local writable primary store is required.
- Raw secrets are not stored in state paths.
- Agents do not receive state-store mounts by default.
- Shared stores may provide catalogs and templates, but local task traceability must work offline.
- Shared path config is not the same as state-store config. Shared read/write paths may be mounted into runtimes according to mount policy; state stores remain product metadata stores unless explicitly requested through access rules.
- Logging defaults to redacted structured events. Expanded logging and metrics are opt-in and must declare retention and PII handling.
- Packaging config is VSIX-only for now, increments the extension version for every installable package, and does not publish to a marketplace/store.
- Source-control config allows developer-selected branches for local work, but code or patch transfer across a network boundary uses product-generated temporary branch names.
- User-facing product naming should resolve through a small set of display-name references so the product can be renamed later without broad churn.

`WorkspaceSetService` manages product-owned workspace sets. A workspace set is a named group of projects; it is not the same thing as the current VS Code workspace.

```ts
interface ProjectRecord {
  id: ProjectId;
  name: string;
  path: string;
  kind: "git" | "folder" | "worktree" | "clone";
  tags: string[];
}

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

interface WorkspaceSetService {
  createWorkspaceSet(request: WorkspaceSetCreate): Promise<WorkspaceSet>;
  addProject(workspaceSetId: WorkspaceSetId, projectId: ProjectId): Promise<void>;
  removeProject(workspaceSetId: WorkspaceSetId, projectId: ProjectId): Promise<void>;
  activateWorkspaceSet(request: WorkspaceActivationRequest): Promise<WorkspaceActivation>;
  getProjection(workspaceSetId: WorkspaceSetId): Promise<WorkspaceProjection>;
}
```

Workspace-switching rules:

- Switching workspace sets is a backend operation, not only a VS Code folder change.
- Switching checkpoints diffs, pauses affected agents, records work-session events, applies the VS Code projection, and restarts runtimes whose mount policy changed.
- Sibling tasks and unrelated agents continue unless they share a changed runtime or mount policy.
- A task may have multiple active contexts over time, each with its own workspace set and diff checkpoints.

`ExtensionPointRegistry` validates and registers schema-bound providers before product code can call them.

```ts
interface ExtensionPointRegistry {
  loadManifest(path: string): Promise<ExtensionManifest>;
  validateManifest(manifest: ExtensionManifest): Promise<ManifestValidationResult>;
  registerProvider(manifest: ExtensionManifest): Promise<void>;
  listProviders(kind?: ExtensionProviderKind): Promise<ExtensionManifest[]>;
  getProvider(providerId: ProviderId): Promise<ExtensionManifest>;
}

type ExtensionProviderKind =
  | "task-provider"
  | "agent-provider"
  | "runtime-adapter"
  | "panel-provider"
  | "memory-provider"
  | "test-provider";
```

Extension rules:

- Provider manifests are schema-bound and versioned.
- Manifests cannot contain raw secrets.
- Panel providers can subscribe to normalized events and call allowed commands, but cannot access secrets, runtime processes, or host filesystem paths directly.
- Custom AI agents must emit normalized product events.
- Custom task providers must map to `TaskRecord`.

`TaskService` manages internal tasks first and external task adapters later. The internal task provider is required and remains available when no Jira, Asana, GitHub, or custom provider is configured.

```ts
interface TaskService {
  createTask(request: TaskCreateRequest): Promise<TaskRecord>;
  activateTask(taskId: TaskId): Promise<TaskActivation>;
  linkProjectFolder(taskId: TaskId, workspaceRootId: WorkspaceRootId): Promise<void>;
  linkWorkspaceSet(taskId: TaskId, workspaceSetId: WorkspaceSetId, reason: TaskWorkspaceLinkReason): Promise<void>;
  findRelatedTasks(workspaceRootId: WorkspaceRootId): Promise<TaskRecord[]>;
  startWorkSession(request: StartTaskWorkSessionRequest): Promise<TaskWorkSession>;
  stopWorkSession(sessionId: TaskWorkSessionId, reason: string): Promise<TaskWorkSession>;
  recordActivity(taskId: TaskId, activity: TaskActivity): Promise<void>;
  linkPrompt(taskId: TaskId, promptId: string): Promise<void>;
  linkRun(taskId: TaskId, runId: RunId): Promise<void>;
  linkPlan(taskId: TaskId, planId: PlanId): Promise<void>;
  linkChangedFile(taskId: TaskId, fileRef: string): Promise<void>;
  linkMemory(taskId: TaskId, memoryRef: string): Promise<void>;
  linkTest(taskId: TaskId, testRunId: string): Promise<void>;
}

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

Task provider rules:

- `InternalTaskProvider` is required, local/offline capable, and auth-free.
- Jira, Asana, GitHub Issues, and custom task systems are adapters around the canonical task model.
- External providers do not own local prompt history, sandbox history, diff baselines, or memory review state.
- `updatedAt` changes when task metadata changes; `lastWorkedAt` changes when user or agent work happens.
- Work sessions record task, workspace set, project IDs, started time, last activity time, runtime generations, runs, diffs, plans, tests, and notes.
- External live probes are read-only unless dedicated test-project settings are configured.
- Sync conflicts use product error code `TASK_SYNC_CONFLICT` and require explicit resolution.

`DayPlannerService` maps tasks to days and records pushes, multi-day spans, and notes.

```ts
interface DayPlannerService {
  getDay(date: string): Promise<DayPlan>;
  scheduleTask(request: ScheduleTaskRequest): Promise<DayPlanItem>;
  moveItem(itemId: DayPlanItemId, targetDate: string, reason: string): Promise<DayPlanPush>;
  addDayNote(request: DayNoteCreate): Promise<DayNote>;
  addTaskNote(taskId: TaskId, request: DayNoteCreate): Promise<DayNote>;
}
```

Planner rules:

- A task can be scheduled for one day or a multi-day span.
- Pushing a task writes a push record rather than overwriting history.
- Notes can attach to a day, task, workspace set, or work session.
- Day planner data is local-first; external calendar sync is a future provider.

`MemoryService` stores reviewed memory candidates only.

```ts
interface MemoryService {
  proposeMemory(candidate: MemoryCandidate): Promise<MemoryCandidateRecord>;
  approveMemory(id: string, approval: MemoryApproval): Promise<MemoryRecord>;
  searchMemory(query: MemoryQuery): Promise<MemoryRecord[]>;
}
```

`TestingService` supports automated tests and human-in-the-loop verification.

```ts
interface TestingService {
  runAutomatedTest(request: AutomatedTestRequest): Promise<TestRun>;
  createHitlRequest(request: HitlRequestCreate): Promise<HitlRequest>;
  recordHitlResult(id: string, result: HitlResult): Promise<void>;
}
```

HITL requests must include instructions, optional snippets, expected result choices, a freeform notes field, status, and links to run IDs and changed files.

## Event Store

Use SQLite with WAL mode for local durability. All product state that must survive extension restart or runtime restart belongs in the event store or in referenced on-disk artifacts.

Suggested tables:

- `runtime_instances`
- `runtime_cleanup_attempts`
- `runtime_inventory_counters`
- `sessions`
- `session_events`
- `agent_runs`
- `access_requests`
- `mount_policies`
- `diff_checkpoints`
- `plan_documents`
- `plan_blocks`
- `document_records`
- `review_sessions`
- `review_threads`
- `review_comments`
- `review_intents`
- `doc_patch_proposals`
- `mini_tasks`
- `auth_providers`
- `agent_adapters`
- `state_stores`
- `shared_path_configs`
- `product_policy_config`
- `project_records`
- `workspace_sets`
- `workspace_set_projects`
- `workspace_activations`
- `extension_manifests`
- `task_providers`
- `tasks`
- `task_project_links`
- `task_workspace_links`
- `task_work_sessions`
- `task_external_refs`
- `task_prompt_links`
- `task_run_links`
- `task_plan_links`
- `task_diff_links`
- `task_test_links`
- `day_plans`
- `day_plan_items`
- `day_plan_pushes`
- `daily_notes`
- `model_profiles`
- `model_routing_decisions`
- `security_evaluations`
- `memory_candidates`
- `memory_records`
- `hitl_requests`

Transaction rules:

- Create inventory records before external runtime creation.
- Record cleanup attempts before running external cleanup commands.
- Record checkpoint metadata before runtime restart.
- Record event stream offsets so replay can resume without duplicated UI state.
- Record model routing decisions and security evaluation outcomes with run/session IDs.
- Record review comments, normalized intent, review-origin subtask creation,
  delegation, and thread resolution as durable events.

## Command Surface

The product may call external commands only through adapter-owned command runners with structured arguments, timeouts, logging, and redaction.

Docker Sandbox commands:

- `sbx create`
- `sbx exec`
- `sbx cp`
- `sbx stop`
- `sbx rm --force`
- `sbx ls`
- `sbx reset --preserve-secrets --force` only after explicit operator confirmation
- `sbx secret ls`
- `sbx secret set`
- `sbx secret rm`
- `sbx policy allow network`
- `sbx policy rm network`

Docker fallback commands:

- `docker run`
- `docker stop`
- `docker rm --force`
- `docker ps -a`
- `docker inspect`

Git clone mode commands:

- `git clone`
- `git worktree add`
- `git worktree remove`
- `git branch`
- `git status --porcelain`
- `git diff`
- `git apply --check`
- `git apply`

Git branch rules:

- Developer-provided branch names are allowed for local work when they pass normal Git ref validation.
- Any branch used to submit code or patches across a network boundary is product-generated with the configured temporary branch prefix and linked back to the task/review session.
- Temporary transfer branches must not encode secrets, ticket bodies, prompt text, or absolute host paths.

VSIX packaging commands:

- Version increment and VSIX package creation are adapter-owned operations with structured logs and redaction.
- Internal Stage 1 packaging uses `npm run package:vsix`, which bundles the extension entrypoint and asserts a scoped VSIX payload before guided manual verification.
- Marketplace/store publishing commands are out of scope until the packaging policy changes.

Agent commands:

- `codex` host detection, login validation, and schema/capability probing; protocol startup, prompt send, event stream, cancellation, and model output only inside isolated runtimes.
- `claude` host detection, login validation, and permission/capability probing; prompt execution, stream JSON output, event stream, cancellation, and model output only inside isolated runtimes.

## Error Model

Product services use stable error codes so UI, logs, and test assertions do not depend on provider text.

```ts
type ProductErrorCode =
  | "RUNTIME_CREATE_FAILED"
  | "RUNTIME_CLEANUP_FAILED"
  | "RUNTIME_RESET_REQUIRED"
  | "RUNTIME_RESTART_REQUIRED"
  | "AUTH_REQUIRED"
  | "ACCESS_REQUEST_REQUIRED"
  | "ADAPTER_UNAVAILABLE"
  | "PROTOCOL_UNAVAILABLE"
  | "DIFF_CONFLICT"
  | "PLAN_APPROVAL_REQUIRED"
  | "HITL_REQUIRED"
  | "TASK_ACTIVATION_REQUIRED"
  | "TASK_SYNC_CONFLICT"
  | "PROVIDER_SCHEMA_INVALID"
  | "STATE_STORE_UNAVAILABLE"
  | "WORKSPACE_SWITCH_REQUIRED"
  | "DAY_PLAN_CONFLICT";
```

Every error record must include service, operation, provider or adapter when applicable, retryability, user action, and redacted diagnostics.

## Security Invariants

- Agents, commands, and AI-controlled tools never run on the host.
- Codex, Claude, and other AI providers are never called on the host for prompts, chat turns, agent sessions, tool calls, or model-generated output.
- Host-side provider checks are limited to inert detection, version, auth status, and schema/capability discovery.
- The host extension may start, stop, inspect, and clean runtimes, but it may not execute agent-requested commands directly.
- Mount additions require user approval and runtime restart.
- There is no permission elevation flow.
- Clone mode is the only future remote/server execution mode.
- Remote/server execution never mounts live workspace roots.
- Raw secrets are not stored in product databases, logs, Markdown plans, or event streams.
- Logs, metrics, and diagnostics are redacted by default. Expanded logging and metrics are opt-in configuration and must keep retention and PII handling explicit.
- Work-management state stores hold product metadata only and are not mounted into agent runtimes unless explicitly configured through normal access rules.
- Destructive cleanup reset is never silent and is never bundled with normal session cleanup.
- Provider-native subagents are optional; product-level orchestration must remain visible and cancellable.
- Model routing cannot broaden runtime permissions, network, secrets, or approvals.
- Guard-model output is advisory or blocking evidence only; it is never an access grant.
- Model outputs, tool outputs, repository files, tickets, and memory candidates remain untrusted even when multiple models agree.
- Security-sensitive source files must be navigable and self-explaining at boundaries: module/file docs, exported API docs, and `MARK` regions are required for large service, adapter, runtime, and policy files.
- Review comments are structured workflow inputs, not hidden prompt text. Every delegated fix must preserve the original file/line range and thread provenance.
- Review-origin subtasks inherit the parent review scope and cannot expand
  runtime permissions.
- Packaging remains VSIX-only until explicitly changed, and each generated VSIX increments the extension version.
- Branches used for cross-boundary Git transfer are temporary product-generated refs, even when local development work uses a developer-selected branch.

## Stage Gates Using This API

Stage 1 may begin only after Stage 0 prevalidation confirms:

- `docs/design/api-reference.md` exists and includes runtime inventory, force cleanup, auth, adapters, diffs, access restart, and references.
- Docker Sandbox or documented fallback runtime checks pass.
- Codex provider discovery/auth/schema communication is validated on host, and executable prompt/session communication is validated in at least one sandbox target.
- Model profile and guard evaluation contracts exist for role defaults, cost/context budgets, local guard checks, and non-expanding fallback behavior.
- Code documentation standards exist for source file docs, exported API docs, and `MARK` navigation in large files.
- Documentation and code review contracts exist for file/line comments,
  intent preprocessing, thread resolution, review-origin subtask creation, and
  delegation provenance.
- Git, plan, diff, orchestration, HITL, auth, access restart, and cleanup accounting probes pass or are explicitly deferred with reasons.

Later stages must extend this document when a new backend contract is introduced.

## References

- Docker Sandboxes: <https://docs.docker.com/ai/sandboxes/>
- Docker `sbx` CLI: <https://docs.docker.com/reference/cli/sbx/>
- Docker `sbx reset`: <https://docs.docker.com/reference/cli/sbx/reset/>
- Docker CLI: <https://docs.docker.com/reference/cli/docker/>
- ACP introduction: <https://agentclientprotocol.com/get-started/introduction>
- ACP schema: <https://agentclientprotocol.com/protocol/v1/schema>
- Codex app server: <https://developers.openai.com/codex/app-server/>
- Codex CLI reference: <https://developers.openai.com/codex/cli/reference/>
- Codex authentication: <https://developers.openai.com/codex/auth/>
- Codex sandboxing: <https://developers.openai.com/codex/concepts/sandboxing/>
- Codex subagents: <https://developers.openai.com/codex/subagents/>
- Claude Code CLI: <https://docs.anthropic.com/en/docs/claude-code/cli-reference>
- JSON Schema: <https://json-schema.org/>
- OpenAPI Specification: <https://spec.openapis.org/oas/latest.html>
- Jira Cloud REST API v3: <https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/>
- Jira issues API: <https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/>
- Jira webhooks: <https://developer.atlassian.com/cloud/jira/platform/webhooks/>
- Asana REST API reference: <https://developers.asana.com/reference/rest-api-reference>
- Asana tasks API: <https://developers.asana.com/reference/tasks>
- Asana webhooks API: <https://developers.asana.com/reference/webhooks>
- GitHub Issues REST API: <https://docs.github.com/en/rest/issues/issues>
- GitHub issue comments API: <https://docs.github.com/en/rest/issues/comments>
- GitHub webhooks: <https://docs.github.com/en/webhooks>
- Git worktree: <https://git-scm.com/docs/git-worktree>
- Git diff: <https://git-scm.com/docs/git-diff>
- Git apply: <https://git-scm.com/docs/git-apply>
- VS Code API: <https://code.visualstudio.com/api/references/vscode-api>
- VS Code Webview API: <https://code.visualstudio.com/api/extension-guides/webview>
- VS Code Tree View API: <https://code.visualstudio.com/api/extension-guides/tree-view>
- SQLite WAL: <https://www.sqlite.org/wal.html>
- SQLite transactions: <https://www.sqlite.org/lang_transaction.html>

