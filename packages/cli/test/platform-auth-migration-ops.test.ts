import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  PlatformAuthOperationPreview,
  PlatformAuthOperationResult,
  PlatformAuthOperatorSnapshot,
} from '@noodle-borg/wire-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, writeConfig } from '../src/index.js';

const SERVICE = 'https://cloud.noodleseed.dev';
const ROOT = `${SERVICE}/v1/platform-auth/migration`;
const SHA = 'a'.repeat(40);
const CHECKSUM = 'b'.repeat(64);
const PREVIEW_CHECKSUM = 'c'.repeat(64);
const ROLLBACK_REHEARSAL_CHECKSUM = '6'.repeat(64);
const STAGING_WORKOS_ONLY_SMOKE_CHECKSUM = '7'.repeat(64);
const PRIVATE_KEY = 'private-idempotency-key';
const PRIVATE_REASON = 'approved internal rollout';
const ENV = { NOODLE_DISABLE_UPDATE_CHECK: '1' };
const SNAPSHOT: PlatformAuthOperatorSnapshot = {
  schemaVersion: 1,
  releaseSha: SHA,
  rollout: {
    generation: 4,
    workosPercentage: 10,
    lifecycle: 'workos',
    canaryClientSetHash: 'd'.repeat(64),
    canaryClientCount: 1,
    recoveryClientSetHash: 'e'.repeat(64),
    recoveryClientCount: 1,
    workosDefaultSince: null,
  },
  inventory: {
    state: 'ready',
    phase: 'completed',
    remotePages: 2,
    remoteUsers: 12,
    localSubjects: 15,
    candidateCount: 12,
    excludedCount: 3,
    checksum: CHECKSUM,
    blockers: [],
  },
  import: {
    state: 'running',
    total: 12,
    pending: 2,
    reconcileRequired: 1,
    linked: 9,
    blocked: 0,
    failed: 0,
    activeLeases: 0,
    nextRetryAt: null,
  },
  synchronization: {
    outbox: { status: 'ready', pending: 0, lastSuccessAgeSeconds: 12 },
    events: { status: 'ready', lastSuccessAgeSeconds: 12 },
  },
  remoteVerification: {
    state: 'running',
    checkedCount: 9,
    candidateCount: 12,
    verifiedCount: 9,
    retryAt: null,
  },
};

let home: string;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-platform-auth-'));
  writeConfig({ serviceUrl: SERVICE, authToken: 'SECRET_TOKEN' }, home);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe('noodle platform-auth migration', () => {
  it('registers one canonical command with migration help', async () => {
    expect(await run(['platform-auth', '--help'], ENV, home)).toBe(0);
    expect(stdout()).toContain('platform-auth migration');
    expect(stdout()).toContain('start-import');
    expect(stdout()).toContain('reconcile');
    expect(stdout()).toContain('finalize');
    expect(stdout()).toContain('--generation <n>');
    expect(stdout()).toContain('--rollback-rehearsal-checksum <checksum>');
    expect(stdout()).toContain('--staging-workos-only-smoke-checksum <checksum>');
    expect(stdout()).toContain(
      'Reuse the same generation until inventory reaches a terminal state.',
    );
    expect(stdout()).toContain('Maximum identities advanced by one bounded operation.');
  });

  it.each(['inventory', 'status'] as const)('reads aggregate-only %s status', async (action) => {
    const requests = stubService({ [`${ROOT}/${action}`]: SNAPSHOT });
    expect(await run(['platform-auth', 'migration', action, '--json'], ENV, home)).toBe(0);
    expect(requests).toEqual([
      expect.objectContaining({
        url: `${ROOT}/${action}`,
        method: 'GET',
        authorization: 'Bearer SECRET_TOKEN',
        redirect: 'manual',
      }),
    ]);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      ok: true,
      data: { service: SERVICE, migration: SNAPSHOT },
    });
    expect(stdout()).not.toMatch(/person@example|google-sub|workos-user/);
  });

  it('requests a fresh inventory generation without changing the release', async () => {
    const url = `${ROOT}/inventory?generation=1`;
    const requests = stubService({ [url]: SNAPSHOT });
    expect(
      await run(
        ['platform-auth', 'migration', 'inventory', '--generation', '1', '--json'],
        ENV,
        home,
      ),
    ).toBe(0);
    expect(requests).toEqual([expect.objectContaining({ url, method: 'GET', redirect: 'manual' })]);
  });

  it('shows only durable completed inventory counts and the exact resume command', async () => {
    const running = {
      ...SNAPSHOT,
      inventory: {
        ...SNAPSHOT.inventory,
        state: 'running' as const,
        phase: 'remote' as const,
        remotePages: 2,
        remoteUsers: 173,
        localSubjects: 0,
        candidateCount: 0,
        excludedCount: 0,
        checksum: null,
      },
      import: {
        ...SNAPSHOT.import,
        state: 'not_started' as const,
        total: 0,
        pending: 0,
        reconcileRequired: 0,
        linked: 0,
      },
      remoteVerification: {
        ...SNAPSHOT.remoteVerification,
        state: 'not_started' as const,
        checkedCount: 0,
        candidateCount: 0,
        verifiedCount: 0,
      },
    };
    const url = `${ROOT}/inventory?generation=2`;
    stubService({ [url]: running });

    expect(
      await run(['platform-auth', 'migration', 'inventory', '--generation', '2'], ENV, home),
    ).toBe(0);

    expect(stdout()).toContain('Inventory: RUNNING');
    expect(stdout()).toContain('Inventory phase: REMOTE');
    expect(stdout()).toContain('WorkOS pages read: 2');
    expect(stdout()).toContain('WorkOS users read: 173');
    expect(stdout()).toContain('Local subjects frozen: 0');
    expect(stdout()).toContain('Next: noodle platform-auth migration inventory --generation 2');
    expect(stdout()).not.toMatch(/inventory[^\n]*\d+%/i);
  });

  it('shows remote verification completed counts and its bounded retry timing', async () => {
    const retryAt = '2026-07-21T12:30:00.000Z';
    const blocked = {
      ...SNAPSHOT,
      import: {
        ...SNAPSHOT.import,
        state: 'completed' as const,
        pending: 0,
        reconcileRequired: 0,
        linked: SNAPSHOT.import.total,
      },
      remoteVerification: {
        state: 'blocked' as const,
        checkedCount: 10,
        candidateCount: 12,
        verifiedCount: 9,
        retryAt,
      },
    };
    stubService({ [`${ROOT}/status`]: blocked });

    expect(await run(['platform-auth', 'migration', 'status'], ENV, home)).toBe(1);

    expect(stdout()).toContain('Platform authentication migration: BLOCKED');
    expect(stdout()).toContain('Remote verification: BLOCKED');
    expect(stdout()).toContain('Remote checks completed: 10/12');
    expect(stdout()).toContain('Remote identities verified: 9');
    expect(stdout()).toContain(`Remote retry at: ${retryAt}`);
    expect(stdout()).toContain(
      `Next: wait until ${retryAt}, then preview and run another reconcile batch.`,
    );
    expect(stdout()).not.toMatch(/verification[^\n]*\d+%/i);
  });

  it('previews an activation, dedupes client IDs, and exits one when blocked', async () => {
    const blocked = preview({
      ready: false,
      previewChecksum: null,
      blockers: [{ code: 'unresolved_imports', count: 3 }],
    });
    const requests = stubService({ [`${ROOT}/preview`]: blocked });
    const code = await run(
      [
        'platform-auth',
        'migration',
        'preview',
        '--operation',
        'activate',
        '--percentage',
        '10',
        '--cohort-mode',
        'replace',
        '--canary-client-id',
        'canary-a',
        '--canary-client-id',
        'canary-a',
        '--recovery-client-id',
        'recovery-a',
        '--json',
      ],
      ENV,
      home,
    );
    expect(code).toBe(1);
    expect(requests[0]).toMatchObject({
      url: `${ROOT}/preview`,
      method: 'POST',
      redirect: 'manual',
      body: {
        schemaVersion: 1,
        operation: 'activate',
        percentage: 10,
        cohortMode: 'replace',
        canaryClientIds: ['canary-a'],
        recoveryClientIds: ['recovery-a'],
      },
    });
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: true,
      data: { migration: { ready: false, previewChecksum: null } },
    });
    expect(stdout()).not.toContain('canary-a');
  });

  it('binds both operational evidence checksums into a finalize preview', async () => {
    const requests = stubService({
      [`${ROOT}/preview`]: preview({ operation: 'finalize' }),
    });
    expect(
      await run(
        [
          'platform-auth',
          'migration',
          'preview',
          '--operation',
          'finalize',
          ...finalizationEvidenceFlags(),
          '--json',
        ],
        ENV,
        home,
      ),
    ).toBe(0);
    expect(requests[0]?.body).toEqual({
      schemaVersion: 1,
      operation: 'finalize',
      rollbackRehearsalChecksum: ROLLBACK_REHEARSAL_CHECKSUM,
      stagingWorkosOnlySmokeChecksum: STAGING_WORKOS_ONLY_SMOKE_CHECKSUM,
    });
  });

  it('binds one secure typed acceleration approval into activate preview and mutation', async () => {
    const approvalFile = join(home, 'acceleration-approval.json');
    const accelerationApproval = {
      schemaVersion: 1,
      exception: 'exact_three_legacy_cutover',
      targetEnvironment: 'production',
      releaseSha: SHA,
      expectedGeneration: 4,
      fromPercentage: 10,
      toPercentage: 50,
      approvedAt: '2026-07-28T12:00:00.000Z',
      evidence: {
        stageVolumeChecksum: '1'.repeat(64),
        criticalSmokesChecksum: '2'.repeat(64),
        rollbackSmokeChecksum: '3'.repeat(64),
      },
    };
    writeFileSync(approvalFile, JSON.stringify(accelerationApproval), { mode: 0o600 });
    chmodSync(approvalFile, 0o600);
    const requests = stubService({
      [`${ROOT}/preview`]: preview(),
      [`${ROOT}/activate`]: mutation('activate'),
    });

    expect(
      await run(
        [
          'platform-auth',
          'migration',
          'preview',
          '--operation',
          'activate',
          '--percentage',
          '50',
          '--cohort-mode',
          'preserve',
          '--acceleration-approval',
          approvalFile,
          '--json',
        ],
        ENV,
        home,
      ),
    ).toBe(0);
    expect(
      await run(
        [
          'platform-auth',
          'migration',
          'activate',
          ...evidenceFlags(),
          '--percentage',
          '50',
          '--cohort-mode',
          'preserve',
          '--acceleration-approval',
          approvalFile,
          '--yes',
          '--json',
        ],
        ENV,
        home,
      ),
    ).toBe(0);
    expect(requests.map((request) => request.body)).toEqual([
      {
        schemaVersion: 1,
        operation: 'activate',
        percentage: 50,
        cohortMode: 'preserve',
        accelerationApproval,
      },
      {
        schemaVersion: 1,
        expectedGeneration: 4,
        releaseSha: SHA,
        previewChecksum: PREVIEW_CHECKSUM,
        idempotencyKey: PRIVATE_KEY,
        reason: PRIVATE_REASON,
        confirmed: true,
        percentage: 50,
        cohortMode: 'preserve',
        accelerationApproval,
      },
    ]);
    expect(stdout()).not.toContain(approvalFile);
  });

  it('rejects unsafe acceleration approval files and inapplicable operations before network use', async () => {
    const approvalFile = join(home, 'approval.json');
    const link = join(home, 'approval-link.json');
    writeFileSync(approvalFile, '{}', { mode: 0o600 });
    symlinkSync(approvalFile, link);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    expect(
      await run(
        [
          'platform-auth',
          'migration',
          'preview',
          '--operation',
          'activate',
          '--percentage',
          '50',
          '--cohort-mode',
          'preserve',
          '--acceleration-approval',
          link,
          '--json',
        ],
        ENV,
        home,
      ),
    ).toBe(2);
    expect(
      await run(
        [
          'platform-auth',
          'migration',
          'preview',
          '--operation',
          'rollback',
          '--acceleration-approval',
          approvalFile,
          '--json',
        ],
        ENV,
        home,
      ),
    ).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(stdout()).not.toContain(link);
  });

  it('rejects every unsafe approval-file shape and redacts its path in JSON and text failures', async () => {
    const wrongMode = join(home, 'wrong-mode-approval.json');
    const directory = join(home, 'approval-directory');
    const oversize = join(home, 'oversize-approval.json');
    const malformedJson = join(home, 'malformed-json-approval.json');
    const typedInvalid = join(home, 'typed-invalid-approval.json');
    writeFileSync(wrongMode, '{}', { mode: 0o640 });
    chmodSync(wrongMode, 0o640);
    mkdirSync(directory);
    writeFileSync(oversize, 'x'.repeat(16 * 1024 + 1), { mode: 0o600 });
    chmodSync(oversize, 0o600);
    writeFileSync(malformedJson, '{"schemaVersion":', { mode: 0o600 });
    chmodSync(malformedJson, 0o600);
    writeFileSync(
      typedInvalid,
      JSON.stringify({
        schemaVersion: 1,
        exception: 'unapproved_exception',
        targetEnvironment: 'production',
      }),
      { mode: 0o600 },
    );
    chmodSync(typedInvalid, 0o600);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    for (const path of [wrongMode, directory, oversize, malformedJson, typedInvalid]) {
      expect(
        await run(
          [
            'platform-auth',
            'migration',
            'preview',
            '--operation',
            'activate',
            '--percentage',
            '50',
            '--cohort-mode',
            'preserve',
            '--acceleration-approval',
            path,
            '--json',
          ],
          ENV,
          home,
        ),
      ).toBe(2);
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
        ok: false,
        error: { code: 'invalid_acceleration_approval' },
      });
      expect(stdout()).not.toContain(path);
      expect(stderr()).not.toContain(path);
      log.mockClear();
      error.mockClear();
    }

    expect(
      await run(
        [
          'platform-auth',
          'migration',
          'preview',
          '--operation',
          'activate',
          '--percentage',
          '50',
          '--cohort-mode',
          'preserve',
          '--acceleration-approval',
          typedInvalid,
        ],
        ENV,
        home,
      ),
    ).toBe(2);
    expect(stdout()).not.toContain(typedInvalid);
    expect(stderr()).not.toContain(typedInvalid);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    'start-import',
    'reconcile',
    'activate',
    'rollback',
    'finalize',
  ] as const)('requires --yes before any %s network request', async (action) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await run(mutationArgs(action, '--json'), ENV, home)).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'confirmation_required', next: expect.stringContaining('--yes') },
    });
  });

  it.each([
    'start-import',
    'reconcile',
    'activate',
    'rollback',
    'finalize',
  ] as const)('sends one strict confirmed %s mutation and redacts private inputs', async (action) => {
    const operation = action === 'start-import' ? 'start_import' : action;
    const result = mutation(operation);
    const requests = stubService({ [`${ROOT}/${action}`]: result });
    expect(await run(mutationArgs(action, '--yes', '--json'), ENV, home), stderr()).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: `${ROOT}/${action}`,
      method: 'POST',
      authorization: 'Bearer SECRET_TOKEN',
      redirect: 'manual',
      body: expect.objectContaining({
        schemaVersion: 1,
        expectedGeneration: 4,
        releaseSha: SHA,
        previewChecksum: PREVIEW_CHECKSUM,
        idempotencyKey: PRIVATE_KEY,
        reason: PRIVATE_REASON,
        confirmed: true,
      }),
    });
    if (action === 'reconcile') expect(requests[0]?.body).toMatchObject({ batchSize: 25 });
    if (action === 'activate') {
      expect(requests[0]?.body).toMatchObject({
        percentage: 10,
        cohortMode: 'replace',
        canaryClientIds: ['canary-a'],
        recoveryClientIds: ['recovery-a'],
      });
    }
    if (action === 'finalize') {
      expect(requests[0]?.body).toMatchObject({
        rollbackRehearsalChecksum: ROLLBACK_REHEARSAL_CHECKSUM,
        stagingWorkosOnlySmokeChecksum: STAGING_WORKOS_ONLY_SMOKE_CHECKSUM,
      });
    }
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      ok: true,
      data: { service: SERVICE, migration: result },
    });
    expect(stdout()).not.toContain(PRIVATE_KEY);
    expect(stdout()).not.toContain(PRIVATE_REASON);
    expect(stdout()).not.toContain('canary-a');
    expect(stdout()).not.toContain('recovery-a');
  });

  it('rejects redirects without forwarding the privileged request body or bearer token', async () => {
    const forwarded: Array<{
      readonly authorization: string | null;
      readonly body: string | null;
    }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.redirect === 'manual') {
          return new Response(null, {
            status: 307,
            headers: { location: 'https://attacker.example/collect' },
          });
        }
        forwarded.push({
          authorization: new Headers(init?.headers).get('authorization'),
          body: typeof init?.body === 'string' ? init.body : null,
        });
        return new Response(JSON.stringify({ ok: true, data: mutation('activate') }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    expect(await run(mutationArgs('activate', '--yes', '--json'), ENV, home)).toBe(1);
    expect(forwarded).toEqual([]);
  });

  it.each([
    {
      name: 'processed batch',
      result: {
        ...mutation('reconcile'),
        import: { ...SNAPSHOT.import, state: 'running' as const },
      },
      exit: 0,
      labels: [
        'PROCESSED',
        'Migration state: RUNNING',
        'Remote verification: RUNNING',
        'Remote checks completed: 9/12',
        'Remote identities verified: 9',
      ],
    },
    {
      name: 'repaired terminal retry',
      result: {
        ...mutation('reconcile'),
        import: {
          ...SNAPSHOT.import,
          state: 'completed' as const,
          pending: 0,
          reconcileRequired: 0,
          linked: SNAPSHOT.import.total,
        },
        remoteVerification: {
          state: 'ready' as const,
          checkedCount: SNAPSHOT.inventory.candidateCount,
          candidateCount: SNAPSHOT.inventory.candidateCount,
          verifiedCount: SNAPSHOT.inventory.candidateCount,
          retryAt: null,
        },
        batch: { ...reconcileBatch(), retryRequired: 0 },
      },
      exit: 0,
      labels: ['COMPLETED', 'Migration state: COMPLETED'],
    },
    {
      name: 'unresolved failed terminal retry',
      result: {
        ...mutation('reconcile'),
        import: { ...SNAPSHOT.import, state: 'failed' as const, failed: 1 },
        batch: { ...reconcileBatch(), failed: 1 },
      },
      exit: 1,
      labels: ['FAILED', 'Migration state: FAILED'],
    },
    {
      name: 'unresolved blocked terminal retry',
      result: {
        ...mutation('reconcile'),
        import: { ...SNAPSHOT.import, state: 'running' as const, blocked: 1 },
        batch: { ...reconcileBatch(), blocked: 1 },
      },
      exit: 1,
      labels: ['BLOCKED', 'Migration state: RUNNING'],
    },
  ])('reports a $name truthfully', async ({ result, exit, labels }) => {
    stubService({ [`${ROOT}/reconcile`]: result });
    expect(await run(mutationArgs('reconcile', '--yes'), ENV, home)).toBe(exit);
    for (const label of labels) expect(stdout()).toContain(label);
  });

  it('keeps preserve, replace, and explicit cohort clearing distinct', async () => {
    const requests = stubService({ [`${ROOT}/preview`]: preview() });
    for (const target of [
      ['--cohort-mode', 'preserve'],
      [
        '--cohort-mode',
        'replace',
        '--canary-client-id',
        'canary-a',
        '--recovery-client-id',
        'recovery-a',
      ],
      ['--cohort-mode', 'replace'],
    ]) {
      expect(
        await run(
          [
            'platform-auth',
            'migration',
            'preview',
            '--operation',
            'activate',
            '--percentage',
            '10',
            ...target,
            '--json',
          ],
          ENV,
          home,
        ),
      ).toBe(0);
    }

    expect(requests.map((request) => request.body)).toEqual([
      {
        schemaVersion: 1,
        operation: 'activate',
        percentage: 10,
        cohortMode: 'preserve',
      },
      {
        schemaVersion: 1,
        operation: 'activate',
        percentage: 10,
        cohortMode: 'replace',
        canaryClientIds: ['canary-a'],
        recoveryClientIds: ['recovery-a'],
      },
      {
        schemaVersion: 1,
        operation: 'activate',
        percentage: 10,
        cohortMode: 'replace',
        canaryClientIds: [],
        recoveryClientIds: [],
      },
    ]);
  });

  it.each([
    {
      name: 'running',
      snapshot: SNAPSHOT,
      exit: 0,
      label: 'Platform authentication migration: RUNNING',
    },
    {
      name: 'completed',
      snapshot: {
        ...SNAPSHOT,
        import: {
          ...SNAPSHOT.import,
          state: 'completed' as const,
          pending: 0,
          reconcileRequired: 0,
          linked: SNAPSHOT.import.total,
        },
        remoteVerification: {
          state: 'ready' as const,
          checkedCount: SNAPSHOT.inventory.candidateCount,
          candidateCount: SNAPSHOT.inventory.candidateCount,
          verifiedCount: SNAPSHOT.inventory.candidateCount,
          retryAt: null,
        },
      },
      exit: 0,
      label: 'Platform authentication migration: COMPLETED',
    },
    {
      name: 'failed',
      snapshot: {
        ...SNAPSHOT,
        import: { ...SNAPSHOT.import, state: 'failed' as const, failed: 1 },
      },
      exit: 1,
      label: 'Platform authentication migration: FAILED',
    },
    {
      name: 'blocked',
      snapshot: {
        ...SNAPSHOT,
        import: { ...SNAPSHOT.import, state: 'running' as const, blocked: 1 },
      },
      exit: 1,
      label: 'Platform authentication migration: BLOCKED',
    },
  ])('reports $name status with a truthful exit code', async ({ name, snapshot, exit, label }) => {
    stubService({ [`${ROOT}/status`]: snapshot });
    expect(await run(['platform-auth', 'migration', 'status'], ENV, home)).toBe(exit);
    expect(stdout()).toContain(label);
    expect(stdout()).toContain('Inventory: READY');
    if (name === 'blocked') {
      expect(stdout()).toContain(
        'Next: repair the reported import blocker, then preview another reconcile batch.',
      );
    }
  });

  it('sends preserve and explicit cohort clearing distinctly on activation', async () => {
    const result = mutation('activate');
    const requests = stubService({ [`${ROOT}/activate`]: result });
    for (const target of [
      ['--cohort-mode', 'preserve'],
      ['--cohort-mode', 'replace'],
    ]) {
      expect(
        await run(
          [
            'platform-auth',
            'migration',
            'activate',
            ...evidenceFlags(),
            '--percentage',
            '10',
            ...target,
            '--yes',
            '--json',
          ],
          ENV,
          home,
        ),
      ).toBe(0);
    }

    expect(requests.map((request) => request.body)).toEqual([
      {
        schemaVersion: 1,
        expectedGeneration: 4,
        releaseSha: SHA,
        previewChecksum: PREVIEW_CHECKSUM,
        idempotencyKey: PRIVATE_KEY,
        reason: PRIVATE_REASON,
        confirmed: true,
        percentage: 10,
        cohortMode: 'preserve',
      },
      {
        schemaVersion: 1,
        expectedGeneration: 4,
        releaseSha: SHA,
        previewChecksum: PREVIEW_CHECKSUM,
        idempotencyKey: PRIVATE_KEY,
        reason: PRIVATE_REASON,
        confirmed: true,
        percentage: 10,
        cohortMode: 'replace',
        canaryClientIds: [],
        recoveryClientIds: [],
      },
    ]);
  });

  it('rejects unknown, duplicate, and operation-inapplicable flags without network', async () => {
    for (const args of [
      ['inventory', '--percentage', '10'],
      ['reconcile', ...evidenceFlags(), '--batch-size', '25', '--batch-size', '50', '--yes'],
      ['rollback', ...evidenceFlags(), '--percentage', '10', '--yes'],
      ['preview', '--operation', 'finalize', '--batch-size', '10'],
      [
        'preview',
        '--operation',
        'activate',
        '--percentage',
        '10',
        '--cohort-mode',
        'preserve',
        ...finalizationEvidenceFlags(),
      ],
    ]) {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      expect(await run(['platform-auth', 'migration', ...args, '--json'], ENV, home)).toBe(2);
      expect(fetch).not.toHaveBeenCalled();
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
        ok: false,
        error: { code: 'usage' },
      });
      error.mockClear();
      vi.unstubAllGlobals();
    }
  });

  it('requires both operational evidence checksums for finalize without making a request', async () => {
    for (const args of [
      ['preview', '--operation', 'finalize'],
      ['finalize', ...evidenceFlags(), '--yes'],
      [
        'finalize',
        ...evidenceFlags(),
        '--rollback-rehearsal-checksum',
        ROLLBACK_REHEARSAL_CHECKSUM,
        '--yes',
      ],
      [
        'preview',
        '--operation',
        'finalize',
        '--rollback-rehearsal-checksum',
        'A'.repeat(64),
        '--staging-workos-only-smoke-checksum',
        STAGING_WORKOS_ONLY_SMOKE_CHECKSUM,
      ],
    ]) {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      expect(await run(['platform-auth', 'migration', ...args, '--json'], ENV, home)).toBe(2);
      expect(fetch).not.toHaveBeenCalled();
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
        ok: false,
        error: { code: 'usage' },
      });
      error.mockClear();
      vi.unstubAllGlobals();
    }
  });

  it('tolerates additive success fields, rejects malformed payloads, and redacts server errors', async () => {
    stubService({ [`${ROOT}/status`]: { ...SNAPSHOT, privateEmail: 'person@example.test' } });
    expect(await run(['platform-auth', 'migration', 'status', '--json'], ENV, home)).toBe(0);

    const { releaseSha: _releaseSha, ...malformed } = SNAPSHOT;
    stubService({ [`${ROOT}/status`]: malformed });
    expect(await run(['platform-auth', 'migration', 'status', '--json'], ENV, home)).toBe(1);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'invalid_service_response' },
    });

    error.mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              code: 'preview_mismatch',
              error: `rejected ${PRIVATE_KEY} ${PRIVATE_REASON} canary-a`,
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    expect(await run(mutationArgs('activate', '--yes', '--json'), ENV, home)).toBe(1);
    expect(stderr()).not.toContain(PRIVATE_KEY);
    expect(stderr()).not.toContain(PRIVATE_REASON);
    expect(stderr()).not.toContain('canary-a');
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'preview_mismatch' },
    });
  });
});

function preview(
  overrides: Partial<PlatformAuthOperationPreview> = {},
): PlatformAuthOperationPreview {
  return {
    ...SNAPSHOT,
    operation: 'activate',
    ready: true,
    previewChecksum: PREVIEW_CHECKSUM,
    blockers: [],
    target: {
      percentage: 10,
      batchSize: null,
      cohortMode: 'replace',
      canaryClientSetHash: 'f'.repeat(64),
      canaryClientCount: 1,
      recoveryClientSetHash: '1'.repeat(64),
      recoveryClientCount: 1,
    },
    ...overrides,
  };
}

function mutation(
  operation: PlatformAuthOperationResult['operation'],
): PlatformAuthOperationResult {
  return {
    ...SNAPSHOT,
    operation,
    replayed: false,
    batch:
      operation === 'reconcile'
        ? {
            attempted: 3,
            linked: 2,
            blocked: 0,
            retryRequired: 1,
            failed: 0,
            outbox: {
              status: 'ready',
              attempted: 2,
              delivered: 2,
              blocked: 0,
              retryRequired: 0,
            },
            events: {
              status: 'ready',
              processed: 1,
            },
          }
        : null,
  };
}

function reconcileBatch(): NonNullable<PlatformAuthOperationResult['batch']> {
  const batch = mutation('reconcile').batch;
  if (batch === null) throw new Error('expected reconcile batch');
  return batch;
}

function mutationArgs(
  action: 'start-import' | 'reconcile' | 'activate' | 'rollback' | 'finalize',
  ...extra: string[]
): string[] {
  const target =
    action === 'reconcile'
      ? ['--batch-size', '25']
      : action === 'activate'
        ? [
            '--percentage',
            '10',
            '--cohort-mode',
            'replace',
            '--canary-client-id',
            'canary-a',
            '--recovery-client-id',
            'recovery-a',
          ]
        : action === 'finalize'
          ? finalizationEvidenceFlags()
          : [];
  return ['platform-auth', 'migration', action, ...evidenceFlags(), ...target, ...extra];
}

function finalizationEvidenceFlags(): string[] {
  return [
    '--rollback-rehearsal-checksum',
    ROLLBACK_REHEARSAL_CHECKSUM,
    '--staging-workos-only-smoke-checksum',
    STAGING_WORKOS_ONLY_SMOKE_CHECKSUM,
  ];
}

function evidenceFlags(): string[] {
  return [
    '--expected-generation',
    '4',
    '--release-sha',
    SHA,
    '--preview-checksum',
    PREVIEW_CHECKSUM,
    '--idempotency-key',
    PRIVATE_KEY,
    '--reason',
    PRIVATE_REASON,
  ];
}

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly redirect: RequestRedirect | undefined;
  readonly body?: Record<string, unknown>;
}

function stubService(responses: Readonly<Record<string, unknown>>): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const request: CapturedRequest = {
        url,
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization'),
        redirect: init?.redirect,
        ...(typeof init?.body === 'string'
          ? { body: JSON.parse(init.body) as Record<string, unknown> }
          : {}),
      };
      requests.push(request);
      const response = responses[url];
      if (response === undefined) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify({ ok: true, data: response }), {
        status: url.endsWith('/start-import') ? 201 : 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return requests;
}

function stdout(): string {
  return log.mock.calls.map(([value]) => String(value)).join('\n');
}

function stderr(): string {
  return error.mock.calls.map(([value]) => String(value)).join('\n');
}
