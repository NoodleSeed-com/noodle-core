/** Hosted account and service command catalog data. Pure data — no runtime imports. */
import type { CommandSpec, FlagSpec } from './catalog-types.js';

const OPTIONAL_FLAG = {
  required: false,
  repeatable: false,
  sensitive: false,
  aliases: [],
  conflictsWith: [],
} as const;

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
const REQUIRED_STRING_FLAG = {
  ...OPTIONAL_FLAG,
  type: 'string',
  required: true,
} as const;
const CAPABILITY_NAMES = [
  'identity',
  'access',
  'controls',
  'audit',
  'observability',
  'secrets',
  'connectors',
  'apps',
] as const;
const SERVICE_PROFILE_NAMES = [
  'noodle-cloud-managed',
  'open-core',
  'enterprise-governed',
  'public-saas',
  'agency-managed',
] as const;
const FEEDBACK_MESSAGE_MIN = 1;
const FEEDBACK_MESSAGE_MAX = 4000;
const FEEDBACK_TITLE_MIN = 1;
const FEEDBACK_TITLE_MAX = 120;
const FEEDBACK_AGENT_NAME_MIN = 1;
const FEEDBACK_AGENT_NAME_MAX = 64;
const FEEDBACK_AGENT_MODEL_MIN = 1;
const FEEDBACK_AGENT_MODEL_MAX = 64;
const FEEDBACK_TYPES = ['fix', 'feat', 'docs', 'chore'] as const;
const FEEDBACK_TYPE_DEFAULT = 'feat';
const FEEDBACK_SEVERITIES = ['P0', 'P1', 'P2', 'P3'] as const;
const FEEDBACK_SEVERITY_DEFAULT = 'P3';
const FEEDBACK_AREAS = [
  'docs',
  'analytics',
  'connectors',
  'self-service',
  'conformance',
  'ci',
  'deploys',
  'distribution',
  'console',
  'dx',
  'plugins',
  'cli',
  'compiler',
  'multi-surface',
  'enterprise',
  'policy',
] as const;

export const CATALOG_ACCOUNT: readonly CommandSpec[] = [
  {
    name: 'service',
    section: 'account',
    helpRank: 11,
    summary: 'Query hosted service capabilities, scaffold a service config, or diagnose it.',
    arguments: [],
    flags: [],
    subcommands: [
      {
        name: 'capabilities',
        summary: 'List enabled capabilities for the target service.',
        arguments: [],
        flags: [
          SERVICE,
          AUTH_TOKEN,
          {
            ...OPTIONAL_FLAG,
            name: 'capability',
            type: 'string',
            value: '<name>',
            summary: 'Filter to a capability.',
            repeatable: true,
            constraints: { choices: CAPABILITY_NAMES },
          },
          {
            ...OPTIONAL_FLAG,
            name: 'advanced',
            type: 'boolean',
            summary: 'Include module-level detail.',
          },
          JSON_FLAG,
        ],
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'init',
        summary: 'Initialize a service profile or the local open-core Compose stack.',
        arguments: [],
        flags: [
          {
            ...OPTIONAL_FLAG,
            name: 'profile',
            type: 'string',
            value: '<name>',
            summary: 'Service operating profile.',
            required: true,
            constraints: { choices: SERVICE_PROFILE_NAMES },
          },
          {
            ...OPTIONAL_FLAG,
            name: 'force',
            type: 'boolean',
            summary: 'Overwrite a changed existing config.',
          },
          {
            ...OPTIONAL_FLAG,
            name: 'compose',
            type: 'boolean',
            summary: 'Generate the local Docker Compose state for the open-core profile.',
          },
          {
            ...OPTIONAL_FLAG,
            name: 'replace-secrets',
            type: 'boolean',
            summary: 'Rotate all generated secrets; requires --compose.',
          },
        ],
      },
      {
        name: 'doctor',
        summary: 'Diagnose service config source, or hosted asset preflight with --assets.',
        arguments: [],
        flags: [
          {
            ...OPTIONAL_FLAG,
            name: 'config',
            type: 'string',
            value: '<source>',
            summary: 'Service configuration source to inspect.',
          },
          {
            ...OPTIONAL_FLAG,
            name: 'assets',
            type: 'boolean',
            summary: 'Run hosted asset preflight checks.',
          },
          {
            ...OPTIONAL_FLAG,
            name: 'org',
            type: 'string',
            value: '<slug>',
            summary: 'Organization slug for hosted asset checks.',
            constraints: { default: 'local' },
          },
          {
            ...OPTIONAL_FLAG,
            name: 'app',
            type: 'string',
            value: '<slug>',
            summary: 'Application slug for hosted asset checks.',
            constraints: { default: 'app' },
          },
          {
            ...OPTIONAL_FLAG,
            name: 'env',
            type: 'string',
            value: '<slug>',
            summary: 'Environment slug for hosted asset checks.',
            constraints: { default: 'prod' },
          },
          SERVICE,
          AUTH_TOKEN,
          JSON_FLAG,
        ],
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'app-purge',
        summary: 'Reconcile historical app anchors after an already-recorded retention purge.',
        arguments: [],
        flags: [],
        subcommands: [
          {
            name: 'preview',
            summary: 'Write a bounded exact-set reconciliation preview artifact.',
            arguments: [],
            flags: [
              {
                ...REQUIRED_STRING_FLAG,
                name: 'output',
                value: '<absolute-path>',
                summary: 'New absolute path for the exclusive 0600 preview artifact.',
                sensitive: false,
              },
              SERVICE,
              AUTH_TOKEN,
              JSON_FLAG,
            ],
            jsonOutput: { mode: 'single' },
          },
          {
            name: 'apply',
            summary: 'Apply one approved exact preview with recovery and approval evidence.',
            arguments: [],
            flags: [
              {
                ...REQUIRED_STRING_FLAG,
                name: 'approved-preview',
                value: '<absolute-path>',
                summary: 'Absolute path to the approved exact 0600 preview artifact.',
                sensitive: true,
              },
              {
                ...REQUIRED_STRING_FLAG,
                name: 'release-sha',
                value: '<sha>',
                summary: 'Exact deployed System Release SHA.',
                sensitive: false,
                constraints: { minLength: 40, maxLength: 40 },
              },
              {
                ...REQUIRED_STRING_FLAG,
                name: 'approval-reference',
                value: '<reference>',
                summary: 'Restricted founder or product-owner approval reference.',
                sensitive: true,
                constraints: { minLength: 1, maxLength: 256 },
              },
              {
                ...REQUIRED_STRING_FLAG,
                name: 'recovery-checkpoint',
                value: '<reference>',
                summary: 'Verified backup or point-in-time recovery checkpoint reference.',
                sensitive: true,
                constraints: { minLength: 1, maxLength: 256 },
              },
              {
                ...REQUIRED_STRING_FLAG,
                name: 'reason',
                value: '<reason>',
                summary: 'Bounded reconciliation reason.',
                sensitive: true,
                constraints: { minLength: 1, maxLength: 500 },
              },
              {
                ...REQUIRED_STRING_FLAG,
                name: 'idempotency-key',
                value: '<key>',
                summary: 'Private key for exact replay.',
                sensitive: true,
                constraints: { minLength: 8, maxLength: 256 },
              },
              {
                ...OPTIONAL_FLAG,
                name: 'yes',
                type: 'boolean',
                summary: 'Confirm the approved destructive operation.',
                required: true,
              },
              SERVICE,
              AUTH_TOKEN,
              JSON_FLAG,
            ],
            jsonOutput: { mode: 'single' },
          },
        ],
      },
    ],
  },
  {
    name: 'login',
    section: 'start',
    summary: 'Sign in to Noodle Seed Cloud.',
    arguments: [],
    flags: [
      SERVICE,
      AUTH_TOKEN,
      {
        ...OPTIONAL_FLAG,
        name: 'env',
        type: 'string',
        value: '<name>',
        summary: 'Default environment saved after sign-in.',
      },
    ],
  },
  {
    name: 'logout',
    section: 'account',
    helpRank: 2,
    summary: 'Sign out and clear saved credentials.',
    arguments: [],
    flags: [],
    local: true,
  },
  {
    name: 'whoami',
    section: 'account',
    helpRank: 1,
    summary: 'Show the signed-in identity.',
    arguments: [],
    flags: [SERVICE, AUTH_TOKEN],
  },
  {
    name: 'feedback',
    section: 'account',
    summary: 'Send product feedback (bug, idea, docs gap) to the Noodle Seed team.',
    arguments: [
      {
        name: 'message',
        type: 'string',
        summary: 'Feedback text.',
        required: false,
        variadic: false,
        sensitive: false,
        constraints: {
          minLength: FEEDBACK_MESSAGE_MIN,
          maxLength: FEEDBACK_MESSAGE_MAX,
        },
      },
    ],
    flags: [
      {
        ...OPTIONAL_FLAG,
        name: 'message',
        type: 'string',
        value: '<text>',
        summary:
          'Feedback text; use it or the optional positional message. When neither is supplied, interactive human mode prompts for it; JSON and noninteractive mode require one.',
        constraints: { minLength: FEEDBACK_MESSAGE_MIN, maxLength: FEEDBACK_MESSAGE_MAX },
      },
      {
        ...OPTIONAL_FLAG,
        name: 'title',
        type: 'string',
        value: '<text>',
        summary: 'Optional short summary.',
        constraints: { minLength: FEEDBACK_TITLE_MIN, maxLength: FEEDBACK_TITLE_MAX },
      },
      {
        ...OPTIONAL_FLAG,
        name: 'type',
        type: 'string',
        value: '<type>',
        summary: 'Classify feedback.',
        constraints: { choices: FEEDBACK_TYPES, default: FEEDBACK_TYPE_DEFAULT },
      },
      {
        ...OPTIONAL_FLAG,
        name: 'severity',
        type: 'string',
        value: '<severity>',
        summary: 'Set impact priority.',
        constraints: { choices: FEEDBACK_SEVERITIES, default: FEEDBACK_SEVERITY_DEFAULT },
      },
      {
        ...OPTIONAL_FLAG,
        name: 'area',
        type: 'string',
        value: '<area>',
        summary: 'Assign a product area.',
        constraints: { choices: FEEDBACK_AREAS },
      },
      {
        ...OPTIONAL_FLAG,
        name: 'agent',
        type: 'string',
        value: '<name>',
        summary: 'Client-reported coding-agent name; omit when unknown.',
        constraints: {
          minLength: FEEDBACK_AGENT_NAME_MIN,
          maxLength: FEEDBACK_AGENT_NAME_MAX,
        },
      },
      {
        ...OPTIONAL_FLAG,
        name: 'model',
        type: 'string',
        value: '<id>',
        summary: 'Client-reported model identifier; requires --agent.',
        constraints: {
          minLength: FEEDBACK_AGENT_MODEL_MIN,
          maxLength: FEEDBACK_AGENT_MODEL_MAX,
        },
      },
      SERVICE,
      AUTH_TOKEN,
      {
        ...OPTIONAL_FLAG,
        name: 'dry-run',
        type: 'boolean',
        summary:
          'Validate and preview the exact submission without authentication, network access, or sending feedback.',
      },
      JSON_FLAG,
    ],
    jsonOutput: { mode: 'single' },
  },
];
