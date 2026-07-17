/**
 * Shared chat message rendering (ADR 0012, P3 extraction).
 *
 * The DOM for one transcript row - user card, full-width assistant markdown,
 * system notices with their action buttons, coalesced command rows - plus the
 * working / reconnecting / thinking indicators. Both the Chat tab and the
 * Planner rail render through these, so a bubble fixed once is fixed
 * everywhere; everything surface-specific arrives via MessageRowContext
 * (author label, link opening, mermaid rendering, subagent group blocks,
 * retry/sign-in handlers), with safe defaults for surfaces that skip a
 * capability.
 *
 * SECURITY: every dynamic string renders via textContent - NEVER innerHTML.
 * Inline markdown is parsed structurally; raw HTML in agent output stays
 * literal text.
 */

import { button, el, formatTime, iconButton } from "../components.js";
import { splitBlocks, type DocBlock } from "../markdownBlocks.js";
import { buildProtocolNote, isProtocolFenceLanguage } from "./protocolNotes.js";
import type { AgentGroup, ChatMessage } from "./transcriptModel.js";

export interface MessageRowContext {
  /** Assistant meta label, e.g. "Orchestrator · GPT-5.5". */
  authorLabel(): string;
  /** Markdown link activation: file refs open in the editor, http(s) external. */
  openLink(href: string): void;
  /** Copy-to-clipboard for code figures; default uses the navigator clipboard. */
  copyText?(text: string, copyButton: HTMLButtonElement): void;
  /** Whether a turn is live NOW; absent = assume live (planner replay etc.). */
  turnActive?(): boolean;
  /** Mermaid fence renderer; default shows the source as a labeled code figure. */
  renderMermaid?(block: DocBlock): HTMLElement;
  /** User message body (host-briefing disclosure, file tokens); default is plain text. */
  renderUserBody?(container: HTMLElement, text: string): void;
  /** role "group" rows; default is the compact group summary below. */
  renderGroup?(nodeId: string): HTMLElement;
  /** Groups store for the default group renderer. */
  groups?(): Record<string, AgentGroup>;
  onRetry?(): void;
  onSignIn?(): void;
  onAuthenticate?(providerId?: string): void;
  /** False when interactive credential flows are intentionally unavailable. */
  authenticationAvailable?(): boolean;
  /** Label for the authenticate button, e.g. "Authenticate Claude". */
  authenticateLabel?(providerId?: string): string;
}

export function chatMessageRow(message: ChatMessage, ctx: MessageRowContext): HTMLElement {
  if (message.role === "group") {
    if (message.nodeId === undefined) return el("div", "chat-message role-group empty");
    if (ctx.renderGroup !== undefined) return ctx.renderGroup(message.nodeId);
    return defaultGroupRow(message.nodeId, ctx.groups?.()[message.nodeId]);
  }
  if (message.role === "system") {
    // A visible in-transcript notice: turn errors, stopped/empty turns, and
    // send failures that used to vanish into the Diagnostics feed.
    const row = el("div", `chat-message role-system${message.tone === "error" ? " tone-error" : ""}`);
    const body = el("div", "chat-system-body");
    body.textContent = message.text;
    row.append(body);
    if (message.signIn === true && ctx.onSignIn !== undefined && ctx.authenticationAvailable?.() !== false) {
      const signInButton = button("Sign in to Docker Sandbox", "small primary chat-system-signin");
      signInButton.addEventListener("click", () => ctx.onSignIn?.());
      row.append(signInButton);
    }
    if (message.authenticate === true && ctx.onAuthenticate !== undefined && ctx.authenticationAvailable?.() !== false) {
      const label = ctx.authenticateLabel?.(message.authProviderId) ?? "Authenticate";
      const authButton = button(label, "small primary chat-system-signin");
      authButton.addEventListener("click", () => {
        authButton.disabled = true;
        ctx.onAuthenticate?.(message.authProviderId);
        window.setTimeout(() => { authButton.disabled = false; }, 2_000);
      });
      row.append(authButton);
    }
    if (message.retry === true && ctx.onRetry !== undefined) {
      const retryButton = button("Retry", "small chat-system-retry");
      retryButton.addEventListener("click", () => ctx.onRetry?.());
      row.append(retryButton);
    }
    return row;
  }
  if (message.role === "command") {
    // A command still "started" when NO turn is live never completed - the
    // turn died (cancelled/crashed). Show that honestly instead of a forever
    // "running…" on a dead session.
    const interrupted = message.commandStatus === "started" && ctx.turnActive?.() === false;
    const row = el("div", `chat-message role-command status-${interrupted ? "interrupted" : message.commandStatus ?? "started"}`);
    const commandLine = el("div", "chat-command-line");
    const promptGlyph = el("span", "chat-command-prompt");
    promptGlyph.textContent = "$";
    const commandText = el("span", "chat-command-text");
    commandText.textContent = message.text;
    const statusChip = el("span", "chat-command-status");
    statusChip.textContent = interrupted
      ? "interrupted"
      : message.commandStatus === "started"
        ? "running…"
        : message.commandStatus === "failed"
        ? `failed${message.commandExit === undefined ? "" : ` · exit ${String(message.commandExit)}`}`
        : `exit ${message.commandExit === undefined ? "0" : String(message.commandExit)}`;
    commandLine.append(promptGlyph, commandText, statusChip);
    row.append(commandLine);
    if (message.commandOutput !== undefined && message.commandOutput.length > 0) {
      const lineCount = message.commandOutput.replace(/\n+$/, "").split("\n").length;
      const output = document.createElement("details");
      output.className = "chat-command-output";
      // Short output shows inline; anything over 3 lines collapses by default.
      output.open = lineCount <= 3;
      const summary = document.createElement("summary");
      summary.textContent = lineCount <= 3 ? "output" : `output (${String(lineCount)} lines)`;
      const pre = document.createElement("pre");
      pre.textContent = message.commandOutput;
      output.append(summary, pre);
      row.append(output);
    }
    return row;
  }
  const streaming = message.streaming === true;
  const row = el("div", `chat-message role-${message.role}${streaming ? " streaming" : ""}`);
  const meta = el("div", "chat-meta");
  meta.textContent = `${message.role === "user" ? "You" : ctx.authorLabel()} · ${formatTime(message.createdAt)}`;
  row.append(meta);

  if (message.role === "user") {
    const body = el("div", "chat-user-body");
    if (ctx.renderUserBody !== undefined) {
      ctx.renderUserBody(body, message.text);
    } else {
      body.textContent = message.text;
    }
    row.append(body);
  } else {
    const body = el("div", "chat-assistant-body");
    // Structural markdown: mermaid fences render as sanitized diagrams when
    // the surface supplies a renderer; the source figure otherwise. Protocol
    // fences (access-request/question/preview/memory) render as collapsed
    // one-line notes - their raw JSON is host plumbing, not reading material.
    for (const block of splitBlocks(message.text, "markdown")) {
      body.append(assistantBlock(block, ctx));
    }
    if (streaming) body.append(el("span", "stream-cursor"));
    row.append(body);
  }
  return row;
}

/** Compact fallback for role "group" rows on surfaces without the Agents lens. */
function defaultGroupRow(nodeId: string, group: AgentGroup | undefined): HTMLElement {
  const details = document.createElement("details");
  details.className = `agent-group agent-group-compact status-${group?.status ?? "unknown"}`;
  const summary = document.createElement("summary");
  summary.className = "agent-group-header";
  const dot = el("span", `agent-group-dot status-${group?.status ?? "unknown"}`);
  const label = el("span", "agent-group-label");
  label.textContent = `⑂ ${group?.label ?? nodeId}`;
  const stats = el("span", "agent-group-stats");
  if (group !== undefined) {
    const calls = group.toolCalls + group.commands;
    const parts: string[] = [group.status];
    if (calls > 0) parts.push(`${String(calls)} tool use${calls === 1 ? "" : "s"}`);
    if (group.fileEdits > 0) parts.push(`${String(group.fileEdits)} file${group.fileEdits === 1 ? "" : "s"}`);
    stats.textContent = parts.join(" · ");
  }
  summary.append(dot, label, stats);
  details.append(summary);
  const feed = el("div", "agent-group-feed");
  for (const entry of group?.entries ?? []) {
    const line = el("div", "agent-group-entry");
    line.textContent = `${formatTime(entry.createdAt)} ${entry.summary}`;
    feed.append(line);
  }
  if (group?.resultPreview !== undefined) {
    const result = el("div", "agent-group-result");
    result.textContent = group.resultPreview;
    feed.append(result);
  }
  details.append(feed);
  return details;
}

/**
 * Inline markdown → DOM: links (clickable), inline code, bold, italic.
 * Everything else stays a plain text node (CSP-safe: no innerHTML). Code
 * fences are handled separately.
 */
export function appendInline(parent: HTMLElement, text: string, openLink: (href: string) => void): void {
  const pattern = /\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|(?:\*|_)([^*_\s][^*_]*?)(?:\*|_)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) parent.append(document.createTextNode(text.slice(last, match.index)));
    if (match[1] !== undefined && match[2] !== undefined) {
      parent.append(inlineLink(match[1], match[2], openLink));
    } else if (match[3] !== undefined) {
      const code = el("code", "md-inline-code");
      code.textContent = match[3];
      parent.append(code);
    } else if (match[4] !== undefined) {
      const strong = document.createElement("strong");
      strong.textContent = match[4];
      parent.append(strong);
    } else if (match[5] !== undefined) {
      const em = document.createElement("em");
      em.textContent = match[5];
      parent.append(em);
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}

/** A clickable markdown link; the surface decides file-open vs. external. */
function inlineLink(label: string, href: string, openLink: (href: string) => void): HTMLElement {
  const anchor = el("a", "md-link") as HTMLAnchorElement;
  anchor.textContent = label;
  anchor.href = "#";
  anchor.title = href;
  anchor.addEventListener("click", (event) => {
    event.preventDefault();
    openLink(href);
  });
  return anchor;
}

/** Builds one structural markdown block as DOM (inline markdown + textContent leaves). */
export function assistantBlock(block: DocBlock, ctx: MessageRowContext): HTMLElement {
  // Protocol fences render as collapsed notes, not raw JSON code blocks.
  if (block.kind === "code" && isProtocolFenceLanguage(block.language)) {
    return buildProtocolNote(block.language ?? "", block.text);
  }
  switch (block.kind) {
    case "heading": {
      const level = Math.min(block.level ?? 1, 4);
      const heading = el(`h${String(level)}`, "md-heading");
      appendInline(heading, block.text, ctx.openLink);
      return heading;
    }
    case "list": {
      const ul = el("ul", "md-list");
      for (const item of block.items ?? []) {
        const li = el("li");
        appendInline(li, item, ctx.openLink);
        ul.append(li);
      }
      return ul;
    }
    case "code":
      return codeBlockFigure(block, ctx.copyText ?? defaultCopyText);
    case "mermaid":
      return ctx.renderMermaid !== undefined
        ? ctx.renderMermaid(block)
        : codeBlockFigure(block, ctx.copyText ?? defaultCopyText, "mermaid");
    case "paragraph":
    default: {
      const p = el("p", "md-paragraph");
      appendInline(p, block.text, ctx.openLink);
      return p;
    }
  }
}

export function codeBlockFigure(
  block: DocBlock,
  copyText: (text: string, copyButton: HTMLButtonElement) => void,
  label?: string,
  extraClass = ""
): HTMLElement {
  const classes = ["md-code"];
  if (extraClass.length > 0) classes.push(extraClass);
  const figure = el("div", classes.join(" "));
  const header = el("div", "md-code-header");
  const badge = el("span", "md-code-badge");
  badge.textContent = label ?? (block.language && block.language.length > 0 ? block.language : "code");
  const copy = iconButton("⧉", "Copy code", "md-code-copy");
  copy.addEventListener("click", () => copyText(block.text, copy));
  header.append(badge, copy);
  const pre = document.createElement("pre");
  pre.className = "md-pre";
  const code = document.createElement("code");
  code.textContent = block.text;
  pre.append(code);
  figure.append(header, pre);
  return figure;
}

/** Navigator-clipboard copy with the ✓/! flash, for surfaces without a host relay. */
export function defaultCopyText(text: string, copyButton: HTMLButtonElement): void {
  const original = copyButton.textContent ?? "Copy";
  const mark = (label: string): void => {
    copyButton.textContent = label;
    window.setTimeout(() => {
      copyButton.textContent = original;
    }, 1_500);
  };
  void (async () => {
    try {
      await navigator.clipboard.writeText(text);
      mark("✓");
    } catch {
      mark("!");
    }
  })();
}

// ---------------------------------------------------------------------------
// Briefed user bodies (plan rails)
// ---------------------------------------------------------------------------

const BRIEFING_START = "[host briefing";
const BRIEFING_END = "[end host briefing";

/**
 * First turns carry host briefings (the session mount briefing and the
 * planner's own). Collapses any leading `[host briefing…]…[end host briefing…]`
 * spans into disclosures so a rail leads with what was actually asked. Plain
 * textContent rendering throughout (no file tokens - the Chat tab supplies its
 * richer renderUserBody itself).
 */
export function renderBriefedUserBody(container: HTMLElement, text: string): void {
  let rest = text;
  for (let guard = 0; guard < 3; guard += 1) {
    const start = rest.indexOf(BRIEFING_START);
    if (start === -1) break;
    const endMark = rest.indexOf(BRIEFING_END, start);
    if (endMark === -1) break;
    const endLine = rest.indexOf("]", endMark);
    if (endLine === -1) break;
    const briefing = rest.slice(start, endLine + 1);
    const before = rest.slice(0, start).trim();
    if (before.length > 0) {
      const lead = el("div", "host-briefing-remainder");
      lead.textContent = before;
      container.append(lead);
    }
    const disclosure = document.createElement("details");
    disclosure.className = "host-briefing-detail";
    const summary = document.createElement("summary");
    summary.textContent = "Host briefing";
    const pre = document.createElement("pre");
    pre.className = "host-briefing-pre";
    pre.textContent = briefing;
    disclosure.append(summary, pre);
    container.append(disclosure);
    rest = rest.slice(endLine + 1);
  }
  const remainder = rest.trim();
  if (remainder.length > 0 || container.childElementCount === 0) {
    const body = el("div", "host-briefing-remainder");
    body.textContent = remainder.length > 0 ? remainder : text;
    container.append(body);
  }
}

// ---------------------------------------------------------------------------
// Turn indicators
// ---------------------------------------------------------------------------

export interface WorkingIndicatorOptions {
  /** Epoch ms the turn started; drives the tooltip's total elapsed. */
  readonly turnStartedAt?: number;
  /** Epoch ms of the last streamed output; drives the visible counter. */
  readonly lastActivityAt?: number;
  /** Live reasoning stream, when any arrived this turn. */
  readonly reasoning?: { readonly text: string };
  /** Extra affordance appended after a sustained silence (e.g. the poke button). */
  readonly trailing?: () => HTMLElement | null;
  /** Seconds of silence before `trailing` appears. */
  readonly trailingAfterSeconds?: number;
}

/**
 * Activity indicator appended at the bottom of the transcript for the duration
 * of a running turn. When reasoning text has arrived this turn it becomes the
 * live "Thinking" disclosure instead of the generic dots row.
 */
export function workingIndicatorRow(options: WorkingIndicatorOptions): HTMLElement {
  const elapsed = options.turnStartedAt === undefined ? 0 : Math.max(0, Math.floor((Date.now() - options.turnStartedAt) / 1000));
  if (options.reasoning !== undefined) {
    return reasoningDisclosure(true, options.reasoning.text, elapsed);
  }
  const row = el("div", "chat-working");
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  // Primary signal is time since the last streamed output: a value that keeps
  // climbing means the turn is running but silent (a likely hang). Total
  // elapsed lives in the tooltip.
  const sinceLast = options.lastActivityAt === undefined ? elapsed : Math.max(0, Math.floor((Date.now() - options.lastActivityAt) / 1000));
  row.title = `${String(elapsed)}s since this turn started`;
  const label = el("span", "chat-working-label");
  if (reducedMotion) {
    label.textContent = `Working… (${String(sinceLast)}s since last output)`;
    row.append(label);
  } else {
    const dots = el("span", "chat-working-dots");
    dots.append(el("span", "dot"), el("span", "dot"), el("span", "dot"));
    label.textContent = `Assistant is working… (${String(sinceLast)}s since last output)`;
    row.append(dots, label);
  }
  if (options.trailing !== undefined && sinceLast >= (options.trailingAfterSeconds ?? 30)) {
    const trailing = options.trailing();
    if (trailing !== null) row.append(trailing);
  }
  return row;
}

/**
 * Live, collapsible "Thinking" block: streams accumulated agent.reasoning text
 * as it arrives, collapsed by default so it never dominates the transcript.
 * Content renders via textContent only (CSP): no markdown, just the raw stream.
 */
export function reasoningDisclosure(live: boolean, text: string, elapsedSeconds: number): HTMLElement {
  const details = document.createElement("details");
  details.className = "chat-reasoning";
  const summary = document.createElement("summary");
  const label = el("span", "chat-reasoning-label");
  label.textContent = live ? `Thinking… (${String(elapsedSeconds)}s)` : `Thought for ${String(elapsedSeconds)}s`;
  summary.append(label);
  if (live) {
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    if (!reducedMotion) {
      const dots = el("span", "chat-working-dots");
      dots.append(el("span", "dot"), el("span", "dot"), el("span", "dot"));
      summary.append(dots);
    }
  }
  details.append(summary);
  const body = el("pre", "chat-reasoning-body");
  body.textContent = text;
  details.append(body);
  return details;
}

/**
 * Live indicator shown while a reconnect (resume/reclaim) boots a fresh
 * runtime, before the turn can start streaming. Elapsed climbs each second;
 * past ~20s it adds a reassurance that starting a sandbox can take a moment.
 */
export function reconnectingIndicatorRow(reconnectLabel: string, elapsedSeconds: number): HTMLElement {
  const row = el("div", "chat-working chat-reconnecting");
  const suffix = elapsedSeconds >= 45
    ? " - still trying; if it doesn't recover, End the session or reload the window"
    : elapsedSeconds >= 20
      ? " - starting the sandbox can take a bit"
      : "";
  const text = `${reconnectLabel} (${String(elapsedSeconds)}s)${suffix}`;
  const label = el("span", "chat-working-label");
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  if (reducedMotion) {
    label.textContent = text;
    row.append(label);
    return row;
  }
  const dots = el("span", "chat-working-dots");
  dots.append(el("span", "dot"), el("span", "dot"), el("span", "dot"));
  label.textContent = text;
  row.append(dots, label);
  return row;
}
