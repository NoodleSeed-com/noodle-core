import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSolutions } from '../src/commands/solutions-ops.js';

interface SourceCommandCase {
  readonly name: string;
  readonly argv: readonly string[];
  readonly suffix: string;
  readonly method?: string;
  readonly body?: unknown;
  readonly data: unknown;
}

const service = 'https://cloud.example.test';
const source = '/v1/orgs/acme/solution-installations/ins_1/collections/stock/source';

const CASES: readonly SourceCommandCase[] = [
  {
    name: 'show',
    argv: ['sources', 'show', 'ins_1', 'stock'],
    suffix: '',
    data: { source: { installationId: 'ins_1', collection: 'stock' } },
  },
  {
    name: 'configure',
    argv: [
      'sources',
      'configure',
      'ins_1',
      'stock',
      '--expected-revision',
      '2',
      '--binding-reference',
      'binding_1',
      '--binding-generation',
      '3',
      '--configuration-reference',
      'config_1',
      '--enable',
      '--replace',
    ],
    suffix: '',
    method: 'PATCH',
    body: {
      expectedRevision: 2,
      binding: { reference: 'binding_1', generation: 3 },
      configurationReference: 'config_1',
      enable: true,
      replace: true,
    },
    data: { source: { installationId: 'ins_1', collection: 'stock', revision: 3 } },
  },
  ...(['pause', 'resume'] as const).map((action) => ({
    name: action,
    argv: ['sources', action, 'ins_1', 'stock', '--expected-revision', '3'],
    suffix: `/${action}`,
    method: 'POST',
    body: { expectedRevision: 3 },
    data: { source: { installationId: 'ins_1', collection: 'stock', revision: 4 } },
  })),
  {
    name: 'refresh',
    argv: [
      'sources',
      'refresh',
      'ins_1',
      'stock',
      '--expected-revision',
      '4',
      '--idempotency-key',
      'refresh-1',
    ],
    suffix: '/refresh',
    method: 'POST',
    body: { expectedRevision: 4, idempotencyKey: 'refresh-1' },
    data: { job: { id: 'job_1', state: 'queued', coalesced: false } },
  },
];

let home: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-solutions-sources-cli-'));
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  rmSync(home, { recursive: true, force: true });
});

describe('noodle solutions sources', () => {
  it.each(CASES)('$name sends the canonical collection-scoped request', async (testCase) => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, data: testCase.data }), {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const exitCode = await runSolutions(
      [...testCase.argv, '--org', 'acme', '--json'],
      { NOODLE_SERVICE_URL: service, NOODLE_AUTH_TOKEN: 'test-token' },
      home,
      { fetchImpl },
    );

    expect(exitCode).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`${service}${source}${testCase.suffix}`);
    expect(init?.method ?? 'GET').toBe(testCase.method ?? 'GET');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token');
    if (testCase.body === undefined) expect(init?.body).toBeUndefined();
    else expect(JSON.parse(String(init?.body))).toEqual(testCase.body);
    expect(JSON.parse(String(logSpy.mock.lastCall?.[0]))).toEqual({
      ok: true,
      data: testCase.data,
    });
  });

  it('requires explicit source enablement before configuration', async () => {
    const fetchImpl = vi.fn();
    const exitCode = await runSolutions(
      [
        'sources',
        'configure',
        'ins_1',
        'stock',
        '--expected-revision',
        '2',
        '--binding-reference',
        'binding_1',
        '--binding-generation',
        '3',
        '--configuration-reference',
        'config_1',
        '--org',
        'acme',
        '--json',
      ],
      { NOODLE_SERVICE_URL: service, NOODLE_AUTH_TOKEN: 'test-token' },
      home,
      { fetchImpl },
    );

    expect(exitCode).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(String(logSpy.mock.lastCall?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'usage_error' },
    });
  });
});
