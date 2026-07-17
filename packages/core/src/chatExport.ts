/**
 * Chat session export builders.
 *
 * Projects a session's stored events into clipboard-ready text: a trimmed
 * chat log (the user/assistant dialogue plus files touched - no commands,
 * reasoning, or host briefing) and the fixed-structure prompt used to ask an
 * agent for an AI summary of that log. Pure functions over StoredEvent[];
 * no storage or vscode imports.
 */

import type { ChatSessionRecord, StoredEvent } from "@drydock/contracts";
import { stripHostBriefing } from "./accessRequestProtocol.js";
import { sandboxRuntimePath } from "./mountPolicy.js";

/** Runtime prefix for clone-mode repos (see accessRequestProtocol briefing). */
const CLONE_REPOS_PREFIX = "/workspace/repos/";
const WORKSPACE_PREFIX = "/workspace/";

interface DialogueEntry {
  readonly role: "User" | "Assistant";
  readonly text: string;
}

interface TouchedFile {
  /** Project name when the path resolved into a mounted root or clone repo. */
  readonly project?: string;
  /** Path relative to its project root (or trimmed runtime path when none). */
  readonly rel: string;
  readonly annotation?: string;
}

/**
 * The trimmed chat log: session header, the user/assistant dialogue (host
 * briefing stripped, reasoning/commands/tool chatter dropped), and a deduped
 * files-touched list using the shortest unique trailing path segments,
 * prefixed with the project name when the session mounted several projects.
 */
export function buildChatLog(session: ChatSessionRecord, events: readonly StoredEvent[]): string {
  const dialogue = collectDialogue(events);
  const files = collectTouchedFiles(events, session.workspaceRoots ?? []);
  const lines: string[] = [`# ${session.title}`, ""];
  lines.push(metaLine(session));
  const projects = [...new Set(files.map((file) => file.project).filter((name): name is string => name !== undefined))];
  if (projects.length > 1) {
    lines.push(`Projects: ${projects.join(", ")}`);
  }
  lines.push("", "## Conversation", "");
  if (dialogue.length === 0) {
    lines.push("(no messages)");
  }
  for (const entry of dialogue) {
    lines.push(`${entry.role}:`, entry.text, "");
  }
  const labels = fileLabels(files, projects.length > 1);
  if (labels.length > 0) {
    while (lines[lines.length - 1] === "") lines.pop();
    lines.push("", "## Files touched", "");
    for (const label of labels) {
      lines.push(`- ${label}`);
    }
  }
  while (lines[lines.length - 1] === "") lines.pop();
  return `${lines.join("\n")}\n`;
}

/**
 * Character budget for the transcript embedded in a summary prompt. Oversized
 * logs elide the MIDDLE of the conversation: the header/opening frames the
 * goal and the tail holds the latest state, so both survive.
 */
export const SUMMARY_TRANSCRIPT_MAX = 120_000;

/**
 * The fixed-structure summarization prompt. The transcript is the trimmed
 * chat log from buildChatLog, so the model sees exactly what the user would
 * copy - nothing hidden, nothing extra.
 */
export function buildSummaryPrompt(chatLog: string): string {
  return [
    "You are summarizing a coding-agent chat session so someone else can pick up the work.",
    "Write ONLY the summary, in exactly this markdown structure (keep every heading; write \"None.\" under a heading when there is nothing to report):",
    "",
    "## Overview",
    "One short paragraph: what the session set out to do and where it ended up.",
    "",
    "## What was done",
    "- Concrete changes and actions, most important first.",
    "",
    "## Key decisions",
    "- Decisions made along the way and why.",
    "",
    "## Files touched",
    "- Copy the transcript's files-touched list (short paths are fine).",
    "",
    "## Open items",
    "- Unfinished work, known issues, and agreed next steps.",
    "",
    "Do not run commands or edit files for this. Base the summary only on the transcript between the markers.",
    "",
    "--- transcript start ---",
    elideMiddle(chatLog, SUMMARY_TRANSCRIPT_MAX),
    "--- transcript end ---",
    "",
    "Respond with only the summary markdown."
  ].join("\n");
}

// MARK: Dialogue

function collectDialogue(events: readonly StoredEvent[]): DialogueEntry[] {
  const entries: DialogueEntry[] = [];
  for (const event of events) {
    if (event.eventType === "user.message") {
      const raw = event.payload["text"];
      if (typeof raw === "string" && raw.length > 0) {
        // Same trim as chatSessionService.contextMessages: the briefing is
        // host boilerplate, not something the user typed.
        const text = stripHostBriefing(raw);
        if (text.length > 0) {
          entries.push({ role: "User", text });
        }
      }
      continue;
    }
    if (event.eventType !== "agent.text") {
      continue;
    }
    const payload = event.payload as { readonly text?: unknown; readonly final?: unknown };
    if (payload.final === true && typeof payload.text === "string" && payload.text.length > 0) {
      entries.push({ role: "Assistant", text: payload.text });
    }
  }
  // Merge consecutive same-role entries (a turn often lands as several final
  // texts): one role header, texts separated by a blank line - the exported
  // log reads cleaner and spends fewer tokens on repeated "Assistant:" blocks.
  const merged: DialogueEntry[] = [];
  for (const entry of entries) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.role === entry.role) {
      merged[merged.length - 1] = { role: last.role, text: `${last.text}\n\n${entry.text}` };
    } else {
      merged.push(entry);
    }
  }
  return merged;
}

function metaLine(session: ChatSessionRecord): string {
  const date = session.createdAt.slice(0, 10);
  const parts = [date, session.providerId];
  if (session.model !== undefined && session.model.length > 0) {
    parts.push(session.model);
  }
  return parts.join(" · ");
}

// MARK: Files touched

function collectTouchedFiles(events: readonly StoredEvent[], workspaceRoots: readonly string[]): TouchedFile[] {
  const roots = workspaceRoots.map((root) => ({
    prefix: `${sandboxRuntimePath(root)}/`,
    project: basename(root)
  }));
  interface Seen {
    readonly project?: string;
    readonly rel: string;
    firstKind: string;
    lastKind: string;
  }
  const seen = new Map<string, Seen>();
  for (const event of events) {
    if (event.eventType !== "agent.file_edit") {
      continue;
    }
    const path = event.payload["path"];
    const kind = event.payload["changeKind"];
    if (typeof path !== "string" || path.length === 0 || typeof kind !== "string") {
      continue;
    }
    const existing = seen.get(path);
    if (existing !== undefined) {
      existing.lastKind = kind;
      continue;
    }
    seen.set(path, { ...resolveProject(path, roots), firstKind: kind, lastKind: kind });
  }
  return [...seen.values()].map((entry) => {
    const annotation = annotationFor(entry.firstKind, entry.lastKind);
    return {
      rel: entry.rel,
      ...(entry.project === undefined ? {} : { project: entry.project }),
      ...(annotation === undefined ? {} : { annotation })
    };
  });
}

/**
 * Maps a runtime-side path into (project, relative path). Mounted roots use
 * the sbx drive-letter mirror of the host path (see sandboxRuntimePath);
 * clone repos live under /workspace/repos/<name>. Matching is
 * case-insensitive because the mirrors derive from Windows host paths.
 */
function resolveProject(
  runtimePath: string,
  roots: readonly { readonly prefix: string; readonly project: string }[]
): { readonly project?: string; readonly rel: string } {
  const lower = runtimePath.toLowerCase();
  for (const root of roots) {
    if (lower.startsWith(root.prefix.toLowerCase())) {
      return { project: root.project, rel: runtimePath.slice(root.prefix.length) };
    }
  }
  if (lower.startsWith(CLONE_REPOS_PREFIX)) {
    const rest = runtimePath.slice(CLONE_REPOS_PREFIX.length);
    const slash = rest.indexOf("/");
    if (slash > 0) {
      return { project: rest.slice(0, slash), rel: rest.slice(slash + 1) };
    }
  }
  if (lower.startsWith(WORKSPACE_PREFIX)) {
    return { rel: runtimePath.slice(WORKSPACE_PREFIX.length) };
  }
  return { rel: runtimePath.replace(/^\/+/, "") };
}

/**
 * Net annotation across a file's edit sequence: a file created in this
 * session stays "new" through later updates; the last kind wins otherwise.
 * Plain updates carry no annotation - they are the common case and the list
 * should stay token-lean.
 */
function annotationFor(firstKind: string, lastKind: string): string | undefined {
  if (lastKind === "delete") return "deleted";
  if (firstKind === "add") return "new";
  if (lastKind === "rename") return "renamed";
  return undefined;
}

/**
 * Emits one display label per file: the shortest trailing-segment suffix of
 * its relative path that is unique across the whole list (project-prefixed
 * when the session touched several projects). Colliding labels grow one
 * segment at a time until they differ or both hit full length.
 */
function fileLabels(files: readonly TouchedFile[], multiProject: boolean): string[] {
  const entries = files.map((file) => ({
    file,
    segments: file.rel.split("/").filter((part) => part.length > 0),
    take: 1
  }));
  for (const entry of entries) {
    if (entry.segments.length === 0) {
      entry.segments = [entry.file.rel];
    }
  }
  const emitted = (entry: (typeof entries)[number]): string => {
    const suffix = entry.segments.slice(entry.segments.length - entry.take).join("/");
    return multiProject && entry.file.project !== undefined ? `${entry.file.project}/${suffix}` : suffix;
  };
  for (;;) {
    const groups = new Map<string, (typeof entries)[number][]>();
    for (const entry of entries) {
      const label = emitted(entry);
      const group = groups.get(label);
      if (group === undefined) {
        groups.set(label, [entry]);
      } else {
        group.push(entry);
      }
    }
    let extended = false;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (const entry of group) {
        if (entry.take < entry.segments.length) {
          entry.take += 1;
          extended = true;
        }
      }
    }
    if (!extended) {
      break;
    }
  }
  return entries
    .map((entry) => `${emitted(entry)}${entry.file.annotation === undefined ? "" : ` (${entry.file.annotation})`}`)
    .sort();
}

function basename(root: string): string {
  const normalized = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

// MARK: Prompt sizing

function elideMiddle(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  const removed = text.length - head - tail;
  return `${text.slice(0, head)}\n[... ${String(removed)} characters elided ...]\n${text.slice(text.length - tail)}`;
}
