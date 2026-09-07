import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLocalDevConfigStore,
  deleteLocalConfigValue,
  readLocalConfigValues,
  resolveLocalConfigValues,
  setLocalConfigValue,
} from '../src/local-config.js';

let dirs: string[] = [];
function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'noodle-local-config-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe('.env.noodle local hierarchical config', () => {
  it('uses project .env as a read-only dev fallback while .env.noodle remains authoritative', async () => {
    const cwd = tmpProject();
    writeFileSync(join(cwd, '.env'), 'TOKEN=dotenv-token\nREGION=dotenv-region\n');
    setLocalConfigValue(cwd, {
      kind: 'secret',
      scope: { level: 'env', org: 'acme', app: 'support', env: 'dev' },
      name: 'TOKEN',
      value: 'managed-token',
    });
    const store = createLocalDevConfigStore(cwd);
    const scope = { level: 'env' as const, org: 'acme', app: 'support', env: 'dev' };

    expect(await store.resolveConfigValues('secret', scope, 'TOKEN')).toEqual({
      TOKEN: 'managed-token',
    });
    expect(await store.resolveConfigValues('variable', scope, 'REGION')).toEqual({
      REGION: 'dotenv-region',
    });
    expect(readFileSync(join(cwd, '.env'), 'utf8')).toBe(
      'TOKEN=dotenv-token\nREGION=dotenv-region\n',
    );
  });

  it('writes scoped secret and variable lines and resolves env overrides', () => {
    const cwd = tmpProject();
    setLocalConfigValue(cwd, {
      kind: 'secret',
      scope: { level: 'org', org: 'acme' },
      name: 'TOKEN',
      value: 'org-token',
    });
    setLocalConfigValue(cwd, {
      kind: 'secret',
      scope: { level: 'env', org: 'acme', app: 'support', env: 'prod' },
      name: 'TOKEN',
      value: 'env-token',
    });
    setLocalConfigValue(cwd, {
      kind: 'variable',
      scope: { level: 'env', org: 'acme', app: 'support', env: 'prod' },
      name: 'REGION',
      value: 'us',
    });

    expect(readFileSync(join(cwd, '.env.noodle'), 'utf8')).toContain(
      'secret org/acme TOKEN=org-token',
    );
    expect(
      resolveLocalConfigValues(cwd, 'secret', { org: 'acme', app: 'support', env: 'prod' }),
    ).toEqual({ TOKEN: 'env-token' });
    expect(
      resolveLocalConfigValues(cwd, 'variable', { org: 'acme', app: 'support', env: 'prod' }),
    ).toEqual({ REGION: 'us' });
  });

  it('lists metadata-only secrets and value-bearing variables', () => {
    const cwd = tmpProject();
    setLocalConfigValue(cwd, {
      kind: 'secret',
      scope: { level: 'org', org: 'acme' },
      name: 'TOKEN',
      value: 'org-token',
    });
    setLocalConfigValue(cwd, {
      kind: 'variable',
      scope: { level: 'org', org: 'acme' },
      name: 'REGION',
      value: 'us',
    });

    expect(
      readLocalConfigValues(cwd, 'secret', { level: 'org', org: 'acme' })[0],
    ).not.toHaveProperty('value');
    expect(readLocalConfigValues(cwd, 'variable', { level: 'org', org: 'acme' })[0]).toMatchObject({
      value: 'us',
    });
  });

  it('deletes lower-scope overrides and falls back to inherited values', () => {
    const cwd = tmpProject();
    setLocalConfigValue(cwd, {
      kind: 'variable',
      scope: { level: 'org', org: 'acme' },
      name: 'REGION',
      value: 'us',
    });
    setLocalConfigValue(cwd, {
      kind: 'variable',
      scope: { level: 'env', org: 'acme', app: 'support', env: 'prod' },
      name: 'REGION',
      value: 'eu',
    });

    expect(
      deleteLocalConfigValue(
        cwd,
        'variable',
        { level: 'env', org: 'acme', app: 'support', env: 'prod' },
        'REGION',
      ),
    ).toBe(true);
    expect(
      resolveLocalConfigValues(cwd, 'variable', { org: 'acme', app: 'support', env: 'prod' }),
    ).toEqual({ REGION: 'us' });
  });

  it.each([
    ['line feed', 'first-line\nsecond-line'],
    ['carriage return', 'first-line\rsecond-line'],
  ])('rejects a local value containing a %s before creating the managed file', (_label, value) => {
    const cwd = tmpProject();

    expect(() =>
      setLocalConfigValue(cwd, {
        kind: 'secret',
        scope: { level: 'org', org: 'acme' },
        name: 'TOKEN',
        value,
      }),
    ).toThrow('local managed values must be a single line');
    expect(existsSync(join(cwd, '.env.noodle'))).toBe(false);
  });

  it('keeps the existing managed file byte-identical after rejecting a multiline value', () => {
    const cwd = tmpProject();
    setLocalConfigValue(cwd, {
      kind: 'variable',
      scope: { level: 'org', org: 'acme' },
      name: 'REGION',
      value: 'us',
    });
    const path = join(cwd, '.env.noodle');
    const before = readFileSync(path, 'utf8');

    expect(() =>
      setLocalConfigValue(cwd, {
        kind: 'secret',
        scope: { level: 'org', org: 'acme' },
        name: 'TOKEN',
        value: 'first-line\nsecond-line',
      }),
    ).toThrow('local managed values must be a single line');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('reports a malformed line number without repeating its contents', () => {
    const cwd = tmpProject();
    const disclosureMarker = 'CONFIDENTIAL_CONTINUATION_MARKER';
    writeFileSync(
      join(cwd, '.env.noodle'),
      `secret org/acme TOKEN=first-line\n${disclosureMarker}\n`,
      { mode: 0o600 },
    );

    expect(() => readLocalConfigValues(cwd, 'secret', { level: 'org', org: 'acme' })).toThrow(
      'invalid .env.noodle syntax at line 2',
    );
    try {
      readLocalConfigValues(cwd, 'secret', { level: 'org', org: 'acme' });
    } catch (error) {
      expect(String(error)).not.toContain(disclosureMarker);
    }
  });

  it('redacts malformed content that reaches scope validation', () => {
    const cwd = tmpProject();
    const disclosureMarker = 'CONFIDENTIAL_SCOPE_MARKER';
    writeFileSync(join(cwd, '.env.noodle'), `secret ${disclosureMarker} TOKEN=value\n`, {
      mode: 0o600,
    });

    expect(() => readLocalConfigValues(cwd, 'secret', { level: 'org', org: 'acme' })).toThrow(
      'invalid .env.noodle syntax at line 1',
    );
    try {
      readLocalConfigValues(cwd, 'secret', { level: 'org', org: 'acme' });
    } catch (error) {
      expect(String(error)).not.toContain(disclosureMarker);
    }
  });
});
