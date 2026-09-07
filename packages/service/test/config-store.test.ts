import { SecretBox } from '@noodle-borg/runtime';
import { describe, expect, it, vi } from 'vitest';
import { type ConfigScope, InMemoryConfigStore, resolveConfigScope } from '../src/index.js';
import { resolveConfigValuesRow } from '../src/store/postgres-config.js';

describe('hierarchical managed config store', () => {
  const org: ConfigScope = { level: 'org', org: 'acme' };
  const app: ConfigScope = { level: 'app', org: 'acme', app: 'support' };
  const env: ConfigScope = { level: 'env', org: 'acme', app: 'support', env: 'prod' };

  it('resolves org -> app -> env inheritance with lower-scope overrides', async () => {
    const store = new InMemoryConfigStore();
    await store.setConfigValue({ kind: 'secret', scope: org, name: 'TOKEN', value: 'org-token' });
    await store.setConfigValue({ kind: 'secret', scope: app, name: 'TOKEN', value: 'app-token' });
    await store.setConfigValue({ kind: 'secret', scope: env, name: 'TOKEN', value: 'env-token' });
    await store.setConfigValue({ kind: 'secret', scope: org, name: 'ORG_ONLY', value: 'org-only' });
    await store.setConfigValue({ kind: 'secret', scope: app, name: 'APP_ONLY', value: 'app-only' });

    await expect(store.resolveConfigValues('secret', env)).resolves.toEqual({
      TOKEN: 'env-token',
      ORG_ONLY: 'org-only',
      APP_ONLY: 'app-only',
    });
  });

  it('falls back to the inherited value when a lower-scope override is deleted', async () => {
    const store = new InMemoryConfigStore();
    await store.setConfigValue({ kind: 'variable', scope: org, name: 'REGION', value: 'us' });
    await store.setConfigValue({ kind: 'variable', scope: env, name: 'REGION', value: 'eu' });

    expect((await store.resolveConfigValues('variable', env)).REGION).toBe('eu');
    await expect(store.deleteConfigValue('variable', env, 'REGION')).resolves.toBe(true);
    expect((await store.resolveConfigValues('variable', env)).REGION).toBe('us');
  });

  it('resolves only the requested effective name from the in-memory store', async () => {
    const store = new InMemoryConfigStore();
    await store.setConfigValue({
      kind: 'secret',
      scope: org,
      name: 'TARGET',
      value: 'org-target',
    });
    await store.setConfigValue({
      kind: 'secret',
      scope: app,
      name: 'TARGET',
      value: 'app-target',
    });
    await store.setConfigValue({
      kind: 'secret',
      scope: env,
      name: 'TARGET',
      value: 'env-target',
    });
    await store.setConfigValue({
      kind: 'secret',
      scope: env,
      name: 'UNRELATED',
      value: 'must-not-resolve',
    });

    await expect(store.resolveConfigValues('secret', env, 'TARGET')).resolves.toEqual({
      TARGET: 'env-target',
    });
  });

  it('predicates Postgres resolution by name before decrypting secret rows', async () => {
    const secretBox = new SecretBox({
      kind: 'static',
      keyId: 'test',
      key: () => Buffer.alloc(32, 7),
    });
    const environmentEnvelope = {
      enc: 'aes-256-gcm' as const,
      sealed: await secretBox.seal('environment-value'),
    };
    const appEnvelope = {
      enc: 'aes-256-gcm' as const,
      sealed: await secretBox.seal('app-value'),
    };
    const organizationEnvelope = {
      enc: 'aes-256-gcm' as const,
      sealed: {
        ...(await secretBox.seal('organization-value')),
        ct: 'corrupt-inherited-ciphertext',
      },
    };
    const unrelatedEnvelope = {
      enc: 'aes-256-gcm' as const,
      sealed: await secretBox.seal('must-not-decrypt'),
    };
    const rows = [
      {
        kind: 'secret' as const,
        scope_level: 'env',
        org_slug: 'acme',
        app_slug: 'support',
        environment: 'prod',
        name: 'TARGET',
        secret_value: environmentEnvelope,
        variable_value: null,
        updated_at: new Date('2026-07-23T00:00:00.000Z'),
        updated_by_subject: null,
        updated_by_email: null,
      },
      {
        kind: 'secret' as const,
        scope_level: 'app',
        org_slug: 'acme',
        app_slug: 'support',
        environment: '',
        name: 'TARGET',
        secret_value: appEnvelope,
        variable_value: null,
        updated_at: new Date('2026-07-23T00:00:00.000Z'),
        updated_by_subject: null,
        updated_by_email: null,
      },
      {
        kind: 'secret' as const,
        scope_level: 'org',
        org_slug: 'acme',
        app_slug: '',
        environment: '',
        name: 'TARGET',
        secret_value: organizationEnvelope,
        variable_value: null,
        updated_at: new Date('2026-07-23T00:00:00.000Z'),
        updated_by_subject: null,
        updated_by_email: null,
      },
      {
        kind: 'secret' as const,
        scope_level: 'env',
        org_slug: 'acme',
        app_slug: 'support',
        environment: 'prod',
        name: 'UNRELATED',
        secret_value: unrelatedEnvelope,
        variable_value: null,
        updated_at: new Date('2026-07-23T00:00:00.000Z'),
        updated_by_subject: null,
        updated_by_email: null,
      },
    ];
    const query = vi.fn(async (_sql: string, values: readonly unknown[]) => ({
      rows: rows.filter(
        (row) =>
          row.scope_level === values[1] &&
          row.org_slug === values[2] &&
          row.app_slug === values[3] &&
          row.environment === values[4] &&
          (values[5] === undefined || row.name === values[5]),
      ),
    }));
    const open = vi.spyOn(secretBox, 'open');

    await expect(
      resolveConfigValuesRow({ query } as never, secretBox, 'secret', env, 'TARGET'),
    ).resolves.toEqual({ TARGET: 'environment-value' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([
      'secret',
      'env',
      'acme',
      'support',
      'prod',
      'TARGET',
    ]);
    expect(open).toHaveBeenCalledTimes(1);
    for (const [sql, values] of query.mock.calls) {
      expect(sql).toContain('AND name = $6');
      expect(values).toEqual(expect.arrayContaining(['TARGET']));
    }
  });

  it('preserves low-to-high merging for unfiltered Postgres resolution', async () => {
    const rowsByScope = {
      org: [
        {
          name: 'TARGET',
          secret_value: null,
          variable_value: 'organization-value',
        },
      ],
      app: [{ name: 'TARGET', secret_value: null, variable_value: 'app-value' }],
      env: [{ name: 'TARGET', secret_value: null, variable_value: 'environment-value' }],
    };
    const query = vi.fn(async (_sql: string, values: readonly unknown[]) => ({
      rows: (rowsByScope[values[1] as keyof typeof rowsByScope] ?? []).map((row) => ({
        ...row,
        kind: 'variable' as const,
        scope_level: values[1] as string,
        org_slug: values[2] as string,
        app_slug: values[3] as string,
        environment: values[4] as string,
        updated_at: new Date('2026-07-23T00:00:00.000Z'),
        updated_by_subject: null,
        updated_by_email: null,
      })),
    }));

    await expect(
      resolveConfigValuesRow({ query } as never, undefined, 'variable', env),
    ).resolves.toEqual({ TARGET: 'environment-value' });
    expect(query.mock.calls.map((call) => call[1]?.[1])).toEqual(['org', 'app', 'env']);
    for (const [sql, values] of query.mock.calls) {
      expect(sql).not.toContain('AND name = $6');
      expect(values).toHaveLength(5);
    }
  });

  it('lists secret metadata without values and variable metadata with values', async () => {
    const store = new InMemoryConfigStore();
    await store.setConfigValue({
      kind: 'secret',
      scope: env,
      name: 'TOKEN',
      value: 'secret-value',
    });
    await store.setConfigValue({
      kind: 'variable',
      scope: env,
      name: 'BASE_URL',
      value: 'https://api',
    });

    const secrets = await store.listConfigValues('secret', env);
    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toMatchObject({ kind: 'secret', name: 'TOKEN', scope: env });
    expect(secrets[0]).not.toHaveProperty('value');

    const variables = await store.listConfigValues('variable', env);
    expect(variables).toHaveLength(1);
    expect(variables[0]).toMatchObject({
      kind: 'variable',
      name: 'BASE_URL',
      scope: env,
      value: 'https://api',
    });
  });

  it('parses supported route scopes and rejects malformed config names', () => {
    expect(resolveConfigScope({ org: 'acme' })).toEqual(org);
    expect(resolveConfigScope({ org: 'acme', app: 'support' })).toEqual(app);
    expect(resolveConfigScope({ org: 'acme', app: 'support', env: 'prod' })).toEqual(env);
    expect(() => resolveConfigScope({ org: 'acme', app: 'bad/app', env: 'prod' })).toThrow(
      /invalid app slug/,
    );
  });
});
