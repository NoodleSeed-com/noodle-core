import { describe, expect, it } from 'vitest';
import { createLogger, noopLogger, stderrSink, stdoutSink } from '../src/index.js';

function capture(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line) => lines.push(line) };
}
const FIXED = (): number => 1_700_000_000_000;

describe('createLogger', () => {
  it('emits one JSON line per call with ts/level/event + allowlisted fields', () => {
    const { lines, sink } = capture();
    createLogger({ sink, clock: FIXED }).info('mcp.request', { serverId: 's1', status: 200 });
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0] ?? '{}');
    expect(rec).toMatchObject({ level: 'info', event: 'mcp.request', serverId: 's1', status: 200 });
    expect(rec.ts).toBe(new Date(FIXED()).toISOString());
  });

  it('drops levels below the configured threshold', () => {
    const { lines, sink } = capture();
    const log = createLogger({ sink, level: 'warn' });
    log.info('a');
    log.debug('b');
    log.warn('c');
    log.error('d');
    expect(lines.map((line) => JSON.parse(line).event)).toEqual(['c', 'd']);
  });

  it('does not let a field overwrite the reserved ts/level/event keys', () => {
    const { lines, sink } = capture();
    createLogger({ sink, clock: FIXED }).info('real', {
      event: 'spoof',
      level: 'error',
      ts: 'nope',
      ok: true,
    });
    const rec = JSON.parse(lines[0] ?? '{}');
    expect(rec.event).toBe('real');
    expect(rec.level).toBe('info');
    expect(rec.ts).toBe(new Date(FIXED()).toISOString());
    expect(rec.ok).toBe(true);
  });

  it('coerces a non-scalar field value to [unloggable] (no object stringified into the line)', () => {
    const { lines, sink } = capture();
    createLogger({ sink }).info('e', { bad: { token: 'leak-me' } as unknown as string });
    expect(lines.join('\n')).not.toContain('leak-me');
    expect(JSON.parse(lines[0] ?? '{}').bad).toBe('[unloggable]');
  });

  it('redacts sensitive field names as a defense-in-depth backstop', () => {
    const { lines, sink } = capture();
    createLogger({ sink }).info('e', {
      authorization: 'Bearer should-not-leak',
      secretName: 'API_TOKEN',
      credentialId: 'cred-1',
      ok: 'safe',
    });
    const joined = lines.join('\n');
    expect(joined).not.toContain('should-not-leak');
    expect(joined).not.toContain('API_TOKEN');
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      authorization: '[redacted]',
      secretName: '[redacted]',
      credentialId: '[redacted]',
      ok: 'safe',
    });
  });

  it('child() merges base fields into every record', () => {
    const { lines, sink } = capture();
    createLogger({ sink, base: { svc: 'noodle' } })
      .child({ rid: 'r1' })
      .info('e');
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ svc: 'noodle', rid: 'r1', event: 'e' });
  });

  it('noopLogger emits nothing and never throws', () => {
    expect(() => {
      noopLogger.info('x', { a: 1 });
      noopLogger.child({ b: 2 }).warn('y');
    }).not.toThrow();
  });

  it('provides explicit stdout and stderr sinks for transport-safe wiring', () => {
    const stdoutWrite = process.stdout.write;
    const stderrWrite = process.stderr.write;
    const out: string[] = [];
    const err: string[] = [];
    Object.defineProperty(process.stdout, 'write', {
      value: (chunk: string) => {
        out.push(chunk);
        return true;
      },
      configurable: true,
    });
    Object.defineProperty(process.stderr, 'write', {
      value: (chunk: string) => {
        err.push(chunk);
        return true;
      },
      configurable: true,
    });
    try {
      stdoutSink('out');
      stderrSink('err');
    } finally {
      Object.defineProperty(process.stdout, 'write', { value: stdoutWrite, configurable: true });
      Object.defineProperty(process.stderr, 'write', { value: stderrWrite, configurable: true });
    }
    expect(out).toEqual(['out\n']);
    expect(err).toEqual(['err\n']);
  });
});
