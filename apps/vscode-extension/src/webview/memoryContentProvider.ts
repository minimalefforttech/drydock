/**
 * Read-only virtual documents for approved memory candidates.
 *
 * Clicking a memory row in the Work tab opens a small markdown document
 * summarizing that candidate - content lives only in the memory-candidate
 * store, there is no on-disk path for it. This provider serves that content
 * under the `drydock-memory` scheme; the URI carries the memoryCandidateId so
 * the resolver can fetch the right record.
 */

import * as vscode from "vscode";
import type { MemoryService } from "@drydock/work-management";

export const MEMORY_SCHEME = "drydock-memory";

/**
 * Builds a stable virtual URI for one memory candidate. The id rides in the
 * query; `Uri.from` percent-encodes it.
 */
export function memoryUri(memoryCandidateId: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: MEMORY_SCHEME,
    path: "/memory",
    query: `memoryCandidateId=${encodeURIComponent(memoryCandidateId)}`
  });
}

export class MemoryContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly memory: MemoryService) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const memoryCandidateId = new URLSearchParams(uri.query).get("memoryCandidateId");
    if (memoryCandidateId === null) {
      return "";
    }
    const candidate = await this.memory.getCandidate(memoryCandidateId);
    if (candidate === null) {
      return "# Drydock memory\n\nThis memory candidate was not found.\n";
    }
    const lines: string[] = ["# Drydock memory", "", candidate.content, "", "## Metadata", ""];
    lines.push(`- Status: ${candidate.status}`);
    lines.push(`- Created: ${candidate.createdAt}`);
    if (candidate.resolvedAt !== undefined) {
      lines.push(`- Resolved: ${candidate.resolvedAt}`);
    }
    lines.push(`- Source session: ${candidate.sessionId}`);
    return `${lines.join("\n")}\n`;
  }
}
