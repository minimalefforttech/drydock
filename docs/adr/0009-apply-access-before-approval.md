# 0009 - Apply access before approval

Status: Accepted - 2026-07-08

Refs: `docs/adr/0001-runtime-isolation-and-access-policy.md`, `apps/vscode-extension/src/services/workspaceReviewAppService.ts`, `apps/vscode-extension/src/webview/controlPanelProvider.ts`

## Context

Access requests expand the runtime mount set. If a request is marked approved
before the runtime has actually been recreated with the new mount, the UI and
ledger can claim access exists while the running session still lacks it.

## Decision

Approving an access request prepares the requested grant, applies the mount to
the session runtime, then marks the request approved.

If applying the mount fails, the request stays pending and can be retried. A
denial resolves the request without applying any mount.

Do not keep an in-memory batch of approved-but-unapplied grants. Durable
approved roots are the source of truth for later resume and reclaim.

## Consequences

Approval may restart the runtime immediately instead of batching several grants
together. In exchange, the access ledger, UI state, and runtime mounts stay in
the same order and failed approvals remain visible.
