# 0003 - Webview and host contract

Status: Superseded by [0006](0006-task-scoped-chat-and-agent-visibility.md) - 2026-07-06

Refs: `docs/design/architecture-implementation-plan.md`, `docs/design/threat-model.md`, `packages/contracts/src/webviewMessages.ts`, `packages/core/src/accessRequestProtocol.ts`

## Context

The panel displays model text and sends user actions back to the extension
host. Treat all model text as untrusted. The runtime also cannot call the host
directly, so agent requests need to travel through the transcript.

## Decision

The main UI is an Activity Bar webview. Larger views can use editor webview
panels, but they must use the same message contract and hardening.

Dynamic strings go into the DOM with `textContent`. If we render Markdown, we
build safe block nodes and still use `textContent` for text. Raw HTML stays
text.

Webviews use strict CSP, no remote content, extension-local resource roots, no
`retainContextWhenHidden`, and a framework-free renderer. Sanitized Mermaid SVG
is the one rendering exception.

Host/webview traffic uses versioned request, response, and push envelopes.
`parsePanelRequest` is the validation gate. Drop malformed requests.

Agent-to-host requests use strict fenced blocks in final agent text. Supported
blocks are access requests, memory candidates, and questions. Parsed requests
are capped and deduped before they become prompts.

All pending user prompts share one attention stack. Access requests and
questions render in one paged card slot. Access confirmation rules do not
change.

## Consequences

Model text cannot become markup. Every host boundary has one validation path.
We give up some rich rendering shortcuts. Mid-turn interactivity would need a
new mechanism. New request types must be added to both the parser and the
attention stack.
