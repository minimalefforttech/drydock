# ADR 0019 — MCP registry and scoped memory

Status: accepted · Related: ADR 0018 (exec side-channel; supersedes its
single-file MCP passthrough), ADR 0016 (human gates), ADR 0001 (isolation),
`docs/design/mcp-and-memory.md` (full design + UX).

## Context

The v1 tool/knowledge story was flat: one host-wide `.mcp.json` written into
every sandbox, and one global list of approved memories injected into every
briefing. Neither respected the shape of real work — a lead equips *this
workspace* with the asset-database tools, *this task* with a production
tracker, and wants Python conventions briefed only where there is Python. The
flat memory list was also the reason briefing injection had to be blocked
under managed policies (no provenance = possible cross-project leakage).

## Decisions

### 1. MCP servers are defined once and toggled per scope

- A sqlite-backed **registry** (System tab) is the only place servers are
  *defined*: name, stdio command/args/env, `enabledByDefault`, `sensitive`.
  `drydock.mcp.configPath` is demoted to an **importer** — its entries appear
  as read-only rows tagged *from settings* (this supersedes ADR 0018's
  direct-write passthrough).
- Everywhere else is **tri-state toggles** (inherit / on / off): workspace
  rows, task cards, and the chat FileMap. The effective set cascades
  registry defaults → workspace-set → task → session, most specific wins.
  Workspace overrides resolve by **roots intersection** with the session's
  mounted roots (sessions do not persist workspace-set ids).
- `sensitive` servers stay OFF unless a **task or session** override turns
  them on — a default or workspace "on" is not consent for a high-stakes
  tool.
- The winner set renders to `/workspace/.mcp.json` over the exec
  side-channel (ADR 0018 invariant: no new mounts, no restarts). Per-turn CLI
  invocation means toggles honestly "apply next turn"; toggling rewrites live
  sessions' files, and an empty effective set writes an empty map so a
  disable disables.
- Env values are stored host-side and injected only into a session's own
  config file. The webview sees **key names only** — env is write-only from
  the manager UI.

### 2. Memory is scoped, tagged, and grouped

- Memories carry a scope — **global / workspace / task** — plus optional
  **tags** and an origin (agent or user). Workspace scope anchors to
  normalized **root paths** (travels with the folder, survives set edits);
  task scope anchors to a taskId. Legacy rows read back as global.
- Tags come from a **glob→tag rule table**: shipped defaults
  (`package.py`→rez, `pyproject.toml`→pip, `*.py`→python, `*.h`→cpp,
  maya/houdini/unreal/usd…) extended — never replaced — by
  `drydock.memory.tagRules`. Detection is one bounded top-level scan per
  mounted root at mount time, cached; multiple tags stack.
- Briefings inject only what applies: global + this-workspace (roots
  intersect) + this-task (linked), tag-filtered, **grouped by scope** most
  specific first. Provenance grouping retires the blanket managed-policy
  block: only the provenance-free global group is dropped under a
  restricting policy.

### 3. Human gates on memory, both directions

- **User quick-add** is one line, never a form: scope pill (task →
  workspace → global) + suggested tag chips; human-authored entries land
  approved immediately.
- **Agent proposals** ride the existing `memory-candidate` fence, upgraded
  to structured JSON `{content, scope, tags}` (plain text stays valid,
  defaults to workspace). The pending card is **fully editable before
  approval** — content, scope, and tags — because agent proposals run wordy;
  the approval card remains the single gate and nothing an agent writes
  persists without it (ADR 0016 posture).

### 4. Context debug shows the composed context with provenance

Chat ⋯ → **Context debug** opens an untitled markdown document composing
everything the next briefed turn would carry — mounts, detected tags, memory
groups (author/source-session/date per note), the MCP effective set with the
scope that decided each state, instruction files, team instructions, and the
exact briefing text — built by the same code paths as the real briefing, so
the view cannot drift from what agents actually receive.

## Security posture

Unchanged in kind. MCP servers execute inside the sandbox under the existing
egress policy; the registry never grants network or mounts, and `sensitive`
is a consent gate, not a sandbox change. Env values never render in the
webview. Memory scoping only ever NARROWS what a briefing carries; agent
memory still cannot persist without human approval.

## Deferred

- Codex-side MCP config rendering (TOML); per-server health probes.
- Path-prefix memory selectors if glob tags prove too coarse.
- Memory dedup/contradiction surfacing; registry + memory export/import.
