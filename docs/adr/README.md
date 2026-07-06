# Drydock - ADRs

Keep this folder small. ADRs are for decisions we do not want to re-argue.
Implementation details live in `docs/design/`.

Prefer merging or superseding an existing ADR over adding a near-duplicate.
There is no fixed cap on the count — it grows as genuinely distinct decisions
land.

| Number | Title | Status | Summary |
|---|---|---|---|
| [0001](0001-runtime-isolation-and-access-policy.md) | Runtime isolation and access policy | Accepted | Agents run in disposable runtimes. Host access is through approved mounts only. |
| [0002](0002-product-owned-orchestration.md) | Product-owned orchestration | Accepted | Drydock owns sessions and events. Adapters convert provider-specific streams. |
| [0003](0003-webview-and-host-contract.md) | Webview and host contract | Superseded by 0006 | Webviews render untrusted text safely and talk to the host through validated messages. |
| [0004](0004-workspace-isolation-and-review-flows.md) | Workspace isolation and review flows | Accepted | Clone work uses real clones. Review views do not ship work. Windows coordinate by heartbeat. |
| [0005](0005-product-identity-and-namespace.md) | Product identity and namespace | Accepted | The product is Drydock. Public ids use `drydock.*`, `@drydock/*`, and `drydock-baseline`. |
| [0006](0006-task-scoped-chat-and-agent-visibility.md) | Task-scoped chat and agent visibility | Accepted | Chats belong to tasks. The Chat surface exposes context, safe rich transcript blocks, and delegated-agent visibility. |
| [0007](0007-task-board-subtasks-and-auto-start.md) | Task board, subtasks, and auto-start | Accepted | Subtasks with same-task acyclic dependencies on a category-driven board. Auto-start is per-subtask opt-in; automation never forces and never passes Review. |
