/**
 * Configure webview (UX overhaul, P6).
 *
 * One quiet page for everything that used to be split between the System tab
 * and settings.json: a 176px section nav on the left, a top bar carrying the
 * scope switch and one search field, and a single ~720px column of rows.
 *
 * Three rules the whole surface obeys:
 *
 * - No Save button. Every control commits on blur/Enter, the host answers, and
 *   the row says "saved to settings" for a moment. Rows whose setting only
 *   takes effect in a new window wear a reload chip, permanently, next to the
 *   control - not as a toast after the fact.
 * - Provenance is visible. `local` rows are Drydock's own and editable;
 *   `settings` rows write through the settings API; `project` rows come from a
 *   `.drydock/` file in an open folder and are READ-ONLY here, offering
 *   "edit the file ↗" instead of a control.
 * - Project scope is a MERGED view. Switching to the project adds its rows
 *   beside the machine's own rather than replacing them.
 *
 * Search flattens every section into one grouped result list, so "denied" or
 * "model" finds its row without knowing which section owns it.
 *
 * SECURITY: every dynamic string (server names, commands, file paths, model
 * ids) is written with textContent - NEVER innerHTML, no DOM-from-string. The
 * strict CSP has no 'unsafe-inline' for styles, so every state cue is a CLASS;
 * there is not one style attribute in this file.
 */

import {
  CONFIG_SECTIONS,
  MAX_VALIDATION_WARM_CAP,
  type ConfigMcpRow,
  type ConfigProviderRow,
  type ConfigScope,
  type ConfigSection,
  type ConfigSettingRow,
  type ConfigSettingSection,
  type ConfigSettingValue,
  type ConfigState,
  type ConfigTagRuleInput,
  type MemoryCandidateSummary,
  type MemoryScope,
  type PanelRequestPayload,
  type PanelResponse
} from "@drydock/contracts";
import {
  button,
  el,
  selectField,
  stringListField,
  stringMapField,
  tagRulesField,
  textField,
  toggleField
} from "./configureFields.js";
import { onPush, request, startMessaging, vscode } from "./configureMessaging.js";
import {
  clockTime,
  middleTruncate,
  quarantineSentence,
  type ValidationConfigState,
  type ValidationLifecycle,
  type ValidationRequest,
  type ValidationResponseEnvelope,
  type ValidationRuntimeRow,
  type ValidationRuntimeUpdate,
  type ValidationTopologyPreset
} from "./validationTypes.js";

/** How long a row says "saved" before returning to its resting state. */
const SAVED_NOTE_MS = 1_600;
/** Settings changed elsewhere arrive as one push; refetch once. */
const REFRESH_DEBOUNCE_MS = 200;

/**
 * The validation-runtimes section (ADR 0022 M7b) is a LOCAL addition to the
 * nav: `CONFIG_SECTIONS` is owned by contracts, so this file inserts the
 * section itself and skips the insert if a later contracts release ships it.
 */
const VALIDATION_SECTION = "validation";
type Section = ConfigSection | typeof VALIDATION_SECTION;

const SECTIONS: readonly Section[] = (CONFIG_SECTIONS as readonly string[]).includes(VALIDATION_SECTION)
  ? (CONFIG_SECTIONS as readonly Section[])
  : buildSections();

/** Validation sits with the other machine-shaped rows: straight after Runtime. */
function buildSections(): readonly Section[] {
  const out: Section[] = [];
  for (const entry of CONFIG_SECTIONS) {
    out.push(entry);
    if (entry === "runtime") out.push(VALIDATION_SECTION);
  }
  if (!out.includes(VALIDATION_SECTION)) out.push(VALIDATION_SECTION);
  return out;
}

const SECTION_LABELS: Record<Section, string> = {
  providers: "Providers",
  mcp: "MCP Servers",
  models: "Agents & Models",
  preprompts: "Preprompts",
  recipes: "Skills & Recipes",
  memories: "Memories",
  runtime: "Runtime",
  validation: "Validation runtimes",
  security: "Security"
};

const LIFECYCLE_OPTIONS: readonly { readonly value: ValidationLifecycle; readonly label: string }[] = [
  { value: "keep-warm", label: "keep-warm" },
  { value: "on-demand", label: "on-demand" },
  { value: "pinned", label: "pinned" }
];

const TOPOLOGY_OPTIONS: readonly { readonly value: ValidationTopologyPreset; readonly label: string }[] = [
  { value: "single", label: "Single VM for everything" },
  { value: "default-plus-named", label: "Default + named runtimes" },
  { value: "per-project", label: "One runtime per project" }
];

const PROVENANCE_LABELS = { local: "local", settings: "settings", project: "project" } as const;
const PROVENANCE_TITLES = {
  local: "Stored by Drydock on this machine.",
  settings: "A VS Code setting; Configure writes it for you.",
  project: "Defined by a file in this project. Read-only here."
} as const;

/** One searchable row: the text search matches, and the node it renders. */
interface Row {
  readonly search: string;
  readonly node: HTMLElement;
}

// ---------------------------------------------------------------------------
// Controller state
// ---------------------------------------------------------------------------

const root = el("div", "cfg");
let state: ConfigState | null = null;
let scope: ConfigScope = "global";
let section: Section = "providers";
let query = "";
let notice: string | null = null;
let booted = false;
/** The row key whose "saved" note is currently showing, and when it expires. */
let savedKey: string | null = null;
let savedTimer: number | undefined;
let refreshTimer: number | undefined;
let fetchToken = 0;

// Memories (ADR 0019, re-homed here by ADR 0020): the browser + approval gate
// state, fetched with config.state and kept fresh by the candidateAdded push.

/** Every candidate the host knows (all statuses); null until memory.list answers. */
let memoryCandidates: MemoryCandidateSummary[] | null = null;
let memoryDetectedTags: readonly string[] = [];
/** Why the browser is unavailable, when it is. */
let memoryNotice: string | null = null;
/** The quick-add input PERSISTS across renders so a push cannot eat a half-typed memory. */
const quickAddInput = document.createElement("input");
quickAddInput.type = "text";
quickAddInput.className = "cfg-input";
quickAddInput.placeholder = "Remember…  (Enter saves)";
quickAddInput.setAttribute("aria-label", "Remember something");
quickAddInput.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  submitQuickAdd();
});
let quickScope: MemoryScope = "workspace";
const quickTags = new Set<string>();
/** Per-candidate approval edits, keyed by id, so re-renders keep drafts. */
interface MemoryDraft {
  content?: string;
  scope: MemoryScope;
  tags: Set<string>;
}
const memoryDrafts = new Map<string, MemoryDraft>();

// Validation runtimes (ADR 0022): the registry, associations and settings ride
// the same refresh as config.state and heal off validation.changed pushes.

/** Null until config.validation.state answers; null again when it fails. */
let validation: ValidationConfigState | null = null;
/** Why the section is unavailable, when it is. */
let validationNotice: string | null = null;
/**
 * Which runtime rows are expanded RIGHT NOW. In-memory only: a mutation
 * refetches and re-renders, and an expansion must survive that, but nothing
 * remembers itself open across a panel open (the disclosure ladder's rule).
 */
const expandedRuntimeIds = new Set<string>();

interface PersistedState {
  readonly section?: Section;
  readonly scope?: ConfigScope;
}

function restore(): PersistedState {
  const stored: unknown = vscode.getState();
  if (typeof stored !== "object" || stored === null) return {};
  return stored as PersistedState;
}

function persist(): void {
  vscode.setState({ section, scope });
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/**
 * The validation kinds are not in `PanelRequestPayload` until M7a lands, so the
 * cast is confined to this ONE function; everything downstream is typed against
 * the mirror in `validationTypes.ts`.
 */
function validationRequest(payload: ValidationRequest): Promise<ValidationResponseEnvelope> {
  return request(payload as unknown as PanelRequestPayload) as unknown as Promise<ValidationResponseEnvelope>;
}

async function load(): Promise<void> {
  fetchToken += 1;
  const token = fetchToken;
  // Memories and validation ride the same refresh: one failing part must not
  // blank the others.
  const [response, memoryResponse, validationResponse] = await Promise.all([
    request({ type: "config.state", scope }),
    request({ type: "memory.list" }),
    validationRequest({ type: "config.validation.state" })
  ]);
  if (token !== fetchToken) return;
  booted = true;
  // The registry arrives either as its own read or riding config.state; take
  // whichever this host offers rather than blanking the section.
  const inlineValidation = response.ok && response.payload.type === "config.state"
    ? (response.payload.state as { readonly validation?: ValidationConfigState }).validation
    : undefined;
  if (validationResponse.ok && validationResponse.payload.type === "config.validation.state") {
    validation = validationResponse.payload.state;
    validationNotice = null;
  } else if (inlineValidation !== undefined) {
    validation = inlineValidation;
    validationNotice = null;
  } else {
    validation = null;
    validationNotice = validationResponse.ok
      ? "Validation runtimes could not be read."
      : validationResponse.error.message;
  }
  if (response.ok && response.payload.type === "config.state") {
    state = response.payload.state;
    scope = state.scope;
    notice = null;
  } else {
    state = null;
    notice = response.ok ? "Configuration could not be read." : response.error.message;
  }
  if (memoryResponse.ok && memoryResponse.payload.type === "memory.list") {
    memoryCandidates = [...memoryResponse.payload.candidates];
    memoryDetectedTags = memoryResponse.payload.detectedTags;
    memoryNotice = null;
  } else {
    memoryCandidates = null;
    memoryNotice = memoryResponse.ok ? "Memories could not be read." : memoryResponse.error.message;
  }
  render();
}

function scheduleRefresh(): void {
  if (refreshTimer !== undefined) return;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = undefined;
    void load();
  }, REFRESH_DEBOUNCE_MS);
}

/** Marks a row saved for a beat, then lets it settle back. */
function flashSaved(key: string): void {
  savedKey = key;
  if (savedTimer !== undefined) window.clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => {
    savedTimer = undefined;
    savedKey = null;
    render();
  }, SAVED_NOTE_MS);
}

function fail(response: PanelResponse): void {
  notice = response.ok ? "That change was not applied." : response.error.message;
  render();
}

/**
 * Writes one setting. The local value updates immediately so the row does not
 * flicker back to its old value while the host answers; a failure re-reads the
 * truth from the host rather than guessing.
 */
function setSetting(row: ConfigSettingRow, value: ConfigSettingValue): void {
  applyLocalSetting(row.key, value);
  render();
  void request({ type: "config.setSetting", section: row.section, key: row.key, value }).then((response) => {
    if (response.ok && response.payload.type === "config.setSetting") {
      flashSaved(row.key);
      render();
      return;
    }
    fail(response);
    void load();
  });
}

function applyLocalSetting(key: string, value: ConfigSettingValue): void {
  if (state === null) return;
  state = {
    ...state,
    settings: state.settings.map((entry) => (entry.key === key ? { ...entry, value } : entry))
  };
}

function settingsFor(current: ConfigState, target: ConfigSettingSection): readonly ConfigSettingRow[] {
  return current.settings.filter((entry) => entry.section === target);
}

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

function chip(text: string, className = ""): HTMLElement {
  return el("span", `cfg-chip ${className}`.trim(), text);
}

function provenanceChip(provenance: keyof typeof PROVENANCE_LABELS): HTMLElement {
  const node = chip(PROVENANCE_LABELS[provenance], `cfg-prov cfg-prov-${provenance}`);
  node.title = PROVENANCE_TITLES[provenance];
  return node;
}

function reloadChip(): HTMLElement {
  const node = chip("needs a reload", "cfg-reload");
  node.title = "This takes effect the next time the window loads.";
  return node;
}

function savedNote(key: string, label = "saved to settings"): HTMLElement | null {
  return savedKey === key ? el("span", "cfg-saved", label) : null;
}

function openFileLink(filePath: string, label = "edit the file ↗"): HTMLElement {
  return button("cfg-linkish", label, filePath, () => {
    void request({ type: "config.openFile", path: filePath }).then((response) => {
      if (!response.ok) fail(response);
    });
  });
}

/**
 * The one row shape the whole panel uses: a title line, a dim detail line, and
 * a control column on the right.
 */
function row(options: {
  readonly title: string;
  readonly detail?: string;
  readonly chips?: readonly HTMLElement[];
  readonly control?: HTMLElement | null;
  readonly below?: HTMLElement | null;
  readonly className?: string;
}): HTMLElement {
  const node = el("div", `cfg-row ${options.className ?? ""}`.trim());
  const main = el("div", "cfg-row-main");
  const head = el("div", "cfg-row-head");
  head.append(el("span", "cfg-row-title", options.title));
  for (const entry of options.chips ?? []) head.append(entry);
  main.append(head);
  if (options.detail !== undefined && options.detail.length > 0) {
    main.append(el("p", "cfg-row-detail", options.detail));
  }
  if (options.below !== null && options.below !== undefined) main.append(options.below);
  node.append(main);
  if (options.control !== null && options.control !== undefined) {
    const control = el("div", "cfg-row-control");
    control.append(options.control);
    node.append(control);
  }
  return node;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function providerRows(current: ConfigState): Row[] {
  return current.providers.map((provider) => ({
    search: `${provider.label} ${provider.providerId} ${provider.defaultModel ?? ""}`,
    node: providerCard(provider)
  }));
}

function providerCard(provider: ConfigProviderRow): HTMLElement {
  const card = el("div", "cfg-card");
  const head = el("div", "cfg-card-head");
  const connected = provider.authStatus === "authenticated";
  const status = el("span", `cfg-auth cfg-auth-${provider.authStatus}`);
  status.textContent = connected ? "✓" : provider.authStatus === "needs-login" ? "●" : "○";
  status.title = connected
    ? "Signed in on this machine."
    : provider.authStatus === "needs-login"
      ? "Not signed in yet."
      : "Drydock could not check this provider's sign-in.";
  head.append(status, el("span", "cfg-card-title", provider.label));
  if (provider.usedByRecentChats !== undefined && provider.usedByRecentChats > 0) {
    head.append(chip(`${String(provider.usedByRecentChats)} recent chats`, "cfg-quiet-chip"));
  }
  card.append(head);

  if (!connected) {
    const signIn = el("div", "cfg-card-line");
    signIn.append(button("cfg-button", "Sign in", provider.loginHint ?? "Sign this provider in", () => {
      void request({ type: "config.provider.signIn", providerId: provider.providerId }).then((response) => {
        if (response.ok && response.payload.type === "config.provider.signIn") {
          notice = `A terminal is running ${response.payload.launched}. Finish the sign-in there — this page rechecks when you close it.`;
          render();
          return;
        }
        fail(response);
      });
    }));
    signIn.append(el("span", "cfg-hint", provider.authKind === "api-key"
      ? "Opens a terminal for this provider's key setup; nothing is typed into Drydock."
      : "Opens a terminal and hands the sign-in to the provider; no credential passes through Drydock."));
    card.append(signIn);
  }

  card.append(modelLine(provider));
  return card;
}

/** The ONE default-model control; the Agents & Models section reuses it. */
function modelLine(provider: ConfigProviderRow): HTMLElement {
  const line = el("div", "cfg-card-line");
  line.append(el("span", "cfg-field-label", "Default model"));
  if (provider.models.length === 0) {
    line.append(el("span", "cfg-hint", "No models discovered yet — sign in, then reopen Configure."));
    return line;
  }
  const options = [
    { value: "", label: "Provider default" },
    ...provider.models.map((model) => ({ value: model.id, label: model.displayName }))
  ];
  line.append(selectField(options, provider.defaultModel ?? "", `Default model for ${provider.label}`, (next) => {
    void request({ type: "config.provider.setDefaultModel", providerId: provider.providerId, model: next })
      .then((response) => {
        if (response.ok && response.payload.type === "config.provider.setDefaultModel") {
          if (state !== null) {
            state = {
              ...state,
              providers: state.providers.map((entry) => (
                entry.providerId === provider.providerId
                  ? { ...entry, ...(next === "" ? {} : { defaultModel: next }) }
                  : entry
              ))
            };
          }
          flashSaved(`model:${provider.providerId}`);
          render();
          return;
        }
        fail(response);
      });
  }));
  const note = savedNote(`model:${provider.providerId}`);
  if (note !== null) line.append(note);
  return line;
}

function mcpRows(current: ConfigState): Row[] {
  return current.mcp.map((server) => ({
    search: `${server.name} ${server.command} ${server.args.join(" ")} ${server.provenance}`,
    node: mcpRow(server)
  }));
}

function mcpRow(server: ConfigMcpRow): HTMLElement {
  const editable = server.provenance === "local";
  const chips: HTMLElement[] = [chip(server.transport, "cfg-micro")];
  if (server.toolCount !== undefined) chips.push(chip(`${String(server.toolCount)} tools`, "cfg-micro"));
  if (server.sensitive) chips.push(chip("sensitive", "cfg-warn-chip"));
  chips.push(provenanceChip(server.provenance));
  const detailNode = el("div", "cfg-mcp-detail");
  detailNode.append(el("code", "cfg-code", [server.command, ...server.args].join(" ")));
  if (!editable && server.filePath !== undefined) detailNode.append(openFileLink(server.filePath));
  const node = row({
    title: server.name,
    chips,
    below: detailNode,
    control: toggleField(server.enabled, `Enable ${server.name}`, !editable, (next) => {
      void request({ type: "config.mcpToggle", serverId: server.serverId, enabled: next }).then((response) => {
        if (response.ok && response.payload.type === "config.mcpToggle") {
          if (state !== null) state = { ...state, mcp: response.payload.servers };
          flashSaved(`mcp:${server.serverId}`);
          render();
          return;
        }
        fail(response);
        void load();
      });
    }),
    className: editable ? "" : "cfg-row-readonly"
  });
  const note = savedNote(`mcp:${server.serverId}`);
  if (note !== null) node.append(note);
  return node;
}

/** The folded "Add server" line: three fields, no dialog. */
function mcpAddRow(): HTMLElement {
  const fold = el("details", "cfg-fold");
  const summary = document.createElement("summary");
  summary.className = "cfg-fold-summary";
  summary.textContent = "Add a server";
  fold.append(summary);
  const form = el("div", "cfg-add-form");
  const name = document.createElement("input");
  name.type = "text";
  name.className = "cfg-input";
  name.placeholder = "name";
  name.setAttribute("aria-label", "Server name");
  const command = document.createElement("input");
  command.type = "text";
  command.className = "cfg-input";
  command.placeholder = "command";
  command.setAttribute("aria-label", "Server command");
  const args = document.createElement("input");
  args.type = "text";
  args.className = "cfg-input";
  args.placeholder = "arguments (space separated)";
  args.setAttribute("aria-label", "Server arguments");
  const submit = (): void => {
    const serverName = name.value.trim();
    const serverCommand = command.value.trim();
    if (serverName.length === 0 || serverCommand.length === 0) {
      notice = "A server needs both a name and a command.";
      render();
      return;
    }
    const serverArgs = args.value.split(/\s+/).filter((entry) => entry.length > 0);
    void request({ type: "config.mcpAdd", name: serverName, command: serverCommand, args: serverArgs })
      .then((response) => {
        if (response.ok && response.payload.type === "config.mcpAdd") {
          if (state !== null) state = { ...state, mcp: response.payload.servers };
          flashSaved(`mcp:add`);
          render();
          return;
        }
        fail(response);
      });
  };
  for (const input of [name, command, args]) {
    input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      submit();
    });
  }
  form.append(name, command, args, button("cfg-button", "Add", "Add this MCP server", submit));
  fold.append(form);
  return fold;
}

function modelSectionRows(current: ConfigState): Row[] {
  return current.providers.map((provider) => ({
    search: `${provider.label} ${provider.providerId} model ${provider.defaultModel ?? ""}`,
    node: row({
      title: provider.label,
      detail: provider.authStatus === "authenticated"
        ? "New chats start on this model unless the composer says otherwise."
        : "Not signed in yet — sign in from Providers first.",
      chips: [provenanceChip("local")],
      control: modelLine(provider)
    })
  }));
}

function prepromptRows(current: ConfigState): Row[] {
  // The settings row first (the path itself is editable), then the files.
  const rows: Row[] = settingsFor(current, "preprompts").map((entry) => ({
    search: `${entry.label} ${entry.detail} ${entry.key}`,
    node: settingRow(entry)
  }));
  rows.push(...current.preprompts.map((entry) => ({
    search: `${entry.label} ${entry.path}`,
    node: row({
      title: entry.label,
      detail: entry.exists
        ? `${entry.path}${entry.bytes === undefined ? "" : ` · ${formatBytes(entry.bytes)}`}`
        : `${entry.path} · not found`,
      chips: [provenanceChip(entry.provenance)],
      control: entry.exists ? openFileLink(entry.path, "open ↗") : null,
      className: entry.provenance === "project" ? "cfg-row-readonly" : ""
    })
  })));
  return rows;
}

function recipeSectionRows(current: ConfigState): Row[] {
  const rows: Row[] = current.recipes.map((recipe) => ({
    search: `${recipe.name} ${recipe.description ?? ""} recipe`,
    node: row({
      title: recipe.name,
      detail: recipe.description ?? `${String(recipe.stepCount)} step${recipe.stepCount === 1 ? "" : "s"}`,
      chips: [chip(`${String(recipe.stepCount)} steps`, "cfg-micro"), provenanceChip(recipe.provenance)],
      className: "cfg-row-readonly"
    })
  }));
  for (const aspect of current.aspects) {
    rows.push({
      search: `${aspect.label} aspect ${aspect.expectedArtifacts.join(" ")}`,
      node: row({
        title: aspect.label,
        detail: aspect.expectedArtifacts.length === 0
          ? "Planning aspect."
          : `Expects: ${aspect.expectedArtifacts.join("; ")}`,
        chips: [chip("aspect", "cfg-micro"), provenanceChip(aspect.provenance)],
        className: "cfg-row-readonly"
      })
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Memories: quick-add, the approval gate, the browser (ADR 0019 / ADR 0020)
// ---------------------------------------------------------------------------

function upsertMemoryCandidate(candidate: MemoryCandidateSummary): void {
  if (memoryCandidates === null) memoryCandidates = [];
  const index = memoryCandidates.findIndex((entry) => entry.memoryCandidateId === candidate.memoryCandidateId);
  if (index === -1) memoryCandidates.unshift(candidate);
  else memoryCandidates[index] = candidate;
}

/** Agent proposals awaiting review - the section's "needs you" number. */
function pendingMemoryCount(): number {
  return memoryCandidates === null
    ? 0
    : memoryCandidates.filter((entry) => entry.status === "pending").length;
}

/** Two-click destructive control: the first click arms to the confirm label. */
function confirmingButton(className: string, label: string, confirmLabel: string, title: string, run: () => void): HTMLButtonElement {
  let armed = false;
  let timer: number | undefined;
  function disarm(): void {
    armed = false;
    node.textContent = label;
    node.classList.remove("cfg-armed");
  }
  const node = button(className, label, title, () => {
    if (armed) {
      if (timer !== undefined) window.clearTimeout(timer);
      disarm();
      run();
      return;
    }
    armed = true;
    node.textContent = confirmLabel;
    node.classList.add("cfg-armed");
    timer = window.setTimeout(disarm, 3_000);
  });
  return node;
}

/** Toggleable tag chips from the workspace's detected tags (+ the row's own). */
function memoryTagChips(container: HTMLElement, selected: Set<string>, extraTags: readonly string[]): void {
  container.replaceChildren();
  const all = [...new Set([...extraTags, ...memoryDetectedTags])];
  if (all.length === 0) return;
  container.append(el("span", "cfg-memory-tags-label", "for:"));
  for (const tag of all) {
    const node = button(
      `cfg-chip cfg-tag-toggle${selected.has(tag) ? " selected" : ""}`,
      tag,
      `Toggle the ${tag} tag`,
      () => {
        if (selected.has(tag)) selected.delete(tag);
        else selected.add(tag);
        memoryTagChips(container, selected, extraTags);
      }
    );
    node.setAttribute("aria-pressed", selected.has(tag) ? "true" : "false");
    container.append(node);
  }
}

/** Compact scope descriptor ("task: Fix export", "ws: drydock", "global"). */
function memoryScopeChipText(candidate: MemoryCandidateSummary): string {
  if (candidate.scope === "task") return `task: ${(candidate.scopeLabel ?? "?").slice(0, 24)}`;
  if (candidate.scope === "workspace") return `ws: ${(candidate.scopeLabel ?? "?").slice(0, 24)}`;
  return "global";
}

function submitQuickAdd(): void {
  const content = quickAddInput.value.trim();
  if (content.length === 0) return;
  void request({
    type: "memory.add",
    content,
    scope: quickScope,
    ...(quickTags.size === 0 ? {} : { tags: [...quickTags] })
  }).then((response) => {
    if (response.ok && response.payload.type === "memory.add") {
      quickAddInput.value = "";
      quickTags.clear();
      upsertMemoryCandidate(response.payload.candidate);
      flashSaved("memory:add");
      render();
      return;
    }
    fail(response);
  });
}

/** The one-line "Remember…" entry; human-authored memories skip the review gate. */
function quickAddRow(): HTMLElement {
  const line = el("div", "cfg-memory-quick");
  line.append(quickAddInput);
  line.append(selectField(
    [
      { value: "workspace", label: "This workspace" },
      { value: "global", label: "Global" }
    ],
    quickScope === "global" ? "global" : "workspace",
    "Where the memory applies",
    (next) => { quickScope = next === "global" ? "global" : "workspace"; }
  ));
  const tags = el("div", "cfg-memory-tags");
  memoryTagChips(tags, quickTags, []);
  const below = el("div");
  below.append(line, tags);
  return row({
    title: "Remember something",
    detail: "One durable sentence. Yours lands approved and rides the next matching briefing.",
    // Not "saved to settings": quick-adds land in the local memory store.
    chips: noteChips("memory:add", "remembered"),
    below
  });
}

function resolveMemoryCandidate(
  candidate: MemoryCandidateSummary,
  approve: boolean,
  edits?: { content: string; scope: MemoryScope; tags: string[] }
): void {
  void request({
    type: "memory.resolve",
    memoryCandidateId: candidate.memoryCandidateId,
    approve,
    ...(edits === undefined ? {} : { edits })
  }).then((response) => {
    if (response.ok && response.payload.type === "memory.resolve") {
      memoryDrafts.delete(candidate.memoryCandidateId);
      upsertMemoryCandidate(response.payload.candidate);
      render();
      return;
    }
    // Resolved elsewhere (or gone): the refetch replaces the guess with truth.
    fail(response);
    void load();
  });
}

/**
 * One pending agent proposal - EVERYTHING is editable before approval (agent
 * proposals run wordy; the human trims to the durable sentence and retargets
 * scope/tags). Approve sends the edited values; this card IS the review gate.
 */
function pendingMemoryCard(candidate: MemoryCandidateSummary): HTMLElement {
  const draft = memoryDrafts.get(candidate.memoryCandidateId) ?? { scope: candidate.scope, tags: new Set(candidate.tags) };
  memoryDrafts.set(candidate.memoryCandidateId, draft);
  const card = el("div", "cfg-card cfg-memory-pending");
  const head = el("div", "cfg-card-head");
  const dot = el("span", "cfg-memory-dot");
  dot.title = "Waiting for your review.";
  head.append(dot, el("span", "cfg-card-title", "Proposed memory"));
  if (candidate.scopeLabel !== undefined) head.append(chip(memoryScopeChipText(candidate), "cfg-quiet-chip"));
  card.append(head);
  const content = document.createElement("textarea");
  content.className = "cfg-memory-edit";
  content.value = draft.content ?? candidate.content;
  content.rows = Math.min(6, Math.max(2, Math.ceil(content.value.length / 80)));
  content.setAttribute("aria-label", "Edit the proposed memory before approving");
  content.addEventListener("input", () => { draft.content = content.value; });
  card.append(content);
  card.append(el("p", "cfg-memory-source",
    `Proposed by an agent (session ${candidate.sessionId.slice(0, 8)}…). Nothing reaches briefings until you approve it.`));
  const scopeLine = el("div", "cfg-memory-scope-line");
  scopeLine.append(el("span", "cfg-field-label", "Applies to"));
  scopeLine.append(selectField(
    [
      { value: "task", label: "The source task" },
      { value: "workspace", label: "This workspace" },
      { value: "global", label: "Everywhere" }
    ],
    draft.scope,
    "Where the memory applies",
    (next) => { draft.scope = next as MemoryScope; }
  ));
  const tags = el("div", "cfg-memory-tags");
  memoryTagChips(tags, draft.tags, candidate.tags);
  scopeLine.append(tags);
  card.append(scopeLine);
  const actions = el("div", "cfg-memory-actions");
  actions.append(button("cfg-button", "Approve", "Approve with the edits above", () => {
    resolveMemoryCandidate(candidate, true, {
      content: content.value.trim() || candidate.content,
      scope: draft.scope,
      tags: [...draft.tags]
    });
  }));
  actions.append(confirmingButton("cfg-button cfg-danger", "Reject", "Confirm reject", "Discard this proposal", () => {
    resolveMemoryCandidate(candidate, false);
  }));
  card.append(actions);
  return card;
}

/** One approved memory: content + scope/tag chips, open ↗ and delete. */
function approvedMemoryRow(candidate: MemoryCandidateSummary): HTMLElement {
  const node = el("div", "cfg-row cfg-memory-row");
  const main = el("div", "cfg-row-main");
  const content = el("p", "cfg-memory-content", candidate.content);
  content.title = candidate.content;
  main.append(content);
  const chipsLine = el("div", "cfg-row-head");
  chipsLine.append(chip(memoryScopeChipText(candidate), "cfg-micro"));
  for (const tag of candidate.tags) chipsLine.append(chip(tag, "cfg-quiet-chip"));
  chipsLine.append(chip(candidate.origin === "user" ? "added by you" : "agent proposal", "cfg-quiet-chip"));
  main.append(chipsLine);
  node.append(main);
  const control = el("div", "cfg-row-control");
  control.append(button("cfg-linkish", "open ↗", "Open this memory as a document", () => {
    void request({ type: "memory.open", memoryCandidateId: candidate.memoryCandidateId }).then((response) => {
      if (!response.ok) fail(response);
    });
  }));
  control.append(confirmingButton("cfg-icon-button cfg-danger", "×", "Delete?", "Delete this memory", () => {
    void request({ type: "memory.delete", memoryCandidateId: candidate.memoryCandidateId }).then((response) => {
      if (response.ok && response.payload.type === "memory.delete") {
        if (memoryCandidates !== null) {
          memoryCandidates = memoryCandidates.filter((entry) => entry.memoryCandidateId !== candidate.memoryCandidateId);
        }
        render();
        return;
      }
      fail(response);
    });
  }));
  node.append(control);
  return node;
}

/** Quick-add, then pending proposals, then the approved browser - data before rules. */
function memoryBrowserRows(): Row[] {
  if (memoryCandidates === null) {
    return [{
      search: "memories",
      node: row({
        title: "Memories",
        detail: memoryNotice ?? "Reading memories…",
        className: "cfg-row-readonly"
      })
    }];
  }
  const rows: Row[] = [{ search: "remember quick add memory note", node: quickAddRow() }];
  const byNewest = (a: MemoryCandidateSummary, b: MemoryCandidateSummary): number => (a.createdAt < b.createdAt ? 1 : -1);
  const pending = memoryCandidates.filter((entry) => entry.status === "pending").sort(byNewest);
  for (const candidate of pending) {
    rows.push({
      search: `proposed memory pending review ${candidate.content} ${candidate.tags.join(" ")}`,
      node: pendingMemoryCard(candidate)
    });
  }
  const approved = memoryCandidates.filter((entry) => entry.status === "approved").sort(byNewest);
  for (const candidate of approved) {
    rows.push({
      search: `memory ${candidate.content} ${candidate.tags.join(" ")} ${candidate.scope}`,
      node: approvedMemoryRow(candidate)
    });
  }
  if (pending.length === 0 && approved.length === 0) {
    rows.push({
      search: "",
      node: el("p", "cfg-empty", "No memories yet. Add one above, or approve an agent's proposal when one arrives at a turn's end.")
    });
  }
  return rows;
}

function memoryRows(current: ConfigState): Row[] {
  const rows: Row[] = memoryBrowserRows();
  rows.push(...settingsFor(current, "memories").map((entry) => ({
    search: `${entry.label} ${entry.detail} tag rules globs`,
    node: settingRow(entry)
  })));
  const builtIn = current.tagRules.filter((rule) => rule.provenance === "local");
  if (builtIn.length > 0) {
    const table = el("div", "cfg-list");
    for (const rule of builtIn) {
      const line = el("div", "cfg-list-row cfg-rule-row cfg-rule-static");
      line.append(el("span", "cfg-rule-globs", rule.globs.join(", ")));
      line.append(el("span", "cfg-rule-arrow", "→"));
      line.append(el("span", "cfg-rule-tag", rule.tag));
      table.append(line);
    }
    rows.push({
      search: `built-in tag rules ${builtIn.map((rule) => `${rule.tag} ${rule.globs.join(" ")}`).join(" ")}`,
      node: row({
        title: "Built-in patterns",
        detail: "Shipped with Drydock; your rules above extend this table.",
        chips: [provenanceChip("local")],
        below: table,
        className: "cfg-row-readonly"
      })
    });
  }
  return rows;
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${String(value)} B`;
}

function isTagRule(value: unknown): value is ConfigTagRuleInput {
  return typeof value === "object" && value !== null && "tag" in value && "globs" in value;
}

function noteChips(key: string, label?: string): HTMLElement[] {
  const note = savedNote(key, label);
  return note === null ? [] : [note];
}

function settingRows(rows: readonly ConfigSettingRow[]): Row[] {
  return rows.map((entry) => ({
    search: `${entry.label} ${entry.detail} ${entry.key}`,
    node: settingRow(entry)
  }));
}

function settingRow(entry: ConfigSettingRow): HTMLElement {
  const locked = entry.lockedReason !== undefined;
  const chips: HTMLElement[] = [provenanceChip(entry.provenance)];
  if (entry.requiresReload) chips.push(reloadChip());
  if (locked) {
    const lock = chip("set by your administrator", "cfg-lock");
    lock.title = entry.lockedReason ?? "";
    chips.push(lock);
  }
  chips.push(...noteChips(entry.key));

  let control: HTMLElement | null = null;
  let below: HTMLElement | null = null;
  switch (entry.kind) {
    case "boolean":
      control = toggleField(entry.value === true, entry.label, locked, (next) => {
        setSetting(entry, next);
      });
      break;
    case "number":
      control = numberControl(entry, locked);
      break;
    case "string":
      control = textField(typeof entry.value === "string" ? entry.value : "", {
        label: entry.label,
        placeholder: "host path",
        ...(locked ? { disabled: true } : {})
      }, (next) => {
        setSetting(entry, next.trim());
      });
      break;
    case "string-list":
      below = stringListField(
        Array.isArray(entry.value) ? (entry.value as readonly string[]).filter((item): item is string => typeof item === "string") : [],
        { label: entry.label, placeholder: "add a path", ...(locked ? { disabled: true } : {}) },
        (next) => { setSetting(entry, next); }
      );
      break;
    case "string-map":
      below = stringMapField(
        typeof entry.value === "object" && entry.value !== null && !Array.isArray(entry.value)
          ? (entry.value as Readonly<Record<string, string>>)
          : {},
        { label: entry.label, ...(locked ? { disabled: true } : {}) },
        (next) => { setSetting(entry, next); }
      );
      break;
    case "tag-rules":
      below = tagRulesField(
        Array.isArray(entry.value) ? (entry.value as readonly unknown[]).filter(isTagRule) : [],
        (next) => { setSetting(entry, next); }
      );
      break;
  }
  return row({
    title: entry.label,
    detail: entry.detail,
    chips,
    control,
    below,
    className: locked ? "cfg-row-readonly" : ""
  });
}

/** `maxConcurrentRuns` reads as auto/1-8 rather than a raw 0. */
function numberControl(entry: ConfigSettingRow, locked: boolean): HTMLElement {
  if (entry.key !== "orchestrator.maxConcurrentRuns") {
    return textField(typeof entry.value === "number" ? String(entry.value) : "", {
      kind: "number",
      label: entry.label,
      ...(entry.min === undefined ? {} : { min: entry.min }),
      ...(entry.max === undefined ? {} : { max: entry.max }),
      ...(locked ? { disabled: true } : {})
    }, (next) => {
      const parsed = Number(next);
      if (!Number.isFinite(parsed)) return;
      setSetting(entry, parsed);
    });
  }
  const options = [
    { value: "0", label: "Auto" },
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((count) => ({ value: String(count), label: String(count) }))
  ];
  const current = typeof entry.value === "number" ? entry.value : 0;
  return selectField(options, String(current), entry.label, (next) => {
    setSetting(entry, Number(next));
  });
}

// ---------------------------------------------------------------------------
// Validation runtimes (ADR 0022, ux-flows F4/F5/F6)
// ---------------------------------------------------------------------------

/**
 * Every validation mutation is request → ack → refetch (the memories pattern),
 * never an optimistic local write: routing, defaults and probe state are the
 * host's truth and a half-applied registry is worse than a beat of latency.
 */
function validationMutate(payload: ValidationRequest, savedKeyName: string): void {
  void validationRequest(payload).then((response) => {
    if (response.ok && (response.payload.type === "config.validation.ack" || response.payload.type === "validation.ack")) {
      flashSaved(savedKeyName);
      void load();
      return;
    }
    notice = response.ok ? "That change was not applied." : response.error.message;
    render();
    void load();
  });
}

/** The one word an L1 runtime line spends on state (F4). */
function runtimeStateWord(runtime: ValidationRuntimeRow): string {
  switch (runtime.availability) {
    case "available": return "running";
    case "stopped": return `${runtime.lifecycle} (stopped)`;
    case "quarantined": return "quarantined";
    case "missing": return "missing";
    default: return "state unknown";
  }
}

function associationCount(current: ValidationConfigState, runtimeId: string): number {
  return current.associations.filter((entry) => entry.runtimeId === runtimeId).length;
}

/** Runtimes a job can be pointed at: everything live, minus the archived. */
function activeRuntimes(current: ValidationConfigState): readonly ValidationRuntimeRow[] {
  return current.runtimes.filter((entry) => entry.archived !== true);
}

/**
 * F5: the one deliberate exception to calm. Persistent (never auto-dismisses),
 * full width, with the three actions the incident needs.
 */
function quarantineBanner(current: ValidationConfigState): HTMLElement {
  const wrap = el("div", "cfg-quarantine");
  wrap.setAttribute("role", "alert");
  for (const entry of current.quarantines) {
    const runtime = current.runtimes.find((candidate) => candidate.runtimeId === entry.runtimeId);
    const block = el("div", "cfg-quarantine-entry");
    const head = el("div", "cfg-quarantine-head");
    const name = el("span", "cfg-quarantine-name", entry.displayName);
    name.title = `${entry.displayName} · probe ${entry.probeId}`;
    head.append(name, chip(entry.probeId, "cfg-micro"));
    block.append(head);
    // The record's own stamp wins: the breach run replaced the live probe
    // view's green, so `probes.greenAt` is empty exactly when this banner
    // shows (T5.5). The live value remains as fallback for legacy records.
    block.append(el("p", "cfg-quarantine-line", quarantineSentence(entry.detail, entry.at, entry.lastGreenAt ?? runtime?.probes?.greenAt)));
    const actions = el("div", "cfg-quarantine-actions");
    actions.append(button("cfg-button", "Probe log", "Open this runtime's isolation evidence", () => {
      expandedRuntimeIds.add(entry.runtimeId);
      render();
      const node = content.querySelector(`[data-runtime-id="${cssEscape(entry.runtimeId)}"]`);
      if (node instanceof HTMLElement) node.scrollIntoView({ block: "nearest" });
    }));
    const revert = button("cfg-button", "Revert & re-probe", "Roll the VM back to its clean baseline and re-run the isolation probes. The quarantine clears only if they pass.", () => {
      validationMutate({ type: "config.validation.revertReprobe", runtimeId: entry.runtimeId }, `validation:revert:${entry.runtimeId}`);
    });
    actions.append(revert);
    actions.append(confirmingButton(
      "cfg-button cfg-danger",
      "Remove",
      "Confirm remove",
      "Delete this runtime. Its associations must be reassigned first.",
      () => {
        validationMutate({ type: "config.validation.deleteRuntime", runtimeId: entry.runtimeId }, `validation:delete:${entry.runtimeId}`);
      }
    ));
    block.append(actions);
    wrap.append(block);
  }
  return wrap;
}

/** Attribute-selector-safe id (ids are host-minted, but never trust that). */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/** One runtime: an L1 line that expands in place to its three concern lines. */
function validationRuntimeRow(current: ValidationConfigState, runtime: ValidationRuntimeRow): HTMLElement {
  const fold = document.createElement("details");
  fold.className = runtime.availability === "quarantined" ? "cfg-vr cfg-vr-quarantined" : "cfg-vr";
  fold.dataset["runtimeId"] = runtime.runtimeId;
  fold.open = expandedRuntimeIds.has(runtime.runtimeId);
  fold.addEventListener("toggle", () => {
    if (fold.open) expandedRuntimeIds.add(runtime.runtimeId);
    else expandedRuntimeIds.delete(runtime.runtimeId);
  });

  const summary = document.createElement("summary");
  summary.className = "cfg-vr-summary";
  const name = el("span", "cfg-vr-name", middleTruncate(runtime.displayName, 30));
  name.title = runtime.displayName;
  summary.append(name);
  if (runtime.isDefault) {
    const marker = chip("default", "cfg-micro");
    marker.title = "Jobs with no override and no project association run here.";
    summary.append(marker);
  }
  summary.append(el("span", "cfg-vr-sep", "—"));
  summary.append(el("span", "cfg-vr-state", runtimeStateWord(runtime)));
  if (runtime.queueDepth > 0) {
    summary.append(el("span", "cfg-vr-queue", `· queue ${String(runtime.queueDepth)}`));
  }
  const associations = associationCount(current, runtime.runtimeId);
  if (associations > 0) {
    summary.append(el("span", "cfg-vr-assoc", `· ${String(associations)} project${associations === 1 ? "" : "s"}`));
  }
  if (runtime.archived === true) summary.append(chip("archived", "cfg-micro"));
  if (runtime.profileException === true) {
    // The one ambient security marker in the list (F4): permanent, never a toast.
    const badge = chip("⚠ profile exception", "cfg-warn-chip");
    badge.title = "This runtime runs under a broader policy profile than the default. Every receipt it produces carries the badge.";
    summary.append(badge);
  }
  fold.append(summary);

  const body = el("div", "cfg-vr-body");
  body.append(concernLine("Runtime", [
    runtime.availability === "unknown" ? "availability unknown" : runtime.availability,
    runtime.vmName,
    runtime.image,
    runtime.connectionHost ?? "no host recorded"
  ].join(" · ")));
  body.append(isolationBlock(runtime));
  // Mirror freshness is per-JOB evidence in v1; the registry cannot verify it,
  // so it renders unknown rather than inventing a green line (ADR 0021).
  body.append(concernLine("Mirror", "unknown — the registry does not track a per-runtime mirror version yet; job receipts carry the version they ran against."));
  body.append(concernLine("Lifecycle", runtime.lifecycle));
  body.append(concernLine("Associations", associations === 0
    ? "none — only jobs that name it explicitly run here"
    : `${String(associations)} project${associations === 1 ? "" : "s"} route here`));
  if (runtime.capabilities.length > 0) {
    body.append(concernLine("Capabilities", runtime.capabilities.join(" · ")));
  }
  body.append(concernLine("Policy profile", runtime.policyProfileRef));
  body.append(runtimeActions(current, runtime));
  body.append(runtimeEditFold(current, runtime));
  fold.append(body);
  return fold;
}

function concernLine(label: string, value: string): HTMLElement {
  const line = el("div", "cfg-vr-line");
  line.append(el("span", "cfg-vr-label", label));
  const text = el("span", "cfg-vr-value", value);
  text.title = value;
  line.append(text);
  return line;
}

/** Isolation: the verdict line, then the probe log as its own mono scroller. */
function isolationBlock(runtime: ValidationRuntimeRow): HTMLElement {
  const wrap = el("div", "cfg-vr-isolation");
  const probes = runtime.probes;
  if (probes === undefined) {
    wrap.append(concernLine("Isolation", "unknown — no probe run is on record. Run probes to establish a baseline."));
    return wrap;
  }
  const verdict = probes.state === "pass"
    ? `verified ${clockTime(probes.at)}`
    : probes.state === "breach"
      ? `BREACH at ${clockTime(probes.at)} — a must-fail probe passed`
      : probes.state === "fail"
        ? `failed at ${clockTime(probes.at)}`
        : `unknown — last attempt ${clockTime(probes.at)}`;
  const green = probes.greenAt === undefined ? "" : ` · last green ${clockTime(probes.greenAt)}`;
  const isolation = concernLine("Isolation", `${verdict}${green}`);
  // Red only where a decision is needed: a breach or a failed suite.
  if (probes.state === "breach" || probes.state === "fail") isolation.classList.add("cfg-vr-line-alarm");
  wrap.append(isolation);
  if (probes.lines.length === 0) return wrap;
  const log = el("div", "cfg-vr-probe-log");
  for (const line of probes.lines) {
    const entry = el("div", `cfg-vr-probe cfg-vr-probe-${line.state}`);
    entry.append(el("span", "cfg-vr-probe-glyph", probeGlyph(line.state)));
    entry.append(el("span", "cfg-vr-probe-id", line.probeId));
    entry.append(el("span", "cfg-vr-probe-title", line.title));
    entry.append(el("span", "cfg-vr-probe-detail", line.detail));
    log.append(entry);
  }
  wrap.append(log);
  return wrap;
}

function probeGlyph(state: string): string {
  if (state === "pass") return "✓";
  if (state === "breach") return "⚠";
  if (state === "fail") return "✕";
  return "?";
}

/** The row's `⋯` actions - destructive ones state their consequence here. */
function runtimeActions(current: ValidationConfigState, runtime: ValidationRuntimeRow): HTMLElement {
  const actions = el("div", "cfg-vr-actions");
  actions.append(el("span", "cfg-vr-actions-label", "⋯"));
  if (!runtime.isDefault && runtime.archived !== true) {
    actions.append(button("cfg-button", "Set default", "Route every unassociated job here", () => {
      validationMutate({ type: "config.validation.setDefault", runtimeId: runtime.runtimeId }, `validation:default`);
    }));
  }
  actions.append(button("cfg-button", "Run probes", "Re-run the isolation probes now", () => {
    validationMutate({ type: "config.validation.runProbes", runtimeId: runtime.runtimeId }, `validation:probes:${runtime.runtimeId}`);
  }));
  actions.append(button("cfg-button", "Adopt", "Take ownership of the VM behind this runtime (re-adopts an existing VM after a rebuild).", () => {
    validationMutate({ type: "config.validation.adopt", runtimeId: runtime.runtimeId }, `validation:adopt:${runtime.runtimeId}`);
  }));
  const archived = runtime.archived === true;
  actions.append(button(
    "cfg-button",
    archived ? "Unarchive" : "Archive",
    archived
      ? "Return this runtime to the routing table"
      : "Stop routing new jobs here. Associations and evidence are kept.",
    () => {
      validationMutate(
        { type: "config.validation.updateRuntime", runtimeId: runtime.runtimeId, update: { archived: !archived } },
        `validation:archive:${runtime.runtimeId}`
      );
    }
  ));

  // Delete needs somewhere for the orphaned associations to land (H5), and the
  // default runtime is never deletable - it is re-pointed instead.
  const associations = associationCount(current, runtime.runtimeId);
  let reassignTo = "";
  if (associations > 0 && !runtime.isDefault) {
    const options = [
      { value: "", label: `default (${String(associations)} project${associations === 1 ? "" : "s"})` },
      ...activeRuntimes(current)
        .filter((entry) => entry.runtimeId !== runtime.runtimeId)
        .map((entry) => ({ value: entry.runtimeId, label: `reassign to ${entry.displayName}` }))
    ];
    actions.append(selectField(options, "", `Where ${runtime.displayName}'s projects go`, (next) => {
      reassignTo = next;
    }));
  }
  const remove = confirmingButton(
    "cfg-button cfg-danger",
    "Delete…",
    associations > 0 ? `Delete and move ${String(associations)}?` : "Confirm delete",
    runtime.isDefault
      ? "The default runtime cannot be deleted — point the default at another runtime first."
      : "Deletes the runtime. Its projects fall back to the runtime chosen beside this button.",
    () => {
      validationMutate({
        type: "config.validation.deleteRuntime",
        runtimeId: runtime.runtimeId,
        ...(reassignTo === "" ? {} : { reassignTo })
      }, `validation:delete:${runtime.runtimeId}`);
    }
  );
  if (runtime.isDefault) remove.disabled = true;
  actions.append(remove);
  return actions;
}

/** Inline field editing, folded away: the row stays one line until asked. */
function runtimeEditFold(current: ValidationConfigState, runtime: ValidationRuntimeRow): HTMLElement {
  const fold = document.createElement("details");
  fold.className = "cfg-fold cfg-vr-edit";
  const summary = document.createElement("summary");
  summary.className = "cfg-fold-summary";
  summary.textContent = "Edit fields";
  fold.append(summary);
  const form = el("div", "cfg-vr-form");
  const commit = (update: ValidationRuntimeUpdate): void => {
    validationMutate(
      { type: "config.validation.updateRuntime", runtimeId: runtime.runtimeId, update },
      `validation:edit:${runtime.runtimeId}`
    );
  };
  form.append(fieldLine("Name", textField(runtime.displayName, { label: "Runtime name" }, (next) => {
    const trimmed = next.trim();
    if (trimmed.length === 0 || trimmed === runtime.displayName) return;
    commit({ displayName: trimmed });
  })));
  form.append(fieldLine("Image", imageControl(current, runtime.image, (next) => {
    if (next === runtime.image) return;
    commit({ image: next });
  })));
  form.append(fieldLine("Lifecycle", selectField(
    LIFECYCLE_OPTIONS.map((entry) => ({ value: entry.value, label: entry.label })),
    runtime.lifecycle,
    "Lifecycle",
    (next) => { commit({ lifecycle: next as ValidationLifecycle }); }
  )));
  form.append(fieldLine("Policy profile", textField(runtime.policyProfileRef, { label: "Policy profile" }, (next) => {
    const trimmed = next.trim();
    if (trimmed.length === 0 || trimmed === runtime.policyProfileRef) return;
    commit({ policyProfileRef: trimmed });
  })));
  const capabilities = el("div", "cfg-vr-field");
  capabilities.append(el("span", "cfg-field-label", "Capabilities"));
  capabilities.append(stringListField([...runtime.capabilities], { label: "Capabilities", placeholder: "add a capability" }, (next) => {
    commit({ capabilities: [...next] });
  }));
  form.append(capabilities);
  fold.append(form);
  return fold;
}

function fieldLine(label: string, control: HTMLElement): HTMLElement {
  const line = el("div", "cfg-vr-field");
  line.append(el("span", "cfg-field-label", label));
  line.append(control);
  return line;
}

/** Studio image allowlists turn the free-text field into a pick (H2/managed). */
function imageControl(current: ValidationConfigState, value: string, commit: (next: string) => void): HTMLElement {
  const allowlist = current.managed?.imageAllowlist;
  if (allowlist === undefined || allowlist.length === 0) {
    return textField(value, { label: "Image", placeholder: "image reference" }, (next) => {
      const trimmed = next.trim();
      if (trimmed.length === 0) return;
      commit(trimmed);
    });
  }
  const options = allowlist.map((entry) => ({ value: entry, label: entry }));
  if (!allowlist.includes(value) && value.length > 0) options.unshift({ value, label: `${value} (not in the studio allowlist)` });
  return selectField(options, value, "Image", commit);
}

/** The collapsed create line: the minimal form, and nothing else (F6). */
function validationCreateFold(current: ValidationConfigState): HTMLElement {
  const fold = document.createElement("details");
  fold.className = "cfg-fold";
  const summary = document.createElement("summary");
  summary.className = "cfg-fold-summary";
  summary.textContent = "Add validation runtime";
  fold.append(summary);
  const form = el("div", "cfg-vr-form");

  const name = document.createElement("input");
  name.type = "text";
  name.className = "cfg-input";
  name.placeholder = "name (cpp-builds, production_tester…)";
  name.setAttribute("aria-label", "New runtime name");

  const allowlist = current.managed?.imageAllowlist ?? [];
  const imageInput = document.createElement("input");
  imageInput.type = "text";
  imageInput.className = "cfg-input";
  imageInput.placeholder = "image reference";
  imageInput.setAttribute("aria-label", "New runtime image");
  let imageValue = allowlist[0] ?? "";
  const imageField: HTMLElement = allowlist.length > 0
    ? selectField(allowlist.map((entry) => ({ value: entry, label: entry })), imageValue, "Image", (next) => { imageValue = next; })
    : imageInput;

  let lifecycle: ValidationLifecycle = "keep-warm";
  const lifecycleField = selectField(
    LIFECYCLE_OPTIONS.map((entry) => ({ value: entry.value, label: entry.label })),
    lifecycle,
    "Lifecycle",
    (next) => { lifecycle = next as ValidationLifecycle; }
  );

  let capabilities: string[] = [];
  const capabilitiesWrap = el("div", "cfg-vr-capabilities");
  const paintCapabilities = (): void => {
    capabilitiesWrap.replaceChildren(stringListField(capabilities, { label: "Capabilities", placeholder: "maya, msvc, …" }, (next) => {
      capabilities = [...next];
      paintCapabilities();
    }));
  };
  paintCapabilities();

  const profile = document.createElement("input");
  profile.type = "text";
  profile.className = "cfg-input";
  profile.placeholder = "policy profile (validation.default)";
  profile.setAttribute("aria-label", "Policy profile reference");

  const host = document.createElement("input");
  host.type = "text";
  host.className = "cfg-input";
  host.placeholder = "guest host";
  host.setAttribute("aria-label", "Guest host");
  const user = document.createElement("input");
  user.type = "text";
  user.className = "cfg-input";
  user.placeholder = "guest user";
  user.setAttribute("aria-label", "Guest user");
  const port = document.createElement("input");
  port.type = "number";
  port.className = "cfg-input cfg-input-port";
  port.placeholder = "port";
  port.setAttribute("aria-label", "Guest SSH port");
  // A TCP port is a whole number in 1..65535; the same range submit() checks below.
  port.min = "1";
  port.max = "65535";
  port.step = "1";

  // The TD gate (F6): studios may forbid creating profile-exception runtimes
  // outright, in which case the control is ABSENT rather than disabled-and-teasing.
  const exceptionAllowed = current.managed?.profileExceptionCreation !== "disabled";
  let profileException = false;
  const confirmWrap = el("div", "cfg-vr-confirm cfg-hidden");
  const confirmLabel = el("label", "cfg-vr-confirm-label");
  confirmLabel.append(document.createTextNode("To create a profile-exception runtime, type "));
  const confirmToken = el("span", "cfg-confirm-token", "the runtime name");
  confirmLabel.append(confirmToken);
  const confirmInput = document.createElement("input");
  confirmInput.type = "text";
  confirmInput.className = "cfg-input";
  confirmInput.placeholder = "type it to confirm";
  confirmInput.setAttribute("aria-label", "Type the runtime name to confirm");
  confirmWrap.append(confirmLabel, confirmInput);

  const vmPreview = el("p", "cfg-vr-vmname", "VM name: drydock-validation-…");
  const create = button("cfg-button", "Create", "Create this validation runtime", () => { submit(); });

  const expectedToken = (): string => name.value.trim().toLowerCase();
  const confirmSatisfied = (): boolean =>
    !profileException || (expectedToken().length > 0 && confirmInput.value.trim().toLowerCase() === expectedToken());
  const refresh = (): void => {
    const slug = name.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    vmPreview.textContent = `VM name: drydock-validation-${slug.length === 0 ? "…" : slug}`;
    confirmToken.textContent = name.value.trim().length === 0 ? "the runtime name" : name.value.trim();
    create.disabled = !confirmSatisfied();
  };
  name.addEventListener("input", refresh);
  confirmInput.addEventListener("input", refresh);

  function submit(): void {
    const displayName = name.value.trim();
    const image = allowlist.length > 0 ? imageValue : imageInput.value.trim();
    const policyProfileRef = profile.value.trim();
    if (displayName.length === 0 || image.length === 0 || policyProfileRef.length === 0) {
      notice = "A runtime needs a name, an image and a policy profile.";
      render();
      return;
    }
    if (!confirmSatisfied()) return;
    const hostValue = host.value.trim();
    const userValue = user.value.trim();
    const portValue = Number(port.value);
    // A TCP port is a whole number in 1..65535 - 22.7 and 99999 both used to
    // pass the old finite/sign-only check.
    const portValid = Number.isInteger(portValue) && portValue >= 1 && portValue <= 65535;
    const connection = hostValue.length > 0 && userValue.length > 0
      ? {
          host: hostValue,
          user: userValue,
          ...(portValid ? { port: portValue } : {})
        }
      : undefined;
    validationMutate({
      type: "config.validation.createRuntime",
      displayName,
      image,
      lifecycle,
      capabilities,
      policyProfileRef,
      ...(profileException ? { profileException: true } : {}),
      ...(connection === undefined ? {} : { connection })
    }, "validation:create");
  }

  form.append(fieldLine("Name", name));
  form.append(fieldLine("Image", imageField));
  form.append(fieldLine("Lifecycle", lifecycleField));
  const capabilitiesLine = el("div", "cfg-vr-field");
  capabilitiesLine.append(el("span", "cfg-field-label", "Capabilities"), capabilitiesWrap);
  form.append(capabilitiesLine);
  form.append(fieldLine("Policy profile", profile));
  if (exceptionAllowed) {
    form.append(fieldLine("Profile exception", toggleField(false, "Profile exception", false, (next) => {
      profileException = next;
      confirmWrap.classList.toggle("cfg-hidden", !next);
      refresh();
    })));
    form.append(confirmWrap);
  }
  const connectionLine = el("div", "cfg-vr-field");
  connectionLine.append(el("span", "cfg-field-label", "Connection"), host, user, port);
  form.append(connectionLine);
  form.append(vmPreview);
  const actions = el("div", "cfg-vr-actions");
  actions.append(create);
  form.append(actions);
  refresh();
  fold.append(form);
  return fold;
}

/** F6's association editor: two columns, scrollable, no row = default. */
function validationAssociations(current: ValidationConfigState): HTMLElement {
  const wrap = el("div", "cfg-assoc");
  const head = el("div", "cfg-assoc-head");
  head.append(el("span", "cfg-assoc-col", "PROJECT"), el("span", "cfg-assoc-col", "RUNTIME"));
  wrap.append(head);
  const body = el("div", "cfg-assoc-body");
  const byProject = new Map(current.associations.map((entry) => [entry.projectRootId, entry]));
  const projects = [...current.projects];
  // An association for a project this window cannot see still routes jobs; show
  // it rather than pretending the table is complete.
  for (const entry of current.associations) {
    if (projects.some((project) => project.projectRootId === entry.projectRootId)) continue;
    projects.push({ projectRootId: entry.projectRootId, label: entry.projectLabel });
  }
  if (projects.length === 0) {
    body.append(el("p", "cfg-empty", "No projects are registered yet — associations appear once a project is known."));
  }
  for (const project of projects) {
    const association = byProject.get(project.projectRootId);
    const line = el("div", "cfg-assoc-row");
    const label = el("span", "cfg-assoc-project", middleTruncate(project.label, 32));
    label.title = project.label;
    line.append(label);
    if (association !== undefined && association.pinned === true) {
      const locked = el("span", "cfg-assoc-locked");
      const runtime = current.runtimes.find((entry) => entry.runtimeId === association.runtimeId);
      locked.textContent = `🔒 ${runtime?.displayName ?? association.runtimeId}`;
      locked.title = `Pinned by ${association.source === "managed" ? "studio policy" : "you"}.`;
      line.append(locked, chip(association.source === "managed" ? "studio policy" : "personal", "cfg-micro"));
      body.append(line);
      continue;
    }
    const options = [
      { value: "", label: "default" },
      ...activeRuntimes(current).map((entry) => ({ value: entry.runtimeId, label: entry.displayName }))
    ];
    const select = selectField(options, association?.runtimeId ?? "", `Runtime for ${project.label}`, (next) => {
      if (next === "") {
        validationMutate({ type: "config.validation.clearAssociation", projectRootId: project.projectRootId }, `validation:assoc:${project.projectRootId}`);
        return;
      }
      validationMutate({ type: "config.validation.setAssociation", projectRootId: project.projectRootId, runtimeId: next }, `validation:assoc:${project.projectRootId}`);
    });
    if (association === undefined) select.classList.add("cfg-assoc-inherited");
    line.append(select);
    body.append(line);
  }
  wrap.append(body);
  return wrap;
}

/** Topology + warm cap, both honest about a studio pin sitting above them. */
function validationSettingsRows(current: ValidationConfigState): Row[] {
  const rows: Row[] = [];
  const pin = current.managed?.topologyPin;
  const topologyChips: HTMLElement[] = [];
  if (pin !== undefined) {
    const locked = chip("pinned by studio policy", "cfg-lock");
    locked.title = "Managed policy fixes the topology for this machine.";
    topologyChips.push(locked);
  }
  topologyChips.push(...noteChips("validation:settings"));
  const selectedPreset = pin ?? current.settings.topologyPreset;
  const topologyOptions = TOPOLOGY_OPTIONS.map((entry) => ({ value: entry.value as string, label: entry.label }));
  // A preset this build does not know still renders as itself rather than
  // silently reading as "single".
  if (!topologyOptions.some((entry) => entry.value === selectedPreset)) {
    topologyOptions.unshift({ value: selectedPreset, label: selectedPreset });
  }
  const topology = selectField(
    topologyOptions,
    selectedPreset,
    "Topology preset",
    (next) => { validationMutate({ type: "config.validation.setSettings", topologyPreset: next as ValidationTopologyPreset }, "validation:settings"); }
  );
  if (pin !== undefined) topology.disabled = true;
  rows.push({
    search: "topology preset single default named per project validation",
    node: row({
      title: "Topology",
      detail: "A starting configuration over one model: named runtimes, a cascade, and one default. Changing it never moves a running job.",
      chips: topologyChips,
      control: topology
    })
  });

  const studioCap = current.managed?.warmCap;
  const mine = current.settings.personalWarmCap ?? current.settings.warmCap;
  const effective = studioCap === undefined
    ? mine
    : mine === undefined ? studioCap : Math.min(mine, studioCap);
  const capChips: HTMLElement[] = [];
  if (studioCap !== undefined) {
    const capChip = chip(`studio cap ${String(studioCap)}`, "cfg-lock");
    capChip.title = "Managed policy caps concurrent warm runtimes; the lower of the two applies.";
    capChips.push(capChip);
  }
  capChips.push(...noteChips("validation:warmcap"));
  rows.push({
    search: "warm cap concurrent runtimes ram budget validation",
    node: row({
      title: "Warm runtimes at once",
      detail: effective === undefined
        ? "No cap. Runtimes past your RAM budget queue behind a boot instead of thrashing."
        : `Effective cap: ${String(effective)}. Extra runtimes start on demand and report the boot as queue state.`,
      chips: capChips,
      control: textField(mine === undefined ? "" : String(mine), { kind: "number", label: "Warm cap", min: 0, max: MAX_VALIDATION_WARM_CAP, step: 1 }, (next) => {
        const trimmed = next.trim();
        if (trimmed.length === 0) {
          validationMutate({ type: "config.validation.setSettings", warmCap: null }, "validation:warmcap");
          return;
        }
        const parsed = Number(trimmed);
        // A runtime count: 3.5 warm runtimes is meaningless, not just unusual.
        // The ceiling mirrors the boundary parser's own cap - past it the host
        // would silently drop the message, so refuse it here instead.
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_VALIDATION_WARM_CAP) return;
        validationMutate({ type: "config.validation.setSettings", warmCap: parsed }, "validation:warmcap");
      })
    })
  });
  return rows;
}

function validationRows(): Row[] {
  const current = validation;
  if (current === null) {
    return [{
      search: "validation runtimes",
      node: row({
        title: "Validation runtimes",
        detail: validationNotice ?? "Reading validation runtimes…",
        className: "cfg-row-readonly"
      })
    }];
  }
  // A host without Hyper-V gets ONE calm line and nothing else to read.
  if (current.hostSupported === false) {
    return [{
      search: "validation runtimes windows hyper-v",
      node: el("p", "cfg-empty", "Validation runtimes need a Windows host with Hyper-V.")
    }];
  }
  const rows: Row[] = [];
  if (current.quarantines.length > 0) {
    rows.push({ search: "quarantine validation runtime blocked isolation", node: quarantineBanner(current) });
  }
  const list = el("div", "cfg-vr-list");
  for (const runtime of current.runtimes) list.append(validationRuntimeRow(current, runtime));
  if (current.runtimes.length === 0) {
    list.append(el("p", "cfg-empty", "No runtimes yet. The first one you add becomes the default."));
  }
  rows.push({
    search: `validation runtimes ${current.runtimes.map((entry) => `${entry.displayName} ${entry.image} ${entry.policyProfileRef}`).join(" ")}`,
    node: list
  });
  rows.push({ search: "add validation runtime create named", node: validationCreateFold(current) });
  rows.push({
    search: `association editor project runtime ${current.projects.map((entry) => entry.label).join(" ")}`,
    node: row({
      title: "Project associations",
      detail: "Resolution per job: chat or task override → this table → the default. A project with no row simply uses the default.",
      below: validationAssociations(current)
    })
  });
  rows.push(...validationSettingsRows(current));
  return rows;
}

/** Every section's rows, plus the extras that are not searchable rows. */
function sectionRows(current: ConfigState, target: Section): Row[] {
  switch (target) {
    case "providers": return providerRows(current);
    case "mcp": return mcpRows(current);
    case "models": return modelSectionRows(current);
    case "preprompts": return prepromptRows(current);
    case "recipes": return recipeSectionRows(current);
    case "memories": return memoryRows(current);
    case "runtime": return settingRows(settingsFor(current, "runtime"));
    case "validation": return validationRows();
    case "security": return settingRows(settingsFor(current, "security"));
  }
}

/** The dim sentence under a section heading; the section's whole promise. */
function sectionIntro(target: Section): string {
  switch (target) {
    case "providers": return "Where the models come from. Sign-in happens in a terminal so no credential passes through Drydock.";
    case "mcp": return "Extra tools agents can call. Servers run INSIDE the sandbox under the same no-egress policy as the agent, and changes apply on each chat's next turn.";
    case "models": return "The model a new chat starts on, per provider. Same value as the Providers cards.";
    case "preprompts": return "Standing instructions added to every session briefing.";
    case "recipes": return "Templates and planning aspects. Run a recipe from the Task Board; edit aspects in the Planner.";
    case "memories": return "What Drydock remembers between sessions: approved notes ride matching briefings by scope and tag. Agent proposals wait here for your review.";
    case "runtime": return "How Drydock runs its own tools on this machine.";
    case "validation": return "Where validation jobs run: named Windows runtimes, one default, and the project associations that route to them. Developers never need this page — their whole surface is the rail dot.";
    case "security": return "What AI may reach. These are the strongest guarantees Drydock makes; most take effect on the next window.";
  }
}

function sectionCount(current: ConfigState, target: Section): number | null {
  switch (target) {
    case "providers": return current.providers.length;
    case "mcp": return current.mcp.length;
    case "preprompts": return current.preprompts.length;
    case "recipes": return current.recipes.length + current.aspects.length;
    // The actionable number: proposals waiting for review, not the store size.
    case "memories": return pendingMemoryCount() > 0 ? pendingMemoryCount() : null;
    case "validation": return validation === null ? null : validation.runtimes.length;
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function topBar(current: ConfigState | null): HTMLElement {
  const bar = el("header", "cfg-top");
  bar.append(el("h1", "cfg-title", "Configure"));
  const controls = el("div", "cfg-top-controls");
  const segmented = el("div", "cfg-segmented");
  segmented.setAttribute("role", "group");
  segmented.setAttribute("aria-label", "Configuration scope");
  const projectLabel = current?.projectLabel;
  const scopes: { readonly value: ConfigScope; readonly label: string; readonly title: string }[] = [
    { value: "global", label: "Global", title: "Settings for this machine." },
    {
      value: "project",
      label: projectLabel ?? "Project",
      title: projectLabel === undefined
        ? "Open a folder to see its .drydock files."
        : `Machine settings merged with ${projectLabel}'s .drydock files.`
    }
  ];
  for (const option of scopes) {
    const node = button(
      `cfg-segment${scope === option.value ? " active" : ""}`,
      option.label,
      option.title,
      () => {
        if (scope === option.value) return;
        scope = option.value;
        persist();
        void load();
      }
    );
    node.setAttribute("aria-pressed", scope === option.value ? "true" : "false");
    if (option.value === "project" && projectLabel === undefined) node.disabled = true;
    segmented.append(node);
  }
  controls.append(segmented);

  const search = document.createElement("input");
  search.type = "search";
  search.className = "cfg-search";
  search.placeholder = "Search settings";
  search.value = query;
  search.setAttribute("aria-label", "Search every section");
  search.addEventListener("input", () => {
    query = search.value;
    renderContent();
  });
  controls.append(search);
  bar.append(controls);
  return bar;
}

function nav(current: ConfigState | null): HTMLElement {
  const list = el("nav", "cfg-nav");
  list.setAttribute("aria-label", "Configuration sections");
  const needsLogin = current?.providers.some((provider) => provider.authStatus === "needs-login") === true;
  for (const target of SECTIONS) {
    const node = button(
      `cfg-nav-item${section === target && query.trim().length === 0 ? " active" : ""}`,
      SECTION_LABELS[target],
      SECTION_LABELS[target],
      () => {
        section = target;
        query = "";
        persist();
        render();
      }
    );
    node.setAttribute("aria-current", section === target ? "true" : "false");
    if (target === "providers" && needsLogin) {
      const dot = el("span", "cfg-nav-dot");
      dot.title = "A provider still needs signing in.";
      node.append(dot);
    }
    if (target === "memories" && pendingMemoryCount() > 0) {
      const dot = el("span", "cfg-nav-dot");
      dot.title = "An agent's proposed memory is waiting for your review.";
      node.append(dot);
    }
    if (target === "validation" && validation !== null && validation.quarantines.length > 0) {
      const dot = el("span", "cfg-nav-dot");
      dot.title = "A validation runtime is quarantined and its queue is blocked.";
      node.append(dot);
    }
    const count = current === null ? null : sectionCount(current, target);
    if (count !== null && count > 0) node.append(el("span", "cfg-nav-count", String(count)));
    list.append(node);
  }
  return list;
}

const content = el("main", "cfg-content");

function renderContent(): void {
  content.replaceChildren();
  if (notice !== null) {
    const banner = el("div", "cfg-notice", notice);
    banner.setAttribute("role", "status");
    content.append(banner);
  }
  if (state === null) {
    content.append(el("p", "cfg-empty", booted
      ? "Configuration is unavailable in this window."
      : "Reading configuration…"));
    return;
  }
  const current = state;
  if (current.availability.available !== true && current.availability.reason !== undefined) {
    content.append(el("p", "cfg-notice", current.availability.reason));
  }
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length > 0) {
    renderSearch(current, trimmed);
    return;
  }
  content.append(el("h2", "cfg-section-title", SECTION_LABELS[section]));
  content.append(el("p", "cfg-section-intro", sectionIntro(section)));
  const rows = sectionRows(current, section);
  if (rows.length === 0) {
    content.append(el("p", "cfg-empty", emptyLabel(section, current)));
  } else {
    for (const entry of rows) content.append(entry.node);
  }
  if (section === "mcp") {
    content.append(mcpAddRow());
    content.append(el("p", "cfg-footnote",
      "MCP servers run inside the same sandbox as the agent, with the same network policy — Drydock never grants them a mount or an egress route of their own."));
  }
  if (section === "security") {
    content.append(el("p", "cfg-footnote",
      "Turning a protection off never applies retroactively: sessions already running keep the rules they started under."));
  }
  if (section === "runtime") {
    content.append(el("p", "cfg-footnote",
      "These variables are stored as ordinary VS Code settings, so keep secrets out of them — sign providers in on the Providers page instead."));
  }
  if (section === "memories") {
    content.append(el("p", "cfg-footnote",
      "Nothing an agent proposes becomes standing context until you approve it here. Memories live in Drydock's local store on this machine, never in the repository."));
  }
  if (section === "validation" && validation !== null && validation.hostSupported !== false) {
    content.append(el("p", "cfg-footnote",
      "Validation runtimes never reach production paths: fixtures are snapshots taken at approval, and a runtime that fails its isolation probes blocks its own queue rather than the fleet."));
  }
}

function emptyLabel(target: Section, current: ConfigState): string {
  switch (target) {
    case "mcp": return "No MCP servers yet. Add one below, or point drydock.mcp.configPath at an .mcp.json.";
    case "preprompts": return scope === "project" && current.projectLabel !== undefined
      ? "No standing instructions, and no CLAUDE.md / AGENTS.md in the open folders."
      : "No standing instructions file is configured.";
    case "recipes": return "No recipes or planning aspects yet.";
    case "providers": return "No providers are registered in this build.";
    case "validation": return "No validation runtimes yet. Add one below — the first becomes the default.";
    default: return "Nothing to configure here yet.";
  }
}

/** Search flattens every section into one grouped list. */
function renderSearch(current: ConfigState, trimmed: string): void {
  let matches = 0;
  for (const target of SECTIONS) {
    const hits = sectionRows(current, target).filter((entry) => entry.search.toLowerCase().includes(trimmed));
    if (hits.length === 0) continue;
    matches += hits.length;
    content.append(el("h2", "cfg-section-title cfg-search-group", SECTION_LABELS[target]));
    for (const entry of hits) content.append(entry.node);
  }
  if (matches === 0) content.append(el("p", "cfg-empty", `Nothing matches “${query.trim()}”.`));
}

function render(): void {
  root.replaceChildren();
  root.append(topBar(state));
  const body = el("div", "cfg-body");
  body.append(nav(state), content);
  root.append(body);
  renderContent();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const persisted = restore();
if (persisted.section !== undefined && (SECTIONS as readonly string[]).includes(persisted.section)) {
  section = persisted.section;
}
if (persisted.scope === "global" || persisted.scope === "project") scope = persisted.scope;

startMessaging();
onPush("config.changed", () => { scheduleRefresh(); });
// Validation pushes are not in PanelPushPayload until M7a lands; the cast is
// confined to this one subscribe helper. Both kinds mean the same thing here:
// the registry moved, refetch it.
function onValidationPush(type: "validation.changed" | "validation.quarantine", handler: () => void): void {
  onPush(type as never, handler as never);
}
onValidationPush("validation.changed", () => { scheduleRefresh(); });
onValidationPush("validation.quarantine", () => { scheduleRefresh(); });
// A new agent proposal lands in the approval list (and the nav count) live.
onPush("memory.candidateAdded", (payload) => {
  upsertMemoryCandidate(payload.candidate);
  render();
});
document.getElementById("app")?.append(root);
render();
void load();
