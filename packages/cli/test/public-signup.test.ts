import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveService } from '@noodle-borg/service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readConfig, run, writeConfig } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const helloServer = join(repoRoot, 'examples', 'hello', 'src', 'server.ts');

describe('public self-service CLI signup', () => {
  let home: string;
  let cwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cwd = process.cwd();
    home = mkdtempSync(join(tmpdir(), 'noodle-cli-public-signup-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(cwd);
    logSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(home, { recursive: true, force: true });
  });

  it('stores the provisioned personal org on login and deploys without manual org flags', async () => {
    const service = await serveService({
      port: 0,
      controlPlaneSignupMode: 'public',
      deployGate: {
        authorize: (req) =>
          req.headers.authorization === 'Bearer public-token'
            ? {
                ok: true,
                identity: {
                  subject: 'sub-public',
                  email: 'builder@example.com',
                  superAdmin: false,
                },
              }
            : { ok: false, status: 401, message: 'invalid bearer token' },
      },
      authServerIssuer: 'https://as.noodle.test',
      verifyOwnerToken: () => Promise.resolve(null),
    });
    try {
      expect(
        await run(['login', '--service', service.url, '--auth-token', 'public-token'], {}, home),
      ).toBe(0);
      const config = readConfig(home);
      expect(config).toMatchObject({
        serviceUrl: service.url,
        authToken: 'public-token',
        identity: { subject: 'sub-public', email: 'builder@example.com' },
        defaultOrg: expect.stringMatching(/^u-builder-[0-9a-f]{8}$/),
      });

      logSpy.mockClear();
      expect(await run(['deploy', helloServer, '--version', '1', '--no-save'], {}, home)).toBe(0);
      const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(printed).toContain(`/o/${config.defaultOrg}/server/mcp`);
      expect(printed).toContain('Access:    owner-only');
    } finally {
      await service.close();
    }
  });

  it('ignores stale global app defaults for a fresh initialized project', async () => {
    const service = await serveService({
      port: 0,
      controlPlaneSignupMode: 'public',
      deployGate: {
        authorize: (req) =>
          req.headers.authorization === 'Bearer public-token'
            ? {
                ok: true,
                identity: {
                  subject: 'sub-public',
                  email: 'builder@example.com',
                  superAdmin: false,
                },
              }
            : { ok: false, status: 401, message: 'invalid bearer token' },
      },
      authServerIssuer: 'https://as.noodle.test',
      verifyOwnerToken: () => Promise.resolve(null),
    });
    const root = mkdtempSync(join(tmpdir(), 'noodle-cli-fresh-project-'));
    try {
      writeConfig(
        {
          serviceUrl: service.url,
          authToken: 'stale-token',
          defaultOrg: 'old-org',
          defaultApp: 'old-app',
          defaultEnv: 'prod',
        },
        home,
      );
      expect(
        await run(['login', '--service', service.url, '--auth-token', 'public-token'], {}, home),
      ).toBe(0);
      const config = readConfig(home);
      expect(config.defaultOrg).toMatch(/^u-builder-[0-9a-f]{8}$/);
      expect(config.defaultApp).toBe('old-app');

      process.chdir(root);
      expect(
        await run(
          ['init', '--no-install', 'signup-smoke', '--template', 'hello', '--no-agents'],
          {},
          home,
        ),
      ).toBe(0);
      process.chdir(join(root, 'signup-smoke'));
      logSpy.mockClear();

      expect(await run(['deploy', '--version', '1'], {}, home)).toBe(0);
      const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(printed).toContain(`/o/${config.defaultOrg}/signup-smoke/mcp`);
      expect(printed).not.toContain('/old-app/');
      expect(printed).toContain('Saved deployment metadata to .noodle/deployment.json.');
    } finally {
      rmSync(root, { recursive: true, force: true });
      await service.close();
    }
  });

  it('prints the resolved target when org access is forbidden', async () => {
    const service = await serveService({
      port: 0,
      controlPlaneSignupMode: 'public',
      deployGate: {
        authorize: (req) =>
          req.headers.authorization === 'Bearer public-token'
            ? {
                ok: true,
                identity: {
                  subject: 'sub-public',
                  email: 'builder@example.com',
                  superAdmin: false,
                },
              }
            : { ok: false, status: 401, message: 'invalid bearer token' },
      },
      authServerIssuer: 'https://as.noodle.test',
      verifyOwnerToken: () => Promise.resolve(null),
    });
    const root = mkdtempSync(join(tmpdir(), 'noodle-cli-forbidden-target-'));
    try {
      expect(
        await run(['login', '--service', service.url, '--auth-token', 'public-token'], {}, home),
      ).toBe(0);
      process.chdir(root);
      expect(
        await run(
          ['init', '--no-install', 'signup-smoke', '--template', 'hello', '--no-agents'],
          {},
          home,
        ),
      ).toBe(0);
      process.chdir(join(root, 'signup-smoke'));
      errSpy.mockClear();

      // A 403 from the deploy service is an authorization failure on this specific target — exit 3
      // (EXIT.AUTH), matching the standard exit-code taxonomy's "HTTP 401/403" bucket.
      expect(await run(['deploy', '--org', 'someone-else', '--version', '1'], {}, home)).toBe(3);
      const printed = errSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(printed).toContain('target: someone-else/signup-smoke/prod');
      expect(printed).toContain('Next: noodle whoami');
      expect(printed).not.toContain('public-token');
    } finally {
      rmSync(root, { recursive: true, force: true });
      await service.close();
    }
  });

  it('refreshes stale global org defaults during first deploy', async () => {
    const service = await serveService({
      port: 0,
      controlPlaneSignupMode: 'public',
      deployGate: {
        authorize: (req) =>
          req.headers.authorization === 'Bearer public-token'
            ? {
                ok: true,
                identity: {
                  subject: 'sub-public',
                  email: 'builder@example.com',
                  superAdmin: false,
                },
              }
            : { ok: false, status: 401, message: 'invalid bearer token' },
      },
      authServerIssuer: 'https://as.noodle.test',
      verifyOwnerToken: () => Promise.resolve(null),
    });
    const root = mkdtempSync(join(tmpdir(), 'noodle-cli-refresh-org-'));
    try {
      writeConfig(
        {
          serviceUrl: service.url,
          authToken: 'public-token',
          defaultOrg: 'old-org',
          defaultApp: 'old-app',
          defaultEnv: 'prod',
        },
        home,
      );
      process.chdir(root);
      expect(
        await run(
          ['init', '--no-install', 'signup-smoke', '--template', 'hello', '--no-agents'],
          {},
          home,
        ),
      ).toBe(0);
      process.chdir(join(root, 'signup-smoke'));
      logSpy.mockClear();

      expect(await run(['deploy', '--version', '1'], {}, home)).toBe(0);
      const config = readConfig(home);
      expect(config.defaultOrg).toMatch(/^u-builder-[0-9a-f]{8}$/);
      const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(printed).toContain(`/o/${config.defaultOrg}/signup-smoke/mcp`);
      expect(printed).not.toContain('/old-org/');
      expect(printed).not.toContain('/old-app/');
    } finally {
      rmSync(root, { recursive: true, force: true });
      await service.close();
    }
  });
});
