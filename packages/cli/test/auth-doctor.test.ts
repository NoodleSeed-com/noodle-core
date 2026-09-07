import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/index.js';

let dir: string;
let home: string;
let cwd: string;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noodle-auth-doctor-'));
  home = mkdtempSync(join(tmpdir(), 'noodle-auth-doctor-home-'));
  cwd = process.cwd();
  process.chdir(dir);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  process.chdir(cwd);
  logSpy.mockRestore();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('noodle auth doctor', () => {
  it('rejects the unsupported --entrypoint option with positional recovery', async () => {
    expect(
      await run(
        ['auth', 'doctor', '--entrypoint', 'app/server.ts', '--json'],
        { NOODLE_UPDATE_MODE: 'off' },
        home,
      ),
    ).toBe(2);
    const envelope = JSON.parse(output()) as {
      ok: false;
      error: { code: string; cause: string; next: string };
    };
    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: 'usage_error',
        cause: 'unknown option: --entrypoint',
        next: 'noodle auth doctor app/server.ts --json',
      },
    });
  });

  it('rejects a second positional entrypoint instead of ignoring it', async () => {
    expect(
      await run(
        ['auth', 'doctor', 'server.ts', 'app/server.ts', '--json'],
        { NOODLE_UPDATE_MODE: 'off' },
        home,
      ),
    ).toBe(2);
    const envelope = JSON.parse(output()) as {
      ok: false;
      error: { code: string; cause: string; next: string };
    };
    expect(envelope.error).toMatchObject({
      code: 'usage_error',
      cause: 'auth doctor accepts at most one positional entrypoint',
      next: 'noodle auth doctor app/server.ts --json',
    });
  });

  it.each([
    '--org',
    '--app',
    '--env',
    '--version',
    '--service',
  ])('rejects %s without a value before project discovery', async (option) => {
    expect(
      await run(['auth', 'doctor', option, '--json'], { NOODLE_UPDATE_MODE: 'off' }, home),
    ).toBe(2);
    const envelope = JSON.parse(output()) as {
      ok: false;
      error: { code: string; message: string; next: string };
    };
    expect(envelope.error).toMatchObject({
      code: 'missing_option_value',
      message: `noodle auth doctor: ${option} requires a value`,
      next: 'noodle auth doctor --help',
    });
  });

  it('runs one customer-authenticated delegated exchange without invoking a business tool', async () => {
    writeFileSync(
      join(dir, 'server.ts'),
      `
import { customerAuth, server, tool, z } from '@noodleseed/one';
export default server('live_app', {
  title: 'Live App', version: '1.0.0',
  auth: customerAuth.firebase({ projectId: 'live-project', apiKey: 'public-key' })
}, [tool('context', {
  description: 'Context', input: z.object({}), fulfil: () => ({ ok: true })
})]);
`,
    );
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ok: true,
        resource: 'https://cloud.example/o/acme/live/v2_0/mcp',
        checks: [
          {
            connectorId: 'acme_api',
            operation: 'list',
            authKind: 'delegatedTokenExchange',
            ok: true,
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(
      await run(
        [
          'auth',
          'doctor',
          'server.ts',
          '--live',
          '--org',
          'acme',
          '--app',
          'live',
          '--env',
          'prod',
          '--version',
          'v2_0',
          '--service',
          'https://cloud.example',
        ],
        { NOODLE_CUSTOMER_TOKEN: 'short-lived-customer-token' },
        home,
      ),
    ).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://cloud.example/v1/orgs/acme/apps/live/envs/prod/auth/doctor?version=2.0',
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
    expect(output()).toContain(
      'PASS Live customer resource: https://cloud.example/o/acme/live/v2_0/mcp',
    );
    expect(output()).toContain('PASS Live delegatedTokenExchange: acme_api.list');
  });

  it('rejects an invalid live doctor server version before making a request', async () => {
    writeFileSync(
      join(dir, 'server.ts'),
      `
import { customerAuth, server, tool, z } from '@noodleseed/one';
export default server('live_app', {
  title: 'Live App', version: '1.0.0',
  auth: customerAuth.firebase({ projectId: 'live-project', apiKey: 'public-key' })
}, [tool('context', {
  description: 'Context', input: z.object({}), fulfil: () => ({ ok: true })
})]);
`,
    );
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    expect(
      await run(
        ['auth', 'doctor', 'server.ts', '--live', '--version', 'not/a/version'],
        { NOODLE_CUSTOMER_TOKEN: 'short-lived-customer-token' },
        home,
      ),
    ).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a missing live doctor server version before making a request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    expect(
      await run(
        ['auth', 'doctor', 'server.ts', '--live', '--version'],
        { NOODLE_CUSTOMER_TOKEN: 'short-lived-customer-token' },
        home,
      ),
    ).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes a built-in bridge customer auth project without OIDC metadata', async () => {
    writeFileSync(
      join(dir, 'server.ts'),
      `
import { customerAuth, server, tool, z } from '@noodleseed/one';

export default server('bridged_app', {
  title: 'Bridged App',
  version: '1.0.0',
  auth: customerAuth.firebase({ projectId: 'bridge-project', apiKey: 'public-key' })
}, [
  tool('whoami', {
    description: 'Show the verified user',
    input: z.object({}),
    fulfil: ({ user }) => ({ subject: user.subject, email: user.email })
  })
]);
`,
    );

    expect(await run(['auth', 'doctor', 'server.ts'], {}, home)).toBe(0);
    expect(output()).toContain('PASS Customer auth: bridge provider "firebase"');
    expect(output()).toContain('PASS MCP issuer: Noodle-managed bridge authorization server');
  });

  it('passes Firebase bridge customer auth readiness without OIDC metadata', async () => {
    writeFileSync(
      join(dir, 'server.ts'),
      `
import { customerAuth, server, tool, z } from '@noodleseed/one';

export default server('firebase_app', {
  title: 'Firebase App',
  version: '1.0.0',
  auth: customerAuth.firebase({
    projectId: 'noodleseed-prod',
    apiKey: 'firebase-public-web-api-key',
    authDomain: 'noodleseed-prod.firebaseapp.com',
    user: { id: 'sub', email: 'email' }
  })
}, [
  tool('whoami', {
    description: 'Show the verified user',
    input: z.object({}),
    fulfil: ({ user }) => ({ subject: user.subject, email: user.email })
  })
]);
`,
    );

    expect(await run(['auth', 'doctor', 'server.ts'], {}, home)).toBe(0);
    expect(output()).toContain('PASS Customer auth: bridge provider "firebase"');
    expect(output()).toContain('PASS Firebase project: noodleseed-prod');
    expect(output()).toContain('PASS Firebase Web API key: configured');
    expect(output()).toContain('PASS Firebase auth domain: noodleseed-prod.firebaseapp.com');
    expect(output()).toContain(
      'WARN Revocation checks: Firebase ID token revocation is not checked in v1',
    );
  });

  it('fails direct OIDC auth when the issuer has no jwks_uri', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          issuer: 'https://app.noodleseed.com',
          id_token_signing_alg_values_supported: ['HS256'],
        }),
      ),
    );
    writeFileSync(
      join(dir, 'server.ts'),
      `
import { customerAuth, server, tool, z } from '@noodleseed/one';

export default server('oidc_app', {
  title: 'OIDC App',
  version: '1.0.0',
  auth: customerAuth.oidc({
    issuer: 'https://app.noodleseed.com',
    audience: 'noodleseed-oidc-app-dev'
  })
}, [
  tool('whoami', {
    description: 'Show the verified user',
    input: z.object({}),
    fulfil: ({ user }) => ({ subject: user.subject })
  })
]);
`,
    );

    expect(await run(['auth', 'doctor', 'server.ts'], {}, home)).toBe(1);
    expect(output()).toContain('PASS Audience: noodleseed-oidc-app-dev');
    expect(output()).toContain('FAIL JWKS: missing or invalid HTTPS jwks_uri');
    expect(output()).toContain('Publish an HTTPS jwks_uri');
  });

  it('requires the primary path-inserted RFC 8414 route by default', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('missing', { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({
          issuer: 'https://id.example.com',
          jwks_uri: 'https://id.example.com/jwks',
        }),
      )
      .mockResolvedValueOnce(Response.json({ keys: [] }));
    vi.stubGlobal('fetch', fetchMock);
    writeFileSync(
      join(dir, 'server.ts'),
      `
import { customerAuth, server, tool, z } from '@noodleseed/one';
export default server('oidc_app', {
  title: 'OIDC App',
  version: '1.0.0',
  auth: customerAuth.oidc({ issuer: 'https://id.example.com', audience: 'api://oidc-app' })
}, [tool('whoami', {
  description: 'Show the caller',
  input: z.object({}),
  fulfil: ({ user }) => ({ subject: user.subject })
})]);
`,
    );

    expect(await run(['auth', 'doctor', 'server.ts'], {}, home)).toBe(1);
    expect(output()).toContain('FAIL MCP host discovery');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://id.example.com/.well-known/oauth-authorization-server',
    );
  });

  it('requires RFC 7591 DCR for BYO-OIDC customer auth without a target flag', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          issuer: 'https://id.example.com',
          authorization_endpoint: 'https://id.example.com/authorize',
          token_endpoint: 'https://id.example.com/token',
          jwks_uri: 'https://id.example.com/jwks',
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          keys: [validRsaSigningJwk()],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    writeFileSync(
      join(dir, 'server.ts'),
      `
import { customerAuth, server, tool, z } from '@noodleseed/one';
export default server('oidc_app', {
  title: 'OIDC App',
  version: '1.0.0',
  auth: customerAuth.oidc({ issuer: 'https://id.example.com', audience: 'api://oidc-app' })
}, [tool('whoami', {
  description: 'Show the caller',
  input: z.object({}),
  fulfil: ({ user }) => ({ subject: user.subject })
})]);
`,
    );

    expect(await run(['auth', 'doctor', 'server.ts'], {}, home)).toBe(1);
    expect(output()).toContain(
      'FAIL Dynamic client registration: missing or invalid HTTPS registration_endpoint',
    );
    expect(output()).toContain('RFC 7591');
  });

  it('fails generic MCP readiness on a redirect from the path-inserted metadata route', async () => {
    let cancelled = false;
    const redirectBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([32]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(redirectBody, {
        status: 307,
        headers: { location: '/auth/login?callbackUrl=%2F.well-known%2Foauth' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    writeFileSync(
      join(dir, 'server.ts'),
      `
import { customerAuth, server, tool, z } from '@noodleseed/one';
export default server('oidc_app', {
  title: 'OIDC App', version: '1.0.0',
  auth: customerAuth.oidc({ issuer: 'https://app.acmehr.example/oauth', audience: 'api://oidc-app' })
}, [tool('whoami', {
  description: 'Show the caller', input: z.object({}),
  fulfil: ({ user }) => ({ subject: user.subject })
})]);
`,
    );

    expect(await run(['auth', 'doctor', 'server.ts'], {}, home)).toBe(1);
    expect(output()).toContain('FAIL MCP host discovery');
    expect(output()).toContain(
      'https://app.acmehr.example/.well-known/oauth-authorization-server/oauth',
    );
    expect(output()).toContain('HTTP 307');
    expect(output()).not.toContain('callbackUrl');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(cancelled).toBe(true);
  });

  it('requires an exact HTTP 200 response from the generic-host metadata route', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            issuer: 'https://id.example.com',
            jwks_uri: 'https://id.example.com/jwks',
            registration_endpoint: 'https://id.example.com/register',
          },
          { status: 201 },
        ),
      ),
    );
    writeFileSync(
      join(dir, 'server.ts'),
      `
import { customerAuth, server, tool, z } from '@noodleseed/one';
export default server('oidc_app', {
  title: 'OIDC App', version: '1.0.0',
  auth: customerAuth.oidc({ issuer: 'https://id.example.com', audience: 'api://oidc-app' })
}, [tool('whoami', {
  description: 'Show the caller', input: z.object({}),
  fulfil: ({ user }) => ({ subject: user.subject })
})]);
`,
    );

    expect(await run(['auth', 'doctor', 'server.ts'], {}, home)).toBe(1);
    expect(output()).toContain('FAIL MCP host discovery');
    expect(output()).toContain('HTTP 201');
  });

  it('reports coded, issuer-scoped readiness for DCR, PKCE, refresh, public clients, and JWKS', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          issuer: 'https://id.example.com/oauth',
          authorization_endpoint: 'https://id.example.com/oauth/authorize',
          token_endpoint: 'https://id.example.com/oauth/token',
          jwks_uri: 'https://id.example.com/oauth/jwks',
          registration_endpoint: 'https://id.example.com/oauth/register',
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          keys: [validRsaSigningJwk()],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    writeFileSync(
      join(dir, 'server.ts'),
      `
import { customerAuth, server, tool, z } from '@noodleseed/one';
export default server('oidc_app', {
  title: 'OIDC App', version: '1.0.0',
  auth: customerAuth.oidc({ issuer: 'https://id.example.com/oauth', audience: 'api://oidc-app' })
}, [tool('whoami', {
  description: 'Show the caller', input: z.object({}),
  fulfil: ({ user }) => ({ subject: user.subject })
})]);
`,
    );

    expect(await run(['auth', 'doctor', 'server.ts', '--json'], {}, home)).toBe(0);
    const envelope = JSON.parse(output()) as {
      data: {
        checks: Array<{
          code?: string;
          level: string;
          issuer?: string;
          message: string;
        }>;
      };
    };
    const issuerChecks = envelope.data.checks.filter(
      (check) => check.issuer === 'https://id.example.com/oauth',
    );
    expect(issuerChecks.map((check) => check.code)).toEqual(
      expect.arrayContaining([
        'oauth_metadata_discovery',
        'oauth_issuer_match',
        'oauth_authorization_endpoint',
        'oauth_token_endpoint',
        'oauth_registration_endpoint',
        'oauth_response_type_code',
        'oauth_authorization_code',
        'oauth_refresh_token',
        'oauth_pkce_s256',
        'oauth_public_client',
        'oauth_jwks',
      ]),
    );
    expect(issuerChecks.every((check) => check.level === 'PASS')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every((call) => call[1]?.method === undefined)).toBe(true);
  });

  it('fails each missing generic-client OAuth capability with a repair instruction', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          issuer: 'https://id.example.com',
          authorization_endpoint: 'https://id.example.com/authorize',
          token_endpoint: 'https://id.example.com/token',
          jwks_uri: 'https://id.example.com/jwks',
          registration_endpoint: 'https://id.example.com/register',
        }),
      )
      .mockResolvedValueOnce(Response.json({ keys: [] }));
    vi.stubGlobal('fetch', fetchMock);
    writeFileSync(
      join(dir, 'server.ts'),
      `
import { customerAuth, server, tool, z } from '@noodleseed/one';
export default server('oidc_app', {
  title: 'OIDC App', version: '1.0.0',
  auth: customerAuth.oidc({ issuer: 'https://id.example.com', audience: 'api://oidc-app' })
}, [tool('whoami', {
  description: 'Show the caller', input: z.object({}),
  fulfil: ({ user }) => ({ subject: user.subject })
})]);
`,
    );

    expect(await run(['auth', 'doctor', 'server.ts', '--json'], {}, home)).toBe(1);
    const envelope = JSON.parse(output()) as {
      error: {
        detail: {
          checks: Array<{ code?: string; level: string; issuer?: string; fix?: string }>;
        };
      };
    };
    const failures = envelope.error.detail.checks.filter((check) => check.level === 'FAIL');
    expect(failures.map((check) => check.code)).toEqual(
      expect.arrayContaining([
        'oauth_authorization_code',
        'oauth_refresh_token',
        'oauth_pkce_s256',
        'oauth_public_client',
        'oauth_jwks',
      ]),
    );
    expect(
      failures.every((check) => check.issuer === 'https://id.example.com' && Boolean(check.fix)),
    ).toBe(true);
  });

  it('stops reading a chunked metadata response once the bounded JSON limit is exceeded', async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls <= 100) {
          controller.enqueue(new Uint8Array(64 * 1024).fill(32));
          return;
        }
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(body, { headers: { 'content-type': 'application/json' } })),
    );
    writeOidcServer('https://id.example.com');

    expect(await run(['auth', 'doctor', 'server.ts'], {}, home)).toBe(1);
    expect(output()).toContain('JSON response exceeds 262144 bytes');
    expect(pulls).toBeLessThanOrEqual(6);
    expect(cancelled).toBe(true);
  });

  it('cancels a response whose declared JSON length exceeds the limit', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([123]));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(body, {
          headers: { 'content-length': String(256 * 1024 + 1) },
        }),
      ),
    );
    writeOidcServer('https://id.example.com');

    expect(await run(['auth', 'doctor', 'server.ts'], {}, home)).toBe(1);
    expect(output()).toContain('JSON response exceeds 262144 bytes');
    expect(cancelled).toBe(true);
  });

  it('rejects encryption-only JWKS entries as public signing keys', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          issuer: 'https://id.example.com',
          authorization_endpoint: 'https://id.example.com/authorize',
          token_endpoint: 'https://id.example.com/token',
          jwks_uri: 'https://id.example.com/jwks',
          registration_endpoint: 'https://id.example.com/register',
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          keys: [
            {
              ...validRsaSigningJwk(),
              kid: 'encryption-key',
              use: 'enc',
              key_ops: ['encrypt'],
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    writeOidcServer('https://id.example.com');

    expect(await run(['auth', 'doctor', 'server.ts'], {}, home)).toBe(1);
    expect(output()).toContain('FAIL JWKS');
    expect(output()).toContain('no valid public signing keys');
  });

  it('rejects non-signing OKP curves as public signing keys', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          issuer: 'https://id.example.com',
          authorization_endpoint: 'https://id.example.com/authorize',
          token_endpoint: 'https://id.example.com/token',
          jwks_uri: 'https://id.example.com/jwks',
          registration_endpoint: 'https://id.example.com/register',
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          keys: [
            {
              kty: 'OKP',
              kid: 'key-agreement-only',
              use: 'sig',
              key_ops: ['verify'],
              crv: 'X25519',
              x: 'public-coordinate',
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    writeOidcServer('https://id.example.com');

    expect(await run(['auth', 'doctor', 'server.ts'], {}, home)).toBe(1);
    expect(output()).toContain('FAIL JWKS');
    expect(output()).toContain('no valid public signing keys');
  });

  it('rejects malformed fixed-width signing-key coordinates', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          issuer: 'https://id.example.com',
          authorization_endpoint: 'https://id.example.com/authorize',
          token_endpoint: 'https://id.example.com/token',
          jwks_uri: 'https://id.example.com/jwks',
          registration_endpoint: 'https://id.example.com/register',
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          keys: [
            {
              kty: 'EC',
              kid: 'malformed-coordinate',
              use: 'sig',
              key_ops: ['verify'],
              crv: 'P-256',
              x: 'A',
              y: 'A',
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    writeOidcServer('https://id.example.com');

    expect(await run(['auth', 'doctor', 'server.ts'], {}, home)).toBe(1);
    expect(output()).toContain('FAIL JWKS');
    expect(output()).toContain('no valid public signing keys');
  });

  it('cancels an unread non-200 JWKS response', async () => {
    let cancelled = false;
    const errorBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([32]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          issuer: 'https://id.example.com',
          authorization_endpoint: 'https://id.example.com/authorize',
          token_endpoint: 'https://id.example.com/token',
          jwks_uri: 'https://id.example.com/jwks',
          registration_endpoint: 'https://id.example.com/register',
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        }),
      )
      .mockResolvedValueOnce(new Response(errorBody, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    writeOidcServer('https://id.example.com');

    expect(await run(['auth', 'doctor', 'server.ts'], {}, home)).toBe(1);
    expect(output()).toContain('FAIL JWKS');
    expect(output()).toContain('HTTP 503');
    expect(cancelled).toBe(true);
  });

  it('redacts metadata endpoint queries from successful human diagnostics', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          issuer: 'https://id.example.com',
          authorization_endpoint: 'https://id.example.com/authorize?api_key=authorization-secret',
          token_endpoint: 'https://id.example.com/token?api_key=token-secret',
          jwks_uri: 'https://id.example.com/jwks?api_key=jwks-secret',
          registration_endpoint: 'https://id.example.com/register?api_key=registration-secret',
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          keys: [validRsaSigningJwk()],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    writeOidcServer('https://id.example.com');

    expect(await run(['auth', 'doctor', 'server.ts'], {}, home)).toBe(0);
    expect(output()).not.toContain('authorization-secret');
    expect(output()).not.toContain('token-secret');
    expect(output()).not.toContain('registration-secret');
    expect(output()).not.toContain('jwks-secret');
  });

  it('does not fetch JWKS or expose metadata values when the discovered issuer mismatches', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        issuer: 'https://attacker.example/oauth?token=issuer-secret',
        authorization_endpoint: 'https://attacker.example/authorize?token=authorize-secret',
        token_endpoint: 'https://attacker.example/token?token=token-secret',
        jwks_uri: 'https://attacker.example/jwks?token=jwks-secret',
        registration_endpoint: 'https://attacker.example/register?token=register-secret',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    writeOidcServer('https://id.example.com');

    expect(await run(['auth', 'doctor', 'server.ts'], {}, home)).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(output()).not.toContain('issuer-secret');
    expect(output()).not.toContain('authorize-secret');
    expect(output()).not.toContain('token-secret');
    expect(output()).not.toContain('jwks-secret');
    expect(output()).not.toContain('register-secret');
  });

  it('returns a stable redacted failure when the metadata request times out', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockRejectedValue(
          new DOMException(
            'request to https://id.example.com/oauth?token=timeout-secret timed out',
            'TimeoutError',
          ),
        ),
    );
    writeOidcServer('https://id.example.com');

    expect(await run(['auth', 'doctor', 'server.ts', '--json'], {}, home)).toBe(1);
    const envelope = JSON.parse(output()) as {
      error: { detail: { checks: Array<{ code: string; message: string }> } };
    };
    const discovery = envelope.error.detail.checks.find(
      (check) => check.code === 'oauth_metadata_discovery',
    );
    expect(discovery).toBeDefined();
    expect(discovery?.message).not.toContain('timeout-secret');
  });

  it('redacts query values from the configured issuer in JSON findings', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('missing', { status: 404 })),
    );
    writeOidcServer('https://id.example.com/oauth?token=configured-issuer-secret');

    expect(await run(['auth', 'doctor', 'server.ts', '--json'], {}, home)).toBe(1);
    expect(output()).not.toContain('configured-issuer-secret');
    const envelope = JSON.parse(output()) as {
      error: { detail: { checks: Array<{ issuer?: string; message: string }> } };
    };
    expect(
      envelope.error.detail.checks
        .filter((check) => check.issuer !== undefined)
        .every((check) => !check.issuer?.includes('?')),
    ).toBe(true);
  });

  it('redacts configured issuer query values from federated check names', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('missing', { status: 404 })),
    );
    writeFederatedOidcServer(
      'https://id.example.com/oauth?token=federated-configured-issuer-secret',
    );

    expect(await run(['auth', 'doctor', 'server.ts', '--json'], {}, home)).toBe(1);
    expect(output()).not.toContain('federated-configured-issuer-secret');
  });

  it('reports delegated token exchange connectors with their endpoint and downstream contract', async () => {
    writeFileSync(
      join(dir, 'server.ts'),
      `
import { connector, customerAuth, secret, server, tool, variable, z } from '@noodleseed/one';

const acmehr = connector('acmehr_api')
  .version('1.0.0')
  .http({
    baseUrl: 'https://app.acmehr.example/api/v1',
    allowedOrigins: ['https://app.acmehr.example'],
    auth: {
      kind: 'delegatedTokenExchange',
      tokenUrl: 'https://app.acmehr.example/api/assistant/oauth/token',
      clientId: variable('ACMEHR_DELEG_CLIENT_ID'),
      clientSecret: secret('ACMEHR_DELEG_CLIENT_SECRET'),
      scopes: ['time_off'],
    },
    operations: {
      list_time_off: {
        type: 'read',
        method: 'GET',
        path: '/teams/{team}/time-off',
        input: z.object({ team: z.string() }),
        output: z.object({ days: z.number() }),
      },
    },
  });

export default server('acmehr_assistant', {
  title: 'AcmeHr Assistant',
  version: '1.0.0',
  use: { acmehr },
  auth: customerAuth.firebase({ projectId: 'acmehr', apiKey: 'public-key' })
}, [
  tool('my_time_off', {
    description: 'Read the signed-in user time off.',
    input: z.object({ team: z.string() }),
    fulfil: ({ input, connectors }) => ({ result: connectors.acmehr.list_time_off({ team: input.team }) })
  })
]);
`,
    );

    expect(await run(['auth', 'doctor', 'server.ts'], {}, home)).toBe(0);
    expect(output()).toContain(
      'PASS Delegated token exchange: acmehr_api → https://app.acmehr.example/api/assistant/oauth/token',
    );
    expect(output()).toContain('ACMEHR_DELEG_CLIENT_SECRET');
    expect(output()).toContain('verify platform assertions against the deployment issuer JWKS');
  });

  it('fails delegated token exchange readiness without a customer identity source', async () => {
    writeFileSync(
      join(dir, 'server.ts'),
      `
import { connector, secret, server, tool, z } from '@noodleseed/one';

const acmehr = connector('acmehr_api')
  .version('1.0.0')
  .http({
    baseUrl: 'https://app.acmehr.example/api/v1',
    allowedOrigins: ['https://app.acmehr.example'],
    auth: {
      kind: 'delegatedTokenExchange',
      tokenUrl: 'https://app.acmehr.example/oauth/token',
      clientId: 'deleg-client-id',
      clientSecret: secret('ACMEHR_DELEG_CLIENT_SECRET'),
    },
    operations: {
      list_time_off: {
        type: 'read', method: 'GET', path: '/time-off',
        output: z.object({ days: z.number() }),
      },
    },
  });

export default server('broken_exchange', {
  title: 'Broken Exchange', version: '1.0.0', use: { acmehr }
}, [tool('my_time_off', {
  description: 'Read time off.', input: z.object({}),
  fulfil: ({ connectors }) => ({ result: connectors.acmehr.list_time_off({}) })
})]);
`,
    );

    expect(await run(['auth', 'doctor', 'server.ts', '--json'], {}, home)).toBe(1);
    const envelope = JSON.parse(output()) as {
      error: {
        detail: { checks: Array<{ code: string; level: string; name: string; fix?: string }> };
      };
    };
    expect(envelope.error.detail.checks).toContainEqual(
      expect.objectContaining({
        code: 'delegated_token_exchange_identity_required',
        level: 'FAIL',
        name: 'Customer identity source',
        fix: expect.stringContaining('customerAuth'),
      }),
    );
    expect(JSON.stringify(envelope)).toContain('embeddedAssistant');
    expect(JSON.stringify(envelope)).not.toContain('https://app.acmehr.example/oauth/token');
    expect(JSON.stringify(envelope)).not.toContain('deleg-client-id');
    expect(JSON.stringify(envelope)).not.toContain('ACMEHR_DELEG_CLIENT_SECRET');
  });

  it('flags a managed delegated provider that does not pair with the declared customer auth', async () => {
    writeFileSync(
      join(dir, 'server.ts'),
      `
import { connector, server, tool, z } from '@noodleseed/one';

const appApi = connector('app_api')
  .version('1.0.0')
  .http({
    baseUrl: 'https://dev.noodleseed.com/api',
    allowedOrigins: ['https://dev.noodleseed.com'],
    auth: { kind: 'delegatedOAuth', provider: 'firebase' },
    operations: {
      list_apps: {
        type: 'read',
        method: 'GET',
        path: '/apps',
        output: z.object({ ok: z.boolean() }),
      },
    },
  });

export default server('unpaired_app', {
  title: 'Unpaired App',
  version: '1.0.0',
  use: { app_api: appApi },
}, [
  tool('list_apps', {
    description: 'List apps.',
    input: z.object({}),
    fulfil: ({ connectors }) => ({ result: connectors.app_api.list_apps({}) })
  })
]);
`,
    );

    expect(await run(['auth', 'doctor', 'server.ts'], {}, home)).toBe(1);
    expect(output()).toContain('FAIL Delegated provider pairing');
    expect(output()).toContain('customerAuth');
  });
});

function output(): string {
  return logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
}

function writeOidcServer(issuer: string): void {
  writeFileSync(
    join(dir, 'server.ts'),
    `
import { customerAuth, server, tool, z } from '@noodleseed/one';
export default server('oidc_app', {
  title: 'OIDC App',
  version: '1.0.0',
  auth: customerAuth.oidc({ issuer: '${issuer}', audience: 'api://oidc-app' })
}, [tool('whoami', {
  description: 'Show the caller',
  input: z.object({}),
  fulfil: ({ user }) => ({ subject: user.subject })
})]);
`,
  );
}

function writeFederatedOidcServer(issuer: string): void {
  writeFileSync(
    join(dir, 'server.ts'),
    `
import { customerAuth, server, tool, z } from '@noodleseed/one';
export default server('federated_oidc_app', {
  title: 'Federated OIDC App',
  version: '1.0.0',
  auth: customerAuth.federatedOidc({
    issuers: [{ issuer: '${issuer}', audience: 'api://oidc-app' }]
  })
}, [tool('whoami', {
  description: 'Show the caller',
  input: z.object({}),
  fulfil: ({ user }) => ({ subject: user.subject })
})]);
`,
  );
}

function validRsaSigningJwk(): Record<string, unknown> {
  return {
    kty: 'RSA',
    kid: 'signing-key',
    use: 'sig',
    n: Buffer.alloc(256, 0xff).toString('base64url'),
    e: 'AQAB',
  };
}
