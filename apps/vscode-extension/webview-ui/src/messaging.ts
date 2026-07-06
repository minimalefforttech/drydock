/**
 * Request/response + push routing for the chat panel webview.
 *
 * Preserves the versioned envelope protocol exactly: requests carry a
 * correlation id and resolve against exactly one response; pushes are routed to
 * per-type subscribers. Views subscribe to the push types they care about.
 *
 * SECURITY: this module moves display-safe envelopes only; rendering (via
 * textContent, never innerHTML) is the views' responsibility.
 */

import {
  WEBVIEW_PROTOCOL_VERSION,
  type HostToWebviewMessage,
  type PanelPushPayload,
  type PanelRequestPayload,
  type PanelResponse
} from "@drydock/contracts";
import { vscode } from "./state.js";

const REQUEST_TIMEOUT_MS = 60_000;
const pending = new Map<string, { resolve: (value: PanelResponse) => void; timer: number }>();
let requestCounter = 0;

type PushType = PanelPushPayload["type"];
type PushHandler<T extends PushType> = (payload: Extract<PanelPushPayload, { type: T }>) => void;

const handlers = new Map<PushType, Set<(payload: PanelPushPayload) => void>>();

/** Subscribe to one push type. Returns an unsubscribe function. */
export function onPush<T extends PushType>(type: T, handler: PushHandler<T>): () => void {
  let set = handlers.get(type);
  if (!set) {
    set = new Set();
    handlers.set(type, set);
  }
  const wrapped = handler as (payload: PanelPushPayload) => void;
  set.add(wrapped);
  return () => set?.delete(wrapped);
}

export function request(payload: PanelRequestPayload): Promise<PanelResponse> {
  requestCounter += 1;
  const requestId = `req-${String(requestCounter)}-${String(Date.now())}`;
  return new Promise<PanelResponse>((resolve) => {
    const timer = window.setTimeout(() => {
      pending.delete(requestId);
      resolve({
        protocolVersion: WEBVIEW_PROTOCOL_VERSION,
        kind: "response",
        requestId,
        ok: false,
        error: { message: "The extension host did not answer in time." }
      });
    }, REQUEST_TIMEOUT_MS);
    pending.set(requestId, { resolve, timer });
    vscode.postMessage({ protocolVersion: WEBVIEW_PROTOCOL_VERSION, kind: "request", requestId, payload });
  });
}

/** Installs the single window message listener. Call once at boot. */
export function startMessaging(): void {
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    const message = event.data as HostToWebviewMessage;
    if (typeof message !== "object" || message === null) return;
    if (message.protocolVersion !== WEBVIEW_PROTOCOL_VERSION) return;
    if (message.kind === "response") {
      const entry = pending.get(message.requestId);
      if (entry) {
        window.clearTimeout(entry.timer);
        pending.delete(message.requestId);
        entry.resolve(message);
      }
      return;
    }
    if (message.kind === "push") {
      const set = handlers.get(message.payload.type);
      if (set) {
        for (const handler of set) handler(message.payload);
      }
    }
  });
}
