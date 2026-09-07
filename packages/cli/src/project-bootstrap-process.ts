import { spawn } from 'node:child_process';

export type BootstrapProcessCode =
  | 'command_failed'
  | 'command_timeout'
  | 'missing_executable'
  | 'cancelled';
export type BootstrapProcessResult =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly code: BootstrapProcessCode; readonly stdout: '' };
export interface BootstrapProcessOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}
export type BootstrapExecutor = (
  command: string,
  args: readonly string[],
  options: BootstrapProcessOptions,
) => Promise<BootstrapProcessResult>;

/** No shell, bounded output/time, and no failed stdout/stderr reflected into recovery data. */
export const runBootstrapProcess: BootstrapExecutor = (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let done = false;
    let stopped: BootstrapProcessCode | undefined;
    let output = '';
    let bytes = 0;
    let force: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid !== undefined) {
        // Signal only the process group we created, including ordinary child processes.
        try {
          process.kill(-child.pid, signal);
        } catch {}
      }
    };
    const stop = (code: BootstrapProcessCode) => {
      if (stopped || done) return;
      stopped = code;
      kill('SIGTERM');
      force = setTimeout(() => kill('SIGKILL'), 1_000);
    };
    const timer = setTimeout(() => stop('command_timeout'), options.timeoutMs ?? 180_000);
    const interrupt = () => stop('cancelled');
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    const finish = (result: BootstrapProcessResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (force) clearTimeout(force);
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
      resolve(result);
    };
    const capture = (chunk: Buffer, stdout: boolean) => {
      bytes += chunk.byteLength;
      if (bytes > (options.maxOutputBytes ?? 1024 * 1024)) stop('command_failed');
      else if (stdout && !stopped) output += chunk.toString('utf8');
    };
    child.stdout?.on('data', (chunk: Buffer) => capture(chunk, true));
    child.stderr?.on('data', (chunk: Buffer) => capture(chunk, false));
    child.once('error', () => finish({ ok: false, code: 'missing_executable', stdout: '' }));
    child.once('close', (code) =>
      finish(
        code === 0 && !stopped
          ? { ok: true, stdout: output }
          : { ok: false, code: stopped ?? 'command_failed', stdout: '' },
      ),
    );
  });
