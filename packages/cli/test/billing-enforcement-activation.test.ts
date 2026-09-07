import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { billingEnforcementActivationApprovalChecksum } from '../src/commands/billing-contract-checksums.js';
import { run, writeConfig } from '../src/index.js';

const SERVICE = 'https://cloud.noodleseed.dev';
const STATUS_ROUTE = `${SERVICE}/v1/billing-accounts/enforcement/activation`;
const PREVIEW_ROUTE = `${STATUS_ROUTE}/preview`;
const ACTIVATE_ROUTE = `${STATUS_ROUTE}/activate`;
const ROLLBACK_ROUTE = `${STATUS_ROUTE}/rollback`;
const RELEASE_SHA = '1'.repeat(40);
const ENV = { NOODLE_DISABLE_UPDATE_CHECK: '1' };
const APPROVAL = {
  schemaVersion: 1,
  targetEnvironment: 'production',
  commercialScope: 'free_v1',
  paidPlans: false,
  service: SERVICE,
  expectedState: 'not_activated',
  expectedGeneration: 0,
  expectedCohortSealId: 'becs_activation',
  expectedValidationEpochId: 'bmev_activation',
  expectedServiceReleaseSha: RELEASE_SHA,
  evidence: {
    trafficFleetConvergence: {
      serviceReleaseSha: RELEASE_SHA,
      verifiedAt: '2026-07-16T12:00:00.000Z',
      checksum: '1'.repeat(64),
    },
    planVolumeCapacity: {
      serviceReleaseSha: RELEASE_SHA,
      topology: 'production',
      approvedAt: '2026-07-16T12:01:00.000Z',
      checksum: '2'.repeat(64),
    },
    nonproductionFailClosedDrill: {
      serviceReleaseSha: RELEASE_SHA,
      environment: 'staging',
      verifiedAt: '2026-07-16T12:02:00.000Z',
      checksum: '3'.repeat(64),
    },
    protectedProductionApproval: {
      serviceReleaseSha: RELEASE_SHA,
      systemReleaseId: 'r12345',
      approvedAt: '2026-07-16T12:03:00.000Z',
      checksum: '4'.repeat(64),
    },
  },
} as const;
const STATUS = {
  schemaVersion: 1,
  state: 'not_activated',
  generation: 0,
  cohortSealId: APPROVAL.expectedCohortSealId,
  activeEpochId: null,
  lastEpochId: null,
  activatedAt: null,
  rolledBackAt: null,
  activationServiceReleaseSha: null,
  admissionContractVersion: null,
  approvalChecksum: null,
} as const;
const PREVIEW = {
  schemaVersion: 1,
  ready: true,
  commercialScope: 'free_v1',
  paidPlans: false,
  checkedAt: '2026-07-16T12:05:00.000Z',
  approvalChecksum: billingEnforcementActivationApprovalChecksum(APPROVAL),
  previewChecksum: '6'.repeat(64),
  blockers: [],
  effects: {
    profileScope: 'enforced',
    commercialScope: 'free_v1',
    paidPlans: false,
    startsFreshAuthoritativeEpochAtZero: true,
    productionAppEnforcement: true,
    legacyInternalExemptBypass: true,
    stripe: false,
    migrationGrants: false,
    invoiceEvidence: false,
  },
} as const;
const ACTIVATED = {
  schemaVersion: 1,
  action: 'activate',
  state: 'active',
  generation: 1,
  replayed: false,
  cohortSealId: APPROVAL.expectedCohortSealId,
  activeEpochId: 'bmea_activation',
  lastEpochId: 'bmea_activation',
  retiredValidationEpochId: APPROVAL.expectedValidationEpochId,
  activatedAt: '2026-07-16T12:10:00.000Z',
  rolledBackAt: null,
  activationServiceReleaseSha: RELEASE_SHA,
  admissionContractVersion: 1,
  approvalChecksum: PREVIEW.approvalChecksum,
  previewChecksum: PREVIEW.previewChecksum,
} as const;
const ROLLED_BACK = {
  ...ACTIVATED,
  action: 'rollback',
  state: 'rolled_back',
  activeEpochId: null,
  retiredValidationEpochId: null,
  rolledBackAt: '2026-07-16T12:20:00.000Z',
  previewChecksum: null,
} as const;

let home: string;
let approvalFile: string;
let previewFile: string;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-enforcement-activation-'));
  approvalFile = join(home, 'production-approval.json');
  previewFile = join(home, 'ready-preview.json');
  writeFileSync(approvalFile, JSON.stringify(APPROVAL));
  writeFileSync(
    previewFile,
    JSON.stringify({ ok: true, data: { service: SERVICE, activationPreview: PREVIEW } }),
  );
  writeConfig({ serviceUrl: SERVICE, authToken: 'SECRET_TOKEN' }, home);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe('noodle billing enforcement activation', () => {
  it('prints strict status in JSON and human modes', async () => {
    const requests = stubService({ [STATUS_ROUTE]: STATUS });

    expect(await run(['billing', 'enforcement', 'activation', 'status', '--json'], ENV, home)).toBe(
      0,
    );
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      ok: true,
      data: { service: SERVICE, activation: STATUS },
    });
    expect(requests[0]).toMatchObject({
      url: STATUS_ROUTE,
      method: 'GET',
      authorization: 'Bearer SECRET_TOKEN',
    });

    log.mockClear();
    expect(await run(['billing', 'enforcement', 'activation', 'status'], ENV, home)).toBe(0);
    expect(stdout()).toContain('Billing enforcement: NOT ACTIVATED');
    expect(stdout()).toContain('Generation: 0');

    log.mockClear();
    stubService({
      [STATUS_ROUTE]: {
        ...STATUS,
        state: 'active',
        generation: 1,
        activeEpochId: 'bmea_active',
        lastEpochId: 'bmea_active',
        activatedAt: '2026-07-16T12:10:00.000Z',
        activationServiceReleaseSha: RELEASE_SHA,
        admissionContractVersion: 2,
        approvalChecksum: '7'.repeat(64),
      },
    });
    expect(await run(['billing', 'enforcement', 'activation', 'status'], ENV, home)).toBe(0);
    expect(stdout()).toContain('Admission contract: v2');
  });

  it('validates the private approval file locally before previewing', async () => {
    writeFileSync(approvalFile, JSON.stringify({ ...APPROVAL, targetEnvironment: 'staging' }));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    expect(await run(previewArgs('--json'), ENV, home)).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_activation_approval_file',
        message: expect.stringContaining(approvalFile),
      },
    });
  });

  it('previews the exact approval and reports a blocked preview with exit one', async () => {
    const blocked = {
      ...PREVIEW,
      ready: false,
      blockers: [{ code: 'technical_readiness_blocked' }],
    } as const;
    const requests = stubService({ [PREVIEW_ROUTE]: blocked });

    expect(await run(previewArgs(), ENV, home)).toBe(1);
    expect(requests[0]).toMatchObject({
      url: PREVIEW_ROUTE,
      method: 'POST',
      body: APPROVAL,
    });
    expect(stdout()).toContain('Billing enforcement activation preview: BLOCKED');
    expect(stdout()).toContain('Commercial scope: Free v1 only');
    expect(stdout()).toContain('Paid plans: INACTIVE');
    expect(stdout()).toContain('technical_readiness_blocked');
    expect(stdout()).toContain('No changes were made.');
  });

  it.each([
    'activate',
    'rollback',
  ] as const)('requires confirmation for %s before files or network are used', async (action) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const args = action === 'activate' ? activateArgs('--json') : rollbackArgs('--json');

    expect(await run(args, ENV, home)).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'confirmation_required', next: expect.stringContaining('--yes') },
    });
  });

  it('rejects a blocked or mismatched approved preview locally', async () => {
    for (const activationPreview of [
      { ...PREVIEW, ready: false, blockers: [{ code: 'technical_readiness_blocked' }] },
      { ...PREVIEW, approvalChecksum: '9'.repeat(64) },
    ]) {
      writeFileSync(
        previewFile,
        JSON.stringify({ ok: true, data: { service: SERVICE, activationPreview } }),
      );
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      expect(await run(activateArgs('--yes', '--json'), ENV, home)).toBe(1);
      expect(fetch).not.toHaveBeenCalled();
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
        ok: false,
        error: { code: 'invalid_activation_preview_file' },
      });
      error.mockClear();
    }
  });

  it('tolerates an additive approved-preview field without sending it', async () => {
    writeFileSync(
      previewFile,
      JSON.stringify({
        ok: true,
        data: { service: SERVICE, activationPreview: { ...PREVIEW, unexpected: true } },
      }),
    );
    const requests = stubService({ [ACTIVATE_ROUTE]: ACTIVATED });
    expect(await run(activateArgs('--yes', '--json'), ENV, home)).toBe(0);
    expect(JSON.stringify(requests)).not.toContain('unexpected');
  });

  it('sends one confirmed activation bound to the reviewed approval and preview', async () => {
    const requests = stubService({ [ACTIVATE_ROUTE]: ACTIVATED });

    expect(await run(activateArgs('--yes', '--json'), ENV, home), stderr()).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: ACTIVATE_ROUTE,
      method: 'POST',
      authorization: 'Bearer SECRET_TOKEN',
      body: {
        schemaVersion: 1,
        approval: APPROVAL,
        expectedPreviewChecksum: PREVIEW.previewChecksum,
        reason: 'approved production activation',
        idempotencyKey: 'private-activation-key',
        confirmed: true,
      },
    });
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      ok: true,
      data: { service: SERVICE, activation: ACTIVATED },
    });
    expect(stdout()).not.toContain('private-activation-key');
  });

  it('labels exact activation replay and leads human output with the outcome', async () => {
    stubService({ [ACTIVATE_ROUTE]: { ...ACTIVATED, replayed: true } });

    expect(await run(activateArgs('--yes'), ENV, home)).toBe(0);
    expect(stdout()).toContain('Billing enforcement: ALREADY ACTIVE');
    expect(stdout()).toContain('Authoritative epoch: bmea_activation');
    expect(stdout()).toContain('no duplicate mutation was made');
    expect(stdout()).not.toContain('private-activation-key');
  });

  it('sends confirmed rollback and explains that evidence is preserved', async () => {
    const requests = stubService({ [ROLLBACK_ROUTE]: ROLLED_BACK });

    expect(await run(rollbackArgs('--yes'), ENV, home)).toBe(0);
    expect(requests[0]).toMatchObject({
      url: ROLLBACK_ROUTE,
      method: 'POST',
      body: {
        schemaVersion: 1,
        expectedState: 'active',
        expectedGeneration: 1,
        expectedEpochId: ACTIVATED.activeEpochId,
        reason: 'controlled production rollback',
        idempotencyKey: 'private-rollback-key',
        confirmed: true,
      },
    });
    expect(stdout()).toContain('Billing enforcement: ROLLED BACK');
    expect(stdout()).toContain('Meter evidence was preserved');
  });

  it.each([
    ['activate', ACTIVATE_ROUTE, 'private-activation-key'],
    ['rollback', ROLLBACK_ROUTE, 'private-rollback-key'],
  ] as const)('redacts the %s idempotency key from service failures', async (action, route, privateKey) => {
    const args =
      action === 'activate' ? activateArgs('--yes', '--json') : rollbackArgs('--yes', '--json');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            ok: false,
            code: 'idempotency_key_conflict',
            error: `idempotency ${privateKey} conflicts at ${route}`,
          },
          { status: 409, headers: { 'x-request-id': `request-${privateKey}` } },
        ),
      ),
    );

    expect(await run(args, ENV, home)).toBe(1);
    expect(stdout()).toContain('[redacted]');
    expect(stdout()).not.toContain(privateKey);
    expect(stdout()).toContain('--idempotency-key <same-private-key>');
    expect(stderr()).toBe('');
  });

  it.each([
    ['activation', 'status', '--unknown'],
    ['activation', 'preview'],
    ['activation', 'activate', '--file', 'approval.json', '--yes'],
    ['activation', 'rollback', '--epoch', ACTIVATED.activeEpochId, '--generation', 'zero', '--yes'],
  ])('rejects incomplete activation grammar: %s %s', async (...args) => {
    expect(await run(['billing', 'enforcement', ...args], ENV, home)).toBe(2);
    expect(stderr()).toContain('billing enforcement activation');
  });
});

function previewArgs(...extra: string[]): string[] {
  return ['billing', 'enforcement', 'activation', 'preview', '--file', approvalFile, ...extra];
}

function activateArgs(...extra: string[]): string[] {
  return [
    'billing',
    'enforcement',
    'activation',
    'activate',
    '--file',
    approvalFile,
    '--preview-file',
    previewFile,
    '--reason',
    'approved production activation',
    '--idempotency-key',
    'private-activation-key',
    ...extra,
  ];
}

function rollbackArgs(...extra: string[]): string[] {
  return [
    'billing',
    'enforcement',
    'activation',
    'rollback',
    '--epoch',
    ACTIVATED.activeEpochId,
    '--generation',
    '1',
    '--reason',
    'controlled production rollback',
    '--idempotency-key',
    'private-rollback-key',
    ...extra,
  ];
}

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

function stubService(responses: Readonly<Record<string, unknown>>): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = {
        url: input.toString(),
        method: init?.method ?? 'GET',
        authorization: new Headers(init?.headers).get('authorization'),
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      requests.push(request);
      if (!(request.url in responses)) {
        return Response.json({ ok: false, error: 'not found' }, { status: 404 });
      }
      return Response.json({ ok: true, data: responses[request.url] });
    }),
  );
  return requests;
}

function stdout(): string {
  return log.mock.calls.map((call) => String(call[0])).join('\n');
}

function stderr(): string {
  return error.mock.calls.map((call) => String(call[0])).join('\n');
}
