import { compileManifest } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { server, tool, z } from '../src/index.js';

describe('elicitation authoring', () => {
  it('records a stable, schema-backed input step and returns its symbolic scope', async () => {
    const app = server('time_off', { title: 'Time off', version: '1.0.0' }, [
      tool('request_time_off', {
        description: 'Prepare a time-off request.',
        input: z.object({ start: z.string() }),
        fulfil(ctx) {
          const choice = ctx.elicit({
            id: 'choose_team',
            message: 'Which team should receive this request?',
            input: z.object({ teamId: z.string().describe('Team') }),
          });
          return { start: ctx.input.start, teamId: choice.teamId };
        },
      }),
    ]);

    const manifest = await app.toManifest();
    expect(manifest.tools[0]?.fulfilment).toEqual({
      steps: [
        {
          id: 'choose_team',
          elicit: {
            message: 'Which team should receive this request?',
            requestedSchema: expect.objectContaining({
              type: 'object',
              properties: { teamId: expect.objectContaining({ type: 'string' }) },
              required: ['teamId'],
            }),
          },
        },
      ],
      output: { start: '${input.start}', teamId: '${steps.choose_team.teamId}' },
    });
    expect(compileManifest(manifest).ok).toBe(true);
  });

  it('rejects duplicate explicit elicitation step ids while recording', async () => {
    const app = server('duplicate_input', { title: 'Duplicate input', version: '1.0.0' }, [
      tool('ask_twice', {
        description: 'Ask twice.',
        input: z.object({}),
        fulfil(ctx) {
          ctx.elicit({ id: 'answer', message: 'First?', input: z.object({ first: z.string() }) });
          const second = ctx.elicit({
            id: 'answer',
            message: 'Second?',
            input: z.object({ second: z.string() }),
          });
          return { second: second.second };
        },
      }),
    ]);

    await expect(app.toManifest()).rejects.toThrow(/duplicate fulfilment step id "answer"/);
  });
});
