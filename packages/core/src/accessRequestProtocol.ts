/**
 * Agent-side access-request protocol (chat panel redesign, Phase 2).
 *
 * The isolated runtime has no network route to the extension host, so agents
 * cannot call a host tool directly. Instead the session briefing teaches the
 * agent a sentinel format: a fenced block whose info string is
 * `access-request` containing a single JSON object. The host parses final
 * agent text for these blocks and turns each into a pending AccessRequest for
 * human approval. Parsing is deliberately strict — a malformed block is
 * dropped, never guessed at — because every parsed request becomes a
 * human-facing approval prompt for a host mount.
 */

import { sandboxRuntimePath } from "./mountPolicy.js";

export interface ParsedAccessRequest {
  readonly path: string;
  readonly mode: "read-only" | "read-write";
  readonly reason: string;
}

export const ACCESS_REQUEST_FENCE = "access-request";
/** Upper bound on requests honored per agent text, to bound approval spam. */
export const MAX_ACCESS_REQUESTS_PER_TEXT = 3;
const MAX_REQUEST_PATH_LENGTH = 1_024;
const MAX_REQUEST_REASON_LENGTH = 4_000;
const DEFAULT_REASON = "requested by the agent";

const FENCE_PATTERN = /```access-request[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;

export const MEMORY_CANDIDATE_FENCE = "memory-candidate";
/** Mirrors contracts MEMORY_CANDIDATE_MAX_LENGTH / MAX_MEMORY_CANDIDATES_PER_TEXT. */
const MEMORY_FENCE_PATTERN = /```memory-candidate[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;
const MAX_MEMORY_CONTENT_LENGTH = 2_000;
const MAX_MEMORY_PER_TEXT = 3;

/**
 * Extracts plain-text memory candidates from an agent's final text. The body
 * is free text, not JSON: trimmed, non-empty, bounded. Anything else is
 * dropped — every parsed candidate becomes a human review item, never
 * persistent context on its own.
 */
export function extractMemoryCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (const match of text.matchAll(MEMORY_FENCE_PATTERN)) {
    if (candidates.length >= MAX_MEMORY_PER_TEXT) break;
    const content = (match[1] ?? "").trim();
    if (content.length === 0 || content.length > MAX_MEMORY_CONTENT_LENGTH) continue;
    candidates.push(content);
  }
  return candidates;
}

export const QUESTION_FENCE = "question";
/** Upper bound on questions honored per agent text, to bound prompt spam. */
export const MAX_QUESTIONS_PER_TEXT = 4;
const MAX_QUESTION_LENGTH = 500;
const MAX_QUESTION_OPTIONS = 6;
const MAX_QUESTION_OPTION_LENGTH = 200;
const QUESTION_FENCE_PATTERN = /```question[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;

export interface ParsedAgentQuestion {
  readonly question: string;
  /** Agent-suggested answers, first = the agent's recommendation. May be empty. */
  readonly options: readonly string[];
}

/**
 * Extracts well-formed agent questions from final text. Strict like the
 * access parser: malformed or out-of-bounds blocks are dropped, never guessed
 * at — every parsed question becomes a human-facing prompt. Options are
 * optional, deduplicated, and bounded; the first option is presented as the
 * agent's recommendation.
 */
export function extractAgentQuestions(text: string): ParsedAgentQuestion[] {
  const questions: ParsedAgentQuestion[] = [];
  for (const match of text.matchAll(QUESTION_FENCE_PATTERN)) {
    if (questions.length >= MAX_QUESTIONS_PER_TEXT) break;
    const parsed = parseQuestionBody(match[1] ?? "");
    if (parsed !== null) {
      questions.push(parsed);
    }
  }
  return questions;
}

function parseQuestionBody(body: string): ParsedAgentQuestion | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const question = record["question"];
  if (typeof question !== "string") return null;
  const trimmed = question.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_QUESTION_LENGTH) return null;
  const rawOptions = record["options"];
  if (rawOptions !== undefined && !Array.isArray(rawOptions)) return null;
  const options: string[] = [];
  for (const candidate of Array.isArray(rawOptions) ? rawOptions : []) {
    if (options.length >= MAX_QUESTION_OPTIONS) break;
    if (typeof candidate !== "string") return null;
    const option = candidate.trim();
    if (option.length === 0 || option.length > MAX_QUESTION_OPTION_LENGTH) continue;
    if (options.some((existing) => existing.toLowerCase() === option.toLowerCase())) continue;
    options.push(option);
  }
  return { question: trimmed, options };
}

/**
 * Extracts well-formed access requests from an agent's final text. Malformed
 * or out-of-bounds blocks are skipped; at most MAX_ACCESS_REQUESTS_PER_TEXT
 * are returned. Path absoluteness is NOT checked here — that stays with
 * AccessRequestService.createRequest so there is exactly one validation gate.
 */
export function extractAccessRequests(text: string): ParsedAccessRequest[] {
  const requests: ParsedAccessRequest[] = [];
  for (const match of text.matchAll(FENCE_PATTERN)) {
    if (requests.length >= MAX_ACCESS_REQUESTS_PER_TEXT) break;
    const parsed = parseRequestBody(match[1] ?? "");
    if (parsed !== null) {
      requests.push(parsed);
    }
  }
  return requests;
}

function parseRequestBody(body: string): ParsedAccessRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const requestPath = record["path"];
  const mode = record["mode"];
  const reason = record["reason"];
  if (typeof requestPath !== "string" || requestPath.length === 0 || requestPath.length > MAX_REQUEST_PATH_LENGTH) return null;
  if (mode !== "read-only" && mode !== "read-write") return null;
  if (reason !== undefined && (typeof reason !== "string" || reason.length > MAX_REQUEST_REASON_LENGTH)) return null;
  const trimmedReason = typeof reason === "string" ? reason.trim() : "";
  return {
    path: requestPath,
    mode,
    reason: trimmedReason.length === 0 ? DEFAULT_REASON : trimmedReason
  };
}

export interface BriefingMount {
  readonly runtimePath: string;
  readonly mode: "read-only" | "read-write";
  readonly hostDisplayPath?: string;
}

export interface SessionBriefingInput {
  readonly mode: "plan" | "implementation" | "clone";
  readonly mounts: readonly BriefingMount[];
  /** Clone mode: repo names under /workspace/repos, for the briefing text. */
  readonly cloneRepos?: readonly string[];
  /** Present after an approval restart: tells the agent what was granted. */
  readonly grantedNote?: string;
  /** Human-approved team memory, newest first, already capped by the caller. */
  readonly memories?: readonly string[];
}

/**
 * Host preamble prepended to the first prompt of a session (and the first
 * prompt after a backend restart, when mounts may have changed). Kept compact:
 * it is paid on every conversation.
 */
export const HOST_BRIEFING_START = "[host briefing]";
export const HOST_BRIEFING_END = "[end host briefing]";

/**
 * Removes the host-briefing block from a stored user message so it never rides
 * into restored conversation context. The briefing is a host-authored preamble
 * prepended to briefed turns (see applySessionBriefing); replaying it as context
 * would repeat mount/protocol boilerplate and crowd out the actual dialogue.
 */
export function stripHostBriefing(text: string): string {
  const start = text.indexOf(HOST_BRIEFING_START);
  if (start === -1) return text;
  const end = text.indexOf(HOST_BRIEFING_END, start);
  if (end === -1) return text;
  return `${text.slice(0, start)}${text.slice(end + HOST_BRIEFING_END.length)}`.trim();
}

export function buildSessionBriefing(input: SessionBriefingInput): string {
  const lines: string[] = [HOST_BRIEFING_START];
  if (input.mode === "plan") {
    lines.push(
      "Mode: PLAN. Workspace mounts are read-only; produce analysis and plan documents rather than code edits. " +
      "Write plan documents into the `plan/` directory of your workspace as Markdown (`.md`) files — one file per " +
      "document (e.g. plan/product-plan.md, plan/architecture.md); put diagrams in ```mermaid fenced blocks or `.mmd` " +
      "files. The host collects `plan/` after each of your turns for human review, and reviewer comments come back " +
      "as follow-up messages."
    );
  } else if (input.mode === "clone") {
    const repoList = (input.cloneRepos ?? []).map((name) => `repos/${name}`).join(", ");
    lines.push(
      "Mode: CLONE. You are working on disposable git clones of the developer's repositories" +
      (repoList.length > 0 ? ` (${repoList} in your workspace)` : "") +
      " — NOT the live folders. Edit files normally; do not run git push, change git remotes, or expect network access. " +
      "Git metadata is kept by the host, so use the product's sync controls instead of Git commands. " +
      "Your changes reach the developer only when they pull a patch from this clone, and their local edits arrive as " +
      "sync commits. If a sync leaves conflict markers (<<<<<<<) in files, resolving those markers is your job — " +
      "do it before continuing other work."
    );
  } else {
    lines.push("Mode: IMPLEMENTATION. Workspace mounts are writable.");
  }
  if (input.mounts.length === 0) {
    lines.push("Mounts: none beyond your scratch workspace.");
  } else {
    lines.push("Mounts:");
    for (const mount of input.mounts) {
      // The `= host <path>` suffix only earns its place when the sandbox path is
      // NOT just the direct drive-mirror of the host path — for a direct mount the
      // runtime path already encodes the host location, so the remap is noise.
      const isDirectMirror = mount.hostDisplayPath !== undefined
        && sandboxRuntimePath(mount.hostDisplayPath) === mount.runtimePath;
      const hostSuffix = mount.hostDisplayPath !== undefined && !isDirectMirror ? ` = host ${mount.hostDisplayPath}` : "";
      lines.push(`- ${mount.runtimePath} (${mount.mode})${hostSuffix}`);
    }
  }
  lines.push(
    "If you need a host directory that is not mounted, ask for it by emitting a fenced block with the info string " +
    `\`${ACCESS_REQUEST_FENCE}\` containing one JSON object: ` +
    '{"path": "<absolute host path>", "mode": "read-only" | "read-write", "reason": "<why>"}. ' +
    "Then stop and wait; a human approves or denies it, your backend restarts with the mount, and the conversation resumes with the outcome."
  );
  lines.push(
    "To propose a durable insight for future sessions (a convention, gotcha, or decision worth remembering), emit a " +
    `fenced block with the info string \`${MEMORY_CANDIDATE_FENCE}\` containing one short plain-text note. ` +
    "A human reviews it; only approved notes persist."
  );
  lines.push(
    "If a decision is genuinely the developer's to make (a choice you cannot resolve from the code or the request), " +
    `ask by emitting a fenced block with the info string \`${QUESTION_FENCE}\` containing one JSON object: ` +
    '{"question": "<one clear question>", "options": ["<your recommended answer first>", "<alternative>", ...]}. ' +
    "Options are optional but preferred. Finish everything you can without the answer before ending your turn; " +
    "the developer's answer arrives as a follow-up message."
  );
  if (input.memories !== undefined && input.memories.length > 0) {
    lines.push("Team memory (human-approved notes from earlier work):");
    for (const memory of input.memories) {
      lines.push(`- ${memory}`);
    }
  }
  if (input.grantedNote !== undefined) {
    lines.push(input.grantedNote);
  }
  lines.push(HOST_BRIEFING_END);
  return lines.join("\n");
}
