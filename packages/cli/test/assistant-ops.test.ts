import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAssistant } from '../src/commands/assistant-ops.js';

afterEach(() => vi.restoreAllMocks());

describe('assistant client operations', () => {
  it('renders the tenant assistant usage summary', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value) => logs.push(String(value)));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          window: { since: '2026-08-17T00:00:00.000Z' },
          metrics: {
            sessions: { minted: 12, public: 12, authenticated: 0 },
            turns: { attempted: 240, delivered: 230, failed: 5, refused: 5 },
            depth: {
              p50: 18,
              p90: 32,
              max: 40,
              atLeast10: 9,
              atLeast20: 6,
              atLeast30: 3,
              atLeast40: 1,
            },
            engagement: { modelRequests: 260, toolTurns: 44, interactionTurns: 9 },
            latency: { p50Ms: 620, p95Ms: 1800 },
            tokens: { prompt: 1000, completion: 500, reasoning: 20, total: 1520 },
            byModelSource: { noodleManaged: 240, operator: 0 },
            refusalsByCode: {
              address_session_budget_exhausted: 7,
              daily_turn_budget_exhausted: 2,
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const code = await runAssistant(
      [
        'usage',
        '--window',
        '7d',
        '--org',
        'acme',
        '--app',
        'support',
        '--env',
        'prod',
        '--service',
        'https://cloud.example',
        '--auth-token',
        'control-token',
      ],
      {},
      mkdtempSync(join(tmpdir(), 'noodle-assistant-usage-')),
    );

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cloud.example/v1/orgs/acme/apps/support/envs/prod/assistant/usage?window=7d',
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    const output = logs.join('\n');
    expect(output).toContain('Assistant usage (7d)');
    expect(output).toContain('240 turns');
    expect(output).toContain('p90 32');
    expect(output).toContain('44 tool turns');
    // An operator who cannot see which refusal is firing cannot tell "we are over budget" from
    // "one address is hammering us" — and those want opposite responses.
    expect(output).toContain('Refused: address_session_budget_exhausted 7');
    expect(output).toContain('daily_turn_budget_exhausted 2');
    // Nothing wrong with the ledger in this fixture, so no warning.
    expect(output).not.toContain('Warning: turns are averaging');
  });

  /**
   * The ladder charges each turn what its rung's policy permits. Turns costing more than that means
   * an enforcer is not enforcing and the sponsored ceiling is decorative — a bug, not a budget note.
   */
  it('warns when sponsored turns cost more than the ladder assumes', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value) => logs.push(String(value)));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          metrics: {
            sessions: { minted: 10, public: 10, authenticated: 0, refused: 0 },
            turns: { attempted: 10, delivered: 10, failed: 0, refused: 0 },
            depth: {
              p50: 1,
              p90: 1,
              max: 1,
              atLeast10: 0,
              atLeast20: 0,
              atLeast30: 0,
              atLeast40: 0,
            },
            engagement: { modelRequests: 10, toolTurns: 0, interactionTurns: 0 },
            latency: { p50Ms: 1, p95Ms: 1 },
            tokens: { prompt: 10_000_000, completion: 0, reasoning: 0, total: 10_000_000 },
            byModelSource: { noodleManaged: 10, operator: 0 },
            refusalsByCode: {},
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const code = await runAssistant(
      [
        'usage',
        '--org',
        'acme',
        '--app',
        'support',
        '--env',
        'prod',
        '--service',
        'https://cloud.example',
        '--auth-token',
        'control-token',
      ],
      {},
      mkdtempSync(join(tmpdir(), 'noodle-assistant-drift-')),
    );

    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('Warning: turns are averaging');
  });

  it('runs the hosted assistant boundary doctor without printing backend credentials', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value) => logs.push(String(value)));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          deploymentId: 'support-v4',
          checks: {
            deployment: { ok: true },
            client: { ok: true },
            origin: { ok: true },
            delegatedCredentials: { ok: true, probes: [] },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const code = await runAssistant(
      [
        'doctor',
        '--origin',
        'https://app.example.com',
        '--org',
        'acme',
        '--app',
        'support',
        '--env',
        'prod',
        '--service',
        'https://cloud.example',
        '--auth-token',
        'control-token',
        '--json',
      ],
      {
        NOODLE_ASSISTANT_CLIENT_ID: 'embed_123',
        NOODLE_ASSISTANT_CLIENT_SECRET: 'nsa_backend_only',
      },
      mkdtempSync(join(tmpdir(), 'noodle-assistant-doctor-')),
    );

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cloud.example/v1/orgs/acme/apps/support/envs/prod/assistant/doctor',
      expect.objectContaining({ method: 'POST' }),
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      clientId: 'embed_123',
      clientSecret: 'nsa_backend_only',
      origin: 'https://app.example.com',
    });
    expect(logs.join('\n')).not.toContain('nsa_backend_only');
    expect(JSON.parse(logs.join('\n'))).toMatchObject({ data: { ok: true } });
  });

  it('renders the elevation check like any other doctor check', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value) => logs.push(String(value)));
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            checks: {
              deployment: { ok: true },
              client: { ok: true },
              origin: { ok: true },
              elevation: { ok: true, issuerRebound: true },
              delegatedCredentials: { ok: false, skipped: true, reason: 'not supported' },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const code = await runAssistant(
      [
        'doctor',
        '--origin',
        'https://www.example.com',
        '--org',
        'acme',
        '--app',
        'support',
        '--env',
        'prod',
        '--service',
        'https://cloud.example',
        '--auth-token',
        'control-token',
      ],
      {
        NOODLE_ASSISTANT_CLIENT_ID: 'embed_123',
        NOODLE_ASSISTANT_CLIENT_SECRET: 'nsa_backend_only',
      },
      mkdtempSync(join(tmpdir(), 'noodle-assistant-doctor-elevation-')),
    );

    expect(code).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('PASS  elevation');
    expect(output).toContain('SKIP  delegatedCredentials');
  });

  it('prints the redacted model failure category and retry posture', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value) => logs.push(String(value)));
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            checks: {
              deployment: { ok: true },
              client: { ok: true },
              origin: { ok: true },
              model: {
                ok: false,
                transport: 'responses',
                code: 'model_auth_failed',
                status: 401,
                retryable: false,
              },
              delegatedCredentials: { ok: true, probes: [] },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const code = await runAssistant(
      [
        'doctor',
        '--origin',
        'https://www.example.com',
        '--org',
        'acme',
        '--app',
        'support',
        '--env',
        'prod',
        '--service',
        'https://cloud.example',
        '--auth-token',
        'control-token',
      ],
      {
        NOODLE_ASSISTANT_CLIENT_ID: 'embed_123',
        NOODLE_ASSISTANT_CLIENT_SECRET: 'nsa_backend_only',
      },
      mkdtempSync(join(tmpdir(), 'noodle-assistant-doctor-model-')),
    );

    expect(code).toBe(1);
    const output = logs.join('\n');
    expect(output).toContain('FAIL  model — model_auth_failed, HTTP 401, not retryable');
    expect(output).not.toContain('nsa_backend_only');
  });

  it('explains that client creation requires an active assistant deployment', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)));
    vi.spyOn(console, 'error').mockImplementation((value) => errors.push(String(value)));
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: 'deployment has no embedded assistant' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const code = await runAssistant(
      [
        'clients',
        'create',
        '--name',
        'web',
        '--org',
        'acme',
        '--app',
        'support',
        '--env',
        'prod',
        '--service',
        'https://cloud.example',
        '--auth-token',
        'control-token',
        '--json',
      ],
      {},
      mkdtempSync(join(tmpdir(), 'noodle-assistant-missing-deploy-')),
    );
    expect(code).toBe(1);
    const body = JSON.parse(output.join('\n')) as {
      error: { code: string; fix: string; next: string };
    };
    expect(errors).toEqual([]);
    expect(body.error).toMatchObject({
      code: 'assistant_deployment_required',
      next: 'noodle deploy',
    });
    expect(body.error.fix).toMatch(/deploy an assistant-enabled server/i);
  });

  it('writes the one-time client secret to a mode-0600 home file and never prints it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'noodle-assistant-cli-'));
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value) => logs.push(String(value)));
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            id: 'embed_123',
            name: 'web',
            createdAt: '2026-07-10T00:00:00.000Z',
            clientSecret: 'nsa_server_only_secret',
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const code = await runAssistant(
      [
        'clients',
        'create',
        '--name',
        'web',
        '--org',
        'acme',
        '--app',
        'support',
        '--env',
        'prod',
        '--service',
        'https://cloud.example',
        '--auth-token',
        'control-token',
      ],
      {},
      home,
    );
    expect(code).toBe(0);
    expect(logs.join('\n')).not.toContain('nsa_server_only_secret');
    const path = join(home, '.noodle', 'assistant-clients', 'embed_123.json');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      clientId: 'embed_123',
      clientSecret: 'nsa_server_only_secret',
    });
    // Ready-to-paste integration block (roadmap S7): env names, the resolved service URL, the
    // backend helper, and the mount — without ever printing the secret itself.
    const printed = logs.join('\n');
    expect(printed).toContain('NOODLE_SERVICE_URL=https://cloud.example');
    expect(printed).toContain('NOODLE_ASSISTANT_CLIENT_ID=embed_123');
    expect(printed).toContain('createAssistantSession');
    expect(printed).toContain('<NoodleAssistant sessionEndpoint="/api/assistant/session" />');
    expect(printed).toContain('https://docs.noodleseed.dev/docs/guides/embedded-assistant');
    expect(printed).not.toContain('https://docs.noodleseed.dev/guides/embedded-assistant');
    expect(printed).not.toContain('nsa_server_only_secret');
  });

  it('reports the control-plane service URL in machine output', async () => {
    const home = mkdtempSync(join(tmpdir(), 'noodle-assistant-json-'));
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value) => logs.push(String(value)));
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            id: 'embed_123',
            name: 'web',
            createdAt: '2026-07-10T00:00:00.000Z',
            clientSecret: 'nsa_server_only_secret',
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const code = await runAssistant(
      [
        'clients',
        'create',
        '--name',
        'web',
        '--org',
        'acme',
        '--app',
        'support',
        '--env',
        'prod',
        '--service',
        'https://cloud.example',
        '--auth-token',
        'control-token',
        '--json',
      ],
      {},
      home,
    );
    expect(code).toBe(0);
    const body = JSON.parse(logs.join('\n')) as { data: Record<string, unknown> };
    expect(body.data.serviceUrl).toBe('https://cloud.example');
    expect(JSON.stringify(body)).not.toContain('nsa_server_only_secret');
  });

  it('lists clients without expecting or printing credentials', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value) => logs.push(String(value)));
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            clients: [{ id: 'embed_123', name: 'web', createdAt: '2026-07-10T00:00:00.000Z' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const code = await runAssistant(
      [
        'clients',
        'list',
        '--org',
        'acme',
        '--app',
        'support',
        '--service',
        'https://cloud.example',
        '--auth-token',
        'token',
      ],
      {},
      mkdtempSync(join(tmpdir(), 'noodle-assistant-list-')),
    );
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('embed_123');
    expect(logs.join('\n')).not.toContain('secret');
  });
});
