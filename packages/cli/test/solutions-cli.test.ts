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
          profileId: 'travel',
          appSlug: 'travel-desk',
          environment: 'prod',
          retentionDays: 30,
        }),
      }),
    );
    expect(output()).toMatchObject({ ok: true, data: { installation: { id: 'ins_1' } } });
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
