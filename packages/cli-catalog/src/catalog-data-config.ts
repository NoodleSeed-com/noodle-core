/**
 * Catalog data: deploy-target and managed-config commands (`target`, `secrets`, `variables`).
 * Pure data — see the doc comment in `catalog-data-core.ts` for the no-runtime-import rule.
 */
import type { ArgumentSpec, CommandSpec, FlagSpec, SubcommandSpec } from './catalog-types.js';

const OPTIONAL_FLAG = {
  required: false,
  repeatable: false,
  sensitive: false,
  aliases: [],
  conflictsWith: [],
} as const;

const JSON_FLAG: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'json',
  type: 'boolean',
  summary: 'Emit JSON output.',
};
const ORG_FLAG: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'org',
  type: 'string',
  value: '<slug>',
  summary: 'Organization slug.',
};
const APP_FLAG: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'app',
  type: 'string',
  value: '<slug>',
  summary: 'Application slug.',
};
const ENV_FLAG: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'env',
  type: 'string',
  value: '<slug>',
  summary: 'Environment slug.',
};
const SERVICE_FLAG: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'service',
  type: 'string',
  value: '<url>',
  summary: 'Control-plane service URL.',
};
const AUTH_TOKEN_FLAG: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'auth-token',
  type: 'string',
  value: '<token>',
  summary: 'Control-plane authentication token.',
  sensitive: true,
};
const CONFIG_RUNTIME_FLAG: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'runtime',
  type: 'string',
  value: '<runtime>',
  summary:
    "Select the config store: --runtime, then saved runtime, then local. Cloud is hosted; local uses the containing project's .env.noodle. Local coordinates resolve from explicit fields, a complete project link, or deterministic local/project-app/dev; saved global coordinates are ignored. A complete hosted --org/--app/--env target requires explicit --runtime.",
  constraints: { choices: ['local', 'cloud', 'other'], default: 'local' },
};
const CONFIG_SCOPE_FLAG: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'scope',
  type: 'string',
  value: '<scope>',
  summary: 'Managed-config scope.',
  constraints: { choices: ['org', 'app', 'env'], default: 'env' },
};
const REVEAL_SCOPE_FLAG: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'scope',
  type: 'string',
  value: '<scope>',
  summary: 'Console reveal scope.',
  constraints: { choices: ['env'], default: 'env' },
};
const REVEAL_RUNTIME_FLAG: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'runtime',
  type: 'string',
  value: '<runtime>',
  summary: 'Cloud runtime required for Console reveal.',
  constraints: { choices: ['cloud'] },
};
const TARGET_RUNTIME_FLAG: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'runtime',
  type: 'string',
  value: '<runtime>',
  summary: 'Default runtime target.',
  constraints: { choices: ['local', 'cloud', 'other'] },
};
const CONFIG_TARGET_FLAGS: readonly FlagSpec[] = [
  CONFIG_RUNTIME_FLAG,
  CONFIG_SCOPE_FLAG,
  ORG_FLAG,
  APP_FLAG,
  ENV_FLAG,
  SERVICE_FLAG,
  AUTH_TOKEN_FLAG,
];
const VALUE_SOURCE_NAMES = ['value', 'from-env', 'from-file', 'from-stdin'] as const;

function valueSourceFlags(sensitive: boolean): readonly FlagSpec[] {
  return VALUE_SOURCE_NAMES.map((name) => {
    const conflictsWith = VALUE_SOURCE_NAMES.filter((candidate) => candidate !== name);
    if (name === 'value') {
      return {
        ...OPTIONAL_FLAG,
        name,
        type: 'string',
        value: '<value>',
        summary: 'Set the managed value directly.',
        sensitive,
        conflictsWith,
      };
    }
    if (name === 'from-env') {
      return {
        ...OPTIONAL_FLAG,
        name,
        type: 'string',
        value: '<name>',
        summary: 'Read the managed value from an environment variable.',
        sensitive,
        conflictsWith,
      };
    }
    if (name === 'from-file') {
      return {
        ...OPTIONAL_FLAG,
        name,
        type: 'string',
        value: '<path>',
        summary: 'Read the managed value from a regular file.',
        sensitive,
        conflictsWith,
      };
    }
    return {
      ...OPTIONAL_FLAG,
      name,
      type: 'boolean',
      summary: 'Read the managed value from standard input.',
      sensitive,
      conflictsWith,
    };
  });
}

function configFlags(
  kind: 'secret' | 'variable',
  action: 'set' | 'read' | 'delete',
): readonly FlagSpec[] {
  return [
    ...(action === 'set' ? valueSourceFlags(kind === 'secret') : []),
    ...CONFIG_TARGET_FLAGS.map((flag) =>
      kind === 'variable' && ['scope', 'app', 'env'].includes(flag.name)
        ? { ...flag, conflictsWith: [...flag.conflictsWith, 'installation'] }
        : flag,
    ),
    ...(kind === 'variable'
      ? [
          {
            ...OPTIONAL_FLAG,
            name: 'installation',
            type: 'string' as const,
            value: '<id>',
            summary:
              'Inspect or configure declared business settings for one installation on cloud/other runtime. Replaces app/env/scope; requires an organization and live business grant. Values use JSON input and are never printed.',
            conflictsWith: ['scope', 'app', 'env'],
          },
        ]
      : []),
    ...(kind === 'variable' && action !== 'read'
      ? [
          {
            ...OPTIONAL_FLAG,
            name: 'expected-revision',
            type: 'string' as const,
            value: '<digest>',
            summary:
              'Require this installation settings revision. Omit to read the current revision before the atomic update; a conflict never retries the write.',
          },
        ]
      : []),
    JSON_FLAG,
  ];
}

function managedConfigSubcommands(kind: 'secret' | 'variable'): readonly SubcommandSpec[] {
  const noun = kind === 'secret' ? 'secret' : 'variable';
  const name: ArgumentSpec = {
    name: 'name',
    type: 'string',
    summary: `Name of the ${noun}.`,
    required: true,
    variadic: false,
    sensitive: false,
    constraints: {},
  };
  return [
    {
      name: 'set',
      summary: `Set a ${noun} value.`,
      arguments: [name],
      flags: configFlags(kind, 'set'),
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'list',
      summary: `List ${noun}s in scope.`,
      arguments: [],
      flags: configFlags(kind, 'read'),
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'delete',
      summary:
        kind === 'variable'
          ? 'Delete a variable; with --installation, reset it to the declared default or unset state.'
          : 'Delete a secret.',
      arguments: [name],
      flags: configFlags(kind, 'delete'),
      jsonOutput: { mode: 'single' },
    },
    ...(kind === 'secret'
      ? [
          {
            name: 'reveal',
            summary: 'Open Console Configuration to reveal a secret after fresh sign-in.',
            arguments: [name],
            flags: [
              REVEAL_RUNTIME_FLAG,
              REVEAL_SCOPE_FLAG,
              ORG_FLAG,
              APP_FLAG,
              ENV_FLAG,
              SERVICE_FLAG,
              AUTH_TOKEN_FLAG,
            ],
          },
        ]
      : []),
    {
      name: 'resolve',
      summary: `Resolve the effective ${noun} value(s) for the target.`,
      arguments: [
        {
          name: 'name',
          type: 'string',
          summary: `Optional ${noun} name to resolve.`,
          required: false,
          variadic: false,
          sensitive: false,
          constraints: {},
        },
      ],
      flags: configFlags(kind, 'read'),
      jsonOutput: { mode: 'single' },
    },
  ];
}

export const CATALOG_CONFIG: readonly CommandSpec[] = [
  {
    name: 'target',
    section: 'account',
    helpRank: 5,
    summary: 'Show or set the deploy target (runtime, service, org, app, env).',
    arguments: [],
    flags: [],
    subcommands: [
      {
        name: 'show',
        summary: 'Show the resolved effective target, annotated with each field’s source.',
        arguments: [],
        flags: [JSON_FLAG],
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'set',
        summary: 'Set one or more default target fields.',
        arguments: [],
        flags: [TARGET_RUNTIME_FLAG, SERVICE_FLAG, ORG_FLAG, APP_FLAG, ENV_FLAG, JSON_FLAG],
        jsonOutput: { mode: 'single' },
      },
    ],
  },
  {
    name: 'secrets',
    section: 'account',
    helpRank: 3,
    summary: 'Manage secrets (set/list/delete/reveal/resolve), scoped to org/app/env.',
    arguments: [],
    flags: [],
    subcommands: managedConfigSubcommands('secret'),
  },
  {
    name: 'variables',
    section: 'account',
    helpRank: 4,
    summary:
      'Manage non-secret variables (set/list/delete/resolve), scoped to org/app/env or installation business settings.',
    arguments: [],
    flags: [],
    subcommands: managedConfigSubcommands('variable'),
  },
];
