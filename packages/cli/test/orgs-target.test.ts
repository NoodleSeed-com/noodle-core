import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryControlPlaneStore, type RunningService, serveService } from '@noodle-borg/service';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { printRecovery } from '../src/diagnostics.js';
import { runDoctor } from '../src/doctor.js';
import { readConfig, run, writeConfig, writeProjectLink } from '../src/index.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';

/**
 * `noodle orgs switch|current|inspect`, the resolved `noodle target show`, `noodle doctor --json`,
 * `printRecovery`'s first-line message fix, and the deploy exit-code taxonomy (auth 3 / unreachable
 * 4). See AGENTS.md's Testing & Quality Gates and `packages/cli/CLAUDE.md`.
 */

const here = import.meta.dirname;
const examples = join(here, '..', '..', '..', 'examples');
const helloManifest = join(examples, 'hello', 'src', 'server.ts');

const IDENTITIES: Record<string, { subject: string; email: string }> = {
  'owner-token': { subject: 'sub-owner', email: 'owner@noodleseed.com' },
};

let service: RunningService;
let store: InMemoryControlPlaneStore;
let home: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

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
    mcpPublicRouting: { publicBaseDomain: 'cloud.noodleseed.dev' },
    verifyOwnerToken: () => Promise.resolve(null),
    authServerIssuer: 'https://as.noodle.test',
  });
});

afterAll(async () => {
  await service.close();
});

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'noodle-orgs-target-cli-'));
  chdirIsolated(home);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  await store.createOrg({ slug: 'acme', displayName: 'Acme' });
  await store.addOrgMember({
    org: 'acme',
    subject: 'sub-owner',
    email: 'owner@noodleseed.com',
    role: 'owner',
  });
});

afterEach(() => {
  restoreCwd();
  logSpy.mockRestore();
  errSpy.mockRestore();
  rmSync(home, { recursive: true, force: true });
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

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    return await fn(dir);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('noodle orgs list (flag-first regression — CodeRabbit 2026-07-05)', () => {
  it('honors --json as the first argument', async () => {
    loginAs('owner-token');
    expect(await run(['orgs', 'list', '--json'], {}, home)).toBe(0);
    const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data.orgs)).toBe(true);
  });

  it('honors --service as the first argument (with --json after)', async () => {
    loginAs('owner-token');
    expect(await run(['orgs', 'list', '--service', service.url, '--json'], {}, home)).toBe(0);
    const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(body.ok).toBe(true);
  });
});

describe('noodle orgs positional safety', () => {
  it.each([
    {
      action: 'create',
      argv: ['orgs', 'create', '--json'],
    },
    {
      action: 'rename',
      argv: ['orgs', 'rename', '--name', 'Unsafe Name', '--json'],
    },
    {
      action: 'switch',
      argv: ['orgs', 'switch', '--json'],
    },
    {
      action: 'inspect',
      argv: ['orgs', 'inspect', '--service', 'https://service.example', '--json'],
    },
  ])('rejects flags in place of the $action slug before an authenticated request', async ({
    argv,
  }) => {
    loginAs('owner-token');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        ok: true,
        org: { slug: '--json' },
        orgs: [],
        data: { slug: '--json', createdAt: new Date().toISOString() },
      }),
    );
    try {
      expect(await run(argv, {}, home)).toBe(2);
      expect(logSpy).toHaveBeenCalledOnce();
      expect(errSpy).not.toHaveBeenCalled();
      expect(JSON.parse(stdout())).toMatchObject({
        ok: false,
        error: { code: 'usage_error' },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('returns a canonical JSON usage failure when the org action is missing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      expect(await run(['orgs', '--json'], {}, home)).toBe(2);
      expect(logSpy).toHaveBeenCalledOnce();
      expect(errSpy).not.toHaveBeenCalled();
      expect(JSON.parse(stdout())).toMatchObject({
        ok: false,
        error: { code: 'missing_subcommand' },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('does not treat another flag as OpenAI challenge mutation data', async () => {
    loginAs('owner-token');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        ok: true,
        data: {
          orgSlug: 'acme',
          configured: true,
          challengeUrl: null,
          challenge: '--bogus',
        },
      }),
    );
    try {
      expect(
        await run(['orgs', 'openai-challenge', 'set', 'acme', '--code', '--bogus'], {}, home),
      ).toBe(2);
      expect(logSpy).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('noodle members mutation validation safety', () => {
  it.each([
    {
      action: 'add',
      argv: ['members', 'add', '--org', 'acme', '--json'],
    },
    {
      action: 'remove',
      argv: ['members', 'remove', '--org', 'acme', '--json'],
    },
    {
      action: 'set-role',
      argv: ['members', 'set-role', '--org', 'acme', '--json'],
    },
    {
      action: 'revoke',
      argv: ['members', 'revoke', '--org', 'acme', '--json'],
    },
  ])('validates $action before resolving authentication', async ({ argv }) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      expect(await run(argv, {}, home)).toBe(2);
      expect(logSpy).toHaveBeenCalledOnce();
      expect(errSpy).not.toHaveBeenCalled();
      expect(JSON.parse(stdout())).toMatchObject({
        ok: false,
        error: { code: 'usage_error' },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('rejects an invalid role before adding a member', async () => {
    loginAs('owner-token');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true }));
    try {
      expect(
        await run(
          [
            'members',
            'add',
            '--org',
            'acme',
            '--subject',
            'sub-new',
            '--email',
            'new@example.com',
            '--role',
            'admin',
            '--json',
          ],
          {},
          home,
        ),
      ).toBe(2);
      expect(logSpy).toHaveBeenCalledOnce();
      expect(errSpy).not.toHaveBeenCalled();
      expect(JSON.parse(stdout())).toMatchObject({
        ok: false,
        error: { code: 'usage_error' },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('does not treat another flag as a member subject', async () => {
    loginAs('owner-token');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true }));
    try {
      expect(
        await run(['members', 'remove', '--org', 'acme', '--subject', '--bogus'], {}, home),
      ).toBe(2);
      expect(logSpy).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('noodle orgs switch', () => {
  it('switches to an org the identity belongs to, writes config, and emits {org,previous}', async () => {
    loginAs('owner-token');
    expect(await run(['orgs', 'switch', 'acme', '--json'], {}, home)).toBe(0);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual({
      ok: true,
      data: { org: 'acme', previous: null },
    });
    expect(readConfig(home).defaultOrg).toBe('acme');
  });

  it('prints a plain confirmation without --json', async () => {
    loginAs('owner-token');
    expect(await run(['orgs', 'switch', 'acme'], {}, home)).toBe(0);
    expect(stdout()).toContain('Switched to acme.');
  });

  it('reports the previously-active org on a second switch', async () => {
    loginAs('owner-token');
    await store.createOrg({ slug: 'beta' });
    await store.addOrgMember({
      org: 'beta',
      subject: 'sub-owner',
      email: 'owner@noodleseed.com',
      role: 'owner',
    });
    expect(await run(['orgs', 'switch', 'acme'], {}, home)).toBe(0);
    logSpy.mockClear();
    expect(await run(['orgs', 'switch', 'beta', '--json'], {}, home)).toBe(0);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).data).toEqual({
      org: 'beta',
      previous: 'acme',
    });
  });

  it('exits 1 with not_a_member for an org the identity does not belong to', async () => {
    loginAs('owner-token');
    expect(await run(['orgs', 'switch', 'ghost', '--json'], {}, home)).toBe(1);
    const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('not_a_member');
    expect(body.error.message).toContain('ghost');
    expect(body.error.next).toBe('noodle orgs list');
  });

  it('exits 2 when no slug is given', async () => {
    loginAs('owner-token');
    expect(await run(['orgs', 'switch'], {}, home)).toBe(2);
  });

  it('exits 3 (auth_required) when not logged in, honoring --json', async () => {
    expect(await run(['orgs', 'switch', 'acme', '--json'], {}, home)).toBe(3);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).error.code).toBe('auth_required');
  });
});

describe('local default organization refresh', () => {
  it('preserves an existing default while it remains in the live organization list', async () => {
    await store.addOrgMember({
      org: 'beta',
      subject: 'sub-owner',
      email: 'owner@noodleseed.com',
      role: 'owner',
    });
    writeConfig({ serviceUrl: service.url, authToken: 'owner-token', defaultOrg: 'beta' }, home);
    try {
      expect(await run(['whoami'], {}, home)).toBe(0);
      expect(readConfig(home).defaultOrg).toBe('beta');
    } finally {
      await store.removeOrgMember({ org: 'beta', subject: 'sub-owner' });
    }
  });

  it('selects the first live organization when the saved default is stale', async () => {
    writeConfig(
      { serviceUrl: service.url, authToken: 'owner-token', defaultOrg: 'former-org' },
      home,
    );

    expect(await run(['whoami'], {}, home)).toBe(0);
    expect(readConfig(home).defaultOrg).toBe('acme');
  });

  it('clears a stale default when the user has no live organizations', async () => {
    writeConfig(
      { serviceUrl: service.url, authToken: 'owner-token', defaultOrg: 'former-org' },
      home,
    );
    await store.removeOrgMember({ org: 'acme', subject: 'sub-owner' });
    try {
      expect(await run(['whoami'], {}, home)).toBe(0);
      expect(readConfig(home)).not.toHaveProperty('defaultOrg');
    } finally {
      await store.addOrgMember({
        org: 'acme',
        subject: 'sub-owner',
        email: 'owner@noodleseed.com',
        role: 'owner',
      });
    }
  });
});

describe('noodle orgs current', () => {
  it('resolves from the linked project (source: link) over saved config', () => {
    return withTempDir('noodle-orgs-current-link-', async (dir) => {
      writeConfig({ defaultOrg: 'config-org' }, home);
      writeProjectLink({ org: 'acme', app: 'demo', cwd: dir });
      expect(await run(['orgs', 'current', '--json'], {}, home)).toBe(0);
      expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual({
        ok: true,
        data: { org: 'acme', source: 'link' },
      });
    });
  });

  it('falls back to config.defaultOrg (source: config) when no project is linked', async () => {
    writeConfig({ defaultOrg: 'acme' }, home);
    expect(await run(['orgs', 'current', '--json'], {}, home)).toBe(0);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual({
      ok: true,
      data: { org: 'acme', source: 'config' },
    });
    expect(await run(['orgs', 'current'], {}, home)).toBe(0);
    expect(stdout()).toContain('acme (from config)');
  });

  it('exits 2 with target_required when no org is set anywhere', async () => {
    expect(await run(['orgs', 'current', '--json'], {}, home)).toBe(2);
    const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(body.error.code).toBe('target_required');
    expect(body.error.next).toBe('noodle orgs switch <org>');
  });
});

describe('noodle orgs inspect', () => {
  it('shows org details for a member org, under --json and human', async () => {
    loginAs('owner-token');
    expect(await run(['orgs', 'inspect', 'acme', '--json'], {}, home)).toBe(0);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).data).toMatchObject({
      slug: 'acme',
      displayName: 'Acme',
    });

    logSpy.mockClear();
    expect(await run(['orgs', 'inspect', 'acme'], {}, home)).toBe(0);
    expect(stdout()).toContain('slug:        acme');
    expect(stdout()).toContain('displayName: Acme');
  });

  it('exits 1 with not_found for an unknown/inaccessible org slug', async () => {
    loginAs('owner-token');
    expect(await run(['orgs', 'inspect', 'ghost', '--json'], {}, home)).toBe(1);
    const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(body.error.code).toBe('not_found');
  });

  it('non-json not_found shows a distinct message line and the cause on its own Cause: line', async () => {
    loginAs('owner-token');
    expect(await run(['orgs', 'inspect', 'ghost'], {}, home)).toBe(1);
    const lines = stderr().split('\n');
    expect(lines[0]).toBe('orgs: org "ghost" was not found');
    expect(lines[1]).toBe('Cause: ghost was not found, or you do not have access to it.');
  });

  it('exits 2 when no slug is given', async () => {
    loginAs('owner-token');
    expect(await run(['orgs', 'inspect'], {}, home)).toBe(2);
  });
});

describe('noodle orgs openai-challenge', () => {
  it('sets, gets, and clears an org OpenAI Apps challenge with JSON output', async () => {
    loginAs('owner-token');
    expect(
      await run(
        ['orgs', 'openai-challenge', 'set', 'acme', '--code', 'openai-code', '--json'],
        {},
        home,
      ),
    ).toBe(0);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).data).toMatchObject({
      orgSlug: 'acme',
      challenge: 'openai-code',
      challengeUrl: 'https://acme.cloud.noodleseed.dev/.well-known/openai-apps-challenge',
    });

    logSpy.mockClear();
    expect(await run(['orgs', 'openai-challenge', 'get', 'acme', '--json'], {}, home)).toBe(0);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).data).toMatchObject({
      orgSlug: 'acme',
      challenge: 'openai-code',
    });

    logSpy.mockClear();
    expect(await run(['orgs', 'openai-challenge', 'clear', 'acme', '--json'], {}, home)).toBe(0);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).data).toMatchObject({
      org: 'acme',
      cleared: true,
    });
  });

  it('requires --code for set and honors auth-required JSON errors', async () => {
    loginAs('owner-token');
    expect(await run(['orgs', 'openai-challenge', 'set', 'acme', '--json'], {}, home)).toBe(2);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).error.code).toBe('usage_error');

    logSpy.mockClear();
    errSpy.mockClear();
    writeConfig({ serviceUrl: service.url }, home);
    expect(await run(['orgs', 'openai-challenge', 'get', 'acme', '--json'], {}, home)).toBe(3);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).error.code).toBe('auth_required');
  });
});

describe('noodle orgs domains', () => {
  it('adds several domains, lists them, and removes one', async () => {
    loginAs('owner-token');
    expect(
      await run(['orgs', 'domains', 'add', 'acme', 'abc.com', 'xyz.com', '--json'], {}, home),
    ).toBe(0);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).data).toMatchObject({
      orgSlug: 'acme',
      domains: [{ domain: 'abc.com' }, { domain: 'xyz.com' }],
    });

    logSpy.mockClear();
    expect(await run(['orgs', 'domains', 'list', 'acme', '--json'], {}, home)).toBe(0);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).data.domains).toHaveLength(2);

    logSpy.mockClear();
    expect(await run(['orgs', 'domains', 'remove', 'acme', 'abc.com', '--json'], {}, home)).toBe(0);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).data).toMatchObject({
      org: 'acme',
      domain: 'abc.com',
      removed: true,
    });

    logSpy.mockClear();
    expect(await run(['orgs', 'domains', 'list', 'acme', '--json'], {}, home)).toBe(0);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).data.domains).toEqual([
      { domain: 'xyz.com', createdAt: expect.any(String) },
    ]);
  });

  it('refuses a public email provider and names the alternative', async () => {
    loginAs('owner-token');
    expect(await run(['orgs', 'domains', 'add', 'acme', 'gmail.com', '--json'], {}, home)).toBe(1);
    const failure = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).error;
    expect(failure.code).toBe('command_failed');
    expect(failure.message).toContain('authenticated');
  });

  it('exits 2 for a missing action, a missing slug, or a missing domain', async () => {
    loginAs('owner-token');
    for (const argv of [
      ['orgs', 'domains', '--json'],
      ['orgs', 'domains', 'add', '--json'],
      ['orgs', 'domains', 'add', 'acme', '--json'],
    ]) {
      logSpy.mockClear();
      expect(await run(argv, {}, home)).toBe(2);
      expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).error.code).toBe('usage_error');
    }
  });

  it('exits 3 when not logged in', async () => {
    writeConfig({ serviceUrl: service.url }, home);
    expect(await run(['orgs', 'domains', 'list', 'acme', '--json'], {}, home)).toBe(3);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).error.code).toBe('auth_required');
  });
});

describe('noodle target show (resolved, per-field sources)', () => {
  it('prefers link over config, and reports default/unset appropriately', () => {
    return withTempDir('noodle-target-show-link-', async (dir) => {
      writeConfig(
        {
          defaultOrg: 'config-org',
          defaultApp: 'config-app',
          defaultEnv: 'staging',
          defaultRuntime: 'cloud',
          serviceUrl: 'https://cfg.example',
        },
        home,
      );
      writeProjectLink({ org: 'link-org', app: 'link-app', cwd: dir });
      expect(await run(['target', 'show', '--json'], {}, home)).toBe(0);
      const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
      expect(body.data.target.org).toEqual({ value: 'link-org', source: 'link' });
      expect(body.data.target.app).toEqual({ value: 'link-app', source: 'link' });
      expect(body.data.target.env).toEqual({ value: 'prod', source: 'link' });
      expect(body.data.target.runtime).toEqual({ value: 'cloud', source: 'config' });
      expect(body.data.target.service.source).toBe('link');
    });
  });

  it('falls back to config, then built-in default, and reports org/app as unset', async () => {
    writeConfig({ defaultRuntime: 'cloud' }, home);
    expect(await run(['target', 'show', '--json'], {}, home)).toBe(0);
    const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(body.data.target.runtime).toEqual({ value: 'cloud', source: 'config' });
    expect(body.data.target.org).toEqual({ value: null, source: 'unset' });
    expect(body.data.target.app).toEqual({ value: null, source: 'unset' });
    expect(body.data.target.env).toEqual({ value: 'prod', source: 'default' });
  });

  it('human output is a detail card annotating each row with its dim source note', async () => {
    writeConfig({ defaultOrg: 'acme' }, home);
    expect(await run(['target', 'show'], {}, home)).toBe(0);
    const out = stdout();
    // Title is the effective org/app/env (unset fields dashed); rows carry source notes.
    expect(out.split('\n')[0]).toMatch(/^acme\/.+\/prod$/);
    expect(out).toMatch(/org\s+acme \(from config\)/);
    expect(out).toMatch(/env\s+prod \(default\)/);
    expect(out).toContain('(from config)');
    expect(out).toContain('(default)');
    expect(out).toContain('NEXT');
    expect(out).toContain('noodle target set');
  });
});

describe('noodle doctor --json', () => {
  it('emits {ok,data:{checks,summary}} and exits 1 when a check fails', () => {
    return withTempDir('noodle-doctor-json-fail-', async (dir) => {
      expect(
        await run(['init', '--no-install', dir, '--name', 'hello-world', '--force'], {}, home),
      ).toBe(0);
      expect(
        await run(
          ['link', '--org', 'acme', '--app', 'hello-world', '--service', service.url],
          {},
          home,
        ),
      ).toBe(0);
      logSpy.mockClear();
      expect(await run(['doctor', '--json'], {}, home)).toBe(1);
      const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.data.checks)).toBe(true);
      expect(body.data.summary.fail).toBeGreaterThan(0);
      const loginCheck = body.data.checks.find((check: { name: string }) => check.name === 'Login');
      expect(loginCheck).toMatchObject({ status: 'fail', next: 'noodle login' });
    });
  }, 30_000);

  it('exits 0 with an all-clear summary when every check passes', () => {
    return withTempDir('noodle-doctor-json-pass-', async (dir) => {
      loginAs('owner-token');
      expect(
        await run(['init', '--no-install', dir, '--name', 'hello-json', '--force'], {}, home),
      ).toBe(0);
      expect(
        await run(
          ['link', '--org', 'acme', '--app', 'hello-json', '--service', service.url],
          {},
          home,
        ),
      ).toBe(0);
      logSpy.mockClear();
      expect(await run(['doctor', '--json'], {}, home)).toBe(0);
      const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
      expect(body.data.summary.fail).toBe(0);
      for (const check of body.data.checks as Array<{ status: string; name: string }>) {
        expect(['pass', 'warn', 'fail']).toContain(check.status);
        expect(typeof check.name).toBe('string');
      }
    });
  }, 30_000);

  it('is equivalent to calling runDoctor directly (envelope shape)', async () => {
    const code = await runDoctor({ rest: ['--json'], env: {}, home });
    expect(code).toBe(1);
    const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(body.data.summary).toEqual(
      expect.objectContaining({
        pass: expect.any(Number),
        warn: expect.any(Number),
        fail: expect.any(Number),
      }),
    );
  }, 10_000);
});

describe('deploy exit codes', () => {
  it('exits 3 for an auth failure (401)', async () => {
    const code = await run(
      [
        'deploy',
        helloManifest,
        '--service',
        service.url,
        '--org',
        'acme',
        '--app',
        'exit-code-auth',
        '--env',
        'prod',
        '--version',
        '1',
        '--auth-token',
        'bogus-token',
      ],
      {},
      home,
    );
    expect(code).toBe(3);
  });

  it('exits 4 when the service is unreachable', async () => {
    const code = await run(
      [
        'deploy',
        helloManifest,
        '--service',
        'http://127.0.0.1:1',
        '--org',
        'acme',
        '--app',
        'exit-code-unreachable',
        '--env',
        'prod',
        '--version',
        '1',
        '--auth-token',
        'owner-token',
      ],
      {},
      home,
    );
    expect(code).toBe(4);
  });
});

describe('validate exit codes (confirmation — no behavior change)', () => {
  it('exits 2 (usage) when no entrypoint can be resolved', () => {
    return withTempDir('noodle-validate-usage-', async () => {
      expect(await run(['validate'], {}, home)).toBe(2);
    });
  });

  it('exits 1 (domain failure) for an invalid manifest', () => {
    return withTempDir('noodle-validate-domain-', async (dir) => {
      const broken = join(dir, 'broken.yaml');
      writeFileSync(broken, 'manifestVersion: "1"\nserver: {}\ntools: []\n');
      expect(await run(['validate', broken], {}, home)).toBe(1);
    });
  });
});

describe('printRecovery', () => {
  it('prints a distinct first-line message, with the cause on its own Cause: line', () => {
    const lines: string[] = [];
    printRecovery(
      {
        command: 'widget',
        message: 'short summary',
        cause: 'the long explanation',
        fix: 'do X',
        next: 'noodle y',
      },
      (line) => lines.push(line),
    );
    expect(lines).toEqual([
      'widget: short summary',
      'Cause: the long explanation',
      'Fix: do X',
      'Next: noodle y',
    ]);
  });

  it('falls back to cause for the first line when message is omitted (existing callers)', () => {
    const lines: string[] = [];
    printRecovery(
      { command: 'widget', cause: 'the cause', fix: 'the fix', next: 'the next' },
      (line) => lines.push(line),
    );
    expect(lines[0]).toBe('widget: the cause');
    expect(lines[1]).toBe('Cause: the cause');
  });
});
