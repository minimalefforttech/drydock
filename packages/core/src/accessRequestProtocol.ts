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

export const PREVIEW_FENCE = "preview";
/** Upper bound on preview announcements honored per agent text. */
export const MAX_PREVIEWS_PER_TEXT = 2;
const MAX_PREVIEW_TITLE_LENGTH = 100;
const MAX_PREVIEW_PATH_LENGTH = 200;
const PREVIEW_FENCE_PATTERN = /```preview[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;

/** One agent-announced in-sandbox HTTP preview server (ADR 0017). */
export interface ParsedPreviewAnnouncement {
  readonly port: number;
  readonly path: string;
  readonly title: string;
}

/**
 * Extracts well-formed preview announcements from final text. Strict like the
 * other fences: malformed or out-of-bounds blocks are dropped, never guessed.
 */
export function extractPreviewAnnouncements(text: string): ParsedPreviewAnnouncement[] {
  const previews: ParsedPreviewAnnouncement[] = [];
  for (const match of text.matchAll(PREVIEW_FENCE_PATTERN)) {
    if (previews.length >= MAX_PREVIEWS_PER_TEXT) break;
    let value: unknown;
    try {
      value = JSON.parse(match[1] ?? "");
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const port = record["port"];
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) continue;
    const rawPath = record["path"];
    const path = typeof rawPath === "string" && rawPath.startsWith("/") && rawPath.length <= MAX_PREVIEW_PATH_LENGTH
      ? rawPath
      : "/";
    const rawTitle = record["title"];
    const title = typeof rawTitle === "string" && rawTitle.trim().length > 0
      ? rawTitle.trim().slice(0, MAX_PREVIEW_TITLE_LENGTH)
      : "Preview";
    previews.push({ port, path, title });
  }
  return previews;
}

export const QUESTION_FENCE = "question";
/** Upper bound on questions honored per agent text, to bound prompt spam. */
export const MAX_QUESTIONS_PER_TEXT = 4;
const MAX_QUESTION_LENGTH = 500;
const MAX_QUESTION_OPTIONS = 6;
const MAX_QUESTION_OPTION_LENGTH = 200;
const QUESTION_FENCE_PATTERN = /```question[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;

const MAX_QUESTION_STEPS = 10;
const MAX_QUESTION_STEP_LENGTH = 300;
const MAX_QUESTION_IMAGES = 3;
const MAX_QUESTION_IMAGE_PATH_LENGTH = 300;

/** One ordered step of a manual-check question, optionally illustrated. */
export interface ParsedQuestionStep {
  readonly text: string;
  /** Absolute runtime path (/workspace/…) the app layer resolves to bytes. */
  readonly imagePath?: string;
}

export interface ParsedAgentQuestion {
  readonly question: string;
  /** Agent-suggested answers, first = the agent's recommendation. May be empty. */
  readonly options: readonly string[];
  /** ADR 0016: plain question (absent) vs a step-by-step manual check. */
  readonly kind?: "manual-check";
  readonly steps?: readonly ParsedQuestionStep[];
  /** Illustration runtime paths (/workspace/…), resolved app-side. */
  readonly imagePaths?: readonly string[];
  /** Subtask whose verify gate this check satisfies. */
  readonly subtaskId?: string;
}

/** Accepts only absolute in-sandbox image paths — never host paths. */
function isRuntimeImagePath(candidate: unknown): candidate is string {
  return typeof candidate === "string"
    && candidate.length <= MAX_QUESTION_IMAGE_PATH_LENGTH
    && candidate.startsWith("/")
    && !candidate.includes("..")
    && /\.(png|jpe?g|gif|webp|bmp)$/i.test(candidate);
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

  // ADR 0016 extensions — every field optional, bounded, dropped when malformed
  // (the base question still stands; extras never make a block unparseable).
  const kind = record["kind"] === "manual-check" ? ("manual-check" as const) : undefined;
  const steps: ParsedQuestionStep[] = [];
  const rawSteps = record["steps"];
  if (Array.isArray(rawSteps)) {
    for (const candidate of rawSteps) {
      if (steps.length >= MAX_QUESTION_STEPS) break;
      if (typeof candidate === "string") {
        const text = candidate.trim();
        if (text.length > 0 && text.length <= MAX_QUESTION_STEP_LENGTH) steps.push({ text });
      } else if (typeof candidate === "object" && candidate !== null) {
        const step = candidate as Record<string, unknown>;
        const text = typeof step["text"] === "string" ? step["text"].trim() : "";
        if (text.length === 0 || text.length > MAX_QUESTION_STEP_LENGTH) continue;
        const imagePath = step["image"];
        steps.push({ text, ...(isRuntimeImagePath(imagePath) ? { imagePath } : {}) });
      }
    }
  }
  const imagePaths: string[] = [];
  const rawImages = record["images"];
  if (Array.isArray(rawImages)) {
    for (const candidate of rawImages) {
      if (imagePaths.length >= MAX_QUESTION_IMAGES) break;
      if (isRuntimeImagePath(candidate)) imagePaths.push(candidate);
    }
  }
  const subtaskId = typeof record["subtaskId"] === "string" && record["subtaskId"].length <= 64
    ? record["subtaskId"]
    : undefined;

  return {
    question: trimmed,
    options,
    ...(kind === undefined ? {} : { kind }),
    ...(steps.length === 0 ? {} : { steps }),
    ...(imagePaths.length === 0 ? {} : { imagePaths }),
    ...(subtaskId === undefined ? {} : { subtaskId })
  };
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
    "the developer's answer arrives as a follow-up message. " +
    'Optional fields: "images": ["/workspace/<path>.png", ...] attaches up to 3 images you produced (screenshots, renders, diagrams) ' +
    'so the developer sees what you see. For checks that need a human to run steps outside the sandbox, add ' +
    '"kind": "manual-check" with "steps": ["<step 1>", {"text": "<step 2>", "image": "/workspace/<path>.png"}, ...] ' +
    '(≤10 steps) and, when the check gates a subtask, its "subtaskId" — the developer can stamp it Verified from the answer.'
  );
  lines.push(
    "UI/UX PROTOTYPING IS WEB-ONLY, even when the real target is Qt, Slate (Unreal), or another native toolkit: " +
    "build the prototype as HTML/CSS/JS, start a plain HTTP server on any localhost port inside your sandbox, and announce it by emitting a fenced block " +
    `with the info string \`${PREVIEW_FENCE}\` containing one JSON object: {"port": <port>, "path": "/", "title": "<short name>"}. ` +
    "The developer gets a live, clickable proxy of your server. Theme stylesheets that make a web prototype feel like the target application are provided at " +
    "/workspace/.drydock-themes/ (qt-dark.css, slate-dark.css, vscode-dark.css, clean-light.css, plus any studio-registered themes) — copy one next to your " +
    "prototype and link it instead of hand-rolling native-looking chrome. Do not attempt native GUI toolkits in the sandbox; there is no display."
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
