# Drydock - ADRs

Keep this folder small. ADRs are for decisions we do not want to re-argue.
Implementation details live in `docs/design/`.

Prefer merging or superseding an existing ADR over adding a near-duplicate.
There is no fixed cap on the count — it grows as genuinely distinct decisions
land.

| Number | Title | Status | Summary |
|---|---|---|---|
| [0001](0001-runtime-isolation-and-access-policy.md) | Runtime isolation and access policy | Accepted | Agents run in disposable runtimes. Host access is through approved mounts only. |
| [0002](0002-product-owned-orchestration.md) | Product-owned orchestration | Accepted | Drydock owns sessions, events, and per-subtask provider/model selection. Adapters convert provider-specific streams without widening access. |
| [0003](0003-webview-and-host-contract.md) | Webview and host contract | Superseded by 0006 | Webviews render untrusted text safely and talk to the host through validated messages. |
| [0004](0004-workspace-isolation-and-review-flows.md) | Workspace isolation and review flows | Accepted | Clone work uses real clones. Review views do not ship work. Review authorship is explicit and windows coordinate by heartbeat. |
| [0005](0005-product-identity-and-namespace.md) | Product identity and namespace | Accepted | The product is Drydock. Public ids use `drydock.*`, `@drydock/*`, and `drydock-baseline`. |
| [0006](0006-task-scoped-chat-and-agent-visibility.md) | Task-scoped chat and agent visibility | Accepted | Sessions belong to tasks. The four-tab task surface separates planning from implementation and exposes safe transcripts plus delegated-agent visibility. |
| [0007](0007-task-board-subtasks-and-auto-start.md) | Task board and bounded subtask workflows | Accepted | Same-task DAG subtasks, data-driven recipes, verification requirements, and opt-in auto-start. Recipes create but never start work or carry ambient access. |
| [0008](0008-session-ownership-and-reclaim.md) | Session ownership and reclaim | Accepted | Fresh foreign heartbeats make sessions read-only here. Takeover is explicit and restores durable context plus approved mounts. |
| [0009](0009-apply-access-before-approval.md) | Apply access before approval | Accepted | Runtime mounts are applied before an access request is marked approved. Failed applies leave the request pending. |
| [0010](0010-diff-view-frames.md) | Diff view frames | Accepted | Sessions keep an immutable session-start, a working, and a per-turn baseline frame. The Changes list toggles This Turn / Session / Full Session; accept advances working+turn only. |
| [0011](0011-chat-summarize-export.md) | Chat summarize export | Accepted | Chat digests (trimmed log or AI summary) are host-built from stored events and go to the clipboard, never the chat. The AI flavor runs on a sidecar connection beside the live runtime; nothing is persisted or published. |
| [0012](0012-planner-panel.md) | Planner panel | Accepted | Plans are first-class durable artifacts with aspects, collect+hydrate persistence, annotations, revision, and previewed checklist-to-board materialization. The composer plan switch and plan-docs surface are retired. |
| [0013](0013-agents-panel.md) | Agents panel and fleet presentation | Accepted | A session-aware fleet projection prioritizes attention, honest lifecycle state, configurable density, live token usage, and landing visibility. |
| [0014](0014-changeset-chaining-and-landing.md) | Changeset chaining and landing | Accepted | Review-entry changesets can seed dependent clone runs by explicit user choice and land through the existing full-pull path with overlap warnings. |
| [0015](0015-bounded-fleet-orchestration.md) | Bounded fleet orchestration | Accepted | Durable run slots, queue/restore, retry-once-then-park, and double-opt-in task FAQ answers bound automation without automating access. |
| [0016](0016-human-gates.md) | Human gates | Accepted | Questions carry sandbox images; `manual-check` kind folds HITL steps, receipts, and verify stamping into one card; HITL stays a protocol layer behind the Lead's inbox, not a new surface. |
