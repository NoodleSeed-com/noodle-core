/** Policy command catalog data with flags attached to their real nested action leaves. */
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
  summary: 'Organization-scoped policy target.',
});
const APP_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'app',
  type: 'string',
  value: '<slug>',
  summary: 'Application-scoped policy target.',
});
const ENV_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'env',
  type: 'string',
  value: '<slug>',
  summary: 'Environment-scoped policy target.',
});
const DEPLOYMENT_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'deployment',
  type: 'string',
  value: '<id>',
  summary: 'Deployment-scoped policy target.',
});
const OPERATION_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'operation',
  type: 'string',
  value: '<name>',
  summary: 'Operation-scoped policy target.',
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
const COMMON_FLAGS: readonly FlagSpec[] = [SERVICE_FLAG, AUTH_TOKEN_FLAG, JSON_FLAG];
const SCOPE_FLAGS: readonly FlagSpec[] = [
  ORG_FLAG,
  APP_FLAG,
  ENV_FLAG,
  DEPLOYMENT_FLAG,
  OPERATION_FLAG,
];
const REASON_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'reason',
  type: 'string',
  value: '<text>',
  summary: 'Operator reason recorded with the policy mutation.',
});
const EXPECTED_VERSION_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'expected-version',
  type: 'integer',
  value: '<n>',
  summary: 'Expected policy version used for optimistic concurrency.',
  constraints: { minimum: 0 },
});
const IDEMPOTENCY_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'idempotency-key',
  type: 'string',
  value: '<key>',
  summary: 'Private replay key for a policy mutation.',
  sensitive: true,
});
const WRITE_FLAGS: readonly FlagSpec[] = [REASON_FLAG, EXPECTED_VERSION_FLAG, IDEMPOTENCY_FLAG];

function leaf(
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
    flags: [...options.flags, ...COMMON_FLAGS],
    jsonOutput: { mode: 'single' },
  });
}

function categoryArgument(): ArgumentSpec {
  return argument({
    ...ARGUMENT_FIELDS,
    name: 'category',
    type: 'string',
    summary: 'MCP policy category.',
    required: true,
    constraints: { choices: ['protocol', 'discovery', 'read', 'execute'] },
  });
}

const LIMIT_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'limit',
  type: 'integer',
  value: '<n>',
  summary: 'Quota or rate limit.',
  required: true,
  constraints: { minimum: 0 },
});
const WINDOW_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'window',
  type: 'string',
  value: '<duration>',
  summary: 'Quota window or token refill duration.',
  required: true,
});

const PLAN = subcommand({
  ...SUBCOMMAND_FIELDS,
  name: 'plan',
  summary: 'Manage the commercial plan.',
  subcommands: [
    leaf('show', 'Show the organization commercial plan.', {
      ...LEAF_FIELDS,
      flags: [flag({ ...FLAG_FIELDS, ...ORG_FLAG, required: true })],
    }),
    leaf('set', 'Set the organization commercial plan.', {
      ...LEAF_FIELDS,
      arguments: [
        argument({
          ...ARGUMENT_FIELDS,
          name: 'plan',
          type: 'string',
          summary: 'Commercial plan.',
          required: true,
          constraints: { choices: ['free', 'pro', 'scale', 'enterprise'] },
        }),
      ],
      flags: [
        flag({ ...FLAG_FIELDS, ...ORG_FLAG, required: true }),
        flag({ ...FLAG_FIELDS, ...REASON_FLAG, required: true }),
        flag({
          ...FLAG_FIELDS,
          name: 'external-ref',
          type: 'string',
          value: '<ref>',
          summary: 'External commercial reference associated with the plan.',
          constraints: { minLength: 1, maxLength: 256 },
        }),
        EXPECTED_VERSION_FLAG,
        flag({ ...FLAG_FIELDS, ...IDEMPOTENCY_FLAG, constraints: { minLength: 1 } }),
      ],
    }),
    leaf('suspend', 'Suspend the organization commercial plan.', {
      ...LEAF_FIELDS,
      flags: [
        flag({ ...FLAG_FIELDS, ...ORG_FLAG, required: true }),
        flag({ ...FLAG_FIELDS, ...REASON_FLAG, required: true }),
        flag({
          ...FLAG_FIELDS,
          name: 'external-ref',
          type: 'string',
          value: '<ref>',
          summary: 'External commercial reference associated with the plan.',
          constraints: { minLength: 1, maxLength: 256 },
        }),
        EXPECTED_VERSION_FLAG,
        flag({ ...FLAG_FIELDS, ...IDEMPOTENCY_FLAG, constraints: { minLength: 1 } }),
      ],
    }),
  ],
});

export const POLICY_COMMAND: CommandSpec = {
  name: 'policy',
  section: 'operate',
  helpRank: 13,
  summary: 'Manage policy admission and commercial plans.',
  arguments: [],
  subcommands: [
    leaf('status', 'Show whether the controls capability is enabled.', LEAF_FIELDS),
    leaf('list', 'List policy assignments in scope.', { ...LEAF_FIELDS, flags: [ORG_FLAG] }),
    leaf('effective', 'Show the effective policy for a scope.', {
      ...LEAF_FIELDS,
      flags: SCOPE_FLAGS,
    }),
    leaf('simulate', 'Simulate a candidate assignment against context.', {
      ...LEAF_FIELDS,
      flags: [
        ...SCOPE_FLAGS,
        flag({
          ...FLAG_FIELDS,
          name: 'file',
          type: 'string',
          value: '<path>',
          summary: 'Optional candidate assignment JSON file.',
        }),
      ],
    }),
    leaf('suspend', 'Suspend all admission in a scope.', {
      ...LEAF_FIELDS,
      flags: [...SCOPE_FLAGS, ...WRITE_FLAGS],
    }),
    leaf('resume', 'Remove a scope suspension.', {
      ...LEAF_FIELDS,
      flags: [...SCOPE_FLAGS, ...WRITE_FLAGS],
    }),
    leaf('usage', 'Show current usage and quota consumption.', {
      ...LEAF_FIELDS,
      flags: [ORG_FLAG],
    }),
    leaf('apply', 'Apply a policy assignment read from a file.', {
      ...LEAF_FIELDS,
      flags: [
        ORG_FLAG,
        flag({
          ...FLAG_FIELDS,
          name: 'file',
          type: 'string',
          value: '<path>',
          summary: 'Policy assignment JSON file.',
          required: true,
        }),
        EXPECTED_VERSION_FLAG,
        IDEMPOTENCY_FLAG,
      ],
    }),
    leaf('show', 'Show one policy assignment.', {
      ...LEAF_FIELDS,
      arguments: [
        argument({
          ...ARGUMENT_FIELDS,
          name: 'id',
          type: 'string',
          summary: 'Policy assignment identifier.',
          required: true,
        }),
      ],
      flags: [
        ORG_FLAG,
        flag({
          ...FLAG_FIELDS,
          name: 'history',
          type: 'boolean',
          summary: 'Show the version history for the assignment.',
        }),
      ],
    }),
    leaf('deny', 'Deny a policy category in a scope.', {
      ...LEAF_FIELDS,
      arguments: [categoryArgument()],
      flags: [...SCOPE_FLAGS, ...WRITE_FLAGS],
    }),
    leaf('quota', 'Set a quota rule.', {
      ...LEAF_FIELDS,
      arguments: [categoryArgument()],
      flags: [...SCOPE_FLAGS, LIMIT_FLAG, WINDOW_FLAG, ...WRITE_FLAGS],
    }),
    leaf('rate', 'Set a token-bucket rate rule.', {
      ...LEAF_FIELDS,
      arguments: [categoryArgument()],
      flags: [
        ...SCOPE_FLAGS,
        LIMIT_FLAG,
        WINDOW_FLAG,
        flag({
          ...FLAG_FIELDS,
          name: 'burst',
          type: 'integer',
          value: '<n>',
          summary: 'Optional token-bucket burst capacity.',
          constraints: { minimum: 0 },
        }),
        flag({
          ...FLAG_FIELDS,
          name: 'partition',
          type: 'string',
          value: '<key>',
          summary: 'Rate-limit partition key.',
          constraints: { choices: ['subject', 'route'] },
        }),
        ...WRITE_FLAGS,
      ],
    }),
    leaf('delete', 'Delete one policy assignment.', {
      ...LEAF_FIELDS,
      arguments: [
        argument({
          ...ARGUMENT_FIELDS,
          name: 'id',
          type: 'string',
          summary: 'Policy assignment identifier.',
          required: true,
        }),
      ],
      flags: [ORG_FLAG, ...WRITE_FLAGS],
    }),
    PLAN,
  ],
  flags: [],
};
