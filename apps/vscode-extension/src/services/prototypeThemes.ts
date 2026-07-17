/**
 * Prototype theme stylesheets (ADR 0017).
 *
 * Web-only prototyping needs prototypes that FEEL like the target app. These
 * packs are pushed into each previewing session's sandbox at
 * /workspace/.drydock-themes/<name>.css so agents link them instead of
 * hand-rolling native-looking chrome. Studios register more via the
 * `drydock.prototypeThemes` setting ({name, cssPath} entries, loaded at
 * activation and pushed alongside the built-ins).
 *
 * Each pack styles the same small vocabulary - body, headings, buttons,
 * inputs, selects, panels (.panel), toolbars (.toolbar), tabs (.tab/.active),
 * lists (.row/.selected), labels (.label) - so an agent can swap themes
 * without rewriting markup.
 */

export interface PrototypeTheme {
  /** File name stem (a-z0-9-); lands as /workspace/.drydock-themes/<name>.css */
  readonly name: string;
  readonly css: string;
}

const SHARED = `
* { box-sizing: border-box; }
body { margin: 0; padding: 12px; }
.toolbar { display: flex; gap: 6px; align-items: center; padding: 6px; }
.panel { padding: 10px; }
.row { display: flex; align-items: center; gap: 8px; padding: 4px 8px; }
.tab { display: inline-block; padding: 5px 14px; cursor: pointer; }
.label { font-size: 11px; opacity: 0.8; }
button, input, select { font: inherit; }
`;

export const BUILT_IN_PROTOTYPE_THEMES: readonly PrototypeTheme[] = [
  {
    // Qt Fusion dark - the Maya/Houdini/DCC feel: mid-grey chrome, dense
    // spacing, subtle 2px radii, steel-blue selection.
    name: "qt-dark",
    css: `${SHARED}
body { background: #444444; color: #dddddd; font: 12px "Segoe UI", sans-serif; }
h1, h2, h3 { font-weight: 600; color: #eeeeee; margin: 8px 0 6px; }
h1 { font-size: 14px; } h2 { font-size: 13px; } h3 { font-size: 12px; }
.panel { background: #4b4b4b; border: 1px solid #2e2e2e; border-radius: 2px; }
.toolbar { background: #3c3c3c; border-bottom: 1px solid #2e2e2e; }
button { background: #5a5a5a; color: #dddddd; border: 1px solid #2e2e2e; border-radius: 2px; padding: 3px 12px; }
button:hover { background: #656565; }
button.primary, button:default { background: #5285a6; border-color: #3f6a86; color: #ffffff; }
input, select { background: #383838; color: #dddddd; border: 1px solid #2e2e2e; border-radius: 2px; padding: 3px 6px; }
.row:hover { background: #4f5b66; }
.row.selected { background: #5285a6; color: #ffffff; }
.tab { background: #3c3c3c; border: 1px solid #2e2e2e; border-bottom: none; border-radius: 2px 2px 0 0; }
.tab.active { background: #4b4b4b; color: #ffffff; }
`
  },
  {
    // Slate (Unreal Editor) dark - near-black, sharp corners, thin hairlines,
    // uppercase micro-labels, Unreal-blue accents.
    name: "slate-dark",
    css: `${SHARED}
body { background: #151515; color: #c0c0c0; font: 12px "Segoe UI", sans-serif; }
h1, h2, h3 { color: #e0e0e0; text-transform: uppercase; letter-spacing: 0.06em; margin: 10px 0 6px; }
h1 { font-size: 13px; } h2 { font-size: 12px; } h3 { font-size: 11px; }
.panel { background: #1f1f1f; border: 1px solid #0a0a0a; }
.toolbar { background: #262626; border-bottom: 1px solid #0a0a0a; }
.label { text-transform: uppercase; letter-spacing: 0.05em; font-size: 10px; color: #8a8a8a; }
button { background: #383838; color: #cccccc; border: 1px solid #0a0a0a; border-radius: 0; padding: 4px 14px; }
button:hover { background: #454545; }
button.primary { background: #0070e0; border-color: #005bb8; color: #ffffff; }
input, select { background: #0f0f0f; color: #cccccc; border: 1px solid #383838; border-radius: 0; padding: 4px 6px; }
.row { border-bottom: 1px solid #0a0a0a; }
.row:hover { background: #252525; }
.row.selected { background: #2a4f76; color: #ffffff; }
.tab { background: #1a1a1a; border: 1px solid #0a0a0a; }
.tab.active { background: #262626; color: #ffffff; border-top: 2px solid #0070e0; }
`
  },
  {
    // VS Code dark - for tool-panel prototypes meant to live in the editor.
    name: "vscode-dark",
    css: `${SHARED}
body { background: #1e1e1e; color: #cccccc; font: 13px "Segoe UI", sans-serif; }
h1, h2, h3 { color: #e7e7e7; font-weight: 600; margin: 10px 0 6px; }
h1 { font-size: 15px; } h2 { font-size: 13px; } h3 { font-size: 12px; }
.panel { background: #252526; border: 1px solid #3c3c3c; border-radius: 4px; }
.toolbar { background: #2d2d2d; border-bottom: 1px solid #3c3c3c; }
button { background: #0e639c; color: #ffffff; border: none; border-radius: 3px; padding: 5px 14px; }
button:hover { background: #1177bb; }
button.secondary { background: #3a3d41; color: #cccccc; }
input, select { background: #3c3c3c; color: #cccccc; border: 1px solid #3c3c3c; border-radius: 3px; padding: 5px 8px; }
.row:hover { background: #2a2d2e; }
.row.selected { background: #094771; color: #ffffff; }
.tab { border-bottom: 2px solid transparent; opacity: 0.8; }
.tab.active { border-bottom-color: #007fd4; opacity: 1; }
`
  },
  {
    // Clean light - neutral product-mockup default.
    name: "clean-light",
    css: `${SHARED}
body { background: #f5f6f8; color: #1f2328; font: 14px "Segoe UI", system-ui, sans-serif; }
h1, h2, h3 { color: #111418; margin: 12px 0 8px; }
h1 { font-size: 20px; } h2 { font-size: 16px; } h3 { font-size: 14px; }
.panel { background: #ffffff; border: 1px solid #d9dde3; border-radius: 8px; box-shadow: 0 1px 2px rgba(16, 24, 40, 0.05); }
.toolbar { background: #ffffff; border-bottom: 1px solid #d9dde3; }
button { background: #1f6feb; color: #ffffff; border: none; border-radius: 6px; padding: 7px 16px; }
button:hover { background: #1a5fd0; }
button.secondary { background: #ffffff; color: #1f2328; border: 1px solid #d9dde3; }
input, select { background: #ffffff; color: #1f2328; border: 1px solid #d9dde3; border-radius: 6px; padding: 7px 10px; }
.row:hover { background: #f0f3f6; }
.row.selected { background: #dbe9ff; }
.tab { border-bottom: 2px solid transparent; color: #57606a; }
.tab.active { border-bottom-color: #1f6feb; color: #111418; }
`
  }
];

/** Valid theme file-name stem (shell- and path-safe by construction). */
export function isValidThemeName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,40}$/.test(name);
}
