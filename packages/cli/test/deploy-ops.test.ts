import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { InMemoryControlPlaneStore, type RunningService, serveService } from '@noodle-borg/service';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isLocalServiceUrl } from '../src/commands/deploy-ops.js';
import { run, writeConfig } from '../src/index.js';
import { readProjectLink } from '../src/project.js';
import { assertJsonEnvelope } from './helpers/json-envelope.js';

/**
 * `noodle deploy --json` envelope contract (S3-C): success is `{ ok: true, data: {...} }` and every
 * failure is `{ ok: false, error: { code, message, ... } }`. A real service is booted and the CLI
 * deploys over the wire; the negative path also proves a non-TTY `--json` deploy never blocks on a
 * prompt (a hang would trip the test timeout).
 */
const HELLO = join(import.meta.dirname, 'fixtures', 'hello', 'server.ts');
const API_KEY_SERVER = join(import.meta.dirname, 'fixtures', 'api-key-server.ts');

let service: RunningService;
let home: string;
// A throwaway project cwd so the on-success `.noodle/project.json` link write lands in a temp dir, never
// in the repo checkout. Deploys use the absolute HELLO path, so cwd only affects link persistence.
let projectCwd: string;
let originalCwd: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  const controlPlane = new InMemoryControlPlaneStore();
  await Promise.all([
    controlPlane.createOrg({ slug: 'acme' }),
    controlPlane.createOrg({ slug: 'local' }),
  ]);
  service = await serveService({
    port: 0,
    controlPlaneStore: controlPlane,
    deployGate: {
      authorize: (req) => {
        const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        if (token !== 'admin-token')
          return Promise.resolve({ ok: false, status: 401, message: 'missing bearer token' });
        return Promise.resolve({
          ok: true,
          identity: { subject: 'admin-sub', email: 'admin@noodleseed.com', superAdmin: true },
        });
      },
    },
    verifyOwnerToken: () => Promise.resolve(null),
    authServerIssuer: 'https://as.noodle.test',
  });
});

afterAll(async () => {
  await service.close();
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-deploy-json-'));
  projectCwd = mkdtempSync(join(tmpdir(), 'noodle-deploy-cwd-'));
  originalCwd = process.cwd();
  process.chdir(projectCwd);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.chdir(originalCwd);
  logSpy.mockRestore();
  errSpy.mockRestore();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
  rmSync(projectCwd, { recursive: true, force: true });
});

function stdout(): string {
  return logSpy.mock.calls.map((call) => String(call[0])).join('\n');
}

function writeNestedProject(
  entrypointSource: string,
  configFile: 'project' | 'local' = 'project',
): string {
  const entrypoint = join(projectCwd, 'src', 'server.ts');
  const nestedCwd = join(projectCwd, 'packages', 'worker');
  mkdirSync(join(projectCwd, 'src'), { recursive: true });
  mkdirSync(nestedCwd, { recursive: true });
  writeFileSync(entrypoint, readFileSync(entrypointSource, 'utf8'));
  const config = {
    entrypoint: 'src/server.ts',
    org: 'acme',
    app: 'facts',
    env: 'staging',
    serviceUrl: service.url,
    accessMode: 'owner-only',
  };
  const configPath =
    configFile === 'project'
      ? join(projectCwd, 'noodle.json')
      : join(projectCwd, '.noodle', 'project.json');
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  process.chdir(nestedCwd);
  return nestedCwd;
}

function writeCustomerAuthServer(issuer: string): string {
  const path = join(projectCwd, 'server.ts');
  writeFileSync(
    path,
    `
import { customerAuth, server, tool, z } from '@noodleseed/one';
export default server('customer_app', {
  title: 'Customer App',
  version: '1.0.0',
  auth: customerAuth.oidc({ issuer: '${issuer}', audience: 'api://customer-app' })
}, [tool('whoami', {
  description: 'Show the caller',
  input: z.object({}),
  fulfil: ({ user }) => ({ subject: user.subject })
})]);
`,
  );
  return path;
}

function stubReadinessFetch(
  issuer: string,
  metadataResponse: Response,
  jwksResponse?: Response,
): ReturnType<typeof vi.fn<typeof fetch>> {
  const realFetch = globalThis.fetch;
  const metadataUrl = `${issuer}/.well-known/oauth-authorization-server`;
  const fetchSpy = vi.fn<typeof fetch>(async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === metadataUrl) return metadataResponse;
    if (url === `${issuer}/jwks` && jwksResponse !== undefined) return jwksResponse;
    return realFetch(input, init);
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

describe('noodle deploy --json', () => {
  it('routes the removed --secrets option through one failure envelope regardless of flag order', async () => {
    expect(await run(['deploy', '--secrets', 'old.json', '--json'], {}, home)).toBe(2);
    expect(errSpy).not.toHaveBeenCalled();
    const envelope = assertJsonEnvelope(JSON.parse(stdout()));
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected a failure envelope');
    expect(envelope.error.code).toBe('deprecated_option');
  });

  it('emits a data-wrapped success envelope without leaking the token', async () => {
    writeConfig({ serviceUrl: service.url, authToken: 'admin-token', defaultOrg: 'acme' }, home);
    const code = await run(
      ['deploy', HELLO, '--org', 'acme', '--app', 'hello', '--version', '1', '--json'],
      {},
      home,
    );
    expect(code).toBe(0);
    const envelope = assertJsonEnvelope<{
      deploymentId: string;
      serverVersion: string;
      url: string;
      service: string;
      accessMode?: string;
      ownerSubject?: string;
      linked?: boolean;
      target?: { org: string; app: string; env: string };
    }>(JSON.parse(stdout()));
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) throw new Error('expected a success envelope');
    expect(typeof envelope.data.deploymentId).toBe('string');
    expect(envelope.data.service).toBe(service.url);
    expect(envelope.data.url).toContain('hello');
    expect(envelope.data.ownerSubject).toBe('admin-sub');
    expect(stdout()).not.toContain('admin-token');
    // Deploying an explicit path from an unrelated cwd is not an in-project deploy, so it never rewrites
    // the cwd's link (mirrors the deployment-metadata write): no `linked` signal, no `.noodle/project.json`.
    expect(envelope.data.linked).toBeUndefined();
    expect(readProjectLink(projectCwd)).toBeUndefined();
  });

  it('prints the exact bound owner without implying the deploy actor owns access', async () => {
    writeConfig({ serviceUrl: service.url, authToken: 'admin-token', defaultOrg: 'acme' }, home);

    expect(
      await run(
        [
          'deploy',
          HELLO,
          '--org',
          'acme',
          '--app',
          'owner-output',
          '--version',
          '1',
          '--owner-subject',
          'oauth-human',
        ],
        {},
        home,
      ),
    ).toBe(0);
    expect(stdout()).toContain('Access:    owner-only — only the bound owner can connect.');
    expect(stdout()).toContain('Owner:     oauth-human');
    expect(stdout()).not.toContain('admin-token');
  });

  it('prints runnable Compose operations without advertising a Core dashboard', async () => {
    writeConfig({ serviceUrl: service.url, authToken: 'admin-token', defaultOrg: 'local' }, home);

    expect(
      await run(
        [
          'deploy',
          HELLO,
          '--org',
          'local',
          '--app',
          'core-output',
          '--version',
          '1',
          '--access',
          'public',
        ],
        { NOODLE_SELF_HOST_ADMIN_TOKEN: 'self-host-secret' },
        home,
      ),
    ).toBe(0);

    expect(stdout()).toContain('Console:   not included in Noodle Core.');
    expect(stdout()).toContain('Verified:  deployment readiness passed.');
    expect(stdout()).toContain('Next:      docker compose logs --follow noodle');
    expect(stdout()).toContain(
      'Next:      docker compose run --build --rm cli smoke --org local --app core-output --env prod',
    );
    expect(stdout()).toContain(
      `Next:      npx @noodleseed/one@latest connect claude-code --endpoint ${service.url}/o/local/core-output/v1/mcp`,
    );
    expect(stdout()).not.toContain('Dashboard:');
    expect(stdout()).not.toContain('hosted readiness');
    expect(stdout()).not.toContain('self-host-secret');
  });

  it('keeps a customers deploy successful and reports failed OAuth readiness in JSON', async () => {
    const issuer = 'https://id.example.com';
    const serverPath = writeCustomerAuthServer(issuer);
    const fetchSpy = stubReadinessFetch(
      issuer,
      new Response('', {
        status: 307,
        headers: { location: '/login?returnTo=%2F.well-known%2Foauth-authorization-server' },
      }),
    );
    writeConfig({ serviceUrl: service.url, authToken: 'admin-token', defaultOrg: 'acme' }, home);

    const code = await run(
      [
        'deploy',
        serverPath,
        '--org',
        'acme',
        '--app',
        'customer-app',
        '--access',
        'customers',
        '--version',
        '1',
        '--json',
      ],
      {},
      home,
    );

    expect(code).toBe(0);
    const envelope = assertJsonEnvelope<{
      authReadiness: {
        ready: boolean;
        checks: Array<{ code: string; level: string; issuer?: string; fix?: string }>;
      };
    }>(JSON.parse(stdout()));
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) throw new Error('expected a success envelope');
    expect(envelope.data.authReadiness.ready).toBe(false);
    expect(envelope.data.authReadiness.checks).toContainEqual(
      expect.objectContaining({
        code: 'oauth_metadata_discovery',
        level: 'FAIL',
        issuer,
      }),
    );
    expect(fetchSpy.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(true);
    expect(
      fetchSpy.mock.calls
        .filter((call) => String(call[0]).startsWith(issuer))
        .every((call) => call[1]?.method === undefined),
    ).toBe(true);
  });

  it('groups nonblocking customer OAuth warnings by issuer in human output', async () => {
    const issuer = 'https://human-output.id.example.com';
    const serverPath = writeCustomerAuthServer(issuer);
    stubReadinessFetch(issuer, new Response('missing', { status: 404 }));
    writeConfig({ serviceUrl: service.url, authToken: 'admin-token', defaultOrg: 'acme' }, home);

    const code = await run(
      [
        'deploy',
        serverPath,
        '--org',
        'acme',
        '--app',
        'customer-app-human',
        '--access',
        'customers',
        '--version',
        '1',
      ],
      {},
      home,
    );

    expect(code).toBe(0);
    expect(stdout()).toContain('OAuth readiness warning');
    expect(stdout()).toContain(issuer);
    expect(stdout()).toContain('oauth_metadata_discovery');
    expect(stdout()).toContain('Deploy succeeded');
  });

  it('persists the resolved deploy target to .noodle/project.json on an in-project deploy', async () => {
    writeConfig({ serviceUrl: service.url, authToken: 'admin-token', defaultOrg: 'acme' }, home);
    // Scaffold a real project in the cwd, then deploy it (no explicit path) — the first hosted deploy must
    // remember its target so a later `noodle deploy` reuses it without the user ever running `noodle link`.
    expect(
      await run(
        ['init', '--no-install', '.', '--name', 'linky', '--template', 'hello', '--no-agents'],
        {},
        home,
      ),
    ).toBe(0);
    expect(readProjectLink(projectCwd)).toBeUndefined();
    logSpy.mockClear(); // drop init's plain output so stdout() is just the deploy envelope
    const code = await run(
      ['deploy', '--org', 'acme', '--app', 'linky', '--version', '1', '--json'],
      {},
      home,
    );
    expect(code).toBe(0);
    const envelope = assertJsonEnvelope<{
      linked?: boolean;
      target?: { org: string; app: string; env: string };
    }>(JSON.parse(stdout()));
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) throw new Error('expected a success envelope');
    // Agent-visible signal + durable link file both reflect the persisted target.
    expect(envelope.data.linked).toBe(true);
    expect(envelope.data.target).toEqual({ org: 'acme', app: 'linky', env: 'prod' });
    const link = readProjectLink(projectCwd);
    expect(link).toBeDefined();
    expect(link?.org).toBe('acme');
    expect(link?.app).toBe('linky');
    expect(link?.env).toBe('prod');
    expect(link?.serviceUrl).toBe(service.url);
  });

  it('uses the nearest parent project target when deploy runs from a nested package', async () => {
    writeConfig({ serviceUrl: service.url, authToken: 'admin-token' }, home);
    const nestedCwd = writeNestedProject(HELLO);

    expect(
      await run(['deploy', '../../src/server.ts', '--version', '1', '--no-prompt'], {}, home),
    ).toBe(0);
    expect(stdout()).toContain('Deployed to acme/facts/staging');
    expect(existsSync(join(projectCwd, '.noodle', 'deployment.json'))).toBe(true);
    expect(existsSync(join(nestedCwd, '.noodle', 'deployment.json'))).toBe(false);
  });

  it('does not apply or persist a parent project target for a different explicit entrypoint', async () => {
    writeConfig({ serviceUrl: service.url, authToken: 'admin-token' }, home);
    const nestedCwd = writeNestedProject(HELLO);

    expect(
      await run(
        ['deploy', HELLO, '--org', 'local', '--app', 'other', '--version', '1', '--no-prompt'],
        {},
        home,
      ),
    ).toBe(0);
    expect(stdout()).toContain('Deployed to local/other/prod');
    expect(existsSync(join(projectCwd, '.noodle', 'project.json'))).toBe(false);
    expect(existsSync(join(projectCwd, '.noodle', 'deployment.json'))).toBe(false);
    expect(existsSync(join(nestedCwd, '.noodle'))).toBe(false);
  });

  it('fails with a repairable missing_target envelope when authenticated to a HOSTED service but no org resolves (exit 2)', async () => {
    // Signed in to a HOSTED service (token present) but no --org, no project link, and no default org:
    // the deploy must not silently target a bogus `local` org — it fails closed with a repairable
    // envelope, exit USAGE. A non-loopback `.invalid` host makes this hosted (not a local loopback,
    // where the implicit `local` org is correct) and fast-fails the default-org lookup via DNS.
    writeConfig({ serviceUrl: 'https://noodle-hosted.invalid', authToken: 'admin-token' }, home);
    const code = await run(
      ['deploy', HELLO, '--app', 'hello', '--version', '1', '--json'],
      {},
      home,
    );
    expect(code).toBe(2); // EXIT.USAGE
    const envelope = assertJsonEnvelope(JSON.parse(stdout()));
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected a failure envelope');
    expect(envelope.error.code).toBe('missing_target');
    expect(envelope.error.next).toContain('noodle link');
    expect(envelope.error.next).toContain('--app hello'); // inferred app name in the repair hint
    // No target resolved → nothing persisted.
    expect(readProjectLink(projectCwd)).toBeUndefined();
  });

  it('deploys to the implicit local org on a loopback control plane when no org resolves', async () => {
    // A `noodle dev`/e2e/test control plane is loopback: an org-less deploy must keep working (targeting
    // the implicit `local` org), NOT hit the hosted-only missing_target guard. This is the offline path
    // the localhost e2e relies on — regressing it fails ~15 e2e deploy assertions.
    writeConfig({ serviceUrl: service.url, authToken: 'admin-token' }, home);
    const code = await run(
      ['deploy', HELLO, '--app', 'hello', '--version', '1', '--json'],
      {},
      home,
    );
    expect(code).toBe(0);
    const envelope = assertJsonEnvelope(JSON.parse(stdout()));
    expect(envelope.ok).toBe(true);
  });

  it('classifies loopback vs hosted control-plane URLs', () => {
    for (const local of [
      'http://127.0.0.1:8787',
      'http://localhost:3000',
      'https://LOCALHOST/',
      'http://[::1]:9000',
      'http://0.0.0.0:8080',
    ]) {
      expect(isLocalServiceUrl(local)).toBe(true);
    }
    for (const hosted of [
      'https://cloud.noodleseed.dev',
      'https://noodle-hosted.invalid',
      'http://192.168.1.10:8787', // LAN, not loopback
      'not-a-url',
    ]) {
      expect(isLocalServiceUrl(hosted)).toBe(false);
    }
  });

  it('stays on the auth/401 path (not missing_target) when not logged in', async () => {
    // Not-logged-in (no token): the missing-target guard is intentionally skipped so this keeps returning
    // the auth envelope with `next: noodle login`, exit AUTH — never `missing_target`.
    writeConfig({ serviceUrl: service.url }, home);
    const code = await run(
      ['deploy', HELLO, '--app', 'hello', '--version', '1', '--json'],
      {},
      home,
    );
    expect(code).toBe(3); // EXIT.AUTH
    const envelope = assertJsonEnvelope(JSON.parse(stdout()));
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected a failure envelope');
    expect(envelope.error.code).toBe('deploy_failed');
    expect(envelope.error.code).not.toBe('missing_target');
    expect(envelope.error.next).toContain('noodle login');
    expect(readProjectLink(projectCwd)).toBeUndefined();
  });

  it('leads with the auth error, not missing_server_version, with no version and not signed in (hosted)', async () => {
    // deploy-ops resolves auth/target BEFORE hard-failing on a missing server version, so an
    // unauthenticated hosted deploy with no version surfaces the actionable auth error (next: noodle
    // login), not a premature missing_server_version. A non-loopback `.invalid` host makes this hosted.
    writeConfig({ serviceUrl: 'https://noodle-hosted.invalid' }, home);
    const code = await run(['deploy', HELLO, '--app', 'hello', '--json', '--no-prompt'], {}, home);
    expect(code).toBe(3); // EXIT.AUTH — not exit 2 (missing_server_version)
    const envelope = assertJsonEnvelope(JSON.parse(stdout()));
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected a failure envelope');
    expect(envelope.error.code).not.toBe('missing_server_version');
    expect(envelope.error.next).toContain('noodle login');
    expect(readProjectLink(projectCwd)).toBeUndefined();
  });

  it('emits a uniform failure envelope on an auth error (exit 3, on stdout)', async () => {
    writeConfig({ serviceUrl: service.url, authToken: 'wrong-token', defaultOrg: 'acme' }, home);
    const code = await run(
      ['deploy', HELLO, '--org', 'acme', '--app', 'hello', '--version', '1', '--json'],
      {},
      home,
    );
    expect(code).toBe(3); // EXIT.AUTH — preserved
    const envelope = assertJsonEnvelope(JSON.parse(stdout()));
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected a failure envelope');
    expect(envelope.error.code).toBe('deploy_failed');
    expect(typeof envelope.error.message).toBe('string');
    // Non-standard deploy specifics are folded under `detail`, not the top-level error.
    expect((envelope.error.detail as { status?: number }).status).toBe(401);
  });

  it('reports a missing managed secret as a failure envelope and never prompts in a non-TTY', async () => {
    writeConfig({ serviceUrl: service.url, authToken: 'admin-token', defaultOrg: 'acme' }, home);
    // A `--json` deploy in a non-TTY must fail closed rather than block on the secret prompt; a hang
    // here would exceed the test timeout instead of resolving with an envelope.
    const code = await run(
      ['deploy', API_KEY_SERVER, '--org', 'acme', '--app', 'facts', '--version', '1', '--json'],
      {},
      home,
    );
    expect(code).toBe(1); // EXIT.FAILURE — a missing-secret is a config/domain failure
    const envelope = assertJsonEnvelope(JSON.parse(stdout()));
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected a failure envelope');
    expect(envelope.error.code).toBe('missing_secret');
    expect(envelope.error.message).toContain('API_NINJAS_KEY');
    // The bespoke shape used to omit `fix`; the uniform envelope carries both `fix` and `next`.
    expect(typeof envelope.error.fix).toBe('string');
    expect(envelope.error.next).toContain('noodle secrets set');
  });

  it('reports the nearest parent project target when a nested deploy is missing a secret', async () => {
    writeConfig({ serviceUrl: service.url, authToken: 'admin-token' }, home);
    writeNestedProject(API_KEY_SERVER, 'local');

    const code = await run(['deploy', '../../src/server.ts', '--version', '1', '--json'], {}, home);
    expect(code).toBe(1);
    const envelope = assertJsonEnvelope(JSON.parse(stdout()));
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected a failure envelope');
    expect(envelope.error.code).toBe('missing_secret');
    expect(envelope.error.next).toContain('--org acme --app facts --env staging');
  });
});
