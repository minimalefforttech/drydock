# Drydock — Design Docs

Working documents behind the ADRs: the full architecture, security model, and
day-to-day workflows the product is built against.

## Reading order

Start with **architecture-implementation-plan**, **threat-model**, and
**workflow-scenarios** — together they explain what's being built, what it
defends against, and how it's actually used. The rest can be read in any
order as needed.

| Doc | Description |
|---|---|
| [architecture-implementation-plan](architecture-implementation-plan.md) | Accepted architecture decisions (state storage, transports, mount policy, model routing, packaging) that implementation must follow. |
| [threat-model](threat-model.md) | The security goals and invariants: isolation, untrusted input, mount-enforced access, clone-mode guarantees. |
| [workflow-scenarios](workflow-scenarios.md) | Day-in-the-life usage scenarios plus an adversarial audit of where friction matters vs. where it doesn't. |
| [roadmap](roadmap.md) | What's shipped and what's next for Drydock. |
| [product-plan](product-plan.md) | The founding product plan: scope, required saved artifacts, and the first minimal end-to-end proof. |
| [api-reference](api-reference.md) | The implementation API contract: service boundaries, durable state, command surfaces, lifecycle and cleanup rules. |
| [extension-points](extension-points.md) | The schema-bound plugin/provider plan for task systems, agents, runtimes, memory, and panels. |
| [work-management](work-management.md) | Core concepts (Project, WorkspaceSet, Task, MiniTask, …) for state stores, workspace sets, and day planning. |
| [task-board-and-subtasks](task-board-and-subtasks.md) | Subtasks, dependency-driven auto-start, and the configurable kanban Task Board panel. |
| [task-chat-and-agent-visibility](task-chat-and-agent-visibility.md) | Task-owned chat UI, context mounts, file tokens, safe transcript rendering, composer behavior, and delegated-agent visibility. |
| [task-review](task-review.md) | The cross-project review surface: aggregates existing diffs/comments and turns them into revision turns; never ships. |
| [planner](planner.md) | The full planning workspace: durable plans over disposable sessions, a configurable aspect registry, collect+hydrate persistence, and annotatable document/diagram/image/prototype providers. |
| [clone-mode](clone-mode.md) | The clone-mode operating modes and the symmetric patch sync protocol. |
| [subagent-workflows](subagent-workflows.md) | Subagent visibility and role-session workflows across Codex and Claude Code transports. |
| [prevalidation-coverage](prevalidation-coverage.md) | Maps the product feature set to the environment/provider capability checks in `tools/prevalidate/`. |

Note: the webview visual-test guide lives at
`tools/webview-harness/visual-tests.md`, not here.
