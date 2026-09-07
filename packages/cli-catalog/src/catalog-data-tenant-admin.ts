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
const REQUIRED_ORG: FlagSpec = { ...ORG, required: true };
const APP: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'app',
  type: 'string',
  value: '<slug>',
  summary: 'Application slug.',
};
const _ENV: FlagSpec = {
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
const YES: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'yes',
  type: 'boolean',
  summary: 'Confirm the MCP URL-breaking change non-interactively.',
};
const WATCH_JSON: FlagSpec = { ...JSON_FLAG, conflictsWith: ['watch'] };
const _RESOURCE_BASE_FLAGS: readonly FlagSpec[] = [ORG, SERVICE, AUTH_TOKEN];
const ORG_FLAGS: readonly FlagSpec[] = [SERVICE, AUTH_TOKEN, JSON_FLAG];
const MEMBER_FLAGS: readonly FlagSpec[] = [REQUIRED_ORG, SERVICE, AUTH_TOKEN, JSON_FLAG];
const GITHUB_BASE_FLAGS: readonly FlagSpec[] = [ORG, APP, SERVICE, AUTH_TOKEN];
const GITHUB_FLAGS: readonly FlagSpec[] = [...GITHUB_BASE_FLAGS, JSON_FLAG];

export const CATALOG_TENANT_ADMIN: readonly CommandSpec[] = [
  {
    name: 'list',
    section: 'resources',
    summary: 'Removed — promoted to `deployments list` (ADR 0128 D4).',
    removed: { use: 'noodle deployments list' },
  },
  {
    name: 'orgs',
    section: 'resources',
    summary: 'List, create, rename, switch, or inspect organizations.',
    arguments: [],
    flags: ORG_FLAGS,
    jsonOutput: { mode: 'single' },
    subcommands: [
      {
        name: 'list',
        summary: 'List organizations you belong to.',
        arguments: [],
        flags: ORG_FLAGS,
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'create',
        summary: 'Create a new organization.',
        arguments: [
          { ...REQUIRED_ARGUMENT, name: 'slug', summary: 'Organization slug to create.' },
        ],
        flags: [
          ...ORG_FLAGS,
          {
            ...OPTIONAL_FLAG,
            name: 'display-name',
            type: 'string',
            value: '<name>',
            summary: 'Set the display name.',
          },
        ],
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'rename',
        summary: 'Rename an organization.',
        arguments: [
          { ...REQUIRED_ARGUMENT, name: 'slug', summary: 'Organization slug to rename.' },
        ],
        flags: [
          ...ORG_FLAGS,
          {
            ...OPTIONAL_FLAG,
            name: 'name',
            type: 'string',
            value: '<displayName>',
            required: true,
            summary: 'Set the new display name.',
          },
        ],
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'switch',
        summary: 'Switch the default org for future commands (validates membership).',
        arguments: [
          { ...REQUIRED_ARGUMENT, name: 'slug', summary: 'Organization slug to select.' },
        ],
        flags: ORG_FLAGS,
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'current',
        summary: 'Show the resolved active org and its source (link/config).',
        arguments: [],
        flags: [JSON_FLAG],
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'inspect',
        summary: 'Show one organization by slug.',
        arguments: [
          { ...REQUIRED_ARGUMENT, name: 'slug', summary: 'Organization slug to inspect.' },
        ],
        flags: ORG_FLAGS,
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'domains',
        summary: 'List, add, or remove org domains whose signed-in users are org members.',
        arguments: [],
        flags: ORG_FLAGS,
        jsonOutput: { mode: 'single' },
        subcommands: [
          {
            name: 'list',
            summary: 'List the org domains that admit signed-in users.',
            arguments: [{ ...REQUIRED_ARGUMENT, name: 'org', summary: 'Organization slug.' }],
            flags: ORG_FLAGS,
            jsonOutput: { mode: 'single' },
          },
          {
            name: 'add',
            summary: 'Register one or more domains whose signed-in users become org members.',
            arguments: [
              { ...REQUIRED_ARGUMENT, name: 'org', summary: 'Organization slug.' },
              {
                ...REQUIRED_ARGUMENT,
                name: 'domain',
                variadic: true,
                summary: 'Domains to register, for example acme.com.',
              },
            ],
            flags: ORG_FLAGS,
            jsonOutput: { mode: 'single' },
          },
          {
            name: 'remove',
            summary: 'Remove one org domain, revoking access for its signed-in users.',
            arguments: [
              { ...REQUIRED_ARGUMENT, name: 'org', summary: 'Organization slug.' },
              { ...REQUIRED_ARGUMENT, name: 'domain', summary: 'Domain to remove.' },
            ],
            flags: ORG_FLAGS,
            jsonOutput: { mode: 'single' },
          },
        ],
      },
      {
        name: 'mcp-subdomain',
        summary: 'Show or change the organization-level MCP hostname label.',
        arguments: [],
        flags: [ORG, SERVICE, AUTH_TOKEN, JSON_FLAG],
        jsonOutput: { mode: 'single' },
        subcommands: [
          {
            name: 'get',
            summary: 'Show the current organization MCP subdomain.',
            arguments: [],
            flags: [ORG, SERVICE, AUTH_TOKEN, JSON_FLAG],
            jsonOutput: { mode: 'single' },
          },
          {
            name: 'set',
            summary: 'Change the MCP subdomain; old MCP URLs stop working immediately.',
            arguments: [
              {
                ...REQUIRED_ARGUMENT,
                name: 'new-subdomain',
                summary: 'Globally unique MCP hostname label.',
              },
            ],
            flags: [ORG, SERVICE, AUTH_TOKEN, JSON_FLAG, YES],
            jsonOutput: { mode: 'single' },
          },
        ],
      },
      {
        name: 'openai-challenge',
        summary: 'Manage the org OpenAI Apps domain verification challenge.',
        arguments: [],
        flags: ORG_FLAGS,
        jsonOutput: { mode: 'single' },
        subcommands: [
          {
            name: 'get',
            summary: 'Show the OpenAI Apps domain verification challenge.',
            arguments: [{ ...REQUIRED_ARGUMENT, name: 'org', summary: 'Organization slug.' }],
            flags: ORG_FLAGS,
            jsonOutput: { mode: 'single' },
          },
          {
            name: 'set',
            summary: 'Set the OpenAI Apps domain verification challenge.',
            arguments: [{ ...REQUIRED_ARGUMENT, name: 'org', summary: 'Organization slug.' }],
            flags: [
              ...ORG_FLAGS,
              {
                ...OPTIONAL_FLAG,
                name: 'code',
                type: 'string',
                value: '<challenge>',
                required: true,
                sensitive: true,
                summary: 'Set the verification challenge.',
              },
            ],
            jsonOutput: { mode: 'single' },
          },
          {
            name: 'clear',
            summary: 'Clear the OpenAI Apps domain verification challenge.',
            arguments: [{ ...REQUIRED_ARGUMENT, name: 'org', summary: 'Organization slug.' }],
            flags: ORG_FLAGS,
            jsonOutput: { mode: 'single' },
          },
        ],
      },
    ],
  },
  {
    name: 'members',
    section: 'resources',
    summary: 'List, add, remove, or manage invitations for org members.',
    arguments: [],
    flags: MEMBER_FLAGS,
    jsonOutput: { mode: 'single' },
    subcommands: [
      {
        name: 'list',
        summary: 'List org members.',
        arguments: [],
        flags: MEMBER_FLAGS,
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'add',
        summary: 'Add a member to an org.',
        arguments: [],
        flags: [
          ...MEMBER_FLAGS,
          {
            ...OPTIONAL_FLAG,
            name: 'subject',
            type: 'string',
            value: '<sub>',
            summary: 'Identity subject to add.',
            required: true,
          },
          {
            ...OPTIONAL_FLAG,
            name: 'email',
            type: 'string',
            value: '<email>',
            summary: 'Member email address.',
            required: true,
          },
          {
            ...OPTIONAL_FLAG,
            name: 'role',
            type: 'string',
            value: '<role>',
            summary: 'Member role.',
            constraints: { choices: ['owner', 'developer'] },
          },
        ],
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'remove',
        summary: 'Remove a member from an org.',
        arguments: [],
        flags: [
          ...MEMBER_FLAGS,
          {
            ...OPTIONAL_FLAG,
            name: 'subject',
            type: 'string',
            value: '<sub>',
            summary: 'Identity subject to remove.',
            required: true,
          },
        ],
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'set-role',
        summary: 'Change a member role.',
        arguments: [],
        flags: [
          ...MEMBER_FLAGS,
          {
            ...OPTIONAL_FLAG,
            name: 'subject',
            type: 'string',
            value: '<sub>',
            summary: 'Identity subject to update.',
            required: true,
          },
          {
            ...OPTIONAL_FLAG,
            name: 'role',
            type: 'string',
            value: '<role>',
            summary: 'New member role.',
            required: true,
            constraints: { choices: ['owner', 'developer'] },
          },
        ],
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'invitations',
        summary: 'List pending invitations for an org.',
        arguments: [],
        flags: [
          ...MEMBER_FLAGS,
          {
            ...OPTIONAL_FLAG,
            name: 'all',
            type: 'boolean',
            summary: 'Include all invitations.',
          },
        ],
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'revoke',
        summary: 'Revoke a pending invitation.',
        arguments: [],
        flags: [
          ...MEMBER_FLAGS,
          {
            ...OPTIONAL_FLAG,
            name: 'email',
            type: 'string',
            value: '<email>',
            summary: 'Invited email address to revoke.',
            required: true,
          },
        ],
        jsonOutput: { mode: 'single' },
      },
    ],
  },
  {
    name: 'github',
    section: 'github',
    summary: 'Connect, inspect, or disconnect the GitHub repository behind GitHub-native deploys.',
    arguments: [],
    flags: GITHUB_FLAGS,
    jsonOutput: { mode: 'single' },
    subcommands: [
      {
        name: 'connect',
        summary: 'Install the Noodle Seed Deploys GitHub App and bind a repository to this app.',
        arguments: [],
        flags: [
          ...GITHUB_FLAGS,
          {
            ...OPTIONAL_FLAG,
            name: 'repo',
            type: 'string',
            value: '<owner/name>',
            summary: 'GitHub repository to bind.',
          },
        ],
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'status',
        summary: 'Show the app GitHub connection.',
        arguments: [],
        flags: GITHUB_FLAGS,
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'disconnect',
        summary: 'Stop GitHub-triggered deploys for this app.',
        arguments: [],
        flags: [
          ...GITHUB_FLAGS,
          {
            ...OPTIONAL_FLAG,
            name: 'yes',
            type: 'boolean',
            summary: 'Confirm non-interactively.',
          },
        ],
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'runs',
        summary: 'List webhook-triggered deploy runs for this app.',
        arguments: [],
        flags: [
          ...GITHUB_BASE_FLAGS,
          WATCH_JSON,
          {
            ...OPTIONAL_FLAG,
            name: 'limit',
            type: 'string',
            value: '<n>',
            summary: 'Maximum deploy runs to return.',
          },
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
        ],
        jsonOutput: { mode: 'single' },
      },
    ],
  },
  {
    name: 'keys',
    section: 'operate',
    summary: 'Removed — caller-key management no longer exists; hosted access is identity-based.',
    removed: { use: 'noodle deploy --access owner-only (or org-members/authenticated/customers)' },
  },
];
