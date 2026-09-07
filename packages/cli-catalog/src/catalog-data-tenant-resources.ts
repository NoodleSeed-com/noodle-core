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
