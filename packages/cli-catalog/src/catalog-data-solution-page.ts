/** Hosted-page operator catalog. Pure data; execution remains in the CLI. */
import {
  EXPECTED_REVISION,
  INSTALLATION_ARGUMENT,
  OPTIONAL_FLAG,
  SOLUTION_COMMON_FLAGS,
} from './catalog-data-solution-flags.js';
import type { FlagSpec, SubcommandSpec } from './catalog-types.js';

const common: readonly FlagSpec[] = SOLUTION_COMMON_FLAGS.map((flag) =>
  flag.name === 'org' ? { ...flag, required: true } : flag,
);
const revision: FlagSpec = {
  ...EXPECTED_REVISION,
  constraints: { minimum: 1, maximum: 2147483647 },
};
const confirm: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'confirm',
  type: 'boolean',
  required: true,
  summary: 'Confirm changing public page availability.',
};
export const SOLUTION_PAGE: SubcommandSpec = {
  name: 'page',
  summary: 'Edit and explicitly publish a Noodle Seed-hosted business page.',
  arguments: [],
  flags: [],
  subcommands: [
    {
      name: 'show',
      summary: 'Inspect the private page draft and its published snapshot.',
      arguments: [INSTALLATION_ARGUMENT],
      flags: common,
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'save',
      summary: 'Save page content without changing the published page.',
      arguments: [INSTALLATION_ARGUMENT],
      flags: [
        ...common,
        { ...revision, constraints: { minimum: 0, maximum: 2147483647 } },
        {
          ...OPTIONAL_FLAG,
          name: 'data',
          type: 'string',
          value: '<json>',
          required: true,
          summary:
            'Bounded JSON with introduction and sections containing title/text; plain text only.',
        },
      ],
      jsonOutput: { mode: 'single' },
    },
    ...(['publish', 'unpublish'] as const).map(
      (name): SubcommandSpec => ({
        name,
        summary:
          name === 'publish'
            ? 'Publish the exact saved page after public-assistant readiness checks.'
            : 'Remove the public page while retaining its private draft.',
        arguments: [INSTALLATION_ARGUMENT],
        flags: [...common, revision, confirm],
        jsonOutput: { mode: 'single' },
      }),
    ),
  ],
};
