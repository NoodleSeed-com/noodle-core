import { describe, expect, it } from 'vitest';
import { InMemoryCatalog } from '../src/catalog/in-memory.js';
import { compile } from '../src/compile.js';

const readCatalog = new InMemoryCatalog([
  {
    id: 'company_calendar',
    version: '1.0.0',
    kind: 'catalog',
    operations: {
      get_context: {
        type: 'read',
        input: {
          type: 'object',
          properties: { as_of: { type: 'string' } },
          required: ['as_of'],
          additionalProperties: false,
        },
        output: {
          type: 'object',
          properties: { default_team_id: { type: 'string' } },
          required: ['default_team_id'],
          additionalProperties: false,
        },
      },
    },
  },
]);

function manifest(operationType: 'read' | 'action' = 'read'): string {
  return `manifestVersion: "1"
server:
  name: people
  version: 1.0.0
  title: People
  context:
    defaults:
      locale: en-GB
      timeZone: Europe/London
    ambient:
      outputSchema:
        type: object
        properties:
          defaultTeamId: { type: string }
        required: [defaultTeamId]
        additionalProperties: false
      fulfilment:
        steps:
          - id: current
            use: calendar.get_context
            args:
              as_of: \${context.temporal.instant}
        output:
          defaultTeamId: \${steps.current.default_team_id}
connectors:
  calendar:
    id: company_calendar
    version: 1.0.0
tools:
  - name: show_context
    description: Show invocation context.
    inputSchema:
      type: object
      additionalProperties: false
    fulfilment:
      steps: []
      output:
        instant: \${context.temporal.instant}
        team: \${context.ambient.defaultTeamId}
        operationType: ${operationType}
`;
}

describe('compiled invocation context', () => {
  it('emits defaults, a resolved ambient fulfilment, and parsed context-root expressions', () => {
    const result = compile(manifest(), { catalog: readCatalog });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.server.context).toMatchObject({
      defaults: { locale: 'en-GB', timeZone: 'Europe/London' },
      ambient: {
        outputSchema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          required: ['defaultTeamId'],
        },
        fulfilment: {
          kind: 'flow',
          steps: [
            {
              id: 'current',
              kind: 'operation',
              operationRef: {
                resolved: true,
                alias: 'calendar',
                connectorId: 'company_calendar',
                connectorVersion: '1.0.0',
                operation: 'get_context',
              },
              args: {
                as_of: {
                  kind: 'path',
                  root: 'context',
                  segments: [
                    { kind: 'prop', name: 'temporal' },
                    { kind: 'prop', name: 'instant' },
                  ],
                },
              },
            },
          ],
        },
      },
    });
    expect(result.artifact.tools[0]?.fulfilment).toMatchObject({
      kind: 'flow',
      output: {
        team: {
          kind: 'path',
          root: 'context',
          segments: [
            { kind: 'prop', name: 'ambient' },
            { kind: 'prop', name: 'defaultTeamId' },
          ],
        },
      },
    });
  });

  it('rejects an action operation in an ambient provider at catalog resolution', () => {
    const actionCatalog = new InMemoryCatalog([
      {
        id: 'company_calendar',
        version: '1.0.0',
        kind: 'catalog',
        operations: {
          get_context: {
            type: 'action',
            input: {
              type: 'object',
              properties: { as_of: { type: 'string' } },
              required: ['as_of'],
              additionalProperties: false,
            },
            output: { type: 'object', additionalProperties: true },
          },
        },
      },
    ]);

    const result = compile(manifest('action'), { catalog: actionCatalog });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'ambient_context_action',
        path: 'server.context.ambient.fulfilment.steps.0.use',
      }),
    );
  });

  it('collects managed variables referenced only by the ambient provider', () => {
    const source = manifest().replace('${context.temporal.instant}', '${env.AMBIENT_AS_OF}');

    const result = compile(source, { catalog: readCatalog });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.config).toEqual({ variables: ['AMBIENT_AS_OF'] });
  });

  it('reserves the cross-surface context adapter tool name', () => {
    const source = manifest().replace('name: show_context', 'name: noodle_context');

    const result = compile(source, { catalog: readCatalog });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual({
      code: 'reserved_name',
      path: 'tools.0.name',
      message: 'tool name "noodle_context" is reserved by the platform',
    });
  });

  it('allows an author tool named noodle_context when no context adapter is declared', () => {
    const result = compile(`manifestVersion: "1"
server:
  name: plain
  version: 1.0.0
  title: Plain
tools:
  - name: noodle_context
    description: An ordinary author tool on a server without platform context.
    inputSchema: { type: object }
    fulfilment:
      steps: []
      output: { ok: true }
`);
    expect(result.ok).toBe(true);
  });
});
