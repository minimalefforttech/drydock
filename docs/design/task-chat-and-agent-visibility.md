# Task Chat And Agent Visibility

> **Superseded in part by ADR 0020 (calm-workbench shell).** The chat, mounts,
> file tokens, transcript rendering and delegated-agent rules below are current.
> The four-tab sidebar that hosted them is not: the chat moved to the chat rail
> (`drydock.chatRail`), Tasks to the left rail + Task Hub, Plan to the Planner
> panel, System to Configure and the Agents panel's Runtimes fold. Read tab
> names below as the surface that inherited them.

## Purpose

This document describes the current panel contract behind ADRs 0006 and 0012.
It covers the task-owned Edit stack, the Chat/Agents lenses, composer behavior, file
reference tokens, safe transcript rendering, and the runtime context shown to
users.

The goal is a work surface that answers the questions a user has while an agent
is running:

- What task am I working on?
- Which chat is active for that task?
- What workspace roots will the runtime see?
- What is the agent doing now, including delegated agents?
- Which provider/model/thinking settings will the next prompt use?
- Which files did I explicitly attach as context?

## Panel Structure

The activity-bar panel has four top-level tabs:

| Tab | Responsibility |
|---|---|
| `Tasks` | Task list, task state, linked chats, workspace-set links, attention summary, memory, and advanced workspace-set controls. |
| `Plan` | Planning chat and entry to the durable Planner workspace from ADR 0012. |
| `Edit` | Selected implementation chat, transcript, open questions, changes, task notes, context mounts, delegated-agent visibility, and prompt composer. |
| `System` | Diagnostics, backend/runtime/provider messages, and low-level debugging output. |

Chats should normally be reached through a task. A task card owns its linked
chat dropdown and highlights the active task. Chats without a task appear in a
collapsed cleanup drawer so they can be linked or deleted, but they do not
compete with tasks as primary navigation objects.

Delete actions for tasks, chats, and notes use an inline confirmation state
whose label is `Confirm`. The confirm state should be local to the clicked
control and should not block unrelated interaction.

## Edit Layout

The Edit tab is a full-height panel:

1. Header and context controls.
2. Scrollable chat body.
3. Pinned composer at the bottom.

The scrollable body owns transcript, open questions, changed files, and task
notes. Each section has a useful minimum height and can scroll internally when
expanded content would otherwise compress the rest of the panel. The composer
never scrolls away.

Open questions render outside the transcript region and only appear when
pending questions exist. Their heading is `Open Questions:`. Diagnostics do not
live in the Edit tab; they belong to `System`.

Task notes are plain, task-scoped user notes. They can contain indented or
code-like text, but they are not review comments and do not carry file/line
semantics. Existing notes render above the note input.

## Context Mounts

The context strip shows the workspace context for the selected chat.

When a runtime isolation snapshot exists, the strip shows the actual mounts
reported by the backend. When no runtime exists yet, the strip shows planned
mounts derived from the selected workspace mode and the open folders or
workspace set.

Planned auto mounts use deterministic runtime roots:

```text
/workspace/root-1 <- C:\path\to\first-project
/workspace/root-2 <- C:\path\to\second-project
```

Planner and read-only role sessions map context roots read-only. Edit sessions
map them read-write when policy allows. Clone sessions show clone context and
the explicit "no live mounts" note because changes reach the host through clone
sync.

The strip is informational; it does not grant access by itself.

## Composer

The composer is a single command box inspired by modern coding assistants. It
contains:

- A multiline prompt field.
- Provider, model, and thinking-effort controls.
- Send and cancel actions.

Edit sends always use implementation mode. Planning starts from the Plan tab
and runs in the Planner's read-only context; clone mode is selected by the
task/subtask start flow and then exposes sync controls in the session. The
retired `Plan | Develop` switch is not part of the composer.

Changing model within the selected provider only updates the picker and affects
future sends. Changing provider sends `chat.restartBackend` so the host can
checkpoint/restart the runtime with the new provider while preserving the
session, task link, and transcript.

The composer must not overflow at sidebar widths. At narrow widths it may use a
two-row footer: prompt/send controls on the command row and provider/model/
thinking controls on a settings row. At wider widths it may collapse to one row.

## File Reference Tokens

Users can drag files onto the prompt input or composer. Dropped files are
inserted as text tokens in the prompt.

Mounted files use the runtime path:

```text
[file:/workspace/root-1/src/example.ts]
```

Unmounted files use the host path:

```text
[file-unmounted:C:/outside/example.ts]
```

Token payloads are URI-encoded enough to survive spaces and square brackets.
The display renderer decodes them for labels and tooltips.

Rules:

- `file:` tokens are context references to paths the container can already see.
- `file-unmounted:` tokens are not permissions. They tell the agent a file
  exists outside the current mount set, so normal access-request flow can be
  used if needed.
- In the chat log, file tokens display as `[filename]`.
- Hovering a mounted token shows both container and host paths when the mapping
  is known.
- Hovering an unmounted token shows the host path and the "not mounted" state.

## Transcript Rendering

The transcript region uses a darker background than the surrounding UI so the
conversation remains visually distinct from controls, changes, and notes.

Assistant text is rendered as safe structural blocks:

- headings, paragraphs, lists, and block quotes;
- fenced code blocks with a top-right copy icon;
- Mermaid fences rendered as diagrams with icon controls to copy source and
  toggle between diagram and source.

Raw HTML is never adopted from model output. It is displayed as text. Dynamic
strings enter the DOM through text nodes. Code blocks support multiline content
and follow the `drydock.codeBlockWordWrap` setting.

Mermaid rendering uses the extension-local diagram bundle. The panel allows the
minimum CSP relaxation needed for Mermaid's scoped SVG styles, and only for
this webview. Mermaid init/config directives from agent text are stripped before
rendering.

Clipboard writes cross the host boundary through the validated
`clipboard.writeText` request. The fallback browser copy path is allowed only
for the rendered webview document.

## Agent Visibility

The Chat transcript has two lenses:

| Lens | Purpose |
|---|---|
| `Chat` | Chronological conversation with collapsible subagent groups anchored where they were spawned. |
| `Agents` | Tree view of the same lineage, optimized for scan status. |

The role selector is hidden until role orchestration is ready. Role sessions may
still exist in state, but the primary visible controls are the two lenses.

Native provider subagents are represented by normalized events:

- `agent.spawn` creates or updates a child node.
- `agent.node_done` completes a child node.
- child-attributed text, tool, command, and file events carry `agentPath`.

The shared reducer in `packages/contracts/src/agentTree.ts` derives the tree
from either stored events or transcript lines. Both host summary chips and the
webview Agents lens use this reducer, so compact task rows and the detailed
view agree.

Each delegated-agent summary can show:

- label and status;
- running duration;
- token usage when the provider reports it;
- tool-use count;
- last activity text;
- last command/tool word, such as `grep`, `npm`, `ls`, `Grep`, or `Edit`;
- idle state when `lastActivityAt` is older than
  `drydock.agentIdleThresholdMinutes`.

Capability tiers stay honest. Full transports can show child feeds. Lifecycle
transports show spawn/status/result and a no-feed note. Unknown or legacy
sessions do not pretend to have subagent visibility.

## Host/Webview Contract

The host owns VS Code APIs, runtime lifecycle, provider catalog refresh,
clipboard writes, task/workspace operations, and backend restarts. The webview
owns local presentation state such as expanded sections, selected lens, draft
text, and visual note ordering.

New or changed contract points:

- `PanelInitState.agentIdleThresholdMs` and
  `PanelInitState.codeBlockWordWrap` hydrate webview rendering settings.
- `ChatSessionSummary.agentActivity` carries compact delegated-agent summaries.
- `session.agentActivity` pushes the same summary shape for live updates.
- `TranscriptLine` carries lineage, model/type metadata, command names, node
  status, tool status, detail previews, and usage.
- `clipboard.writeText` is the validated host request for copy buttons.
- `chat.restartBackend` is the explicit provider-change path.

All requests still pass through `parsePanelRequest`. Malformed messages are
dropped. Provider/model IDs, prompts, paths, and clipboard text remain bounded
at the contract boundary.

## Visual-Test Coverage

The webview harness records the expected behavior in
`tools/webview-harness/visual-tests.md`. The relevant checks include:

- task-owned chat navigation and active task highlighting;
- context mount expansion and planned auto mappings;
- darker transcript background;
- file drag/drop token insertion and token display;
- code copy buttons and Mermaid source/diagram toggle;
- composer layout at sidebar width;
- questions, changes, task notes, and pinned composer scrolling;
- Chat/Agents lens behavior and delegated-agent summaries.
