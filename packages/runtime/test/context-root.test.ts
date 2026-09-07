import { compileManifest, InMemoryCatalog, type Manifest } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { StaticServiceBroker } from '../src/broker/static.js';
import { InMemoryConnector, InMemoryConnectorRegistry } from '../src/connector/in-memory.js';
import {
  type ExecuteDeps,
  executeAmbientContext,
  executePrompt,
  executeResource,
  executeTool,
  type InvocationContext,
} from '../src/index.js';

const contextSignature = {
  type: 'read' as const,
  input: {
    type: 'object',
    properties: { as_of: { type: 'string' } },
    required: ['as_of'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { defaultTeamId: { type: 'string' } },
    required: ['defaultTeamId'],
    additionalProperties: false,
  },
};

const providerSignature = {
  ...contextSignature,
  output: { type: 'object', additionalProperties: true },
};

const invocationContext: InvocationContext = {
  temporal: {
    instant: '2026-07-14T09:30:00.000Z',
    localDate: '2026-07-14',
    localTime: '10:30:00',
    utcOffset: '+01:00',
    weekday: 'Tuesday',
    timeZone: 'Europe/London',
    locale: 'en-GB',
    source: {
      locale: 'client-hint',
      timeZone: 'user-preference',
    },
  },
  ambientStatus: 'available',
  ambient: { defaultTeamId: 'team-1' },
  location: {
    latitude: 51.5072,
    longitude: -0.1276,
    city: 'London',
    region: 'England',
    country: 'GB',
    timeZone: 'Europe/London',
    source: 'client-hint',
  },
};

const manifest: Manifest = {
  manifestVersion: '1',
  server: {
    name: 'people',
    version: '1.0.0',
    title: 'People',
    context: {
      defaults: { locale: 'en-US', timeZone: 'UTC' },
      ambient: {
        outputSchema: contextSignature.output,
        fulfilment: {
          steps: [
            {
              id: 'load',
              use: 'calendar.get_context',
              args: { as_of: '${context.temporal.instant}' },
            },
          ],
          output: { defaultTeamId: '${steps.load.defaultTeamId}' },
        },
      },
    },
  },
  connectors: { calendar: { id: 'company_calendar', version: '1.0.0' } },
  tools: [
    {
      name: 'show_context',
      description: 'Show invocation context.',
      inputSchema: { type: 'object', additionalProperties: false },
      fulfilment: {
        steps: [],
        output: {
          instant: '${context.temporal.instant}',
          team: '${context.ambient.defaultTeamId}',
          timeZoneSource: '${context.temporal.source.timeZone}',
          latitude: '${context.location.latitude}',
          longitude: '${context.location.longitude}',
        },
      },
    },
  ],
  resources: [
    {
      name: 'current_context',
      uri: 'context://current',
      fulfilment: {
        steps: [],
        output: { value: '${context.ambient.defaultTeamId}' },
      },
    },
  ],
  prompts: [
    {
      name: 'today',
      fulfilment: {
        steps: [],
        output: { value: 'Today is ${context.temporal.localDate}' },
      },
    },
  ],
};

const catalog = new InMemoryCatalog([
  {
    id: 'company_calendar',
    version: '1.0.0',
    kind: 'catalog',
    operations: { get_context: providerSignature },
  },
]);

function setup(
  defaultTeamId: unknown = 'team-1',
  extraOutput: Readonly<Record<string, unknown>> = {},
  permissiveAmbientSchema = false,
  decorateOutput?: (output: Record<string, unknown>) => Record<string, unknown>,
) {
  const configuredManifest: Manifest = permissiveAmbientSchema
    ? {
        ...manifest,
        server: {
          ...manifest.server,
          context: {
            ...manifest.server.context,
            ambient: {
              ...manifest.server.context?.ambient,
              outputSchema: providerSignature.output,
              fulfilment: {
                ...manifest.server.context?.ambient?.fulfilment,
                output: {
                  defaultTeamId: '${steps.load.defaultTeamId}',
                  payload: '${steps.load}',
                },
              },
            },
          },
        },
      }
    : manifest;
  const compiled = compileManifest(configuredManifest, { catalog });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  const connector = new InMemoryConnector('company_calendar', '1.0.0', {
    get_context: {
      signature: providerSignature,
      handler: (args) => {
        const output = {
          defaultTeamId:
            args.as_of === invocationContext.temporal.instant ? defaultTeamId : 'wrong',
          ...extraOutput,
        };
        return decorateOutput?.(output) ?? output;
      },
    },
  });
  const deps: ExecuteDeps = {
    connectors: new InMemoryConnectorRegistry([connector]),
    broker: new StaticServiceBroker({ token: 'service-token' }),
    context: invocationContext,
  };
  return { artifact: compiled.artifact, deps };
}

describe('runtime invocation context', () => {
  it('exposes the same fixed snapshot to tool, resource, and prompt expressions', async () => {
    const { artifact, deps } = setup();

    await expect(executeTool(artifact, 'show_context', {}, deps)).resolves.toEqual({
      ok: true,
      output: {
        instant: '2026-07-14T09:30:00.000Z',
        team: 'team-1',
        timeZoneSource: 'user-preference',
        latitude: 51.5072,
        longitude: -0.1276,
      },
    });
    await expect(executeResource(artifact, 'current_context', {}, deps)).resolves.toEqual({
      ok: true,
      output: { value: 'team-1' },
    });
    await expect(executePrompt(artifact, 'today', {}, deps)).resolves.toEqual({
      ok: true,
      output: { value: 'Today is 2026-07-14' },
    });
  });

  it('executes the ambient provider against temporal context and validates its output', async () => {
    const { artifact, deps } = setup();

    await expect(executeAmbientContext(artifact, deps)).resolves.toEqual({
      ok: true,
      output: { defaultTeamId: 'team-1' },
    });
  });

  it('strips reserved connector result metadata before validating or exposing ambient context', async () => {
    const { artifact, deps } = setup('team-1', {
      __noodleResultMeta: { noodle: { projection: { cursor: 'host-only' } } },
    });

    await expect(executeAmbientContext(artifact, deps)).resolves.toEqual({
      ok: true,
      output: { defaultTeamId: 'team-1' },
    });
  });

  it.each([
    'own',
    'inherited',
  ] as const)('rejects ambient values with a credential-bearing %s toJSON hook', async (kind) => {
    const malicious = setup('team-1', {}, true, (output) => {
      const toJSON = () => ({
        defaultTeamId: 'team-1',
        apiKey: 'must-never-enter-model-context',
      });
      if (kind === 'own') {
        Object.defineProperty(output, 'toJSON', { value: toJSON });
      } else {
        Object.setPrototypeOf(output, { toJSON });
      }
      return output;
    });

    await expect(executeAmbientContext(malicious.artifact, malicious.deps)).resolves.toMatchObject({
      ok: false,
      error: { code: 'output_invalid', path: 'context.ambient.payload' },
    });
  });

  it('rejects an ambient result that violates the declared output schema', async () => {
    const { artifact, deps } = setup(42);

    await expect(executeAmbientContext(artifact, deps)).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'output_invalid',
        path: 'context.ambient.defaultTeamId',
      },
    });
  });

  it('rejects unbounded or credential-shaped ambient context after schema validation', async () => {
    const oversized = setup('team-1', { summary: 'x'.repeat(17 * 1024) }, true);
    await expect(executeAmbientContext(oversized.artifact, oversized.deps)).resolves.toMatchObject({
      ok: false,
      error: { code: 'output_invalid', path: 'context.ambient' },
    });

    const sensitive = setup('team-1', { apiKey: 'must-not-enter-context' }, true);
    await expect(executeAmbientContext(sensitive.artifact, sensitive.deps)).resolves.toMatchObject({
      ok: false,
      error: { code: 'output_invalid', path: 'context.ambient.payload.apiKey' },
    });

    const disguisedCredential = setup(
      'team-1',
      { summary: 'Bearer abcdefghijklmnopqrstuvwxyz123456' },
      true,
    );
    await expect(
      executeAmbientContext(disguisedCredential.artifact, disguisedCredential.deps),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'output_invalid', path: 'context.ambient.payload.summary' },
    });

    let nested: Readonly<Record<string, unknown>> = { value: true };
    for (let depth = 0; depth < 10; depth += 1) nested = { next: nested };
    const tooDeep = setup('team-1', { nested }, true);
    await expect(executeAmbientContext(tooDeep.artifact, tooDeep.deps)).resolves.toMatchObject({
      ok: false,
      error: { code: 'output_invalid' },
    });

    const tooMany = setup(
      'team-1',
      {
        values: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`k${index}`, index])),
      },
      true,
    );
    await expect(executeAmbientContext(tooMany.artifact, tooMany.deps)).resolves.toMatchObject({
      ok: false,
      error: { code: 'output_invalid' },
    });
  });
});
