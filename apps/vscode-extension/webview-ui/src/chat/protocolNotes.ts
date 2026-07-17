/**
 * Protocol-fence presentation for the transcript.
 *
 * Agents emit fenced JSON blocks (access-request / question / preview /
 * memory-candidate) that the HOST parses into cards, inbox items, and
 * proxies. In the chat those fences render as COLLAPSED one-line notes — a
 * summary naming what was requested, expandable for the path/reason detail.
 * The actual flows are untouched: presentation only, textContent only.
 */

const PROTOCOL_LANGUAGES = new Set(["access-request", "question", "memory-candidate", "preview"]);

export function isProtocolFenceLanguage(language: string | undefined): boolean {
  return language !== undefined && PROTOCOL_LANGUAGES.has(language);
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Builds the collapsed note for one protocol fence. */
export function buildProtocolNote(language: string, text: string): HTMLElement {
  const details = document.createElement("details");
  details.className = `protocol-note protocol-${language}`;
  const summary = document.createElement("summary");
  summary.className = "protocol-note-summary";
  const body = el("div", "protocol-note-body");
  details.append(summary, body);

  const line = (content: string, cls = "protocol-note-line"): void => {
    body.append(el("div", cls, content));
  };

  if (language === "memory-candidate") {
    summary.textContent = "💡 Proposed a team memory";
    line(oneLine(text));
    line("Review it under Tasks → Memory.", "protocol-note-hint");
    return details;
  }

  const data = parseJson(text);
  if (language === "access-request" && data !== null) {
    const requestPath = typeof data["path"] === "string" ? data["path"] : "";
    const mode = data["mode"] === "read-write" ? "read-write" : "read-only";
    const leaf = requestPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? requestPath;
    summary.textContent = `⛨ Requested ${mode} access — ${leaf}`;
    line(requestPath, "protocol-note-path");
    if (typeof data["reason"] === "string" && data["reason"].length > 0) line(oneLine(data["reason"]));
    line("Respond from the access card (also in the Tasks inbox).", "protocol-note-hint");
    return details;
  }
  if (language === "question" && data !== null) {
    const question = typeof data["question"] === "string" ? oneLine(data["question"]) : "";
    summary.textContent = `❓ Asked: ${question.length > 80 ? `${question.slice(0, 80)}…` : question}`;
    if (question.length > 80) line(question);
    line("Answer from the question card.", "protocol-note-hint");
    return details;
  }
  if (language === "preview" && data !== null) {
    const title = typeof data["title"] === "string" ? oneLine(data["title"]) : "Preview";
    const port = typeof data["port"] === "number" ? String(data["port"]) : "?";
    summary.textContent = `▶ Preview server up: ${title} (port ${port})`;
    line("Open it from the preview strip.", "protocol-note-hint");
    return details;
  }

  // Malformed fence: honest fallback — generic summary, raw body behind it.
  summary.textContent = `⚙ ${language} (unparsed)`;
  const pre = document.createElement("pre");
  pre.className = "protocol-note-raw";
  pre.textContent = text;
  body.append(pre);
  return details;
}
