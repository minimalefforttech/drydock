/**
 * Read-only virtual documents for baseline file content.
 *
 * The diff editor's left pane shows a file's state at baseline capture, which
 * lives only in the content-addressed blob store — there is no on-disk path for
 * it. This provider serves that content under the `drydock-baseline` scheme;
 * the URI carries the baselineId and the root-relative path so the resolver can
 * fetch the right blob and VS Code can pick a language from the path's suffix.
 */

import * as vscode from "vscode";
import type { WorkspaceReviewAppService } from "../services/workspaceReviewAppService.js";

export const BASELINE_SCHEME = "drydock-baseline";

/**
 * Builds a stable virtual URI for one baseline file. The root-relative path is
 * the URI path (so `.ts` etc. drives syntax highlighting) and the baselineId
 * rides in the query. `Uri.from` percent-encodes both, so Windows separators
 * and spaces survive the round-trip.
 */
export function baselineUri(baselineId: string, relativePath: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: BASELINE_SCHEME,
    // A leading slash keeps this a valid absolute-path URI across platforms.
    path: relativePath.startsWith("/") ? relativePath : `/${relativePath}`,
    query: `baselineId=${encodeURIComponent(baselineId)}`
  });
}

export class BaselineContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly resolve: WorkspaceReviewAppService) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const baselineId = new URLSearchParams(uri.query).get("baselineId");
    if (baselineId === null) {
      return "";
    }
    // uri.path is the decoded root-relative path with a leading slash we added.
    const relativePath = uri.path.replace(/^\//, "");
    const text = await this.resolve.readBaselineFileText(baselineId, relativePath);
    // null means an unknown baseline; an empty left pane is the safe rendering.
    return text ?? "";
  }
}
