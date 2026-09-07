import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAssistant } from '../src/commands/assistant-ops.js';

const SERVICE = 'https://cloud.example';
const ROOT = `${SERVICE}/v1/orgs/acme/apps/support/envs/prod/assistant/appearance`;
const TARGET = [
  '--org',
  'acme',
  '--app',
  'support',
  '--env',
  'prod',
  '--service',
  SERVICE,
  '--auth-token',
  'control-token',
] as const;

let home: string;
let logs: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-assistant-appearance-'));
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((value) => logs.push(String(value)));
  vi.spyOn(console, 'error').mockImplementation((value) => logs.push(String(value)));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

function appearanceResponse(revision: number, source: 'developer' | 'operator' = 'operator') {
  return {
    ok: true,
    assistantEnabled: true,
    revision,
    fallback: 'halo',
    developer: { branding: { accent: '#2563EB' } },
    override: source === 'operator' ? { branding: { accent: '#EA580C' } } : null,
    effective: { branding: { accent: source === 'operator' ? '#EA580C' : '#2563EB' } },
    provenance: { 'branding.accent': source },
    updatedAt: '2030-08-01T10:00:00.000Z',
    updatedBy: 'operator-1',
  };
}

describe('noodle assistant appearance', () => {
  it('shows revision and field provenance without printing appearance values', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(appearanceResponse(3)), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await runAssistant(['appearance', 'show', ...TARGET, '--json'], {}, home)).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(ROOT, expect.any(Object));
    const output = logs.join('\n');
    expect(JSON.parse(output)).toMatchObject({
      data: {
        assistantEnabled: true,
        revision: 3,
        fallback: 'halo',
        hasOverride: true,
        fields: [{ path: 'branding.accent', source: 'operator' }],
        updatedBy: 'operator-1',
      },
    });
    expect(output).not.toContain('#EA580C');
    expect(output).not.toContain('#2563EB');
  });

  it('validates and replaces the complete override with an If-Match revision', async () => {
    const file = join(home, 'appearance.json');
    writeFileSync(
      file,
      JSON.stringify({
        branding: { accent: '#EA580C' },
        assistant: {
          theme: 'dark',
          layout: { position: 'bottom-right' },
          presentation: { launcher: { style: 'bubble' } },
        },
      }),
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(appearanceResponse(3)), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(appearanceResponse(4)), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(
      await runAssistant(['appearance', 'apply', '--file', file, ...TARGET, '--json'], {}, home),
    ).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(url).toBe(ROOT);
    expect(init).toMatchObject({ method: 'PUT' });
    const headers = new Headers(init?.headers);
    expect(headers.get('if-match')).toBe('"3"');
    expect(JSON.parse(String(init?.body))).toEqual({
      branding: { accent: '#EA580C' },
      assistant: {
        theme: 'dark',
        layout: { position: 'bottom-right' },
        presentation: { launcher: { style: 'bubble' } },
      },
    });
    expect(logs.join('\n')).not.toContain('#EA580C');
  });

  it('pins apply to an explicitly reviewed revision without re-reading current state', async () => {
    const file = join(home, 'appearance.json');
    writeFileSync(file, JSON.stringify({ branding: { accent: '#EA580C' } }));
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(appearanceResponse(8)), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(
      await runAssistant(
        ['appearance', 'apply', '--file', file, '--revision', '7', ...TARGET, '--json'],
        {},
        home,
      ),
    ).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(ROOT);
    expect(init).toMatchObject({ method: 'PUT' });
    expect(new Headers(init?.headers).get('if-match')).toBe('"7"');
  });

  it('rejects unsafe or empty files locally before contacting the service', async () => {
    const file = join(home, 'unsafe.json');
    writeFileSync(file, JSON.stringify({ assistant: { model: { apiKey: 'secret' } } }));
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    expect(
      await runAssistant(['appearance', 'apply', '--file', file, ...TARGET, '--json'], {}, home),
    ).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(logs.join('\n'))).toMatchObject({
      error: { code: 'assistant_appearance_file_invalid' },
    });
    expect(logs.join('\n')).not.toContain('secret');
  });

  it('resets the override with the latest revision', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(appearanceResponse(4)), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(appearanceResponse(5, 'developer')), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    expect(await runAssistant(['appearance', 'reset', ...TARGET, '--json'], {}, home)).toBe(0);
    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(url).toBe(ROOT);
    expect(init).toMatchObject({ method: 'DELETE' });
    expect(new Headers(init?.headers).get('if-match')).toBe('"4"');
    expect(JSON.parse(logs.join('\n'))).toMatchObject({
      data: { revision: 5, hasOverride: false },
    });
  });

  it('pins reset to an explicitly reviewed revision without re-reading current state', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(appearanceResponse(8, 'developer')), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    expect(
      await runAssistant(['appearance', 'reset', '--revision', '7', ...TARGET, '--json'], {}, home),
    ).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(ROOT);
    expect(init).toMatchObject({ method: 'DELETE' });
    expect(new Headers(init?.headers).get('if-match')).toBe('"7"');
  });

  it('rejects malformed reviewed revisions before contacting the service', async () => {
    const file = join(home, 'appearance.json');
    writeFileSync(file, JSON.stringify({ branding: { accent: '#EA580C' } }));
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    expect(
      await runAssistant(
        ['appearance', 'apply', '--file', file, '--revision', '1.5', ...TARGET, '--json'],
        {},
        home,
      ),
    ).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(logs.join('\n'))).toMatchObject({ error: { code: 'usage_error' } });
  });

  it('requires exactly one supported action and --file for apply', async () => {
    expect(await runAssistant(['appearance', 'apply', ...TARGET, '--json'], {}, home)).toBe(2);
    expect(JSON.parse(logs.join('\n'))).toMatchObject({ error: { code: 'usage_error' } });
    logs = [];
    expect(await runAssistant(['appearance', 'paint', ...TARGET, '--json'], {}, home)).toBe(2);
    expect(JSON.parse(logs.join('\n'))).toMatchObject({ error: { code: 'usage_error' } });
  });
});
