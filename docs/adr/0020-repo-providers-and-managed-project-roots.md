# 0020 - Repo providers and managed project roots

Status: Accepted - 2026-07-24

Refs: `docs/ideas/background-lane-and-inspection-workspaces.md` (D2),
`docs/design/work-management.md`, 0001 (isolation and access policy), 0019
(secrets posture), `docs/design/studio-security-policy.md`

## Context

The project catalog only registered existing host folders, so every repo a
ticket needed had to be cloned by hand first. Studio work often lives on
self-hosted GitLab (and GitHub), and tickets routinely name projects that
have no local checkout yet. Bringing a remote repo in must not create a new
credential surface for sandboxes or a side door around the studio policy's
project-root controls.

## Decision

- **Repo providers are a host-side picker, not a live connection.**
  `Drydock: Add Project from GitHub/GitLab…` searches a provider, clones
  the pick HOST-SIDE over https into the managed projects root
  (`drydock.projectsRoot`, default `<stateRoot>/projects/<host>/<org>/<repo>`,
  path segments sanitized against traversal), and registers the folder
  through the normal `ProjectCatalogService` path - the studio policy gate
  applies unchanged, and from then on it is an ordinary catalog project.
- **Provenance, not coupling.** The catalog row gains optional `origin`
  metadata (provider, host, remote path, web URL, default branch). Origin
  is provenance for display and future fetch affordances; nothing reads it
  to reach the network implicitly.
- **Tokens follow the 0019 posture.** GitHub uses VS Code's built-in
  authentication provider; GitLab hosts (from `drydock.gitlabHosts`) use a
  per-host personal access token held in VS Code SecretStorage. Tokens are
  never rendered, never written to git config, never placed on a command
  line (git receives them only through a transient 0600 ASKPASS helper,
  deleted after the clone), and never enter a sandbox. Remote clones are
  https-only.
- **The sandbox never fetches.** Every network interaction here is the
  HOST acting on an explicit human gesture. Sandbox network policy is
  untouched by this decision.

## Consequences

- Remote-picked projects behave exactly like local ones for mounts,
  workspace sets, clone policies, and tickets; a missing local checkout is
  no longer a reason a ticket cannot name a repo.
- Fetch-on-task-start for origin-bearing projects is a deliberate
  follow-up, not implied: today the managed clone advances only when a
  human acts.
- Publishing flows (push, PR/MR creation) remain out of scope and would
  need their own decision - nothing in this ADR pushes anywhere.
