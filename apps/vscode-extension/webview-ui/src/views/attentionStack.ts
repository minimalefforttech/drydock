/**
 * Stacked attention cards (questions + access requests).
 *
 * Instead of stacking full cards vertically (the W1 problem: two escalated
 * cards ate ~310px at rest), pending items share ONE card slot with a small
 * `‹ i/N ›` pager top-right — the claude/codex-style prompt block. Questions
 * render as: the question, the agent's suggested answers as one-click buttons
 * (first marked recommended), and a free-text answer row. Access requests
 * render the EXISTING buildAccessCard unchanged — no approval friction is
 * added or removed by the presentation (B4: the typed-confirm survives).
 *
 * Resolving an item advances to the next unresolved one; the caller re-renders
 * with the item removed and the pager clamps. `StackCursor` is caller-owned so
 * the position survives re-renders (webview-session-local, not persisted).
 *
 * SECURITY: question text, options, and answers are agent/user text — every
 * dynamic string reaches the DOM via textContent, never innerHTML.
 */

import type { AccessRequestSummary, AgentQuestionSummary } from "@drydock/contracts";
import { button, card, el, iconButton, textInput } from "../components.js";
import { request } from "../messaging.js";
import { buildAccessCard, type AccessCardCallbacks } from "./accessCard.js";

export type AttentionItem =
  | { readonly kind: "question"; readonly question: AgentQuestionSummary }
  | { readonly kind: "access"; readonly access: AccessRequestSummary };

/** Caller-owned pager position; clamped on every render. */
export interface StackCursor {
  index: number;
}

export interface AttentionStackCallbacks {
  /** An item was resolved (answered/dismissed/approved/denied) — re-render surfaces. */
  onResolved(): void;
  onError(message: string): void;
  readonly access: AccessCardCallbacks;
}

/**
 * Renders the stack into `container` (replaceChildren). Hidden when empty —
 * callers toggle their own section visibility off the item count.
 */
export function renderAttentionStack(
  container: HTMLElement,
  items: readonly AttentionItem[],
  cursor: StackCursor,
  callbacks: AttentionStackCallbacks
): void {
  container.replaceChildren();
  if (items.length === 0) return;
  if (cursor.index >= items.length) cursor.index = items.length - 1;
  if (cursor.index < 0) cursor.index = 0;
  const item = items[cursor.index] as AttentionItem;

  const stack = el("div", "attention-stack");
  const header = el("div", "attention-stack-header");
  const headline = el("span", "attention-stack-title");
  headline.textContent = item.kind === "question" ? "Agent asks" : "Agent requests access";
  header.append(headline);
  if (items.length > 1) {
    const nav = el("div", "attention-stack-nav");
    const prev = iconButton("‹", "Previous item", "attention-stack-prev");
    const counter = el("span", "attention-stack-counter");
    counter.textContent = `${String(cursor.index + 1)}/${String(items.length)}`;
    const next = iconButton("›", "Next item", "attention-stack-next");
    prev.disabled = cursor.index === 0;
    next.disabled = cursor.index === items.length - 1;
    prev.addEventListener("click", () => {
      cursor.index -= 1;
      renderAttentionStack(container, items, cursor, callbacks);
    });
    next.addEventListener("click", () => {
      cursor.index += 1;
      renderAttentionStack(container, items, cursor, callbacks);
    });
    nav.append(prev, counter, next);
    header.append(nav);
  }
  stack.append(header);

  stack.append(
    item.kind === "question"
      ? buildQuestionCard(item.question, callbacks)
      : buildAccessCard(item.access, callbacks.access, "access-card stacked")
  );
  container.append(stack);
}

function buildQuestionCard(question: AgentQuestionSummary, callbacks: AttentionStackCallbacks): HTMLElement {
  const c = card("attention-card question-card");

  const text = el("div", "question-text");
  text.textContent = question.question;
  c.append(text);

  let busy = false;
  const submit = (answer: string): void => {
    if (busy) return;
    const trimmed = answer.trim();
    if (trimmed.length === 0) return;
    busy = true;
    c.classList.add("busy");
    void request({ type: "question.answer", questionId: question.questionId, answer: trimmed }).then((response) => {
      busy = false;
      c.classList.remove("busy");
      if (!response.ok) {
        callbacks.onError(response.error.message);
        return;
      }
      callbacks.onResolved();
    });
  };

  if (question.options.length > 0) {
    const options = el("div", "question-options");
    question.options.forEach((option, index) => {
      const optionButton = button(index === 0 ? `${option} · recommended` : option, index === 0 ? "question-option primary small" : "question-option small");
      optionButton.addEventListener("click", () => submit(option));
      options.append(optionButton);
    });
    c.append(options);
  }

  const answerRow = el("div", "question-answer-row");
  const answerInput = textInput(question.options.length > 0 ? "or type your own answer…" : "type your answer…");
  answerInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit(answerInput.value);
    }
  });
  const answerButton = button("Answer", "small");
  answerButton.addEventListener("click", () => submit(answerInput.value));
  const dismissButton = button("Dismiss", "ghost small");
  dismissButton.title = "Drop the question without answering (the agent is not notified)";
  dismissButton.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    void request({ type: "question.dismiss", questionId: question.questionId }).then((response) => {
      busy = false;
      if (!response.ok) {
        callbacks.onError(response.error.message);
        return;
      }
      callbacks.onResolved();
    });
  });
  answerRow.append(answerInput, answerButton, dismissButton);
  c.append(answerRow);

  return c;
}
