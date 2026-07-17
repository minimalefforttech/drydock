# Drydock

> **Note:** Drydock is currently an AI-generated prototype experiment. It is
> an attempt to solve the compliance boundary for AI-assisted development in
> VFX. Use in production is at your own risk. Contributions welcome.

Drydock is a security-first engineering AI workbench for VS Code. Coding
agents run in disposable Docker Sandbox runtimes, with explicit host mounts
and review before work is pulled back into your working tree.

## Requirements

- VS Code 1.101 or newer.
- Node.js is supplied by VS Code; the extension requires the Node 22 extension
  host used by VS Code 1.101+.
- Docker Desktop with Docker Sandbox (`sbx`) installed and authenticated.
- A supported agent CLI authenticated for use inside the sandbox (Codex or
  Claude Code).

## First run

1. Install the VSIX and reload VS Code.
2. Open **Drydock** from the Activity Bar.
3. Review the preflight status before starting an agent.
4. Create or select a task and workspace set, then start a contained chat.

Drydock stores durable state under `~/.drydock` by default. The location and
runtime environment settings are machine-scoped so a repository cannot
redirect state, replace runtime executables, or weaken the default denied-path
policy through workspace settings.

## Safety model

- Agent prompts, tools, and model output run inside disposable runtimes.
- Host filesystem access is limited to explicit mounts and denied sensitive
  credential roots by default.
- Clone-mode work is only pulled into the local working tree after a user
  action; Drydock does not commit or push it.
- Model text is treated as untrusted content by the extension webviews.

This is currently a VSIX-only pre-release and is not published to a marketplace.
