import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryControlPlaneStore, type RunningService, serveService } from '@noodle-borg/service';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runOrgsMcpSubdomain } from '../src/commands/org-mcp-subdomain.js';
import { run, writeConfig } from '../src/index.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';

const IDENTITIES: Record<string, { subject: string; email: string }> = {
  'owner-token': { subject: 'owner-sub', email: 'owner@example.com' },
  'developer-token': { subject: 'developer-sub', email: 'developer@example.com' },
};
const MCP_BASE_DOMAIN = 'borg.noodleseed.test';

const ORGS = {
  read: 'mcp-read-cli',
  confirmation: 'mcp-confirm-cli',
  cancel: 'mcp-cancel-cli',
  change: 'mcp-change-cli',
  human: 'mcp-human-cli',
  denied: 'mcp-denied-cli',
} as const;

let service: RunningService;
let store: InMemoryControlPlaneStore;
let home: string;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  store = new InMemoryControlPlaneStore();
  for (const org of Object.values(ORGS)) {
    await store.createOrgWithOwner({
      slug: org,
      owner: { subject: 'owner-sub', email: 'owner@example.com' },
    });
    await store.addOrgMember({
      org,
      subject: 'developer-sub',
      email: 'developer@example.com',
      role: 'developer',
    });
  }
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
    mcpPublicRouting: { publicBaseDomain: MCP_BASE_DOMAIN },
  });
});

afterAll(async () => {
  await service.close();
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-mcp-subdomain-cli-'));
  chdirIsolated(home);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  restoreCwd();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

function loginAs(token: string, org: string): void {
  writeConfig({ serviceUrl: service.url, authToken: token, defaultOrg: org }, home);
}

function stdout(): string {
  return logSpy.mock.calls.map((call) => String(call[0])).join('\n');
}

describe('noodle orgs mcp-subdomain', () => {
  it('lets any exact member read the current subdomain and resolved MCP host', async () => {
    loginAs('developer-token', ORGS.read);

    expect(await run(['orgs', 'mcp-subdomain', 'get', '--json'], {}, home)).toBe(0);

    expect(JSON.parse(stdout())).toEqual({
      ok: true,
      data: {
        orgSlug: ORGS.read,
        mcpSubdomain: ORGS.read,
        mcpServerHost: `${ORGS.read}.${MCP_BASE_DOMAIN}`,
        changeAllowedAt: null,
      },
    });
  });

  it('requires --yes non-interactively before making any request', async () => {
    loginAs('owner-token', ORGS.confirmation);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    expect(
      await run(['orgs', 'mcp-subdomain', 'set', 'mcp-confirmed-cli', '--json'], {}, home),
    ).toBe(2);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.parse(stdout())).toMatchObject({
      ok: false,
      error: {
        code: 'confirmation_required',
        cause: expect.stringContaining('Existing MCP server URLs stop working immediately'),
        next: expect.stringContaining('--yes'),
      },
    });
    fetchSpy.mockRestore();
  });

  it('defaults an interactive confirmation to No and sends no mutation when cancelled', async () => {
    loginAs('owner-token', ORGS.cancel);
    const originalFetch = globalThis.fetch;
    const methods: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      methods.push(init?.method ?? 'GET');
      return originalFetch(input, init);
    });
    const confirm = vi.fn().mockResolvedValue(false);

    expect(
      await runOrgsMcpSubdomain(['set', 'mcp-cancelled-cli'], {}, home, {
        isInteractive: () => true,
        confirm,
      }),
    ).toBe(2);

    expect(confirm).toHaveBeenCalledWith('Change the organization MCP subdomain?', {
      initial: false,
    });
    expect(methods).toEqual(['GET']);
    expect(stdout()).toContain('Existing MCP server URLs stop working immediately');
    await expect(store.getMcpSubdomainSetting(ORGS.cancel)).resolves.toMatchObject({
      mcpSubdomain: ORGS.cancel,
    });
    fetchSpy.mockRestore();
  });

  it('changes once with an opaque idempotency key and explicit breakage acknowledgement', async () => {
    loginAs('owner-token', ORGS.change);
    const originalFetch = globalThis.fetch;
    let mutationKey: string | null = null;
    let mutationBody: unknown;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (init?.method === 'PUT') {
        mutationKey = new Headers(init.headers).get('idempotency-key');
        mutationBody = JSON.parse(String(init.body));
      }
      return originalFetch(input, init);
    });

    expect(
      await run(['orgs', 'mcp-subdomain', 'set', 'mcp-changed-cli', '--yes', '--json'], {}, home),
    ).toBe(0);

    expect(mutationKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(mutationBody).toEqual({
      mcpSubdomain: 'mcp-changed-cli',
      acknowledgeOldUrlsStopWorking: true,
    });
    const body = JSON.parse(stdout());
    expect(body).toMatchObject({
      ok: true,
      data: {
        orgSlug: ORGS.change,
        previousMcpSubdomain: ORGS.change,
        mcpSubdomain: 'mcp-changed-cli',
        previousMcpServerHost: `${ORGS.change}.${MCP_BASE_DOMAIN}`,
        mcpServerHost: `mcp-changed-cli.${MCP_BASE_DOMAIN}`,
        changed: true,
        oldUrlsInvalidated: true,
        reauthorizationRequired: true,
        reconnectRequired: true,
      },
    });
    expect(stdout()).not.toContain(String(mutationKey));
    await expect(store.resolveActiveMcpSubdomain(ORGS.change)).resolves.toBeUndefined();
    await expect(store.resolveActiveMcpSubdomain('mcp-changed-cli')).resolves.toMatchObject({
      orgSlug: ORGS.change,
    });
    fetchSpy.mockRestore();
  });

  it('warns human --yes callers and gives the exact reconnect action', async () => {
    loginAs('owner-token', ORGS.human);

    expect(
      await run(['orgs', 'mcp-subdomain', 'set', 'mcp-human-changed', '--yes'], {}, home),
    ).toBe(0);

    const out = stdout();
    expect(out).toContain('Existing MCP server URLs stop working immediately');
    expect(out).toContain('The old host will not redirect and can never be reused');
    expect(out).toContain('Update every MCP client to the new URL, then reconnect and reauthorize');
    expect(out).toContain(`mcp-human-changed.${MCP_BASE_DOMAIN}`);
    expect(out).not.toContain('owner-token');
  });

  it('keeps developer-role members read-only', async () => {
    loginAs('developer-token', ORGS.denied);

    expect(
      await run(
        ['orgs', 'mcp-subdomain', 'set', 'mcp-denied-changed', '--yes', '--json'],
        {},
        home,
      ),
    ).toBe(3);

    expect(JSON.parse(stdout())).toMatchObject({
      ok: false,
      error: { code: 'organization_owner_required' },
    });
    await expect(store.getMcpSubdomainSetting(ORGS.denied)).resolves.toMatchObject({
      mcpSubdomain: ORGS.denied,
    });
  });
});
