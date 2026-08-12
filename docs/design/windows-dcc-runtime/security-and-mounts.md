# Security and mounts — Windows DCC validation runtime

Companion to ADR 0022. Everything here is enforcement, not convention: the
test is always "what happens when agent-generated code tries", never "what
the prompt says".

## Policy → enforcement

| Studio policy | Mechanism | Layer |
|---|---|---|
| Read-write dev area | Changeset snapshot copied into a per-job workspace; results return as patch + report through review. Live dev files are never writable by running test code. | Host copy path |
| Read-only package area | Host-local mirror of allowlisted `X:\Pipeline` subtrees, shared read-only over the internal switch, mapped as `X:` in the guest. | SMB share ACL + NTFS |
| No production access | `X:\Projects` is unrouted (no NAS route from the guest), unnamed (absent or stub in the curated tree), uncredentialed (no account in the guest can open it), and denied in drydock mount policy. | Routing + namespace + ACL + `mountPolicy` denied paths |
| No internet from validation | vNIC default-deny extended port ACLs; allows = host internal-switch IP, license server IP:ports. No gateway, no DNS, no Default Switch. | Hyper-V port ACL |
| No provider secrets near test code | Validation VM holds no LLM credentials; agents keep theirs in session runtimes. | Placement |

The `X:\Projects` denial (and UNC equivalents) ships in the
administrator-managed policy file (`studio-security-policy.md`), not personal
settings — every workstation inherits it, and no session on any runtime kind
can approve production into a mount set.

## The curated `X:` namespace

The host maintains `xroot` (local disk): robocopy mirrors of exactly the
subtrees the manifest allows — initially
`Pipeline\rez\packages\{internal,external,staging}` plus whatever the
reference scan adds. The guest maps `\\<host-internal>\xroot` as `X:`.

- Every `X:\Pipeline\...` string in `package.py`, `packages_path`, and baked
  `.rxt` contexts resolves unchanged. No package edits, no config forks.
- Package cache stays guest-local (`C:\Users\<agent>\.rez\package_cache`) —
  the studio rezconfig already configures this.
- `rez release` targets `X:` and fails read-only by construction.
- `X:\Projects`: absent by default. When a job carries approved fixtures,
  the host seeds `xroot\Projects\<show>\...` server-side at the exact
  expected relative paths before the job and removes it after. Jobs are
  serialized, so the composition is deterministic. Packages that export
  `FR_ASSET_API_SILEX_ROOT = X:\Projects` therefore fail closed by default
  and resolve to job fixtures when granted — with the production-identical
  path string preserved.
- The mirror manifest is versioned. A standing scan of all `package.py`
  files diffs referenced `X:\...` roots against the manifest on every
  package release; new roots surface as a proposal, never a silent break.

## Getting prohibited content to the AI (fixture flow)

Two entry points, one mechanism:

1. **User-initiated:** drag a file into chat or pick via the fixture picker.
   The explicit gesture is the approval for read of that item; the card
   confirms scope (files, sizes, target runtime) in one click. Production
   paths always show the production risk tier.
2. **Agent-initiated:** the agent's access request names exact paths; the
   card renders them with sizes and risk tier. Production tier requires
   typed confirmation (ADR 0001 approval-cost rule).

On approve, the host copies a **snapshot** — never mounts — into the
session's uploads area (agent runtimes) or the job fixture root (validation
VM), records a grants-ledger entry (`source: "temporary"`, provenance,
expiry, content hash), and the chat shows a provenance chip. Folder grants
preview file count and total size before approval; oversized requests offer
a narrower selection instead of a bigger yes.

There is no write-back: nothing in any runtime can modify production, and
"send result to production" is not a product action. Output lands in the
dev area through review, like all other work.

## Subagents and delegation

- Fixture grants are session mounts of source `temporary`, so the existing
  child-subset-of-parent rule applies unchanged at spawn and on later
  requests: a child can hold at most the parent's fixtures.
- Validation capability is role-scoped: a child may queue validation jobs
  only if its parent session could. Jobs are tagged with task, session, and
  agent ids end to end, so evidence attributes to the requesting subagent.
- Subagents never address the VM. All jobs pass through the host queue.

## Mixed runtimes

A task may hold Linux sbx sessions and Windows validation jobs at once.
Rules that keep that honest:

- No shared mounts between runtime kinds, ever. Content moves as snapshots
  (changeset patch, fixtures) through the host.
- Evidence binds to the changeset hash it ran against. If the agent edits
  after job start, the receipt is marked superseded rather than silently
  stale.
- Patch application to the Windows guest pins `core.autocrlf=false` and
  fails visibly on case-collision paths a Linux runtime could produce.

## Probes (standing, not one-time)

Run at adopt, on schedule, and before first job after any revert:

- Read `X:\Projects` (real path, not stub) → must fail.
- Write anywhere under mirrored `X:` → must fail.
- Connect to any address outside the allowlist (including the NAS) → must
  fail.
- Resolve the standard validation toolsets → must succeed; every path in
  the resolved environment must exist.

Any must-fail success ⇒ runtime `quarantined`, queue blocked, incident
banner. Probe results are part of runtime health in the UI and are stamped
into evidence (`probesGreenAt`).

## Residual risks (accepted, with bounds)

- A malicious job can tamper with the shared guest for later jobs (e.g.
  poison the rez package cache). Bounds: no secrets or egress worth
  stealing, serialized jobs, checkpoint revert cadence restores clean state,
  evidence records revert generation.
- SMB ACLs on the host share are a flatter boundary than sbx virtiofs
  read-only mounts. Bounds: share is single-purpose, single-account, bound
  to the internal switch; probes verify continuously.
- License-port egress is a theoretical exfiltration channel. Bounds: fixed
  IP:ports, license protocols, negligible bandwidth; accepted.
