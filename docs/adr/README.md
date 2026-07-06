# Drydock - ADRs

Keep this folder small. ADRs are for decisions we do not want to re-argue.
Implementation details live in `docs/design/`.

Until first release, keep at most five active ADRs. If we need a sixth, merge
or replace one first.

| Number | Title | Status | Summary |
|---|---|---|---|
| [0001](0001-runtime-isolation-and-access-policy.md) | Runtime isolation and access policy | Accepted | Agents run in disposable runtimes. Host access is through approved mounts only. |
| [0002](0002-product-owned-orchestration.md) | Product-owned orchestration | Accepted | Drydock owns sessions and events. Adapters convert provider-specific streams. |
| [0003](0003-webview-and-host-contract.md) | Webview and host contract | Superseded by 0006 | Webviews render untrusted text safely and talk to the host through validated messages. |
| [0004](0004-workspace-isolation-and-review-flows.md) | Workspace isolation and review flows | Accepted | Clone work uses real clones. Review views do not ship work. Windows coordinate by heartbeat. |
| [0005](0005-product-identity-and-namespace.md) | Product identity and namespace | Accepted | The product is Drydock. Public ids use `drydock.*`, `@drydock/*`, and `drydock-baseline`. |
| [0006](0006-task-scoped-chat-and-agent-visibility.md) | Task-scoped chat and agent visibility | Accepted | Chats belong to tasks. The Chat surface exposes context, safe rich transcript blocks, and delegated-agent visibility. |
