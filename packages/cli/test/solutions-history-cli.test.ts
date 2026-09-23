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
const human = flags.filter((flag) => flag !== '--json');
const revision = 'a'.repeat(64);
const settings = {
  revision,
  canEdit: true,
  activity: { retentionDays: 30, maximumDays: 90, defaultDays: 30 },
  conversations: {
    state: 'on',
    retentionDays: 30,
    sources: { websiteVisitors: true, signedInCustomers: true, whatsapp: true },
  },
};
const saved = (shortens: boolean, dryRun: boolean) => ({
  ok: true,
  data: {
    dryRun,
    shortensConversations: shortens,
    impact: shortens ? { conversations: 3, items: 12 } : { conversations: 0, items: 0 },
    settings,
  },
});
const set = (...extra: string[]) => [
  'history',
  'settings',
  'set',
  'install',
  '--expected-revision',
  revision,
  ...extra,
];
const body = (request: ReturnType<typeof vi.fn<typeof fetch>>, call: number) =>
  JSON.parse(String(request.mock.calls[call]?.[1]?.body));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-history-cli-'));
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  log.mockRestore();
  error.mockRestore();
  rmSync(home, { recursive: true, force: true });
});

describe('solutions history settings CLI', () => {
  it('reads the one history setting and omits unrecognized response data', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: true, data: { ...settings, future: 'never-output' } }),
    );
    expect(
      await runSolutions(['history', 'settings', 'get', 'install', ...flags], {}, home, {
        fetchImpl: request,
      }),
    ).toBe(0);
    expect(request.mock.calls[0]?.[0]).toBe(
      'https://cloud.example.test/v1/orgs/acme/solution-installations/install/history/settings',
    );
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ ok: true, data: settings });
    log.mockClear();
    expect(
      await runSolutions(['history', 'settings', 'get', 'install', ...human], {}, home, {
        fetchImpl: request,
      }),
    ).toBe(0);
    const output = String(log.mock.calls[0]?.[0]);
    expect(output).toContain('Activity: 30 day(s); plan maximum 90, default 30.');
    expect(output).toContain('Conversations: 30 day(s).');
    expect(output).toContain('website visitors on, signed-in customers on, WhatsApp on');
  });

  it('names the surfaces the application keeps no chats on', async () => {
    const optedOut = {
      ...settings,
      conversations: { ...settings.conversations, disabledByApplication: ['authenticatedWebsite'] },
    };
    const request = vi.fn<typeof fetch>(async () => Response.json({ ok: true, data: optedOut }));
    expect(
      await runSolutions(['history', 'settings', 'get', 'install', ...flags], {}, home, {
        fetchImpl: request,
      }),
    ).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ ok: true, data: optedOut });
    log.mockClear();
    expect(
      await runSolutions(['history', 'settings', 'get', 'install', ...human], {}, home, {
        fetchImpl: request,
      }),
    ).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain(
      'Never kept by the application (history: false in server.ts): authenticated website.',
    );
  });

  it('saves a change that does not shorten conversations after a dry run confirms it', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(saved(false, true)))
      .mockResolvedValueOnce(Response.json(saved(false, false)));
    expect(
      await runSolutions(
        set('--activity-days', '60', '--conversation-days', '45', '--whatsapp', 'off', ...flags),
        {},
        home,
        { fetchImpl: request },
      ),
    ).toBe(0);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[1]).toMatchObject({ method: 'PUT' });
    const change = {
      expectedRevision: revision,
      activityDays: 60,
      conversations: { retentionDays: 45 },
      sources: { whatsapp: false },
    };
    expect(body(request, 0)).toEqual({ ...change, dryRun: true });
    expect(body(request, 1)).toEqual(change);
  });

  it('refuses to shorten or turn off conversations without --confirm and shows the effect', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json(saved(true, true)));
    expect(
      await runSolutions(set('--conversations', 'off', ...flags), {}, home, {
        fetchImpl: request,
      }),
    ).toBe(2);
    expect(request).toHaveBeenCalledOnce();
    expect(body(request, 0)).toEqual({
      expectedRevision: revision,
      conversations: 'off',
      dryRun: true,
    });
    const failure = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(failure).toMatchObject({ ok: false, error: { code: 'confirmation_required' } });
    expect(failure.error.message).toContain('3 conversation(s) and 12 item(s)');
  });

  it('saves a confirmed shortening directly and reports its effect', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json(saved(true, false)));
    expect(
      await runSolutions(set('--conversation-days', '7', '--confirm', ...human), {}, home, {
        fetchImpl: request,
      }),
    ).toBe(0);
    expect(request).toHaveBeenCalledOnce();
    expect(body(request, 0)).toEqual({
      expectedRevision: revision,
      conversations: { retentionDays: 7 },
    });
    expect(String(log.mock.calls[0]?.[0])).toContain('3 conversation(s) and 12 item(s)');
  });

  it.each([
    [['history', 'settings', 'set', 'install', '--activity-days', '30']],
    [set()],
    [set('--activity-days', '366')],
    [set('--conversation-days', '7', '--conversations', 'off')],
    [set('--conversations', 'on')],
    [set('--whatsapp', 'yes')],
    [set('--retention-days', '30')],
    [['history', 'settings', 'get', 'install', '--confirm']],
    [['history', 'settings', 'get', 'install', '--expected-revision', revision]],
    [['history', 'get', 'install']],
    [['activity', 'settings', 'get', 'install']],
  ])('rejects incompatible or unbounded arguments without a request: %j', async (args) => {
    const request = vi.fn<typeof fetch>();
    expect(await runSolutions([...args, ...flags], {}, home, { fetchImpl: request })).toBe(2);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    403, 409,
  ])('propagates typed %i denial without printing payloads or credentials', async (status) => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json(
        { ok: false, code: status === 403 ? 'forbidden' : 'activity_conflict', error: 'Denied.' },
        { status },
      ),
    );
    expect(
      await runSolutions(set('--activity-days', '30', '--confirm', ...flags), {}, home, {
        fetchImpl: request,
      }),
    ).not.toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ ok: false });
    expect(JSON.stringify([...error.mock.calls, ...log.mock.calls])).not.toContain('fixture-owner');
  });
});
