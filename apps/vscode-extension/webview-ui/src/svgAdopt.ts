/**
 * Sanitizing SVG adoption for mermaid output (plan-docs panel).
 *
 * This module is the ONE sanctioned exception to the textContent-only
 * rendering invariant: mermaid returns an SVG markup string that must become
 * DOM. It never touches innerHTML on the live document — the string is parsed
 * in an inert DOMParser document, scrubbed, and only then imported. The scrub
 * is defense-in-depth on top of mermaid's securityLevel "strict" +
 * htmlLabels:false (which already drop script/foreignObject pathways): we do
 * not trust the renderer's internal sanitizer to be the only line.
 *
 * Scrub policy: drop script/foreignObject/iframe/object/embed/animate*
 * elements outright; drop <use> unless it references a local fragment; strip
 * every on* attribute; strip href/xlink:href values that are not local
 * fragments. Inline style attributes/elements are allowed — this panel's CSP
 * permits inline styles (owner-approved) and mermaid needs them.
 */

const FORBIDDEN_ELEMENTS: ReadonlySet<string> = new Set([
  "script",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "animate",
  "animatemotion",
  "animatetransform",
  "set"
]);

/**
 * Parses and scrubs an SVG markup string, returning a node imported into the
 * caller's document — or null when the input is not a well-formed lone <svg>.
 */
export function adoptSanitizedSvg(targetDocument: Document, svgText: string): SVGSVGElement | null {
  const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml");
  if (parsed.querySelector("parsererror") !== null) {
    return null;
  }
  const root = parsed.documentElement;
  if (root.tagName.toLowerCase() !== "svg") {
    return null;
  }
  scrubElement(root);
  return targetDocument.importNode(root, true) as unknown as SVGSVGElement;
}

function scrubElement(element: Element): void {
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith("on")) {
      element.removeAttribute(attribute.name);
      continue;
    }
    if ((name === "href" || name === "xlink:href") && !attribute.value.trim().startsWith("#")) {
      element.removeAttribute(attribute.name);
    }
  }
  for (const child of [...element.children]) {
    const tag = child.tagName.toLowerCase();
    if (FORBIDDEN_ELEMENTS.has(tag) || (tag === "use" && !hasOnlyLocalRef(child))) {
      child.remove();
      continue;
    }
    scrubElement(child);
  }
}

/** A <use> is kept only when every href it carries is a local fragment. */
function hasOnlyLocalRef(element: Element): boolean {
  for (const name of ["href", "xlink:href"]) {
    const value = element.getAttribute(name);
    if (value !== null && !value.trim().startsWith("#")) {
      return false;
    }
  }
  return true;
}
