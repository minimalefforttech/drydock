/**
 * Line-delimited JSON-RPC client used by Codex app-server probes.
 *
 * The client answers unexpected server requests with method-not-found so the
 * server does not block on unimplemented UI callbacks.
 */

import { spawn } from "node:child_process";
import type { JsonValue } from "@drydock/contracts";
import { errorMessage, makeSpawnInvocation, sanitizeOutput } from "@drydock/core";

export interface JsonRpcMessage {
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: JsonValue;
  readonly result?: JsonValue;
  readonly error?: {
    readonly code?: number;
    readonly message?: string;
    readonly data?: JsonValue;
  };
}

interface NotificationWaiter {
  resolve(message: JsonRpcMessage): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

export class LineJsonRpcClient {
  readonly notifications: JsonRpcMessage[] = [];
  private child: ReturnType<typeof spawn> | null = null;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private readonly notificationQueue: JsonRpcMessage[] = [];
  private readonly notificationWaiters: NotificationWaiter[] = [];
  private nextId = 1;
  private readonly pending = new Map<number, {
    readonly resolve: (value: JsonValue) => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
  }>();

  constructor(
    private readonly command: string,
    private readonly args: readonly string[],
    private readonly cwd: string
  ) {}

  async start(): Promise<void> {
    const invocation = makeSpawnInvocation(this.command, this.args);
    this.child = spawn(invocation.command, invocation.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    this.child.stdout?.setEncoding("utf8");
    this.child.stderr?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrBuffer += sanitizeOutput(chunk);
    });
    this.child.on("error", (error) => this.rejectAll(new Error(`app-server process error: ${error.message}`)));
    this.child.on("exit", (code, signal) => {
      this.rejectAll(new Error(`app-server process exited before completing pending requests: code=${String(code)} signal=${String(signal)}`));
    });

    await delay(200);
    if (this.child.exitCode !== null) {
      throw new Error(`app-server process exited immediately with code ${String(this.child.exitCode)}. ${oneLine(this.stderrBuffer)}`);
    }
  }

  request(method: string, params: JsonValue, timeoutMs: number): Promise<JsonValue> {
    if (!this.child?.stdin) {
      throw new Error("app-server process is not running.");
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method} response after ${String(timeoutMs)}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin?.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method: string, params: JsonValue): void {
    this.child?.stdin?.write(`${JSON.stringify({ method, params })}\n`);
  }

  nextNotification(signal?: AbortSignal): Promise<JsonRpcMessage> {
    const queued = this.notificationQueue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    if (signal?.aborted) {
      return Promise.reject(new Error("Notification wait aborted."));
    }
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const waiter: NotificationWaiter = {
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal })
      };
      if (signal !== undefined) {
        const abortHandler = (): void => {
          this.removeNotificationWaiter(waiter);
          reject(new Error("Notification wait aborted."));
        };
        waiter.abortHandler = abortHandler;
        signal.addEventListener("abort", abortHandler, { once: true });
      }
      this.notificationWaiters.push(waiter);
    });
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    this.child.stdin?.end();
    if (this.child.exitCode === null) {
      this.child.kill();
      await delay(150);
    }
    this.rejectNotificationWaiters(new Error("app-server process stopped."));
  }

  diagnostics(): string[] {
    return [
      oneLine(`stdout: ${this.stdoutBuffer}`),
      oneLine(`stderr: ${this.stderrBuffer}`),
      `notifications observed: ${String(this.notifications.length)}`
    ];
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += sanitizeOutput(chunk);
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.onMessage(JSON.parse(line) as JsonRpcMessage);
      } catch (error) {
        this.stderrBuffer += `\nNon-JSON stdout line: ${oneLine(`${line} ${errorMessage(error)}`)}`;
      }
    }
  }

  private onMessage(message: JsonRpcMessage): void {
    if (message.id !== undefined && message.id !== null && (message.result !== undefined || message.error !== undefined)) {
      const id = typeof message.id === "number" ? message.id : Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (message.error) {
        pending.reject(new Error(`app-server error ${String(message.error.code)}: ${message.error.message ?? "unknown error"}`));
      } else {
        pending.resolve(message.result ?? null);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      this.respondMethodNotFound(message);
      return;
    }

    this.pushNotification(message);
  }

  private respondMethodNotFound(message: JsonRpcMessage): void {
    this.child?.stdin?.write(`${JSON.stringify({
      id: message.id ?? null,
      error: {
        code: -32601,
        message: `Client method not implemented: ${message.method ?? "unknown"}`
      }
    })}\n`);
  }

  private rejectAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.rejectNotificationWaiters(error);
  }

  private pushNotification(message: JsonRpcMessage): void {
    this.notifications.push(message);
    const waiter = this.notificationWaiters.shift();
    if (waiter === undefined) {
      this.notificationQueue.push(message);
      return;
    }
    if (waiter.signal !== undefined && waiter.abortHandler !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.abortHandler);
    }
    waiter.resolve(message);
  }

  private removeNotificationWaiter(waiter: NotificationWaiter): void {
    const index = this.notificationWaiters.indexOf(waiter);
    if (index !== -1) {
      this.notificationWaiters.splice(index, 1);
    }
  }

  private rejectNotificationWaiters(error: Error): void {
    for (const waiter of this.notificationWaiters.splice(0)) {
      if (waiter.signal !== undefined && waiter.abortHandler !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.abortHandler);
      }
      waiter.reject(error);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 2000);
}
