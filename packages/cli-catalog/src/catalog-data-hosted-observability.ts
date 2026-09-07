/** Hosted deployment, governance, observability, and billing command catalog data. */
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

export const CATALOG_HOSTED_OBSERVABILITY: readonly CommandSpec[] = [
  {
    name: 'knowledge',
    section: 'operate',
    helpRank: 15,
    summary: 'Operator-only knowledge components: list, status, and refresh (ADR 0202).',
    arguments: [],
    subcommands: [
      subcommand({
        ...SUBCOMMAND_FIELDS,
        name: 'list',
        summary: 'List the active deployment knowledge components for an org/app/env.',
        flags: TENANT_TARGET_FLAGS,
        jsonOutput: { mode: 'single' },
      }),
      subcommand({
        ...SUBCOMMAND_FIELDS,
        name: 'status',
        summary: 'Show one knowledge component: revision, lifecycle, provisioning, budget.',
        arguments: [
          argument({
            ...ARGUMENT_FIELDS,
            name: 'name',
            type: 'string',
            summary: 'Knowledge component name.',
            required: true,
          }),
        ],
        flags: TENANT_TARGET_FLAGS,
        jsonOutput: { mode: 'single' },
      }),
      subcommand({
        ...SUBCOMMAND_FIELDS,
        name: 'refresh',
        summary: 'Crawl the component sites now and report the resulting crawl state.',
        arguments: [
          argument({
            ...ARGUMENT_FIELDS,
            name: 'name',
            type: 'string',
            summary: 'Knowledge component name.',
            required: true,
          }),
        ],
        flags: TENANT_TARGET_FLAGS,
        jsonOutput: { mode: 'single' },
      }),
    ],
    flags: [],
  },
  {
    name: 'audit',
    section: 'operate',
    helpRank: 14,
    summary: 'Operator governance audit status and event queries.',
    arguments: [],
    subcommands: [
      subcommand({
        ...SUBCOMMAND_FIELDS,
        name: 'status',
        summary: 'Show whether the audit capability is enabled.',
        flags: [SERVICE_FLAG, AUTH_TOKEN_FLAG, JSON_FLAG],
        jsonOutput: { mode: 'single' },
      }),
      subcommand({
        ...SUBCOMMAND_FIELDS,
        name: 'events',
        summary: 'Query audit events for an org.',
        flags: [
          flag({
            ...FLAG_FIELDS,
            name: 'org',
            type: 'string',
            value: '<slug>',
            summary: 'Organization slug.',
            required: true,
          }),
          APP_FLAG,
          ENV_FLAG,
          flag({
            ...FLAG_FIELDS,
            name: 'event-type',
            type: 'string',
            value: '<type>',
            summary: 'Audit event type filter.',
          }),
          flag({
            ...FLAG_FIELDS,
            name: 'limit',
            type: 'string',
            value: '<n>',
            summary: 'Maximum number of audit events returned.',
          }),
          SERVICE_FLAG,
          AUTH_TOKEN_FLAG,
          JSON_FLAG,
        ],
        jsonOutput: { mode: 'single' },
      }),
    ],
    flags: [SERVICE_FLAG, AUTH_TOKEN_FLAG, JSON_FLAG],
    jsonOutput: { mode: 'single' },
  },
  {
    name: 'logs',
    section: 'operate',
    helpRank: 2,
    next: ['noodle metrics', 'noodle events'],
    summary: 'Tenant-safe app logs (redacted, newest-first).',
    arguments: [],
    flags: [
      ...TENANT_TARGET_FLAGS,
      flag({
        ...FLAG_FIELDS,
        name: 'limit',
        type: 'string',
        value: '<n>',
        summary: 'Maximum number of log records returned.',
      }),
      flag({
        ...FLAG_FIELDS,
        name: 'level',
        type: 'string',
        value: '<level>',
        summary: 'Minimum log severity filter.',
        constraints: { choices: ['debug', 'info', 'warn', 'error'] },
      }),
      flag({
        ...FLAG_FIELDS,
        name: 'search',
        type: 'string',
        value: '<text>',
        summary: 'Text search applied to log records.',
      }),
      flag({
        ...FLAG_FIELDS,
        name: 'since',
        type: 'string',
        value: '<iso>',
        summary: 'Inclusive ISO timestamp lower bound.',
      }),
      flag({
        ...FLAG_FIELDS,
        name: 'until',
        type: 'string',
        value: '<iso>',
        summary: 'Inclusive ISO timestamp upper bound.',
      }),
      flag({
        ...FLAG_FIELDS,
        name: 'follow',
        type: 'boolean',
        summary: 'Poll for new records.',
        aliases: ['tail'],
      }),
      flag({
        ...FLAG_FIELDS,
        name: 'interval',
        type: 'number',
        value: '<seconds>',
        summary: 'Polling interval used with --follow.',
        constraints: { default: 2, minimum: 0.5 },
      }),
      flag({
        ...FLAG_FIELDS,
        name: 'max-polls',
        type: 'number',
        value: '<count>',
        summary: 'Bound the number of follow polls.',
      }),
    ],
    jsonOutput: { mode: 'single', streamWhenAnyFlag: ['follow', 'tail'] },
  },
  {
    name: 'metrics',
    section: 'operate',
    helpRank: 3,
    summary:
      'MCP analytics: volume, sessions, latency percentiles, errors, tools, clients for a deployed server.',
    arguments: [],
    flags: [
      ...TENANT_TARGET_FLAGS,
      flag({
        ...FLAG_FIELDS,
        name: 'window',
        type: 'string',
        value: '<window>',
        summary: 'Preset analytics window.',
        constraints: { choices: ['24h', '7d', '30d'], default: '7d' },
      }),
      flag({
        ...FLAG_FIELDS,
        name: 'since',
        type: 'string',
        value: '<iso>',
        summary: 'Inclusive ISO timestamp lower bound.',
      }),
      flag({
        ...FLAG_FIELDS,
        name: 'until',
        type: 'string',
        value: '<iso>',
        summary: 'Inclusive ISO timestamp upper bound.',
      }),
      flag({
        ...FLAG_FIELDS,
        name: 'agent-output',
        type: 'boolean',
        summary: 'Distilled health verdict and next actions for coding agents.',
      }),
    ],
    jsonOutput: { mode: 'single' },
  },
  {
    name: 'events',
    section: 'operate',
    helpRank: 4,
    summary: 'The MCP request stream; --session replays one session in order.',
    arguments: [],
    flags: [
      ...TENANT_TARGET_FLAGS,
      flag({
        ...FLAG_FIELDS,
        name: 'status',
        type: 'string',
        value: '<status>',
        summary: 'MCP request outcome filter.',
        constraints: { choices: ['ok', 'tool_error', 'mcp_error'] },
      }),
      flag({
        ...FLAG_FIELDS,
        name: 'tool',
        type: 'string',
        value: '<name>',
        summary: 'Tool name filter.',
      }),
      flag({
        ...FLAG_FIELDS,
        name: 'client',
        type: 'string',
        value: '<name>',
        summary: 'Client name filter.',
      }),
      flag({
        ...FLAG_FIELDS,
        name: 'session',
        type: 'string',
        value: '<id>',
        summary: 'Replay one session in chronological order.',
      }),
      flag({
        ...FLAG_FIELDS,
        name: 'limit',
        type: 'string',
        value: '<n>',
        summary: 'Maximum number of events returned.',
      }),
      flag({
        ...FLAG_FIELDS,
        name: 'tail',
        type: 'boolean',
        summary: 'Poll for new events.',
        aliases: ['follow'],
      }),
      flag({
        ...FLAG_FIELDS,
        name: 'interval',
        type: 'number',
        value: '<seconds>',
        summary: 'Polling interval used with --tail.',
        constraints: { default: 2, minimum: 0.5 },
      }),
      flag({
        ...FLAG_FIELDS,
        name: 'max-polls',
        type: 'number',
        value: '<count>',
        summary: 'Positive bound on the number of tail polls.',
        constraints: { minimum: Number.MIN_VALUE },
      }),
    ],
    jsonOutput: { mode: 'single', streamWhenAnyFlag: ['follow', 'tail'] },
  },
  {
    name: 'intents',
    section: 'operate',
    helpRank: 5,
    summary: 'Optional model-supplied user-goal insights for private-preview environments.',
    arguments: [],
    subcommands: [
      subcommand({
        ...SUBCOMMAND_FIELDS,
        name: 'status',
        summary: 'Show whether intent capture is enabled and its retention policy.',
        flags: TENANT_TARGET_FLAGS,
        jsonOutput: { mode: 'single' },
      }),
      subcommand({
        ...SUBCOMMAND_FIELDS,
        name: 'enable',
        summary: 'Enable the fixed starter-v1 taxonomy for one environment.',
        flags: TENANT_TARGET_FLAGS,
        jsonOutput: { mode: 'single' },
      }),
      subcommand({
        ...SUBCOMMAND_FIELDS,
        name: 'disable',
        summary: 'Stop future capture without deleting retained intent events.',
        flags: TENANT_TARGET_FLAGS,
        jsonOutput: { mode: 'single' },
      }),
      subcommand({
        ...SUBCOMMAND_FIELDS,
        name: 'list',
        summary: 'Show coverage, goal-fit breakdowns, tools, and recent intent.',
        flags: [
          ...TENANT_TARGET_FLAGS,
          flag({
            ...FLAG_FIELDS,
            name: 'window',
            type: 'string',
            value: '<window>',
            summary: 'Retention-bounded insight window.',
            constraints: { choices: ['24h', '7d', '14d'], default: '7d' },
          }),
        ],
        jsonOutput: { mode: 'single' },
      }),
      subcommand({
        ...SUBCOMMAND_FIELDS,
        name: 'purge',
        summary: 'Permanently delete retained intent and disable future capture.',
        flags: [
          ...TENANT_TARGET_FLAGS,
          flag({
            ...FLAG_FIELDS,
            name: 'yes',
            type: 'boolean',
            summary: 'Confirm permanent deletion.',
            required: true,
          }),
        ],
        jsonOutput: { mode: 'single' },
      }),
    ],
    flags: TENANT_TARGET_FLAGS,
    jsonOutput: { mode: 'single' },
  },
  {
    name: 'alerts',
    section: 'operate',
    helpRank: 6,
    summary:
      'Analytics alert rules: POST a webhook when error share, error count, calls, or p95 latency breaches.',
    arguments: [],
    subcommands: [
      subcommand({
        ...SUBCOMMAND_FIELDS,
        name: 'add',
        summary: 'Create an alert rule (edge-triggered webhook on metric breach).',
        flags: [
          flag({
            ...FLAG_FIELDS,
            name: 'metric',
            type: 'string',
            value: '<metric>',
            summary: 'Analytics metric evaluated by the rule.',
            required: true,
            constraints: { choices: ['error_share', 'error_count', 'calls', 'p95_ms'] },
          }),
          flag({
            ...FLAG_FIELDS,
            name: 'threshold',
            type: 'number',
            value: '<number>',
            summary: 'Metric threshold that triggers the rule.',
            required: true,
            constraints: { minimum: 0 },
          }),
          flag({
            ...FLAG_FIELDS,
            name: 'window',
            type: 'integer',
            value: '<minutes>',
            summary: 'Evaluation window in minutes.',
            required: true,
            constraints: { choices: [5, 15, 60] },
          }),
          flag({
            ...FLAG_FIELDS,
            name: 'webhook',
            type: 'string',
            value: '<https-url>',
            summary: 'Webhook destination that receives alert payloads.',
            required: true,
            sensitive: true,
          }),
          flag({
            ...FLAG_FIELDS,
            name: 'name',
            type: 'string',
            value: '<text>',
            summary: 'Optional alert rule display name.',
          }),
          flag({
            ...FLAG_FIELDS,
            name: 'cooldown',
            type: 'integer',
            value: '<minutes>',
            summary: 'Minimum time between webhook deliveries.',
            constraints: { minimum: 1 },
          }),
          ...TENANT_TARGET_FLAGS,
        ],
        jsonOutput: { mode: 'single' },
      }),
      subcommand({
        ...SUBCOMMAND_FIELDS,
        name: 'list',
        summary: 'List alert rules (webhook URLs are shown redacted to their origin).',
        flags: [
          flag({
            ...FLAG_FIELDS,
            name: 'agent-output',
            type: 'boolean',
            summary: 'Distilled breach verdict for coding agents.',
          }),
          ...TENANT_TARGET_FLAGS,
        ],
        jsonOutput: { mode: 'single' },
      }),
      subcommand({
        ...SUBCOMMAND_FIELDS,
        name: 'remove',
        summary: 'Delete an alert rule.',
        arguments: [
          argument({
            ...ARGUMENT_FIELDS,
            name: 'id',
            type: 'string',
            summary: 'Alert rule identifier.',
            required: true,
          }),
        ],
        flags: TENANT_TARGET_FLAGS,
        jsonOutput: { mode: 'single' },
      }),
      subcommand({
        ...SUBCOMMAND_FIELDS,
        name: 'test',
        summary: 'Send a synthetic test payload through the rule’s webhook.',
        arguments: [
          argument({
            ...ARGUMENT_FIELDS,
            name: 'id',
            type: 'string',
            summary: 'Alert rule identifier.',
            required: true,
          }),
        ],
        flags: TENANT_TARGET_FLAGS,
        jsonOutput: { mode: 'single' },
      }),
    ],
    flags: TENANT_TARGET_FLAGS,
    jsonOutput: { mode: 'single' },
  },
];
