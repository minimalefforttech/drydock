# Provider sign-in and the provider registry (proposal)

Status: phases 0-2 implemented on `chat_ux_fixes` (2026-07-24); phase 3 and
the spikes below remain open. One scope refinement was ratified during
implementation: auth handshakes are interactive user setup, not agent work,
so they run on the HOST (like `sbx secret set` always has) - only
prompt-bearing agent execution must stay inside sandboxes. This makes the
guided Claude path `claude setup-token` on the host (browser + callback work
natively) with the token piped into `sbx secret set -g anthropic`, falling
back to the in-sandbox terminal flow when no host Claude CLI exists.
Companion reading: `docs/design/threat-model.md`, `docs/design/api-reference.md`
(Auth Provider Service section), `docs/adr/0017-sandbox-preview-servers.md`,
`docs/adr/0018-sandbox-side-channel-and-honest-session-views.md`.

Implementation map: registry `packages/contracts/src/providerRegistry.ts`;
guided flows `apps/vscode-extension/src/services/providerConnectService.ts`;
runtime wiring `apps/vscode-extension/src/services/providerWire.ts` +
`ChatSessionService.prepareRuntime`; recheck/TTL split + registry-driven
status in `apps/vscode-extension/src/services/isolatedRunService.ts`; connect
card in `apps/vscode-extension/webview-ui/src/views/chatTab.ts`.

## 1. The problem, step by step

Observed first-run experience signing Claude in (Codex is similar but less
painful):

| Step the user performed | Why it happens (code) |
| --- | --- |
| Clicked Log in; a terminal opened instead of a browser | `provider.login` opens a VS Code terminal running `sbx run claude` (`controlPanelProvider.ts:754-768`) because Docker Sandbox rejects `sbx secret set -g anthropic --oauth`, so there is no host-side OAuth path for Anthropic (`isolatedRunService.ts:1471-1478`) |
| Typed `/login` as instructed | The instruction is literal UI copy: "Type /login there to sign in" (`chatTab.ts:2748`). Nothing drives the CLI for the user |
| Got a link, opened it manually in a browser | Claude runs inside a microVM with no browser and no way to open one; drydock never sees the URL because the terminal owns stdout |
| Email + 6 digit code | Anthropic account verification. External to us; unavoidable on a fresh browser session |
| Pasted a long code string back into the terminal | Claude's OAuth callback server binds localhost inside the VM, unreachable from the host browser, so Anthropic falls back to the manual copy/paste code flow |
| Clicked Recheck; showed connected only ~5 minutes later | Recheck sends `provider.list`, which funnels through `refreshHostProviderCatalogs()`. That method is TTL-gated by `HOST_CATALOG_TTL_MS = 5 * 60_000` (`isolatedRunService.ts:225,1561`) and the timer starts at panel init, so the auth probe (`sbx secret ls`) is silently skipped for up to 5 minutes. There is also no `onDidCloseTerminal` listener anywhere: login is fire and forget |

Codex today: `sbx secret set -g openai --oauth` runs the OAuth flow on the
host (browser opens, localhost callback works), which is already near-native.
But it opens in a bare terminal with no completion detection, and the same
Recheck TTL bug applies. Upstream watch item: docker/sbx-releases#160 reports
ChatGPT-plan tokens being rejected in-sandbox after a successful host OAuth.

## 2. Ground truth about the platform (verified 2026-07)

Docker Sandbox credential model
(https://docs.docker.com/ai/sandboxes/security/credentials/):

- The sandbox proxy injects real credentials into outbound HTTPS requests on
  behalf of the agent. Containers only ever see sentinel values such as
  `proxy-managed`. Real values live in the OS keychain via `sbx secret set`.
- Built-in services with env var + domain mappings: `anthropic`, `openai`,
  `google`, `github`, `cursor`, `droid`, `groq`, `mistral`, `nebius`,
  `openrouter`, `xai`.
- `sbx secret set -g <service>` accepts an API key (pipeable via stdin; the
  prevalidate README already documents this for `openai`). `--oauth` runs a
  host-side browser flow, currently for OpenAI style services only; Anthropic
  OAuth is the documented in-sandbox `/login` exception.
- `sbx secret set-custom` (experimental) covers providers outside the
  built-in list: domain patterns + env var + placeholder; the proxy replaces
  the placeholder anywhere in requests to the configured hosts.
- `sbx ports <sandbox> --publish HOST:SANDBOX` exists upstream, but drydock
  deliberately uses zero published ports; the exec channel is the only
  host-initiated data path (ADR-0018), and previews bridge via bounded execs
  (ADR-0017).

Agent CLIs:

- Claude Code's OAuth callback is `http://localhost:54545/callback`, fixed by
  default and configurable with `--callback-port` / `oauth.callbackPort`.
  Devcontainer users already make browser login work by pre-forwarding a
  known port. `claude setup-token` mints a ~1 year subscription token
  (consumed via `CLAUDE_CODE_OAUTH_TOKEN`) using a URL + paste-code flow that
  is fully drivable over stdio.
- Claude Code speaks to any Anthropic-compatible endpoint via
  `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (env or settings.json `env`
  block). Officially documented by DeepSeek
  (`https://api.deepseek.com/anthropic`), Moonshot/Kimi
  (`https://api.moonshot.ai/anthropic`), and OpenRouter ("Anthropic skin").
- Codex CLI supports arbitrary OpenAI-compatible providers via
  `model_providers` in `config.toml` (`base_url`, `env_key`, `wire_api`).

## 3. Constraints any redesign must keep

From the threat model and ADRs (all already ratified):

- The extension host does inert auth checks only; no model calls, no raw
  secret storage, no secret values in events/plans/webview. Secrets are
  references (`sbx:service/*`, `vscode-secret:<provider>`).
- `docs/design/api-reference.md` already specifies the target shape: an
  `AuthProviderService` with `requestLogin`, `validateLogin`,
  `resolveSecretRef`, `injectRuntimeAuth`, `revokeSessionAuth`, and
  `AUTH_REQUIRED` pause semantics (no host fallback). Today's
  `loginCommand()` + terminal is a placeholder for it.
- Managed mode forbids interactive sign-in entirely; admins pre-provision.
- Network egress stays default-deny; providers get scoped allowlists via
  `sbx policy allow network`, removed on cleanup.
- Provider/model switching is routing, never a permission change: a new
  provider must not widen mounts, network, or secret policy.

## 4. Proposal

### Phase 0: make Recheck honest (bug fixes, no design change)

1. Recheck must always probe. Either make `provider.list` accept
   `{ force: true }` or add a `provider.recheckAuth` message that calls
   `refreshProviderAuthStatuses()` directly, bypassing `HOST_CATALOG_TTL_MS`
   (the TTL should only throttle the model-catalog fetch, not the inert
   `sbx secret ls` probe, which is cheap).
2. Track login terminals: keep the `vscode.Terminal` returned in
   `provider.login` / `runtime.sbxLogin`, subscribe to
   `window.onDidCloseTerminal`, and on close force the auth probe and push
   `provider.models` so the banner flips without any click.
3. While a login terminal is open, poll the probe every few seconds (it is
   inert and local) so the banner can flip green the moment the credential
   lands, even before the user closes the terminal.

This alone converts "wait ~5 minutes and click Recheck" into "it turns green
by itself".

### Phase 1: drydock drives the sign-in (guided connect flow)

Replace "open a terminal and follow instructions" with a Connect flow the
product owns. New `AuthProviderService` (implementing the api-reference
sketch) runs the provider's login process itself with piped stdio instead of
a visible terminal:

- Spawn the same commands we spawn today (`sbx secret set -g openai --oauth`
  for Codex; for Claude a non-interactive login inside a throwaway sandbox,
  see spike S1: `sbx exec <sandbox> claude setup-token` or equivalent).
- Scrape the login URL from stdout and call `vscode.env.openExternal(url)`.
  The user no longer types `/login` or clicks a link in a terminal.
- If the flow requires a paste-back code (Claude's manual fallback), show a
  single input field in the auth banner / connect card; write the value to
  the child's stdin. The code is an OAuth authorization code, not a stored
  secret; it transits process memory only and is never logged or persisted.
- On process exit: force the auth probe, push `provider.models`, and show
  success or the captured stderr tail on failure.
- If URL scraping fails (CLI output changed), fall back to today's visible
  terminal so the user is never stuck.

Resulting Claude UX: click Connect, browser opens by itself, sign in (email
code only if Anthropic asks), paste one string into a drydock field, banner
flips green immediately. Codex UX: click Connect, browser opens, done.

Managed mode: the connect card renders as "provisioned by your
administrator" and the service refuses interactive flows, exactly as
`assertInteractiveSetupAllowed` does today.

### Phase 2: provider registry (OpenRouter, DeepSeek, Kimi, ...)

New AI providers do not get new transports. They ride the two existing CLIs;
the registry describes how. `AgentTransport` stays
`codex-app-server | claude-exec-json`.

```ts
interface ProviderDescriptor {
  providerId: string;            // "openrouter", "deepseek", "kimi"
  displayName: string;
  rideOn: "codex-cli" | "claude-cli";
  auth:
    | { kind: "sbx-oauth"; service: string }              // codex/openai
    | { kind: "in-sandbox-login"; service: string }       // claude subscription
    | { kind: "api-key"; service?: string;                // built-in sbx service
        custom?: { domains: string[]; envVar: string };   // sbx secret set-custom
        keyUrl: string };                                 // "get a key" link
  wire:
    | { kind: "openai-compat"; baseUrl: string; envKey: string }   // codex config.toml
    | { kind: "anthropic-compat"; baseUrl: string };               // claude env block
  egress: string[];              // sbx policy allow network entries
  models: { static: AgentModelSummary[]; discoveryPath?: string }; // GET /models
}
```

Launch set and their bindings:

| Provider | Ride on | sbx secret | Wire | Egress |
| --- | --- | --- | --- | --- |
| OpenRouter | either; default codex-cli | built-in service `openrouter` | openai-compat `https://openrouter.ai/api/v1` (or anthropic skin via claude-cli) | `openrouter.ai:443` |
| DeepSeek | claude-cli | `set-custom` on `api.deepseek.com` | anthropic-compat `https://api.deepseek.com/anthropic` | `api.deepseek.com:443` |
| Kimi (Moonshot) | claude-cli | `set-custom` on `api.moonshot.ai` | anthropic-compat `https://api.moonshot.ai/anthropic` | `api.moonshot.ai:443` |
| Mistral, xAI, Groq, Gemini | codex-cli | built-in services | openai-compat endpoints | per provider |

Mechanics, all reusing existing plumbing:

- Key entry: the connect card collects the key in a masked field and pipes it
  to `sbx secret set -g <service>` (or `set-custom`) stdin, mirroring the
  documented prevalidate provisioning path. Drydock stores only the ref
  (`sbx:service/<name>`), never the value. Alternative with zero extension
  transit: open the sbx prompt in a terminal as today, now with Phase 0 auto
  detection (spike S2 confirms prompting behavior).
- Config injection into the sandbox uses the `.mcp.json` precedent (exec
  side-channel, base64):
  - codex-cli riders: write `config.toml` with the `model_providers` entry.
    `env_key` in the container holds the sentinel; the proxy injects the real
    key at the HTTPS layer.
  - claude-cli riders: write `/workspace/.claude/settings.json` with an `env`
    block (`ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, sentinel
    `ANTHROPIC_AUTH_TOKEN`), or wrap the exec command with env assignments.
    Base URLs and sentinels are not secrets, so either channel is fine.
- Egress: session preparation appends the provider's `egress` entries to the
  existing `networkResources` advanced option; cleanup already removes them.
- Validation without touching secrets: run one bounded
  `sbx exec <sandbox> curl <models-endpoint>` inside a sandbox where the
  proxy injects the credential. The extension stays inert; status comes from
  the exit code. Model discovery can ride the same call.
- `normalizeModelSelection` / `assertSupportedModelSelection` /
  `transportForProvider` switch from hardcoded codex/claude to registry
  lookups; `PROVIDER_SBX_SERVICES` folds into the registry.

Per the threat model, a registry entry never widens policy: same mounts, same
approval flow, only the declared egress domains differ, and those remain
visible in `IsolationSummary.networkAllowlist`.

### Phase 3 (stretch): zero-paste Claude login

Claude's callback port is fixed/configurable. ADR-0017 already bridges
host-loopback HTTP into a sandbox via one bounded exec. Combine them:

1. Start the throwaway login sandbox; run login with `--callback-port 54545`.
2. Host binds `127.0.0.1:54545` with the ADR-0017 style relay (each request
   is one `sbx exec` doing a loopback fetch inside the sandbox).
3. Open the scraped URL. Anthropic redirects the host browser to
   `localhost:54545/callback`; the relay delivers it to the CLI inside the
   sandbox; login completes with no paste at all.

No published ports, consistent with ADR-0018. Do this only if the Phase 1
paste flow still feels heavy; it is strictly additive.

## 5. Spikes and open questions

- S1: exact non-interactive Claude login invocation inside a sandbox.
  Candidates: `claude setup-token` (documented stdio flow) vs driving the
  REPL `/login`. Check TTY requirements against the known conpty limitation
  noted in `extension.ts:319-322`; node-pty or `sbx exec -i` may be needed.
- S2: does `sbx secret set -g <service>` prompt interactively when stdin is
  a TTY, and does `set-custom` appear in `sbx secret ls` (auth probe
  coverage for custom providers)?
- S3: does the sbx `anthropic` service injection work with subscription
  OAuth tokens (Bearer + oauth beta header) or only `x-api-key`? Determines
  whether `setup-token` output can be stored as the service secret instead
  of relying on in-sandbox credential persistence.
- S4: watch docker/sbx-releases#160 (ChatGPT-plan token rejected in-sandbox)
  and any upstream addition of `sbx secret set -g anthropic --oauth`, which
  would collapse the Claude special case entirely.
- S5: OpenRouter anthropic-skin fidelity for claude-cli agent workloads;
  OpenRouter recommends pinning Anthropic first-party for Claude Code, so
  default OpenRouter to the codex-cli ride.

## 6. Sources

- https://docs.docker.com/ai/sandboxes/security/credentials/
- https://docs.docker.com/reference/cli/sbx/ports/
- https://github.com/docker/sbx-releases/issues/160
- https://github.com/anthropics/claude-code/issues/2586 (fixed port 54545)
- https://github.com/anthropics/claude-code/issues/20793 (devcontainer
  callback forwarding, `--callback-port`)
- https://code.claude.com/docs/en/authentication (`claude setup-token`)
- https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/
- https://platform.kimi.ai/docs/guide/claude-code-kimi
- https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration
