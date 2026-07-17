# Studio security policy

Drydock has two policy layers for a simple studio workflow:

- A studio policy sets the maximum access available to AI on a workstation.
- Personal machine settings let a user restrict AI further without changing the user's own filesystem access.

The studio policy is intentionally local. It controls which projects this Drydock installation may expose, whether project work must use private clones, which repository paths must be omitted, and whether networked AI may run on this machine. It does not route work to another machine or add an external AI provider.

## Policy location and deployment

Drydock reads one fixed, OS-managed file when the extension starts:

| Platform | Policy path |
| --- | --- |
| Windows | `C:\ProgramData\Drydock\policy.json` |
| macOS | `/Library/Application Support/Drydock/policy.json` |
| Linux | `/etc/drydock/policy.json` |

If the file is absent, Drydock uses personal restrictions only. If the file exists but is unreadable, invalid JSON, or not a valid version 1 policy, Drydock blocks startup rather than silently ignoring it. Reload the VS Code window after deploying a change.

Deploy the file with MDM, configuration management, or an installer, and use OS permissions that let the user read but not edit or replace it. The policy is not a security boundary if the user can modify the policy, Drydock installation, extension process, or its runtime. A local administrator can bypass local controls and must be handled by the studio's wider endpoint controls.

## Version 1 format

For an allocated Windows AI workstation, a practical policy is:

```json
{
  "version": 1,
  "policyId": "production-ai-workstations-v1",
  "allowedProjectRoots": [
    "D:\\Shows\\AllocatedForAI"
  ],
  "deniedPaths": [
    "D:\\StudioAdministration",
    "D:\\Credentials"
  ],
  "cloneOnly": true,
  "omitSensitiveFiles": true,
  "omittedRepoPaths": [
    "config/local",
    "pipeline/credentials"
  ],
  "allowNetworkedAiOnThisMachine": true
}
```

| Field | Meaning |
| --- | --- |
| `version` | Required. Must be `1`. |
| `policyId` | Required non-empty identifier used to identify the deployed policy. Change it when the managed policy meaningfully changes. |
| `allowedProjectRoots` | Optional array of existing absolute directories. AI may use only these directories or their descendants. An empty array permits no projects; omitting the field adds no studio allowlist. |
| `deniedPaths` | Optional array of host paths that AI must never mount or receive through an access request. A project is refused if its root contains a denied path or is inside one. Use this for whole host security boundaries, not a folder that should merely be removed from a clone. |
| `cloneOnly` | When `true`, project-backed plan and implementation work is automatically tightened to a private local Git clone instead of mounting the live project. |
| `omitSensitiveFiles` | Enables the built-in path preset for common environment, credential, key, secret, and cloud-configuration names. It also implies clone-only mode. |
| `omittedRepoPaths` | Exact repository-relative file or folder prefixes. `config/local` matches that path and its descendants. Absolute paths, `..`, `.git`, and globs are not accepted. Any entry implies clone-only mode. |
| `allowNetworkedAiOnThisMachine` | Set `true` only in policy targeted to allocated machines. `false` or omission blocks networked AI. |

For a safe fleet rollout, deploy a baseline policy with `allowNetworkedAiOnThisMachine: false`, then target a separate policy with `true` only to the workstation allocation group.

## Effective policy

Personal settings can only narrow a studio policy:

- Allowed project roots are the intersection of the studio and personal allowlists. The more specific overlapping root wins; no overlap permits no projects.
- Studio, personal, and default denied paths are combined. A personal setting cannot remove a studio denial.
- Clone-only and sensitive omission are enabled if either policy enables them.
- Exact omitted repository paths from both layers are combined.
- Without a managed policy, networked AI follows the personal `drydock.security.networkedAiEnabled` setting. With one, both that setting and an explicit `allowNetworkedAiOnThisMachine: true` are required.

The corresponding personal settings are `drydock.security.allowedProjectRoots`, `drydock.security.cloneOnly`, `drydock.security.omitSensitiveFiles`, `drydock.security.omittedRepoPaths`, `drydock.security.networkedAiEnabled`, and `drydock.deniedPaths`. They are useful when a user has access to many productions but wants AI enabled for only a selected subset.

## Runtime behavior

Drydock checks the effective host-path policy when a project is registered and again before work starts. Canonical filesystem paths are checked so a symlink cannot be used to escape an allowlist. A project outside the effective allowlist, or intersecting a denied path, is refused with a direct explanation.

When clone-only is effective, Drydock automatically selects clone mode; the user does not need to choose a different workflow. Older sessions that used live mounts cannot be resumed under a new clone-only policy. Access requests cannot add host mounts to a clone session, and prior approvals are not remounted into it.

Repo-owned planner aspects and task recipes are loaded only from permitted roots and are suppressed when their `.drydock` file is omitted. Global approved-memory briefing is disabled under managed or project-restricting policy until memories carry project provenance.

Repository omission is deliberately fail closed:

- Matching untracked files are skipped when the working state is carried into the clone.
- If a matching path is currently tracked or appears anywhere in reachable Git history, the clone is blocked before repository objects are copied. Removing only the checked-out file would not prevent recovery from `.git`.
- Omission is path-based, not secret-content scanning. Sensitive material stored under an unlisted filename requires an exact omitted path or another studio control.

To resolve an omission block, remove the content from Git including reachable history, or change the omission only if studio policy permits it. Do not use `deniedPaths` to hide a nested project folder: because a live mount of the parent would contain it, that rule correctly blocks the entire project. Use clone omission for that case.

## Assurance scope

This policy provides a small, reviewable control surface and useful evidence for least privilege, project authorization, local isolation, and workstation allocation. It can support a studio's alignment with industry or content-owner security requirements, but it is not a certification or a content-owner approval, and it is not a substitute for an assessment, endpoint hardening, identity controls, monitoring, incident response, and documented studio procedures.
