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
- **Planner and plan → board** — durable task-owned plans collect/hydrate
  documents, diagrams, images, and sandboxed prototypes across disposable
  sessions; annotations become revision turns, while literal document
  checkboxes can be previewed into backlog subtasks without inference or
  auto-start (ADR 0012).
- **Agents panel** — the fleet view (ADR 0013): every session across every
  task grouped under its board column, role children nested, subagent rows
  from the same activity summaries as the sidebar chips, honest
  running-elsewhere/capability-tier states, attention chips for pending
  questions/access, click-through to the sidebar Edit session, configurable quiet
  density, live token rollups, and explicit starting/resuming state. The
  session overview adds no polling or parallel session store.
- **Chained clone output and landing** — Review entry captures durable
  per-repo changesets; dependents may explicitly seed from unlanded upstream
  output before their sync base freezes. The fleet Landing drawer orders
  path-disjoint, unknown, and overlapping work and reuses the two-click full
  Pull into the developer's working tree (ADR 0014).
- **Fleet workflow rails** — seeded/repo-overlay task recipes create DAGs with
  model/seed/verification defaults but never start them; a machine-derived
  run-slot budget exposes a durable queue, automatic failures retry once then
  park, and doubly-opt-in task FAQ answers leave transcript receipts while
  never touching access requests (ADRs 0007 and 0015).
- **Verification and review provenance** — recipes can mark a done subtask as
  needing human verification, and machine-authored Task Review comments are
  visibly labeled `agent` or `guard` rather than presented as the user's.

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
  step), project touch-history ("recently changed by task X"), and creation
  of `origin: "review"` subtasks directly from review comments.
- Secret-scanner tripwire on approvals. The old require-plan gate was retired
  in favor of the separate Planner workflow (ADR 0012); any future
  workspace-level planning policy needs a new explicit decision.
- Agent-driven (not just user-driven) role spawns, with an approval design
  proportional to blast radius; per-native-node cancel; role-aware model
  routing.
- Legacy cleanup: the sidebar plan-block approval flow and the per-session
  plan-docs surface are retired (ADR 0012); the docs-review backend remains to
  fold into its replacement.
- Planner follow-ups: an "Export plan…" command materializing a plan's
  artifacts to a chosen folder. (Task ownership shipped: plans carry `task_id`,
  create surfaces lead with a task picker, and task cards have a "Plan"
  action — see docs/design/planner.md.)
