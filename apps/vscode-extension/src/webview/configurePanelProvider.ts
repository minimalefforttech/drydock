/**
 * Configure editor panel host (UX overhaul P6).
 *
 * ONE singleton editor-area WebviewPanel over everything that used to be
 * spread across the System tab and the settings JSON: Providers · MCP Servers ·
 * Agents & Models · Preprompts · Skills & Recipes · Memories · Runtime ·
 * Validation · Security. It owns its own dispatch - `parsePanelRequest` gates
 * every inbound message and this provider answers ONLY the `config.*` and
 * `memory.*` namespaces plus the `panel.init` boot, so a Configure webview can
 * never reach a chat, a runtime, or the board. That allowlist now includes the
 * `config.validation.*` registry writes (ADR 0022 M7): they are TD-facing
 * configuration, so they belong to this panel, while the developer-facing
 * `validation.*` half is dispatched by the control panel. The `memory.*` handlers are the ADR
 * 0019 store (quick-add, browser, agent-proposal approval gate), re-homed here
 * after ADR 0020 retired the Tasks tab; they share `memoryShared.ts` with the
 * chat host so the two surfaces cannot drift.
 *
 * Three provenance rules decide what a row may do, and they are enforced HERE,
 * not in the webview:
 *
 * - `local`    SQLite the panel owns (MCP registry rows, per-provider default
 *              model in `app_state`): editable.
 * - `settings` a `drydock.*` VS Code setting: written through
 *              `workspace.getConfiguration().update(..., Global)`. The machine
 *              scope accepts the Global target; most of these only take effect
 *              on the next window, which the row's `requiresReload` chip says
 *              out loud. Only keys in SETTING_DEFS are writable - the webview
 *              cannot name another extension's configuration.
 * - `project`  a `.drydock/` file in an open folder (read-only): the row has
 *              no control, only "edit the file ↗", and `config.openFile`
 *              re-checks the requested path against the exact list this
 *              provider last advertised.
 *
 * There is no Save button: each write is its own request and the row reports
 * itself saved when the host answers.
 *
 * SECURITY: MCP env VALUES never cross the boundary (key names only, like every
 * other MCP surface); provider sign-in reuses the existing loginCommand +
 * visible-terminal flow so no credential passes through the extension; and the
 * CSP is the strict task-board CSP with no `unsafe-inline` anywhere.
 */

import { randomBytes } from "node:crypto";
import path from "node:path";
import * as vscode from "vscode";
import {
  parsePanelRequest,
  PROVIDER_REGISTRY,
  WEBVIEW_PROTOCOL_VERSION,
  type ConfigAspectRow,
  type ConfigMcpRow,
  type ConfigPrepromptRow,
  type ConfigProviderRow,
  type ConfigRecipeRow,
  type ConfigScope,
  type ConfigSettingRow,
  type ConfigSettingValue,
  type ConfigState,
  type ConfigTagRuleRow,
  type HostToWebviewMessage,
  type PanelPushPayload,
  type PanelRequest,
  type PanelResponsePayload,
  type PlanAspectRecord,
  type ValidationConfigState
} from "@drydock/contracts";
import { DEFAULT_TAG_RULES, type Logger } from "@drydock/core";
import type { Backend, BackendReady } from "../compositionRoot.js";
import type { ValidationAppService } from "../services/validationAppService.js";
import { MCP_OVERLAY_ID_PREFIX, type McpProjectServer } from "../services/mcpProjectOverlay.js";
import { memoryUri } from "./memoryContentProvider.js";
import { memoryAnchorPorts, memoryTaskTitles, resolveMemoryEdits, toMemoryCandidateSummary } from "./memoryShared.js";

/** How many recent chats the "used by" count on a provider card looks back over. */
const RECENT_CHAT_WINDOW = 50;
/** app_state key holding a provider's chosen default model. */
const DEFAULT_MODEL_KEY_PREFIX = "config.defaultModel.";
/** Settings changes outside this panel collapse into one push. */
const PUSH_DEBOUNCE_MS = 250;

/**
 * The authoritative list of settings this panel surfaces, in render order.
 * `key` omits the `drydock.` prefix. Anything not in here is not writable
 * through `config.setSetting`, whatever the webview asks for.
 *
 * `requiresReload` mirrors package.json: every machine-scope setting consumed
 * at activation (PATH, env, denied paths, policy) needs a new window;
 * the live-read ones (run slots, idle threshold) do not.
 */
interface SettingDef {
  readonly key: string;
  readonly section: "runtime" | "security" | "memories" | "preprompts";
  readonly label: string;
  readonly detail: string;
  readonly kind: ConfigSettingRow["kind"];
  readonly fallback: ConfigSettingValue;
  readonly requiresReload: boolean;
  readonly min?: number;
  readonly max?: number;
  /** Managed policy pins this row; the panel renders it read-only. */
  readonly managedLock?: string;
}

const SETTING_DEFS: readonly SettingDef[] = [
  {
    key: "runtime.pathAdditions",
    section: "runtime",
    label: "Extra folders on PATH",
    detail: "Prepended when Drydock runs sbx and the agent CLIs. The standard Docker Desktop folders are already included.",
    kind: "string-list",
    fallback: [],
    requiresReload: true,
    managedLock: "Managed mode ignores local PATH overrides."
  },
  {
    key: "runtime.env",
    section: "runtime",
    label: "Extra environment variables",
    detail: "Passed to Drydock's runtime tools. VS Code stores these as ordinary settings, so do not put secrets here — sign providers in instead.",
    kind: "string-map",
    fallback: {},
    requiresReload: true,
    managedLock: "Managed mode ignores local environment overrides."
  },
  {
    key: "runtime.copyEnv",
    section: "runtime",
    label: "Variables to forward from this window",
    detail: "Names only. Drydock already inherits the host environment; this is for the ones a launcher strips.",
    kind: "string-list",
    fallback: [],
    requiresReload: true,
    managedLock: "Managed mode ignores this setting."
  },
  {
    key: "orchestrator.maxConcurrentRuns",
    section: "runtime",
    label: "Agents running at once",
    detail: "Further starts wait in a visible queue; a manual start jumps the queue. Auto derives the number from this machine's cores and memory.",
    kind: "number",
    fallback: 0,
    requiresReload: false,
    min: 0,
    max: 64
  },
  {
    key: "runtime.appServerInactivityTimeoutMs",
    section: "runtime",
    label: "Quiet-turn warning after",
    detail: "Milliseconds of silence before Drydock logs a stall note. The turn is never auto-failed; 0 turns the note off.",
    kind: "number",
    fallback: 300_000,
    requiresReload: true,
    min: 0
  },
  {
    key: "agentIdleThresholdMinutes",
    section: "runtime",
    label: "Call an agent idle after",
    detail: "Minutes without activity before a delegated agent is labelled idle.",
    kind: "number",
    fallback: 5,
    requiresReload: false,
    min: 1,
    max: 120
  },
  {
    key: "deniedPaths",
    section: "security",
    label: "Folders the agent can never reach",
    detail: "Excluded from mounts, snapshots, and diffs. A mount that overlaps one in either direction is refused, even after you approve it.",
    kind: "string-list",
    fallback: [],
    requiresReload: true
  },
  {
    key: "disableDefaultDeniedPaths",
    section: "security",
    label: "Drop the built-in protection for home config folders",
    detail: "Not recommended. By default ~/.ssh, ~/.aws, ~/.gnupg, ~/.kube, ~/.azure and ~/.docker can never be mounted.",
    kind: "boolean",
    fallback: false,
    requiresReload: true,
    managedLock: "Managed mode always keeps the built-in protections."
  },
  {
    key: "security.allowedProjectRoots",
    section: "security",
    label: "Only these folders may be used by AI",
    detail: "Empty means no personal allowlist. This can only narrow an administrator's policy, never widen it.",
    kind: "string-list",
    fallback: [],
    requiresReload: true
  },
  {
    key: "security.cloneOnly",
    section: "security",
    label: "Always work in a private clone",
    detail: "Agents get a copy of the repository instead of your live folder; you review and land the changes yourself.",
    kind: "boolean",
    fallback: false,
    requiresReload: true
  },
  {
    key: "security.omitSensitiveFiles",
    section: "security",
    label: "Keep credential files out of clones",
    detail: "Leaves .env files, secrets folders, keys and cloud config behind. If one is in reachable Git history Drydock blocks the clone rather than pretending deletion is safe. Turns on clone-only.",
    kind: "boolean",
    fallback: false,
    requiresReload: true
  },
  {
    key: "security.omittedRepoPaths",
    section: "security",
    label: "Extra repository paths to leave behind",
    detail: "Exact files or folders, for example config/local. Descendants are included; globs are intentionally unsupported. Turns on clone-only.",
    kind: "string-list",
    fallback: [],
    requiresReload: true
  },
  {
    key: "security.networkedAiEnabled",
    section: "security",
    label: "Allow new AI requests on this machine",
    detail: "Turning this off stops new turns and new runtimes. Runtimes already running are cleaned up separately.",
    kind: "boolean",
    fallback: true,
    requiresReload: true
  },
  {
    key: "memory.tagRules",
    section: "memories",
    label: "Extra file patterns that tag a project",
    detail: "Tags are detected per mounted folder and decide which tagged team memories a briefing carries. These extend the built-in table below.",
    kind: "tag-rules",
    fallback: [],
    requiresReload: true
  },
  {
    key: "teamInstructionsPath",
    section: "preprompts",
    label: "Studio standing instructions",
    detail: "A markdown file appended to every session briefing, capped at 8 KB. Repo CLAUDE.md / AGENTS.md files are detected automatically.",
    kind: "string",
    fallback: "",
    requiresReload: true
  }
];

const SETTING_BY_KEY = new Map(SETTING_DEFS.map((def) => [def.key, def]));

export class ConfigurePanelProvider implements vscode.Disposable {
  /** Single instance: at most one Configure panel per window. */
  private panel: vscode.WebviewPanel | undefined;
  private sequence = 0;
  private scope: ConfigScope = "global";
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  /** Paths the last config.state advertised; config.openFile accepts only these. */
  private openablePaths: ReadonlySet<string> = new Set();
  /** The inert auth probe runs at most once per panel lifetime, in the background. */
  private authProbe: Promise<void> | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly backend: Backend,
    private readonly logger: Logger,
    /** Read-only project MCP rows from `.drydock/mcp.json` in the open folders. */
    private readonly mcpProjectOverlays: () => Promise<readonly McpProjectServer[]> = async () => [],
    /** The same `.drydock/planner-aspects.json` reader the planner registry uses, for provenance. */
    private readonly plannerAspectOverlays: () => Promise<readonly PlanAspectRecord[]> = async () => []
  ) {
    // A setting changed from the Settings editor (or another window) must not
    // leave stale values on screen; the webview refetches on the push.
    this.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("drydock")) return;
      this.schedulePush();
    }));
    // A freshly captured agent proposal lands in the Memories approval list
    // without a refetch. Deliberately NO toast - memory is never urgent.
    if (backend.available) {
      const unsubscribe = backend.bus.subscribe((event) => {
        if (event.kind === "memory-candidate-added") {
          this.push({ type: "memory.candidateAdded", candidate: toMemoryCandidateSummary(event.candidate) });
          return;
        }
        // ADR 0022: the registry moved (a runtime, an association, a probe run),
        // or a runtime was quarantined. The first is a coarse refetch signal;
        // the second is the F5 banner, which never auto-dismisses.
        if (event.kind === "validation-runtime-changed") {
          this.push({ type: "validation.changed" });
          return;
        }
        if (event.kind === "validation-quarantine") {
          const validation = backend.available ? backend.validation : undefined;
          const runtimeId = event.runtimeId;
          void (validation?.displayNameFor(runtimeId) ?? Promise.resolve(String(runtimeId)))
            .then((displayName) => {
              this.push({
                type: "validation.quarantine",
                runtimeId: String(runtimeId),
                displayName,
                probeId: event.probeId,
                detail: event.detail,
                at: event.at
              });
            })
            .catch(() => { /* the banner is best-effort; the state read still carries it */ });
        }
      });
      this.subscriptions.push({ dispose: () => { unsubscribe(); } });
    }
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions.length = 0;
    if (this.pushTimer !== undefined) {
      clearTimeout(this.pushTimer);
      this.pushTimer = undefined;
    }
    this.panel?.dispose();
  }

  /** Opens (or reveals) the one Configure panel this window owns. */
  open(): Promise<void> {
    if (this.panel !== undefined) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return Promise.resolve();
    }
    const panel = vscode.window.createWebviewPanel(
      "drydock.configure",
      "Drydock: Configure",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")]
      }
    );
    this.panel = panel;
    this.sequence = 0;
    panel.webview.html = this.renderHtml(panel.webview);
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      void this.onMessage(raw);
    });
    panel.onDidDispose(() => {
      this.panel = undefined;
      if (this.pushTimer !== undefined) {
        clearTimeout(this.pushTimer);
        this.pushTimer = undefined;
      }
    });
    return Promise.resolve();
  }

  private schedulePush(): void {
    if (this.panel === undefined || this.pushTimer !== undefined) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      this.push({ type: "config.changed" });
    }, PUSH_DEBOUNCE_MS);
  }

  private requireBackend(): BackendReady {
    if (!this.backend.available) {
      throw new Error(this.backend.reason);
    }
    return this.backend;
  }

  /**
   * The validation service, or a sentence saying why there is none. Off
   * Windows the section still RENDERS (with `hostSupported: false`), but a
   * write must fail loudly rather than look like it worked.
   */
  private requireValidation(): ValidationAppService {
    const backend = this.requireBackend();
    if (backend.validation === undefined) {
      throw new Error("Validation runtimes need a Windows host with Hyper-V and OpenSSH; this machine cannot manage them.");
    }
    return backend.validation;
  }

  /** Every registry mutation answers the same ack and re-pushes the section. */
  private ackValidation(requestId: string): void {
    this.respond(requestId, { type: "config.validation.ack" });
    this.push({ type: "validation.changed" });
  }

  /**
   * The Validation section. With no service composed the panel still gets a
   * shape - an empty registry marked `hostSupported: false` - so it can say
   * "Windows host required" instead of rendering an empty list as a choice.
   */
  private async validationState(): Promise<ValidationConfigState> {
    const validation = this.backend.available ? this.backend.validation : undefined;
    if (validation === undefined) {
      return {
        hostSupported: false,
        runtimes: [],
        associations: [],
        projects: [],
        settings: { topologyPreset: "single" },
        quarantines: []
      };
    }
    return validation.state();
  }

  private async onMessage(raw: unknown): Promise<void> {
    const request = parsePanelRequest(raw);
    if (!request) {
      this.logger.warn("configure panel dropped a malformed webview message");
      return;
    }
    try {
      await this.handleRequest(request);
    } catch (error) {
      this.respondError(request.requestId, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleRequest(request: PanelRequest): Promise<void> {
    const payload = request.payload;
    switch (payload.type) {
      case "panel.init": {
        // Boot parity with the other editor panels; Configure reads everything
        // it actually renders from config.state.
        this.respond(request.requestId, {
          type: "panel.init",
          state: {
            availability: this.availability(),
            runtimes: [],
            providerCatalogs: this.backend.available ? this.backend.appService.listChatProviderCatalogs() : [],
            stateRootDisplayPath: this.backend.stateRootPath,
            openFolderNames: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.name),
            agentIdleThresholdMs: this.numberSetting("agentIdleThresholdMinutes", 5) * 60_000,
            codeBlockWordWrap: vscode.workspace.getConfiguration("drydock").get<boolean>("codeBlockWordWrap", true)
          }
        });
        return;
      }
      case "config.state": {
        if (payload.scope !== undefined) this.scope = payload.scope;
        const state = await this.buildState(this.scope);
        this.respond(request.requestId, { type: "config.state", state });
        // Auth ticks fill in behind the first paint: the probe is inert (it
        // reads the secret ledger, never a secret value) but it shells out, so
        // it must not sit between the panel opening and its first frame.
        this.ensureAuthProbe();
        return;
      }
      case "config.setSetting": {
        const def = SETTING_BY_KEY.get(payload.key);
        // Section and key must agree: a "runtime" request cannot write a
        // security setting even though both are in the same allowlist.
        if (def === undefined || def.section !== payload.section) {
          throw new Error(`${payload.key} is not a setting the Configure panel writes.`);
        }
        await this.writeSetting(def, payload.value);
        this.respond(request.requestId, { type: "config.setSetting", ok: true });
        return;
      }
      case "config.mcpToggle": {
        const backend = this.requireBackend();
        const server = (await backend.mcp.listServers()).find((entry) => entry.serverId === payload.serverId);
        if (server === undefined) {
          throw new Error(
            payload.serverId.startsWith(MCP_OVERLAY_ID_PREFIX)
              ? "This server comes from the project's .drydock/mcp.json — edit that file instead."
              : `MCP server ${payload.serverId} was not found.`
          );
        }
        if (server.source !== "registry") {
          throw new Error("This server comes from drydock.mcp.configPath — edit that file instead.");
        }
        await backend.mcp.saveServer({
          serverId: server.serverId,
          name: server.name,
          command: server.command,
          args: [...server.args],
          enabledByDefault: payload.enabled,
          sensitive: server.sensitive,
          ...(server.notes === undefined ? {} : { notes: server.notes })
        });
        // Toggles apply on the next turn of affected chats, never a restart.
        void backend.appService.refreshMcpConfigForLiveSessions();
        this.respond(request.requestId, { type: "config.mcpToggle", servers: await this.mcpRows(this.scope) });
        return;
      }
      case "config.mcpAdd": {
        const backend = this.requireBackend();
        await backend.mcp.saveServer({
          name: payload.name,
          command: payload.command,
          args: [...payload.args],
          enabledByDefault: true,
          sensitive: false
        });
        void backend.appService.refreshMcpConfigForLiveSessions();
        this.respond(request.requestId, { type: "config.mcpAdd", servers: await this.mcpRows(this.scope) });
        return;
      }
      case "config.provider.signIn": {
        const backend = this.requireBackend();
        // The existing terminal flow, verbatim: loginCommand re-enforces the
        // interactive/network policy and yields the spawnable pieces, and the
        // handshake stays user-driven in a visible terminal so no credential
        // ever passes through the extension.
        const login = backend.appService.loginCommand(payload.providerId);
        const terminal = vscode.window.createTerminal({
          name: `${payload.providerId} login`,
          shellPath: login.command,
          shellArgs: [...login.args]
        });
        terminal.show();
        this.watchLoginTerminal(terminal);
        this.respond(request.requestId, {
          type: "config.provider.signIn",
          providerId: payload.providerId,
          launched: login.display,
          mode: "terminal"
        });
        return;
      }
      case "config.provider.setDefaultModel": {
        const backend = this.requireBackend();
        const key = `${DEFAULT_MODEL_KEY_PREFIX}${payload.providerId}`;
        if (payload.model === "") backend.appState.deleteAppState(key);
        else backend.appState.setAppState(key, payload.model);
        this.respond(request.requestId, {
          type: "config.provider.setDefaultModel",
          providerId: payload.providerId,
          model: payload.model
        });
        return;
      }
      case "config.openFile": {
        // The webview may only re-open a path this provider itself advertised
        // in the last config.state; anything else is refused outright.
        if (!this.openablePaths.has(normalizePath(payload.path))) {
          throw new Error("That file is not one of the configuration files this panel manages.");
        }
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(payload.path));
        await vscode.window.showTextDocument(document, { preview: false });
        this.respond(request.requestId, { type: "config.openFile", opened: true });
        return;
      }
      case "memory.list": {
        const backend = this.requireBackend();
        const titles = await memoryTaskTitles(() => backend.tasks.listTasks());
        const candidates = (await backend.memory.listCandidates()).map((record) => toMemoryCandidateSummary(record, titles));
        // Suggestion chips for quick-add: tags detected in the open folders.
        const detectedTags = await backend.appService.tagsForRoots(openFolderRoots()).catch(() => [] as string[]);
        this.respond(request.requestId, { type: "memory.list", candidates, detectedTags });
        return;
      }
      case "memory.resolve": {
        const backend = this.requireBackend();
        const edits = await resolveMemoryEdits(memoryAnchorPorts(backend), payload.memoryCandidateId, payload.edits, openFolderRoots());
        const record = await backend.memory.resolve(payload.memoryCandidateId, payload.approve, edits);
        this.respond(request.requestId, {
          type: "memory.resolve",
          candidate: toMemoryCandidateSummary(record, await memoryTaskTitles(() => backend.tasks.listTasks()))
        });
        return;
      }
      case "memory.add": {
        const backend = this.requireBackend();
        // Quick-add is human-authored, so it lands approved; the workspace
        // anchor is this window's open folders (there is no source session).
        const record = await backend.memory.addUserMemory({
          content: payload.content,
          scope: payload.scope,
          ...(payload.taskId === undefined ? {} : { taskId: payload.taskId }),
          roots: openFolderRoots(),
          ...(payload.tags === undefined ? {} : { tags: payload.tags })
        });
        this.respond(request.requestId, {
          type: "memory.add",
          candidate: toMemoryCandidateSummary(record, await memoryTaskTitles(() => backend.tasks.listTasks()))
        });
        return;
      }
      case "memory.delete": {
        await this.requireBackend().memory.deleteMemory(payload.memoryCandidateId);
        this.respond(request.requestId, { type: "memory.delete", memoryCandidateId: payload.memoryCandidateId });
        return;
      }
      // ADR 0022 M7: the TD's validation-runtime surface. Reads answer with the
      // whole section; every mutation answers `config.validation.ack` and
      // re-pushes, keeping the panel's no-Save-button convention. Refusals
      // (managed policy, the H5 delete guard) arrive as error responses whose
      // message the panel renders verbatim.
      case "config.validation.state": {
        this.respond(request.requestId, { type: "config.validation.state", state: await this.validationState() });
        return;
      }
      case "config.validation.createRuntime": {
        await this.requireValidation().createRuntime({
          displayName: payload.displayName,
          image: payload.image,
          lifecycle: payload.lifecycle,
          capabilities: payload.capabilities,
          policyProfileRef: payload.policyProfileRef,
          ...(payload.profileException === undefined ? {} : { profileException: payload.profileException }),
          ...(payload.connection === undefined ? {} : { connection: payload.connection })
        });
        this.ackValidation(request.requestId);
        return;
      }
      case "config.validation.updateRuntime": {
        await this.requireValidation().updateRuntime(payload.runtimeId, payload.update);
        this.ackValidation(request.requestId);
        return;
      }
      case "config.validation.deleteRuntime": {
        await this.requireValidation().deleteRuntime(
          payload.runtimeId,
          payload.reassignTo === undefined ? undefined : payload.reassignTo
        );
        this.ackValidation(request.requestId);
        return;
      }
      case "config.validation.setDefault": {
        await this.requireValidation().setDefault(payload.runtimeId);
        this.ackValidation(request.requestId);
        return;
      }
      case "config.validation.setSettings": {
        await this.requireValidation().setSettings({
          ...(payload.topologyPreset === undefined ? {} : { topologyPreset: payload.topologyPreset }),
          ...(payload.warmCap === undefined ? {} : { warmCap: payload.warmCap })
        });
        this.ackValidation(request.requestId);
        return;
      }
      case "config.validation.setAssociation": {
        await this.requireValidation().setAssociation(payload.projectRootId, payload.runtimeId);
        this.ackValidation(request.requestId);
        return;
      }
      case "config.validation.clearAssociation": {
        await this.requireValidation().clearAssociation(payload.projectRootId);
        this.ackValidation(request.requestId);
        return;
      }
      case "config.validation.runProbes": {
        await this.requireValidation().runProbes(payload.runtimeId);
        this.ackValidation(request.requestId);
        return;
      }
      case "config.validation.adopt": {
        await this.requireValidation().adopt(payload.runtimeId);
        this.ackValidation(request.requestId);
        return;
      }
      case "config.validation.revertReprobe": {
        await this.requireValidation().revertAndReprobe(payload.runtimeId);
        this.ackValidation(request.requestId);
        return;
      }
      case "memory.open": {
        const candidate = await this.requireBackend().memory.getCandidate(payload.memoryCandidateId);
        if (candidate === null) {
          throw new Error(`Memory candidate ${payload.memoryCandidateId} was not found.`);
        }
        const document = await vscode.workspace.openTextDocument(memoryUri(candidate.memoryCandidateId));
        await vscode.window.showTextDocument(document, { preview: true });
        this.respond(request.requestId, { type: "memory.open", accepted: true });
        return;
      }
      default:
        this.respondError(request.requestId, `Request ${payload.type} is not supported by the Configure panel.`);
    }
  }

  // -------------------------------------------------------------------------
  // State assembly
  // -------------------------------------------------------------------------

  /**
   * One inert auth re-probe per panel lifetime. It reads the Docker Sandbox
   * secret ledger (and whether a SecretStorage ref exists) without touching a
   * secret value, then invalidates the panel so the ticks appear.
   */
  private ensureAuthProbe(): void {
    if (this.authProbe !== undefined || !this.backend.available) return;
    const backend = this.backend;
    this.authProbe = backend.appService.refreshProviderAuthStatuses()
      .then(() => { this.schedulePush(); })
      .catch((error: unknown) => {
        this.logger.warn("configure auth probe failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  /** Closing the login terminal re-probes once, so the card flips on its own. */
  private watchLoginTerminal(terminal: vscode.Terminal): void {
    const listener = vscode.window.onDidCloseTerminal((closed) => {
      if (closed !== terminal) return;
      cleanup();
      this.authProbe = undefined;
      this.ensureAuthProbe();
    });
    const timeout = setTimeout(() => { cleanup(); }, 15 * 60_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      listener.dispose();
      const index = this.subscriptions.indexOf(listener);
      if (index >= 0) this.subscriptions.splice(index, 1);
    };
    this.subscriptions.push(listener);
  }

  private availability(): ConfigState["availability"] {
    return this.backend.available
      ? { available: true, sbxDisplayPath: this.backend.sbxDisplayPath }
      : { available: false, reason: this.backend.reason };
  }

  private async buildState(scope: ConfigScope): Promise<ConfigState> {
    const projectLabel = (vscode.workspace.workspaceFolders ?? [])[0]?.name;
    const managed = await this.isManaged();
    const [providers, mcp, recipes, aspects, preprompts, validation] = await Promise.all([
      this.providerRows(),
      this.mcpRows(scope),
      this.recipeRows(scope),
      this.aspectRows(scope),
      this.prepromptRows(scope),
      // The Validation section rides the one composite read like every other
      // section; a failure there degrades that section, never the whole panel.
      this.validationState().catch((error: unknown): ValidationConfigState | undefined => {
        this.logger.warn("configure validation state failed", {
          error: error instanceof Error ? error.message : String(error)
        });
        return undefined;
      })
    ]);
    // Every path any row offers to open, gathered once so the openFile guard
    // and the webview's links can never drift apart.
    const openable = new Set<string>();
    for (const row of mcp) if (row.filePath !== undefined) openable.add(normalizePath(row.filePath));
    for (const row of preprompts) if (row.exists) openable.add(normalizePath(row.path));
    for (const filePath of await this.projectOverlayFiles(scope)) openable.add(normalizePath(filePath));
    this.openablePaths = openable;
    return {
      scope,
      ...(projectLabel === undefined ? {} : { projectLabel }),
      availability: this.availability(),
      providers,
      mcp,
      recipes,
      aspects,
      tagRules: this.tagRuleRows(),
      preprompts,
      settings: this.settingRows(managed),
      editablePaths: [...openable],
      ...(validation === undefined ? {} : { validation })
    };
  }

  private async isManaged(): Promise<boolean> {
    if (!this.backend.available) return false;
    try {
      return (await this.backend.workspaceReview.getPolicyState()).security?.managed === true;
    } catch {
      return false;
    }
  }

  private async providerRows(): Promise<readonly ConfigProviderRow[]> {
    if (!this.backend.available) return [];
    const backend = this.backend;
    // The cached catalogs, never a probe: opening Configure must not spend a
    // network round trip per provider. The sign-in flow refreshes on its own.
    const catalogs = backend.appService.listChatProviderCatalogs();
    const recent = await this.recentProviderCounts();
    const byId = new Map(catalogs.map((catalog) => [catalog.providerId, catalog]));
    const rows: ConfigProviderRow[] = [];
    for (const descriptor of PROVIDER_REGISTRY) {
      const catalog = byId.get(descriptor.providerId);
      const stored = backend.appState.getAppState(`${DEFAULT_MODEL_KEY_PREFIX}${descriptor.providerId}`);
      // Discovered (live or cached) models only; there is no compiled-in list.
      const models = (catalog?.models ?? [])
        .filter((model) => !model.hidden)
        .map((model) => ({ id: model.id, displayName: model.displayName }));
      const used = recent.get(descriptor.providerId);
      rows.push({
        providerId: descriptor.providerId,
        label: descriptor.displayName,
        authStatus: catalog?.authStatus ?? backend.appService.providerAuthStatus(descriptor.providerId),
        ...(catalog?.authKind === undefined
          ? { authKind: descriptor.connect.oauth !== undefined ? "oauth" as const : "api-key" as const }
          : { authKind: catalog.authKind }),
        ...(catalog?.loginHint === undefined || catalog.loginHint === "" ? {} : { loginHint: catalog.loginHint }),
        models,
        ...(stored === null ? {} : { defaultModel: stored }),
        ...(used === undefined ? {} : { usedByRecentChats: used })
      });
    }
    return rows;
  }

  /** providerId → chats in the recent window; best-effort, omitted on failure. */
  private async recentProviderCounts(): Promise<ReadonlyMap<string, number>> {
    if (!this.backend.available) return new Map();
    try {
      const sessions = await this.backend.appService.listChatSessions(RECENT_CHAT_WINDOW);
      const counts = new Map<string, number>();
      for (const session of sessions) {
        counts.set(session.providerId, (counts.get(session.providerId) ?? 0) + 1);
      }
      return counts;
    } catch {
      return new Map();
    }
  }

  private async mcpRows(scope: ConfigScope): Promise<readonly ConfigMcpRow[]> {
    const rows: ConfigMcpRow[] = [];
    if (this.backend.available) {
      const settingsPath = this.settingsMcpPath();
      for (const server of await this.backend.mcp.listServers()) {
        rows.push({
          serverId: server.serverId,
          name: server.name,
          provenance: server.source === "settings" ? "settings" : "local",
          enabled: server.enabledByDefault,
          transport: "stdio",
          command: server.command,
          args: [...server.args],
          sensitive: server.sensitive,
          ...(server.source === "settings" && settingsPath !== undefined ? { filePath: settingsPath } : {})
        });
      }
    }
    // Project scope is the MERGED view: repo rows join the machine's own,
    // read-only, with the file that defines them one click away.
    if (scope === "project") {
      for (const overlay of await this.readProjectOverlays()) {
        rows.push({
          serverId: overlay.serverId,
          name: overlay.name,
          provenance: "project",
          enabled: true,
          transport: "stdio",
          command: overlay.command,
          args: [...overlay.args],
          sensitive: false,
          filePath: overlay.filePath
        });
      }
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async readProjectOverlays(): Promise<readonly McpProjectServer[]> {
    try {
      return await this.mcpProjectOverlays();
    } catch (error) {
      this.logger.warn("mcp project overlay read failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  private async recipeRows(scope: ConfigScope): Promise<readonly ConfigRecipeRow[]> {
    if (!this.backend.available) return [];
    try {
      const recipes = await this.backend.recipes.listRecipes();
      return recipes
        .filter((recipe) => scope === "project" || recipe.source !== "overlay")
        .map((recipe) => ({
          recipeId: recipe.recipeId,
          name: recipe.name,
          ...(recipe.description === undefined ? {} : { description: recipe.description }),
          stepCount: recipe.subtasks.length,
          provenance: recipe.source === "overlay" ? "project" as const : "local" as const
        }));
    } catch (error) {
      this.logger.warn("configure recipe list failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  private async aspectRows(scope: ConfigScope): Promise<readonly ConfigAspectRow[]> {
    if (!this.backend.available) return [];
    try {
      // The planner merges stored rows with `.drydock/planner-aspects.json`
      // and hands back one flat list, so provenance comes from asking the
      // overlay reader which ids the repository contributed.
      const [aspects, overlayIds] = await Promise.all([
        this.backend.planner.listAspects(false),
        this.projectAspectIds()
      ]);
      return aspects
        .filter((aspect) => !aspect.archived)
        .map((aspect) => ({
          aspectId: aspect.aspectId,
          label: aspect.label,
          expectedArtifacts: [...aspect.expectedArtifacts],
          // A stored row always wins an id collision, so a `seeded` row is
          // never the repository's even if the id also appears in its file.
          provenance: (!aspect.seeded && overlayIds.has(aspect.aspectId) ? "project" : "local") as ConfigAspectRow["provenance"]
        }))
        // Project rows belong to the merged project view only.
        .filter((row) => scope === "project" || row.provenance !== "project");
    } catch (error) {
      this.logger.warn("configure aspect list failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  private async projectAspectIds(): Promise<ReadonlySet<string>> {
    try {
      return new Set((await this.plannerAspectOverlays()).map((aspect) => aspect.aspectId));
    } catch {
      return new Set();
    }
  }

  private tagRuleRows(): readonly ConfigTagRuleRow[] {
    const rows: ConfigTagRuleRow[] = DEFAULT_TAG_RULES.map((rule) => ({
      globs: [...rule.globs],
      tag: rule.tag,
      provenance: "local" as const
    }));
    for (const rule of this.tagRuleSetting()) {
      rows.push({ globs: [...rule.globs], tag: rule.tag, provenance: "settings" });
    }
    return rows;
  }

  /** The raw `drydock.memory.tagRules` value, defensively normalized. */
  private tagRuleSetting(): readonly { readonly globs: readonly string[]; readonly tag: string }[] {
    const raw = vscode.workspace.getConfiguration("drydock").get<unknown>("memory.tagRules", []);
    if (!Array.isArray(raw)) return [];
    const rules: { globs: string[]; tag: string }[] = [];
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const tag = typeof record["tag"] === "string" ? record["tag"] : "";
      const globs = Array.isArray(record["globs"])
        ? record["globs"].filter((glob): glob is string => typeof glob === "string")
        : [];
      if (tag.length === 0 || globs.length === 0) continue;
      rules.push({ globs, tag });
    }
    return rules;
  }

  private async prepromptRows(scope: ConfigScope): Promise<readonly ConfigPrepromptRow[]> {
    const rows: ConfigPrepromptRow[] = [];
    const teamPath = vscode.workspace.getConfiguration("drydock").get<string>("teamInstructionsPath", "").trim();
    if (teamPath.length > 0) {
      const stat = await statFile(teamPath);
      rows.push({
        label: "Studio standing instructions",
        path: teamPath,
        provenance: "settings",
        exists: stat !== null,
        ...(stat === null ? {} : { bytes: stat })
      });
    }
    if (scope === "project") {
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        for (const name of ["CLAUDE.md", "AGENTS.md"]) {
          const candidate = path.join(folder.uri.fsPath, name);
          const stat = await statFile(candidate);
          if (stat === null) continue;
          rows.push({
            label: `${folder.name} · ${name}`,
            path: candidate,
            provenance: "project",
            exists: true,
            bytes: stat
          });
        }
      }
    }
    return rows;
  }

  /** `.drydock/` files the panel links to, even when they contribute no rows. */
  private async projectOverlayFiles(scope: ConfigScope): Promise<readonly string[]> {
    const files: string[] = [];
    const settingsPath = this.settingsMcpPath();
    if (settingsPath !== undefined) files.push(settingsPath);
    if (scope !== "project") return files;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      for (const relative of ["mcp.json", "recipes.json", "planner-aspects.json"]) {
        const candidate = path.join(folder.uri.fsPath, ".drydock", relative);
        if (await statFile(candidate) !== null) files.push(candidate);
      }
    }
    return files;
  }

  private settingsMcpPath(): string | undefined {
    const configured = vscode.workspace.getConfiguration("drydock").get<string>("mcp.configPath", "").trim();
    return configured.length === 0 ? undefined : configured;
  }

  private settingRows(managed: boolean): readonly ConfigSettingRow[] {
    const configuration = vscode.workspace.getConfiguration("drydock");
    return SETTING_DEFS.map((def) => {
      const stored = configuration.get<unknown>(def.key);
      const locked = managed && def.managedLock !== undefined ? def.managedLock : undefined;
      return {
        key: def.key,
        section: def.section,
        label: def.label,
        detail: def.detail,
        kind: def.kind,
        value: coerceValue(stored, def.fallback),
        requiresReload: def.requiresReload,
        provenance: "settings" as const,
        ...(def.min === undefined ? {} : { min: def.min }),
        ...(def.max === undefined ? {} : { max: def.max }),
        ...(locked === undefined ? {} : { lockedReason: locked })
      };
    });
  }

  private numberSetting(key: string, fallback: number): number {
    const value = vscode.workspace.getConfiguration("drydock").get<number>(key, fallback);
    return Number.isFinite(value) ? value : fallback;
  }

  /**
   * Machine-scope settings accept the Global target, which is what the design
   * calls for: Configure writes the user's own machine configuration, never a
   * workspace file a repository could then carry to someone else.
   */
  private async writeSetting(def: SettingDef, value: ConfigSettingValue): Promise<void> {
    if (def.managedLock !== undefined && await this.isManaged()) {
      throw new Error(def.managedLock);
    }
    if (def.kind === "number") {
      if (typeof value !== "number") throw new Error(`${def.label} must be a number.`);
      if (def.min !== undefined && value < def.min) throw new Error(`${def.label} must be at least ${String(def.min)}.`);
      if (def.max !== undefined && value > def.max) throw new Error(`${def.label} must be at most ${String(def.max)}.`);
    }
    if (def.kind === "boolean" && typeof value !== "boolean") throw new Error(`${def.label} must be on or off.`);
    if (def.kind === "string" && typeof value !== "string") throw new Error(`${def.label} must be text.`);
    if ((def.kind === "string-list" || def.kind === "tag-rules") && !Array.isArray(value)) {
      throw new Error(`${def.label} must be a list.`);
    }
    if (def.kind === "string-map" && (typeof value !== "object" || value === null || Array.isArray(value))) {
      throw new Error(`${def.label} must be a set of name/value pairs.`);
    }
    await vscode.workspace.getConfiguration().update(
      `drydock.${def.key}`,
      value,
      vscode.ConfigurationTarget.Global
    );
  }

  // -------------------------------------------------------------------------
  // Envelope plumbing
  // -------------------------------------------------------------------------

  private respond(requestId: string, payload: PanelResponsePayload): void {
    this.post({ protocolVersion: WEBVIEW_PROTOCOL_VERSION, kind: "response", requestId, ok: true, payload });
  }

  private respondError(requestId: string, message: string): void {
    this.post({ protocolVersion: WEBVIEW_PROTOCOL_VERSION, kind: "response", requestId, ok: false, error: { message } });
  }

  private push(payload: PanelPushPayload): void {
    if (this.panel === undefined) return;
    this.sequence += 1;
    this.post({ protocolVersion: WEBVIEW_PROTOCOL_VERSION, kind: "push", sequence: this.sequence, payload });
  }

  private post(message: HostToWebviewMessage): void {
    void this.panel?.webview.postMessage(message);
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("hex");
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "configure.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "configure.css"));
    // Strict CSP, matching the task-board panel exactly: no remote content,
    // scripts only with this nonce, styles only from the extension, no
    // 'unsafe-inline' anywhere. All dynamic text renders via textContent.
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri.toString()}">
  <title>Drydock: Configure</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}

/** Case-insensitive, separator-normalized key for the openFile allowlist. */
function normalizePath(value: string): string {
  return path.normalize(value).replace(/[\\/]+$/, "").toLowerCase();
}

/** File-scheme open folders - the workspace-scope anchor for memory adds/edits. */
function openFolderRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === "file")
    .map((folder) => folder.uri.fsPath);
}

/** Byte size when the file exists, null otherwise. */
async function statFile(filePath: string): Promise<number | null> {
  try {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    return stat.type === vscode.FileType.Directory ? null : stat.size;
  } catch {
    return null;
  }
}

/** A stored value the setting's schema does not match falls back to the default. */
function coerceValue(stored: unknown, fallback: ConfigSettingValue): ConfigSettingValue {
  if (typeof fallback === "boolean") return typeof stored === "boolean" ? stored : fallback;
  if (typeof fallback === "number") return typeof stored === "number" && Number.isFinite(stored) ? stored : fallback;
  if (typeof fallback === "string") return typeof stored === "string" ? stored : fallback;
  if (Array.isArray(fallback)) {
    if (!Array.isArray(stored)) return fallback;
    if (stored.every((entry) => typeof entry === "string")) return stored as string[];
    const rules: { globs: string[]; tag: string }[] = [];
    for (const entry of stored) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const tag = typeof record["tag"] === "string" ? record["tag"] : "";
      const globs = Array.isArray(record["globs"])
        ? record["globs"].filter((glob): glob is string => typeof glob === "string")
        : [];
      if (tag.length > 0 && globs.length > 0) rules.push({ globs, tag });
    }
    return rules;
  }
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return fallback;
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof value === "string") map[key] = value;
  }
  return map;
}
