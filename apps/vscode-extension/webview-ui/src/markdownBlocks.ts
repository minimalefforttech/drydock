/**
 * Structural markdown block splitter, shared by the plan-docs panel and the
 * chat dev-log transcript.
 *
 * This is a STRUCTURAL classifier only — it groups source lines into headings,
 * paragraphs, lists, fenced code, and mermaid blocks. It never parses inline
 * markdown and never produces markup: callers build DOM nodes and assign every
 * text leaf via textContent, so raw HTML inside the source stays literal.
 *
 * SECURITY: pure/deterministic; touches no DOM and emits no HTML. Rendering
 * (textContent only, never innerHTML) is the caller's responsibility.
 */

import type { PlanDocDetail } from "@drydock/contracts";

export type BlockKind = "heading" | "paragraph" | "list" | "code" | "mermaid";

/** The document format the splitter honors ("mermaid" → one whole-doc block). */
export type BlockFormat = PlanDocDetail["format"];

export interface DocBlock {
  /** 1-based index within the document; the review comment line anchor. */
  readonly index: number;
  readonly kind: BlockKind;
  /** Heading depth 1..6 (heading blocks only). */
  readonly level?: number;
  /** Info string / language for code blocks (may be ""). */
  readonly language?: string;
  /** For list blocks: one entry per item, marker stripped. */
  readonly items?: readonly string[];
  /** Rendered text for heading/paragraph/code/mermaid blocks. */
  readonly text: string;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM_RE = /^(\s*)([-*]\s+|\d+[.)]\s+)(.*)$/;

/**
 * Splits document content into 1-based indexed blocks (pure, deterministic).
 *
 * Rules: a mermaid-format doc is one single mermaid block. Otherwise: fenced
 * code (``` fence to matching ```; an info string of "mermaid" makes it a
 * mermaid block, else a code block with the info string as language), ATX
 * headings (#..######), contiguous list lines ("- "/"* "/"1. " etc.) grouped
 * into ONE list block, and blank-line-separated runs of the remaining lines as
 * paragraphs. Index is assigned in document order across all block kinds.
 */
export function splitBlocks(content: string, format: BlockFormat): DocBlock[] {
  if (format === "mermaid") {
    return [{ index: 1, kind: "mermaid", language: "mermaid", text: content.replace(/\s+$/, "") }];
  }
  const lines = content.split(/\r?\n/);
  const blocks: DocBlock[] = [];
  let index = 0;
  const push = (block: Omit<DocBlock, "index">): void => {
    index += 1;
    blocks.push({ index, ...block });
  };

  let paragraph: string[] = [];
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    push({ kind: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };
  let listItems: string[] = [];
  const flushList = (): void => {
    if (listItems.length === 0) return;
    push({ kind: "list", items: listItems, text: listItems.join("\n") });
    listItems = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      flushParagraph();
      flushList();
      const marker = fence[1] ?? "```";
      const info = (fence[2] ?? "").trim();
      const fenceChar = marker[0];
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const inner = lines[i] ?? "";
        const closeRe = new RegExp(`^\\s*${fenceChar === "`" ? "`{3,}" : "~{3,}"}\\s*$`);
        if (closeRe.test(inner)) { i += 1; break; }
        body.push(inner);
        i += 1;
      }
      const text = body.join("\n");
      if (info.toLowerCase() === "mermaid") {
        push({ kind: "mermaid", language: "mermaid", text });
      } else {
        push({ kind: "code", language: info, text });
      }
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      push({ kind: "heading", level: (heading[1] ?? "#").length, text: (heading[2] ?? "").trim() });
      i += 1;
      continue;
    }

    const listItem = LIST_ITEM_RE.exec(line);
    if (listItem) {
      flushParagraph();
      listItems.push((listItem[3] ?? "").trim());
      i += 1;
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      flushList();
      i += 1;
      continue;
    }

    // A non-list, non-blank line ends any list and extends the paragraph.
    flushList();
    paragraph.push(line);
    i += 1;
  }
  flushParagraph();
  flushList();
  return blocks;
}
