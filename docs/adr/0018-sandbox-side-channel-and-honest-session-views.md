# ADR 0018 — Sandbox side-channel, evidence-based session views, and the current task

Status: accepted · Related: ADR 0001 (isolation), ADR 0016 (human gates),
ADR 0017 (preview servers), `threat-model.md`.

## Context

Three friction clusters surfaced in daily use: (1) the host had no way to
enrich a LIVE sandbox (tool configs, instructions, an inspection shell)
without restarting it; (2) the Edit tab's changed-file views showed baseline
drift — everything that changed under the mounts, including the developer's
own later edits — rather than the session's work; (3) each tab derived its own
notion of "the task I'm working", so Plan, Edit, and Tasks disagreed, and the
chat log presented machine plumbing (protocol JSON, stale `running…` states,
briefing-prefixed titles) as if it were content.

## Decisions

### 1. The runtime exec transport is the host↔sandbox side-channel

Everything the host injects into or reads from a live sandbox rides the SAME
bounded `sbx exec` channel the adapters already use — never new mounts, never
container restarts, and identical behavior for remote runtimes:

- **MCP passthrough** (`drydock.mcp.configPath`): a host `.mcp.json`,
  validated at activation, written to `/workspace/.mcp.json` before the first
  turn. Per-turn CLI invocation means every turn loads it. Servers run INSIDE
  the no-egress sandbox — the sandbox network policy governs their reach.
  Claude transports first; Codex TOML is the recorded follow-up.
  *Superseded by ADR 0019*: the file is now IMPORTED into the MCP registry
  and the per-session effective set is what gets written.
- **Standing instructions**: repo `CLAUDE.md`/`AGENTS.md` files are detected
  in-container at first turn and the briefing points at them explicitly;
  `drydock.teamInstructionsPath` appends a studio-level markdown (≤8 KB) to
  every briefing.
- **Terminal attach** (`drydock.session.attachTerminal`, Edit ⋯ menu +
  palette): `sbx exec -i <sandbox> /bin/sh -i` as a VS Code terminal —
  line-buffered but bidirectional (verified against the real CLI; `-t` under
  conpty produced no output — a PTY shim is the recorded follow-up). Entry is
  gated by a modal that names the blast radius: you act with the agent's
  permissions, host mounts included.

This family (with ADR 0016's image reads and ADR 0017's preview proxy and
theme push) establishes the invariant: **the exec channel is the only
host-initiated data path into a running sandbox**, always bounded, always
logged, never widening mounts.

### 2. Session views are evidence-based

The Edit tab's This Turn / Session / Full Session lists show what the SESSION
did, derived from its replay log — never raw baseline drift:

- A change is listed iff it is **named** by an `agent.file_edit` event, or its
  mtime falls inside an **agent activity span** — windows merged from the
  agent's own event timestamps (gap-merged at 10 min, padded ±2 s). Spans end
  at the agent's last event, so the developer's after-the-fact edits are
  structurally outside.
- **Unsure means unlisted**: unattributable deletions and missing-mtime rows
  are excluded; a session with no recorded work lists nothing. The unfiltered
  diff survives only when the event store itself is unreadable.
- Baseline creation and diffing honor `.gitignore` (batch `git check-ignore`)
  plus built-in junk rules (`__pycache__`, caches, `.pyc`), applied to BOTH
  diff sides so legacy baselines clean up without migration.

### 3. One current task, shared

A persisted `activeTaskId` is the single "task I'm working" across surfaces:
task-card click sets it, session selection adopts the session's owner, the
Plan tab's picker defaults to and writes it, and new chats (header ＋ / menu)
auto-link to it. The Tasks tab's active treatment marks the current task, not
liveness. Last explicit gesture wins; a pinned mode is deferred until wanted.

### 4. The chat log presents for humans

- Protocol fences (access-request/question/preview/memory) render as
  COLLAPSED one-line notes with the detail behind a disclosure; the actual
  cards/flows are untouched, and malformed fences fall back to raw.
- Status honesty: stream cursors and `running…` command chips are recomputed
  at render time against live turn state — a dead session shows
  `interrupted`, never activity.
- Assistant prose renders verbatim (the 400-char summary clip applies only to
  genuine summaries); session titles strip the host briefing; chat-log export
  merges consecutive same-role entries under one header.
- Slow host phases (sandbox boot, history load) show an inline busy line; the
  FileMap disclosure (mounts, grants, uploads dir, themes) lives in the
  header with inline host↔sandbox mappings instead of tooltips.

## Security posture

Unchanged in kind. Side-channel writes are host-initiated, size-capped,
shell-safe by construction, and land only in the session's own container;
terminal attach is a human-confirmed action with the agent's existing
permissions, nothing more. Evidence-based views only ever NARROW what is
displayed. MCP configs execute inside the sandbox boundary under the existing
egress policy.

## Deferred

- Codex-side MCP config (TOML) and per-task MCP allowlists.
- PTY shim for a full interactive terminal (vim/top); Agents-panel attach row.
- `file_edit` synthesis for command-produced changes at the adapter layer.
- Pinned current-task mode (ignore session-selection adoption).
- Batched access-request notes ("requested access to N paths").
