/**
 * DOM component helpers for the chat panel webview.
 *
 * SECURITY: every helper that takes text assigns it via textContent — never
 * innerHTML — so agent output and any host-supplied string can never become
 * markup. Callers must keep this invariant when composing nodes.
 */

export function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export function button(label: string, extraClass = ""): HTMLButtonElement {
  const node = document.createElement("button");
  node.textContent = label;
  node.className = `button ${extraClass}`.trim();
  return node;
}

export function iconButton(glyph: string, label: string, extraClass = ""): HTMLButtonElement {
  const node = document.createElement("button");
  node.textContent = glyph;
  node.className = `icon-button ${extraClass}`.trim();
  node.title = label;
  node.setAttribute("aria-label", label);
  return node;
}

export function textInput(placeholder: string): HTMLInputElement {
  const node = document.createElement("input");
  node.type = "text";
  node.className = "text-input";
  node.placeholder = placeholder;
  return node;
}

export function numberInput(placeholder: string, initial: number): HTMLInputElement {
  const node = document.createElement("input");
  node.type = "number";
  node.className = "number-input";
  node.placeholder = placeholder;
  node.min = "1";
  node.value = String(initial);
  return node;
}

export function option(value: string, label: string): HTMLOptionElement {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = label;
  return node;
}

export function select(className: string, title?: string): HTMLSelectElement {
  const node = document.createElement("select");
  node.className = className;
  if (title) node.title = title;
  return node;
}

/** A quiet card container; children are appended by the caller. */
export function card(extraClass = ""): HTMLElement {
  return el("div", `card ${extraClass}`.trim());
}

/**
 * A collapsible `<details>` section with a text summary. Returns the details
 * element, its body, and the summary label span so callers can `replaceChildren`
 * on re-render (preserving open/closed state) and update the summary text
 * (e.g. a live "(N files)" count) without rebuilding the disclosure.
 */
export function collapsible(
  summaryText: string,
  open = false
): { details: HTMLDetailsElement; body: HTMLElement; summaryLabel: HTMLElement } {
  const details = document.createElement("details");
  details.className = "section";
  if (open) details.open = true;
  const summary = document.createElement("summary");
  const summaryLabel = el("span", "section-summary-label");
  summaryLabel.textContent = summaryText;
  summary.append(summaryLabel);
  const body = el("div", "section-body");
  details.append(summary, body);
  return { details, body, summaryLabel };
}

/** A small pill/chip; optional click handler turns it into an affordance. */
export function chip(text: string, onClick?: () => void): HTMLElement {
  const node = el(onClick ? "button" : "span", `chip${onClick ? " chip-button" : ""}`);
  node.textContent = text;
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

/** A status dot with an accessible label; class encodes the visual state. */
export function statusDot(stateClass: string, label: string): HTMLElement {
  const dot = el("span", `status-dot ${stateClass}`.trim());
  dot.title = label;
  dot.setAttribute("aria-label", label);
  return dot;
}

/** A small status badge (colored pill) with textContent-only content. */
export function badge(text: string, extraClass = ""): HTMLElement {
  const node = el("span", `status ${extraClass}`.trim());
  node.textContent = text;
  return node;
}

/**
 * A word-wrapped popover anchored to a trigger button (a custom div, not the
 * native `title` attribute, which cannot wrap reliably). Toggles on click and
 * closes on outside-click or Escape. The caller fills `content` via a builder
 * so the popover always reflects fresh data when opened.
 */
export function popover(
  trigger: HTMLElement,
  build: (content: HTMLElement, close: () => void) => void
): HTMLElement {
  const wrap = el("span", "popover-wrap");
  const content = el("div", "popover hidden");
  wrap.append(trigger, content);

  const close = (): void => {
    content.classList.add("hidden");
    document.removeEventListener("click", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const onOutside = (event: MouseEvent): void => {
    if (!wrap.contains(event.target as Node)) close();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") close();
  };

  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    if (content.classList.contains("hidden")) {
      content.replaceChildren();
      build(content, close);
      content.classList.remove("hidden");
      document.addEventListener("click", onOutside, true);
      document.addEventListener("keydown", onKey, true);
    } else {
      close();
    }
  });
  return wrap;
}

/**
 * A destructive-action button that requires a second confirming click. The
 * first click swaps the label to "Confirm?"; clicking Confirm runs `onConfirm`,
 * clicking elsewhere (or a 3s timeout) reverts. Prevents accidental deletes.
 */
export function inlineConfirmButton(
  label: string,
  confirmLabel: string,
  onConfirm: () => void,
  extraClass = "ghost small danger"
): HTMLButtonElement {
  const node = button(label, extraClass);
  let armed = false;
  let timer = 0;
  const disarm = (): void => {
    armed = false;
    node.textContent = label;
    node.classList.remove("armed");
    if (timer) window.clearTimeout(timer);
  };
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!armed) {
      armed = true;
      node.textContent = confirmLabel;
      node.classList.add("armed");
      timer = window.setTimeout(disarm, 3_000);
      return;
    }
    disarm();
    onConfirm();
  });
  node.addEventListener("blur", disarm);
  return node;
}

/** Relative "3m ago" style timestamp from an ISO string. */
export function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.round(hours / 24);
  return `${String(days)}d ago`;
}

/** HH:MM:SS from an ISO timestamp for log rows. */
export function formatTime(iso: string): string {
  const time = iso.split("T")[1];
  return time ? time.slice(0, 8) : iso;
}

/** Last two path segments, for compact display of long file paths. */
export function shortPath(value: string): string {
  const parts = value.split(/[\\/]/);
  return parts.slice(-2).join("/");
}
