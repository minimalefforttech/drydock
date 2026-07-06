/**
 * Shared access-request approval card, used by both the Tasks tab
 * ("needs attention" strip) and the Chat tab (inline transcript card).
 *
 * One card-building function keeps the markup and resolve logic in one place;
 * callers only differ in container class and post-resolve refresh behavior.
 *
 * Risk-tiered approval (see docs/design/workflow-scenarios.md, personas B1/B4): a plain read-only,
 * non-sensitive request keeps its one-click Allow. When the request grants write
 * access (`mode === "read-write"`) OR the path looks sensitive
 * (`sensitive === true`), the card escalates: an amber/red accent, a one-line
 * warning, and a TWO-STEP typed confirmation — clicking Allow reveals an input
 * and the confirm button stays disabled until the typed text matches the
 * expected last path segment (basename of the CURRENT path value, compared
 * case-insensitively after trimming). Editing the path re-derives the expected
 * segment, so a post-arm path change re-gates the confirmation. Deny is always
 * one click.
 *
 * SECURITY: all dynamic strings (path, reason, mode, expected segment) render
 * via textContent — never innerHTML.
 */

import type { AccessRequestSummary } from "@drydock/contracts";
import { button, card, chip, el, textInput } from "../components.js";
import { request } from "../messaging.js";

export interface AccessCardCallbacks {
  /** Called once the resolve request completes successfully (approve or deny). */
  onResolved(approve: boolean): void;
  /** Called when the resolve request fails; the card re-enables its buttons. */
  onError(message: string): void;
}

/** Last path segment (basename) of a host path, tolerant of / and \ separators. */
function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/**
 * Builds one access-request card. `extraClass` lets callers add a container
 * class (e.g. `access-card` for the inline chat variant) without duplicating
 * the rest of the markup/behavior.
 */
export function buildAccessCard(
  access: AccessRequestSummary,
  callbacks: AccessCardCallbacks,
  extraClass = ""
): HTMLElement {
  // A request escalates when it widens host reach (rw) or reads a
  // sensitive-looking path (credentials/keys/env). Both get the typed confirm.
  const escalated = access.mode === "read-write" || access.sensitive === true;
  const c = card(`attention-card ${extraClass}${escalated ? " access-escalated" : ""}`.trim());

  const title = el("div", "attention-title");
  title.textContent = "Agent requests access";

  const modeChip = chip(access.mode === "read-write" ? "rw" : "ro");

  const headerRow = el("div", "access-card-header");
  headerRow.append(title, modeChip);

  const reason = el("div", "attention-reason");
  reason.textContent = access.reason;

  const pathInput = textInput("Host path");
  pathInput.className += " access-card-path";
  pathInput.value = access.displayPath;

  const actions = el("div", "card-actions");
  const approve = button("Allow", "small primary");
  const deny = button("Deny", "ghost small");
  actions.append(approve, deny);

  const setBusy = (busy: boolean): void => {
    approve.disabled = busy;
    deny.disabled = busy;
  };

  const send = (approveDecision: boolean): void => {
    setBusy(true);
    const editedPath = pathInput.value.trim();
    const editedHostPath = approveDecision && editedPath.length > 0 && editedPath !== access.displayPath
      ? editedPath
      : undefined;
    void request({
      type: "policy.resolveAccess",
      accessRequestId: access.accessRequestId,
      approve: approveDecision,
      ...(editedHostPath ? { editedHostPath } : {})
    }).then((response) => {
      if (!response.ok) {
        setBusy(false);
        callbacks.onError(response.error.message);
        return;
      }
      callbacks.onResolved(approveDecision);
    });
  };

  deny.addEventListener("click", () => send(false));

  c.append(headerRow, reason, pathInput);

  if (!escalated) {
    // Plain read-only, non-sensitive: unchanged one-click Allow.
    approve.addEventListener("click", () => send(true));
    c.append(actions);
    return c;
  }

  // --- escalated: warning + two-step typed confirmation ----------------------
  // The escalation line names WHAT triggered the escalation and WHAT the grant
  // exposes. For a sensitive path we lead with the matched-pattern reason
  // (host-supplied display text via `sensitiveReason`, falling back to today's
  // generic line) and append the exposure phrase; a plain rw grant states the
  // write exposure. All strings render via textContent.
  const warning = el("div", "access-warning");
  if (access.sensitive === true) {
    const exposure = access.mode === "read-write" ? "writes to your machine" : "readable by the model";
    warning.textContent = access.sensitiveReason !== undefined && access.sensitiveReason.length > 0
      ? `${access.sensitiveReason} — ${exposure}`
      : `this path looks like credentials or secrets — ${exposure}`;
  } else {
    warning.textContent = "writes to your machine";
  }
  c.insertBefore(warning, pathInput);

  // The typed-confirm block is hidden until Allow arms it. The label NAMES the
  // exact token to type — the current path's final segment in a monospace span
  // — while the input placeholder stays GENERIC so the greyed text can't be
  // transcribed on autopilot without reading the label.
  const confirmWrap = el("div", "access-confirm hidden");
  const confirmLabel = el("label", "access-confirm-label");
  const confirmLabelLead = document.createTextNode("To approve, type ");
  const confirmToken = el("span", "confirm-token");
  confirmLabel.append(confirmLabelLead, confirmToken);
  const confirmInput = textInput("type it to confirm");
  confirmInput.className += " access-confirm-input";
  confirmLabel.append(confirmInput);
  const confirmActions = el("div", "card-actions");
  const confirmButton = button("Confirm", "small primary");
  confirmButton.disabled = true;
  confirmActions.append(confirmButton);
  confirmWrap.append(confirmLabel, confirmActions);

  // Expected segment is ALWAYS derived from the CURRENT path value (basename),
  // so editing the path after arming re-gates the confirmation. The label token
  // shows the raw (case-preserved) segment; the match stays case-insensitive.
  const expectedRaw = (): string => basename(pathInput.value.trim()).trim();
  const expected = (): string => expectedRaw().toLowerCase();
  const matches = (): boolean => {
    const exp = expected();
    return exp.length > 0 && confirmInput.value.trim().toLowerCase() === exp;
  };
  const refreshConfirmEnabled = (): void => {
    confirmToken.textContent = expectedRaw();
    confirmButton.disabled = !matches();
  };
  confirmInput.addEventListener("input", refreshConfirmEnabled);
  // Re-deriving on path edit means an armed confirm can silently invalidate, and
  // the named token must track the edit; keep both honest.
  pathInput.addEventListener("input", refreshConfirmEnabled);

  approve.addEventListener("click", () => {
    // First Allow click arms the typed confirm; it does not resolve.
    if (confirmWrap.classList.contains("hidden")) {
      confirmWrap.classList.remove("hidden");
      approve.classList.add("armed");
      refreshConfirmEnabled();
      confirmInput.focus();
    }
  });
  confirmButton.addEventListener("click", () => {
    if (!matches()) return;
    send(true);
  });

  actions.append(el("span", "card-actions-spacer"));
  c.append(actions, confirmWrap);
  return c;
}
