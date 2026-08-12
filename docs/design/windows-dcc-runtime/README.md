# Windows DCC validation runtime — docset

Design docset for ADR 0022: a pooled Hyper-V Windows VM that lets agents
auto-validate work under `mayapy`/`hython` with the studio's existing Windows
rez packages, without host execution and without any path to production.

Read in this order:

| Doc | What it covers |
|---|---|
| [upgrade-plan.md](upgrade-plan.md) | Phased delivery plan, gates, kill criteria, reference environment findings |
| [implementation-plan.md](implementation-plan.md) | Executable milestone breakdown (M0–M8) with file anchors, definitions of done, and the next-session agenda |
| [security-and-mounts.md](security-and-mounts.md) | Policy → enforcement mapping, curated `X:` namespace, fixture flow, probes |
| [ux-flows.md](ux-flows.md) | Setup, daily use, maintenance, and incident UX with annotated mockups |
| [edge-cases.md](edge-cases.md) | Edge-case catalog with decided behaviors and open questions |
| [runbook.md](runbook.md) | TD maintenance tasks: provision, mirror sync, clean baseline, image update, incident response |

Mockups live in [images/](images/); each is referenced from a flow in
`ux-flows.md`.

Guiding constraint (from the sponsor): **seamless or bypassed.** Developers
already have `mayapy` in a terminal. Every flow here is designed against
measurable friction budgets (see `ux-flows.md` §Principles); when the product
is slower or noisier than the bypass, the design is wrong.
