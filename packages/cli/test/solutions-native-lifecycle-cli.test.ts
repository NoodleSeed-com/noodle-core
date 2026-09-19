import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSolutions } from '../src/commands/solutions-ops.js';

describe('native record lifecycle CLI', () => {
  let home: string;
  const env = { NOODLE_SERVICE_URL: 'https://service.example', NOODLE_AUTH_TOKEN: 'private-token' };
  const preview = {
    policy: 'legacy_expiry',
    installationRevision: 1,
    observedAt: '2030-01-01T00:00:00.000Z',
    recordsToPreserve: 2,
    expiredRecords: 1,
    digest: 'a'.repeat(64),
  };
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'noodle-lifecycle-cli-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });
  it.each(['preview', 'migrate'])('uses the authenticated typed %s endpoint', async (operation) => {
    const data =
      operation === 'preview'
        ? preview
        : {
            policy: 'explicit_erasure',
            installationRevision: 2,
            recordsPreserved: 2,
            replayed: false,
          };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true, data: { ...data, additive: true } }));
    const args = [
      'records',
      'lifecycle',
      operation,
      'site',
      '--org',
      'acme',
      '--json',
      ...(operation === 'migrate' ? ['--preview', JSON.stringify(preview), '--confirm'] : []),
    ];
    expect(await runSolutions(args, env, home, { fetchImpl })).toBe(0);
    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error('request missing');
    expect(call[0]).toBe(
      'https://service.example/v1/orgs/acme/solution-installations/site/record-lifecycle',
    );
    expect(call[1]?.method).toBe(operation === 'preview' ? 'GET' : 'POST');
    if (operation === 'migrate')
      expect(JSON.parse(String(call[1]?.body))).toEqual({ preview, confirm: true });
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain('private-token');
  });
  it.each([
    ['migrate', 'site', '--org', 'acme', '--preview', JSON.stringify(preview)],
    ['migrate', 'site', '--org', 'acme', '--confirm'],
    ['preview', 'site', '--org', 'acme', '--confirm'],
    ['migrate', 'site', '--org', 'acme', '--confirm', '--preview', '{"secret":"hidden-invalid"'],
    ['preview', 'site'],
  ])('refuses invalid or unreviewed changes without contacting the service', async (...args) => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(
      await runSolutions(['records', 'lifecycle', ...args, '--json'], env, home, { fetchImpl }),
    ).not.toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      JSON.stringify([
        ...vi.mocked(console.log).mock.calls,
        ...vi.mocked(console.error).mock.calls,
      ]),
    ).not.toContain('hidden-invalid');
  });
});
