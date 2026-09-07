import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { legacyBillingMigrationPreviewChecksum } from '../src/commands/billing-contract-checksums.js';
import { run, writeConfig } from '../src/index.js';

const SERVICE = 'https://svc.example';
const APPLY_ROUTE = `${SERVICE}/v1/billing-accounts/migrations/legacy/apply`;
const ENV = { NOODLE_DISABLE_UPDATE_CHECK: '1' };

const MAPPING = {
  schemaVersion: 1,
  mappings: [
    {
      org: 'legacy',
      linkState: 'unlinked',
      defaultBillingOwnerSubject: 'owner-sub',
      productionApps: [],
    },
  ],
} as const;

const PREVIEW_CONTENT = {
  schemaVersion: 1,
  ready: true,
  organizations: [
    {
      org: 'legacy',
      ownerCandidates: [{ subject: 'owner-sub', email: 'owner@example.com' }],
      mappedOwnerSubject: 'owner-sub',
      productionApps: [],
    },
  ],
  linkedOrganizations: [],
  fundingSets: [
    {
      destination: {
        kind: 'proposed_default',
        identityIssuer: 'https://accounts.google.com',
        subject: 'owner-sub',
      },
      organizations: ['legacy'],
      productionApps: [],
      missingProductionClassifications: [],
    },
  ],
  blockers: [],
  grantPolicy: {
    durationDays: 90,
    startsAt: 'billing_enforcement_cutover',
    expiresAt: null,
    eligibility: 'account_cohort_above_capacity',
  },
} as const;
const PREVIEW_CHECKSUM = legacyBillingMigrationPreviewChecksum(PREVIEW_CONTENT);
const PREVIEW = { ...PREVIEW_CONTENT, previewChecksum: PREVIEW_CHECKSUM } as const;

const PLAN_EVIDENCE = {
  schemaVersion: 1,
  service: SERVICE,
  capturedAt: '2026-07-15T12:00:00.000Z',
  authoritativeOrganizationCount: 1,
  projections: [
    {
      org: 'legacy',
      response: {
        ok: true,
        service: SERVICE,
        plan: { org: 'legacy', plan: 'free', state: 'active', source: 'default' },
      },
    },
  ],
  reconciliation: {
    complete: true,
    treatment: 'preserve_as_free',
    counts: { freeActiveDefault: 1, exceptions: 0 },
  },
} as const;

const RESULT = {
  schemaVersion: 1,
  migrationId: 'bm_00000000-0000-0000-0000-000000000001',
  mode: 'shadow',
  state: 'prepared',
  replayed: false,
  preparedAt: '2026-07-15T12:05:00.000Z',
  enforcementMode: 'legacy_unchanged',
  meteringMode: 'not_started',
  grantMode: 'pending_activation',
  mappingChecksum: 'b'.repeat(64),
  previewChecksum: PREVIEW_CHECKSUM,
  planEvidenceChecksum: 'c'.repeat(64),
  counts: {
    organizations: 1,
    accountsCreated: 1,
    accountsReused: 0,
    linksCreated: 1,
    linksPreserved: 0,
    productionApps: 0,
    grantCandidateFundingSets: 0,
  },
  fundingSets: [
    {
      billingAccountId: 'ba_00000000-0000-0000-0000-000000000001',
      accountDisposition: 'created',
      snapshotId: 'bes_00000000-0000-0000-0000-000000000001',
      organizations: 1,
      productionApps: 0,
      grantCandidate: false,
    },
  ],
  links: [
    {
      org: 'legacy',
      billingAccountId: 'ba_00000000-0000-0000-0000-000000000001',
      version: 1,
      disposition: 'created',
    },
  ],
} as const;

let home: string;
let mappingFile: string;
let previewFile: string;
let planEvidenceFile: string;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-billing-apply-'));
  mappingFile = join(home, 'mapping.json');
  previewFile = join(home, 'ready-preview.json');
  planEvidenceFile = join(home, 'plan-evidence.json');
  writeFileSync(mappingFile, JSON.stringify(MAPPING));
  writeFileSync(
    previewFile,
    JSON.stringify({ ok: true, data: { service: SERVICE, preview: PREVIEW } }),
  );
  writeFileSync(planEvidenceFile, JSON.stringify(PLAN_EVIDENCE));
  writeConfig({ serviceUrl: SERVICE, authToken: 'SECRET_TOKEN' }, home);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe('noodle billing migration apply', () => {
  it('requires --yes before any network request in JSON or non-interactive mode', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    expect(await run(applyArgs('--json'), ENV, home)).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'confirmation_required',
        message: 'billing migration shadow apply requires confirmation',
        next: expect.stringContaining('--yes'),
      },
    });
  });

  it('validates every private evidence file locally before contacting the service', async () => {
    writeFileSync(planEvidenceFile, JSON.stringify({ schemaVersion: 1, projections: [] }));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    expect(await run(applyArgs('--yes', '--json'), ENV, home)).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_plan_evidence_file',
        message: expect.stringContaining(planEvidenceFile),
      },
    });
  });

  it('binds the approved checksum and sends one confirmed shadow apply', async () => {
    const requests = stubApply(RESULT);

    expect(await run(applyArgs('--yes', '--json'), ENV, home), stderr()).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: APPLY_ROUTE,
      method: 'POST',
      authorization: 'Bearer SECRET_TOKEN',
      body: {
        ...MAPPING,
        mode: 'shadow',
        expectedPreviewChecksum: PREVIEW_CHECKSUM,
        legacyPlanEvidence: PLAN_EVIDENCE,
        idempotencyKey: 'production-bootstrap-v1',
        reason: 'approved production bootstrap',
        confirmed: true,
      },
    });
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      ok: true,
      data: { service: SERVICE, migration: RESULT },
    });
    expect(stderr()).toBe('');
    expect(stdout()).not.toContain('SECRET_TOKEN');
  });

  it('preserves a typed atomic drift conflict from the service', async () => {
    const requests = stubApply(
      {
        ok: false,
        code: 'preview_checksum_mismatch',
        error: 'approved preview no longer matches current state',
      },
      409,
    );

    expect(await run(applyArgs('--yes', '--json'), ENV, home)).toBe(1);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'preview_checksum_mismatch',
        message: expect.stringContaining('approved preview'),
      },
    });
  });

  it('rejects a saved blocked preview locally', async () => {
    const blockedPreview = {
      ...PREVIEW,
      ready: false,
      blockers: [
        {
          org: 'legacy',
          code: 'owner_not_org_owner',
          message: 'mapped subject is not a current organization owner',
        },
      ],
    } as const;
    writeFileSync(
      previewFile,
      JSON.stringify({
        ok: true,
        data: {
          service: SERVICE,
          preview: {
            ...blockedPreview,
            previewChecksum: legacyBillingMigrationPreviewChecksum(blockedPreview),
          },
        },
      }),
    );
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    expect(await run(applyArgs('--yes', '--json'), ENV, home)).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'approved_preview_blocked',
        cause: expect.stringContaining('owner_not_org_owner'),
      },
    });
  });

  it('rejects an approved preview whose contents no longer match its checksum', async () => {
    writeFileSync(
      previewFile,
      JSON.stringify({
        ok: true,
        data: {
          service: SERVICE,
          preview: { ...PREVIEW, organizations: [] },
        },
      }),
    );
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    expect(await run(applyArgs('--yes', '--json'), ENV, home)).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_preview_file',
        cause: expect.stringContaining('checksum'),
      },
    });
  });

  it('leads human output with the outcome and makes the non-enforcement boundary explicit', async () => {
    stubApply(RESULT);

    expect(await run(applyArgs('--yes'), ENV, home)).toBe(0);
    const output = stdout();
    expect(output).toContain('Billing migration: PREPARED');
    expect(output).toContain('Organizations: 1');
    expect(output).toContain('Billing data was written. Enforcement remains unchanged.');
    expect(output).toContain('Usage metering has not started. No 90-day grant clock has started.');
  });

  it('labels an exact replay without implying that billing data was written twice', async () => {
    const requests = stubApply({ ...RESULT, replayed: true });

    expect(await run(applyArgs('--yes'), ENV, home)).toBe(0);
    expect(requests).toHaveLength(1);
    expect(stdout()).toContain('Billing migration: ALREADY PREPARED');
    expect(stdout()).toContain(
      'The existing shadow preparation was returned; no duplicate writes were made.',
    );
  });
});

function applyArgs(...extra: string[]): string[] {
  return [
    'billing',
    'migration',
    'apply',
    '--file',
    mappingFile,
    '--preview-file',
    previewFile,
    '--plan-evidence',
    planEvidenceFile,
    '--mode',
    'shadow',
    '--reason',
    'approved production bootstrap',
    '--idempotency-key',
    'production-bootstrap-v1',
    ...extra,
  ];
}

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

function stubApply(result: unknown, status = 200): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = {
        url: input.toString(),
        method: init?.method ?? 'GET',
        authorization: new Headers(init?.headers).get('authorization'),
        body: JSON.parse(init?.body?.toString() ?? '{}') as unknown,
      };
      requests.push(request);
      if (request.url === APPLY_ROUTE) {
        return status >= 400
          ? Response.json(result, { status })
          : Response.json({ ok: true, data: result }, { status });
      }
      return Response.json({ ok: false, error: 'not found' }, { status: 404 });
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
