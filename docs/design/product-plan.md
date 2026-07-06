# Security-First VS Code Agent Extension Plan

## Summary

Stage 0 is an entry gate, not VS Code implementation. No extension scaffolding begins until the repo contains:

- A saved Markdown product plan.
- A saved threat model.
- A saved implementation API reference.
- A saved extension-points and task-integration plan with schema-bound provider contracts.
- A saved work-management plan for state stores, workspace sets, task work sessions, workspace switching, and day planning.
- An executable prevalidation harness that proves the required runtime, Codex adapter, Git, diff, plan, and orchestration assumptions.

The first product proof remains minimal: run one agent inside one isolated Docker Sandbox microVM. Before that proof, this repo must validate that the needed external commands, protocols, and runtime behaviors are actually available on the developer machine.

## Feature Set

Build a local-first engineering control plane for serious development:

- One isolated runtime per chat/session.
- No direct host-side AI execution. Codex, Claude, and future providers may be detected on the host for inert version/auth/schema/capability checks, but prompts, chat turns, model output, tool calls, and agent sessions must run inside isolated runtimes.
- Runtime inventory and cleanup accounting for every sandbox/container started, including force cleanup, quarantine, and reset-required states.
- Runtime registry with optional name, type, CPU/memory/network/access settings, and future adapter support.
- Runtime types: Docker Sandbox first, Docker second, WSL third, extension-provided adapters later.
- Codex through an agent adapter. Codex communication is required in Stage 0: inert host Codex login/protocol/capability checks plus Docker Sandbox and Docker-container Codex prompt/session communication must all be validated before Stage 1. Literal ACP is probed when available, and current required protocol coverage uses Codex app-server JSON-RPC, MCP server, and exec JSON.
- Agent adapter registry supports Codex first, Claude as the next named adapter, and generic ACP/provider adapters later without changing runtime or orchestration semantics.
- Model routing is profile-based, not hard-coded. The orchestrator can route different roles to different configured model aliases, such as a high-capability Codex worker, a cheaper Sonnet-style tester/reviewer, a Gemini-style design workflow, a local no-network guard model for injection/sanitization checks, and a cheap mapper for workspace/task classification.
- Model routing should stay quiet by default. Users choose or inherit a task/workspace profile; the system only interrupts for missing auth, unusual cost, degraded capability, or security-relevant routing changes.
- Model choice must never expand permissions. A cheaper or specialized model receives only the mounts, tools, network, and secrets granted to its role and runtime policy.
- Multi-root workspace support, not one parent folder.
- Product-owned workspace sets that can contain multiple projects and can be switched independently of the current VS Code workspace.
- Configured state stores, with at least one local writable primary store, to track tasks, workspace sets, work sessions, day plans, and provider sync state outside the active VS Code workspace.
- Configured shared paths are applied by default unless explicitly overridden.
- Shared read paths, such as studio Python/package roots, mount read-only; configured shared write paths, such as approved shared libraries, mount read-write.
- Workspace root access follows the active agent role and session mode: plan/research/review modes are read-only, implementation/test modes may write approved roots, and clone mode never mounts the live workspace.
- Clone mode never mounts live workspace; it uses disposable clones/worktrees and Git/patch sync.
- No permission elevation. Extra directory access requires user approval, a runtime checkpoint, and sandbox restart with new mounts. The chat/session remains continuous while only the requesting runtime generation is replaced.
- Markdown planning with stable block IDs, comments, revisions, and approvals.
- Discoverable Markdown documentation review for planning docs, ADRs, runbooks, architecture notes, and other `.md` files in `docs/` or configured documentation paths. Review comments attach to file paths, line ranges, and optional stable block IDs.
- Documentation review preprocessing turns review comments into intent such as new expectation, correction, open question, accepted convention, or follow-up task, then proposes doc updates rather than burying decisions in chat.
- Strong orchestration: researcher, planner, worker, tester, reviewer, memory extractor.
- Visual agent panel showing categories, flow, status, events, outputs, and decisions.
- Per-session diff support independent of Git: changed files strip, per-file diff, accept baseline reset, revert with confirmation.
- GitHub/GitLab-style code review for current session diffs, workspace diffs, and clone/worktree patches. Comments attach to files and line ranges, resolve through review threads, and become part of the task/run history.
- Repeated or broad review feedback can be promoted into mini tasks. The orchestrator groups comments by theme, file, risk, and ownership, then delegates scoped fixes to suitable agents.
- Automated tests and human-in-the-loop test panels.
- Internal task tracking first and always available for work that has no Jira/Asana/GitHub issue. External adapters sync to the same canonical task model later.
- Tasks can relate to one or more workspace sets and projects; working a task creates task work sessions with timestamps, runtime generations, run IDs, diff checkpoints, tests, notes, `updatedAt`, and `lastWorkedAt`.
- Day planner support for mapping tasks to days, multi-day spans, pushing tasks with reasons, and notes per day/task/work session for unexpected meetings, support, incidents, or other interruptions.
- Schema-bound extension points for task providers, agent providers, runtime adapters, panel providers, memory providers, and test providers.
- Shared memory via reviewed memory candidates only.
- Provider authentication prompts are explicit user actions. Credentials are persisted as provider secret references outside disposable runtimes and reinjected on runtime creation/restart without writing raw secrets to events or plans.
- Future remote/server mode only supports clone mode.
- Logs and metrics are redacted by default because prompts, tickets, paths, and tool output can contain PII. Expanded logging and metrics are opt-in configuration with retention and redaction controls.
- Packaging is VSIX-only for now. Each generated VSIX increments the extension version; marketplace/store publishing is out of scope.
- Product naming stays sparse and centralized until the user chooses a stable name.
- Developers may specify working branches. When Git is used to send code or patches across a network boundary, the product creates scoped temporary branch names instead of reusing arbitrary local branch state.
- Lightweight security control tracking maps key AI workflow risks to existing controls, tests, and evidence without creating a heavy compliance workflow.
- A small adversarial fixture pack covers prompt injection from repo files, ticket text, tool output, memory candidates, and package scripts. These fixtures are regression tests for the orchestrator and guard model, not extra user-facing review steps.
- Source code is treated as a long-lived product surface. Files, modules, exported classes/interfaces, and non-trivial functions need concise docs, and large files use `MARK` navigation comments so reviewers can move around quickly.

## Stage 0: Plan, Threat Model, And Prevalidation

Stage 0 creates and maintains these artifacts:

- `docs/design/product-plan.md`: this staged product plan.
- `docs/design/threat-model.md`: security goals, non-goals, trust boundaries, denied behaviors, runtime assumptions.
- `docs/design/api-reference.md`: implementation-facing API contract for runtimes, cleanup, adapters, auth, diffs, planning, orchestration, tasks, memory, testing, and command surfaces.
- `docs/design/extension-points.md`: task integration and schema-bound extension point plan.
- `docs/design/work-management.md`: state-store, workspace-set, task-work-session, workspace-switching, and day-planner plan.
- `schemas/`: JSON schemas and example manifests for internal, Jira, Asana, GitHub, and custom providers.
- `docs/design/prevalidation-coverage.md`: feature-to-check coverage matrix and deferred validation notes.
- `docs/prevalidation-report.md`: generated by the prevalidation harness.
- `prevalidation.json`: machine-readable prevalidation output.
- `tools/prevalidate/`: executable TypeScript CLI used before extension work begins.

Use TypeScript for the prevalidation CLI so it shares language/runtime choices with the future extension while staying independent from VS Code APIs.

The prevalidation CLI must:

- Detect OS, shell, Node, npm/pnpm, Git, Docker, Docker Sandbox, WSL, and Codex command availability.
- Discover command paths and versions without assuming fixed install locations.
- Validate Docker Sandbox can create an isolated microVM, mount a temp project, run a command, enforce read-only mounts, enforce writable mounts, and clean up.
- Validate that runtime inventory, start counts, force cleanup tiers, quarantine, and reset-required accounting are represented before UI work begins.
- Validate Docker fallback can do the same with hardened flags where Docker Sandbox is unavailable.
- Validate WSL availability and record whether it is usable, but do not require WSL for v1.
- Validate host Codex login and protocol/capability communication without starting prompts, turns, model-output streams, tool calls, or implementation agents on the host.
- Validate Docker Sandbox Codex login and protocol communication through `sbx codex`.
- Validate Docker-container Codex login and protocol communication using an explicit credential path or token.
- Validate the Codex adapter surface: command startup, app-server JSON-RPC initialize/thread-start, app-server schema generation, exec JSON support, MCP server support, authentication availability, error reporting, and stop/cancellation control assumptions.
- Validate Codex app-server schema visibility for lifecycle events, command events, file-change/diff events, plan events, approval fields, status changes, and native collab-agent concepts.
- Validate a real Docker Sandbox Codex JSONL turn can run under a sandbox-scoped Codex service egress rule and expose turn lifecycle, agent messages, commands, command results, usage, and filesystem add/modify/delete effects through session snapshots.
- Validate an agent adapter registry that keeps Codex required while representing Claude and other provider adapters with common capability flags.
- Validate model-profile data shapes for role defaults, cost class, context budget, required runtime isolation, and provider auth references.
- Validate guard-model policy shape for untrusted prompt/context/command checks. A guard result may deny, warn, or require approval, but it cannot grant access.
- Validate a compact adversarial fixture set for repository-file, ticket, tool-output, memory, and package-script injection attempts.
- Validate source documentation conventions are represented before implementation: module/file doc comments, exported API docs, and language-native `MARK` navigation for large files.
- Validate the provider login lifecycle: auth request, user approval, secret reference, runtime reinjection, and no raw secret event storage.
- Validate access-request restart continuity by checkpointing runtime artifacts, stopping/removing a sandbox, recreating it with approved extra mounts, preserving mounted edits, restoring checkpointed artifacts, and proving sibling sessions remain running.
- Validate the product-owned role timeline model can represent parent/child sessions, categories, statuses, messages, decisions, commands, file changes, blocked states, and cancellation.
- Validate internal task, related-project history, prompt history, reviewed memory candidate, and automated-test result data shapes.
- Validate schema-bound extension contracts for internal task tracking, Jira, Asana, GitHub Issues, custom task systems, custom AI agents, runtime adapters, panel providers, memory providers, and test providers.
- Validate the internal task provider is default, local/offline capable, auth-free, and can link project folders, prompts, runs, plans, diffs, memory, automated tests, and HITL results.
- Validate work-management contracts: configured state-store paths, shared path defaults/overrides, redacted logging defaults, VSIX packaging policy, source-control branch policy, workspace sets that contain multiple projects, tasks linked to one or more workspace sets/projects, task work-session timestamps, workspace-switch semantics, and day planner data for multi-day/pushed tasks and notes.
- Validate external task provider manifests and skip live Jira/Asana/GitHub probes cleanly unless credentials are configured.
- Probe literal Codex ACP startup, JSON-RPC handshake, session creation, prompt send, event streaming, and cancellation/stop behavior inside an isolated runtime when an ACP command is installed or provided. Host ACP checks, if any, are discovery/schema/capability only.
- Probe Claude CLI noninteractive, streaming JSON, permission, and configuration surfaces when the Claude CLI is installed. Claude is optional until explicitly selected as a supported backend.
- Validate that the required Codex control surface runs inside the target sandbox image; inert host checks alone are never sufficient for implementation.
- Validate Git commands needed for clone mode: clone, worktree create/remove, developer-specified branch refs, temporary transfer branch creation, patch generation, patch apply, diff, status, and conflict detection.
- Validate filesystem policy mechanics: multi-root temp workspaces, configured shared read path, configured shared write path, denied path, plan-mode read-only behavior, and per-role workspace root access.
- Validate session diff mechanics: before/after snapshot, per-file baseline, accept baseline reset, revert from checkpoint.
- Validate that serialized diff checkpoints survive runtime restart/replay and keep per-file accept/revert semantics.
- Validate Markdown plan mechanics: create plan file, insert stable block IDs, parse block comments, mark approval state, link run IDs.
- Validate Markdown document discovery and review mechanics: find docs in configured paths, attach comments to file/line ranges or block IDs, preprocess comment intent, and propose doc updates.
- Validate orchestration mechanics without relying on hidden Codex subagent behavior: create multiple independent agent sessions/runtimes, label roles, stream their events, cancel one without killing others.
- Validate review mechanics for code and docs: create review threads, resolve comments, detect repeated themes, promote mini tasks, and delegate them without expanding agent access.
- Separately probe Codex-native subagent support if available, record it as optional capability.
- Validate HITL data shape by generating a sample verification request and round-tripping expected-result choices plus freeform notes.
- Emit a machine-readable `prevalidation.json` and human-readable `docs/prevalidation-report.md`.

Stage 0 success criteria:

- The plan is saved to disk.
- The threat model is saved to disk.
- The implementation API reference is saved to disk.
- The extension-points plan and provider schemas are saved to disk.
- The work-management plan and schemas are saved to disk.
- The prevalidation CLI runs from a clean checkout.
- It clearly reports pass/fail/optional for every required capability.
- VS Code extension scaffolding is blocked until required checks pass or are explicitly marked as deferred with a reason. Codex communication checks are required, not optional.

## Staged Delivery After Prevalidation

Stage 1 - Minimal isolated agent PoC:

- Start one Docker Sandbox per chat.
- Mount only a disposable test workspace.
- Launch the Codex adapter inside the sandbox.
- Send one prompt, stream events, stop, and clean up.
- Success: the agent runs in isolation and cannot access unmounted host paths.
- Remaining hardening from validation feeds into the Stage 2 entry gate: event ordering, failure terminal status, runtime reconciliation metadata, current-state projections, and app-server event normalization.

Stage 2 - Orchestrator and state:

- Entry deliverable: panel v0, a replaceable control-panel webview in a dedicated Activity Bar view container (`drydock`, hosting the `drydock.controlPanel` WebviewViewProvider). Buttons for isolated test prompts, the app-server probe, runtime status, and stop/cleanup; post-hoc transcript replay; visible isolation indicators (micro-VM badge, network mode, mounts). Commands and panel are thin delegations over the same `IsolatedRunService`, and activation degrades gracefully (panel renders an actionable state when `sbx` is missing).
- Add local orchestrator, SQLite event store, configured state stores, project catalog, workspace-set registry, session lifecycle, logs, cancellation, and replayable timelines.
- Exit deliverable: chat v1 in the panel — streaming transport (Codex app-server threads promoted from probe to primary, exec JSON as single-turn fallback), working end-to-end cancellation (AbortSignal through CommandRunner and adapters), durable sessions table with a history list, and multi-turn prompts against a persistent runtime. The panel transcript switches from post-hoc replay to live pushed events with durable sequence offsets.
- Chat v1 backend/UI is wired and unit-tested with fakes. Landed pieces include `ChatSessionService`, in-process event bus, durable session store, sequence-returning event store, startup reconciliation, abortable/line-streaming `CommandRunner`, app-server multi-turn transport, app-server notification normalization, panel session list/timeline/send/cancel/end handlers, and chat-first webview state. Remaining validation is live Docker Sandbox/Codex app-server verification against the installed protocol.
- Panel flow contract (supersedes an earlier "Start backend" button flow): provider and model selection is always available and is populated by an inert host API ping (`OPENAI_API_KEY` when present; static fallback otherwise) — prompts never ride that path. The micro-VM starts lazily when the first message is submitted. Changing provider/model while a backend is live ends that backend immediately; the next submitted message starts a fresh micro-VM as a new session. The panel surfaces workspace mounts (mode + runtime path + host display path), per-session changed files derived from `agent.file_edit` events, durable chat history, and runtime inventory. Deeper UX polish is deferred to the Stage 7 orchestration UI work.
- Success: a completed session can be reopened with full event history, and the panel can run, watch, cancel, and reopen a multi-turn session.

Stage 3 - Workspace policy:

- Add multi-root workspace mounting, shared paths, deny rules, plan-mode read-only, implementation-mode writable roots, and access request restart flow.
- Success: filesystem policy is technically enforced by runtime mounts, not prompt text; approved access requests restart only the affected runtime generation while preserving mounted edits, checkpointed runtime artifacts, auth references, and sibling-agent continuity.

Stage 4 - Diff review:

- Add per-session/per-file checkpoints, changed-file strip, diff viewer, accept, accept all, and revert.
- Add review threads for current session diffs and workspace diffs with file/line comments, severity, status, and links to runs.
- Success: accepted files reset their baseline independently of Git, and review comments remain attached to the relevant diff or file range.

Stage 5 - Markdown planning:

- Generate plan files with block IDs, comments, approval states, and run links.
- Discover and review Markdown documentation files in `docs/` and configured doc paths.
- Preprocess document review comments into expectations, questions, corrections, conventions, or follow-up tasks before updating docs.
- Block implementation until relevant plan blocks are approved.
- Success: implementation runs cite approved plan blocks, and doc review comments can update expectations without relying on chat history.

Stage 6 - Clone/worktree mode:

- Add disposable clones/worktrees, compare, patch apply, branch creation, and sync back.
- Success: clone sessions can iterate without live workspace access.

Stage 7 - Agent orchestration UI:

- Add researcher/planner/worker/tester/reviewer/memory roles and visual flow panel.
- UI grows inside the Stage 2 view container (sibling views plus editor-area WebviewPanels for heavy surfaces such as flow visualization); the panel architecture and message envelopes from Stage 2 are extended, not replaced.
- Add review thread views for docs and code so developers can comment on file ranges and see which comments are open, resolved, delegated, or blocked.
- Success: user can inspect what each agent did, where the task is blocked, and which review comments are still actionable.

Stage 8 - Tasks, memory, and testing:

- Add internal task registry, project/workspace-set activation, task work sessions, related task history, day planner, reviewed memory candidates, automated tests, and HITL panels. The internal task registry is the default task system when no external provider is configured.
- Add mini-task promotion from repeated review comments, with scoped agent delegation and links back to the original review threads.
- Success: a task can move from plan to implementation to verification with traceability, and repeated review feedback can become delegated mini tasks.

Stage 9 - External and remote expansion:

- Add GitHub/Jira/Asana adapters after internal task flow works, using the schema-bound task provider contract.
- Add remote/server execution only for clone mode.
- Success: remote work syncs through Git/patches without live workspace mounts.

## Test Plan

- Prevalidation tests are mandatory before product implementation.
- Runtime tests cover isolation, mount policy, cleanup, cancellation, and no network by default.
- Agent adapter tests cover sandbox execution, handshake/control lifecycle, event stream, cancellation, auth readiness, and error reporting; literal ACP coverage is required once the selected Codex adapter exposes it.
- Adapter registry tests cover Codex, Claude, generic ACP/provider adapters, shared capability flags, and provider-specific auth references.
- Runtime restart tests cover user-approved mount additions, runtime checkpoint/copy-out, stop/remove/recreate, mount expansion, artifact restore, auth reinjection, and sibling-session isolation.
- Event visibility tests cover app-server schema notifications, JSONL event streams, command execution items, turn completion/usage, and filesystem snapshots for add/modify/delete detection.
- Orchestration tests cover role session lineage, status transitions, visible decisions, command events, file-change events, blocked states, cancellation, and category grouping.
- Workspace tests cover multi-root, shared read/write, denied paths, and plan-mode immutability.
- Logging tests cover default redaction, PII-safe diagnostics, and opt-in expanded logging/metrics retention.
- Packaging tests cover VSIX generation and version increments for each installable package.
- Source-control tests cover developer-selected branches for local work and temporary branch names for cross-boundary Git transfer.
- Diff tests cover modify, delete, rename, accept, revert, baseline reset, serialized checkpoint replay, and restart persistence.
- Plan and doc-review tests cover Markdown discovery, block parsing, line-range comments, revisions, approvals, intent preprocessing, and implementation blocking.
- Code-review tests cover file/line comment threads, current-session and workspace review scopes, repeated theme detection, mini-task creation, delegation, and resolution.
- Model-routing tests cover role-to-model selection, fallback, context budgets, and the rule that routing cannot broaden runtime permissions.
- Guard tests cover command/input sanitization, indirect prompt-injection fixtures, and redaction of sensitive strings before provider submission.
- Documentation tests or lint checks cover public API docs and `MARK` navigation in large source files without requiring noisy comments on trivial helpers.
- Clone tests cover clone/worktree creation, patch generation, apply, conflicts, and sync.
- Task/memory tests cover multi-project task activation, related task discovery, prompt history, reviewed memory candidates, and automated-test artifacts.
- HITL tests cover instruction rendering, expected choices, notes, and result persistence.

## Assumptions

- Default stack: TypeScript monorepo, local SQLite, internal task registry first.
- Docker Sandbox is required for the first real runtime; Docker is a fallback, WSL is later.
- Model names in examples are aliases. A profile such as `main-worker`, `test-review`, `design-flow`, `local-guard`, or `workspace-mapper` resolves to the best configured provider/model for the user's environment.
- Local guard or mapper models run with no workspace write access, no provider secrets, and no network unless a future profile explicitly requires otherwise.
- Sandboxed Codex is the first agent backend to validate, but all product code talks through an adapter. Host checks are limited to inert discovery, auth status, schema, and capability validation. Product prompts, turns, model output, tool calls, and agent sessions run only in isolated runtimes. Literal ACP remains the compatibility target when exposed by the installed backend; app-server, MCP server, and exec JSON are acceptable Stage 0 control surfaces to prove before VS Code work begins.
- Claude is the next named adapter target. It is optional in Stage 0 unless selected for implementation, but the registry and Docker Sandbox agent template must be represented now.
- Codex-native subagents are optional; the product's reliable orchestration model is multiple controlled sessions/runtimes.
- Sources to keep aligned with: [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/), [ACP](https://agentclientprotocol.com/get-started/introduction), [ACP schema](https://agentclientprotocol.com/protocol/v1/schema), [Codex sandboxing](https://developers.openai.com/codex/concepts/sandboxing), [Codex permissions](https://developers.openai.com/codex/permissions), [Codex subagents](https://developers.openai.com/codex/subagents), [Codex worktrees](https://developers.openai.com/codex/app/worktrees), and [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview).

