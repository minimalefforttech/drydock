# 0011 - Chat summarize export

Status: Accepted - 2026-07-10

Refs: `docs/adr/0002-product-owned-orchestration.md`, `docs/adr/0006-task-scoped-chat-and-agent-visibility.md`, `packages/core/src/chatExport.ts`, `packages/core/src/chatSessionService.ts`

## Context

Handing a chat's substance to another person, another session, or another
model meant hand-copying transcript fragments. The webview transcript is the
wrong source for that: its lines are display projections clipped at 400
characters, while full-fidelity text exists only in the durable event store.
An AI-written summary needs a model turn, but every existing turn path
persists its events and publishes to the transcript bus - and the architecture
forbids host-side model calls (prompts only run inside isolated runtimes).

## Decision

Summarize is a host-built export with two flavors, both delivered to the
system clipboard and never into the chat:

- **Chat log** - a pure projection of the stored events
  (`buildChatLog`): the user/assistant dialogue exactly as
  `contextMessages` restores it (host briefing stripped, reasoning and
  command/tool chatter dropped, only final agent text), plus a files-touched
  list from `agent.file_edit` events. File labels use the shortest trailing
  path segments unique within the list, prefixed with the project name when
  the session mounted more than one root - token-lean by construction.
- **AI summary** - the chat log embedded in a fixed-structure prompt
  (`buildSummaryPrompt`), answered through a **sidecar connection**
  (`runSidecarPrompt`): a second, synthetic-id adapter connection on the
  session's already-running runtime. Nothing is appended to the event store
  and nothing is published, so the transcript is untouched by construction.
  Adapter connection ids are derived from generation + agent id so a sidecar
  can never collide with the session's own connection state.

The host writes the clipboard itself (no webview round-trip, no payload
bound), and the AI flavor is asynchronous: the request acks immediately and
completion arrives as a `session.summaryReady` push, because a model turn can
outlive the webview request timeout.

## Consequences

- Copying a session digest works for any stored session; the AI flavor
  additionally requires the session live in the current window (the sidecar
  rides its runtime - no runtime, no model). Ended sessions offer the log and
  a disabled AI item that says to resume first.
- The AI exchange shares the runtime's resources but not its conversation
  thread; the summary prompt is exactly the exportable log, so the model sees
  nothing the user could not paste themselves.
- One summarize per session at a time (service-side guard); the panel keeps a
  single in-flight indicator and recovers via a safety timeout if the
  completion push is lost. The clipboard still lands host-side in that case.
