/**
 * Structured process execution for adapter-owned host control commands.
 *
 * This runner accepts command plus argv, captures bounded output, and supports
 * stdin without invoking a shell. Batch scripts (.cmd/.bat) are refused
 * outright: they can only run through cmd.exe, whose argument parsing cannot
 * be made injection-safe for untrusted argv such as prompt-derived text.
 */

import { spawn } from "node:child_process";
import type { CommandResult, CommandRunner, CommandRunnerOptions } from "@drydock/contracts";

const MAX_CAPTURED_OUTPUT = 120_000;

export class SpawnCommandRunner implements CommandRunner {
  run(command: string, args: readonly string[], options: CommandRunnerOptions): Promise<CommandResult> {
    const started = Date.now();
    return new Promise<CommandResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let stdoutLineBuffer = "";
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let child: ReturnType<typeof spawn> | undefined;

      const finish = (partial: Omit<CommandResult, "command" | "args" | "cwd" | "stdout" | "stderr" | "durationMs">): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", abortHandler);
        resolve({
          command,
          args,
          cwd: options.cwd,
          stdout: truncate(sanitizeOutput(stdout)),
          stderr: truncate(sanitizeOutput(stderr)),
          durationMs: Date.now() - started,
          ...partial
        });
      };

      const abortHandler = (): void => {
        child?.kill();
        finish({
          exitCode: child?.exitCode ?? null,
          signal: child?.signalCode ?? null,
          timedOut: false,
          error: "Aborted"
        });
      };

      if (options.signal?.aborted) {
        finish({ exitCode: null, signal: null, timedOut: false, error: "Aborted" });
        return;
      }

      let invocation: { readonly command: string; readonly args: string[] };
      try {
        invocation = makeSpawnInvocation(command, args);
      } catch (error) {
        finish({ exitCode: null, signal: null, timedOut: false, error: errorMessage(error) });
        return;
      }

      try {
        child = spawn(invocation.command, invocation.args, {
          cwd: options.cwd,
          env: options.env ?? process.env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true
        });
      } catch (error) {
        finish({ exitCode: null, signal: null, timedOut: false, error: errorMessage(error) });
        return;
      }

      options.signal?.addEventListener("abort", abortHandler, { once: true });

      timer = setTimeout(() => {
        child?.kill();
        finish({
          exitCode: child?.exitCode ?? null,
          signal: child?.signalCode ?? null,
          timedOut: true,
          error: `Timed out after ${options.timeoutMs}ms`
        });
      }, options.timeoutMs);

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        stdoutLineBuffer += chunk;
        while (true) {
          const newline = stdoutLineBuffer.indexOf("\n");
          if (newline === -1) break;
          const line = stdoutLineBuffer.slice(0, newline).replace(/\r$/, "");
          stdoutLineBuffer = stdoutLineBuffer.slice(newline + 1);
          options.onStdoutLine?.(sanitizeOutput(line));
        }
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        finish({ exitCode: null, signal: null, timedOut: false, error: error.message });
      });
      child.on("close", (exitCode, signal) => {
        finish({ exitCode, signal, timedOut: false });
      });

      if (options.input !== undefined) {
        child.stdin?.write(options.input);
      }
      child.stdin?.end();
    });
  }
}

export function makeSpawnInvocation(command: string, args: readonly string[]): { readonly command: string; readonly args: string[] } {
  if (/\.(cmd|bat)$/i.test(command)) {
    throw new Error(
      `Refusing to execute batch script "${command}" as a control binary. ` +
      "cmd.exe argument parsing cannot be made injection-safe; point to a native executable (.exe) instead."
    );
  }
  return { command, args: [...args] };
}

export function sanitizeOutput(value: string): string {
  return value.replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "sk-REDACTED");
}

export function truncate(value: string): string {
  if (value.length <= MAX_CAPTURED_OUTPUT) return value;
  return `${value.slice(0, MAX_CAPTURED_OUTPUT)}\n[truncated ${String(value.length - MAX_CAPTURED_OUTPUT)} chars]`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
