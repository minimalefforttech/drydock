/**
 * Shared plan-docs panel helpers.
 *
 * The control panel and the plan-docs editor panel both project plan-doc
 * records for the webview and both send the reviewer's comments back as a
 * revision turn. That logic lives here once so the two hosts stay in lockstep
 * (same summary/detail shapes, same send guards).
 */

import type {
  PlanDocDetail,
  PlanDocRecord,
  PlanDocSummary
} from "@drydock/contracts";
import type { Backend } from "../compositionRoot.js";
import type { IsolatedRunService } from "../services/isolatedRunService.js";

/** Full plan document for a panel; content renders textContent-only. */
export function toPlanDocDetail(record: PlanDocRecord): PlanDocDetail {
  return {
    name: record.name,
    format: record.format,
    revision: record.revision,
    collectedAt: record.collectedAt,
    content: record.content
  };
}

/** Listing entry (no content) for the `planDocs.updated` push. */
export function toPlanDocSummary(record: PlanDocRecord): PlanDocSummary {
  return {
    name: record.name,
    format: record.format,
    revision: record.revision,
    collectedAt: record.collectedAt
  };
}

/** Outcome of a plan-docs send: how many comments were delegated, and the prompt (if any). */
export interface PlanDocsSendResult {
  readonly sentCount: number;
  readonly prompt?: string;
}

/**
 * Composes the reviewer's open plan-doc comments into a revision turn. Returns
 * sentCount 0 with no prompt when there is nothing open to send (the caller
 * treats that as an accepted no-op). When there are comments, the send is
 * guarded like every other chat send: the session must be live with no active
 * turn, otherwise this throws. The caller runs the returned prompt detached.
 */
export async function composePlanDocsSend(
  backend: Extract<Backend, { available: true }>,
  appService: IsolatedRunService,
  sessionId: string
): Promise<PlanDocsSendResult> {
  const composed = await backend.planDocs.composeCommentTurn(sessionId);
  if (composed === null) {
    return { sentCount: 0 };
  }
  if (!appService.isChatSessionLive(sessionId)) {
    throw new Error("This session is no longer live. Start a new chat.");
  }
  if (appService.hasActiveChatTurn(sessionId)) {
    throw new Error("A turn is already in progress for this session.");
  }
  return { sentCount: composed.count, prompt: composed.prompt };
}
