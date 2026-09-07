import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/index.js';
import { assertJsonEnvelope } from './helpers/json-envelope.js';

describe.sequential('automatic entrypoint diagnostics', () => {
  let dir: string;
  let home: string;
  let cwd: string;
  let previousEnvironmentEntrypoint: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-entrypoint-diagnostics-'));
    home = mkdtempSync(join(tmpdir(), 'noodle-entrypoint-home-'));
    cwd = process.cwd();
    previousEnvironmentEntrypoint = process.env.NOODLE_ENTRYPOINT;
    delete process.env.NOODLE_ENTRYPOINT;
    process.chdir(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(cwd);
    if (previousEnvironmentEntrypoint === undefined) delete process.env.NOODLE_ENTRYPOINT;
    else process.env.NOODLE_ENTRYPOINT = previousEnvironmentEntrypoint;
    logSpy.mockRestore();
    errorSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function writeJson(path: string, value: unknown): void {
    writeFileSync(join(dir, path), `${JSON.stringify(value, null, 2)}\n`);
  }

  function writeServer(path: string): void {
    writeFileSync(
      join(dir, path),
      `
import { server, tool, z } from '@noodleseed/one';
export default server('entrypoint_test', {
  title: 'Entrypoint Test',
  version: '1.0.0'
}, [tool('ping', {
  description: 'Return pong',
  input: z.object({}),
  fulfil: () => ({ pong: true })
})]);
`,
    );
  }

  function lastJsonOutput(): ReturnType<typeof assertJsonEnvelope> {
    const raw = logSpy.mock.calls.at(-1)?.[0];
    if (typeof raw !== 'string') throw new Error('expected a JSON stdout envelope');
    return assertJsonEnvelope(JSON.parse(raw));
  }

  it('loads a noodle.json subdirectory entrypoint for no-argument validate and auth doctor', async () => {
    mkdirSync(join(dir, 'app'));
    writeServer('app/server.ts');
    writeJson('noodle.json', { entrypoint: 'app/server.ts' });

    expect(await run(['validate'], { NOODLE_UPDATE_MODE: 'off' }, home)).toBe(0);
    expect(await run(['auth', 'doctor'], { NOODLE_UPDATE_MODE: 'off' }, home)).toBe(0);
  });

  it('loads the same conventional entrypoint for no-argument validate and auth doctor', async () => {
    writeServer('server.ts');

    expect(await run(['validate'], { NOODLE_UPDATE_MODE: 'off' }, home)).toBe(0);
    expect(await run(['auth', 'doctor'], { NOODLE_UPDATE_MODE: 'off' }, home)).toBe(0);
  });

  it.each([
    ['validate'],
    ['auth', 'doctor'],
  ])('reports the stale local link before %s loads a lower-precedence entrypoint', async (...argv) => {
    mkdirSync(join(dir, '.noodle'));
    mkdirSync(join(dir, 'app'));
    writeServer('app/server.ts');
    writeJson('.noodle/project.json', { entrypoint: 'server.ts' });
    writeJson('noodle.json', { entrypoint: 'app/server.ts' });

    expect(await run([...argv, '--json'], { NOODLE_UPDATE_MODE: 'off' }, home)).toBe(2);
    const envelope = lastJsonOutput();
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure envelope');
    expect(envelope.error).toMatchObject({
      code: 'project_entrypoint_missing',
      message: 'Configured project entrypoint does not exist.',
      cause: '.noodle/project.json sets entrypoint to "server.ts", but that file does not exist.',
      next: 'noodle link --entrypoint app/server.ts',
      detail: { source: '.noodle/project.json', entrypoint: 'server.ts' },
    });
    expect(envelope.error.code).not.toBe('auth_entrypoint_load');
    expect(envelope.error.code).not.toBe('auth_doctor_failed');
  });
});
