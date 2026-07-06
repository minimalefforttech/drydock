/**
 * Shared normalizer preview caps. Event previews are display slices,
 * never full payloads — subagent results can be file-dump sized and the
 * event store must not become a blob store (design: subagent-workflows.md).
 */

export const SPAWN_PROMPT_PREVIEW_MAX = 500;
export const NODE_RESULT_PREVIEW_MAX = 1024;
export const TOOL_OUTPUT_PREVIEW_MAX = 1024;

export function capPreview(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
