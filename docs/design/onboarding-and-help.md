# Onboarding and help

Drydock webviews share one instructional help system: concise styled tooltips,
a dismissible first-visit prompt, topic pages, and a spotlight tour. Help copy
describes the operation and its consequences; it does not present product
marketing.

## Control-panel handoff

The sidebar tour introduces Tasks, Plan, Edit, and System before ending at an
editor-panel guide chooser. Selecting Task Board, Agents, Planner, or Task
Review opens or reveals that panel and starts its complete local tour.

Tours follow the operation instead of enumerating visible controls. Each step
has one instructional purpose: choose or create the owner, configure scope,
inspect state, take the next action, verify the result, and hand work to the
next surface. A target must contain the control or state named by its copy;
loading-state and generic container fallbacks are reserved for genuinely empty
views.

The current complete tours contain eight steps each. The sidebar separates
session context from the instruction composer. Task Board covers stages,
ownership, subtask creation, dependencies, starting, verification, and moving
work. Agents covers rollups, attention, sessions, delegated work, task links,
and landing. Planner deliberately moves from the intake state into an existing
plan before explaining outputs and revisions. Task Review separates file
status, diff inspection, comment creation, comment state, and dispatch.

The handoff is host-mediated. The open request carries `startGuide: true`, and
the destination provider waits for the panel's initial state request before it
pushes `help.startTour`. This prevents a new tour from measuring loading or
empty-state markup. An already-open panel is revealed and starts immediately;
Planner defers locally while a requested plan is loading.

Task Review requires a task. The sidebar uses the selected session's task when
available, otherwise the first task in the current task list. If there is no
task, the chooser stays open and explains that a task must be created first.

## Accessibility

Help dialogs and tours trap keyboard focus, support Escape, and expose their
current content as dialogs. Tour handoff choices are native buttons with a
visible focus state. If opening a destination fails, the error remains in the
current tour step and focus returns to the failed choice.
