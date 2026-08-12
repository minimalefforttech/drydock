/**
 * The Task Hub's line icons (UX overhaul, P3).
 *
 * Built with `createElementNS`, never from markup: the hub's strict CSP has no
 * `unsafe-inline`, and the panel's rule is textContent/DOM-construction only.
 * One stroked 16px grid, `currentColor` throughout - the icon never carries
 * colour of its own, so a card band inherits whatever quiet tone the card has
 * and the single accent stays where the design put it.
 */

const NS = "http://www.w3.org/2000/svg";

/** Path data per icon; keys are the names the views ask for. */
const PATHS: Readonly<Record<string, readonly string[]>> = {
  chats: ["M2.5 3.5h11v7.5H6.5l-3 2.5v-2.5h-1z"],
  subtasks: ["M2.5 4h3v3h-3z", "M2.5 9h3v3h-3z", "M7.5 5.5h6", "M7.5 10.5h6"],
  plans: ["M4 2.5h5l3 3v8H4z", "M9 2.5v3h3"],
  system: ["M5.5 5.5h5v5h-5z", "M3 7h2.5", "M3 9h2.5", "M10.5 7H13", "M10.5 9H13", "M7 3v2.5", "M9 3v2.5", "M7 10.5V13", "M9 10.5V13"],
  attention: ["M8 2.5l5.5 10.5h-11z", "M8 6.5v3", "M8 11.2v.6"],
  board: ["M2.5 3.5h11v9h-11z", "M6.2 3.5v9", "M9.9 3.5v9"],
  agents: ["M8 2.5a2.5 2.5 0 100 5 2.5 2.5 0 100-5z", "M3 13.5a5 5 0 0110 0"],
  review: ["M2 8s2.5-3.8 6-3.8S14 8 14 8s-2.5 3.8-6 3.8S2 8 2 8z", "M8 6.6a1.4 1.4 0 100 2.8 1.4 1.4 0 100-2.8z"],
  back: ["M9.5 3.5L5 8l4.5 4.5"],
  plus: ["M8 3.5v9", "M3.5 8h9"],
  stop: ["M5 5h6v6H5z"]
};

/** One 16px stroked glyph. Unknown names render an empty (but valid) svg. */
export function icon(name: keyof typeof PATHS | string, className = "hub-icon"): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.3");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", className);
  for (const data of PATHS[name] ?? []) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", data);
    svg.append(path);
  }
  return svg;
}
