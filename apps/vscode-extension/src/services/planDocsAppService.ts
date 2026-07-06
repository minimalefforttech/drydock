/**
 * Plan-document application facade (chat-panel redesign, Phase 2 — plan mode v2).
 *
 * One truth for collecting, listing, and reviewing the Markdown/mermaid
 * documents a plan-mode agent writes into its workspace `plan/` directory. The
 * session workspace is a host temp dir mounted into the VM, so collection is a
 * bounded host-side read after each plan-mode turn. Block comments reuse the
 * code-review service with the `plan:<docName>` filePath convention; there is
 * no separate plan-doc comment store. No `vscode` imports belong here.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  asId,
  PLAN_DOC_MAX_BYTES,
  PLAN_DOC_MAX_FILES,
  type PlanDocFormat,
  type PlanDocRecord,
  type PlanDocStore,
  type ReviewCommentRecord,
  type SessionId
} from "@drydock/contracts";
import {
  composeReviewCommentTurn,
  type ChatSessionService,
  type Clock,
  type CodeReviewService,
  type ComposedCommentTurn,
  type Logger,
  type ProductEventBus
} from "@drydock/core";

export interface PlanDocsAppServiceOptions {
  readonly logger: Logger;
  readonly clock: Clock;
  readonly store: PlanDocStore;
  readonly chatService: ChatSessionService;
  readonly bus: ProductEventBus;
  readonly review: CodeReviewService;
}

export type { ComposedCommentTurn } from "@drydock/core";

/** File extension → plan-doc format; anything else is not a plan document. */
function formatForName(name: string): PlanDocFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".mmd") || lower.endsWith(".mermaid")) return "mermaid";
  return null;
}

export class PlanDocsAppService {
  constructor(private readonly options: PlanDocsAppServiceOptions) {}

  /**
   * Collects the session's `plan/` directory into the store. Reads bounded to
   * the newest turn's output: accepts only .md (markdown) and .mmd/.mermaid
   * (mermaid) files, keeps the first PLAN_DOC_MAX_FILES in alphabetical order,
   * and skips any file over PLAN_DOC_MAX_BYTES. A row is rewritten only when its
   * content changed (revision + 1); an unchanged file leaves its row untouched;
   * a new file starts at revision 1. Publishes `plan-docs-updated` (with the
   * full current record set) only when at least one row changed.
   *
   * Files deleted from `plan/` do NOT delete rows: a partial write during a turn
   * (the agent rewriting a file, momentarily removing it) must not destroy the
   * review state accumulated against it.
   */
  async collectPlanDocs(sessionId: string): Promise<PlanDocRecord[]> {
    const id = asId<"SessionId">(sessionId);
    const workspacePath = this.options.chatService.getSessionWorkspacePath(id);
    if (workspacePath === null) {
      return [];
    }
    const planDir = path.join(workspacePath, "plan");
    const accepted = await this.readPlanFiles(id, planDir);

    let changed = false;
    for (const file of accepted) {
      const existing = await this.options.store.getDoc(id, file.name);
      if (existing !== null && existing.content === file.content) {
        // Unchanged content: leave the row (and its revision) untouched.
        continue;
      }
      const revision = existing === null ? 1 : existing.revision + 1;
      await this.options.store.upsertDoc({
        sessionId: id,
        name: file.name,
        format: file.format,
        content: file.content,
        revision,
        collectedAt: this.options.clock.isoNow()
      });
      changed = true;
    }

    const current = await this.options.store.listDocs(id);
    if (changed) {
      this.options.bus.publish({ kind: "plan-docs-updated", sessionId: id, docs: current });
    }
    return current;
  }

  listDocs(sessionId: string): Promise<PlanDocRecord[]> {
    return this.options.store.listDocs(asId<"SessionId">(sessionId));
  }

  deleteSessionDocs(sessionId: string): Promise<number> {
    return this.options.store.deleteSessionDocs(asId<"SessionId">(sessionId));
  }

  /**
   * Composes a revision turn from the reviewer's open plan-doc comments via the
   * shared composer (core), filtered to the `plan:` filePath convention.
   * Returns null when there is nothing open to send.
   */
  composeCommentTurn(sessionId: string): Promise<ComposedCommentTurn | null> {
    return composeReviewCommentTurn({
      review: this.options.review,
      sessionId: asId<"SessionId">(sessionId),
      anchorFilter: (filePath) => filePath.startsWith("plan:"),
      header: "[host] Reviewer comments on your plan documents — address them and update the files in plan/:",
      renderLine: (comment) => `- ${docNameOf(comment)} (block ${String(comment.startLine)}): ${comment.body}`
    });
  }

  /**
   * Reads the accepted plan files under `planDir`, applying the collection
   * bounds. A missing directory yields []. Alphabetical order wins the
   * PLAN_DOC_MAX_FILES cap; oversized files are skipped. Names are the path
   * relative to `plan/`, forward-slashed.
   */
  private async readPlanFiles(
    sessionId: SessionId,
    planDir: string
  ): Promise<{ name: string; format: PlanDocFormat; content: string }[]> {
    let candidates: string[];
    try {
      const entries = await readdir(planDir, { recursive: true, withFileTypes: true });
      candidates = entries
        .filter((entry) => entry.isFile() && formatForName(entry.name) !== null)
        .map((entry) => path.relative(planDir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    // Alphabetical order is the tie-breaker for the file cap, so sort first.
    candidates.sort((a, b) => a.localeCompare(b));

    if (candidates.length > PLAN_DOC_MAX_FILES) {
      this.options.logger.warn("plan-doc collection skipped files over the count cap", {
        sessionId,
        limit: PLAN_DOC_MAX_FILES,
        skipped: candidates.slice(PLAN_DOC_MAX_FILES)
      });
      candidates = candidates.slice(0, PLAN_DOC_MAX_FILES);
    }

    const accepted: { name: string; format: PlanDocFormat; content: string }[] = [];
    for (const name of candidates) {
      const format = formatForName(name);
      if (format === null) {
        continue;
      }
      const filePath = path.join(planDir, name);
      const size = (await stat(filePath)).size;
      if (size > PLAN_DOC_MAX_BYTES) {
        this.options.logger.warn("plan-doc collection skipped an oversized file", {
          sessionId,
          name,
          size,
          limit: PLAN_DOC_MAX_BYTES
        });
        continue;
      }
      accepted.push({ name, format, content: await readFile(filePath, "utf8") });
    }
    return accepted;
  }
}

/** The doc name a `plan:<docName>` comment anchors to (or the raw path). */
function docNameOf(comment: ReviewCommentRecord): string {
  return comment.filePath.startsWith("plan:") ? comment.filePath.slice("plan:".length) : comment.filePath;
}
