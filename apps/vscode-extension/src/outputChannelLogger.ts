/**
 * Logger adapter that writes structured lines into the extension's
 * output channel.
 */

import * as vscode from "vscode";
import type { JsonObject } from "@drydock/contracts";
import type { Logger } from "@drydock/core";

export class OutputChannelLogger implements Logger {
  constructor(private readonly output: vscode.OutputChannel) {}

  info(message: string, data?: JsonObject): void {
    this.write("info", message, data);
  }

  warn(message: string, data?: JsonObject): void {
    this.write("warn", message, data);
  }

  error(message: string, data?: JsonObject): void {
    this.write("error", message, data);
  }

  private write(level: string, message: string, data?: JsonObject): void {
    this.output.appendLine(data === undefined
      ? `[${level}] ${message}`
      : `[${level}] ${message} ${JSON.stringify(data)}`);
  }
}
