/**
 * Pure quick-chat decisions (UX overhaul, P4), vscode-free so they are
 * testable outside the extension host - the same host/pure split as
 * workspaceMismatch.ts / workspaceMismatchHost.ts.
 */

import type { ChatModelSelection } from "@drydock/contracts";

/** A task title is a glance, not a paragraph: the first line, trimmed short. */
const TASK_TITLE_MAX = 48;

/** Titles the task from the prompt's first line, ellipsised at the cap. */
export function quickChatTaskTitle(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).find((line) => line.trim().length > 0) ?? prompt;
  const cleaned = firstLine.trim().replace(/\s+/g, " ");
  if (cleaned.length === 0) return "Quick chat";
  return cleaned.length > TASK_TITLE_MAX ? `${cleaned.slice(0, TASK_TITLE_MAX).trimEnd()}…` : cleaned;
}

/**
 * Reads the persisted model, falling back to the first catalog entry. A stored
 * provider that no longer exists in the catalogs is ignored rather than failing
 * the start (providers come and go with configuration).
 */
export function resolveQuickChatModel(
  stored: string | null,
  catalogs: readonly { readonly providerId: string; readonly models: readonly { readonly id: string; readonly isDefault: boolean; readonly hidden: boolean }[] }[]
): ChatModelSelection | undefined {
  const known = new Set(catalogs.map((catalog) => catalog.providerId));
  if (stored !== null) {
    try {
      const parsed: unknown = JSON.parse(stored);
      if (typeof parsed === "object" && parsed !== null) {
        const providerId = (parsed as { providerId?: unknown }).providerId;
        const model = (parsed as { model?: unknown }).model;
        if (typeof providerId === "string" && known.has(providerId)) {
          return { providerId, ...(typeof model === "string" ? { model } : {}) };
        }
      }
    } catch {
      // A corrupt row is not worth a failed start; fall through to the catalog.
    }
  }
  const first = catalogs[0];
  if (first === undefined) return undefined;
  const visible = first.models.filter((model) => !model.hidden);
  const preferred = visible.find((model) => model.isDefault) ?? visible[0];
  return { providerId: first.providerId, ...(preferred === undefined ? {} : { model: preferred.id }) };
}
