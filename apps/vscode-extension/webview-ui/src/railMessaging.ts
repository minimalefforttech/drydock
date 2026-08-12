/**
 * The left-rail webviews' bridge instance (UX overhaul, P1).
 *
 * One bridge shared by all three rail views, since they ship as one bundle
 * switched by `body[data-view]`. See `panelBridge.ts` for the protocol.
 */

import { createPanelBridge } from "./panelBridge.js";

export const { vscode, onPush, request, startMessaging } = createPanelBridge("rail");
