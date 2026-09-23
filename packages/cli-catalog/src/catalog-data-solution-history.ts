/** The installation history setting (ADR 0241 decision 6); imported by the solutions family. Data only. */
import {
  INSTALLATION_ARGUMENT,
  OPTIONAL_FLAG,
  SOLUTION_COMMON_FLAGS,
} from './catalog-data-solution-flags.js';
import type { FlagSpec, SubcommandSpec } from './catalog-types.js';

const days = (name: string, summary: string, conflictsWith: readonly string[] = []): FlagSpec => ({
  ...OPTIONAL_FLAG,
  name,
  type: 'integer',
  value: '<days>',
  summary,
  constraints: { minimum: 1, maximum: 365 },
  conflictsWith,
});
const channel = (name: string, summary: string): FlagSpec => ({
  ...OPTIONAL_FLAG,
  name,
  type: 'string',
  value: '<on|off>',
  summary,
  constraints: { choices: ['on', 'off'] },
});

export const SOLUTION_HISTORY: SubcommandSpec = {
  name: 'history',
  summary: 'Inspect or change how long Activity and conversations are kept.',
  arguments: [],
  flags: [],
  subcommands: [
    {
      name: 'settings',
      summary: 'Read or change the installation history setting within plan limits.',
      arguments: [],
      flags: [],
      subcommands: [
        {
          name: 'get',
          summary:
            'Read Activity and conversation durations, recording switches, edit permission and revision.',
          arguments: [INSTALLATION_ARGUMENT],
          flags: SOLUTION_COMMON_FLAGS,
          jsonOutput: { mode: 'single' },
        },
        {
          name: 'set',
          summary:
            'Change durations or recording switches with a revision check; shortening or turning off conversations needs --confirm.',
          arguments: [INSTALLATION_ARGUMENT],
          flags: [
            ...SOLUTION_COMMON_FLAGS,
            days('activity-days', 'Days to keep Activity, within the plan maximum.'),
            days('conversation-days', 'Days to keep conversations; turns recording on.', [
              'conversations',
            ]),
            {
              ...OPTIONAL_FLAG,
              name: 'conversations',
              type: 'string',
              value: 'off',
              summary: 'Turn conversation recording off.',
              constraints: { choices: ['off'] },
              conflictsWith: ['conversation-days'],
            },
            channel('website-visitors', 'Record anonymous website visitors.'),
            channel('signed-in-customers', 'Record signed-in customers.'),
            channel('whatsapp', 'Record WhatsApp conversations.'),
            {
              ...OPTIONAL_FLAG,
              required: true,
              name: 'expected-revision',
              type: 'string',
              value: '<hash>',
              summary: 'Revision returned by history settings get.',
            },
            {
              ...OPTIONAL_FLAG,
              name: 'confirm',
              type: 'boolean',
              summary:
                'Confirm a change that shortens or turns off conversation history; without it the effect is shown and nothing is saved.',
            },
          ],
          jsonOutput: { mode: 'single' },
        },
      ],
    },
  ],
};
