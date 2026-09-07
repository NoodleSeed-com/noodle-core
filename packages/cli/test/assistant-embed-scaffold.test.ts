// `noodle assistant embed --framework nextjs` scaffolds the embedding-app side of the assistant:
// session route, client-only mount, env example, and the coding-agent instructions — so the
// integration that took a customer hours becomes one command (roadmap S8).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createServer, type ViteDevServer } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAssistant } from '../src/commands/assistant-ops.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
// pnpm keeps @types/* in its virtual store; resolve real directories from the owning packages.
const typesRoot = dirname(
  dirname(createRequire(import.meta.url).resolve('@types/node/package.json')),
);
const reactTypesDir = dirname(
  createRequire(join(repoRoot, 'packages', 'assistant', 'package.json')).resolve(
    '@types/react/package.json',
  ),
);

let dir: string;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function scaffold(extra: readonly string[] = []): Promise<{
  code: number;
  body: { data: { files: Array<{ path: string; action: string }> } };
}> {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((value) => logs.push(String(value)));
  const code = await runAssistant(
    ['embed', '--framework', 'nextjs', '--dir', dir, '--json', ...extra],
    {},
    dir,
  );
  return { code, body: JSON.parse(logs.join('\n')) };
}

/** Load the generated Next.js route through Vite without binding a local port. */
async function generatedRouteServer(): Promise<ViteDevServer> {
  return createServer({
    root: dir,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
    resolve: {
      alias: {
        '@noodleseed/assistant/server': join(repoRoot, 'packages/assistant/dist/server.js'),
      },
    },
  });
}

async function checkHost(
  env: NodeJS.ProcessEnv,
  extra: readonly string[] = [],
): Promise<{
  code: number;
  body: {
    data: {
      ready: boolean;
      requiredEnvironmentNames: string[];
      missingEnvironmentNames: string[];
      csp: { status: string; files: string[]; missingDirectives?: string[] };
      postDeployProbes: Array<{ id: string }>;
      diagnostics: {
        serviceUrl: { status: string };
        sessionRoute: { status: string; files: string[] };
        clientMount: { status: string; files: string[] };
        sessionCookies: { status: string; files: string[] };
      };
      evidence: {
        provenThrough: string | null;
        firstUnproven: string;
        levels: Array<{ id: string; status: string }>;
      };
    };
    error?: { code: string };
  };
}> {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((value) => logs.push(String(value)));
  const code = await runAssistant(
    ['embed', '--check', '--framework', 'nextjs', '--dir', dir, '--json', ...extra],
    env,
    dir,
  );
  return { code, body: JSON.parse(logs.join('\n')) };
}

describe('noodle assistant embed --framework nextjs', () => {
  it('emits a fail-closed auth adapter, guarded session route, client mount, env, and instructions', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-embed-scaffold-'));
    const { code, body } = await scaffold();
    expect(code).toBe(0);

    const route = readFileSync(join(dir, 'app', 'api', 'assistant', 'session', 'route.ts'), 'utf8');
    expect(route).toContain("from '@noodleseed/assistant/server'");
    expect(route).toContain("from '../../../../lib/noodle-assistant-auth'");
    expect(route).toContain('createAssistantSession');
    expect(route).toContain('NOODLE_SERVICE_URL');
    expect(route).toContain('createAssistantSessionHandler');
    expect(route).toContain('origin: process.env.PUBLIC_APP_ORIGIN');
    expect(route).toContain('authenticate: authenticateAssistantRequest');
    expect(route).not.toContain('request.json()');
    expect(route).not.toContain('body.routing');
    expect(route).not.toContain('NEXT_PUBLIC'); // secrets must stay server-side

    const adapter = readFileSync(join(dir, 'lib', 'noodle-assistant-auth.ts'), 'utf8');
    expect(adapter).toContain('export type NoodleAssistantIdentity');
    expect(adapter).toContain('export async function authenticateAssistantRequest');
    expect(adapter).toContain('Promise<NoodleAssistantIdentity | null>');
    expect(adapter).toContain('return null');
    expect(adapter).toContain('server-owned membership');
    expect(adapter).toContain('HTML redirect');
    expect(adapter).toContain('CSRF');

    const mount = readFileSync(join(dir, 'components', 'noodle-assistant.tsx'), 'utf8');
    expect(mount).toContain("'use client'");
    expect(mount).toContain('ssr: false');
    expect(mount).toContain('sessionEndpoint="/api/assistant/session"');

    const envExample = readFileSync(join(dir, '.env.local.example'), 'utf8');
    for (const name of [
      'NOODLE_SERVICE_URL',
      'NOODLE_ASSISTANT_CLIENT_ID',
      'NOODLE_ASSISTANT_CLIENT_SECRET',
      'PUBLIC_APP_ORIGIN',
    ]) {
      expect(envExample).toContain(name);
    }

    // Coding-agent instructions land for both targets (S7b contract).
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(true);
    expect(
      existsSync(
        join(dir, '.claude', 'skills', 'noodle-seed', 'references', 'embedded-assistant.md'),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(dir, '.agents', 'skills', 'noodle-seed', 'references', 'embedded-assistant.md'),
      ),
    ).toBe(true);

    expect(body.data.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'app/api/assistant/session/route.ts', action: 'created' }),
        expect.objectContaining({ path: 'lib/noodle-assistant-auth.ts', action: 'created' }),
        expect.objectContaining({ path: 'components/noodle-assistant.tsx', action: 'created' }),
        expect.objectContaining({ path: '.env.local.example', action: 'created' }),
      ]),
    );
  });

  it('executes the generated auth adapter and session route fail closed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-embed-scaffold-route-'));
    await scaffold();
    const session = {
      token: 'synthetic-session',
      expiresAt: '2030-01-01T00:00:00Z',
      endpoints: {
        turns: 'https://cloud.example/turns',
        toolConfirmations: 'https://cloud.example/confirmations',
      },
    };
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(session));
    vi.stubGlobal('fetch', fetchMock);

    let server = await generatedRouteServer();
    try {
      const adapter = (await server.ssrLoadModule('/lib/noodle-assistant-auth.ts')) as {
        authenticateAssistantRequest(request: Request): Promise<unknown>;
      };
      await expect(
        adapter.authenticateAssistantRequest(
          new Request('https://app.example/api/assistant/session'),
        ),
      ).resolves.toBeNull();
    } finally {
      await server.close();
    }

    const adapterPath = join(dir, 'lib', 'noodle-assistant-auth.ts');
    const adapterSource = readFileSync(adapterPath, 'utf8');
    writeFileSync(
      adapterPath,
      adapterSource.replace(
        'return null;',
        `return (Reflect.get(globalThis, '__noodleTestAssistantIdentity') ?? null) as
    | NoodleAssistantIdentity
    | null;`,
      ),
    );

    vi.stubEnv('PUBLIC_APP_ORIGIN', 'https://app.example');
    vi.stubEnv('NOODLE_SERVICE_URL', 'https://cloud.example');
    vi.stubEnv('NOODLE_ASSISTANT_CLIENT_ID', 'embed_123');
    vi.stubEnv('NOODLE_ASSISTANT_CLIENT_SECRET', 'secret_123');
    server = await generatedRouteServer();
    try {
      const route = (await server.ssrLoadModule('/app/api/assistant/session/route.ts')) as {
        POST(request: Request): Promise<Response>;
      };
      const request = (
        body: string,
        headers: Record<string, string> = {
          origin: 'https://app.example',
          'content-type': 'application/json',
        },
      ) =>
        new Request('https://app.example/api/assistant/session', {
          method: 'POST',
          headers,
          body,
        });

      const invalidOrigin = await route.POST(
        request('{}', { origin: 'https://evil.example', 'content-type': 'application/json' }),
      );
      expect(invalidOrigin.status).toBe(403);
      expect(invalidOrigin.headers.get('cache-control')).toBe('no-store');

      const invalidContentType = await route.POST(
        request('{}', { origin: 'https://app.example', 'content-type': 'text/plain' }),
      );
      expect(invalidContentType.status).toBe(415);

      const unauthenticated = await route.POST(request('{}'));
      expect(unauthenticated.status).toBe(401);
      expect(await unauthenticated.json()).toEqual({
        code: 'authentication_required',
        error: 'authentication required',
      });

      const identity = {
        user: { id: 'user_123', email: 'user@example.com' },
        claims: { accountTier: 'pro' },
        preferences: { locale: 'en-US' },
        routing: { endpoints: { customer_api: 'https://tenant.api.example' } },
      };
      Reflect.set(globalThis, '__noodleTestAssistantIdentity', identity);

      expect((await route.POST(request('null'))).status).toBe(400);
      expect((await route.POST(request('{"context":{"nested":{"unsafe":true}}}'))).status).toBe(
        400,
      );

      const success = await route.POST(
        request('{"context":{"page":"settings","count":2,"enabled":true,"selection":null}}'),
      );
      expect(success.status).toBe(200);
      expect(success.headers.get('cache-control')).toBe('no-store');
      expect(await success.json()).toEqual(session);
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
        origin: 'https://app.example',
        ...identity,
        context: { page: 'settings', count: 2, enabled: true, selection: null },
      });
    } finally {
      Reflect.deleteProperty(globalThis, '__noodleTestAssistantIdentity');
      await server.close();
    }
  });

  it('never overwrites user files without --force, and reconciles idempotently', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-embed-scaffold-force-'));
    await scaffold();
    const routePath = join(dir, 'app', 'api', 'assistant', 'session', 'route.ts');
    writeFileSync(routePath, '// user-modified\n');

    const second = await scaffold();
    expect(second.code).toBe(0);
    expect(second.body.data.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'app/api/assistant/session/route.ts', action: 'skipped' }),
        expect.objectContaining({ path: 'components/noodle-assistant.tsx', action: 'unchanged' }),
      ]),
    );
    expect(readFileSync(routePath, 'utf8')).toBe('// user-modified\n');

    const forced = await scaffold(['--force']);
    expect(forced.code).toBe(0);
    expect(forced.body.data.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'app/api/assistant/session/route.ts',
          action: 'overwritten',
        }),
      ]),
    );
    expect(readFileSync(routePath, 'utf8')).toContain('createAssistantSession');
  });

  it('rejects unknown frameworks with a repairable error', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-embed-scaffold-framework-'));
    const output: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)));
    vi.spyOn(console, 'error').mockImplementation((value) => errors.push(String(value)));
    const code = await runAssistant(
      ['embed', '--framework', 'svelte', '--dir', dir, '--json'],
      {},
      dir,
    );
    expect(code).not.toBe(0);
    expect(output.join('\n')).toContain('nextjs');
    expect(errors).toEqual([]);
  });

  it('checks host environment presence without scaffolding or exposing values', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-embed-check-missing-'));
    const env: NodeJS.ProcessEnv = {
      NOODLE_SERVICE_URL: 'https://cloud.example',
      NOODLE_ASSISTANT_CLIENT_ID: 'embed_123',
      NOODLE_ASSISTANT_CLIENT_SECRET: 'nsa_private_value',
      PUBLIC_APP_ORIGIN: 'https://app.example',
    };
    const result = await checkHost(env, ['--require-env', 'EXAMPLE_DELEG_CLIENT_SECRET']);

    expect(result.code).toBe(1);
    expect(result.body.data).toMatchObject({
      ready: false,
      requiredEnvironmentNames: [
        'NOODLE_SERVICE_URL',
        'NOODLE_ASSISTANT_CLIENT_ID',
        'NOODLE_ASSISTANT_CLIENT_SECRET',
        'PUBLIC_APP_ORIGIN',
        'EXAMPLE_DELEG_CLIENT_SECRET',
      ],
      missingEnvironmentNames: ['EXAMPLE_DELEG_CLIENT_SECRET'],
      csp: { status: 'not-detected', files: [] },
    });
    expect(result.body.data.postDeployProbes.map((probe) => probe.id)).toEqual([
      'session-exchange',
      'assistant-doctor',
      'browser-flow',
    ]);
    expect(JSON.stringify(result.body.data.postDeployProbes)).toContain(
      '--user-id <real-test-user>',
    );
    expect(JSON.stringify(result.body)).not.toContain('nsa_private_value');
    expect(existsSync(join(dir, 'app', 'api', 'assistant', 'session', 'route.ts'))).toBe(false);
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
  });

  it('treats an empty host environment value as missing without exposing it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-embed-check-empty-'));
    const result = await checkHost({
      NOODLE_SERVICE_URL: 'https://cloud.example',
      NOODLE_ASSISTANT_CLIENT_ID: 'embed_123',
      NOODLE_ASSISTANT_CLIENT_SECRET: 'nsa_private_value',
      PUBLIC_APP_ORIGIN: '',
    });

    expect(result.code).toBe(1);
    expect(result.body.data).toMatchObject({
      ready: false,
      missingEnvironmentNames: ['PUBLIC_APP_ORIGIN'],
    });
    expect(JSON.stringify(result.body)).not.toContain('nsa_private_value');
  });

  it('rejects a missing additional environment name without writing files', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-embed-check-env-name-missing-'));
    const result = await checkHost({}, ['--require-env']);

    expect(result.code).toBe(2);
    expect(result.body).toMatchObject({
      error: {
        code: 'assistant_host_env_name_missing',
      },
    });
    expect(existsSync(join(dir, 'app', 'api', 'assistant', 'session', 'route.ts'))).toBe(false);
  });

  it('passes a complete static CSP that names the service origin', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-embed-check-csp-pass-'));
    writeFileSync(
      join(dir, 'next.config.mjs'),
      `export default {
  async headers() {
    return [{
      source: '/:path*',
      headers: [{
        key: 'Content-Security-Policy',
        value: "default-src 'self'; connect-src 'self' https://cloud.example; frame-src https://cloud.example",
      }],
    }];
  },
};
`,
    );
    const result = await checkHost({
      NOODLE_SERVICE_URL: 'https://cloud.example/v1',
      NOODLE_ASSISTANT_CLIENT_ID: 'embed_123',
      NOODLE_ASSISTANT_CLIENT_SECRET: 'nsa_private_value',
      PUBLIC_APP_ORIGIN: 'https://app.example',
    });

    expect(result.code).toBe(0);
    expect(result.body.data).toMatchObject({
      ready: true,
      missingEnvironmentNames: [],
      csp: { status: 'ready', files: ['next.config.mjs'] },
    });
    expect(JSON.stringify(result.body)).not.toContain('nsa_private_value');
  });

  it('fails with the exact missing CSP directive and never echoes config contents', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-embed-check-csp-fail-'));
    writeFileSync(
      join(dir, 'next.config.ts'),
      `const privateMarker = 'do-not-return-this';
export default {
  async headers() {
    return [{
      source: '/:path*',
      headers: [{
        key: 'Content-Security-Policy',
        value: "default-src 'self'; connect-src 'self' https://cloud.example",
      }],
    }];
  },
};
`,
    );
    const result = await checkHost({
      NOODLE_SERVICE_URL: 'https://cloud.example',
      NOODLE_ASSISTANT_CLIENT_ID: 'embed_123',
      NOODLE_ASSISTANT_CLIENT_SECRET: 'nsa_private_value',
      PUBLIC_APP_ORIGIN: 'https://app.example',
    });

    expect(result.code).toBe(1);
    expect(result.body.data.csp).toMatchObject({
      status: 'missing-directives',
      files: ['next.config.ts'],
      missingDirectives: ['frame-src'],
    });
    expect(JSON.stringify(result.body)).not.toContain('do-not-return-this');
    expect(JSON.stringify(result.body)).not.toContain('nsa_private_value');
  });

  it('verifies a wildcard CSP source that covers the service origin', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-embed-check-csp-wildcard-'));
    writeFileSync(
      join(dir, 'next.config.mjs'),
      `export default {
  async headers() {
    return [{
      source: '/:path*',
      headers: [{
        key: 'Content-Security-Policy',
        value: "default-src 'self'; connect-src 'self' https://*.noodleseed.dev; frame-src https://*.noodleseed.dev",
      }],
    }];
  },
};
`,
    );
    const result = await checkHost({
      NOODLE_SERVICE_URL: 'https://api.noodleseed.dev',
      NOODLE_ASSISTANT_CLIENT_ID: 'embed_123',
      NOODLE_ASSISTANT_CLIENT_SECRET: 'nsa_private_value',
      PUBLIC_APP_ORIGIN: 'https://app.example',
    });

    // A covering wildcard is a correct CSP; failing it while an app with NO CSP passed was the
    // inversion the literal substring match produced.
    expect(result.code).toBe(0);
    expect(result.body.data.csp).toMatchObject({ status: 'ready' });
  });

  it('does not let a wildcard for another scheme or suffix verify the origin', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-embed-check-csp-wildcard-miss-'));
    writeFileSync(
      join(dir, 'next.config.mjs'),
      `export default {
  headers: "connect-src https://*.other.example; frame-src http://*.noodleseed.dev",
};
`,
    );
    const result = await checkHost({
      NOODLE_SERVICE_URL: 'https://api.noodleseed.dev',
      NOODLE_ASSISTANT_CLIENT_ID: 'embed_123',
      NOODLE_ASSISTANT_CLIENT_SECRET: 'secret',
      PUBLIC_APP_ORIGIN: 'https://app.example',
    });

    expect(result.code).toBe(1);
    expect(result.body.data.csp).toMatchObject({ status: 'unverified' });
  });

  it('--surface public drops the backend credential requirement and demands script-src', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-embed-check-public-'));
    writeFileSync(
      join(dir, 'next.config.mjs'),
      `export default {
  headers: "connect-src https://cloud.example; frame-src https://cloud.example",
};
`,
    );
    // A public embed has no client secret by design: the embed id is not a credential.
    const result = await checkHost(
      { NOODLE_SERVICE_URL: 'https://cloud.example', PUBLIC_APP_ORIGIN: 'https://www.example' },
      ['--surface', 'public'],
    );

    expect(result.body.data.requiredEnvironmentNames).toEqual([
      'NOODLE_SERVICE_URL',
      'PUBLIC_APP_ORIGIN',
    ]);
    expect(result.body.data.missingEnvironmentNames).toEqual([]);
    // The one failure mode undetectable from inside the page: a blocked script-src runs no widget
    // code at all, so nothing can report it. The preflight is the only place to catch it.
    expect(result.code).toBe(1);
    expect(result.body.data.csp).toMatchObject({
      status: 'missing-directives',
      missingDirectives: ['script-src'],
    });
  });

  it('--surface mixed keeps the backend credentials and also demands script-src', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-embed-check-mixed-'));
    writeFileSync(
      join(dir, 'next.config.mjs'),
      `export default {
  headers: "script-src 'self' https://cloud.example; connect-src https://cloud.example; frame-src https://cloud.example",
};
`,
    );
    const result = await checkHost(
      {
        NOODLE_SERVICE_URL: 'https://cloud.example',
        NOODLE_ASSISTANT_CLIENT_ID: 'embed_123',
        NOODLE_ASSISTANT_CLIENT_SECRET: 'secret',
        PUBLIC_APP_ORIGIN: 'https://www.example',
      },
      ['--surface', 'mixed'],
    );

    expect(result.code).toBe(0);
    expect(result.body.data.csp).toMatchObject({ status: 'ready' });
    expect(result.body.data.requiredEnvironmentNames).toContain('NOODLE_ASSISTANT_CLIENT_SECRET');
  });

  it('checks the generated public React profile without requiring a backend or remote script', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-embed-check-public-profile-'));
    await scaffold(['--surface', 'public', '--no-agents']);
    writeFileSync(
      join(dir, 'next.config.mjs'),
      `export default { headers: "connect-src https://cloud.example; frame-src https://cloud.example" };`,
    );
    const guide = readFileSync(join(dir, 'NOODLE-INTEGRATION.md'), 'utf8');
    const command = guide.match(/\x60noodle assistant embed (--check[^\x60]+)\x60/)?.[1];
    expect(command).toBeDefined();
    const result = await checkHost(
      {
        NEXT_PUBLIC_NOODLE_EMBED_ID: 'public-test-id',
        NEXT_PUBLIC_NOODLE_SERVICE_URL: 'https://cloud.example',
        PUBLIC_APP_ORIGIN: 'https://www.example',
      },
      command?.split(' ') ?? [],
    );
    expect(result.code).toBe(0);
    expect(result.body.data.missingEnvironmentNames).toEqual([]);
    expect(result.body.data.csp.status).toBe('ready');
    expect(result.body.data.diagnostics.sessionRoute.status).toBe('not-applicable');
    expect(JSON.stringify(result.body.data.postDeployProbes)).not.toContain(
      '/api/assistant/session',
    );
    expect(JSON.stringify(result.body.data.postDeployProbes)).not.toContain('--user-id');
    expect(result.body.data.postDeployProbes.map((probe) => probe.id)).toContain(
      'public-admission',
    );
    expect(result.body.data.evidence.firstUnproven).toBe('local-contract');
  });

  it('rejects an unknown --surface without writing files', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-embed-check-surface-invalid-'));
    const result = await checkHost({}, ['--surface', 'intranet']);

    expect(result.code).toBe(2);
    expect(result.body).toMatchObject({ error: { code: 'assistant_host_surface_invalid' } });
  });

  it('--env-alias checks the host repo name instead of forcing a rename', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-embed-check-alias-'));
    const result = await checkHost(
      {
        MY_NOODLE_URL: 'https://cloud.example',
        NOODLE_ASSISTANT_CLIENT_ID: 'embed_123',
        NOODLE_ASSISTANT_CLIENT_SECRET: 'secret',
        PUBLIC_APP_ORIGIN: 'https://app.example',
      },
      ['--env-alias', 'NOODLE_SERVICE_URL=MY_NOODLE_URL'],
    );

    expect(result.code).toBe(0);
    expect(result.body.data.requiredEnvironmentNames).toContain('MY_NOODLE_URL');
    expect(result.body.data.requiredEnvironmentNames).not.toContain('NOODLE_SERVICE_URL');
  });

  it('rejects a malformed --env-alias', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-embed-check-alias-invalid-'));
    const result = await checkHost({}, ['--env-alias', 'NOODLE_SERVICE_URL:lowercase']);

    expect(result.code).toBe(2);
    expect(result.body).toMatchObject({ error: { code: 'assistant_host_env_alias_invalid' } });
  });

  it('fails closed when a CSP is present but its service-origin expression is not provable', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-embed-check-csp-unverified-'));
    writeFileSync(
      join(dir, 'middleware.ts'),
      `const serviceOrigin = resolveAtRuntime();
const csp = \`connect-src 'self' \${serviceOrigin}; frame-src \${serviceOrigin}\`;
`,
    );
    const result = await checkHost({
      NOODLE_SERVICE_URL: 'https://cloud.example',
      NOODLE_ASSISTANT_CLIENT_ID: 'embed_123',
      NOODLE_ASSISTANT_CLIENT_SECRET: 'nsa_private_value',
      PUBLIC_APP_ORIGIN: 'https://app.example',
    });

    expect(result.code).toBe(1);
    expect(result.body.data.csp).toMatchObject({
      status: 'unverified',
      files: ['middleware.ts'],
    });
  });

  it('reports the first unproven evidence level instead of promoting static checks to browser proof', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-embed-check-evidence-'));
    const result = await checkHost({
      NOODLE_SERVICE_URL: 'https://cloud.example',
      NOODLE_ASSISTANT_CLIENT_ID: 'embed_123',
      NOODLE_ASSISTANT_CLIENT_SECRET: 'secret',
      PUBLIC_APP_ORIGIN: 'https://app.example',
    });

    expect(result.code).toBe(0);
    expect(result.body.data.evidence).toEqual({
      provenThrough: null,
      firstUnproven: 'static-host',
      levels: [
        { id: 'static-host', status: 'partial' },
        { id: 'local-contract', status: 'unproven' },
        { id: 'hosted-session', status: 'unproven' },
        { id: 'production-browser', status: 'unproven' },
        { id: 'operations', status: 'unproven' },
      ],
    });
    expect(result.body.data.diagnostics).toMatchObject({
      serviceUrl: { status: 'ready' },
      sessionRoute: { status: 'not-detected', files: [] },
      clientMount: { status: 'not-detected', files: [] },
      sessionCookies: { status: 'not-detected', files: [] },
    });
  });

  it('rejects a deployment MCP endpoint where the control-plane service URL is required', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-embed-check-mcp-url-'));
    const result = await checkHost({
      NOODLE_SERVICE_URL: 'https://acme.cloud.example/orders/mcp',
      NOODLE_ASSISTANT_CLIENT_ID: 'embed_123',
      NOODLE_ASSISTANT_CLIENT_SECRET: 'secret',
      PUBLIC_APP_ORIGIN: 'https://app.example',
    });

    expect(result.code).toBe(1);
    expect(result.body.data.diagnostics.serviceUrl).toEqual({ status: 'mcp-endpoint' });
    expect(result.body.data.evidence).toMatchObject({
      provenThrough: null,
      firstUnproven: 'static-host',
    });
    expect(JSON.stringify(result.body)).not.toContain('acme.cloud.example');
  });

  it('detects an HTML login redirect risk in the canonical session route without echoing source', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-embed-check-redirect-'));
    const routeDir = join(dir, 'app', 'api', 'assistant', 'session');
    mkdirSync(routeDir, { recursive: true });
    writeFileSync(
      join(routeDir, 'route.ts'),
      "const privateMarker = 'do-not-return-this'; export async function POST() { return Response.redirect('/login'); }\n",
    );
    const result = await checkHost({
      NOODLE_SERVICE_URL: 'https://cloud.example',
      NOODLE_ASSISTANT_CLIENT_ID: 'embed_123',
      NOODLE_ASSISTANT_CLIENT_SECRET: 'secret',
      PUBLIC_APP_ORIGIN: 'https://app.example',
    });

    expect(result.code).toBe(1);
    expect(result.body.data.diagnostics.sessionRoute).toMatchObject({
      status: 'html-redirect-risk',
      files: ['app/api/assistant/session/route.ts'],
    });
    expect(JSON.stringify(result.body)).not.toContain('do-not-return-this');
  });

  it('detects SSR mounting and cross-origin cookie risks in the canonical client mount', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-embed-check-client-risk-'));
    const componentDir = join(dir, 'components');
    mkdirSync(componentDir, { recursive: true });
    writeFileSync(
      join(componentDir, 'noodle-assistant.tsx'),
      `import { NoodleAssistant } from '@noodleseed/assistant/react';
export function AssistantWidget() {
  return <NoodleAssistant sessionEndpoint="https://api.example/session" />;
}
`,
    );
    const result = await checkHost({
      NOODLE_SERVICE_URL: 'https://cloud.example',
      NOODLE_ASSISTANT_CLIENT_ID: 'embed_123',
      NOODLE_ASSISTANT_CLIENT_SECRET: 'secret',
      PUBLIC_APP_ORIGIN: 'https://app.example',
    });

    expect(result.code).toBe(1);
    expect(result.body.data.diagnostics.clientMount).toMatchObject({
      status: 'ssr-risk',
      files: ['components/noodle-assistant.tsx'],
    });
    expect(result.body.data.diagnostics.sessionCookies).toMatchObject({
      status: 'cross-origin-risk',
      files: ['components/noodle-assistant.tsx'],
    });
  });

  it.each([
    '//evil.example/session',
    '/\\evil.example/session',
    '/\t/evil.example/session',
    '/api/\tassistant/session',
    '/api/\u0085assistant/session',
  ])('rejects non-canonical session endpoint %s', async (sessionEndpoint) => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-embed-check-protocol-relative-'));
    const componentDir = join(dir, 'components');
    mkdirSync(componentDir, { recursive: true });
    const hasControlCharacter = Array.from(sessionEndpoint).some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
      );
    });
    const serializedSessionEndpoint = hasControlCharacter
      ? `"${sessionEndpoint}"`
      : JSON.stringify(sessionEndpoint);
    writeFileSync(
      join(componentDir, 'noodle-assistant.tsx'),
      `"use client";
import dynamic from 'next/dynamic';
const NoodleAssistant = dynamic(() => import('@noodleseed/assistant/react'), { ssr: false });
export function AssistantWidget() {
  return <NoodleAssistant sessionEndpoint=${serializedSessionEndpoint} />;
}
`,
    );
    const result = await checkHost({
      NOODLE_SERVICE_URL: 'https://cloud.example',
      NOODLE_ASSISTANT_CLIENT_ID: 'embed_123',
      NOODLE_ASSISTANT_CLIENT_SECRET: 'secret',
      PUBLIC_APP_ORIGIN: 'https://app.example',
    });

    expect(result.code).toBe(1);
    expect(result.body.data.diagnostics.clientMount).toMatchObject({ status: 'ready' });
    expect(result.body.data.diagnostics.sessionCookies).toMatchObject({
      status: 'cross-origin-risk',
    });
  });

  it('proves only the static level for the generated fail-closed host files', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-embed-check-generated-static-'));
    await scaffold();
    const result = await checkHost({
      NOODLE_SERVICE_URL: 'https://cloud.example',
      NOODLE_ASSISTANT_CLIENT_ID: 'embed_123',
      NOODLE_ASSISTANT_CLIENT_SECRET: 'secret',
      PUBLIC_APP_ORIGIN: 'https://app.example',
    });

    expect(result.code).toBe(0);
    expect(result.body.data.diagnostics).toMatchObject({
      serviceUrl: { status: 'ready' },
      sessionRoute: { status: 'ready' },
      clientMount: { status: 'ready' },
      sessionCookies: { status: 'ready' },
    });
    expect(result.body.data.evidence).toMatchObject({
      provenThrough: 'static-host',
      firstUnproven: 'local-contract',
    });
    expect(
      result.body.data.evidence.levels.find((level) => level.id === 'production-browser'),
    ).toEqual({ id: 'production-browser', status: 'unproven' });
  });

  it.each([
    'authenticated',
    'public',
    'mixed',
  ])('emitted %s files typecheck against the workspace assistant package types', async (surface) => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-embed-scaffold-types-'));
    await scaffold(['--surface', surface]);
    const assistantDist = join(repoRoot, 'packages', 'assistant', 'dist');
    // Minimal ambient stand-in for the host framework's dynamic() helper.
    const nextDynamicStub = join(dir, 'next-dynamic.d.ts');
    writeFileSync(
      nextDynamicStub,
      "declare module 'next/dynamic' { export default function dynamic<T>(loader: () => Promise<T>, options?: { ssr?: boolean }): T; }\n",
    );
    const program = ts.createProgram(
      [
        join(dir, 'app', 'api', 'assistant', 'session', 'route.ts'),
        join(dir, 'lib', 'noodle-assistant-auth.ts'),
        join(dir, 'components', 'noodle-assistant.tsx'),
        nextDynamicStub,
      ].filter((path) => existsSync(path)),
      {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2022,
        lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
        types: ['node'],
        typeRoots: [typesRoot],
        paths: {
          '@noodleseed/assistant/server': [join(assistantDist, 'server.d.ts')],
          '@noodleseed/assistant/react': [join(assistantDist, 'react.d.ts')],
          react: [join(reactTypesDir, 'index.d.ts')],
          'react/jsx-runtime': [join(reactTypesDir, 'jsx-runtime.d.ts')],
        },
      },
    );
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    expect(diagnostics).toEqual([]);
  }, 60_000);
});
