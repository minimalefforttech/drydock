/**
 * Reusable, panel-local onboarding for Drydock webviews.
 *
 * The help experience has three layers:
 * - styled hover/focus tooltips for concise explanations;
 * - a non-blocking first-visit invitation;
 * - a help centre and spotlight tour for deeper orientation.
 *
 * All copy is rendered with textContent. Tour targets are resolved lazily so
 * panels that rebuild their DOM with replaceChildren remain safe to guide.
 */

export interface HelpPageSection {
  readonly title: string;
  readonly body: string;
  readonly bullets?: readonly string[];
}

export interface HelpPage {
  readonly id: string;
  readonly label: string;
  readonly title: string;
  readonly intro: string;
  readonly sections: readonly HelpPageSection[];
}

export interface HelpTourStep {
  readonly title: string;
  readonly body: string;
  readonly target: string | (() => HTMLElement | null);
  /** Used by cross-tab and multi-state tours to reveal the target before it is measured. */
  readonly prepare?: () => void | Promise<void>;
  /** Optional handoffs shown inside the step, used to continue into another panel's guide. */
  readonly actions?: readonly HelpTourAction[];
  /** Replaces Finish on the last step when the user may choose to stop without a handoff. */
  readonly nextLabel?: string;
}

export interface HelpTourAction {
  readonly label: string;
  readonly description: string;
  readonly run: () => void | Promise<void>;
}

export interface HelpExperienceConfig {
  readonly id: string;
  readonly title: string;
  readonly intro: string;
  readonly pages: readonly HelpPage[];
  readonly tour: readonly HelpTourStep[];
  readonly showWelcome?: boolean;
}

export interface HelpExperience {
  launcher(extraClass?: string): HTMLButtonElement;
  openGuide(pageId?: string): void;
  startTour(): void;
  destroy(): void;
}

interface PersistedHelpState {
  readonly welcomeDismissed?: boolean;
  readonly tourCompleted?: boolean;
}

const STORAGE_PREFIX = "drydock.help.v1.";
const TOOLTIP_ID = "drydock-help-tooltip";
let tooltipInstalled = false;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}

function action(label: string, className = ""): HTMLButtonElement {
  const value = node("button", `dd-help-action ${className}`.trim(), label);
  value.type = "button";
  return value;
}

function readState(id: string): PersistedHelpState {
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${id}`);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed as PersistedHelpState : {};
  } catch {
    return {};
  }
}

function writeState(id: string, state: PersistedHelpState): void {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${id}`, JSON.stringify(state));
  } catch {
    // Help stays fully usable when webview storage is unavailable; only the
    // first-visit invitation may return on the next panel open.
  }
}

/** Adds the shared styled tooltip affordance to any focusable or hoverable node. */
export function setHelpTooltip(target: HTMLElement, text: string): void {
  target.dataset["helpTooltip"] = text;
  target.setAttribute("aria-describedby", TOOLTIP_ID);
  installHelpTooltips();
}

function installHelpTooltips(): void {
  if (tooltipInstalled) return;
  tooltipInstalled = true;
  const tooltip = node("div", "dd-help-tooltip hidden");
  tooltip.id = TOOLTIP_ID;
  tooltip.setAttribute("role", "tooltip");
  document.body.append(tooltip);

  let current: HTMLElement | null = null;
  const findTarget = (value: EventTarget | null): HTMLElement | null =>
    value instanceof Element ? value.closest<HTMLElement>("[data-help-tooltip]") : null;

  const hide = (): void => {
    current = null;
    tooltip.classList.add("hidden");
  };
  const show = (target: HTMLElement): void => {
    const text = target.dataset["helpTooltip"];
    if (!text) return;
    current = target;
    tooltip.textContent = text;
    tooltip.classList.remove("hidden");
    positionTooltip(target, tooltip);
  };

  document.addEventListener("mouseover", (event) => {
    const target = findTarget(event.target);
    if (target !== null && target !== current) show(target);
  });
  document.addEventListener("mouseout", (event) => {
    if (current === null) return;
    const related = event.relatedTarget;
    if (related instanceof Node && current.contains(related)) return;
    const target = findTarget(event.target);
    if (target === current) hide();
  });
  document.addEventListener("focusin", (event) => {
    const target = findTarget(event.target);
    if (target !== null) show(target);
  });
  document.addEventListener("focusout", (event) => {
    if (findTarget(event.target) === current) hide();
  });
  window.addEventListener("scroll", () => {
    if (current !== null) positionTooltip(current, tooltip);
  }, true);
  window.addEventListener("resize", () => {
    if (current !== null) positionTooltip(current, tooltip);
  });
}

function positionTooltip(target: HTMLElement, tooltip: HTMLElement): void {
  const targetRect = target.getBoundingClientRect();
  const tipRect = tooltip.getBoundingClientRect();
  const gap = 8;
  const left = Math.min(
    window.innerWidth - tipRect.width - gap,
    Math.max(gap, targetRect.left + (targetRect.width - tipRect.width) / 2)
  );
  const above = targetRect.top - tipRect.height - gap;
  const top = above >= gap ? above : Math.min(window.innerHeight - tipRect.height - gap, targetRect.bottom + gap);
  tooltip.style.left = `${String(Math.round(left))}px`;
  tooltip.style.top = `${String(Math.round(Math.max(gap, top)))}px`;
}

export function createHelpExperience(config: HelpExperienceConfig): HelpExperience {
  installHelpTooltips();
  let state = readState(config.id);
  let selectedPageId = config.pages[0]?.id ?? "";
  let guideReturnFocus: HTMLElement | null = null;
  let welcome: HTMLElement | null = null;
  let tourIndex = -1;
  let tourTarget: HTMLElement | null = null;

  const guideOverlay = node("div", "dd-help-overlay hidden");
  const guide = node("section", "dd-help-centre");
  guide.setAttribute("role", "dialog");
  guide.setAttribute("aria-modal", "true");
  guide.setAttribute("aria-labelledby", `${config.id}-help-title`);
  guide.tabIndex = -1;
  guideOverlay.append(guide);
  document.body.append(guideOverlay);

  const masks = ["top", "right", "bottom", "left"].map((edge) => {
    const mask = node("div", "dd-tour-mask hidden");
    mask.dataset["edge"] = edge;
    document.body.append(mask);
    return mask;
  });
  const callout = node("section", "dd-tour-callout hidden");
  callout.setAttribute("role", "dialog");
  callout.setAttribute("aria-modal", "true");
  callout.setAttribute("aria-live", "polite");
  callout.tabIndex = -1;
  document.body.append(callout);

  const launcher = (extraClass = ""): HTMLButtonElement => {
    const button = node("button", `dd-help-launcher ${extraClass}`.trim(), "?");
    button.type = "button";
    button.setAttribute("aria-label", `Open ${config.title} help`);
    setHelpTooltip(button, "Open help pages and the guided tour.");
    button.addEventListener("click", () => openGuide());
    return button;
  };

  const dismissWelcome = (): void => {
    welcome?.remove();
    welcome = null;
    state = { ...state, welcomeDismissed: true };
    writeState(config.id, state);
  };

  const showWelcome = (): void => {
    if (welcome !== null || state.welcomeDismissed === true || config.showWelcome !== true) return;
    welcome = node("aside", "dd-help-welcome");
    welcome.setAttribute("aria-label", `${config.title} introduction`);
    welcome.append(
      node("div", "dd-help-eyebrow", "GETTING STARTED"),
      node("h2", "dd-help-welcome-title", config.title),
      node("p", "dd-help-welcome-copy", config.intro)
    );
    const actions = node("div", "dd-help-welcome-actions");
    const tour = action("Start guided tour", "primary");
    const browse = action("Open help");
    const later = action("Dismiss", "quiet");
    tour.addEventListener("click", () => {
      dismissWelcome();
      startTour();
    });
    browse.addEventListener("click", () => {
      dismissWelcome();
      openGuide();
    });
    later.addEventListener("click", dismissWelcome);
    actions.append(tour, browse, later);
    welcome.append(actions);
    document.body.append(welcome);
  };

  const closeGuide = (): void => {
    guideOverlay.classList.add("hidden");
    setBackgroundInert(false);
    document.removeEventListener("keydown", onGuideKeydown, true);
    guideReturnFocus?.focus();
    guideReturnFocus = null;
  };

  const onGuideKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeGuide();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...guide.querySelectorAll<HTMLElement>(
      "button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex='-1'])"
    )];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const renderGuide = (): void => {
    const selected = config.pages.find((page) => page.id === selectedPageId) ?? config.pages[0];
    guide.replaceChildren();

    const header = node("header", "dd-help-header");
    const headingWrap = node("div");
    headingWrap.append(
      node("div", "dd-help-eyebrow", "DRYDOCK HELP"),
      node("h1", "dd-help-title", config.title)
    );
    const heading = headingWrap.querySelector("h1");
    if (heading) heading.id = `${config.id}-help-title`;
    const close = action("Close", "icon");
    close.setAttribute("aria-label", "Close help");
    close.textContent = "×";
    close.addEventListener("click", closeGuide);
    header.append(headingWrap, close);

    const shell = node("div", "dd-help-shell");
    const nav = node("nav", "dd-help-nav");
    nav.setAttribute("aria-label", "Help topics");
    for (const page of config.pages) {
      const item = action(page.label, page.id === selected?.id ? "topic active" : "topic");
      item.setAttribute("aria-current", page.id === selected?.id ? "page" : "false");
      item.addEventListener("click", () => {
        selectedPageId = page.id;
        renderGuide();
        guide.querySelector<HTMLElement>(".dd-help-page")?.focus();
      });
      nav.append(item);
    }

    const pageBody = node("article", "dd-help-page");
    pageBody.tabIndex = -1;
    if (selected !== undefined) {
      pageBody.append(
        node("div", "dd-help-page-label", selected.label),
        node("h2", "dd-help-page-title", selected.title),
        node("p", "dd-help-page-intro", selected.intro)
      );
      const sectionGrid = node("div", "dd-help-section-grid");
      selected.sections.forEach((section, index) => {
        const card = node("section", "dd-help-section");
        const number = node("span", "dd-help-section-number", String(index + 1).padStart(2, "0"));
        const copy = node("div");
        copy.append(node("h3", "dd-help-section-title", section.title), node("p", "dd-help-section-copy", section.body));
        if (section.bullets !== undefined && section.bullets.length > 0) {
          const list = node("ul", "dd-help-list");
          for (const bullet of section.bullets) list.append(node("li", undefined, bullet));
          copy.append(list);
        }
        card.append(number, copy);
        sectionGrid.append(card);
      });
      pageBody.append(sectionGrid);
    }

    const footer = node("footer", "dd-help-footer");
    const tour = action(state.tourCompleted === true ? "Replay guided tour" : "Start guided tour", "primary");
    tour.addEventListener("click", startTour);
    const reset = action("Reset getting-started prompt", "quiet");
    reset.addEventListener("click", () => {
      state = {};
      writeState(config.id, state);
      closeGuide();
      window.setTimeout(showWelcome, 0);
    });
    footer.append(tour, reset);
    shell.append(nav, pageBody);
    guide.append(header, shell, footer);
  };

  const openGuide = (pageId?: string): void => {
    dismissWelcome();
    endTour(false);
    if (pageId !== undefined && config.pages.some((page) => page.id === pageId)) selectedPageId = pageId;
    guideReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    renderGuide();
    guideOverlay.classList.remove("hidden");
    setBackgroundInert(true);
    document.addEventListener("keydown", onGuideKeydown, true);
    guide.focus();
  };

  const resolveTarget = (step: HelpTourStep): HTMLElement | null =>
    typeof step.target === "string" ? document.querySelector<HTMLElement>(step.target) : step.target();

  const updateTourPosition = (): void => {
    if (tourTarget === null || tourIndex < 0) return;
    const rect = tourTarget.getBoundingClientRect();
    const gap = 6;
    const left = Math.max(0, rect.left - gap);
    const top = Math.max(0, rect.top - gap);
    const right = Math.min(window.innerWidth, rect.right + gap);
    const bottom = Math.min(window.innerHeight, rect.bottom + gap);
    const [topMask, rightMask, bottomMask, leftMask] = masks;
    if (!topMask || !rightMask || !bottomMask || !leftMask) return;

    setRect(topMask, 0, 0, window.innerWidth, top);
    setRect(rightMask, right, top, window.innerWidth - right, Math.max(0, bottom - top));
    setRect(bottomMask, 0, bottom, window.innerWidth, window.innerHeight - bottom);
    setRect(leftMask, 0, top, left, Math.max(0, bottom - top));

    const calloutRect = callout.getBoundingClientRect();
    const horizontal = Math.min(
      window.innerWidth - calloutRect.width - 12,
      Math.max(12, left + (right - left - calloutRect.width) / 2)
    );
    const below = bottom + 12;
    const vertical = below + calloutRect.height <= window.innerHeight - 12
      ? below
      : Math.max(12, top - calloutRect.height - 12);
    callout.style.left = `${String(Math.round(horizontal))}px`;
    callout.style.top = `${String(Math.round(vertical))}px`;
  };

  const renderTourStep = (index: number): void => {
    const step = config.tour[index];
    if (step === undefined) {
      endTour(true);
      return;
    }
    tourIndex = index;
    const presentStep = (): void => {
      window.setTimeout(() => {
        if (tourIndex !== index) return;
        tourTarget?.classList.remove("dd-tour-target");
        tourTarget = resolveTarget(step) ?? document.querySelector<HTMLElement>(".dd-help-launcher") ?? document.body;
        tourTarget.classList.add("dd-tour-target");
        tourTarget.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });

        callout.replaceChildren();
        callout.classList.toggle("with-actions", step.actions !== undefined && step.actions.length > 0);
        const progress = node("div", "dd-tour-progress");
        progress.append(
          node("span", "dd-help-eyebrow", `QUICK TOUR · ${String(index + 1)} OF ${String(config.tour.length)}`),
          node("span", "dd-tour-dots", config.tour.map((_, dot) => dot === index ? "●" : "○").join(" "))
        );
        callout.append(progress, node("h2", "dd-tour-title", step.title), node("p", "dd-tour-copy", step.body));
        if (step.actions !== undefined && step.actions.length > 0) {
          const handoffs = node("div", "dd-tour-handoffs");
          const error = node("div", "dd-tour-action-error hidden");
          error.setAttribute("role", "alert");
          for (const handoff of step.actions) {
            const handoffButton = action("", "handoff");
            handoffButton.append(
              node("span", "dd-tour-handoff-label", handoff.label),
              node("span", "dd-tour-handoff-copy", handoff.description)
            );
            handoffButton.addEventListener("click", () => {
              error.classList.add("hidden");
              for (const button of handoffs.querySelectorAll<HTMLButtonElement>("button")) button.disabled = true;
              Promise.resolve().then(() => handoff.run()).then(() => {
                endTour(true);
              }, (reason: unknown) => {
                error.textContent = reason instanceof Error ? reason.message : String(reason);
                error.classList.remove("hidden");
                for (const button of handoffs.querySelectorAll<HTMLButtonElement>("button")) button.disabled = false;
                handoffButton.focus();
                updateTourPosition();
              });
            });
            handoffs.append(handoffButton);
          }
          callout.append(handoffs, error);
        }
        const actions = node("div", "dd-tour-actions");
        const end = action("End tour", "quiet");
        end.addEventListener("click", () => endTour(false));
        const back = action("Back");
        back.disabled = index === 0;
        back.addEventListener("click", () => renderTourStep(index - 1));
        const next = action(step.nextLabel ?? (index === config.tour.length - 1 ? "Finish" : "Next"), "primary");
        next.addEventListener("click", () => renderTourStep(index + 1));
        actions.append(end, node("span", "dd-tour-spacer"), back, next);
        callout.append(actions);
        for (const mask of masks) mask.classList.remove("hidden");
        callout.classList.remove("hidden");
        updateTourPosition();
        next.focus();
      }, 0);
    };
    void Promise.resolve()
      .then(() => step.prepare?.())
      .then(presentStep, presentStep);
  };

  const onTourKeydown = (event: KeyboardEvent): void => {
    if (tourIndex < 0) return;
    if (event.key === "Tab") {
      const focusable = [...callout.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      endTour(false);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      renderTourStep(tourIndex + 1);
    } else if (event.key === "ArrowLeft" && tourIndex > 0) {
      event.preventDefault();
      renderTourStep(tourIndex - 1);
    }
  };

  const startTour = (): void => {
    dismissWelcome();
    guideOverlay.classList.add("hidden");
    setBackgroundInert(false);
    document.removeEventListener("keydown", onGuideKeydown, true);
    endTour(false);
    setBackgroundInert(true);
    document.addEventListener("keydown", onTourKeydown, true);
    window.addEventListener("resize", updateTourPosition);
    window.addEventListener("scroll", updateTourPosition, true);
    renderTourStep(0);
  };

  function endTour(completed: boolean): void {
    if (tourIndex < 0 && callout.classList.contains("hidden")) return;
    tourIndex = -1;
    tourTarget?.classList.remove("dd-tour-target");
    tourTarget = null;
    for (const mask of masks) mask.classList.add("hidden");
    callout.classList.add("hidden");
    setBackgroundInert(false);
    document.removeEventListener("keydown", onTourKeydown, true);
    window.removeEventListener("resize", updateTourPosition);
    window.removeEventListener("scroll", updateTourPosition, true);
    if (completed) {
      state = { ...state, tourCompleted: true, welcomeDismissed: true };
      writeState(config.id, state);
      showCompletion();
    }
  }

  const showCompletion = (): void => {
    const toast = node("div", "dd-help-toast");
    toast.setAttribute("role", "status");
    toast.append(
      node("span", "dd-help-toast-mark", "✓"),
      node("span", undefined, "Tour complete. Use the ? button to open help or run the tour again.")
    );
    document.body.append(toast);
    window.setTimeout(() => toast.remove(), 4_500);
  };

  const destroy = (): void => {
    closeGuide();
    endTour(false);
    welcome?.remove();
    guideOverlay.remove();
    callout.remove();
    for (const mask of masks) mask.remove();
  };

  window.setTimeout(showWelcome, 250);
  return { launcher, openGuide, startTour, destroy };
}

function setBackgroundInert(inert: boolean): void {
  document.getElementById("app")?.toggleAttribute("inert", inert);
}

function setRect(target: HTMLElement, left: number, top: number, width: number, height: number): void {
  target.style.left = `${String(Math.round(left))}px`;
  target.style.top = `${String(Math.round(top))}px`;
  target.style.width = `${String(Math.max(0, Math.round(width)))}px`;
  target.style.height = `${String(Math.max(0, Math.round(height)))}px`;
}
