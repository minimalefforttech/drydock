# 0012 - Planner panel

Status: Accepted - 2026-07-10

Refs: `docs/design/planner.md`, 0001 (mount-enforced access), 0006 (webview
contract), 0007 (subtasks create separately from starts), 0011
(ack-then-push for slow host work)

## Context

Planning was a composer toggle: a session started in "plan" mode mounted its
project roots read-only, the agent wrote Markdown into its workspace `plan/`
directory, and a per-session plan-docs panel collected and reviewed them. The
mode was immutable per session and the switch mid-session did nothing - a
standing trap. Plans died with their sessions, images and clickable mockups had
no home, and the review affordance (block comments piggybacking on review
comments) could not anchor to diagrams or images.

## Decision

Planning becomes a place, not a mode. A single editor-area Planner panel
(`drydock.planner`) owns the whole loop:

- A **Plan** is a first-class durable entity: brief, a multi-select **aspect
  registry** (seeded with ten angles, extensible as data - plus optional
  read-only repo packs in `.drydock/planner-aspects.json`), read-only context
  roots, pre-information, at most one chat session, artifacts, annotations.
- Plans, like edits, **generally belong to tasks** (`task_id`, nullable):
  every create surface leads with a task picker (orphans allowed, discouraged
  in copy), the owning task's title chips plan headers and lists, and each
  session boot links the plan's session to the task so board chips and task
  history see planning work like any other.
- The agent writes into its workspace `plan/` directory (a host bind mount -
  crash-safe by construction). After every turn and on panel open the host
  **collects** artifacts into the durable store: text kinds inline in SQLite,
  images in the content-addressed blob store. A fresh session **hydrates** its
  workspace from the store, so sessions stay disposable while plans persist.
- Four artifact providers render behind one seam: documents (structural
  markdown, click-to-instruct blocks), mermaid diagrams (node anchors + free
  points), images (point/region annotations, normalized coordinates), and
  sandboxed HTML **prototypes** (live in an iframe with no same-origin access;
  scripts per-artifact opt-in). One anchor grammar
  (`block:` / `node:` / `point:` / `region:`) feeds one annotation model:
  open → delegated (composed into a single revision turn) → resolved/reopened.
- The plan transcript and composer remain in the Drydock **Plan tab** in the
  VS Code sidebar. The editor-area Planner contains intake, outputs, artifact
  review, annotations, and handoff controls; it does not duplicate the chat.
  Plan selection is synchronized between the two surfaces. The Plan and Edit
  tabs use the same transcript components (`webview-ui/src/chat/`).
- A task-owned plan can materialize work through **To board**. Candidates are
  only literal Markdown checkbox items in document artifacts (`- [ ]`,
  `* [x]`, or numbered checkbox lines), deduplicated case-insensitively and
  shown in a preview. There is no heading inference. Confirmed items become
  backlog subtasks with plan-sourced prompts; auto-start stays off and no DAG
  edges are invented. Orphan plans must be assigned to a task first.
- The composer [Plan | Develop] switch and the per-session plan-docs surface
  are retired. Edit sessions always run implementation mode; the internal
  `plan` mode literal survives for role spawns and Planner sessions - read-only
  stays mount-enforced (0001), never agent-sandbox-enforced.

## Consequences

- Plans survive sandbox crashes, session ends, and window reloads; the
  workspace is only ever a writing surface.
- One annotation model spans text, diagrams, images, and prototypes; the
  reviewer's open notes send as one turn with delegated/addressed bookkeeping.
- The `plan_docs` table joins the orphaned-legacy set (kept per the additive
  migration policy); `planner_*` tables are the live schema.
- The Planner panel carries the mermaid `style-src 'unsafe-inline'` CSP
  deviation (owner-approved with this ADR), with the same input-side
  mitigations as its predecessor; prototype frames add no CSP relaxation.
- Departments extend the aspect registry without code; aspect ids double as
  `plan/<aspectId>/` collection directories.
- Re-running materialization may propose items that already became subtasks;
  the preview is the current duplicate guard.
