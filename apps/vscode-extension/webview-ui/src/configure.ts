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

/** How long a row says "saved" before returning to its resting state. */
const SAVED_NOTE_MS = 1_600;
/** Settings changed elsewhere arrive as one push; refetch once. */
const REFRESH_DEBOUNCE_MS = 200;

const SECTION_LABELS: Record<ConfigSection, string> = {
  providers: "Providers",
  mcp: "MCP Servers",
  models: "Agents & Models",
  preprompts: "Preprompts",
  recipes: "Skills & Recipes",
  memories: "Memories",
  runtime: "Runtime",
  security: "Security"
};

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
let section: ConfigSection = "providers";
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

interface PersistedState {
  readonly section?: ConfigSection;
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

async function load(): Promise<void> {
  fetchToken += 1;
  const token = fetchToken;
  // Memories ride the same refresh: one failing half must not blank the other.
  const [response, memoryResponse] = await Promise.all([
    request({ type: "config.state", scope }),
    request({ type: "memory.list" })
  ]);
  if (token !== fetchToken) return;
  booted = true;
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

/** Every section's rows, plus the extras that are not searchable rows. */
function sectionRows(current: ConfigState, target: ConfigSection): Row[] {
  switch (target) {
    case "providers": return providerRows(current);
    case "mcp": return mcpRows(current);
    case "models": return modelSectionRows(current);
    case "preprompts": return prepromptRows(current);
    case "recipes": return recipeSectionRows(current);
    case "memories": return memoryRows(current);
    case "runtime": return settingRows(settingsFor(current, "runtime"));
    case "security": return settingRows(settingsFor(current, "security"));
  }
}

/** The dim sentence under a section heading; the section's whole promise. */
function sectionIntro(target: ConfigSection): string {
  switch (target) {
    case "providers": return "Where the models come from. Sign-in happens in a terminal so no credential passes through Drydock.";
    case "mcp": return "Extra tools agents can call. Servers run INSIDE the sandbox under the same no-egress policy as the agent, and changes apply on each chat's next turn.";
    case "models": return "The model a new chat starts on, per provider. Same value as the Providers cards.";
    case "preprompts": return "Standing instructions added to every session briefing.";
    case "recipes": return "Templates and planning aspects. Run a recipe from the Task Board; edit aspects in the Planner.";
    case "memories": return "What Drydock remembers between sessions: approved notes ride matching briefings by scope and tag. Agent proposals wait here for your review.";
    case "runtime": return "How Drydock runs its own tools on this machine.";
    case "security": return "What AI may reach. These are the strongest guarantees Drydock makes; most take effect on the next window.";
  }
}

function sectionCount(current: ConfigState, target: ConfigSection): number | null {
  switch (target) {
    case "providers": return current.providers.length;
    case "mcp": return current.mcp.length;
    case "preprompts": return current.preprompts.length;
    case "recipes": return current.recipes.length + current.aspects.length;
    // The actionable number: proposals waiting for review, not the store size.
    case "memories": return pendingMemoryCount() > 0 ? pendingMemoryCount() : null;
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
  for (const target of CONFIG_SECTIONS) {
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
}

function emptyLabel(target: ConfigSection, current: ConfigState): string {
  switch (target) {
    case "mcp": return "No MCP servers yet. Add one below, or point drydock.mcp.configPath at an .mcp.json.";
    case "preprompts": return scope === "project" && current.projectLabel !== undefined
      ? "No standing instructions, and no CLAUDE.md / AGENTS.md in the open folders."
      : "No standing instructions file is configured.";
    case "recipes": return "No recipes or planning aspects yet.";
    case "providers": return "No providers are registered in this build.";
    default: return "Nothing to configure here yet.";
  }
}

/** Search flattens every section into one grouped list. */
function renderSearch(current: ConfigState, trimmed: string): void {
  let matches = 0;
  for (const target of CONFIG_SECTIONS) {
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
if (persisted.section !== undefined && (CONFIG_SECTIONS as readonly string[]).includes(persisted.section)) {
  section = persisted.section;
}
if (persisted.scope === "global" || persisted.scope === "project") scope = persisted.scope;

startMessaging();
onPush("config.changed", () => { scheduleRefresh(); });
// A new agent proposal lands in the approval list (and the nav count) live.
onPush("memory.candidateAdded", (payload) => {
  upsertMemoryCandidate(payload.candidate);
  render();
});
document.getElementById("app")?.append(root);
render();
void load();
