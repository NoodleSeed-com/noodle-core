import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/index.js';

const SERVICE = 'https://cloud.example';
const TOKEN = 'operator-token-never-print';
const PRINCIPAL = 'spn_00000000-0000-4000-8000-000000000001';
const GRANT = 'spg_00000000-0000-4000-8000-000000000002';
const CREDENTIAL = 'spc_00000000-0000-4000-8000-000000000003';
const SECRET = 'abcdefghijklmnopqrstuvwxyzABCDEFGH123456789';

let home: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-service-principal-cli-'));
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe('noodle auth service-principals', () => {
  it('creates, lists, and shows principals over the exact organization-scoped API', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ ok: true, data: principal('nightly sync') }, 201))
      .mockResolvedValueOnce(json({ ok: true, data: [principal('nightly sync')] }))
      .mockResolvedValueOnce(
        json({
          ok: true,
          data: {
            principal: principal('nightly sync'),
            grants: [],
            credentials: [
              {
                credentialId: CREDENTIAL,
                principalId: PRINCIPAL,
                kind: 'client_secret',
                label: 'primary',
                status: 'active',
                secret: SECRET,
                secretDigest: 'must-not-print',
                publicJwk: { kty: 'RSA', d: 'must-not-print' },
                createdBySubject: 'human-1',
                createdAt: '2026-08-03T00:00:00.000Z',
                updatedAt: '2026-08-03T00:00:00.000Z',
              },
            ],
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    expect(await cli(['create', 'nightly sync', '--json'])).toBe(0);
    expect(request(fetchMock, 0)).toMatchObject({
      url: `${SERVICE}/v1/orgs/acme/service-principals`,
      method: 'POST',
      body: { name: 'nightly sync' },
    });

    logSpy.mockClear();
    expect(await cli(['list', '--json'])).toBe(0);
    expect(request(fetchMock, 1)).toMatchObject({
      url: `${SERVICE}/v1/orgs/acme/service-principals`,
      method: 'GET',
    });

    logSpy.mockClear();
    expect(await cli(['show', PRINCIPAL, '--json'])).toBe(0);
    expect(request(fetchMock, 2)).toMatchObject({
      url: `${SERVICE}/v1/orgs/acme/service-principals/${PRINCIPAL}`,
      method: 'GET',
    });
    expect(stdout()).not.toContain(SECRET);
    expect(stdout()).not.toContain('must-not-print');
    expect(request(fetchMock, 2).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('creates a target grant with repeated scopes and explicit target overrides', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        ok: true,
        data: {
          grantId: GRANT,
          principalId: PRINCIPAL,
          org: 'acme',
          app: 'todoist',
          environment: 'prod',
          scopes: ['todos.read', 'todos.write'],
          status: 'active',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(
      await cli([
        'grant',
        PRINCIPAL,
        '--app',
        'todoist',
        '--env',
        'prod',
        '--scope',
        'todos.read',
        '--scope',
        'todos.write',
        '--json',
      ]),
    ).toBe(0);

    expect(request(fetchMock, 0)).toMatchObject({
      url: `${SERVICE}/v1/orgs/acme/service-principals/${PRINCIPAL}/grants`,
      method: 'POST',
      body: {
        app: 'todoist',
        environment: 'prod',
        scopes: ['todos.read', 'todos.write'],
      },
    });
  });

  it('adds an explicit public JWK file without printing key material', async () => {
    const jwk = {
      kty: 'RSA',
      alg: 'RS256',
      kid: 'automation-2026-08',
      n: 'public-modulus-never-print',
      e: 'AQAB',
    };
    const file = join(home, 'public.jwk.json');
    writeFileSync(file, JSON.stringify(jwk));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        ok: true,
        data: {
          credentialId: CREDENTIAL,
          principalId: PRINCIPAL,
          kind: 'public_jwk',
          label: 'primary',
          algorithm: 'RS256',
          kid: jwk.kid,
          status: 'active',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(
      await cli([
        'add-jwk',
        PRINCIPAL,
        '--label',
        'primary',
        '--file',
        file,
        '--expires-at',
        '2027-08-03T00:00:00.000Z',
        '--json',
      ]),
    ).toBe(0);

    expect(request(fetchMock, 0)).toMatchObject({
      url: `${SERVICE}/v1/orgs/acme/service-principals/${PRINCIPAL}/credentials`,
      method: 'POST',
      body: {
        kind: 'public_jwk',
        label: 'primary',
        algorithm: 'RS256',
        publicJwk: jwk,
        expiresAt: '2027-08-03T00:00:00.000Z',
      },
    });
    expect(allOutput()).not.toContain(jwk.n);
  });

  it.each([
    'd',
    'p',
    'q',
    'dp',
    'dq',
    'qi',
    'oth',
    'k',
  ])('rejects private JWK member %s locally before fetch', async (member) => {
    const file = join(home, 'private.jwk.json');
    writeFileSync(
      file,
      JSON.stringify({
        kty: 'RSA',
        alg: 'RS256',
        n: 'n',
        e: 'AQAB',
        [member]: 'highly-sensitive-key-value',
      }),
    );
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    expect(await cli(['add-jwk', PRINCIPAL, '--label', 'bad', '--file', file, '--json'])).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(stdout())).toMatchObject({
      ok: false,
      error: { code: 'private_jwk_forbidden' },
    });
    expect(allOutput()).not.toContain('highly-sensitive-key-value');
  });

  it('returns a generated secret once and gives safe handoff guidance in plain output', async () => {
    const response = {
      ok: true,
      data: {
        credentialId: CREDENTIAL,
        principalId: PRINCIPAL,
        kind: 'client_secret',
        label: 'primary',
        status: 'active',
        secret: SECRET,
      },
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json(response, 201));
    vi.stubGlobal('fetch', fetchMock);

    expect(
      await cli([
        'create-secret',
        PRINCIPAL,
        '--label',
        'primary',
        '--expires-at',
        '2027-08-03T00:00:00.000Z',
        '--json',
      ]),
    ).toBe(0);
    expect(JSON.parse(stdout())).toMatchObject({ ok: true, data: { secret: SECRET } });
    expect(request(fetchMock, 0).body).toEqual({
      kind: 'client_secret',
      label: 'primary',
      expiresAt: '2027-08-03T00:00:00.000Z',
    });

    logSpy.mockClear();
    fetchMock.mockResolvedValueOnce(json(response, 201));
    expect(await cli(['create-secret', PRINCIPAL, '--label', 'primary'])).toBe(0);
    expect(stdout()).toContain(SECRET);
    expect(stdout()).toContain('external secrets manager');
    expect(stdout()).toContain('cannot be retrieved later');
    expect(allOutput()).not.toContain(TOKEN);
  });

  it.each([
    ['revoke-grant', [PRINCIPAL, GRANT], `${PRINCIPAL}/grants/${GRANT}`],
    ['revoke-credential', [PRINCIPAL, CREDENTIAL], `${PRINCIPAL}/credentials/${CREDENTIAL}`],
    ['revoke', [PRINCIPAL], PRINCIPAL],
  ] as const)('%s requires --yes non-interactively and then sends the exact DELETE', async (action, identifiers, suffix) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await cli([action, ...identifiers, '--json'])).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(stdout())).toMatchObject({
      ok: false,
      error: { code: 'confirmation_required', next: expect.stringContaining('--yes') },
    });

    logSpy.mockClear();
    expect(await cli([action, ...identifiers, '--yes', '--json'])).toBe(0);
    expect(request(fetchMock, 0)).toMatchObject({
      url: `${SERVICE}/v1/orgs/acme/service-principals/${suffix}`,
      method: 'DELETE',
    });
  });

  it('reports strict usage failures without contacting the service or leaking auth material', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    expect(await cli(['grant', PRINCIPAL, '--app', 'todoist', '--json'])).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(stdout())).toMatchObject({ ok: false, error: { code: 'usage_error' } });
    expect(allOutput()).not.toContain(TOKEN);
  });
});

function cli(rest: readonly string[]): Promise<number> {
  return run(
    [
      'auth',
      'service-principals',
      ...rest,
      '--org',
      'acme',
      '--service',
      SERVICE,
      '--auth-token',
      TOKEN,
    ],
    {},
    home,
  );
}

function request(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, index: number) {
  const call = fetchMock.mock.calls[index];
  const init = call?.[1];
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  return {
    url: String(call?.[0]),
    method: init?.method ?? 'GET',
    authorization: new Headers(init?.headers).get('authorization'),
    body,
  };
}

function principal(name: string) {
  return {
    principalId: PRINCIPAL,
    org: 'acme',
    name,
    status: 'active',
    createdBySubject: 'human-1',
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function stdout(): string {
  return logSpy.mock.calls.map(([line]) => String(line)).join('\n');
}

function allOutput(): string {
  return `${stdout()}\n${errorSpy.mock.calls.map(([line]) => String(line)).join('\n')}`;
}
