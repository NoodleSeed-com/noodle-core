import { sha256Canonical } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { ApplicationSettings, type SettingsTarget } from '../src/application-settings.js';
import { InMemoryConfigStore } from '../src/store/config-values.js';

const scope = { level: 'env', org: 'acme', app: 'desk', env: 'prod' } as const;
function target(defaultValue = 30): SettingsTarget {
  const declaration = {
    name: 'DURATION',
    schemaVersion: 1 as const,
    valueSchema: { type: 'integer', minimum: 15, maximum: 90 },
    default: defaultValue,
    portal: { label: 'Duration' },
    requiredFor: ['book'],
  };
  return {
    scope,
    releaseDigest: `release-${defaultValue}`,
    declarations: [{ ...declaration, schemaDigest: sha256Canonical(declaration) }],
  };
}

describe('application settings over managed configuration', () => {
  it('pins accepted defaults across release changes and resets only explicitly', async () => {
    const config = new InMemoryConfigStore();
    const settings = new ApplicationSettings(config);
    await settings.initialize(target());
    const updated = await settings.read(target(45), true);
    expect(updated.values).toEqual({ DURATION: 30 });
    expect(updated.provenance).toEqual({ DURATION: 'default' });
    const saved = await settings.save(
      target(45),
      {
        expectedRevision: updated.revision,
        schemaDigest: updated.schemaDigest,
        values: {},
        resetKeys: ['DURATION'],
      },
      'admin',
    );
    expect(saved.values).toEqual({ DURATION: 45 });
  });

  it('isolates businesses and atomically rejects concurrent/stale saves', async () => {
    const settings = new ApplicationSettings(new InMemoryConfigStore());
    const first = await settings.read(target(), true);
    const input = {
      expectedRevision: first.revision,
      schemaDigest: first.schemaDigest,
      values: { DURATION: 60 },
    };
    const outcomes = await Promise.allSettled([
      settings.save(target(), input, 'one'),
      settings.save(target(), input, 'two'),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      await settings.read({ ...target(), scope: { ...scope, org: 'other' } }, true),
    ).toMatchObject({ values: { DURATION: 30 } });
    await expect(settings.save(target(45), input, 'admin')).rejects.toMatchObject({
      code: 'settings_conflict',
    });
  });

  it('rejects unknown and invalid values without partially committing', async () => {
    const settings = new ApplicationSettings(new InMemoryConfigStore());
    const current = await settings.read(target(), true);
    const input = { expectedRevision: current.revision, schemaDigest: current.schemaDigest };
    await expect(
      settings.save(target(), { ...input, values: { DURATION: 1000 } }, 'admin'),
    ).rejects.toMatchObject({ code: 'settings_invalid' });
    await expect(
      settings.save(target(), { ...input, values: { SECRET: 'hidden' } }, 'admin'),
    ).rejects.toMatchObject({ code: 'settings_invalid' });
    expect((await settings.read(target(), true)).revision).toBe(current.revision);
  });

  it('keeps technical declarations private and missing settings disable only dependent tools', async () => {
    const privateDeclaration = {
      ...target().declarations[0]!,
      name: 'TECHNICAL',
      portal: undefined,
    };
    const required = { ...target().declarations[0]!, name: 'REQUIRED', default: undefined };
    delete required.default;
    const settings = new ApplicationSettings(new InMemoryConfigStore());
    const result = await settings.read(
      { ...target(), declarations: [privateDeclaration, required] },
      false,
    );
    expect(result.declarations.map((item) => item.name)).toEqual(['REQUIRED']);
    expect(result.values).toEqual({});
    expect(result.readiness).toEqual([{ tool: 'book', ready: false, missing: ['REQUIRED'] }]);
    expect(result.canEdit).toBe(false);
  });

  it('uses the same validation and revision for inherited technical writes and deletes', async () => {
    const store = new InMemoryConfigStore();
    const settings = new ApplicationSettings(store);
    await settings.initialize(target());
    const before = await settings.read(target(), true);
    const input = {
      kind: 'variable' as const,
      scope: { level: 'org' as const, org: 'acme' },
      name: 'DURATION',
    };
    await expect(
      settings.writeTechnical([target()], { ...input, value: '"wrong"' }),
    ).rejects.toMatchObject({ code: 'settings_invalid' });
    await settings.writeTechnical([target()], { ...input, value: '45' });
    const after = await settings.read(target(), true);
    expect(after.values.DURATION).toBe(45);
    expect(after.provenance.DURATION).toBe('organization');
    expect(after.revision).not.toBe(before.revision);
    await settings.writeTechnical([target()], input);
    expect((await settings.read(target(), true)).values.DURATION).toBe(30);
  });
});
