# 0001 - Runtime isolation and access policy

Status: Accepted - 2026-07-06

Refs: `docs/design/threat-model.md`, `docs/design/architecture-implementation-plan.md`, `docs/design/workflow-scenarios.md`, `docs/design/subagent-workflows.md`

## Context

Agents can run commands directly on the host workstation. They should not run them on the developer's host.
Provider sandboxes are also not enough; Drydock needs one access model that
works the same way across providers.

Users still need to grant useful access without being asked to approve every
small action.

## Decision

Each agent session runs in a disposable runtime. The extension host may do
safe adapter work, such as provider detection, auth checks, and schema lookup.
It does not run model calls or agent tools.

Filesystem access is only through explicit mounts from workspace policy. We
check denied paths when building mounts and again when approving them.
Filesystem roots are not mountable. When access expands, we checkpoint the
session, recreate the runtime with the new mounts, and resume.

Approval cost follows risk:

- Safe, reversible, contained actions stay one click.
- Broad, writable, or sensitive mounts need a typed confirmation.
- Visibility-only features should not add prompts.

Role child sessions only get a subset of the parent's mounts. We enforce that
when the child is created and again on later access requests.

## Consequences

Session risk is bounded by the mount set. We need a grants ledger, runtime
cleanup, and enough saved state outside the runtime to survive restarts.

New UI actions need a risk level before we add prompts. Do not add a modal just
because the action feels important.
