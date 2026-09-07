/** Auth-discovery command catalog data. Pure data — no runtime imports. */
import type { CommandSpec, FlagSpec } from './catalog-types.js';

const OPTIONAL_FLAG = {
  required: false,
  repeatable: false,
  sensitive: false,
  aliases: [],
  conflictsWith: [],
} as const;

const GOOGLE_ACTION_FLAGS = [
  {
    ...OPTIONAL_FLAG,
    name: 'org',
    type: 'string',
    value: '<slug>',
    summary: 'Organization slug.',
  },
  {
    ...OPTIONAL_FLAG,
    name: 'app',
    type: 'string',
    value: '<slug>',
    summary: 'Application slug.',
  },
  {
    ...OPTIONAL_FLAG,
    name: 'env',
    type: 'string',
    value: '<env>',
    summary: 'Environment slug.',
  },
  {
    ...OPTIONAL_FLAG,
    name: 'service',
    type: 'string',
    value: '<url>',
    summary: 'Control-plane service URL.',
  },
  {
    ...OPTIONAL_FLAG,
    name: 'auth-token',
    type: 'string',
    value: '<token>',
    summary: 'Control-plane authentication token.',
    sensitive: true,
  },
  {
    ...OPTIONAL_FLAG,
    name: 'json',
    type: 'boolean',
    summary: 'Emit JSON output.',
  },
] as const satisfies readonly FlagSpec[];

const SERVICE_PRINCIPAL_COMMON_FLAGS = [
  {
    ...OPTIONAL_FLAG,
    name: 'org',
    type: 'string',
    value: '<slug>',
    summary: 'Organization that owns the service principal.',
    required: true,
  },
  GOOGLE_ACTION_FLAGS[3],
  GOOGLE_ACTION_FLAGS[4],
  GOOGLE_ACTION_FLAGS[5],
] as const satisfies readonly FlagSpec[];

const PRINCIPAL_ARGUMENT = {
  name: 'principal-id',
  type: 'string',
  summary: 'Service-principal client identifier.',
  required: true,
  variadic: false,
  sensitive: false,
  constraints: { minLength: 40, maxLength: 40 },
} as const;

const LABEL_FLAG = {
  ...OPTIONAL_FLAG,
  name: 'label',
  type: 'string',
  value: '<label>',
  summary: 'Human-readable credential label.',
  required: true,
  constraints: { minLength: 1, maxLength: 80 },
} as const satisfies FlagSpec;

const EXPIRES_AT_FLAG = {
  ...OPTIONAL_FLAG,
  name: 'expires-at',
  type: 'string',
  value: '<timestamp>',
  summary: 'Optional credential expiry as an ISO 8601 timestamp.',
} as const satisfies FlagSpec;

const YES_FLAG = {
  ...OPTIONAL_FLAG,
  name: 'yes',
  type: 'boolean',
  summary: 'Confirm revocation without an interactive prompt.',
} as const satisfies FlagSpec;

const SERVICE_PRINCIPAL_SUBCOMMANDS = [
  {
    name: 'create',
    summary: 'Create an organization-owned OAuth service principal.',
    arguments: [
      {
        name: 'name',
        type: 'string',
        summary: 'Human-readable service-principal name.',
        required: true,
        variadic: false,
        sensitive: false,
        constraints: { minLength: 1, maxLength: 80 },
      },
    ],
    flags: SERVICE_PRINCIPAL_COMMON_FLAGS,
    jsonOutput: { mode: 'single' },
  },
  {
    name: 'list',
    summary: 'List service principals owned by an organization.',
    arguments: [],
    flags: SERVICE_PRINCIPAL_COMMON_FLAGS,
    jsonOutput: { mode: 'single' },
  },
  {
    name: 'show',
    summary: 'Show one service principal with its grants and redacted credentials.',
    arguments: [PRINCIPAL_ARGUMENT],
    flags: SERVICE_PRINCIPAL_COMMON_FLAGS,
    jsonOutput: { mode: 'single' },
  },
  {
    name: 'grant',
    summary: 'Grant a service principal access to one deployed app environment.',
    arguments: [PRINCIPAL_ARGUMENT],
    flags: [
      {
        ...OPTIONAL_FLAG,
        name: 'app',
        type: 'string',
        value: '<slug>',
        summary: 'Target application slug.',
        required: true,
      },
      {
        ...OPTIONAL_FLAG,
        name: 'env',
        type: 'string',
        value: '<env>',
        summary: 'Target environment slug.',
        required: true,
      },
      {
        ...OPTIONAL_FLAG,
        name: 'scope',
        type: 'string',
        value: '<scope>',
        summary: 'OAuth scope ceiling; repeat for multiple scopes.',
        repeatable: true,
      },
      ...SERVICE_PRINCIPAL_COMMON_FLAGS,
    ],
    jsonOutput: { mode: 'single' },
  },
  {
    name: 'revoke-grant',
    summary: 'Revoke one app-environment grant.',
    arguments: [
      PRINCIPAL_ARGUMENT,
      {
        name: 'grant-id',
        type: 'string',
        summary: 'Grant identifier to revoke.',
        required: true,
        variadic: false,
        sensitive: false,
        constraints: { minLength: 40, maxLength: 40 },
      },
    ],
    flags: [YES_FLAG, ...SERVICE_PRINCIPAL_COMMON_FLAGS],
    jsonOutput: { mode: 'single' },
  },
  {
    name: 'add-jwk',
    summary: 'Add an RS256 or ES256 public JWK credential from a file.',
    arguments: [PRINCIPAL_ARGUMENT],
    flags: [
      LABEL_FLAG,
      {
        ...OPTIONAL_FLAG,
        name: 'file',
        type: 'string',
        value: '<path>',
        summary: 'Path to one public JWK JSON object.',
        required: true,
      },
      EXPIRES_AT_FLAG,
      ...SERVICE_PRINCIPAL_COMMON_FLAGS,
    ],
    jsonOutput: { mode: 'single' },
  },
  {
    name: 'create-secret',
    summary: 'Create a client secret that is returned once.',
    arguments: [PRINCIPAL_ARGUMENT],
    flags: [LABEL_FLAG, EXPIRES_AT_FLAG, ...SERVICE_PRINCIPAL_COMMON_FLAGS],
    jsonOutput: { mode: 'single' },
  },
  {
    name: 'revoke-credential',
    summary: 'Revoke one public-key or client-secret credential.',
    arguments: [
      PRINCIPAL_ARGUMENT,
      {
        name: 'credential-id',
        type: 'string',
        summary: 'Credential identifier to revoke.',
        required: true,
        variadic: false,
        sensitive: false,
        constraints: { minLength: 40, maxLength: 40 },
      },
    ],
    flags: [YES_FLAG, ...SERVICE_PRINCIPAL_COMMON_FLAGS],
    jsonOutput: { mode: 'single' },
  },
  {
    name: 'revoke',
    summary: 'Revoke a service principal and all of its access.',
    arguments: [PRINCIPAL_ARGUMENT],
    flags: [YES_FLAG, ...SERVICE_PRINCIPAL_COMMON_FLAGS],
    jsonOutput: { mode: 'single' },
  },
] as const satisfies NonNullable<CommandSpec['subcommands']>;

export const CATALOG_AUTH_DISCOVERY: readonly CommandSpec[] = [
  {
    name: 'auth',
    section: 'account',
    helpRank: 9,
    summary: 'Manage service identities and diagnose downstream auth readiness.',
    arguments: [],
    flags: [],
    subcommands: [
      {
        name: 'doctor',
        summary:
          'Check remote MCP OAuth readiness and optionally probe a deployed customer credential exchange.',
        arguments: [
          {
            name: 'server.ts',
            type: 'string',
            summary: 'Authored server entrypoint.',
            required: false,
            variadic: false,
            sensitive: false,
            constraints: {},
          },
        ],
        flags: [
          {
            ...OPTIONAL_FLAG,
            name: 'live',
            type: 'boolean',
            summary: 'Probe real delegated exchanges without a business tool.',
          },
          GOOGLE_ACTION_FLAGS[0],
          GOOGLE_ACTION_FLAGS[1],
          GOOGLE_ACTION_FLAGS[2],
          {
            ...OPTIONAL_FLAG,
            name: 'version',
            type: 'string',
            value: '<version>',
            summary: 'Pinned deployed MCP version to probe.',
          },
          GOOGLE_ACTION_FLAGS[3],
          GOOGLE_ACTION_FLAGS[5],
        ],
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'google',
        summary: 'Manage an environment-scoped Google Workload Identity Federation subject.',
        arguments: [],
        flags: [],
        subcommands: [
          {
            name: 'prepare',
            summary: 'Prepare Google Workload Identity Federation.',
            arguments: [],
            flags: [
              {
                ...OPTIONAL_FLAG,
                name: 'project-number',
                type: 'string',
                value: '<number>',
                summary: 'Google Cloud project number.',
                required: true,
                constraints: { minLength: 6, maxLength: 32 },
              },
              {
                ...OPTIONAL_FLAG,
                name: 'pool',
                type: 'string',
                value: '<id>',
                summary: 'Workload Identity Pool identifier.',
                required: true,
                constraints: { minLength: 4, maxLength: 32 },
              },
              {
                ...OPTIONAL_FLAG,
                name: 'provider',
                type: 'string',
                value: '<id>',
                summary: 'Workload Identity Provider identifier.',
                required: true,
                constraints: { minLength: 4, maxLength: 32 },
              },
              {
                ...OPTIONAL_FLAG,
                name: 'service-account',
                type: 'string',
                value: '<email>',
                summary: 'Google service account email.',
              },
              ...GOOGLE_ACTION_FLAGS,
            ],
            jsonOutput: { mode: 'single' },
          },
          {
            name: 'status',
            summary: 'Show Google Workload Identity Federation status.',
            arguments: [],
            flags: GOOGLE_ACTION_FLAGS,
            jsonOutput: { mode: 'single' },
          },
          {
            name: 'doctor',
            summary: 'Diagnose Google Workload Identity Federation.',
            arguments: [],
            flags: GOOGLE_ACTION_FLAGS,
            jsonOutput: { mode: 'single' },
          },
          {
            name: 'revoke',
            summary: 'Revoke Google Workload Identity Federation.',
            arguments: [],
            flags: GOOGLE_ACTION_FLAGS,
            jsonOutput: { mode: 'single' },
          },
        ],
      },
      {
        name: 'service-principals',
        summary: 'Manage organization-owned OAuth service principals for headless MCP callers.',
        arguments: [],
        flags: [],
        subcommands: SERVICE_PRINCIPAL_SUBCOMMANDS,
      },
    ],
  },
];
