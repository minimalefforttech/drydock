# MCP Registry & Scoped Memory

Related: ADR 0018 (side-channel: today's single `drydock.mcp.configPath` and
briefing memory), ADR 0016 (human gates), `work-management.md`.
Status: implemented (ADR 0019, shipped 0.12.x) — all four rollout phases plus the context-debug
view (chat ⋯ → Context debug: an untitled markdown doc composing the session's
briefing inputs — mounts, detected tags, memory groups, MCP effective set,
instructions — each section annotated with its source). One deviation from the
sketch below: workspace-scoped memory anchors to the session's mounted ROOT
PATHS rather than a workspaceSetId (sessions don't persist set ids; roots
survive set edits and travel with the folder). MCP workspace overrides still
key on workspace sets, resolved by roots-intersection at session time.
Surfaces moved once since: ADR 0020's calm-workbench shell retired the
Tasks/System tabs, and the memory quick-add + browser + approval gate
re-homed to Configure › Memories (0.14.0, shared host projections in
`memoryShared.ts`).

## Goals

The lead equips the team: which tools (MCP servers) agents get, and what
standing knowledge (memory) they carry — per workspace, task, chat, file
type, or package ecosystem. Both must be quick to adjust mid-flow ("toggle
that off for this chat", "remember this for Python work") and agents must be
able to *propose* memory, never write it unilaterally.

## Part 1 — MCP registry

### Model

```
McpServerRecord {
  serverId, name,                 // display name, unique
  command, args[], env{},         // stdio launch inside the sandbox
  transports: ("claude"|"codex")[],
  enabledByDefault: boolean,      // the global switch
  sensitive?: boolean,            // requires explicit per-task/chat opt-in
  notes?
}
McpOverride {
  scope: "workspace-set" | "task" | "session",
  refId,                          // workspaceSetId / taskId / sessionId
  serverId,
  state: "on" | "off"             // absent row = inherit
}
```

**Effective set for a session** = registry defaults → workspace-set override
→ task override → session override (most specific wins; `sensitive` servers
are OFF unless a task/session explicitly turns them on). Computed at first
turn and on demand, rendered to `/workspace/.mcp.json` (Claude) /
`config.toml` (Codex, follow-up) over the exec side-channel. Toggling
mid-session rewrites the file — per-turn CLI invocation picks it up on the
next turn, no restart (states this honestly in the UI: "applies next turn").

Storage: two sqlite tables (additive). `drydock.mcp.configPath` remains as an
IMPORT source: entries appear in the registry tagged `from settings`,
editable only by editing the file.

### UX

- **Registry manager**: System tab gains an "MCP Servers" section — rows
  (name · transport chips · default on/off toggle · sensitive badge · edit /
  delete), `＋ Add server` inline form (name, command, args, env). This is
  the only place servers are *defined*; everywhere else only toggles.
- **Workspace defaults**: each row in the Workspaces section gets an `MCP (n)`
  chip → popover of tri-state toggles (inherit/on/off per server).
- **Task**: task card ⋯ menu → `MCP…` — same tri-state popover.
- **Chat**: the Edit tab's FileMap row gains `· MCP: n on`; expanding FileMap
  lists the effective servers with per-session toggles and an `inherited
  from <scope>` note per row. One click flips a server for THIS chat only.
- Managed studio policy can pin a server allowlist/denylist; pinned rows
  render locked with the policy named.

### Security posture

Servers execute INSIDE the sandbox under the existing egress policy — the
registry never grants network or mounts. `sensitive` is a labeling gate, not
a sandbox change. Env values are stored host-side and injected only into the
session's own config file; they never render in the webview (rows show key
names only).

## Part 2 — Scoped memory

### Model

Extend the existing memory record (additive columns):

```
MemoryRecord {
  …existing (content, status, source session, timestamps)…,
  scope: "global" | { workspaceSetId } | { taskId },
  tags?: string[]                 // ["python", "rez", "maya", "cpp", …]
}
```

One selector mechanism: **tags**. What maps workspace contents to tags is a
**rule table** — simple globs, not hardcoded manifest logic:

```
TagRule { globs: string[], tag: string }   // first-class config, ordered list
```

Shipped defaults (users extend/override the same table):

| Globs | Tag |
|---|---|
| `package.py` | `rez` |
| `pyproject.toml`, `requirements.txt` | `pip` |
| `package.json` | `node` |
| `*.py` | `python` |
| `*.h`, `*.hh`, `*.cpp` | `cpp` |
| `*.uproject` | `unreal` |
| `*.ma`, `*.mb` | `maya` |
| `*.hip`, `*.hiplc` | `houdini` |

Rules are additive — **multiple tags apply** when multiple globs match
(a rez-packaged Maya Python repo yields `rez + python + maya`). The table
lives in config (System tab editor + settings JSON) so a studio can add
`*.usd → usd` or `SConstruct → scons` without a code change.

**Detection** runs once per mounted root at mount time — a bounded, cached
glob scan (top levels + extension census, no deep walk), invalidated on
remount. Detected tags show as chips on the FileMap row so it's visible why
a memory did or didn't load.

**Application at briefing time** (replaces today's flat global list):

1. Collect candidates: global + the session's workspace-set + its task.
2. Tag filter: a memory with `tags` applies only when at least one of its
   tags was detected in the session's mounts; untagged memories always apply
   within their scope.
3. Inject grouped and capped per scope (`Team memory — global / this
   workspace / this task / python`), most specific first. Provenance grouping
   also resolves the ADR-noted policy concern: workspace-scoped memories
   never leak into foreign-project briefings.

### UX — quick add as you go

- **Memory section (Configure › Memories; sketched for the Tasks tab and
  re-homed when ADR 0020 retired it)**: a one-line `＋ Remember…` input with a
  scope pill defaulting to the CURRENT context (`task: <active task>` — one
  click cycles task → workspace → global) and an optional `for:` chip row
  (`python`, `rez`, `maya` — the active workspace's detected tags, one click
  each). Enter saves. User memories are short by design — this stays a
  one-liner, never a form. The list gains scope/tag chips per row, a scope
  filter, and edit/retarget/delete.
- **From the transcript**: select text in a chat → a floating `Remember`
  affordance pre-fills the quick-add with the selection and current scope.
- **Command palette**: `Drydock: Remember…` for keyboard flow.

### Agent-committed memory (ask-first, always)

The existing `memory-candidate` fence upgrades to structured JSON (plain text
stays valid, defaulting to workspace scope):

```json
{"content": "Alembic exports must use the framerange guard",
 "scope": "task" | "workspace" | "global",
 "tags": ["python", "maya"]}
```

The briefing tells agents: *when the developer asks you to remember
something, or you learn a durable convention, propose it with this fence —
a human approves before it persists.* The pending card renders **everything
editable pre-approval**: the content is an editable text field (agent
proposals run wordy — the user trims to the durable sentence before it
sticks), and the scope/tag chips can be retargeted (narrow global → task).
Approval remains the single human gate — this is the "ask user before
adding", reusing the exact card flow that exists today, so "remember that we
always use pytest here" in a prompt becomes an edit-then-one-click approval
with the right scope already suggested.

## Rollout

1. Memory scope/tag columns + glob rule table with shipped defaults +
   mount-time detection + briefing grouping + quick-add row (highest value,
   smallest surface).
2. Structured memory-candidate fence + editable content/scope/tags on the
   pending card.
3. MCP registry tables + System-tab manager + effective-set rendering
   (replaces the v1 configPath write; configPath becomes an importer).
4. Scope toggles (workspace chip, task menu, FileMap per-chat) + transcript
   `Remember` affordance.

## Deferred

- Codex TOML rendering; per-server health probe in the FileMap list.
- Path-prefix selectors (`src/pipeline/**`) if extension/package selectors
  prove too coarse.
- Memory dedup/conflict surfacing (two memories contradicting each other).
- Export/import of registry + memories for team sharing (pairs with the
  studio policy story).
