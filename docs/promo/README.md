# Drydock — promotional GIFs

Short, looping captures of Drydock's features and workflows. Open
[`index.html`](index.html) for the gallery. Two kinds, two pipelines.

## Core functionality — real bundled panel (`record.mjs`)

These record the **actual bundled control panel** (the same `main.js`/`main.css`
that ship in the VSIX) rendered by the webview harness with its mock host,
driven through live workflows, composed into a captioned landscape frame
(`src/wrap.html`).

| GIF | Workflow |
|---|---|
| `core-session.gif` | A tour of one contained session — conversation, code/diagram output, the subagent hierarchy, a pending approval, an open question, the working set |
| `core-approvals.gif` | An agent requests a host path; the risk-tiered card, then typed-confirm for the sensitive root |
| `core-subagents.gif` | A live subagent fan-out — two children, a nested grandchild, one failure — as a hierarchy |

```
node docs/promo/record.mjs                 # all core scenes
node docs/promo/record.mjs approvals       # one scene
```

How it works: `record.mjs` starts the harness server, launches headless Chrome
with remote debugging, and for each scene navigates to the wrapper, sets its
caption, and runs a **timeline** of steps (each drives the real panel through
`window.P` — select a session, switch tabs, fire a `__harness.scenario`, click a
button, pan the transcript) while grabbing frames via CDP `Page.captureScreenshot`
at a fixed cadence. Frames are encoded to a looping GIF with ffmpeg. Real time
in, real footage out — no mock UI. The scene list and timelines live at the top
of `record.mjs`.

## Task board & subtasks — deterministic scenes (`build.mjs`)

These mirror the task-board harness visual tests, rendered in the product's
design language as deterministic per-frame animations.

| GIF | Workflow | Test |
|---|---|---|
| `drag.gif` | Move a card across the board | V42 |
| `depend.gif` | Draw a dependency; same-task boundary grey-out | V48 / V49 |
| `cascade.gif` | Finished run → Review; dependents auto-start in parallel | V47 |
| `unblock.gif` | A blocked subtask clears itself | computed-blocked |
| `memory.gif` | Renamed "Orphaned Chats" + openable memories | V40 |

```
node docs/promo/build.mjs                  # all task-board scenes
node docs/promo/build.mjs cascade          # one scene
```

Each `src/<name>.html` reads `?f=<frame>&K=<total>` and paints one exact
keyframe (no transitions), so it renders identically every load; `build.mjs`
screenshots each frame in headless Chrome and encodes with ffmpeg. Shared kit:
`src/common.css` (board components) + `src/frame.js` (the `PROMO` frame driver).

## Requirements

System **Chrome** (or `CHROME=/path`) and **ffmpeg** on `PATH`. Frame PNGs/JPEGs
go to `.frames/` (git-ignored scratch); only the `.gif` files are committed.
