/**
 * Validation chips in the chat transcript (ADR 0022, ux-flows F2).
 *
 * The chip IS the default experience: one line per live job plus the newest
 * settled one, appended to the transcript's status area. Not a protocol fence
 * and not a card - jobs arrive from `validation.jobs` and heal off the
 * `validation.jobChanged` push, exactly like every other host-owned list.
 *
 * The disclosure ladder is the law here:
 * - L1 is ONE line. Green says a word and a duration; red promotes exactly one
 *   level (the failing test + its assertion) because red is when a decision is
 *   needed; a license wait owns the line only while it IS the state.
 * - L2 (expanding a chip in place) carries the receipt metadata - changeset,
 *   mirror version + freshness, fixture manifest, license wait, probes-green -
 *   and the actions: Re-run, Abort, and the explicit reroute.
 * - Rerouting is never silent (edge case H1): `Run on default instead` asks the
 *   host, and a cross-profile move comes back `needs-confirm` with the policy
 *   delta, which renders INSIDE the expansion and requires a second click.
 *
 * SECURITY: every dynamic string (runtime names, park reasons, assertions,
 * hashes) is written with textContent - never innerHTML.
 */

import type { PanelRequestPayload } from "@drydock/contracts";
import { button, el } from "../components.js";
import { onPush, request } from "../messaging.js";
import {
  clockSpan,
  clockTime,
  middleTruncate,
  shortRef,
  wordSpan,
  type ValidationJobView,
  type ValidationPolicyDeltaView,
  type ValidationRequest,
  type ValidationResponseEnvelope
} from "../validationTypes.js";

/** States that will never move again: only the newest of these renders. */
const TERMINAL = new Set(["completed", "aborted", "failed"]);

export interface ValidationChipsMount {
  readonly root: HTMLElement;
  /** Points the strip at a session (null clears it); refetches on change. */
  setSession(sessionId: string | null): void;
  /** Refetch for the current session - push-driven, never polled. */
  refresh(): void;
}

/**
 * The validation kinds are not in `PanelRequestPayload` until M7a lands; the
 * cast lives in this ONE function and everything downstream is typed against
 * the mirror in `validationTypes.ts`.
 */
function validationRequest(payload: ValidationRequest): Promise<ValidationResponseEnvelope> {
  return request(payload as unknown as PanelRequestPayload) as unknown as Promise<ValidationResponseEnvelope>;
}

interface PendingDelta {
  readonly delta: ValidationPolicyDeltaView;
  readonly toRuntimeId: string;
  readonly toDisplayName: string;
}

export function createValidationChips(options: { log(line: string): void }): ValidationChipsMount {
  const root = el("div", "validation-chips");
  let sessionId: string | null = null;
  let jobs: readonly ValidationJobView[] = [];
  let fetchToken = 0;
  /** In-memory only: an expansion survives a refetch, never a panel reopen. */
  const expanded = new Set<string>();
  /** Jobs whose reroute came back `needs-confirm`, keyed by job id. */
  const pendingDeltas = new Map<string, PendingDelta>();
  /** Per-render list of "update my elapsed time" closures for live chips. */
  let tickers: (() => void)[] = [];
  let tickTimer: number | undefined;

  function refresh(): void {
    const target = sessionId;
    if (target === null) {
      jobs = [];
      render();
      return;
    }
    fetchToken += 1;
    const token = fetchToken;
    void validationRequest({ type: "validation.jobs", sessionId: target }).then((response) => {
      if (token !== fetchToken || sessionId !== target) return;
      if (response.ok && response.payload.type === "validation.jobs") {
        jobs = response.payload.jobs;
      } else {
        // No validation on this host (or the read failed): say nothing at all
        // rather than inventing a state for a surface devs never asked for.
        jobs = [];
      }
      render();
    });
  }

  function setSession(next: string | null): void {
    if (next === sessionId) return;
    sessionId = next;
    jobs = [];
    expanded.clear();
    pendingDeltas.clear();
    render();
    refresh();
  }

  // --- the visible jobs ------------------------------------------------------

  function visibleJobs(): readonly ValidationJobView[] {
    const live = jobs.filter((job) => !TERMINAL.has(job.state));
    const settled = jobs.filter((job) => TERMINAL.has(job.state));
    const newest = settled.reduce<ValidationJobView | null>((best, job) => {
      if (best === null) return job;
      const a = job.completedAt ?? job.queuedAt;
      const b = best.completedAt ?? best.queuedAt;
      return a > b ? job : best;
    }, null);
    const ordered = [...live].sort((a, b) => (a.queuedAt < b.queuedAt ? -1 : 1));
    return newest === null ? ordered : [...ordered, newest];
  }

  // --- L1 line ---------------------------------------------------------------

  function elapsedMs(job: ValidationJobView): number {
    const started = Date.parse(job.startedAt ?? job.queuedAt);
    if (Number.isNaN(started)) return 0;
    return Date.now() - started;
  }

  function settledMs(job: ValidationJobView): number | null {
    const started = Date.parse(job.startedAt ?? job.queuedAt);
    const ended = job.completedAt === undefined ? Number.NaN : Date.parse(job.completedAt);
    if (Number.isNaN(started) || Number.isNaN(ended)) return null;
    return ended - started;
  }

  /** What a running job is validating: the profile when the host names one. */
  function subject(job: ValidationJobView): string {
    const name = job.profileRef ?? job.runtimeDisplayName ?? "";
    return name === "" ? "" : middleTruncate(name, 28);
  }

  function glyphFor(job: ValidationJobView): string {
    switch (job.state) {
      case "queued": return "▸";
      case "parked": return "◼";
      case "aborted": return "◼";
      case "license-wait": return "⏸";
      case "starting": return "⧗";
      case "completed": return job.receipt?.verdict === "passed" ? "✓" : "✕";
      case "failed": return "✕";
      default: return "▶";
    }
  }

  /** The L1 text, and whether it needs a live clock. */
  function lineText(job: ValidationJobView): { readonly text: string; readonly live: boolean } {
    const name = subject(job);
    switch (job.state) {
      case "queued":
        return {
          text: job.queuePosition === undefined
            ? "Validation queued"
            : `Validation queued · position ${String(job.queuePosition)}`,
          live: false
        };
      case "starting":
        return { text: `starting ${name === "" ? "the runtime" : name} · ${clockSpan(elapsedMs(job))}`, live: true };
      case "syncing":
        return { text: `Syncing the mirror · ${clockSpan(elapsedMs(job))}`, live: true };
      case "resolving":
        return { text: `Resolving where this runs · ${clockSpan(elapsedMs(job))}`, live: true };
      case "license-wait": {
        const ahead = job.queuePosition === undefined ? "" : ` · ${String(job.queuePosition)} ahead`;
        const waited = job.licenseWaitMs === undefined ? "" : ` · ${clockSpan(job.licenseWaitMs)}`;
        return { text: `waiting for Maya license${ahead}${waited}`, live: false };
      }
      case "running":
        return {
          text: `Validating${name === "" ? "" : ` ${name}`} · ${clockSpan(elapsedMs(job))}`,
          live: true
        };
      case "parked":
        return { text: `Parked — ${job.parkedReason ?? "the resolved runtime is unavailable"}`, live: false };
      case "aborted":
        return { text: "Validation aborted", live: false };
      case "failed":
        return { text: `Validation could not run — ${job.parkedReason ?? "the runtime failed before any test ran"}`, live: false };
      default: {
        const receipt = job.receipt;
        const span = settledMs(job);
        if (receipt === undefined) return { text: "Validation finished · no receipt recorded", live: false };
        if (receipt.verdict === "passed") {
          return { text: `Validation passed${span === null ? "" : ` · ${wordSpan(span)}`}`, live: false };
        }
        if (receipt.verdict === "error") {
          return { text: `Validation error — ${receipt.summary ?? "the run did not produce a verdict"}`, live: false };
        }
        // Red gets the extra line: the failing test AND its assertion, once.
        const test = receipt.failingTest ?? receipt.summary ?? "a test failed";
        const assertion = receipt.failingAssertion;
        return { text: assertion === undefined ? test : `${test} — ${assertion}`, live: false };
      }
    }
  }

  // --- L2 expansion ----------------------------------------------------------

  function receiptRows(job: ValidationJobView): HTMLElement {
    const wrap = el("div", "validation-receipt");
    const receipt = job.receipt;
    const line = (label: string, value: string): void => {
      const node = el("div", "validation-receipt-row");
      const key = el("span", "validation-receipt-key");
      key.textContent = label;
      const val = el("span", "validation-receipt-value");
      val.textContent = value;
      val.title = value;
      node.append(key, val);
      wrap.append(node);
    };
    line("runtime", job.runtimeDisplayName ?? "unknown");
    if (receipt === undefined) {
      line("receipt", "not stamped yet — evidence lands when the job settles");
      return wrap;
    }
    line("changeset", shortRef(receipt.changesetRef));
    line("mirror", receipt.mirrorVersion === undefined
      ? "unknown"
      : `v${String(receipt.mirrorVersion)}${receipt.mirrorFreshnessAt === undefined ? "" : ` · synced ${clockTime(receipt.mirrorFreshnessAt)}`}`);
    line("fixtures", receipt.fixtureManifestHash === undefined ? "none" : shortRef(receipt.fixtureManifestHash));
    line("license wait", wordSpan(receipt.licenseWaitMs));
    line("probes green", receipt.probesGreenAt === undefined ? "unknown" : clockTime(receipt.probesGreenAt));
    if (receipt.superseded) line("superseded", "the working set moved on after this evidence was produced");
    return wrap;
  }

  /** The policy delta, rendered verbatim before anything reroutes (H1/H2). */
  function deltaBlock(job: ValidationJobView, pending: PendingDelta): HTMLElement {
    const wrap = el("div", "validation-delta");
    const head = el("div", "validation-delta-head");
    head.textContent = `Run on ${pending.toDisplayName} instead?`;
    wrap.append(head);
    const lines = el("div", "validation-delta-lines");
    const delta = pending.delta;
    const add = (text: string): void => {
      const node = el("div", "validation-delta-line");
      node.textContent = text;
      lines.append(node);
    };
    add(delta.profileChanged
      ? `profile: ${delta.fromProfile ?? "unknown"} → ${delta.toProfile}`
      : `profile: ${delta.toProfile} (same)`);
    add(delta.imageChanged ? "image: different" : "image: same");
    add(delta.capabilitiesAdded.length === 0 ? "capabilities added: none" : `capabilities added: ${delta.capabilitiesAdded.join(", ")}`);
    add(delta.capabilitiesRemoved.length === 0 ? "capabilities removed: none" : `capabilities removed: ${delta.capabilitiesRemoved.join(", ")}`);
    wrap.append(lines);
    if (delta.profileException) {
      const warn = el("div", "validation-delta-warning");
      warn.textContent = "This runtime carries a policy-profile exception — it can reach a standing fixture set the default cannot.";
      wrap.append(warn);
    }
    const actions = el("div", "validation-chip-actions");
    const confirm = button("Confirm", "small primary");
    confirm.addEventListener("click", () => {
      requeue(job, pending.toRuntimeId, true);
    });
    const cancel = button("Cancel", "ghost small");
    cancel.addEventListener("click", () => {
      pendingDeltas.delete(job.jobId);
      render();
    });
    actions.append(confirm, cancel);
    wrap.append(actions);
    return wrap;
  }

  // --- actions ---------------------------------------------------------------

  function requeue(job: ValidationJobView, rerouteTo?: string, confirmed?: boolean): void {
    void validationRequest({
      type: "validation.requeue",
      jobId: job.jobId,
      ...(rerouteTo === undefined ? {} : { rerouteTo }),
      ...(confirmed === true ? { confirmedDelta: true } : {})
    }).then((response) => {
      if (!response.ok) {
        options.log(`validation requeue failed: ${response.error.message}`);
        return;
      }
      if (response.payload.type !== "validation.requeue") return;
      const result = response.payload.result;
      if (result.kind === "queued") {
        pendingDeltas.delete(job.jobId);
        options.log("validation requeued");
        refresh();
        return;
      }
      if (result.kind === "needs-confirm") {
        // Cross-profile: the delta renders in the expansion, never a modal.
        pendingDeltas.set(job.jobId, {
          delta: result.delta,
          toRuntimeId: result.toRuntimeId,
          toDisplayName: result.toDisplayName
        });
        expanded.add(job.jobId);
        options.log(`validation reroute needs the policy delta confirmed (${result.toDisplayName})`);
        render();
        return;
      }
      options.log(`validation stayed parked: ${result.reason}`);
      refresh();
    });
  }

  function abort(job: ValidationJobView): void {
    void validationRequest({ type: "validation.abortJob", jobId: job.jobId }).then((response) => {
      if (!response.ok) {
        options.log(`validation abort failed: ${response.error.message}`);
        return;
      }
      options.log("validation aborted");
      refresh();
    });
  }

  function rerun(): void {
    if (sessionId === null) return;
    void validationRequest({ type: "validation.run", sessionId }).then((response) => {
      if (!response.ok) {
        options.log(`validation re-run failed: ${response.error.message}`);
        return;
      }
      options.log("validation re-run queued");
      refresh();
    });
  }

  // --- render ----------------------------------------------------------------

  function chipNode(job: ValidationJobView): HTMLElement {
    const wrap = el("div", `validation-chip state-${job.state}`);
    wrap.dataset["jobId"] = job.jobId;
    const verdict = job.receipt?.verdict;
    if (job.state === "completed" && verdict !== undefined) wrap.classList.add(`verdict-${verdict}`);

    const line = el("div", "validation-chip-line");
    const glyph = el("span", "validation-chip-glyph");
    glyph.textContent = glyphFor(job);
    const text = el("span", "validation-chip-text");
    const { text: label, live } = lineText(job);
    text.textContent = label;
    text.title = label;
    line.append(glyph, text);

    if (job.receipt?.superseded === true) {
      // A suffix and a re-run affordance, not a second card.
      const suffix = el("span", "validation-chip-suffix");
      suffix.textContent = "· edited since";
      const again = button("↻", "ghost small validation-chip-rerun");
      again.title = "Re-run validation against the current working set";
      again.addEventListener("click", (event) => {
        event.stopPropagation();
        rerun();
      });
      line.append(suffix, again);
    }
    if (job.state === "parked") {
      const reroute = button("Run on default instead", "small validation-chip-reroute");
      reroute.title = "Re-queue this job on the default runtime. A different policy profile asks first.";
      reroute.addEventListener("click", (event) => {
        event.stopPropagation();
        requeue(job);
      });
      line.append(reroute);
    }
    const caret = el("span", "validation-chip-caret");
    caret.textContent = expanded.has(job.jobId) ? "▾" : "▸";
    line.append(caret);
    line.tabIndex = 0;
    line.setAttribute("role", "button");
    const toggle = (): void => {
      if (expanded.has(job.jobId)) expanded.delete(job.jobId);
      else expanded.add(job.jobId);
      render();
    };
    line.addEventListener("click", toggle);
    line.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (event.target !== line) return;
      event.preventDefault();
      toggle();
    });
    wrap.append(line);

    if (live) {
      tickers.push(() => {
        const next = lineText(job).text;
        text.textContent = next;
        text.title = next;
      });
    }

    if (!expanded.has(job.jobId)) return wrap;

    const body = el("div", "validation-chip-body");
    body.append(receiptRows(job));
    const pending = pendingDeltas.get(job.jobId);
    if (pending !== undefined) body.append(deltaBlock(job, pending));
    const actions = el("div", "validation-chip-actions");
    const again = button("Re-run", "small");
    again.addEventListener("click", () => rerun());
    actions.append(again);
    if (!TERMINAL.has(job.state)) {
      const stop = button("Abort", "ghost small");
      stop.addEventListener("click", () => abort(job));
      actions.append(stop);
    }
    if (job.state === "parked" && pending === undefined) {
      const reroute = button("Run on default instead", "ghost small");
      reroute.addEventListener("click", () => requeue(job));
      actions.append(reroute);
    }
    body.append(actions);
    wrap.append(body);
    return wrap;
  }

  function render(): void {
    tickers = [];
    const visible = visibleJobs();
    root.replaceChildren(...visible.map((job) => chipNode(job)));
    if (tickers.length === 0) {
      if (tickTimer !== undefined) {
        window.clearInterval(tickTimer);
        tickTimer = undefined;
      }
      return;
    }
    if (tickTimer !== undefined) return;
    tickTimer = window.setInterval(() => {
      for (const tick of tickers) tick();
    }, 1_000);
  }

  // Jobs move on the host's clock; the strip heals off the push, never polls.
  onValidationPush("validation.jobChanged", (payload) => {
    const target = (payload as { readonly sessionId?: string }).sessionId;
    if (sessionId === null) return;
    if (target !== undefined && target !== sessionId) return;
    refresh();
  });
  onValidationPush("validation.changed", () => {
    if (sessionId !== null) refresh();
  });

  return { root, setSession, refresh };
}

/** Push kinds land in `PanelPushPayload` with M7a; the cast is confined here. */
function onValidationPush(type: "validation.jobChanged" | "validation.changed", handler: (payload: unknown) => void): void {
  onPush(type as never, handler as never);
}
