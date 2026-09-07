/** Hosted immutable distribution and lifecycle command grammar. Pure data. */
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
const RESOURCE_FLAGS: readonly FlagSpec[] = [ORG, SERVICE, AUTH_TOKEN, JSON_FLAG];
const DISTRIBUTION_ID = {
  ...REQUIRED_ARGUMENT,
  name: 'distribution-id',
  summary: 'Immutable distribution version identifier.',
} as const;

export const CATALOG_DISTRIBUTIONS: CommandSpec = {
  name: 'distributions',
  section: 'resources',
  summary: 'Publish immutable host packages and operate their delivery lifecycle.',
  arguments: [],
  flags: [],
  subcommands: [
    {
      name: 'publish',
      summary: 'Build locally, bind to the exact deployment snapshot, and publish one package.',
      arguments: [
        {
          ...REQUIRED_ARGUMENT,
          name: 'deployment-id',
          summary: 'Exact deployment whose public MCP URL and package snapshot are bound.',
        },
        {
          type: 'string',
          required: false,
          variadic: false,
          sensitive: false,
          constraints: {},
          name: 'server.ts',
          summary: 'Local entrypoint; defaults to the linked or conventional project entrypoint.',
        },
      ],
      flags: [
        {
          ...OPTIONAL_FLAG,
          name: 'target',
          type: 'string',
          value: '<openai|claude>',
          summary: 'Host package target.',
          required: true,
          constraints: { choices: ['openai', 'claude'] },
        },
        {
          ...OPTIONAL_FLAG,
          name: 'category',
          type: 'string',
          value: '<category>',
          summary: 'OpenAI submission category; required only for the OpenAI target.',
        },
        {
          ...OPTIONAL_FLAG,
          name: 'connectors',
          type: 'string',
          value: '<file>',
          summary: 'Connector catalog override used to compile the exact local source.',
        },
        ...RESOURCE_FLAGS,
      ],
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'list',
      summary: 'List immutable distribution versions for one deployment.',
      arguments: [
        {
          ...REQUIRED_ARGUMENT,
          name: 'deployment-id',
          summary: 'Deployment identifier whose distribution versions are listed.',
        },
      ],
      flags: [
        {
          ...OPTIONAL_FLAG,
          name: 'target',
          type: 'string',
          value: '<openai|claude>',
          summary: 'Optionally filter by host package target.',
          constraints: { choices: ['openai', 'claude'] },
        },
        ...RESOURCE_FLAGS,
      ],
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'inspect',
      summary: 'Inspect immutable metadata and current lifecycle state without archive bytes.',
      arguments: [DISTRIBUTION_ID],
      flags: RESOURCE_FLAGS,
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'download',
      summary: 'Download exact archive bytes and verify their immutable digest before writing.',
      arguments: [DISTRIBUTION_ID],
      flags: [
        {
          ...OPTIONAL_FLAG,
          name: 'output',
          type: 'string',
          value: '<archive.zip>',
          summary: 'Destination for the verified archive bytes.',
          required: true,
        },
        ...RESOURCE_FLAGS,
      ],
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'readiness',
      summary: 'Record whether one immutable version is draft, ready, or blocked.',
      arguments: [DISTRIBUTION_ID],
      flags: [
        {
          ...OPTIONAL_FLAG,
          name: 'status',
          type: 'string',
          value: '<draft|ready|blocked>',
          summary: 'Operator-confirmed delivery readiness.',
          required: true,
          constraints: { choices: ['draft', 'ready', 'blocked'] },
        },
        {
          ...OPTIONAL_FLAG,
          name: 'note',
          type: 'string',
          value: '<text>',
          summary: 'Optional readiness note.',
          constraints: { minLength: 1, maxLength: 1000 },
        },
        ...RESOURCE_FLAGS,
      ],
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'review',
      summary: 'Record a human-reported external host review status and optional feedback.',
      arguments: [DISTRIBUTION_ID],
      flags: [
        {
          ...OPTIONAL_FLAG,
          name: 'status',
          type: 'string',
          value: '<status>',
          summary: 'Human-reported host review status; Noodle does not infer host actions.',
          required: true,
          constraints: {
            choices: [
              'submitted',
              'in-review',
              'changes-requested',
              'approved',
              'rejected',
              'published',
              'withdrawn',
            ],
          },
        },
        {
          ...OPTIONAL_FLAG,
          name: 'feedback',
          type: 'string',
          value: '<text>',
          summary: 'Human-entered host feedback; required for changes-requested or rejected.',
          constraints: { minLength: 1, maxLength: 4000 },
        },
        ...RESOURCE_FLAGS,
      ],
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'release',
      summary: 'Move the stable release channel forward to this ready version.',
      arguments: [DISTRIBUTION_ID],
      flags: [
        {
          ...OPTIONAL_FLAG,
          name: 'visibility',
          type: 'string',
          value: '<private|public>',
          summary: 'Private grant-only delivery or public discovery and delivery.',
          required: true,
          constraints: { choices: ['private', 'public'] },
        },
        ...RESOURCE_FLAGS,
      ],
      jsonOutput: { mode: 'single' },
    },
    ...(['rollback', 'deprecate', 'revoke'] as const).map((name) => ({
      name,
      summary:
        name === 'rollback'
          ? 'Move the stable release pointer to this older ready version.'
          : name === 'deprecate'
            ? 'Stop delivery of this version while retaining its immutable record.'
            : 'Permanently revoke delivery of this version.',
      arguments: [DISTRIBUTION_ID],
      flags: RESOURCE_FLAGS,
      jsonOutput: { mode: 'single' as const },
    })),
    {
      name: 'grant',
      summary: 'Create a short-lived exact-version private archive download URL.',
      arguments: [DISTRIBUTION_ID],
      flags: [
        {
          ...OPTIONAL_FLAG,
          name: 'expires-in',
          type: 'integer',
          value: '<seconds>',
          summary: 'Grant lifetime in seconds.',
          constraints: { default: 900, minimum: 60, maximum: 3600 },
        },
        ...RESOURCE_FLAGS,
      ],
      jsonOutput: { mode: 'single' },
    },
  ],
};
