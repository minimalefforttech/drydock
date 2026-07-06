# Stage 0 Prevalidation

This CLI is the hard gate before any VS Code extension scaffolding begins.

Run:

```powershell
npm install
npm run prevalidate
```

Use strict mode in CI or when deciding whether Stage 1 may begin:

```powershell
npm run prevalidate:strict
```

Outputs:

- `prevalidation.json`: machine-readable result.
- `docs/prevalidation-report.md`: human-readable result.

## Command Discovery

The harness searches `PATH` and known Windows install locations. Override discovery with:

```powershell
$env:PREVALIDATE_SBX_PATH="$env:LOCALAPPDATA\DockerSandboxes\bin\sbx.exe"
$env:PREVALIDATE_DOCKER_PATH="C:\Program Files\Docker\Docker\resources\bin\docker.exe"
$env:PREVALIDATE_CODEX_PATH="$env:LOCALAPPDATA\OpenAI\Codex\bin\<version>\codex.exe"
$env:CODEX_ACP_COMMAND="codex-acp"
$env:PREVALIDATE_DOCKER_CONTEXT="desktop-linux"
$env:PREVALIDATE_CODEX_AUTH_DIR="$env:USERPROFILE\.codex"
```

Codex is required for Stage 0. The harness prefers the standalone Codex CLI under `%LOCALAPPDATA%\OpenAI\Codex\bin\...` over the WindowsApps app alias because the alias can be visible on `PATH` but fail with `Access is denied`.

Codex rich-client communication is validated through `codex app-server` JSON-RPC, which is the interface current Codex documentation describes for VS Code-style integrations. A literal ACP command is optional compatibility only. The harness will use `CODEX_ACP_COMMAND`, a `codex-acp` executable, or `codex acp` only when the installed Codex help advertises that subcommand.

`CODEX_ACP_COMMAND` may include arguments; use it only when a literal Codex ACP adapter is installed outside `PATH` and you want the optional ACP compatibility probe to run.

Claude is represented in the required adapter registry and probed locally only when a `claude` CLI is installed. A missing Claude CLI is a skipped optional probe, not a Stage 0 blocker while Codex remains the selected required backend.

`PREVALIDATE_CODEX_AUTH_DIR` is explicit opt-in for the Docker-container Codex check. When set to a directory containing `auth.json`, the harness copies that auth file into a disposable container instead of silently mounting host Codex secrets.

## Current Local Setup Notes

On this machine, Stage 0 found:

- Docker CLI is installed and Docker Desktop can provide the fallback runtime.
- Docker Sandbox CLI is installed at `%LOCALAPPDATA%\DockerSandboxes\bin\sbx.exe`.
- Docker Sandbox daemon is running and `sbx login` has been completed.
- Docker Sandbox can create shell and Codex sandboxes and enforce the tested mount policy.
- The WindowsApps Codex executable is visible but returns `spawn EPERM`; discovery now prefers the newest standalone binary under `%LOCALAPPDATA%\OpenAI\Codex\bin\...\codex.exe`.
- Host Codex login and app-server JSON-RPC communication pass.
- Docker-container Codex login and app-server JSON-RPC communication pass when `PREVALIDATE_CODEX_AUTH_DIR="$env:USERPROFILE\.codex"` is set for the run.
- Docker Sandbox Codex login passes after `sbx secret set -g openai --oauth`.
- Docker Sandbox advertises agent templates for Codex, Claude, and other agents; the harness records this as adapter-registry evidence.
- Provider auth is validated as explicit login/secret-reference/reinjection state. `sbx secret ls` must not expose raw secret values.
- Runtime access-request restart is validated by creating a sandbox, checkpointing a runtime-local artifact, stopping/removing it, recreating it with approved extra mounts, restoring the artifact, and verifying mounted edits persisted.
- The live Docker Sandbox Codex JSONL smoke test temporarily adds a sandbox-scoped allow rule for `chatgpt.com:443,ab.chatgpt.com:443,files.openai.com:443,api.openai.com:443`, removes it after the run, and keeps the global default-deny policy.
- The live JSONL smoke test uses Codex's bypass flag inside the microVM so Docker Sandbox remains the enforcement boundary and Codex's inner Linux sandbox does not mask backend validation with duplicate mount issues.

To provide credentials to new Codex sandboxes, run one of:

```powershell
sbx secret set -g openai --oauth
# or pipe an API key into:
sbx secret set -g openai
```

Then rerun:

```powershell
$env:PREVALIDATE_CODEX_AUTH_DIR="$env:USERPROFILE\.codex"
npm run prevalidate
```

Stage 1 remains blocked until required checks pass or are explicitly deferred in the plan.

