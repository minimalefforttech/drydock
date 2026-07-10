# Roadmap

What's shipped and what's next for Drydock.

## Shipped

- **Contained sessions** — isolated per-chat runtime, Codex and Claude Code
  transports, restart-not-end continuity, model/provider switching mid-session.
- **Blast-radius approvals & mounts** — fenced host-path request protocol,
  risk-tiered approval cards with typed confirm for sensitive roots,
  default-denied credential roots, per-session grants ledger.
- **Work management** — tasks linking sessions and workspace sets, live
  workspace switching with multi-window awareness (host-instance heartbeats
  so sessions can be adopted or shown as running elsewhere), memory
  candidates with human review.
- **Working set & review** — per-file diff baselines with accept/discard,
  Copilot-style working set with line stats and diff-editor integration.
- **Task Review** — one surface to review a task's changes across every
  linked session and repo before the normal commit/PR; comments become
  agent revision turns through the shared composer; never commits or pushes.
- **Clone mode** — full-clone sandboxes (never worktrees) with a symmetric
  3-way patch sync between the clone and the working tree, for work that
  must never mount live folders.
- **Subagent visibility** — native fan-outs render as collapsible transcript
  groups and a hierarchy lens with per-agent status, files, and token usage.
- **Role sessions** — spawn researcher/planner/worker/tester/reviewer
  children from a live chat; children's mounts are always a subset of the
  parent's, enforced at spawn and at every expansion.
- **Attention stack** — agent questions and access requests share one paged
  card slot (question plus recommended answers plus free-text, or the
  typed-confirm access flow), wired to badges and toasts.
- **Task board & subtasks** — tasks and per-task subtasks as independent
  cards on a configurable kanban panel (fixed behaviour categories, an age
  filter over finished work, Review→Finished as a manual gate); same-task
  dependency edges drawn dot-to-dot with live boundary grey-out and cycle
  rejection; per-subtask auto-start flags cascade prompt-backed runs in
  parallel as upstream chats finish (Backlog never auto-starts, Force start
  is manual-only). Work-tab memories open as read-only documents.

## Next

**External providers & remote execution**

- GitHub Issues / Jira / Asana integration with sync cursors and
  webhook/polling updates.
- Clone-only remote execution: the remote-mode sync protocol runs the same
  symmetric patch exchange over a transport-independent channel (a staging
  bare repo over SSH), so remote work stays clone-only and never mounts a
  live folder.

## Later / open questions

- Deeper work-management flows: task activation history, a task-first
  creation gesture (new task, then pick projects, then start a chat as one
  step), project touch-history ("recently changed by task X"), mini-tasks
  created from review comments.
- Secret-scanner tripwire on approvals. (The "redesigned require-plan policy"
  landed as the Planner panel — ADR 0012, `docs/design/planner.md`: plan-mode
  sessions exist only under plans, and the composer switch is gone.)
- Agent-driven (not just user-driven) role spawns, with an approval design
  proportional to blast radius; per-native-node cancel; role-aware model
  routing.
- Legacy cleanup: the sidebar plan-block approval flow and the per-session
  plan-docs surface are retired (ADR 0012); the docs-review backend remains to
  fold into its replacement.
- Planner follow-ups: a board "Plan this task" action creating a pre-linked
  plan, and an "Export plan…" command materializing a plan's artifacts to a
  chosen folder.
