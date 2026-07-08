# 0008 - Session ownership and reclaim

Status: Accepted - 2026-07-08

Refs: `docs/adr/0004-workspace-isolation-and-review-flows.md`, `packages/core/src/chatSessionService.ts`, `apps/vscode-extension/src/webview/controlPanelProvider.ts`, `apps/vscode-extension/src/services/isolatedRunService.ts`

## Context

The same Drydock state root can be open in more than one VS Code window. A
session may also survive host reloads, so the user needs a way to resume work
without letting two windows mutate one live runtime at the same time.

## Decision

A fresh heartbeat from another host means the session is running elsewhere.
This host shows it as read-only and refuses mutating actions such as stop,
delete, and direct session edits.

Taking over is an explicit operation. Reclaim first claims ownership, then
starts a fresh runtime for this host and restores the session context.

Reclaim restores the persisted project roots and approved mounts. It does not
depend on stale in-memory mount state from the previous host.

## Consequences

Two windows cannot silently stop or delete each other's active sessions. A
reload or second window still has a visible escape hatch: take over here, then
continue with the same durable context and approved access.
