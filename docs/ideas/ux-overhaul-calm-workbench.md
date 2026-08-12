# UX overhaul — the calm workbench

Status: Proposal — 2026-08-01. Review artifact (mockups + pins + phases):
https://claude.ai/code/artifact/7d8e3988-82a7-4a85-80c1-8747e646320a

## Problem

The UI is too technical and taxes attention: one 300px webview carries four jobs
(Tasks / Plan / Edit / System), machinery renders at the same volume as
conversation, and "does anything need me?" requires visiting tabs to answer.

## Shape

VS Code stays the platform; Drydock wraps it in a workspace layer.
**Left orients · center informs · right converses.**
Mental model: **Task = what · Workspace = where · Agent = who.**
Amber only for needs-input, red only for failed; running is quiet; done fades.

- **Left rail** — three webview views in the existing container (native
  sashes): Tasks (recent-first; 8px status dot is the rail's only color;
  sticky "Needs you" cluster for failed + awaiting; expandable subtasks;
  "Earlier" fold), **Recents** (one row per task = its most recent chat across
  task + subtasks; click = task switch + focus chat; cap 7 then "All chats ↗"),
  Workspaces (sets, RW/RO tags, delete guards). Native view-title actions
  (New · Board · Agents · Configure) + native badge = failed+awaiting count.
- **Active-task spine** — `ActiveTaskService` (SQLite-persisted) + bus kind
  `active-task-changed`. Selecting a task retargets everything.
- **Task Hub** (center, singleton editor panel) — overview-first cards, no
  sub-tabs: attention rail → stats strip → Chats → Subtasks → Plans →
  collapsed System (runtimes, mounts, launch cmd, raw stream). Every card is a
  summary + one link out to Board/Agents/Planner/Review; the hub never
  duplicates their depth. Chat rows focus the right rail.
- **New chat** — composer in the hub; every field prefilled with vanishing
  provenance hints; prompt is the only required touch; [Start chat] transforms
  the card into a boot timeline (create → mount/clone → start, queue + failure
  variants); [Plan first] carries the brief into the Planner. No subtask
  toggle — linkage comes from where you started + a post-first-turn "Track as
  subtask" affordance.
- **Chat rail** (right, Secondary Side Bar best-effort) — just the chat:
  2-line header (task chip · session switcher · quiet meta popover), transcript
  where prose dominates and machinery folds (briefing/thinking/commands),
  needs-input cards with a 2px amber left edge answered inline, one-line stats,
  Stop/poke composer. Sending is the reconnect when offline.
- **Configure** (editor panel) — Providers · MCP · Agents & Models · Preprompts
  · Skills & Recipes · Memories · Runtime · Security. Three provenance sources
  as chips: local (SQLite, editable) · settings (writes via settings API) ·
  project (`.drydock/` overlays, read-only + "edit the file"). Project scope =
  merged view. No Save button.

## Task switching

One click on a task row moves the whole bench on the active-task spine:
rail edge instantly → hub retargets in place (tab title, 400ms slide,
← back-chip ~6s, opens if closed) → chat rail follows to the task's most
recent chat (empty invite if none) → Planner/Review retarget if open →
Board/Agents only highlight + scroll. **Nothing ever stops** — background
chats keep streaming, dots stay live in Recents. Back = back-chip or Alt+←
(one step).

Workspace mismatch: if the task's set roots ≠ window folders (normalized
set-equality), a **non-blocking toast** appears after the switch: [Switch to
X] (updateWorkspaceFolders — in place for multi-root; single-folder window
reloads), [Keep current] (hub chip wears a quiet ⇄), gear → "Don't ask for
this task" (persisted, reversible from task ⋯). Sandbox mounts never depend
on window folders — convenience only.

## Agents panel (clarity pass)

Rebuilt on the Claude Code background-tasks pattern: flat recent-first list,
one row per agent (dot · title · owning task grey · elapsed) + ONE
live-activity line (current command / latest output / pending question, from
the activity projection + raw-stream tail). Needs-you rows pin with amber
left edge; expand in place = output tail + subagent children + meta; done
rows collapse to a result line with per-row "Land changes" only when a
changeset waits (bulk drawer moves behind toolbar overflow); failed rows get
Retry. Group-by-task becomes an opt-in toggle; hover cards and the grouped
grid retire.

## Status language (everywhere)

running · awaiting input · failed · queued · starting · idle-live · done ·
offline. Roll-up: **awaiting › failed** › running › starting/queued › idle ›
done/offline (awaiting outranks failed: a blocked agent burns wall-clock, a
failure waits — flagged as an open call).

## Shortcomings + alternatives (honest, in the artifact per-section)

- Three-pane costs ~670px before code; assumes panes get collapsed. Alt:
  **solo mode** — nothing hub-exclusive, rail alone is sufficient (call 11).
- Needs-you cluster teleports rows (breaks spatial memory); webview list
  re-implements native-tree freebies. Alts: native TreeView variant (ugly,
  cheap, fast), badge-only attention, recents chevron for parallel chats.
- Singleton hub can't do side-by-side; follow-everything yanks panels
  mid-read. Alts: pinnable hub (tab-pin), follow toggle, native editor
  history for back.
- Mismatch toast fatigues set-hoppers. Alts: do-nothing default (⇄ glyph
  only), auto-switch + statusbar undo, open-in-new-window.
- Hub is a summary layer that will drift; lazy devs close it, dedicated go
  board-first. Alts: optional-by-guarantee, hub-lite (dense README), board
  menus carry the links.
- Composer is still a form; honest boot feels slow. Alts: **quick chat**
  (call 10: keybind → instant chat, auto-task titled from first prompt,
  window folders as implicit set — recommend), optimistic boot (queue first
  message during boot), slash commands.
- 370px rail is bad for diffs. Alts: open-chat-as-editor, code-block →
  editor, drag rail to bottom panel.
- Flat agents list churns past ~20 rows. Alts: auto-group past threshold,
  damp updates (≥1s, no auto-scroll), multi-select bulk stop/land.
- Configure sprawl; settings write-through surprises. Alts: v1 = 4 sections,
  first-run wizard, raw file escape hatches per section.

Other shapes ranked honestly: three-pane ≥ chat-first (Copilot-shaped) >
window-per-task > native-first. Quick chat steals chat-first's best idea.

## Workflows (storyboarded in the artifact)

Lazy: prompt → boot → quiet work → badge+cluster interrupt → answer → land.
Dedicated: plan-first → checklist → materialize to board (rails queue) →
flat fleet → FAQ auto-answer receipt → land per changeset, disjoint-first.

## Phases

P0 active-task spine (S) → P1 left rail incl. Recents + mismatch toast (L) →
P2 chat rail rehome onto shared chat components (M) → P3 Task Hub + retarget
choreography (L) → P4 new-chat flow + boot-stage events (M) → P5 Agents
clarity pass (M) → P6 Configure (L) → P7 retire Control Panel + polish (M).
Old panel keeps working until P7.

## Open calls

1. Roll-up precedence (awaiting above failed) — confirm or flip.
2. Secondary-side-bar placement is best-effort (move command + one-time hint).
3. Dual-run window until P6 vs hard cutover.
4. New boot-stage events from isolatedRunService for the spool timeline.
5. Composer has no subtask toggle (provenance + post-turn affordance instead).
6. Configure writes machine-scope settings via the settings API.
7. Naming: "Task Hub" / "Agent View" / "Configure".
8. Workspace switch reloads single-folder windows (multi-root updates in
   place) — accept, or suppress the prompt there?
9. Agents landing drawer demoted to per-row "Land changes" + toolbar
   overflow — confirm.
10. Quick chat (keybind → instant chat, auto-task from first prompt, window
    folders as implicit set) — recommend yes, folds into P4.
11. Solo-mode guarantee (nothing hub-exclusive; rail alone is sufficient) —
    accept as a hard rule?
