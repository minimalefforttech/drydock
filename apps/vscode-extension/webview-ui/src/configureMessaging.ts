/**
 * The Configure panel's bridge instance (UX overhaul P6).
 *
 * See `panelBridge.ts` for the protocol.
 */

import { createPanelBridge } from "./panelBridge.js";

export const { vscode, onPush, request, startMessaging } = createPanelBridge("cfg");
