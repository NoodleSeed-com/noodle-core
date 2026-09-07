import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProcessRunner, renderSafeCommand } from '../../../scripts/lib/self-host-e2e.mjs';

describe('projected self-host acceptance process I/O', () => {
  it('renders commands without exposing sensitive argument values', () => {
    expect(
      renderSafeCommand('noodle', [
        'deploy',
        '--auth-token',
        'hidden-token',
        '--org',
        'local',
        'DATABASE_URL=postgresql://hidden',
      ]),
    ).toBe('noodle deploy --auth-token [REDACTED] --org local DATABASE_URL=[REDACTED]');
  });

  it('captures bounded subprocess output and fails on exits, signals, and timeouts', async () => {
    const runner = createProcessRunner();
    await expect(
      runner.run({
        stage: 'prerequisites',
        command: process.execPath,
        args: ['-e', 'process.stdout.write("ready")'],
        cwd: process.cwd(),
        timeoutMs: 2_000,
      }),
    ).resolves.toMatchObject({ stdout: 'ready', stderr: '', code: 0 });

    await expect(
      runner.run({
        stage: 'bootstrap',
        command: process.execPath,
        args: ['-e', 'process.stderr.write("admin-secret"); process.exit(7)'],
        cwd: process.cwd(),
        timeoutMs: 2_000,
        generatedSecrets: ['admin-secret'],
      }),
    ).rejects.toMatchObject({
      name: 'SelfHostE2EFailure',
      stage: 'bootstrap',
      safeTail: '[REDACTED]',
    });

    await expect(
      runner.run({
        stage: 'health',
        command: process.execPath,
        args: ['-e', "process.kill(process.pid, 'SIGTERM')"],
        cwd: process.cwd(),
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow('terminated by signal SIGTERM');

    await expect(
      runner.run({
        stage: 'health',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1_000)'],
        cwd: process.cwd(),
        timeoutMs: 50,
      }),
    ).rejects.toThrow('timed out after 50ms');
  });

  it('fails closed instead of discarding subprocess output beyond the audit bound', async () => {
    const runner = createProcessRunner();

    await expect(
      runner.run({
        stage: 'log-scan',
        command: process.execPath,
        args: ['-e', 'process.stdout.write("x".repeat(5 * 1024 * 1024))'],
        cwd: process.cwd(),
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow('command output exceeded the 4 MiB acceptance bound');
  });

  it('streams binary maintenance artifacts through private files outside the log bound', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noodle-self-host-e2e-binary-'));
    const runner = createProcessRunner();
    try {
      await expect(
        runner.run({
          stage: 'backup',
          command: process.execPath,
          args: ['-e', 'process.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1, 255))'],
          cwd: root,
          timeoutMs: 5_000,
          stdoutFile: 'database.dump',
        }),
      ).resolves.toMatchObject({ stdout: '', code: 0 });
      expect(statSync(join(root, 'database.dump')).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(root, 'database.dump')).byteLength).toBe(4 * 1024 * 1024 + 1);
      await expect(
        runner.run({
          stage: 'backup',
          command: process.execPath,
          args: [
            '-e',
            'let n=0; process.stdin.on("data", chunk => n += chunk.length); process.stdin.on("end", () => process.stdout.write(String(n)))',
          ],
          cwd: root,
          timeoutMs: 5_000,
          stdinFile: 'database.dump',
        }),
      ).resolves.toMatchObject({ stdout: String(4 * 1024 * 1024 + 1), code: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
