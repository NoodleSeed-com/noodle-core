import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, writeConfig } from '../src/index.js';

const SERVICE = 'https://svc.example';
const ROUTE = `${SERVICE}/v1/billing-accounts/migrations/legacy/preview`;
const ENV = { NOODLE_DISABLE_UPDATE_CHECK: '1' };

const READY_PREVIEW = {
  schemaVersion: 1,
  ready: true,
  organizations: [
    {
      org: 'alpha',
      ownerCandidates: [{ subject: 'shared-owner', email: 'owner@example.com' }],
      mappedOwnerSubject: 'shared-owner',
      productionApps: [],
    },
  ],
  linkedOrganizations: [],
  fundingSets: [
    {
      destination: {
        kind: 'proposed_default',
        identityIssuer: 'https://accounts.google.com',
        subject: 'shared-owner',
      },
      organizations: ['alpha'],
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
  previewChecksum: 'a'.repeat(64),
} as const;

const BLOCKED_PREVIEW = {
  schemaVersion: 1,
  ready: false,
  organizations: [
    {
      org: 'legacy',
      ownerCandidates: [{ subject: 'sole-owner', email: 'owner@example.com' }],
    },
  ],
  linkedOrganizations: [],
  fundingSets: [],
  blockers: [
    {
      code: 'owner_mapping_required',
      org: 'legacy',
      message: 'an operator must explicitly select the organization home Free owner',
    },
  ],
  grantPolicy: {
    durationDays: 90,
    startsAt: 'billing_enforcement_cutover',
    expiresAt: null,
    eligibility: 'account_cohort_above_capacity',
  },
  previewChecksum: 'b'.repeat(64),
} as const;

let home: string;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-billing-migration-'));
  writeConfig({ serviceUrl: SERVICE, authToken: 'SECRET_TOKEN' }, home);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe('noodle billing migration preview', () => {
  it('posts the versioned mapping to the public HTTP contract', async () => {
    const file = join(home, 'route-mapping.json');
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        mappings: [
          {
            org: 'legacy',
            linkState: 'unlinked',
            defaultBillingOwnerSubject: 'legacy-owner',
            productionApps: [],
          },
        ],
      }),
    );
    const requests = stubPreview(READY_PREVIEW);

    expect(
      await run(['billing', 'migration', 'preview', '--file', file, '--json'], ENV, home),
    ).toBe(0);
    expect(requests).toEqual([
      expect.objectContaining({
        url: ROUTE,
        method: 'POST',
        authorization: 'Bearer SECRET_TOKEN',
        body: expect.objectContaining({ schemaVersion: 1 }),
      }),
    ]);
  });

  it('POSTs an empty mapping document by default and emits stable ready JSON', async () => {
    const requests = stubPreview(READY_PREVIEW);

    expect(await run(['billing', 'migration', 'preview', '--json'], ENV, home)).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: ROUTE,
      method: 'POST',
      authorization: 'Bearer SECRET_TOKEN',
      contentType: 'application/json',
      body: { schemaVersion: 1, mappings: [] },
    });
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      ok: true,
      data: { service: SERVICE, preview: READY_PREVIEW },
    });
    expect(stderr()).toBe('');
    expect(stdout()).not.toContain('SECRET_TOKEN');
  });

  it('reads --file as the complete versioned mapping document', async () => {
    const mapping = {
      schemaVersion: 1,
      mappings: [
        {
          org: 'alpha',
          linkState: 'unlinked',
          defaultBillingOwnerSubject: 'shared-owner',
          productionApps: [],
        },
      ],
    };
    const file = join(home, 'mapping.json');
    writeFileSync(file, `${JSON.stringify(mapping, null, 2)}\n`);
    const requests = stubPreview(READY_PREVIEW);

    expect(
      await run(['billing', 'migration', 'preview', '--file', file, '--json'], ENV, home),
    ).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toEqual(mapping);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      ok: true,
      data: { service: SERVICE, preview: READY_PREVIEW },
    });
  });

  it('rejects a structurally invalid mapping document locally without contacting the service', async () => {
    const file = join(home, 'invalid-mapping.json');
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, mappings: {} }));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    expect(
      await run(['billing', 'migration', 'preview', '--file', file, '--json'], ENV, home),
    ).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_mapping_file',
        message: expect.stringContaining(file),
        cause: expect.stringContaining('invalid billing migration preview'),
        fix: expect.stringContaining('readable JSON'),
      },
    });
  });

  it('reports an unreadable mapping file locally without contacting the service', async () => {
    const file = join(home, 'missing-mapping.json');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    expect(
      await run(['billing', 'migration', 'preview', '--file', file, '--json'], ENV, home),
    ).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_mapping_file',
        message: expect.stringContaining(file),
        fix: expect.stringContaining('readable JSON'),
      },
    });
  });

  it('rejects a flag token where --file requires a path', async () => {
    expect(await run(['billing', 'migration', 'preview', '--file', '--json'], ENV, home)).toBe(2);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'usage', message: 'a flag value is missing' },
    });
  });

  it('keeps a blocked preview machine-readable and exits nonzero', async () => {
    stubPreview(BLOCKED_PREVIEW);

    expect(await run(['billing', 'migration', 'preview', '--json'], ENV, home)).toBe(1);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      ok: true,
      data: { service: SERVICE, preview: BLOCKED_PREVIEW },
    });
    expect(stderr()).toBe('');
  });

  it('leads human output with READY and the completed preview counts', async () => {
    stubPreview(READY_PREVIEW);

    expect(await run(['billing', 'migration', 'preview'], ENV, home)).toBe(0);
    const output = stdout();
    expect(output).toContain('Billing migration preview');
    expect(output).toContain('READY');
    expect(output).toContain('Organizations requiring mapping: 1');
    expect(output).toContain('Already linked: 0');
    expect(output).toContain('Funding sets: 1');
    expect(output).toContain(
      'Legacy cohort grant policy: 90 days when the account footprint exceeds plan capacity',
    );
    expect(output).toContain('No changes were made.');
    expect(output).not.toContain('SECRET_TOKEN');
  });

  it('lists typed blockers and an exact repair command in human output', async () => {
    stubPreview(BLOCKED_PREVIEW);

    expect(await run(['billing', 'migration', 'preview'], ENV, home)).toBe(1);
    const output = stdout();
    expect(output).toContain('Billing migration preview');
    expect(output).toContain('BLOCKED');
    expect(output).toContain('legacy');
    expect(output).toContain('owner_mapping_required');
    expect(output).toContain('an operator must explicitly select the organization home Free owner');
    expect(output).toContain('noodle billing migration preview --file <mapping.json>');
    expect(stderr()).toBe('');
  });
});

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly contentType: string | null;
  readonly body: unknown;
}

function stubPreview(preview: unknown): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: input.toString(),
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization'),
        contentType: headers.get('content-type'),
        body: JSON.parse(init?.body?.toString() ?? '{}') as unknown,
      });
      return Response.json({ ok: true, data: preview });
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
