import { ApiError } from '../services/errors.js';
import { childLogger } from '../services/logger.js';

export interface ExecRequest {
  /** Host directory bind-mounted into the sandbox as the working directory. */
  workspaceDir: string;
  /** Command and arguments. Never a shell string, so nothing is interpolated. */
  command: string;
  args: string[];
  timeoutMs: number;
  /** Extra environment for the command. Secrets are never passed here. */
  env?: Record<string, string>;
  /** Container port to publish, when starting a preview server. */
  publishPort?: number;
  /** Host port to bind the published port to. */
  hostPort?: number;
  signal?: AbortSignal;
  /** Label used in logs, e.g. "npm install". */
  label: string;
}

export interface ExecResult {
  exitCode: number;
  output: string;
  truncated: boolean;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
}

export interface SandboxDriver {
  readonly id: 'docker' | 'local';
  readonly isolationNote: string;
  available(): Promise<boolean>;
  /** Runs a command to completion, capturing combined output. */
  exec(request: ExecRequest): Promise<ExecResult>;
  /** Detaches a long-running server and returns once the port responds. */
  startServer(request: ExecRequest): Promise<{ handle: string; hostPort: number }>;
  stopServer(handle: string): Promise<void>;
  /** Releases resources associated with a workspace. */
  cleanup(workspaceDir: string): Promise<void>;
}

export const MAX_CAPTURED_OUTPUT = 60_000;

export function truncateOutput(text: string, limit = MAX_CAPTURED_OUTPUT): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= limit) return { text, truncated: false };
  const head = text.slice(0, Math.floor(limit * 0.6));
  const tail = text.slice(text.length - Math.floor(limit * 0.4));
  return {
    text: `${head}\n\n… [${text.length - limit} characters omitted] …\n\n${tail}`,
    truncated: true,
  };
}

/**
 * Runs a child process without a shell. Arguments are passed as an array, so
 * nothing in a generated project can be interpreted as a shell command.
 */
export async function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    signal?: AbortSignal;
    onOutput?: (chunk: string) => void;
  },
): Promise<ExecResult> {
  const { spawn } = await import('node:child_process');
  const started = Date.now();

  return new Promise<ExecResult>((resolve, reject) => {
    let settled = false;
    let captured = '';
    let truncated = false;
    let timedOut = false;
    let cancelled = false;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Never shell-interpret.
      shell: false,
    });

    const append = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      options.onOutput?.(text);
      if (captured.length < MAX_CAPTURED_OUTPUT * 2) {
        captured += text;
      } else {
        truncated = true;
      }
    };

    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const bounded = truncateOutput(captured);
      resolve({
        exitCode: code,
        output: bounded.text,
        truncated: truncated || bounded.truncated,
        durationMs: Date.now() - started,
        timedOut,
        cancelled,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, options.timeoutMs);

    const onAbort = () => {
      cancelled = true;
      killTree(child.pid);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(ApiError.internal(`Failed to start ${command}`, { err: String(e) }));
    });

    child.on('close', (code) => finish(code ?? -1));
  });
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    // Negative pid signals the whole process group, so npm's children die too.
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

export function sandboxLogger(label: string) {
  return childLogger({ sandbox: label });
}
