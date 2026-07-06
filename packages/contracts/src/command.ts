/**
 * Structured command-runner contracts.
 *
 * Runtime and agent adapters execute only allowlisted host control commands
 * through this shape so logs can be redacted consistently.
 */

export interface CommandResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly error?: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options: CommandRunnerOptions): Promise<CommandResult>;
}

export interface CommandRunnerOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
  /** Aborting kills the child process; the result reports the abort as an error. */
  readonly signal?: AbortSignal;
  /** Observes each complete stdout line as it arrives; stdout is still captured in full. */
  readonly onStdoutLine?: (line: string) => void;
}

