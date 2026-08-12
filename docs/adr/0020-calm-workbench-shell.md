# 0020 - Calm workbench shell

Status: Accepted - 2026-08-02

Refs: `docs/ideas/ux-overhaul-calm-workbench.md` (design),
`docs/design/ux-overhaul-implementation.md` (phased build), 0006 (supersedes
its four-tab sidebar model), 0012 (editor-area panel pattern), 0013
(supersedes the grouped fleet grid), 0018 (one current task - superseded by
the active-task spine), 0019 (MCP registry - its System-tab home moves to
Configure)

## Context

Every surface Drydock grew between 0006 and 0019 landed in the same place: a
single sidebar webview with a four-tab strip (Tasks · Plan · Edit · System).
That worked while the product was one chat with some scaffolding around it. It
stopped working once the fleet was real. The tab strip made four unrelated jobs
compete for one narrow column; chat - the thing people actually watch - was one
click away from being replaced by a runtime inventory; "which task am I on?"
had four different answers depending on which tab last rendered; and the System
tab had quietly become the attic where MCP registration, provider status,
runtimes, and a raw diagnostics feed all lived because nowhere else would take
them.

The fix is not another tab. It is a shell: put each job in the place VS Code
already has for that kind of job, and give them one shared answer to "what are
we working on".

## Decision

**A three-pane workbench.** Navigation lives in the left rail (`drydock.tasks`
/ `drydock.recents` / `drydock.workspaces`, one `rail.js` bundle switched by
`body[data-view]`, native sashes between them). Conversation lives in the chat
rail (`drydock.chatRail`, its own activity-bar container, best-effort moved to
the Secondary Side Bar once). Everything with breadth - Task Hub, Agents,
Planner, Task Review, Code Review, Configure - is an editor-area panel, because
editor area is where VS Code puts things you read and compare.

**One active-task spine.** `ActiveTaskService` (`app_state` key `activeTaskId`,
bus kind `active-task-changed`) is the single answer to "what are we working
on". Every surface reads and writes it through `active.get`/`active.set`; the
Task Hub retargets off the push; navigation and the spine cannot disagree
because `showSession` sets it. This supersedes 0018's per-webview "current
task" persistence.

**One dispatch, many hosts.** `ControlPanelProvider` keeps its name and its
job - the audited `parsePanelRequest` gate over every backend service, plus the
push fan-out - and loses its view. Hosts register with `attachWebview`;
responses go to the host that asked, pushes broadcast to all. There is exactly
one implementation of chat message handling, and the rail, the hub and the rail
views all use it. No host gets a private protocol.

**Solo-mode guarantee.** Nothing is hub-exclusive. Every affordance the Task
Hub offers also exists through the rail or the chat, so a user who never opens
the hub is never locked out of a capability.

**Quiet by default.** Attention pins and folds rather than shouting: the fleet
is a flat list of one-line rows with an expand-in-place, settled rows sink
below a fold after ten minutes, and the plumbing (runtimes) is a collapsed
section at the bottom of Agents rather than a dashboard.

### What retired

- **The four-tab Control Panel.** The `drydock.controlPanel` view contribution,
  `main.ts`, `tabs.ts`, and the Tasks / Plan / System tab views are deleted.
  The Edit tab's chat module (`views/chatTab.ts` over `chat/*`) survives
  unchanged as the chat rail's content - it was never the problem.
  - Tasks tab → left rail (Tasks / Recents / Workspaces) + Task Hub.
  - Plan tab → the Planner panel (0012), which already owned plans.
  - System tab → Configure (MCP registry, providers, runtime and security
    settings) and the Agents panel's Runtimes fold (inventory, stop, clean up
    stale, sandbox sign-in).
  - Edit tab → the chat rail.
- **The grouped fleet grid** of 0013: hover cards, chip clusters and the
  density grid gave way to the flat row list already shipped in P5.
- **The System tab's diagnostics feed.** The global event log and per-session
  diagnostics list are not rehomed. They duplicated three better sources that
  all survive: the raw agent stream (expand a fleet row), the launch-command
  disclosure, and a real terminal into the container. A scrollback of
  paraphrased event summaries is not evidence; the three above are.
- **`drydock.panel.open`** no longer focuses a retired view; it focuses the
  Tasks rail.

## Consequences

- The activity-bar badge moves to the Tasks rail view, folded from the same bus
  events; `ControlPanelProvider` keeps the attention bookkeeping (it owns the
  `session.attention` push and the hidden-host toast) but no longer writes a
  badge. The toast now suppresses on a *visible chat rail* rather than a
  visible panel, reported by the host through `attachWebview`.
- `panel.showPlan` is gone: the sidebar Plan tab was its only listener, so the
  push type, `ControlPanelProvider.showPlan` and the `showPlanInSidebar`
  callback threaded into `PlannerPanelProvider` all retired with it. The
  Planner panel owns plan selection outright and announces it to itself with
  `planner.showPlan`.
- Retiring a webview means retiring its messages. Requests reachable only from
  the deleted tabs are removed from `parsePanelRequest` and covered by
  regression cases asserting they now parse to `null`, following the 0012
  planDocs precedent. Contracts serving any surviving surface were kept even
  where their only *webview* caller was a deleted tab.
- **Known gap: memory has no surface.** The Tasks tab was the only home for
  0019's memory quick-add, the memory browser, and the agent-proposal approval
  gate; Configure's Memories section covers glob→tag rules only. The contracts
  and host handlers are all kept, and the `memory.candidateAdded` push still
  fires - the UI simply has nowhere to render until Configure › Memories grows
  the browser + approval list. Until then a proposed memory can only be
  approved from a previous build. This is the one capability the retirement
  cost, and it is tracked rather than accepted. *Resolved 2026-08-02:*
  Configure › Memories now leads with the data - quick-add, the pending
  approval cards (edit-then-approve), the approved browser - above the
  tag-rule rows. The Configure host answers the kept `memory.*` contracts and
  translates `memory-candidate-added` into the kept push; the display
  projection and edit-anchor resolution moved to `memoryShared.ts` so the two
  hosts cannot drift.
- Three panes cost more screen than one sidebar. The chat rail's one-time move
  into the Secondary Side Bar is best-effort against internal API; when it
  fails the user gets a single hint and their own drag always wins.
- Onboarding must be re-walked end to end on a clean state root: the tour
  targets, the walkthrough steps and the demo-mode screenshot pass all
  referenced tab ids that no longer exist.
