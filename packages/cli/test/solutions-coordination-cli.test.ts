import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSolutions } from '../src/commands/solutions-ops.js';

const resource = 'a'.repeat(64);
const token = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const flags = [
  '--org',
  'acme',
  '--service',
  'https://service.example.test',
  '--auth-token',
  'fixture',
  '--json',
];
let home: string;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-coordination-cli-'));
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  log.mockRestore();
  error.mockRestore();
  rmSync(home, { recursive: true, force: true });
});
const run = (args: string[], request: typeof fetch) =>
  runSolutions(['operations', 'coordination', ...args, ...flags], {}, home, { fetchImpl: request });

describe('administrator coordination CLI', () => {
  it('reads one exact page and strips additive fields recursively', async () => {
    const record = {
      resource,
      token,
      reference: 'provider-item',
      operationDigest: 'b'.repeat(64),
      state: 'unknown',
      startedAt: '2026-09-10T00:00:00.000Z',
      deadline: '2026-09-10T00:01:00.000Z',
    };
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        ok: true,
        future: 'hidden',
        data: {
          records: [{ ...record, private: 'hidden' }],
          nextBeforeResource: resource,
          private: 'hidden',
        },
      }),
    );
    expect(
      await run(['list', 'install', '--limit', '2', '--before-resource', resource], request),
    ).toBe(0);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe(
      `https://service.example.test/v1/orgs/acme/solution-installations/install/operations/coordination?limit=2&beforeResource=${resource}`,
    );
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      ok: true,
      data: { records: [record], nextBeforeResource: resource },
    });
  });
  it('submits explicit CAS and reason without inventing reviewer or changing external records', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: true, data: { resolved: true, private: 'hidden' } }),
    );
    expect(
      await run(
        [
          'resolve',
          'install',
          '--resource',
          resource,
          '--token',
          token,
          '--reason',
          'Verified external outcome',
        ],
        request,
      ),
    ).toBe(0);
    expect(request.mock.calls[0]?.[0]).toMatch(/\/operations\/coordination\/resolve$/);
    expect(request.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      resource,
      token,
      reason: 'Verified external outcome',
    });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      ok: true,
      data: { resolved: true },
    });
  });
  it.each([
    ['resolve', 'install'],
    ['resolve', 'install', '--resource', resource, '--token', token, '--reason', ' '],
    ['resolve', 'install', '--resource', resource, '--token', token, '--reason', 'a'.repeat(257)],
    [
      'resolve',
      'install',
      '--resource',
      resource,
      '--token',
      token,
      '--reason',
      'reviewed',
      '--limit',
      '1',
    ],
    ['list', 'install', '--before-resource', 'invalid'],
    ['list', 'install', '--limit', '101'],
    ['list', 'install', '--reason', 'invalid'],
    ['list', 'install', '--reviewer', 'forged'],
  ])('rejects unsupported or incomplete review before network IO: %s', async (...args) => {
    const request = vi.fn<typeof fetch>();
    expect(await run(args, request)).not.toBe(0);
    expect(request).not.toHaveBeenCalled();
  });
  it('does not retry a denied or stale resolution', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json(
        { error: 'The operation changed.', code: 'coordination_conflict' },
        { status: 409 },
      ),
    );
    expect(
      await run(
        ['resolve', 'install', '--resource', resource, '--token', token, '--reason', 'reviewed'],
        request,
      ),
    ).not.toBe(0);
    expect(request).toHaveBeenCalledOnce();
    expect(log.mock.calls.join(' ')).not.toContain('"resolved":true');
  });
});
