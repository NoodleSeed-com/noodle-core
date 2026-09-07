/** Local authoring command catalog data. Pure data — no runtime imports. */
import type { CommandSpec, FlagSpec } from './catalog-types.js';

const OPTIONAL_FLAG = {
  required: false,
  repeatable: false,
  sensitive: false,
  aliases: [],
  conflictsWith: [],
} as const;
const CONNECTORS_FLAG: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'connectors',
  type: 'string',
  value: '<file>',
  summary: 'Connector configuration file.',
};
const JSON_FLAG: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'json',
  type: 'boolean',
  summary: 'Emit JSON output.',
};
const SERVER_ARGUMENT = {
  name: 'server.ts',
  type: 'string',
  summary: 'Authored server entrypoint.',
  required: false,
  variadic: false,
  sensitive: false,
  constraints: {},
} as const;

export const CATALOG_LOCAL_AUTHORING: readonly CommandSpec[] = [
  {
    name: 'prompts',
    section: 'build',
    helpRank: 6,
    summary: 'Get local prompts via a loopback MCP smoke.',
    arguments: [],
    subcommands: [
      {
        name: 'get',
        summary: 'Render one prompt by name.',
        arguments: [
          {
            name: 'name',
            type: 'string',
            summary: 'Name of the prompt to render.',
            required: true,
            variadic: false,
            sensitive: false,
            constraints: {},
          },
          SERVER_ARGUMENT,
        ],
        flags: [
          {
            ...OPTIONAL_FLAG,
            name: 'args',
            type: 'string',
            value: '<json>',
            summary: 'Prompt arguments as a JSON object.',
          },
          JSON_FLAG,
        ],
        jsonOutput: { mode: 'single' },
      },
    ],
    flags: [CONNECTORS_FLAG, JSON_FLAG],
    jsonOutput: { mode: 'single' },
    local: true,
  },
  {
    name: 'dev',
    section: 'start',
    summary:
      'Run a local runtime with hot reload (no Noodle account; customer sign-in when declared).',
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
        name: 'org',
        type: 'string',
        value: '<slug>',
        summary: 'Organization slug for local target context.',
      },
      {
        ...OPTIONAL_FLAG,
        name: 'app',
        type: 'string',
        value: '<slug>',
        summary: 'Application slug for local target context.',
      },
      {
        ...OPTIONAL_FLAG,
        name: 'env',
        type: 'string',
        value: '<slug>',
        summary: 'Environment slug for local target context.',
      },
      CONNECTORS_FLAG,
      {
        ...OPTIONAL_FLAG,
        name: 'port',
        type: 'integer',
        value: '<port>',
        summary: 'Loopback MCP server port.',
      },
      {
        ...OPTIONAL_FLAG,
        name: 'tunnel',
        type: 'boolean',
        summary: 'Publish the loopback server via cloudflared for cloud AI clients.',
      },
      {
        ...OPTIONAL_FLAG,
        name: 'no-preview',
        type: 'boolean',
        summary: 'Disable the widget preview.',
      },
      {
        ...OPTIONAL_FLAG,
        name: 'preview',
        type: 'boolean',
        summary: 'Force the widget preview to open.',
      },
      {
        ...OPTIONAL_FLAG,
        name: 'preview-port',
        type: 'integer',
        value: '<port>',
        summary: 'Widget preview server port.',
      },
      {
        ...OPTIONAL_FLAG,
        name: 'model',
        type: 'string',
        value: '<model>',
        summary: 'Model used by the widget preview chat.',
      },
      {
        ...OPTIONAL_FLAG,
        name: 'theme',
        type: 'string',
        value: '<theme>',
        summary: 'Widget preview theme.',
        constraints: { default: 'both' },
      },
      {
        ...OPTIONAL_FLAG,
        name: 'device',
        type: 'string',
        value: '<device>',
        summary: 'Widget preview device size.',
        constraints: { default: 'both' },
      },
    ],
    local: true,
  },
  {
    name: 'devtools',
    section: 'build',
    helpRank: 7,
    summary:
      'Preview tools and widgets with direct, federated OIDC, Firebase, or Microsoft customer sign-in.',
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
        name: 'port',
        type: 'integer',
        value: '<port>',
        summary: 'Widget devtools server port.',
      },
      CONNECTORS_FLAG,
      {
        ...OPTIONAL_FLAG,
        name: 'model',
        type: 'string',
        value: '<model>',
        summary: 'Model used by the preview chat.',
      },
      {
        ...OPTIONAL_FLAG,
        name: 'theme',
        type: 'string',
        value: '<theme>',
        summary: 'Preview theme.',
        constraints: { default: 'both' },
      },
      {
        ...OPTIONAL_FLAG,
        name: 'device',
        type: 'string',
        value: '<device>',
        summary: 'Preview device size.',
        constraints: { default: 'both' },
      },
      {
        ...OPTIONAL_FLAG,
        name: 'headless',
        type: 'boolean',
        summary: 'Run without opening the interactive browser.',
      },
      {
        ...OPTIONAL_FLAG,
        name: 'open',
        type: 'boolean',
        summary: 'Open the widget devtools in a browser.',
      },
    ],
    local: true,
  },
  {
    name: 'design',
    section: 'build',
    helpRank: 8,
    summary: 'Inspect the latest finalized local widget design brief.',
    arguments: [],
    subcommands: [
      {
        name: 'inspect',
        summary: 'Render the latest finalized Design Session for a coding agent.',
        arguments: [],
        flags: [
          {
            ...OPTIONAL_FLAG,
            name: 'latest',
            type: 'boolean',
            summary: 'Inspect the latest finalized Design Session.',
            required: true,
          },
          JSON_FLAG,
        ],
        jsonOutput: { mode: 'single' },
      },
    ],
    flags: [],
    local: true,
  },
  {
    name: 'update',
    section: 'account',
    helpRank: 13,
    summary: 'Check for, install, or safely repair the global CLI install.',
    arguments: [],
    flags: [
      {
        ...OPTIONAL_FLAG,
        name: 'check',
        type: 'boolean',
        summary: 'Report the plan only; change nothing.',
      },
      {
        ...OPTIONAL_FLAG,
        name: 'yes',
        type: 'boolean',
        summary: 'Confirm the update without prompting.',
      },
      {
        ...OPTIONAL_FLAG,
        name: 'repair',
        type: 'boolean',
        summary: 'Remove a blocking old binary, then update.',
      },
      JSON_FLAG,
    ],
    jsonOutput: { mode: 'single' },
    exitCodes: {
      10: 'update available (--check)',
      11: 'update or repair failed',
      12: 'repair required (safe, but --repair not authorized/confirmable)',
      13: 'unsafe conflicting binary blocks npm',
      14: 'network inconclusive',
    },
    local: true,
  },
];
