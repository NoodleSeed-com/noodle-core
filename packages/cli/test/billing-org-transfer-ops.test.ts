import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertBillingTransferArtifactDestination,
  installBillingTransferArtifactNoReplace,
} from '../src/commands/billing-org-transfer-files.js';
import { run, writeConfig } from '../src/index.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';

const SERVICE = 'https://svc.example';
const OTHER_SERVICE = 'https://other.example';
const TOKEN = 'SECRET_TOKEN';
const ACCOUNT = 'ba_00000000-0000-0000-0000-000000000001';
const OTHER_ACCOUNT = 'ba_00000000-0000-0000-0000-000000000002';
const ORG = 'acme';
const KEY = 'private-transfer-key';
const REASON = 'support case 1234';
const SOURCE_MARKER = 'ba_source-private-marker';
const ENV = { NOODLE_DISABLE_UPDATE_CHECK: '1' };

const CANDIDATES = {
  ok: true,
  responseFuture: 'accepted',
  data: {
    schemaVersion: 1,
    dataFuture: 'accepted',
    items: [
      {
        organization: { slug: ORG, displayName: 'Acme', organizationFuture: 'accepted' },
        state: 'blocked',
        warnings: ['currently_paid_elsewhere', 'lower_plan', 'capability_loss'],
        blockers: [
          'already_linked',
          'billing_setup_incomplete',
          'destination_ineligible',
          'destination_capacity_exceeded',
        ],
        itemFuture: 'accepted',
      },
    ],
    nextCursor: 'next-page',
  },
} as const;

const PREVIEW = {
  schemaVersion: 1,
  organization: { slug: ORG, displayName: 'Acme' },
  destination: {
    id: ACCOUNT,
    displayName: 'Bob Scale',
    state: 'active',
    plan: { code: 'scale', version: 1 },
    linkedOrganizationCount: 2,
  },
  currentPlan: { code: 'pro', version: 1 },
  resultingPlan: { code: 'scale', version: 1 },
  linkedOrganizationCounts: { current: 2, prospective: 3 },
  productionCapacity: {
    current: 3,
    organizationContribution: 1,
    prospective: 4,
    limit: 10,
  },
  lostCapabilityIds: ['apps.private', 'usage.mcp_calls.included'],
  fallback: 'home_free',
  warnings: ['currently_paid_elsewhere', 'lower_plan', 'capability_loss'],
  blockers: [],
  expectedLinkVersion: 4,
  previewChecksum: 'a'.repeat(64),
  previewedAt: '2026-09-02T12:00:00.000Z',
} as const;

const APPLY = {
  schemaVersion: 1,
  operationId: 'boto_00000000-0000-0000-0000-000000000001',
  organization: PREVIEW.organization,
  destination: { ...PREVIEW.destination, linkedOrganizationCount: 3 },
  resultingPlan: PREVIEW.resultingPlan,
  productionCapacity: PREVIEW.productionCapacity,
  fallback: 'home_free',
  resultingLinkVersion: 5,
  effectiveAt: '2026-09-02T12:00:01.000Z',
  recordedAt: '2026-09-02T12:00:01.000Z',
  warnings: PREVIEW.warnings,
  replayed: false,
} as const;

type CapturedRequest = {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly body: unknown;
};

let home: string;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-billing-org-transfer-'));
  chdirIsolated(home);
  writeConfig({ serviceUrl: SERVICE, authToken: TOKEN }, home);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  restoreCwd();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

function stdout(): string {
  return log.mock.calls.map((call) => String(call[0])).join('\n');
}

function stderr(): string {
  return error.mock.calls.map((call) => String(call[0])).join('\n');
}

function stubService(routes: Readonly<Record<string, unknown>>, status = 200): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const headers = new Headers(init?.headers);
      requests.push({
        url,
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization'),
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      const body = routes[url];
      if (body === undefined) throw new Error(`unexpected request: ${url}`);
      return Response.json(body, { status });
    }),
  );
  return requests;
}

function artifactPath(name = 'reviewed-preview.json'): string {
  return join(home, name);
}

function customerPreviewArgs(out = artifactPath(), ...extra: string[]): string[] {
  return [
    'billing',
    'org',
    'transfer',
    'preview',
    ORG,
    '--account',
    ACCOUNT,
    '--out',
    out,
    ...extra,
  ];
}

function customerApplyArgs(file = artifactPath(), ...extra: string[]): string[] {
  return [
    'billing',
    'org',
    'transfer',
    'apply',
    '--preview-file',
    file,
    '--idempotency-key',
    KEY,
    '--yes',
    ...extra,
  ];
}

function adminPreviewArgs(out = artifactPath(), ...extra: string[]): string[] {
  return [
    'billing',
    'administration',
    'transfer',
    'preview',
    '--org',
    ORG,
    '--account',
    ACCOUNT,
    '--reason',
    REASON,
    '--out',
    out,
    ...extra,
  ];
}

function adminApplyArgs(file = artifactPath(), ...extra: string[]): string[] {
  return [
    'billing',
    'administration',
    'transfer',
    'apply',
    '--preview-file',
    file,
    '--idempotency-key',
    KEY,
    '--yes',
    ...extra,
  ];
}

function writeArtifact(
  authorityPath: 'customer' | 'super_admin',
  overrides: Record<string, unknown> = {},
  path = artifactPath(),
): string {
  const request =
    authorityPath === 'customer'
      ? { schemaVersion: 1, organizationSlug: ORG, destinationBillingAccountId: ACCOUNT }
      : {
          schemaVersion: 1,
          organizationSlug: ORG,
          destinationBillingAccountId: ACCOUNT,
          administrativeReason: REASON,
        };
  writeFileSync(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      serviceOrigin: SERVICE,
      authorityPath,
      request,
      preview: PREVIEW,
      ...overrides,
    })}\n`,
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
  return path;
}

describe('customer billing organization transfer commands', () => {
  it('lists candidates with exact bounded query parameters and additive response parsing', async () => {
    const url = `${SERVICE}/v1/billing-accounts/${ACCOUNT}/organization-transfer-candidates?query=Alice+%26+Bob&cursor=page%2F2&limit=25`;
    const requests = stubService({ [url]: CANDIDATES });

    expect(
      await run(
        [
          'billing',
          'org',
          'transfer',
          'candidates',
          '--account',
          ACCOUNT,
          '--query',
          'Alice & Bob',
          '--cursor',
          'page/2',
          '--limit',
          '25',
          '--json',
        ],
        ENV,
        home,
      ),
    ).toBe(0);
    expect(requests).toEqual([
      { url, method: 'GET', authorization: `Bearer ${TOKEN}`, body: undefined },
    ]);
    const output = JSON.parse(stdout());
    expect(output).toEqual({
      ok: true,
      data: {
        service: SERVICE,
        candidates: {
          schemaVersion: 1,
          items: [
            {
              organization: { slug: ORG, displayName: 'Acme' },
              state: 'blocked',
              warnings: ['currently_paid_elsewhere', 'lower_plan', 'capability_loss'],
              blockers: [
                'already_linked',
                'billing_setup_incomplete',
                'destination_ineligible',
                'destination_capacity_exceeded',
              ],
            },
          ],
          nextCursor: 'next-page',
        },
      },
    });
    expect(stdout()).not.toContain('responseFuture');
    expect(stderr()).toBe('');
  });

  it('renders every candidate warning and blocker for agents in human mode', async () => {
    const url = `${SERVICE}/v1/billing-accounts/${ACCOUNT}/organization-transfer-candidates?limit=50`;
    stubService({ [url]: CANDIDATES });

    expect(
      await run(['billing', 'org', 'transfer', 'candidates', '--account', ACCOUNT], ENV, home),
    ).toBe(0);
    for (const code of [
      ...CANDIDATES.data.items[0].warnings,
      ...CANDIDATES.data.items[0].blockers,
    ]) {
      expect(stdout()).toContain(code);
    }
    expect(stdout()).toContain('Next cursor: next-page');
  });

  it('previews the exact customer request and atomically writes one normalized private artifact', async () => {
    const route = `${SERVICE}/v1/orgs/${ORG}/billing-transfer/preview`;
    const requests = stubService({
      [route]: { ok: true, responseFuture: true, data: { ...PREVIEW, future: true } },
    });
    const out = artifactPath();

    expect(
      await run(customerPreviewArgs(out, '--service', `${SERVICE}/`, '--json'), ENV, home),
    ).toBe(0);
    expect(requests).toEqual([
      {
        url: route,
        method: 'POST',
        authorization: `Bearer ${TOKEN}`,
        body: { schemaVersion: 1, destinationBillingAccountId: ACCOUNT },
      },
    ]);
    expect(lstatSync(out).mode & 0o777).toBe(0o600);
    expect(readdirSync(home).filter((name) => name.includes('.tmp'))).toEqual([]);
    const artifact = JSON.parse(readFileSync(out, 'utf8'));
    expect(artifact).toEqual({
      schemaVersion: 1,
      serviceOrigin: SERVICE,
      authorityPath: 'customer',
      request: { schemaVersion: 1, organizationSlug: ORG, destinationBillingAccountId: ACCOUNT },
      preview: PREVIEW,
    });
    expect(JSON.parse(stdout())).toEqual({
      ok: true,
      data: {
        service: SERVICE,
        authority: 'customer',
        preview: PREVIEW,
        previewFile: out,
      },
    });
  });

  it('writes and renders a blocked preview with every warning and blocker', async () => {
    const blocked = {
      ...PREVIEW,
      blockers: CANDIDATES.data.items[0].blockers,
    };
    stubService({
      [`${SERVICE}/v1/orgs/${ORG}/billing-transfer/preview`]: { ok: true, data: blocked },
    });

    expect(await run(customerPreviewArgs(), ENV, home)).toBe(1);
    for (const code of [...blocked.warnings, ...blocked.blockers]) expect(stdout()).toContain(code);
    expect(stdout()).toContain('Billing organization transfer preview: BLOCKED');
    expect(lstatSync(artifactPath()).isFile()).toBe(true);
  });

  it('forces the final artifact to mode 0600 even under a restrictive process umask', async () => {
    stubService({
      [`${SERVICE}/v1/orgs/${ORG}/billing-transfer/preview`]: { ok: true, data: PREVIEW },
    });
    const previousUmask = process.umask(0o777);
    try {
      expect(await run(customerPreviewArgs(), ENV, home)).toBe(0);
    } finally {
      process.umask(previousUmask);
    }

    expect(lstatSync(artifactPath()).mode & 0o777).toBe(0o600);
  });

  it('applies only the exact reviewed request and does not re-preview', async () => {
    writeArtifact('customer');
    const route = `${SERVICE}/v1/orgs/${ORG}/billing-transfer`;
    const requests = stubService({
      [route]: { ok: true, data: { ...APPLY, responseFuture: 'accepted', [SOURCE_MARKER]: true } },
    });

    expect(await run(customerApplyArgs(artifactPath(), '--json'), ENV, home)).toBe(0);
    expect(requests).toEqual([
      {
        url: route,
        method: 'POST',
        authorization: `Bearer ${TOKEN}`,
        body: {
          schemaVersion: 1,
          destinationBillingAccountId: ACCOUNT,
          expectedLinkVersion: PREVIEW.expectedLinkVersion,
          previewChecksum: PREVIEW.previewChecksum,
          idempotencyKey: KEY,
          confirmed: true,
        },
      },
    ]);
    expect(JSON.parse(stdout())).toEqual({
      ok: true,
      data: { service: SERVICE, authority: 'customer', transfer: APPLY },
    });
    expect(stdout()).not.toContain(KEY);
    expect(stdout()).not.toContain(SOURCE_MARKER);
  });
});

describe('super-admin billing organization transfer commands', () => {
  it('previews the exact privileged request and deliberately renders the reviewed reason', async () => {
    const route = `${SERVICE}/v1/billing-administration/organization-transfers/preview`;
    const requests = stubService({ [route]: { ok: true, data: PREVIEW } });

    expect(await run(adminPreviewArgs(artifactPath(), '--json'), ENV, home)).toBe(0);
    expect(requests[0]).toEqual({
      url: route,
      method: 'POST',
      authorization: `Bearer ${TOKEN}`,
      body: {
        schemaVersion: 1,
        organizationSlug: ORG,
        destinationBillingAccountId: ACCOUNT,
        administrativeReason: REASON,
      },
    });
    expect(JSON.parse(stdout())).toMatchObject({
      ok: true,
      data: { authority: 'super_admin', administrativeReason: REASON, preview: PREVIEW },
    });
    expect(JSON.parse(readFileSync(artifactPath(), 'utf8'))).toMatchObject({
      authorityPath: 'super_admin',
      request: { administrativeReason: REASON },
    });
  });

  it('applies the exact privileged artifact and renders all warnings without the reason or key', async () => {
    writeArtifact('super_admin');
    const route = `${SERVICE}/v1/billing-administration/organization-transfers`;
    const requests = stubService({ [route]: { ok: true, data: APPLY } });

    expect(await run(adminApplyArgs(artifactPath()), ENV, home)).toBe(0);
    expect(requests[0]).toEqual({
      url: route,
      method: 'POST',
      authorization: `Bearer ${TOKEN}`,
      body: {
        schemaVersion: 1,
        organizationSlug: ORG,
        destinationBillingAccountId: ACCOUNT,
        administrativeReason: REASON,
        expectedLinkVersion: PREVIEW.expectedLinkVersion,
        previewChecksum: PREVIEW.previewChecksum,
        idempotencyKey: KEY,
        confirmed: true,
      },
    });
    for (const warning of APPLY.warnings) expect(stdout()).toContain(warning);
    expect(stdout()).not.toContain(REASON);
    expect(stdout()).not.toContain(KEY);
  });
});

describe('billing organization transfer local safety', () => {
  it('rejects duplicate transfer options before authentication or fetch', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    expect(
      await run(
        customerPreviewArgs(artifactPath(), '--account', OTHER_ACCOUNT, '--json'),
        ENV,
        home,
      ),
    ).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(stdout())).toMatchObject({ ok: false, error: { code: 'usage_error' } });
  });

  it.each([
    ['candidates account', ['billing', 'org', 'transfer', 'candidates']],
    [
      'customer preview org',
      ['billing', 'org', 'transfer', 'preview', '--account', ACCOUNT, '--out', 'preview.json'],
    ],
    [
      'customer preview account',
      ['billing', 'org', 'transfer', 'preview', ORG, '--out', 'preview.json'],
    ],
    ['customer preview out', ['billing', 'org', 'transfer', 'preview', ORG, '--account', ACCOUNT]],
    [
      'customer apply file',
      ['billing', 'org', 'transfer', 'apply', '--idempotency-key', KEY, '--yes'],
    ],
    [
      'customer apply key',
      ['billing', 'org', 'transfer', 'apply', '--preview-file', 'preview.json', '--yes'],
    ],
    [
      'customer apply yes',
      [
        'billing',
        'org',
        'transfer',
        'apply',
        '--preview-file',
        'preview.json',
        '--idempotency-key',
        KEY,
      ],
    ],
    [
      'admin preview org',
      [
        'billing',
        'administration',
        'transfer',
        'preview',
        '--account',
        ACCOUNT,
        '--reason',
        REASON,
        '--out',
        'preview.json',
      ],
    ],
    [
      'admin preview reason',
      [
        'billing',
        'administration',
        'transfer',
        'preview',
        '--org',
        ORG,
        '--account',
        ACCOUNT,
        '--out',
        'preview.json',
      ],
    ],
    [
      'admin apply yes',
      [
        'billing',
        'administration',
        'transfer',
        'apply',
        '--preview-file',
        'preview.json',
        '--idempotency-key',
        KEY,
      ],
    ],
  ] as const)('requires %s before authentication or fetch', async (_label, argv) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    expect(await run([...argv, '--json'], ENV, home)).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(stdout())).toMatchObject({ ok: false, error: { code: 'usage_error' } });
  });

  it('refuses every existing preview destination before fetch and requires a new path', async () => {
    const target = artifactPath('target.json');
    writeFileSync(target, 'do not replace', { mode: 0o600 });
    const link = artifactPath('linked.json');
    symlinkSync(target, link);
    const directory = artifactPath('directory');
    mkdirSync(directory);

    for (const out of [target, link, directory]) {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      expect(await run(customerPreviewArgs(out, '--json'), ENV, home)).toBe(1);
      expect(fetch).not.toHaveBeenCalled();
      expect(stdout()).not.toContain('do not replace');
      expect(JSON.parse(stdout()).error.fix).toContain('new output path');
      vi.unstubAllGlobals();
      log.mockClear();
    }
    expect(readFileSync(target, 'utf8')).toBe('do not replace');
  });

  it('does not replace an entry raced into place after validation and cleans its temporary file', async () => {
    const destination = artifactPath('raced.json');
    const temporary = artifactPath('raced.tmp');
    const target = artifactPath('raced-target.json');

    await assertBillingTransferArtifactDestination(destination);
    writeFileSync(temporary, 'private reviewed bytes', { mode: 0o600 });
    chmodSync(temporary, 0o600);
    writeFileSync(target, 'raced entry remains', { mode: 0o600 });
    symlinkSync(target, destination);

    await expect(installBillingTransferArtifactNoReplace(temporary, destination)).rejects.toThrow();
    expect(lstatSync(destination).isSymbolicLink()).toBe(true);
    expect(readlinkSync(destination)).toBe(target);
    expect(readFileSync(target, 'utf8')).toBe('raced entry remains');
    expect(existsSync(temporary)).toBe(false);
  });

  it('rejects malformed, non-private, symlinked, and authority-mismatched artifacts before fetch', async () => {
    const cases: Array<{ file: string; argv: string[] }> = [];
    const malformed = artifactPath('malformed.json');
    writeFileSync(malformed, '{private-malformed-marker', { mode: 0o600 });
    cases.push({ file: malformed, argv: customerApplyArgs(malformed, '--json') });
    const publicFile = writeArtifact('customer', {}, artifactPath('public.json'));
    chmodSync(publicFile, 0o644);
    cases.push({ file: publicFile, argv: customerApplyArgs(publicFile, '--json') });
    const target = writeArtifact('customer', {}, artifactPath('target.json'));
    const link = artifactPath('link.json');
    symlinkSync(target, link);
    cases.push({ file: link, argv: customerApplyArgs(link, '--json') });
    const wrongAuthority = writeArtifact('customer', {}, artifactPath('wrong-authority.json'));
    cases.push({ file: wrongAuthority, argv: adminApplyArgs(wrongAuthority, '--json') });

    for (const { file, argv } of cases) {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      expect(await run(argv, ENV, home)).toBe(1);
      expect(fetch).not.toHaveBeenCalled();
      expect(stdout()).toContain(file);
      expect(stdout()).not.toContain('private-malformed-marker');
      vi.unstubAllGlobals();
      log.mockClear();
    }
  });

  it('rejects origin, request, checksum, version, blockers, and unknown artifact fields before fetch', async () => {
    const invalid: Array<{ name: string; overrides: Record<string, unknown> }> = [
      ['origin', { serviceOrigin: OTHER_SERVICE }],
      [
        'request',
        {
          request: {
            schemaVersion: 1,
            organizationSlug: ORG,
            destinationBillingAccountId: OTHER_ACCOUNT,
          },
        },
      ],
      [
        'organization',
        {
          request: {
            schemaVersion: 1,
            organizationSlug: 'different-org',
            destinationBillingAccountId: ACCOUNT,
          },
        },
      ],
      ['checksum', { preview: { ...PREVIEW, previewChecksum: 'A'.repeat(64) } }],
      ['version', { preview: { ...PREVIEW, expectedLinkVersion: 0 } }],
      ['blockers', { preview: { ...PREVIEW, blockers: ['already_linked'] } }],
      ['unknown', { unexpected: true }],
    ];

    for (const { 0: name, 1: overrides } of invalid) {
      const file = writeArtifact('customer', overrides, artifactPath(`${name}.json`));
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      expect(await run(customerApplyArgs(file, '--json'), ENV, home)).toBe(1);
      expect(fetch).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
      log.mockClear();
    }
  });

  it('rejects an origin mismatch before token refresh can make a network request', async () => {
    writeConfig(
      {
        serviceUrl: SERVICE,
        authToken: 'expired-token',
        authTokenExpiresAt: '2020-01-01T00:00:00.000Z',
        oauthRefreshToken: 'private-refresh-token',
        oauthClientId: 'cli-client',
        oauthIssuer: 'https://issuer.example',
      },
      home,
    );
    const file = writeArtifact('customer', { serviceOrigin: OTHER_SERVICE });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    expect(await run(customerApplyArgs(file, '--json'), ENV, home)).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      'candidate --service',
      [
        'billing',
        'org',
        'transfer',
        'candidates',
        '--account',
        ACCOUNT,
        '--service',
        `${SERVICE}/path`,
      ],
      ENV,
    ],
    [
      'preview environment',
      ['billing', 'org', 'transfer', 'preview', ORG, '--account', ACCOUNT, '--out', 'preview.json'],
      { ...ENV, NOODLE_SERVICE_URL: 'not-a-url' },
    ],
  ] as const)('returns one stable failure for a malformed or path-bearing %s origin', async (_label, argv, env) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(run([...argv, '--json'], env, home)).resolves.toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(stdout())).toMatchObject({
      ok: false,
      error: { code: 'invalid_service_origin' },
    });
  });

  it('rejects config and artifact path-bearing origins before token refresh or apply fetch', async () => {
    const refreshConfig = {
      authToken: 'expired-token',
      authTokenExpiresAt: '2020-01-01T00:00:00.000Z',
      oauthRefreshToken: 'private-refresh-token',
      oauthClientId: 'cli-client',
      oauthIssuer: 'https://issuer.example',
    } as const;
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    writeConfig({ ...refreshConfig, serviceUrl: `${SERVICE}/path` }, home);
    writeArtifact('customer');
    await expect(run(customerApplyArgs(artifactPath(), '--json'), ENV, home)).resolves.toBe(2);
    expect(JSON.parse(stdout())).toMatchObject({
      ok: false,
      error: { code: 'invalid_service_origin' },
    });
    expect(fetch).not.toHaveBeenCalled();

    log.mockClear();
    writeConfig({ ...refreshConfig, serviceUrl: SERVICE }, home);
    writeArtifact('customer', { serviceOrigin: `${SERVICE}/path` });
    await expect(run(customerApplyArgs(artifactPath(), '--json'), ENV, home)).resolves.toBe(1);
    expect(JSON.parse(stdout())).toMatchObject({
      ok: false,
      error: { code: 'invalid_billing_transfer_preview_file' },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('redacts known private values from a blocked artifact location in JSON and human output', async () => {
    const privatePath = artifactPath(`${KEY}-${REASON}.json`);
    writeArtifact(
      'super_admin',
      { preview: { ...PREVIEW, blockers: ['already_linked'] } },
      privatePath,
    );

    for (const extra of [['--json'], []] as const) {
      expect(await run(adminApplyArgs(privatePath, ...extra), ENV, home)).toBe(1);
      expect(`${stdout()}\n${stderr()}`).not.toContain(KEY);
      expect(`${stdout()}\n${stderr()}`).not.toContain(REASON);
      log.mockClear();
      error.mockClear();
    }
  });

  it('retries an ambiguous apply with byte-equivalent reviewed input and the same private key', async () => {
    writeArtifact('customer');
    const requests: CapturedRequest[] = [];
    let attempt = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: input.toString(),
          method: init?.method ?? 'GET',
          authorization: new Headers(init?.headers).get('authorization'),
          body: JSON.parse(String(init?.body)),
        });
        attempt++;
        if (attempt === 1) throw new Error(`uncertain ${KEY} ${SOURCE_MARKER}`);
        return Response.json({ ok: true, data: { ...APPLY, replayed: true } });
      }),
    );

    expect(await run(customerApplyArgs(artifactPath(), '--json'), ENV, home)).toBe(4);
    expect(stdout()).not.toContain(KEY);
    expect(stdout()).not.toContain(SOURCE_MARKER);
    log.mockClear();
    expect(await run(customerApplyArgs(artifactPath(), '--json'), ENV, home)).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(JSON.parse(stdout())).toMatchObject({
      ok: true,
      data: { transfer: { replayed: true } },
    });
  });

  it('never exposes an admin reason, key, or source identity through service failure diagnostics', async () => {
    writeArtifact('super_admin');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            ok: false,
            code: 'billing_transfer_idempotency_conflict',
            error: `reason=${REASON}; key=${KEY}; source=${SOURCE_MARKER}`,
          },
          { status: 409, headers: { 'x-request-id': `request-${KEY}` } },
        ),
      ),
    );

    expect(await run(adminApplyArgs(artifactPath(), '--json'), ENV, home)).toBe(1);
    expect(stdout()).toContain('billing_transfer_idempotency_conflict');
    expect(stdout()).not.toContain(REASON);
    expect(stdout()).not.toContain(KEY);
    expect(stdout()).not.toContain(SOURCE_MARKER);
    expect(stderr()).toBe('');
  });
});
