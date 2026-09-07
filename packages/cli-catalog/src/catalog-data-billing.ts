/** Billing command catalog data with flags attached to their real nested action leaves. */
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
const YES_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'yes',
  type: 'boolean',
  summary: 'Confirm the requested billing operation.',
});
const COMMON_FLAGS: readonly FlagSpec[] = [SERVICE_FLAG, AUTH_TOKEN_FLAG, JSON_FLAG];
const REASON_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'reason',
  type: 'string',
  value: '<text>',
  summary: 'Operator reason recorded with the billing operation.',
  required: true,
});
const IDEMPOTENCY_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'idempotency-key',
  type: 'string',
  value: '<key>',
  summary: 'Private replay key for a billing mutation.',
  required: true,
  sensitive: true,
});
const TRANSFER_ACCOUNT_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'account',
  type: 'string',
  value: '<destination-id>',
  summary: 'Destination billing account identifier.',
  required: true,
});
const TRANSFER_ORG_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'org',
  type: 'string',
  value: '<org>',
  summary: 'Organization slug to transfer.',
  required: true,
});
const TRANSFER_QUERY_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'query',
  type: 'string',
  value: '<text>',
  summary: 'Filter owned organizations by name or slug.',
  constraints: { minLength: 1, maxLength: 100 },
});
const TRANSFER_CURSOR_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'cursor',
  type: 'string',
  value: '<cursor>',
  summary: 'Opaque continuation cursor.',
  constraints: { maxLength: 512 },
});
const TRANSFER_LIMIT_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'limit',
  type: 'integer',
  value: '<n>',
  summary: 'Maximum organization candidates returned.',
  constraints: { default: 50, minimum: 1, maximum: 100 },
});
const TRANSFER_OUT_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'out',
  type: 'string',
  value: '<reviewed-preview.json>',
  summary: 'New private path for the reviewed preview artifact.',
  required: true,
  sensitive: true,
});
const TRANSFER_PREVIEW_FILE_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'preview-file',
  type: 'string',
  value: '<reviewed-preview.json>',
  summary: 'Private reviewed billing transfer preview artifact.',
  required: true,
  sensitive: true,
});
const TRANSFER_IDEMPOTENCY_FLAG = flag({
  ...IDEMPOTENCY_FLAG,
  constraints: { minLength: 8, maxLength: 256 },
});
const TRANSFER_YES_FLAG = flag({ ...YES_FLAG, required: true });
const TRANSFER_ADMIN_REASON_FLAG = flag({
  ...REASON_FLAG,
  summary: 'Restricted administrative reason recorded with the transfer.',
  sensitive: true,
  constraints: { minLength: 1, maxLength: 256 },
});

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

function branch(
  name: string,
  summary: string,
  subcommands: readonly SubcommandSpec[],
): SubcommandSpec {
  return subcommand({ ...SUBCOMMAND_FIELDS, name, summary, subcommands });
}

function accountArgument(required: boolean): ArgumentSpec {
  return argument({
    ...ARGUMENT_FIELDS,
    name: 'account-id',
    type: 'string',
    summary: 'Billing account identifier.',
    required,
  });
}

const ACCOUNTS = branch(
  'accounts',
  'Inspect an account, purchase a plan, or open its billing portal.',
  [
    leaf('list', 'List billing accounts visible to the current identity.', LEAF_FIELDS),
    leaf('inspect', 'Inspect one billing account.', {
      ...LEAF_FIELDS,
      arguments: [accountArgument(true)],
    }),
    leaf('checkout', 'Create a Stripe Checkout session for one billing account.', {
      ...LEAF_FIELDS,
      arguments: [accountArgument(true)],
      flags: [
        flag({
          ...FLAG_FIELDS,
          name: 'plan',
          type: 'string',
          value: '<plan>',
          summary: 'Paid plan selected for Stripe Checkout.',
          required: true,
          constraints: { choices: ['pro', 'scale'] },
        }),
        flag({
          ...FLAG_FIELDS,
          name: 'interval',
          type: 'string',
          value: '<interval>',
          summary: 'Stripe Checkout billing interval.',
          required: true,
          constraints: { choices: ['month', 'year'] },
        }),
        flag({ ...FLAG_FIELDS, ...IDEMPOTENCY_FLAG, required: false }),
      ],
    }),
    leaf('portal', 'Open the Stripe billing portal for one billing account.', {
      ...LEAF_FIELDS,
      arguments: [accountArgument(true)],
    }),
  ],
);

const ENFORCEMENT = branch(
  'enforcement',
  'Inspect or seal the classification-only cohort, then manage activation.',
  [
    branch('cohort', 'Inspect or seal the classification-only billing cohort.', [
      leaf('status', 'Inspect classification-only cohort readiness.', LEAF_FIELDS),
      leaf('seal', 'Seal the classification-only cohort.', {
        ...LEAF_FIELDS,
        flags: [REASON_FLAG, IDEMPOTENCY_FLAG, YES_FLAG],
      }),
    ]),
    branch('activation', 'Inspect, preview, activate, or roll back billing enforcement.', [
      leaf('status', 'Inspect billing-enforcement activation state.', LEAF_FIELDS),
      leaf('preview', 'Preview billing-enforcement activation evidence.', {
        ...LEAF_FIELDS,
        flags: [
          flag({
            ...FLAG_FIELDS,
            name: 'file',
            type: 'string',
            value: '<approval.json>',
            summary: 'Private reviewed activation approval file.',
            required: true,
            sensitive: true,
          }),
        ],
      }),
      leaf('activate', 'Activate billing enforcement from reviewed evidence.', {
        ...LEAF_FIELDS,
        flags: [
          flag({
            ...FLAG_FIELDS,
            name: 'file',
            type: 'string',
            value: '<approval.json>',
            summary: 'Private reviewed activation approval file.',
            required: true,
            sensitive: true,
          }),
          flag({
            ...FLAG_FIELDS,
            name: 'preview-file',
            type: 'string',
            value: '<ready-preview.json>',
            summary: 'Private reviewed READY preview file.',
            required: true,
            sensitive: true,
          }),
          REASON_FLAG,
          IDEMPOTENCY_FLAG,
          YES_FLAG,
        ],
      }),
      leaf('rollback', 'Roll back one billing-enforcement activation generation.', {
        ...LEAF_FIELDS,
        flags: [
          flag({
            ...FLAG_FIELDS,
            name: 'epoch',
            type: 'string',
            value: '<epoch-id>',
            summary: 'Billing activation epoch identifier.',
            required: true,
          }),
          flag({
            ...FLAG_FIELDS,
            name: 'generation',
            type: 'integer',
            value: '<n>',
            summary: 'Activation generation expected for rollback.',
            required: true,
            constraints: { minimum: 1 },
          }),
          REASON_FLAG,
          IDEMPOTENCY_FLAG,
          YES_FLAG,
        ],
      }),
    ]),
  ],
);

const METERING = branch(
  'metering',
  'Inspect readiness or manage a validation-only epoch as a super-admin.',
  [
    leaf('readiness', 'Inspect authoritative-meter technical readiness.', LEAF_FIELDS),
    branch('validation', 'Manage validation-only meter epochs.', [
      leaf('prepare', 'Prepare a validation-only meter epoch.', {
        ...LEAF_FIELDS,
        flags: [REASON_FLAG, IDEMPOTENCY_FLAG, YES_FLAG],
      }),
      leaf('retire', 'Retire a validation-only meter epoch.', {
        ...LEAF_FIELDS,
        flags: [
          flag({
            ...FLAG_FIELDS,
            name: 'epoch',
            type: 'string',
            value: '<epoch-id>',
            summary: 'Validation epoch identifier.',
            required: true,
          }),
          REASON_FLAG,
          IDEMPOTENCY_FLAG,
          YES_FLAG,
        ],
      }),
    ]),
  ],
);

const MIGRATION = branch(
  'migration',
  'Run the super-admin-only legacy shadow-migration workflow.',
  [
    leaf('preview', 'Preview the legacy billing migration.', {
      ...LEAF_FIELDS,
      flags: [
        flag({
          ...FLAG_FIELDS,
          name: 'file',
          type: 'string',
          value: '<mapping.json>',
          summary: 'Private legacy billing mapping file.',
          sensitive: true,
        }),
      ],
    }),
    leaf('apply', 'Apply a reviewed legacy billing migration in shadow mode.', {
      ...LEAF_FIELDS,
      flags: [
        flag({
          ...FLAG_FIELDS,
          name: 'file',
          type: 'string',
          value: '<mapping.json>',
          summary: 'Private legacy billing mapping file.',
          required: true,
          sensitive: true,
        }),
        flag({
          ...FLAG_FIELDS,
          name: 'preview-file',
          type: 'string',
          value: '<ready-preview.json>',
          summary: 'Private reviewed READY preview evidence file.',
          required: true,
          sensitive: true,
        }),
        flag({
          ...FLAG_FIELDS,
          name: 'plan-evidence',
          type: 'string',
          value: '<plan-evidence.json>',
          summary: 'Private reviewed plan evidence file.',
          required: true,
          sensitive: true,
        }),
        flag({
          ...FLAG_FIELDS,
          name: 'mode',
          type: 'string',
          value: '<mode>',
          summary: 'Legacy migration application mode.',
          required: true,
          constraints: { choices: ['shadow'] },
        }),
        REASON_FLAG,
        IDEMPOTENCY_FLAG,
        YES_FLAG,
      ],
    }),
  ],
);

const CUSTOMER_TRANSFER = branch(
  'transfer',
  'Move an owned organization to an eligible billing account.',
  [
    leaf('candidates', 'List owned organizations with billing transfer status and eligibility.', {
      ...LEAF_FIELDS,
      flags: [
        TRANSFER_ACCOUNT_FLAG,
        TRANSFER_QUERY_FLAG,
        TRANSFER_CURSOR_FLAG,
        TRANSFER_LIMIT_FLAG,
      ],
    }),
    leaf('preview', 'Preview an exact customer billing transfer without changing state.', {
      arguments: [
        argument({
          ...ARGUMENT_FIELDS,
          name: 'org-slug',
          type: 'string',
          summary: 'Owned organization slug to transfer.',
          required: true,
        }),
      ],
      flags: [TRANSFER_ACCOUNT_FLAG, TRANSFER_OUT_FLAG],
    }),
    leaf('apply', 'Apply an exact reviewed customer billing transfer.', {
      ...LEAF_FIELDS,
      flags: [TRANSFER_PREVIEW_FILE_FLAG, TRANSFER_IDEMPOTENCY_FLAG, TRANSFER_YES_FLAG],
    }),
  ],
);

const ADMINISTRATION = branch(
  'administration',
  'Perform restricted super-admin billing operations on behalf of users.',
  [
    branch('transfer', 'Move organization billing with explicit super-admin authority.', [
      leaf('preview', 'Preview an exact administrative billing transfer.', {
        ...LEAF_FIELDS,
        flags: [
          TRANSFER_ORG_FLAG,
          TRANSFER_ACCOUNT_FLAG,
          TRANSFER_ADMIN_REASON_FLAG,
          TRANSFER_OUT_FLAG,
        ],
      }),
      leaf('apply', 'Apply an exact reviewed administrative billing transfer.', {
        ...LEAF_FIELDS,
        flags: [TRANSFER_PREVIEW_FILE_FLAG, TRANSFER_IDEMPOTENCY_FLAG, TRANSFER_YES_FLAG],
      }),
    ]),
  ],
);

export const BILLING_COMMAND: CommandSpec = {
  name: 'billing',
  section: 'operate',
  helpRank: 15,
  summary: 'Inspect billing accounts, buy a plan, and manage billing.',
  arguments: [],
  subcommands: [
    branch('catalog', 'Inspect or activate the versioned billing catalog.', [
      leaf('status', 'Inspect the active catalog and supported reader version.', {
        ...LEAF_FIELDS,
      }),
      leaf('activate', 'Activate catalog 2 using protected System Release evidence.', {
        ...LEAF_FIELDS,
        flags: [
          flag({
            ...FLAG_FIELDS,
            name: 'proof',
            type: 'string',
            value: '<file>',
            summary: 'Verified protected release inventory; workload authorization is required.',
            required: true,
          }),
        ],
      }),
    ]),
    ACCOUNTS,
    branch('org', 'Inspect or transfer an organization’s effective billing.', [
      leaf('inspect', 'Inspect effective billing entitlements for one organization.', {
        ...LEAF_FIELDS,
        arguments: [
          argument({
            ...ARGUMENT_FIELDS,
            name: 'org-slug',
            type: 'string',
            summary: 'Organization slug; defaults to the resolved organization.',
            required: false,
          }),
        ],
      }),
      CUSTOMER_TRANSFER,
    ]),
    ADMINISTRATION,
    ENFORCEMENT,
    METERING,
    MIGRATION,
  ],
  flags: [],
};
