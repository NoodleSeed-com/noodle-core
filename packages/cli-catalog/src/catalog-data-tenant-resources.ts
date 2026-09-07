/** Tenant resource and administration command catalog data. Pure data — no runtime imports. */
import type { CommandSpec, FlagSpec } from './catalog-types.js';

const OPTIONAL_FLAG = {
  required: false,
  repeatable: false,
  sensitive: false,
  aliases: [],
  conflictsWith: [],
} as const;
const REQUIRED_ARGUMENT = {
  type: 'string',
  required: true,
  variadic: false,
  sensitive: false,
  constraints: {},
} as const;

const ORG: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'org',
  type: 'string',
  value: '<slug>',
  summary: 'Organization slug.',
};
const _REQUIRED_ORG: FlagSpec = { ...ORG, required: true };
const APP: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'app',
  type: 'string',
  value: '<slug>',
  summary: 'Application slug.',
};
const ENV: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'env',
  type: 'string',
  value: '<slug>',
  summary: 'Environment slug.',
};
const SERVICE: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'service',
  type: 'string',
  value: '<url>',
  summary: 'Control-plane service URL.',
};
const AUTH_TOKEN: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'auth-token',
  type: 'string',
  value: '<token>',
  summary: 'Control-plane authentication token.',
  sensitive: true,
};
const JSON_FLAG: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'json',
  type: 'boolean',
  summary: 'Emit JSON output.',
};
const WATCH_JSON: FlagSpec = { ...JSON_FLAG, conflictsWith: ['watch'] };
const ARCHIVED: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'archived',
  type: 'boolean',
  summary: 'Include archived resources.',
};
const VERSION: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'version',
  type: 'string',
  value: '<version>',
  summary: 'Exact deployed server version.',
  required: true,
};
const YES: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'yes',
  type: 'boolean',
  summary: 'Confirm non-interactively.',
};
const RETENTION: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'retention-days',
  type: 'integer',
  value: '<days>',
  summary: 'Managed-record retention in days.',
  constraints: { choices: [7, 30, 90], default: 30 },
};
const INSTALLATION_ARGUMENT = {
  ...REQUIRED_ARGUMENT,
  name: 'installation',
  summary: 'Solution installation identifier.',
};
const COLLECTION_ARGUMENT = {
  ...REQUIRED_ARGUMENT,
  name: 'collection',
  summary: 'Managed collection key.',
};
const RECORD_ARGUMENT = {
  ...REQUIRED_ARGUMENT,
  name: 'record',
  summary: 'Managed record identifier.',
};
const SOLUTION_COMMON_FLAGS: readonly FlagSpec[] = [ORG, SERVICE, AUTH_TOKEN, JSON_FLAG];
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
  {
    ...OPTIONAL_FLAG,
    name: 'cursor',
    type: 'string',
    value: '<cursor>',
    summary: 'Opaque page cursor.',
  },
  {
    ...OPTIONAL_FLAG,
    name: 'limit',
    type: 'integer',
    value: '<count>',
    summary: 'Bounded page size.',
  },
  {
    ...OPTIONAL_FLAG,
    name: 'include-deleted',
    type: 'boolean',
    summary: 'Include payload-free tombstones.',
  },
];

const WATCH_FLAGS: readonly FlagSpec[] = [
  {
    ...OPTIONAL_FLAG,
    name: 'watch',
    type: 'boolean',
    summary: 'Live-refresh the human-readable view.',
    conflictsWith: ['json'],
  },
  {
    ...OPTIONAL_FLAG,
    name: 'interval',
    type: 'number',
    value: '<seconds>',
    summary: 'Set the live-refresh interval.',
    constraints: { default: 5, minimum: 2 },
  },
];

const RESOURCE_BASE_FLAGS: readonly FlagSpec[] = [ORG, SERVICE, AUTH_TOKEN];
const RESOURCE_FLAGS: readonly FlagSpec[] = [...RESOURCE_BASE_FLAGS, JSON_FLAG];
const ENV_RESOURCE_FLAGS: readonly FlagSpec[] = [ORG, APP, SERVICE, AUTH_TOKEN, JSON_FLAG];
const DEPLOYMENT_BASE_FLAGS: readonly FlagSpec[] = [ORG, APP, ENV, SERVICE, AUTH_TOKEN];
const DEPLOYMENT_INSPECT_FLAGS: readonly FlagSpec[] = [ORG, SERVICE, AUTH_TOKEN, JSON_FLAG];
const _GITHUB_BASE_FLAGS: readonly FlagSpec[] = [ORG, APP, SERVICE, AUTH_TOKEN];

export const CATALOG_TENANT_RESOURCES: readonly CommandSpec[] = [
  {
    name: 'solutions',
    section: 'resources',
    helpRank: 1,
    summary: 'Install and operate data-driven business solutions.',
    arguments: [],
    flags: [],
    subcommands: [
      {
        name: 'catalog',
        summary: 'List centrally managed solution profiles.',
        arguments: [],
        flags: [SERVICE, AUTH_TOKEN, JSON_FLAG],
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'list',
        summary: 'List solution installations for an organization.',
        arguments: [],
        flags: SOLUTION_COMMON_FLAGS,
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'install',
        summary: 'Install one managed solution profile.',
        arguments: [{ ...REQUIRED_ARGUMENT, name: 'profile', summary: 'Solution profile key.' }],
        flags: [...SOLUTION_COMMON_FLAGS, APP, ENV, RETENTION],
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'inspect',
        summary: 'Inspect one solution installation.',
        arguments: [INSTALLATION_ARGUMENT],
        flags: SOLUTION_COMMON_FLAGS,
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'grants',
        summary: 'Manage installation-scoped business grants.',
        arguments: [],
        flags: [],
        subcommands: [
          {
            name: 'list',
            summary: 'List live business grants.',
            arguments: [INSTALLATION_ARGUMENT],
            flags: SOLUTION_COMMON_FLAGS,
            jsonOutput: { mode: 'single' },
          },
          {
            name: 'set',
            summary: 'Create or update a business grant.',
            arguments: [INSTALLATION_ARGUMENT],
            flags: [
              ...SOLUTION_COMMON_FLAGS,
              {
                ...OPTIONAL_FLAG,
                name: 'subject',
                type: 'string',
                value: '<subject>',
                summary: 'Canonical business-user subject.',
                required: true,
              },
              {
                ...OPTIONAL_FLAG,
                name: 'email',
                type: 'string',
                value: '<email>',
                summary: 'Business-user email address.',
                required: true,
              },
              {
                ...OPTIONAL_FLAG,
                name: 'role',
                type: 'string',
                value: '<role>',
                summary: 'Business role.',
                required: true,
                constraints: { choices: ['administrator', 'manager', 'operator', 'viewer'] },
              },
              {
                ...OPTIONAL_FLAG,
                name: 'expected-revision',
                type: 'integer',
                value: '<revision>',
                summary: 'Expected current grant revision; 0 for a new grant.',
              },
            ],
            jsonOutput: { mode: 'single' },
          },
          {
            name: 'revoke',
            summary: 'Revoke a business grant using optimistic concurrency.',
            arguments: [INSTALLATION_ARGUMENT],
            flags: [
              ...SOLUTION_COMMON_FLAGS,
              {
                ...OPTIONAL_FLAG,
                name: 'subject',
                type: 'string',
                value: '<subject>',
                summary: 'Canonical business-user subject.',
                required: true,
              },
              {
                ...OPTIONAL_FLAG,
                name: 'expected-revision',
                type: 'integer',
                value: '<revision>',
                summary: 'Expected current grant revision.',
                required: true,
              },
            ],
            jsonOutput: { mode: 'single' },
          },
        ],
      },
      {
        name: 'records',
        summary: 'Operate one installed managed collection.',
        arguments: [],
        flags: [],
        usage:
          'solutions records <list|create|get|update|assign|status|note|activity|delete|export> <installation> <collection> [record] [options]',
        subcommands: [
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
            'export',
          ].map((name) => ({
            name,
            summary: `${name[0]?.toUpperCase()}${name.slice(1)} managed records.`,
            arguments: [
              INSTALLATION_ARGUMENT,
              COLLECTION_ARGUMENT,
              ...(name === 'list' || name === 'create' || name === 'export'
                ? []
                : [RECORD_ARGUMENT]),
            ],
            flags: RECORD_FLAGS,
            jsonOutput: { mode: 'single' as const },
          })),
        ],
      },
    ],
  },
  {
    name: 'apps',
    section: 'resources',
    summary: 'List, inspect, or open hosted apps for an org.',
    arguments: [],
    flags: [],
    subcommands: [
      {
        name: 'list',
        summary: 'List apps in an org.',
        arguments: [],
        flags: [...RESOURCE_BASE_FLAGS, ARCHIVED, WATCH_JSON, ...WATCH_FLAGS],
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'inspect',
        summary: 'Show one app across every environment.',
        arguments: [{ ...REQUIRED_ARGUMENT, name: 'app', summary: 'App slug to inspect.' }],
        flags: RESOURCE_FLAGS,
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'open',
        summary: "Open or print the app's endpoint URL.",
        arguments: [{ ...REQUIRED_ARGUMENT, name: 'app', summary: 'App slug to open.' }],
        flags: [
          ...RESOURCE_FLAGS,
          ENV,
          {
            ...OPTIONAL_FLAG,
            name: 'print',
            type: 'boolean',
            summary: 'Print the URL instead of opening it.',
          },
        ],
        jsonOutput: { mode: 'single' },
      },
    ],
  },
  {
    name: 'envs',
    section: 'resources',
    summary: 'List or inspect environments for an app.',
    arguments: [],
    flags: [],
    subcommands: [
      {
        name: 'list',
        summary: 'List environments for an app.',
        arguments: [],
        flags: [...ENV_RESOURCE_FLAGS, ARCHIVED],
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'inspect',
        summary: 'Show one environment.',
        arguments: [{ ...REQUIRED_ARGUMENT, name: 'env', summary: 'Environment name to inspect.' }],
        flags: ENV_RESOURCE_FLAGS,
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'set-production',
        summary: "Designate an app's production environment.",
        arguments: [
          { ...REQUIRED_ARGUMENT, name: 'env', summary: 'Environment name to designate.' },
        ],
        flags: ENV_RESOURCE_FLAGS,
        jsonOutput: { mode: 'single' },
      },
    ],
  },
  {
    name: 'deployments',
    section: 'resources',
    summary: 'List, inspect, or read packages for individual deployments.',
    arguments: [],
    flags: [],
    subcommands: [
      {
        name: 'list',
        summary: 'List hosted deployments, or the local deployment cache when signed out.',
        arguments: [],
        flags: [...DEPLOYMENT_BASE_FLAGS, ARCHIVED, WATCH_JSON, ...WATCH_FLAGS],
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'inspect',
        summary: 'Show one deployment by id.',
        arguments: [
          { ...REQUIRED_ARGUMENT, name: 'id', summary: 'Deployment identifier to inspect.' },
        ],
        flags: DEPLOYMENT_INSPECT_FLAGS,
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'package',
        summary: 'Read the immutable App Package snapshot for one deployment.',
        arguments: [
          { ...REQUIRED_ARGUMENT, name: 'id', summary: 'Deployment identifier to read.' },
        ],
        flags: DEPLOYMENT_INSPECT_FLAGS,
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'lock',
        summary: 'Freeze an active server version against deploys and rollbacks.',
        arguments: [],
        flags: [...DEPLOYMENT_BASE_FLAGS, VERSION, JSON_FLAG],
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'unlock',
        summary: 'Allow an active server version to be changed again.',
        arguments: [],
        flags: [...DEPLOYMENT_BASE_FLAGS, VERSION, YES, JSON_FLAG],
        jsonOutput: { mode: 'single' },
      },
    ],
  },
];
