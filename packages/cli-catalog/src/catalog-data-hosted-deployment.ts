/** Hosted deployment, governance, observability, and billing command catalog data. */
import type { ArgumentSpec, CommandSpec, FlagSpec, SubcommandSpec } from './catalog-types.js';

const ACCESS_MODES = [
  'owner-only',
  'org-members',
  'authenticated',
  'public',
  'mixed',
  'customers',
] as const;

const ARGUMENT_FIELDS = { variadic: false, sensitive: false, constraints: {} } as const;
const FLAG_FIELDS = {
  required: false,
  repeatable: false,
  sensitive: false,
  aliases: [],
  conflictsWith: [],
} as const;
const SUBCOMMAND_FIELDS = { arguments: [], flags: [] } as const;

function argument(value: ArgumentSpec): ArgumentSpec {
  return value;
}

function flag(value: FlagSpec): FlagSpec {
  return value;
}

function subcommand(value: SubcommandSpec): SubcommandSpec {
  return value;
}

const ORG_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'org',
  type: 'string',
  value: '<slug>',
  summary: 'Organization slug.',
});
const APP_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'app',
  type: 'string',
  value: '<slug>',
  summary: 'Application slug.',
});
const ENV_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'env',
  type: 'string',
  value: '<slug>',
  summary: 'Environment slug.',
});
const SERVICE_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'service',
  type: 'string',
  value: '<url>',
  summary: 'Control-plane service URL.',
});
const AUTH_TOKEN_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'auth-token',
  type: 'string',
  value: '<token>',
  summary: 'Control-plane authentication token.',
  sensitive: true,
});
const JSON_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'json',
  type: 'boolean',
  summary: 'Emit JSON output.',
});
const TENANT_TARGET_FLAGS: readonly FlagSpec[] = [
  ORG_FLAG,
  APP_FLAG,
  ENV_FLAG,
  SERVICE_FLAG,
  AUTH_TOKEN_FLAG,
  JSON_FLAG,
];

/** `--watch`/`--interval` (ADR 0129 live-redraw dashboards): `apps list`, `deployments list`, `status`. */
const WATCH_FLAGS: readonly FlagSpec[] = [
  flag({
    ...FLAG_FIELDS,
    name: 'watch',
    type: 'boolean',
    summary:
      'Live-refresh in place (Ctrl-C to stop); TTY repaints, non-TTY streams timestamped snapshots.',
    conflictsWith: ['json'],
  }),
  flag({
    ...FLAG_FIELDS,
    name: 'interval',
    type: 'number',
    value: '<seconds>',
    summary: 'Refresh interval used with --watch.',
    constraints: { default: 5, minimum: 2 },
  }),
];

const DEPLOY_ARGUMENTS: readonly ArgumentSpec[] = [
  argument({
    ...ARGUMENT_FIELDS,
    name: 'server.ts',
    type: 'string',
    summary: 'Server entrypoint; defaults to the linked or conventional project entrypoint.',
    required: false,
  }),
];
const DEPLOY_FLAGS: readonly FlagSpec[] = [
  ORG_FLAG,
  APP_FLAG,
  ENV_FLAG,
  flag({
    ...FLAG_FIELDS,
    name: 'version',
    type: 'string',
    value: '<version>',
    summary:
      'Publish or overwrite an exact server version. Omit it and deploy reuses this project’s last version, a vN/ entrypoint folder, or the version the hosted app already runs — a brand-new app starts at 1.',
  }),
  flag({
    ...FLAG_FIELDS,
    name: 'private',
    type: 'boolean',
    summary: 'Shorthand for --access owner-only.',
  }),
  flag({
    ...FLAG_FIELDS,
    name: 'access',
    type: 'string',
    value: '<mode>',
    summary: 'Identity access mode for the deployment.',
    constraints: { choices: ACCESS_MODES },
  }),
  flag({
    ...FLAG_FIELDS,
    name: 'owner-subject',
    type: 'string',
    value: '<subject>',
    summary: 'Exact OAuth subject bound when access is owner-only.',
  }),
  flag({
    ...FLAG_FIELDS,
    name: 'connectors',
    type: 'string',
    value: '<file>',
    summary: 'Connector catalog override file.',
  }),
  SERVICE_FLAG,
  AUTH_TOKEN_FLAG,
  flag({
    ...FLAG_FIELDS,
    name: 'save',
    type: 'boolean',
    summary: 'Also append to ~/.noodle/servers.json.',
  }),
  flag({
    ...FLAG_FIELDS,
    name: 'no-save',
    type: 'boolean',
    summary: 'Do not persist deployment metadata.',
  }),
  flag({
    ...FLAG_FIELDS,
    name: 'no-prompt',
    type: 'boolean',
    summary: 'Never prompt to set missing variables or secrets; return the complete checklist.',
  }),
  JSON_FLAG,
];

export const CATALOG_HOSTED_DEPLOYMENT: readonly CommandSpec[] = [
  {
    name: 'deploy',
    section: 'start',
    usage: '[<server.ts>] | preflight [<server.ts>]',
    next: ['noodle login then noodle deploy', 'noodle github connect'],
    summary:
      'Preflight required config, deploy your server, and verify its governed MCP URL is ready.',
    arguments: DEPLOY_ARGUMENTS,
    flags: DEPLOY_FLAGS,
    subcommands: [
      subcommand({
        name: 'preflight',
        summary:
          'Check the authored deployment and all reported prerequisites without configuring or publishing.',
        arguments: DEPLOY_ARGUMENTS,
        flags: DEPLOY_FLAGS.filter((item) => item.name !== 'save' && item.name !== 'no-save').map(
          (item) =>
            item.name === 'version'
              ? {
                  ...item,
                  summary:
                    'Server version to validate without publishing. Omit it to use the normal deployment version resolution.',
                }
              : item,
        ),
        jsonOutput: { mode: 'single' },
      }),
    ],
    jsonOutput: { mode: 'single' },
  },
  {
    name: 'open',
    section: 'operate',
    helpRank: 6,
    summary: 'Open or print the latest linked deployment URL.',
    arguments: [],
    flags: [
      flag({
        ...FLAG_FIELDS,
        name: 'print',
        type: 'boolean',
        summary: 'Print the URL without opening a browser.',
      }),
      flag({
        ...FLAG_FIELDS,
        name: 'dashboard',
        type: 'boolean',
        summary: 'Open the project dashboard instead.',
      }),
    ],
  },
  {
    name: 'status',
    section: 'operate',
    helpRank: 1,
    next: ['noodle logs', 'noodle open'],
    summary: 'Show hosted deployment status.',
    arguments: [],
    flags: [
      ...TENANT_TARGET_FLAGS.map((item) =>
        item.name === 'json' ? { ...item, conflictsWith: ['watch'] } : item,
      ),
      flag({
        ...FLAG_FIELDS,
        name: 'version',
        type: 'string',
        value: '<version>',
        summary: 'Server version to inspect.',
      }),
      ...WATCH_FLAGS,
    ],
    jsonOutput: { mode: 'single' },
  },
  {
    name: 'inspect',
    section: 'operate',
    helpRank: 7,
    summary: 'Inspect hosted deployment metadata without secret material.',
    arguments: [],
    flags: TENANT_TARGET_FLAGS,
    jsonOutput: { mode: 'single' },
  },
  {
    name: 'smoke',
    section: 'operate',
    helpRank: 8,
    summary: 'Run hosted readiness diagnostics and print external smoke commands.',
    arguments: [],
    flags: TENANT_TARGET_FLAGS,
    jsonOutput: { mode: 'single' },
  },
  {
    name: 'rollback',
    section: 'operate',
    helpRank: 9,
    summary: 'Reactivate a historical deployment.',
    arguments: [
      argument({
        ...ARGUMENT_FIELDS,
        name: 'deployment-id',
        type: 'string',
        summary: 'Historical deployment identifier to reactivate.',
        required: true,
      }),
    ],
    flags: [
      ...TENANT_TARGET_FLAGS,
      flag({
        ...FLAG_FIELDS,
        name: 'reason',
        type: 'string',
        value: '<text>',
        summary: 'Operator reason recorded with the rollback.',
      }),
    ],
    jsonOutput: { mode: 'single' },
  },
  {
    name: 'archive',
    section: 'operate',
    helpRank: 11,
    summary:
      'Archive the whole app: endpoints answer 410 Gone; hard-deleted after the retention window.',
    arguments: [
      argument({
        ...ARGUMENT_FIELDS,
        name: 'app',
        type: 'string',
        summary: 'Application slug; defaults to the linked application.',
        required: false,
      }),
    ],
    flags: [
      ORG_FLAG,
      APP_FLAG,
      flag({ ...FLAG_FIELDS, name: 'yes', type: 'boolean', summary: 'Confirm non-interactively.' }),
      SERVICE_FLAG,
      AUTH_TOKEN_FLAG,
      JSON_FLAG,
    ],
    jsonOutput: { mode: 'single' },
  },
  {
    name: 'restore',
    section: 'operate',
    helpRank: 12,
    summary: 'Restore an archived app within the retention window.',
    arguments: [
      argument({
        ...ARGUMENT_FIELDS,
        name: 'app',
        type: 'string',
        summary: 'Application slug; defaults to the linked application.',
        required: false,
      }),
    ],
    flags: [ORG_FLAG, APP_FLAG, SERVICE_FLAG, AUTH_TOKEN_FLAG, JSON_FLAG],
    jsonOutput: { mode: 'single' },
  },
  {
    name: 'access',
    section: 'operate',
    helpRank: 10,
    summary: 'Set the identity access mode for a hosted deployment.',
    arguments: [],
    subcommands: [
      subcommand({
        ...SUBCOMMAND_FIELDS,
        name: 'set',
        summary: 'Set the access mode for a target.',
        arguments: [
          argument({
            ...ARGUMENT_FIELDS,
            name: 'mode',
            type: 'string',
            summary: 'Identity access mode.',
            required: true,
            constraints: { choices: ACCESS_MODES },
          }),
        ],
        flags: [
          flag({
            ...FLAG_FIELDS,
            name: 'version',
            type: 'string',
            value: '<version>',
            summary: 'Server version whose access mode is changed.',
          }),
          flag({
            ...FLAG_FIELDS,
            name: 'owner-subject',
            type: 'string',
            value: '<subject>',
            summary: 'Exact OAuth subject to bind or transfer for owner-only access.',
          }),
          ...TENANT_TARGET_FLAGS,
        ],
        jsonOutput: { mode: 'single' },
      }),
    ],
    flags: TENANT_TARGET_FLAGS,
    jsonOutput: { mode: 'single' },
  },
];
