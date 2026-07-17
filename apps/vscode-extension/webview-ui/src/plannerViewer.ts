/**
 * Planner viewer column: the ArtifactProvider seam plus the document provider
 * and the annotation dock (ADR 0012).
 *
 * One interface renders every artifact kind; P2 ships the document provider
 * (structural markdown blocks in the design-doc theme, click-to-instruct on
 * every block); the diagram/image/prototype providers land in P4/P5 behind the
 * same seam - until then those kinds fall back to a source/placeholder view.
 *
 * SECURITY: every dynamic string renders via textContent - NEVER innerHTML.
 * Markdown renders STRUCTURALLY through splitBlocks; raw HTML in agent output
 * stays literal text.
 */

import { parsePlanAnchor, type PlanAnnotationSummary, type PlanArtifactDetail } from "@drydock/contracts";
import { badge, button, el } from "./components.js";
import { splitBlocks, type DocBlock } from "./markdownBlocks.js";
import { adoptSanitizedSvg } from "./svgAdopt.js";
// TYPE-ONLY import: the mermaid runtime bundle (~3.3 MB) is NEVER imported here
// - it is script-injected lazily by loadMermaid(), exactly as the plan-docs
// panel does. Importing the type erases at compile time.
import type { PlanDocsMermaidApi } from "./planDocsMermaid.js";

declare global {
  interface Window {
    vscodeAiPlanDocsMermaid?: PlanDocsMermaidApi;
  }
}

export interface ProviderEvents {
  /** Opens the instruction box for an anchor (optionally prefilled). */
  readonly onAnnotate: (anchor: string, prefill?: string) => void;
  /** Jump-to-annotation from the dock or the outline. */
  readonly onFocusDock: (annotationId: string) => void;
  /** Prototype kinds only: flip the per-artifact scripts toggle host-side. */
  readonly onSetPrototypeScripts?: (artifactId: string, enabled: boolean) => void;
}

export interface ArtifactProvider {
  readonly kind: PlanArtifactDetail["kind"];
  render(host: HTMLElement, artifact: PlanArtifactDetail, annotations: readonly PlanAnnotationSummary[], events: ProviderEvents): void;
  /** Scrolls/highlights the target of an anchor; no-op when unresolvable. */
  focusAnchor(anchor: string): void;
}

// ---------------------------------------------------------------------------
// Document provider
// ---------------------------------------------------------------------------

/** Block DOM nodes for the active document, keyed by block index. */
export class DocumentProvider implements ArtifactProvider {
  readonly kind = "document" as const;
  private readonly blockNodes = new Map<number, HTMLElement>();

  render(host: HTMLElement, artifact: PlanArtifactDetail, annotations: readonly PlanAnnotationSummary[], events: ProviderEvents): void {
    this.blockNodes.clear();
    host.replaceChildren();
    const blocks = splitBlocks(artifact.content ?? "", "markdown");
    if (blocks.length === 0) {
      const empty = el("div", "pl-block-empty");
      empty.textContent = "This document is empty.";
      host.append(empty);
      return;
    }
    for (const block of blocks) {
      const node = this.renderBlock(block, artifact, annotations, events);
      this.blockNodes.set(block.index, node);
      host.append(node);
    }
  }

  focusAnchor(anchor: string): void {
    const match = /^block:(\d+)$/.exec(anchor);
    if (match === null) return;
    const node = this.blockNodes.get(Number(match[1]));
    if (node === undefined) return;
    node.scrollIntoView({ block: "center", behavior: "smooth" });
    node.classList.add("pl-block-flash");
    window.setTimeout(() => node.classList.remove("pl-block-flash"), 1600);
  }

  /** Heading blocks (index + text + level) for the outline rail. */
  static outline(artifact: PlanArtifactDetail): { index: number; text: string; level: number }[] {
    return splitBlocks(artifact.content ?? "", "markdown")
      .filter((block) => block.kind === "heading")
      .map((block) => ({ index: block.index, text: block.text, level: block.level ?? 1 }));
  }

  private renderBlock(
    block: DocBlock,
    _artifact: PlanArtifactDetail,
    annotations: readonly PlanAnnotationSummary[],
    events: ProviderEvents
  ): HTMLElement {
    const wrap = el("div", `pl-block pl-block-${block.kind}`);
    const content = el("div", "pl-block-content");
    content.append(renderBlockBody(block));
    wrap.append(content);

    const annotateButton = el("button", "pl-annotate-icon");
    annotateButton.textContent = "✎";
    annotateButton.title = "Add an instruction for this block";
    annotateButton.setAttribute("aria-label", "Add an instruction for this block");
    annotateButton.addEventListener("click", () => events.onAnnotate(`block:${String(block.index)}`));
    wrap.append(annotateButton);

    const blockNotes = annotations.filter((annotation) => annotation.anchor === `block:${String(block.index)}`);
    if (blockNotes.length > 0) {
      const pill = el("button", "pl-block-count");
      pill.textContent = `${String(blockNotes.length)} ✎`;
      pill.title = "Jump to the instructions on this block";
      pill.addEventListener("click", () => {
        const first = blockNotes[0];
        if (first) events.onFocusDock(first.annotationId);
      });
      wrap.append(pill);
    }
    return wrap;
  }
}

/** Structural block body shared with fallback presentations. */
export function renderBlockBody(block: DocBlock): HTMLElement {
  switch (block.kind) {
    case "heading": {
      const level = Math.min(block.level ?? 1, 4);
      const heading = el(`h${String(level)}`, "pl-heading");
      heading.textContent = block.text;
      return heading;
    }
    case "paragraph": {
      const paragraph = el("p", "pl-paragraph");
      paragraph.textContent = block.text;
      return paragraph;
    }
    case "list": {
      const list = el("ul", "pl-list");
      for (const item of block.items ?? []) {
        const entry = el("li");
        entry.textContent = item;
        list.append(entry);
      }
      return list;
    }
    case "code":
    case "mermaid": {
      const figure = el("div", block.kind === "mermaid" ? "pl-code pl-mermaid-source" : "pl-code");
      const label = badge(block.kind === "mermaid" ? "diagram" : (block.language && block.language.length > 0 ? block.language : "code"), "pl-badge");
      const pre = document.createElement("pre");
      pre.className = "pl-pre";
      const code = document.createElement("code");
      code.textContent = block.text;
      pre.append(code);
      figure.append(label, pre);
      return figure;
    }
  }
}

// ---------------------------------------------------------------------------
// Mermaid loader (shared global with the plan-docs bundle; lazy per panel)
// ---------------------------------------------------------------------------

let mermaidLoad: Promise<PlanDocsMermaidApi> | undefined;

function loadMermaid(): Promise<PlanDocsMermaidApi> {
  if (mermaidLoad !== undefined) return mermaidLoad;
  mermaidLoad = new Promise<PlanDocsMermaidApi>((resolve, reject) => {
    const existing = window.vscodeAiPlanDocsMermaid;
    if (existing !== undefined) {
      resolve(existing);
      return;
    }
    const app = document.getElementById("app");
    const src = app?.dataset["mermaidSrc"] ?? "";
    const nonce = app?.dataset["nonce"] ?? "";
    if (src === "") {
      mermaidLoad = undefined;
      reject(new Error("Mermaid bundle source is not configured on #app."));
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.nonce = nonce;
    script.addEventListener("load", () => {
      const api = window.vscodeAiPlanDocsMermaid;
      if (api === undefined) {
        reject(new Error("Mermaid bundle loaded but did not expose its renderer."));
        return;
      }
      resolve(api);
    });
    script.addEventListener("error", () => {
      mermaidLoad = undefined;
      reject(new Error("Failed to load the mermaid diagram bundle."));
    });
    document.head.append(script);
  });
  return mermaidLoad;
}

/** Strips a mermaid `%%{...}%%` init/config directive span (defense-in-depth). */
const MERMAID_DIRECTIVE_RE = /%%\{[\s\S]*?\}%%/g;

/**
 * Deterministic, DOM-id-safe render id per artifact (plan-docs precedent).
 * Mermaid derives node ids from it, so `node:<id>` anchors stay stable across
 * re-renders and revisions instead of embedding a render counter.
 */
function mermaidRenderId(relPath: string): string {
  return `planner-mermaid-${relPath.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

// ---------------------------------------------------------------------------
// Annotation surface: the pin/region overlay shared by images, rendered
// diagrams, and (P5) prototypes. Normalized 0-1 coordinates over the target.
// ---------------------------------------------------------------------------

export interface AnnotationSurface {
  readonly element: HTMLElement;
  /** Redraws the pins/regions for the current annotation set. */
  refresh(annotations: readonly PlanAnnotationSummary[]): void;
  /** Flashes the marker for an anchor; true when one matched. */
  focusAnchor(anchor: string): boolean;
}

const REGION_MIN_SIZE = 0.01;
const DRAG_THRESHOLD_PX = 6;

/**
 * Builds the transparent capture layer. A plain click yields `point:x,y`; a
 * drag beyond the threshold yields `region:x,y,w,h`. Existing point/region
 * annotations render as pins and dashed rectangles; clicking one jumps to its
 * dock entry instead of creating a new annotation.
 */
export function createAnnotationSurface(events: ProviderEvents): AnnotationSurface {
  const layer = el("div", "pl-anno-layer");
  const markers = el("div", "pl-anno-markers");
  layer.append(markers);

  let dragStart: { x: number; y: number; px: number; py: number } | null = null;
  let dragRect: HTMLElement | null = null;

  const normalized = (event: PointerEvent): { x: number; y: number } => {
    const bounds = layer.getBoundingClientRect();
    const x = bounds.width <= 0 ? 0 : Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    const y = bounds.height <= 0 ? 0 : Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height));
    return { x, y };
  };
  const coord = (value: number): string => String(Math.round(value * 1000) / 1000);

  layer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest(".pl-pin, .pl-region") !== null) return;
    const at = normalized(event);
    dragStart = { ...at, px: event.clientX, py: event.clientY };
    layer.setPointerCapture(event.pointerId);
  });
  layer.addEventListener("pointermove", (event) => {
    if (dragStart === null) return;
    const moved = Math.hypot(event.clientX - dragStart.px, event.clientY - dragStart.py);
    if (moved < DRAG_THRESHOLD_PX && dragRect === null) return;
    const at = normalized(event);
    if (dragRect === null) {
      dragRect = el("div", "pl-region pl-region-draft");
      markers.append(dragRect);
    }
    positionRect(dragRect, dragStart, at);
  });
  layer.addEventListener("pointerup", (event) => {
    if (dragStart === null) return;
    const start = dragStart;
    dragStart = null;
    const at = normalized(event);
    if (dragRect !== null) {
      dragRect.remove();
      dragRect = null;
      const x = Math.min(start.x, at.x);
      const y = Math.min(start.y, at.y);
      const width = Math.abs(at.x - start.x);
      const height = Math.abs(at.y - start.y);
      if (width >= REGION_MIN_SIZE && height >= REGION_MIN_SIZE) {
        events.onAnnotate(`region:${coord(x)},${coord(y)},${coord(width)},${coord(height)}`);
        return;
      }
    }
    events.onAnnotate(`point:${coord(at.x)},${coord(at.y)}`);
  });
  layer.addEventListener("pointercancel", () => {
    dragStart = null;
    dragRect?.remove();
    dragRect = null;
  });

  const byAnchor = new Map<string, HTMLElement>();
  const refresh = (annotations: readonly PlanAnnotationSummary[]): void => {
    markers.replaceChildren();
    byAnchor.clear();
    for (const annotation of annotations) {
      const parsed = parsePlanAnchor(annotation.anchor);
      if (parsed === null || (parsed.kind !== "point" && parsed.kind !== "region")) continue;
      let marker: HTMLElement;
      if (parsed.kind === "point") {
        marker = el("button", `pl-pin status-${annotation.status}`);
        marker.style.left = `${String(parsed.x * 100)}%`;
        marker.style.top = `${String(parsed.y * 100)}%`;
      } else {
        marker = el("button", `pl-region status-${annotation.status}`);
        marker.style.left = `${String(parsed.x * 100)}%`;
        marker.style.top = `${String(parsed.y * 100)}%`;
        marker.style.width = `${String(parsed.width * 100)}%`;
        marker.style.height = `${String(parsed.height * 100)}%`;
      }
      marker.title = annotation.body;
      marker.addEventListener("click", (event) => {
        event.stopPropagation();
        events.onFocusDock(annotation.annotationId);
      });
      byAnchor.set(annotation.anchor, marker);
      markers.append(marker);
    }
  };

  const focusAnchor = (anchor: string): boolean => {
    const marker = byAnchor.get(anchor);
    if (marker === undefined) return false;
    marker.scrollIntoView({ block: "center", behavior: "smooth" });
    marker.classList.add("pl-block-flash");
    window.setTimeout(() => marker.classList.remove("pl-block-flash"), 1600);
    return true;
  };

  return { element: layer, refresh, focusAnchor };
}

function positionRect(rect: HTMLElement, a: { x: number; y: number }, b: { x: number; y: number }): void {
  rect.style.left = `${String(Math.min(a.x, b.x) * 100)}%`;
  rect.style.top = `${String(Math.min(a.y, b.y) * 100)}%`;
  rect.style.width = `${String(Math.abs(b.x - a.x) * 100)}%`;
  rect.style.height = `${String(Math.abs(b.y - a.y) * 100)}%`;
}

// ---------------------------------------------------------------------------
// Diagram provider (mermaid)
// ---------------------------------------------------------------------------

const NODE_ID_SAFE_RE = /[^A-Za-z0-9_.:-]/g;

export class DiagramProvider implements ArtifactProvider {
  readonly kind = "diagram" as const;
  private svgHost: SVGSVGElement | null = null;
  private surface: AnnotationSurface | null = null;

  render(host: HTMLElement, artifact: PlanArtifactDetail, annotations: readonly PlanAnnotationSummary[], events: ProviderEvents): void {
    host.replaceChildren();
    this.svgHost = null;
    this.surface = null;
    const source = (artifact.content ?? "").replace(MERMAID_DIRECTIVE_RE, "").trim();
    const placeholder = el("div", "md-mermaid-placeholder");
    placeholder.textContent = "rendering diagram…";
    host.append(placeholder);
    const mine = annotations.filter((annotation) => annotation.artifactId === artifact.artifactId);

    const renderId = mermaidRenderId(artifact.relPath);
    void loadMermaid()
      .then((api) => api.render(renderId, source))
      .then((result) => {
        if (!placeholder.isConnected) return;
        const svg = adoptSanitizedSvg(document, result.svg);
        if (svg === null) {
          placeholder.replaceWith(this.sourceFallback(artifact, "This diagram could not be displayed; showing its source."));
          return;
        }
        placeholder.replaceWith(this.figure(svg, artifact, mine, events));
      })
      .catch(() => {
        if (!placeholder.isConnected) return;
        placeholder.replaceWith(this.sourceFallback(artifact, "This diagram could not be rendered; showing its source."));
      });
  }

  focusAnchor(anchor: string): void {
    if (this.surface?.focusAnchor(anchor) === true) return;
    const parsed = parsePlanAnchor(anchor);
    if (parsed === null || parsed.kind !== "node" || this.svgHost === null) return;
    const group = this.svgHost.querySelector(`g[id="${parsed.nodeId.replace(/"/g, "")}"]`);
    if (group instanceof SVGElement) {
      group.scrollIntoView({ block: "center", behavior: "smooth" });
      group.classList.add("pl-node-flash");
      window.setTimeout(() => group.classList.remove("pl-node-flash"), 1600);
    }
  }

  /**
   * Rendered figure: sanitized SVG in a positioned wrap that carries the
   * point/region annotation surface; node clicks anchor as `node:<id>`.
   * Node anchors with open notes get an outline class so they read on-canvas.
   */
  private figure(
    svg: SVGSVGElement,
    artifact: PlanArtifactDetail,
    annotations: readonly PlanAnnotationSummary[],
    events: ProviderEvents
  ): HTMLElement {
    const figure = el("figure", "md-mermaid-figure pl-diagram-figure");
    const wrap = el("div", "md-mermaid-svg-wrap pl-anno-host");
    wrap.append(svg);
    this.svgHost = svg;

    // Node hit-testing runs on the SVG itself; the surface layer sits above it
    // but forwards node clicks by checking the element under the pointer.
    const surface = createAnnotationSurface({
      onAnnotate: (anchor, prefill) => {
        events.onAnnotate(anchor, prefill);
      },
      onFocusDock: events.onFocusDock
    });
    this.surface = surface;
    surface.element.addEventListener("pointerdown", (event) => {
      // A click landing on a node group anchors to the node, not a free point:
      // hide the layer for a hit-test instant to find the SVG element below.
      surface.element.style.pointerEvents = "none";
      const under = document.elementFromPoint(event.clientX, event.clientY);
      surface.element.style.pointerEvents = "";
      const group = under instanceof Element ? under.closest("g[id]") : null;
      if (group !== null && svg.contains(group)) {
        event.stopImmediatePropagation();
        const nodeId = group.id.replace(NODE_ID_SAFE_RE, "").slice(0, 120);
        if (nodeId.length > 0) {
          const label = (group.textContent ?? "").trim().slice(0, 40);
          events.onAnnotate(`node:${nodeId}`, label.length > 0 ? `[${label}] ` : undefined);
        }
      }
    }, { capture: true });
    surface.refresh(annotations);
    for (const annotation of annotations) {
      const parsed = parsePlanAnchor(annotation.anchor);
      if (parsed === null || parsed.kind !== "node") continue;
      const group = svg.querySelector(`g[id="${parsed.nodeId.replace(/"/g, "")}"]`);
      if (group instanceof SVGElement) group.classList.add(annotation.status === "open" ? "pl-node-noted" : "pl-node-noted-muted");
    }
    wrap.append(surface.element);

    const sourceView = document.createElement("pre");
    sourceView.className = "md-pre md-mermaid-source hidden";
    const code = document.createElement("code");
    code.textContent = artifact.content ?? "";
    sourceView.append(code);
    const footer = el("figcaption", "md-code-header md-mermaid-header");
    const label = badge("diagram", "md-code-badge md-mermaid-badge");
    const toggle = button("view source", "ghost small");
    toggle.addEventListener("click", () => {
      const showingSource = !sourceView.classList.contains("hidden");
      sourceView.classList.toggle("hidden", showingSource);
      wrap.classList.toggle("hidden", !showingSource);
      toggle.textContent = showingSource ? "view source" : "view diagram";
    });
    footer.append(label, toggle);
    figure.append(wrap, sourceView, footer);
    return figure;
  }

  private sourceFallback(artifact: PlanArtifactDetail, message: string): HTMLElement {
    const wrap = el("div", "pl-mermaid-fallback");
    const pre = document.createElement("pre");
    pre.className = "pl-pre pl-fallback-source";
    const code = document.createElement("code");
    code.textContent = artifact.content ?? "";
    pre.append(code);
    const error = el("div", "pl-fallback-note");
    error.textContent = message;
    wrap.append(pre, error);
    return wrap;
  }
}

// ---------------------------------------------------------------------------
// Image provider
// ---------------------------------------------------------------------------

export class ImageProvider implements ArtifactProvider {
  readonly kind = "image" as const;
  private surface: AnnotationSurface | null = null;

  render(host: HTMLElement, artifact: PlanArtifactDetail, annotations: readonly PlanAnnotationSummary[], events: ProviderEvents): void {
    host.replaceChildren();
    this.surface = null;
    if (artifact.imageDataUri === undefined) {
      const note = el("div", "pl-fallback-note");
      note.textContent = artifact.oversizedImage === true
        ? "This image is too large to preview inline - use \"open file\" above."
        : "This image has no inline preview yet.";
      host.append(note);
      return;
    }
    const wrap = el("div", "pl-image-wrap pl-anno-host");
    const image = document.createElement("img");
    image.className = "pl-image";
    image.src = artifact.imageDataUri;
    image.alt = artifact.title;
    image.draggable = false;
    wrap.append(image);
    const surface = createAnnotationSurface(events);
    this.surface = surface;
    surface.refresh(annotations.filter((annotation) => annotation.artifactId === artifact.artifactId));
    wrap.append(surface.element);
    host.append(wrap);
    const hint = el("div", "pl-footnote pl-anno-hint");
    hint.textContent = "click for a point note · drag for a region";
    host.append(hint);
  }

  focusAnchor(anchor: string): void {
    this.surface?.focusAnchor(anchor);
  }
}

// ---------------------------------------------------------------------------
// Prototype provider: agent-authored single-file HTML, live in a sandboxed
// frame. Preview mode hands the pointer to the page (buttons actually click);
// Annotate mode raises the same point/region surface images use. Scripts are
// per-artifact opt-in: `allow-scripts` only when toggled on, and NEVER
// `allow-same-origin` - the frame cannot reach the panel's DOM, state, or
// message bridge either way.
// ---------------------------------------------------------------------------

export class PrototypeProvider implements ArtifactProvider {
  readonly kind = "prototype" as const;
  private surface: AnnotationSurface | null = null;
  /** Transient per-render; a prototype opens interactive. */
  private mode: "preview" | "annotate" = "preview";

  render(host: HTMLElement, artifact: PlanArtifactDetail, annotations: readonly PlanAnnotationSummary[], events: ProviderEvents): void {
    host.replaceChildren();
    this.surface = null;
    if (artifact.content === undefined) {
      const note = el("div", "pl-fallback-note");
      note.textContent = "This prototype has no inline content - use \"open file\" above.";
      host.append(note);
      return;
    }

    const toolbar = el("div", "pl-proto-toolbar");
    const modeGroup = el("div", "pl-proto-modes");
    const previewButton = button("Preview", `small pl-proto-mode${this.mode === "preview" ? " active" : ""}`);
    const annotateButton = button("Annotate", `small pl-proto-mode${this.mode === "annotate" ? " active" : ""}`);
    modeGroup.append(previewButton, annotateButton);
    const scriptsChip = button(`scripts: ${artifact.scriptsEnabled ? "on" : "off"}`, "ghost small pl-proto-scripts");
    scriptsChip.title = artifact.scriptsEnabled
      ? "Scripts run inside the sandboxed frame (no same-origin access). Click to disable."
      : "Scripts are inert. Click to let this prototype's inline JS run inside the sandboxed frame.";
    if (events.onSetPrototypeScripts !== undefined) {
      const toggle = events.onSetPrototypeScripts;
      scriptsChip.addEventListener("click", () => {
        scriptsChip.disabled = true;
        toggle(artifact.artifactId, !artifact.scriptsEnabled);
      });
    } else {
      scriptsChip.disabled = true;
    }
    const hint = el("span", "pl-footnote");
    hint.textContent = this.mode === "preview" ? "the page is interactive" : "click for a point · drag for a region";
    toolbar.append(modeGroup, scriptsChip, hint);
    host.append(toolbar);

    const wrap = el("div", `pl-proto-wrap pl-anno-host mode-${this.mode}`);
    const frame = document.createElement("iframe");
    frame.className = "pl-proto-frame";
    // NEVER allow-same-origin: the srcdoc document stays cross-origin to the
    // panel, so agent-authored JS (when enabled) cannot touch this webview.
    frame.setAttribute("sandbox", artifact.scriptsEnabled ? "allow-scripts" : "");
    frame.setAttribute("title", artifact.title);
    frame.srcdoc = artifact.content;
    wrap.append(frame);

    const surface = createAnnotationSurface(events);
    this.surface = surface;
    surface.refresh(annotations.filter((annotation) => annotation.artifactId === artifact.artifactId));
    wrap.append(surface.element);
    host.append(wrap);

    const setMode = (mode: "preview" | "annotate"): void => {
      this.mode = mode;
      wrap.classList.toggle("mode-preview", mode === "preview");
      wrap.classList.toggle("mode-annotate", mode === "annotate");
      previewButton.classList.toggle("active", mode === "preview");
      annotateButton.classList.toggle("active", mode === "annotate");
      hint.textContent = mode === "preview" ? "the page is interactive" : "click for a point · drag for a region";
    };
    previewButton.addEventListener("click", () => setMode("preview"));
    annotateButton.addEventListener("click", () => setMode("annotate"));
  }

  focusAnchor(anchor: string): void {
    this.surface?.focusAnchor(anchor);
  }
}

// ---------------------------------------------------------------------------
// Fallback provider (kinds whose real provider lands in a later phase)
// ---------------------------------------------------------------------------

export class FallbackProvider implements ArtifactProvider {
  constructor(readonly kind: PlanArtifactDetail["kind"], private readonly note: string) {}

  render(host: HTMLElement, artifact: PlanArtifactDetail): void {
    host.replaceChildren();
    const notice = el("div", "pl-fallback-note");
    notice.textContent = this.note;
    host.append(notice);
    if (artifact.content !== undefined) {
      const pre = document.createElement("pre");
      pre.className = "pl-pre pl-fallback-source";
      const code = document.createElement("code");
      code.textContent = artifact.content;
      pre.append(code);
      host.append(pre);
    }
    if (artifact.imageDataUri !== undefined) {
      const image = document.createElement("img");
      image.className = "pl-image";
      image.src = artifact.imageDataUri;
      image.alt = artifact.title;
      host.append(image);
    }
    if (artifact.oversizedImage === true) {
      const oversize = el("div", "pl-fallback-note");
      oversize.textContent = "This image is too large to preview inline - use \"open file\" above.";
      host.append(oversize);
    }
  }

  focusAnchor(): void {
    // Nothing to scroll to until the real provider lands.
  }
}

// ---------------------------------------------------------------------------
// Annotation dock
// ---------------------------------------------------------------------------

export interface DockActions {
  readonly onSetStatus: (annotationId: string, status: PlanAnnotationSummary["status"]) => void;
  readonly onRemove: (annotationId: string) => void;
  readonly onFocusAnchor: (anchor: string) => void;
}

/** Renders the selected artifact's annotations; returns nodes keyed by id for dock focus. */
export function renderAnnotationDock(
  host: HTMLElement,
  artifact: PlanArtifactDetail,
  annotations: readonly PlanAnnotationSummary[],
  actions: DockActions
): Map<string, HTMLElement> {
  host.replaceChildren();
  const nodes = new Map<string, HTMLElement>();
  const mine = annotations.filter((annotation) => annotation.artifactId === artifact.artifactId);
  if (mine.length === 0) {
    const empty = el("div", "pl-dock-empty");
    empty.textContent = "No instructions on this artifact yet - click any block, node, or region to add one.";
    host.append(empty);
    return nodes;
  }
  for (const annotation of mine) {
    const entry = el("div", `pl-dock-entry status-${annotation.status}`);
    const header = el("div", "pl-dock-head");
    const anchorLink = el("button", "pl-dock-anchor");
    anchorLink.textContent = annotation.anchor;
    anchorLink.title = "Jump to this spot";
    anchorLink.addEventListener("click", () => actions.onFocusAnchor(annotation.anchor));
    const addressed = annotation.status === "delegated"
      && annotation.delegatedRev !== null
      && artifact.revision > annotation.delegatedRev;
    header.append(anchorLink, badge(
      addressed ? `addressed in rev ${String(artifact.revision)}?` : dockStatusLabel(annotation),
      `pl-status-${annotation.status}${addressed ? " pl-status-addressed" : ""}`
    ));
    const body = el("div", "pl-dock-body");
    body.textContent = annotation.body;
    const actionsRow = el("div", "pl-dock-actions");
    if (annotation.status === "open") {
      actionsRow.append(
        dockAction("Park", () => actions.onSetStatus(annotation.annotationId, "wont-fix")),
        dockAction("Remove", () => actions.onRemove(annotation.annotationId))
      );
    } else if (annotation.status === "delegated") {
      actionsRow.append(
        dockAction("Resolve", () => actions.onSetStatus(annotation.annotationId, "resolved")),
        dockAction("Reopen", () => actions.onSetStatus(annotation.annotationId, "open"))
      );
    } else {
      actionsRow.append(dockAction("Reopen", () => actions.onSetStatus(annotation.annotationId, "open")));
    }
    entry.append(header, body, actionsRow);
    nodes.set(annotation.annotationId, entry);
    host.append(entry);
  }
  return nodes;
}

function dockAction(label: string, onClick: () => void): HTMLButtonElement {
  const node = button(label, "ghost small");
  node.addEventListener("click", onClick);
  return node;
}

/** "delegated" cards carry the revision they were sent against. */
function dockStatusLabel(annotation: PlanAnnotationSummary): string {
  if (annotation.status === "delegated" && annotation.delegatedRev !== null) {
    return `delegated · rev ${String(annotation.delegatedRev)}`;
  }
  return annotation.status;
}
