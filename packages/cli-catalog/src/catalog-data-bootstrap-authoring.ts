/** Bootstrap and local authoring command catalog data. Pure data — no runtime imports. */
import type { ArgumentSpec, CommandSpec, FlagSpec } from './catalog-types.js';

const OPTIONAL_FLAG = {
  required: false,
  repeatable: false,
  sensitive: false,
  aliases: [],
  conflictsWith: [],
} as const;

function stringFlag(
  name: string,
  value: string,
  summary: string,
  options: Partial<FlagSpec> = {},
): FlagSpec {
  return { ...OPTIONAL_FLAG, name, type: 'string', value, summary, ...options };
}

function booleanFlag(name: string, summary: string): FlagSpec {
  return { ...OPTIONAL_FLAG, name, type: 'boolean', summary };
}

const JSON_FLAG = booleanFlag('json', 'Emit JSON output.');
const CONNECTORS_FLAG = stringFlag('connectors', '<file>', 'Connector configuration file.');
const ENDPOINT_FLAG = stringFlag('endpoint', '<url>', 'Deployed MCP endpoint URL.');
const NAME_FLAG = stringFlag('name', '<label>', 'Display label for the client connection.');
const WRITE_FLAG = booleanFlag('write', 'Write the generated configuration.');
const FORCE_FLAG = booleanFlag('force', 'Overwrite changed generated files.');
const SERVER_ARGUMENT: ArgumentSpec = {
  name: 'server.ts',
  type: 'string',
  summary: 'Authored server entrypoint.',
  required: false,
  variadic: false,
  sensitive: false,
  constraints: {},
};

const CONNECT_JSON_FLAGS = [JSON_FLAG] as const;

export const CATALOG_BOOTSTRAP_AUTHORING: readonly CommandSpec[] = [
  {
    name: 'docs',
    section: 'build',
    helpRank: 10,
    summary: 'Export the docs for LLM and coding-agent consumption.',
    arguments: [],
    flags: [],
    subcommands: [
      {
        name: 'export',
        summary: 'Export LLM-readable platform docs.',
        arguments: [],
        flags: [
          stringFlag('format', '<format>', 'Documentation export format.', {
            required: true,
            constraints: { choices: ['llms'] },
          }),
          stringFlag('output', '<file>', 'Output file path.'),
        ],
      },
    ],
    local: true,
  },
  {
    name: 'connect',
    section: 'account',
    helpRank: 10,
    summary: 'Print connection setup for an MCP client host.',
    arguments: [],
    flags: [ENDPOINT_FLAG, NAME_FLAG, WRITE_FLAG, JSON_FLAG],
    jsonOutput: { mode: 'single' },
    subcommands: [
      {
        name: 'claude-code',
        summary: 'Project-local Claude Code agent setup.',
        arguments: [],
        flags: CONNECT_JSON_FLAGS,
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'codex',
        summary: 'Project-local Codex agent setup.',
        arguments: [],
        flags: CONNECT_JSON_FLAGS,
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'gemini',
        summary: 'Portable docs-context setup guidance.',
        arguments: [],
        flags: CONNECT_JSON_FLAGS,
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'gemini-enterprise',
        summary: 'Print Gemini Enterprise OAuth client registration fields.',
        arguments: [],
        flags: [ENDPOINT_FLAG, NAME_FLAG, JSON_FLAG],
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'cursor',
        summary: 'Portable docs-context setup guidance.',
        arguments: [],
        flags: CONNECT_JSON_FLAGS,
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'vscode',
        summary: 'Portable docs-context setup guidance.',
        arguments: [],
        flags: CONNECT_JSON_FLAGS,
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'claude',
        summary: 'Print an MCP client config block for a deployed endpoint.',
        arguments: [],
        flags: [ENDPOINT_FLAG, JSON_FLAG],
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'chatgpt',
        summary: 'Print an MCP client config block for a deployed endpoint.',
        arguments: [],
        flags: [ENDPOINT_FLAG, JSON_FLAG],
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'inspector',
        summary: 'Print the local MCP Inspector setup steps.',
        arguments: [],
        flags: CONNECT_JSON_FLAGS,
        jsonOutput: { mode: 'single' },
      },
    ],
  },
  {
    name: 'import',
    section: 'build',
    helpRank: 8,
    summary: 'Scaffold starter code from OpenAPI or a frozen upstream MCP tool snapshot.',
    arguments: [],
    flags: [],
    subcommands: [
      {
        name: 'openapi',
        summary: 'Write a pinned src/server.ts project and offline contract test from OpenAPI.',
        arguments: [
          {
            name: 'file',
            type: 'string',
            summary: 'OpenAPI document to import.',
            required: true,
            variadic: false,
            sensitive: false,
            constraints: {},
          },
        ],
        flags: [
          stringFlag('output', '<dir>', 'Generated project directory.', {
            constraints: { default: 'noodle-openapi-app' },
          }),
          stringFlag('name', '<slug>', 'Generated server name.', {
            constraints: { default: 'openapi-app' },
          }),
          stringFlag('base-url', '<url>', 'Override the imported API base URL.'),
          FORCE_FLAG,
        ],
      },
      {
        name: 'mcp',
        summary: 'Import a remote MCP tool snapshot into a governed TypeScript project.',
        arguments: [
          {
            name: 'url',
            type: 'string',
            summary: 'Remote Streamable HTTP MCP endpoint.',
            required: true,
            variadic: false,
            sensitive: false,
            constraints: {},
          },
        ],
        flags: [
          stringFlag('output', '<dir>', 'Generated project directory.', {
            constraints: { default: 'noodle-mcp-app' },
          }),
          stringFlag('name', '<slug>', 'Generated server and connector name.', {
            constraints: { default: 'mcp-app' },
          }),
          stringFlag('prefix', '<name>', 'Prefix imported operation and outward tool names.'),
          stringFlag(
            'header-env',
            '<header>=<ENV_NAME>',
            'Read one import credential from the named environment variable; never persist its value.',
          ),
          booleanFlag(
            'check',
            'Compare the live tool surface with the saved snapshot without writing.',
          ),
          FORCE_FLAG,
          JSON_FLAG,
        ],
        jsonOutput: { mode: 'single' },
      },
    ],
    local: true,
  },
  {
    name: 'export',
    section: 'build',
    helpRank: 9,
    summary: 'Compile locally and export a manifest, host plugin, or connector dossier.',
    arguments: [],
    flags: [],
    subcommands: [
      {
        name: 'manifest',
        summary: 'Write the compiled, portable manifest (and connector catalog) to disk.',
        arguments: [SERVER_ARGUMENT],
        flags: [
          stringFlag('output', '<file>', 'Manifest output file.'),
          stringFlag('connectors-output', '<file>', 'Connector catalog output file.'),
          CONNECTORS_FLAG,
        ],
      },
      {
        name: 'plugin',
        summary: 'Write a deterministic host plugin package from server.ts.',
        arguments: [],
        flags: [],
        subcommands: [
          {
            name: 'openai',
            summary: 'Write an OpenAI local-testing or submission plugin ZIP.',
            arguments: [SERVER_ARGUMENT],
            flags: [
              stringFlag(
                'state',
                '<state>',
                'Local marketplace testing or public submission projection.',
                {
                  required: true,
                  constraints: { choices: ['local', 'submission'] },
                },
              ),
              stringFlag('mcp-url', '<url>', 'Exact Streamable HTTP MCP URL.', {
                required: true,
              }),
              stringFlag('category', '<category>', 'OpenAI install-surface category.', {
                required: true,
              }),
              stringFlag(
                'registered-app-id',
                '<plugin_asdk_app_id>',
                'ChatGPT developer-mode app ID for local testing only.',
              ),
              stringFlag('output', '<file>', 'Output ZIP file.', {
                required: true,
              }),
              CONNECTORS_FLAG,
              JSON_FLAG,
            ],
            jsonOutput: { mode: 'single' },
          },
          {
            name: 'claude',
            summary: 'Write an installable Claude Code plugin repository ZIP.',
            arguments: [SERVER_ARGUMENT],
            flags: [
              stringFlag('mcp-url', '<url>', 'Public Streamable HTTP MCP URL.', {
                required: true,
              }),
              stringFlag('output', '<file>', 'Output ZIP file.', {
                required: true,
              }),
              CONNECTORS_FLAG,
              JSON_FLAG,
            ],
            jsonOutput: { mode: 'single' },
          },
        ],
      },
      {
        name: 'connector',
        summary: 'Write an offline remote-connector submission dossier from server.ts.',
        arguments: [],
        flags: [],
        subcommands: [
          {
            name: 'claude',
            summary: 'Write an Anthropic Connector Directory operator dossier ZIP.',
            arguments: [SERVER_ARGUMENT],
            flags: [
              stringFlag('mcp-url', '<url>', 'Public Streamable HTTP MCP URL.', {
                required: true,
              }),
              stringFlag('auth', '<mode>', 'Connector authentication mode.', {
                required: true,
                constraints: { choices: ['none', 'oauth-dcr'] },
              }),
              stringFlag(
                'category',
                '<category>',
                'Connector Directory category (repeat one to five times).',
                { required: true, repeatable: true },
              ),
              stringFlag('output', '<file>', 'Output ZIP file.', {
                required: true,
              }),
              CONNECTORS_FLAG,
              JSON_FLAG,
            ],
            jsonOutput: { mode: 'single' },
          },
        ],
      },
    ],
    local: true,
  },
  {
    name: 'validate',
    section: 'build',
    helpRank: 1,
    summary: 'Author-time compile check (schema, expressions, connector refs); no service.',
    arguments: [SERVER_ARGUMENT],
    flags: [
      CONNECTORS_FLAG,
      JSON_FLAG,
      booleanFlag('fix-prompt', 'Emit an agent-ready repair prompt for the failing errors.'),
    ],
    jsonOutput: { mode: 'single' },
    local: true,
  },
  {
    name: 'check',
    section: 'build',
    helpRank: 3,
    summary: 'Check tool design and MCP Apps/widget readiness; no service.',
    arguments: [SERVER_ARGUMENT],
    flags: [
      CONNECTORS_FLAG,
      stringFlag('target', '<target>', 'Host compatibility target.', {
        constraints: {
          choices: ['generic', 'chatgpt', 'claude', 'embedded-assistant'],
          default: 'generic',
        },
      }),
      stringFlag(
        'min-severity',
        '<severity>',
        'Hide findings below this severity; the pass/fail verdict is unchanged.',
        {
          constraints: { choices: ['info', 'warn', 'error'] },
        },
      ),
      JSON_FLAG,
      booleanFlag('fix-prompt', 'Emit an agent-ready repair prompt for the failing checks.'),
    ],
    jsonOutput: { mode: 'single' },
    local: true,
  },
  {
    name: 'test',
    section: 'build',
    helpRank: 2,
    summary: 'Local compile plus an open-MCP or protected-auth boundary smoke.',
    arguments: [SERVER_ARGUMENT],
    flags: [
      CONNECTORS_FLAG,
      stringFlag(
        'tool',
        '<name>',
        'Tool to call for an open app; protected apps require Devtools sign-in.',
      ),
      stringFlag('args', '<json>', 'Tool input as a JSON object.'),
      JSON_FLAG,
    ],
    jsonOutput: { mode: 'single' },
    local: true,
  },
  {
    name: 'tools',
    section: 'build',
    helpRank: 4,
    summary: 'List or call local tools via a loopback MCP smoke.',
    arguments: [],
    flags: [CONNECTORS_FLAG, JSON_FLAG],
    jsonOutput: { mode: 'single' },
    subcommands: [
      {
        name: 'list',
        summary: 'List the tools the local server exposes.',
        arguments: [SERVER_ARGUMENT],
        flags: CONNECT_JSON_FLAGS,
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'call',
        summary: 'Call one tool and print its result.',
        arguments: [
          {
            name: 'name',
            type: 'string',
            summary: 'Name of the tool to call.',
            required: true,
            variadic: false,
            sensitive: false,
            constraints: {},
          },
          SERVER_ARGUMENT,
        ],
        flags: [stringFlag('args', '<json>', 'Tool input as a JSON object.'), JSON_FLAG],
        jsonOutput: { mode: 'single' },
      },
    ],
    local: true,
  },
  {
    name: 'resources',
    section: 'build',
    helpRank: 5,
    summary: 'Read local resources via a loopback MCP smoke.',
    arguments: [],
    flags: [CONNECTORS_FLAG, JSON_FLAG],
    jsonOutput: { mode: 'single' },
    subcommands: [
      {
        name: 'read',
        summary: 'Read one resource by URI.',
        arguments: [
          {
            name: 'uri',
            type: 'string',
            summary: 'URI of the resource to read.',
            required: true,
            variadic: false,
            sensitive: false,
            constraints: {},
          },
          SERVER_ARGUMENT,
        ],
        flags: CONNECT_JSON_FLAGS,
        jsonOutput: { mode: 'single' },
      },
    ],
    local: true,
  },
];
