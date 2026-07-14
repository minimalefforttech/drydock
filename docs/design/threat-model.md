# Threat Model

## Security Goals

- Keep all AI model execution, shell commands, package managers, test runners, and generated tools outside the host system.
- Keep all agent prompts, chat turns, model-generated outputs, provider tool calls, and AI protocol sessions inside isolated runtimes. Host-side provider checks are limited to inert detection, version, auth status, and schema/capability discovery.
- Treat prompts, model output, web content, repository files, review comments, and external task data as untrusted input.
- Ignore repository-supplied task-recipe prompts and automation defaults until VS Code marks the workspace trusted.
- Treat model selection as a routing decision, not a permission decision.
- Enforce filesystem access through runtime mounts and deny rules, not prompt instructions.
- Make planning sessions read-only at the runtime boundary.
- Make implementation mode writable only for approved workspace roots or approved shared write paths.
- Ensure clone mode never mounts the live workspace.
- Provide no command-level permission elevation path.
- Require user approval for adding directories, then restart the runtime with a new mount policy.
- Preserve chat/session continuity across runtime restarts by recording runtime generations, checkpointing runtime-local artifacts before stop, and leaving sibling sessions/runtimes untouched unless explicitly selected.
- Record an auditable event trail for prompts, agent events, commands, filesystem changes, approvals, plans, tests, and memory candidates.
- Redact logs, metrics, diagnostics, and audit summaries by default because prompts, tickets, paths, and tool output may contain PII.
- Keep permanent shared memory reviewable and reversible.
- Store provider authentication as external secret references and status metadata only; raw token/API-key material must never be written to events, plans, memory, or diff artifacts.
- Use lightweight guard checks for high-risk inputs and commands, especially repository instructions, ticket text, tool output, package scripts, and memory candidates. Guard checks may block, warn, or ask for approval, but they must not grant additional access.

## Non-Goals

- The extension does not try to make unsafe host execution safe.
- ACP is not treated as a security boundary.
- Prompts are not treated as access control.
- Git is not treated as the only diff source; session checkpoints are tracked separately.
- The first release does not support remote live-workspace access.
- The first release does not implement broad network access.
- The first release does not trust Codex-native subagents as the orchestration boundary.

## Trust Boundaries

- VS Code extension: trusted UI surface for the local user. It may request user decisions but does not run AI commands directly.
- Webview panels: untrusted renderers. They run under a strict CSP (no remote content, nonce-scoped scripts, extension-local resources only), receive only display-safe projections (never secrets, runtime handles, or process APIs), and every inbound message is schema-validated at the extension-host boundary before it can reach a service. Model output is rendered as text, never as markup.
- Local orchestrator: trusted local control plane. It manages sessions, policies, runtime lifecycle, event store, diffs, plans, tasks, and memory review.
- Runtime adapter: trusted policy translator for Docker Sandbox, Docker, WSL, and later runtimes.
- MicroVM/container/runtime: enforcement boundary for agent commands and filesystem access.
- Agent backend: untrusted worker from a security perspective. It can request actions only through approved protocol and runtime boundaries.
- Agent adapter: trusted protocol bridge for Codex, Claude, ACP, or other providers. It normalizes capabilities and events but is not a security boundary.
- Workspace roots: user-owned project files; readable/writable only according to session mode and policy.
- Shared read paths: readable support context; never writable by default.
- Shared write paths: explicitly writable scratch/output areas.
- External systems: untrusted data sources unless separately authenticated and scoped.

## Denied Behaviors

- Running agent commands on the host OS.
- Calling Codex, Claude, or any other AI backend directly on the host for a prompt, chat turn, agent session, tool call, or model-generated output.
- Granting `danger-full-access` or equivalent host access.
- Reusing a chat runtime across unrelated sessions without explicit policy.
- Mutating workspace roots from a planning session.
- Mounting live workspace folders in clone mode.
- Silently adding directories to the runtime.
- Restarting sibling subagents/runtimes as a side effect of one session's access request.
- Losing mounted workspace edits or approved checkpoint artifacts during an access-request restart.
- Silently storing permanent memory.
- Silently mounting host credential directories into disposable runtimes.
- Persisting raw provider secrets in local event/task/plan/memory stores.
- Persisting unredacted prompt, ticket, path, tool-output, or model-output data in logs/metrics unless expanded logging is explicitly enabled with retention and PII handling.
- Letting an agent spawn arbitrary host processes.
- Letting a subagent inherit broader access than its parent session.
- Treating user secrets, `.env` files, SSH keys, tokens, or browser profiles as readable unless explicitly configured and approved.
- Enabling network by default.
- Allowing remote/server execution against a live local workspace.
- Falling back to a different model/provider in a way that broadens mounts, network, tools, secrets, or approval policy.
- Treating agreement between multiple models as human approval or as an access-control decision.
- Treating review comments, doc comments, or subtask creation as permission to broaden access.
- Reusing arbitrary local branch names for cross-boundary code or patch transfer. Network-bound Git handoff uses product-generated temporary branch refs.

## Runtime Assumptions

- Docker Sandbox is the preferred v1 isolation target because it provides one isolated microVM per agent session.
- Docker container fallback must use hardened flags such as no network by default, `--cap-drop=ALL`, `--security-opt no-new-privileges`, CPU/memory limits, explicit mounts, and isolated working directories.
- WSL is optional for v1 and must be treated as a later adapter, not an implicit host escape hatch.
- Codex is a required Stage 0 dependency, but the product must call it through an adapter. Stage 0 validates host discovery, login/protocol availability, and schema/capability visibility only as inert host checks; Docker Sandbox and Docker-container checks validate the executable agent surfaces. Product prompts, turns, tools, chat sessions, and model output generation belong inside isolated runtimes only.
- Literal ACP is a compatibility target when exposed; app-server JSON-RPC, MCP server, and exec JSON are the required current control surfaces to prove.
- Claude and other provider backends must use the same adapter contract: explicit auth status, noninteractive execution, event streaming or parseable output, cancellation, filesystem snapshot support, and provider-specific permission controls where available.
- The external runtime boundary is the security boundary for Stage 1. Codex's inner CLI sandbox may be disabled inside the microVM for controlled smoke tests only when Docker Sandbox mounts and network policy are the active enforcement layer.
- Live Codex turns require scoped egress to the Codex service. Stage 0 must use sandbox-scoped allow rules and remove them after the validation run; global default-deny remains the baseline.
- The orchestrator can create multiple independent sessions/runtimes for roles even if Codex-native subagent support is unavailable.
- Access-request restarts replace one runtime generation at a time. Running sibling sessions remain attached to their own runtimes and do not inherit the new directory unless they request and receive their own updated policy.
- Runtime cleanup is mandatory after cancellation, failure, and normal completion.

## Model Routing Assumptions

- The orchestrator may route roles to configured model profiles to reduce cost and improve fit: main worker, tester/reviewer, design workflow, local guard, and workspace mapper are expected profile types.
- Profiles resolve to provider/model aliases, not fixed model names. Example aliases can point to Codex, Claude Sonnet, Gemini, or local models depending on installation and policy.
- Every model profile declares cost class, context budget, network requirement, auth reference, expected output schema, and allowed role types.
- A local guard or mapper model runs in a no-network, no-secret, read-only context unless explicitly reprofiled later.
- Model routing decisions are recorded with the run so audits can answer which model saw which context, why it was selected, and what budget/profile applied.
- Routing failures degrade safely: pause, retry with an approved equivalent profile, or ask the user. They do not fall back to host execution or broader access.

## Data And Audit Assumptions

- SQLite stores local durable state for sessions, events, tasks, plans, diffs, and memory candidates.
- Provider auth records store provider id, login status, secret reference, scope, and last validation time; they do not store secret values.
- Markdown plan files are user-visible artifacts, but the event store remains the authoritative workflow log.
- Git remains the authoritative source for repository history, not for per-session review state.
- Per-session diff checkpoints define what the AI changed during a session, independent of Git staging or commits.
- Runtime-local artifacts that are not on mounted paths are ephemeral unless the orchestrator copies them to a checkpoint/shared-write location before restart.
- Generated memory must be proposed with evidence and reviewed before becoming shared memory.
- Context packs should record classification metadata such as public/internal/secret-like, source type, and guard result. This keeps security visible without asking the user to read every token.
- Review comments should record source file, line range, author, intent, and
  linked task/run IDs. Delegated review-origin subtasks must preserve that
  provenance.
- Prompt and artifact retention should be configurable by class so low-risk diagnostics can expire while reviewed memory and task-linked audit evidence remain available.
- Redacted structured logging is the default. Expanded logs and metrics are an explicit configuration choice, not a hidden debugging mode.
- When expanded logging is enabled, records must carry retention class and PII policy so they can be expired, redacted, or excluded from prompts.
- Branch names recorded in tasks, reviews, or telemetry must not encode secrets, ticket bodies, prompt text, or absolute host paths.

## Stage 0 Security Gate

Before VS Code implementation begins, the prevalidation harness must prove or clearly block:

- Required commands are discoverable.
- Docker Sandbox can run isolated commands and enforce read-only/write mounts.
- Docker fallback can enforce hardened mount behavior when available.
- Host Codex login and app-server protocol/capability checks work without starting prompts, chat turns, model-output streams, tool calls, or agent sessions on the host.
- Docker Sandbox Codex has authenticated access and exposes the required adapter control surfaces from inside the target sandbox image.
- Docker-container Codex has authenticated access and exposes the required adapter control surfaces from inside a disposable hardened container.
- Docker Sandbox Codex can run one live JSONL turn with scoped Codex service egress, produce lifecycle and command events, and mutate only the disposable workspace.
- The adapter registry represents Codex, Claude, and future providers through a common capability matrix.
- Provider login flow can request user action, persist only a secret reference, reinject auth into a new runtime, and avoid raw secret storage.
- Access-request restart can checkpoint runtime-local artifacts, stop/remove/recreate the sandbox with added mounts, preserve mounted edits, and leave sibling sessions running.
- Filesystem add/modify/delete state can be derived from session snapshots even when the agent mutates files through shell commands rather than dedicated file-change protocol items.
- Codex app-server schema exposes the lifecycle, command, file-change, diff, plan, approval, status, and native collab-agent concepts needed by later backend/UI stages.
- Literal Codex ACP can start, handshake, create a session, send a prompt, stream events, and accept cancellation/stop controls when the installed backend exposes an ACP command.
- Claude CLI surfaces can be probed when installed; absence of Claude does not weaken the Codex-required Stage 0 gate.
- Model-profile configuration can represent role defaults, fallback rules, context budgets, cost class, and required runtime isolation.
- Guard policy fixtures can detect obvious indirect prompt injection and suspicious command/input patterns without requiring a live expensive model call.
- Git clone/worktree/patch flows work for clone mode.
- Local diff checkpoints can accept and revert files independently of Git.
- Serialized diff checkpoints survive runtime restart/replay.
- Durable plan artifacts can be collected, hydrated, annotated, and linked to
  tasks without treating model agreement or plan state as human approval.
- Multiple orchestrated role sessions can run independently and one can be cancelled without killing the rest.
- Role timeline, task registry, related project history, prompt history, memory review, automated-test, and HITL records can be represented before UI implementation begins.

