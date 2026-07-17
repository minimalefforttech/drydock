/**
 * Chain changesets (ADR 0014).
 *
 * When a subtask's card enters a done-category column ("Review entry"), its
 * clone's outbound patch (refs/sync/base..HEAD - exactly what a full Pull
 * would apply) is captured DURABLY: patch text in the content-addressed blob
 * store, one metadata row per (subtask, repo), latest capture replacing the
 * subtask's prior set. A dependent subtask whose stored `seedMode` is
 * `upstream` then seeds its fresh clone by 3-way-applying its upstream
 * subtasks' unlanded changesets at start - the user's choice, never invented
 * by automation. Pulling a session's work into the local repo marks its rows
 * landed, after which they stop seeding (the content now rides local HEAD).
 *
 * This service owns capture/query/land bookkeeping only; git mechanics stay
 * in CloneSyncService and the clone plumbing stays in IsolatedRunService -
 * both reach this service through the narrow ports below.
 */

import { randomUUID } from "node:crypto";
import { asId } from "@drydock/contracts";
import type { SubtaskId, TaskChangesetRecord, TaskChangesetStore } from "@drydock/contracts";
import type { Clock, Logger, ProductEventBus } from "@drydock/core";

/** Patch-text persistence; the composition root adapts ContentAddressedBlobStore. */
export interface ChangesetBlobPort {
  putText(text: string): Promise<{ readonly sha256: string; readonly bytes: number }>;
  /** null when the blob is missing (pruned store, foreign state dir). */
  readText(sha256: string): Promise<string | null>;
}

/** One clone repo's outbound patch at capture time. */
export interface CapturedClonePatch {
  readonly repoName: string;
  readonly patch: string;
  readonly fileCount: number;
  /** Touched repo-relative paths (landing overlap pre-check, ADR 0014). */
  readonly paths?: readonly string[];
}

/** One patch to 3-way apply into a dependent's fresh clone, by repo name. */
export interface SeedPatch {
  readonly repoName: string;
  /** Names the source in conflict errors ("subtask-x/repo"). */
  readonly label: string;
  readonly patch: string;
}

export interface ChangesetServiceOptions {
  readonly store: TaskChangesetStore;
  readonly blobs: ChangesetBlobPort;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Optional: publishes board-changed so ⎘ chips refresh across surfaces. */
  readonly bus?: ProductEventBus;
  /** Test seam; defaults to a random id. */
  readonly changesetId?: () => string;
}

export class ChangesetService {
  constructor(private readonly options: ChangesetServiceOptions) {}

  /**
   * Replaces the subtask's capture set with the given patches (empty input
   * clears it - a re-done subtask that now produces no changes must not keep
   * seeding stale ones). Empty patch texts are skipped.
   */
  async captureForSubtask(input: {
    readonly taskId: string;
    readonly subtaskId: string;
    readonly sessionId: string;
    readonly patches: readonly CapturedClonePatch[];
  }): Promise<TaskChangesetRecord[]> {
    const capturedAt = this.options.clock.isoNow();
    const records: TaskChangesetRecord[] = [];
    for (const patch of input.patches) {
      if (patch.patch.length === 0) continue;
      const stored = await this.options.blobs.putText(patch.patch);
      records.push({
        changesetId: this.options.changesetId?.() ?? `changeset-${randomUUID().slice(0, 12)}`,
        taskId: asId<"TaskId">(input.taskId),
        subtaskId: asId<"SubtaskId">(input.subtaskId),
        sessionId: asId<"SessionId">(input.sessionId),
        repoName: patch.repoName,
        patchSha256: stored.sha256,
        patchBytes: stored.bytes,
        fileCount: patch.fileCount,
        ...(patch.paths === undefined ? {} : { paths: patch.paths }),
        capturedAt
      });
    }
    await this.options.store.replaceForSubtask(asId<"SubtaskId">(input.subtaskId), records);
    this.options.logger.info("changeset capture", {
      subtaskId: input.subtaskId,
      sessionId: input.sessionId,
      repos: records.map((record) => record.repoName).join(",") || "(none)"
    });
    this.options.bus?.publish({ kind: "board-changed" });
    return records;
  }

  /**
   * The unlanded upstream patches a dependent seeds from, in the given
   * upstream order (then capture order per subtask). A row whose blob has
   * vanished is a hard error - the user explicitly chose upstream seeding,
   * so silently seeding less would be dishonest.
   */
  async seedPatchesFor(upstreamSubtaskIds: readonly string[]): Promise<SeedPatch[]> {
    const ids = upstreamSubtaskIds.map((id) => asId<"SubtaskId">(id));
    const rows = await this.options.store.listForSubtasks(ids);
    const order = new Map<SubtaskId, number>(ids.map((id, index) => [id, index]));
    const unlanded = rows
      .filter((row) => row.landedAt === undefined)
      .sort((a, b) => (order.get(a.subtaskId) ?? 0) - (order.get(b.subtaskId) ?? 0));
    const seeds: SeedPatch[] = [];
    for (const row of unlanded) {
      const patch = await this.options.blobs.readText(row.patchSha256);
      if (patch === null) {
        throw new Error(
          `Upstream changeset ${row.changesetId} (${row.subtaskId}/${row.repoName}) is missing its patch blob; re-run the upstream subtask or switch this subtask's seed to local.`
        );
      }
      seeds.push({ repoName: row.repoName, label: `${row.subtaskId as string}/${row.repoName}`, patch });
    }
    return seeds;
  }

  /** Subtask ids (among the given) holding at least one unlanded changeset. */
  async unlandedSubtaskIds(subtaskIds: readonly string[]): Promise<ReadonlySet<string>> {
    return new Set(await this.options.store.listUnlandedSubtaskIds(subtaskIds.map((id) => asId<"SubtaskId">(id))));
  }

  /** Every unlanded row - the fleet Landing drawer's source (ADR 0014). */
  listUnlanded(): Promise<TaskChangesetRecord[]> {
    return this.options.store.listUnlanded();
  }

  /**
   * Marks a session's captured rows landed after its work was pulled into
   * the local repo (full pull = every repo; repoName narrows to one).
   */
  async markLandedBySession(sessionId: string, repoName?: string): Promise<number> {
    const landed = await this.options.store.markLandedBySession(asId<"SessionId">(sessionId), this.options.clock.isoNow(), repoName);
    if (landed > 0) {
      this.options.logger.info("changesets landed", { sessionId, rows: landed });
      this.options.bus?.publish({ kind: "board-changed" });
    }
    return landed;
  }
}
