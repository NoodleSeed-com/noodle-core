import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForPublicPortal } from '../../../scripts/lib/system-release-portal-readiness.mjs';

const origin = 'https://portal.example.test';
const ready = '{"status":"ready"}\n200';

function fixture(responses: Array<string | Error>, durationMs = 30_000) {
  let clock = 100_000;
  const initial = clock;
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const executeAsync = vi.fn(
    async (
      _command: string,
      _args: string[],
      _limits: { timeoutMs: number; maxOutputBytes: number },
    ) => {
      const response = responses.length > 1 ? responses.shift() : responses[0];
      if (response instanceof Error) throw response;
      return response;
    },
  );
  const wait = vi.fn(async (milliseconds: number) => {
    clock += milliseconds;
  });
  const options = {
    url: origin,
    executeAsync,
    deadlineMs: initial + durationMs,
    nowMs: () => clock,
    wait,
  };
  return { options, executeAsync, wait, output, elapsed: () => clock - initial };
}

afterEach(() => vi.restoreAllMocks());

describe('public Portal readiness before billing activation', () => {
  it.each([
    undefined,
    '',
    'http://portal.example.test',
    'https://portal.example.test/path',
    'https://user:private@example.test',
    'https://127.0.0.1',
  ])('rejects invalid public origin %s before any command', async (url) => {
    const f = fixture([ready]);
    await expect(waitForPublicPortal({ ...f.options, url })).rejects.toThrow(
      'public Portal origin',
    );
    expect(f.executeAsync).not.toHaveBeenCalled();
    expect(f.wait).not.toHaveBeenCalled();
  });

  it('requires a verified HTTPS HTTP200 ready response with bounded command output', async () => {
    const f = fixture([ready]);
    await expect(waitForPublicPortal(f.options)).resolves.toBeUndefined();
    expect(f.executeAsync).toHaveBeenCalledWith(
      'curl',
      [
        '--silent',
        '--show-error',
        '--proto',
        '=https',
        '--max-time',
        '10',
        '--max-redirs',
        '0',
        '--write-out',
        '\n%{http_code}',
        `${origin}/readyz`,
      ],
      { timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 },
    );
    expect(f.wait).not.toHaveBeenCalled();
    expect(f.output).not.toHaveBeenCalled();
  });

  it('waits through certificate provisioning and reports that wait only once', async () => {
    const f = fixture([new Error('private-token from curl'), '{"status":"pending"}\n503', ready]);
    await waitForPublicPortal(f.options);
    expect(f.executeAsync).toHaveBeenCalledTimes(3);
    expect(f.elapsed()).toBe(20_000);
    expect(f.output).toHaveBeenCalledTimes(1);
    expect(f.output.mock.calls[0]?.[0]).toMatch(/Waiting for public Portal HTTPS readiness/);
    expect(JSON.stringify(f.output.mock.calls)).not.toContain('private-token');
  });

  it.each([
    '{"status":"pending"}\n200',
    '{"status":"ready"}\n302',
    '{"status":"ready"}\n503',
    '<html>private response</html>\n200',
    'null\n200',
    '[]\n200',
    '{"status":"ready"}',
  ])('does not accept an unrelated body or unsuccessful HTTP status', async (response) => {
    const f = fixture([response], 21_000);
    await expect(waitForPublicPortal(f.options)).rejects.toThrow('public Portal HTTPS readiness');
    expect(f.executeAsync).toHaveBeenCalledTimes(3);
    expect(f.elapsed()).toBe(21_000);
    expect(f.output).toHaveBeenCalledTimes(1);
  });

  it('caps provisioning wait at fifteen minutes even when the job has more time', async () => {
    const f = fixture([new Error('certificate pending')], 60 * 60_000);
    await expect(waitForPublicPortal(f.options)).rejects.toThrow('public Portal HTTPS readiness');
    expect(f.elapsed()).toBe(15 * 60_000);
    expect(f.executeAsync).toHaveBeenCalledTimes(90);
  });

  it('honors a shorter rollback deadline in both the command timeout and retry wait', async () => {
    const f = fixture([new Error('private stderr')], 7500);
    await expect(waitForPublicPortal(f.options)).rejects.toThrow('public Portal HTTPS readiness');
    expect(f.elapsed()).toBe(7500);
    expect(f.executeAsync).toHaveBeenCalledTimes(1);
    expect(f.executeAsync.mock.calls[0]?.[1]).toContain('7.5');
    expect(f.executeAsync.mock.calls[0]?.[2]).toEqual({
      timeoutMs: 7500,
      maxOutputBytes: 1024 * 1024,
    });
    expect(JSON.stringify(f.output.mock.calls)).not.toContain('private stderr');
  });

  it.each([
    0,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('does not start commands with an unusable deadline %s', async (deadlineMs) => {
    const f = fixture([ready]);
    await expect(waitForPublicPortal({ ...f.options, deadlineMs })).rejects.toThrow(
      'public Portal',
    );
    expect(f.executeAsync).not.toHaveBeenCalled();
  });
});
