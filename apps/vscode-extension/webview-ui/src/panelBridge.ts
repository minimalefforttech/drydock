/**
 * The request/response + push bridge every standalone Drydock webview speaks.
 *
 * The versioned envelope protocol, verbatim: requests carry a correlation id
 * and resolve against exactly one response; pushes fan out to per-type
 * subscribers. Self-contained on purpose - a panel or rail bundle must not drag
 * in the control panel's app state just to post a message, which is why this
 * acquires its own `vscode` handle rather than importing `state.js`.
 *
 * One bridge per bundle: `createPanelBridge` closes over the pending map, the
 * push handlers and the request counter, so the module a bundle wires it into
 * is the single instance every view in that bundle shares. The `prefix` keeps
 * request ids distinct between bundles - the host correlates in-flight requests
 * across every attached webview in one map, so two hosts must never mint the
 * same id.
 *
 * SECURITY: this moves display-safe envelopes only; rendering (via textContent,
 * never innerHTML) is the views' responsibility. The message listener also
 * only trusts host-posted messages (event.source === window.parent, or null
 * from this repo's test harness) - see the check in startMessaging() below.
 */

import {
  WEBVIEW_PROTOCOL_VERSION,
  type HostToWebviewMessage,
  type PanelPushPayload,
  type PanelRequestPayload,
  type PanelResponse
} from "@drydock/contracts";

export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const REQUEST_TIMEOUT_MS = 60_000;
/**
 * VM allocation, image preparation and provider boot legitimately outlast the
 * ordinary UI timeout on a cold host. A composer's start must not abandon a
 * response whose durable session then looks lost (the same allowance the chat
 * bridge makes).
 */
const SANDBOX_START_TIMEOUT_MS = 5 * 60_000;

type PushType = PanelPushPayload["type"];
type PushHandler<T extends PushType> = (payload: Extract<PanelPushPayload, { type: T }>) => void;

export interface PanelMessagingBridge {
  readonly vscode: VsCodeApi;
  /** Subscribe to one push type. Returns an unsubscribe function. */
  onPush<T extends PushType>(type: T, handler: PushHandler<T>): () => void;
  request(payload: PanelRequestPayload): Promise<PanelResponse>;
  /** Installs the single window message listener. Call once at boot. */
  startMessaging(): void;
}

export function createPanelBridge(prefix: string): PanelMessagingBridge {
  const vscode: VsCodeApi = acquireVsCodeApi();
  const pending = new Map<string, { resolve: (value: PanelResponse) => void; timer: number }>();
  const handlers = new Map<PushType, Set<(payload: PanelPushPayload) => void>>();
  let requestCounter = 0;

  function onPush<T extends PushType>(type: T, handler: PushHandler<T>): () => void {
    let set = handlers.get(type);
    if (!set) {
      set = new Set();
      handlers.set(type, set);
    }
    const wrapped = handler as (payload: PanelPushPayload) => void;
    set.add(wrapped);
    return () => set?.delete(wrapped);
  }

  function request(payload: PanelRequestPayload): Promise<PanelResponse> {
    requestCounter += 1;
    const requestId = `${prefix}-${String(requestCounter)}-${String(Date.now())}`;
    const timeoutMs = payload.type === "chat.startSession" ? SANDBOX_START_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
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
      }, timeoutMs);
      pending.set(requestId, { resolve, timer });
      vscode.postMessage({ protocolVersion: WEBVIEW_PROTOCOL_VERSION, kind: "request", requestId, payload });
    });
  }

  function startMessaging(): void {
    window.addEventListener("message", (event: MessageEvent<unknown>) => {
      // SECURITY: only the extension host may drive this bus. VS Code's
      // webview host relays extension messages via contentWindow.postMessage
      // from the OUTER host frame, so genuine messages arrive with
      // event.source === window.parent; this repo's test harness dispatches
      // synthetic events whose source defaults to null. Anything else - e.g.
      // a forged envelope from a sandboxed child iframe, whose source is its
      // own contentWindow - is neither and must be rejected before event.data
      // is read.
      if (event.source !== null && event.source !== window.parent) return;
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

  return { vscode, onPush, request, startMessaging };
}
