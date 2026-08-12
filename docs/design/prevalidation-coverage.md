# Stage 0 Prevalidation Coverage

This document maps the product feature set to Stage 0 validation checks. The goal is to avoid starting VS Code UI work while backend, runtime, protocol, or state assumptions are still vague.

## Coverage Matrix

| Feature area | Stage 0 validation | Status expectation |
| --- | --- | --- |
| Saved plan and threat model | `artifacts.product-plan`, `artifacts.threat-model` | Required |
| Implementation API reference | `artifacts.api-reference` checks runtime cleanup, inventory, auth, adapters, diffs, access restart APIs, command surfaces, and citations | Required |
| Extension-points plan | `artifacts.extension-points` checks task integration and schema-bound plugin/provider planning | Required |
| Work-management plan | `artifacts.work-management` checks configured state stores, workspace sets, task work sessions, workspace switching, and day planning | Required |
| Provider schemas and manifests | `integrations.extension-contracts` validates schemas plus internal, Jira, Asana, GitHub, and custom provider manifests | Required |
| Work-management schemas | `work.work-management-contracts` validates configured state paths, shared path defaults/overrides, redacted logging defaults, VSIX packaging policy, source-control branch policy, workspace sets, task links, work-session timestamps, and day planner pushes/notes | Required |
| Required commands | Node, npm, Git, Docker, Docker Sandbox, Codex discovery/version checks | Required |
| Optional runtimes | WSL discovery/status | Optional for v1 |
| Docker Sandbox isolation | Create shell sandbox, mount workspace, configured shared read-only, configured shared write, cleanup | Required |
| Docker fallback isolation | Hardened Docker run with no network, dropped caps, no-new-privileges, mounts | Required |
| Windows validation runtime host | `hyperv.features` reads `Win32_OptionalFeature` install state for Hyper-V, hypervisor, services, and the management PowerShell module plus the `vmms` service state; `hyperv.admin` reads Hyper-V Administrators SID membership in the current logon token | Optional while ADR 0022 is Proposed; fix-needed rows name the enable/join command and never block the Stage 0 gate |
| Validation runtime storage and exec channel | `hyperv.storage` measures free space on the planned VM disk and curated `P:` mirror volumes against the 150 GB combined floor; `hyperv.ssh` resolves the native Windows OpenSSH `ssh.exe` the star-topology exec channel spawns | Optional while ADR 0022 is Proposed; shim scripts on PATH report as fix-needed because the adapter spawns `ssh.exe` directly |
| DCC license server configuration | `hyperv.license-server` validates the `DRYDOCK_LICENSE_SERVER` host:port shape that seeds the validation runtime's vNIC allowlist | Optional until the endpoint is configured; configuration presence only, no reachability probe |
| Codex host protocol | Standalone Codex login, doctor, app-server schema, app-server JSON-RPC thread start, exec JSON, MCP server | Required |
| Codex Docker Sandbox protocol | Codex sandbox create, login, app-server schema, app-server JSON-RPC thread start, exec JSON, MCP server | Required |
| Codex Docker container protocol | Disposable Linux Codex image, explicit auth import, app-server JSON-RPC thread start, login, exec JSON, MCP server | Required |
| Codex event visibility | Generated app-server schema includes lifecycle, status, command, file-change, diff, plan, approval, and collab-agent concepts | Required |
| Agent adapter registry | Common adapter registry with Codex required, Claude optional, generic ACP/provider slots, auth references, and capability flags | Required |
| Model routing profiles | Role defaults for main worker, test/review, design, local guard, and workspace mapper include provider/model alias, cost class, context budget, auth refs, and runtime isolation requirement | Required data-shape validation; live non-Codex probes optional until configured |
| Local guard evaluation | Guard policy can represent allow/warn/needs-approval/deny decisions for prompts, commands, tool output, package scripts, and memory candidates without granting access | Required data-shape validation; live local model optional until configured |
| Provider auth lifecycle | `sbx secret ls` plus auth request/approval/secret-reference/reinjection data shape with no raw secret event storage | Required |
| Adversarial fixture pack | Small fixture set covers repo-file, ticket, tool-output, package-script, and memory prompt-injection attempts | Required lightweight static validation |
| Source documentation and navigation | Coding standards require file/module docs, exported API docs, and language-native `MARK` navigation comments for large files | Required documentation standard; lint automation begins in Stage 1 |
| Live Codex turn | Docker Sandbox Codex `exec --json` runs in disposable workspace with sandbox-scoped Codex service egress | Required |
| File add/modify/delete visibility | Live Codex JSONL exposes turn and command activity; session snapshots prove added, modified, and deleted files | Required |
| Literal ACP | `CODEX_ACP_COMMAND`, `codex-acp`, or advertised `codex acp` compatibility probe | Optional until an installed backend exposes it; Codex app-server remains required |
| Claude CLI adapter surface | Local `claude` CLI noninteractive, JSON/streaming, permission, and config/MCP surfaces when installed | Optional until Claude is selected as a backend |
| Native Codex subagents | Help/schema probe for native subagent/collab-agent concepts | Optional capability; product orchestration does not depend on it |
| Product-owned orchestration | Multiple independent role jobs, cancellation isolation, role timeline model with parent/child sessions and visible events | Required |
| Multi-root and mount policy | Plan/implementation/clone mode mount planner, per-role workspace root access, configured shared read/write paths, denied path representation | Required |
| Workspace sets | Product-owned workspace sets detached from the current VS Code workspace, with activation/projection and switch semantics | Required |
| Runtime restart continuity | Create sandbox, write mounted edit, checkpoint runtime-local artifact, stop/remove/recreate with new mounts, restore artifact, preserve sibling sessions | Required |
| Session diff | Before/after snapshots, add/delete/modify/rename, per-file accept, per-file revert | Required |
| Restart diff persistence | Serialize and rehydrate per-session diff checkpoints across runtime restart while preserving per-file accept semantics | Required |
| Markdown planning | Stable block IDs, comments, approval state, run links | Required |
| Markdown document review | Discover Markdown docs in `docs/` and configured paths, attach file/line comments, preprocess intent, and propose doc patches | Required data-shape validation |
| Code review workflow | Current-session/workspace/patch review sessions, file-line comments, thread status, repeated theme detection, and mini-task promotion | Required data-shape validation |
| Clone/worktree mode | Clone, worktree add/remove, developer branch refs, temporary transfer branch refs, binary patch, apply, status, conflict detection | Required |
| VSIX packaging | VSIX package creation, version increment per package, and no marketplace/store publishing command path | Required before extension install handoff |
| Internal task registry | Default local task provider, no auth, offline operation, multi-project activation, related task discovery, prompt history, run links | Required |
| Task work sessions | Track task `updatedAt`, `lastWorkedAt`, workspace set, project IDs, run IDs, diff checkpoints, tests, and notes | Required |
| Day planner | Map tasks to days and multi-day spans, push tasks with reasons, and record notes per day/task/work session | Required |
| External task adapters | Jira, Asana, GitHub Issues manifests, canonical task mappings, credential-gated read-only live probes | Required static validation; live probes optional unless credentials are configured |
| Memory | Reviewed memory candidate with evidence and approval metadata | Required data-shape validation |
| Automated testing | Command result, exit code, stdout/stderr refs, artifact refs | Required data-shape validation |
| HITL testing | Instructions, snippets, expected choices, freeform notes, selected result | Required |
| Visual agent panel | Backend-visible role/session/event/status/file-change model | Required data-shape validation; actual UI deferred |
| External task adapter implementation | GitHub/Jira/Asana runtime sync, mutation, and webhook handling | Deferred until internal task registry works |
| Remote/server mode | Clone-only remote execution | Deferred to Stage 9 |

## Backend Conclusions

- UI diff state must not rely only on Codex file-change protocol items. Shell commands can change files without a dedicated file-change item, so the product must combine protocol events with per-session filesystem snapshots.
- Docker Sandbox global network policy can remain default-deny, but live Codex turns require sandbox-scoped egress to Codex service hosts: `chatgpt.com:443`, `ab.chatgpt.com:443`, `files.openai.com:443`, and `api.openai.com:443`. The harness adds and removes those scoped rules during validation.
- Product-owned orchestration remains the reliable model. Native Codex collab-agent/subagent concepts are visible in the schema, but the product must still control roles as separate sessions/runtimes.
- Documentation and code review should share one review-thread model: file path, line range, optional stable block ID, comment body, intent, status, and provenance.
- Review comments become structured workflow inputs before they reach agents. The preprocessor extracts intent and risk, then either proposes doc patches, leaves questions open, or creates mini-task proposals.
- Mini tasks are a convenience layer over review comments. They must inherit the original review scope and runtime policy, so delegating a fix cannot widen access.
- Model routing is a cost and capability optimization, not an authorization mechanism. Switching from Codex to Sonnet, Gemini, or a local model must preserve the same runtime mount, network, tool, and secret policy for the role.
- Local guard and workspace-mapper profiles should use small context packs, no network, no secrets, and read-only inputs by default. Their value is catching obvious risky input before expensive or capable worker models see it.
- Adversarial fixtures should stay small enough to run often. They prove that untrusted text is handled as data and that model agreement is never treated as user approval.
- Logs, metrics, and diagnostics are redacted by default because PII may appear in prompts, tickets, paths, command output, and model output. Expanded logging is useful for development but must be opt-in, retained by class, and excluded from prompts unless explicitly allowed.
- Code readability is a security control. File/module docs, exported API docs, and `MARK` navigation reduce review fatigue and make it easier to spot unsafe boundaries in large files.
- Codex's inner CLI sandbox can conflict with Docker Sandbox path mounts. Stage 0 validates live turns by using Docker Sandbox as the enforcement boundary and disabling the inner Codex sandbox inside the microVM.
- Current Codex builds expose `app-server` as the rich-client JSON-RPC interface. The harness does not guess `codex acp` unless the installed help advertises that subcommand, because otherwise Codex treats `acp` as an interactive prompt and fails in non-TTY automation.
- Access requests are implemented as runtime-generation changes: checkpoint, stop/remove, recreate with expanded mounts, restore checkpointed artifacts, and continue the same chat/session. Sibling subagents keep running in their own runtimes and do not inherit new mounts automatically.
- Runtime cleanup is a tracked backend service, not a best-effort exit hook. Every started sandbox/container is counted, reconciled against `sbx ls` and `docker ps -a`, and moved through graceful cleanup, force remove, quarantine, or reset-required states.
- Provider auth is a secret-reference problem, not a mount problem. Codex is required now; Claude and later providers must use the same explicit login prompt, secret reference, scoped reinjection, and no-raw-secret persistence model.
- Claude support is represented in Stage 0 through the adapter registry and Docker Sandbox `claude` template discovery. A local Claude CLI probe is optional until Claude is selected for implementation.
- The internal task provider is required and remains available without network, credentials, or external APIs. Jira, Asana, GitHub, and custom systems are adapters around the canonical local task model.
- All provider categories must be schema-bound before UI work depends on them: task providers, agent providers, runtime adapters, panel providers, memory providers, and test providers.
- Product workspaces are workspace sets stored in configured state stores. The current VS Code workspace is only an activation/projection and can be swapped without losing task identity, work-session history, diff checkpoints, or day-planner state.
- Shared path defaults come from config: studio/package paths are read-only, approved shared libraries are read-write, and workspace roots still follow the active agent role/session mode.
- Local development may use developer-selected branches. Any Git branch used to move code across a network boundary is a temporary product-generated ref linked to the task/review session.
- Packaging stays VSIX-only until that policy changes, so validation should prove package creation and version increments rather than marketplace publishing.
- The Hyper-V gates report configuration facts and take no side effects. They run fixed-literal PowerShell with parameters passed as environment variables and read as `$env:NAME`, and they create no switch, no VM, and no network connection. The first state change belongs to the M1a hardware smoke, not to prevalidation.
- Hyper-V Administrators membership is a logon-token fact, so an account added to the group still reports fix-needed until the user signs out and back in. That is the honest state: `Get-VM` and the `hyperv` adapter fail with access denied until the token carries `S-1-5-32-578`.
- The license server is configuration-gated, not reachability-gated. The studio license service is not reachable from every workstation, so a red row for a correct-but-unreachable endpoint would train people to ignore the section; the validation runtime proves reachability during the M1 spike instead.

