import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  InMemoryAssetStore,
  InMemoryControlPlaneStore,
  type RunningService,
  serveService,
} from '@noodle-borg/service';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendServer, deploy, run, writeConfig, writeProjectDeployment } from '../src/index.js';
import { parseDeployRequestJson } from './deploy-request-test-helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, '..', '..', '..', 'examples');
const helloManifest = join(examples, 'hello', 'src', 'server.ts');
const postsConnectors = join(here, 'fixtures', 'posts', 'connectors.yaml');

let service: RunningService;

async function controlPlaneWithOrgs(
  ...orgs: readonly string[]
): Promise<InMemoryControlPlaneStore> {
  const controlPlane = new InMemoryControlPlaneStore();
  await Promise.all(orgs.map((slug) => controlPlane.createOrg({ slug })));
  return controlPlane;
}

beforeAll(async () => {
  service = await serveService({
    port: 0,
    controlPlaneStore: await controlPlaneWithOrgs('local'),
    deployGate: {
      authorize: () =>
        Promise.resolve({
          ok: true,
          identity: { subject: 'owner-sub', email: 'owner@noodleseed.com', superAdmin: true },
        }),
    },
    verifyOwnerToken: (token) =>
      Promise.resolve(token === 'OWNER' ? { caller: { subject: 'owner-sub' } } : null),
    authServerIssuer: 'https://as.noodle.test',
    assetStore: new InMemoryAssetStore(),
  });
});

afterAll(async () => {
  await service.close();
});

describe('noodle deploy', () => {
  it('deploys a TypeScript-authored server and returns a working endpoint', async () => {
    const outcome = await deploy({ manifestPath: helloManifest, serviceUrl: service.url });
    expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.deploymentId).toMatch(/^hello-[0-9a-f]{8}$/);
    expect(outcome.serverVersion).toBe('1');
    expect(outcome.url).toBe(`${service.url}/o/local/server/v1/mcp`);
    expect(outcome.defaultUrl).toBe(`${service.url}/o/local/server/mcp`);
    expect(outcome.accessMode).toBe('owner-only');

    // the returned endpoint actually serves MCP with an owner identity token
    const res = await fetch(outcome.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer OWNER',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25' },
      }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects YAML app inputs before deploy', async () => {
    const broken = join(tmpdir(), `noodle-broken-${process.pid}.yaml`);
    writeFileSync(
      broken,
      'manifestVersion: "1"\nserver:\n  name: x\n  version: 1.0.0\ntools: []\n',
    );
    const outcome = await deploy({ manifestPath: broken, serviceUrl: service.url });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(0);
    expect(outcome.message).toContain('public app authoring uses TypeScript');
  });

  it('fails clearly when the service is unreachable', async () => {
    const outcome = await deploy({
      manifestPath: helloManifest,
      serviceUrl: 'http://127.0.0.1:1',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(0);
    expect(outcome.message).toMatch(/could not reach/);
  });

  it('treats malformed successful deploy responses as failures', async () => {
    const outcome = await deploy({
      manifestPath: helloManifest,
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: true, deploymentId: 123, url: false }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(201);
    expect(outcome.message).toBe(
      'deploy succeeded but the service response did not match the v1 wire contract',
    );
  });

  it('fails clearly when the server entrypoint is missing', async () => {
    const outcome = await deploy({
      manifestPath: join(tmpdir(), 'does-not-exist.ts'),
      serviceUrl: service.url,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toMatch(/cannot read input file/);
  });

  it('deploys a TypeScript-authored server definition with a connector catalog', async () => {
    const authored = join(tmpdir(), `noodle-posts-${process.pid}.ts`);
    writeFileSync(
      authored,
      `
import { connector, server, tool, z } from '@noodleseed/one';

const posts = connector('jsonplaceholder')
  .version('1.0.0')
  .operation('get_post', {
    type: 'read',
    input: z.object({ post_id: z.string() }),
    output: z.object({ title: z.string().optional(), body: z.string().optional() }),
  });

export default server('posts_ts', { title: 'Posts TS', version: '1.0.0', use: { posts } }, [
  tool('get_post', {
    description: 'Fetch a post by its ID from the public JSONPlaceholder API.',
    input: z.object({ post_id: z.string() }),
    fulfil({ input, connectors }) {
      const post = connectors.posts.getPost({ post_id: input.post_id });
      return { title: post.title, body: post.body };
    },
  }),
]);
`,
    );

    const outcome = await deploy({
      manifestPath: authored,
      connectorsPath: postsConnectors,
      serviceUrl: service.url,
    });

    expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.deploymentId).toMatch(/^posts-ts-[0-9a-f]{8}$/);
  }, 30_000);

  it('deploys a JavaScript-authored server definition', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), `noodle-posts-${process.pid}-`));
    const authored = join(tempDir, 'server.mjs');
    writeFileSync(
      authored,
      `
import { connector, server, tool, z } from '@noodleseed/one';

const posts = connector('jsonplaceholder')
  .version('1.0.0')
  .operation('get_post', {
    type: 'read',
    input: z.object({ post_id: z.string() }),
    output: z.object({ title: z.string().optional(), body: z.string().optional() }),
  });

export default server('posts_js', { title: 'Posts JS', version: '1.0.0', use: { posts } }, [
  tool('get_post', {
    description: 'Fetch a post by its ID from the public JSONPlaceholder API.',
    input: z.object({ post_id: z.string() }),
    fulfil({ input, connectors }) {
      const post = connectors.posts.getPost({ post_id: input.post_id });
      return { title: post.title, body: post.body };
    },
  }),
]);
`,
    );

    const outcome = await deploy({
      manifestPath: authored,
      connectorsPath: postsConnectors,
      serviceUrl: service.url,
    });

    expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.deploymentId).toMatch(/^posts-js-[0-9a-f]{8}$/);
  });

  it('rejects raw manifest objects exported from JavaScript modules', async () => {
    const authored = join(tmpdir(), `noodle-raw-${process.pid}.mjs`);
    writeFileSync(
      authored,
      `
export default {
  manifestVersion: '1',
  server: { name: 'raw_js', version: '1.0.0', title: 'Raw JS' },
  tools: [{
    name: 'greet',
    description: 'Greet someone.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    fulfilment: {
      steps: [{ id: 'shape', map: { message: 'Hello, \${input.name}!' } }],
      output: { message: '\${steps.shape.message}' },
    },
  }],
};
`,
    );

    const outcome = await deploy({ manifestPath: authored, serviceUrl: service.url });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('authoring module must export a Noodle server definition');
  });

  it('reports a clear error for an authoring module with no usable export', async () => {
    const authored = join(tmpdir(), `noodle-bad-export-${process.pid}.mjs`);
    writeFileSync(authored, 'export default 42;\n');

    const outcome = await deploy({ manifestPath: authored, serviceUrl: service.url });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(0);
    expect(outcome.message).toMatch(/authoring module must export/);
  });

  it('reports module-load failures while reading TypeScript-authored servers', async () => {
    const authored = join(tmpdir(), `noodle-throws-${process.pid}.ts`);
    writeFileSync(authored, 'throw new Error("authoring exploded");\nexport default {};\n');

    const outcome = await deploy({ manifestPath: authored, serviceUrl: service.url });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(0);
    expect(outcome.message).toMatch(/authoring exploded/);
  }, 30_000);
});

describe('noodle deploy — managed config', () => {
  /** A fetch stub that captures the deploy request body and returns a canned success response. */
  function capturingFetch(): {
    fetchImpl: typeof fetch;
    sent(): Record<string, unknown>;
    url(): string;
  } {
    let body: Record<string, unknown> = {};
    let requestUrl = '';
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      requestUrl = url;
      body = parseDeployRequestJson(init);
      return new Response(
        JSON.stringify({
          ok: true,
          org: 'local',
          app: 'manifest',
          env: 'prod',
          deploymentId: 'hello-12345678',
          serverVersion: '1',
          url: 'http://x/o/local/manifest/v1/mcp',
          defaultUrl: 'http://x/o/local/manifest/mcp',
          accessMode: 'owner-only',
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    return { fetchImpl, sent: () => body, url: () => requestUrl };
  }

  it('never sends deploy-body secrets', async () => {
    const cap = capturingFetch();
    await deploy({ manifestPath: helloManifest, fetchImpl: cap.fetchImpl });
    expect(cap.sent().secrets).toBeUndefined();
  });

  it('sends the canonical server version in the deploy body', async () => {
    const cap = capturingFetch();
    await deploy({
      manifestPath: helloManifest,
      serverVersion: 'v2_0_6',
      fetchImpl: cap.fetchImpl,
    });
    expect(cap.sent().serverVersion).toBe('2.0.6');
  });

  it('identifies CLI deploy requests as cli source metadata', async () => {
    const cap = capturingFetch();
    await deploy({ manifestPath: helloManifest, fetchImpl: cap.fetchImpl });
    expect(cap.sent().deploymentSource).toBe('cli');
  });

  it('defaults deploys to Noodle Seed Cloud when no service override is supplied', async () => {
    const cap = capturingFetch();
    await deploy({ manifestPath: helloManifest, fetchImpl: cap.fetchImpl });
    expect(cap.url()).toBe(
      'https://cloud.noodleseed.dev/v1/orgs/local/apps/server/envs/prod/deploy',
    );
  });

  it('rejects the removed --secrets flag in the CLI', async () => {
    const code = await run(['deploy', helloManifest, '--secrets', 'secrets.json']);
    expect(code).toBe(2);
  });

  it('fails non-interactive deploys when no version is provided or inferred', async () => {
    // A loopback control plane needs no account, so auth/target resolution passes and the deploy reaches
    // the server-version check — with no version and --no-prompt it fails with missing_server_version
    // (exit 2). An isolated home + loopback service keeps this hermetic (no real ~/.noodle token).
    const home = mkdtempSync(join(tmpdir(), 'noodle-cli-noversion-'));
    try {
      writeConfig({ serviceUrl: 'http://127.0.0.1:9' }, home);
      const code = await run(['deploy', helloManifest, '--no-prompt'], {}, home);
      expect(code).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('manages local .env.noodle secrets and variables through the CLI', async () => {
    const cwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'noodle-cli-config-'));
    writeFileSync(join(dir, 'noodle.json'), JSON.stringify({ name: 'local-config-test' }));
    process.chdir(dir);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const home = mkdtempSync(join(tmpdir(), 'noodle-cli-home-'));
      expect(
        await run(
          [
            'target',
            'set',
            '--runtime',
            'local',
            '--org',
            'acme',
            '--app',
            'support',
            '--env',
            'prod',
          ],
          {},
          home,
        ),
      ).toBe(0);
      expect(
        await run(['secrets', 'set', 'TOKEN', '--scope', 'org', '--value', 'org-token'], {}, home),
      ).toBe(0);
      expect(
        await run(['secrets', 'set', 'TOKEN', '--scope', 'env', '--value', 'env-token'], {}, home),
      ).toBe(0);
      expect(
        await run(['variables', 'set', 'REGION', '--scope', 'env', '--value', 'us'], {}, home),
      ).toBe(0);
      expect(await run(['secrets', 'list', '--scope', 'env'], {}, home)).toBe(0);
      const text = readFileSync(join(dir, '.env.noodle'), 'utf8');
      expect(text).toContain('secret org/local TOKEN=org-token');
      expect(text).toContain('secret org/local/app/local-config-test/env/dev TOKEN=env-token');
      expect(text).toContain('var org/local/app/local-config-test/env/dev REGION=us');
      const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(printed).toContain('runtime: local');
      expect(printed).toContain('scope:   org/local/app/local-config-test/env/dev');
    } finally {
      logSpy.mockRestore();
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints cloud target details and sends bearer auth for hosted config commands', async () => {
    const home = mkdtempSync(join(tmpdir(), 'noodle-cli-home-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const requests: Array<{ url: string; authorization?: string; body?: string }> = [];
    vi.stubGlobal('fetch', (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: input.toString(),
        authorization: headers.get('authorization') ?? undefined,
        body: init?.body?.toString(),
      });
      return Response.json({ ok: true, value: { name: 'TOKEN' } });
    }) as typeof fetch);
    try {
      writeConfig({ authToken: 'cloud-secret-token', serviceUrl: 'https://svc.example' }, home);
      expect(
        await run(
          [
            'secrets',
            'set',
            'TOKEN',
            '--runtime',
            'cloud',
            '--scope',
            'env',
            '--org',
            'acme',
            '--app',
            'support',
            '--env',
            'prod',
            '--value',
            'secret-value',
          ],
          {},
          home,
        ),
      ).toBe(0);
      expect(requests).toEqual([
        expect.objectContaining({
          url: 'https://svc.example/v1/orgs/acme/apps/support/envs/prod/secrets/TOKEN',
          authorization: 'Bearer cloud-secret-token',
          body: JSON.stringify({ value: 'secret-value' }),
        }),
      ]);
      const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(printed).toContain('runtime: cloud');
      expect(printed).toContain('service: https://svc.example');
      expect(printed).toContain('scope:   org/acme/app/support/env/prod');
      expect(printed).not.toContain('cloud-secret-token');
      expect(printed).not.toContain('secret-value');
    } finally {
      vi.unstubAllGlobals();
      logSpy.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('fails cloud config commands without a login token before calling the service', async () => {
    const home = mkdtempSync(join(tmpdir(), 'noodle-cli-home-'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      expect(
        await run(
          [
            'variables',
            'list',
            '--runtime',
            'cloud',
            '--scope',
            'env',
            '--org',
            'acme',
            '--app',
            'support',
            '--env',
            'prod',
          ],
          {},
          home,
        ),
      ).toBe(1);
      expect(fetchSpy).not.toHaveBeenCalled();
      const printed = errSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(printed).toContain('Cause: No control-plane login token is available.');
      expect(printed).toContain('Next: noodle login');
    } finally {
      vi.unstubAllGlobals();
      errSpy.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('uses NOODLE_AUTH_TOKEN for hosted config commands without printing it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'noodle-cli-home-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let authorization: string | undefined;
    vi.stubGlobal('fetch', (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      authorization = new Headers(init?.headers).get('authorization') ?? undefined;
      return Response.json({ ok: true, values: [] });
    }) as typeof fetch);
    try {
      expect(
        await run(
          [
            'variables',
            'list',
            '--runtime',
            'cloud',
            '--service',
            'https://svc.example',
            '--scope',
            'env',
            '--org',
            'acme',
            '--app',
            'support',
            '--env',
            'prod',
          ],
          { NOODLE_AUTH_TOKEN: 'env-secret-token' },
          home,
        ),
      ).toBe(0);
      expect(authorization).toBe('Bearer env-secret-token');
      expect(logSpy.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain(
        'env-secret-token',
      );
    } finally {
      vi.unstubAllGlobals();
      logSpy.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('noodle deploy — access mode (OA-1/OA-3)', () => {
  /** A fetch stub that captures the request body and returns an identity-mode keyless deploy response. */
  function identityFetch(accessMode: 'owner-only' | 'org-members' | 'customers'): {
    fetchImpl: typeof fetch;
    sent(): Record<string, unknown>;
  } {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = parseDeployRequestJson(init);
      return new Response(
        JSON.stringify({
          ok: true,
          org: 'local',
          app: 'manifest',
          env: 'prod',
          deploymentId: 'hello-12345678',
          serverVersion: '1',
          url: 'http://x/o/local/manifest/v1/mcp',
          defaultUrl: 'http://x/o/local/manifest/mcp',
          accessMode,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    return { fetchImpl, sent: () => body };
  }

  it('sends accessMode owner-only and returns no caller key when --private', async () => {
    const cap = identityFetch('owner-only');
    const outcome = await deploy({
      manifestPath: helloManifest,
      accessMode: 'owner-only',
      fetchImpl: cap.fetchImpl,
    });
    expect(cap.sent().accessMode).toBe('owner-only');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.accessMode).toBe('owner-only');
    expect(outcome.callerKey).toBeUndefined();
  });

  it('sends and preserves accessMode org-members', async () => {
    const cap = identityFetch('org-members');
    const outcome = await deploy({
      manifestPath: helloManifest,
      accessMode: 'org-members',
      fetchImpl: cap.fetchImpl,
    });
    expect(cap.sent().accessMode).toBe('org-members');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.accessMode).toBe('org-members');
    expect(outcome.callerKey).toBeUndefined();
  });

  it('sends and preserves accessMode customers', async () => {
    const cap = identityFetch('customers');
    // customers requires server.auth (preflighted locally since roadmap S4), so this mode
    // deploys the customer-auth fixture rather than the auth-less hello manifest.
    const outcome = await deploy({
      manifestPath: join(here, 'fixtures', 'embedded-assistant-auth', 'server.ts'),
      accessMode: 'customers',
      fetchImpl: cap.fetchImpl,
    });
    expect(cap.sent().accessMode).toBe('customers');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.accessMode).toBe('customers');
    expect(outcome.callerKey).toBeUndefined();
  });

  it('sends owner-only as the default access mode', async () => {
    const cap = identityFetch('owner-only');
    await deploy({ manifestPath: helloManifest, fetchImpl: cap.fetchImpl });
    expect(cap.sent().accessMode).toBe('owner-only');
  });

  it('rejects removed caller-key access in the CLI', async () => {
    const testHome = mkdtempSync(join(tmpdir(), 'noodle-cli-home-'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await run(['deploy', helloManifest, '--access', 'caller-key'], {}, testHome)).toBe(2);
      expect(err.mock.calls.join('\n')).toContain('caller-key access has been removed');
    } finally {
      err.mockRestore();
      rmSync(testHome, { recursive: true, force: true });
    }
  });
});

describe('noodle deploy auth', () => {
  it('identity deploys fail closed when a service cannot establish deployer identity', async () => {
    const open = await serveService({ port: 0 });
    try {
      const outcome = await deploy({ manifestPath: helloManifest, serviceUrl: open.url });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.status).toBe(401);
      expect(outcome.message).toContain('owner-only deployments require an authenticated deployer');
    } finally {
      await open.close();
    }
  });

  it('surfaces hosted control-plane 401s with auth-token guidance', async () => {
    const outcome = await deploy({
      manifestPath: helloManifest,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toMatch(/unauthorized.*NOODLE_AUTH_TOKEN/);
  });
});

describe('noodle CLI diagnostics and doctor', () => {
  let home: string;
  let dir: string;
  let cwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  const secretServer = `
import { connector, server, tool, z } from '@noodleseed/one';

const httpbin = connector('httpbin').version('1.0.0').http({
  baseUrl: 'https://api.example.com',
  allowedOrigins: ['https://api.example.com'],
  auth: { kind: 'bearer', secret: 'API_TOKEN' },
  operations: {
    whoami: {
      type: 'read',
      method: 'GET',
      path: '/bearer',
      output: z.object({ ok: z.boolean().optional() }),
      response: { ok: true },
    },
  },
});

export default server('secret_app', { title: 'Secret App', version: '1.0.0', use: { httpbin } }, [
  tool('whoami', {
    description: 'Echo auth.',
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    fulfil: ({ connectors }) => {
      const result = connectors.httpbin.whoami({});
      return { ok: result.ok };
    },
  }),
]);
`;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'noodle-cli-doctor-home-'));
    dir = mkdtempSync(join(tmpdir(), 'noodle-cli-doctor-'));
    cwd = process.cwd();
    process.chdir(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(cwd);
    logSpy.mockRestore();
    errSpy.mockRestore();
    vi.unstubAllGlobals();
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSecretProject(): void {
    writeFileSync(join(dir, 'server.ts'), secretServer);
  }

  it('formats deploy missing-secret failures with exact remediation and no secret material', async () => {
    const open = await serveService({
      port: 0,
      controlPlaneStore: await controlPlaneWithOrgs('acme'),
      deployGate: {
        authorize: () =>
          Promise.resolve({
            ok: true,
            identity: { subject: 'owner-sub', email: 'owner@noodleseed.com', superAdmin: true },
          }),
      },
      verifyOwnerToken: (token) =>
        Promise.resolve(token === 'OWNER' ? { caller: { subject: 'owner-sub' } } : null),
      authServerIssuer: 'https://as.noodle.test',
    });
    try {
      writeSecretProject();
      expect(
        await run(
          [
            'deploy',
            'server.ts',
            '--service',
            open.url,
            '--org',
            'acme',
            '--app',
            'secret-app',
            '--env',
            'prod',
            '--version',
            '1',
          ],
          {},
          home,
        ),
      ).toBe(1);
      const printed = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).toContain('Cause: Missing required managed secret(s): API_TOKEN');
      expect(printed).toContain('Fix: Set the missing secret(s) at the environment scope.');
      expect(printed).toContain(
        'Next: noodle secrets set API_TOKEN --runtime cloud --scope env --org acme --app secret-app --env prod --from-env API_TOKEN',
      );
      expect(printed).not.toContain('supersecrettoken');
      expect(printed).not.toContain('"errors"');
    } finally {
      await open.close();
    }
  });

  it('keeps non-secret compile errors structured', async () => {
    const broken = join(dir, 'broken.yaml');
    writeFileSync(broken, 'manifestVersion: "1"\nserver: {}\ntools: []\n');
    expect(await run(['validate', broken], {}, home)).toBe(1);
    const printed = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('error(s) [read]');
    expect(printed).toContain('public app authoring uses TypeScript');
  });

  it('reports unreachable service failures with cause, fix, and next command', async () => {
    expect(
      await run(
        ['whoami', '--service', 'http://127.0.0.1:1', '--auth-token', 'secret-token'],
        {},
        home,
      ),
    ).toBe(1);
    const whoami = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(whoami).toContain('Cause:');
    expect(whoami).toContain('Fix:');
    expect(whoami).toContain('Next:');
    expect(whoami).not.toContain('secret-token');
  });

  it('doctor exits 0 for a linked, logged-in, reachable, valid project', async () => {
    writeConfig(
      {
        serviceUrl: service.url,
        authToken: 'OWNER',
        identity: { subject: 'owner-sub', email: 'owner@noodleseed.com' },
      },
      home,
    );
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

    expect(await run(['doctor'], {}, home)).toBe(0);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // Checklist convention: aligned labels with dim details, summary line, Next pointer.
    expect(printed).toMatch(/Node\s+v\d/);
    expect(printed).toMatch(/CLI\s+\d/);
    expect(printed).toMatch(/Login\s+owner@noodleseed\.com/);
    expect(printed).toMatch(/Service\s+http/);
    expect(printed).toMatch(/Project link\s+\S/);
    expect(printed).toMatch(/Entrypoint\s+\S/);
    expect(printed).toMatch(/Validate\s+manifest compiles locally/);
    expect(printed).toMatch(/\d+ ok · \d+ warnings? · 0 failing/);
    expect(printed).toContain('Next: noodle dev');
  });

  it('doctor ignores stale global deployment metadata for linked projects with no project deployment', async () => {
    writeConfig(
      {
        serviceUrl: service.url,
        authToken: 'OWNER',
        identity: { subject: 'owner-sub', email: 'owner@noodleseed.com' },
      },
      home,
    );
    appendServer(
      {
        deploymentId: 'stale-global',
        url: 'https://borg.noodleseed.com/o/demo/hello/dev/mcp',
        createdAt: '2026-06-09T00:00:00.000Z',
      },
      home,
    );
    expect(await run(['init', '--no-install', dir, '--name', 'smoke', '--force'], {}, home)).toBe(
      0,
    );
    expect(
      await run(['link', '--org', 'acme', '--app', 'smoke', '--service', service.url], {}, home),
    ).toBe(0);
    logSpy.mockClear();

    expect(await run(['doctor'], {}, home)).toBe(0);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toMatch(/Endpoint health\s+no project deployment metadata/);
    expect(printed).toContain('Next: noodle dev');
    expect(printed).not.toContain('/o/demo/hello/dev/mcp');
  });

  it('doctor health-checks matching project deployment metadata', async () => {
    writeConfig(
      {
        serviceUrl: service.url,
        authToken: 'OWNER',
        identity: { subject: 'owner-sub', email: 'owner@noodleseed.com' },
      },
      home,
    );
    expect(await run(['init', '--no-install', dir, '--name', 'smoke', '--force'], {}, home)).toBe(
      0,
    );
    expect(
      await run(['link', '--org', 'acme', '--app', 'smoke', '--service', service.url], {}, home),
    ).toBe(0);
    writeProjectDeployment({
      deploymentId: 'project-deployment',
      url: `${service.url}/o/acme/smoke/mcp`,
      org: 'acme',
      app: 'smoke',
      env: 'prod',
      accessMode: 'owner-only',
      serviceUrl: service.url,
      createdAt: '2026-06-09T00:00:00.000Z',
    });
    logSpy.mockClear();

    expect(await run(['doctor'], {}, home)).toBe(0);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toMatch(/Endpoint health\s+http/);
    expect(printed).toContain(`${service.url}/o/acme/smoke/mcp`);
  });

  it('doctor warns when project deployment metadata does not match the current link', async () => {
    writeConfig(
      {
        serviceUrl: service.url,
        authToken: 'OWNER',
        identity: { subject: 'owner-sub', email: 'owner@noodleseed.com' },
      },
      home,
    );
    expect(await run(['init', '--no-install', dir, '--name', 'smoke', '--force'], {}, home)).toBe(
      0,
    );
    expect(
      await run(['link', '--org', 'acme', '--app', 'smoke', '--service', service.url], {}, home),
    ).toBe(0);
    writeProjectDeployment({
      deploymentId: 'old-project-deployment',
      url: `${service.url}/o/acme/old-app/mcp`,
      org: 'acme',
      app: 'old-app',
      env: 'prod',
      accessMode: 'owner-only',
      serviceUrl: service.url,
      createdAt: '2026-06-09T00:00:00.000Z',
    });
    logSpy.mockClear();

    expect(await run(['doctor'], {}, home)).toBe(0);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toMatch(/Endpoint health\s+stale project deployment metadata/);
    expect(printed).toContain(
      'Cause: Saved deployment metadata does not match the current project link.',
    );
    expect(printed).toContain('noodle deploy');
    expect(printed).not.toMatch(/Endpoint health\s+http/);
  });

  it('doctor reports missing login with recovery guidance', async () => {
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

    expect(await run(['doctor'], {}, home)).toBe(1);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // Failing checklist item: label + detail, indented Cause:/Fix:, the fix command beneath.
    expect(printed).toMatch(/Login\s+missing/);
    expect(printed).toContain('Cause: No saved Noodle login token or identity was found.');
    expect(printed).toMatch(/\n\s+Fix: Sign in to Noodle Seed Cloud/);
    expect(printed).toMatch(/\n\s+noodle login/);
    expect(printed).toMatch(/\d+ ok · \d+ warnings? · [1-9]\d* failing/);
    expect(printed).toContain('Next: noodle login');
  });

  it('doctor reports missing or corrupt project link with recovery guidance', async () => {
    writeConfig({ serviceUrl: service.url, authToken: 'OWNER' }, home);

    expect(await run(['doctor'], {}, home)).toBe(1);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toMatch(/Project link\s+missing/);
    expect(printed).toContain('Next: noodle init');
    expect(printed).toContain('noodle link');
  });

  it('doctor reports invalid manifests with validate guidance', async () => {
    writeConfig({ serviceUrl: service.url, authToken: 'OWNER' }, home);
    writeFileSync(join(dir, 'server.ts'), 'export default 42;\n');
    expect(
      await run(['link', '--org', 'acme', '--app', 'broken', '--service', service.url], {}, home),
    ).toBe(0);
    logSpy.mockClear();

    expect(await run(['doctor'], {}, home)).toBe(1);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toMatch(/Validate\s+\d+ error/);
    expect(printed).toContain('Next: noodle validate');
  });

  it('doctor reports missing required connector secrets without leaking values', async () => {
    writeConfig({ serviceUrl: service.url, authToken: 'OWNER' }, home);
    writeSecretProject();
    expect(
      await run(
        [
          'link',
          '--org',
          'acme',
          '--app',
          'secret-app',
          '--service',
          service.url,
          '--entrypoint',
          'server.ts',
        ],
        {},
        home,
      ),
    ).toBe(0);
    logSpy.mockClear();

    expect(await run(['doctor'], {}, home)).toBe(1);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toMatch(/Secrets\s+missing API_TOKEN/);
    expect(printed).toContain(
      'Next: noodle secrets set API_TOKEN --scope env --org acme --app secret-app',
    );
    expect(printed).not.toContain('tok-123');
  });

  it('doctor reports service reachability failures without throwing stack traces', async () => {
    writeConfig({ serviceUrl: 'http://127.0.0.1:1', authToken: 'OWNER' }, home);
    expect(
      await run(['init', '--no-install', dir, '--name', 'hello-world', '--force'], {}, home),
    ).toBe(0);
    expect(
      await run(
        ['link', '--org', 'acme', '--app', 'hello-world', '--service', 'http://127.0.0.1:1'],
        {},
        home,
      ),
    ).toBe(0);
    logSpy.mockClear();

    expect(await run(['doctor'], {}, home)).toBe(1);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toMatch(/Service\s+http:\/\/127\.0\.0\.1:1/);
    expect(printed).toContain('Next: noodle login --service http://127.0.0.1:1');
    expect(printed).not.toContain('Error:');
  });
});
