/** Canonical source-draft operations; imported by the solutions family. Data only. */
import {
  EXPECTED_REVISION,
  IDEMPOTENCY_KEY,
  OPTIONAL_FLAG,
  REQUIRED_ARGUMENT,
  SOLUTION_COMMON_FLAGS,
} from './catalog-data-solution-flags.js';
import type { FlagSpec, SubcommandSpec } from './catalog-types.js';

const common: readonly FlagSpec[] = [
  ...SOLUTION_COMMON_FLAGS.map((flag) =>
    flag.name === 'org' ? { ...flag, required: true } : flag,
  ),
  {
    ...OPTIONAL_FLAG,
    name: 'app',
    type: 'string',
    value: '<slug>',
    required: true,
    summary: 'Application slug.',
  },
];
const source: readonly FlagSpec[] = [
  {
    ...OPTIONAL_FLAG,
    name: 'source-dir',
    type: 'string',
    value: '<directory>',
    required: true,
    summary:
      'Directory containing bounded TypeScript application source; no symlinks or environment files.',
  },
  {
    ...OPTIONAL_FLAG,
    name: 'entrypoint',
    type: 'string',
    value: '<path>',
    summary: 'Relative TypeScript entrypoint.',
    constraints: { default: 'server.ts' },
  },
];
const draftId = { ...REQUIRED_ARGUMENT, name: 'draft-id', summary: 'Saved draft identifier.' };
const revision = { ...EXPECTED_REVISION, constraints: { minimum: 1, maximum: 2147483647 } };

export const SOLUTION_DRAFTS: SubcommandSpec = {
  name: 'drafts',
  summary: 'Save and inspect private application source without publishing it.',
  arguments: [],
  flags: [],
  subcommands: [
    {
      name: 'history',
      summary: 'List source-free revisions, newest first.',
      arguments: [draftId],
      flags: common,
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'diff',
      summary: 'Compare exact source and entrypoints at two revisions.',
      arguments: [draftId],
      flags: [
        ...common,
        { ...revision, name: 'from-revision', summary: 'Revision to compare from.' },
        { ...revision, name: 'to-revision', summary: 'Revision to compare to.' },
      ],
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'list',
      summary: 'List source-free draft summaries.',
      arguments: [],
      flags: common,
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'show',
      summary: 'Read an authorized exact draft revision.',
      arguments: [draftId],
      flags: [
        ...common,
        {
          ...revision,
          name: 'revision',
          required: false,
          summary: 'Revision to read; defaults to the current revision.',
        },
      ],
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'create',
      summary: 'Save a new private draft from TypeScript source.',
      arguments: [],
      flags: [
        ...common,
        ...source,
        IDEMPOTENCY_KEY,
        {
          ...OPTIONAL_FLAG,
          name: 'env',
          type: 'string',
          value: '<slug>',
          summary: 'Intended publish environment; saving does not deploy.',
          constraints: { default: 'prod' },
        },
      ],
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'edit',
      summary: 'Append a revision without overwriting concurrent work.',
      arguments: [draftId],
      flags: [...common, ...source, revision, IDEMPOTENCY_KEY],
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'undo',
      summary: 'Restore an earlier source revision as a new revision.',
      arguments: [draftId],
      flags: [
        ...common,
        revision,
        IDEMPOTENCY_KEY,
        {
          ...revision,
          name: 'target-revision',
          summary: 'Earlier revision whose source will be restored.',
        },
      ],
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'delete',
      summary: 'Erase a draft and its source history; published applications are unchanged.',
      arguments: [draftId],
      flags: [
        ...common,
        revision,
        {
          ...OPTIONAL_FLAG,
          name: 'confirm',
          type: 'boolean',
          required: true,
          summary: 'Confirm erasing the draft source and history.',
        },
      ],
      jsonOutput: { mode: 'single' },
    },
  ],
};
