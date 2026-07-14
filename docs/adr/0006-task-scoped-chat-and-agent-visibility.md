# 0006 - Task-scoped chat and agent visibility

Status: Accepted - 2026-07-06; planning/composer portion amended by
[0012](0012-planner-panel.md)

Supersedes: [0003](0003-webview-and-host-contract.md)

Refs: `docs/design/task-chat-and-agent-visibility.md`, `docs/design/subagent-workflows.md`, `docs/design/work-management.md`, `packages/contracts/src/events.ts`, `packages/contracts/src/agentTree.ts`, `packages/contracts/src/webviewMessages.ts`

## Context

The first panel treated chats as top-level objects and showed agent activity as
flat transcript text. That made the UI harder to scan once a user had more
than one body of work, and it hid important runtime context: which task owns a
chat, which workspace roots are mounted, which subagents are running, whether a
subagent has gone idle, and which provider/model is active.

This ADR carries forward ADR 0003's webview contract: model output is
untrusted, webview messages are validated, and the host remains the only side
that can touch VS Code APIs or backend services. The surface now needs a richer
product shape without weakening those boundaries.

## Decision

Drydock's primary unit of work is a task. Chats belong to tasks. Unlinked chats
may appear only as a cleanup or migration drawer; they are not the main product
stack.

The main panel uses a `Tasks | Plan | Edit | System` model:

- `Tasks` owns task selection, task state, linked chats, workspace-set links,
  attention summaries, memory, and advanced workspace-set controls.
- `Plan` owns the planning chat and opens the durable Planner workspace
  defined by 0012.
- `Edit` owns the selected implementation chat, prompt composer, transcript,
  changes,
  open questions, task notes, context mounts, and agent visibility.
- `System` owns diagnostics and low-level runtime/provider messages.

The chat transcript has two lenses over the same normalized event stream:
`Chat` for chronological conversation and `Agents` for delegated-agent status.
Provider-native subagents are visible as product events with lineage, status,
tool counts, last activity, last command word, duration, and token usage when
reported. A configurable idle threshold labels delegated agents that have not
emitted activity recently.

Planning is a place, not an Edit-composer mode (0012). Edit sessions run in
implementation mode; the internal `plan` literal is reserved for Planner and
read-only role sessions. Clone is a transfer/sync mechanism selected when a
session starts, not a mid-chat composer mode. Model selection is free within
the same provider. Changing provider restarts the backend/runtime generation
for that chat while preserving the task, transcript, and selected identity.

File references in user prompts use explicit text tokens:

- `[file:<runtime-path>]` for files already mounted into the runtime.
- `[file-unmounted:<host-path>]` for dropped host files outside known mounts.

The webview maps dragged host files to runtime paths before inserting tokens
when it can. Unmounted tokens do not grant access; they are context for the
agent to request access through the normal mount flow.

The webview may render safe structural markdown blocks, code fences with copy
buttons, and Mermaid diagrams from transcript text. Mermaid SVG is the only
rendering exception to text-only output and must use the existing sanitized,
extension-local bundle path. Raw HTML remains text.

## Consequences

Task state and chat state stay linked, so UI affordances such as notes, changes,
questions, and workspace mappings can be scoped correctly.

The webview/host message contract grows, but `parsePanelRequest` remains the
single validation gate. New host-only actions, such as clipboard writes and
provider restarts, still cross the envelope boundary explicitly.

Subagent visibility becomes a shared contract instead of a UI-only projection.
The same reducer drives the Edit session's Chat/Agents lenses and compact
task-row summaries, which keeps the scan view and detailed transcript
consistent.

The UI can show host and container paths, but path tokens are references, not
permission grants. Runtime access still follows mount policy, denied-path
checks, and runtime restart rules.
