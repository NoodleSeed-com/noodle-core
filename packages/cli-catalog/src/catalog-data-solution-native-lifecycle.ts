/** Native-record lifecycle review; no automatic data migration. */
import {
  INSTALLATION_ARGUMENT,
  OPTIONAL_FLAG,
  SOLUTION_COMMON_FLAGS,
} from './catalog-data-solution-flags.js';
import type { SubcommandSpec } from './catalog-types.js';

const common = SOLUTION_COMMON_FLAGS.map((flag) =>
  flag.name === 'org' ? { ...flag, required: true } : flag,
);
export const SOLUTION_NATIVE_LIFECYCLE: SubcommandSpec = {
  name: 'lifecycle',
  summary: 'Review and explicitly preserve available native records until erasure.',
  arguments: [],
  flags: [],
  subcommands: [
    {
      name: 'preview',
      summary: 'Inspect current policy and preservation counts without changing records.',
      arguments: [INSTALLATION_ARGUMENT],
      flags: common,
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'migrate',
      summary: 'Apply a reviewed one-way migration; never restore expired or erased records.',
      arguments: [INSTALLATION_ARGUMENT],
      flags: [
        ...common,
        {
          ...OPTIONAL_FLAG,
          name: 'preview',
          type: 'string',
          value: '<json>',
          required: true,
          summary:
            'Exact preview data JSON, valid for five minutes and only while the reviewed inventory is unchanged.',
        },
        {
          ...OPTIONAL_FLAG,
          name: 'confirm',
          type: 'boolean',
          required: true,
          summary:
            'Confirm preserving available and future records until explicit erasure. Activity history is unchanged.',
        },
      ],
      jsonOutput: { mode: 'single' },
    },
  ],
};
