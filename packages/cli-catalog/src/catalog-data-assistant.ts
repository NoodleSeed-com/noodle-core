/** Embedded-assistant command catalog data, split from hosted observability by concern. */
import type { ArgumentSpec, CommandSpec, FlagSpec, SubcommandSpec } from './catalog-types.js';

const ARGUMENT_FIELDS = { variadic: false, sensitive: false, constraints: {} } as const;
const FLAG_FIELDS = {
  required: false,
  repeatable: false,
  sensitive: false,
  aliases: [],
  conflictsWith: [],
} as const;
const SUBCOMMAND_FIELDS = { arguments: [], flags: [] } as const;
const LEAF_FIELDS = { arguments: [], flags: [] } as const;

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
  summary: 'Emit one JSON result envelope.',
});
const REVISION_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'revision',
  type: 'integer',
  value: '<n>',
  summary: 'Appearance revision reviewed before this mutation.',
  constraints: { minimum: 0 },
});
const TENANT_FLAGS: readonly FlagSpec[] = [
  ORG_FLAG,
  APP_FLAG,
  ENV_FLAG,
  SERVICE_FLAG,
  AUTH_TOKEN_FLAG,
  JSON_FLAG,
];

function clientLeaf(
  name: string,
  summary: string,
  options: {
    readonly arguments: readonly ArgumentSpec[];
    readonly flags: readonly FlagSpec[];
  },
): SubcommandSpec {
  return subcommand({
    ...SUBCOMMAND_FIELDS,
    name,
    summary,
    arguments: options.arguments,
    flags: [...options.flags, ...TENANT_FLAGS],
    jsonOutput: { mode: 'single' },
  });
}

const EMBEDS_SUBCOMMAND = subcommand({
  ...SUBCOMMAND_FIELDS,
  name: 'embeds',
  summary: 'Inspect the public website surfaces a deployed app exposes.',
  subcommands: [
    clientLeaf(
      'list',
      'List public embed ids with their live origins, capabilities, caps, and today’s consumption.',
      { ...LEAF_FIELDS, flags: [] },
    ),
  ],
});

const BUDGET_SUBCOMMAND = subcommand({
  ...SUBCOMMAND_FIELDS,
  name: 'budget',
  summary: 'Set what a public website surface may spend, per day and per source address.',
  subcommands: [
    clientLeaf('set', 'Raise, lower, or switch off a public surface’s daily caps.', {
      ...LEAF_FIELDS,
      flags: [
        flag({
          ...FLAG_FIELDS,
          name: 'turns-per-day',
          type: 'string',
          value: '<count>',
          summary: 'Model turns this surface may run per UTC day. 0 stops it serving anyone.',
        }),
        flag({
          ...FLAG_FIELDS,
          name: 'mints-per-day',
          type: 'string',
          value: '<count>',
          summary: 'Sessions this surface may open per UTC day. 0 stops it serving anyone.',
        }),
        flag({
          ...FLAG_FIELDS,
          name: 'mints-per-address-hour',
          type: 'string',
          value: '<count>',
          summary: 'Sessions one source address may open per hour. The abuse bound, not fairness.',
        }),
        flag({
          ...FLAG_FIELDS,
          name: 'turns-per-address-hour',
          type: 'string',
          value: '<count>',
          summary:
            'Model turns one source address may run per hour. The abuse bound, not fairness.',
        }),
        flag({
          ...FLAG_FIELDS,
          name: 'bridge-calls-per-session',
          type: 'string',
          value: '<count>',
          summary: 'Tool calls a browser agent may make in one session over the WebMCP bridge.',
        }),
        flag({
          ...FLAG_FIELDS,
          name: 'bridge-calls-per-day',
          type: 'string',
          value: '<count>',
          summary: 'Bridge tool calls this surface may serve per UTC day. 0 closes the bridge.',
        }),
        flag({
          ...FLAG_FIELDS,
          name: 'surface',
          type: 'string',
          value: '<embed-id>',
          summary: 'Which surface to change. Optional when the app has exactly one.',
        }),
      ],
    }),
  ],
});

const SPONSORSHIP_ACCOUNT_ARGUMENT = argument({
  ...ARGUMENT_FIELDS,
  name: 'billing-account-id',
  type: 'string',
  summary: 'Billing account receiving the sponsored allowance.',
  required: true,
});

const SPONSORSHIP_FLAGS = [SERVICE_FLAG, AUTH_TOKEN_FLAG, JSON_FLAG] as const;
const SPONSORSHIP_REASON_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'reason',
  type: 'string',
  value: '<text>',
  summary: 'Auditable reason for granting or revoking sponsored usage.',
  required: true,
});
const SPONSORSHIP_IDEMPOTENCY_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'idempotency-key',
  type: 'string',
  value: '<key>',
  summary: 'Stable retry key for exactly-once mutation semantics.',
  required: true,
});

const SPONSORSHIP_SUBCOMMAND = subcommand({
  ...SUBCOMMAND_FIELDS,
  name: 'sponsorship',
  summary: 'Inspect sponsored managed-assistant usage or operate expiring bonus grants.',
  subcommands: [
    subcommand({
      ...SUBCOMMAND_FIELDS,
      name: 'inspect',
      summary: 'Show one billing account’s allowance, usage, reset, and grants.',
      arguments: [SPONSORSHIP_ACCOUNT_ARGUMENT],
      flags: [...SPONSORSHIP_FLAGS],
      jsonOutput: { mode: 'single' },
    }),
    subcommand({
      ...SUBCOMMAND_FIELDS,
      name: 'grant',
      summary: 'Add a bounded daily allowance until an explicit expiry.',
      arguments: [SPONSORSHIP_ACCOUNT_ARGUMENT],
      flags: [
        flag({
          ...FLAG_FIELDS,
          name: 'turns-per-day',
          type: 'integer',
          value: '<count>',
          summary: 'Additional sponsored turns per UTC day.',
          required: true,
          constraints: { minimum: 1, maximum: 100_000 },
        }),
        flag({
          ...FLAG_FIELDS,
          name: 'starts-at',
          type: 'string',
          value: '<timestamp>',
          summary: 'Optional ISO timestamp; defaults to now.',
          constraints: { default: 'now' },
        }),
        flag({
          ...FLAG_FIELDS,
          name: 'expires-at',
          type: 'string',
          value: '<timestamp>',
          summary: 'Required ISO timestamp after which the grant stops applying.',
          required: true,
        }),
        SPONSORSHIP_REASON_FLAG,
        SPONSORSHIP_IDEMPOTENCY_FLAG,
        ...SPONSORSHIP_FLAGS,
      ],
      jsonOutput: { mode: 'single' },
    }),
    subcommand({
      ...SUBCOMMAND_FIELDS,
      name: 'revoke',
      summary: 'Revoke one bonus grant without deleting its audit history.',
      arguments: [
        SPONSORSHIP_ACCOUNT_ARGUMENT,
        argument({
          ...ARGUMENT_FIELDS,
          name: 'grant-id',
          type: 'string',
          summary: 'Managed-assistant sponsorship grant identifier.',
          required: true,
        }),
      ],
      flags: [SPONSORSHIP_REASON_FLAG, SPONSORSHIP_IDEMPOTENCY_FLAG, ...SPONSORSHIP_FLAGS],
      jsonOutput: { mode: 'single' },
    }),
  ],
});

const CLIENTS_SUBCOMMAND = subcommand({
  ...SUBCOMMAND_FIELDS,
  name: 'clients',
  summary: 'Create, list, rotate, or revoke deployment-bound assistant clients.',
  subcommands: [
    clientLeaf('create', 'Create a deployment-bound assistant client.', {
      ...LEAF_FIELDS,
      flags: [
        flag({
          ...FLAG_FIELDS,
          name: 'name',
          type: 'string',
          value: '<name>',
          summary: 'Display name for the new assistant client.',
          constraints: { default: 'web' },
        }),
      ],
    }),
    clientLeaf('list', 'List deployment-bound assistant clients.', LEAF_FIELDS),
    clientLeaf('rotate', 'Rotate one assistant client credential.', {
      ...LEAF_FIELDS,
      arguments: [
        argument({
          ...ARGUMENT_FIELDS,
          name: 'client-id',
          type: 'string',
          summary: 'Assistant client identifier.',
          required: true,
        }),
      ],
    }),
    clientLeaf('revoke', 'Revoke one assistant client.', {
      ...LEAF_FIELDS,
      arguments: [
        argument({
          ...ARGUMENT_FIELDS,
          name: 'client-id',
          type: 'string',
          summary: 'Assistant client identifier.',
          required: true,
        }),
      ],
    }),
  ],
});

const APPEARANCE_SUBCOMMAND = subcommand({
  ...SUBCOMMAND_FIELDS,
  name: 'appearance',
  summary: 'Inspect or replace the environment-scoped embedded assistant appearance.',
  subcommands: [
    clientLeaf('show', 'Show the active revision and field provenance without printing values.', {
      ...LEAF_FIELDS,
      flags: [],
    }),
    clientLeaf('apply', 'Replace the complete browser-safe appearance override from JSON.', {
      ...LEAF_FIELDS,
      flags: [
        flag({
          ...FLAG_FIELDS,
          name: 'file',
          type: 'string',
          value: '<appearance.json>',
          summary: 'Complete browser-safe appearance override.',
          required: true,
        }),
        REVISION_FLAG,
      ],
    }),
    clientLeaf('reset', 'Remove the operator override and restore inherited defaults.', {
      ...LEAF_FIELDS,
      flags: [REVISION_FLAG],
    }),
  ],
});

export const ASSISTANT_COMMAND: CommandSpec = {
  name: 'assistant',
  section: 'operate',
  helpRank: 6,
  summary: 'Configure and validate the customer-branded embedded assistant boundary.',
  arguments: [],
  subcommands: [
    subcommand({
      ...SUBCOMMAND_FIELDS,
      name: 'doctor',
      summary:
        'Verify the active deployment, backend client credential, exact origin, and delegated credential exchanges.',
      flags: [
        flag({
          ...FLAG_FIELDS,
          name: 'origin',
          type: 'string',
          value: '<https-origin>',
          summary: 'Exact browser origin used by the embedding application.',
        }),
        flag({
          ...FLAG_FIELDS,
          name: 'client-id',
          type: 'string',
          value: '<id>',
          summary: 'Backend assistant client identifier.',
        }),
        flag({
          ...FLAG_FIELDS,
          name: 'user-id',
          type: 'string',
          value: '<id>',
          summary: 'Optional customer user identifier exercised by the diagnostic.',
        }),
        ...TENANT_FLAGS,
      ],
      jsonOutput: { mode: 'single' },
    }),
    APPEARANCE_SUBCOMMAND,
    CLIENTS_SUBCOMMAND,
    EMBEDS_SUBCOMMAND,
    BUDGET_SUBCOMMAND,
    SPONSORSHIP_SUBCOMMAND,
    subcommand({
      ...SUBCOMMAND_FIELDS,
      name: 'usage',
      summary:
        'Show assistant sessions, conversation depth, engagement, latency, and model tokens.',
      flags: [
        flag({
          ...FLAG_FIELDS,
          name: 'window',
          type: 'string',
          value: '<window>',
          summary: 'Aggregation window.',
          constraints: { choices: ['24h', '7d', '30d'], default: '7d' },
        }),
        ...TENANT_FLAGS,
      ],
      jsonOutput: { mode: 'single' },
    }),
    subcommand({
      ...SUBCOMMAND_FIELDS,
      name: 'embed',
      summary:
        'Install the selected website integration with explicit application-owned seams and verification guidance.',
      flags: [
        flag({
          ...FLAG_FIELDS,
          name: 'framework',
          type: 'string',
          value: '<framework>',
          summary: 'Embedding profile: nextjs or authenticated django-vue.',
          constraints: { choices: ['nextjs', 'django-vue'], default: 'nextjs' },
        }),
        flag({
          ...FLAG_FIELDS,
          name: 'dir',
          type: 'string',
          value: '<path>',
          summary: 'Existing web application directory.',
          constraints: { default: '.' },
        }),
        flag({
          ...FLAG_FIELDS,
          name: 'force',
          type: 'boolean',
          summary: 'Overwrite user-modified scaffold files.',
        }),
        flag({
          ...FLAG_FIELDS,
          name: 'dry-run',
          type: 'boolean',
          summary:
            'Preview generated files, hashes, conflicts, and next steps without writing files.',
        }),
        flag({
          ...FLAG_FIELDS,
          name: 'no-agents',
          type: 'boolean',
          summary: 'Skip writing agent instructions.',
        }),
        flag({
          ...FLAG_FIELDS,
          name: 'check',
          type: 'boolean',
          summary:
            'Check host environment presence and statically detectable CSP without writing files.',
        }),
        flag({
          ...FLAG_FIELDS,
          name: 'require-env',
          type: 'string',
          value: '<NAME>',
          summary:
            'Additional application-owned host environment name required by the integration.',
          repeatable: true,
        }),
        flag({
          ...FLAG_FIELDS,
          name: 'surface',
          type: 'string',
          value: '<mode>',
          summary:
            'Surface to install or check; public omits backend exchange, mixed adds the existing-login handoff.',
          constraints: { choices: ['authenticated', 'public', 'mixed'], default: 'authenticated' },
        }),
        flag({
          ...FLAG_FIELDS,
          name: 'env-alias',
          type: 'string',
          value: '<NAME=HOST_NAME>',
          summary: 'Check a host-repo environment name in place of the canonical one.',
          repeatable: true,
        }),
        JSON_FLAG,
      ],
      jsonOutput: { mode: 'single' },
    }),
  ],
  flags: [],
};
