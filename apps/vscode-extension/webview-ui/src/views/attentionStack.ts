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
import { pastedFiles, pastedName, uploadAttachment } from "../attachments.js";
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
  headline.textContent = item.kind === "question" ? "Open Questions:" : "Agent requests access";
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

  if (question.kind === "manual-check") {
    const chipEl = el("span", "question-kind-chip");
    chipEl.textContent = "manual check";
    chipEl.title = "The agent needs a human to run these steps outside its sandbox";
    c.append(chipEl);
  }
  const text = el("div", "question-text");
  text.textContent = question.question;
  c.append(text);

  // Agent-supplied illustrations (sandbox screenshots/renders), resolved to
  // data URIs host-side at capture. Unresolved refs state the path honestly.
  const imageEl = (dataUri: string, alt: string): HTMLElement => {
    const img = document.createElement("img");
    img.src = dataUri;
    img.alt = alt;
    img.className = "question-image";
    img.addEventListener("click", () => img.classList.toggle("zoomed"));
    return img;
  };
  if (question.images !== undefined && question.images.length > 0) {
    const row = el("div", "question-images");
    for (const image of question.images) {
      if (image.dataUri !== undefined) {
        row.append(imageEl(image.dataUri, image.path));
      } else {
        const missing = el("span", "question-image-missing");
        missing.textContent = `⚠ ${image.path} (could not be read from the sandbox)`;
        row.append(missing);
      }
    }
    c.append(row);
  }

  // Manual-check steps: an ordered, checkable list (webview-local check state);
  // the answer carries a completed-steps receipt.
  const stepChecks: HTMLInputElement[] = [];
  if (question.kind === "manual-check" && question.steps !== undefined && question.steps.length > 0) {
    const list = el("ol", "question-steps");
    for (const step of question.steps) {
      const item = el("li", "question-step");
      const label = el("label", "question-step-label");
      const check = document.createElement("input");
      check.type = "checkbox";
      stepChecks.push(check);
      const stepText = el("span", "question-step-text");
      stepText.textContent = step.text;
      label.append(check, stepText);
      item.append(label);
      if (step.imageDataUri !== undefined) item.append(imageEl(step.imageDataUri, step.text));
      list.append(item);
    }
    c.append(list);
  }

  // Verify-gate stamping: a manual check tied to a subtask can stamp it
  // Verified with the same gesture (checked by default — answering IS the check).
  let verifyBox: HTMLInputElement | null = null;
  if (question.kind === "manual-check" && question.subtaskId !== undefined) {
    const verifyLabel = el("label", "question-verify-row");
    verifyBox = document.createElement("input");
    verifyBox.type = "checkbox";
    verifyBox.checked = true;
    const verifyText = el("span");
    verifyText.textContent = "Stamp the gated subtask Verified ✓ with this answer";
    verifyLabel.append(verifyBox, verifyText);
    c.append(verifyLabel);
  }

  let busy = false;
  const submit = (answer: string): void => {
    if (busy) return;
    const trimmed = answer.trim();
    if (trimmed.length === 0) return;
    busy = true;
    c.classList.add("busy");
    const checked = stepChecks.filter((check) => check.checked).length;
    const receipt = stepChecks.length > 0 ? ` (steps checked: ${String(checked)}/${String(stepChecks.length)})` : "";
    void request({ type: "question.answer", questionId: question.questionId, answer: `${trimmed}${receipt}` }).then((response) => {
      busy = false;
      c.classList.remove("busy");
      if (!response.ok) {
        callbacks.onError(response.error.message);
        return;
      }
      if (verifyBox?.checked === true && question.subtaskId !== undefined) {
        void request({ type: "subtask.update", subtaskId: question.subtaskId, verified: true }).then((verifyResponse) => {
          if (!verifyResponse.ok) callbacks.onError(`verify stamp failed: ${verifyResponse.error.message}`);
        });
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
  // Attachments on answers: pasted screenshots / picked files upload into the
  // question's session sandbox and land in the answer text as [file:…] tokens
  // the agent can open (same mechanism as the composer).
  const attachToAnswer = async (files: readonly File[]): Promise<void> => {
    for (const [index, file] of files.entries()) {
      try {
        const uploaded = await uploadAttachment(question.sessionId, pastedName(file, index), file);
        const token = `[file:${uploaded.runtimePath}]`;
        answerInput.value = answerInput.value.length === 0 ? token : `${answerInput.value} ${token}`;
      } catch (error) {
        callbacks.onError(`attach failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    answerInput.focus();
  };
  answerInput.addEventListener("paste", (event) => {
    const files = pastedFiles(event);
    if (files.length === 0) return;
    event.preventDefault();
    void attachToAnswer(files);
  });
  const answerFileInput = document.createElement("input");
  answerFileInput.type = "file";
  answerFileInput.multiple = true;
  answerFileInput.className = "hidden";
  answerFileInput.addEventListener("change", () => {
    const files = [...(answerFileInput.files ?? [])];
    answerFileInput.value = "";
    void attachToAnswer(files);
  });
  const attachButton = iconButton("📎", "Attach images or documents to your answer (uploaded into the running sandbox)", "question-attach-button");
  attachButton.addEventListener("click", () => answerFileInput.click());
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
  answerRow.append(answerInput, attachButton, answerFileInput, answerButton, dismissButton);
  c.append(answerRow);

  return c;
}
