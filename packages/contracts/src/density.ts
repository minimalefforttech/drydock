/**
 * Card density levels (ADR 0013): how much a board card / fleet row renders
 * inline. `minimal` keeps one state chip and moves the rest into the per-card
 * hover card; `standard` is the classic chip set; `full` adds passive
 * metadata. The default comes from the `drydock.ui.cardDetail` setting,
 * injected by the panel providers as `<body data-card-detail="…">`; each
 * panel's toolbar control overrides it per panel (webview-persisted).
 */

export type CardDetailLevel = "minimal" | "standard" | "full";

export const CARD_DETAIL_LEVELS: readonly CardDetailLevel[] = ["minimal", "standard", "full"];

/** Sanitizes an untrusted value (setting, dataset, persisted state) to a level. */
export function cardDetailLevel(value: unknown): CardDetailLevel {
  return value === "standard" || value === "full" || value === "minimal" ? value : "minimal";
}
