/**
 * Mermaid renderer bundle for the plan-docs panel (owner-approved 2026-07-04).
 *
 * Built as its own minified IIFE and injected lazily by planDocs.ts only when
 * a document actually contains a diagram, so the multi-MB parse cost is never
 * paid on a diagram-less panel. Exposes exactly one namespaced global.
 *
 * SECURITY: diagram source is agent-authored (untrusted). This wrapper pins
 * the hardened configuration - securityLevel "strict" and htmlLabels off drop
 * mermaid's foreignObject/HTML pathways entirely; startOnLoad off means
 * nothing renders without an explicit call. Callers must still strip
 * `%%{init:...}%%` directives from the source (host-controlled theme only)
 * and adopt the output through svgAdopt.ts - never raw innerHTML.
 */

import mermaid from "mermaid";

export interface PlanDocsMermaidApi {
  render(id: string, source: string): Promise<{ svg: string }>;
}

declare global {
  interface Window {
    vscodeAiPlanDocsMermaid?: PlanDocsMermaidApi;
  }
}

const dark = document.body.classList.contains("vscode-dark") || document.body.classList.contains("vscode-high-contrast");

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: dark ? "dark" : "default",
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  // Keep agent source from steering layout/theming beyond diagram text.
  suppressErrorRendering: true
});

window.vscodeAiPlanDocsMermaid = {
  async render(id: string, source: string): Promise<{ svg: string }> {
    const { svg } = await mermaid.render(id, source);
    return { svg };
  }
};
