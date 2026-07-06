# 0002 - Product-owned orchestration

Status: Accepted - 2026-07-06

Refs: `docs/design/api-reference.md`, `docs/design/product-plan.md`, `docs/design/subagent-workflows.md`, `packages/contracts/src/events.ts`

## Context

Providers expose different streams and subagent features. Some have child
threads, some have JSONL, and some have task sidechains. Drydock should not
make one provider's internal model the product model.

## Decision

Drydock owns the session and runtime. Product-owned role sessions are created,
cancelled, resumed, and checked by Drydock.

Provider-native subagents are fine when available, but they are only observed
inside the parent runtime. They are not the access or lifecycle boundary.

Adapters convert raw provider output into the shared `AgentEvent` union before
anything reaches storage or UI. Keep the raw provider line on `event.raw` when
it helps with debugging or backfill.

Events may include `agentPath`. `[]` means the root agent; child ids are
transport-scoped. Delegation uses `agent.spawn` and `agent.node_done`. Only the
root agent can finish the product run.

Before freezing a provider contract, run a live probe for the feature and keep
a trimmed capture as a normalizer fixture. Synthetic fixtures are allowed, but
they must say what real probe is still missing.

## Consequences

Adding a provider means writing a normalizer, not forking the app. Unsupported
subagent visibility is shown as unsupported. Per-child cancel stays out until a
transport can actually do it.
