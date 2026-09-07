import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runBootstrapProcess } from '../src/project-bootstrap-process.js';

describe('bounded bootstrap command execution', () => {
  const options = { cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs: 2_000 };
  it('captures a bounded version result without a shell', async () => {
    expect(
      await runBootstrapProcess(process.execPath, ['-e', "console.log('1.2.3')"], options),
    ).toEqual({ ok: true, stdout: '1.2.3\n' });
  });
  it('does not reflect failed command output', async () => {
    const result = await runBootstrapProcess(
      process.execPath,
      ['-e', "console.log('private-output'); console.error('private-error'); process.exit(1)"],
      options,
    );
    expect(result).toEqual({ ok: false, code: 'command_failed', stdout: '' });
    expect(JSON.stringify(result)).not.toContain('private-');
  });
  it('classifies missing executables and timeouts safely', async () => {
    expect(await runBootstrapProcess('/noodle-fixture-missing-executable', [], options)).toEqual({
      ok: false,
      code: 'missing_executable',
      stdout: '',
    });
    expect(
      await runBootstrapProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        ...options,
        timeoutMs: 40,
      }),
    ).toEqual({ ok: false, code: 'command_timeout', stdout: '' });
  });
  it('terminates excessive output without returning it', async () => {
    const result = await runBootstrapProcess(
      process.execPath,
      ['-e', "process.stdout.write('x'.repeat(10000))"],
      { ...options, maxOutputBytes: 1_000 },
    );
    expect(result).toEqual({ ok: false, code: 'command_failed', stdout: '' });
  });

  it('cancels the owned child process when the bootstrap receives a termination signal', async () => {
    const modulePath = fileURLToPath(
      new URL('../src/project-bootstrap-process.ts', import.meta.url),
    );
    const source = `import { runBootstrapProcess } from ${JSON.stringify(modulePath)};
const running = runBootstrapProcess(process.execPath, ['-e', 'setTimeout(() => {}, 3000) // noodle-bootstrap-signal-fixture'], { cwd: process.cwd(), env: {}, timeoutMs: 3000 });
console.log('armed'); console.log(JSON.stringify(await running));`;
    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      let interrupted = false;
      child.stdout.on('data', (chunk) => {
        output += String(chunk);
        if (!interrupted && output.includes('armed')) {
          interrupted = true;
          child.kill('SIGTERM');
        }
      });
      child.once('error', reject);
      child.once('close', () => resolve(output));
    });
    expect(result).toContain('"code":"cancelled"');
  });
});
