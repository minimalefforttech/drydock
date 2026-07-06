/**
 * Minimal structured logging interfaces.
 *
 * Output channels, smoke harnesses, and tests can share the same service code
 * without depending on VS Code APIs.
 */

import type { JsonObject } from "@drydock/contracts";

export interface Logger {
  info(message: string, data?: JsonObject): void;
  warn(message: string, data?: JsonObject): void;
  error(message: string, data?: JsonObject): void;
}

export class ConsoleLogger implements Logger {
  info(message: string, data?: JsonObject): void {
    console.log(format("info", message, data));
  }

  warn(message: string, data?: JsonObject): void {
    console.warn(format("warn", message, data));
  }

  error(message: string, data?: JsonObject): void {
    console.error(format("error", message, data));
  }
}

export class MemoryLogger implements Logger {
  readonly entries: Array<{ readonly level: "info" | "warn" | "error"; readonly message: string; readonly data?: JsonObject }> = [];

  info(message: string, data?: JsonObject): void {
    this.push("info", message, data);
  }

  warn(message: string, data?: JsonObject): void {
    this.push("warn", message, data);
  }

  error(message: string, data?: JsonObject): void {
    this.push("error", message, data);
  }

  private push(level: "info" | "warn" | "error", message: string, data?: JsonObject): void {
    if (data === undefined) {
      this.entries.push({ level, message });
    } else {
      this.entries.push({ level, message, data });
    }
  }
}

function format(level: string, message: string, data?: JsonObject): string {
  return data === undefined
    ? `[drydock:${level}] ${message}`
    : `[drydock:${level}] ${message} ${JSON.stringify(data)}`;
}

