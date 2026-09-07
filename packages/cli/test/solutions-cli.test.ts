import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSolutions } from '../src/commands/solutions-ops.js';

let home: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-solutions-cli-'));
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  rmSync(home, { recursive: true, force: true });
});

function output(): unknown {
  return JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join('\n'));
}

function response(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

const env = {
  NOODLE_SERVICE_URL: 'https://cloud.example.test',
  NOODLE_AUTH_TOKEN: 'test-token',
};

describe('noodle solutions', () => {
  it.each([
    [429, 'business_api_rate_limited', true, '45'],
    [503, 'business_api_admission_unavailable', true, null],
    [409, 'installation_capacity_exceeded', false, null],
  ] as const)('preserves safe admission/capacity errors through the existing command family: %s', async (status, code, retryable, retryAfter) => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ code, error: 'Safe remediation supplied by service.' }), {
          status,
          headers: {
            'content-type': 'application/json',
            ...(retryAfter ? { 'retry-after': retryAfter } : {}),
          },
        }),
    );
    expect(
      await runSolutions(
        ['install', 'travel', '--org', 'acme', '--app', 'travel-desk', '--env', 'prod', '--json'],
        env,
        home,
        { fetchImpl },
      ),
    ).not.toBe(0);
    expect(output()).toMatchObject({
      ok: false,
      error: { code, retryable, ...(retryAfter ? { retryAfterSeconds: 45 } : {}) },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(output())).not.toContain('test-token');
  });

  it('reads and explicitly accepts the exact organization agreement through the typed API', async () => {
    const fetchImpl = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      response({ ok: true, data: { required: null, accepted: true, canAccept: true } }),
    );
    expect(
      await runSolutions(['agreement', 'get', '--org', 'acme', '--json'], env, home, { fetchImpl }),
    ).toBe(0);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://cloud.example.test/v1/orgs/acme/agreement');
    expect(
      await runSolutions(
        [
          'agreement',
          'accept',
          '--org',
          'acme',
          '--version',
          'v1',
          '--document-digest',
          'a'.repeat(64),
          '--accept',
          '--json',
        ],
        env,
        home,
        { fetchImpl },
      ),
    ).toBe(0);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({
      version: 'v1',
      documentDigest: 'a'.repeat(64),
      accepted: true,
    });
    expect(
      await runSolutions(
        [
          'agreement',
          'accept',
          '--org',
          'acme',
          '--version',
          'v1',
          '--document-digest',
          'a'.repeat(64),
          '--json',
        ],
        env,
        home,
        { fetchImpl },
      ),
    ).not.toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('saves and reads a revision-protected business notice without granting authority locally', async () => {
    const notice = {
      displayName: 'Acme',
      privacyUrl: 'https://example.test/privacy',
      supportUrl: 'mailto:help@example.test',
    };
    const fetchImpl = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      response({ ok: true, data: { revision: 1, notice, canEdit: true } }),
    );
    expect(
      await runSolutions(
        [
          'notice',
          'set',
          'ins',
          '--org',
          'acme',
          '--expected-revision',
          '0',
          '--display-name',
          notice.displayName,
          '--privacy-url',
          notice.privacyUrl,
          '--support-url',
          notice.supportUrl,
          '--json',
        ],
        env,
        home,
        { fetchImpl },
      ),
    ).toBe(0);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://cloud.example.test/v1/orgs/acme/solution-installations/ins/notice',
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      expectedRevision: 0,
      notice,
    });
    expect(
      await runSolutions(['notice', 'get', 'ins', '--org', 'acme', '--json'], env, home, {
        fetchImpl,
      }),
    ).toBe(0);
  });
  it.each([
    ['installation-options'],
    ['agreement', 'get', '--org', 'acme'],
    ['notice', 'get', 'ins', '--org', 'acme'],
  ])('preserves service authorization failures for %j', async (...command) => {
    const fetchImpl = vi.fn(() => response({ error: 'Access revoked', code: 'forbidden' }, 403));
    expect(await runSolutions([...command, '--json'], env, home, { fetchImpl })).toBe(3);
    expect(output()).toMatchObject({
      ok: false,
      error: { code: 'forbidden', next: 'noodle login' },
    });
  });
  it('lists installation choices through the authenticated bounded discovery contract', async () => {
    const fetchImpl = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      response({
        ok: true,
        data: { organizations: [{ slug: 'acme', displayName: 'Acme' }], nextCursor: 'YWNtZQ' },
      }),
    );
    expect(
      await runSolutions(['installation-options', '--limit', '1', '--json'], env, home, {
        fetchImpl,
      }),
    ).toBe(0);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://cloud.example.test/v1/me/solution-installation-options?limit=1',
    );
    expect(output()).toMatchObject({
      ok: true,
      data: { organizations: [{ slug: 'acme', displayName: 'Acme' }], nextCursor: 'YWNtZQ' },
    });
  });

  it('rejects invalid installation-choice limits before sending a request', async () => {
    const fetchImpl = vi.fn();
    expect(
      await runSolutions(['installation-options', '--limit', '101', '--json'], env, home, {
        fetchImpl,
      }),
    ).not.toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('clears named optional fields through the existing revision-protected update command', async () => {
    const fetchImpl = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      response({ ok: true, data: { record: { id: 'r1', revision: 3 } } }),
    );
    expect(
      await runSolutions(
        [
          'records',
          'update',
          'ins',
          'items',
          'r1',
          '--org',
          'acme',
          '--expected-revision',
          '2',
          '--unset',
          'reference,tag',
          '--json',
        ],
        env,
        home,
        { fetchImpl },
      ),
    ).toBe(0);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({
        operation: 'update',
        expectedRevision: 2,
        patch: {},
        unset: ['reference', 'tag'],
      }),
    });
  });
  it.each([
    '',
    'reference,reference',
    'reference,',
  ])('rejects malformed clear flags without a request: %s', async (unset) => {
    const fetchImpl = vi.fn();
    expect(
      await runSolutions(
        [
          'records',
          'update',
          'ins',
          'items',
          'r1',
          '--org',
          'acme',
          '--expected-revision',
          '2',
          '--unset',
          unset,
          '--json',
        ],
        env,
        home,
        { fetchImpl },
      ),
    ).not.toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('rejects setting and clearing the same field before sending a mutation', async () => {
    const fetchImpl = vi.fn();
    expect(
      await runSolutions(
        [
          'records',
          'update',
          'ins',
          'items',
          'r1',
          '--org',
          'acme',
          '--expected-revision',
          '2',
          '--data',
          '{"reference":"new"}',
          '--unset',
          'reference',
          '--json',
        ],
        env,
        home,
        { fetchImpl },
      ),
    ).not.toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('passes the native record activity page cursor and limit without changing their scope', async () => {
    const fetchImpl = vi.fn((_input: string | URL | Request) =>
      response({ ok: true, data: { activities: [], nextCursor: 'older-page' } }),
    );
    expect(
      await runSolutions(
        [
          'records',
          'activity',
          'ins',
          'items',
          'r1',
          '--org',
          'acme',
          '--limit',
          '25',
          '--cursor',
          'opaque/record',
          '--json',
        ],
        env,
        home,
        { fetchImpl },
      ),
    ).toBe(0);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://cloud.example.test/v1/orgs/acme/solution-installations/ins/collections/items/records/r1/activity?cursor=opaque%2Frecord&limit=25',
    );
    expect(output()).toMatchObject({ data: { nextCursor: 'older-page' } });
  });

  it('passes declared equality queries and explicit schema migration through the existing records family', async () => {
    const fetchImpl = vi.fn(() =>
      response({
        ok: true,
        data: {
          records: [],
          record: { id: 'r1', revision: 2, payload: { private: 'do-not-print' } },
        },
      }),
    );
    const common = ['--org', 'acme', '--json'];
    expect(
      await runSolutions(
        [
          'records',
          'list',
          'ins',
          'items',
          '--filters',
          '[{"field":"status","value":"new"}]',
          '--sort-field',
          'status',
          '--sort-direction',
          'desc',
          '--created-at-from',
          '2030-01-01T00:00:00Z',
          ...common,
        ],
        env,
        home,
        { fetchImpl },
      ),
    ).toBe(0);
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(JSON.parse(url.searchParams.get('filters') ?? '')).toEqual([
      { field: 'status', value: 'new' },
    ]);
    expect(url.searchParams.get('sortDirection')).toBe('desc');
    expect(url.searchParams.get('createdAtFrom')).toBe('2030-01-01T00:00:00Z');
    logSpy.mockClear();
    expect(
      await runSolutions(
        ['records', 'migrate-schema', 'ins', 'items', 'r1', '--expected-revision', '1', ...common],
        env,
        home,
        { fetchImpl },
      ),
    ).toBe(0);
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({ operation: 'migrate-schema', expectedRevision: 1 }),
    });
    expect(JSON.stringify(output())).not.toContain('do-not-print');
  });

  it.each([
    'not-json',
    '[{"field":"status","value":{}}]',
  ])('rejects malformed typed filters before any request: %s', async (filters) => {
    const fetchImpl = vi.fn(() => response({}));
    expect(
      await runSolutions(
        ['records', 'list', 'ins', 'items', '--org', 'acme', '--filters', filters, '--json'],
        env,
        home,
        { fetchImpl },
      ),
    ).not.toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lists the central profile catalog with machine output', async () => {
    const fetchImpl = vi.fn(() =>
      response({
        ok: true,
        data: {
          profiles: [
            {
              id: 'travel',
              title: 'Travel',
              description: 'Receive and operate travel requests.',
              collection: {
                key: 'travel_requests',
                title: 'Travel requests',
                singularTitle: 'Travel request',
                schemaVersion: 1,
                schemaDigest: 'a'.repeat(64),
                recordSchema: { type: 'object' },
                summaryFields: ['summary'],
              },
            },
          ],
        },
      }),
    );
    expect(await runSolutions(['catalog', '--json'], env, home, { fetchImpl })).toBe(0);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://cloud.example.test/v1/solutions/catalog');
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer test-token',
    );
    expect(output()).toMatchObject({ ok: true, data: { profiles: [{ id: 'travel' }] } });
  });

  it('installs a profile with explicit operator settings', async () => {
    const fetchImpl = vi.fn(() =>
      response(
        {
          ok: true,
          data: {
            installation: {
              id: 'ins_1',
              organizationId: 'acme',
              profileId: 'travel',
              appSlug: 'travel-desk',
              environment: 'prod',
              retentionDays: 30,
              publicId: 'sol_public',
              active: true,
              currentRole: 'administrator',
              revision: 1,
              collection: {
                key: 'travel_requests',
                title: 'Travel requests',
                singularTitle: 'Travel request',
                schemaVersion: 1,
                schemaDigest: 'a'.repeat(64),
                recordSchema: { type: 'object' },
                summaryFields: ['summary'],
              },
              createdAt: '2026-09-04T12:00:00.000Z',
              updatedAt: '2026-09-04T12:00:00.000Z',
              createdBySubject: 'owner',
            },
          },
        },
        201,
      ),
    );
    const result = await runSolutions(
      [
        'install',
        'travel',
        '--org',
        'acme',
        '--app',
        'travel-desk',
        '--env',
        'prod',
        '--retention-days',
        '30',
        '--json',
      ],
      env,
      home,
      { fetchImpl },
    );
    expect(result).toBe(0);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://cloud.example.test/v1/orgs/acme/solution-installations',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          definition: { kind: 'managed', profileId: 'travel' },
          appSlug: 'travel-desk',
          environment: 'prod',
          retentionDays: 30,
        }),
      }),
    );
    expect(output()).toMatchObject({ ok: true, data: { installation: { id: 'ins_1' } } });
  });

  it('installs an immutable private definition release through the same route', async () => {
    const fetchImpl = vi.fn(() =>
      response({ ok: true, data: { installation: { id: 'ins_private' } } }, 201),
    );
    expect(
      await runSolutions(
        [
          'install',
          '--publisher-org',
          'publisher',
          '--definition-app',
          'customer-source',
          '--definition-env',
          'prod',
          '--deployment',
          'dep_1',
          '--org',
          'acme',
          '--app',
          'customer-ops',
          '--env',
          'prod',
          '--json',
        ],
        env,
        home,
        { fetchImpl },
      ),
    ).toBe(0);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://cloud.example.test/v1/orgs/acme/solution-installations',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          definition: {
            kind: 'private',
            publisherOrg: 'publisher',
            app: 'customer-source',
            environment: 'prod',
            deploymentId: 'dep_1',
          },
          appSlug: 'customer-ops',
          environment: 'prod',
          retentionDays: 30,
        }),
      }),
    );
  });

  it('pauses and resumes public intake with explicit installation revisions', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(() =>
        response({ ok: true, data: { installation: { id: 'ins_1', active: false } } }),
      )
      .mockImplementationOnce(() =>
        response({ ok: true, data: { installation: { id: 'ins_1', active: true } } }),
      );
    expect(
      await runSolutions(
        ['pause', 'ins_1', '--org', 'acme', '--expected-revision', '4', '--json'],
        env,
        home,
        { fetchImpl },
      ),
    ).toBe(0);
    expect(
      await runSolutions(
        ['resume', 'ins_1', '--org', 'acme', '--expected-revision', '5', '--json'],
        env,
        home,
        { fetchImpl },
      ),
    ).toBe(0);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://cloud.example.test/v1/orgs/acme/solution-installations/ins_1',
    );
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ active: false, expectedRevision: 4 }),
      }),
    );
    expect(fetchImpl.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ active: true, expectedRevision: 5 }),
      }),
    );
  });

  it('rejects new legacy b2b_saas installs before making a request', async () => {
    const fetchImpl = vi.fn();
    expect(
      await runSolutions(
        ['install', 'b2b_saas', '--org', 'acme', '--app', 'support', '--env', 'prod', '--json'],
        env,
        home,
        { fetchImpl },
      ),
    ).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(output()).toMatchObject({ ok: false, error: { code: 'usage_error' } });
  });

  it('sends one explicit optimistic record mutation', async () => {
    const fetchImpl = vi.fn(() =>
      response({
        ok: true,
        data: {
          record: {
            id: 'rec_1',
            installationId: 'ins_1',
            collection: 'travel_requests',
            schemaVersion: 1,
            schemaDigest: 'a'.repeat(64),
            payload: { summary: 'Call back tomorrow.' },
            status: 'in_progress',
            revision: 2,
            origin: { surface: 'portal', subject: 'owner' },
            createdAt: '2026-09-04T12:00:00.000Z',
            updatedAt: '2026-09-04T12:01:00.000Z',
            retentionExpiresAt: '2026-10-04T12:00:00.000Z',
          },
        },
      }),
    );
    const result = await runSolutions(
      [
        'records',
        'status',
        'ins_1',
        'travel_requests',
        'rec_1',
        '--org',
        'acme',
        '--expected-revision',
        '1',
        '--status',
        'in_progress',
        '--json',
      ],
      env,
      home,
      { fetchImpl },
    );
    expect(result).toBe(0);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://cloud.example.test/v1/orgs/acme/solution-installations/ins_1/collections/travel_requests/records/rec_1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          operation: 'set-status',
          expectedRevision: 1,
          status: 'in_progress',
        }),
      }),
    );
  });

  it('uses the service assignee filter for record lists', async () => {
    const fetchImpl = vi.fn(() => response({ ok: true, data: { records: [] } }));
    const result = await runSolutions(
      [
        'records',
        'list',
        'ins_1',
        'travel_requests',
        '--org',
        'acme',
        '--assignee',
        'operator-sub',
        '--json',
      ],
      env,
      home,
      { fetchImpl },
    );

    expect(result).toBe(0);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://cloud.example.test/v1/orgs/acme/solution-installations/ins_1/collections/travel_requests/records?assigneeSubject=operator-sub',
    );
  });

  it('preserves the typed external-record mutation rejection', async () => {
    const fetchImpl = vi.fn(() =>
      response(
        {
          ok: false,
          error: 'external collection records cannot be updated through the record API',
          code: 'operation_not_supported',
          details: { authority: 'external', operation: 'update' },
        },
        422,
      ),
    );
    const result = await runSolutions(
      [
        'records',
        'update',
        'ins_1',
        'stock',
        'rec_1',
        '--org',
        'acme',
        '--expected-revision',
        '1',
        '--data',
        '{"quantity":2}',
        '--json',
      ],
      env,
      home,
      { fetchImpl },
    );

    expect(result).toBe(1);
    expect(output()).toMatchObject({
      ok: false,
      error: { code: 'operation_not_supported' },
    });
  });

  it('creates a new business grant from revision zero', async () => {
    const fetchImpl = vi.fn(() =>
      response(
        {
          ok: true,
          data: {
            grant: {
              installationId: 'ins-1',
              subject: 'operator-sub',
              email: 'operator@example.test',
              role: 'operator',
              revision: 1,
              createdAt: '2026-09-04T12:00:00.000Z',
              createdBySubject: 'owner-sub',
            },
          },
        },
        201,
      ),
    );
    const result = await runSolutions(
      [
        'grants',
        'set',
        'ins-1',
        '--org',
        'acme',
        '--subject',
        'operator-sub',
        '--email',
        'operator@example.test',
        '--role',
        'operator',
        '--json',
      ],
      env,
      home,
      { fetchImpl },
    );

    expect(result).toBe(0);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://cloud.example.test/v1/orgs/acme/solution-installations/ins-1/grants',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          subject: 'operator-sub',
          email: 'operator@example.test',
          role: 'operator',
          expectedRevision: 0,
        }),
      }),
    );
  });

  it('discovers granted solution workspaces without an organization flag', async () => {
    const fetchImpl = vi.fn(() => response({ ok: true, data: { installations: [] } }));
    expect(
      await runSolutions(['list', '--cursor', 'page_1', '--limit', '5', '--json'], env, home, {
        fetchImpl,
      }),
    ).toBe(0);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://cloud.example.test/v1/me/solution-installations?cursor=page_1&limit=5',
    );
  });

  it('creates, revokes, and accepts installation-scoped invitations', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(() =>
        response(
          {
            ok: true,
            data: {
              invitation: { invitationId: 'binv_1' },
              acceptPath: '/portal-invitations/token',
              replayed: false,
            },
          },
          201,
        ),
      )
      .mockImplementationOnce(() =>
        response({ ok: true, data: { invitation: { invitationId: 'binv_1' } } }),
      )
      .mockImplementationOnce(() =>
        response({ ok: true, data: { installation: { id: 'ins-1' }, grant: {} } }, 201),
      );
    expect(
      await runSolutions(
        [
          'invitations',
          'create',
          'ins-1',
          '--org',
          'acme',
          '--email',
          'staff@example.test',
          '--role',
          'operator',
          '--idempotency-key',
          'invite-1',
          '--json',
        ],
        env,
        home,
        { fetchImpl },
      ),
    ).toBe(0);
    const create = fetchImpl.mock.calls[0]?.[1];
    expect(create).toEqual(expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(String(create?.body))).toMatchObject({
      email: 'staff@example.test',
      role: 'operator',
      idempotencyKey: 'invite-1',
      expiresInHours: 168,
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(
      await runSolutions(
        [
          'invitations',
          'revoke',
          'ins-1',
          'binv_1',
          '--org',
          'acme',
          '--expected-revision',
          '1',
          '--json',
        ],
        env,
        home,
        { fetchImpl },
      ),
    ).toBe(0);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      'https://cloud.example.test/v1/orgs/acme/solution-installations/ins-1/invitations/binv_1',
    );
    expect(
      await runSolutions(['invitations', 'accept', 'a'.repeat(43), '--json'], env, home, {
        fetchImpl,
      }),
    ).toBe(0);
    expect(fetchImpl.mock.calls[2]?.[0]).toBe(
      `https://cloud.example.test/v1/solution-invitations/${'a'.repeat(43)}/accept`,
    );
  });

  it('rejects unsupported retention before making a request', async () => {
    const fetchImpl = vi.fn();
    expect(
      await runSolutions(
        [
          'install',
          'travel',
          '--org',
          'acme',
          '--app',
          'travel-desk',
          '--env',
          'prod',
          '--retention-days',
          '365',
          '--json',
        ],
        env,
        home,
        { fetchImpl },
      ),
    ).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(output()).toMatchObject({ ok: false, error: { code: 'usage_error' } });
  });
});
