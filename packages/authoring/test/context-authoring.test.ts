import { describe, expect, it } from 'vitest';
import { connector, prompt, resource, server, tool, z } from '../src/index.js';

const calendar = connector('company_calendar')
  .version('1.0.0')
  .operation('get_context', {
    type: 'read',
    input: z.object({ subject: z.string(), as_of: z.string() }),
    output: z.object({ default_team_id: z.string(), holidays: z.array(z.string()) }),
  })
  .operation('change_calendar', {
    type: 'action',
    input: z.object({ subject: z.string() }),
    output: z.object({ ok: z.boolean() }),
  });

describe('invocation context authoring', () => {
  it('leaves Core-v2 context discovery to an explicit context-provider tool', async () => {
    const app = server('temporal', { title: 'Temporal', version: '1.0.0' }, [
      tool('today', {
        description: 'Return the current local date.',
        input: z.object({}),
        fulfil: ({ context }) => ({ date: context.temporal.localDate }),
      }),
    ]);

    const manifest = await app.toManifest();

    expect(manifest.server.context).toBeUndefined();
    expect(manifest.tools[0]?.fulfilment.output).toEqual({ date: '${context.temporal.localDate}' });
  });

  it('records server defaults, a read-only ambient provider, and context expressions on every fulfilment surface', async () => {
    const app = server(
      'people',
      {
        title: 'People',
        version: '1.0.0',
        use: { calendar },
        context: {
          defaults: { locale: 'en-GB', timeZone: 'Europe/London' },
          ambient: {
            output: z.object({
              defaultTeamId: z.string(),
              holidays: z.array(z.string()),
            }),
            fulfil: ({ user, context, connectors }) => {
              const current = connectors.calendar.getContext({
                subject: user.subject,
                as_of: context.temporal.instant,
              });
              return {
                defaultTeamId: current.default_team_id,
                holidays: current.holidays,
              };
            },
          },
        },
      },
      [
        tool('show_context', {
          description: 'Show invocation context.',
          input: z.object({}),
          fulfil: ({ context }) => ({
            instant: context.temporal.instant,
            team: context.ambient.defaultTeamId,
            status: context.ambientStatus,
            latitude: context.location.latitude.optional(),
            longitude: context.location.longitude.optional(),
          }),
        }),
        resource('context_resource', {
          uri: 'context://current',
          fulfil: ({ context }) => ({ team: context.ambient.defaultTeamId }),
        }),
        prompt('context_prompt', {
          fulfil: ({ context }) => `Today is ${context.temporal.localDate}`,
        }),
      ],
    );

    const manifest = await app.toManifest();

    expect(manifest.server.context).toMatchObject({
      defaults: { locale: 'en-GB', timeZone: 'Europe/London' },
      ambient: {
        outputSchema: {
          type: 'object',
          required: ['defaultTeamId', 'holidays'],
          additionalProperties: false,
        },
        fulfilment: {
          steps: [
            {
              id: 'get_context',
              use: 'calendar.get_context',
              args: {
                subject: '${user.subject}',
                as_of: '${context.temporal.instant}',
              },
            },
          ],
          output: {
            defaultTeamId: '${steps.get_context.default_team_id}',
            holidays: '${steps.get_context.holidays}',
          },
        },
      },
    });
    expect(manifest.tools[0]?.fulfilment.output).toEqual({
      instant: '${context.temporal.instant}',
      team: '${context.ambient.defaultTeamId}',
      status: '${context.ambientStatus}',
      latitude: '${context.location.latitude}',
      longitude: '${context.location.longitude}',
    });
    expect(manifest.resources?.[0]?.fulfilment.output).toEqual({
      value: { team: '${context.ambient.defaultTeamId}' },
    });
    expect(manifest.prompts?.[0]?.fulfilment.output).toEqual({
      value: 'Today is ${context.temporal.localDate}',
    });
  });

  it('rejects side-effecting connector operations while recording ambient context', async () => {
    const app = server(
      'unsafe_context',
      {
        title: 'Unsafe Context',
        version: '1.0.0',
        use: { calendar },
        context: {
          ambient: {
            output: z.object({ ok: z.boolean() }),
            fulfil: ({ user, connectors }) => {
              const result = connectors.calendar.changeCalendar({ subject: user.subject });
              return { ok: result.ok };
            },
          },
        },
      },
      [
        tool('noop', {
          description: 'No-op.',
          input: z.object({}),
          fulfil: () => ({ ok: true }),
        }),
      ],
    );

    await expect(app.toManifest()).rejects.toThrow(
      /ambient context.*read-only.*calendar\.change_calendar/i,
    );
  });
});
