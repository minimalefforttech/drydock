# Drydock - Design Docs

Focused documents behind the ADRs: current feature behavior, security
invariants, and day-to-day workflows. The older Stage 0/1 plans remain useful
build history, but current ADRs and the TypeScript contracts win wherever old
stage terminology disagrees.

## Reading order

Start with the [ADR index](../adr/README.md), **roadmap**, **threat-model**, and
**workflow-scenarios**. Then read the focused feature document for the surface
you are changing.

| Doc | Description |
|---|---|
| [architecture-implementation-plan](architecture-implementation-plan.md) | Historical staged implementation plan. Retained for rationale; later ADRs and current feature docs supersede retired flows. |
| [threat-model](threat-model.md) | The security goals and invariants: isolation, untrusted input, mount-enforced access, clone-mode guarantees. |
| [studio-security-policy](studio-security-policy.md) | Administrator-managed project, clone, omission, and allocated-machine network guardrails, plus personal narrowing settings. |
| [workflow-scenarios](workflow-scenarios.md) | Day-in-the-life usage scenarios plus an adversarial audit of where friction matters vs. where it doesn't. |
| [roadmap](roadmap.md) | What's shipped and what's next for Drydock. |
| [product-plan](product-plan.md) | Historical founding plan: scope, saved artifacts, and staged proof goals. |
| [api-reference](api-reference.md) | Design-level service reference. `packages/contracts` and exported interfaces are authoritative for implemented shapes. |
| [extension-points](extension-points.md) | Forward-looking schema-bound plugin/provider plan for task systems, agents, runtimes, memory, and panels. |
| [work-management](work-management.md) | Product concepts for projects, workspace sets, tasks, review-origin subtasks, work sessions, and future day planning. |
| [task-board-and-subtasks](task-board-and-subtasks.md) | Subtasks, recipes, bounded dependency automation, verification markers, and the configurable kanban panel. |
| [task-chat-and-agent-visibility](task-chat-and-agent-visibility.md) | Task-owned Edit UI, context mounts, file tokens, safe transcript rendering, and delegated-agent visibility. **Its four-tab sidebar model is superseded by ADR 0020** (calm-workbench shell): the chat now lives in the chat rail, Plan in the Planner panel, Tasks in the left rail + Task Hub, System in Configure. |
| [task-review](task-review.md) | The cross-project review surface: aggregates existing diffs/comments and turns them into revision turns; never ships. |
| [mcp-and-memory](mcp-and-memory.md) | MCP server registry with global→workspace→task→chat toggle cascade, and scoped memory (global/workspace/task + glob-rule tags detected at mount time) with quick-add and agent-proposed, edit-before-approve commits. |
| [code-review-panel](code-review-panel.md) | In-panel GitHub-style review (v2 of task-review): continuous diff scroll, scope toggle, inline multi-range comments routed to owning agents. Prototype: `prototypes/code-review-panel.html`. |
| [planner](planner.md) | Durable planning over disposable sessions, annotatable artifact providers, and literal-checklist materialization to the board. |
| [agents-panel](agents-panel.md) | Fleet sessions, delegated agents, attention, density, live token scope, honest boot state, and changeset landing. Its grouped density grid is superseded by ADR 0020's flat row list. |
| [onboarding-and-help](onboarding-and-help.md) | Shared tooltips, help pages, spotlight tours, and sidebar-to-editor-panel guide handoffs. |
| [clone-mode](clone-mode.md) | Clone operating modes, symmetric patch sync, user-selected changeset chaining, and landing semantics. |
| [subagent-workflows](subagent-workflows.md) | Subagent visibility and role-session workflows across Codex and Claude Code transports. |
| [prevalidation-coverage](prevalidation-coverage.md) | Original Stage 0 coverage map; useful for the environment/provider gate, not a current feature inventory. |
| [ux-overhaul-implementation](ux-overhaul-implementation.md) | Phased build plan for the calm-workbench shell (left rail, active-task spine, task hub, chat rail, quick chat, agents clarity, configure, control-panel retirement). Design: `docs/ideas/ux-overhaul-calm-workbench.md`. |
| [windows-dcc-runtime/](windows-dcc-runtime/README.md) | ADR 0022 docset (proposed): pooled Hyper-V validation runtime for Windows-native mayapy/hython + studio rez packages — upgrade plan, curated-`X:` security model, fixture flow, UX flows with annotated mockups, edge-case catalog. |

Note: the webview visual-test guide lives at
`tools/webview-harness/visual-tests.md`, not here.
