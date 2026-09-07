import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runKnowledge } from '../src/commands/knowledge.js';

/**
 * Operator-only `noodle knowledge list|status <name>` (ADR 0202 as amended): the whole v0
 * knowledge CLI. ADR 0129 contract: one JSON envelope, table suppressed under --json, errors
 * name the exact next command.
 */

const HOME = { dir: mkdtempSync(join(tmpdir(), 'noodle-knowledge-cli-')) };

const LIST_BODY = {
  ok: true,
  scope: { org: 'acme', app: 'site', env: 'prod' },
  components: [
    {
      name: 'product',
      sources: { documents: 2, sites: 1 },
      declaringScope: 'env',
      activeRevisionId: 'bm25-rev-abc',
      activeDeploymentId: 'deploy-1',
      state: 'active',
    },
  ],
};

const STATUS_BODY = {
  ok: true,
  scope: { org: 'acme', app: 'site', env: 'prod' },
  component: LIST_BODY.components[0],
  siteProvisioning: 'missing',
  errors: [],
};

let output: string[];
let errors: string[];

beforeEach(() => {
  output = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    output.push(String(line));
  });
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    errors.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function fetchReturning(body: unknown, status = 200): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;
}

const target = [
  '--org',
  'acme',
  '--app',
  'site',
  '--env',
  'prod',
  '--service',
  'https://service.test',
  '--auth-token',
  'token-1',
];

describe('noodle knowledge', () => {
  it('lists components as a table naming both lifecycles', async () => {
    const exit = await runKnowledge(['list', ...target], {}, HOME, {
      fetchImpl: fetchReturning(LIST_BODY),
    });
    expect(exit).toBe(0);
    const joined = output.join('\n');
    expect(joined).toContain('product');
    expect(joined).toContain('documents');
    expect(joined).toContain('sites');
    expect(joined).toContain('active');
  });

  it('emits the JSON envelope under --json', async () => {
    const exit = await runKnowledge(['list', ...target, '--json'], {}, HOME, {
      fetchImpl: fetchReturning(LIST_BODY),
    });
    expect(exit).toBe(0);
    const parsed = JSON.parse(output.join('\n')) as { ok: boolean; data: typeof LIST_BODY };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.components[0]?.name).toBe('product');
  });

  it('shows component status including the honest provisioning state', async () => {
    const exit = await runKnowledge(['status', 'product', ...target], {}, HOME, {
      fetchImpl: fetchReturning(STATUS_BODY),
    });
    expect(exit).toBe(0);
    const joined = output.join('\n');
    expect(joined).toContain('versioned documents: 2');
    expect(joined).toContain('live sites: 1');
    expect(joined).toContain('bm25-rev-abc');
    expect(joined).toContain('missing');
  });

  it('surfaces the fail-closed gate error with its fix command', async () => {
    const exit = await runKnowledge(['list', ...target, '--json'], {}, HOME, {
      fetchImpl: fetchReturning(
        {
          code: 'knowledge_not_enabled',
          error: 'knowledge is not enabled for this org/app/env',
          fix: 'noodle variables set NOODLE_KNOWLEDGE_ENABLED --value true',
        },
        403,
      ),
    });
    expect(exit).not.toBe(0);
    const parsed = JSON.parse([...output, ...errors].join('\n')) as {
      ok: boolean;
      error: { message: string; next?: string; fix?: string };
    };
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed.error)).toContain('NOODLE_KNOWLEDGE_ENABLED');
  });

  it('renders crawl state and budget on status when present', async () => {
    const exit = await runKnowledge(['status', 'product', ...target], {}, HOME, {
      fetchImpl: fetchReturning({
        ...STATUS_BODY,
        crawl: {
          status: 'completed',
          lastCompletedAt: 1755500000000,
          pagesIndexed: 25,
          nextRefreshAt: 1755521600000,
        },
        budget: {
          orgConsumed: 25,
          orgCeiling: 20000,
          appConsumed: 25,
          appCeiling: 10000,
          blocked: false,
        },
      }),
    });
    expect(exit).toBe(0);
    const joined = output.join('\n');
    expect(joined).toContain('crawl: completed, 25 pages');
    expect(joined).toContain('crawl budget: org 25/20000 pages, app 25/10000');
  });

  it('refresh triggers a crawl and exits 0 only on completion', async () => {
    const exit = await runKnowledge(['refresh', 'product', ...target], {}, HOME, {
      fetchImpl: fetchReturning({
        ok: true,
        crawl: { status: 'completed', lastCompletedAt: 1755500000000, pagesIndexed: 25 },
      }),
    });
    expect(exit).toBe(0);
    expect(output.join('\n')).toContain('crawl: completed, 25 pages');
  });

  it('refresh exits nonzero and shows the crawl error when the crawl fails', async () => {
    const exit = await runKnowledge(['refresh', 'product', ...target], {}, HOME, {
      fetchImpl: fetchReturning({
        ok: true,
        crawl: {
          status: 'failed',
          lastError: 'crawl page budget exhausted for this month',
          pagesIndexed: 0,
        },
      }),
    });
    expect(exit).toBe(1);
    expect(output.join('\n')).toContain('crawl page budget exhausted');
  });

  it('refresh survives a transport timeout by polling status until the crawl completes', async () => {
    // The synchronous crawl can outlive any single HTTP request (proxies, Cloud Run request
    // caps). The verb's exit code must reflect the crawl's real outcome, not transport luck.
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/refresh')) {
        const abort = new Error('aborted');
        abort.name = 'AbortError';
        throw abort;
      }
      const crawl =
        calls.filter((entry) => entry.endsWith('/status')).length < 2
          ? { status: 'in_progress', pagesIndexed: 0 }
          : { status: 'completed', lastCompletedAt: 1755500000000, pagesIndexed: 41 };
      return new Response(JSON.stringify({ ...STATUS_BODY, crawl }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const exit = await runKnowledge(['refresh', 'product', ...target], {}, HOME, {
      fetchImpl,
      refreshPollIntervalMs: 1,
      refreshPollBudgetMs: 1000,
    });
    expect(exit).toBe(0);
    expect(output.join('\n')).toContain('crawl: completed, 41 pages');
    expect(calls.some((url) => url.endsWith('/status'))).toBe(true);
  });

  it('refresh reports in_progress with the status verb when the poll budget expires', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/refresh')) {
        const abort = new Error('aborted');
        abort.name = 'AbortError';
        throw abort;
      }
      return new Response(
        JSON.stringify({ ...STATUS_BODY, crawl: { status: 'in_progress', pagesIndexed: 0 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const exit = await runKnowledge(['refresh', 'product', ...target], {}, HOME, {
      fetchImpl,
      refreshPollIntervalMs: 1,
      refreshPollBudgetMs: 5,
    });
    expect(exit).toBe(1);
    const joined = [...output, ...errors].join('\n');
    expect(joined).toContain('still running');
    expect(joined).toContain('noodle knowledge status product');
  });

  it('requires a component name for refresh', async () => {
    const exit = await runKnowledge(['refresh', ...target, '--json'], {}, HOME, {
      fetchImpl: fetchReturning(STATUS_BODY),
    });
    expect(exit).toBe(2);
  });

  it('requires a component name for status', async () => {
    const exit = await runKnowledge(['status', ...target, '--json'], {}, HOME, {
      fetchImpl: fetchReturning(STATUS_BODY),
    });
    expect(exit).toBe(2);
  });

  it('rejects unknown subcommands with usage guidance', async () => {
    const exit = await runKnowledge(['sync', ...target, '--json'], {}, HOME, {
      fetchImpl: fetchReturning(LIST_BODY),
    });
    expect(exit).toBe(2);
  });
});
