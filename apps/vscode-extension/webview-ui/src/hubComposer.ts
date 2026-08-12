/**
 * New-chat composer (UX overhaul, P4).
 *
 * The one form in the calm workbench, and it is built to not feel like one:
 * every field arrives prefilled with a faint provenance suffix that VANISHES
 * the moment you touch it, so the only required touch is the prompt. Start
 * transforms the card IN PLACE into an honest boot timeline driven by
 * `chat.bootProgress` pushes, then collapses to a one-line receipt. Plan first
 * carries the same brief into the Planner instead.
 *
 * The composer owns no protocol of its own: it posts the shipped
 * `chat.startSession` / `chat.sendTurn` / `planner.create` requests and reads
 * the catalogs `panel.init` already carries. Nothing here is hub-exclusive -
 * the rail's own composer starts the same chats (the solo-mode guarantee).
 *
 * SECURITY: every dynamic string (titles, model names, workspace names, error
 * text) reaches the DOM via textContent - never innerHTML - and every state cue
 * is a CLASS, because the hub's strict CSP has no 'unsafe-inline' for styles.
 */

import type {
  AgentModelCatalog,
  ChatSessionModeSelection,
  ChatSessionSummary,
  ChatWorkspaceSelection,
  HubState,
  PanelInitState,
  WorkspacePolicyState
} from "@drydock/contracts";
import { icon } from "./hubIcons.js";
import { request } from "./hubMessaging.js";

/** Boot stages the timeline can light; `mount` and `clone` are exclusive. */
type BootStage = "create" | "mount" | "clone" | "start";

type Phase = "closed" | "form" | "booting" | "queued" | "receipt" | "error";

const TITLE_MAX = 120;
const PROMPT_MAX = 20_000;

/** The three access modes, in the order the segmented control shows them. */
interface AccessMode {
  readonly value: ChatSessionModeSelection;
  readonly label: string;
  /** What choosing this actually does to the user's files - the whole point. */
  readonly consequence: string;
}

const ACCESS_MODES: readonly AccessMode[] = [
  {
    value: "implementation",
    label: "Mount",
    consequence: "The agent edits your files directly — changes land on disk as it works."
  },
  {
    value: "clone",
    label: "Clone",
    consequence: "The agent works in a private git clone — you pull the patch when it is done."
  },
  {
    value: "plan",
    label: "Read-only",
    consequence: "The agent can read your files but never write — answers and plans only."
  }
];

// ---------------------------------------------------------------------------
// Small DOM helpers (mirrors of the hub's own - this module imports no view)
// ---------------------------------------------------------------------------

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, label: string, title: string, run: () => void): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = label;
  node.title = title;
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    run();
  });
  return node;
}

/** "1.4s" under a minute, "2m 05s" beyond it - one compact token either way. */
function seconds(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  if (total < 60) return `${total.toFixed(1)}s`;
  const minutes = Math.floor(total / 60);
  return `${String(minutes)}m ${String(Math.floor(total % 60)).padStart(2, "0")}s`;
}

// ---------------------------------------------------------------------------
// Context the hub feeds in on every render
// ---------------------------------------------------------------------------

export interface ComposerContext {
  readonly taskId: string;
  readonly taskTitle: string;
  /** Chats already on this task: the `· chat <n>` title prefill counts from here. */
  readonly chatCount: number;
  readonly linkedWorkspaceSetIds: readonly string[];
  /** Provider/model of the task's most recent chat, when it has one. */
  readonly lastModel?: { readonly providerId: string; readonly model?: string };
}

export interface ComposerHost {
  /** Ask the hub to refetch (a chat was started, or a plan was created). */
  readonly refresh: () => void;
  /** Focus a session in whichever chat surface is listening. */
  readonly openChat: (sessionId: string) => void;
  /** Open a Drydock surface (used for the plan-first hand-off). */
  readonly openPlanner: (taskId: string) => void;
}

export interface Composer {
  /** The stable node the hub appends; its contents are the composer's own. */
  readonly root: HTMLElement;
  /** Called on every hub render with fresh task data. */
  setContext(context: ComposerContext): void;
  /**
   * True while the card holds text or a live boot. The hub defers its debounced
   * refetch then: a full re-render would blow focus out of the textarea.
   */
  isBusy(): boolean;
  /** `chat.bootProgress` push relay. */
  onBootProgress(sessionId: string, stage: BootStage): void;
  /** `session.updated` push relay: the boot going live ends the timeline. */
  onSessionUpdated(session: ChatSessionSummary): void;
  /** `provider.models` push relay: fresher catalogs replace the composer's copy. */
  onProviderModels(catalogs: readonly AgentModelCatalog[]): void;
}

/** Draft kept across collapse/expand so Esc never costs anything typed. */
interface Draft {
  title: string;
  titleTouched: boolean;
  /** "auto" | "none" | "set:<id>" - the shipped workspace-picker vocabulary. */
  workspace: string;
  workspaceTouched: boolean;
  mode: ChatSessionModeSelection;
  /** Index into the flattened model list, or -1 for "not chosen yet". */
  modelIndex: number;
  modelTouched: boolean;
  prompt: string;
}

interface ModelOption {
  readonly providerId: string;
  readonly providerName: string;
  readonly model?: string;
  readonly label: string;
}

interface StageMark {
  readonly stage: BootStage;
  readonly at: number;
}

export function createComposer(host: ComposerHost): Composer {
  const root = el("section", "hub-composer");

  let context: ComposerContext | null = null;
  let phase: Phase = "closed";
  let draft: Draft | null = null;
  let advancedOpen = false;
  let notice: string | null = null;

  // Host data, fetched once on first expand and reused after that.
  let catalogs: readonly AgentModelCatalog[] = [];
  let policy: WorkspacePolicyState | null = null;
  let openFolderNames: readonly string[] = [];
  let hostDataLoaded = false;
  let modelOptions: readonly ModelOption[] = [];

  // Boot timeline.
  let bootSessionId: string | null = null;
  let bootStartedAt = 0;
  let marks: StageMark[] = [];
  let tick: number | undefined;

  // Terminal states.
  let receipt: { readonly sessionId: string; readonly elapsedMs: number; readonly warning?: string } | null = null;
  let planReceipt = false;

  // -------------------------------------------------------------------------
  // Prefills
  // -------------------------------------------------------------------------

  function defaultTitle(): string {
    if (context === null) return "New chat";
    return `${context.taskTitle} · chat ${String(context.chatCount + 1)}`;
  }

  function defaultWorkspace(): string {
    const linked = context?.linkedWorkspaceSetIds ?? [];
    const known = new Set((policy?.workspaceSets ?? []).map((set) => set.workspaceSetId));
    const first = linked.find((id) => known.has(id));
    if (first !== undefined) return `set:${first}`;
    return openFolderNames.length > 0 ? "auto" : "none";
  }

  /** Clone-only policy is a hard rail: the other two modes are not offered. */
  function cloneOnly(): boolean {
    return policy?.security?.cloneOnly === true;
  }

  function defaultModelIndex(): number {
    if (modelOptions.length === 0) return -1;
    const last = context?.lastModel;
    if (last !== undefined) {
      const exact = modelOptions.findIndex(
        (option) => option.providerId === last.providerId && option.model === last.model
      );
      if (exact >= 0) return exact;
      const byProvider = modelOptions.findIndex((option) => option.providerId === last.providerId);
      if (byProvider >= 0) return byProvider;
    }
    return 0;
  }

  function freshDraft(): Draft {
    return {
      title: defaultTitle(),
      titleTouched: false,
      workspace: defaultWorkspace(),
      workspaceTouched: false,
      mode: cloneOnly() ? "clone" : "implementation",
      modelIndex: defaultModelIndex(),
      modelTouched: false,
      prompt: ""
    };
  }

  /** Untouched prefills follow the task; anything the user typed is theirs. */
  function reconcileDraft(): void {
    if (draft === null) return;
    if (!draft.titleTouched) draft.title = defaultTitle();
    if (!draft.workspaceTouched) draft.workspace = defaultWorkspace();
    if (!draft.modelTouched) draft.modelIndex = defaultModelIndex();
    if (cloneOnly()) draft.mode = "clone";
  }

  function flattenCatalogs(): ModelOption[] {
    const options: ModelOption[] = [];
    for (const catalog of catalogs) {
      const models = catalog.models.filter((model) => !model.hidden);
      if (models.length === 0) {
        // Native CLIs have their own default model, so an undiscovered native
        // provider is still startable. A rider without a discovered model
        // cannot run a turn (the adapter refuses honestly) - omit it here.
        if (catalog.providerId === "codex" || catalog.providerId === "claude") {
          options.push({ providerId: catalog.providerId, providerName: catalog.displayName, label: "provider default" });
        }
        continue;
      }
      for (const model of models) {
        options.push({
          providerId: catalog.providerId,
          providerName: catalog.displayName,
          model: model.id,
          label: model.displayName
        });
      }
    }
    return options;
  }

  /** One choke point for catalog data, whatever host message carried it. */
  function applyCatalogs(incoming: readonly AgentModelCatalog[]): void {
    catalogs = incoming;
    modelOptions = flattenCatalogs();
    reconcileDraft();
    // The catalogs can land while the user is already typing: repaint without
    // stealing the caret back.
    renderKeepingCaret();
  }

  /** Catalogs + workspace policy, fetched lazily so hub boot pays nothing. */
  async function loadHostData(): Promise<void> {
    if (hostDataLoaded) return;
    hostDataLoaded = true;
    const [initResponse, workspaceResponse] = await Promise.all([
      request({ type: "panel.init" }),
      request({ type: "workspace.state" })
    ]);
    if (initResponse.ok && initResponse.payload.type === "panel.init") {
      const init: PanelInitState = initResponse.payload.state;
      openFolderNames = init.openFolderNames;
      applyCatalogs(init.providerCatalogs);
    }
    if (workspaceResponse.ok && workspaceResponse.payload.type === "workspace.state") {
      policy = workspaceResponse.payload.state;
    }
    reconcileDraft();
    renderKeepingCaret();
  }

  /** A re-render that returns the caret to the prompt if it was already there. */
  function renderKeepingCaret(): void {
    const before = root.querySelector(".hub-composer-prompt");
    const focused = before instanceof HTMLTextAreaElement && document.activeElement === before;
    const caret = focused ? before.selectionStart : 0;
    render();
    if (!focused) return;
    const after = root.querySelector(".hub-composer-prompt");
    if (!(after instanceof HTMLTextAreaElement)) return;
    after.focus();
    after.setSelectionRange(caret, caret);
  }

  // -------------------------------------------------------------------------
  // Phase transitions
  // -------------------------------------------------------------------------

  function open(): void {
    if (phase === "booting" || phase === "queued") return;
    phase = "form";
    notice = null;
    receipt = null;
    planReceipt = false;
    draft ??= freshDraft();
    reconcileDraft();
    render();
    void loadHostData();
    focusPrompt();
  }

  /** Esc: fold the card away but keep every character typed. */
  function collapse(): void {
    if (phase === "booting" || phase === "queued") return;
    phase = "closed";
    notice = null;
    render();
    host.refresh();
  }

  function focusPrompt(): void {
    const field = root.querySelector(".hub-composer-prompt");
    if (field instanceof HTMLTextAreaElement) {
      field.focus();
      // Caret at the end: a restored draft resumes where it was left.
      field.setSelectionRange(field.value.length, field.value.length);
    }
  }

  function stopTicking(): void {
    if (tick === undefined) return;
    window.clearInterval(tick);
    tick = undefined;
  }

  function startTicking(): void {
    if (tick !== undefined) return;
    tick = window.setInterval(() => {
      if (phase !== "booting") {
        stopTicking();
        return;
      }
      render();
    }, 1000);
  }

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  function workspaceSelection(): ChatWorkspaceSelection | undefined {
    if (draft === null) return undefined;
    if (draft.workspace === "none") return undefined;
    if (draft.workspace.startsWith("set:")) {
      return { workspaceSetId: draft.workspace.slice(4), mode: draft.mode };
    }
    return { auto: true, mode: draft.mode };
  }

  function modelSelection(): { readonly providerId: string; readonly model?: string } {
    const chosen = draft === null ? undefined : modelOptions[draft.modelIndex];
    if (chosen === undefined) {
      // No catalog yet (offline host, first boot): the service normalizes an
      // unqualified selection to its default provider rather than refusing.
      return { providerId: context?.lastModel?.providerId ?? "codex" };
    }
    return { providerId: chosen.providerId, ...(chosen.model === undefined ? {} : { model: chosen.model }) };
  }

  async function start(): Promise<void> {
    if (draft === null || context === null) return;
    const prompt = draft.prompt.trim();
    if (prompt.length === 0) {
      notice = "A chat needs a prompt.";
      render();
      focusPrompt();
      return;
    }
    // Capture every choice synchronously: pushes can refetch the task under us
    // while the boot is in flight, and the session must use what was pressed.
    const title = draft.title.trim().slice(0, TITLE_MAX);
    const model = modelSelection();
    const workspace = workspaceSelection();
    const taskId = context.taskId;

    phase = "booting";
    notice = null;
    bootSessionId = null;
    bootStartedAt = Date.now();
    marks = [];
    render();
    startTicking();

    const response = await request({
      type: "chat.startSession",
      model,
      taskId,
      ...(title.length === 0 ? {} : { title }),
      ...(workspace === undefined ? {} : { workspace })
    });
    stopTicking();
    if (!response.ok || response.payload.type !== "chat.startSession") {
      phase = "error";
      notice = response.ok
        ? "The host answered the start with something unexpected."
        : response.error.message;
      render();
      return;
    }
    const session = response.payload.session;
    // The start response rides back the freshest catalogs (the session's own
    // backend just listed its models) - fold them in rather than discarding.
    applyCatalogs(response.payload.providerCatalogs);
    bootSessionId = session.sessionId;
    // The orchestrator can hold a start behind the run-slot budget. The summary
    // carries no queue position today, so the row states the fact without one.
    if (session.status === "queued") {
      phase = "queued";
      render();
      host.refresh();
      return;
    }
    // The session is live; the prompt is a normal turn on it.
    const turn = await request({ type: "chat.sendTurn", sessionId: session.sessionId, prompt, model });
    const elapsedMs = Date.now() - bootStartedAt;
    receipt = {
      sessionId: session.sessionId,
      elapsedMs,
      ...(turn.ok ? {} : { warning: `Started, but the first message did not send: ${turn.error.message}` })
    };
    phase = "receipt";
    // The draft has been spent; the next New chat starts clean.
    draft = null;
    render();
    host.refresh();
  }

  /** Plan first: the same brief, carried into the Planner instead of an agent. */
  async function planFirst(): Promise<void> {
    if (draft === null || context === null) return;
    const brief = draft.prompt.trim();
    if (brief.length === 0) {
      notice = "A plan needs a brief — write the prompt first.";
      render();
      focusPrompt();
      return;
    }
    const title = draft.title.trim().slice(0, TITLE_MAX);
    const taskId = context.taskId;
    const response = await request({
      type: "planner.create",
      brief,
      // Aspects and context roots are the Planner's own intake; the composer
      // hands over a draft rather than pretending to make those choices.
      aspectIds: [],
      contextRoots: [],
      ...(title.length === 0 ? {} : { title }),
      taskId
    });
    if (!response.ok || response.payload.type !== "planner.create") {
      phase = "error";
      notice = response.ok ? "The host answered the plan with something unexpected." : response.error.message;
      render();
      return;
    }
    planReceipt = true;
    phase = "receipt";
    draft = null;
    render();
    host.refresh();
    host.openPlanner(taskId);
  }

  /** Retry after a failure: the form comes back exactly as it was submitted. */
  function retry(): void {
    phase = "form";
    notice = null;
    render();
    focusPrompt();
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  function render(): void {
    switch (phase) {
      case "closed":
        root.replaceChildren(buildTrigger());
        return;
      case "form":
        root.replaceChildren(buildForm());
        return;
      case "booting":
        root.replaceChildren(buildTimeline());
        return;
      case "queued":
        root.replaceChildren(buildQueued());
        return;
      case "receipt":
        root.replaceChildren(buildReceipt());
        return;
      case "error":
        root.replaceChildren(buildError());
        return;
    }
  }

  function buildTrigger(): HTMLElement {
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "hub-newchat";
    trigger.append(icon("plus"), el("span", undefined, "New chat"));
    trigger.title = "Start a chat on this task";
    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      open();
    });
    return trigger;
  }

  /** A faint "· from task" style suffix that disappears once the field is touched. */
  function provenance(text: string, touched: boolean): HTMLElement | null {
    return touched ? null : el("span", "hub-composer-prov", `· ${text}`);
  }

  function field(label: string, control: HTMLElement, hint: HTMLElement | null): HTMLElement {
    const row = el("div", "hub-composer-field");
    const head = el("label", "hub-composer-label", label);
    if (control.id !== "") head.setAttribute("for", control.id);
    row.append(head);
    const line = el("div", "hub-composer-control");
    line.append(control);
    if (hint !== null) line.append(hint);
    row.append(line);
    return row;
  }

  function buildForm(): HTMLElement {
    const current = draft ?? freshDraft();
    draft = current;
    const card = el("div", "hub-composer-card");

    // Esc folds the card (keeping the draft); Ctrl/Cmd+Enter starts.
    card.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        collapse();
        return;
      }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        event.stopPropagation();
        void start();
      }
    });

    // --- title ---------------------------------------------------------------
    const title = document.createElement("input");
    title.id = "hub-composer-title";
    title.className = "hub-composer-input";
    title.type = "text";
    title.maxLength = TITLE_MAX;
    title.value = current.title;
    title.addEventListener("input", () => {
      current.title = title.value;
      current.titleTouched = true;
      dropProvenance(title);
    });
    card.append(field("Title", title, provenance("from task", current.titleTouched)));

    // --- workspace -----------------------------------------------------------
    const workspace = document.createElement("select");
    workspace.id = "hub-composer-workspace";
    workspace.className = "hub-composer-select";
    const linked = new Set(context?.linkedWorkspaceSetIds ?? []);
    const sets = [...(policy?.workspaceSets ?? [])].sort((a, b) => {
      const aLinked = linked.has(a.workspaceSetId) ? 0 : 1;
      const bLinked = linked.has(b.workspaceSetId) ? 0 : 1;
      return aLinked - bLinked;
    });
    for (const set of sets) {
      const option = document.createElement("option");
      option.value = `set:${set.workspaceSetId}`;
      option.textContent = linked.has(set.workspaceSetId) ? `${set.name} (task set)` : set.name;
      workspace.append(option);
    }
    if (openFolderNames.length > 0) {
      const option = document.createElement("option");
      option.value = "auto";
      option.textContent = `Open folders: ${openFolderNames.join(", ")}`;
      workspace.append(option);
    }
    const noneOption = document.createElement("option");
    noneOption.value = "none";
    noneOption.textContent = "No workspace";
    workspace.append(noneOption);
    workspace.value = [...workspace.options].some((option) => option.value === current.workspace)
      ? current.workspace
      : "none";
    current.workspace = workspace.value;
    const fromTask = current.workspace.startsWith("set:") && linked.has(current.workspace.slice(4));
    card.append(field(
      "Workspace",
      workspace,
      provenance(fromTask ? "from task" : "this window", current.workspaceTouched)
    ));

    // --- access --------------------------------------------------------------
    // With no workspace there is nothing to grant access to, so the row hides
    // rather than offering a choice with no consequence.
    const access = buildAccess(current);
    access.classList.toggle("hidden", current.workspace === "none");
    card.append(access);
    workspace.addEventListener("change", () => {
      current.workspace = workspace.value;
      current.workspaceTouched = true;
      dropProvenance(workspace);
      access.classList.toggle("hidden", current.workspace === "none");
    });

    // --- model ---------------------------------------------------------------
    const model = document.createElement("select");
    model.id = "hub-composer-model";
    model.className = "hub-composer-select";
    let group: HTMLOptGroupElement | null = null;
    modelOptions.forEach((option, index) => {
      if (group === null || group.label !== option.providerName) {
        group = document.createElement("optgroup");
        group.label = option.providerName;
        model.append(group);
      }
      const node = document.createElement("option");
      node.value = String(index);
      node.textContent = option.label;
      group.append(node);
    });
    if (modelOptions.length === 0) {
      const node = document.createElement("option");
      node.value = "-1";
      node.textContent = catalogs.length === 0 ? "Loading models…" : "No models discovered";
      model.append(node);
    }
    // Requery entry point, in the dropdown itself: picking it forces the host
    // past its TTL and re-runs every provider's live discovery.
    const refreshOption = document.createElement("option");
    refreshOption.value = "refresh";
    refreshOption.textContent = "↻ Refresh model list…";
    model.append(refreshOption);
    model.value = String(current.modelIndex);
    model.addEventListener("change", () => {
      if (model.value === "refresh") {
        model.value = String(current.modelIndex);
        void request({ type: "provider.list", force: true }).then((response) => {
          if (response.ok && response.payload.type === "provider.list") {
            applyCatalogs(response.payload.providerCatalogs);
          }
        });
        return;
      }
      current.modelIndex = Number.parseInt(model.value, 10);
      current.modelTouched = true;
      dropProvenance(model);
    });
    const modelProvenance = context?.lastModel === undefined ? "default" : "last used";
    card.append(field("Model", model, provenance(modelProvenance, current.modelTouched)));

    // --- prompt --------------------------------------------------------------
    const prompt = document.createElement("textarea");
    prompt.id = "hub-composer-prompt";
    prompt.className = "hub-composer-prompt";
    prompt.rows = 4;
    prompt.maxLength = PROMPT_MAX;
    prompt.placeholder = "What should the agent do?";
    prompt.value = current.prompt;
    prompt.addEventListener("input", () => {
      current.prompt = prompt.value;
    });
    const promptField = el("div", "hub-composer-field");
    const promptLabel = el("label", "hub-composer-label", "Prompt");
    promptLabel.setAttribute("for", prompt.id);
    promptField.append(promptLabel, prompt);
    card.append(promptField);

    // --- advanced ------------------------------------------------------------
    card.append(buildAdvanced());

    if (notice !== null) card.append(el("p", "hub-composer-notice", notice));

    // --- actions -------------------------------------------------------------
    const actions = el("div", "hub-composer-actions");
    actions.append(
      button("hub-composer-start", "Start chat", "Start this chat (Ctrl+Enter)", () => void start()),
      button("hub-composer-ghost", "Plan first", "Draft a plan from this brief instead", () => void planFirst()),
      button("hub-composer-ghost quiet", "Cancel", "Close the composer (Esc); the draft is kept", collapse)
    );
    card.append(actions);
    return card;
  }

  /** Retires one field's provenance suffix without re-rendering (focus stays put). */
  function dropProvenance(control: HTMLElement): void {
    control.parentElement?.querySelector(".hub-composer-prov")?.remove();
  }

  /**
   * The access choice, stated by its CONSEQUENCE rather than its mechanism -
   * the one place the composer refuses to be terse. Selection updates in place
   * so the pressed segment keeps the keyboard.
   */
  function buildAccess(current: Draft): HTMLElement {
    const row = el("div", "hub-composer-field");
    row.append(el("span", "hub-composer-label", "Access"));
    const segmented = el("div", "hub-segmented");
    const consequence = el("p", "hub-composer-consequence");
    const locked = cloneOnly();
    const buttons: { readonly node: HTMLButtonElement; readonly mode: AccessMode }[] = [];
    const paint = (): void => {
      for (const entry of buttons) {
        entry.node.className = entry.mode.value === current.mode ? "hub-segment on" : "hub-segment";
        entry.node.setAttribute("aria-pressed", entry.mode.value === current.mode ? "true" : "false");
      }
      consequence.textContent = ACCESS_MODES.find((mode) => mode.value === current.mode)?.consequence ?? "";
    };
    for (const mode of ACCESS_MODES) {
      const disabled = locked && mode.value !== "clone";
      const node = document.createElement("button");
      node.type = "button";
      node.className = "hub-segment";
      node.textContent = mode.label;
      node.disabled = disabled;
      node.title = disabled ? "This machine's policy allows clone mode only." : mode.consequence;
      node.addEventListener("click", (event) => {
        event.stopPropagation();
        current.mode = mode.value;
        paint();
      });
      buttons.push({ node, mode });
      segmented.append(node);
    }
    row.append(segmented, consequence);
    if (locked) {
      row.append(el("p", "hub-composer-consequence policy", "This machine's policy allows clone mode only."));
    }
    paint();
    return row;
  }

  /**
   * The fold is deliberately thin: verify mode, env overrides and a briefing
   * dry-run have no request that can carry them yet, and the composer does not
   * invent contracts. It says so rather than showing controls that lie.
   */
  function buildAdvanced(): HTMLElement {
    const details = document.createElement("details");
    details.className = "hub-composer-advanced";
    details.open = advancedOpen;
    details.addEventListener("toggle", () => {
      advancedOpen = details.open;
    });
    const summary = document.createElement("summary");
    summary.textContent = "Advanced";
    const row = el("p", "hub-composer-advanced-row", "Briefing preview (coming later)");
    details.append(summary, row);
    return details;
  }

  // --- boot timeline ---------------------------------------------------------

  /** Which middle stage this boot expects; the other one never lights. */
  function middleStage(): BootStage {
    return draft?.mode === "clone" ? "clone" : "mount";
  }

  function markFor(stage: BootStage): StageMark | undefined {
    return marks.find((mark) => mark.stage === stage);
  }

  function buildTimeline(): HTMLElement {
    const card = el("div", "hub-composer-card booting");
    card.append(el("p", "hub-composer-boot-title", "Starting the chat…"));
    const list = el("div", "hub-composer-stages");
    const planned: readonly { readonly stage: BootStage; readonly label: string }[] = [
      { stage: "create", label: "Disposable workspace" },
      { stage: middleStage(), label: middleStage() === "clone" ? "Cloning repositories" : "Mounting your folders" },
      { stage: "start", label: "Starting the agent backend" }
    ];
    const lastMark = marks[marks.length - 1];
    for (const entry of planned) {
      const mark = markFor(entry.stage);
      const isCurrent = mark !== undefined && lastMark?.stage === entry.stage;
      const row = el("div", mark === undefined
        ? "hub-stage pending"
        : isCurrent ? "hub-stage current" : "hub-stage done");
      row.append(el("span", "hub-stage-dot"));
      row.append(el("span", "hub-stage-label", entry.label));
      if (mark !== undefined) {
        const next = marks[marks.indexOf(mark) + 1];
        const until = next === undefined ? Date.now() : next.at;
        row.append(el("span", "hub-stage-time", seconds(until - mark.at)));
      }
      list.append(row);
    }
    card.append(list);
    card.append(el("p", "hub-composer-boot-total", seconds(Date.now() - bootStartedAt)));
    return card;
  }

  function buildQueued(): HTMLElement {
    const card = el("div", "hub-composer-card");
    const row = el("p", "hub-composer-queued", "⏸ Queued — starts automatically");
    card.append(row);
    return card;
  }

  function buildReceipt(): HTMLElement {
    const row = el("div", "hub-composer-receipt");
    if (planReceipt) {
      row.append(el("span", "hub-composer-tick", "✓"));
      row.append(el("span", undefined, "Plan created — continue in Planner"));
      row.append(button("hub-composer-link", "↗", "Open the Planner", () => {
        if (context !== null) host.openPlanner(context.taskId);
      }));
      row.append(button("hub-composer-link", "New chat", "Start another chat", open));
      return row;
    }
    const done = receipt;
    if (done === null) return buildTrigger();
    row.append(el("span", "hub-composer-tick", "✓"));
    row.append(el("span", undefined, `Chat started · ${seconds(done.elapsedMs)}`));
    row.append(button("hub-composer-link", "Open ↗", "Open this chat", () => host.openChat(done.sessionId)));
    row.append(button("hub-composer-link", "New chat", "Start another chat", open));
    if (done.warning !== undefined) {
      const wrap = el("div", "hub-composer-receipt-wrap");
      wrap.append(row, el("p", "hub-composer-notice", done.warning));
      return wrap;
    }
    return row;
  }

  function buildError(): HTMLElement {
    const card = el("div", "hub-composer-card failed");
    card.append(el("p", "hub-composer-notice", notice ?? "The chat could not be started."));
    if (marks.length > 0) {
      card.append(el("p", "hub-composer-consequence", "It may still be starting — check the Chats list above."));
    }
    const actions = el("div", "hub-composer-actions");
    actions.append(
      button("hub-composer-start", "Retry", "Try starting this chat again", retry),
      button("hub-composer-ghost quiet", "Dismiss", "Close the composer", collapse)
    );
    card.append(actions);
    return card;
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  render();

  return {
    root,
    setContext(next: ComposerContext): void {
      context = next;
      reconcileDraft();
      if (phase === "closed") render();
    },
    isBusy(): boolean {
      if (phase === "booting" || phase === "queued") return true;
      if (phase !== "form") return false;
      // An open-but-idle form must not freeze the hub's other cards, so only a
      // form the user is actually in (focus inside it, or text already typed)
      // holds refreshes back.
      const active = document.activeElement;
      if (active !== null && root.contains(active)) return true;
      return draft !== null && (draft.prompt.length > 0 || draft.titleTouched);
    },
    onBootProgress(sessionId: string, stage: BootStage): void {
      if (phase !== "booting") return;
      // Until the start response lands the composer does not know its own
      // session id; the boot it just asked for is the one in flight, so the
      // first id seen is adopted and corrected from the response if it differs.
      bootSessionId ??= sessionId;
      if (sessionId !== bootSessionId) return;
      if (marks.some((mark) => mark.stage === stage)) return;
      marks = [...marks, { stage, at: Date.now() }];
      render();
    },
    onSessionUpdated(session: ChatSessionSummary): void {
      if (phase !== "queued" || session.sessionId !== bootSessionId) return;
      if (session.status === "queued") return;
      // The queue released it: collapse to the same receipt a direct start gets.
      receipt = { sessionId: session.sessionId, elapsedMs: Date.now() - bootStartedAt };
      phase = "receipt";
      render();
      host.refresh();
    },
    onProviderModels(incoming: readonly AgentModelCatalog[]): void {
      // Ignore pushes until the first load: applyCatalogs would repaint a card
      // that has never fetched its workspace policy half.
      if (!hostDataLoaded) return;
      applyCatalogs(incoming);
    }
  };
}

/** Composer context from one hub state read - the hub owns no prefill logic. */
export function composerContextFor(state: HubState): ComposerContext {
  const newest = [...state.chats].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
  return {
    taskId: state.task.taskId,
    taskTitle: state.task.title,
    chatCount: state.chats.length,
    linkedWorkspaceSetIds: state.task.linkedWorkspaceSetIds,
    ...(newest === undefined
      ? {}
      : {
        lastModel: {
          providerId: newest.providerId,
          ...(newest.model === undefined ? {} : { model: newest.model })
        }
      })
  };
}
