# 0022 - Windows DCC validation runtime on Hyper-V

Status: Proposed - 2026-08-12 · Implemented behind the Phase-1 gate - 2026-08-13

> **Status note (2026-08-13).** M0-M8 are implemented and tested on branch
> ADR-22 (prevalidate gates, contracts/registry/routing, hyperv adapter,
> job service, mirror tooling, probe suite, full UX, policy keys). The M1a
> hardware smoke ran clean non-elevated (6.2 s control-plane round trip;
> extended ACLs survive checkpoint restore), and the full job pipeline has
> now been **live-fired against real DCCs** (hython 20.5, Blender 5.2) on
> the reference laptop through the exec seam's local transport - pass /
> fail / license-wait / stall+sweep all green, local round-trip baseline
> recorded - see `docs/design/windows-dcc-runtime/spike-report.md`. The M1
> kill-gate numbers (warm-restore, exec latency, stream latency, round-trip
> ratio) still require a studio workstation with the package share, a guest
> image, and license-server reachability; this ADR flips to Accepted only
> when that spike passes its ceilings. Two spike findings already shape the
> code: Windows OpenSSH has no ControlMaster, so exec is per-process behind
> a swappable transport seam; and PowerShell `-Command` space-joins trailing
> argv, so tagged guest scripts end on a constant comment line for the job
> token to land on (`VALIDATION_TAG_COMMENT`). Deferred items are listed in
> `implementation-plan.md` §Post-M8 backlog.

Refs: `docs/design/windows-dcc-runtime/` (docset), `docs/design/threat-model.md`,
ADR 0001 (isolation), ADR 0007 (verification requirements), ADR 0015 (bounded
fleet), ADR 0016 (human gates), ADR 0018 (exec side-channel).

## Context

Agents must auto-validate their work by running code under Windows-native
`mayapy`/`hython` against the studio's existing Windows rez packages. The
Docker Sandbox runtime is a Linux microVM and can never execute that stack.
Running validation on the host violates ADR 0001.

The studio policy is: read-write to the dev area, read-only to the package
area (`P:\Pipeline`), and no access to production (`P:\Projects`). Both live
on one SMB share (`\\studio-fs\share`), so network- or share-level separation
is not available without restructuring storage (server, share, and
drive-letter names in this docset are anonymized examples; the real values
live in studio configuration).

## Decision

We add a second runtime class beside disposable session runtimes: a
**validation runtime** — a product-adopted Hyper-V Windows VM (adapter kind
`hyperv`) that only ever runs validation jobs.

Validation runtimes form a **named registry with one default**, routed by an
association cascade (the ADR 0019 pattern): chat/task override → project/
workspace association → default runtime. Named runtimes (e.g. `cpp-builds`,
`pipzone`, `production_tester`) carry their own image, capabilities, policy
profile, and lifecycle (`keep-warm` | `on-demand` | `pinned`). The common
topologies are presets over this one model — "single VM" is just the
default; "one per project" is an auto-create association rule; "default +
named" is the model itself. Studio managed policy may cap VM count, restrict
images, or force a topology.

Routing never degrades silently: if a job's resolved runtime is unavailable,
the job parks with the reason. Rerouting to a runtime with a *different
policy profile* is always an explicit user action that shows the policy
delta — never automatic in either direction (threat-model rule: fallback
must not broaden access; broader-to-narrower fallback just fails confusingly).

- **Star topology.** Agents stay in their session runtimes. The host ships a
  changeset snapshot into a per-job folder in the VM, executes the validation
  profile over the exec channel (SSH over an internal host-only switch), and
  streams results back as verification evidence. Agent runtimes have no route
  to the VM; the VM has no route to agent runtimes.
- **No secrets, no internet.** The VM holds no provider credentials. Its vNIC
  is default-deny with allows for the host's internal-switch address and the
  DCC license server ports only.
- **Curated namespace, not path translation.** The VM maps a host-maintained
  read-only mirror as `P:` whose tree contains only allowlisted subtrees
  (`Pipeline\rez\packages\...`). Package definitions, `packages_path`, and
  baked contexts resolve byte-for-byte unchanged. `P:\Projects` exists only
  as an empty stub or a per-job fixture root — production is unroutable and
  unnamed, not merely denied.
- **Fixtures, never mounts.** Content from prohibited locations reaches a
  runtime only as an approved, size-capped, per-job snapshot copy recorded in
  the grants ledger with provenance and expiry. There is no write-back path
  to production from any runtime.
- **Hygiene by revert, not disposal.** The pooled VM relaxes ADR 0001's
  one-disposable-runtime-per-session rule for this runtime class only.
  Compensations: jobs are serialized with job-scoped workspaces and env dirs,
  the VM is reverted to a clean Hyper-V checkpoint on a policy cadence, and
  standing negative probes (read production must fail, write mirror must
  fail, reach non-allowlisted addresses must fail) quarantine the runtime on
  any violation.
- **Adoption before lifecycle.** v1 adopts a pre-provisioned VM through the
  existing inventory adopt path. Golden-image/differencing-disk lifecycle is
  deferred until per-session disposable VMs are actually wanted.

## Consequences

Validation evidence binds to a changeset hash, so results stay honest while
the agent keeps editing. Subagents inherit validation capability only if the
parent session has it, and fixture grants follow the existing
child-subset-of-parent mount rule.

We own new security-critical surfaces: the mirror sync, the port ACL set,
the probe suite, and the fixture copy path. The threat model gains a
validation-runtime section; prevalidate gains Hyper-V gates.

Per-runtime policy profiles concentrate risk visibly: a TD-created
`production_tester` runtime with a standing fixture set is a deliberate,
badged exception — creation of such profiles is TD-gated with typed
confirmation, and jobs show which runtime (and so which profile) produced
their evidence. Frequent project switching costs nothing at the VM layer:
association resolves per job, the default stays warm, and `on-demand`
runtimes report boot time as honest queue state.

A failed must-fail probe is a security incident surface (quarantine + block
+ banner), not a toast.
