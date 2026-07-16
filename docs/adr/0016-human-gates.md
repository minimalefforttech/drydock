# ADR 0016 — Human gates: richer questions, manual checks, and the HITL layer decision

Status: accepted · Related: ADR 0007 (verify markers, FAQ), ADR 0013 (agents
panel attention), `docs/design/task-review.md`, the Lead's inbox (Tasks tab).

## Context

The question/answer flow is the management interface between the lead and the
agent team, and it was flat: a text question with optional one-click options.
Three gaps mattered:

1. **Agents could not show what they see.** A "does this match?" question
   could not carry the render/screenshot the agent produced, even though the
   file already existed in its sandbox.
2. **HITL manual checks were smeared across three artifacts** — instructions
   as a transcript message, a separate question for the verdict, and a board
   verify chip stamped in yet another place.
3. **HITL primitives are fragmented in general**: agent questions, access
   requests, verify gates, review round-trips, and FAQ auto-answers each own a
   detection path, store, status vocabulary, and push.

## Decision

### 1. Questions can carry images (agent → human)

The `question` fence gains an optional `images` field (≤3 absolute in-sandbox
image paths). At capture time the app layer resolves each path to a data URI
by running `base64 <path>` through the session's own runtime executor — the
exact inverse of attachment upload, riding the same transport (works for
remote runtimes), capped (~512 KB encoded each), image extensions only, no
`..`, never a host path. Resolution happens BEFORE the record persists, so
cards render everywhere (sidebar inbox, chat, fleet) without a live-session
requirement at render time; unresolved paths store path-only and the card says
so honestly.

### 2. `manual-check` question kind (one artifact, whole loop)

A question may declare `kind: "manual-check"` with ordered `steps` (≤10, each
optionally illustrated via the same image resolution) and an optional
`subtaskId` naming the verify gate it satisfies. The card renders check-off
boxes per step (webview-local), appends a receipt to the answer
(`steps checked: 3/3`), and — when a subtask is named — offers a
checked-by-default "stamp Verified ✓" that sends the existing
`subtask.update verified=true` with the same gesture. Instructions, evidence,
verdict, and the board gate collapse into one card.

Storage is additive: one nullable `extras_json` column on `agent_questions`
(kind/steps/images/subtaskId); legacy rows and malformed extras degrade to
plain questions. Parser bounds mirror the existing protocol posture: strict,
bounded, malformed extras dropped without invalidating the base question.

### 3. HITL is a protocol layer, not a new surface

Decision: **no new panel.** The Lead's inbox (Tasks tab) remains the single
presentation of "what needs me"; this ADR extends the richest primitive
(questions) in place. A unifying **gate substrate** — one record shape
`{kind, payload, blocking?, status, receipt, expiry?, autoAnswerPolicy}` that
questions/access/verify/manual-check converge on — is the right eventual
shape, but it earns its keep only when host-side away-notifications (OS
toasts) force a host-side inbox feed anyway. Building it now would be
speculative; building the feed twice later would be waste. Recorded as the
trigger condition, not a date.

## Security posture

Unchanged in kind. Image bytes flow container → host → webview only, rendered
as `<img src="data:">` under the strict CSP (never inline SVG markup); paths
are validated (absolute, in-sandbox, image extension, no traversal) before the
bounded exec; counts and sizes are capped at parse and at resolution. The
verify stamp reuses the existing guarded `subtask.update` path and stays a
human gesture — agents can *request* verification, never grant it.

## Deferred (recorded, not built)

- Gate substrate + host-side inbox feed (trigger: OS toast/away notifications).
- Blocking vs non-blocking gate semantics (agent declares "cannot proceed"
  vs "confirm when convenient"; inbox ranks accordingly).
- `[image:…]` tokens rendering inline in general transcript text (manual-check
  steps cover the instruction case today).
- "Add to task FAQ" checkbox at answer time (FAQ machinery exists, ADR 0007;
  needs task resolution in the shared card component).
- Answer parking ("remind me in an hour") and answering from the Agents panel.
