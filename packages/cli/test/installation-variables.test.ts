import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApplicationSettingsProjection } from '@noodle-borg/wire-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runConfigValues } from '../src/commands/config-values.js';
import { run } from '../src/index.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';

const revision = 'a'.repeat(64);
const schemaDigest = 'b'.repeat(64);
const target = ['--installation', 'ins-one', '--org', 'acme', '--runtime', 'cloud'];
const auth = ['--service', 'https://service.example.test', '--auth-token', 'test-token', '--json'];
let home: string;
let log: ReturnType<typeof vi.spyOn>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

function projection(): ApplicationSettingsProjection {
  return {
    revision,
    schemaDigest,
    releaseDigest: 'release-one',
    canEdit: true,
    declarations: [
      {
        name: 'NOTICE',
        schemaVersion: 1,
        schemaDigest,
        valueSchema: { type: 'string', maxLength: 500 },
        default: 'Private default notice',
        portal: { label: 'Notice', group: 'Experience' },
        requiredFor: ['show_notice'],
      },
      {
        name: 'ENABLED',
        schemaVersion: 1,
        schemaDigest,
        valueSchema: { type: 'boolean' },
        portal: { label: 'Enabled' },
        requiredFor: [],
      },
    ],
    values: { NOTICE: 'Private operator notice', ENABLED: false },
    provenance: { NOTICE: 'operator', ENABLED: 'default' },
    readiness: [{ tool: 'show_notice', ready: true, missing: [] }],
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-installation-variables-'));
  chdirIsolated(home);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => Response.json({ ok: true, data: projection() }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  restoreCwd();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

function output(): string {
  return log.mock.calls.map((args) => String(args[0])).join('\n');
}

function call(args: string[], kind: 'variable' | 'secret' = 'variable') {
  return runConfigValues(kind, [...args, ...target, ...auth], {}, home);
}

function patch(): unknown {
  const init = fetchMock.mock.calls[1]?.[1];
  expect(init?.method).toBe('PATCH');
  return JSON.parse(String(init?.body));
}

describe('installation-scoped variables', () => {
  it('uses the declared projection without printing operator/default values or inherited technical keys', async () => {
    const data = projection();
    data.values.TECHNICAL = 'Private technical value';
    data.provenance.TECHNICAL = 'organization';
    fetchMock.mockResolvedValue(Response.json({ ok: true, data }));
    expect(await call(['list'])).toBe(0);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://service.example.test/v1/orgs/acme/solution-installations/ins-one/settings',
    );
    const result = JSON.parse(output());
    expect(result.data).toMatchObject({
      revision,
      schemaDigest,
      settings: [
        { name: 'NOTICE', label: 'Notice', provenance: 'operator' },
        { name: 'ENABLED', label: 'Enabled', provenance: 'default' },
      ],
      readiness: [{ tool: 'show_notice', ready: true }],
    });
    expect(output()).not.toMatch(/Private|TECHNICAL/);
  });

  it('resolves one declared name and rejects an undeclared technical reference', async () => {
    expect(await call(['resolve', 'NOTICE'])).toBe(0);
    expect(JSON.parse(output()).data.settings).toHaveLength(1);
    log.mockClear();
    expect(await call(['resolve', 'TECHNICAL'])).toBe(2);
    expect(JSON.parse(output()).error.code).toBe('setting_not_declared');
  });

  it.each([
    ['NOTICE', '"Quoted notice"', 'Quoted notice'],
    ['ENABLED', 'true', true],
    ['ENABLED', 'false', false],
  ])('sets %s as a typed JSON value using the current revision', async (name, encoded, value) => {
    expect(await call(['set', String(name), '--value', String(encoded)])).toBe(0);
    expect(patch()).toEqual({
      expectedRevision: revision,
      schemaDigest,
      values: { [String(name)]: value },
    });
    expect(JSON.parse(output()).data).toMatchObject({ name, revision, disposition: 'set' });
    expect(output()).not.toMatch(/Quoted notice|Private|values|valueSchema/);
  });

  it('reuses the file input path and accepts a current explicit revision', async () => {
    writeFileSync(join(home, 'value.json'), '"File notice"\n');
    expect(
      await call([
        'set',
        'NOTICE',
        '--from-file',
        join(home, 'value.json'),
        '--expected-revision',
        revision,
      ]),
    ).toBe(0);
    expect(patch()).toEqual({
      expectedRevision: revision,
      schemaDigest,
      values: { NOTICE: 'File notice' },
    });
  });

  it('rejects invalid JSON without reflecting input or writing', async () => {
    expect(await call(['set', 'NOTICE', '--value', 'Unquoted private notice'])).toBe(2);
    expect(JSON.parse(output()).error.code).toBe('invalid_setting_value');
    expect(output()).not.toContain('Unquoted private notice');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a valid JSON value with the wrong declared type before dispatch', async () => {
    expect(await call(['set', 'ENABLED', '--value', '"true"'])).toBe(2);
    expect(JSON.parse(output()).error.code).toBe('invalid_setting_value');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects revoked installation access at the service boundary', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: 'Private access context' }, { status: 403 }),
    );
    expect(await call(['list'])).toBe(3);
    expect(JSON.parse(output()).error.code).toBe('settings_forbidden');
    expect(output()).not.toContain('Private');
  });

  it('fails closed on a malformed projection without printing its content', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ ok: true, data: { values: { SECRET: 'Private' } } }),
    );
    expect(await call(['set', 'NOTICE', '--value', '"Changed"'])).toBe(1);
    expect(JSON.parse(output()).error.code).toBe('invalid_service_response');
    expect(output()).not.toMatch(/Private|SECRET/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resets through the same atomic API so the service adopts the declared default', async () => {
    expect(await call(['delete', 'NOTICE'])).toBe(0);
    expect(patch()).toEqual({
      expectedRevision: revision,
      schemaDigest,
      values: {},
      resetKeys: ['NOTICE'],
    });
    expect(JSON.parse(output()).data.disposition).toBe('reset');
    expect(output()).not.toMatch(/Private|values|valueSchema/);
  });

  it('rejects an explicitly stale revision before sending a mutation', async () => {
    expect(
      await call(['set', 'NOTICE', '--value', '"Changed"', '--expected-revision', 'c'.repeat(64)]),
    ).toBe(1);
    expect(JSON.parse(output()).error.code).toBe('settings_conflict');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('allows non-administrator inspection but rejects writes before reading input', async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ ok: true, data: { ...projection(), canEdit: false } }),
    );
    expect(await call(['list'])).toBe(0);
    log.mockClear();
    expect(await call(['set', 'NOTICE', '--from-file', '/missing/private-file'])).toBe(3);
    expect(JSON.parse(output()).error.code).toBe('settings_forbidden');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [400, 'settings_invalid', 2],
    [403, 'settings_forbidden', 3],
    [409, 'settings_conflict', 1],
  ])('reports a bounded typed HTTP %s failure without retrying the PATCH or echoing values', async (status, code, exit) => {
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true, data: projection() }));
    fetchMock.mockResolvedValueOnce(
      Response.json({ code, error: 'Private rejected input' }, { status: Number(status) }),
    );
    expect(await call(['set', 'NOTICE', '--value', '"Private submitted value"'])).toBe(exit);
    expect(JSON.parse(output()).error.code).toBe(code);
    expect(output()).not.toContain('Private');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['variable', ['--runtime', 'local']],
    ['secret', []],
    ['variable', ['--app', 'other-app']],
    ['variable', ['--env', 'prod']],
    ['variable', ['--scope', 'env']],
  ] as const)('rejects incompatible %s targets %j without local writes or network access', async (kind, flags) => {
    expect(await runConfigValues(kind, ['list', ...target, ...flags, ...auth], {}, home)).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(join(home, '.env.noodle'))).toBe(false);
  });

  it('accepts the same public flags through catalog dispatch on a portable service', async () => {
    expect(
      await run(
        ['variables', 'list', ...target.slice(0, -2), '--runtime', 'other', ...auth],
        {},
        home,
      ),
    ).toBe(0);
  });

  it('rejects an expected revision outside installation mutations', async () => {
    expect(await call(['list', '--expected-revision', revision])).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not fall through to local configuration when the installation flag has no value', async () => {
    expect(
      await runConfigValues(
        'variable',
        ['set', 'NOTICE', '--installation', '--value', '"Private"', ...auth],
        {},
        home,
      ),
    ).toBe(2);
    expect(existsSync(join(home, '.env.noodle'))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(output()).not.toContain('Private');
  });
});
