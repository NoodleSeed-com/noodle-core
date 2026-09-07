import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveBuildInfo } from '../src/build-info.js';
import {
  createServiceHandler,
  InMemoryConfigStore,
  ServerRegistry,
  serveService,
} from '../src/index.js';

const OWNER_TOKEN = 'OWNER';

const HELLO = `
manifestVersion: "1"
server:
  name: hello
  version: 1.0.0
  title: Hello
tools:
  - name: greet
    description: Greet someone.
    inputSchema:
      type: object
      properties:
        name:
          type: string
      required:
        - name
      additionalProperties: false
    fulfilment:
      steps:
        - id: build
          map:
            message: "Hello, \${input.name}!"
      output:
        message: \${steps.build.message}
`;

let http: Server;
let base: string;
let configStore: InMemoryConfigStore;

beforeEach(async () => {
  configStore = new InMemoryConfigStore();
  http = createServer(
    createServiceHandler(new ServerRegistry(undefined, undefined, configStore), {
      configStore,
      deployGate: {
        authorize: () =>
          Promise.resolve({
            ok: true,
            identity: { subject: 'owner-sub', email: 'owner@noodleseed.com', superAdmin: true },
          }),
      },
      verifyOwnerToken: (token) =>
        Promise.resolve(token === OWNER_TOKEN ? { caller: { subject: 'owner-sub' } } : null),
      authServerIssuer: 'https://as.noodle.test',
    }),
  );
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
});

function tenantDeployUrl(baseUrl: string, app = 'hello', env = 'prod'): string {
  return `${baseUrl}/v1/orgs/acme/apps/${app}/envs/${env}/deploy`;
}

describe('serveService bind safety', () => {
  it('refuses a non-loopback bind without deploy authentication (fail closed)', async () => {
    await expect(serveService({ host: '0.0.0.0', port: 0 })).rejects.toThrow(
      /non-loopback.*without deploy authentication/,
    );
  });

  it('builds a parsable IPv6 loopback URL before binding local Devtools credentials', async () => {
    const svc = await serveService({
      host: '::1',
      port: 0,
      localDevtoolsDirectFirebaseAuth: true,
    });
    try {
      expect(svc.url).toMatch(/^http:\/\/\[::1\]:\d+$/u);
      expect(new URL(svc.url).hostname).toBe('[::1]');
      expect(svc.localDevtoolsDelegatedCredentials).toBeDefined();
    } finally {
      await svc.close();
    }
  });

  it('requires authenticated identity for management config and deployment listing routes', async () => {
    const svc = await serveService({ port: 0 });
    try {
      const config = await fetch(`${svc.url}/v1/orgs/acme/apps/hello/envs/prod/secrets`);
      expect(config.status).toBe(401);

      const deployments = await fetch(`${svc.url}/v1/orgs/acme/deployments`);
      expect(deployments.status).toBe(401);
    } finally {
      await svc.close();
    }
  });

  it('rejects localhost identity deploys without deployer authentication', async () => {
    const svc = await serveService({ port: 0 });
    try {
      const res = await fetch(tenantDeployUrl(svc.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: HELLO }),
      });
      expect(res.status).toBe(401);
      expect(await res.text()).toContain(
        'owner-only deployments require an authenticated deployer',
      );
    } finally {
      await svc.close();
    }
  });

  it('bootstraps the account-free local organization for loopback public deploys', async () => {
    const svc = await serveService({ port: 0 });
    try {
      const res = await fetch(`${svc.url}/v1/orgs/local/apps/hello/envs/prod/deploy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: HELLO, accessMode: 'public' }),
      });
      expect(res.status).toBe(201);
    } finally {
      await svc.close();
    }
  });

  it('bootstraps the system local organization for authenticated loopback deploys', async () => {
    const svc = await serveService({
      port: 0,
      deployGate: {
        authorize: async () => ({
          ok: true,
          identity: {
            subject: 'local-admin',
            email: 'local-admin@noodleseed.com',
            superAdmin: true,
          },
        }),
      },
    });
    try {
      const res = await fetch(`${svc.url}/v1/orgs/local/apps/hello/envs/prod/deploy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: HELLO, accessMode: 'public' }),
      });
      expect(res.status).toBe(201);
    } finally {
      await svc.close();
    }
  });

  it('accepts Google control-plane auth as non-loopback deploy authentication', async () => {
    const svc = await serveService({
      host: '0.0.0.0',
      port: 0,
      googleClientId: 'client-id',
      controlPlaneAdmins: ['admin@noodleseed.com'],
      googleVerifier: {
        verify: async () => ({ subject: 'sub-admin', email: 'admin@noodleseed.com' }),
      },
    });
    await svc.close();
  });
});

describe('health probes (ADR 0034)', () => {
  async function listen(handler: ReturnType<typeof createServiceHandler>): Promise<{
    url: string;
    close: () => Promise<void>;
  }> {
    const srv = createServer(handler);
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const { port } = srv.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      close: () =>
        new Promise<void>((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve()))),
    };
  }

  it('GET /healthz → 200, un-gated (no deploy auth required)', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('ok');
  });

  it('GET /healthz is not 426 even under enforced HTTPS (Cloud Run probe is plain HTTP)', async () => {
    const srv = await listen(
      createServiceHandler(new ServerRegistry(), { tls: { trustProxy: true } }),
    );
    try {
      // A plain-HTTP management deploy would 426 under trustProxy; /healthz must bypass enforcement.
      expect((await fetch(tenantDeployUrl(srv.url), { method: 'POST' })).status).toBe(426);
      expect((await fetch(`${srv.url}/healthz`)).status).toBe(200);
    } finally {
      await srv.close();
    }
  });

  it('GET /readyz reflects the readiness probe (200 ready ↔ 503 unready)', async () => {
    let ready = true;
    const srv = await listen(
      createServiceHandler(new ServerRegistry(), { readinessProbe: async () => ready }),
    );
    try {
      expect((await fetch(`${srv.url}/readyz`)).status).toBe(200);
      ready = false;
      expect((await fetch(`${srv.url}/readyz`)).status).toBe(503);
    } finally {
      await srv.close();
    }
  });

  it('GET /readyz defaults to 200 when no probe is configured', async () => {
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
  });
});

describe('console route reservation', () => {
  it('reserves GET / for the future console even when no console handler is configured', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'console not configured' });
  });

  it('lets a console handler own / without swallowing reserved service paths', async () => {
    const consoleHits: string[] = [];
    const authHits: string[] = [];
    const srv = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      const server = createServer(
        createServiceHandler(new ServerRegistry(), {
          authServerIssuer: 'https://as.noodle.test',
          authServerApp: (req, res) => {
            authHits.push(req.url ?? '');
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ route: 'auth' }));
          },
          consoleHandler: (req, res) => {
            consoleHits.push(req.url ?? '');
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end('<main>Noodle Seed Cloud</main>');
          },
        }),
      );
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        resolve({
          url: `http://127.0.0.1:${port}`,
          close: () =>
            new Promise<void>((closeResolve, reject) =>
              server.close((error) => (error ? reject(error) : closeResolve())),
            ),
        });
      });
    });
    try {
      const root = await fetch(`${srv.url}/`);
      expect(root.status).toBe(200);
      expect(await root.text()).toContain('Noodle Seed Cloud');

      expect((await fetch(`${srv.url}/v1/service/capabilities`)).status).toBe(200);
      expect((await fetch(`${srv.url}/authorize`)).status).toBe(200);
      expect(
        (await fetch(`${srv.url}/.well-known/oauth-protected-resource/o/acme/app/mcp`)).status,
      ).toBe(200);
      expect((await fetch(`${srv.url}/o/acme/app/mcp`)).status).toBe(404);
      expect((await fetch(`${srv.url}/deploy`)).status).toBe(404);
      expect((await fetch(`${srv.url}/mcp`)).status).toBe(404);

      expect(consoleHits).toEqual(['/']);
      expect(authHits).toEqual(['/authorize']);
    } finally {
      await srv.close();
    }
  });
});

describe('deployed-version visibility (/v1/service/info)', () => {
  async function listenWith(
    options: Parameters<typeof createServiceHandler>[1],
  ): Promise<{ url: string; close: () => Promise<void> }> {
    const srv = createServer(createServiceHandler(new ServerRegistry(), options));
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const { port } = srv.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      close: () =>
        new Promise<void>((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve()))),
    };
  }

  it('resolveBuildInfo defaults to unknown/dev when env is unset', () => {
    expect(resolveBuildInfo({})).toEqual({
      version: 'dev',
      gitSha: 'unknown',
      buildTime: 'unknown',
    });
  });

  it('resolveBuildInfo reads NOODLE_BUILD_* from env', () => {
    expect(
      resolveBuildInfo({
        NOODLE_BUILD_VERSION: '1.2.3',
        NOODLE_BUILD_SHA: 'abc1234',
        NOODLE_BUILD_TIME: '2026-06-17T00:00:00Z',
      }),
    ).toEqual({ version: '1.2.3', gitSha: 'abc1234', buildTime: '2026-06-17T00:00:00Z' });
  });

  it('resolveBuildInfo includes compatibility-set identity only when promoted', () => {
    expect(
      resolveBuildInfo({
        NOODLE_SYSTEM_RELEASE: 'r142',
        NOODLE_RELEASE_MANIFEST_CHECKSUM: `sha256:${'a'.repeat(64)}`,
        NOODLE_PACKAGE_VERSIONS_B64: Buffer.from(
          JSON.stringify({ '@noodleseed/one': '0.34.0' }),
        ).toString('base64'),
        NOODLE_COMPATIBLE_PACKAGE_VERSIONS_B64: Buffer.from(
          JSON.stringify({ '@noodleseed/one': ['0.33.0', '0.34.0'] }),
        ).toString('base64'),
      }),
    ).toEqual({
      version: 'dev',
      gitSha: 'unknown',
      buildTime: 'unknown',
      systemRelease: 'r142',
      manifestChecksum: `sha256:${'a'.repeat(64)}`,
      packageVersions: { '@noodleseed/one': '0.34.0' },
      compatiblePackageVersions: { '@noodleseed/one': ['0.33.0', '0.34.0'] },
    });
  });

  it('GET /v1/service/info → 200 un-authed with only non-sensitive build fields', async () => {
    const srv = await listenWith({
      buildInfo: {
        version: '9.9.9',
        gitSha: 'deadbeef',
        buildTime: '2026-06-17T12:00:00Z',
        systemRelease: 'r142',
        manifestChecksum: `sha256:${'a'.repeat(64)}`,
        packageVersions: { '@noodleseed/one': '0.34.0' },
        compatiblePackageVersions: { '@noodleseed/one': ['0.33.0', '0.34.0'] },
      },
    });
    try {
      const res = await fetch(`${srv.url}/v1/service/info`);
      expect(res.status).toBe(200);
      // Exact shape — no env, config, paths, or other internal fields may leak.
      expect(await res.json()).toEqual({
        ok: true,
        status: 'ok',
        version: '9.9.9',
        gitSha: 'deadbeef',
        buildTime: '2026-06-17T12:00:00Z',
        systemRelease: 'r142',
        manifestChecksum: `sha256:${'a'.repeat(64)}`,
        packageVersions: { '@noodleseed/one': '0.34.0' },
        compatiblePackageVersions: { '@noodleseed/one': ['0.33.0', '0.34.0'] },
      });
    } finally {
      await srv.close();
    }
  });

  it('serves build info even under enforced HTTPS (the deploy smoke/probe must read it)', async () => {
    const srv = await listenWith({
      tls: { trustProxy: true },
      buildInfo: { version: '1', gitSha: 'sha', buildTime: 't' },
    });
    try {
      // A plain-HTTP tenant deploy 426s under trustProxy; /v1/service/info must bypass that like /healthz.
      expect(
        (await fetch(`${srv.url}/v1/orgs/acme/apps/hello/envs/prod/deploy`, { method: 'POST' }))
          .status,
      ).toBe(426);
      expect((await fetch(`${srv.url}/v1/service/info`)).status).toBe(200);
    } finally {
      await srv.close();
    }
  });

  it('fails an explicitly versioned incompatible CLI before hosted operations', async () => {
    const srv = await listenWith({
      buildInfo: {
        version: '1',
        gitSha: 'sha',
        buildTime: 't',
        packageVersions: { '@noodleseed/one': '0.34.0' },
        compatiblePackageVersions: { '@noodleseed/one': ['0.34.0'] },
      },
    });
    try {
      const res = await fetch(`${srv.url}/v1/orgs/acme/apps`, {
        headers: { 'x-noodle-cli-version': '0.33.0' },
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: 'client_version_unsupported',
        installedVersion: '0.33.0',
        supportedVersion: '0.34.0',
      });
    } finally {
      await srv.close();
    }
  });
});
