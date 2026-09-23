import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSolutions } from '../src/commands/solutions-ops.js';

let home: string;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
const flags = [
  '--org',
  'acme',
  '--service',
  'https://cloud.example.test',
  '--auth-token',
  'fixture-owner',
  '--json',
];
const revision = 'a'.repeat(64);
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-activity-cli-'));
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  log.mockRestore();
  error.mockRestore();
  rmSync(home, { recursive: true, force: true });
});
describe('solutions activity CLI', () => {
  it('uses the bounded list projection and omits unrecognized response data', async () => {
    const activity = {
      id: revision,
      tool: 'create_item',
      operation: 'create',
      outcome: 'returned',
      startedAt: '2026-09-06T00:00:00.000Z',
    };
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        ok: true,
        data: {
          activities: [{ ...activity, raw: 'never-output' }],
          historyDays: 30,
          nextCursor: 'opaque',
          future: 'never-output',
        },
      }),
    );
    expect(
      await runSolutions(
        ['activity', 'list', 'install', '--limit', '10', '--cursor', 'opaque/input', ...flags],
        {},
        home,
        { fetchImpl: request },
      ),
    ).toBe(0);
    expect(request.mock.calls[0]?.[0]).toBe(
      'https://cloud.example.test/v1/orgs/acme/solution-installations/install/activity?limit=10&cursor=opaque%2Finput',
    );
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      ok: true,
      data: { activities: [activity], historyDays: 30, nextCursor: 'opaque' },
    });
  });
  it('exports a single authorized page with actor and connection and preserves the purpose cursor', async () => {
    const activity = {
      id: revision,
      actorReference: 'b'.repeat(64),
      connectionId: 'calendar',
      tool: 'book',
      operation: 'create',
      outcome: 'completed',
      startedAt: '2026-09-06T00:00:00.000Z',
    };
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        ok: true,
        data: {
          activities: [{ ...activity, actorDigest: 'private' }],
          historyDays: 30,
          nextCursor: 'next',
        },
      }),
    );
    expect(
      await runSolutions(
        ['activity', 'export', 'install', '--limit', '2', '--cursor', 'export/page', ...flags],
        {},
        home,
        { fetchImpl: request },
      ),
    ).toBe(0);
    expect(request.mock.calls[0]?.[0]).toContain('/activity/export?limit=2&cursor=export%2Fpage');
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      ok: true,
      data: { activities: [activity], historyDays: 30, nextCursor: 'next' },
    });
    expect(request).toHaveBeenCalledOnce();
  });
  it('reads a server-computed hypothetical preview without accepting local dates or limits', async () => {
    const data = {
      state: 'available',
      kind: 'hypothetical',
      asOf: '2026-09-06T00:00:00.000Z',
      revision,
      currentMaximumDays: 90,
      paidPeriodEnd: '2026-10-01T00:00:00.000Z',
      currentlyAccessibleCount: 20,
      physicallyExpiresByPeriodEndCount: 5,
      scenarios: [
        { id: 'free', label: 'Free', maximumDays: 7, additionallyHiddenAtPeriodEndCount: 10 },
      ],
    };
    const request = vi.fn<typeof fetch>(async () => Response.json({ ok: true, data }));
    expect(
      await runSolutions(['activity', 'preview', 'install', ...flags], {}, home, {
        fetchImpl: request,
      }),
    ).toBe(0);
    expect(request.mock.calls[0]?.[0]).toMatch(/\/activity\/preview$/);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ ok: true, data });
    log.mockClear();
    expect(
      await runSolutions(
        ['activity', 'preview', 'install', ...flags.filter((v) => v !== '--json')],
        {},
        home,
        { fetchImpl: request },
      ),
    ).toBe(0);
    expect(log.mock.calls[0]?.[0]).toContain('Hypothetical');
    expect(log.mock.calls[0]?.[0]).toContain('not a scheduled change');
  });
  it.each([
    ['list', 'install', '--limit', '101'],
    ['export', 'install', '--limit', '101'],
    ['preview', 'install', '--limit', '7'],
    ['preview', 'install', '--effective-at', '2027-01-01'],
    ['list', 'install', '--retention-days', '30'],
    ['settings', 'get', 'install'],
    ['settings', 'set', 'install', '--retention-days', '30', '--expected-revision', revision],
  ])('rejects incompatible or unbounded arguments: %j', async (...args) => {
    const request = vi.fn<typeof fetch>();
    expect(
      await runSolutions(['activity', ...args, ...flags], {}, home, { fetchImpl: request }),
    ).toBe(2);
    expect(request).not.toHaveBeenCalled();
  });
  it('explains evidence levels in human output without claiming external completion', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        ok: true,
        data: {
          historyDays: 30,
          activities: ['returned', 'accepted', 'unknown'].map((outcome) => ({
            id: revision,
            tool: 'send_request',
            operation: 'create',
            outcome,
            startedAt: '2026-09-06T00:00:00.000Z',
          })),
        },
      }),
    );
    expect(
      await runSolutions(
        ['activity', 'list', 'install', ...flags.filter((flag) => flag !== '--json')],
        {},
        home,
        { fetchImpl: request },
      ),
    ).toBe(0);
    const output = String(log.mock.calls[0]?.[0]);
    expect(output).toContain('current 30-day history window');
    expect(output).not.toContain('30-day plan window');
    expect(output).toContain('completion unconfirmed');
    expect(output).toContain('pending external completion');
    expect(output).toContain('do not retry blindly');
  });
});
