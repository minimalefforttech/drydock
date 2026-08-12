# ADR 0021 — Live model discovery and honest turn delivery

Status: accepted · Related: ADR 0002 (product-owned orchestration), ADR 0018
(exec side-channel), ADR 0020 (calm workbench shell).

## Context

Model pickers were compiled-in lists: the Claude adapter shipped a four-model
array, the Codex fallback stopped at the GPT‑5.5 era, riders carried registry
seed catalogs, and the webview kept its own codex-only fallback plus a
persisted copy of whatever catalog an older build had shown it. Live discovery
existed only for Codex, and only when a native host `codex.exe` or an
`OPENAI_API_KEY` env var happened to exist. Users on current CLIs could not
see current models (`claude-sonnet-5`, `gpt-5.6-sol/luna`).

Separately, turns were silently lost. Claude interactive turns ran as one
buffered exec whose captured stdout was head-truncated at 120 KB — a verbose
turn lost its reply, its terminal `result` line, and the `session_id` that
`--resume` continuity depends on, all with exit code 0. Failures that happened
before a turn existed (stale policy, busy-session races, briefing errors)
surfaced only as a session-less `run.failed` push whose webview handler was a
stub. Codex turns could also spin forever on unrecognized terminal
notifications, and stale JSON-RPC notifications replayed into the next turn's
run id.

## Decisions

### 1. No compiled-in model data; discovery is live, cache is explicit

- `AgentModelCatalog.source` is now `"provider" | "cache" | "unavailable"`.
  `"fallback"` is gone, and with it every static model array (adapters,
  registry seeds, service fallbacks, webview fallback, demo aside).
- Discovery per provider, all live:
  - **Codex**: host `codex.exe` app-server `model/list` (unchanged), else the
    session's own sandbox `model/list` at start. The `OPENAI_API_KEY` ping is
    removed — it listed API models, not Codex models, through a brittle
    family regex.
  - **Claude**: `GET api.anthropic.com/v1/models` executed INSIDE a live
    Claude runtime via `node -e` (the sandbox proxy injects the credential;
    the host never sees it). Runs at session start and on demand through any
    live Claude session.
  - **Riders**: the registry now describes a discovery endpoint
    (`ProviderModelDiscoverySpec`: OpenRouter public, DeepSeek/Kimi with the
    SecretStorage key) instead of seed models.
- Last successful discoveries persist in the sqlite `app_state` table
  (`providerCatalogCache.v1`) and load as `source:"cache"` so models are
  selectable before anything connects. Webview-side catalog persistence is
  deleted — the host cache is the only cache.
- Merge semantics are honest: a live result replaces the entry wholesale
  (removed models really disappear), cache only fills absence, and an
  unavailable result never erases a usable list — it attaches its failure
  reason as diagnostics. Providers that have never discovered render as
  explicit "unavailable" entries with the reason and a Refresh affordance;
  the picker never invents a list.
- Requery is a first-class action: the model popover has "↻ Refresh models",
  the hub composer dropdown has a refresh entry, and `provider.list` with
  `force` bypasses the TTL and re-runs every provider (auth-only rechecks
  keep the cheap `forceAuthProbe` path). A completed sign-in triggers one
  forced discovery so the picker fills the moment a provider turns green.
- With no compiled defaults, rider turns without an explicit model are
  refused at send with an actionable message (native CLIs keep their own
  defaults). Ultra effort is offered by capability (the model advertises
  `xhigh`), not by a hardcoded model id.

### 2. Turn delivery is streamed and every failure is visible

- The Claude adapter parses stream-json lines LIVE via the command runner's
  `onStdoutLine` hook: events reach the UI mid-turn, the raw view streams,
  truncation of the buffered capture can no longer eat replies, and the
  provider session id is captured from the first line that carries it (so
  even a cancelled turn stays resumable). Buffered-capture truncation now
  keeps the tail, where terminal lines live.
- Turn endings are explicit: a clean exit with no `result` line, a stall past
  the inactivity watchdog (default 10 min), the hard turn cap (default 60
  min), and cancellation each yield a distinct, actionable `agent.error` —
  never silence. Codex turns fail honestly after three quiet watchdog windows
  (the "poke" affordance covers the first ones) and the dead server-side turn
  is interrupted so the thread stays usable.
- Stale app-server notifications are dropped at every turn boundary
  (`clearNotificationQueue`), ending cross-turn event bleed.
- Pre-turn failures are recorded as durable transcript events
  (`ChatSessionService.recordSendFailure`) and `run.failed` carries a
  `sessionId` that the webview renders as an error row with one-click retry.
  Planner and subtask first-turn dispatch failures route through the same
  path instead of logger-only catches.
- `sendTurn`'s post-loop bookkeeping no longer resurrects a session that
  `endSession` tore down mid-stream, and the webview re-pulls the durable
  timeline on every visibility gain, so completions that pushed while the
  view was detached still land.

## Consequences

- A fresh install shows empty, honest pickers until a provider connects or a
  session starts; after the first discovery the cache keeps models selectable
  offline. Nothing model-shaped needs a code change to stay current.
- Host-side discovery for riders performs inert HTTPS GETs from the extension
  host (threat model: capability discovery, no prompt/workspace data).
- The Claude adapter option `timeoutMs` was replaced by `turnTimeoutMs` +
  `inactivityTimeoutMs`; `ClaudeWireConfig.defaultModel` and
  `providerDefaultModel()` are gone.
