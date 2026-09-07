import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryControlPlaneStore, type RunningService, serveService } from '@noodle-borg/service';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  renderInvitationsTable,
  renderMembersTable,
  renderOrgsTable,
} from '../src/commands/org-admin.js';
import { run, writeConfig } from '../src/index.js';

/**
 * Org administration CLI (issue #267) verified against a real service instance: org rename, member role
 * change, and invitation list/revoke ride the same `/v1/orgs/...` routes the service ships in this slice.
 */

let service: RunningService;
let store: InMemoryControlPlaneStore;
let home: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

const IDENTITIES: Record<string, { subject: string; email: string }> = {
  'owner-token': { subject: 'sub-owner', email: 'owner@noodleseed.com' },
  'dev-token': { subject: 'sub-dev', email: 'dev@noodleseed.com' },
};

beforeAll(async () => {
  store = new InMemoryControlPlaneStore();
  service = await serveService({
    port: 0,
    controlPlaneStore: store,
    deployGate: {
      authorize: (req) => {
        const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        const identity = token !== undefined ? IDENTITIES[token] : undefined;
        if (identity === undefined) {
          return Promise.resolve({ ok: false, status: 401, message: 'missing bearer token' });
        }
        return Promise.resolve({ ok: true, identity: { ...identity, superAdmin: false } });
      },
    },
    verifyOwnerToken: () => Promise.resolve(null),
    authServerIssuer: 'https://as.noodle.test',
  });
});

afterAll(async () => {
  await service.close();
});

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'noodle-org-admin-cli-'));
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  await store.createOrg({ slug: 'acme', displayName: 'Acme' });
  await store.addOrgMember({
    org: 'acme',
    subject: 'sub-owner',
    email: 'owner@noodleseed.com',
    role: 'owner',
  });
  await store.addOrgMember({
    org: 'acme',
    subject: 'sub-dev',
    email: 'dev@noodleseed.com',
    role: 'developer',
  });
});

afterEach(async () => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  rmSync(home, { recursive: true, force: true });
  // Reset acme to the canonical two-member fixture for the next test.
  await store.revokeOrgInvitation({ org: 'acme', email: 'newbie@noodleseed.com' });
  await store.updateOrg({ slug: 'acme', displayName: 'Acme' });
  await store.updateOrgMemberRole({ org: 'acme', subject: 'sub-owner', role: 'owner' });
  await store.updateOrgMemberRole({ org: 'acme', subject: 'sub-dev', role: 'developer' });
});

function stdout(): string {
  return logSpy.mock.calls.map((call) => String(call[0])).join('\n');
}

function stderr(): string {
  return errSpy.mock.calls.map((call) => String(call[0])).join('\n');
}

function loginAs(token: string): void {
  writeConfig({ serviceUrl: service.url, authToken: token }, home);
}

async function inviteNewbie(): Promise<void> {
  const res = await fetch(`${service.url}/v1/orgs/acme/invitations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer owner-token' },
    body: JSON.stringify({ email: 'newbie@noodleseed.com', role: 'developer' }),
  });
  expect(res.status).toBe(201);
}

describe('noodle orgs list', () => {
  it('renders the branded orgs table with slug, name, and relative created time', async () => {
    loginAs('owner-token');
    expect(await run(['orgs', 'list'], {}, home)).toBe(0);
    const out = stdout();
    for (const header of ['ORG', 'NAME', 'CREATED']) expect(out).toContain(header);
    expect(out).toContain('acme');
    expect(out).toContain('Acme');
    expect(out).toContain('just now');
  });

  it('wraps the org list payload under data', async () => {
    loginAs('owner-token');
    expect(await run(['orgs', 'list', '--json'], {}, home)).toBe(0);
    const body = JSON.parse(stdout());
    expect(Object.keys(body).sort()).toEqual(['data', 'ok']);
    expect(body.data.orgs).toEqual([
      expect.objectContaining({ slug: 'acme', displayName: 'Acme', createdAt: expect.any(String) }),
    ]);
  });
});

describe('noodle members list', () => {
  it('renders the branded members table plus the dim invite hint', async () => {
    loginAs('owner-token');
    expect(await run(['members', 'list', '--org', 'acme'], {}, home)).toBe(0);
    const out = stdout();
    for (const header of ['MEMBER', 'EMAIL', 'ROLE', 'JOINED']) expect(out).toContain(header);
    expect(out).toContain('sub-owner');
    expect(out).toContain('owner@noodleseed.com');
    expect(out).toContain('developer');
    expect(out).toContain('just now');
    expect(out).toContain('noodle members add --org acme');
  });

  it('wraps the members list payload under data', async () => {
    loginAs('owner-token');
    expect(await run(['members', 'list', '--org', 'acme', '--json'], {}, home)).toBe(0);
    const body = JSON.parse(stdout());
    expect(Object.keys(body).sort()).toEqual(['data', 'ok']);
    expect(body.data.members).toHaveLength(2);
    expect(body.data.members[0]).toMatchObject({
      subject: expect.any(String),
      email: expect.any(String),
      role: expect.any(String),
    });
  });
});

describe('org-admin table renderers', () => {
  it('colors owner roles orange and metadata dim under truecolor', () => {
    const colored = renderMembersTable(
      [
        {
          subject: 'sub-owner',
          email: 'owner@noodleseed.com',
          role: 'owner',
          createdAt: new Date().toISOString(),
        },
        {
          subject: 'sub-dev',
          email: 'dev@noodleseed.com',
          role: 'developer',
          createdAt: new Date().toISOString(),
        },
      ],
      { color: 'truecolor', glyph: 'unicode' },
    );
    expect(colored).toContain('38;2;249;115;22'); // owner role → orange
    expect(colored).toContain('38;2;115;115;115'); // email/joined → dim
  });

  it('colors invitation expiry green when accepted and amber when expired', () => {
    const now = new Date().toISOString();
    const colored = renderInvitationsTable(
      [
        { email: 'a@x.com', role: 'developer', status: 'accepted', createdAt: now, expiresAt: now },
        { email: 'b@x.com', role: 'developer', status: 'expired', createdAt: now, expiresAt: now },
      ],
      { color: 'truecolor', glyph: 'unicode' },
    );
    expect(colored).toContain('accepted');
    expect(colored).toContain('expired');
    expect(colored).toContain('38;2;34;197;94'); // accepted → green
    expect(colored).toContain('38;2;245;158;11'); // expired → amber
  });

  it('stays escape-free under color none', () => {
    const plain = renderOrgsTable(
      [{ slug: 'acme', displayName: 'Acme', createdAt: new Date().toISOString() }],
      { color: 'none', glyph: 'ascii' },
    );
    expect(plain).not.toContain(String.fromCharCode(27));
    expect(plain).toContain('acme');
  });
});

describe('noodle orgs rename', () => {
  it('renames the org for owners and emits JSON without token material', async () => {
    loginAs('owner-token');
    expect(
      await run(['orgs', 'rename', 'acme', '--name', 'Acme Industries', '--json'], {}, home),
    ).toBe(0);
    const body = JSON.parse(stdout());
    expect(body.ok).toBe(true);
    expect(body.data.org).toMatchObject({ slug: 'acme', displayName: 'Acme Industries' });
    expect(stdout()).not.toContain('owner-token');
    expect((await store.listOrgs())[0]?.displayName).toBe('Acme Industries');
  });

  it('fails for non-owners and requires --name', async () => {
    loginAs('dev-token');
    expect(await run(['orgs', 'rename', 'acme', '--name', 'Nope'], {}, home)).toBe(1);
    expect(stderr()).toContain('orgs:');

    errSpy.mockClear();
    loginAs('owner-token');
    expect(await run(['orgs', 'rename', 'acme'], {}, home)).toBe(2);
  });
});

describe('noodle members set-role', () => {
  it('changes a member role and blocks demoting the last owner', async () => {
    loginAs('owner-token');
    expect(
      await run(
        [
          'members',
          'set-role',
          '--org',
          'acme',
          '--subject',
          'sub-dev',
          '--role',
          'owner',
          '--json',
        ],
        {},
        home,
      ),
    ).toBe(0);
    expect(JSON.parse(stdout()).data.member).toMatchObject({ subject: 'sub-dev', role: 'owner' });

    // Reset dev back down, then try to demote the only remaining owner.
    await store.updateOrgMemberRole({ org: 'acme', subject: 'sub-dev', role: 'developer' });
    expect(
      await run(
        ['members', 'set-role', '--org', 'acme', '--subject', 'sub-owner', '--role', 'developer'],
        {},
        home,
      ),
    ).toBe(1);
    expect(stderr()).toContain('members:');
    expect((await store.getOrgMember({ org: 'acme', subject: 'sub-owner' }))?.role).toBe('owner');
  });
});

describe('noodle members invitations', () => {
  it('prints a friendly empty line when there are no invitations (not a silent no-op)', async () => {
    loginAs('owner-token');
    expect(await run(['members', 'invitations', '--org', 'acme'], {}, home)).toBe(0);
    expect(stdout()).toContain('No invitations found.');
  });

  it('lists pending invitations without exposing tokens', async () => {
    await inviteNewbie();
    loginAs('owner-token');
    expect(await run(['members', 'invitations', '--org', 'acme', '--json'], {}, home)).toBe(0);
    const printed = stdout();
    expect(printed).not.toContain('tokenHash');
    const body = JSON.parse(printed);
    expect(body.ok).toBe(true);
    expect(body.data.invitations).toEqual([
      expect.objectContaining({
        email: 'newbie@noodleseed.com',
        role: 'developer',
        status: 'pending',
      }),
    ]);
  });

  it('renders the branded invitations table with relative invited/expiry columns', async () => {
    await inviteNewbie();
    loginAs('owner-token');
    expect(await run(['members', 'invitations', '--org', 'acme'], {}, home)).toBe(0);
    const out = stdout();
    for (const header of ['EMAIL', 'ROLE', 'INVITED', 'EXPIRES']) expect(out).toContain(header);
    expect(out).toContain('newbie@noodleseed.com');
    expect(out).toContain('just now'); // invited moments ago
    expect(out).toMatch(/in [67]d/); // 7-day invitation TTL, rounded by elapsed milliseconds
  });

  it('is owner-only', async () => {
    loginAs('dev-token');
    expect(await run(['members', 'invitations', '--org', 'acme'], {}, home)).toBe(1);
    expect(stderr()).toContain('members:');
  });
});

describe('noodle members revoke', () => {
  it('revokes pending invitations by email', async () => {
    await inviteNewbie();
    loginAs('owner-token');
    expect(
      await run(
        ['members', 'revoke', '--org', 'acme', '--email', 'newbie@noodleseed.com', '--json'],
        {},
        home,
      ),
    ).toBe(0);
    expect(JSON.parse(stdout())).toMatchObject({ ok: true, data: { revoked: 1 } });
    expect(await store.listOrgInvitations('acme')).toEqual([]);
  });

  it('requires --email', async () => {
    loginAs('owner-token');
    expect(await run(['members', 'revoke', '--org', 'acme'], {}, home)).toBe(2);
  });
});
