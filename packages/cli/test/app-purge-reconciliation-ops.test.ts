import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeConfig } from '../src/config.js';
import { run } from '../src/index.js';

const SERVICE = 'https://svc.example';
const ROOT = `${SERVICE}/v1/service/app-purge-reconciliation`;
const SHA = 'a'.repeat(40);
const PRIVATE_TOKEN = 'private-auth-token';
const PRIVATE_KEY = 'private-idempotency-key';
const PRIVATE_APPROVAL = 'private-change-123';
const PRIVATE_RECOVERY = 'private-pitr-456';
const PRIVATE_REASON = 'private reviewed cleanup reason';
const PRIVATE_SERVER_VALUE = 'private-server-row';
const ENV = { NOODLE_DISABLE_UPDATE_CHECK: '1' };

let home: string;
let output: string;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-app-purge-ops-'));
  output = join(home, 'preview.json');
  writeConfig({ serviceUrl: SERVICE, authToken: PRIVATE_TOKEN }, home);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe('noodle service app-purge', () => {
  it('previews before exclusive artifact creation and prints only scalar coordination output', async () => {
    const artifact = previewArtifact();
    const requests = stubService({ [`${ROOT}/preview`]: { ok: true, artifact } });

    expect(
      await run(['service', 'app-purge', 'preview', '--output', output, '--json'], ENV, home),
    ).toBe(0);

    expect(requests).toEqual([
      {
        url: `${ROOT}/preview`,
        method: 'POST',
        redirect: 'manual',
        body: { schemaVersion: 1 },
      },
    ]);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(artifact);
    expect(JSON.parse(stdout())).toEqual({
      ok: true,
      data: {
        appPurge: {
          artifactPath: output,
          candidateCount: 1,
          checksum: artifact.checksum,
          releaseSha: SHA,
          expiresAt: artifact.expiresAt,
          truncated: false,
        },
      },
    });
    expect(combinedOutput()).not.toContain('old-app');
    expect(combinedOutput()).not.toContain(PRIVATE_TOKEN);
  });

  it('does not create an output file when preview service validation fails', async () => {
    stubService({
      [`${ROOT}/preview`]: {
        ok: true,
        artifact: { ...previewArtifact(), checksum: `sha256:${'0'.repeat(64)}` },
      },
    });

    expect(
      await run(['service', 'app-purge', 'preview', '--output', output, '--json'], ENV, home),
    ).toBe(1);
    expect(existsSync(output)).toBe(false);
    expect(combinedOutput()).not.toContain('old-app');
  });

  it('applies the entire validated artifact with exact evidence and prints scalar results', async () => {
    const artifact = previewArtifact();
    writeFileSync(output, JSON.stringify(artifact), { mode: 0o600 });
    chmodSync(output, 0o600);
    const response = {
      ok: true,
      replayed: false,
      result: {
        operationId: '00000000-0000-4000-8000-000000000099',
        previewChecksum: artifact.checksum,
        releaseSha: SHA,
        candidateCount: 1,
        deletedCount: 1,
        appliedAt: '2026-09-02T00:10:00.000Z',
      },
    };
    const requests = stubService({ [`${ROOT}/apply`]: response });

    expect(await run(applyCommand(), ENV, home)).toBe(0);

    expect(requests).toEqual([
      {
        url: `${ROOT}/apply`,
        method: 'POST',
        redirect: 'manual',
        body: {
          schemaVersion: 1,
          preview: artifact,
          releaseSha: SHA,
          approvalReference: PRIVATE_APPROVAL,
          recoveryCheckpoint: PRIVATE_RECOVERY,
          reason: PRIVATE_REASON,
          idempotencyKey: PRIVATE_KEY,
          confirmed: true,
        },
      },
    ]);
    expect(JSON.parse(stdout())).toEqual({
      ok: true,
      data: {
        appPurge: {
          operationId: response.result.operationId,
          previewChecksum: artifact.checksum,
          releaseSha: SHA,
          candidateCount: 1,
          deletedCount: 1,
          appliedAt: response.result.appliedAt,
          replayed: false,
        },
      },
    });
    expect(combinedOutput()).not.toContain(PRIVATE_KEY);
    expect(combinedOutput()).not.toContain(PRIVATE_APPROVAL);
    expect(combinedOutput()).not.toContain(PRIVATE_RECOVERY);
    expect(combinedOutput()).not.toContain(PRIVATE_REASON);
    expect(combinedOutput()).not.toContain('old-app');
  });

  it.each([
    401, 403,
  ])('maps HTTP %s to the existing auth exit class without private output', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { ok: false, error: `${PRIVATE_SERVER_VALUE} ${PRIVATE_KEY} ${PRIVATE_REASON}` },
          { status },
        ),
      ),
    );
    writePreview();

    expect(await run(applyCommand(), ENV, home)).toBe(3);
    expect(JSON.parse(stdout())).toMatchObject({ ok: false, error: { code: 'auth_failed' } });
    assertNoPrivateOutput();
  });

  it.each([
    ['service failure', 500, { ok: false, error: PRIVATE_SERVER_VALUE }],
    ['malformed success', 200, { ok: true, artifact: { privateRow: PRIVATE_SERVER_VALUE } }],
  ])('bounds a %s without leaking request or response evidence', async (_name, status, body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(body, { status })),
    );

    expect(
      await run(['service', 'app-purge', 'preview', '--output', output, '--json'], ENV, home),
    ).toBe(1);
    expect(existsSync(output)).toBe(false);
    expect(JSON.parse(stdout())).toMatchObject({
      ok: false,
      error: { next: 'noodle service app-purge preview --output <absolute-path>' },
    });
    assertNoPrivateOutput();
  });

  it('reports a lost apply response as unknown and requires replaying the exact apply', async () => {
    writePreview();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(`${PRIVATE_SERVER_VALUE} ${PRIVATE_KEY} ${PRIVATE_REASON}`);
      }),
    );

    expect(await run(applyCommand(), ENV, home)).toBe(4);
    expectUnknownApplyRecovery();
    assertNoPrivateOutput();
  });

  it('reports a malformed apply response as unknown and requires replaying the exact apply', async () => {
    writePreview();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true, result: { privateRow: PRIVATE_SERVER_VALUE } })),
    );

    expect(await run(applyCommand(), ENV, home)).toBe(1);
    expectUnknownApplyRecovery();
    assertNoPrivateOutput();
  });

  it.each([
    ['generic 500', 500, { ok: false, error: `${PRIVATE_SERVER_VALUE} ${PRIVATE_KEY}` }],
    ['generic 502', 502, { ok: false, error: `${PRIVATE_SERVER_VALUE} ${PRIVATE_REASON}` }],
    [
      'structured unavailable 503',
      503,
      {
        ok: false,
        code: 'app_purge_reconciliation_unavailable',
        error: `${PRIVATE_SERVER_VALUE} ${PRIVATE_APPROVAL}`,
      },
    ],
    ['generic 504', 504, { ok: false, error: `${PRIVATE_SERVER_VALUE} ${PRIVATE_RECOVERY}` }],
  ])('treats a %s apply response as potentially committed', async (_name, status, body) => {
    writePreview();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(body, { status })),
    );

    expect(await run(applyCommand(), ENV, home)).toBe(1);
    expectUnknownApplyRecovery();
    assertNoPrivateOutput();
  });

  it('rejects an apply result that does not match the approved preview evidence', async () => {
    writePreview();
    stubService({
      [`${ROOT}/apply`]: {
        ok: true,
        replayed: false,
        result: {
          operationId: '00000000-0000-4000-8000-000000000099',
          previewChecksum: `sha256:${'0'.repeat(64)}`,
          releaseSha: SHA,
          candidateCount: 1,
          deletedCount: 1,
          appliedAt: '2026-09-02T00:10:00.000Z',
        },
      },
    });

    expect(await run(applyCommand(), ENV, home)).toBe(1);
    expect(JSON.parse(stdout())).toMatchObject({
      ok: false,
      error: { code: 'app_purge_apply_outcome_unknown' },
    });
    assertNoPrivateOutput();
  });

  it('rejects a release that differs from the approved artifact before a request', async () => {
    writePreview();
    const requests = stubService({});
    const command = applyCommand();
    command[command.indexOf('--release-sha') + 1] = 'b'.repeat(40);

    expect(await run(command, ENV, home)).toBe(1);
    expect(requests).toHaveLength(0);
    assertNoPrivateOutput();
  });

  it('requires authentication before reading or sending an apply artifact', async () => {
    const requests = stubService({});
    const unauthenticatedHome = mkdtempSync(join(tmpdir(), 'noodle-app-purge-unauthenticated-'));
    try {
      expect(await run(applyCommand(), ENV, unauthenticatedHome)).toBe(3);
      expect(requests).toHaveLength(0);
    } finally {
      rmSync(unauthenticatedHome, { recursive: true, force: true });
    }
  });
});

function applyCommand(): string[] {
  return [
    'service',
    'app-purge',
    'apply',
    '--approved-preview',
    output,
    '--release-sha',
    SHA,
    '--approval-reference',
    PRIVATE_APPROVAL,
    '--recovery-checkpoint',
    PRIVATE_RECOVERY,
    '--reason',
    PRIVATE_REASON,
    '--idempotency-key',
    PRIVATE_KEY,
    '--yes',
    '--json',
  ];
}

function writePreview(): void {
  writeFileSync(output, JSON.stringify(previewArtifact()), { mode: 0o600 });
  chmodSync(output, 0o600);
}

function previewArtifact() {
  const unsigned = {
    schemaVersion: 1 as const,
    releaseSha: SHA,
    createdAt: '2026-09-02T00:00:00.000Z',
    expiresAt: '2026-09-02T00:15:00.000Z',
    candidateCount: 1,
    truncated: false,
    candidates: [
      {
        org: 'acme',
        app: 'old-app',
        anchorCreatedAt: '2026-01-01T00:00:00.000Z',
        purgeAuditId: '00000000-0000-4000-8000-000000000001',
        environments: [
          {
            name: 'prod',
            isProduction: true,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    ],
  };
  return {
    ...unsigned,
    checksum: `sha256:${createHash('sha256').update(JSON.stringify(unsigned)).digest('hex')}`,
  };
}

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly redirect?: RequestRedirect;
  readonly body?: unknown;
}

function stubService(responses: Readonly<Record<string, unknown>>): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = {
        url: String(input),
        method: init?.method ?? 'GET',
        ...(init?.redirect === undefined ? {} : { redirect: init.redirect }),
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
      };
      requests.push(request);
      const response = responses[request.url];
      return response === undefined
        ? new Response('not found', { status: 404 })
        : Response.json(response);
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

function assertNoPrivateOutput(): void {
  for (const value of [
    PRIVATE_TOKEN,
    PRIVATE_KEY,
    PRIVATE_APPROVAL,
    PRIVATE_RECOVERY,
    PRIVATE_REASON,
    PRIVATE_SERVER_VALUE,
    'old-app',
  ]) {
    expect(combinedOutput()).not.toContain(value);
  }
}

function expectUnknownApplyRecovery(): void {
  expect(JSON.parse(stdout())).toMatchObject({
    ok: false,
    error: {
      code: 'app_purge_apply_outcome_unknown',
      cause: expect.stringMatching(/may have committed/i),
      fix: expect.stringMatching(/replay the exact apply command/i),
      next: expect.stringMatching(/same approved artifact.*evidence.*idempotency key/i),
    },
  });
  expect(stdout()).toMatch(/do not create a new preview/i);
}
