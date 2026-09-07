import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, writeConfig } from '../src/index.js';

const SERVICE = 'https://cloud.noodleseed.dev';
const ROOT = `${SERVICE}/v1/platform-auth/account-reset`;
const SHA = 'a'.repeat(40);
const CHECKSUM = 'b'.repeat(64);
const OPERATION_ID = 'reset-12345678';
const PRIVATE_PRINCIPAL = 'private-principal-001';
const PRIVATE_KEY = 'private-idempotency-key';
const PRIVATE_REASON = 'private approved reset reason';
const PRIVATE_EMAIL = 'private@example.test';
const PRIVATE_PROVIDER_ID = 'workos-private-provider-id';
const ENV = { NOODLE_DISABLE_UPDATE_CHECK: '1' };

let home: string;
let targetFile: string;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-account-reset-'));
  targetFile = join(home, 'targets.json');
  writeFileSync(
    targetFile,
    JSON.stringify({
      schemaVersion: 1,
      principalIds: [PRIVATE_PRINCIPAL, 'private-principal-002', 'private-principal-003'],
    }),
    { mode: 0o600 },
  );
  chmodSync(targetFile, 0o600);
  writeConfig({ serviceUrl: SERVICE, authToken: 'SECRET_TOKEN' }, home);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe('noodle platform-auth account-reset', () => {
  it('runs the canonical quarantine preview and sends principals only in its request body', async () => {
    const requests = stubService({ [`${ROOT}/preview`]: result() });

    expect(
      await run(
        [
          'platform-auth',
          'account-reset',
          'preview',
          '--operation',
          'quarantine',
          '--target-file',
          targetFile,
        ],
        ENV,
        home,
      ),
    ).toBe(0);

    expect(requests).toEqual([
      expect.objectContaining({
        url: `${ROOT}/preview`,
        method: 'POST',
        body: {
          schemaVersion: 1,
          operation: 'quarantine',
          targetSet: {
            schemaVersion: 1,
            principalIds: [PRIVATE_PRINCIPAL, 'private-principal-002', 'private-principal-003'],
          },
        },
      }),
    ]);
    expect(stdout()).toContain('Platform account reset quarantine preview: READY');
    expect(stdout()).toContain(`Operation ID: ${OPERATION_ID}`);
    expect(stdout()).toContain(`Release SHA: ${SHA}`);
    expect(stdout()).toContain('Rollout generation: 4');
    expect(stdout()).toContain('Source epoch: 2');
    expect(stdout()).toContain(`Preview checksum: ${CHECKSUM}`);
    expect(stdout()).not.toContain('Target-set fingerprint');
    expect(stdout()).not.toContain('Request fingerprint');
    expect(stdout()).toContain('Targets: 3');
    expect(stdout()).toContain('Personal organizations: 3');
    expect(stdout()).toContain('Sole-owned organizations: 0');
    expect(stdout()).toContain('Owner-only apps: 4');
    expect(stdout()).toContain('Preserved shared organizations: 2');
    expect(stdout()).toContain('Blockers: 0');
    expect(stdout()).toContain('No changes were made.');
    expect(combinedOutput()).not.toContain(PRIVATE_PRINCIPAL);
    expect(combinedOutput()).not.toContain(targetFile);
  });

  it('returns the safe coordination evidence required by the next operator command', async () => {
    stubService({ [`${ROOT}/preview`]: result() });

    expect(
      await run(
        [
          'platform-auth',
          'account-reset',
          'preview',
          '--operation',
          'quarantine',
          '--target-file',
          targetFile,
          '--json',
        ],
        ENV,
        home,
      ),
    ).toBe(0);

    expect(JSON.parse(stdout())).toEqual({
      ok: true,
      data: {
        accountReset: {
          operation: 'quarantine preview',
          outcome: 'READY',
          operationId: OPERATION_ID,
          releaseSha: SHA,
          rolloutGeneration: 4,
          sourceEpoch: 2,
          previewChecksum: CHECKSUM,
          targetCount: 3,
          personalOrganizationCount: 3,
          soleOwnedOrganizationCount: 0,
          ownerOnlyAppCount: 4,
          preservedSharedOrganizationCount: 2,
          blockerCount: 0,
        },
      },
    });
    for (const privateValue of [
      PRIVATE_PRINCIPAL,
      PRIVATE_EMAIL,
      PRIVATE_PROVIDER_ID,
      PRIVATE_KEY,
      PRIVATE_REASON,
      targetFile,
      'SECRET_TOKEN',
    ]) {
      expect(combinedOutput()).not.toContain(privateValue);
    }
  });

  it.each([
    [
      'status',
      ['--operation-id', OPERATION_ID],
      `${ROOT}/status?operation_id=${OPERATION_ID}`,
      'GET',
    ],
    [
      'preview',
      ['--operation', 'rollback', '--operation-id', OPERATION_ID],
      `${ROOT}/preview`,
      'POST',
    ],
  ] as const)('%s never sends principals outside a quarantine preview', async (action, flags, url, method) => {
    const requests = stubService({ [url]: result() });
    expect(await run(['platform-auth', 'account-reset', action, ...flags], ENV, home)).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url, method });
    expect(JSON.stringify(requests[0].body ?? {})).not.toContain(PRIVATE_PRINCIPAL);
    if (action === 'preview') {
      expect(requests[0]?.body).toEqual({
        schemaVersion: 1,
        operation: flags[1],
        operationId: OPERATION_ID,
      });
    }
  });

  it('sends exact finalize preview and reports the fixed Release-A conflict without private output', async () => {
    const requests: CapturedRequest[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(input),
          method: init?.method ?? 'GET',
          ...(typeof init?.body === 'string'
            ? { body: JSON.parse(init.body) as Record<string, unknown> }
            : {}),
        });
        return new Response(
          JSON.stringify({
            ok: false,
            code: 'operation_conflict',
            error: `rejected ${PRIVATE_EMAIL} ${PRIVATE_PROVIDER_ID}`,
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    expect(
      await run(
        [
          'platform-auth',
          'account-reset',
          'preview',
          '--operation',
          'finalize',
          '--operation-id',
          OPERATION_ID,
        ],
        ENV,
        home,
      ),
    ).toBe(1);
    expect(requests).toEqual([
      {
        url: `${ROOT}/preview`,
        method: 'POST',
        body: { schemaVersion: 1, operation: 'finalize', operationId: OPERATION_ID },
      },
    ]);
    expect(combinedOutput()).not.toContain(PRIVATE_EMAIL);
    expect(combinedOutput()).not.toContain(PRIVATE_PROVIDER_ID);
  });

  it('treats zero-count blocker entries as ready', async () => {
    const requests = stubService({
      [`${ROOT}/preview`]: {
        ...result(),
        blockers: [{ code: 'operation_conflict', count: 0 }],
      },
    });

    expect(
      await run(
        [
          'platform-auth',
          'account-reset',
          'preview',
          '--operation',
          'quarantine',
          '--target-file',
          targetFile,
        ],
        ENV,
        home,
      ),
    ).toBe(0);
    expect(stdout()).toContain('Platform account reset quarantine preview: READY');
    expect(stdout()).toContain('Blockers: 0');
    expect(stdout()).not.toContain('operation_conflict');
    expect(requests).toHaveLength(1);
  });

  it('sends only opaque operation and evidence fields for a successful rollback mutation', async () => {
    const action = 'rollback';
    const requests = stubService({ [`${ROOT}/${action}`]: result() });
    expect(
      await run(
        [
          'platform-auth',
          'account-reset',
          action,
          '--operation-id',
          OPERATION_ID,
          ...mutationArgs(action),
        ],
        ENV,
        home,
      ),
    ).toBe(0);
    expect(requests).toEqual([
      expect.objectContaining({
        url: `${ROOT}/${action}`,
        method: 'POST',
        body: {
          schemaVersion: 1,
          action,
          operationId: OPERATION_ID,
          expectedGeneration: 4,
          releaseSha: SHA,
          previewChecksum: CHECKSUM,
          idempotencyKey: PRIVATE_KEY,
          reason: PRIVATE_REASON,
          confirmed: true,
        },
      }),
    ]);
    expect(JSON.stringify(requests[0]?.body)).not.toContain(PRIVATE_PRINCIPAL);
    expect(JSON.stringify(requests[0]?.body)).not.toContain(PRIVATE_EMAIL);
  });

  it('reports the fixed Release-A conflict for a finalize mutation without private output', async () => {
    const requests: CapturedRequest[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(input),
          method: init?.method ?? 'GET',
          ...(typeof init?.body === 'string'
            ? { body: JSON.parse(init.body) as Record<string, unknown> }
            : {}),
        });
        return new Response(
          JSON.stringify({
            ok: false,
            code: 'operation_conflict',
            error: `rejected ${PRIVATE_EMAIL} ${PRIVATE_PROVIDER_ID}`,
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    expect(
      await run(
        [
          'platform-auth',
          'account-reset',
          'finalize',
          '--operation-id',
          OPERATION_ID,
          ...mutationArgs('finalize'),
        ],
        ENV,
        home,
      ),
    ).toBe(1);
    expect(requests).toEqual([
      expect.objectContaining({
        url: `${ROOT}/finalize`,
        method: 'POST',
        body: expect.objectContaining({ action: 'finalize', operationId: OPERATION_ID }),
      }),
    ]);
    expect(combinedOutput()).not.toContain(PRIVATE_EMAIL);
    expect(combinedOutput()).not.toContain(PRIVATE_PROVIDER_ID);
    expect(combinedOutput()).not.toContain(PRIVATE_KEY);
    expect(combinedOutput()).not.toContain(PRIVATE_REASON);
  });

  it.each([
    'quarantine',
    'rollback',
    'finalize',
  ] as const)('%s requires every evidence flag and explicit confirmation', async (action) => {
    const base = ['platform-auth', 'account-reset', action, '--operation-id', OPERATION_ID];
    for (const missing of [
      '--expected-generation',
      '--release-sha',
      '--preview-checksum',
      '--idempotency-key',
      '--reason',
      '--yes',
    ]) {
      const argv = mutationArgs(action).filter((value, index, values) =>
        missing === '--yes'
          ? value !== '--yes'
          : value !== missing && values[index - 1] !== missing,
      );
      expect(await run([...base, ...argv], ENV, home)).toBe(2);
    }
  });

  it('rejects duplicate and unknown flags before issuing a request', async () => {
    const requests = stubService({ [`${ROOT}/status?operation_id=${OPERATION_ID}`]: result() });
    expect(
      await run(
        [
          'platform-auth',
          'account-reset',
          'status',
          '--operation-id',
          OPERATION_ID,
          '--operation-id',
          OPERATION_ID,
        ],
        ENV,
        home,
      ),
    ).toBe(2);
    expect(
      await run(
        ['platform-auth', 'account-reset', 'status', '--operation-id', OPERATION_ID, '--unknown'],
        ENV,
        home,
      ),
    ).toBe(2);
    expect(requests).toHaveLength(0);
  });

  it('rejects preview flags that do not belong to the selected operation', async () => {
    const requests = stubService({});
    expect(
      await run(
        [
          'platform-auth',
          'account-reset',
          'preview',
          '--operation',
          'quarantine',
          '--target-file',
          targetFile,
          '--operation-id',
          OPERATION_ID,
        ],
        ENV,
        home,
      ),
    ).toBe(2);
    expect(
      await run(
        [
          'platform-auth',
          'account-reset',
          'preview',
          '--operation',
          'rollback',
          '--operation-id',
          OPERATION_ID,
          '--target-file',
          targetFile,
        ],
        ENV,
        home,
      ),
    ).toBe(2);
    expect(requests).toHaveLength(0);
  });

  it('redacts private values from HTTP and schema failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(PRIVATE_KEY, { status: 500, headers: { 'content-type': 'text/plain' } }),
      ),
    );
    expect(
      await run(
        [
          'platform-auth',
          'account-reset',
          'quarantine',
          '--operation-id',
          OPERATION_ID,
          ...mutationArgs('quarantine'),
        ],
        ENV,
        home,
      ),
    ).toBe(1);
    expect(combinedOutput()).not.toContain(PRIVATE_KEY);
    expect(combinedOutput()).not.toContain(PRIVATE_REASON);
    expect(combinedOutput()).not.toContain('SECRET_TOKEN');
  });

  it('redacts private canaries from malformed successful service responses', async () => {
    stubService({
      [`${ROOT}/preview`]: {
        schemaVersion: 1,
        operationId: OPERATION_ID,
        principalId: PRIVATE_PRINCIPAL,
        email: PRIVATE_EMAIL,
        providerId: PRIVATE_PROVIDER_ID,
        evidence: PRIVATE_KEY,
      },
    });

    expect(
      await run(
        [
          'platform-auth',
          'account-reset',
          'preview',
          '--operation',
          'quarantine',
          '--target-file',
          targetFile,
        ],
        ENV,
        home,
      ),
    ).toBe(1);
    for (const privateValue of [
      PRIVATE_PRINCIPAL,
      PRIVATE_EMAIL,
      PRIVATE_PROVIDER_ID,
      PRIVATE_KEY,
      targetFile,
      'SECRET_TOKEN',
    ]) {
      expect(combinedOutput()).not.toContain(privateValue);
    }
  });
});

function mutationArgs(_action: 'quarantine' | 'rollback' | 'finalize'): string[] {
  return [
    '--expected-generation',
    '4',
    '--release-sha',
    SHA,
    '--preview-checksum',
    CHECKSUM,
    '--idempotency-key',
    PRIVATE_KEY,
    '--reason',
    PRIVATE_REASON,
    '--yes',
  ];
}

function result() {
  return {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    lifecycle: 'previewed',
    releaseSha: SHA,
    rolloutGeneration: 4,
    sourceEpoch: 2,
    previewChecksum: CHECKSUM,
    counts: {
      targetCount: 3,
      suspendedPrincipalCount: 3,
      personalOrganizationCount: 3,
      soleOwnedOrganizationCount: 0,
      ownerOnlyAppCount: 4,
      preservedSharedOrganizationCount: 2,
      membershipCount: 5,
      billingAccountCount: 3,
      credentialCount: 3,
      providerObjectCount: 0,
      cleanupPendingCount: 0,
    },
    blockers: [],
  };
}

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly body?: Record<string, unknown>;
}

function stubService(responses: Readonly<Record<string, unknown>>): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request: CapturedRequest = {
        url: String(input),
        method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string'
          ? { body: JSON.parse(init.body) as Record<string, unknown> }
          : {}),
      };
      requests.push(request);
      const response = responses[request.url];
      return response === undefined
        ? new Response('not found', { status: 404 })
        : new Response(JSON.stringify({ ok: true, data: response }), {
            headers: { 'content-type': 'application/json' },
          });
    }),
  );
  return requests;
}

function stdout(): string {
  return log.mock.calls.map(([value]) => String(value)).join('\n');
}

function combinedOutput(): string {
  return [...log.mock.calls, ...error.mock.calls].flat().map(String).join('\n');
}
