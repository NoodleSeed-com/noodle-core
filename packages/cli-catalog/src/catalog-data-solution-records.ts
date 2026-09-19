/** Canonical record operations and reviewed lifecycle metadata. Pure data only. */
import {
  INSTALLATION_ARGUMENT,
  OPTIONAL_FLAG,
  PAGING_FLAGS,
  REQUIRED_ARGUMENT,
  SOLUTION_COMMON_FLAGS,
} from './catalog-data-solution-flags.js';
import { SOLUTION_NATIVE_LIFECYCLE } from './catalog-data-solution-native-lifecycle.js';
import type { FlagSpec, SubcommandSpec } from './catalog-types.js';

export const COLLECTION_ARGUMENT = {
  ...REQUIRED_ARGUMENT,
  name: 'collection',
  summary: 'Managed collection key.',
};
const RECORD_ARGUMENT = {
  ...REQUIRED_ARGUMENT,
  name: 'record',
  summary: 'Managed record identifier.',
};

const RECORD_QUERY_FLAGS: readonly FlagSpec[] = [
  {
    ...OPTIONAL_FLAG,
    name: 'filters',
    type: 'string',
    value: '<json>',
    summary:
      'JSON array of up to eight field/value equality filters, combined with AND. Only declared fields.',
  },
  {
    ...OPTIONAL_FLAG,
    name: 'sort-field',
    type: 'string',
    value: '<field>',
    summary: 'Declared native collection sort field.',
  },
  {
    ...OPTIONAL_FLAG,
    name: 'sort-direction',
    type: 'string',
    value: '<asc|desc>',
    summary: 'Sort direction; requires --sort-field.',
  },
  {
    ...OPTIONAL_FLAG,
    name: 'created-at-from',
    type: 'string',
    value: '<timestamp>',
    summary: 'Inclusive creation-time lower bound; narrows the 10,000-record payload-query scan.',
  },
  {
    ...OPTIONAL_FLAG,
    name: 'created-at-to',
    type: 'string',
    value: '<timestamp>',
    summary: 'Inclusive creation-time upper bound.',
  },
];

const RECORD_FLAGS: readonly FlagSpec[] = [
  ...SOLUTION_COMMON_FLAGS,
  {
    ...OPTIONAL_FLAG,
    name: 'data',
    type: 'string',
    value: '<json>',
    summary: 'Structured JSON record data.',
  },
  {
    ...OPTIONAL_FLAG,
    name: 'idempotency-key',
    type: 'string',
    value: '<key>',
    summary: 'Retry-safe create key.',
  },
  {
    ...OPTIONAL_FLAG,
    name: 'expected-revision',
    type: 'integer',
    value: '<revision>',
    summary: 'Expected current record revision.',
  },
  {
    ...OPTIONAL_FLAG,
    name: 'status',
    type: 'string',
    value: '<status>',
    summary: 'Record status or list filter.',
  },
  {
    ...OPTIONAL_FLAG,
    name: 'assignee',
    type: 'string',
    value: '<subject>',
    summary: 'Assignee subject or list filter.',
  },
  {
    ...OPTIONAL_FLAG,
    name: 'note',
    type: 'string',
    value: '<text>',
    summary: 'Operator note text.',
  },
  ...PAGING_FLAGS,
  {
    ...OPTIONAL_FLAG,
    name: 'include-deleted',
    type: 'boolean',
    summary: 'Include payload-free tombstones.',
  },
];

export const SOLUTION_RECORDS: SubcommandSpec = {
  name: 'records',
  summary: 'Operate one installed managed collection.',
  arguments: [],
  flags: [],
  usage:
    'solutions records <list|create|get|update|assign|status|note|activity|delete|migrate-schema|export|lifecycle> [options]',
  subcommands: [
    SOLUTION_NATIVE_LIFECYCLE,
    ...[
      'list',
      'create',
      'get',
      'update',
      'assign',
      'status',
      'note',
      'activity',
      'delete',
      'migrate-schema',
      'export',
    ].map((name) => ({
      name,
      summary:
        name === 'activity'
          ? 'Read native record history newest first; default 50, maximum 100, with --cursor for older pages.'
          : name === 'migrate-schema'
            ? 'Administrator-only conversion of an eligible legacy request record with revision protection.'
            : `${name[0]?.toUpperCase()}${name.slice(1)} managed records.`,
      arguments: [
        INSTALLATION_ARGUMENT,
        COLLECTION_ARGUMENT,
        ...(name === 'list' || name === 'create' || name === 'export' ? [] : [RECORD_ARGUMENT]),
      ],
      flags: [
        ...RECORD_FLAGS,
        ...(name === 'list' ? RECORD_QUERY_FLAGS : []),
        ...(name === 'update'
          ? [
              {
                ...OPTIONAL_FLAG,
                name: 'unset',
                type: 'string' as const,
                value: '<fields>',
                summary:
                  'Comma-separated optional field keys to remove; cannot overlap --data. May be used without --data.',
              },
            ]
          : []),
      ],
      jsonOutput: { mode: 'single' as const },
    })),
  ],
};
