/** Small, framework-free modal focus helpers shared by editor webviews. */

export interface ModalFocusSnapshot {
  readonly key: string | null;
  readonly index: number | null;
}

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(", ");

export function modalFocusableElements(modal: HTMLElement): HTMLElement[] {
  return [...modal.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((node) => !node.hasAttribute("hidden") && node.getAttribute("aria-hidden") !== "true");
}

export function captureModalFocus(modal: HTMLElement | null): ModalFocusSnapshot | null {
  const active = document.activeElement;
  if (modal === null || !(active instanceof HTMLElement) || !modal.contains(active)) return null;
  const index = modalFocusableElements(modal).indexOf(active);
  return {
    key: active.dataset["modalFocus"] ?? null,
    index: index < 0 ? null : index
  };
}

export function trapModalFocus(event: KeyboardEvent, modal: HTMLElement): void {
  if (event.key !== "Tab") return;
  const focusable = modalFocusableElements(modal);
  if (focusable.length === 0) {
    event.preventDefault();
    modal.focus();
    return;
  }
  const activeIndex = document.activeElement instanceof HTMLElement
    ? focusable.indexOf(document.activeElement)
    : -1;
  if (activeIndex < 0) {
    event.preventDefault();
    (event.shiftKey ? focusable[focusable.length - 1] : focusable[0])?.focus();
    return;
  }
  if (!event.shiftKey && activeIndex === focusable.length - 1) {
    event.preventDefault();
    focusable[0]?.focus();
  } else if (event.shiftKey && activeIndex === 0) {
    event.preventDefault();
    focusable[focusable.length - 1]?.focus();
  }
}

/** Adds modal semantics/focus containment and identifies the first focus target. */
export function prepareModalFocus(modal: HTMLElement, initialFocus: HTMLElement = modal): void {
  modal.setAttribute("aria-modal", "true");
  modal.tabIndex = -1;
  modal.dataset["modalFocus"] = "dialog";
  initialFocus.dataset["modalInitial"] = "true";
  modal.addEventListener("keydown", (event) => trapModalFocus(event, modal));
}

function keyedTarget(modal: HTMLElement, key: string): HTMLElement | undefined {
  if (modal.dataset["modalFocus"] === key) return modal;
  return [...modal.querySelectorAll<HTMLElement>("[data-modal-focus]")]
    .find((node) => node.dataset["modalFocus"] === key);
}

/** Restores the prior modal control after a re-render, or enters at its initial target. */
export function queueModalFocus(modal: HTMLElement, snapshot: ModalFocusSnapshot | null): void {
  queueMicrotask(() => {
    if (!modal.isConnected) return;
    const focusable = modalFocusableElements(modal);
    let target = snapshot?.key === null || snapshot?.key === undefined
      ? undefined
      : keyedTarget(modal, snapshot.key);
    if (target === undefined && snapshot?.index !== null && snapshot?.index !== undefined) {
      target = focusable[Math.min(snapshot.index, Math.max(0, focusable.length - 1))];
    }
    if (target === undefined) {
      target = modal.dataset["modalInitial"] === "true"
        ? modal
        : modal.querySelector<HTMLElement>("[data-modal-initial]") ?? focusable[0] ?? modal;
    }
    target.focus();
  });
}
