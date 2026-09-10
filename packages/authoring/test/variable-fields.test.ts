import { describe, expect, expectTypeOf, it } from 'vitest';
import { compileManifest, InMemoryCatalog } from '../../compiler/src/index.js';
import {
  executePreparedTool,
  executeTool,
  InMemoryConnectorRegistry,
  prepareToolForConfirmation,
  StaticServiceBroker,
} from '../../runtime/src/index.js';
import { server, tool, variable, z } from '../src/index.js';

describe('typed variable field references', () => {
  const settings = () =>
    variable('BOOKING_SETTINGS', {
      schema: z.object({
        calendarId: z.string().max(200),
        hours: z.array(z.object({ weekday: z.number().int().min(1).max(7) })).max(7),
        branding: z.object({ title: z.string().max(100) }),
        administrativeOnly: z.boolean(),
      }),
    });

  it('selects declared fields through the existing managed variable reference and inventory', async () => {
    const config = settings();
    expectTypeOf(config.field)
      .parameter(0)
      .toEqualTypeOf<'calendarId' | 'hours' | 'branding' | 'administrativeOnly'>();
    expectTypeOf(config.field('branding').field).parameter(0).toEqualTypeOf<'title'>();
    const app = server('settings', { title: 'Settings', version: '1', variables: [config] }, [
      tool('read_settings', {
        description: 'Read explicitly exposed settings.',
        input: z.object({}),
        fulfil: () => ({
          calendarId: config.field('calendarId'),
          hours: config.field('hours'),
          title: config.field('branding').field('title'),
        }),
      }),
    ]);
    const manifest = await app.toManifest();
    expect(manifest.tools[0]?.fulfilment.output).toEqual({
      calendarId: '${env.BOOKING_SETTINGS.calendarId}',
      hours: '${env.BOOKING_SETTINGS.hours}',
      title: '${env.BOOKING_SETTINGS.branding.title}',
    });
    const compiled = compileManifest(manifest, { catalog: new InMemoryCatalog([]) });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.artifact.config?.variables).toEqual(['BOOKING_SETTINGS']);
    expect(compiled.artifact.server.variables).toHaveLength(1);
    expect(String(config.field('calendarId'))).toBe('${env.BOOKING_SETTINGS.calendarId}');
    const value = {
      calendarId: 'calendar@example.com',
      hours: [{ weekday: 1 }],
      branding: { title: 'Appointments' },
      administrativeOnly: false,
    };
    const deps = {
      connectors: new InMemoryConnectorRegistry([]),
      broker: new StaticServiceBroker({}),
      env: { BOOKING_SETTINGS: JSON.stringify(value) },
    };
    expect(await executeTool(compiled.artifact, 'read_settings', {}, deps)).toEqual({
      ok: true,
      output: { calendarId: value.calendarId, hours: value.hours, title: value.branding.title },
    });
    const prepared = await prepareToolForConfirmation(compiled.artifact, 'read_settings', {}, deps);
    expect(prepared.status).toBe('confirmation_required');
    if (prepared.status !== 'confirmation_required') return;
    expect(
      await executePreparedTool(compiled.artifact, prepared.continuation, {
        ...deps,
        env: { BOOKING_SETTINGS: JSON.stringify({ ...value, administrativeOnly: true }) },
      }),
    ).toMatchObject({ status: 'failed', error: { code: 'configuration_changed' } });
  });

  it('rejects undeclared, inherited, non-object and unsafe property paths before emitting data', () => {
    const config = settings();
    const select = config.field as (key: string) => unknown;
    for (const key of [
      'missing',
      'toString',
      '__proto__',
      'constructor',
      'calendarId.secret',
      'calendarId}',
    ]) {
      expect(() => select(key), key).toThrow(/declared object field/);
    }
    expect(() => (config.field('calendarId').field as (key: string) => unknown)('length')).toThrow(
      /declared object field/,
    );
    expect(() => (config.field('hours').field as (key: string) => unknown)('0')).toThrow(
      /declared object field/,
    );
    expect(variable('TECHNICAL')).not.toHaveProperty('field');
  });
});
