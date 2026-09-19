import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSolutions } from '../src/commands/solutions-ops.js';

describe('noodle solutions workspace', () => {
  let home: string;
  const invitationId = '019e6c86-5838-4000-8000-019e6c865838';
  const token = 'i'.repeat(43);
  const env = {
    NOODLE_SERVICE_URL: 'https://service.example',
    NOODLE_AUTH_TOKEN: 'private-control-token',
    INVITATION_TOKEN: token,
  };
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'noodle-workspace-cli-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });
  it('lists only the signed-in principal workspaces with bounded service pagination', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ok: true,
        data: {
          workspaces: [
            {
              org: 'acme',
              authorityVersion: 1,
              revision: 1,
              role: 'builder',
              permissions: ['drafts:read'],
              future: true,
            },
          ],
          nextCursor: 'YWNtZQ',
          future: true,
        },
      }),
    );
    expect(
      await runSolutions(
        ['workspace', 'list', '--limit', '1', '--cursor', 'YWFh', '--json'],
        env,
        home,
        { fetchImpl },
      ),
    ).toBe(0);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://service.example/v1/me/business-workspaces?limit=1&cursor=YWFh',
    );
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain('future');
    expect(
      await runSolutions(['workspace', 'list', '--org', 'acme', '--json'], env, home, {
        fetchImpl,
      }),
    ).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('inspects live workspace authority and strips additive fields from every response layer', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ok: true,
        data: {
          org: 'acme',
          authorityVersion: 1,
          revision: 1,
          activatedAt: '2026-09-18T00:00:00.000Z',
          role: 'owner',
          permissions: ['team:manage'],
          future: 'root',
          members: [
            {
              subject: 'owner',
              role: 'owner',
              joinedAt: '2026-09-18T00:00:00.000Z',
              future: 'member',
            },
          ],
          invitations: [
            {
              id: invitationId,
              email: 'staff@example.test',
              role: 'operator',
              createdBy: 'owner',
              createdAt: '2026-09-18T00:00:00.000Z',
              expiresAt: '2026-09-25T00:00:00.000Z',
              future: token,
            },
          ],
        },
      }),
    );
    expect(
      await runSolutions(['workspace', 'show', '--org', 'acme', '--json'], env, home, {
        fetchImpl,
      }),
    ).toBe(0);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://service.example/v1/orgs/acme/business-workspace',
    );
    const output = JSON.stringify(vi.mocked(console.log).mock.calls);
    expect(output).toContain('team:manage');
    expect(output).not.toContain('future');
    expect(output).not.toContain(token);
  });
  it.each([
    [
      'invite',
      ['--email', 'staff@example.test', '--expected-revision', '1'],
      '/invitations',
      'POST',
      { email: 'staff@example.test', expectedRevision: 1, role: 'operator' },
    ],
    [
      'set-role',
      ['--subject', 'staff', '--role', 'builder', '--expected-revision', '1', '--confirm'],
      '/members',
      'PATCH',
      { subject: 'staff', role: 'builder', expectedRevision: 1 },
    ],
    [
      'remove',
      ['--subject', 'staff', '--expected-revision', '1', '--confirm'],
      '/members',
      'PATCH',
      { subject: 'staff', role: null, expectedRevision: 1 },
    ],
    [
      'revoke-invitation',
      ['--invitation', invitationId, '--expected-revision', '1', '--confirm'],
      `/invitations/${invitationId}`,
      'DELETE',
      { expectedRevision: 1 },
    ],
    ['accept', ['--token-from-env', 'INVITATION_TOKEN', '--confirm'], '/accept', 'POST', { token }],
  ] as const)('uses the typed service contract for %s', async (operation, args, suffix, method, body) => {
    const data =
      operation === 'invite'
        ? {
            id: invitationId,
            token,
            role: 'operator',
            expiresAt: '2026-09-25T00:00:00.000Z',
            revision: 2,
          }
        : { revision: 2 };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true, data: { ...data, future: true } }));
    expect(
      await runSolutions(['workspace', operation, '--org', 'acme', '--json', ...args], env, home, {
        fetchImpl,
      }),
    ).toBe(0);
    const call = fetchImpl.mock.calls[0];
    expect(call?.[0]).toBe(`https://service.example/v1/orgs/acme/business-workspace${suffix}`);
    expect(call?.[1]?.method).toBe(method);
    expect(JSON.parse(String(call?.[1]?.body))).toEqual(body);
    const output = JSON.stringify(vi.mocked(console.log).mock.calls);
    expect(output).not.toContain('private-control-token');
    expect(output).not.toContain('future');
    if (operation !== 'invite') expect(output).not.toContain(token);
  });
  it.each([
    ['set-role', '--subject', 'staff', '--role', 'owner', '--expected-revision', '1'],
    ['invite', '--email', 'staff@example.test', '--expected-revision', '1', '--role', 'superuser'],
    ['show', '--role', 'owner'],
    ['accept', '--token-from-env', 'MISSING', '--confirm'],
    ['remove', '--subject', 'staff', '--expected-revision', '1e3', '--confirm'],
  ])('fails invalid requests before network access: %j', async (...args) => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(
      await runSolutions(['workspace', ...args, '--org', 'acme', '--json'], env, home, {
        fetchImpl,
      }),
    ).not.toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(token);
  });
});
