import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deployResumeCommand } from '../src/commands/deploy-first-flow.js';
import { preflightHostedDeploy } from '../src/commands/deploy-preflight.js';
import { run, writeConfig } from '../src/index.js';
import { parseDeployRequestJson } from './deploy-request-test-helpers.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';
import { assertJsonEnvelope } from './helpers/json-envelope.js';

const HELLO = join(import.meta.dirname, 'fixtures', 'hello', 'server.ts');
const CONNECTORS = join(import.meta.dirname, 'fixtures', 'posts', 'connectors.yaml');
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

let home: string;
let cwd: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-first-deploy-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'noodle-first-deploy-cwd-'));
  chdirIsolated(cwd);
  writeConfig(
    {
      serviceUrl: 'https://service.example.test',
      authToken: 'control-plane-token',
      defaultOrg: 'acme',
    },
    home,
  );
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  restoreCwd();
  logSpy.mockRestore();
  errorSpy.mockRestore();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function stdout(): string {
  return logSpy.mock.calls.map((call) => String(call[0])).join('\n');
}

function args(): string[] {
  return [
    'deploy',
    HELLO,
    '--org',
    'acme',
    '--app',
    'support',
    '--env',
    'prod',
    '--version',
    '1',
    '--no-prompt',
    '--json',
  ];
}

describe('canonical first-deploy flow', () => {
  it('preserves preflight correlation and directs an incomplete check to tenant audit before retry', async () => {
    const requestId = '279dd3d8-22f8-48f3-9217-c43ccce8c589';
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (!String(input).endsWith('/deploy/preflight')) throw new Error('unexpected request');
      return Response.json(
        {
          code: 'deploy_preflight_busy',
          phase: 'admission',
          error: 'Preflight capacity is busy.',
        },
        { status: 503, headers: { 'x-request-id': requestId, 'retry-after': '5' } },
      );
    });
    vi.stubGlobal('fetch', fetchImpl);
    const exit = await run(args(), {}, home);
    expect(exit).not.toBe(0);
    expect(JSON.parse(stdout())).toMatchObject({
      ok: false,
      error: {
        code: 'deploy_preflight_busy',
        requestId,
        fix: expect.stringContaining('Publication did not start.'),
        next: 'noodle audit events --org acme --app support --env prod --service https://service.example.test --json',
        detail: {
          status: 503,
          phase: 'preflight.admission',
          retryAfterSeconds: 5,
          elapsedMs: expect.any(Number),
        },
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('renders every safe deploy-defining option and shell-quotes user-controlled values', () => {
    expect(
      deployResumeCommand({
        manifestPath: 'apps/customer portal/server.ts',
        connectorsPath: "config/team's connectors.yaml",
        serviceUrl: 'https://service.example.test/base?region=us east',
        target: { org: 'acme', app: 'customer portal', env: 'qa' },
        accessMode: 'owner-only',
        ownerSubject: 'oauth|customer owner',
        serverVersion: 'v 2',
        saveLegacy: true,
        noPrompt: true,
        json: true,
      }),
    ).toBe(
      "noodle deploy 'apps/customer portal/server.ts'" +
        " --connectors 'config/team'\"'\"'s connectors.yaml'" +
        " --service 'https://service.example.test/base?region=us east'" +
        " --org acme --app 'customer portal' --env qa --version 'v 2'" +
        " --access owner-only --owner-subject 'oauth|customer owner' --save --no-prompt --json",
    );
  });

  it('sends and fingerprints an explicit owner through compressed preflight and final deploy bodies', async () => {
    const bodies: Record<string, unknown>[] = [];
    const keys: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (url.endsWith('/deploy/preflight')) {
          bodies.push(parseDeployRequestJson(init));
          return Response.json({
            ok: true,
            ready: true,
            target: {
              org: 'acme',
              app: 'support',
              env: 'prod',
              appState: 'will-create',
              environmentState: 'will-create',
            },
            ownerSubject: bodies.at(-1)?.ownerSubject,
            config: { ready: true, missingSecrets: [], missingVariables: [] },
            errors: [],
          });
        }
        if (url.endsWith('/deploy')) {
          bodies.push(parseDeployRequestJson(init));
          keys.push(new Headers(init?.headers).get('idempotency-key') ?? '');
          return Response.json(
            {
              ok: true,
              org: 'acme',
              app: 'support',
              env: 'prod',
              deploymentId: 'deploy-owner-bound',
              serverVersion: '1',
              url: 'https://service.example.test/o/acme/support/v1/mcp',
              defaultUrl: 'https://service.example.test/o/acme/support/mcp',
              accessMode: 'owner-only',
              ownerSubject: 'oauth-human',
            },
            { status: 201 },
          );
        }
        if (url.endsWith('/smoke')) {
          return Response.json({
            ok: true,
            target: { org: 'acme', app: 'support', env: 'prod' },
            checks: [{ level: 'PASS', name: 'readiness', message: 'ready' }],
            external: { inspector: 'npx inspector', mcpjam: 'npx mcpjam' },
          });
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    );

    expect(await run([...args(), '--owner-subject', 'oauth-human'], {}, home)).toBe(0);
    expect(bodies).toEqual([
      expect.objectContaining({ accessMode: 'owner-only', ownerSubject: 'oauth-human' }),
      expect.objectContaining({ accessMode: 'owner-only', ownerSubject: 'oauth-human' }),
    ]);
    expect(keys[0]).toMatch(/^sha256:[a-f0-9]{64}$/);
    const envelope = assertJsonEnvelope<{ ownerSubject?: string }>(JSON.parse(stdout()));
    expect(envelope).toMatchObject({ ok: true, data: { ownerSubject: 'oauth-human' } });

    const first = await preflightHostedDeploy({
      manifestPath: HELLO,
      serviceUrl: 'https://service.example.test',
      token: 'control-plane-token',
      target: { org: 'acme', app: 'support', env: 'prod' },
      accessMode: 'owner-only',
      ownerSubject: 'oauth-human',
      serverVersion: '1',
      fetchImpl: globalThis.fetch,
    });
    const second = await preflightHostedDeploy({
      manifestPath: HELLO,
      serviceUrl: 'https://service.example.test',
      token: 'control-plane-token',
      target: { org: 'acme', app: 'support', env: 'prod' },
      accessMode: 'owner-only',
      ownerSubject: 'oauth-human-2',
      serverVersion: '1',
      fetchImpl: globalThis.fetch,
    });
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it.each([
    undefined,
    'oauth-other',
  ])('blocks an explicit owner when preflight echoes %s before mutation or deploy', async (echoedOwner) => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        calls.push(url);
        if (!url.endsWith('/deploy/preflight'))
          throw new Error(`unexpected irreversible request: ${url}`);
        return Response.json({
          ok: true,
          ready: false,
          target: {
            org: 'acme',
            app: 'support',
            env: 'prod',
            appState: 'will-create',
            environmentState: 'will-create',
          },
          ...(echoedOwner === undefined ? {} : { ownerSubject: echoedOwner }),
          config: { ready: false, missingSecrets: ['API_TOKEN'], missingVariables: [] },
          errors: [{ code: 'missing_secret', path: 'secrets.API_TOKEN', message: 'missing' }],
        });
      }),
    );

    expect(await run([...args(), '--owner-subject', 'oauth-human'], {}, home)).toBe(1);
    expect(calls).toEqual([
      'https://service.example.test/v1/orgs/acme/apps/support/envs/prod/deploy/preflight',
    ]);
    const envelope = assertJsonEnvelope<never>(JSON.parse(stdout()));
    expect(envelope).toMatchObject({
      ok: false,
      error: { code: 'deploy_owner_mismatch', detail: { requestedOwnerSubject: 'oauth-human' } },
    });
  });

  it('returns one complete missing-config checklist before the deploy request', async () => {
    writeFileSync(
      join(cwd, '.env'),
      'API_TOKEN=headless-secret-sentinel\nAPI_BASE_URL=https://headless.example.test\n',
    );
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith('/deploy/preflight')) {
          return Response.json({
            ok: true,
            ready: false,
            target: {
              org: 'acme',
              app: 'support',
              env: 'prod',
              appState: 'will-create',
              environmentState: 'will-create',
            },
            config: {
              ready: false,
              missingSecrets: ['API_TOKEN'],
              missingVariables: ['API_BASE_URL', 'REGION'],
            },
            errors: [
              {
                code: 'missing_secret',
                path: 'secrets.API_TOKEN',
                message: 'required secret is not configured',
              },
              {
                code: 'missing_variable',
                path: 'variables.API_BASE_URL',
                message: 'required variable is not configured',
              },
              {
                code: 'missing_variable',
                path: 'variables.REGION',
                message: 'required variable is not configured',
              },
            ],
          });
        }
        throw new Error(`unexpected irreversible request: ${url}`);
      }),
    );

    expect(
      await run(
        [
          'deploy',
          HELLO,
          '--connectors',
          CONNECTORS,
          '--service',
          'https://service.example.test',
          '--auth-token',
          'resume-token-sentinel',
          '--org',
          'acme',
          '--app',
          'support',
          '--env',
          'prod',
          '--version',
          '1',
          '--access',
          'public',
          '--no-save',
          '--no-prompt',
          '--json',
        ],
        {},
        home,
      ),
    ).toBe(1);
    expect(calls).toEqual([
      'https://service.example.test/v1/orgs/acme/apps/support/envs/prod/deploy/preflight',
    ]);
    const envelope = assertJsonEnvelope<never>(JSON.parse(stdout()));
    expect(envelope.ok).toBe(false);
    if (envelope.ok) return;
    expect(envelope.error).toMatchObject({
      code: 'missing_config',
      next: 'noodle variables set API_BASE_URL --runtime cloud --scope env --org acme --app support --env prod --from-env API_BASE_URL',
      detail: {
        target: { org: 'acme', app: 'support', env: 'prod' },
        missingSecrets: ['API_TOKEN'],
        missingVariables: ['API_BASE_URL', 'REGION'],
        resume: deployResumeCommand({
          manifestPath: HELLO,
          connectorsPath: CONNECTORS,
          serviceUrl: 'https://service.example.test',
          target: { org: 'acme', app: 'support', env: 'prod' },
          accessMode: 'public',
          serverVersion: '1',
          noSave: true,
          noPrompt: true,
          json: true,
        }),
      },
    });
    expect(stdout()).not.toContain('control-plane-token');
    expect(stdout()).not.toContain('resume-token-sentinel');
    expect(stdout()).not.toContain('headless-secret-sentinel');
    expect(stdout()).not.toContain('https://headless.example.test');
  });

  it('stops an asset-bearing deploy at the lock preflight before planning or uploading assets', async () => {
    mkdirSync(join(cwd, 'assets'));
    writeFileSync(join(cwd, 'assets', 'logo.png'), PNG_1X1);
    const authored = join(cwd, 'server.ts');
    writeFileSync(
      authored,
      `
import { asset, server, tool, z } from '@noodleseed/one';
const logo = asset('./assets/logo.png');
export default server('locked_asset', { title: 'Locked asset', version: '1.0.0', branding: { logo: { uri: logo, alt: 'Logo' } } }, [
  tool('status', { description: 'Status.', input: z.object({}), output: z.object({ ok: z.boolean() }), fulfil: () => ({ ok: true }) }),
]);
`,
    );
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        calls.push(url);
        if (!url.endsWith('/deploy/preflight')) throw new Error(`unexpected request: ${url}`);
        const body = parseDeployRequestJson(init);
        expect(body.hostedAssets).toHaveLength(1);
        return Response.json({
          ok: true,
          ready: false,
          target: {
            org: 'acme',
            app: 'support',
            env: 'prod',
            appState: 'existing',
            environmentState: 'existing',
          },
          config: { ready: true, missingSecrets: [], missingVariables: [] },
          errors: [
            {
              code: 'deployment_locked',
              path: 'serverVersion',
              message: 'this server version is locked; unlock it before deploying',
            },
          ],
        });
      }),
    );

    expect(
      await run(
        [
          'deploy',
          authored,
          '--org',
          'acme',
          '--app',
          'support',
          '--env',
          'prod',
          '--version',
          '1',
          '--no-prompt',
          '--json',
        ],
        {},
        home,
      ),
    ).toBe(1);
    expect(calls, stdout()).toEqual([
      'https://service.example.test/v1/orgs/acme/apps/support/envs/prod/deploy/preflight',
    ]);
    const envelope = assertJsonEnvelope<never>(JSON.parse(stdout()));
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error).toMatchObject({
        code: 'deployment_locked',
        next: 'noodle deployments unlock --org acme --app support --env prod --version 1 --yes',
      });
    }
  });

  it('uses a reserved HTTPS placeholder when the deploy service is an internal Docker hostname', async () => {
    mkdirSync(join(cwd, 'assets'));
    writeFileSync(join(cwd, 'assets', 'logo.png'), PNG_1X1);
    const authored = join(cwd, 'server.ts');
    writeFileSync(
      authored,
      `
import { asset, server, tool, z } from '@noodleseed/one';
const logo = asset('./assets/logo.png');
export default server('local_asset', { title: 'Local asset', version: '1.0.0', branding: { logo: { uri: logo, alt: 'Logo' } } }, [
  tool('status', { description: 'Status.', input: z.object({}), output: z.object({ ok: z.boolean() }), fulfil: () => ({ ok: true }) }),
]);
`,
    );

    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        'http://noodle:8787/v1/orgs/noodle-local/apps/local-asset/envs/prod/deploy/preflight',
      );
      const body = parseDeployRequestJson(init);
      expect(body.hostedAssets).toEqual([
        expect.objectContaining({
          publicUrl: expect.stringMatching(
            /^https:\/\/deploy-preflight\.invalid\/__noodle\/deploy-preflight\//,
          ),
        }),
      ]);
      expect(JSON.stringify(body)).not.toContain('http://noodle:8787');
      return Response.json({
        ok: true,
        ready: true,
        target: {
          org: 'noodle-local',
          app: 'local-asset',
          env: 'prod',
          appState: 'will-create',
          environmentState: 'will-create',
        },
        config: { ready: true, missingSecrets: [], missingVariables: [] },
        errors: [],
      });
    });

    await expect(
      preflightHostedDeploy({
        manifestPath: authored,
        serviceUrl: 'http://noodle:8787',
        token: 'control-plane-token',
        target: { org: 'noodle-local', app: 'local-asset', env: 'prod' },
        accessMode: 'public',
        serverVersion: '1',
        fetchImpl,
      }),
    ).resolves.toMatchObject({ response: { ready: true } });
  });

  it('preflights, deploys with a retry key, then verifies hosted readiness', async () => {
    const calls: string[] = [];
    let deployHeaders: Headers | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith('/deploy/preflight')) {
          return Response.json({
            ok: true,
            ready: true,
            target: {
              org: 'acme',
              app: 'support',
              env: 'prod',
              appState: 'will-create',
              environmentState: 'will-create',
            },
            config: { ready: true, missingSecrets: [], missingVariables: [] },
            errors: [],
          });
        }
        if (url.endsWith('/deploy')) {
          deployHeaders = new Headers(init?.headers);
          return Response.json(
            {
              ok: true,
              org: 'acme',
              app: 'support',
              env: 'prod',
              deploymentId: 'deploy-1234567890abcdef',
              serverVersion: '1',
              url: 'https://service.example.test/o/acme/support/v1/mcp',
              defaultUrl: 'https://service.example.test/o/acme/support/mcp',
              accessMode: 'owner-only',
            },
            { status: 201 },
          );
        }
        if (url.endsWith('/smoke')) {
          return Response.json({
            ok: true,
            target: { org: 'acme', app: 'support', env: 'prod' },
            checks: [{ level: 'PASS', name: 'readiness', message: 'ready' }],
            external: { inspector: 'npx inspector', mcpjam: 'npx mcpjam' },
          });
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    );

    expect(await run(args(), {}, home)).toBe(0);
    expect(calls).toEqual([
      'https://service.example.test/v1/orgs/acme/apps/support/envs/prod/deploy/preflight',
      'https://service.example.test/v1/orgs/acme/apps/support/envs/prod/deploy',
      'https://service.example.test/v1/orgs/acme/apps/support/envs/prod/smoke',
    ]);
    expect(deployHeaders?.get('idempotency-key')).toMatch(/^sha256:[a-f0-9]{64}$/);
    const envelope = assertJsonEnvelope<{
      deploymentId: string;
      verification: { ok: boolean };
    }>(JSON.parse(stdout()));
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;
    expect(envelope.data).toMatchObject({
      deploymentId: 'deploy-1234567890abcdef',
      verification: { ok: true },
    });
  });

  it('reports a deployed-but-unverified state with the same idempotent resume command', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.endsWith('/deploy/preflight')) {
          return Response.json({
            ok: true,
            ready: true,
            target: {
              org: 'acme',
              app: 'support',
              env: 'prod',
              appState: 'will-create',
              environmentState: 'will-create',
            },
            config: { ready: true, missingSecrets: [], missingVariables: [] },
            errors: [],
          });
        }
        if (url.endsWith('/deploy')) {
          return Response.json(
            {
              ok: true,
              org: 'acme',
              app: 'support',
              env: 'prod',
              deploymentId: 'deploy-1234567890abcdef',
              serverVersion: '1',
              url: 'https://service.example.test/o/acme/support/v1/mcp',
              defaultUrl: 'https://service.example.test/o/acme/support/mcp',
              accessMode: 'owner-only',
            },
            { status: 201 },
          );
        }
        if (url.endsWith('/smoke')) {
          return Response.json({
            ok: false,
            target: { org: 'acme', app: 'support', env: 'prod' },
            checks: [{ level: 'FAIL', name: 'readiness', message: 'not ready' }],
            external: { inspector: 'npx inspector', mcpjam: 'npx mcpjam' },
          });
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    );

    expect(await run(args(), {}, home)).toBe(1);
    const envelope = assertJsonEnvelope<never>(JSON.parse(stdout()));
    expect(envelope.ok).toBe(false);
    if (envelope.ok) return;
    expect(envelope.error).toMatchObject({
      code: 'deploy_verification_failed',
      next: deployResumeCommand({
        manifestPath: HELLO,
        serviceUrl: 'https://service.example.test',
        target: { org: 'acme', app: 'support', env: 'prod' },
        accessMode: 'owner-only',
        serverVersion: '1',
        noPrompt: true,
        json: true,
      }),
      detail: {
        deploymentId: 'deploy-1234567890abcdef',
        deployed: true,
        verification: { ok: false },
      },
    });
  });

  it('reuses the unfinished deploy key until readiness verification succeeds', async () => {
    const deployKeys: string[] = [];
    let smokeAttempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (url.endsWith('/deploy/preflight')) {
          return Response.json({
            ok: true,
            ready: true,
            target: {
              org: 'acme',
              app: 'support',
              env: 'prod',
              appState: smokeAttempts === 0 ? 'will-create' : 'existing',
              environmentState: smokeAttempts === 0 ? 'will-create' : 'existing',
            },
            config: { ready: true, missingSecrets: [], missingVariables: [] },
            errors: [],
          });
        }
        if (url.endsWith('/deploy')) {
          const key = new Headers(init?.headers).get('idempotency-key');
          if (key !== null) deployKeys.push(key);
          return Response.json(
            {
              ok: true,
              org: 'acme',
              app: 'support',
              env: 'prod',
              deploymentId: 'deploy-1234567890abcdef',
              serverVersion: '1',
              url: 'https://service.example.test/o/acme/support/v1/mcp',
              defaultUrl: 'https://service.example.test/o/acme/support/mcp',
              accessMode: 'owner-only',
            },
            { status: 201 },
          );
        }
        if (url.endsWith('/smoke')) {
          smokeAttempts++;
          return Response.json({
            ok: smokeAttempts > 1,
            target: { org: 'acme', app: 'support', env: 'prod' },
            checks: [
              {
                level: smokeAttempts > 1 ? 'PASS' : 'FAIL',
                name: 'readiness',
                message: smokeAttempts > 1 ? 'ready' : 'not ready',
              },
            ],
            external: { inspector: 'npx inspector', mcpjam: 'npx mcpjam' },
          });
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    );

    expect(await run(args(), {}, home)).toBe(1);
    logSpy.mockClear();
    expect(await run(args(), {}, home)).toBe(0);
    expect(deployKeys).toHaveLength(2);
    expect(deployKeys[0]).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(deployKeys[1]).toBe(deployKeys[0]);
  });

  it('reuses the unfinished deploy key after deployment fails before activation', async () => {
    const deployKeys: string[] = [];
    let deployAttempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (url.endsWith('/deploy/preflight')) {
          return Response.json({
            ok: true,
            ready: true,
            target: {
              org: 'acme',
              app: 'support',
              env: 'prod',
              appState: 'will-create',
              environmentState: 'will-create',
            },
            config: { ready: true, missingSecrets: [], missingVariables: [] },
            errors: [],
          });
        }
        if (url.endsWith('/deploy')) {
          const key = new Headers(init?.headers).get('idempotency-key');
          if (key !== null) deployKeys.push(key);
          deployAttempts++;
          if (deployAttempts === 1) {
            return Response.json({ error: 'temporary activation failure' }, { status: 503 });
          }
          return Response.json(
            {
              ok: true,
              org: 'acme',
              app: 'support',
              env: 'prod',
              deploymentId: 'deploy-1234567890abcdef',
              serverVersion: '1',
              url: 'https://service.example.test/o/acme/support/v1/mcp',
              defaultUrl: 'https://service.example.test/o/acme/support/mcp',
              accessMode: 'owner-only',
            },
            { status: 201 },
          );
        }
        if (url.endsWith('/smoke')) {
          return Response.json({
            ok: true,
            target: { org: 'acme', app: 'support', env: 'prod' },
            checks: [{ level: 'PASS', name: 'readiness', message: 'ready' }],
            external: { inspector: 'npx inspector', mcpjam: 'npx mcpjam' },
          });
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    );

    expect(await run(args(), {}, home)).toBe(1);
    logSpy.mockClear();
    expect(await run(args(), {}, home)).toBe(0);
    expect(deployKeys).toHaveLength(2);
    expect(deployKeys[1]).toBe(deployKeys[0]);
  });

  it('sends the preflight body gzip-compressed, like the deploy call', async () => {
    // A real customer manifest is multi-megabyte (inline widget bundles); deploy already gzips
    // and the service already accepts content-encoding: gzip on the whole deploy lane.
    const seen: Array<{ encoding: string | null; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (!String(input).endsWith('/deploy/preflight'))
        throw new Error(`unexpected request: ${String(input)}`);
      seen.push({
        encoding: new Headers(init?.headers).get('content-encoding'),
        body: parseDeployRequestJson(init),
      });
      return Response.json({
        ok: true,
        ready: true,
        target: {
          org: 'acme',
          app: 'support',
          env: 'prod',
          appState: 'existing',
          environmentState: 'existing',
        },
        config: { ready: true, missingSecrets: [], missingVariables: [] },
        errors: [],
      });
    });

    const preflight = await preflightHostedDeploy({
      manifestPath: HELLO,
      serviceUrl: 'https://service.example.test',
      token: 'control-plane-token',
      target: { org: 'acme', app: 'support', env: 'prod' },
      accessMode: 'public',
      serverVersion: '1',
      fetchImpl,
    });

    expect(preflight.response.ready).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.encoding).toBe('gzip');
    expect(typeof seen[0]?.body.manifest).toBe('string');
    expect(seen[0]?.body.serverVersion).toBe('1');
  });
});
