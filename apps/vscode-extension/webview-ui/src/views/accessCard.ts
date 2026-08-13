/**
 * Shared access-request approval card, used by both the Tasks tab
 * ("needs attention" strip) and the Chat tab (inline transcript card).
 *
 * One card-building function keeps the markup and resolve logic in one place;
 * callers only differ in container class and post-resolve refresh behavior.
 *
 * Risk-tiered approval (see docs/design/workflow-scenarios.md, personas B1/B4): a plain read-only,
 * non-sensitive request keeps its one-click Allow. When the request grants write
 * access (`mode === "read-write"`) OR the path looks sensitive, the card
 * escalates: an amber/red accent, a one-line warning, and a TWO-STEP typed
 * confirmation - clicking Allow reveals an input and the confirm button stays
 * disabled until the typed text matches the expected last path segment
 * (basename of the CURRENT path value, compared case-insensitively after
 * trimming). "Looks sensitive" is re-evaluated LIVE against the CURRENT path
 * input, not latched from the original request: `access.sensitive` only
 * describes the path the request arrived with, so an edited path is
 * reclassified with the same matcher the host used (sensitivePath.ts, a pure
 * webview-side mirror of mountPolicy.ts's - see its header for why this can't
 * just import @drydock/core), re-checked on every keystroke AND again at
 * Allow-click time so a stale paint can never be trusted. A benign request
 * whose path is edited to `~/.ssh` (or any other sensitive-looking path) gets
 * the same typed-confirm treatment a fresh request for that path would (T2.4).
 * Editing the path also re-derives the expected typed-confirm segment, so a
 * post-arm path change re-gates the confirmation. Deny is always one click.
 *
 * Production fixtures (ADR 0022, ux-flows F3) are the same card in three
 * lines: `Production file → snapshot` + tier badge, the file line, and the
 * SAME typed confirm this module already owns (production forces the escalated
 * path; the token stays the basename and the placeholder stays generic). The
 * mechanics - copied at approval, hash recorded, expires with the session,
 * wiped between jobs, no write-back - sit behind `ⓘ how snapshots work`,
 * because the decision only needs two facts: what file, and where from.
 *
 * SECURITY: all dynamic strings (path, reason, mode, expected segment) render
 * via textContent - never innerHTML.
 */

import type { AccessRequestSummary } from "@drydock/contracts";
import { button, card, chip, el, textInput } from "../components.js";
import { request } from "../messaging.js";
import { baseName, dirName, middleTruncate, type AccessProductionFields } from "../validationTypes.js";
import { sensitivePathMatch, sensitiveReasonFor } from "./sensitivePath.js";

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
 * `ⓘ how snapshots work` - the mechanics, on request only. Answers the one
 * question the card cannot afford a line for: what am I actually agreeing to?
 */
function snapshotDetails(access: AccessRequestSummary): HTMLElement {
  const details = document.createElement("details");
  details.className = "access-snapshot";
  const summary = document.createElement("summary");
  summary.className = "access-snapshot-summary";
  summary.textContent = "ⓘ how snapshots work";
  details.append(summary);
  const body = el("div", "access-snapshot-body");
  for (const line of [
    "Copied once at approval — never a mount, never live. The content hash is recorded in the grants ledger.",
    `The run sees it at the same path (${access.displayPath}), backed by job-scoped content.`,
    "Expires with this session · wiped between jobs · recorded in every validation receipt it feeds.",
    "There is no write-back: nothing the run produces can reach the production copy."
  ]) {
    const node = el("div", "access-snapshot-line");
    node.textContent = line;
    body.append(node);
  }
  const requester = el("div", "access-snapshot-line");
  requester.textContent = `Requested for: ${access.reason}`;
  body.append(requester);
  details.append(body);
  return details;
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
  // A production-tier path is a FIXTURE decision, not a mount decision: the
  // policy forbids the mount outright, so approval means "snapshot it".
  const production = (access as AccessProductionFields).production === true;
  // Escalation triggers that do NOT depend on the (editable) host path:
  // production tier and read-write mode widen host reach regardless of which
  // path is finally submitted. Path-derived escalation ("looks sensitive") is
  // recomputed LIVE from the CURRENT input value by isEscalatedNow() below -
  // access.sensitive/sensitiveReason only ever describe the ORIGINAL,
  // unedited path. Trusting them once and never re-checking an edited path is
  // exactly how a one-click Allow card could slip a sensitive path through
  // with no typed confirm (T2.4) - the `access-escalated` class is set live
  // too, see updateEscalationDisplay().
  const structurallyEscalated = production || access.mode === "read-write";
  const c = card(`attention-card ${extraClass}${production ? " access-production" : ""}`.trim());

  const title = el("div", "attention-title");
  title.textContent = production ? "Production file → snapshot" : "Agent requests access";

  const modeChip = production ? chip("production") : chip(access.mode === "read-write" ? "rw" : "ro");
  if (production) {
    modeChip.classList.add("chip-production");
    modeChip.title = "Production tier: approving copies the file into this session, never mounts it.";
  }

  const headerRow = el("div", "access-card-header");
  headerRow.append(title, modeChip);

  const reason = el("div", "attention-reason");
  reason.textContent = access.reason;

  const pathInput = textInput("Host path");
  pathInput.className += " access-card-path";
  pathInput.value = access.displayPath;

  const actions = el("div", "card-actions");
  const approve = button(production ? "Approve snapshot" : "Allow", "small primary");
  const deny = button("Deny", "ghost small");
  actions.append(approve, deny);

  const setBusy = (busy: boolean): void => {
    approve.disabled = busy;
    deny.disabled = busy;
  };

  // `confirmedEscalation` is the card's attestation that the typed-confirm
  // gate ran for this approval; the HOST independently re-derives escalation
  // from the effective path and refuses an escalated approval without it, so
  // this flag is honest reporting, not the enforcement itself (F3).
  const send = (approveDecision: boolean, confirmedEscalation = false): void => {
    setBusy(true);
    const editedPath = pathInput.value.trim();
    const editedHostPath = approveDecision && editedPath.length > 0 && editedPath !== access.displayPath
      ? editedPath
      : undefined;
    void request({
      type: "policy.resolveAccess",
      accessRequestId: access.accessRequestId,
      approve: approveDecision,
      ...(editedHostPath ? { editedHostPath } : {}),
      ...(approveDecision && confirmedEscalation ? { confirmedEscalation: true } : {})
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

  if (production) {
    // Three lines, and that is the whole card. `pathInput` stays OUT of the
    // DOM but keeps its value, so the typed-confirm machinery below (which
    // derives the token from the current path) is untouched - and the path
    // itself is not editable on a production request.
    const fileLine = el("div", "access-file-line");
    const base = baseName(access.displayPath);
    const size = (access as AccessProductionFields).sizeLabel;
    const folder = dirName(access.displayPath);
    const name = el("span", "access-file-name");
    name.textContent = middleTruncate(base, 40);
    name.title = base;
    fileLine.append(name);
    if (size !== undefined && size.length > 0) {
      const sizeNode = el("span", "access-file-size");
      sizeNode.textContent = `· ${size}`;
      fileLine.append(sizeNode);
    }
    const folderNode = el("span", "access-file-folder");
    folderNode.textContent = folder.length === 0 ? "" : `· ${middleTruncate(folder, 44)}`;
    folderNode.title = access.displayPath;
    fileLine.append(folderNode);
    c.append(headerRow, fileLine, snapshotDetails(access));
  } else {
    c.append(headerRow, reason, pathInput);
  }

  // --- escalation, recomputed from the CURRENT path -------------------------
  // `access.sensitive`/`sensitiveReason` describe the ORIGINAL request only.
  // Once the input differs from that original path, they no longer apply -
  // the EDITED path is reclassified with the same matcher the host used to
  // flag it in the first place (sensitivePathMatch; see sensitivePath.ts's
  // header for why this is a local mirror rather than an @drydock/core
  // import). This is the single source of truth for "is the request the user
  // is about to submit dangerous" - it is called fresh on every path edit AND
  // again at Allow/Confirm-click time, never cached (T2.4).
  const currentSensitiveReason = (): string | null => {
    if (production) return null;
    const current = pathInput.value.trim();
    if (current === access.displayPath) {
      // Unedited: trust the host's original classification verbatim.
      if (access.sensitive !== true) return null;
      return access.sensitiveReason !== undefined && access.sensitiveReason.length > 0
        ? access.sensitiveReason
        : "this path looks like credentials or secrets";
    }
    const match = sensitivePathMatch(current);
    return match === null ? null : sensitiveReasonFor(match);
  };
  const isEscalatedNow = (): boolean => structurallyEscalated || currentSensitiveReason() !== null;

  // The escalation line names WHAT triggered the escalation and WHAT the grant
  // exposes. For a sensitive path we lead with the matched-pattern reason
  // (host-supplied display text via `sensitiveReason` for an unedited path,
  // the local re-match for an edited one) and append the exposure phrase; a
  // plain rw grant states the write exposure. All strings render via
  // textContent. Built and wired for EVERY non-production card, not only one
  // that starts escalated, so a plain card can escalate live as the path is
  // edited instead of only at the next full render.
  const warning = el("div", "access-warning");

  // The typed-confirm block is hidden until Allow arms it. The label NAMES the
  // exact token to type - the current path's final segment in a monospace span
  // - while the input placeholder stays GENERIC so the greyed text can't be
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

  // Repaints the accent + warning line from isEscalatedNow() and reports the
  // result so callers (the path-input listener and the Allow/Confirm click
  // handlers) can branch on the SAME live check instead of a second, possibly
  // stale, read. Does not touch confirmWrap's armed/hidden state on its own
  // EXCEPT to belt-and-braces disarm it the moment the current path is no
  // longer dangerous - never leave a typed-confirm box armed for a request
  // that would not need one if submitted fresh right now.
  const updateEscalationDisplay = (): boolean => {
    const nowEscalated = isEscalatedNow();
    c.classList.toggle("access-escalated", nowEscalated);
    if (production) {
      // The production card spends its whole friction budget on the typed
      // confirm (F3); a warning line would be a fourth line saying what the
      // badge already says. Its path is never editable (kept out of the DOM
      // above), so this is always true and never revisited.
      warning.textContent = "";
      return nowEscalated;
    }
    const reason = currentSensitiveReason();
    if (reason !== null) {
      const exposure = access.mode === "read-write" ? "writes to your machine" : "readable by the model";
      warning.textContent = `${reason} - ${exposure}`;
    } else if (access.mode === "read-write") {
      warning.textContent = "writes to your machine";
    } else {
      warning.textContent = "";
    }
    if (nowEscalated) {
      if (warning.parentElement === null) c.insertBefore(warning, pathInput);
    } else {
      if (warning.parentElement !== null) warning.remove();
      confirmWrap.classList.add("hidden");
      approve.classList.remove("armed");
    }
    refreshConfirmEnabled();
    return nowEscalated;
  };

  confirmInput.addEventListener("input", refreshConfirmEnabled);
  // Re-deriving on every path edit means an armed confirm can silently
  // invalidate, the named token must track the edit, and a PLAIN card can
  // newly become escalated (or an escalated one settle back down) - keep all
  // three honest as the user types, not only at the next click.
  pathInput.addEventListener("input", () => updateEscalationDisplay());

  approve.addEventListener("click", () => {
    // Recomputed HERE, at click time, rather than trusting whatever state was
    // last painted by an "input" event - belt and braces against an edit that
    // never fired one (e.g. a programmatic value change) or landed between
    // the last keystroke and this click (T2.4).
    if (!updateEscalationDisplay()) {
      // Recomputed and still genuinely benign: unchanged one-click Allow.
      send(true);
      return;
    }
    // First Allow click on an escalated card arms the typed confirm; it does
    // not resolve.
    if (confirmWrap.classList.contains("hidden")) {
      confirmWrap.classList.remove("hidden");
      approve.classList.add("armed");
      confirmInput.focus();
    }
  });
  confirmButton.addEventListener("click", () => {
    // Belt and braces: re-check even here. In normal use this can only be
    // clicked while genuinely escalated (de-escalating hides and disarms this
    // block via updateEscalationDisplay above), but never trust a hidden
    // element can't still receive a click.
    if (!updateEscalationDisplay() || !matches()) return;
    send(true, true);
  });

  updateEscalationDisplay();
  actions.append(el("span", "card-actions-spacer"));
  c.append(actions, confirmWrap);
  return c;
}
