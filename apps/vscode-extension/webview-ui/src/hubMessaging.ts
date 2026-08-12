/**
 * The Task Hub panel's bridge instance (UX overhaul, P3).
 *
 * See `panelBridge.ts` for the protocol - including the longer timeout the
 * composer's `chat.startSession` needs on a cold host.
 */

import { createPanelBridge } from "./panelBridge.js";

export const { vscode, onPush, request, startMessaging } = createPanelBridge("hub");
