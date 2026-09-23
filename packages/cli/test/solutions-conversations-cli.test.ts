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
const base = 'https://cloud.example.test/v1/orgs/acme/solution-installations/install/conversations';
const summary = {
  id: 'cv_0123456789abcdef',
  channel: 'whatsapp',
  subject: { kind: 'participant', ref: 'wa_4821' },
  startedAt: '2026-09-06T00:00:00.000Z',
  lastMessageAt: '2026-09-06T00:01:00.000Z',
  itemCount: 2,
  reviewStatus: 'needs_attention',
};
const expiresAt = '2026-09-13T00:01:00.000Z';
const notes = [{ author: 'staff_1', text: 'Call back after 5pm', at: '2026-09-06T00:02:00.000Z' }];
const items = [
  { kind: 'message', role: 'user', text: 'Is the shop open?', at: '2026-09-06T00:00:00.000Z' },
  { kind: 'message', role: 'assistant', text: 'Until 6pm.', at: '2026-09-06T00:01:00.000Z' },
];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-conversations-cli-'));
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  log.mockRestore();
  error.mockRestore();
  rmSync(home, { recursive: true, force: true });
});

function run(args: readonly string[], request: typeof fetch) {
  return runSolutions(['conversations', ...args], {}, home, { fetchImpl: request });
}

describe('solutions conversations CLI', () => {
  it('lists one bounded page and omits unrecognized response fields', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        ok: true,
        data: { conversations: [{ ...summary, raw: 'never' }], nextCursor: 'next', future: 1 },
      }),
    );
    expect(
      await run(
        [
          'list',
          'install',
          '--limit',
          '10',
          '--cursor',
          'a/b',
          '--channel',
          'whatsapp',
          '--status',
          'needs-attention',
          ...flags,
        ],
        request,
      ),
    ).toBe(0);
    expect(request.mock.calls[0]?.[0]).toBe(
      `${base}?limit=10&cursor=a%2Fb&channel=whatsapp&status=needs_attention`,
    );
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      ok: true,
      data: { conversations: [summary], nextCursor: 'next' },
    });
    log.mockClear();
    expect(await run(['list', 'install', ...human], request)).toBe(0);
    const text = String(log.mock.calls[0]?.[0]);
    expect(text).toContain('cv_0123456789abcdef');
    expect(text).toContain('participant wa_4821');
    expect(text).toContain('needs attention');
    expect(text).toContain('Next cursor: next');
    expect(text).not.toContain('Preview');
  });

  it('states a Preview environment and its fixed window (ADR 0241 decision 18)', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        ok: true,
        data: { conversations: [summary], preview: { retentionDays: 3 } },
      }),
    );
    expect(await run(['list', 'install', ...flags], request)).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).data.preview).toEqual({ retentionDays: 3 });
    log.mockClear();
    expect(await run(['list', 'install', ...human], request)).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toMatch(
      /^Preview environment: conversations are kept for 3 days\.\n/,
    );
  });

  it('shows one conversation with its messages and private notes', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: true, data: { conversation: { ...summary, expiresAt, items, notes } } }),
    );
    expect(await run(['show', 'install', '--conversation', summary.id, ...flags], request)).toBe(0);
    expect(request.mock.calls[0]?.[0]).toBe(`${base}/${summary.id}`);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).data.conversation.items).toEqual(items);
    log.mockClear();
    expect(await run(['show', 'install', '--conversation', summary.id, ...human], request)).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain('user: Is the shop open?');
    expect(String(log.mock.calls[0]?.[0])).toContain('note staff_1: Call back after 5pm');
    expect(String(log.mock.calls[0]?.[0])).toContain(`Removed automatically on ${expiresAt}`);
  });

  it.each([
    [['review', '--status', 'reviewed'], { reviewStatus: 'reviewed' }, 'marked reviewed'],
    [
      ['review', '--status', 'needs-attention'],
      { reviewStatus: 'needs_attention' },
      'marked needs attention',
    ],
    [['note', '--text', 'Call back after 5pm'], { note: 'Call back after 5pm' }, '1 private note'],
  ])('changes review state with PATCH (%j)', async ([action, ...rest], body, text) => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        ok: true,
        data: {
          conversation: {
            ...summary,
            reviewStatus: body.reviewStatus ?? 'needs_attention',
            expiresAt,
            items,
            notes: 'note' in body ? notes : [],
          },
        },
      }),
    );
    const args = [String(action), 'install', '--conversation', summary.id, ...rest];
    expect(await run([...args, ...flags], request)).toBe(0);
    expect(request.mock.calls[0]?.[0]).toBe(`${base}/${summary.id}`);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).data.conversation.id).toBe(summary.id);
    log.mockClear();
    expect(await run([...args, ...human], request)).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain(text);
  });

  it('exports one page and preserves the export cursor', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: true, data: { conversations: [{ ...summary, expiresAt, items }] } }),
    );
    expect(
      await run(['export', 'install', '--limit', '25', '--cursor', 'page', ...flags], request),
    ).toBe(0);
    expect(request.mock.calls[0]?.[0]).toBe(`${base}/export?limit=25&cursor=page`);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).data.conversations).toHaveLength(1);
  });

  it.each([
    [['--conversation', summary.id], { conversationId: summary.id }],
    [['--customer', 'sara_91'], { subject: { kind: 'customer', ref: 'sara_91' } }],
    [['--participant', 'wa_4821'], { subject: { kind: 'participant', ref: 'wa_4821' } }],
  ])('forgets with an explicit confirmation (%j)', async (selector, body) => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: true, data: { forgotten: { conversations: 1, items: 2 } } }),
    );
    expect(await run(['forget', 'install', ...selector, '--confirm', ...flags], request)).toBe(0);
    expect(request.mock.calls[0]?.[0]).toBe(`${base}/forget`);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify(body),
    });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      ok: true,
      data: { forgotten: { conversations: 1, items: 2 } },
    });
  });

  it.each([
    ['list', 'install', '--limit', '101'],
    ['export', 'install', '--limit', '26'],
    ['list', 'install', '--channel', 'sms'],
    ['list', 'install', '--conversation', summary.id],
    ['show', 'install'],
    ['show', 'install', '--conversation', 'not-a-conversation'],
    ['show', 'install', '--conversation', summary.id, '--limit', '2'],
    ['forget', 'install', '--conversation', summary.id],
    ['forget', 'install', '--confirm'],
    ['forget', 'install', '--customer', 'a', '--participant', 'b', '--confirm'],
    ['forget', 'install', '--conversation', summary.id, '--customer', 'a', '--confirm'],
    ['list', 'install', '--confirm'],
    ['list', 'install', '--status', 'needs_attention'],
    ['show', 'install', '--conversation', summary.id, '--status', 'reviewed'],
    ['review', 'install', '--conversation', summary.id],
    ['review', 'install', '--status', 'reviewed'],
    ['review', 'install', '--conversation', summary.id, '--status', 'done'],
    ['review', 'install', '--conversation', summary.id, '--status', 'reviewed', '--text', 'x'],
    ['note', 'install', '--conversation', summary.id],
    ['note', 'install', '--conversation', summary.id, '--text', '   '],
    ['note', 'install', '--conversation', summary.id, '--text', 'x'.repeat(2001)],
    ['note', 'install', '--text', 'x'],
    ['list', 'install', '--text', 'x'],
    ['delete', 'install'],
    ['list'],
  ])('rejects %j before any request', async (...args) => {
    const request = vi.fn<typeof fetch>();
    expect(await run([...args, ...flags], request)).toBe(2);
    expect(request).not.toHaveBeenCalled();
  });
});
