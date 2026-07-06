/**
 * Memory-candidate service.
 *
 * Agents propose durable insights; each parsed note is captured as a pending
 * candidate, inert until a human approves it. Approved candidates feed future
 * session briefings. Persistence lives in the store; capture dedupe, the
 * approve/reject state machine, and the briefing projection live here.
 */

import { asId } from "@drydock/contracts";
import type {
  MemoryCandidateRecord,
  MemoryCandidateStatus,
  MemoryCandidateStore,
  SessionId
} from "@drydock/contracts";
import type { Clock, IdGenerator } from "@drydock/core";

export interface MemoryServiceOptions {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly store: MemoryCandidateStore;
}

export class MemoryService {
  constructor(private readonly options: MemoryServiceOptions) {}

  /**
   * Captures agent-proposed notes as pending candidates. Each text is trimmed;
   * a text whose trimmed content matches an existing candidate of ANY status is
   * skipped (dedupe against re-emitting agents and re-approvals alike). Returns
   * only the records actually created, newest text last (insertion order).
   */
  async captureCandidates(sessionId: string, texts: readonly string[]): Promise<MemoryCandidateRecord[]> {
    if (texts.length === 0) {
      return [];
    }
    const session = asId<"SessionId">(sessionId);
    const seen = new Set(
      (await this.options.store.listCandidates()).map((candidate) => candidate.content)
    );
    const created: MemoryCandidateRecord[] = [];
    for (const text of texts) {
      const content = text.trim();
      if (content.length === 0 || seen.has(content)) {
        continue;
      }
      const record: MemoryCandidateRecord = {
        memoryCandidateId: this.options.ids.memoryCandidateId(),
        sessionId: session,
        content,
        status: "pending",
        createdAt: this.options.clock.isoNow()
      };
      await this.options.store.insertCandidate(record);
      // Guard against duplicates within this same batch too.
      seen.add(content);
      created.push(record);
    }
    return created;
  }

  /**
   * Approves or rejects a pending candidate. Re-resolving an already-resolved
   * candidate is rejected so an approval/rejection cannot be flipped after the
   * fact. Returns the resolved record.
   */
  async resolve(memoryCandidateId: string, approve: boolean): Promise<MemoryCandidateRecord> {
    const id = asId<"MemoryCandidateId">(memoryCandidateId);
    const existing = await this.options.store.getCandidate(id);
    if (existing === null) {
      throw new Error(`Memory candidate ${memoryCandidateId} was not found.`);
    }
    if (existing.status !== "pending") {
      throw new Error(`Memory candidate ${memoryCandidateId} is already ${existing.status}.`);
    }
    const status: MemoryCandidateStatus = approve ? "approved" : "rejected";
    const resolvedAt = this.options.clock.isoNow();
    await this.options.store.updateCandidateStatus(id, status, resolvedAt);
    const resolved = await this.options.store.getCandidate(id);
    if (resolved === null) {
      throw new Error(`Memory candidate ${memoryCandidateId} vanished during resolution.`);
    }
    return resolved;
  }

  listCandidates(status?: MemoryCandidateStatus): Promise<MemoryCandidateRecord[]> {
    return this.options.store.listCandidates(status);
  }

  /** Newest-first approved contents for briefings, capped at `limit`. */
  async listApprovedContents(limit: number): Promise<string[]> {
    const approved = await this.options.store.listCandidates("approved");
    return approved.slice(0, limit).map((candidate) => candidate.content);
  }
}
