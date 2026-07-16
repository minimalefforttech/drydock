# ADR 0017 — Sandbox preview servers and web-only prototyping

Status: accepted · Related: ADR 0016 (human gates), ADR 0001 (isolation),
`threat-model.md`.

## Decision

**Prototyping is web-only, even for Qt/Slate (Unreal) targets.** Agents build
UI prototypes as HTML/CSS/JS, serve them on any localhost port inside their
own sandbox, and announce them via a ` ```preview ` fence
(`{"port", "path", "title"}` — strict, bounded, ≤2 per text). The host starts
a `127.0.0.1` proxy per announcement: each request is one bounded exec into
the session's own container (node `fetch` against loopback, body/headers
base64-relayed over stdio). No published ports, no container restarts, no
network reach beyond that one container — and remote runtimes work unchanged
because the relay rides the runtime's own exec transport. Websockets/streaming
and per-request latency (~100–300 ms) are the accepted v1 limits; a persistent
duplex relay is the recorded fast-follow.

**Theme packs make web prototypes feel native.** Built-in stylesheets
(`qt-dark`, `slate-dark`, `vscode-dark`, `clean-light`) target one shared
widget vocabulary (panel/toolbar/tab/row/button…) and are pushed into the
sandbox at `/workspace/.drydock-themes/` on first preview. Studios register
more via `drydock.prototypeThemes` ({name, cssPath}); names are validated to a
path/shell-safe stem. The host briefing instructs agents: web-only, link a
theme, never attempt native toolkits (no display in the sandbox).

**Surfaces.** `preview.available` push → a pinned chip strip in the Edit tab
(dot · title · Open in Simple Browser · ↗ external · ✕ stop) and a
non-blocking `▶` row in the Lead's inbox (`· N previews` on the summary line).
Previews are process-local like clone state; a window reload drops the proxy
(the agent re-announces on request).

## Security posture

The proxy listener binds `127.0.0.1` only and bridges to exactly one
container's loopback. Agent-served pages are untrusted content: they open in
Simple Browser / external browser (never a privileged webview) with a one-time
notice per preview. The container's no-egress policy is unchanged — an inbound
preview grants no outbound network. Fence parsing carries the same strictness
and caps as the access/question protocol.

## Deferred

- Persistent duplex relay (websockets, streaming, lower latency).
- Multi-port dashboards; preview chips on Agents-panel rows.
- Preview screenshots attached to manual-check questions (ADR 0016 synergy).
- Studio policy knob to disable preview proxying entirely.
